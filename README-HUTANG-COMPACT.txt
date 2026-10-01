INKAMBILL — HUTANG COMPACT FINAL PATCH
========================================

Fitur:
- Nomor urut otomatis
- Search box
- Filter Status
- Filter Site (jika kolom Site/Lokasi ada)
- Filter jatuh tempo
- Quick filter chips
- Summary bar padat
- Sticky table header
- Sorting header
- Drawer detail
- Keyboard "/" untuk search dan Esc untuk tutup drawer
- Action Edit/Hapus/Bayar yang SUDAH ADA tetap dipakai dan dirapikan
- UI compact, anti-card berlebihan

PENTING
-------
Patch ini sengaja tidak menebak endpoint CRUD baru.
Kalau backend Hutang saat ini sudah punya Edit/Hapus/Bayar, tombol tersebut otomatis
tetap berfungsi dan ditampilkan secara compact.

Kalau backend belum punya endpoint Edit/Hapus/Bayar, installer TIDAK membuat endpoint
sembarangan karena nama tabel/kolom harus mengikuti schema repo yang aktual.

CARA PAKAI
----------
1. Extract ZIP ke root repo inkambill-server.
2. Jalankan:
   node scripts/apply-hutang-compact-final.js

3. Validasi:
   node --check public/js/hutang-compact.js

   Bila tersedia:
   npm run validate:final

4. Test menu Hutang:
   - search
   - filter status
   - filter site
   - filter JT
   - nomor urut
   - sort tabel
   - buka detail row
   - Edit/Hapus/Bayar existing action

5. GitHub Desktop:
   Review changes -> Commit -> Push

SAFETY
------
Installer membuat .bak timestamp untuk view Hutang sebelum mengubah file.
Jika kandidat view ambigu, installer berhenti dan tidak memaksa patch.
