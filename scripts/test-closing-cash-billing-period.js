const assert = require('node:assert/strict');
const { loadActualClosing, countPendingClosingCash } = require('../services/closingLedgerService');

const rows = [
  { id: 1, transaction_date: '2026-11-05', year: 2026, month: 10, amount: 100, category_type: 'income', category_name: 'Billing', site_code: 'KBG', status: 'APPROVED', payment_status: 'confirmed' },
  { id: 2, transaction_date: '2026-11-06', year: 2026, month: 11, amount: 200, category_type: 'income', category_name: 'Billing', site_code: 'KBG', status: 'APPROVED', payment_status: 'confirmed' },
  { id: 3, transaction_date: '2026-10-12', amount: 30, category_type: 'expense', category_name: 'Biaya', site_code: 'KBG', status: 'APPROVED' },
  { id: 4, transaction_date: '2026-11-08', year: 2026, month: 10, amount: 50, status: 'PENDING_APPROVAL' }
];
const db = { async execute(sql, params) {
  assert.match(sql, /COALESCE\(YEAR\(ct\.accounting_period\),source_invoice\.period_year/);
  assert.match(sql, /COALESCE\(MONTH\(ct\.accounting_period\),source_invoice\.period_month/);
  const [year, month] = params;
  const inPeriod = r => r.year ? r.year === year && r.month === month : Number(r.transaction_date.slice(0,4)) === year && Number(r.transaction_date.slice(5,7)) === month;
  if (sql.includes('COUNT(*)')) return [[{ n: rows.filter(r => inPeriod(r) && r.status === 'PENDING_APPROVAL').length }]];
  assert.match(sql, /source_payment\.status='confirmed'/);
  return [rows.filter(r => inPeriod(r) && r.status === 'APPROVED' && (!r.year || r.payment_status === 'confirmed'))];
} };
(async () => {
  const oct = await loadActualClosing({db, start: '2026-10-01', end: '2026-10-31'});
  const nov = await loadActualClosing({db, start: '2026-11-01', end: '2026-11-30'});
  assert.equal(oct.ledgerSummary.income, 100);
  assert.equal(oct.ledgerSummary.expense, 30);
  assert.equal(oct.lineItems[0].entry_date, '2026-11-05');
  assert.equal(nov.ledgerSummary.income, 200);
  assert.equal(await countPendingClosingCash({db,start:'2026-10-01',end:'2026-10-31'}), 1);
  assert.equal(await countPendingClosingCash({db,start:'2026-11-01',end:'2026-11-30'}), 0);
  console.log('PASS closing billing-period cash and pending approvals');
})().catch(e => { console.error(e); process.exitCode = 1; });
