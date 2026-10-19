const assert=require('node:assert/strict'),fs=require('node:fs');
const {installmentSchedule}=require('../routes/debts');
const date='2099-01-01';
const basic={principal_amount:1000000,payment_method:'INSTALLMENT',installment_months:3,issue_date:date,due_date:date,payments:[]};
const first=installmentSchedule(basic);
assert.deepEqual(first.map(x=>x.target),[333333,333333,333334]);
assert.equal(first.reduce((n,x)=>n+x.target,0),1000000);
assert.deepEqual(first.map(x=>x.remaining),first.map(x=>x.target));
const paid=installmentSchedule({...basic,payments:[
 {id:1,payment_date:'2099-01-01',amount:333333,installment_number:null},
 {id:2,payment_date:'2099-01-02',amount:100000,installment_number:2},
 {id:3,payment_date:'2099-01-03',amount:50000,installment_number:2}
]});
assert.deepEqual(paid.map(x=>x.paid),[333333,150000,0]);
assert.deepEqual(paid.map(x=>x.status),['PAID','PARTIAL','UPCOMING']);
assert.equal(paid[1].remaining,183333);
const monthly=installmentSchedule({...basic,issue_date:'2099-01-31',due_date:null});
assert.equal(monthly[0].dueDate,'2099-02-28','first due is one month after origination when no due date is specified');
assert.equal(monthly[1].dueDate,'2099-03-28','subsequent installments remain monthly and valid');
const arbitrary=installmentSchedule({...basic,payments:[{id:5,payment_date:'2099-01-02',amount:200000,installment_number:3}]});
assert.deepEqual(arbitrary.map(x=>x.paid),[0,0,200000]);
const route=fs.readFileSync('routes/debts.js','utf8'),schema=fs.readFileSync('services/schemaService.js','utf8');
const app=fs.readFileSync('app.js','utf8'),ui=fs.readFileSync('views/debts/index.ejs','utf8');
assert.match(schema,/ADD COLUMN IF NOT EXISTS installment_number/);
assert.match(schema,/ADD COLUMN IF NOT EXISTS voided_at/);
assert.match(app,/await ensureV66Schema\(\)/);
assert.match(route,/INSERT INTO finance_debt_payments\(debt_id,installment_number/);
assert.doesNotMatch(route,/INSERT INTO finance_debt_cash_movements/);
assert.doesNotMatch(route,/INSERT INTO cash_transactions/);
assert.match(route,/SET voided_at=NOW\(\)/);
assert.match(route,/WHERE voided_at IS NULL GROUP BY debt_id/);
assert.match(ui,/Cicilan ke-<%= item.number %>/);
assert.match(ui,/data-debt-installment-number/);
assert.match(ui,/Lanjut Bayar/);
assert.match(ui,/name="installment_number" id="debtPayInstallmentNumber"/);
assert.match(ui,/Sisa cicilan setelah pembayaran/);
console.log('PASS explicit installments, partial/legacy allocation, voidable audit trail and manual Cash-only recording');
