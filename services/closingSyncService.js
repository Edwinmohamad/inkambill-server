const { money, normalizeSiteCluster } = require('./closingCalculator');

function toDateKey(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Satu-satunya aturan pemetaan baris Data Kas -> baris closing_entries. Dipakai
// baik saat INSERT baris baru maupun saat rekonsiliasi baris yang sudah pernah
// disinkron, supaya kedua jalur tidak mungkin menghasilkan angka berbeda.
function mapCashRowToEntry(row) {
  const site = normalizeSiteCluster(row.site_code, null);
  if (!site) return { skip: 'unmapped' };
  const amount = money(row.amount);
  if (amount <= 0) return { skip: 'zero' };
  return {
    entryType: row.category_type === 'income' ? 'INCOME' : 'EXPENSE',
    site: site.site,
    cluster: site.cluster,
    category: String(row.category_name || 'Lain-lain').trim().slice(0, 120) || 'Lain-lain',
    amount,
    entryDate: toDateKey(row.transaction_date),
    description: [row.name, row.notes].filter(Boolean).join(' · ').trim().slice(0, 255) || null
  };
}

// Transaksi Data Kas APPROVED dalam rentang periode yang belum pernah ditarik ke
// closing_entries periode ini (dicek lewat cash_transaction_id). closingId boleh
// null/undefined untuk periode yang belum punya baris closing_periods sama sekali
// (draft belum dibuat) — dalam kasus itu semua transaksi APPROVED di rentang
// tanggal dianggap belum pernah ditarik.
async function selectUnsyncedCashRows({ db, closingId, start, end }) {
  const params = [start, end];
  let excludeSql = '';
  if (closingId) {
    excludeSql = ' AND ct.id NOT IN (SELECT cash_transaction_id FROM closing_entries WHERE closing_id = ? AND cash_transaction_id IS NOT NULL)';
    params.push(closingId);
  }
  const [rows] = await db.execute(
    `SELECT ct.id, ct.transaction_date, ct.name, ct.amount, ct.notes, cc.type category_type, cc.name category_name, s.code site_code
     FROM cash_transactions ct
     JOIN cash_categories cc ON cc.id = ct.category_id
     LEFT JOIN sites s ON s.id = ct.site_id
     WHERE ct.transaction_date BETWEEN ? AND ?
       AND COALESCE(ct.approval_status,'APPROVED') = 'APPROVED'${excludeSql}
     ORDER BY ct.transaction_date, ct.id`,
    params
  );
  return rows;
}

// v3.2 — BUG FIX: dulu Sync hanya INSERT transaksi baru. Baris yang SUDAH pernah
// ditarik tidak pernah dicek ulang, jadi kalau transaksi di Data Kas dikoreksi
// (lokasi KBG -> KRW, kategori, nominal, tanggal, dihapus, atau dikembalikan ke
// PENDING_APPROVAL karena diedit) closing_entries tetap memakai data lama dan PDF
// Closing ikut salah. Fungsi ini membandingkan setiap baris cash_sync periode ini
// dengan kondisi Data Kas terkini dan menentukan aksinya:
//   - update : sumber masih APPROVED & valid, tapi ada field yang berbeda
//   - delete : sumber dihapus / tidak APPROVED lagi / pindah ke luar periode /
//              lokasi tidak terpetakan / nominal 0 -> tidak boleh ikut dihitung
//   - keep   : sudah sama persis
// Baris yang sengaja dikecualikan (excluded_at) tetap dikecualikan; isinya tetap
// diperbarui supaya kalau dipulihkan, datanya sudah yang terbaru. Baris excluded
// yang sumbernya belum APPROVED dibiarkan (tetap tidak dihitung) agar pilihan
// "kecualikan" tidak hilang hanya karena transaksinya sedang direvisi.
async function planSyncedReconciliation({ db, closingId, start, end }) {
  if (!closingId) return [];
  const [rows] = await db.execute(
    `SELECT ce.id entry_id, ce.cash_transaction_id, ce.entry_type, ce.site_code entry_site, ce.cluster_name entry_cluster,
            ce.category entry_category, ce.amount entry_amount, ce.entry_date, ce.description entry_description, ce.excluded_at,
            ct.id src_id, ct.transaction_date, ct.name, ct.amount, ct.notes, COALESCE(ct.approval_status,'APPROVED') src_status,
            cc.type category_type, cc.name category_name, s.code site_code
     FROM closing_entries ce
     LEFT JOIN cash_transactions ct ON ct.id = ce.cash_transaction_id
     LEFT JOIN cash_categories cc ON cc.id = ct.category_id
     LEFT JOIN sites s ON s.id = ct.site_id
     WHERE ce.closing_id = ? AND ce.source_type = 'cash_sync' AND ce.cash_transaction_id IS NOT NULL`,
    [closingId]
  );

  const plan = [];
  for (const row of rows) {
    const base = { entryId: row.entry_id, cashTransactionId: row.cash_transaction_id, excluded: Boolean(row.excluded_at) };
    if (!row.src_id) { plan.push({ ...base, action: 'delete', reason: 'deleted' }); continue; }
    if (String(row.src_status).toUpperCase() !== 'APPROVED') {
      plan.push({ ...base, action: base.excluded ? 'keep' : 'delete', reason: 'not_approved' });
      continue;
    }
    const srcDate = toDateKey(row.transaction_date);
    if (!srcDate || srcDate < start || srcDate > end) { plan.push({ ...base, action: 'delete', reason: 'out_of_period' }); continue; }
    const mapped = mapCashRowToEntry(row);
    if (mapped.skip) { plan.push({ ...base, action: 'delete', reason: mapped.skip }); continue; }

    const before = {
      entryType: row.entry_type,
      site: row.entry_site,
      cluster: row.entry_cluster || null,
      category: row.entry_category,
      amount: money(row.entry_amount),
      entryDate: toDateKey(row.entry_date),
      description: row.entry_description || null
    };
    const changed = Object.keys(before).filter((key) => String(before[key] ?? '') !== String(mapped[key] ?? ''));
    if (!changed.length) { plan.push({ ...base, action: 'keep', reason: 'same' }); continue; }
    plan.push({ ...base, action: 'update', reason: 'changed', changed, before, after: mapped });
  }
  return plan;
}

// Mode Otomatis — sinkron dua arah-satu sumber: Data Kas (APPROVED) adalah sumber
// kebenaran untuk semua baris cash_sync. Langkah:
//   1. Rekonsiliasi baris yang sudah pernah ditarik (update / hapus bila berubah).
//   2. Tarik transaksi APPROVED baru yang belum pernah ditarik.
// Idempoten: menekan Sync berkali-kali tanpa perubahan di Data Kas tidak mengubah
// apa pun. Baris cash_sync yang diedit manual di Closing akan dikembalikan sesuai
// Data Kas saat Sync — koreksi permanen harus dilakukan di Data Kas.
async function syncCashDataIntoClosing({ conn, closingId, start, end, userId }) {
  const plan = await planSyncedReconciliation({ db: conn, closingId, start, end });
  let updated = 0;
  let removed = 0;
  const changes = [];
  for (const item of plan) {
    if (item.action === 'update') {
      const a = item.after;
      await conn.execute(
        'UPDATE closing_entries SET entry_type=?,site_code=?,cluster_name=?,category=?,amount=?,entry_date=?,description=? WHERE id=?',
        [a.entryType, a.site, a.cluster, a.category, a.amount, a.entryDate, a.description, item.entryId]
      );
      updated += 1;
      changes.push({ action: 'update', cash_transaction_id: item.cashTransactionId, fields: item.changed, before: item.before, after: a });
    } else if (item.action === 'delete') {
      await conn.execute('DELETE FROM closing_entries WHERE id=?', [item.entryId]);
      removed += 1;
      changes.push({ action: 'delete', cash_transaction_id: item.cashTransactionId, reason: item.reason });
    }
  }

  const rows = await selectUnsyncedCashRows({ db: conn, closingId, start, end });
  let inserted = 0;
  let skippedUnmapped = 0;
  let skippedZero = 0;

  for (const row of rows) {
    const mapped = mapCashRowToEntry(row);
    if (mapped.skip === 'unmapped') { skippedUnmapped += 1; continue; }
    if (mapped.skip === 'zero') { skippedZero += 1; continue; }
    try {
      await conn.execute(
        `INSERT INTO closing_entries(closing_id,entry_type,source_type,cash_transaction_id,site_code,cluster_name,category,amount,entry_date,description,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [closingId, mapped.entryType, 'cash_sync', row.id, mapped.site, mapped.cluster, mapped.category, mapped.amount, mapped.entryDate, mapped.description, userId]
      );
      inserted += 1;
    } catch (err) {
      // Baris ini sudah pernah ditarik oleh proses lain di antara SELECT dan INSERT (race
      // condition) — unique key (closing_id, cash_transaction_id) yang menolaknya. Aman diabaikan.
      if (err && err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }

  return { inserted, updated, removed, skippedUnmapped, skippedZero, scanned: rows.length, changes };
}

// Dipakai oleh banner mode Otomatis dan guard sebelum kunci periode:
// - pendingApproval: transaksi Data Kas di rentang ini yang MASIH menunggu approval.
// - unsyncedApproved: transaksi APPROVED & mappable yang belum ditarik.
// - staleSynced: baris yang sudah ditarik tapi datanya sudah beda dengan Data Kas
//   (lokasi/kategori/nominal/tanggal berubah, dihapus, atau tidak APPROVED lagi).
// - needsSync: unsyncedApproved + staleSynced — kalau > 0, PDF/Closing belum
//   sama dengan Data Kas.
async function countPendingCashData({ db, closingId, start, end }) {
  const [[pendingRow]] = await db.execute(
    `SELECT COUNT(*) n FROM cash_transactions ct WHERE ct.transaction_date BETWEEN ? AND ? AND ct.approval_status = 'PENDING_APPROVAL'`,
    [start, end]
  );
  const unsyncedRows = await selectUnsyncedCashRows({ db, closingId, start, end });
  const unsyncedApproved = unsyncedRows.reduce((count, row) => (mapCashRowToEntry(row).skip ? count : count + 1), 0);
  const plan = await planSyncedReconciliation({ db, closingId, start, end });
  const staleSynced = plan.filter((item) => item.action !== 'keep').length;
  return { pendingApproval: Number(pendingRow?.n || 0), unsyncedApproved, staleSynced, needsSync: unsyncedApproved + staleSynced };
}

module.exports = { syncCashDataIntoClosing, countPendingCashData, selectUnsyncedCashRows, planSyncedReconciliation, mapCashRowToEntry, toDateKey };
