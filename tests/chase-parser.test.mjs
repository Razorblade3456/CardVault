import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = await readFile(join(root, 'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'), 'utf8');
const vite = await createServer({ configFile: join(root, 'vite.config.ts'), server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'silent' });
let parser, model;
try {
  parser = await vite.ssrLoadModule('/src/parser.ts');
  model = await vite.ssrLoadModule('/src/model.ts');
} finally {
  await vite.close();
}

test('synthetic Chase August statement extracts 19 Account Activity rows and ignores non-transaction amounts', async () => {
  const draft = await parser.parseChaseText(fixture);
  assert.equal(draft.transactions.length, 19);
  assert.equal(draft.transactions.filter(t => t.type === 'purchase').length, 12);
  assert.equal(model.sum(draft.transactions.filter(t => t.type === 'purchase').map(t => t.amount)), 1091.72);
  assert.equal(draft.transactions.filter(t => t.type === 'payment').length, 6);
  assert.equal(model.sum(draft.transactions.filter(t => t.type === 'payment').map(t => t.amount)), 1310);
  assert.equal(draft.transactions.filter(t => t.type === 'interest').length, 1);
  assert.equal(model.sum(draft.transactions.filter(t => t.type === 'interest').map(t => t.amount)), 148.62);
  assert.equal(draft.previous, 6659.79);
  assert.equal(draft.ending, 6590.13);
  assert.equal(draft.minimum, 214);
  assert.equal(draft.periodStart, '2026-07-21');
  assert.equal(draft.periodEnd, '2026-08-20');
  assert.equal(draft.dueDate, '2026-09-17');
  assert.equal(draft.pointsPrevious, 322);
  assert.equal(draft.pointsEarned, 1092);
  assert.equal(draft.rewardBalance, 1414);
  assert.ok(!draft.transactions.some(t => t.amount === 3333.86), 'APR balance-subject amount must not become a transaction');
  assert.ok(!draft.transactions.some(t => /minimum payment|balance subject|year.to.date|points/i.test(t.description)));
  assert.ok(draft.suspiciousRows.some(row => /214\.00/.test(row.line)));
  assert.deepEqual(draft.summaryTotals, { purchases: 1091.72, paymentsAndCredits: -1310, cashAdvances: 0, balanceTransfers: 0, interest: 148.62, fees: 0 });
  const result = model.reconcile(draft);
  assert.equal(result.status, 'Reconciled');
  assert.equal(result.summaryDifference, 0);
  assert.deepEqual(result.detailMismatches, []);
});

test('summary balance passing with incomplete transaction totals remains Needs Review', async () => {
  const draft = await parser.parseChaseText(fixture.replace('08/01/26 08/02/26 FICTIONAL SHOP 50.00\n', ''));
  const result = model.reconcile(draft);
  assert.equal(result.summaryPassed, true);
  assert.equal(result.status, 'Needs Review');
  assert.ok(result.detailMismatches.some(m => m.category === 'Purchases'));
});
