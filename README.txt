INKAMBILL CLOSING PDF V2
Paket kumulatif: sinkronisasi closing + tata letak 5 bagian.
Setiap site mendapat kartu lebar: 1 Pendapatan per kategori; 2 Pengeluaran per kategori; 3 Laba bersih; 4 Piutang; 5 Pembagian hasil.
Gunakan paket ini sebagai pengganti paket sebelumnya.

PEMASANGAN
Upload ZIP ke server, lalu:
python3 -m zipfile -e inkambill-closing-pdf-rapi-v2.zip closing-pdf-v2
python3 closing-pdf-v2/INSTALL.py /PATH/APLIKASI/inkambill-server
Ganti path dengan folder aplikasi yang berisi app.js. Installer memeriksa versi file sebelum menulis, membuat backup, dan rollback bila tes gagal. Tidak mengubah database.
Setelah selesai, rebuild/restart dengan prosedur deployment yang biasa digunakan. Export PDF baru. Periode LOCKED perlu dibuka dan Sync untuk memperbarui sumber kas; manual hanya rekonsiliasi baris kas yang sudah ada.

VALIDASI
npm run validate dan 4 tes closing lulus. Preview PDF dirender dan diperiksa secara visual. Preview memakai angka ilustrasi, bukan laporan produksi; susunan kartu saja yang dicontohkan. Database produksi belum diakses.
ROLLBACK
Salin file dari folder closing-backup yang dicetak installer ke folder aplikasi, lalu rebuild/restart.
