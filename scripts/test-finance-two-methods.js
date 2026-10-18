const assert=require('node:assert/strict'),fs=require('node:fs');
const pay=fs.readFileSync('routes/payments.js','utf8');
const debt=fs.readFileSync('routes/debts.js','utf8');
const view=fs.readFileSync('views/debts/index.ejs','utf8');
assert.match(pay,/Metode pembayaran baru hanya Cash atau Transfer/);
assert.match(debt,/new Set\(\['cash', 'transfer'\]\)/);
assert.doesNotMatch(view,/name="payment_method" value="(?:qris|other)"/);
console.log('New cash/transfer-only methods: PASS');
