# Perbaikan Smart Sync PPPoE

Paket ini hanya berisi file yang direvisi. Salin isinya ke root aplikasi dengan
struktur folder tetap sama, lalu restart aplikasi. Migrasi V56 dijalankan
otomatis saat aplikasi mulai.

## Yang diperbaiki

- mapping `router_id` atau username lama dapat diperbaiki oleh Smart Sync;
- kandidat divalidasi ulang langsung dari semua router pada site sebelum simpan;
- router yang tidak bisa diverifikasi menahan sinkronisasi otomatis pada site itu;
- satu secret tidak dapat dipasang otomatis ke dua pelanggan;
- penyimpanan memakai transaksi, advisory lock per site, dan verifikasi baca ulang;
- status pelanggan mengikuti sesi aktif (`online`, `offline`, atau `isolated`);
- waktu dan sumber sinkronisasi tersimpan di data pelanggan;
- semua percobaan sukses/gagal dicatat di `pppoe_sync_logs`;
- endpoint riwayat tersedia di `GET /network/api/sync-history` untuk Admin.

## Verifikasi

Jalankan:

```bash
npm install
npm run test:pppoe-smart-sync
npm run validate
```

Setelah restart, buka **MikroTik NMS → Sync & Audit**, tekan **Refresh**, lalu
jalankan **Smart Sync Aman**. Server akan menampilkan konfirmasi jumlah kandidat
yang sudah diverifikasi sebelum perubahan diterapkan.
