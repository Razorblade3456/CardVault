import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const vite=await createServer({configFile:`${root}/vite.config.ts`,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom',logLevel:'silent'});
let planner;
try{planner=await vite.ssrLoadModule('/src/payment-planner.ts')}finally{await vite.close()}

test('payment targets include new interest, fees, credits, minimum due, and a debt reduction goal',()=>{
 const result=planner.calculatePaymentPlan({balance:6733.42,minimumDue:214,monthlyPayment:1500,purchases:1301.48,fees:0,credits:0,interestMode:'monthly',monthlyInterest:146.76,apr:0,debtReductionGoal:100});
 assert.equal(result.stayAhead,1448.24);
 assert.equal(result.reduceDebt,1548.24);
 assert.equal(result.debtReduction,51.76);
 assert.equal(result.balanceChange,-51.76);
});

test('payment simulations recalculate future interest as balances change and extra payments shorten payoff',()=>{
 const input={balance:1200,minimumDue:35,monthlyPayment:125,purchases:0,fees:0,credits:0,interestMode:'apr',monthlyInterest:0,apr:24,debtReductionGoal:100};
 const normal=planner.simulatePayment(input);const higher=planner.simulatePayment(input,input.monthlyPayment+50);const comparison=planner.comparePaymentScenarios(input,50);
 assert.equal(normal.paidOff,true);assert.equal(higher.paidOff,true);assert.ok(higher.monthsToPayoff<normal.monthsToPayoff);assert.ok(higher.totalFutureInterest<normal.totalFutureInterest);assert.ok(Math.abs(comparison.interestSavings-(normal.totalFutureInterest-higher.totalFutureInterest))<.001);assert.equal(comparison.monthsSaved,normal.monthsToPayoff-higher.monthsToPayoff);
});

test('simulations include steady future purchases and change when APR or monthly interest assumptions change',()=>{
 const base={balance:500,minimumDue:25,monthlyPayment:100,purchases:0,fees:0,credits:0,interestMode:'apr',monthlyInterest:0,apr:18,debtReductionGoal:0};
 const noSpend=planner.simulatePayment(base);const spend=planner.simulatePayment({...base,purchases:50});const higherApr=planner.simulatePayment({...base,apr:30});
 assert.ok(spend.totalFutureInterest>noSpend.totalFutureInterest);assert.ok(spend.monthsToPayoff>noSpend.monthsToPayoff);assert.ok(higherApr.totalFutureInterest>noSpend.totalFutureInterest);
 const monthly=planner.simulatePayment({...base,interestMode:'monthly',monthlyInterest:12,apr:0});const lowerMonthly=planner.simulatePayment({...base,interestMode:'monthly',monthlyInterest:4,apr:0});assert.ok(monthly.totalFutureInterest>lowerMonthly.totalFutureInterest);
});

test('zero starting balance still models ongoing purchases and cards simulate independently',()=>{
 const zero={balance:0,minimumDue:0,monthlyPayment:0,purchases:100,fees:0,credits:0,interestMode:'apr',monthlyInterest:0,apr:24,debtReductionGoal:0};const unpaid=planner.simulatePayment(zero);assert.equal(unpaid.monthsToPayoff,null);assert.ok(unpaid.balanceAfterFirstMonth>0);
 const cardA=planner.simulatePayment({...zero,balance:800,purchases:0,monthlyPayment:100});const cardB=planner.simulatePayment({...zero,balance:2400,purchases:0,monthlyPayment:100});assert.ok(cardB.monthsToPayoff>cardA.monthsToPayoff);assert.ok(cardB.totalFutureInterest>cardA.totalFutureInterest);
});

test('credits and fees change the estimated stay-ahead payment and a minimum remains a floor',()=>{
 const result=planner.calculatePaymentPlan({balance:1000,minimumDue:125,monthlyPayment:150,purchases:200,fees:10,credits:40,interestMode:'monthly',monthlyInterest:20,apr:0,debtReductionGoal:25});
 assert.equal(result.stayAhead,190);
 assert.equal(result.reduceDebt,215);
});

test('APR mode estimates interest against the balance and half of expected purchases',()=>{
 const result=planner.calculatePaymentPlan({balance:1200,minimumDue:null,monthlyPayment:200,purchases:200,fees:0,credits:0,interestMode:'apr',monthlyInterest:0,apr:24,debtReductionGoal:100});
 assert.equal(result.interest,26);
 assert.equal(result.stayAhead,226);
 assert.equal(result.balanceChange,26);
});

test('payoff estimate is absent when the payment cannot amortize the modeled balance',()=>{
 const result=planner.calculatePaymentPlan({balance:1000,minimumDue:25,monthlyPayment:10,purchases:20,fees:0,credits:0,interestMode:'monthly',monthlyInterest:15,apr:0,debtReductionGoal:100});
 assert.equal(result.payoffMonths,null);
});

test('non-amortizing and below-minimum scenarios remain explicit and savings stay incomplete',()=>{
 const input={balance:1000,minimumDue:40,monthlyPayment:10,purchases:25,fees:0,credits:0,interestMode:'monthly',monthlyInterest:50,apr:0,debtReductionGoal:0};const projection=planner.simulatePayment(input);const comparison=planner.comparePaymentScenarios(input,5);
 assert.equal(projection.paidOff,false);assert.equal(projection.monthsToPayoff,null);assert.equal(projection.totalFutureInterest,null);assert.equal(projection.minimumShortfall,30);assert.equal(comparison.complete,false);assert.equal(comparison.interestSavings,null);assert.equal(comparison.monthsSaved,null);
});
