import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = await readFile(join(root, 'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'), 'utf8');
const septemberFixture = await readFile(join(root, 'tests/fixtures/chase-freedom-sep-2026-synthetic.txt'), 'utf8');
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
  assert.equal(model.sum(draft.transactions.filter(t => t.type === 'payment').map(t => t.amount)), -1310);
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

test('synthetic September statement retains purchase section across a continued page and matches exact totals', async () => {
  const draft = await parser.parseChaseText(septemberFixture);
  assert.equal(draft.transactions.length, 70);
  assert.equal(draft.transactions.filter(t => t.type === 'payment').length, 23);
  assert.equal(draft.transactions.filter(t => t.type === 'credit').length, 1);
  assert.equal(draft.transactions.filter(t => t.type === 'purchase').length, 45);
  assert.equal(draft.transactions.filter(t => t.type === 'interest').length, 1);
  assert.equal(model.sum(draft.transactions.filter(t => ['payment','credit'].includes(t.type)).map(t => t.amount)), -2497.14);
  assert.equal(model.sum(draft.transactions.filter(t => t.type === 'purchase').map(t => t.amount)), 2339.90);
  assert.equal(model.sum(draft.transactions.filter(t => t.type === 'interest').map(t => t.amount)), 144.04);
  assert.equal(draft.transactions.find(t => t.type === 'credit').amount, -14.14);
  assert.equal(draft.summaryTotals.paymentsAndCredits, -2497.14);
  assert.equal(draft.summaryTotals.purchases, 2339.90);
  assert.equal(draft.summaryTotals.interest, 144.04);
  assert.equal(draft.previous, 6590.13);
  assert.equal(draft.ending, 6576.93);
  assert.equal(draft.periodStart, '2026-08-21');
  assert.equal(draft.periodEnd, '2026-09-20');
  assert.equal(draft.dueDate, '2026-10-17');
  assert.equal(draft.pagesProcessed, 2);
  assert.equal(draft.continuedActivityFound, true);
  assert.ok(draft.transactions.some(t => t.type === 'purchase' && t.page === 1));
  assert.ok(draft.transactions.some(t => t.type === 'purchase' && t.page === 2));
  assert.ok(draft.transactions.filter(t => t.type === 'purchase').some(t => t.date.startsWith('2026-08-')));
  assert.ok(draft.transactions.filter(t => t.type === 'purchase').some(t => t.date.startsWith('2026-09-')));
  assert.ok(Object.values(draft.transactions.filter(t => t.type === 'payment').reduce((counts,t)=>({...counts,[t.date]:(counts[t.date]??0)+1}),{})).some(count=>count>1));
  assert.ok(draft.transactions.filter(t => t.description.startsWith('FIC MARKET')).length>1);
  assert.ok(!draft.transactions.some(t => t.amount === 3333.86));
  assert.equal(draft.pointsPrevious, 1414);
  assert.equal(draft.pointsEarned, 4075);
  assert.equal(draft.pointsRedeemed, 1414);
  assert.equal(draft.rewardBalance, 4075);
  assert.deepEqual(draft.pointsBreakdown.map(x => x.points), [1037, 2340, 458, 240]);
  const result = model.reconcile(draft);
  assert.equal(result.status, 'Reconciled');
  assert.equal(result.summaryDifference, 0);
  assert.deepEqual(result.detailMismatches, []);
});

test('duplicate heading words are normalized, while transaction descriptions are left intact', async () => {
  assert.equal(parser.normalizeHeading('ACCOUNTACCOUNT ACTIVITYACTIVITY'), 'ACCOUNT ACTIVITY');
  assert.equal(parser.normalizeHeading('ACCOUNT ACTIVITY (CONTINUED)'), 'ACCOUNT ACTIVITY CONTINUED');
  const lines = parser.reconstructPdfPageLines([
    {text:'ACCOUNT',x:0,y:100}, {text:'ACCOUNT',x:0.3,y:100},
    {text:'ACTIVITY',x:90,y:99}, {text:'ACTIVITY',x:90.2,y:99},
    {text:'FIC MARKET MARKET',x:0,y:80}, {text:'$14.14',x:300,y:80},
  ], 1);
  assert.equal(lines[0].text, 'ACCOUNT ACTIVITY');
  assert.equal(lines[1].text, 'FIC MARKET MARKET $14.14');
});

test('summary found with zero parsed transactions is a review failure, never a reconciled statement', async () => {
  const broken = await parser.parseChaseText(fixture.replace('ACCOUNTACCOUNT ACTIVITYACTIVITY', 'UNRECOGNIZED SECTION'));
  assert.equal(broken.summarySectionFound, true);
  assert.equal(broken.transactions.length, 0);
  assert.equal(broken.extractionFailed, true);
  assert.ok(broken.warnings.includes('Transaction extraction failed. The statement summary was found, but CardVault could not read the transaction table.'));
  assert.equal(model.reconcile(broken).status, 'Needs Review');
});

test('blank trailing PDF page is counted but contributes no transaction rows; unreadable text fails clearly', async () => {
  const withBlankPage = await parser.parseChaseText(septemberFixture + '\f');
  assert.equal(withBlankPage.pagesProcessed, 3);
  assert.equal(withBlankPage.transactions.length, 70);
  await assert.rejects(() => parser.parseChaseText('Chase'), /too little readable text/i);
});
