INKAMBILL — DASHBOARD CLICKABLE FINAL
====================================

Patch ini dibuat berdasarkan struktur repo main saat ini.

Yang dibuat clickable:
- KPI dashboard atas: sudah existing sebagai <a>, dipertahankan.
- Billing Control:
  * Tertagih -> daftar tagihan periode/site aktif
  * Terkumpul -> daftar pembayaran periode/site aktif
  * Follow Up -> quick-filter tabel Billing Control tanpa reload
  * Wajib Isolir -> quick-filter tabel tanpa reload
  * Outstanding -> invoice open periode/site aktif
  * Alert Wajib Isolir -> quick-filter yang sama
- Collection Target -> buka Collection Analysis
- Site cards: sudah clickable, dipertahankan.
- Action Center: sudah clickable, dipertahankan.
- Charts:
  * Billing bulanan -> sudah drill-down per bulan
  * KPI Tagihan -> sudah drill-down per status
  * Site chart -> sudah drill-down site/status
  * PSB chart -> sudah clickable
  Semua logic existing dipertahankan.

UX:
- hover / focus state
- selected state untuk quick-filter
- Enter / Space untuk accessibility
- Ctrl/Cmd + click pada card navigasi membuka tab baru
- klik card Follow Up/Wajib Isolir lagi => reset via filter Semua
- smooth scroll ke tabel Billing Control

CARA INSTALL
------------
Extract ZIP ke root repo lalu:
  node scripts/apply-dashboard-clickable-final.js

Validasi:
  node --check public/js/dashboard-clickable-final.js
  npm run check
  npm run validate:final

Installer membuat backup timestamp dan berhenti aman jika anchor repo berubah.
