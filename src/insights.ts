import { reconcile, sum } from './model';
import { displayMerchant, normalizeMerchant } from './transactions';
import type { Statement, Tx } from './model';

export type ReportingBasis = 'statement' | 'transaction';
export type SpendRow = { period: string; purchases: number; refunds: number; net: number; transactions: Tx[] };
export type RecurringCandidate = { key: string; cardId: string; merchantKey: string; merchant: string; count: number; amount: number; category: string; intervalDays: number; transactions: Tx[] };

export function periodFor(statement: Statement, tx: Tx, basis: ReportingBasis) {
  return basis === 'statement' ? statement.periodEnd?.slice(0, 7) || 'Unknown' : tx.date?.slice(0, 7) || 'Unknown';
}

/** Purchases less refunds only; payment/credit/interest rows are never spending. */
export function spendingByPeriod(statements: Statement[], basis: ReportingBasis, category = 'all') {
  const groups = new Map<string, Tx[]>();
  for (const statement of statements) for (const tx of statement.transactions) {
    if (tx.type !== 'purchase' && tx.type !== 'refund') continue;
    if (category !== 'all' && (tx.category || 'Uncategorized') !== category) continue;
    const period = periodFor(statement, tx, basis);
    groups.set(period, [...(groups.get(period) ?? []), tx]);
  }
  return [...groups].map(([period, transactions]) => ({
    period,
    purchases: sum(transactions.filter(tx => tx.type === 'purchase').map(tx => Math.abs(tx.amount))),
    refunds: sum(transactions.filter(tx => tx.type === 'refund').map(tx => -Math.abs(tx.amount))),
    net: sum(transactions.map(tx => tx.type === 'refund' ? -Math.abs(tx.amount) : Math.abs(tx.amount))),
    transactions,
  } satisfies SpendRow)).sort((a, b) => a.period.localeCompare(b.period));
}

/** Keep review reports strictly tied to statements whose transaction details reconciled. */
export function verifiedStatements(statements: Statement[]) {
  return statements.filter(statement => statement.status === 'Reconciled' && reconcile(statement).status === 'Reconciled' && statement.ending != null && statement.previous != null &&
    statement.summaryTotals != null && Object.values(statement.summaryTotals).every(value => value != null) &&
    statement.detailMismatches?.length === 0).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

function daysBetween(a: string, b: string) {
  const first = Date.parse(`${a}T00:00:00Z`), second = Date.parse(`${b}T00:00:00Z`);
  return Number.isFinite(first) && Number.isFinite(second) ? Math.round((second - first) / 86400000) : null;
}

/** Conservative candidates: at least 3 same-card purchases with regular monthly or weekly timing. */
export function recurringCandidates(statements: Statement[]): RecurringCandidate[] {
  const groups = new Map<string, { cardId: string; transactions: Tx[] }>();
  for (const statement of statements) for (const tx of statement.transactions) {
    if (tx.type !== 'purchase') continue;
    const merchantKey = normalizeMerchant(tx.description);
    if (!merchantKey) continue;
    const key = `${statement.cardId}:${merchantKey}`;
    const group = groups.get(key) ?? { cardId: statement.cardId, transactions: [] };
    group.transactions.push(tx); groups.set(key, group);
  }
  const candidates: RecurringCandidate[] = [];
  for (const [key, group] of groups) {
    const unique = [...new Map(group.transactions.map(tx => [`${tx.date}|${tx.type}|${tx.amount}`, tx])).values()]
      .sort((a, b) => a.date.localeCompare(b.date));
    if (unique.length < 3) continue;
    const gaps = unique.slice(1).map((tx, index) => daysBetween(unique[index].date, tx.date)).filter((n): n is number => n != null);
    const regular = gaps.filter(n => (n >= 20 && n <= 45) || (n >= 5 && n <= 12));
    if (regular.length < 2 || regular.length / gaps.length < .66) continue;
    const category = unique.map(tx => tx.category || 'Uncategorized').sort((a, b) =>
      unique.filter(tx => (tx.category || 'Uncategorized') === b).length - unique.filter(tx => (tx.category || 'Uncategorized') === a).length)[0];
    const last = unique[unique.length - 1];
    candidates.push({ key, cardId: group.cardId, merchantKey: normalizeMerchant(last.description), merchant: displayMerchant(last), count: unique.length,
      amount: Math.round(sum(unique.map(tx => tx.amount)) / unique.length * 100) / 100, category, intervalDays: Math.round(regular.reduce((a, b) => a + b, 0) / regular.length), transactions: unique });
  }
  return candidates.sort((a, b) => a.merchant.localeCompare(b.merchant));
}

export function monthlyStatementObservations(statement: Statement, prior?: Statement | null) {
  const totals = statement.summaryTotals;
  if (!totals || statement.previous == null || statement.ending == null) return ['Some statement totals are unavailable, so this review is incomplete.'];
  const observations: string[] = [];
  const delta = Math.round((statement.ending - statement.previous) * 100) / 100;
  observations.push(delta > 0 ? `The statement balance increased by $${delta.toFixed(2)} to $${statement.ending.toFixed(2)}.` : delta < 0 ? `The statement balance decreased by $${Math.abs(delta).toFixed(2)} to $${statement.ending.toFixed(2)}.` : `The statement balance was unchanged at $${statement.ending.toFixed(2)}.`);
  if (prior?.summaryTotals?.interest != null && totals.interest != null) {
    const interestDelta = Math.round((Math.abs(totals.interest) - Math.abs(prior.summaryTotals.interest)) * 100) / 100;
    if (interestDelta !== 0) observations.push(`Interest ${interestDelta > 0 ? 'increased' : 'decreased'} by $${Math.abs(interestDelta).toFixed(2)} from the prior statement.`);
  }
  const categories = new Map<string, number>();
  for (const tx of statement.transactions) if (tx.type === 'purchase' || tx.type === 'refund') categories.set(tx.category || 'Uncategorized', sum([categories.get(tx.category || 'Uncategorized') ?? 0, tx.type === 'refund' ? -Math.abs(tx.amount) : Math.abs(tx.amount)]));
  const leader = [...categories].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1])[0];
  observations.push(leader ? `${leader[0]} was the largest categorized net spending category at $${leader[1].toFixed(2)}.` : 'Categorized spending highlights are unavailable for this statement.');
  return observations;
}
