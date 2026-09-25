PATCH HISTORI REKONSILIASI

Replace file:
routes/payments.js

Perbaikan:
- Tidak lagi menjalankan ensureV53Schema() penuh ketika tab Histori dibuka.
- Schema settlement minimum dibuat/dicek secara kompatibel MySQL/MariaDB.
- Index settlement dicek dengan SHOW INDEX sebelum ALTER TABLE.
- Kolom settlement_id, settled_by, settled_at dibuat hanya jika belum ada.
- Query grafik Histori dibuat non-fatal; jika chart gagal, tabel Histori tetap terbuka.

Setelah replace, restart aplikasi Node.js/container.
