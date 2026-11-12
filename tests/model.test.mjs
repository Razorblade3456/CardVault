import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/model.ts', import.meta.url), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 });
const model = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const tx = (type, amount) => ({ id: `${type}-${amount}`, date: '2026-10-10', description: type, amount, type, category: 'Test', source: 'manual' });

test('currency sums avoid binary floating point drift', () => {
  assert.equal(model.sum([0.1, 0.2]), 0.3);
});

test('reconciliation includes purchases, payments, refunds, credits, interest, and fees', () => {
  const result = model.reconcile({
    previous: 100,
    ending: 125.1,
    transactions: [tx('purchase', 50.1), tx('interest', 1), tx('fee', 2), tx('payment', 20), tx('refund', 5), tx('credit', 3)],
  });
  assert.deepEqual(result, { status: 'Reconciled', difference: 0 });
});

test('a statement mismatch is not marked reconciled', () => {
  const result = model.reconcile({ previous: 100, ending: 121, transactions: [tx('purchase', 20)] });
  assert.deepEqual(result, { status: 'Discrepancy Found', difference: -1 });
});

test('missing totals or transactions stay in review', () => {
  assert.equal(model.reconcile({ previous: null, ending: 10, transactions: [tx('purchase', 10)] }).status, 'Needs Review');
  assert.equal(model.reconcile({ previous: 0, ending: 0, transactions: [] }).status, 'Needs Review');
});
