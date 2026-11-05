#!/usr/bin/env bash
# Apply only the four billing-period application files. No npm install or DB repair.
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE=b8e14d3fbc99799b0a9327ce0d36dcd18284d205
REVISION=$(git rev-parse "${PERIOD_FIX_REF:-refs/remotes/origin/fix/billing-period-balances}^{commit}")
git merge-base --is-ancestor "$BASE" "$REVISION"
CONTAINER=INKAMBILLING-APP
APP_DIR=$(docker inspect --format '{{.Config.WorkingDir}}' "$CONTAINER")
PROJECT=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")
SERVICE=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER")
APP_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")
OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$CONTAINER")
if [[ "$APP_DIR" != /app || "$SERVICE" != app || -z "$PROJECT" || "$PROJECT" == '<no value>' ]]; then
  echo 'Identitas container/Compose berbeda. Tidak ada perubahan diterapkan.' >&2
  exit 1
fi
if [[ "$APP_IMAGE" == sha256:* || "$APP_IMAGE" == *@* ]]; then
  echo 'Image harus menggunakan tag lokal yang dapat diperbarui.' >&2
  exit 1
fi
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml)
if ! "${COMPOSE[@]}" config --images | grep -Fxq "$APP_IMAGE"; then
  echo 'Image Compose tidak cocok dengan container aktif. Tidak ada perubahan diterapkan.' >&2
  exit 1
fi

FILES=(routes/finance.js routes/closing.js views/finance/cash.ejs views/closing/index.ejs)
mkdir -p work
BACKUP=$(mktemp -d "$PWD/work/period-update.XXXXXX")
STAMP="$(date +%Y%m%d%H%M%S)-$$"
BASE_IMAGE="inkambilling-period-base:$STAMP"
NEW_IMAGE="inkambilling-period-update:$STAMP"
MUTATED=0
rollback() {
  local code=$?
  trap - ERR
  if (( MUTATED )); then
    echo "Deploy gagal. Memulihkan kode dan image sebelumnya dari $BACKUP" >&2
    for path in "${FILES[@]}"; do cp -p "$BACKUP/original/$path" "$path" || true; done
    docker tag "$OLD_IMAGE" "$APP_IMAGE" || true
    "${COMPOSE[@]}" up -d --no-deps --no-build --pull never --force-recreate app || true
  else
    echo "Pemeriksaan gagal; aplikasi belum diubah. Bahan pemeriksaan: $BACKUP" >&2
  fi
  exit "$code"
}
trap rollback ERR

for path in "${FILES[@]}"; do
  [[ -f "$path" && ! -L "$path" ]]
  mkdir -p "$BACKUP/current/$(dirname "$path")" "$BACKUP/base/$(dirname "$path")" "$BACKUP/candidate/$(dirname "$path")" \
    "$BACKUP/merged/$(dirname "$path")" "$BACKUP/original/$(dirname "$path")"
  git show "$BASE:$path" > "$BACKUP/base/$path"
  git show "$REVISION:$path" > "$BACKUP/candidate/$path"
  cp -p "$path" "$BACKUP/original/$path"
  cp -p "$path" "$BACKUP/current/$path"
  if [[ "$path" == views/finance/cash.ejs ]]; then
    # Recognize the exact wording installed by the earlier summary-only script.
    # Normalize only that known edit before the three-way merge.
    docker exec -i "$CONTAINER" node -e \
      'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s.replace("Daftar dan ringkasan pembayaran mengikuti periode tagihan; transaksi tanpa tagihan mengikuti tanggal transaksi. Grafik mengikuti tanggal kas asli.","Daftar pembayaran mengikuti periode tagihan; transaksi tanpa tagihan mengikuti tanggal transaksi. Ringkasan dan grafik mengikuti tanggal kas.")));' \
      < "$path" > "$BACKUP/current/$path"
  fi
  # Preserve compatible manual changes, including the earlier summary-only fix.
  # Conflicts stop the script before any production file or image is changed.
  git merge-file -p "$BACKUP/current/$path" "$BACKUP/base/$path" "$BACKUP/candidate/$path" > "$BACKUP/merged/$path"
  if [[ "$path" == *.js ]]; then
    docker exec -i "$CONTAINER" node --check < "$BACKUP/merged/$path"
  else
    docker exec -i "$CONTAINER" node -e \
      'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>require("ejs").compile(s));' \
      < "$BACKUP/merged/$path"
  fi
done

docker tag "$OLD_IMAGE" "$BASE_IMAGE"
{
  printf 'FROM %s\n' "$BASE_IMAGE"
  for path in "${FILES[@]}"; do printf 'COPY %s /app/%s\n' "$path" "$path"; done
} > "$BACKUP/merged/Dockerfile"
# The build context contains four merged source files plus this tiny Dockerfile.
# The base image is already local; dependencies and all other layers are reused.
docker build --network=none --pull=false -t "$NEW_IMAGE" "$BACKUP/merged"

MUTATED=1
for path in "${FILES[@]}"; do cat "$BACKUP/merged/$path" > "$path"; done
docker tag "$NEW_IMAGE" "$APP_IMAGE"
"${COMPOSE[@]}" up -d --no-deps --no-build --pull never --force-recreate app

HEALTHY=0
for (( attempt=1; attempt<=60; attempt++ )); do
  if docker exec "$CONTAINER" node -e \
    'fetch("http://127.0.0.1:"+(process.env.PORT||3200)+"/healthz",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));' \
    >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 3
done
[[ "$HEALTHY" == 1 ]]
trap - ERR
echo "Selesai: empat file diterapkan; aplikasi sehat. Backup: $BACKUP"
echo "Image sebelumnya tetap tersedia: $BASE_IMAGE"
echo 'Kode host diperbarui; gabungkan PR ke main agar deploy berikutnya mempertahankan revisi ini.'
git status --short -- "${FILES[@]}"
