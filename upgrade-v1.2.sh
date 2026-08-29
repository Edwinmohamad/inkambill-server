#!/bin/sh
set -eu

if [ ! -f .env ]; then echo "ERROR: .env tidak ditemukan."; exit 1; fi
if ! docker compose version >/dev/null 2>&1; then echo "ERROR: Docker Compose tidak tersedia."; exit 1; fi

echo "[1/4] Validasi source v1.2..."
node --check app.js >/dev/null
find routes services middleware config -name '*.js' -print0 | xargs -0 -n1 node --check

echo "[2/4] Validasi Docker Compose..."
docker compose config >/dev/null

echo "[3/4] Rebuild aplikasi v1.2 (database tidak diubah)..."
docker compose up -d --build app

echo "[4/4] Status..."
docker compose ps

echo "Upgrade v1.2 selesai. Cek /healthz lalu hard-refresh browser (Ctrl+F5)."
