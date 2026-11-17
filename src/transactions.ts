import { DEFAULT_CATEGORIES, money, sum } from './model';
import { uniqueCategoryNames } from './categories';
import type { AppData, MerchantRule, Statement, Tx, TxType } from './model';

const NEGATIVE_TYPES: TxType[] = ['payment', 'refund', 'credit'];

export function canonicalAmount(type: TxType, value: number) {
  const cents = Math.round(Math.abs(value) * 100) / 100;
  return NEGATIVE_TYPES.includes(type) ? -cents : cents;
}

export function migrateData(input: Partial<AppData> & Pick<AppData, 'cards' | 'statements'>): AppData {
  const old = (input.dataVersion ?? 0) < 2;
  const statements = input.statements.map(statement => ({
    ...statement,
    transactions: statement.transactions.map(tx => ({
      ...tx,
      originalDescription: tx.originalDescription ?? tx.description,
      originalAmount: tx.originalAmount ?? tx.amount,
      amount: old ? canonicalAmount(tx.type, tx.amount) : tx.amount,
      categorySource: tx.categorySource ?? (tx.source === 'manual' ? 'manual' as const : 'default' as const),
    })),
    summaryTotals: statement.summaryTotals ? {
      ...statement.summaryTotals,
      paymentsAndCredits: statement.summaryTotals.paymentsAndCredits == null ? null : -Math.abs(statement.summaryTotals.paymentsAndCredits),
    } : statement.summaryTotals,
  }));
  return {
    ...input,
    cards: input.cards.map(card => ({ ...card, pointValue: card.pointValue ?? null, pointValueConfigured: card.pointValueConfigured ?? (card.pointValue != null && card.pointValue !== 1) })),
    statements,
    categories: uniqueCategoryNames([...(input.categories ?? []), ...statements.flatMap(statement=>statement.transactions.map(tx=>tx.category)), ...(input.merchantRules??[]).map(rule=>rule.category), ...DEFAULT_CATEGORIES]),
    merchantRules: input.merchantRules ?? [],
    recurringDecisions: input.recurringDecisions ?? {},
    dataVersion: 2,
    theme: input.theme ?? 'dark',
    tutorialDone: input.tutorialDone ?? false,
    lastBackup: input.lastBackup ?? null,
    graceDays: input.graceDays ?? 7,
  };
}

/** Remove trailing numeric reference/location codes, but preserve every merchant word. */
export function normalizeMerchant(description: string) {
  return description.toUpperCase()
    .replace(/\bHTTPS?:\/\//g, '')
    .replace(/\bWWW\./g, '')
    .replace(/\.COM\b/g, '')
    .replace(/\b(?:REF|REFERENCE|CONF|CONFIRMATION|ID|TRANS|TRACE|#)\s*[:#-]?\s*[A-Z0-9-]+\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+\d+[A-Z0-9-]*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findMerchantRule(rules: MerchantRule[], description: string, cardId: string, amount?: number) {
  const key = normalizeMerchant(description);
  if (!key) return undefined;
  const candidates = rules.filter(rule => rule.enabled !== false && rule.applyToFuture !== false && rule.merchantKey === key && (rule.cardId === cardId || rule.cardId === null))
    .filter(rule => rule.matchMode !== 'exact' || (amount != null && Math.round(Math.abs(amount) * 100) === Math.round(Math.abs(rule.amount ?? NaN) * 100)))
    .filter(rule => rule.matchMode !== 'range' || (amount != null && Math.abs(amount) >= (rule.minAmount ?? 0) && Math.abs(amount) <= (rule.maxAmount ?? Number.POSITIVE_INFINITY)));
  const priority = (rule: MerchantRule) => rule.matchMode === 'exact' ? 3 : rule.matchMode === 'range' ? 2 : 1;
  candidates.sort((a,b) => priority(b)-priority(a) || Number(b.cardId===cardId)-Number(a.cardId===cardId));
  const first = candidates[0];
  if (!first) return undefined;
  // Equal-priority rules that disagree are ambiguous. Leave the row to existing suggestions.
  if (candidates.some(rule => priority(rule) === priority(first) && rule.cardId === first.cardId && (rule.category !== first.category || rule.recurring !== first.recurring))) return undefined;
  return first;
}

export function applyMerchantRules<T extends { cardId: string; transactions: Tx[] }>(statement: T, rules: MerchantRule[]): T {
  return {
    ...statement,
    transactions: statement.transactions.map(tx => {
      if (tx.categorySource === 'manual' || tx.source === 'manual' || tx.type !== 'purchase') return tx;
      const rule = findMerchantRule(rules, tx.description, statement.cardId, tx.amount);
      return rule ? { ...tx, category: rule.category, categorySource: 'merchant-rule' as const, categoryRuleId:rule.id, categoryBeforeRule:tx.categorySource==='merchant-rule'?tx.categoryBeforeRule??'Uncategorized':tx.category,
        ...(rule.recurring == null && rule.category !== 'Subscriptions' ? {} : { recurring: rule.recurring ?? true, recurringSource: (rule.recurring == null ? 'category' : 'merchant-rule') as 'category'|'merchant-rule' }) } : tx;
    }),
  };
}

export function matchesMerchantRule(rule:MerchantRule,cardId:string,tx:Tx){
 if(tx.type!=='purchase'||(rule.cardId!==null&&rule.cardId!==cardId)||normalizeMerchant(tx.description)!==rule.merchantKey)return false;
 const amount=Math.round(Math.abs(tx.amount)*100);
 if(rule.matchMode==='exact'&&amount!==Math.round(Math.abs(rule.amount??NaN)*100))return false;
 if(rule.matchMode==='range'&&(Math.abs(tx.amount)<(rule.minAmount??0)||Math.abs(tx.amount)>(rule.maxAmount??Number.POSITIVE_INFINITY)))return false;
 return true;
}

export function sameMerchantRuleMatch(a:MerchantRule,b:MerchantRule){
 return a.merchantKey===b.merchantKey&&a.cardId===b.cardId&&(a.matchMode??'merchant')===(b.matchMode??'merchant')&&
  ((a.matchMode==='exact'||!a.matchMode)?Math.round(Math.abs(a.amount??0)*100)===Math.round(Math.abs(b.amount??0)*100):true)&&
  (a.matchMode==='range'?a.minAmount===b.minAmount&&a.maxAmount===b.maxAmount:true);
}

export function assignCategory(tx:Tx,category:string,source:'manual'|'merchant-rule'='manual',ruleId?:string){
 const fromCategorySubscription=tx.recurringSource==='category'&&tx.category==='Subscriptions';
 const recurringPatch=category==='Subscriptions'?{recurring:true,recurringSource:(source==='merchant-rule'?'merchant-rule':'category') as 'category'|'merchant-rule'}:
  fromCategorySubscription?{recurring:false,recurringSource:'manual' as const}:{};
 return {...tx,category,categorySource:source,...(source==='merchant-rule'?{categoryRuleId:ruleId}:{categoryRuleId:undefined}),...recurringPatch};
}

export function mergeReprocessedTransactions(old:Pick<Statement,'transactions'|'corrections'>,fresh:Tx[]){
 const corrected=old.transactions.filter(tx=>tx.source==='manual'||(old.corrections??[]).includes(tx.id));
 const transactions=[...fresh];const conflicts:string[]=[];const matched=new Set<number>();
 const key=(tx:Tx,description=tx.description)=>`${tx.date}|${tx.type}|${normalizeMerchant(description)}`;
 for(const prior of corrected){
  let index=transactions.findIndex((tx,i)=>!matched.has(i)&&key(tx)===key(prior));
  if(index<0&&prior.originalDescription)index=transactions.findIndex((tx,i)=>!matched.has(i)&&key(tx)===key(prior,prior.originalDescription));
  if(index<0){const candidates=transactions.map((tx,i)=>({tx,i})).filter(({tx,i})=>!matched.has(i)&&tx.date===prior.date&&tx.type===prior.type);if(candidates.length===1)index=candidates[0].i}
  if(index>=0){const extracted=transactions[index];matched.add(index);if((old.corrections??[]).includes(prior.id)&&['date','type','description','amount'].some(field=>String(extracted[field as keyof Tx])!==String(prior[field as keyof Tx])))conflicts.push(`Edited row preserved: ${prior.date} · ${prior.description}; saved ${money(prior.amount)}, freshly extracted ${money(extracted.amount)}.`);transactions[index]={...extracted,...prior,source:'manual'};}
  else{transactions.push(prior);conflicts.push(`${prior.date} · ${prior.description} (${money(prior.amount)})`);}
 }
 const removedRows=old.transactions.filter(prior=>prior.source!=='manual'&&!(old.corrections??[]).includes(prior.id)&&!fresh.some(extracted=>key(extracted)===key(prior)));
 return {transactions,conflicts,removedRows};
}

export function signedAmount(value: number) {
  const sign = value < 0 ? '−' : '+';
  return `${sign}${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(value))}`;
}

export function displayMerchant(tx: Pick<Tx, 'type' | 'description'>) {
  if (tx.type === 'payment' && /payment\s+thank\s+you\s*[- ]\s*mobile/i.test(tx.description)) return 'Chase Mobile Payment';
  return tx.description.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

export function transactionSummary(transactions: Tx[]) {
  const byType = (types: TxType[]) => transactions.filter(tx => types.includes(tx.type));
  const purchases = byType(['purchase']);
  const payments = byType(['payment']);
  const credits = byType(['refund','credit']);
  const interestFees = byType(['interest','fee']);
  return {
    count: transactions.length,
    purchasesCount: purchases.length, purchases: sum(purchases.map(tx => tx.amount)),
    paymentsCount: payments.length, payments: sum(payments.map(tx => tx.amount)),
    creditsCount: credits.length, credits: sum(credits.map(tx => tx.amount)),
    interestFeesCount: interestFees.length, interestFees: sum(interestFees.map(tx => tx.amount)),
    net: sum(transactions.map(tx => tx.amount)),
  };
}

export function statementBalanceBridge(statement: Pick<Statement, 'previous'|'ending'|'transactions'|'summaryTotals'>) {
  const totals = statement.summaryTotals;
  const typeSum = (types: TxType[]) => sum(statement.transactions.filter(tx => types.includes(tx.type)).map(tx => tx.amount));
  const purchases = totals?.purchases == null ? typeSum(['purchase']) : Math.abs(totals.purchases);
  const paymentsAndCredits = totals?.paymentsAndCredits == null ? sum(statement.transactions.filter(tx => ['payment','refund','credit'].includes(tx.type)).map(tx => tx.amount)) : -Math.abs(totals.paymentsAndCredits);
  const interest = totals?.interest == null ? typeSum(['interest']) : Math.abs(totals.interest);
  const fees = totals?.fees == null ? typeSum(['fee']) : Math.abs(totals.fees);
  const otherActivity = sum([totals?.cashAdvances ?? typeSum(['cashAdvance']), totals?.balanceTransfers ?? typeSum(['balanceTransfer'])].map(Math.abs));
  const calculated = statement.previous == null ? null : sum([statement.previous, purchases, interest, fees, otherActivity, paymentsAndCredits]);
  return { starting: statement.previous, purchases, interest, fees, paymentsAndCredits, otherActivity, calculated, ending: statement.ending };
}

export function statementDebtChange(statement:Pick<Statement,'previous'|'ending'>){
 return statement.previous==null||statement.ending==null?null:Math.round((statement.ending-statement.previous)*100)/100;
}

export function utilization(balance: number|null|undefined, limit: number|null|undefined) {
  if (balance == null || limit == null || limit <= 0) return null;
  return { percent: balance / limit * 100, remaining: Math.round((limit - balance) * 100) / 100, over: Math.max(0, Math.round((balance - limit) * 100) / 100) };
}

export function completeConsecutiveCoverage(rows: {statement:Statement;tx:Tx}[], allStatements:Statement[]) {
  const byId=new Map<string,{statement:Statement;ids:Set<string>}>();
  for(const row of rows){let group=byId.get(row.statement.id);if(!group){group={statement:row.statement,ids:new Set()};byId.set(row.statement.id,group)}group.ids.add(row.tx.id)}
  const groups=[...byId.values()];if(!groups.length)return false;
  for(const group of groups)if(group.ids.size!==group.statement.transactions.length||group.statement.transactions.some(tx=>!group.ids.has(tx.id)))return false;
  const byCard=new Map<string,Statement[]>();for(const {statement} of groups)byCard.set(statement.cardId,[...(byCard.get(statement.cardId)??[]),statement]);
  for(const cardStatements of byCard.values()){if(cardStatements.length<2)return false;cardStatements.sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));for(let i=1;i<cardStatements.length;i++){if(!cardStatements[i-1].periodEnd||!cardStatements[i].periodStart)return false;const next=new Date(`${cardStatements[i-1].periodEnd}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);if(next.toISOString().slice(0,10)!==cardStatements[i].periodStart)return false}}
  return groups.every(g=>allStatements.some(s=>s.id===g.statement.id));
}

export function latestStatementPerCard(statements:Statement[]) {
  return statements.reduce<Statement[]>((latest,statement)=>{const prior=latest.find(s=>s.cardId===statement.cardId);return !prior||statement.periodEnd>prior.periodEnd?[...latest.filter(s=>s.cardId!==statement.cardId),statement]:latest},[]);
}

