const assert = require('node:assert/strict');
const { buildRevenueSummaryRows } = require('../services/closingReportData');
const { mapCashRowToEntry, planSyncedReconciliation } = require('../services/closingSyncService');
(async () => {
  const allowed = new Set(['krwclm','kbg']);
  const rows = buildRevenueSummaryRows([
    {entry_type:'INCOME',site_code:'CDS',cluster_name:'KRW',payment_id:1,invoice_status:'paid',amount:100},
    {entry_type:'INCOME',site_code:'CDS',cluster_name:'CLM',category:'Pendapatan Peralihan Barang',amount:200},
    {entry_type:'INCOME',site_code:'KBG',payment_id:2,invoice_status:'partial',amount:50},
    {entry_type:'INCOME',site_code:'KBG',amount:999,excluded_at:'2026-09-01'}
  ],[{site_code:'KBG',outstanding:75}],allowed);
  assert.equal(rows.find(r=>r.kind==='total').amount,350);
  assert.equal(rows.find(r=>r.kind==='receivable').amount,75);
  assert.equal(rows.filter(r=>r.kind==='income').length,3);
  const mapped=mapCashRowToEntry({category_type:'income',amount:100,site_code:'CDS',cluster_name:'CLM',customer_name:'Fadilah',customer_code:'C001',name:'Old name',category_name:'Pendapatan pelanggan',invoice_status:'paid',transaction_date:'2026-09-05'});
  assert.equal(mapped.cluster,'CLM');
  assert.equal(mapped.category,'Pendapatan pelanggan');
  assert.match(mapped.description,/Fadilah \[C001\]/);
  for(const payment of [{payment_status:'cancelled'},{payment_status:'confirmed',payment_method:'cash',payment_settlement_status:'held_by_staff'}]){
    const db={execute:async()=>[[{entry_id:1,src_id:2,src_status:'APPROVED',cash_source_type:'payment',...payment}]]};
    const plan=await planSyncedReconciliation({db,closingId:1,start:'2026-09-01',end:'2026-09-30'});
    assert.equal(plan[0].reason,'payment_not_eligible');
    assert.equal(plan[0].action,'delete');
  }
  console.log('Closing report integrity: category/site totals, receivables, canonical customer and revoked payment reconciliation passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
