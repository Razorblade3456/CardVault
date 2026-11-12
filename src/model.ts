export type Card = { id:string; nickname:string; type:string; last4:string; closingDay:number|null; rewardsProgram:string; rates:Record<string,number>; pointValue:number; createdAt:string };
export type TxType='purchase'|'payment'|'refund'|'credit'|'interest'|'fee'|'cashAdvance'|'balanceTransfer';
export type Tx={ id:string; date:string; description:string; originalDescription?:string; amount:number; originalAmount?:number; type:TxType; category:string; categorySource?:'default'|'merchant-rule'|'manual'; source:'extracted'|'manual'; page?:number; sourceSection?:string };
export type MerchantRule={id:string;merchantKey:string;label:string;category:string;cardId:string|null};
export type StatementTotals={purchases:number|null;paymentsAndCredits:number|null;cashAdvances:number|null;balanceTransfers:number|null;interest:number|null;fees:number|null};
export type DetailMismatch={category:string;expected:number;actual:number;difference:number};
export type Statement={ id:string; cardId:string; periodStart:string; periodEnd:string; dueDate:string; previous:number|null; ending:number|null; minimum:number|null; opening?:string; transactions:Tx[]; pointsPrevious?:number|null; pointsEarned:number|null; pointsRedeemed:number|null; rewardBalance:number|null; pointsBreakdown?:{label:string;points:number}[]; summaryTotals?:StatementTotals; summaryDifference?:number|null; detailMismatches?:DetailMismatch[]; activitySectionFound?:boolean; summarySectionFound?:boolean; pagesProcessed?:number; continuedActivityFound?:boolean; continuityDifference?:number|null; continuityWarning?:string|null; status:'Reconciled'|'Needs Review'|'Discrepancy Found'|'Not Yet Reconciled'; difference:number|null; pdf:Blob; fileName:string; hash:string; createdAt:string; corrections:string[] };
export const DEFAULT_CATEGORIES=['Groceries','Restaurants & Food','Gas & Transportation','Shopping','Gaming','Entertainment','Subscriptions','Utilities','Insurance','Healthcare','Travel','Education','Personal Care','Miscellaneous','Uncategorized'];
export type AppData={cards:Card[];statements:Statement[];categories:string[];merchantRules:MerchantRule[];dataVersion:number;theme:'dark'|'light';tutorialDone:boolean;lastBackup:string|null;graceDays:number};
export const emptyData:AppData={cards:[],statements:[],categories:DEFAULT_CATEGORIES,merchantRules:[],dataVersion:2,theme:'dark',tutorialDone:false,lastBackup:null,graceDays:7};
export const uid=()=>crypto.randomUUID();
export const money=(n:number|null|undefined)=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
export const sum=(xs:number[])=>Math.round(xs.reduce((a,b)=>a+Math.round(b*100),0))/100;
export function checkContinuity(candidate:{cardId:string;periodStart:string;previous:number|null},statements:Statement[]){
 if(!candidate.periodStart)return{preceding:null as Statement|null,difference:null as number|null,warning:null as string|null};
 const preceding=statements.filter(s=>s.cardId===candidate.cardId&&s.periodEnd&&s.periodEnd<candidate.periodStart).sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd))[0]??null;
 if(!preceding)return{preceding:null as Statement|null,difference:null as number|null,warning:null as string|null};
 const nextDay=new Date(`${preceding.periodEnd}T00:00:00Z`);nextDay.setUTCDate(nextDay.getUTCDate()+1);
 if(nextDay.toISOString().slice(0,10)!==candidate.periodStart)return{preceding:null as Statement|null,difference:null as number|null,warning:null as string|null};
 if(preceding.ending==null||candidate.previous==null)return{preceding,difference:null as number|null,warning:`Consecutive statement balances cannot be compared because ${preceding.ending==null?'the earlier ending balance':'the newer previous balance'} is missing.`};
 const difference=Math.round((candidate.previous-preceding.ending)*100)/100;
 return{preceding,difference,warning:Math.abs(difference)>.01?`Continuity warning: previous balance ${money(candidate.previous)} does not match the preceding statement ending balance ${money(preceding.ending)} (${money(difference)} difference).`:null};
}
export function refreshStatementContinuity(statements:Statement[]){return statements.map(statement=>{const result=checkContinuity(statement,statements);return{...statement,continuityDifference:result.difference,continuityWarning:result.warning}})}
export function reconcile(s:Pick<Statement,'previous'|'ending'|'transactions'> & Partial<Pick<Statement,'summaryTotals'|'activitySectionFound'>>){
 const totals=s.summaryTotals;
 if(!totals||s.previous==null||s.ending==null){return {status:'Needs Review' as const,difference:null,summaryDifference:null,detailMismatches:[],summaryPassed:false,detailsPassed:false,reviewReasons:[!totals?'Official Account Summary totals are missing.':null,s.previous==null?'Previous balance is missing.':null,s.ending==null?'New balance is missing.':null].filter((x):x is string=>!!x)};}
 const required:[keyof StatementTotals,string][]=[['purchases','Purchases'],['paymentsAndCredits','Payments and credits'],['cashAdvances','Cash advances'],['balanceTransfers','Balance transfers'],['interest','Interest'],['fees','Fees']];
 const missing=required.filter(([key])=>totals[key]==null).map(([,label])=>`${label} summary total is missing.`);
 const summaryComplete=missing.length===0;
 const calculated=summaryComplete?Math.round((s.previous!+Math.abs(totals.purchases!)+Math.abs(totals.cashAdvances!)+Math.abs(totals.balanceTransfers!)+Math.abs(totals.interest!)+Math.abs(totals.fees!)-Math.abs(totals.paymentsAndCredits!))*100)/100:null;
 const summaryDifference=calculated==null?null:Math.round((calculated-s.ending!)*100)/100;
 const t=s.transactions;
 const actual:Record<keyof StatementTotals,number>={purchases:sum(t.filter(x=>x.type==='purchase').map(x=>x.amount)),paymentsAndCredits:sum(t.filter(x=>['payment','refund','credit'].includes(x.type)).map(x=>x.amount)),cashAdvances:sum(t.filter(x=>x.type==='cashAdvance').map(x=>x.amount)),balanceTransfers:sum(t.filter(x=>x.type==='balanceTransfer').map(x=>x.amount)),interest:sum(t.filter(x=>x.type==='interest').map(x=>x.amount)),fees:sum(t.filter(x=>x.type==='fee').map(x=>x.amount))};
 const detailMismatches:DetailMismatch[]=required.flatMap(([key,label])=>{const expected=key==='paymentsAndCredits'?-Math.abs(totals[key]??0):Math.abs(totals[key]??0);if(totals[key]==null)return[];const diff=Math.round((actual[key]-expected)*100)/100;return Math.abs(diff)<=0.01?[]:[{category:label,expected,actual:actual[key],difference:diff}];});
 const detailsComplete=summaryComplete&&s.activitySectionFound===true&&t.length>0&&detailMismatches.length===0;
 const summaryPassed=summaryDifference!=null&&Math.abs(summaryDifference)<=0.01;
 const status=summaryDifference!=null&&Math.abs(summaryDifference)>.01?'Discrepancy Found' as const:summaryPassed&&detailsComplete?'Reconciled' as const:'Needs Review' as const;
 const reviewReasons=[...missing,...(s.activitySectionFound===false?['Account Activity section was not found.']:s.activitySectionFound!==true?['Transaction section coverage is unverified.']:[]),...(t.length===0?['No transaction rows were extracted.']:[]),...detailMismatches.map(m=>`${m.category}: statement summary ${money(m.expected)}, extracted transactions ${money(m.actual)}.`),...(summaryDifference!=null&&Math.abs(summaryDifference)>.01?[`Summary arithmetic differs from the printed new balance by ${money(summaryDifference)}.`]:[])];
 return {status,difference:summaryDifference,summaryDifference,detailMismatches,summaryPassed,detailsPassed:detailsComplete,reviewReasons};
}
