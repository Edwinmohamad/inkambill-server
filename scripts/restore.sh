#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then echo "Usage: $0 /path/to/fmt-tbs-YYYYMMDD-HHMMSS.tar.gz" >&2; exit 2; fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="$1"
[ -f "$BACKUP" ] || { echo "Backup not found: $BACKUP" >&2; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar -xzf "$BACKUP" -C "$TMP"
[ -f "$TMP/data/fmt_tbs.db" ] || { echo "Invalid backup: database missing" >&2; exit 3; }
python3 - "$TMP/data/fmt_tbs.db" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); row=c.execute('PRAGMA integrity_check').fetchone(); c.close()
if not row or row[0] != 'ok': raise SystemExit('Backup database integrity check failed')
PY
mkdir -p "$ROOT/data" "$ROOT/uploads"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -f "$ROOT/data/fmt_tbs.db" ]; then cp -a "$ROOT/data/fmt_tbs.db" "$ROOT/data/fmt_tbs.db.pre-restore-$STAMP"; fi
cp -a "$TMP/data/fmt_tbs.db" "$ROOT/data/fmt_tbs.db"
rm -rf "$ROOT/uploads"; cp -a "$TMP/uploads" "$ROOT/uploads"
echo "Restore completed. Restart the application before use."
