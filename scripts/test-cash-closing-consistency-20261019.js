const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const finance=read('routes/finance.js'),sync=read('services/closingSyncService.js'),view=read('views/finance/cash.ejs');
const charts=finance.slice(finance.indexOf('const [categoryChartRows]'),finance.indexOf('const daysInMonth='));
assert.equal((charts.match(/ct\.internal_transfer_key IS NULL/g)||[]).length,2,'daily and category charts must exclude internal transfers even when filtering by site');
assert.doesNotMatch(charts,/site\?'1=1'/,'site filter must not change accounting treatment');
assert.match(finance,/WHERE ct\.internal_transfer_key IS NULL AND COALESCE\(ct\.approval_status/,'summary excludes internal transfer');
assert.match(sync,/ct\.transaction_date BETWEEN \? AND \?\s+AND ct\.internal_transfer_key IS NULL/,'AUTO Closing unsynced excludes transfers');
assert.match(sync,/WHERE ct\.id IN \(\$\{marks\}\)\s+AND ct\.internal_transfer_key IS NULL/,'direct Closing sync excludes transfers');
assert.match(sync,/if \(row\.internal_transfer_key\) \{ plan\.push\(\{ \.\.\.base, action: 'delete'/,'existing internal transfer Closing entries must be removed on re-sync');
assert.match(finance,/WHERE p\.method='cash' AND p\.status='confirmed' AND p\.settlement_status='held_by_staff'/,'collector-held cash must include all months');
assert.doesNotMatch(finance.slice(finance.indexOf('const [[collection]]'),finance.indexOf('const [categoryChartRows]')), /MONTH\(p\.paid_at\)/,'held cash is stock, not current month flow');
assert.match(view,/Bukan saldo rekening\/bank aktual/);
assert.match(view,/Cash masih di staff \(semua periode\)/);
const {planSyncedReconciliation}=require('../services/closingSyncService');
(async()=>{
 const conn={execute:async sql=>{
   assert.match(sql,/internal_transfer_key/);
   return [[{entry_id:44,cash_transaction_id:55,src_id:55,internal_transfer_key:'TX-INTERNAL',
      src_status:'APPROVED',transaction_date:'2026-10-01',amount:170000,
      entry_date:'2026-10-01',entry_amount:170000,category_type:'income',
      site_code:'KRW',entry_site:'CDS',entry_type:'INCOME'}]];
 }};
 const result=await planSyncedReconciliation({db:conn,closingId:7,start:'2026-10-01',end:'2026-10-31'});
 assert.equal(result.length,1);
 assert.equal(result[0].action,'delete');
 assert.equal(result[0].reason,'internal_transfer_not_operating_cash');
 console.log('PASS Data Kas summary/chart/collector stock and Closing internal transfer parity');
})().catch(e=>{console.error(e);process.exitCode=1});
