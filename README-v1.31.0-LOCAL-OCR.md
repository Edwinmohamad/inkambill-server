# INKAMBILL v1.31.0 — Local OCR Proof Validation

Patch ini dibangun untuk source INKAMBILL v1.30 hasil audit 30 Sep 2026.

## Prinsip final

- Tidak menggunakan AI.
- Tidak menggunakan Anthropic/OpenAI/Gemini atau API OCR eksternal.
- OCR berjalan lokal memakai Tesseract CLI.
- Hasil OCR hanya advisory untuk Master Admin.
- Mismatch rekening, nominal, nama penerima, atau indikasi duplikat TIDAK memblokir approval.
- Admin biasa tetap memakai flow lama dan tidak melihat panel OCR.
- Master Admin melihat validasi saat membuka bukti atau menekan Approve.
- Jika OCR/Tesseract tidak tersedia, approval manual tetap berjalan.
- Rekening resmi selalu dibaca dari tabel `banks`; tidak ada nomor rekening hard-code di service.
- Duplicate check memakai SHA-256, nomor referensi, dan kombinasi nominal+waktu. Bukti yang sama dalam satu batch multi-faktur dikecualikan.
- Jika OCR membaca tanggal transfer, modal approval menambahkan pilihan tanggal bukti OCR dan memilihnya sebagai saran default. Server mengambil tanggal dari DB OCR, bukan mempercayai hidden input browser.

## File yang berubah

- `services/proofOcrService.js` (baru)
- `services/schemaService.js`
- `services/paymentVerificationService.js`
- `routes/payments.js`
- `views/payments/index.ejs`
- `app.js`
- `scripts/test-proof-ocr-local.js` (baru)
- `package.json`
- `Dockerfile` hanya bila base image Debian/Ubuntu/Node atau Alpine dikenali.

## Database

Patch membuat tabel baru `payment_proof_ocr` melalui `ensureV59Schema()`.

Tabel lama `payment_proof_scans` tidak dipakai sehingga tidak bentrok dengan cleanup legacy `ensureV57Schema()`.

## Instalasi aman

```bash
cd /root
unzip inkambill-v1.31.0-LOCAL-OCR-FINAL-PATCH.zip -d inkambill-local-ocr-final
cd inkambill-local-ocr-final
APP=/opt/inkambilling FULL_TESTS=1 DEPLOY=0 bash APPLY_LOCAL_OCR_FINAL.sh
```

Installer otomatis:

1. membuat backup source ke `/root/inkambilling-before-local-ocr-YYYYMMDD-HHMMSS.tar.gz`;
2. memeriksa patch point v1.30;
3. memasang service OCR lokal;
4. menjalankan `node --check`;
5. menjalankan unit test OCR;
6. menjalankan static validation;
7. menjalankan regression suite existing bila `FULL_TESTS=1`;
8. rollback otomatis jika salah satu tahap gagal;
9. tidak restart Docker bila validasi gagal.

## Deploy setelah patch PASS

```bash
cd /opt/inkambilling
docker compose build
docker compose up -d
docker compose ps
```

Atau langsung deploy hanya jika Anda memang ingin installer melakukan build/restart setelah semua test PASS:

```bash
APP=/opt/inkambilling FULL_TESTS=1 DEPLOY=1 bash APPLY_LOCAL_OCR_FINAL.sh
```

## Verifikasi Tesseract di container aplikasi

Cari container aplikasi:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Lalu:

```bash
docker exec -it INKAMBILLING-APP tesseract --version
docker exec -it INKAMBILLING-APP tesseract --list-langs | grep -E '^(eng|ind)$'
```

Minimal `eng` harus tersedia. `ind+eng` dipilih otomatis jika keduanya tersedia.

## Expected UI

Master Admin → Lihat Bukti / Approve:

- ✓ Nominal sesuai
- ✓ Tanggal terbaca
- ✓ Rekening resmi / tersamar cocok
- ✓ Penerima sesuai
- ✓ Bukti unik
- ✓ Reference terbaca
- OCR xx%

Jika mismatch:

- ⚠ Rekening tujuan tidak terdaftar
- ⚠ Nominal berbeda
- ⚠ Nama penerima berbeda
- ⚠ Kemungkinan bukti ganda

Tombol approval tetap tersedia dan berubah menjadi `Tetap Approve` pada warning.

## Catatan PDF

Upload PDF tetap diterima oleh Billing tetapi OCR lokal otomatis dilewati untuk PDF pada patch ini. Master Admin tetap dapat membuka PDF dan approve secara manual. JPG/PNG/WEBP diproses Tesseract.
