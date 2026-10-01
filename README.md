# INKAMBILL Financial Integrity Final Patch

Tujuan utama:
- PSB / generate invoice tidak lagi otomatis menciptakan payment atau pendapatan kas.
- Pendapatan hanya direalisasi dari payment yang benar-benar confirmed dan sudah masuk perusahaan.
- PSB memakai satu income journal saja (`source_type=payment`), sehingga tidak bisa dobel dengan `install_income`.
- Komisi PSB baru dijurnal saat payment direalisasi, bukan saat invoice dibuat.
- Cash `held_by_staff` tetap bukan pendapatan sampai settlement.
- Jurnal otomatis/payment-linked immutable dari Data Kas; koreksi wajib dari Payment/Tagihan.
- Period Closing LOCKED melindungi approval/reject/edit/delete transaksi.
- Force-delete jurnal payment-linked/APPROVED diblokir.
- Force-delete invoice yang memiliki histori payment diblokir.
- Ditambahkan financial integrity audit + legacy PSB duplicate repair.

## Instalasi
```bash
cd /root
unzip INKAMBILL-FINANCIAL-INTEGRITY-FINAL.zip -d inkambill-financial-integrity-final
cd inkambill-financial-integrity-final
APP=/opt/inkambilling bash APPLY_FINANCIAL_INTEGRITY_FINAL.sh
```

## Audit data sebelum repair
```bash
cd /opt/inkambilling
node scripts/financial-integrity-audit.js
```

## Repair legacy double PSB
Backup database terlebih dahulu, lalu:
```bash
node scripts/repair-legacy-psb-double-income.js
node scripts/financial-integrity-audit.js
```

Repair hanya menargetkan payment yang memiliki lebih dari satu income journal `payment/install_income` untuk `source_id` yang sama. Ia mempertahankan satu jurnal (memprioritaskan kategori `PSB-IN`) dan menormalisasi source type komisi legacy.

## Deploy
```bash
cd /opt/inkambilling
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3301/healthz && echo
```

## Validasi yang sudah PASS pada baseline source audit
- `npm run check`
- `npm run validate:final`
- `node scripts/test-financial-integrity-static.js`

Catatan: patch dibangun dari clean source InkamBill v1.26.0 yang tersedia pada workspace audit. Installer menggunakan `patch --dry-run`; bila source production berbeda pada baris yang disentuh, installer berhenti sebelum mengubah file, sehingga tidak memaksa patch yang salah.
