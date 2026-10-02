const fs=require('fs');const assert=require('assert');
const invoice=fs.readFileSync('services/invoiceService.js','utf8');const pay=fs.readFileSync('services/paymentVerificationService.js','utf8');const fin=fs.readFileSync('routes/finance.js','utf8');const cash=fs.readFileSync('services/cashService.js','utf8');const closingSync=fs.readFileSync('services/closingSyncService.js','utf8');const reports=fs.readFileSync('routes/reports.js','utf8');const analytics=fs.readFileSync('services/analyticsService.js','utf8');
assert(!/INSERT INTO payments[\s\S]{0,500}Pemasangan Baru/.test(invoice),'PSB invoice generation must not create payment');
assert(pay.includes("source_type IN ('payment','install_income')"),'cross-source dedupe missing');
assert(pay.includes('0 is_psb'),'regular invoice payment must never be reclassified as PSB settlement');
assert(!pay.includes("payment_commission_technician")&&!pay.includes("payment_commission_sales"),'PSB team settlement must never create cash expense journals');
assert(fin.includes('Jurnal otomatis/payment-linked tidak boleh dihapus'),'auto journal deletion guard missing');
assert(fin.includes('await assertDateOpen(conn,rows[0].transaction_date)'),'old-date lock guard missing');
assert(cash.includes('if(tx.transaction_date)await assertCashDateOpen(conn,tx.transaction_date)'),'approval/reject locked-period guard missing');
assert(pay.includes("sourcePayment.method==='cash'&&sourcePayment.settlement_status!=='settled'"),'cash held must be rejected before journal creation');
assert(pay.includes("p.method='cash' AND p.settlement_status='settled'"),'historical repair must only create settled cash journals');
for(const [source,label] of [[fin,'Data Kas balance'],[closingSync,'Closing sync'],[reports,'cash report'],[analytics,'cash analytics']]){
  assert(source.includes("source_payment.settlement_status='settled'")||source.includes("p.settlement_status='settled'"),`${label} must exclude cash held by collector`);
}
console.log('financial-integrity-static: PASS');
