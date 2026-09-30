#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="/DATA/AppData/fmt_dashboard"; APP="$ROOT/app"; BACKUPS="$ROOT/backups"; TMP="$ROOT/.install_tmp"; TS="$(date +%Y%m%d-%H%M%S)"
CONTAINER="fmt-tbs-dashboard"; DEFAULT_PORT=8096; MAX_PORT=8115; EXPECTED="3.4.0"
log(){ printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail(){ echo; echo "ERROR: $*" >&2; exit 1; }
trap 'rc=$?; if [ $rc -ne 0 ]; then echo; echo "Installer stopped with code $rc" >&2; docker logs --tail 160 "$CONTAINER" 2>/dev/null || true; fi' EXIT
[ "$(id -u)" -eq 0 ] || fail "Run as root."
command -v docker >/dev/null || fail "Docker is not installed."
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null; then COMPOSE=(docker-compose); else fail "Docker Compose is not available."; fi
command -v unzip >/dev/null || { apt-get update -y >/dev/null; apt-get install -y unzip >/dev/null; }
command -v curl >/dev/null || { apt-get update -y >/dev/null; apt-get install -y curl >/dev/null; }
mkdir -p "$ROOT" "$BACKUPS"
ZIP="${1:-}"
if [ -z "$ZIP" ]; then ZIP="$(find "$ROOT" -maxdepth 2 -type f \( -iname '*fmt*3.4*.zip' -o -iname '*fmt*dashboard*.zip' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"; fi
[ -n "$ZIP" ] && [ -f "$ZIP" ] || fail "FMT 3.4 package was not found under $ROOT."
unzip -tq "$ZIP" >/dev/null || fail "ZIP validation failed: $ZIP"
rm -rf "$TMP"; mkdir -p "$TMP/extract"; unzip -q "$ZIP" -d "$TMP/extract"; SRC="$TMP/extract"
if [ "$(find "$SRC" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ]; then ONE="$(find "$SRC" -mindepth 1 -maxdepth 1 | head -1)"; [ -d "$ONE" ] && [ -f "$ONE/docker-compose.yml" ] && SRC="$ONE"; fi
[ -f "$SRC/app/main.py" ] && [ -f "$SRC/docker-compose.yml" ] || fail "Application source is incomplete."
VER="$(tr -d '\r\n ' < "$SRC/VERSION" 2>/dev/null || true)"; [ "$VER" = "$EXPECTED" ] || fail "Expected VERSION $EXPECTED, found '${VER:-missing}'."
grep -q 'app.css?v=3.4.0' "$SRC/app/templates/base.html" || fail "3.4 UI assets are missing."
log "Using package: $ZIP (VERSION $VER)"
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
NEW="$ROOT/app.new-$TS"; cp -a "$SRC" "$NEW"; mkdir -p "$NEW/data" "$NEW/uploads"
if [ -d "$APP" ]; then
  mkdir -p "$BACKUPS/source-$TS"
  [ -f "$APP/data/fmt_tbs.db" ] && cp -a "$APP/data/fmt_tbs.db" "$BACKUPS/fmt_tbs-$TS.db"
  [ -f "$APP/.env" ] && cp -a "$APP/.env" "$NEW/.env"
  rm -rf "$NEW/data" "$NEW/uploads"
  [ -d "$APP/data" ] && mv "$APP/data" "$NEW/data" || mkdir -p "$NEW/data"
  [ -d "$APP/uploads" ] && mv "$APP/uploads" "$NEW/uploads" || mkdir -p "$NEW/uploads"
  mv "$APP" "$BACKUPS/source-$TS/app-old"
fi
mkdir -p "$NEW/uploads/branding" "$NEW/data"
[ -f "$ROOT/bdx.logo" ] && cp -f "$ROOT/bdx.logo" "$NEW/uploads/branding/bdx.logo"
port_in_use(){ local p="$1"; ss -lntH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}$"; }
PORT="$DEFAULT_PORT"; while [ "$PORT" -le "$MAX_PORT" ] && port_in_use "$PORT"; do PORT=$((PORT+1)); done
[ "$PORT" -le "$MAX_PORT" ] || fail "No free port between $DEFAULT_PORT and $MAX_PORT."
ENVFILE="$NEW/.env"; touch "$ENVFILE"
set_env(){ local k="$1" v="$2"; if grep -qE "^${k}=" "$ENVFILE"; then sed -i "s#^${k}=.*#${k}=${v}#" "$ENVFILE"; else echo "${k}=${v}" >> "$ENVFILE"; fi; }
set_env FMT_PORT "$PORT"; set_env FMT_ADMIN_USER admin; set_env FMT_ADMIN_PASSWORD admin; set_env FMT_SESSION_HOURS 12; set_env FMT_MAX_UPLOAD_MB 50; set_env FMT_COOKIE_SECURE 0; chmod 600 "$ENVFILE"
mv "$NEW" "$APP"; cd "$APP"
log "Building FMT Operations Dashboard $EXPECTED..."; "${COMPOSE[@]}" build
log "Starting on host port $PORT..."; "${COMPOSE[@]}" up -d
healthy=0; for _ in $(seq 1 60); do st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)"; [ "$st" = healthy ] && { healthy=1; break; }; sleep 2; done
[ "$healthy" -eq 1 ] || fail "Container did not become healthy."
curl -fsS "http://127.0.0.1:${PORT}/health" | grep -q '"status":"ok"' || fail "Health endpoint failed."
docker exec "$CONTAINER" python -m py_compile /app/app/main.py /app/app/db.py /app/app/auth.py /app/app/services.py || fail "Python compile failed."
docker exec "$CONTAINER" python - <<'PY'
from pathlib import Path
from jinja2 import Environment,FileSystemLoader
p=Path('/app/app/templates'); e=Environment(loader=FileSystemLoader(p))
for f in p.glob('*.html'): e.get_template(f.name)
print('templates-ok')
PY
COOKIE="/tmp/fmt-cookie-$TS"; code="$(curl -sS -o /dev/null -c "$COOKIE" -w '%{http_code}' -X POST -d 'username=admin&password=admin' "http://127.0.0.1:${PORT}/login")"; [ "$code" = 303 ] || fail "Admin login smoke test failed (HTTP $code)."
for route in / /attendance /attendance/upload /attendance/signing /signatures /inventory/assets /inventory/tools /consumables '/tickets?type=Change' /reports /activity /users /roles /settings /profile; do code="$(curl -sS -o /dev/null -b "$COOKIE" -w '%{http_code}' "http://127.0.0.1:${PORT}${route}")"; [ "$code" = 200 ] || fail "Route failed: $route (HTTP $code)"; done
rm -f "$COOKIE"; rm -rf "$TMP"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-192.168.100.110}"
trap - EXIT
echo; echo "============================================================"; echo " FMT OPERATIONS DASHBOARD $EXPECTED — SUCCESS"; echo "============================================================"; echo " URL      : http://${IP}:${PORT}"; echo " Username : admin"; echo " Password : admin"; echo " Status   : HEALTHY + ROUTE TESTS PASSED"; echo "============================================================"
