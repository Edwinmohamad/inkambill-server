# Closing — CDS / KBG

Paket ini menambahkan modul Closing dengan PIN, mode otomatis/manual, snapshot saat dikunci, dan PDF terpisah.

## PIN awal

`684217`

Untuk mengganti PIN di server, isi `CLOSING_PIN_SHA256` dengan hash SHA-256 PIN baru. Contoh:

```bash
printf '%s' 'PIN-BARU' | sha256sum
```

## Output PDF

- **PDF CDS**: site CDS, yaitu gabungan cluster KRW dan CLM.
- **KBG · Mang Ali**: hanya pembagian Mang Ali (35%).
- **KBG · Jon + Bopung**: pembagian internal untuk Jon dan Bopung; bagian Edwin tidak ditampilkan.

Centang **Sembunyikan bagian Edwin saat unduh PDF** bila PDF CDS tidak boleh memuat baris pembagian Edwin.

## Deploy melalui GitHub Desktop

Salin file pada paket ini ke path yang sama di repo lokal, commit, lalu push ke `main`. Workflow deploy akan menjalankan migrasi tabel Closing otomatis. Jangan menimpa `.env` produksi; cukup tambahkan `CLOSING_PIN_SHA256` jika PIN ingin diganti.

Validasi yang sudah dijalankan:

```bash
npm run validate:v119
```

