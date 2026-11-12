import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Statement,Tx,TxType } from './model';
import { uid,reconcile } from './model';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
export type Draft=Omit<Statement,'cardId'|'status'|'difference'|'id'|'createdAt'|'corrections'> & { extractedText:string; warnings:string[]; accountLast4:string|null; corrections:string[] };
const amount=(s:string):number|null=>{const n=Number(s.replace(/[$,]/g,''));return Number.isFinite(n)?Math.round(n*100)/100:null};
function dateISO(s:string){const numeric=s.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);if(numeric){let y=numeric[3]?Number(numeric[3]):new Date().getFullYear();if(y<100)y+=2000;return `${y}-${numeric[1].padStart(2,'0')}-${numeric[2].padStart(2,'0')}`;}const parsed=Date.parse(s);if(Number.isFinite(parsed)){const d=new Date(parsed);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}return null;}
export async function parseChasePdf(file:File):Promise<Draft>{
 if(file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf'))throw new Error('Choose a PDF statement.');
 const bytes=await file.arrayBuffer();const doc=await pdfjs.getDocument({data:bytes}).promise;let all='';
 for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const c=await page.getTextContent();let lastY:number|undefined;let line='';for(const item of c.items as Array<{str:string;transform?:number[]}>){const y=item.transform?.[5];if(lastY!==undefined&&y!==undefined&&Math.abs(lastY-y)>3){all+=line+'\n';line='';}line+=item.str+' ';if(y!==undefined)lastY=y;}all+=line+'\n';}
 const text=all.replace(/\s+/g,' ').trim();if(text.length<80)throw new Error('This PDF contains too little readable text. It may be scanned or password protected. Try a text-based Chase PDF, or enter the statement manually.');
 if(!/chase|jpmorgan|jp morgan/i.test(text))throw new Error('This does not appear to be a Chase statement. CardVault version 1 supports Chase credit cards only.');
 const warnings:string[]=[];const grab=(patterns:RegExp[])=>{for(const re of patterns){const m=text.match(re);if(m){const n=amount(m[1]);if(n!=null)return n;}}return null;};
 const previous=grab([/(?:previous|prior) balance\s*\$?\s*(-?[\d,]+\.\d{2})/i]);
 const ending=grab([/(?:new balance|statement balance|ending balance|account balance)\s*\$?\s*(-?[\d,]+\.\d{2})/i]);
 const minimum=grab([/(?:minimum payment due|minimum payment)\s*\$?\s*(-?[\d,]+\.\d{2})/i]);
 const pointCount=(patterns:RegExp[])=>{for(const re of patterns){const m=text.match(re);if(m){const n=Number(m[1].replace(/,/g,''));if(Number.isFinite(n))return n;}}return null;};
 const pointsEarned=pointCount([/(?:points earned this statement|points earned this billing cycle|points earned this period)\s*:?\s*([\d,]+)/i]);
 const pointsRedeemed=pointCount([/(?:points redeemed|points used)\s*:?\s*([\d,]+)/i]);
 const rewardBalance=pointCount([/(?:available points|points balance|available rewards balance)\s*:?\s*([\d,]+)/i]);
 const dueMatch=text.match(/(?:payment due date|due date)\s*:?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i);
 const periodMatches=[...text.matchAll(/(?:billing cycle|statement period|opening date|closing date|new balance as of)\s*:?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/gi)].map(x=>x[1]);
 let dates=periodMatches.map(dateISO).filter((x):x is string=>!!x);const periodEnd=dates[dates.length-1]??null;const periodStart=dates[0]??null;
 const cardNums=[...text.matchAll(/(?:account|card)(?:\s+(?:number|ending|no\.))?\s*(?:\*+|x+|ending\s+in\s+)?(\d{4})\b/gi)].map(x=>x[1]);
 const accountLast4=cardNums.length?cardNums[0]:null;
 // Chase statement tables are highly variable. Only treat clearly dated rows as candidates;
 // all values remain reviewable and the generic parser never claims universal layout support.
 const transactions:Tx[]=[];
 const rowRe=/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.{3,65}?)\s+\$?(-?[\d,]+\.\d{2})\b/g;
 for(const m of text.matchAll(rowRe)){const dt=dateISO(m[1]);const desc=m[2].trim().replace(/\s+/g,' ');const amt=amount(m[3]);if(!dt||amt==null||desc.length<3)continue;if(/previous balance|new balance|minimum payment|total fees|total interest|rewards summary/i.test(desc))continue;
  let type:TxType='purchase';if(/payment|autopay|thank you/i.test(desc))type='payment';else if(/interest/i.test(desc))type='interest';else if(/annual fee|late fee|fee/i.test(desc))type='fee';else if(/refund|return/i.test(desc))type='refund';else if(amt<0)type='credit';
  transactions.push({id:uid(),date:dt,description:desc,amount:Math.abs(amt),type,category:categorize(desc),source:'extracted'});
 }
 if(!transactions.length)warnings.push('No transaction rows were confidently recognized. Add or correct transactions before reconciling.');
 if(previous==null)warnings.push('Previous balance was not confidently found.');if(ending==null)warnings.push('New statement balance was not confidently found.');if(!periodEnd)warnings.push('Statement closing date was not confidently found.');
 const stmt={periodStart:periodStart??'',periodEnd:periodEnd??'',dueDate:dueMatch?(dateISO(dueMatch[1])??''):'',previous,ending,minimum,opening:periodStart??'',transactions,pointsEarned,pointsRedeemed,rewardBalance,pdf:new Blob([bytes],{type:'application/pdf'}),fileName:file.name,hash:await hash(bytes)};
 if(!dueMatch)warnings.push('Payment due date was not found.');
 return {...stmt,extractedText:text,warnings,accountLast4,corrections:[]};
}
function categorize(s:string){if(/grocery|market|whole foods|trader joe/i.test(s))return'Groceries';if(/restaurant|cafe|coffee|doordash|uber eats/i.test(s))return'Dining';if(/shell|chevron|exxon|fuel|gas station/i.test(s))return'Gas';if(/amazon/i.test(s))return'Shopping';if(/hotel|airline|uber|lyft/i.test(s))return'Travel';return'Uncategorized';}
async function hash(bytes:ArrayBuffer){const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function draftStatus(d:Draft){return reconcile(d);}
