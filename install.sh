#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker belum terpasang."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose plugin belum tersedia."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "File .env dibuat. Edit dulu: nano .env"
  echo "Jangan jalankan aplikasi sebelum semua password/secret placeholder diganti."
  exit 1
fi

if grep -Eq '^(SESSION_SECRET|ROUTER_CREDENTIAL_KEY|DB_PASSWORD|DB_ROOT_PASSWORD)=.*(GANTI_|GantiPassword)' .env; then
  echo "ERROR: Masih ada SESSION/DB/ROUTER secret default di .env."
  echo "Edit dulu: nano .env"
  exit 1
fi
if grep -Eq '^DEFAULT_ADMIN_PASSWORD=GantiPassword' .env; then
  echo "ERROR: DEFAULT_ADMIN_PASSWORD belum diganti."
  exit 1
fi

PORT_VALUE=$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- | tr -d '\r' || true)
APP_URL_VALUE=$(grep -E '^APP_URL=' .env | tail -1 | cut -d= -f2- | tr -d '\r' || true)
[ -n "$PORT_VALUE" ] || PORT_VALUE=3200

mkdir -p storage/payment-proofs storage/profile-photos storage/cash-proofs storage/ticket-attachments storage/server-duty-proofs
chmod 700 storage storage/payment-proofs storage/profile-photos storage/cash-proofs storage/ticket-attachments storage/server-duty-proofs 2>/dev/null || true

echo "Validasi Docker Compose..."
docker compose config >/dev/null

echo "Build dan start INKAMNET Control Center v1.8.0..."
docker compose up -d --build

echo "Menunggu container sehat..."
i=0
while [ "$i" -lt 24 ]; do
  STATUS=$(docker compose ps --format json 2>/dev/null | grep -c '"Health":"healthy"' || true)
  if [ "$STATUS" -ge 2 ]; then break; fi
  i=$((i+1))
  sleep 5
done

echo ""
echo "Status container:"
docker compose ps
echo ""
if [ -n "$APP_URL_VALUE" ]; then echo "Buka: $APP_URL_VALUE"; else echo "Buka: http://IP-SERVER:$PORT_VALUE"; fi
echo "Health check: /healthz"
