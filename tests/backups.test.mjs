import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: `${root}/vite.config.ts`, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'silent' });
let backups;
try { backups = await vite.ssrLoadModule('/src/backups.ts'); }
finally { await vite.close(); }

function sampleData(pdf = new Blob(['%PDF original Chase statement'], { type: 'application/pdf' })) {
  return {
    cards: [{ id: 'freedom', nickname: 'Freedom Flex', type: 'Freedom Flex', last4: '1234', closingDay: 20, rewardsProgram: 'Ultimate Rewards', rates: {}, pointValue: null, createdAt: '2026-01-01' }],
    statements: [{ id: 'statement-1', cardId: 'freedom', periodStart: '2026-01-21', periodEnd: '2026-02-20', dueDate: '2026-03-17', previous: 100, ending: 110, minimum: 25, pointsEarned: 10, pointsRedeemed: null, rewardBalance: 50, summaryTotals: { purchases: 10, paymentsAndCredits: 0, cashAdvances: 0, balanceTransfers: 0, interest: 0, fees: 0 }, activitySectionFound: true, transactions: [{ id: 'purchase-1', date: '2026-02-02', description: 'Test Market', amount: 10, type: 'purchase', category: 'Custom', source: 'extracted' }], status: 'Reconciled', difference: 0, pdf, fileName: 'statement.pdf', hash: 'hash-1', createdAt: '2026-02-20', corrections: [] }],
    categories: ['Uncategorized', 'Custom'], merchantRules: [{ id: 'rule-1', merchantKey: 'TEST MARKET', label: 'Test Market', category: 'Custom', cardId: 'freedom', matchMode: 'merchant', enabled: true }], recurringDecisions: { 'freedom:test': 'confirmed' }, dataVersion: 2, theme: 'dark', tutorialDone: true, lastBackup: null, graceDays: 7,
  };
}

test('backup round-trip preserves cards, statements, transactions, rewards, custom categories, rules, and source PDFs', async () => {
  const original = sampleData();
  const blob = await backups.createBackup(original);
  const restored = await backups.readBackup(blob);
  assert.equal(restored.missingPdfCount, 0);
  assert.equal(restored.data.cards[0].nickname, original.cards[0].nickname);
  assert.ok(restored.data.categories.includes('Custom'));
  assert.deepEqual(restored.data.merchantRules, original.merchantRules);
  assert.deepEqual(restored.data.recurringDecisions, original.recurringDecisions);
  assert.equal(restored.data.statements[0].transactions[0].amount, 10);
  assert.equal(restored.data.statements[0].pointsEarned, 10);
  assert.equal(await restored.data.statements[0].pdf.text(), '%PDF original Chase statement');
});

test('a backup with a missing PDF restores its statement and reports the file for safe reattachment', async () => {
  const blob = await backups.createBackup(sampleData(new Blob([])));
  const restored = await backups.readBackup(blob);
  assert.equal(restored.missingPdfCount, 1);
  assert.equal(restored.data.statements.length, 1);
  assert.equal(restored.data.statements[0].transactions.length, 1);
  assert.equal(restored.data.statements[0].pdf.size, 0);
});

test('merging a backup can restore a missing PDF without replacing current statement edits or preferences', () => {
  const current = sampleData(new Blob([]));
  current.statements[0].transactions[0].category = 'Travel';
  current.statements[0].rewardBalance = 75;
  current.theme = 'light';
  current.recurringDecisions['freedom:test'] = 'dismissed';
  const incoming = sampleData();
  incoming.cards[0].nickname = 'Old card name';
  const merged = backups.mergeBackupData(current, incoming);
  assert.equal(merged.statements.length, 1);
  assert.equal(merged.statements[0].transactions[0].category, 'Travel');
  assert.equal(merged.statements[0].rewardBalance, 75);
  assert.ok(merged.statements[0].pdf.size > 0);
  assert.equal(merged.cards[0].nickname, 'Freedom Flex');
  assert.equal(merged.theme, 'light');
  assert.equal(merged.recurringDecisions['freedom:test'], 'dismissed');
});
