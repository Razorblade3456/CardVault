import type { AppData, CategoryHistoryChange, CategorySnapshot, ChangeHistoryEntry, MerchantRule } from './model';
import { sameMerchantRuleMatch } from './transactions';

export function categorySnapshot(tx:CategorySnapshot):CategorySnapshot{
 return {category:tx.category,categorySource:tx.categorySource,categoryRuleId:tx.categoryRuleId,categoryBeforeRule:tx.categoryBeforeRule,recurring:tx.recurring,recurringSource:tx.recurringSource};
}

export function addChangeHistory(data:AppData,entry:ChangeHistoryEntry):AppData{
 return {...data,changeHistory:[...(data.changeHistory??[]),entry].slice(-100)};
}

function stableRules(rules:MerchantRule[]){return [...rules].sort((a,b)=>a.id.localeCompare(b.id)).map(rule=>JSON.stringify(rule)).join('|')}

export function undoChangeHistory(data:AppData,entryId:string){
 const entry=data.changeHistory?.find(item=>item.id===entryId);
 if(!entry||entry.undoneAt)return {data,applied:0,conflicts:0,missing:!entry,alreadyUndone:!!entry};
 let applied=0,conflicts=0;
 const changesByStatement=new Map<string,CategoryHistoryChange[]>();
 for(const change of entry.affected){changesByStatement.set(change.statementId,[...(changesByStatement.get(change.statementId)??[]),change])}
 const statements=data.statements.map(statement=>{
  const changes=changesByStatement.get(statement.id);if(!changes)return statement;let changed=false;for(const item of changes)if(!statement.transactions.some(tx=>tx.id===item.txId))conflicts++;
  const transactions=statement.transactions.map(tx=>{
   const change=changes.find(item=>item.txId===tx.id);if(!change)return tx;
   if(tx.categoryChangeId!==entry.id||JSON.stringify(categorySnapshot(tx))!==JSON.stringify(change.next)){conflicts++;return tx;}
   changed=true;applied++;return {...tx,...change.previous,categoryChangeId:crypto.randomUUID()};
  });
  return changed?{...statement,transactions,categoriesReviewedAt:null}:statement;
 });
 for(const [statementId,changes] of changesByStatement)if(!data.statements.some(statement=>statement.id===statementId))conflicts+=changes.length;
 let merchantRules=data.merchantRules;
 for(const change of entry.rules){
  const current=merchantRules.filter(rule=>sameMerchantRuleMatch(rule,change.match));
  if(stableRules(current)!==stableRules(change.next)){conflicts++;continue;}
  merchantRules=[...merchantRules.filter(rule=>!sameMerchantRuleMatch(rule,change.match)),...change.previous];applied++;
 }
 if(!applied)return {data,applied,conflicts,missing:false,alreadyUndone:false};
 const updated={...data,statements,merchantRules,changeHistory:(data.changeHistory??[]).map(item=>item.id===entryId?{...item,undoneAt:new Date().toISOString(),undoSummary:conflicts?`Undid ${applied}; left ${conflicts} newer change${conflicts===1?'':'s'} untouched.`:`Undid all ${applied} change${applied===1?'':'s'}.`}:item)};
 return {data:updated,applied,conflicts,missing:false,alreadyUndone:false};
}
