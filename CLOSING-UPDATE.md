# Modul Closing — CDS / KBG

Modul ini adalah kalkulator pembagian hasil bulanan INKAMBILLING. Semua angka dihitung berdasarkan tanggal transaksi yang dipilih, bukan tanggal saat tombol closing ditekan.

## Periode dan sumber data

- Contoh: transaksi 1–31 Agustus diproses saat closing 5/6 September dengan memilih `from=YYYY-08-01` dan `to=YYYY-08-31`.
- Tanggal September tidak ikut masuk ke closing Agustus.
- Closing sekarang **full manual**. Route Closing tidak membaca tabel billing, pembayaran, jurnal kas, atau cash yang masih dipegang tim.
- Isi satu baris untuk setiap angka pendapatan dan pengeluaran. Pendapatan dapat diberi site `CDS` atau `KBG`; pendapatan CDS dapat diberi cluster `KRW` atau `CLM`.
- Pengeluaran dijumlahkan sekali berdasarkan site. Cluster pada pengeluaran hanya keterangan, sehingga KRW dan CLM tidak menggandakan biaya CDS.
- Data `closing_router_assets` tetap merupakan daftar manual khusus INVEST ROUTER; data ini bukan sinkronisasi billing.
- Gaji, carry-over, cash belum setor, potongan/tambahan, dan catatan juga diisi dari menu Closing.

## Aturan pembagian

- **CDS** adalah satu site gabungan dari cluster KRW dan CLM: Edwin 50%, Jon 25%, Bopung 25%.
- **KBG / Kubang**: Mang Ali 35%; pool internal 65% dibagi Edwin 41,418%, Jon 11,791%, dan Bopung 11,791% dari total profit.
- Gaji Agung + Padilah menjadi potongan CDS: Edwin 50%, Jon 25%, Bopung 25%; Mang Ali tidak dibebani.
- Baris penyesuaian bertipe **Cash belum setor** mengurangi penerima yang dipilih pada site yang dipilih. Tidak ada lagi pengambilan otomatis dari status `held_by_staff`.
- INVEST ROUTER memberi Rp20.000 per unit per bulan hanya ketika status `ACTIVE` dan router masih berada di periode. Status `BROKEN`, `REPLACED`, atau `INACTIVE` tidak menghasilkan reward.
- Penyesuaian manual dapat berupa tambahan atau potongan dan harus memilih site CDS/KBG.
- Carry-over negatif tetap tersedia sebagai input manual; sistem tidak memindahkan saldo ke bulan berikutnya secara otomatis.
- Lokasi lain/KUBANG yang tidak terbaca sebagai KBG masuk **Lokasi belum dipetakan** dan mencegah periode dikunci sampai diperbaiki.

## PDF per penerima

Tersedia empat PDF terpisah:

1. Edwin — rincian CDS dan KBG yang menjadi bagian Edwin.
2. Jon — rincian CDS dan KBG yang menjadi bagian Jon.
3. Bopung — rincian CDS dan KBG yang menjadi bagian Bopung.
4. Mang Ali — rincian KBG Mang Ali (35%).

Setiap PDF memuat pendapatan pelanggan/pemasukan, pengeluaran lengkap beserta kategori dan keterangan, subtotal cluster CDS, pembagian penerima, cash belum setor, gaji, INVEST ROUTER, dan penyesuaian milik penerima tersebut. PDF memiliki watermark penerima dan opsi **Sembunyikan bagian Edwin** untuk dokumen yang dibagikan ke pihak lain.

## Keamanan

- Route Closing hanya dapat dibuka oleh akun **Master Admin**. Setelah role lolos, PIN Closing tetap wajib dimasukkan.
- Setelah login, PIN Closing tetap diperlukan. PIN awal: `121224`.
- Lima kesalahan PIN mengunci akses selama 15 menit; sesi PIN berlaku 30 menit.
- Untuk mengganti PIN, isi hash SHA-256 di `.env` produksi:

  ```bash
  printf '%s' 'PIN-BARU' | sha256sum
  ```

  lalu masukkan hasilnya ke `CLOSING_PIN_SHA256`.

- Periode yang sudah dikunci menyimpan snapshot sehingga perubahan data setelah closing tidak mengubah PDF lama.

## Deploy melalui GitHub Desktop

Salin file paket ini ke path yang sama di repo lokal, commit, lalu push ke `main`. Workflow deploy akan menjalankan migrasi Closing (`ensureV35Schema` sampai `ensureV37Schema`) saat aplikasi start. Jangan menimpa `.env` produksi.

## Validasi

Sebelum commit, jalankan:

```bash
npm run validate:v119
```

Validasi mencakup syntax JavaScript, struktur EJS/form, kalkulator CDS/KBG, approval kas, responsif CSS, dan kontrak aplikasi.
