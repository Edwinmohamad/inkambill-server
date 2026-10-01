INKAMBILL CONTROL CENTER FINAL PATCH
===================================

Target struktur: repository main yang diperiksa pada 1 Oct 2026.

ISI PATCH
---------
1. Role-based Workspace di homepage
   - Owner
   - Admin Billing / Finance
   - NOC
   - Teknisi
   Aksi yang tampil tetap difilter berdasarkan permission user.

2. Notification Center ditingkatkan
   - pembayaran pending (existing)
   - pelanggan overdue (existing)
   - pelanggan isolir (existing)
   - tiket aktif (existing)
   - router down
   - WA gagal 24 jam
   - hutang/piutang mendekati / lewat JT
   - selisih rekonsiliasi
   - pembayaran besar hari ini
   Query tambahan fail-safe: bila sumber opsional belum ada, header tidak crash.

3. Bulk Actions
   Patch TIDAK membuat jalur bulk duplikat.
   Ia mempertahankan dan memanfaatkan bulk action existing:
   - Customers: WA Reminder, ubah paket, arsip/hapus
   - NMS PPP: isolir, buka isolir, kick, profile, jadwal, fasum
   - Rekonsiliasi: konfirmasi setoran massal
   Ini sengaja agar backend tidak memiliki dua implementasi untuk aksi yang sama.

4. Reconciliation Intelligence
   - Matched
   - Unmatched
   - Duplicate payment
   - Nominal tidak sesuai
   - Payment tanpa invoice
   - suggestion links untuk kasus yang perlu dicek

5. Customer Risk Indicator
   - Normal
   - Pantau
   - Prioritas
   Berdasarkan data operasional: overdue, umur tunggakan, isolir,
   WhatsApp invalid, dan tiket aktif.
   Ini bukan label permanen dan bukan keputusan otomatis.

6. Audit & Undo
   Patch mempertahankan mekanisme existing yang lebih aman:
   - Customer -> archive/restore (soft delete)
   - NMS -> undo aksi 5 detik
   - Rekonsiliasi -> cancel settlement dengan alasan
   - audit_logs existing tetap dipakai
   Tidak ditambahkan "undo palsu" untuk transaksi finansial yang tidak aman dibalik.

7. PPP Secrets KPI Cards Clickable
   Online / Offline / Diisolir / Ter-link / Fasum / Exempt
   bisa diklik atau Enter/Space untuk mengaktifkan filter existing.

INSTALL
-------
Extract ZIP ke ROOT repository inkambill-server, lalu:

node scripts/apply-control-center-final.js

Kemudian:
npm run check
node --check services/workspaceService.js
node --check services/reconciliationIntelligenceService.js
node --check public/js/control-center-final.js
npm run validate:final

Jika satu anchor source tidak cocok, installer berhenti sebelum menulis perubahan.
File existing yang berubah dibuatkan backup timestamp.

GITHUB DESKTOP
--------------
Review Changes -> Commit -> Push.
Disarankan commit:
feat: role workspace, notification intelligence, risk and reconciliation control center
