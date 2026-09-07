#!/bin/sh
set -eu
BACKUP_DIR=${BACKUP_DIR:-/opt/inkambilling/backups}
STAMP=$(date +%Y%m%d-%H%M%S)
MONTH=$(date +%Y-%m)
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/monthly" "$BACKUP_DIR/logs"
chmod 700 "$BACKUP_DIR"
SQL_FILE="$BACKUP_DIR/daily/inkamnet-$STAMP.sql.gz"
LOG_FILE="$BACKUP_DIR/logs/backup-$STAMP.log"
docker compose exec -T db sh -c 'exec mariadb-dump --single-transaction --routines --triggers -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' | gzip -9 > "$SQL_FILE"
test -s "$SQL_FILE"
gzip -t "$SQL_FILE"
gzip -dc "$SQL_FILE" | head -n 40 | grep -q 'MariaDB dump\|MySQL dump'
sha256sum "$SQL_FILE" > "$SQL_FILE.sha256"
if [ -d storage ]; then
  tar -czf "$BACKUP_DIR/daily/inkamnet-files-$STAMP.tar.gz" storage
fi
if [ ! -f "$BACKUP_DIR/monthly/inkamnet-$MONTH.sql.gz" ]; then
  cp "$SQL_FILE" "$BACKUP_DIR/monthly/inkamnet-$MONTH.sql.gz"
  cp "$SQL_FILE.sha256" "$BACKUP_DIR/monthly/inkamnet-$MONTH.sql.gz.sha256"
fi
find "$BACKUP_DIR/daily" -type f -mtime +14 -delete
find "$BACKUP_DIR/monthly" -type f -mtime +190 -delete
if [ -n "${BACKUP_SYNC_COMMAND:-}" ]; then sh -c "$BACKUP_SYNC_COMMAND"; fi
printf '%s backup=success file=%s sha256=%s\n' "$(date -Iseconds)" "$SQL_FILE" "$(cut -d' ' -f1 "$SQL_FILE.sha256")" | tee "$LOG_FILE"
