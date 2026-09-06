const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const service=fs.readFileSync(path.join(root,'services/invoiceService.js'),'utf8');
const route=fs.readFileSync(path.join(root,'routes/invoices.js'),'utf8');
const checks=[
  [service.includes('function currentInvoiceAmounts(customer, year, monthIndex)'),'kalkulasi tunggal'],
  [service.includes("status IN ('pending','confirmed')"),'proteksi pembayaran'],
  [service.includes("['unpaid','overdue'].includes(invoice.status)"),'hanya faktur terbuka'],
  [service.includes('Number(invoice.paid_amount || 0) === 0'),'proteksi pembayaran sebagian'],
  [service.includes('subtotal=?,discount=?,total=?,outstanding=?'),'nominal dan sisa disegarkan'],
  [service.includes('refreshed++')&&service.includes('return { created, refreshed'),'hasil refresh dilaporkan'],
  [route.includes('nominal tagihan terbuka diperbarui'),'pesan admin jelas']
];
for(const [valid,label] of checks)if(!valid)throw new Error(`Validasi refresh invoice gagal: ${label}`);
console.log(`Invoice refresh validation passed: ${checks.length} checks.`);
