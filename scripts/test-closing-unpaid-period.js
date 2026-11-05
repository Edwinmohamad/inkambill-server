const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../routes/closing.js'), 'utf8');
const functionSource = source.slice(source.indexOf('async function loadUnpaidCustomers('), source.indexOf('// v2.5 — ringkasan aktivitas'));
const invoices = [
  { customer: 'A', year: 2026, month: 10, outstanding: 165, active: true },
  { customer: 'B', year: 2026, month: 10, outstanding: 0, active: true },
  { customer: 'C', year: 2026, month: 10, outstanding: 150, active: false },
  { customer: 'D', year: 2026, month: 11, outstanding: 165, active: true }
];
const db = { async execute(sql, params) {
  assert.match(sql, /i\.period_year=\? AND i\.period_month=\?/);
  assert.match(sql, /COALESCE\(i\.outstanding,0\)/);
  assert.match(sql, /JOIN packages pkg ON pkg\.id=c\.package_id/);
  assert.doesNotMatch(sql, /c\.customer_status|c\.archived_at|confirmed_paid/);
  const [year, month] = params;
  return [invoices.filter(i => i.year === year && i.month === month && i.outstanding > 0)
    .map(i => ({name:i.customer, invoice_count:1, outstanding:i.outstanding}))];
} };
const context = {db, console};
vm.createContext(context);
vm.runInContext(functionSource + '\nthis.load = loadUnpaidCustomers;', context);
(async () => {
  const oct = await context.load('2026-10-01','2026-10-31');
  assert.equal(oct.unpaidSummary.count,2);
  assert.equal(oct.unpaidSummary.outstanding,315);
  assert.deepEqual(Array.from(oct.unpaidCustomers, r => r.name),['A','C']);
  const nov = await context.load('2026-11-01','2026-11-30');
  assert.equal(nov.unpaidSummary.count,1);
  assert.equal(nov.unpaidSummary.outstanding,165);
  assert.equal((source.match(/loadUnpaidCustomers\(start, end\)/g) || []).length,3);
  console.log('PASS closing unpaid invoices match report scope and outstanding balance');
})().catch(e => {console.error(e);process.exitCode=1;});
