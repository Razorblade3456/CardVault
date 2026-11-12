import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: `${root}/vite.config.ts`, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'silent' });
let txModel, model, parser, categories;
try { txModel = await vite.ssrLoadModule('/src/transactions.ts'); model = await vite.ssrLoadModule('/src/model.ts'); parser = await vite.ssrLoadModule('/src/parser.ts'); categories = await vite.ssrLoadModule('/src/categories.ts'); }
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
        { id: 'g', date: '2026-08-04', description: 'Game store', amount: 12, type: 'purchase', category: 'Gaming', source: 'extracted' },
        { id: 'u', date: '2026-08-05', description: 'Power company', amount: 18, type: 'purchase', category: 'Utilities', source: 'extracted' },
      ], summaryTotals: { purchases: 180, paymentsAndCredits: 230, cashAdvances: 0, balanceTransfers: 0, interest: 0, fees: 0 }, corrections: [] }],
  };
  const migrated = txModel.migrateData(old);
  assert.deepEqual(migrated.statements[0].transactions.slice(0,3).map(t => t.amount), [-220, -10, 2]);
  assert.deepEqual(migrated.statements[0].transactions.slice(0,3).map(t => t.originalAmount), [220, 10, 2]);
  assert.equal(migrated.statements[0].summaryTotals.paymentsAndCredits, -230);
  assert.equal(migrated.statements[0].transactions[0].originalDescription, 'Payment Thank You-Mobile');
  assert.equal(migrated.dataVersion, 2);
  assert.ok(migrated.categories.includes('My Custom Category'));
  assert.ok(migrated.categories.includes('Gaming'));
  assert.ok(migrated.categories.includes('Utilities'));
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

test('transaction totals separate counts, purchase spending, payments, credits, charges, and net movement', () => {
  const transactions = [];
  for (let i = 0; i < 77; i++) transactions.push({ id:`p${i}`, type:'purchase', amount:60 });
  transactions.push({ id:'p77', type:'purchase', amount:113.10 });
  for (let i = 0; i < 42; i++) transactions.push({ id:`pay${i}`, type:'payment', amount:-117 });
  transactions.push({ id:'pay42', type:'payment', amount:-130 });
  transactions.push({ id:'credit1', type:'credit', amount:-34.89 }, { id:'credit2', type:'refund', amount:-20 });
  transactions.push({ id:'interest1', type:'interest', amount:146.47 }, { id:'interest2', type:'interest', amount:146.47 }, { id:'interest3', type:'interest', amount:146.48 });
  const summary = txModel.transactionSummary(transactions);
  assert.equal(summary.count, 126);
  assert.deepEqual([summary.purchasesCount, summary.paymentsCount, summary.creditsCount, summary.interestFeesCount], [78, 43, 2, 3]);
  assert.deepEqual([summary.purchases, summary.payments, summary.credits, summary.interestFees, summary.net], [4733.1, -5044, -54.89, 439.42, 73.63]);
  const bridge = txModel.statementBalanceBridge({ previous:6659.79, ending:6733.42, transactions, summaryTotals:{purchases:4733.10,paymentsAndCredits:-5098.89,cashAdvances:0,balanceTransfers:0,interest:439.42,fees:0} });
  assert.equal(bridge.calculated, 6733.42);
  assert.equal(txModel.utilization(6733.42, 6600).over, 133.42);
  assert.equal(txModel.utilization(6733.42, 6600).percent.toFixed(2), '102.02');
});

test('net balance change label requires full transaction coverage across adjacent statements', () => {
  const tx1={id:'a',type:'purchase',amount:2}, tx2={id:'b',type:'payment',amount:-1};
  const aug={id:'aug',cardId:'c',periodEnd:'2026-08-20',periodStart:'2026-07-21',transactions:[tx1]};
  const sep={id:'sep',cardId:'c',periodEnd:'2026-09-20',periodStart:'2026-08-21',transactions:[tx2]};
  assert.equal(txModel.completeConsecutiveCoverage([{statement:aug,tx:tx1},{statement:sep,tx:tx2}],[aug,sep]), true);
  assert.equal(txModel.completeConsecutiveCoverage([{statement:aug,tx:tx1}],[aug,sep]), false);
  assert.equal(txModel.completeConsecutiveCoverage([{statement:aug,tx:tx1},{statement:{...sep,periodStart:'2026-08-22'},tx:tx2}],[aug,sep]), false);
});

test('unknown rewards values remain unavailable and are not silently valued at one cent', () => {
  const oldCard={id:'c',nickname:'Card',type:'',last4:'1234',closingDay:null,rewardsProgram:'',rates:{},pointValue:1,createdAt:'today'};
  const migrated=txModel.migrateData({cards:[oldCard],statements:[]});
  assert.equal(migrated.cards[0].pointValueConfigured, false);
  assert.equal(txModel.utilization(100, null), null);
});

test('available rewards use only the latest reported balance per card', () => {
  const statements=[{id:'aug',cardId:'a',periodEnd:'2026-08-20',rewardBalance:900},{id:'sep',cardId:'a',periodEnd:'2026-09-20',rewardBalance:1200},{id:'sep-b',cardId:'b',periodEnd:'2026-09-21',rewardBalance:300}];
  assert.deepEqual(txModel.latestStatementPerCard(statements).map(s=>s.rewardBalance).sort((a,b)=>a-b),[300,1200]);
});

test('statement parsing retains historical limit, minimum due, and payment due date fields', async () => {
  const fixture=await readFile(join(root,'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'),'utf8');
  const parsed=await parser.parseChaseText(`${fixture}\nCredit Limit $6,600`);
  assert.equal(parsed.creditLimit,6600);
  assert.equal(parsed.minimum,214);
  assert.equal(parsed.dueDate,'2026-09-17');
});

test('category options open complete, preserve Uncategorized, and search only when a query is entered', () => {
  const options=categories.uniqueCategoryNames(['Gaming',' Utilities  ','utilities','Restaurants  &  Food'],'');
  assert.deepEqual(options,['Gaming','Utilities','Restaurants & Food','Uncategorized']);
  assert.deepEqual(categories.filterCategoryNames(options,''),options);
  assert.deepEqual(categories.filterCategoryNames(options,' gam '),['Gaming']);
  assert.equal(categories.normalizeCategoryName('  Restaurants   & Food '),'restaurants & food');
});

test('category menu chooses the upward placement when the trigger is near the viewport bottom', () => {
  const above=categories.categoryPopupPosition({left:320,top:728,bottom:754,width:140},{width:900,height:800});
  assert.equal(above.opensUp,true);
  assert.equal(above.maxHeight,280);
  const below=categories.categoryPopupPosition({left:20,top:10,bottom:38,width:180},{width:390,height:844});
  assert.equal(below.opensUp,false);
  assert.equal(below.top,44);
  assert.equal(below.width,220);
});

test('category picker keyboard navigation supports arrows, Home, and End without wrapping', () => {
  assert.equal(categories.categoryNavigationIndex(0,'up',4),0);
  assert.equal(categories.categoryNavigationIndex(0,'down',4),1);
  assert.equal(categories.categoryNavigationIndex(3,'down',4),3);
  assert.equal(categories.categoryNavigationIndex(2,'first',4),0);
  assert.equal(categories.categoryNavigationIndex(0,'last',4),3);
  assert.equal(categories.categoryNavigationIndex(0,'down',0),-1);
});
