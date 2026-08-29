#!/bin/sh
set -e
[ -f .env ] || { echo ".env tidak ditemukan"; exit 1; }
echo "Menjalankan migrasi INKAMNET Studio v0.4..."
docker compose up -d db
echo "Menunggu MariaDB healthy..."
i=0
while [ "$i" -lt 30 ]; do
  if docker compose exec -T db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then break; fi
  i=$((i+1)); sleep 2
done
docker compose exec -T db sh -lc 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' < database/migration_v04.sql
echo "Migrasi selesai. Rebuild aplikasi..."
docker compose up -d --build app
docker compose ps
