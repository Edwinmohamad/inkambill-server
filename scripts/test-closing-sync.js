const assert = require('assert');
const { syncCashDataIntoClosing, countPendingCashData } = require('../services/closingSyncService');

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

  console.log('Closing sync service validation OK: idempotent insert, unmapped/zero-amount skip, race-duplicate ignored, and pending-count math match what Sync would actually pull.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
