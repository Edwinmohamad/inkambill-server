# Integrasi WAHA CasaOS ↔ WEB INKAMBILL Proxmox

WEB INKAMBILL dapat memakai WAHA yang berjalan pada CT berbeda. Konfigurasi aktif dilakukan dari **WA Gateway → Koneksi Server WAHA** oleh Master Admin; `.env` hanya menjadi fallback.

## Jaringan yang harus tersedia

1. Dari CT WEB, URL WAHA harus dapat dijangkau, misalnya `http://192.168.1.20:3000`.
2. Dari CT WAHA, callback WEB harus dapat dijangkau, misalnya `http://192.168.1.30:3000/api/waha/webhook`.
3. Buka firewall hanya di LAN/VLAN yang diperlukan. Jangan membuka WAHA ke internet tanpa API key dan reverse proxy yang aman.
4. `SESSION_SECRET` atau `ROUTER_CREDENTIAL_KEY` WEB harus terisi minimal 16 karakter karena API key dan token webhook disimpan terenkripsi.

Tes dari CT WEB:

```bash
curl -i -H "X-Api-Key: API_KEY_WAHA" http://IP-CT-CASAOS:PORT/api/server/status
```

Tes callback dari CT WAHA:

```bash
curl -i -X POST -H "Content-Type: application/json" \
  "http://IP-CT-WEB:PORT/api/waha/webhook?token=TOKEN_WEBHOOK" \
  -d '{}'
```

## Langkah di WEB INKAMBILL

1. Masuk sebagai Master Admin dan buka **WA Gateway**.
2. Isi URL WAHA, nama sesi (`default` bila belum membuat nama lain), API key, dan URL callback WEB.
3. Klik **Simpan & Tes Koneksi**. Status harus menjadi **Tes Berhasil**.
4. Klik **Hubungkan WA Gateway**. Jika sesi belum tertaut, scan QR dari WhatsApp → Perangkat Tertaut.
5. Gunakan bagian **Kirim Pesan WhatsApp** untuk tes nomor nyata.
6. Periksa **Log Pengiriman Terbaru**. Status berubah otomatis menjadi Antrean, Terkirim, atau Gagal. Pesan gagal dapat dikirim ulang dengan **Coba Lagi**.

## Catatan status

- **Antrean**: tersimpan aman di database dan menunggu sesi WAHA aktif.
- **Terkirim**: WAHA menerima permintaan kirim dan mengembalikan respons sukses.
- **Gagal**: WAHA/network menolak pengiriman; alasan teknis ditampilkan pada log.

Pesan dari menu Tagihan, blast pelanggan, auto-reminder, tanda terima pembayaran, dan alert jaringan memakai antrean serta log yang sama.
