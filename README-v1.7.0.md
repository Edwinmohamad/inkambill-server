# INKAMNET Control Center v1.7.0

Release fokus pada billing safety, output PDF, paket per-site, dashboard operasional, kontak WhatsApp, dan precision UI.

## Perubahan utama

- Action dropdown Tagihan dirapikan dan diposisikan ke viewport agar tidak terpotong oleh tabel responsive.
- Generator PDF laporan/faktur didesain ulang: branded header, summary cards, table pagination, repeated header, zebra rows, page numbering, dan landscape otomatis untuk tabel lebar.
- Paket Internet sekarang dapat dimiliki Site/POP tertentu. Paket lama tetap dibaca sebagai `GLOBAL` (`site_id = NULL`) agar data existing tidak putus.
- Form pelanggan hanya menampilkan paket yang cocok dengan Site pelanggan; validasi server mencegah paket site yang salah.
- Nomor WhatsApp pada daftar Pelanggan menjadi link langsung ke `wa.me`.
- Dashboard disederhanakan menjadi summary penting: pelanggan aktif, pembayaran, outstanding, collection rate, PSB, ticket aktif, router health, overdue, trend billing, prioritas hari ini, dan tagihan terbaru.
- Animasi global diperhalus: reveal viewport, ambient pulse/grid, command dashboard orbit/radar, button shimmer; otomatis dikurangi jika browser memakai `prefers-reduced-motion`.
- Generate Tagihan menjadi mode Refresh/Generate per bulan/tahun/site/pelanggan dan idempotent.
- Invoice existing tidak pernah di-reset. Invoice LUNAS tetap LUNAS ketika Refresh/Generate dijalankan kembali.
- Advisory DB lock + unique customer-period menjadi proteksi tambahan terhadap generate paralel/duplicate.
- Pelanggan dengan activation_date setelah akhir periode yang dipilih tidak dibuatkan tagihan periode lama.

## Database

Startup otomatis menambahkan:

```sql
packages.site_id BIGINT UNSIGNED NULL
INDEX idx_packages_site(site_id)
```

Tidak ada reset database. Paket existing akan tetap `GLOBAL` sampai dipetakan ke site secara manual.

## Catatan migrasi paket lama

Jika satu paket legacy masih dipakai pelanggan di lebih dari satu site, aplikasi tidak mengizinkan paket itu langsung dipindah ke satu site. Buat paket baru per site terlebih dahulu lalu pindahkan pelanggan secara bertahap.

## Validasi release

- JavaScript syntax validation
- Static EJS/modal/form validation
- JSON/YAML validation
- Shell syntax validation
- Invoice idempotency mock test (invoice paid preserved, hanya customer baru dibuat)
- PDF generator flow test menggunakan mock PDFKit API

> Validasi static/unit tidak menggantikan smoke-test terhadap database production. Sesudah deploy, cek Login → Dashboard → Paket Internet → Pelanggan → Tagihan → PDF → Reports.
