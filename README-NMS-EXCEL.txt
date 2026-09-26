INKAMBILL / MikroTik NMS - PPP Mapping Excel + Smart Sync Fix
===============================================================

Patch ini sudah termasuk perbaikan mapping PPP sebelumnya + fitur Excel.

FILE YANG DIREVISI / DITAMBAH:
- routes/nms.js
- services/nms/smartSync.js
- services/nms/excelSync.js (baru)
- middleware/nmsExcelUpload.js (baru)
- public/js/nms-common.js
- public/js/nms-secrets.js
- views/nms/secrets.ejs

FITUR EXCEL:
1. Tombol Excel langsung di toolbar PPP Secrets.
2. Export tab aktif ke .xlsx.
3. Export semua mapping ke .xlsx.
4. Download template import dinamis + referensi secret dan pelanggan.
5. Import .xlsx maksimal 5.000 baris / 8 MB.
6. Preview wajib: Siap / Konflik / Error / Tidak berubah.
7. LINK pakai CUSTOMER_CODE, bukan nama pelanggan.
8. Konflik existing harus di-acknowledge sebelum overwrite/pindah mapping.
9. UNLINK eksplisit dengan konfirmasi.
10. LINK hasil Excel tercatat sebagai batch Smart Sync untuk audit/undo.

FORMAT SHEET MAPPING:
AKSI | SITE | ROUTER | PPPOE_USERNAME | CUSTOMER_CODE | CATATAN

AKSI:
- LINK   : hubungkan PPP secret ke CUSTOMER_CODE
- UNLINK : lepas link pelanggan dari PPP secret
- kosong : baris tidak diproses (berguna saat edit hasil Export)

INSTALL:
Replace file sesuai struktur folder project lalu restart aplikasi Node/container.
Tidak ada dependency npm baru; project sudah menggunakan exceljs 4.4.0.

VALIDASI:
- npm run validate : PASS
- scripts/test-pppoe-smart-sync.js : PASS
