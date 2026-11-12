import { DEFAULT_CATEGORIES } from './model';
import type { AppData, MerchantRule, Tx, TxType } from './model';

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

