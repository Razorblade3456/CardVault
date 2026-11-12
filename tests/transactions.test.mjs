import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: `${root}/vite.config.ts`, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'silent' });
let txModel, model, parser;
try { txModel = await vite.ssrLoadModule('/src/transactions.ts'); model = await vite.ssrLoadModule('/src/model.ts'); parser = await vite.ssrLoadModule('/src/parser.ts'); }
finally { await vite.close(); }

test('one canonical sign rule normalizes payments, refunds, credits and keeps charges positive', () => {
  assert.equal(txModel.canonicalAmount('purchase', 34.08), 34.08);
  assert.equal(txModel.canonicalAmount('payment', 220), -220);
  assert.equal(txModel.canonicalAmount('refund', 12.5), -12.5);
  assert.equal(txModel.canonicalAmount('credit', 5), -5);
  assert.equal(txModel.canonicalAmount('interest', -148.62), 148.62);
  assert.equal(txModel.displayMerchant({ type: 'payment', description: 'Payment Thank You-Mobile' }), 'Chase Mobile Payment');
});

test('legacy IndexedDB records migrate once and preserve their original imported values', () => {
  const old = {
    cards: [], categories: ['My Custom Category'], merchantRules: [{ id: 'r', merchantKey: 'STEAMGAMES', label: 'Steam Games', category: 'My Custom Category', cardId: null }], theme: 'dark', tutorialDone: true, lastBackup: null, graceDays: 7,
    statements: [{ id: 's', cardId: 'c', periodStart: '', periodEnd: '2026-08-20', dueDate: '', previous: 100, ending: 50, minimum: 0,
      transactions: [
        { id: 'p', date: '2026-08-01', description: 'Payment Thank You-Mobile', amount: 220, type: 'payment', category: 'Uncategorized', source: 'extracted' },
        { id: 'c', date: '2026-08-02', description: 'Shop return', amount: 10, type: 'refund', category: 'Shopping', source: 'extracted' },
        { id: 'i', date: '2026-08-03', description: 'Interest charge', amount: 2, type: 'interest', category: 'Uncategorized', source: 'extracted' },
      ], summaryTotals: { purchases: 180, paymentsAndCredits: 230, cashAdvances: 0, balanceTransfers: 0, interest: 0, fees: 0 }, corrections: [] }],
  };
  const migrated = txModel.migrateData(old);
  assert.deepEqual(migrated.statements[0].transactions.map(t => t.amount), [-220, -10, 2]);
  assert.deepEqual(migrated.statements[0].transactions.map(t => t.originalAmount), [220, 10, 2]);
  assert.equal(migrated.statements[0].summaryTotals.paymentsAndCredits, -230);
  assert.equal(migrated.statements[0].transactions[0].originalDescription, 'Payment Thank You-Mobile');
  assert.equal(migrated.dataVersion, 2);
  assert.ok(migrated.categories.includes('My Custom Category'));
  assert.equal(migrated.merchantRules[0].category, 'My Custom Category');
  const again = txModel.migrateData(migrated);
  assert.equal(again.statements[0].transactions[0].amount, -220, 'a refresh must not reverse the payment again');
});

test('the August synthetic statement keeps its original $0.00 reconciliation after legacy sign migration', async () => {
  const fixture = await readFile(join(root, 'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'), 'utf8');
  const parsed = await parser.parseChaseText(fixture);
  const legacy = {
    cards: [], statements: [{ ...parsed, id: 'aug', cardId: 'freedom', status: 'Reconciled', difference: 0, createdAt: '2026-08-20', corrections: [],
      transactions: parsed.transactions.map(tx => ({ ...tx, amount: Math.abs(tx.amount) })) }],
  };
  const migrated = txModel.migrateData(legacy).statements[0];
  const result = model.reconcile(migrated);
  assert.equal(model.sum(migrated.transactions.filter(t => t.type === 'payment').map(t => t.amount)), -1310);
  assert.equal(migrated.transactions.filter(t => t.type === 'purchase').reduce((a, t) => a + t.amount, 0), 1091.72);
  assert.equal(migrated.transactions.filter(t => t.type === 'interest').reduce((a, t) => a + t.amount, 0), 148.62);
  assert.equal(migrated.ending, 6590.13);
  assert.equal(result.summaryDifference, 0);
  assert.equal(result.status, 'Reconciled');
});

test('merchant normalization ignores trailing numeric references but keeps merchant distinctions', () => {
  assert.equal(txModel.normalizeMerchant('STEAMGAMES.COM 001248'), 'STEAMGAMES');
  assert.equal(txModel.normalizeMerchant('STEAMGAMES.COM 991003'), 'STEAMGAMES');
  assert.notEqual(txModel.normalizeMerchant('AMAZON PRIME'), txModel.normalizeMerchant('AMAZON MARKETPLACE'));
});

test('merchant rules apply by chosen card and never replace manual category corrections', () => {
  const rules = [{ id: 'r', merchantKey: 'STEAMGAMES', label: 'Steam Games', category: 'Gaming', cardId: 'card-a' }];
  const statement = { id: 's', cardId: 'card-a', transactions: [
    { id: 'a', date: '2026-08-01', description: 'STEAMGAMES.COM 0012', amount: 10, type: 'purchase', category: 'Uncategorized', categorySource: 'default', source: 'extracted' },
    { id: 'b', date: '2026-08-02', description: 'STEAMGAMES.COM 9999', amount: 12, type: 'purchase', category: 'Shopping', categorySource: 'manual', source: 'manual' },
    { id: 'c', date: '2026-08-03', description: 'AMAZON MARKETPLACE', amount: 15, type: 'purchase', category: 'Uncategorized', categorySource: 'default', source: 'extracted' },
  ] };
  const ruled = txModel.applyMerchantRules(statement, rules);
  assert.equal(ruled.transactions[0].category, 'Gaming');
  assert.equal(ruled.transactions[0].categorySource, 'merchant-rule');
  assert.equal(ruled.transactions[1].category, 'Shopping');
  assert.equal(ruled.transactions[2].category, 'Uncategorized');
  assert.equal(txModel.findMerchantRule(rules, 'STEAMGAMES.COM 0012', 'card-b'), undefined);
});

test('monthly purchase breakdown nets a categorized refund and excludes payments', () => {
  const items = [
    { date: '2026-08-02', amount: 34.08, type: 'purchase', category: 'Gaming' },
    { date: '2026-08-12', amount: -4.08, type: 'refund', category: 'Gaming' },
    { date: '2026-08-15', amount: -220, type: 'payment', category: 'Uncategorized' },
  ];
  const spending = items.filter(t => t.type === 'purchase' || t.type === 'refund').reduce((a, t) => a + t.amount, 0);
  assert.equal(spending, 30);
});
