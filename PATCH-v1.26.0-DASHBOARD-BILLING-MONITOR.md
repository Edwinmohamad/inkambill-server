# INKAMNET Control Center v1.26.0 — Dashboard Billing Collection Monitor

Tanggal: 30 September 2026

## Tujuan

Menambahkan monitor billing harian yang ringkas, Apple-style, dan memakai data existing InkamBill sebagai satu sumber kebenaran. Tidak ada menu utama baru: monitoring berada di Dashboard, sedangkan detail tetap dibuka melalui Tagihan, Approval Pembayaran, dan Data Kas.

## Aturan bisnis yang dipakai

1. Tagihan dibagi menjadi siklus jatuh tempo **15** dan **30** mengikuti aturan `due_bucket` aplikasi existing (`DAY(due_date) <= 22` = siklus 15, selebihnya = siklus 30).
2. Pembayaran **pending** tidak dihitung sebagai pendapatan dan belum dihitung sebagai pelanggan lunas.
3. Pembayaran transfer/QRIS baru menjadi **pendapatan harian** setelah `payments.status='confirmed'`, memiliki `verified_at`, dan jurnal `cash_transactions` source `payment` sudah berstatus APPROVED.
4. Pembayaran cash yang sudah di-approve tetapi masih dipegang admin/teknisi **belum** menjadi pendapatan kas. Cash baru masuk grafik pendapatan setelah setoran dikonfirmasi (`settled_at`) dan jurnal Data Kas sudah ada.
5. Progress pelanggan = invoice lunas / total invoice valid pada siklus.
6. Progress nominal = `paid_amount / total` invoice valid pada siklus.
7. Pola pembayaran dihitung dari tanggal pelanggan benar-benar membayar (`paid_at`) terhadap `due_date`: lebih awal, tepat waktu, H+1—H+3, dan lewat H+3.

## UI Dashboard baru

### Filter global
- Site: Semua / KRW / KBG / CLM / site existing lainnya.
- Bulan.
- Tahun.
- Siklus: 15 + 30 / 15 / 30.
- Tren: 3 / 6 / 12 bulan.
- Filter utama dipertahankan saat filter PSB/KPI/status pelanggan digunakan agar state tidak reset.

### Pendapatan Hari Ini
- Total uang yang benar-benar sudah masuk Data Kas.
- Jumlah pembayaran.
- Breakdown Transfer / QRIS / Cash Disetor.
- Perbandingan dengan kemarin.
- Pending approval periode terpilih ditampilkan terpisah.

### Collection Siklus 15 & 30
Masing-masing menampilkan:
- Persentase pelanggan lunas.
- Lunas / total pelanggan berinvoice.
- Progress bar.
- Nominal tertagih vs total tagihan.
- Persentase collection nominal.
- Jumlah pending approval.
- Jumlah belum bayar + outstanding.
- Perbandingan progress dengan bulan sebelumnya.

### Grafik Progress Collection
- Mode **Harian**: progress kumulatif selama bulan tagihan sampai H+3.
- Mode **Tren**: perbandingan 3/6/12 bulan.
- Toggle **Pelanggan / Nominal**.
- Siklus 15 dan 30 dapat dipantau dalam satu chart.
- Marker garis jatuh tempo 15 dan 30.
- Grafik tidak menggambar tanggal masa depan pada window H+1—H+3.

### Grafik Pendapatan Harian
- Bar chart kas masuk per hari pada bulan terpilih.
- Data mengikuti aturan pengakuan kas sebenarnya, bukan tanggal admin menginput draft/pending.

### Pola Pembayaran
- Lebih awal.
- Tepat waktu.
- H+1—H+3.
- Lewat H+3.

### Masuk Kas Terbaru
- Nama pelanggan.
- Site.
- Siklus.
- Metode pembayaran.
- Nominal (role yang berhak melihat finance).
- Jam masuk kas.

### Drill-down Belum Bayar
Klik `Belum Bayar` pada card siklus membuka modal cepat tanpa meninggalkan Dashboard:
- pencarian nama / customer ID / site / cluster;
- daftar pending approval dipisahkan dari belum bayar;
- badge H-/Hari H/H+;
- nominal outstanding untuk role finance/admin;
- link ke detail Tagihan dengan filter periode + siklus yang sama.

## Proteksi konsistensi data

- Pendapatan tidak dihitung dari sekadar `status='paid'` atau tanggal input admin.
- Harus ada pembayaran confirmed **dan** jurnal Data Kas source payment yang approved.
- Cash yang masih `held_by_staff` tidak masuk pendapatan.
- Schema `settled_by` dan `settled_at` sekarang dijamin pada startup schema, bukan hanya dibuat lazy saat halaman rekonsiliasi dibuka.
- Tidak ada tabel statistik baru; Dashboard membaca invoice/payment/cash existing sehingga tidak ada data summary yang harus disinkron manual.

## File baru

- `services/dashboardBillingMonitorService.js`
- `scripts/test-dashboard-billing-monitor.js`
- `PATCH-v1.26.0-DASHBOARD-BILLING-MONITOR.md`

## File diperbarui

- `routes/dashboard.js`
- `views/dashboard/index.ejs`
- `public/css/app.css`
- `services/schemaService.js`
- `views/partials/layout.ejs`
- `scripts/validate-v119.js`
- `package.json`
- `package-lock.json`

## Validasi yang sudah dijalankan

Semua PASS:

- `npm run validate:final`
- `npm run test:dashboard-billing`
- `npm run test:pppoe-smart-sync`
- `npm run test:network-suite`
- `npm run test:fasum`
- EJS tag balance + server-side EJS JavaScript syntax check.
- Browser JavaScript syntax check untuk script Dashboard.

Suite `validate:final` termasuk static validation, seluruh JS syntax check, cash approval, closing calculator/sync, responsive CSS, Android/mobile API, debt monitor, payment-method correction, invoice refresh, cash naming/expense submit, ACS, dan regression khusus Dashboard Billing.

## Catatan deployment

Patch tidak menghapus data dan tidak membuat tabel summary baru. Startup schema akan menambahkan kolom settlement yang belum ada dengan `ADD COLUMN IF NOT EXISTS`.

Tetap lakukan backup database dan `/opt/inkambilling` sebelum deploy produksi.
