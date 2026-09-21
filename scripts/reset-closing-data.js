// Reset total data Closing (mode Manual/Otomatis, v2).
//
// Menghapus SEMUA baris di closing_periods, closing_entries, dan
// closing_adjustments — termasuk periode yang sudah LOCKED (riwayat lama).
// closing_router_assets (daftar INVEST ROUTER) TIDAK ikut dihapus karena itu
// daftar aset, bukan data transaksi per periode.
//
// Aman dijalankan berkali-kali: selalu bikin backup JSON dulu ke
// storage/closing-reset-backups/ sebelum menghapus apa pun, dan defaultnya
// cuma DRY RUN (menampilkan apa yang akan dihapus + menulis backup) supaya
// tidak kepencet tidak sengaja.
//
// Pemakaian:
//   node scripts/reset-closing-data.js            -> dry run + backup saja
//   node scripts/reset-closing-data.js --yes       -> backup lalu benar-benar hapus
//
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

async function main() {
  const confirm = process.argv.includes('--yes');
  const backupDir = path.join(__dirname, '..', 'storage', 'closing-reset-backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const [periods] = await db.query('SELECT * FROM closing_periods ORDER BY period_start');
  const [entries] = await db.query('SELECT * FROM closing_entries ORDER BY id');
  const [adjustments] = await db.query('SELECT * FROM closing_adjustments ORDER BY id');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `closing-reset-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ generatedAt: new Date().toISOString(), periods, entries, adjustments }, null, 2));

  console.log(`Backup ditulis ke: ${backupFile}`);
  console.log(`Ditemukan: ${periods.length} closing_periods, ${entries.length} closing_entries, ${adjustments.length} closing_adjustments.`);

  if (!confirm) {
    console.log('\nDRY RUN — belum ada yang dihapus. Jalankan ulang dengan flag --yes untuk benar-benar menghapus semuanya:');
    console.log('  node scripts/reset-closing-data.js --yes\n');
    await db.end();
    return;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM closing_entries');
    await conn.query('DELETE FROM closing_adjustments');
    await conn.query('DELETE FROM closing_periods');
    await conn.query('ALTER TABLE closing_entries AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE closing_adjustments AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE closing_periods AUTO_INCREMENT = 1');
    await conn.commit();
    console.log('Selesai — semua data Closing (periode, baris input, penyesuaian) sudah dihapus. Backup tetap tersimpan di file di atas kalau perlu dipulihkan.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await db.end();
  }
}

main().catch((err) => {
  console.error('Reset gagal:', err);
  process.exitCode = 1;
});
