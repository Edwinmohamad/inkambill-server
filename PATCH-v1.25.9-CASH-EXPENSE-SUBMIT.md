# Patch v1.25.9 — Pengeluaran tidak tersimpan / tidak muncul di Approval

## Perubahan

- Form Data Kas sekarang memeriksa tanggal, nominal, nama transaksi, dan kategori saat tombol Simpan ditekan.
- Jika Nominal kosong atau tidak valid, modal menampilkan pesan merah dan fokus kembali ke kolom yang harus diperbaiki.
- Endpoint `POST /cash` menormalisasi tanggal transaksi sebelum insert.
- `source_type='manual'` dan `approval_status='PENDING_APPROVAL'` dikirim sebagai nilai database eksplisit, bukan mengandalkan default kolom.
- Setelah insert, transaksi dibaca kembali dan diverifikasi sebelum commit. Jika ID/status tidak sesuai, transaksi dibatalkan agar tidak ada data setengah tersimpan.
- Antrean Approval menggunakan status pending yang konsisten, termasuk data manual lama yang statusnya NULL.

## Cara uji setelah deploy

1. Buka Data Kas → Data Kas, pilih Pengeluaran.
2. Isi Tanggal, Nominal, Nama Transaksi, Kategori, dan Site bila perlu. Bukti boleh dikosongkan.
3. Klik Simpan Pengeluaran. Harus muncul pesan berhasil dan baris berstatus `Pending Approval`.
4. Buka Pembayaran → Approval & Transaksi. Baris pengeluaran harus terlihat di bagian Approval Kas Manual.
5. Jika Nominal dikosongkan, submit tidak diteruskan dan modal menampilkan `Nominal pengeluaran wajib diisi dan harus lebih dari 0.`.

Catatan: ringkasan saldo tetap hanya menghitung transaksi `APPROVED`; transaksi baru memang belum menambah saldo sampai disetujui Master Admin.
