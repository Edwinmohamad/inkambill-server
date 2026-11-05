const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../routes/closing.js'), 'utf8');
const functionSource = source.slice(source.indexOf('async function loadUnpaidCustomers('), source.indexOf('// v2.5 — ringkasan aktivitas'));
const invoices = [
  { id: 1, customer: 'A', year: 2026, month: 1, total: 100, status: 'unpaid' },
  { id: 2, customer: 'A', year: 2026, month: 2, total: 200, status: 'unpaid' },
  { id: 3, customer: 'B', year: 2026, month: 2, total: 150, status: 'unpaid' },
  { id: 4, customer: 'C', year: 2025, month: 2, total: 500, status: 'unpaid' },
  { id: 5, customer: 'D', year: 2026, month: 2, total: 300, status: 'cancelled' }
];
const payments = [
  { invoice: 2, amount: 50, date: '2026-02-15', status: 'confirmed' },
  { invoice: 2, amount: 40, date: '2026-03-01', status: 'confirmed' },
  { invoice: 3, amount: 150, date: '2026-03-05', status: 'confirmed' },
  { invoice: 2, amount: 30, date: '2026-02-20', status: 'pending' }
];
const db = { async execute(sql, params) {
  assert.match(sql, /i\.period_year=\? AND i\.period_month=\?/);
  assert.doesNotMatch(sql, /booked_at|paid_at/);
  assert.match(sql, /status='confirmed'/);
  assert.match(sql, /i\.status NOT IN \('cancelled','refunded'\)/);
  const [year, month] = params;
  const rows = invoices.filter(i => i.year === year && i.month === month && !['cancelled', 'refunded'].includes(i.status))
    .map(i => ({ name: i.customer, invoice_count: 1, outstanding: Math.max(i.total - payments.filter(p => p.invoice === i.id && p.status === 'confirmed').reduce((s, p) => s + p.amount, 0), 0) }))
    .filter(i => i.outstanding > 0);
  return [rows];
} };
const context = { db, console };
vm.createContext(context);
vm.runInContext(functionSource + '\nthis.load = loadUnpaidCustomers;', context);
(async () => {
  const feb = await context.load('2026-02-01', '2026-02-28');
  assert.equal(feb.unpaidSummary.count, 1);
  assert.equal(feb.unpaidSummary.outstanding, 110);
  assert.equal(feb.unpaidCustomers[0].name, 'A');
  const jan = await context.load('2026-01-01', '2026-01-31');
  assert.equal(jan.unpaidSummary.outstanding, 100);
  assert.equal((source.match(/loadUnpaidCustomers\(start, end\)/g) || []).length, 3);
  console.log('Closing unpaid billing-period checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
