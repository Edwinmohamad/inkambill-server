const { money, normalizeSiteCluster } = require('./closingCalculator');

function toDateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// Mode Otomatis — menarik transaksi Data Kas (cash_transactions) yang sudah
// APPROVED Master Admin ke dalam closing_entries periode terkait. Idempoten:
// transaksi yang sudah pernah ditarik (dilacak lewat cash_transaction_id) tidak
// akan ditarik dua kali walau tombol Sync ditekan berkali-kali. Baris hasil
// sync tetap boleh diedit manual seperti baris biasa; menghapusnya dari Closing
// tidak benar-benar DELETE (lihat routes/closing.js /entries/:id/delete) —
// ditandai excluded_at supaya cash_transaction_id-nya tetap "terpakai" dan tidak
// tertarik ulang secara membingungkan pada sync berikutnya.
async function syncCashDataIntoClosing({ conn, closingId, start, end, userId }) {
  const rows = await selectUnsyncedCashRows({ db: conn, closingId, start, end });

  let inserted = 0;
  let skippedUnmapped = 0;
  let skippedZero = 0;

  for (const row of rows) {
    const site = normalizeSiteCluster(row.site_code, null);
    if (!site) { skippedUnmapped += 1; continue; }
    const amount = money(row.amount);
    if (amount <= 0) { skippedZero += 1; continue; }
    const entryType = row.category_type === 'income' ? 'INCOME' : 'EXPENSE';
    const category = String(row.category_name || 'Lain-lain').trim().slice(0, 120) || 'Lain-lain';
    const description = [row.name, row.notes].filter(Boolean).join(' · ').trim().slice(0, 255) || null;
    const entryDate = toDateKey(row.transaction_date);
    try {
      await conn.execute(
        `INSERT INTO closing_entries(closing_id,entry_type,source_type,cash_transaction_id,site_code,cluster_name,category,amount,entry_date,description,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [closingId, entryType, 'cash_sync', row.id, site.site, site.cluster, category, amount, entryDate, description, userId]
      );
      inserted += 1;
    } catch (err) {
      // Baris ini sudah pernah ditarik oleh proses lain di antara SELECT dan INSERT (race
      // condition) — unique key (closing_id, cash_transaction_id) yang menolaknya. Aman diabaikan.
      if (err && err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }

  return { inserted, skippedUnmapped, skippedZero, scanned: rows.length };
}

// Dipakai oleh banner mode Otomatis dan guard sebelum kunci periode. Dua angka:
// - pendingApproval: transaksi Data Kas di rentang tanggal ini yang MASIH
//   menunggu approval Master Admin (tidak akan ikut ke Sync sampai di-approve).
// - unsyncedApproved: transaksi yang SUDAH APPROVED, mappable ke CDS/KBG, dan
//   akan benar-benar ditambahkan kalau tombol Sync ditekan sekarang (jumlah ini
//   sengaja tidak menghitung transaksi yang lokasinya tidak terpetakan, karena
//   itu tidak akan pernah tertarik oleh Sync berapa kali pun ditekan).
async function countPendingCashData({ db, closingId, start, end }) {
  const [[pendingRow]] = await db.execute(
    `SELECT COUNT(*) n FROM cash_transactions ct WHERE ct.transaction_date BETWEEN ? AND ? AND ct.approval_status = 'PENDING_APPROVAL'`,
    [start, end]
  );
  const unsyncedRows = await selectUnsyncedCashRows({ db, closingId, start, end });
  const unsyncedApproved = unsyncedRows.reduce((count, row) => {
    const site = normalizeSiteCluster(row.site_code, null);
    return site && money(row.amount) > 0 ? count + 1 : count;
  }, 0);
  return { pendingApproval: Number(pendingRow?.n || 0), unsyncedApproved };
}

module.exports = { syncCashDataIntoClosing, countPendingCashData };
