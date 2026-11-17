import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

class EventHub {
  listeners = new Map();
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  dispatch(type, props = {}) { const event = { type, target: this, ...props }; for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); this[`on${type}`]?.(event); }
}

class FakeRequest extends EventHub { result = undefined; error = null; }
class FakeNames extends Array { contains(name) { return this.includes(name); } }
class FakeDatabase extends EventHub {
  stores = new Map();
  objectStoreNames = new FakeNames();
  createObjectStore(name) { this.stores.set(name, new Map()); this.objectStoreNames.push(name); return {}; }
  transaction(names, mode = 'readonly') { return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode); }
  close() {}
}
class FakeObjectStore {
  constructor(name, transaction) { this.name = name; this.transaction = transaction; }
  get(key) { return this.transaction.request(() => this.transaction.stores.get(this.name).get(key)); }
  put(value, key) { return this.transaction.request(() => { this.transaction.stores.get(this.name).set(key, structuredClone(value)); return key; }); }
  delete(key) { return this.transaction.request(() => this.transaction.stores.get(this.name).delete(key)); }
}
class FakeTransaction extends EventHub {
  error = null;
  pending = 0;
  active = true;
  objectStoreNames = new FakeNames();
  constructor(database, names, mode) {
    super(); this.database = database; this.names = names; this.mode = mode;
    this.objectStoreNames.push(...names);
    this.stores = new Map(names.map(name => [name, new Map(database.stores.get(name) ?? [])]));
  }
  objectStore(name) { return new FakeObjectStore(name, this); }
  request(operation) {
    const request = new FakeRequest(); this.pending++;
    queueMicrotask(() => {
      try { request.result = operation(); request.dispatch('success'); }
      catch (error) { request.error = error; request.dispatch('error'); }
      this.pending--;
      setTimeout(() => this.completeIfIdle(), 0);
    });
    return request;
  }
  completeIfIdle() {
    if (!this.active || this.pending) return;
    if (this.mode === 'readwrite') for (const name of this.names) this.database.stores.set(name, this.stores.get(name));
    this.active = false; this.dispatch('complete');
  }
  abort() { if (!this.active) return; this.active = false; this.dispatch('abort'); }
}
class FakeFactory {
  databases = new Map();
  open(name, version) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      let database = this.databases.get(name); const oldVersion = database?.version ?? 0;
      if (!database) { database = new FakeDatabase(); database.name = name; database.version = version; this.databases.set(name, database); }
      request.result = database;
      if (oldVersion < version) { database.version = version; request.transaction = new FakeTransaction(database, [], 'versionchange'); request.dispatch('upgradeneeded', { oldVersion, newVersion: version }); }
      setTimeout(() => request.dispatch('success'), 0);
    });
    return request;
  }
}

test('IndexedDB saves and reloads the app snapshot and original statement PDFs', async () => {
  globalThis.IDBRequest = FakeRequest; globalThis.IDBIndex = class {}; globalThis.IDBObjectStore = FakeObjectStore;
  globalThis.IDBCursor = class {}; globalThis.IDBDatabase = FakeDatabase; globalThis.IDBTransaction = FakeTransaction;
  globalThis.indexedDB = new FakeFactory();
  const root = fileURLToPath(new URL('..', import.meta.url));
  const vite = await createServer({ configFile: `${root}/vite.config.ts`, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'silent' });
  try {
    const db = await vite.ssrLoadModule('/src/db.ts');
    const base = await db.loadData();
    const pdf = new Blob(['%PDF statement persisted through IndexedDB'], { type: 'application/pdf' });
    const statement = { id: 's1', cardId: 'c1', periodStart: '2026-01-01', periodEnd: '2026-01-31', dueDate: '', previous: 100, ending: 120, minimum: null, transactions: [{ id: 't1', date: '2026-01-05', description: 'Market', amount: 20, type: 'purchase', category: 'Custom', source: 'extracted' }], pointsEarned: 10, pointsRedeemed: null, rewardBalance: 50, status: 'Needs Review', difference: null, pdf, fileName: 'statement.pdf', hash: 'hash-1', createdAt: '2026-01-31', corrections: [] };
    const snapshot = { ...base, cards: [{ id: 'c1', nickname: 'Freedom Flex', type: '', last4: '1234', closingDay: 20, rewardsProgram: '', rates: {}, pointValue: null, createdAt: '2026-01-01' }], statements: [statement], categories: [...base.categories, 'Custom'], merchantRules: [{ id: 'r1', merchantKey: 'MARKET', label: 'Market', category: 'Custom', cardId: 'c1' }], changeHistory:[{id:'change-1',createdAt:'2026-01-31T12:00:00.000Z',action:'bulk-category',summary:'Categorized 1 purchase as Custom.',affected:[],rules:[]}],merchantGroups:[{id:'group-1',name:'Market',merchantKeys:['MARKET','MARKET STORE'],updatedAt:'2026-01-31'}],priceAlertDecisions:{'c1:MARKET':'confirmed'},recurringAmountOverrides:{'c1:MARKET':12.99} };
    await db.saveData(snapshot);
    let loaded = await db.loadData();
    assert.equal(loaded.statements[0].pdf.size, pdf.size);
    assert.equal(await loaded.statements[0].pdf.text(), await pdf.text());
    assert.equal(loaded.statements[0].transactions[0].category, 'Custom');
    assert.equal(loaded.statements[0].pointsEarned, 10);
    assert.equal(loaded.merchantRules[0].category, 'Custom');
    assert.deepEqual(loaded.merchantGroups, snapshot.merchantGroups);
    assert.deepEqual(loaded.priceAlertDecisions, snapshot.priceAlertDecisions);
    assert.deepEqual(loaded.recurringAmountOverrides, snapshot.recurringAmountOverrides);
    assert.equal(loaded.changeHistory[0].id,'change-1');

    const updated = { ...loaded, statements: [{ ...loaded.statements[0], rewardBalance: 60, transactions: [{ ...loaded.statements[0].transactions[0], category: 'Travel' }] }] };
    await db.saveData(updated);
    loaded = await db.loadData();
    assert.equal(loaded.statements[0].pdf.size, pdf.size);
    assert.equal(loaded.statements[0].rewardBalance, 60);
    assert.equal(loaded.statements[0].transactions[0].category, 'Travel');
    assert.equal(loaded.changeHistory[0].id,'change-1');
  } finally { await vite.close(); }
});
