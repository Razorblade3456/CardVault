export type PaymentPlannerInput={
 balance:number;
 minimumDue:number|null;
 monthlyPayment:number;
 purchases:number;
 fees:number;
 credits:number;
 interestMode:'monthly'|'apr';
 monthlyInterest:number;
 apr:number;
 debtReductionGoal:number;
};
const cents=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;

export function estimateMonthlyInterest(input:Pick<PaymentPlannerInput,'balance'|'purchases'|'interestMode'|'monthlyInterest'|'apr'>){
 if(input.interestMode==='monthly')return cents(Math.max(0,input.monthlyInterest));
 // A blended APR is applied to the statement balance plus half the expected
 // purchases, assuming spending happens evenly through the month.
 return cents(Math.max(0,(Math.max(0,input.balance)+Math.max(0,input.purchases)/2)*Math.max(0,input.apr)/1200));
}

export function calculatePaymentPlan(input:PaymentPlannerInput){
 const interest=estimateMonthlyInterest(input);
 const monthlyDebtGrowth=cents(Math.max(0,input.purchases)+Math.max(0,input.fees)+interest-Math.max(0,input.credits));
 const minimum=Math.max(0,input.minimumDue??0);
 const stayAhead=Math.max(minimum,monthlyDebtGrowth);
 const reduceDebt=Math.max(minimum,monthlyDebtGrowth+Math.max(0,input.debtReductionGoal));
 const balanceChange=cents(monthlyDebtGrowth-Math.max(0,input.monthlyPayment));
 const debtReduction=Math.max(0,cents(-balanceChange));
 let projectedBalance=Math.max(0,input.balance);let payoffMonths:number|null=null;
 if(projectedBalance<=0)payoffMonths=0;
 else if(input.monthlyPayment>0){
  for(let month=1;month<=600;month++){
   const monthInterest=estimateMonthlyInterest({...input,balance:projectedBalance});
   projectedBalance=Math.max(0,Math.round((projectedBalance+Math.max(0,input.purchases)+Math.max(0,input.fees)+monthInterest-Math.max(0,input.credits)-input.monthlyPayment)*100)/100);
   if(projectedBalance===0){payoffMonths=month;break;}
  }
 }
 return {interest,monthlyDebtGrowth,stayAhead,reduceDebt,balanceChange,debtReduction,payoffMonths,projectedBalance};
}

export type PaymentProjectionInput=PaymentPlannerInput&{horizonMonths?:number};
export type PaymentProjection={monthlyPayment:number;monthsToPayoff:number|null;totalFutureInterest:number|null;balanceAfterFirstMonth:number;monthlyBalanceChange:number;balanceAtHorizon:number;horizonMonths:number;paidOff:boolean;minimumShortfall:number;firstMonthInterest:number};

/**
 * Projects a fixed monthly payment under a simplified monthly model. APR mode
 * applies APR/12 to the current balance plus half the month’s new purchases.
 * Monthly-interest mode converts the user’s first-month interest estimate to
 * an implied monthly rate at the starting balance, then scales that rate as
 * the modeled balance changes. Purchases, fees, credits, and payments are
 * assumed to occur consistently once per month. The 600-month horizon is 50 years.
 */
export function simulatePayment(input:PaymentProjectionInput,payment=input.monthlyPayment):PaymentProjection{
 const horizon=Math.min(600,Math.max(1,Math.floor(input.horizonMonths??600)));
 const balance=Math.max(0,input.balance),purchases=Math.max(0,input.purchases),fees=Math.max(0,input.fees),credits=Math.max(0,input.credits),monthlyPayment=Math.max(0,payment);
 const startInterest=estimateMonthlyInterest(input);
 const impliedRate=input.interestMode==='apr'?Math.max(0,input.apr)/1200:startInterest/Math.max(1,balance+purchases/2);
 const interestFor=(current:number)=>cents(Math.max(0,current+purchases/2)*impliedRate);
 const firstMonthInterest=interestFor(balance);
 let current=balance,totalInterest=0,monthsToPayoff:number|null=balance===0&&purchases+fees<=credits?0:null,balanceAfterFirstMonth=balance;
 for(let month=1;month<=horizon&&(current>0||monthsToPayoff==null);month++){
  const interest=interestFor(current);totalInterest=cents(totalInterest+interest);
  const due=cents(current+purchases+fees+interest-credits);
  current=Math.max(0,cents(due-monthlyPayment));
  if(month===1)balanceAfterFirstMonth=current;
  if(current===0){monthsToPayoff=month;break}
 }
 return{monthlyPayment,monthsToPayoff,totalFutureInterest:monthsToPayoff==null?null:totalInterest,balanceAfterFirstMonth,monthlyBalanceChange:cents(balanceAfterFirstMonth-balance),balanceAtHorizon:current,horizonMonths:horizon,paidOff:monthsToPayoff!=null,minimumShortfall:Math.max(0,cents(Math.max(0,input.minimumDue??0)-monthlyPayment)),firstMonthInterest};
}

export function comparePaymentScenarios(input:PaymentProjectionInput,extraPayment:number){const base=simulatePayment(input,input.monthlyPayment);const increased=simulatePayment(input,input.monthlyPayment+Math.max(0,extraPayment));const complete=base.paidOff&&increased.paidOff;return{base,increased,complete,interestSavings:complete?cents((base.totalFutureInterest??0)-(increased.totalFutureInterest??0)):null,monthsSaved:complete?(base.monthsToPayoff??0)-(increased.monthsToPayoff??0):null};}
