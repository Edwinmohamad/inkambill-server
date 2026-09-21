# NOC Terpadu — Dashboard Monitoring Minimalis

Sebelumnya ada dua dashboard jaringan yang tumpang tindih (`/noc` dan `/monitoring`) plus 8 menu terpisah di sidebar. Update ini menyatukan semuanya jadi **satu pintu masuk** (`/noc`) untuk ringkasan, dan `/monitoring` khusus jadi konsol aksi per-perangkat.

## Struktur baru

- **`/noc` (NOC Terpadu)** — satu-satunya dashboard ringkasan, sekarang dibagi jadi dua blok jelas sesuai jenis perangkat:
  - **ONT Pelanggan** — ONT Online, Redaman Kritis, Pelanggan Online (dari GenieACS).
  - **Perangkat Jaringan** — Router Online, **OLT / ONU Online** (baru — sebelumnya OLT tidak muncul sama sekali di ringkasan NOC), dan Tiket Aktif. Ada tombol cepat **Tambah Router** dan **Tambah OLT** langsung di blok ini.
  - Di bawahnya tetap ada tabel **Kesehatan Per Site** dan **Alarm Prioritas** seperti sebelumnya.
- **`/monitoring` (Kelola Perangkat)** — sekarang berperan sebagai konsol detail & aksi (ping, reboot, ganti SSID/password ONT, test koneksi router, drill-down per site/OLT), diakses dari tombol "Kelola Perangkat" di NOC. Grafik tren 24 Jam/7 Hari/30 Hari yang jarang dipakai sudah **dihapus total** (endpoint, query, dan UI-nya), termasuk query historis yang membebani database tiap load. Semua endpoint status & aksi realtime (bukan tren) tetap utuh.
- **Sidebar** — di menu Jaringan, `NOC Terpadu` dan `Map & ONT` sekarang jadi link langsung (satu klik), sementara Router, Registry OLT, Site/POP, Cluster & ODP, dan Kelola Perangkat dikumpulkan dalam grup collapsible **"Detail & Pengaturan"**.

## Integrasi OLT / Mikrotik baru

Tidak ada perubahan kode yang diperlukan untuk menambah OLT atau router Mikrotik baru — keduanya murni data (`olt_devices`, `routers`) yang dibaca dinamis oleh semua service monitoring (`WHERE is_active=1`). Tombol **Tambah Router** / **Tambah OLT** di blok "Perangkat Jaringan" langsung mengarah ke form pendaftarannya (`/routers`, `/olt`); begitu tersimpan, otomatis muncul di semua ringkasan NOC dan Kelola Perangkat tanpa perlu deploy ulang.

## Dibersihkan

- `routes/mikrotik.js` dan `views/mikrotik/index.ejs` — kode lama yang sudah tidak pernah di-mount di `app.js` (mati total, dicek dulu tidak ada referensi lain di seluruh repo). Dipindah ke folder `_to_delete/` di root project karena sesi ini tidak diberi izin hapus file langsung — tinggal dihapus manual lewat File Explorer / GitHub Desktop kalau sudah yakin.

## Catatan validasi

`npm run validate:v119`, `npm run validate:final`, dan seluruh `scripts/test-*.js` (termasuk `test-powerful-network-suite.js` dan `test-debt-monitor.js`) sekarang lolos semua.

Dua kegagalan yang sempat ditemukan saat kerja NOC ini sudah ada **sebelum** update ini dan tidak terkait file yang disentuh — keduanya guard test yang assertion-nya ketinggalan zaman (kodenya sendiri sudah benar), sudah diperbaiki menyusul:
- `test-powerful-network-suite.js` — assertion allowlist aksi ACS masih memeriksa 2 aksi lama (`refreshObject`, `reboot`), padahal kode sudah lama menambah aksi ketiga (`setParameterValues`). Assertion disesuaikan ke kode aktual.
- `test-debt-monitor.js` — tiga assertion (jadwal cicilan otomatis, layout profesional, filter otomatis & reset) memeriksa nama class/teks lama dari sebelum redesign modul Hutang & Piutang (mis. `debt-page-v2` → sekarang `debt-page`). Assertion disesuaikan ke markup aktual, dan satu class (`debt-filter-reset`) yang memang seharusnya ada tapi hilang di tombol reset filter ditambahkan kembali ke `views/debts/index.ejs`.

## Live auto-refresh & status kritis lebih mencolok (v2)

`/noc` sekarang benar-benar "hidup" seperti layar NOC, bukan cuma render sekali saat halaman dibuka:

- **Auto-refresh tiap 20 detik** — KPI, tabel Kesehatan Per Site, dan Alarm Prioritas ter-update sendiri lewat polling ke `GET /noc/api/dashboard` (endpoint baru, query-nya sama persis dengan yang dipakai render awal, di-cache 8 detik di server supaya beberapa layar NOC yang terbuka bersamaan tidak membebani database). Ada indikator kecil di health-strip ("live" / "diperbarui Xd lalu" / "gagal memuat ulang") biar jelas datanya masih hidup.
- **Status kritis lebih mencolok** — dot hijau di health-strip sekarang benar-benar berdenyut (sebelumnya statis), kartu KPI yang berstatus danger dan baris Alarm Prioritas yang danger punya animasi pulse merah supaya langsung kelihatan dari jauh, dan angka besar di kartu KPI diperbesar sedikit untuk keterbacaan wallboard. Animasi otomatis nonaktif kalau OS pengguna diset `prefers-reduced-motion`.
- File baru: `public/js/noc.js` (polling + render ulang KPI/tabel/alarm client-side, pola sama seperti `public/js/monitoring.js`).
