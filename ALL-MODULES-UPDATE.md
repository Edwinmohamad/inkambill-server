# INKAMBILLING — paket modul terpadu

## Yang berubah

- **Closing:** tetap kalkulator manual sesuai keputusan sebelumnya (periode 1–31, closing tanggal 5/6; input pelanggan/pengeluaran/salary/cash/router manual, PDF per penerima).
- **Tema:** mode light memakai palet abu-abu netral lembut; kontras font dan field diperbaiki. Dashboard dirapatkan dan widget teknis NMS dipindahkan ke menu NMS.
- **MikroTik NMS:** telemetry traffic interface dan histori sesi PPPoE tersimpan setiap lima menit; tab Traffic & Uptime; auto-isolir idempotent; CRUD secret tetap tersedia; backup RSC/backup memakai endpoint RouterOS dan menyimpan metadata/hash lokal.
- **Inventory:** kategori dinamis, barcode, QR label, soft-delete, minimum-stock alert, dan setiap saldo awal/perubahan tercatat pada movement + audit.
- **Dashboard:** fokus ke PSB, pelanggan, billing, collection, cash di tim, dan tiket. Detail router/traffic ada di NMS.
- **Analytics:** proyeksi tiga bulan, alasan churn, tombol export PDF ber-watermark dan Excel.
- **n8n:** lima workflow JSON di `n8n/`; endpoint server-to-server menggunakan `N8N_API_TOKEN` dan idempotency event.

## Konfigurasi wajib

Salin nilai berikut ke `.env` produksi (jangan commit `.env`):

```env
N8N_API_TOKEN=token-random-minimal-32-karakter
NMS_BACKUP_DIR=storage/nms-backups
NMS_TRAFFIC_SAMPLE_MINUTES=5
```

Setelah server hidup, migrasi V38 dijalankan otomatis oleh `app.js`. Pastikan user container dapat menulis `storage/nms-backups` dan volume n8n memakai penyimpanan persisten untuk foto piket.

## Validasi lokal

```bash
npm run validate:final
```

Perintah ini memeriksa sintaks seluruh JavaScript, EJS/static contract lama, Closing calculator, responsive CSS, schema bootstrap, route token n8n, fitur telemetry/inventory/analytics, dan seluruh file JSON n8n.

Uji router MikroTik, cron, database migration, PDF render, dan WhatsApp harus dilakukan setelah paket dijalankan pada server dengan kredensial nyata; workspace ini tidak terhubung ke router/DB produksi.
