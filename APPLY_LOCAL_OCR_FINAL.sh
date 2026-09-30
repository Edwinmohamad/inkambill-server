#!/usr/bin/env bash
set -Eeuo pipefail

APP="${APP:-/opt/inkambilling}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/inkambilling-before-local-ocr-${STAMP}.tar.gz"
FULL_TESTS="${FULL_TESTS:-1}"
DEPLOY="${DEPLOY:-0}"

log(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail(){ printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -d "$APP" ]] || fail "APP tidak ditemukan: $APP"
cd "$APP"
for f in app.js services/schemaService.js services/paymentVerificationService.js routes/payments.js views/payments/index.ejs package.json; do
  [[ -f "$f" ]] || fail "File wajib tidak ditemukan: $f"
done
[[ -f "$SELF_DIR/payload/services/proofOcrService.js" ]] || fail "Payload proofOcrService.js tidak ditemukan"
[[ -f "$SELF_DIR/payload/scripts/test-proof-ocr-local.js" ]] || fail "Payload test-proof-ocr-local.js tidak ditemukan"

log "Backup source"
tar --exclude='./node_modules' --exclude='./storage/payment-proofs' --exclude='./.git' -czf "$BACKUP" .
echo "Backup: $BACKUP"

rollback(){
  code=$?
  if [[ $code -ne 0 ]]; then
    echo
    echo "Patch gagal. Source akan dikembalikan dari backup: $BACKUP" >&2
    rm -rf /tmp/inkambill-ocr-restore-${STAMP}
    mkdir -p /tmp/inkambill-ocr-restore-${STAMP}
    tar -xzf "$BACKUP" -C /tmp/inkambill-ocr-restore-${STAMP}
    cp -a /tmp/inkambill-ocr-restore-${STAMP}/. "$APP"/
    echo "ROLLBACK selesai. Tidak ada deploy/restart yang dilakukan." >&2
  fi
  exit $code
}
trap rollback EXIT

log "Pasang service + test OCR lokal"
install -m 0644 "$SELF_DIR/payload/services/proofOcrService.js" services/proofOcrService.js
install -m 0644 "$SELF_DIR/payload/scripts/test-proof-ocr-local.js" scripts/test-proof-ocr-local.js

log "Patch source v1.30"
python3 - <<'PY'
from pathlib import Path
import json, re

ROOT = Path('/opt/inkambilling')
import os
ROOT = Path(os.environ.get('APP','/opt/inkambilling'))

def read(rel): return (ROOT/rel).read_text()
def write(rel, text): (ROOT/rel).write_text(text)
def replace_once(text, old, new, label):
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'Patch point {label} harus 1x, ditemukan {count}x')
    return text.replace(old, new, 1)

def insert_before_once(text, needle, insert, label):
    if insert.strip() in text:
        return text
    count = text.count(needle)
    if count != 1:
        raise SystemExit(f'Patch point {label} harus 1x, ditemukan {count}x')
    return text.replace(needle, insert + needle, 1)

# 1) schemaService.js — tabel baru terisolasi dari legacy payment_proof_scans yang di-drop v57.
p = 'services/schemaService.js'
s = read(p)
if 'async function ensureV59Schema()' not in s:
    marker = '\nmodule.exports = {'
    if marker not in s:
        raise SystemExit('module.exports schemaService tidak ditemukan')
    fn = r'''
async function ensureV59Schema() {
  // Local OCR bukti transfer — 100% lokal, tanpa AI/API eksternal.
  // Tabel baru sengaja TIDAK memakai payment_proof_scans agar tidak terkena cleanup legacy ensureV57Schema().
  await db.query(`CREATE TABLE IF NOT EXISTS payment_proof_ocr (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    payment_id BIGINT UNSIGNED NOT NULL,
    proof_path VARCHAR(255) NULL,
    file_sha256 CHAR(64) NULL,
    status ENUM('queued','processing','done','unavailable','error','skipped') NOT NULL DEFAULT 'queued',
    engine VARCHAR(40) NOT NULL DEFAULT 'tesseract',
    engine_version VARCHAR(120) NULL,
    error_message VARCHAR(500) NULL,
    raw_text MEDIUMTEXT NULL,
    ocr_confidence DECIMAL(5,2) NULL,
    amount_detected DECIMAL(14,2) NULL,
    transfer_at DATETIME NULL,
    transfer_has_time TINYINT(1) NOT NULL DEFAULT 0,
    sender_name VARCHAR(180) NULL,
    sender_bank VARCHAR(100) NULL,
    recipient_name VARCHAR(180) NULL,
    recipient_bank VARCHAR(100) NULL,
    recipient_account VARCHAR(80) NULL,
    ref_no VARCHAR(120) NULL,
    channel VARCHAR(100) NULL,
    transaction_status VARCHAR(30) NULL,
    parsed_json TEXT NULL,
    overall_status ENUM('processing','ok','warning','unreadable') NOT NULL DEFAULT 'processing',
    checks_json TEXT NULL,
    summary VARCHAR(1000) NULL,
    duplicate_payment_ids VARCHAR(255) NULL,
    can_approve TINYINT(1) NOT NULL DEFAULT 1,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_payment_proof_ocr_payment (payment_id),
    INDEX idx_payment_proof_ocr_sha (file_sha256),
    INDEX idx_payment_proof_ocr_ref (ref_no),
    INDEX idx_payment_proof_ocr_queue (status,updated_at),
    INDEX idx_payment_proof_ocr_overall (overall_status)
  )`);
}
'''
    s = s.replace(marker, '\n' + fn + marker, 1)
if 'ensureV59Schema' not in re.search(r'module\.exports\s*=\s*\{[^;]+\};', s, re.S).group(0):
    s = replace_once(s, 'ensureV58Schema };', 'ensureV58Schema, ensureV59Schema };', 'schema export V59')
write(p, s)

# 2) app.js — bootstrap schema + recovery + sweep setiap menit.
p = 'app.js'; s = read(p)
if 'ensureV59Schema' not in s.split('\n', 60)[0:60].__str__():
    s = replace_once(s, 'ensureV58Schema } = require(\'./services/schemaService\');', 'ensureV58Schema, ensureV59Schema } = require(\'./services/schemaService\');', 'app schema import')
ocr_import = "const { runProofOcrSweep, recoverProofOcrOnBoot } = require('./services/proofOcrService');\n"
if ocr_import.strip() not in s:
    schema_line = re.search(r"^const \{ ensureV14Schema.*?schemaService'\);\n", s, re.M)
    if not schema_line:
        raise SystemExit('Baris import schemaService app.js tidak ditemukan')
    s = s[:schema_line.end()] + ocr_import + s[schema_line.end():]
if 'await ensureV59Schema();' not in s:
    s = replace_once(s, '  await ensureV58Schema();\n', '  await ensureV58Schema();\n  await ensureV59Schema();\n  await recoverProofOcrOnBoot();\n', 'app bootstrap V59')
cron_block = """  // OCR lokal: pulihkan antrean dan scan bukti pending yang belum memiliki metadata.\n  cron.schedule('* * * * *', async () => {\n    try { await runProofOcrSweep(); }\n    catch (err) { console.error('Local OCR sweep gagal:', err.message); }\n  });\n\n"""
if "Local OCR sweep gagal" not in s:
    first_cron = re.search(r"^  cron\.schedule\(", s, re.M)
    if not first_cron:
        raise SystemExit('Area cron app.js tidak ditemukan')
    s = s[:first_cron.start()] + cron_block + s[first_cron.start():]
write(p, s)

# 3) paymentVerificationService — mode tanggal OCR opsional, tetap fallback aman.
p = 'services/paymentVerificationService.js'; s = read(p)
old = "    const booking=await resolveBookDate(conn,{mode:bookDateMode,paidAt:p.paid_at,manualDate:manualBookDate});"
new = """    let effectivePaidAt=p.paid_at;\n    let resolvedBookMode=bookDateMode;\n    let resolvedManualDate=manualBookDate;\n    let usedOcrDate=false;\n    if(bookDateMode==='ocr_date'&&['transfer','qris'].includes(p.method)){\n      try{\n        const [ocrRows]=await conn.execute(`SELECT DATE_FORMAT(transfer_at,'%Y-%m-%d %H:%i:%s') transfer_at_text FROM payment_proof_ocr WHERE payment_id=? AND transfer_at IS NOT NULL LIMIT 1`,[p.id]);\n        const ocrAt=ocrRows[0]?.transfer_at_text;\n        if(ocrAt){effectivePaidAt=ocrAt;resolvedBookMode='manual';resolvedManualDate=String(ocrAt).slice(0,10);usedOcrDate=true;}\n        else resolvedBookMode='payment_date';\n      }catch(_){resolvedBookMode='payment_date';}\n    }\n    const booking=await resolveBookDate(conn,{mode:resolvedBookMode,paidAt:effectivePaidAt,manualDate:resolvedManualDate});"""
if 'usedOcrDate' not in s:
    s = replace_once(s, old, new, 'verify booking OCR')
old_sql = "    await conn.execute(`UPDATE payments SET status='confirmed',settlement_status=?,booked_at=?,booked_date_mode=?,verified_by=?,verified_at=NOW() WHERE id=?`,[p.method==='cash'?'held_by_staff':'not_applicable',booking.date,booking.mode,userId,p.id]);"
new_sql = """    await conn.execute(`UPDATE payments SET status='confirmed',settlement_status=?,booked_at=?,booked_date_mode=?,paid_at=?,verified_by=?,verified_at=NOW() WHERE id=?`,[p.method==='cash'?'held_by_staff':'not_applicable',booking.date,booking.mode,effectivePaidAt,userId,p.id]);\n    p.paid_at=effectivePaidAt;p.booked_at=booking.date;p.booked_date_mode=booking.mode;p.ocr_date_used=usedOcrDate;"""
if 'p.ocr_date_used=usedOcrDate' not in s:
    s = replace_once(s, old_sql, new_sql, 'verify update paid_at OCR')
s = s.replace("after:{status:'confirmed',booked_at:booking.date,booked_date_mode:booking.mode}", "after:{status:'confirmed',booked_at:booking.date,booked_date_mode:booking.mode,paid_at:effectivePaidAt,ocr_date_used:usedOcrDate}", 1)
write(p, s)

# 4) routes/payments.js — queue OCR diam-diam + endpoint Master Admin only.
p = 'routes/payments.js'; s = read(p)
ocr_import = "const { queueProofOcr,getPaymentOcrForUi,SCANNABLE_METHODS:OCR_SCANNABLE_METHODS }=require('../services/proofOcrService');\n"
if ocr_import.strip() not in s:
    anchor = "const { PROOF_DIR,saveProofFile,removeProofFile,paymentReference,postCashTransaction,maybeAutoUnisolate,verifyPendingPayment }=require('../services/paymentVerificationService');\n"
    s = replace_once(s, anchor, anchor + ocr_import, 'payments OCR import')
create_anchor = "    await conn.commit();\n    await audit({userId:req.session.user.id,action:'create',entityType:'payment_batch'"
if 'Local OCR queue create gagal' not in s:
    replacement = "    await conn.commit();\n    if(req.file&&OCR_SCANNABLE_METHODS.has(normalizedMethod)){for(const c of created){try{await queueProofOcr(c.paymentId);}catch(err){console.error('Local OCR queue create gagal:',err.message);}}}\n    await audit({userId:req.session.user.id,action:'create',entityType:'payment_batch'"
    s = replace_once(s, create_anchor, replacement, 'payments queue create')
upload_anchor = "    await audit({userId:req.session.user.id,action:'upload_proof',entityType:'payment',entityId:payment.id,description:'Upload/ganti bukti pembayaran',ip:req.ip});\n    req.session.flash={type:'success',message:'Bukti pembayaran berhasil diupload.'};"
if 'Local OCR queue upload gagal' not in s:
    replacement = "    await audit({userId:req.session.user.id,action:'upload_proof',entityType:'payment',entityId:payment.id,description:'Upload/ganti bukti pembayaran',ip:req.ip});\n    if(OCR_SCANNABLE_METHODS.has(payment.method)){try{await queueProofOcr(payment.id);}catch(err){console.error('Local OCR queue upload gagal:',err.message);}}\n    req.session.flash={type:'success',message:'Bukti pembayaran berhasil diupload.'};"
    s = replace_once(s, upload_anchor, replacement, 'payments queue upload')
route_block = r'''
router.get('/:id/proof-validation',requireMasterAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    const item=await getPaymentOcrForUi(req.params.id,{queueIfMissing:true,waitMs:1500});
    res.json({ok:true,item});
  }catch(err){
    console.error('Local OCR validation gagal:',err.message);
    res.json({ok:true,item:{state:'error',overall:'unreadable',canApprove:true,checks:[],summary:'OCR lokal tidak tersedia. Verifikasi manual tetap dapat dilakukan.',error:String(err.message||err).slice(0,300)}});
  }
});

'''
if "router.get('/:id/proof-validation'" not in s:
    s = insert_before_once(s, "router.get('/:id/proof',async(req,res)=>{", route_block, 'proof validation route')
write(p, s)

# 5) payments view — render OCR hanya untuk Master Admin; Admin biasa tidak melihat/menjalankan fetch.
p = 'views/payments/index.ejs'; s = read(p)
view_marker = 'LOCAL_OCR_MASTER_UI_V1'
if view_marker not in s:
    master_ui = r'''

<% if(isMasterAdmin){ %>
<!-- LOCAL_OCR_MASTER_UI_V1 -->
<style>
.local-ocr-card{margin-top:12px;border:1px solid rgba(142,142,147,.24);border-radius:14px;padding:12px;background:rgba(142,142,147,.06)}
.local-ocr-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.local-ocr-head span{font-size:11px;font-weight:800;letter-spacing:.08em;color:#8e8e93}.local-ocr-head strong{font-size:12px}.local-ocr-state-ok{color:#34c759}.local-ocr-state-warning{color:#ff9f0a}.local-ocr-state-processing,.local-ocr-state-unreadable{color:#8e8e93}.local-ocr-list{display:grid;gap:7px;margin:0;padding:0;list-style:none}.local-ocr-list li{display:grid;grid-template-columns:18px 1fr;gap:7px;font-size:12px;line-height:1.35}.local-ocr-list i{margin-top:1px}.local-ocr-list .ok i{color:#34c759}.local-ocr-list .warn i{color:#ff9f0a}.local-ocr-list .info i{color:#8e8e93}.local-ocr-summary{font-size:11px;color:#8e8e93;margin:8px 0 0}.local-ocr-date-note{margin-top:8px;font-size:11px;color:#8e8e93}
</style>
<script>
(()=>{
  const cache=new Map();
  const money=v=>v==null?null:`Rp${Math.round(Number(v)).toLocaleString('id-ID')}`;
  function ensureCard(where,id){
    let card=document.getElementById(id);if(card)return card;
    card=document.createElement('div');card.id=id;card.className='local-ocr-card';card.innerHTML='<div class="local-ocr-head"><span>VALIDASI OCR LOKAL</span><strong data-ocr-state class="local-ocr-state-processing">Memuat…</strong></div><ul class="local-ocr-list" data-ocr-list></ul><p class="local-ocr-summary" data-ocr-summary>OCR hanya membantu verifikasi. Keputusan tetap pada Master Admin.</p>';
    where?.appendChild(card);return card;
  }
  function icon(level){return level==='ok'?'bi-check-circle-fill':level==='warn'?'bi-exclamation-triangle-fill':'bi-info-circle-fill';}
  function render(card,item){
    if(!card)return;const state=card.querySelector('[data-ocr-state]'),list=card.querySelector('[data-ocr-list]'),summary=card.querySelector('[data-ocr-summary]');
    const overall=item?.overall||'unreadable';const labels={ok:'Sesuai',warning:'Perlu dicek',processing:'Sedang membaca',unreadable:'Verifikasi manual'};
    state.textContent=(labels[overall]||'Verifikasi manual')+(item?.confidence!=null?` · OCR ${item.confidence}%`:'');state.className=`local-ocr-state-${overall}`;
    list.replaceChildren();
    const checks=Array.isArray(item?.checks)?item.checks:[];
    if(!checks.length){const li=document.createElement('li');li.className='info';li.innerHTML='<i class="bi bi-info-circle-fill"></i><span>Belum ada hasil OCR. Anda tetap dapat memverifikasi bukti secara manual.</span>';list.appendChild(li);}else checks.forEach(c=>{const li=document.createElement('li');li.className=c.level||'info';const i=document.createElement('i');i.className=`bi ${icon(c.level)}`;const span=document.createElement('span');const b=document.createElement('b');b.textContent=c.label||'Info';span.append(b,document.createTextNode(c.detail?` · ${c.detail}`:''));li.append(i,span);list.appendChild(li);});
    summary.textContent=item?.error?`${item.error} · Approval manual tetap tersedia.`:(item?.summary||'OCR hanya membantu verifikasi. Keputusan tetap pada Master Admin.');
  }
  async function load(id){
    const key=String(id);if(cache.has(key))return cache.get(key);
    const p=fetch(`/payments/${id}/proof-validation`,{headers:{accept:'application/json'},credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();return j.item||{};}).catch(err=>({state:'error',overall:'unreadable',canApprove:true,checks:[],summary:'OCR lokal tidak tersedia. Verifikasi manual tetap dapat dilakukan.',error:err.message}));
    cache.set(key,p);const item=await p;if(['queued','processing'].includes(item?.state))cache.delete(key);else cache.set(key,Promise.resolve(item));return item;
  }
  const proofPanel=()=>{const aside=document.querySelector('#proofViewerModal .proof-meta-panel');if(!aside)return null;const open=document.getElementById('proofOpenNew');let card=document.getElementById('localOcrProofCard');if(!card){card=ensureCard(null,'localOcrProofCard');aside.insertBefore(card,open||null);}return card;};
  document.querySelectorAll('.proof-view-btn').forEach(btn=>btn.addEventListener('click',async()=>{const m=String(btn.dataset.proofUrl||'').match(/\/payments\/(\d+)\/proof/);if(!m)return;const card=proofPanel();render(card,{overall:'processing',checks:[],summary:'Membaca hasil OCR lokal…'});render(card,await load(m[1]));}));

  const approveModal=document.getElementById('paymentApproveModal');const approveBody=approveModal?.querySelector('.modal-body');let approveCard=null;
  if(approveBody){approveCard=ensureCard(null,'localOcrApproveCard');const note=approveBody.querySelector('.secure-file-note');approveBody.insertBefore(approveCard,note||null);}
  const mode=document.getElementById('paymentApproveBookMode');const submit=approveModal?.querySelector('button[type="submit"]');
  function clearOcrDate(){const opt=mode?.querySelector('option[value="ocr_date"]');if(opt)opt.remove();}
  function setButton(item){if(!submit)return;submit.innerHTML=item?.overall==='warning'?'<i class="bi bi-check2-circle"></i>Tetap Approve':'<i class="bi bi-check2-circle"></i>Approve Pembayaran';}
  document.querySelectorAll('.payment-approve-btn').forEach(btn=>btn.addEventListener('click',async()=>{clearOcrDate();setButton(null);if(approveCard)render(approveCard,{overall:'processing',checks:[],summary:'Membaca hasil OCR lokal…'});const item=await load(btn.dataset.paymentId);if(approveCard)render(approveCard,item);setButton(item);if(mode&&item?.transferAt){const date=String(item.transferAt).slice(0,10);if(/^\d{4}-\d{2}-\d{2}$/.test(date)){const opt=document.createElement('option');opt.value='ocr_date';opt.textContent=`Gunakan tanggal bukti OCR · ${date.split('-').reverse().join('/')}`;mode.appendChild(opt);mode.value='ocr_date';}}}));
  approveModal?.addEventListener('hidden.bs.modal',()=>{clearOcrDate();setButton(null);});
})();
</script>
<% } %>
'''
    s = s.rstrip() + master_ui + '\n'
write(p, s)

# 6) package.json test shortcut.
p = 'package.json'
data = json.loads(read(p))
data.setdefault('scripts', {})['test:proof-ocr-local'] = 'node scripts/test-proof-ocr-local.js'
write(p, json.dumps(data, ensure_ascii=False, indent=2) + '\n')

# 7) Dockerfile — install Tesseract in FINAL stage, if a conventional Debian/Alpine image is used.
docker = ROOT/'Dockerfile'
if docker.exists():
    s = docker.read_text()
    if 'tesseract-ocr' not in s:
        lines = s.splitlines()
        from_idx = [i for i,l in enumerate(lines) if re.match(r'^\s*FROM\s+', l, re.I)]
        if from_idx:
            i = from_idx[-1]
            base = lines[i].lower()
            if 'alpine' in base:
                install = 'RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-ind'
            elif any(x in base for x in ['node:', 'debian', 'bookworm', 'bullseye', 'trixie', 'ubuntu']):
                install = 'RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ind && rm -rf /var/lib/apt/lists/*'
            else:
                install = None
            if install:
                lines.insert(i+1, install)
                docker.write_text('\n'.join(lines)+'\n')
                print('Dockerfile: Tesseract install ditambahkan ke final stage')
            else:
                print('WARNING: base image Dockerfile tidak dikenali; OCR akan fallback manual jika tesseract tidak tersedia')
else:
    print('WARNING: Dockerfile tidak ditemukan; pastikan tesseract terpasang pada runtime Node.js')

print('PATCH SOURCE: OK')
PY

log "Syntax check"
node --check services/proofOcrService.js
node --check services/paymentVerificationService.js
node --check routes/payments.js
node --check services/schemaService.js
node --check app.js

log "Unit test OCR lokal"
node scripts/test-proof-ocr-local.js

log "Static validation aplikasi"
npm run check
node scripts/validate-static.js

if [[ "$FULL_TESTS" == "1" ]]; then
  log "Regression suite existing"
  npm run test:dashboard-billing
  npm run test:pppoe-smart-sync
  npm run test:network-suite
  npm run test:fasum
  npm run validate:final
fi

log "Audit keamanan OCR"
! grep -RniE 'ANTHROPIC_API_KEY|PROOF_SCAN_API_KEY|openai|claude|gemini' services/proofOcrService.js routes/payments.js views/payments/index.ejs || fail "Masih ada referensi AI/API pada implementasi OCR lokal"
grep -q "canApprove: true" services/proofOcrService.js || fail "Guard advisory canApprove=true tidak ditemukan"
grep -q "requireMasterAdmin" routes/payments.js || fail "Master Admin guard tidak ditemukan"
grep -q "LOCAL_OCR_MASTER_UI_V1" views/payments/index.ejs || fail "UI Master Admin OCR tidak terpasang"

log "Patch berhasil dan lolos validasi"
echo "Backup       : $BACKUP"
echo "OCR service  : services/proofOcrService.js"
echo "OCR table    : payment_proof_ocr"
echo "AI/API       : TIDAK DIPAKAI"
echo "Approval     : advisory only; mismatch tidak memblokir"
echo "Admin biasa  : UI OCR tidak dirender"
echo "Master Admin : OCR tampil saat Lihat Bukti / Approve"

if [[ -f Dockerfile ]]; then
  echo
  echo "Dockerfile sudah disiapkan untuk Tesseract bila base image Debian/Alpine dikenali."
fi

if [[ "$DEPLOY" == "1" ]]; then
  log "Deploy Docker"
  if [[ -f compose.yml || -f compose.yaml || -f docker-compose.yml || -f docker-compose.yaml ]]; then
    docker compose build
    docker compose up -d
    docker compose ps
  else
    fail "DEPLOY=1 tetapi compose file tidak ditemukan"
  fi
else
  echo
  echo "Belum restart/deploy. Setelah review:"
  echo "  cd $APP"
  echo "  docker compose build"
  echo "  docker compose up -d"
  echo "  docker compose ps"
  echo
  echo "Atau satu langkah: DEPLOY=1 APP=$APP bash $SELF_DIR/APPLY_LOCAL_OCR_FINAL.sh"
fi

trap - EXIT
