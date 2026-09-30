#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST" "$TMP/data"
python3 - "$ROOT/data/fmt_tbs.db" "$TMP/data/fmt_tbs.db" <<'PY'
import sqlite3, sys, pathlib
src,dst=sys.argv[1:]
pathlib.Path(dst).parent.mkdir(parents=True,exist_ok=True)
if pathlib.Path(src).exists():
    a=sqlite3.connect(src); b=sqlite3.connect(dst)
    with b: a.backup(b)
    a.close(); b.close()
PY
if [ -d "$ROOT/uploads" ]; then cp -a "$ROOT/uploads" "$TMP/uploads"; else mkdir -p "$TMP/uploads"; fi
cat > "$TMP/MANIFEST.txt" <<EOF
FMT TBS Dashboard backup
Created: $(date -Is)
Database: SQLite online backup API
Includes: data/fmt_tbs.db + uploads/
EOF
tar -czf "$DEST/fmt-tbs-$STAMP.tar.gz" -C "$TMP" data uploads MANIFEST.txt
find "$DEST" -type f -name 'fmt-tbs-*.tar.gz' -mtime +30 -delete
printf 'Backup created: %s\n' "$DEST/fmt-tbs-$STAMP.tar.gz"
