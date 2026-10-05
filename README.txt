INKAMBILL - LAPORAN PROFESIONAL V3
Paket kumulatif pengganti patch closing sebelumnya.
CAKUPAN
- Menu Laporan: pelanggan, tagihan, faktur, arus kas/pemasukan/pengeluaran.
- PDF dan TXT: nomor urut, rekap per site/kategori/status, rincian terbayar dan sisa, referensi pelanggan/invoice/kas.
- TXT: tabel ringkas disertai rincian lengkap tanpa pemotongan teks.
- Export Excel tagihan dan rekonsiliasi cash: nomor urut.
- PDF laporan umum: nomor urut otomatis bila belum tersedia.
- Closing: sinkronisasi dan layout 5 bagian dari V2.
- Filter jatuh tempo tetap terbawa pada export; tanggal default mengikuti WIB; pelanggan/invoice arsip tidak masuk laporan operasional.
- Kas: APPROVED saja; jurnal pembayaran harus confirmed, cash harus settled. Kategori sistem yang berisi pendapatan sah tetap dihitung.
- Pemeriksaan invoice vs jumlah pembayaran confirmed menampilkan peringatan bila perlu rekonsiliasi. Tidak mengubah atau menghapus data finansial.

PEMASANGAN
Upload ZIP ke server:
python3 -m zipfile -e inkambill-laporan-profesional-v3.zip laporan-v3
python3 laporan-v3/INSTALL.py /PATH/APLIKASI/inkambill-server
Ganti path dengan folder berisi app.js dan dependency aplikasi yang sudah terpasang.
Installer memeriksa versi sebelum menulis, membuat backup, menjalankan tes, dan rollback jika tes gagal.
Setelah terpasang, rebuild/restart sesuai deployment Anda lalu unduh laporan baru.

VALIDASI
npm run validate, pengujian laporan/closing/invoice/filter pembayaran/jurnal setoran lulus. PDF contoh 5 halaman telah diperiksa; angka ilustrasi bukan data produksi. Installer diuji pada salinan commit dasar.
PDF tagihan berpatokan pada periode invoice; arus kas berpatokan pada tanggal kas diterima. Terbayar invoice termasuk cash yang belum disetor, sedangkan kas perusahaan hanya cash yang sudah disetor. Perbedaan dasar periode dan setoran ini dijelaskan untuk menghindari salah perbandingan.
Seluruh database produksi belum diaudit langsung. Peringatan rekonsiliasi harus diperiksa pada server.
ROLLBACK
Pulihkan file dari folder closing-backup yang dicetak installer lalu rebuild/restart.
