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
assert.equal(data.blocks.krwclm.shares.find((share) => share.name === 'Bopung').amount, 4375000);
assert.equal(data.blocks.kbg.profit, 8000000);
assert.equal(data.blocks.kbg.shares.find((share) => share.name === 'Jon').amount, 893280);
assert.equal(data.blocks.kbg.shares.find((share) => share.name === 'Mang Ali').amount, 2800000);

// v1.29 — INVEST ROUTER auto-reward removed: owning a router must no longer add
// anything to a person's payout automatically. routerAssets is still accepted as a
// parameter for backward-compatible call sites, but it must be a complete no-op —
// the same input with and without routerAssets has to reconcile to the exact same
// rupiah for every recipient. Any reward now has to be entered as a visible manual
// adjustment (Langkah 3) instead.
const withoutRouter = buildClosingCalculation({
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
  adjustments: [{ site_code: 'KBG', recipient_name: 'Jon', amount: 50000, direction: 'DEDUCT' }]
  // routerAssets intentionally omitted here
});
['krwclm', 'kbg'].forEach((blockKey) => {
  data.blocks[blockKey].shares.forEach((share) => {
    const other = withoutRouter.blocks[blockKey].shares.find((s) => s.name === share.name);
    assert.equal(other.amount, share.amount, `routerAssets tidak boleh mengubah bagian ${share.name} di ${blockKey}`);
  });
});

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

// v2 — Closing punya dua mode (Manual/Otomatis) per periode, tapi kalkulasi inti
// (loadClosing) harus TETAP selalu membaca dari closing_entries saja, apa pun
// modenya — tidak boleh diam-diam membaca payments/cash_transactions langsung
// di dalam loadClosing. Sinkronisasi Data Kas hanya boleh masuk lewat jalur
// terpisah dan auditable: closingSyncService.js menulis baris ke closing_entries
// (bukan menghitung langsung), lalu loadClosing membacanya sama seperti baris
// manual biasa.
const closingRoute = fs.readFileSync(require.resolve('../routes/closing'), 'utf8');
const loadStart = closingRoute.indexOf('async function loadClosing');
const loadEnd = closingRoute.indexOf('async function ensureDraftPeriod');
assert(loadStart >= 0 && loadEnd > loadStart, 'loadClosing route section is missing');
const loadSource = closingRoute.slice(loadStart, loadEnd);
assert(!/FROM\s+payments\b/i.test(loadSource), 'loadClosing tidak boleh membaca payments langsung');
assert(!/FROM\s+cash_transactions\b/i.test(loadSource), 'loadClosing tidak boleh membaca cash_transactions langsung');
assert(!/settlement_status/i.test(loadSource), 'Closing tidak boleh memakai status settlement billing');
assert(loadSource.includes('FROM closing_entries'), 'Closing harus memakai closing_entries sebagai sumber angka, baik manual maupun hasil sync');
assert(loadSource.includes('closing.mode'), 'Mode closing harus dibaca dari data periode (closing_periods.mode), bukan konstanta tetap');

// Sinkronisasi Data Kas: harus lewat service terpisah, hanya menarik transaksi
// APPROVED, dan menandai baris hasil sync supaya tidak tertarik dobel.
const syncServiceSource = fs.readFileSync(require.resolve('../services/closingSyncService'), 'utf8');
assert(syncServiceSource.includes('FROM cash_transactions'), 'closingSyncService harus menarik dari cash_transactions');
assert(/approval_status[^\n]*APPROVED/.test(syncServiceSource), "closingSyncService hanya boleh menarik transaksi APPROVED");
assert(syncServiceSource.includes("'cash_sync'"), 'Baris hasil sync harus ditandai source_type cash_sync');
assert(syncServiceSource.includes('cash_transaction_id'), 'Baris hasil sync harus melacak cash_transaction_id supaya sync berikutnya tidak dobel');

// Endpoint /mode dan /sync wajib ada dan dijaga: sync hanya boleh jalan kalau
// periode masih DRAFT dan mode-nya AUTO.
assert(closingRoute.includes("router.post('/mode'"), 'Route ganti mode closing wajib tersedia');
assert(closingRoute.includes("router.post('/sync'"), 'Route sinkronisasi Data Kas wajib tersedia');
const syncStart = closingRoute.indexOf("router.post('/sync'");
const syncEnd = closingRoute.indexOf("router.post('/period-lock'");
const syncRouteSource = closingRoute.slice(syncStart, syncEnd);
assert(/status\s*===\s*['"]LOCKED['"]/.test(syncRouteSource), 'Route /sync wajib menolak periode yang sudah LOCKED');
assert(/mode[^\n]*!==\s*['"]AUTO['"]/.test(syncRouteSource), 'Route /sync wajib menolak kalau mode periode bukan AUTO');

// Financial control: kalkulasi tetap independen, periode bisa dikunci/dibuka
// kembali oleh Master Admin, dan setiap ganti mode/sync harus tercatat di audit log.
assert(closingRoute.includes("router.post('/period-lock'"), 'Route kunci periode wajib tersedia');
assert(closingRoute.includes("router.post('/period-reopen'"), 'Route buka kembali periode wajib tersedia');
assert(!/router\.(get|post)\(['"]\/router-assets/.test(closingRoute), 'Route /router-assets harus sudah dihapus');
assert(/status\s*===\s*['"]LOCKED['"]/.test(closingRoute), 'Guard status LOCKED wajib tersedia');
assert(closingRoute.includes("router.post('/entries/:id/update'"), 'Route edit entry (closing_entries) harus tersedia');
assert(closingRoute.includes("router.post('/adjustments/:id/update'"), 'Route edit penyesuaian (closing_adjustments) harus tersedia');
assert(closingRoute.includes("action:'set_closing_mode'") || closingRoute.includes("action: 'set_closing_mode'"), 'Ganti mode wajib tercatat di financialAudit');
assert(closingRoute.includes("action:'sync_closing_cash'") || closingRoute.includes("action: 'sync_closing_cash'"), 'Sinkronisasi Data Kas wajib tercatat di financialAudit');
console.log('Closing calculator validation OK: entries-based source (manual & sinkron Data Kas), cluster revenue, combined expenses, salary, cash, and per-location adjustments reconcile without double counting; router ownership no longer auto-rewards; mode switch & sync are DRAFT/AUTO-gated and audited.');
