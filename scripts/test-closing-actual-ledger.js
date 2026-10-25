const assert=require('node:assert/strict');
const {loadActualClosing}=require('../services/closingLedgerService');
const {mapCashRowToEntry,planSyncedReconciliation}=require('../services/closingSyncService');
(async()=>{
 const db={execute:async(sql,args)=>{assert(sql.includes('FROM cash_transactions'));assert(!sql.includes('FROM closing_entries'));assert.deepEqual(args,['2026-10-01','2026-10-31']);return [[{id:10,site_code:null,amount:100000,category_type:'income',category_name:'Billing',transaction_date:'2026-10-01'}]];}};
 const result=await loadActualClosing({db,start:'2026-10-01',end:'2026-10-31',closing:{mode:'MANUAL',manual_revenue:999999,manual_expense:12345}});
 assert.equal(result.ledgerSummary.income,100000);assert.equal(result.ledgerSummary.expense,0);assert.equal(result.blocks.other.revenue,100000);assert.equal(result.blocks.krwclm.revenue,0);assert.equal(result.ledgerSummary.invalid,1);
 assert.equal(mapCashRowToEntry({site_code:null,amount:100000}).skip,'unmapped');
 const base={entry_id:1,cash_transaction_id:1,src_id:1,src_status:'APPROVED',src_source_type:'payment'};
 for(const payment of [{payment_status:'failed'},{payment_status:null},{payment_status:'confirmed',payment_method:'cash',payment_settlement_status:'held_by_staff'}]){
 const plan=await planSyncedReconciliation({db:{execute:async()=>[[{...base,...payment}]]},closingId:1,start:'2026-10-01',end:'2026-10-31'});
 assert.equal(plan[0].action,'delete');assert.equal(plan[0].reason,'invalid_source_payment');
 }
 console.log('PASS actual Closing ledger: legacy override ignored, unmapped preserved, invalid source payments removed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
