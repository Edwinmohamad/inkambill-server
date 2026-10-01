# InkamBilling v1.32.1 — Manual Auto-Journal Delete

Tujuan: memungkinkan Master Admin membersihkan jurnal Data Kas dobel/salah secara manual tanpa membatalkan invoice/payment.

Perubahan utama:
- Tombol `Hapus Paksa Jurnal Saja` dapat digunakan pada jurnal APPROVED, termasuk jurnal otomatis payment-linked.
- Jika jurnal `payment` / legacy `install_income` dihapus, payment sumber diberi suppression tombstone:
  - `cash_journal_suppressed_at`
  - `cash_journal_suppressed_by`
  - `cash_journal_suppressed_reason`
- `postCashTransaction()` menghormati tombstone tersebut sehingga jurnal yang sengaja dihapus tidak dibuat ulang otomatis.
- Payment dan invoice TIDAK dibatalkan oleh aksi ini.
- Hapus paksa massal menerapkan mekanisme suppression yang sama.
- Semua force-delete tetap dilarang pada periode Closing yang sudah LOCKED.
- Aksi tercatat di financial audit.

Kapan dipakai:
- Bersihkan duplicate legacy PSB, misalnya Pendapatan Pemasangan Baru + Setoran Cash Pelanggan untuk uang yang sama.
- Bersihkan jurnal otomatis yang diketahui salah tetapi payment/invoice harus tetap dipertahankan.

Jangan dipakai bila sebenarnya pembayaran pelanggan harus dibatalkan. Untuk itu gunakan `Batalkan Pembayaran` / reset invoice ke belum lunas.

Deploy:
1. Backup database dan source.
2. Replace source dengan ZIP ini / deploy melalui Git.
3. Rebuild container: `docker compose build && docker compose up -d`.
4. SchemaService saat startup menambah kolom suppression secara idempotent.
5. Cek `/healthz` dan Data Kas.

Validasi statis yang dijalankan:
- `node --check routes/finance.js`
- `node --check services/paymentVerificationService.js`
- `node --check services/schemaService.js`
- `node scripts/test-financial-integrity-static.js`
- `node scripts/test-manual-auto-journal-delete.js`
