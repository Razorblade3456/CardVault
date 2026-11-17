import type {AppData} from './model';
import {normalizeMerchant} from './transactions';
import {merchantDisplayName} from './merchant-insights';

export type SearchKind='Transactions'|'Merchants'|'Categories'|'Statements'|'Cards'|'Smart Rules'|'Recurring Expenses'|'Financial Reviews';
export type SearchResult={kind:SearchKind;id:string;title:string;detail:string;cardId?:string;statementId?:string;txId?:string;category?:string};
const money=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Math.abs(n));

export function quickSearch(data:AppData,query:string,cardId='all',limit=6):SearchResult[]{
 const q=query.trim().toLocaleLowerCase();if(!q)return[];
 const terms=q.replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
 const matches=(...values:(string|number|null|undefined)[])=>{const text=values.filter(v=>v!=null).join(' ').toLocaleLowerCase();if(q.startsWith('$')){const amount=Number(q.replace(/[$,\s]/g,''));return Number.isFinite(amount)&&values.some(v=>typeof v==='number'&&Math.round(Math.abs(v)*100)===Math.round(amount*100))}return terms.every(term=>text.includes(term))};
 const groups:Record<SearchKind,SearchResult[]>={Transactions:[],Merchants:[],Categories:[],Statements:[],Cards:[],'Smart Rules':[],'Recurring Expenses':[],'Financial Reviews':[]};
 const allowed=(id:string)=>cardId==='all'||cardId===id;const seenMerchant=new Set<string>(),seenRecurring=new Set<string>(),seenReports=new Set<string>();
 for(const statement of data.statements){if(!allowed(statement.cardId))continue;const monthName=statement.periodEnd?new Date(`${statement.periodEnd}T12:00:00`).toLocaleString('en-US',{month:'long'}):'';
  if(matches(statement.fileName,statement.periodStart,statement.periodEnd,monthName))groups.Statements.push({kind:'Statements',id:statement.id,title:statement.fileName||`Statement ${statement.periodEnd}`,detail:`${statement.periodStart} – ${statement.periodEnd}`,cardId:statement.cardId,statementId:statement.id});
  for(const tx of statement.transactions){const description=tx.originalDescription??tx.description;const dateMonth=tx.date?new Date(`${tx.date}T12:00:00`).toLocaleString('en-US',{month:'long'}):'';
   if(matches(description,tx.category,tx.date,dateMonth,tx.amount))groups.Transactions.push({kind:'Transactions',id:`${statement.id}:${tx.id}`,title:tx.description,detail:`${tx.date} · ${tx.category} · ${money(tx.amount)}`,cardId:statement.cardId,statementId:statement.id,txId:tx.id,category:tx.category});
   const key=normalizeMerchant(tx.description);const group=data.merchantGroups?.find(item=>item.merchantKeys.includes(key));const merchantIdentity=group?.id??key;
   if(key&&!seenMerchant.has(merchantIdentity)&&matches(key,tx.description,group?.name)){seenMerchant.add(merchantIdentity);groups.Merchants.push({kind:'Merchants',id:key,title:merchantDisplayName(key,data.merchantGroups),detail:'Merchant spending history',cardId:statement.cardId});}
   if(tx.recurring===true&&matches(tx.description,tx.category)){const recurringKey=`${statement.cardId}:${key}`;if(!seenRecurring.has(recurringKey)){seenRecurring.add(recurringKey);groups['Recurring Expenses'].push({kind:'Recurring Expenses',id:recurringKey,title:tx.description,detail:`${tx.category} · confirmed recurring`,cardId:statement.cardId});}}
  }
  const reportKey=statement.id;if(statement.status==='Reconciled'&&!seenReports.has(reportKey)&&matches(statement.periodEnd,monthName)){seenReports.add(reportKey);groups['Financial Reviews'].push({kind:'Financial Reviews',id:statement.id,title:`${monthName} review`,detail:`Statement ending ${statement.periodEnd}`,cardId:statement.cardId,statementId:statement.id});}
 }
 for(const card of data.cards)if(allowed(card.id)&&matches(card.nickname,card.type,card.last4))groups.Cards.push({kind:'Cards',id:card.id,title:card.nickname,detail:`Chase ${card.type} · ••${card.last4}`,cardId:card.id});
 for(const category of data.categories)if(matches(category))groups.Categories.push({kind:'Categories',id:category,title:category,detail:'Transaction category',category});
 for(const rule of data.merchantRules)if((rule.cardId==null||allowed(rule.cardId))&&matches(rule.label,rule.merchantKey,rule.category))groups['Smart Rules'].push({kind:'Smart Rules',id:rule.id,title:rule.label,detail:`${rule.category} · ${rule.enabled===false?'disabled':'active'}`,cardId:rule.cardId??undefined});
 return(Object.keys(groups) as SearchKind[]).flatMap(kind=>groups[kind].slice(0,limit));
}
