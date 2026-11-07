const assert=require('node:assert/strict'),Module=require('node:module');
const original=Module._load;let captured;
Module._load=function(request,parent,...args){if(request==='../config/db'&&parent.filename.endsWith('customerReceiptService.js'))return {execute:async(sql,params)=>{captured={sql,params};return [[
 {method:'transfer',status:'confirmed',amount:450000,transaction_count:3},
 {method:'cash',status:'confirmed',settlement_status:'held_by_staff',amount:100000,transaction_count:1},
 {method:'cash',status:'confirmed',settlement_status:'settled',amount:200000,transaction_count:2},
 {method:'qris',status:'confirmed',amount:50000,transaction_count:1},
 {method:'transfer',status:'pending',amount:900000,transaction_count:5}
 ]];}};return original.call(this,request,parent,...args);};
const {loadCustomerReceipts}=require('../services/customerReceiptService');Module._load=original;
(async()=>{
 const r=await loadCustomerReceipts({date:'2026-11-07',siteId:3});
 assert.equal(r.amount,800000);assert.equal(r.transfer,450000);assert.equal(r.cash,300000);assert.equal(r.cashHeld,100000);assert.equal(r.qris,50000);assert.equal(r.count,7);assert.equal(r.pending,900000);
 assert.deepEqual(captured.params,['2026-11-07','2026-11-07',3]);
 assert.match(captured.sql,/p.paid_at>=\?/);assert.match(captured.sql,/p.paid_at<DATE_ADD\(\?,INTERVAL 1 DAY\)/);
 assert.match(captured.sql,/p.status IN \('confirmed','pending'\)/);
 assert.doesNotMatch(captured.sql,/verified_at|booked_at|period_month|period_year|customer_status|archived_at/);
 await assert.rejects(()=>loadCustomerReceipts({date:'2026-02-30'}));await assert.rejects(()=>loadCustomerReceipts({date:'bad'}));
 await loadCustomerReceipts({date:'2026-11-07'});assert.deepEqual(captured.params,['2026-11-07','2026-11-07']);assert(!captured.sql.includes('c.site_id=?'));
 console.log('Customer receipts: payment-date range, site scope, confirmed methods, pending and cash held PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
