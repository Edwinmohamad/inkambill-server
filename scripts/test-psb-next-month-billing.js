const fs=require('fs');
const assert=require('assert');
const {buildPsbTerms,isPsbActivationPeriod}=require('../services/psbService');

const yes=buildPsbTerms({isNewInstall:true,teamPayment:'yes',packagePrice:165000,salesFlatCommission:50000});
assert.deepStrictEqual(yes,{isNewInstall:1,firstMonthFree:1,teamPayment:1,salesAmount:50000,technicianAmount:115000});
assert.deepStrictEqual(buildPsbTerms({isNewInstall:true,teamPayment:'no',packagePrice:165000,salesFlatCommission:50000}),{isNewInstall:1,firstMonthFree:1,teamPayment:0,salesAmount:0,technicianAmount:0});
assert.throws(()=>buildPsbTerms({isNewInstall:true,teamPayment:'yes',packagePrice:40000,salesFlatCommission:50000}),/tidak valid/);
assert.strictEqual(isPsbActivationPeriod('2026-10-15',2026,9),true);
assert.strictEqual(isPsbActivationPeriod('2026-10-15',2026,10),false);

const route=fs.readFileSync('routes/customers.js','utf8');
const invoice=fs.readFileSync('services/invoiceService.js','utf8');
const payment=fs.readFileSync('services/paymentVerificationService.js','utf8');
const schema=fs.readFileSync('services/schemaService.js','utf8');
const form=fs.readFileSync('views/customers/form.ejs','utf8');
const list=fs.readFileSync('views/customers/index.ejs','utf8');
const detail=fs.readFileSync('views/customers/detail.ejs','utf8');

assert(route.includes('psbTerms.firstMonthFree')&&route.includes('psb_team_payment'),'customer create must persist the PSB policy');
assert(route.includes('Tanggal instalasi wajib diisi'),'PSB activation date guard missing');
assert(!route.slice(route.indexOf("router.post('/',"),route.indexOf("router.post('/bulk'")).includes('INSERT INTO cash_transactions'),'customer creation must not journal cash');
assert(invoice.includes('isPsbActivationPeriod(c.activation_date, year, monthIndex)'),'activation-month invoice skip missing');
assert(!invoice.includes('await settleNewInstallCommission(conn'),'monthly generator must not create PSB settlement');
assert(payment.includes('0 is_psb'),'next-month invoice must be ordinary billing');
assert(!payment.includes('payment_commission_technician')&&!payment.includes('payment_commission_sales'),'payment flow must not post PSB commissions');
for(const column of ['psb_team_payment','psb_sales_amount','psb_technician_amount','psb_settled_at','psb_settled_by'])assert(schema.includes(column),`schema missing ${column}`);
assert(form.includes('Pembayaran instalasi pelanggan dibagikan ke teknisi dan sales?'),'PSB yes/no control missing');
assert(form.includes('tidak membuat tagihan, pemasukan, pengeluaran, atau jurnal kas'),'non-cash explanation missing');
assert(list.includes('PSB <%= psbMonth %>'),'PSB month tag missing from list');
assert(detail.includes('DAMPAK KAS PERUSAHAAN')&&detail.includes('Rp0'),'PSB cash impact missing from detail');
assert(detail.includes('Mulai bulan depan')&&detail.includes('Tidak ada tagihan pada bulan instalasi'),'PSB billing state is misleading');

console.log('PSB next-month billing validation: PASS');
