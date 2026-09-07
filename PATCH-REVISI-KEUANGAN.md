# Revisi Kontrol Keuangan INKAMBILLING

## Yang berubah

- Tanggal bayar pelanggan dipisahkan dari tanggal approval dan tanggal pembukuan.
- Saat approval tersedia pilihan: tanggal bayar (default), tanggal approval, atau tanggal manual.
- Transfer/QRIS wajib memiliki bukti sebelum dapat disetujui; cash tetap opsional.
- Bukti pembayaran otomatis dapat dilihat dari Data Kas.
- Approval dan perubahan Closing memiliki audit before/after permanen.
- Idempotency mencegah submit pembayaran/jurnal sumber yang sama tercatat dua kali.
- Closing dapat dikunci dan hanya Master Admin yang dapat membukanya kembali dengan alasan.
- Import Excel ditandai `excel_import` dan tidak dihitung sebagai PSB.
- PSB hanya pelanggan `new_install` pada bulan tanggal aktivasi.
- Loading menampilkan konteks operasi dan mencegah klik submit berulang.
- Backup tervalidasi dijalankan sebelum deploy, dengan retensi harian/bulanan dan SHA-256.

## Deploy

Commit dan push seluruh file patch ke branch `main`. GitHub Actions self-hosted runner akan:

1. Membuat backup database.
2. Menarik commit terbaru ke `/opt/inkambilling`.
3. Build dan restart container.
4. Memeriksa `/healthz` sampai aplikasi siap.

Migration V41 berjalan otomatis saat aplikasi startup. Setelah deploy, uji satu pembayaran transfer dummy: input tanggal bayar, lampirkan bukti, pilih tanggal buku saat approval, lalu pastikan tanggal dan bukti yang sama tampil di Data Kas.

## Catatan penting

Jika startup memperingatkan bahwa unique index jurnal belum dapat dibuat, berarti database lama sudah memiliki jurnal ganda. Aplikasi tetap memiliki guard idempotency, tetapi data lama harus diaudit sebelum unique index diaktifkan.
