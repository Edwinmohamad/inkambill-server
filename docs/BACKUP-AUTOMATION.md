# Backup INKAMBILLING

Backup dijalankan otomatis sebelum setiap deploy GitHub Actions. Untuk backup harian tanpa membuka server, pasang satu kali:

```bash
(crontab -l 2>/dev/null; echo '15 2 * * * cd /opt/inkambilling && /bin/sh backup.sh >> /opt/inkambilling/backups/cron.log 2>&1') | crontab -
```

Retensi bawaan: 14 hari untuk backup harian dan sekitar 6 bulan untuk salinan bulanan. Setiap SQL diperiksa dengan `gzip -t`, diperiksa header dump-nya, lalu dibuat checksum SHA-256.

Untuk menyalin ke NAS/Proxmox/ownCloud, ekspor environment `BACKUP_SYNC_COMMAND` pada service/cron, misalnya perintah `rsync` menuju target yang sudah memakai SSH key. Jangan simpan password NAS di repository.

Catatan: script tidak menjalankan `source .env`, sehingga nilai `.env` yang mengandung spasi tidak lagi menyebabkan error `command not found`. Kredensial database dibaca dari environment container MariaDB.
