const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes/payments.js'),'utf8');
const view=fs.readFileSync(path.join(root,'views/payments/index.ejs'),'utf8');
const checks=[
  [route.includes("router.post('/:id/method-to-cash',requireMasterAdmin"),'khusus Master Admin'],
  [route.includes("['transfer','qris'].includes(payment.method)"),'sumber metode dibatasi'],
  [route.includes("DELETE FROM cash_transactions WHERE source_type='payment' AND source_id=?"),'jurnal transfer dibatalkan'],
  [route.includes("payment.status==='confirmed'?'held_by_staff':'not_applicable'"),'status settlement aman'],
  [route.includes("action:'correct_payment_method'"),'audit permanen'],
  [view.includes('paymentMethodCorrectionModal')&&view.includes('collector_user_id'),'UI collector'],
  [view.includes('Alasan koreksi')&&view.includes('minlength="3"'),'alasan wajib']
];
for(const [valid,label] of checks)if(!valid)throw new Error(`Validasi koreksi metode gagal: ${label}`);
console.log(`Payment method correction validation passed: ${checks.length} checks.`);
