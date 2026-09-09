# INKAMNET Control Center v1.25.7 — Data Kas Save Visibility Fix

## Masalah
User dapat menekan **Simpan Data Kas** tetapi perubahan tidak terlihat pada ringkasan Pendapatan/Pengeluaran/Saldo karena transaksi manual baru dibuat dengan status `PENDING_APPROVAL`. Ringkasan memang hanya menghitung transaksi `APPROVED`, sehingga UX terlihat seolah data tidak tersimpan.

## Perbaikan
- POST `/cash` sekarang memverifikasi row baru di database **sebelum commit**.
- Jika database tidak mengembalikan ID transaksi atau verifikasi row gagal, transaction di-rollback dan error eksplisit ditampilkan.
- Redirect setelah save membawa `created=<id>`.
- Row yang baru dibuat ditandai/highlight pada tabel Data Kas.
- Banner konfirmasi menampilkan kode, nama transaksi, nominal, dan status PENDING APPROVAL.
- Ditambahkan summary card **Menunggu Approval** berisi jumlah transaksi dan total nominal pending.
- Default tanggal input menggunakan tanggal hari ini jika periode filter adalah bulan berjalan.
- Ringkasan Pendapatan/Pengeluaran/Saldo tetap hanya menghitung APPROVED agar akuntansi tidak berubah sebelum approval.

## Validasi
- `npm run check` PASS
- `node scripts/validate-static.js` PASS
- `node scripts/test-v1256-cash-payment-ui.js` PASS
