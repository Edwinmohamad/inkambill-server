# PATCH v1.29 — Filter Cash/Transfer & Scan Bukti Transfer Otomatis

## Fitur
- **Filter metode** di Approval & Transaksi: dropdown + chip cepat Cash / Transfer / QRIS (jumlah menunggu approval).
- **Scan bukti transfer/QRIS** setiap kali bukti diupload (baru, ganti bukti, atau tombol "Baca ulang"):
  - AI vision membaca nominal, tanggal/jam, pengirim, penerima (nama + rekening), no. referensi.
  - Server mencocokkan dengan data tagihan → badge **Cocok / Perlu dicek / Tidak cocok / Belum terbaca** + catatan otomatis
    (mis. "Bukti Rp100.000, tagihan Rp150.000 · KURANG Rp50.000").
  - Cek penerima terhadap rekening aktif di Pengaturan → Bank (+ nama merchant QRIS tambahan).
  - Cek pengirim vs nama pelanggan (gelar, nama terpotong, inisial ditangani) + **pengirim dikenal** per pelanggan.
  - **Deteksi bukti ganda** (lokal, tanpa AI): hash file, kemiripan gambar (kompres ulang WhatsApp), no. referensi,
    kombinasi nominal+jam+pengirim. 1 bukti untuk beberapa faktur dalam satu pengajuan tetap dianggap sah.
- **Pengaman approval**: status Perlu dicek/Tidak cocok wajib diisi alasan (tercatat di audit), dan dilewati saat Approve Massal.
- Filter "Scan bukti" + panel detail hasil scan di viewer bukti.
- Perbaikan kecil: segel status di viewer bukti sebelumnya selalu "CONFIRMED" walau pembayaran masih pending.

## Deploy
1. Tarik kode, lalu rebuild container (ada dependency baru `jpeg-js`, `pngjs` — murni JavaScript):
   `docker compose up -d --build`
2. Skema (`payment_proof_scans`, `customer_payer_aliases`, kolom `settings.proof_scan_*`) dibuat otomatis saat start.
3. Isi API key Anthropic: menu **Approval & Transaksi → Scan Bukti** (tersimpan terenkripsi), atau `.env` `PROOF_SCAN_API_KEY=`.
   Tanpa API key, hanya cek bukti ganda yang berjalan.
4. Bukti pending lama otomatis ikut di-scan bertahap (20 per menit).

## Tes
`npm run test:proof-scan` (juga termasuk di `npm run validate:final`).
