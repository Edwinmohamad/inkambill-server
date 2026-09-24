const assert = require('assert');
const { syncCashDataIntoClosing, countPendingCashData, planSyncedReconciliation } = require('../services/closingSyncService');

// Baris Data Kas tiruan yang akan dilihat oleh service — mensimulasikan hasil JOIN
// cash_transactions x cash_categories x sites persis seperti query asli.
const CASH_ROWS = [
  { id: 101, transaction_date: '2026-08-05', name: 'Pembayaran pelanggan', amount: 5000000, notes: null, category_type: 'income', category_name: 'Pendapatan pelanggan', site_code: 'CDS' },
  { id: 102, transaction_date: '2026-08-10', name: 'Beli kabel', amount: 1200000, notes: 'untuk KRW', category_type: 'expense', category_name: 'Material jaringan', site_code: 'CDS' },
  { id: 103, transaction_date: '2026-08-12', name: 'Sewa ruko cabang lain', amount: 800000, notes: null, category_type: 'expense', category_name: 'Sewa', site_code: 'XYZ' }, // lokasi tak terpetakan
  { id: 104, transaction_date: '2026-08-15', name: 'Transaksi nominal nol', amount: 0, notes: null, category_type: 'income', category_name: 'Lain-lain', site_code: 'KBG' }, // nominal 0
  { id: 106, transaction_date: '2026-08-20', name: 'Race condition row', amount: 250000, notes: null, category_type: 'income', category_name: 'Pendapatan pelanggan', site_code: 'KBG' } // akan disimulasikan dobel oleh proses lain
];

function fakeConn() {
  const inserts = [];
  return {
    inserts,
    async execute(sql, params = []) {
      if (sql.startsWith('SELECT ct.id')) return [CASH_ROWS];
      if (sql.startsWith('SELECT ce.id')) return [[]];
      if (sql.startsWith('INSERT INTO closing_entries')) {
        const [, , , cashTransactionId] = params;
        if (cashTransactionId === 106) { const err = new Error('Duplicate entry'); err.code = 'ER_DUP_ENTRY'; throw err; }
        inserts.push(params);
        return [{ insertId: inserts.length }];
      }
      throw new Error(`Unexpected SQL in fakeConn: ${sql}`);
    }
  };
}

function fakeDb(pendingApprovalCount) {
  return {
    async execute(sql) {
      if (sql.startsWith('SELECT COUNT(*) n FROM cash_transactions')) return [[{ n: pendingApprovalCount }]];
      if (sql.startsWith('SELECT ct.id')) return [CASH_ROWS];
      if (sql.startsWith('SELECT ce.id')) return [[]];
      throw new Error(`Unexpected SQL in fakeDb: ${sql}`);
    }
  };
}

(async () => {
  // syncCashDataIntoClosing: hanya baris yang mappable (CDS/KBG) dan nominal > 0
  // yang benar-benar di-INSERT; baris yang "dobel" (race condition, ER_DUP_ENTRY)
  // harus diabaikan dengan tenang, bukan melempar error ke atas.
  const conn = fakeConn();
  const result = await syncCashDataIntoClosing({ conn, closingId: 42, start: '2026-08-01', end: '2026-08-31', userId: 7 });
  assert.equal(result.scanned, 5, 'harus memindai seluruh baris yang dikembalikan query');
  assert.equal(result.inserted, 2, 'cuma baris 101 & 102 yang valid untuk di-insert (103 unmapped, 104 nominal 0, 106 race-duplicate)');
  assert.equal(result.skippedUnmapped, 1, 'site_code XYZ harus dilewati sebagai lokasi tak terpetakan');
  assert.equal(result.skippedZero, 1, 'nominal 0 harus dilewati');

  const incomeInsert = conn.inserts.find((params) => params[3] === 101);
  assert.ok(incomeInsert, 'baris 101 harus ter-insert');
  assert.equal(incomeInsert[1], 'INCOME', 'kategori income harus masuk sebagai entry_type INCOME');
  assert.equal(incomeInsert[2], 'cash_sync', 'source_type harus cash_sync');
  assert.equal(incomeInsert[4], 'CDS', 'site_code harus mengikuti pemetaan Data Kas');
  assert.equal(incomeInsert[7], 5000000, 'nominal harus sama persis dengan Data Kas');

  const expenseInsert = conn.inserts.find((params) => params[3] === 102);
  assert.ok(expenseInsert, 'baris 102 harus ter-insert');
  assert.equal(expenseInsert[1], 'EXPENSE', 'kategori expense harus masuk sebagai entry_type EXPENSE');

  const raceInsert = conn.inserts.find((params) => params[3] === 106);
  assert.equal(raceInsert, undefined, 'baris yang ER_DUP_ENTRY tidak boleh tercatat sebagai berhasil di-insert');

  // countPendingCashData: menghitung dua angka terpisah — yang masih menunggu
  // approval (tidak bisa ditarik sampai di-approve), dan yang sudah APPROVED tapi
  // mappable & belum ditarik (persis yang akan benar-benar ditarik kalau Sync
  // ditekan sekarang — makanya baris unmapped/nominal-0 TIDAK dihitung di sini,
  // supaya guard sebelum kunci periode tidak macet permanen gara-gara baris yang
  // memang tidak akan pernah bisa disinkron).
  const pending = await countPendingCashData({ db: fakeDb(4), closingId: 42, start: '2026-08-01', end: '2026-08-31' });
  assert.equal(pending.pendingApproval, 4, 'jumlah PENDING_APPROVAL harus diteruskan apa adanya dari query');
  assert.equal(pending.unsyncedApproved, 3, 'hanya baris mappable & nominal>0 yang dihitung (101,102,106) — 103 & 104 dikecualikan');


  // v3.2 — REGRESI BUG: transaksi Data Kas yang sudah pernah disinkron lalu
  // dikoreksi (mis. pengeluaran salah lokasi KBG -> seharusnya KRW) harus ikut
  // terbarui saat Sync, bukan tetap memakai data lama.
  const base = { entry_type: 'EXPENSE', entry_cluster: null, entry_description: 'Beli ODP', excluded_at: null, notes: null, name: 'Beli ODP', category_type: 'expense' };
  const SYNCED = [
    // 201: dulu KBG, di Data Kas sudah dikoreksi ke KRW -> update lokasi
    { ...base, entry_id: 1, cash_transaction_id: 201, entry_site: 'KBG', entry_category: 'Material jaringan', entry_amount: '300000.00', entry_date: new Date(2026, 7, 3),
      src_id: 201, transaction_date: new Date(2026, 7, 3), amount: '300000.00', src_status: 'APPROVED', category_name: 'Material jaringan', site_code: 'KRW' },
    // 202: sama persis -> keep
    { ...base, entry_id: 2, cash_transaction_id: 202, entry_site: 'CDS', entry_cluster: 'CLM', entry_category: 'Sewa', entry_amount: '500000.00', entry_date: '2026-08-04',
      src_id: 202, transaction_date: '2026-08-04', amount: '500000.00', src_status: 'APPROVED', category_name: 'Sewa', site_code: 'CLM' },
    // 203: transaksi dihapus dari Data Kas -> delete
    { ...base, entry_id: 3, cash_transaction_id: 203, entry_site: 'KBG', entry_category: 'Bensin', entry_amount: '50000.00', entry_date: '2026-08-05', src_id: null },
    // 204: diedit di Data Kas -> PENDING_APPROVAL lagi -> keluar dari hitungan
    { ...base, entry_id: 4, cash_transaction_id: 204, entry_site: 'KBG', entry_category: 'Bensin', entry_amount: '70000.00', entry_date: '2026-08-06',
      src_id: 204, transaction_date: '2026-08-06', amount: '70000.00', src_status: 'PENDING_APPROVAL', category_name: 'Bensin', site_code: 'KBG' },
    // 205: kategori & nominal dikoreksi -> update
    { ...base, entry_id: 5, cash_transaction_id: 205, entry_site: 'KBG', entry_category: 'Lain-lain', entry_amount: '10000.00', entry_date: '2026-08-07',
      src_id: 205, transaction_date: '2026-08-07', amount: '15000.00', src_status: 'APPROVED', category_name: 'Konsumsi', site_code: 'KBG' },
    // 206: tanggal dipindah ke bulan lain -> delete dari periode ini
    { ...base, entry_id: 6, cash_transaction_id: 206, entry_site: 'KBG', entry_category: 'Sewa', entry_amount: '90000.00', entry_date: '2026-08-30',
      src_id: 206, transaction_date: '2026-09-02', amount: '90000.00', src_status: 'APPROVED', category_name: 'Sewa', site_code: 'KBG' },
    // 207: excluded manual & sedang PENDING -> tetap dibiarkan (tetap dikecualikan)
    { ...base, entry_id: 7, cash_transaction_id: 207, excluded_at: new Date(), entry_site: 'KBG', entry_category: 'Sewa', entry_amount: '1000.00', entry_date: '2026-08-08',
      src_id: 207, transaction_date: '2026-08-08', amount: '1000.00', src_status: 'PENDING_APPROVAL', category_name: 'Sewa', site_code: 'KBG' }
  ];
  const reconConn = {
    updates: [], deletes: [],
    async execute(sql, params = []) {
      if (sql.startsWith('SELECT ce.id')) return [SYNCED];
      if (sql.startsWith('SELECT ct.id')) return [[]];
      if (sql.startsWith('UPDATE closing_entries')) { this.updates.push(params); return [{}]; }
      if (sql.startsWith('DELETE FROM closing_entries')) { this.deletes.push(params[0]); return [{}]; }
      if (sql.startsWith('SELECT COUNT(*) n FROM cash_transactions')) return [[{ n: 1 }]];
      throw new Error(`Unexpected SQL in reconConn: ${sql}`);
    }
  };
  const plan = await planSyncedReconciliation({ db: reconConn, closingId: 42, start: '2026-08-01', end: '2026-08-31' });
  const byId = Object.fromEntries(plan.map((p) => [p.cashTransactionId, p]));
  assert.equal(byId[201].action, 'update'); assert.deepEqual(byId[201].changed, ['site', 'cluster']);
  assert.equal(byId[202].action, 'keep', 'baris yang sama persis tidak boleh diubah');
  assert.equal(byId[203].action, 'delete'); assert.equal(byId[204].action, 'delete');
  assert.equal(byId[205].action, 'update'); assert.equal(byId[206].action, 'delete');
  assert.equal(byId[207].action, 'keep', 'baris excluded yang sumbernya sedang direvisi tetap dikecualikan');

  const pendingRecon = await countPendingCashData({ db: reconConn, closingId: 42, start: '2026-08-01', end: '2026-08-31' });
  assert.equal(pendingRecon.staleSynced, 5); assert.equal(pendingRecon.needsSync, 5);

  const recon = await syncCashDataIntoClosing({ conn: reconConn, closingId: 42, start: '2026-08-01', end: '2026-08-31', userId: 7 });
  assert.equal(recon.updated, 2); assert.equal(recon.removed, 3); assert.equal(recon.inserted, 0);
  const upd201 = reconConn.updates.find((p) => p[7] === 1);
  assert.equal(upd201[1], 'CDS'); assert.equal(upd201[2], 'KRW', 'KBG -> KRW harus terbawa ke closing_entries');
  const upd205 = reconConn.updates.find((p) => p[7] === 5);
  assert.equal(upd205[3], 'Konsumsi'); assert.equal(upd205[4], 15000);
  assert.deepEqual(reconConn.deletes.sort(), [3, 4, 6]);

  console.log('Closing sync service validation OK: idempotent insert, unmapped/zero-amount skip, race-duplicate ignored, pending-count math, and reconciliation of already-synced rows (site/category/amount/date/delete/unapprove) match Data Kas.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
