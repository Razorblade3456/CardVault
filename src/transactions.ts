import { DEFAULT_CATEGORIES, sum } from './model';
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
    categories: [...new Set([...(input.categories ?? []), ...DEFAULT_CATEGORIES])],
    merchantRules: input.merchantRules ?? [],
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

export function findMerchantRule(rules: MerchantRule[], description: string, cardId: string) {
  const key = normalizeMerchant(description);
  if (!key) return undefined;
  return rules.find(rule => rule.merchantKey === key && rule.cardId === cardId)
    ?? rules.find(rule => rule.merchantKey === key && rule.cardId === null);
}

export function applyMerchantRules<T extends { cardId: string; transactions: Tx[] }>(statement: T, rules: MerchantRule[]): T {
  return {
    ...statement,
    transactions: statement.transactions.map(tx => {
      if (tx.categorySource === 'manual' || tx.source === 'manual' || tx.type !== 'purchase') return tx;
      const rule = findMerchantRule(rules, tx.description, statement.cardId);
      return rule ? { ...tx, category: rule.category, categorySource: 'merchant-rule' as const } : tx;
    }),
  };
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

