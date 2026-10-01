#!/usr/bin/env bash
set -euo pipefail
APP="${APP:-/opt/inkambilling}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/inkambilling-backup-before-v1.32.1-manual-cash-delete-$TS"

if [ ! -d "$APP" ]; then
  echo "ERROR: app directory tidak ditemukan: $APP" >&2
  exit 1
fi

mkdir -p "$BACKUP"
for rel in \
  package.json \
  routes/finance.js \
  services/paymentVerificationService.js \
  services/schemaService.js \
  views/finance/cash.ejs \
  scripts/test-financial-integrity-static.js; do
  if [ -f "$APP/$rel" ]; then
    mkdir -p "$BACKUP/$(dirname "$rel")"
    cp -a "$APP/$rel" "$BACKUP/$rel"
  fi
done

echo "Backup: $BACKUP"

cp -a "$HERE/files/package.json" "$APP/package.json"
cp -a "$HERE/files/routes/finance.js" "$APP/routes/finance.js"
cp -a "$HERE/files/services/paymentVerificationService.js" "$APP/services/paymentVerificationService.js"
cp -a "$HERE/files/services/schemaService.js" "$APP/services/schemaService.js"
cp -a "$HERE/files/views/finance/cash.ejs" "$APP/views/finance/cash.ejs"
cp -a "$HERE/files/scripts/test-financial-integrity-static.js" "$APP/scripts/test-financial-integrity-static.js"
cp -a "$HERE/files/scripts/test-manual-auto-journal-delete.js" "$APP/scripts/test-manual-auto-journal-delete.js"

# Syntax/static checks use the container if host Node is unavailable.
if command -v node >/dev/null 2>&1; then
  cd "$APP"
  node --check routes/finance.js
  node --check services/paymentVerificationService.js
  node --check services/schemaService.js
  node scripts/test-manual-auto-journal-delete.js
else
  if docker ps --format '{{.Names}}' | grep -qx 'INKAMBILLING-APP'; then
    docker exec -w /app INKAMBILLING-APP node --check routes/finance.js || true
    docker exec -w /app INKAMBILLING-APP node --check services/paymentVerificationService.js || true
    docker exec -w /app INKAMBILLING-APP node --check services/schemaService.js || true
    echo "NOTE: container yang sedang berjalan masih memakai source image lama; test penuh dijalankan setelah rebuild."
  else
    echo "NOTE: Node tidak ada di host dan container INKAMBILLING-APP tidak aktif; syntax check dilewati."
  fi
fi

echo
echo "PATCH APPLIED. Selanjutnya jalankan:"
echo "  cd $APP"
echo "  docker compose build"
echo "  docker compose up -d"
echo "  docker compose ps"
echo "  docker exec -w /app INKAMBILLING-APP node scripts/test-manual-auto-journal-delete.js"
