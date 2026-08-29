# INKAMNET Control Center v1.6.1

Hotfix setelah v1.6.0:

- Memperbaiki error halaman Tagihan akibat nilai query-string dipanggil sebagai fungsi di template EJS.
- Kategori Kas sekarang dibuat manual dari UI dan kategori non-sistem dapat dihapus bila belum dipakai transaksi.
- Seed kategori pengeluaran otomatis dihentikan pada startup berikutnya.
- Kategori `Pendapatan Billing` dan `Setoran Cash Pelanggan` tetap dilindungi karena dipakai otomatis oleh alur pembayaran.
- Semua input tanggal/date dan datetime-local membuka calendar picker native saat diklik (browser yang mendukung `showPicker()`).
- Cache asset dan label versi dinaikkan ke v1.6.1.
