#!/usr/bin/env bash
set -Eeuo pipefail
APP="${APP:-/opt/inkambilling}"
SELF="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/inkambilling-before-financial-integrity-${STAMP}.tar.gz"
cd "$APP"
for f in services/invoiceService.js services/paymentVerificationService.js services/cashService.js routes/finance.js routes/invoices.js package.json; do
  test -f "$f" || { echo "File wajib tidak ada: $f" >&2; exit 1; }
done
echo "[1/6] Backup source -> $BACKUP"
tar --exclude='./node_modules' --exclude='./storage' --exclude='./.git' -czf "$BACKUP" .
echo "[2/6] Dry-run patch"
patch -p1 --dry-run < "$SELF/FINANCIAL-INTEGRITY-FINAL.patch"
echo "[3/6] Apply patch"
patch -p1 < "$SELF/FINANCIAL-INTEGRITY-FINAL.patch"
echo "[4/6] Syntax + static validation"
npm run check
node scripts/test-financial-integrity-static.js
if [ -d node_modules ]; then
  echo "[5/6] Existing regression suite"
  npm run validate:final
else
  echo "[5/6] node_modules tidak ada di host; regression runtime dilewati. Docker build akan install dependency."
fi
echo "[6/6] Selesai. Belum menjalankan repair DB dan belum restart container."
echo "Backup: $BACKUP"
echo "NEXT: node scripts/financial-integrity-audit.js"
echo "Jika audit menemukan legacy double PSB: node scripts/repair-legacy-psb-double-income.js lalu audit ulang."
