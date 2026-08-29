#!/bin/sh
set -eu

if [ ! -f .env ]; then echo "ERROR: .env tidak ditemukan."; exit 1; fi
if ! docker compose version >/dev/null 2>&1; then echo "ERROR: Docker Compose tidak tersedia."; exit 1; fi
DB_ROOT_PASSWORD_VALUE=$(grep -E '^DB_ROOT_PASSWORD=' .env | tail -1 | cut -d= -f2- | tr -d '\r')
DB_NAME_VALUE=$(grep -E '^DB_NAME=' .env | tail -1 | cut -d= -f2- | tr -d '\r')
[ -n "$DB_ROOT_PASSWORD_VALUE" ] || { echo "ERROR: DB_ROOT_PASSWORD kosong"; exit 1; }
[ -n "$DB_NAME_VALUE" ] || DB_NAME_VALUE=inkamnet

echo "[1/4] Menyalakan database..."
docker compose up -d db

echo "[2/4] Menunggu database healthy..."
i=0
while [ "$i" -lt 30 ]; do
  if docker compose ps db --format json 2>/dev/null | grep -q '"Health":"healthy"'; then break; fi
  i=$((i+1)); sleep 2
done

echo "[3/4] Menjalankan migration v1.1..."
docker compose exec -T db mariadb -uroot -p"$DB_ROOT_PASSWORD_VALUE" "$DB_NAME_VALUE" < database/migration_v11.sql

echo "[4/4] Rebuild aplikasi..."
docker compose up -d --build app

echo "Selesai. Status:"
docker compose ps
