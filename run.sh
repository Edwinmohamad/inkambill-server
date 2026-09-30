#!/usr/bin/env bash
set -euo pipefail
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${FMT_PORT:-8096}" --workers 1
