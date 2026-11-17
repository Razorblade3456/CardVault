import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const vite=await createServer({configFile:`${root}/vite.config.ts`,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom',logLevel:'silent'});
let history,txModel;
try{history=await vite.ssrLoadModule('/src/change-history.ts');txModel=await vite.ssrLoadModule('/src/transactions.ts')}finally{await vite.close()}

function sample(){
 const transactions=[
  {id:'one',date:'2026-10-01',description:'Coffee Shop 123',amount:12,type:'purchase',category:'Uncategorized',categorySource:'default',source:'extracted'},
  {id:'two',date:'2026-10-02',description:'Game Store',amount:48,type:'purchase',category:'Gaming',categorySource:'manual',source:'extracted'},
 ];
 const statement={id:'statement',cardId:'freedom',periodEnd:'2026-10-15',transactions,status:'Reconciled',difference:0,summaryDifference:0};
 return {cards:[],statements:[statement],categories:['Gaming','Uncategorized'],merchantRules:[],changeHistory:[],dataVersion:2,theme:'dark',tutorialDone:true,lastBackup:null,graceDays:7};
}

test('bulk category history reverses selected rows and a newly saved Smart Rule without changing financial amounts',()=>{
 const initial=sample();const id='bulk-1';const oldRows=initial.statements[0].transactions;const rules=[{id:'rule-1',merchantKey:'COFFEE SHOP',label:'Coffee Shop',category:'Gaming',cardId:'freedom',matchMode:'merchant'}];
 const affected=oldRows.map(tx=>({statementId:'statement',txId:tx.id,merchant:tx.description,previous:history.categorySnapshot(tx),next:history.categorySnapshot(txModel.assignCategory(tx,'Gaming','manual',undefined,id))}));
 const entry={id,createdAt:'2026-10-16T12:00:00.000Z',action:'bulk-category',summary:'Categorized 2 purchases as Gaming.',affected,rules:rules.map(match=>({match,previous:[],next:[match]}))};
 const changed={...initial,merchantRules:rules,statements:[{...initial.statements[0],transactions:oldRows.map(tx=>txModel.assignCategory(tx,'Gaming','manual',undefined,id))}]};
 const saved=history.addChangeHistory(changed,entry);const result=history.undoChangeHistory(saved,id);
 assert.equal(result.applied,3);
 assert.equal(result.conflicts,0);
 assert.deepEqual(result.data.statements[0].transactions.map(tx=>tx.category),['Uncategorized','Gaming']);
 assert.deepEqual(result.data.statements[0].transactions.map(tx=>tx.amount),[12,48]);
 assert.equal(result.data.merchantRules.length,0);
 assert.ok(result.data.changeHistory[0].undoneAt);
});

test('undo reports and preserves a newer category edit instead of overwriting it',()=>{
 const initial=sample();const id='bulk-2';const tx=initial.statements[0].transactions[0];const updated=txModel.assignCategory(tx,'Gaming','manual',undefined,id);
 const entry={id,createdAt:new Date().toISOString(),action:'bulk-category',summary:'Categorized one purchase as Gaming.',affected:[{statementId:'statement',txId:tx.id,merchant:tx.description,previous:history.categorySnapshot(tx),next:history.categorySnapshot(updated)}],rules:[]};
 const newer=txModel.assignCategory(updated,'Groceries','manual',undefined,'newer-edit');const current=history.addChangeHistory({...initial,statements:[{...initial.statements[0],transactions:[newer,...initial.statements[0].transactions.slice(1)]}]},entry);
 const result=history.undoChangeHistory(current,id);
 assert.equal(result.applied,0);
 assert.equal(result.conflicts,1);
 assert.equal(result.data.statements[0].transactions[0].category,'Groceries');
 assert.equal(result.data.changeHistory[0].undoneAt,undefined);
});

test('undo can restore unchanged rows while reporting newer edits in the same bulk operation',()=>{
 const initial=sample();const id='bulk-3';const rows=initial.statements[0].transactions;const assigned=rows.map(tx=>txModel.assignCategory(tx,'Gaming','manual',undefined,id));
 const entry={id,createdAt:new Date().toISOString(),action:'bulk-category',summary:'Categorized 2 purchases as Gaming.',affected:rows.map(tx=>({statementId:'statement',txId:tx.id,merchant:tx.description,previous:history.categorySnapshot(tx),next:history.categorySnapshot(txModel.assignCategory(tx,'Gaming','manual',undefined,id))})),rules:[]};
 assigned[1]=txModel.assignCategory(assigned[1],'Utilities','manual',undefined,'newer');const current=history.addChangeHistory({...initial,statements:[{...initial.statements[0],transactions:assigned}]},entry);
 const result=history.undoChangeHistory(current,id);
 assert.equal(result.applied,1);assert.equal(result.conflicts,1);
 assert.deepEqual(result.data.statements[0].transactions.map(tx=>tx.category),['Uncategorized','Utilities']);
 assert.ok(result.data.changeHistory[0].undoneAt);
});

test('undo detects a Smart Rule that was edited after the history entry',()=>{
 const initial=sample();const id='rule-action';const original={id:'rule-old',merchantKey:'COFFEE SHOP',label:'Coffee Shop',category:'Dining',cardId:'freedom',matchMode:'merchant'};const changed={...original,category:'Gaming'};
 const entry={id,createdAt:new Date().toISOString(),action:'smart-rule',summary:'Changed Coffee Shop rule to Gaming.',affected:[],rules:[{match:changed,previous:[original],next:[changed]}]};
 const newer={...changed,category:'Travel',enabled:false};const current=history.addChangeHistory({...initial,merchantRules:[newer]},entry);const result=history.undoChangeHistory(current,id);
 assert.equal(result.applied,0);assert.equal(result.conflicts,1);assert.deepEqual(result.data.merchantRules,[newer]);
});
