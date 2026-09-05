const assert = require('assert');
const fs = require('fs');
const { buildClosingCalculation } = require('../services/closingCalculator');

const data = buildClosingCalculation({
  mode: 'manual',
  closing: { manual_revenue: 0, manual_expense: 0, manual_carry: 0, manual_salary_agung: 500000, manual_salary_padilah: 1000000 },
  payments: [
    { site_code: 'CDS', cluster_name: 'KRW', amount: 24000000 },
    { site_code: 'CDS', cluster_name: 'CLM', amount: 5000000 },
    { site_code: 'KBG', amount: 10000000 }
  ],
  expenses: [
    { site_code: 'CDS', category: 'Petty cash', amount: 10000000 },
    { site_code: 'KBG', category: 'Maintenance', amount: 2000000 }
  ],
  heldCash: [{ site_code: 'CDS', cluster_name: 'KRW', holder_name: 'Jon', amount: 100000 }],
  routerAssets: [{ site_code: 'CDS', cluster_name: 'CLM', owner_name: 'Bopung', units: 2, status: 'ACTIVE' }],
  adjustments: [{ site_code: 'KBG', recipient_name: 'Jon', amount: 50000, direction: 'DEDUCT' }]
});

assert.equal(data.blocks.krwclm.revenue, 29000000);
assert.equal(data.blocks.krwclm.expense, 10000000);
assert.deepEqual(data.blocks.krwclm.clusterRevenue, { KRW: 24000000, CLM: 5000000 });
assert.equal(data.blocks.krwclm.profit, 19000000);
assert.equal(data.blocks.krwclm.shares.find((share) => share.name === 'Edwin').amount, 8750000);
assert.equal(data.blocks.krwclm.shares.find((share) => share.name === 'Jon').amount, 4275000);
assert.equal(data.blocks.krwclm.shares.find((share) => share.name === 'Bopung').amount, 4415000);
assert.equal(data.blocks.kbg.profit, 8000000);
assert.equal(data.blocks.kbg.shares.find((share) => share.name === 'Jon').amount, 893280);
assert.equal(data.blocks.kbg.shares.find((share) => share.name === 'Mang Ali').amount, 2800000);

const aliases = buildClosingCalculation({
  mode: 'manual',
  closing: { manual_salary_agung: 1, manual_salary_padilah: 0 },
  payments: [
    { site_code: 'KUBANG', amount: 1000000 },
    { site_code: 'KRW', amount: 500000 }
  ],
  expenses: [{ site_code: 'CLM', category: 'Petty cash', amount: 100000 }]
});
assert.equal(aliases.blocks.kbg.revenue, 1000000, 'KUBANG harus dipetakan ke KBG');
assert.equal(aliases.blocks.krwclm.revenue, 500000, 'KRW harus masuk CDS');
assert.equal(aliases.blocks.krwclm.expense, 100000, 'CLM harus tetap masuk total biaya CDS');
assert.equal(aliases.salaryByOwner.edwin + aliases.salaryByOwner.jon + aliases.salaryByOwner.bopung, 1, 'Pembagian gaji harus tepat tanpa selisih pembulatan');
assert.equal(aliases.blocks.other.revenue, 0, 'Alias lokasi yang dikenal tidak boleh masuk lokasi belum dipetakan');

// Closing must remain a true manual calculator. Guard the route itself so a
// future edit cannot quietly reintroduce billing/payment/cash synchronisation.
const closingRoute = fs.readFileSync(require.resolve('../routes/closing'), 'utf8');
const loadStart = closingRoute.indexOf('async function loadClosing');
const loadEnd = closingRoute.indexOf('async function ensureDraftPeriod');
assert(loadStart >= 0 && loadEnd > loadStart, 'loadClosing route section is missing');
const loadSource = closingRoute.slice(loadStart, loadEnd);
assert(!/FROM\s+payments\b/i.test(loadSource), 'Closing tidak boleh membaca payments');
assert(!/FROM\s+cash_transactions\b/i.test(loadSource), 'Closing tidak boleh membaca cash_transactions');
assert(!/settlement_status/i.test(loadSource), 'Closing tidak boleh memakai status settlement billing');
assert(loadSource.includes('FROM closing_entries'), 'Closing harus memakai closing_entries sebagai sumber angka manual');
assert(closingRoute.includes("mode: 'manual'"), 'Mode Closing harus dipaksa manual');
console.log('Closing calculator validation OK: manual-only source, cluster revenue, combined expenses, salary, cash, router, and per-location adjustments reconcile without double counting.');
