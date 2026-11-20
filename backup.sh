#!/bin/sh
set -eu
BACKUP_DIR=${BACKUP_DIR:-/opt/inkambilling/backups}
STAMP=$(date +%Y%m%d-%H%M%S)
MONTH=$(date +%Y-%m)
DAY=$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/monthly" "$BACKUP_DIR/logs"
chmod 700 "$BACKUP_DIR"
SQL_FILE="$BACKUP_DIR/daily/inkamnet-$STAMP.sql.gz"
LOG_FILE="$BACKUP_DIR/logs/backup-$STAMP.log"
# gzip -9 (max compression) on a potentially-large SQL dump was burning most of this step's time for
# a space saving the deploy pipeline doesn't need urgently; -1 keeps every safety check below
# (test -s / gzip -t / header check / sha256) identical, just much faster so the 35-minute job
# timeout (see .github/workflows/deploy.yml) doesn't auto-cancel the whole deploy mid-backup.
docker compose exec -T db sh -c 'exec mariadb-dump --single-transaction --routines --triggers -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' | gzip -1 > "$SQL_FILE"
test -s "$SQL_FILE"
gzip -t "$SQL_FILE"
gzip -dc "$SQL_FILE" | head -n 40 | grep -q 'MariaDB dump\|MySQL dump'
sha256sum "$SQL_FILE" > "$SQL_FILE.sha256"
# storage/ (bukti foto/PDF) tidak berubah karena deploy KODE -- hanya berubah saat user upload
# bukti baru. Men-tar ulang seluruh folder ini di SETIAP deploy (bisa beberapa kali sehari) adalah
# pemborosan waktu besar untuk perlindungan yang sama; cukup sekali per hari kalender. Isi foto/PDF
# sudah terkompresi sehingga gzip tidak banyak menghemat ruang -- level 1 saja sudah cukup.
if [ -d storage ] && ! ls "$BACKUP_DIR"/daily/inkamnet-files-"$DAY"-*.tar.gz >/dev/null 2>&1; then
  tar -cf - storage | gzip -1 > "$BACKUP_DIR/daily/inkamnet-files-$STAMP.tar.gz"
fi
if [ ! -f "$BACKUP_DIR/monthly/inkamnet-$MONTH.sql.gz" ]; then
  cp "$SQL_FILE" "$BACKUP_DIR/monthly/inkamnet-$MONTH.sql.gz"
  cp "$SQL_FILE.sha256" "$BACKUP_DIR/monthly/inkamnet-$MONTH.sql.gz.sha256"
fi
find "$BACKUP_DIR/daily" -type f -mtime +14 -delete
find "$BACKUP_DIR/monthly" -type f -mtime +190 -delete
if [ -n "${BACKUP_SYNC_COMMAND:-}" ]; then sh -c "$BACKUP_SYNC_COMMAND"; fi
printf '%s backup=success file=%s sha256=%s\n' "$(date -Iseconds)" "$SQL_FILE" "$(cut -d' ' -f1 "$SQL_FILE.sha256")" | tee "$LOG_FILE"
