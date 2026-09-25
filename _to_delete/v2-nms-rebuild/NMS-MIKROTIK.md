# MikroTik NMS

Modul `/network/monitor` membaca telemetry langsung dari RouterOS REST API untuk semua router aktif. Site tidak di-hardcode; CLM, KBG, KRW, dan site baru otomatis memperoleh fitur yang sama selama router terdaftar pada menu **Router MikroTik**.

## Data yang dibaca

- `/system/resource` untuk CPU, uptime, versi, board, dan memori.
- `/ppp/secret` dan `/ppp/active` untuk status subscriber.
- `/ppp/profile` untuk pilihan profile pada editor secret.
- `/interface` untuk status dan counter RX/TX. Browser menghitung rate dari selisih counter setiap polling 15 detik.

Status ditentukan sebagai berikut:

- **Isolir**: secret disabled atau nama profile mengandung `isolir`/`isolate`.
- **Online**: terdapat sesi pada `/ppp/active` dan secret tidak terisolir.
- **Offline**: secret aktif tetapi tidak mempunyai sesi PPP aktif.

## Integrasi billing

Secret dicocokkan dengan `customers.pppoe_username` pada router/site yang sama. Editor NMS dapat menghubungkan secret ke pelanggan; server akan memperbarui `router_id`, `pppoe_username`, dan status jaringan pelanggan. Outstanding invoice ditampilkan untuk membantu NOC membedakan gangguan teknis dan isolasi billing.

## Keamanan produksi

1. Gunakan endpoint HTTPS RouterOS dan sertifikat yang valid (`verify_tls` aktif).
2. Batasi alamat sumber yang boleh mengakses service `www-ssl` pada firewall MikroTik.
3. Buat user RouterOS khusus aplikasi dengan hak minimum yang masih mengizinkan read/write PPP dan read interface/resource.
4. Jangan gunakan user admin utama router.
5. Pastikan `ROUTER_CREDENTIAL_KEY` berbeda dari `SESSION_SECRET`, panjang, dan tersimpan hanya di environment server.
6. Operasi tambah/ubah secret hanya tersedia untuk role aplikasi `admin`, memakai CSRF protection, dan dicatat di audit log.
7. Password secret lama tidak pernah dikirim ke browser. Kolom password kosong saat edit berarti password tidak diubah.

Jika satu router tidak dapat dijangkau, snapshot router tersebut mengembalikan status `UNREACHABLE`; router/site lain tetap dimuat sehingga kegagalan satu site tidak mematikan seluruh dashboard.

## Rekonsiliasi subscriber

NMS memberi saran pasangan secret dan pelanggan berdasarkan username, Customer ID, nama, komentar, serta token angka yang sama. Saran selalu memerlukan konfirmasi admin; pencocokan otomatis tidak menulis database tanpa tindakan pengguna.

Secret non-billing dapat dikecualikan dari antrian rekonsiliasi dengan penanda pada nama profile atau komentar:

- `[ADMIN]` untuk akun administrator, NOC, monitoring, router, server, teknisi, atau staf.
- `[FREE]` untuk layanan gratis, internal, sponsor, atau owner.

Tombol hapus secret memutus sesi aktif, menghapus secret dari RouterOS, melepaskan `pppoe_username` pelanggan yang terkait, lalu menyimpan aktivitas ke audit log. Gunakan hanya setelah memastikan subscriber memang harus dihapus permanen.
