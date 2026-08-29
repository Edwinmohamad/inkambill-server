#!/bin/sh
set -e
if [ ! -f .env ]; then echo "File .env tidak ditemukan."; exit 1; fi
DB_CONTAINER=$(docker compose ps -q db)
if [ -z "$DB_CONTAINER" ]; then echo "Container database belum running."; exit 1; fi
DB_NAME_VALUE=$(grep -E '^DB_NAME=' .env | tail -1 | cut -d= -f2-)
DB_USER_VALUE=$(grep -E '^DB_USER=' .env | tail -1 | cut -d= -f2-)
DB_PASSWORD_VALUE=$(grep -E '^DB_PASSWORD=' .env | tail -1 | cut -d= -f2-)
mkdir -p storage/payment-proofs
echo "Apply migration v0.5.1 (payment proof upload)..."
docker exec -i "$DB_CONTAINER" mariadb -u"$DB_USER_VALUE" -p"$DB_PASSWORD_VALUE" "$DB_NAME_VALUE" < database/migration_v051.sql
echo "Rebuild aplikasi..."
docker compose up -d --build app
echo "Selesai. Bukti transfer tersimpan di ./storage/payment-proofs"
docker compose ps
