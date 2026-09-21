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

`npm run validate:v119`, `test-acs-monitoring.js`, dan `test-powerful-network-suite.js` (khusus bagian yang menyentuh NOC/sidebar/monitoring) semua lolos. Dua kegagalan yang ditemukan (`test-powerful-network-suite.js` bagian allowlist aksi ACS, dan `test-debt-monitor.js`) sudah ada **sebelum** perubahan ini — tidak terkait file yang disentuh di update ini, jadi sengaja tidak diutak-atik di sini.
