import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Statement, StatementTotals, Tx, TxType } from './model';
import { reconcile, sum, uid } from './model';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfTextLine = { text: string; page: number; y?: number; columns?: { x:number; text:string }[] };
export type SuspiciousRow = { page: number; section: string; line: string };
export type Draft = Omit<Statement, 'cardId' | 'status' | 'difference' | 'id' | 'createdAt' | 'corrections'> & {
  extractedText: string;
  warnings: string[];
  accountLast4: string | null;
  corrections: string[];
  suspiciousRows: SuspiciousRow[];
  extractionFailed:boolean;
};

const MONEY = String.raw`(?:\(?\s*-?\s*\$?\s*[\d,]+\.\d{2}\s*\)?|\(?\s*\$?\s*[\d,]+\.\d{2}\s*\)?)(?:\s*(?:CR|DR)|-)?`;
const DATE = String.raw`\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?`;
const amount = (value: string): number | null => {
  const negative = /-|\(|\bDR\b/i.test(value);
  const normalized = value.replace(/[$,\s()]/g, '').replace(/(?:CR|DR)$/i, '').replace(/-$/, '');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -Math.abs(n) : Math.abs(n)) * 100) / 100;
};

function numericDate(value: string, fallbackYear?: number): string | null {
  const m = value.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (!m) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    const d = new Date(parsed);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  let year = m[3] ? Number(m[3]) : fallbackYear ?? new Date().getFullYear();
  if (year < 100) year += 2000;
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function dateInPeriod(value: string, closingDate: string | null): string | null {
  const d = numericDate(value, closingDate ? Number(closingDate.slice(0, 4)) : undefined);
  if (!d || !closingDate || value.split(/[/-]/).length < 3) return d;
  const month = Number(d.slice(5, 7));
  const closeMonth = Number(closingDate.slice(5, 7));
  let year = Number(d.slice(0, 4));
  if (month > closeMonth && year === Number(closingDate.slice(0, 4))) year--;
  return `${year}${d.slice(4)}`;
}

function normalizeLine(s: string) {
  return s.replace(/\s+/g, ' ').replace(/[|¦]/g, ' ').trim();
}

/** Heading-only normalization: collapse duplicated words/spans without touching merchant text. */
export function normalizeHeading(value:string) {
  let words=normalizeLine(value).toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
  words=words.map(word=>{const mid=word.length/2;return word.length%2===0&&word.slice(0,mid)===word.slice(mid)?word.slice(0,mid):word;});
  words=words.filter((word,index)=>index===0||word!==words[index-1]);
  if(words.length>1&&words.length%2===0){const half=words.length/2;if(words.slice(0,half).every((word,index)=>word===words[index+half]))words=words.slice(0,half);}
  return words.join(' ');
}

function parseMoneyNearLabel(line: string, label: RegExp): number | null {
  const match = label.exec(line);
  if (!match || match.index == null) return null;
  const tail = line.slice(match.index + match[0].length);
  const next = tail.search(/\b(?:previous balance|new balance|purchases|payments?\s*(?:,|and|&)\s*(?:other\s+)?credits?|payments?\s+and\s+credits?|cash advances?|balance transfers?|interest charged|fees? charged|minimum payment|payment due date)\b/i);
  const window = next >= 0 ? tail.slice(0, next) : tail.slice(0, 55);
  const found = window.match(new RegExp(MONEY));
  if (found) return amount(found[0]);
  // Some PDFs render values before their row labels.
  const head = line.slice(Math.max(0, match.index - 30), match.index);
  const matches = [...head.matchAll(new RegExp(MONEY, 'g'))];
  const before = matches[matches.length - 1]?.[0];
  return before ? amount(before) : null;
}

function rowMatch(line: string) {
  const expression = new RegExp(`^(${DATE})(?:\\s+${DATE})?\\s+(.{2,140}?)\\s+(${MONEY})\\s*$`, 'i');
  const match = normalizeLine(line).match(expression);
  if (!match) return null;
  const desc = match[2].replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]/.test(desc)) return null;
  return { date: match[1], description: desc, amount: amount(match[3]) };
}

function categorize(s: string) {
  return 'Uncategorized';
}

function sectionHeading(line: string): TxType | 'other' | null {
  const s = normalizeHeading(line);
  if (/^PAYMENTS? (?:(?:AND|&) (?:OTHER )?)?CREDITS?$/.test(s)) return 'payment';
  if (/^PURCHASES?(?: AND OTHER CHARGES)?$/.test(s)) return 'purchase';
  if (/^(?:CASH ADVANCES?|CASH ADVANCE TRANSACTIONS)$/.test(s)) return 'cashAdvance';
  if (/^BALANCE TRANSFERS?$/.test(s)) return 'balanceTransfer';
  if (/^INTEREST CHARGED$/.test(s)) return 'interest';
  if (/^FEES?(?: CHARGED)?$/.test(s)) return 'fee';
  if (/^(?:ACCOUNT SUMMARY|REWARDS SUMMARY|PAYMENT INFORMATION|IMPORTANT INFORMATION|APR|ANNUAL PERCENTAGE RATE(?: TABLE)?|INTEREST CHARGES?|INTEREST CHARGES? CALCULATION|BALANCE SUBJECT TO INTEREST RATE|YEAR TO DATE TOTALS?|PAYMENT COUPON|REMITTANCE COUPON)$/.test(s)) return 'other';
  return null;
}

const emptyTotals = (): StatementTotals => ({ purchases: null, paymentsAndCredits: null, cashAdvances: null, balanceTransfers: null, interest: null, fees: null });

/** Parse text-only Chase fixtures through the same section-aware rules as PDF extraction. */
export async function parseChaseText(input: string | PdfTextLine[], fileName = 'synthetic-chase-statement.pdf', pdf = new Blob([], { type: 'application/pdf' }), pageCount?:number): Promise<Draft> {
  const lines: PdfTextLine[] = typeof input === 'string'
    ? input.split('\f').flatMap((pageText,index)=>pageText.split(/\r?\n/).map(text=>({text,page:index+1})))
    : input;
  const detectedPageCount=pageCount??(typeof input==='string'?input.split('\f').length:Math.max(0,...lines.map(line=>line.page)));
  const text = lines.map(line => line.text).join('\n');
  if (text.trim().length < 50) throw new Error('This PDF contains too little readable text. It may be scanned or password protected. Try a text-based Chase PDF, or enter the statement manually.');
  if (!/chase|jpmorgan|jp morgan/i.test(text)) throw new Error('This does not appear to be a Chase statement. CardVault version 1 supports Chase credit cards only.');

  const normalized = lines.map(line => ({ ...line, text: normalizeLine(line.text) })).filter(x => x.text);
  const flat = normalizeLine(text);
  const rangeMatch = flat.match(new RegExp(`opening\\s*\\/\\s*closing\\s+date\\s*:?\\s*(${DATE})\\s*(?:-|–|to)\\s*(${DATE})`, 'i'));
  const openingMatch = flat.match(new RegExp(`opening\\s+date\\s*:?\\s*(${DATE})`, 'i'));
  const closingMatch = flat.match(new RegExp(`closing\\s+date\\s*:?\\s*(${DATE})`, 'i'));
  const openingDate = rangeMatch ? numericDate(rangeMatch[1]) : openingMatch ? numericDate(openingMatch[1]) : null;
  const periodEnd = rangeMatch ? numericDate(rangeMatch[2]) : closingMatch ? numericDate(closingMatch[1]) : null;
  const dueLine = normalized.find(x => /\bpayment due date\b/i.test(x.text));
  const dueRaw = dueLine?.text.match(new RegExp(`payment due date\\s*:?\\s*(${DATE})`, 'i'))?.[1] ?? flat.match(new RegExp(`payment due date\\s*:?\\s*(${DATE})`, 'i'))?.[1];
  const dueDate = dueRaw ? numericDate(dueRaw) : null;

  let summaryMode = false;
  let summarySectionFound = false;
  const summaryLines: string[] = [];
  let inActivity = false;
  let activitySection: TxType | null = null;
  let activitySectionFound = false;
  let continuedActivityFound = false;
  const transactions: Tx[] = [];
  const suspiciousRows: SuspiciousRow[] = [];
  const warnings: string[] = [];

  for (const line of normalized) {
    const heading = sectionHeading(line.text);
    const headingText = normalizeHeading(line.text);
    if (headingText === 'ACCOUNT SUMMARY') {
      summaryMode = true;
      summarySectionFound = true;
      inActivity = false;
      activitySection = null;
      summaryLines.push(line.text);
      continue;
    }
    if (heading === 'other') {
      summaryMode = false;
      inActivity = false;
      activitySection = null;
      const candidate = rowMatch(line.text);
      if (candidate && /coupon|APR|annual percentage|balance subject|year.to.date|rewards|minimum payment|payment due|interest charge/i.test(line.text)) {
        suspiciousRows.push({ page: line.page, section: line.text.match(/APR|ANNUAL PERCENTAGE|BALANCE SUBJECT|YEAR TO DATE|REWARDS|COUPON|MINIMUM PAYMENT|PAYMENT DUE/i)?.[0] ?? 'Non-activity section', line: line.text });
      }
      continue;
    }
    if (headingText === 'ACCOUNT ACTIVITY CONTINUED') {
      summaryMode = false;
      inActivity = true;
      activitySectionFound = true;
      continuedActivityFound = true;
      // Keep the PURCHASE/PAYMENTS/etc. state across the continued-page heading.
      continue;
    }
    if (headingText === 'ACCOUNT ACTIVITY') {
      summaryMode = false;
      inActivity = true;
      activitySectionFound = true;
      activitySection = null;
      continue;
    }
    if (heading && inActivity) {
      activitySection = heading;
      continue;
    }
    if (/^(?:TRANSACTION|TRANS|POSTING|DATE|DESCRIPTION|AMOUNT|REFERENCE)\b/i.test(line.text)) continue;
    if (summaryMode) summaryLines.push(line.text);

    const candidate = rowMatch(line.text);
    if (!candidate) continue;
    if (inActivity && activitySection) {
      const lower = candidate.description.toLowerCase();
      if (/^(?:minimum payment due|payment due date|balance subject to interest|total fees|total interest|year.to.date|previous balance|new balance|available credit|credit limit|points? earned|rewards? summary)/i.test(candidate.description)) {
        suspiciousRows.push({ page: line.page, section: activitySection.toUpperCase(), line: line.text });
        continue;
      }
      let type = activitySection;
      if (activitySection === 'payment') {
        if (/refund|return|reversal/i.test(lower)) type = 'refund';
        else if (/payment|autopay|thank you/i.test(lower)) type = 'payment';
        else type = 'credit';
      }
      const extractedAmount = candidate.amount ?? 0;
      const signed = ['payment','refund','credit'].includes(type) ? -Math.abs(extractedAmount) : Math.abs(extractedAmount);
      transactions.push({ id: uid(), date: dateInPeriod(candidate.date, periodEnd) ?? candidate.date, description: candidate.description, originalDescription: candidate.description, amount: signed, originalAmount: extractedAmount, type, category: categorize(candidate.description), categorySource: 'default', source: 'extracted', page: line.page, sourceSection: activitySection.toUpperCase() });
    } else if (/minimum payment|payment due|balance subject to interest|annual percentage|year.to.date|rewards|coupon|remittance/i.test(line.text)) {
      suspiciousRows.push({ page: line.page, section: 'Non-activity section', line: line.text });
    }
  }

  const labelValue = (labels:RegExp[], source: string[]) => {
    for (const line of source) for (const label of labels) {
      const value = parseMoneyNearLabel(line, label);
      if (value != null) return value;
    }
    return null;
  };
  const previous = labelValue([/previous balance\b/i], normalized.map(x => x.text));
  const ending = labelValue([/new balance\b/i, /statement balance\b/i], normalized.map(x => x.text));
  const minimum = labelValue([/minimum payment due\b/i], normalized.map(x => x.text));
  const summarySource = summaryLines;
  const summaryTotals: StatementTotals = {
    purchases: labelValue([/purchases\b/i], summarySource),
    paymentsAndCredits: (() => { const value = labelValue([/payments?\s*(?:,|and|&)\s*(?:other\s+)?credits?\b/i, /payments?\s+and\s+other\s+credits?\b/i], summarySource); return value == null ? null : -Math.abs(value); })(),
    cashAdvances: labelValue([/cash advances?\b/i], summarySource),
    balanceTransfers: labelValue([/balance transfers?\b/i], summarySource),
    interest: labelValue([/interest charged\b/i], summarySource),
    fees: labelValue([/fees? charged\b/i], summarySource),
  };
  if (!summarySectionFound) warnings.push('Official Account Summary section was not found; totals will remain unavailable.');

  const points = (labels:RegExp[]) => {
    for (const line of normalized) for (const label of labels) {
      const m = line.text.match(new RegExp(`${label.source}\\s*:?\\s*([\\d,]+)`, 'i'));
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  };
  const pointsPrevious = points([/previous points/i, /prior points/i]);
  const pointsBreakdown = normalized.flatMap(line=>{
    const match=line.text.match(/\b(dining|gas|entertainment)\s+bonus\s+points?\s*:?[ ]*([\d,]+)/i)??line.text.match(/\bbase\s+points?\s*:?[ ]*([\d,]+)/i);
    if(!match)return[];
    const label=match[0].match(/^(dining|gas|entertainment|base)/i)?.[1]??'Points';
    const points=Number(match[match.length-1].replace(/,/g,''));
    return[{label:label.replace(/\b\w/g,c=>c.toUpperCase())+(label.toLowerCase()==='base'?' points':' bonus points'),points}];
  });
  const explicitPointsEarned=points([/points? earned (?:in this|this) statement/i, /points? earned this billing cycle/i, /total points earned/i]);
  const pointsEarned = explicitPointsEarned ?? (pointsBreakdown.length?pointsBreakdown.reduce((total,item)=>total+item.points,0):null);
  const pointsRedeemed = points([/points? redeemed/i, /points? used/i]);
  const rewardBalance = points([/points? available/i, /available points/i]);
  const accountLast4 = flat.match(/(?:account|card)(?:\s+(?:number|ending|no\.))?\s*(?:\*+|x+|ending\s+in\s+)?(\d{4})\b/i)?.[1] ?? null;
  const pdfBytes = await pdf.arrayBuffer();
  const hash = await digest(pdfBytes.byteLength ? pdfBytes : new TextEncoder().encode(text).buffer);

  const summaryHasActivity=Object.values(summaryTotals).some(value=>value!=null&&Math.abs(value)>0);
  const extractionFailed=transactions.length===0;
  if (extractionFailed&&summarySectionFound&&summaryHasActivity) warnings.push('Transaction extraction failed. The statement summary was found, but CardVault could not read the transaction table.');
  else if (extractionFailed) warnings.push('No transaction rows were found under a recognized Account Activity heading.');
  if (!activitySectionFound) warnings.push('Account Activity section was not found; transaction details cannot be validated.');
  if (previous == null) warnings.push('Previous balance was not confidently found.');
  if (ending == null) warnings.push('New balance was not confidently found.');
  if (!periodEnd) warnings.push('Opening/closing date range was not confidently found.');
  if (!dueDate) warnings.push('Payment due date was not confidently found.');
  if (suspiciousRows.length) warnings.push(`${suspiciousRows.length} date/amount row(s) outside supported activity sections were excluded and flagged for review.`);

  const statement = {
    periodStart: openingDate ?? '', periodEnd: periodEnd ?? '', dueDate: dueDate ?? '', previous, ending, minimum,
    opening: openingDate ?? '', transactions, pointsPrevious, pointsEarned, pointsRedeemed, rewardBalance, pointsBreakdown, summaryTotals,
    activitySectionFound, summarySectionFound, pagesProcessed:detectedPageCount, continuedActivityFound, summaryDifference: null, detailMismatches: [], pdf, fileName, hash,
  };
  const check = reconcile(statement);
  if (check.reviewReasons.length) warnings.push(...check.reviewReasons);
  return { ...statement, extractedText: text, warnings: [...new Set(warnings)], accountLast4, corrections: [], suspiciousRows, extractionFailed };
}

export function reconstructPdfPageLines(items:{text:string;x:number;y:number}[],page:number,yTolerance=2.5):PdfTextLine[]{
  const grouped:{y:number;items:{x:number;text:string}[]}[]=[];
  for(const item of items){if(!item.text.trim())continue;let line=grouped.find(candidate=>Math.abs(candidate.y-item.y)<=yTolerance);if(!line){line={y:item.y,items:[]};grouped.push(line)};const duplicate=line.items.some(existing=>existing.text.trim()===item.text.trim()&&Math.abs(existing.x-item.x)<=1.25);if(!duplicate)line.items.push({x:item.x,text:item.text});}
  return grouped.sort((a,b)=>b.y-a.y).flatMap(line=>{const columns=line.items.sort((a,b)=>a.x-b.x).map(item=>({x:item.x,text:item.text.trim()}));const text=columns.map(item=>item.text).join(' ').replace(/\s+/g,' ').trim();return text?[{text,page,y:line.y,columns}]:[]});
}

export async function parseChasePdf(file: File): Promise<Draft> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF statement.');
  const bytes = await file.arrayBuffer();
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const lines: PdfTextLine[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const positioned=(content.items as Array<{str:string;transform?:number[]}>).filter(item=>item.str?.trim()&&item.transform).map(item=>({text:item.str,x:item.transform![4],y:item.transform![5]}));
    lines.push(...reconstructPdfPageLines(positioned,pageNumber));
  }
  const readable = lines.map(line=>line.text).join(' ');
  if (readable.trim().length < 80) throw new Error('This PDF contains too little readable text. It may be scanned or password protected. Try a text-based Chase PDF, or enter the statement manually.');
  return parseChaseText(lines, file.name, new Blob([bytes], { type: 'application/pdf' }), document.numPages);
}

async function digest(bytes:ArrayBuffer) {
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export function draftStatus(draft:Draft) { return reconcile(draft); }
