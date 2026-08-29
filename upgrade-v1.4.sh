#!/bin/sh
set -eu
if [ ! -f .env ]; then echo "ERROR: .env tidak ditemukan."; exit 1; fi
node --check app.js
find routes services middleware config -name '*.js' -print0 | xargs -0 -n1 node --check
docker compose config >/dev/null
echo "Rebuild aplikasi v1.4.0..."
docker compose up -d --build app
echo "Schema v1.4 akan dibuat idempotent saat app startup."
docker compose ps
