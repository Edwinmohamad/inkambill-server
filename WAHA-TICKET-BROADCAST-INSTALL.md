# Instalasi Broadcast Ticket WAHA

Paket ini menambahkan broadcast tiket baru ke semua karyawan teknis aktif dan aksi cepat melalui Reply WhatsApp.

1. Backup folder aplikasi INKAMBILLING di CasaOS.
2. Salin isi paket patch ini ke root aplikasi; izinkan file dengan nama sama ditimpa.
3. Di menu **Pengaturan -> Karyawan**, pastikan setiap teknisi penerima (Jon, Bopung, Agung) memiliki nomor WhatsApp yang benar, status aktif, dan posisi dengan kategori `technical`.
4. Import ulang `n8n/06-wa-ticket-bot.json` ke n8n, lalu isi kembali node **Config** dan dua credential Header Auth bila diperlukan. Aktifkan workflow setelah itu.
5. Pastikan `.env` memiliki `WA_TICKET_NOTIFY=true`, lalu restart aplikasi INKAMBILLING dan n8n.
6. Buat satu tiket percobaan dari web. Ketiga teknisi harus langsung menerima pesan pribadi dari WAHA.

## Aksi cepat teknisi

Teknisi membalas pesan notifikasi tiket, lalu cukup mengetik salah satu:

- `proses`
- `update sedang menuju lokasi`
- `pending menunggu material`
- `selesai internet normal`

Bot mengetahui tiket dari pesan yang dibalas. Perintah lama seperti `#update <kode> ...` dan `#close <kode> ...` tetap didukung.

## Catatan

- Broadcast berjalan segera setelah tiket tersimpan; tidak menunggu teknisi mengambil tiket atau memilih PIC.
- Semua penerima diambil dinamis dari data karyawan teknis aktif, sehingga tidak ada nomor WhatsApp yang ditanam di source code.
- Balasan tanpa awalan `#` hanya diterima jika benar-benar membalas notifikasi tiket, untuk mencegah chat biasa diproses sebagai update.
