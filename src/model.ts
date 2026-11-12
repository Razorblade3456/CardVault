export type Card = { id:string; nickname:string; type:string; last4:string; closingDay:number|null; rewardsProgram:string; rates:Record<string,number>; pointValue:number; createdAt:string };
export type TxType='purchase'|'payment'|'refund'|'credit'|'interest'|'fee';
export type Tx={ id:string; date:string; description:string; amount:number; type:TxType; category:string; source:'extracted'|'manual' };
export type Statement={ id:string; cardId:string; periodStart:string; periodEnd:string; dueDate:string; previous:number|null; ending:number|null; minimum:number|null; opening?:string; transactions:Tx[]; pointsEarned:number|null; pointsRedeemed:number|null; rewardBalance:number|null; status:'Reconciled'|'Needs Review'|'Discrepancy Found'|'Not Yet Reconciled'; difference:number|null; pdf:Blob; fileName:string; hash:string; createdAt:string; corrections:string[] };
export type AppData={cards:Card[];statements:Statement[];theme:'dark'|'light';tutorialDone:boolean;lastBackup:string|null;graceDays:number};
export const emptyData:AppData={cards:[],statements:[],theme:'dark',tutorialDone:false,lastBackup:null,graceDays:7};
export const uid=()=>crypto.randomUUID();
export const money=(n:number|null|undefined)=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
export const sum=(xs:number[])=>Math.round(xs.reduce((a,b)=>a+Math.round(b*100),0))/100;
export function reconcile(s:Pick<Statement,'previous'|'ending'|'transactions'>){
 if(s.previous==null||s.ending==null)return {status:'Needs Review' as const,difference:null};
 const t=s.transactions;
 if(!t.length)return {status:'Needs Review' as const,difference:null};
 const purchases=sum(t.filter(x=>x.type==='purchase').map(x=>x.amount));
 const interest=sum(t.filter(x=>x.type==='interest').map(x=>x.amount));
 const fees=sum(t.filter(x=>x.type==='fee').map(x=>x.amount));
 const payments=sum(t.filter(x=>x.type==='payment').map(x=>x.amount));
 const refunds=sum(t.filter(x=>x.type==='refund'||x.type==='credit').map(x=>x.amount));
 const calculated=Math.round((s.previous+purchases+interest+fees-payments-refunds)*100)/100;
 const difference=Math.round((calculated-s.ending)*100)/100;
 return {status:Math.abs(difference)<=0.01?'Reconciled' as const:'Discrepancy Found' as const,difference};
}
