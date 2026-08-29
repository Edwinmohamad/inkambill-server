# INKAMNET Control Center FINAL v1.2.1.1

Staging build untuk PT INKAMNET NEXERA TECHNOLOGY.

## Fokus v1.2.1

- Branding mengikuti warna logo resmi INKAMNET: purple `#603AEA` + red `#FF433E`.
- Logo web menggunakan asset transparan HQ untuk sidebar, loader, mobile login, dan cover login.
- Cover login memiliki floating logo, signal ring, moving scan/data lines, dan status system animation.
- Dark Mode / Light Mode dengan preferensi tersimpan di browser.
- Dashboard mendukung filter **Semua Site / per Site**, bulan, dan tahun.
- Dashboard menambahkan grafik **Pelanggan & PSB per bulan**:
  - PSB bulanan (bar)
  - Total base aktivasi kumulatif (line)
  - PSB YTD
  - bulan PSB tertinggi
  - rata-rata PSB per bulan
- Dashboard tetap menampilkan billing trend, pembayaran, outstanding, router health, ticket, low stock, cash di tim, cashflow, dan distribusi POP.
- Global technology polish: live WIB clock, animated topbar scan, subtle signal stream, tech corner, page progress, card reveal, cursor spotlight, and command palette `Ctrl+K`.
- Semua fitur v1.1 tetap dipertahankan: XLSX pelanggan, server duty/piket, payment proof, cash reconciliation, network, ticketing, warehouse, billing, finance, reports, staff/settings.

## Menu

- Control Center: Dashboard
- Pelanggan: Pelanggan, Paket Internet
- Network: Site/POP, Router MikroTik, Cluster & ODP, MikroTik NMS
- Support: Ticketing, Jadwal Teknisi, Piket Server
- Gudang: Stock Barang, Pergerakan Stock, Pemakaian Material, Supplier
- Billing: Tagihan, Pembayaran, Faktur Custom, Diskon, Biaya Tambahan
- Keuangan: Rekonsiliasi, Arus Kas, Kategori Kas, Laporan
- System: Activity Log, Pengaturan

## Instalasi staging baru

```bash
cp .env.example .env
nano .env
chmod +x install.sh
./install.sh
```

Wajib ganti `SESSION_SECRET`, `ROUTER_CREDENTIAL_KEY`, password database, password admin, dan `APP_URL`.

## Upgrade dari staging v1.1

**Jangan ganti `.env` existing dan jangan hapus volume database.** Backup dulu, lalu replace source v1.1 dengan source v1.2.1 sambil mempertahankan `.env` dan folder `storage`.

Setelah source v1.2.1 aktif:

```bash
chmod +x upgrade-v1.2.1.sh
./upgrade-v1.2.1.sh
```

v1.2.1 tidak membutuhkan migration database baru. Script hanya melakukan validation + rebuild aplikasi.

Setelah rebuild:

```bash
curl -I http://127.0.0.1:3200/healthz
```

Lalu hard refresh browser: `Ctrl + F5`.

## Catatan grafik PSB

PSB dihitung dari `activation_date`; jika kosong sistem menggunakan tanggal `created_at`. Grafik mengikuti filter Site dan tahun yang dipilih. Total Base pada grafik adalah total aktivasi kumulatif, sedangkan KPI Pelanggan Aktif tetap menggunakan status pelanggan aktif saat ini.

## Keamanan & data

- Bukti transfer tersimpan di private storage dan membutuhkan login untuk dibuka.
- Pembayaran transfer staff menggunakan verifikasi admin.
- Cash yang diterima staff masuk `held_by_staff` sampai direkonsiliasi.
- POST form menggunakan CSRF token.
- Credential router tersimpan terenkripsi menggunakan `ROUTER_CREDENTIAL_KEY`.
- Production menolak secret/password placeholder.
- Backup mencakup database dan storage bukti pembayaran.

## Status validasi

Lihat `FINAL-VALIDATION.md`. Runtime Docker/MariaDB/Cloudflare/MikroTik tetap wajib dites di staging sebelum promosi ke live.


## v1.2.1 UI hotfix
- Asset URLs are versioned to prevent browser cache mixing releases.
- Loader has critical inline sizing, fades safely, then is removed from the DOM.
- HQ logo dimensions are hard-capped to prevent oversized splash rendering.
