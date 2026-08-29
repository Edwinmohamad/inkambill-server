#!/bin/sh
set -e
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
set -a
. ./.env
set +a
docker compose exec -T db mariadb-dump -u root -p"$DB_ROOT_PASSWORD" "$DB_NAME" | gzip > "backups/inkamnet-$STAMP.sql.gz"
if [ -d storage ]; then
  tar -czf "backups/inkamnet-files-$STAMP.tar.gz" storage
fi
find backups -type f -name 'inkamnet-*.sql.gz' -mtime +14 -delete
find backups -type f -name 'inkamnet-files-*.tar.gz' -mtime +14 -delete
echo "Backup DB: backups/inkamnet-$STAMP.sql.gz"
[ -f "backups/inkamnet-files-$STAMP.tar.gz" ] && echo "Backup bukti/file: backups/inkamnet-files-$STAMP.tar.gz"
