const assert=require('assert');
const {approveCashTransaction,rejectCashTransaction}=require('../services/cashService');

function fakeConn(initial){
  let row={...initial};
  const calls=[];
  return {calls,get row(){return row;},async execute(sql,params=[]){calls.push({sql,params});if(sql.startsWith('SELECT ct.id'))return [[{...row,category_type:'expense'}]];if(sql.startsWith("UPDATE cash_transactions SET approval_status='APPROVED'")){row={...row,approval_status:'APPROVED',approval_reason:null,reviewed_by:params[0]};return [{affectedRows:1}];}if(sql.startsWith("UPDATE cash_transactions SET approval_status='REJECTED'")){row={...row,approval_status:'REJECTED',approval_reason:params[0],reviewed_by:params[1]};return [{affectedRows:1}];}throw new Error(`Unexpected SQL: ${sql}`);}};
}

(async()=>{
  const approved=fakeConn({id:7,transaction_code:'EXP-202608-000007',name:'Material FO',amount:150000,source_type:'manual',approval_status:'PENDING_APPROVAL'});
  const approvedTx=await approveCashTransaction(approved,7,1);
  assert.equal(approvedTx.id,7);assert.equal(approved.row.approval_status,'APPROVED');assert.equal(approved.row.reviewed_by,1);

  const rejected=fakeConn({id:8,transaction_code:'EXP-202608-000008',name:'Transport',amount:80000,source_type:'manual',approval_status:'PENDING_APPROVAL'});
  const rejectedTx=await rejectCashTransaction(rejected,8,2,'  Bukti nominal belum sesuai  ');
  assert.equal(rejected.row.approval_status,'REJECTED');assert.equal(rejected.row.approval_reason,'Bukti nominal belum sesuai');assert.equal(rejectedTx.approval_reason,'Bukti nominal belum sesuai');

  const nonPending=fakeConn({id:9,source_type:'manual',approval_status:'APPROVED'});
  await assert.rejects(()=>approveCashTransaction(nonPending,9,1),/PENDING_APPROVAL/);
  // v1.24.5 — AUTO BILLING rows (source_type='payment') can be edited from Data Kas like manual entries
  // (routes/finance.js POST /cash/:id/update), which resets them to PENDING_APPROVAL just like a manual
  // row. approveCashTransaction/rejectCashTransaction therefore no longer special-case source_type: an
  // edited AUTO BILLING row must be approvable/rejectable too, or it would get stuck in PENDING_APPROVAL
  // forever. This asserts the CURRENT (intentional) behavior instead of the old pre-v1.24.5 guard, which
  // this test previously still expected even though the guard itself was already removed from cashService.js.
  const automatic=fakeConn({id:10,transaction_code:'EXP-202608-000010',name:'Auto billing edit',amount:120000,source_type:'payment',approval_status:'PENDING_APPROVAL'});
  const automaticTx=await approveCashTransaction(automatic,10,1);
  assert.equal(automaticTx.id,10);assert.equal(automatic.row.approval_status,'APPROVED');
  const shortReason=fakeConn({id:11,source_type:'manual',approval_status:'PENDING_APPROVAL'});
  await assert.rejects(()=>rejectCashTransaction(shortReason,11,1,'x'),/minimal 3 karakter/);
  console.log('Cash approval validation OK: approve/reject transitions, reason validation, duplicate-state guards, and edited-AUTO-BILLING-row approval passed.');
})().catch(err=>{console.error('Cash approval validation FAILED:',err.stack||err);process.exit(1);});
