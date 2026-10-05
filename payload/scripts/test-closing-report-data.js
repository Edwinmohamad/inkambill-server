const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { buildRevenueSummaryRows } = require('../services/closingReportData');
const { planSyncedReconciliation } = require('../services/closingSyncService');

async function main() {
  const allowed = new Set(['krwclm', 'kbg']);
  const items = [
    { entry_type: 'INCOME', site_code: 'KRW', amount: 150000, payment_id: 1, invoice_status: 'paid' },
    { entry_type: 'INCOME', site_code: 'KRW', amount: 50000, payment_id: 2, invoice_status: 'partial' },
    { entry_type: 'INCOME', site_code: 'KBG', amount: 80000, category: 'Pendapatan Peralihan Barang' },
    { entry_type: 'INCOME', site_code: 'KBG', amount: 99999, category: 'Excluded', excluded_at: '2026-10-01' },
    { entry_type: 'EXPENSE', site_code: 'KRW', amount: 30000, category: 'Material' }
  ];
  const unpaid = [{ id: 1, name: 'Fadilah', site_code: 'KRW', outstanding: 100000 }];
  const rows = buildRevenueSummaryRows(items, unpaid, allowed);
  assert.equal(rows.find(r => r.category === 'Pembayaran Pelanggan Lunas').amount, 150000);
  assert.equal(rows.find(r => r.category === 'Pembayaran Pelanggan Sebagian').amount, 50000);
  assert.equal(rows.find(r => r.category === 'Pendapatan Peralihan Barang').amount, 80000);
  assert.equal(rows.find(r => r.kind === 'total').amount, 280000);
  assert.equal(rows.find(r => r.kind === 'receivable').amount, 100000);
  const ali = buildRevenueSummaryRows(items, unpaid, new Set(['kbg']));
  assert.equal(ali.find(r => r.kind === 'total').amount, 80000);
  assert.equal(ali.find(r => r.kind === 'receivable').amount, 0);

  // Execute the real route loader with a DB fixture: two matching names, one
  // archived ID, multiple invoices on the current ID. No name-based merging.
  const route = fs.readFileSync(require.resolve('../routes/closing'), 'utf8');
  const source = route.slice(route.indexOf('async function loadUnpaidCustomers('), route.indexOf('// v2.5 — ringkasan aktivitas'));
  const customers = [{ id: 1, name: 'Fadilah', archived_at: null }, { id: 2, name: 'Fadilah', archived_at: '2026-09-01' }, { id: 3, name: 'Fadilah', archived_at: null }];
  const context = { db: { async execute(sql) {
    assert(sql.includes('c.archived_at IS NULL'));
    assert(sql.includes('i.archived_at IS NULL'));
    assert(sql.includes('GROUP BY c.id'));
    return [customers.filter(c => !c.archived_at).map(c => ({ ...c, outstanding: 100000, invoice_count: 2 }))];
  } } };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.load = loadUnpaidCustomers;', context);
  const result = await context.load('2026-09-30');
  assert.equal(result.unpaidSummary.count, 2);
  assert.equal(result.unpaidSummary.outstanding, 200000);
  assert(!result.unpaidCustomers.some(c => c.id === 2));
  context.db.execute = async () => { throw new Error('DB unavailable'); };
  await assert.rejects(context.load('2026-09-30'), /DB unavailable/);

  const base = { src_id: 1, src_status: 'APPROVED', cash_source_type: 'payment', entry_id: 1, transaction_date: '2026-09-05', site_code: 'KRW', amount: 100000 };
  const plan = await planSyncedReconciliation({ db: { execute: async () => [[
    { ...base, payment_status: 'cancelled', payment_method: 'transfer' },
    { ...base, entry_id: 2, payment_status: 'confirmed', payment_method: 'cash', payment_settlement_status: 'held' },
    { ...base, entry_id: 3, payment_status: null },
    { ...base, entry_id: 4, payment_status: 'confirmed', payment_method: 'cash', payment_settlement_status: 'settled' }
  ]] }, closingId: 1, start: '2026-09-01', end: '2026-09-30' });
  assert(plan.slice(0, 3).every(r => r.action === 'delete' && r.reason === 'payment_not_eligible'));
  assert.notEqual(plan[3].action, 'delete');
  console.log('Closing report regression OK: master/archive scope, distinct customer IDs, category totals, partial receipts, piutang isolation, recipient scope, DB failure, cancelled/held/missing payments.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
