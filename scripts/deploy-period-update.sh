#!/usr/bin/env bash
# Apply changed billing/PPPoE source and remove retired monitoring code. No npm install or historical data deletion.
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

FILES=(routes/settings.js views/settings/index.ejs routes/finance.js routes/closing.js routes/reports.js routes/payments.js routes/invoices.js views/finance/cash.ejs views/closing/index.ejs views/reports/index.ejs services/financialControlService.js services/paymentVerificationService.js app.js services/accountingPeriodSchema.js services/closingLedgerService.js services/closingSyncService.js services/financialIntegrityService.js services/reportPdf.js services/closingPdfText.js routes/nms.js routes/network.js routes/n8n.js services/nms/inventory.js services/nms/fasum.js services/nms/insights.js public/js/nms-common.js public/js/nms-secrets.js public/js/nms-insights.js public/js/pppoe-history.js views/nms/_bar.ejs views/nms/secrets.ejs views/nms/insights.ejs views/nms/sync-history.ejs views/partials/layout.ejs views/dashboard/index.ejs)
DELETED=(services/nms/poller.js services/nms/dashboard.js services/nms/widgets.js services/nmsTelemetryService.js services/networkInfrastructureService.js services/networkWorkspaceService.js services/networkAlertService.js routes/monitoring.js views/nms/dashboard.ejs views/nms/wall.ejs views/nms/automation.ejs views/network/workspace.ejs views/network/infrastructure.ejs views/network/tools.ejs views/monitoring/index.ejs public/js/nms.js public/js/nms-wall.js public/js/nms-noc.js public/js/nms-layout.js public/js/nms-mascot.js public/js/nms-automation.js public/js/network-control-center.js public/js/network-infrastructure.js public/js/monitoring.js public/css/nms-wall.css public/css/network-workspace.css public/css/network-infrastructure.css public/css/monitoring.css)
mkdir -p work
# Repeated deployments use the last applied revision as merge base, so adding
# widgets after the period fix does not conflict with that earlier revision.
if [[ -f work/period-update.applied ]]; then
  APPLIED=$(cat work/period-update.applied)
  if [[ "$APPLIED" =~ ^[0-9a-f]{40}$ ]] && git merge-base --is-ancestor "$BASE" "$APPLIED" && git merge-base --is-ancestor "$APPLIED" "$REVISION"; then
    BASE=$APPLIED
  fi
else
  # Older copies of this installer did not record their revision. Recognize
  # their exact changed-file source tree without guessing about manual edits.
  while IFS= read -r PREVIOUS; do
    MATCH=1
    for path in "${FILES[@]}"; do
      if ! git cat-file -e "$PREVIOUS:$path" 2>/dev/null; then
        if [[ -e "$path" ]]; then MATCH=0; break; else continue; fi
      fi
      if ! git show "$PREVIOUS:$path" | cmp -s - "$path"; then MATCH=0; break; fi
    done
    if (( MATCH )); then BASE=$PREVIOUS; break; fi
  done < <(git rev-list "$BASE..$REVISION")
fi
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
    for path in "${FILES[@]}"; do
      if [[ -f "$BACKUP/original-missing/$path" ]]; then rm -f -- "$path" || true;
      else cp -p "$BACKUP/original/$path" "$path" || true; fi
    done
    for path in "${DELETED[@]}"; do if [[ -f "$BACKUP/deleted-original/$path" ]]; then cp -p "$BACKUP/deleted-original/$path" "$path" || true; fi; done
    docker tag "$OLD_IMAGE" "$APP_IMAGE" || true
    "${COMPOSE[@]}" up -d --no-deps --no-build --pull never --force-recreate app || true
  else
    echo "Pemeriksaan gagal; aplikasi belum diubah. Bahan pemeriksaan: $BACKUP" >&2
  fi
  exit "$code"
}
trap rollback ERR

for path in "${FILES[@]}"; do
  [[ ! -L "$path" ]]
  mkdir -p "$BACKUP/current/$(dirname "$path")" "$BACKUP/base/$(dirname "$path")" "$BACKUP/candidate/$(dirname "$path")" \
    "$BACKUP/merged/$(dirname "$path")" "$BACKUP/original/$(dirname "$path")"
  if git cat-file -e "$BASE:$path" 2>/dev/null; then
    git show "$BASE:$path" > "$BACKUP/base/$path"
    [[ -f "$path" ]]
  else
    : > "$BACKUP/base/$path"
  fi
  git show "$REVISION:$path" > "$BACKUP/candidate/$path"
  if [[ -f "$path" ]]; then
    cp -p "$path" "$BACKUP/original/$path"
    cp -p "$path" "$BACKUP/current/$path"
  else
    mkdir -p "$BACKUP/original-missing/$(dirname "$path")"
    : > "$BACKUP/original-missing/$path"
    : > "$BACKUP/current/$path"
  fi
  if [[ "$path" == routes/finance.js && "$BASE" == b8e14d3fbc99799b0a9327ce0d36dcd18284d205 ]]; then
    # Recognize the exact summary-only patch supplied before this PR. Its SQL
    # occupies one line, so normalize that known edit before merging new fields.
    BASE_SUMMARY=$(sed -n '/const summarySql=/p' "$BACKUP/base/$path")
    docker exec -i "$CONTAINER" node -e \
      'const base=process.argv[1];const known=base.replace("WHERE ct.internal_transfer_key IS NULL","LEFT JOIN invoices summary_invoice ON summary_invoice.id=source_payment.invoice_id WHERE ct.internal_transfer_key IS NULL").replace("AND MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=?","AND COALESCE(summary_invoice.period_month,MONTH(ct.transaction_date))=? AND COALESCE(summary_invoice.period_year,YEAR(ct.transaction_date))=?");let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s.split("\n").map(line=>line===known?base:line).join("\n")));' \
      "$BASE_SUMMARY" < "$path" > "$BACKUP/current/$path"
  fi
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

for path in "${DELETED[@]}"; do
  [[ ! -L "$path" ]]
  if [[ -f "$path" ]]; then mkdir -p "$BACKUP/deleted-original/$(dirname "$path")"; cp -p "$path" "$BACKUP/deleted-original/$path"; fi
done

docker tag "$OLD_IMAGE" "$BASE_IMAGE"
{
  printf 'FROM %s\n' "$BASE_IMAGE"
  for path in "${FILES[@]}"; do printf 'COPY %s /app/%s\n' "$path" "$path"; done
  printf 'RUN rm -f'; for path in "${DELETED[@]}"; do printf ' /app/%s' "$path"; done; printf '\n'
} > "$BACKUP/merged/Dockerfile"
# The build context contains only the merged source files plus this tiny Dockerfile.
# The base image is already local; dependencies and all other layers are reused. Startup adds a nullable accounting_period column; existing dates/amounts are untouched.
docker build --network=none --pull=false -t "$NEW_IMAGE" "$BACKUP/merged"

MUTATED=1
for path in "${FILES[@]}"; do cat "$BACKUP/merged/$path" > "$path"; done
for path in "${DELETED[@]}"; do rm -f -- "$path"; done
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
printf '%s\n' "$REVISION" > work/period-update.applied
trap - ERR
echo "Selesai: file revisi periode diterapkan; aplikasi sehat. Backup: $BACKUP"
echo "Image sebelumnya tetap tersedia: $BASE_IMAGE"
echo 'Kode host diperbarui; gabungkan PR ke main agar deploy berikutnya mempertahankan revisi ini.'
git status --short -- "${FILES[@]}"
