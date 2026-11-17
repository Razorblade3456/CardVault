import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: `${root}/vite.config.ts`, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'silent' });
let txModel, model, parser, categories, insights;
try { txModel = await vite.ssrLoadModule('/src/transactions.ts'); model = await vite.ssrLoadModule('/src/model.ts'); parser = await vite.ssrLoadModule('/src/parser.ts'); categories = await vite.ssrLoadModule('/src/categories.ts'); insights = await vite.ssrLoadModule('/src/insights.ts'); }
finally { await vite.close(); }

test('one canonical sign rule normalizes payments, refunds, credits and keeps charges positive', () => {
  assert.equal(txModel.canonicalAmount('purchase', 34.08), 34.08);
  assert.equal(txModel.canonicalAmount('payment', 220), -220);
  assert.equal(txModel.canonicalAmount('refund', 12.5), -12.5);
  assert.equal(txModel.canonicalAmount('credit', 5), -5);
  assert.equal(txModel.canonicalAmount('interest', -148.62), 148.62);
  assert.equal(txModel.displayMerchant({ type: 'payment', description: 'Payment Thank You-Mobile' }), 'Chase Mobile Payment');
});

test('category reassignment keeps recurring labels in sync and merchant rules match the selected card', () => {
  const purchase = { id: 'p', date: '2026-10-01', description: 'STREAMING.COM 0842', amount: 12.99, type: 'purchase', category: 'Subscriptions', categorySource: 'manual', recurring: true, recurringSource: 'category', source: 'manual' };
  const changed = txModel.assignCategory(purchase, 'Entertainment');
  assert.equal(changed.category, 'Entertainment');
  assert.equal(changed.recurring, false);
  const rule = { id: 'r', merchantKey: 'STREAMING', label: 'Streaming', category: 'Entertainment', cardId: 'card-a', matchMode: 'merchant' };
  assert.equal(txModel.matchesMerchantRule(rule, 'card-a', purchase), true);
  assert.equal(txModel.matchesMerchantRule(rule, 'card-b', purchase), false);
  assert.equal(txModel.sameMerchantRuleMatch(rule, { ...rule, id: 'new' }), true);
});

test('uncategorized purchase counting excludes refunds and categorized transactions',()=>{
 assert.equal(txModel.isUncategorizedPurchase({type:'purchase',category:'Uncategorized'}),true);
 assert.equal(txModel.isUncategorizedPurchase({type:'purchase',category:undefined}),true);
 assert.equal(txModel.isUncategorizedPurchase({type:'refund',category:'Uncategorized'}),false);
 assert.equal(txModel.isUncategorizedPurchase({type:'purchase',category:'Groceries'}),false);
});

test('statement reprocessing preserves manual corrections and reports changed or removed extracted rows', () => {
  const original = [
    { id: 'manual-1', date: '2026-10-01', description: 'Edited merchant', amount: 19.99, type: 'purchase', category: 'Gaming', categorySource: 'manual', source: 'manual' },
    { id: 'edited-2', date: '2026-10-02', description: 'Store corrected', originalDescription: 'Store', amount: 14, type: 'purchase', category: 'Shopping', source: 'extracted' },
    { id: 'gone-3', date: '2026-10-03', description: 'Old row', amount: 5, type: 'purchase', category: 'Shopping', source: 'extracted' },
  ];
  const result = txModel.mergeReprocessedTransactions({ transactions: original, corrections: ['edited-2'] }, [
    { id: 'fresh-1', date: '2026-10-02', description: 'Store', amount: 15, type: 'purchase', category: 'Uncategorized', source: 'extracted' },
    { id: 'fresh-2', date: '2026-10-04', description: 'New row', amount: 7, type: 'purchase', category: 'Uncategorized', source: 'extracted' },
  ]);
  assert.equal(result.transactions.find(tx => tx.id === 'manual-1').category, 'Gaming');
  assert.equal(result.transactions.find(tx => tx.id === 'manual-1').source, 'manual');
  assert.equal(result.transactions.find(tx => tx.id === 'edited-2').amount, 14);
  assert.equal(result.transactions.filter(tx => tx.date === '2026-10-02').length, 1);
  assert.equal(result.conflicts.length, 2);
  assert.equal(result.removedRows[0].id, 'gone-3');
});

test('synthetic Insights totals match three imported Chase statements without embedding their results in app code', () => {
  const distribute = (totalCents, count, type) => Array.from({ length: count }, (_, index) => {
    const cents = Math.floor(totalCents / count) + (index < totalCents % count ? 1 : 0);
    return { id: `${type}-${index}`, date: `2026-08-${String(index % 28 + 1).padStart(2, '0')}`, description: `${type} synthetic row ${index}`, type, amount: txModel.canonicalAmount(type, cents / 100), category: type === 'purchase' ? 'Shopping' : 'Uncategorized', source: 'extracted' };
  });
  const transactions = [
    ...distribute(473310, 120, 'purchase'),
    ...distribute(504400, 2, 'payment'),
    ...distribute(5489, 2, 'credit'),
    ...distribute(43942, 2, 'interest'),
  ];
  const statements = Array.from({ length: 3 }, (_, index) => ({ id: `synthetic-${index + 1}`, transactions: [] }));
  transactions.forEach((transaction, index) => statements[index % statements.length].transactions.push(transaction));
  assert.deepEqual(statements.map(statement => statement.transactions.length), [42, 42, 42]);
  const totals = txModel.transactionSummary(statements.flatMap(statement => statement.transactions));
  assert.equal(totals.count, 126);
  assert.equal(totals.purchases, 4733.10);
  assert.equal(totals.payments, -5044.00);
  assert.equal(totals.credits, -54.89);
  assert.equal(totals.interestFees, 439.42);
  assert.equal(totals.net, 73.63);
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
  assert.deepEqual(migrated.changeHistory, []);
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

test('smart rules support exact and range amounts, disabled rules, recurrence, and specific-rule priority', () => {
  const rules = [
    { id:'general', merchantKey:'APPLE BILL', label:'Apple', category:'Shopping', cardId:null, matchMode:'merchant' },
    { id:'exact', merchantKey:'APPLE BILL', label:'Apple', category:'Subscriptions', cardId:'card-a', matchMode:'exact', amount:9.99, recurring:true },
    { id:'range', merchantKey:'APPLE BILL', label:'Apple', category:'Utilities', cardId:'card-a', matchMode:'range', minAmount:10, maxAmount:20 },
    { id:'off', merchantKey:'STEAMGAMES', label:'Steam', category:'Gaming', cardId:null, enabled:false },
  ];
  const statement = { id:'s', cardId:'card-a', transactions:[
    { id:'a', description:'apple.com/bill 1234', amount:9.99, type:'purchase', category:'Uncategorized', source:'extracted' },
    { id:'b', description:'APPLE.COM/BILL 5678', amount:12, type:'purchase', category:'Uncategorized', source:'extracted' },
    { id:'c', description:'APPLE.COM/BILL', amount:40, type:'purchase', category:'Uncategorized', source:'extracted' },
    { id:'d', description:'STEAMGAMES', amount:40, type:'purchase', category:'Uncategorized', source:'extracted' },
  ] };
  const ruled = txModel.applyMerchantRules(statement, rules);
  assert.deepEqual(ruled.transactions.map(t=>t.category), ['Subscriptions','Utilities','Shopping','Uncategorized']);
  assert.equal(ruled.transactions[0].recurring, true);
  assert.equal(ruled.transactions[0].categorySource, 'merchant-rule');
});

test('conflicting equal-priority rules remain unassigned for review', () => {
  const rules = [
    { id:'a', merchantKey:'APPLE BILL', label:'Apple', category:'Subscriptions', cardId:null },
    { id:'b', merchantKey:'APPLE BILL', label:'Apple', category:'Shopping', cardId:null },
  ];
  assert.equal(txModel.findMerchantRule(rules, 'APPLE.COM/BILL', 'card-a'), undefined);
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

test('three-statement synthetic history reconciles the verified balance increase and average interest', () => {
  const makeTx = (id,date,type,amount,category='Uncategorized',description=type) => ({id,date,type,amount,category,description,source:'extracted'});
  const statements = [
    {id:'aug',cardId:'synthetic',periodStart:'2026-07-21',periodEnd:'2026-08-20',previous:6659.79,ending:6590.13,status:'Reconciled',activitySectionFound:true,detailMismatches:[],summaryTotals:{purchases:1091.72,paymentsAndCredits:-1310,cashAdvances:0,balanceTransfers:0,interest:148.62,fees:0},transactions:[makeTx('a-p','2026-08-02','purchase',1091.72,'Gaming','Game Store'),makeTx('a-pay','2026-08-03','payment',-1310),makeTx('a-i','2026-08-20','interest',148.62)]},
    {id:'sep',cardId:'synthetic',periodStart:'2026-08-21',periodEnd:'2026-09-20',previous:6590.13,ending:6576.93,status:'Reconciled',activitySectionFound:true,detailMismatches:[],summaryTotals:{purchases:1800,paymentsAndCredits:-1900,cashAdvances:0,balanceTransfers:0,interest:86.80,fees:0},transactions:[makeTx('s-p','2026-09-02','purchase',1800,'Dining','Cafe'),makeTx('s-pay','2026-09-03','payment',-1900),makeTx('s-i','2026-09-20','interest',86.80)]},
    {id:'oct',cardId:'synthetic',periodStart:'2026-09-21',periodEnd:'2026-10-20',previous:6576.93,ending:6733.42,status:'Reconciled',activitySectionFound:true,detailMismatches:[],summaryTotals:{purchases:1841.38,paymentsAndCredits:-1888.89,cashAdvances:0,balanceTransfers:0,interest:204,fees:0},transactions:[makeTx('o-p','2026-10-02','purchase',1841.38,'Gaming','Game Store'),makeTx('o-pay','2026-10-03','payment',-1888.89),makeTx('o-i','2026-10-20','interest',204)]},
  ];
  const history=insights.verifiedStatements(statements);
  assert.equal(history.length,3);
  assert.deepEqual(history.map(s=>s.ending),[6733.42,6576.93,6590.13]);
  assert.equal(model.sum(statements.map(s=>s.summaryTotals.purchases)),4733.10);
  assert.equal(model.sum(statements.map(s=>s.summaryTotals.paymentsAndCredits)),-5098.89);
  assert.equal(model.sum(statements.map(s=>s.summaryTotals.interest)),439.42);
  assert.equal(Math.round(model.sum(statements.map(s=>s.summaryTotals.interest))/3*100)/100,146.47);
  assert.equal(Math.round((statements[2].ending-statements[0].previous)*100)/100,73.63);
  const explanation=insights.monthlyStatementObservations(statements[2],statements[1]);
  assert.ok(explanation.includes('The statement balance increased by $156.49 to $6733.42.'));
});

test('monthly reviews reject a stale reconciled label when transaction coverage is unverified', () => {
  const statement={id:'s',cardId:'c',periodStart:'2026-08-01',periodEnd:'2026-08-31',previous:100,ending:100,status:'Reconciled',activitySectionFound:false,detailMismatches:[],summaryTotals:{purchases:0,paymentsAndCredits:0,cashAdvances:0,balanceTransfers:0,interest:0,fees:0},transactions:[{id:'tx',date:'2026-08-03',type:'purchase',amount:0,category:'Gaming'}]};
  assert.equal(insights.verifiedStatements([statement]).length,0);
});

test('spending reports net refunds, exclude payments, and flag only repeated purchase timing', () => {
  const statements=[{cardId:'c',periodEnd:'2026-10-20',transactions:[
    {id:'1',date:'2026-08-02',type:'purchase',amount:40,category:'Gaming',description:'STREAMBOX.COM 001'},
    {id:'2',date:'2026-09-02',type:'purchase',amount:40,category:'Gaming',description:'STREAMBOX.COM 002'},
    {id:'3',date:'2026-10-02',type:'purchase',amount:40,category:'Gaming',description:'STREAMBOX.COM 003'},
    {id:'4',date:'2026-10-03',type:'refund',amount:-10,category:'Gaming',description:'Store refund'},
    {id:'5',date:'2026-10-04',type:'payment',amount:-200,category:'Uncategorized',description:'Payment'},
  ]}];
  assert.equal(insights.spendingByPeriod(statements,'transaction').find(x=>x.period==='2026-10').net,30);
  const candidates=insights.recurringCandidates(statements);
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].merchantKey,'STREAMBOX');
  assert.equal(candidates[0].count,3);
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

test('utilization uses the actual limit, reports over-limit dollars, and stays unavailable without a limit', () => {
  const value=txModel.utilization(6733.42,6600);
  assert.ok(Math.abs(value.percent-102.0215151515)<0.00001);
  assert.equal(value.over,133.42);
  assert.equal(txModel.utilization(6733.42,null),null);
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

test('credit limit extraction does not mistake zero available credit for the limit', async () => {
  const fixture=await readFile(join(root,'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'),'utf8');
  const parsed=await parser.parseChaseText(`${fixture}\nCredit Limit $6,600 Available Credit $0.00`);
  assert.equal(parsed.creditLimit,6600);
  const unavailable=await parser.parseChaseText(`${fixture}\nCredit Limit $0.00 Available Credit $0.00`);
  assert.equal(unavailable.creditLimit,null);
});

test('credit limit extraction does not use an amount before the label as the limit', async () => {
  const fixture=await readFile(join(root,'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'),'utf8');
  const parsed=await parser.parseChaseText(`${fixture}\nOver Limit $133.42 Credit Limit\n$6,600`);
  assert.equal(parsed.creditLimit,6600);
  const ambiguous=await parser.parseChaseText(`${fixture}\nOver Limit $133.42 Credit Limit\nAvailable Credit $0.00`);
  assert.equal(ambiguous.creditLimit,null);
});

test('rewards extraction accepts the concise Points Earned label used by some Chase layouts', async () => {
  const fixture=await readFile(join(root,'tests/fixtures/chase-freedom-aug-2026-synthetic.txt'),'utf8');
  const parsed=await parser.parseChaseText(fixture.replace('Points Earned in This Statement 1,092','Points Earned 1,092'));
  assert.equal(parsed.pointsEarned,1092);
  assert.equal(parsed.rewardBalance,1414);
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
