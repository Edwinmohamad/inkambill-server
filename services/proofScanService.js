// v1.29 — Antrean & orkestrasi pembacaan bukti transfer.
// Alur: upload bukti -> queueProofScan() -> diproses di background (tidak memblokir upload) ->
//   hash file + perceptual hash (lokal) -> AI vision (opsional) -> evaluateProof() -> simpan hasil.
// Hasil dipakai halaman Approval (badge + catatan) dan dijadikan pengaman saat approve.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const { hammingHex, analyzeImageAsync, detectMime } = require('./proofImageService');
const { extractTransferProof, DEFAULT_MODEL } = require('./proofAiService');
const { evaluateProof, normalizeName, normalizeRef, NEEDS_REASON } = require('./proofMatchService');
const { decrypt } = require('./cryptoService');

const PROOF_DIR = path.join(__dirname, '..', 'storage', 'payment-proofs');
const SCANNABLE_METHODS = new Set(['transfer', 'qris']);
const MAX_ATTEMPTS = 3;
// Jarak Hamming dHash (dari 256 bit). Kompres ulang WhatsApp biasanya 0-3; screenshot bank berbeda
// dengan layout sama bisa ~10, jadi 'mirip' tanpa data pendukung dibatasi ketat.
const PHASH_SIMILAR = 4;
const PHASH_CONFIRMED = 8;
const PHASH_LOOKBACK_DAYS = 400;

let running = false;
let rerunRequested = false;

async function getScanSettings(conn = db) {
  let row = {};
  try {
    const [[r]] = await conn.query(`SELECT proof_scan_enabled,proof_scan_model,proof_scan_api_key_enc,proof_scan_amount_tolerance,proof_scan_recipient_names,proof_scan_max_date_diff_days FROM settings WHERE id=1 LIMIT 1`);
    row = r || {};
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  let dbKey = '';
  if (row.proof_scan_api_key_enc) {
    try { dbKey = decrypt(row.proof_scan_api_key_enc); } catch (_) { dbKey = ''; }
  }
  const envKey = String(process.env.PROOF_SCAN_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
  const apiKey = dbKey || envKey;
  return {
    enabled: row.proof_scan_enabled === undefined || row.proof_scan_enabled === null ? true : Number(row.proof_scan_enabled) === 1,
    model: String(row.proof_scan_model || process.env.PROOF_SCAN_MODEL || DEFAULT_MODEL).trim(),
    apiKey,
    apiKeySource: dbKey ? 'settings' : envKey ? 'env' : '',
    tolerance: Math.max(0, Number(row.proof_scan_amount_tolerance || 0)),
    maxDateDiffDays: Math.max(1, Number(row.proof_scan_max_date_diff_days || 3)),
    recipientNames: String(row.proof_scan_recipient_names || '').split(/[,\n;]/).map(s => s.trim()).filter(Boolean)
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function batchPrefix(idempotencyKey) {
  const key = String(idempotencyKey || '');
  const i = key.lastIndexOf(':');
  return i > 0 ? key.slice(0, i) : null;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, m => `\\${m}`);
}

async function readProof(filename) {
  if (!filename) return null;
  try { return await fs.promises.readFile(path.join(PROOF_DIR, path.basename(filename))); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// Dipanggil setelah bukti transfer/QRIS tersimpan (baru atau diganti). Tidak pernah melempar error
// ke pemanggil: kegagalan scan tidak boleh menggagalkan upload bukti.
async function queueProofScan(paymentId, { kick = true } = {}) {
  try {
    const [rows] = await db.execute(`SELECT id,method,proof_path FROM payments WHERE id=? LIMIT 1`, [paymentId]);
    const p = rows[0];
    if (!p || !p.proof_path || !SCANNABLE_METHODS.has(p.method)) return false;
    const buffer = await readProof(p.proof_path);
    const hash = buffer ? sha256(buffer) : null;
    await db.execute(`INSERT INTO payment_proof_scans(payment_id,proof_path,file_sha256,status,attempts,next_attempt_at,overall_status,ai_status)
      VALUES(?,?,?,'queued',0,NOW(),'processing','pending')
      ON DUPLICATE KEY UPDATE proof_path=VALUES(proof_path),file_sha256=VALUES(file_sha256),phash=NULL,status='queued',attempts=0,next_attempt_at=NOW(),started_at=NULL,
        overall_status='processing',ai_status='pending',ai_error=NULL,is_transfer_proof=NULL,transaction_status=NULL,amount_detected=NULL,amount_confidence=NULL,total_charged=NULL,
        transfer_at=NULL,transfer_has_time=0,sender_name=NULL,sender_name_norm=NULL,sender_bank=NULL,sender_account=NULL,recipient_name=NULL,recipient_bank=NULL,recipient_account=NULL,
        ref_no=NULL,ref_no_norm=NULL,channel=NULL,ai_notes=NULL,raw_json=NULL,checks_json=NULL,summary=NULL,expected_amount=NULL,duplicate_payment_ids=NULL,
        override_reason=NULL,override_by=NULL,override_at=NULL`, [p.id, p.proof_path, hash]);
    if (kick) kickProcessor();
    return true;
  } catch (err) {
    console.error('Proof scan: gagal antre pembayaran', paymentId, err.message);
    return false;
  }
}

function kickProcessor() {
  setImmediate(() => { processQueue().catch(err => console.error('Proof scan processor gagal:', err.message)); });
}

async function processQueue({ limit = 25 } = {}) {
  if (running) { rerunRequested = true; return { processed: 0, busy: true }; }
  running = true;
  let processed = 0;
  try {
    do {
      rerunRequested = false;
      while (processed < limit) {
        const [rows] = await db.query(`SELECT id FROM payment_proof_scans WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()) ORDER BY next_attempt_at,id LIMIT 1`);
        if (!rows.length) break;
        const [claim] = await db.execute(`UPDATE payment_proof_scans SET status='processing',started_at=NOW() WHERE id=? AND status='queued'`, [rows[0].id]);
        if (!claim.affectedRows) continue;
        await runScan(rows[0].id);
        processed++;
      }
    } while (rerunRequested && processed < limit);
  } finally {
    running = false;
  }
  return { processed };
}

function extractionColumns(data) {
  return {
    is_transfer_proof: data.isTransferProof === null ? null : data.isTransferProof ? 1 : 0,
    transaction_status: data.transactionStatus,
    amount_detected: data.amount,
    amount_confidence: data.amountConfidence,
    total_charged: data.totalCharged,
    transfer_at: data.transferAt,
    transfer_has_time: data.transferHasTime ? 1 : 0,
    sender_name: data.senderName,
    sender_name_norm: normalizeName(data.senderName) || null,
    sender_bank: data.senderBank,
    sender_account: data.senderAccount,
    recipient_name: data.recipientName,
    recipient_bank: data.recipientBank,
    recipient_account: data.recipientAccount,
    ref_no: data.referenceNumber,
    ref_no_norm: normalizeRef(data.referenceNumber),
    channel: data.channel,
    ai_notes: data.notes
  };
}

const COPY_COLUMNS = ['is_transfer_proof', 'transaction_status', 'amount_detected', 'amount_confidence', 'total_charged', 'transfer_at', 'transfer_has_time', 'sender_name', 'sender_name_norm', 'sender_bank', 'sender_account', 'recipient_name', 'recipient_bank', 'recipient_account', 'ref_no', 'ref_no_norm', 'channel', 'ai_notes', 'raw_json', 'ai_model'];

async function runScan(scanId) {
  const [rows] = await db.execute(`SELECT ps.*,p.method,p.proof_mime FROM payment_proof_scans ps JOIN payments p ON p.id=ps.payment_id WHERE ps.id=? LIMIT 1`, [scanId]);
  const scan = rows[0];
  if (!scan) return;
  try {
    const buffer = await readProof(scan.proof_path);
    if (!buffer) {
      await db.execute(`UPDATE payment_proof_scans SET status='done',ai_status='skipped',ai_error=? WHERE id=?`, ['File bukti tidak ditemukan di storage.', scanId]);
      await reevaluatePayment(scan.payment_id);
      return;
    }
    const hash = sha256(buffer);
    const settings = await getScanSettings();
    const mime = detectMime(buffer, scan.proof_mime);
    const [reuse] = await db.execute(`SELECT * FROM payment_proof_scans WHERE file_sha256=? AND id<>? AND ai_status='done' ORDER BY updated_at DESC LIMIT 1`, [hash, scanId]);
    const needAi = settings.enabled && !!settings.apiKey && mime !== 'application/pdf' && !reuse.length;
    // Decode/resize dijalankan di worker thread (tidak memblokir request lain).
    const analysis = mime === 'application/pdf' ? { phash: null, prepared: null } : await analyzeImageAsync(buffer, mime, { forAi: needAi });
    await db.execute(`UPDATE payment_proof_scans SET file_sha256=?,phash=? WHERE id=?`, [hash, analysis.phash || reuse[0]?.phash || null, scanId]);

    if (mime === 'application/pdf') {
      await db.execute(`UPDATE payment_proof_scans SET status='done',ai_status='skipped',ai_error=? WHERE id=?`, ['Bukti PDF tidak dibaca otomatis (hanya gambar JPG/PNG/WEBP).', scanId]);
    } else if (!settings.enabled || !settings.apiKey) {
      await db.execute(`UPDATE payment_proof_scans SET status='done',ai_status='disabled',ai_error=NULL WHERE id=?`, [scanId]);
    } else {
      // Satu file yang sama (mis. 1 transfer untuk beberapa faktur) cukup dibaca AI sekali.
      if (reuse.length) {
        const src = reuse[0];
        await db.execute(`UPDATE payment_proof_scans SET ${COPY_COLUMNS.map(c => `${c}=?`).join(',')},status='done',ai_status='done',ai_error=NULL WHERE id=?`, [...COPY_COLUMNS.map(c => src[c] ?? null), scanId]);
      } else {
        try {
          if (!analysis.prepared) { const e = new Error(analysis.prepareError || 'Gambar bukti tidak dapat diproses.'); e.retryable = false; throw e; }
          const prepared = analysis.prepared;
          const result = await extractTransferProof({ base64: prepared.base64, mime: prepared.mime, apiKey: settings.apiKey, model: settings.model });
          const cols = extractionColumns(result.data);
          const keys = Object.keys(cols);
          await db.execute(`UPDATE payment_proof_scans SET ${keys.map(k => `${k}=?`).join(',')},raw_json=?,ai_model=?,status='done',ai_status='done',ai_error=NULL WHERE id=?`,
            [...keys.map(k => cols[k] ?? null), JSON.stringify(result.raw).slice(0, 60000), String(result.model).slice(0, 80), scanId]);
        } catch (err) {
          const attempts = Number(scan.attempts || 0) + 1;
          const message = String(err.message || err).slice(0, 480);
          if (err.retryable && attempts < MAX_ATTEMPTS) {
            await db.execute(`UPDATE payment_proof_scans SET status='queued',attempts=?,ai_status='error',ai_error=?,next_attempt_at=DATE_ADD(NOW(),INTERVAL ? MINUTE) WHERE id=?`, [attempts, message, attempts * 2, scanId]);
            await reevaluatePayment(scan.payment_id, { keepProcessing: true });
            return;
          }
          await db.execute(`UPDATE payment_proof_scans SET status='done',attempts=?,ai_status='error',ai_error=? WHERE id=?`, [attempts, message, scanId]);
        }
      }
    }
    const result = await reevaluatePayment(scan.payment_id);
    // Pasangan duplikat yang masih menunggu approval ikut dievaluasi ulang supaya keduanya ditandai.
    for (const other of result?.duplicateIds || []) await reevaluatePayment(other, { onlyPending: true });
  } catch (err) {
    console.error('Proof scan gagal untuk scan', scanId, err.message);
    await db.execute(`UPDATE payment_proof_scans SET status='done',ai_status='error',ai_error=? WHERE id=?`, [String(err.message).slice(0, 480), scanId]).catch(() => {});
    await reevaluatePayment(scan.payment_id).catch(() => {});
  }
}

async function findGroup(conn, payment, scan) {
  const prefix = batchPrefix(payment.idempotency_key);
  if (!prefix || !scan.file_sha256) return [{ id: payment.id, amount: payment.amount }];
  const [rows] = await conn.execute(`SELECT p.id,p.amount FROM payments p JOIN payment_proof_scans ps ON ps.payment_id=p.id
    WHERE p.idempotency_key LIKE ? AND ps.file_sha256=? AND (p.status<>'failed' OR p.id=?)`, [`${escapeLike(prefix)}:%`, scan.file_sha256, payment.id]);
  return rows.length ? rows : [{ id: payment.id, amount: payment.amount }];
}

async function findDuplicates(conn, payment, scan, groupIds) {
  const exclude = new Set(groupIds.map(Number));
  const found = new Map();
  const push = (row, reason, strength) => {
    if (exclude.has(Number(row.payment_id))) return;
    if (row.status === 'failed' && Number(row.invoice_id) === Number(payment.invoice_id)) return; // ajukan ulang setelah ditolak
    const prev = found.get(row.payment_id);
    if (prev && prev.strength === 'strong') { if (!prev.reasons.includes(reason)) prev.reasons.push(reason); return; }
    found.set(row.payment_id, { payment_id: row.payment_id, reference: row.reference, customer_name: row.customer_name, same_customer: Number(row.customer_id) === Number(payment.customer_id), status: row.status, strength, reasons: prev ? [...prev.reasons, reason] : [reason] });
  };
  const base = `SELECT ps.payment_id,ps.phash,ps.amount_detected,ps.ref_no_norm,ps.transfer_at,ps.transfer_has_time,ps.sender_name_norm,p.reference,p.status,p.invoice_id,c.id customer_id,c.name customer_name
    FROM payment_proof_scans ps JOIN payments p ON p.id=ps.payment_id JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE ps.payment_id<>?`;
  if (scan.file_sha256) {
    const [rows] = await conn.execute(`${base} AND ps.file_sha256=?`, [payment.id, scan.file_sha256]);
    rows.forEach(r => push(r, 'file identik', 'strong'));
  }
  if (scan.ref_no_norm) {
    const [rows] = await conn.execute(`${base} AND ps.ref_no_norm=?`, [payment.id, scan.ref_no_norm]);
    rows.forEach(r => push(r, 'no. referensi sama', 'strong'));
  }
  if (scan.amount_detected && scan.transfer_has_time && scan.transfer_at && scan.sender_name_norm) {
    const [rows] = await conn.execute(`${base} AND ps.amount_detected=? AND ps.transfer_at=? AND ps.transfer_has_time=1 AND ps.sender_name_norm=?`, [payment.id, scan.amount_detected, scan.transfer_at, scan.sender_name_norm]);
    rows.forEach(r => push(r, 'nominal, jam & pengirim sama', 'strong'));
  }
  if (scan.phash) {
    const [rows] = await conn.execute(`${base} AND ps.phash IS NOT NULL AND ps.created_at>=DATE_SUB(NOW(),INTERVAL ${PHASH_LOOKBACK_DAYS} DAY) ORDER BY ps.id DESC LIMIT 5000`, [payment.id]);
    for (const r of rows) {
      const distance = hammingHex(scan.phash, r.phash);
      if (distance > PHASH_CONFIRMED) continue;
      // Screenshot bank yang berbeda bisa berlayout mirip. Anggap sama hanya jika data yang
      // terbaca tidak saling bertentangan.
      const conflict = (scan.ref_no_norm && r.ref_no_norm && scan.ref_no_norm !== r.ref_no_norm)
        || (scan.amount_detected && r.amount_detected && Number(scan.amount_detected) !== Number(r.amount_detected))
        || (scan.transfer_at && r.transfer_at && new Date(scan.transfer_at).getTime() !== new Date(r.transfer_at).getTime());
      if (conflict) continue;
      const bothRead = !!(scan.amount_detected && r.amount_detected && ((scan.ref_no_norm && r.ref_no_norm) || (scan.transfer_has_time && r.transfer_has_time)));
      if (bothRead) push(r, 'gambar sama (kompres ulang)', 'strong');
      else if (distance <= PHASH_SIMILAR) push(r, 'gambar hampir identik', 'similar');
    }
  }
  return [...found.values()].map(d => ({ ...d, reason: d.reasons[0] }));
}

// Menghitung ulang hasil cek dari data tersimpan (tanpa memanggil AI).
async function evaluatePayment(conn, paymentId) {
  const [rows] = await conn.execute(`SELECT ps.*,p.id pid,p.method,p.amount,p.paid_at,p.bank_name,p.idempotency_key,p.invoice_id,p.status payment_status,c.id customer_id,c.name customer_name
    FROM payment_proof_scans ps JOIN payments p ON p.id=ps.payment_id JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE ps.payment_id=? LIMIT 1`, [paymentId]);
  const scan = rows[0];
  if (!scan) return null;
  const payment = { id: scan.pid, method: scan.method, amount: Number(scan.amount), paid_at: scan.paid_at, bank_name: scan.bank_name, idempotency_key: scan.idempotency_key, invoice_id: scan.invoice_id, customer_id: scan.customer_id, customer_name: scan.customer_name, status: scan.payment_status };
  const settings = await getScanSettings(conn);
  const group = await findGroup(conn, payment, scan);
  const expectedAmount = group.reduce((a, g) => a + Number(g.amount || 0), 0);
  const duplicates = await findDuplicates(conn, payment, scan, group.map(g => g.id));
  const [banks] = await conn.query(`SELECT bank_name,account_name,account_number FROM banks WHERE is_active=1`);
  const [aliasRows] = await conn.execute(`SELECT payer_name FROM customer_payer_aliases WHERE customer_id=?`, [payment.customer_id]);
  const aiState = ['done', 'disabled', 'error', 'skipped'].includes(scan.ai_status) ? scan.ai_status : 'error';
  const evaluation = evaluateProof({ scan, payment, expectedAmount, groupCount: group.length, banks, recipientNames: settings.recipientNames, aliases: aliasRows.map(a => a.payer_name), duplicates, settings, aiState, aiError: scan.ai_error });
  return { scan, payment, evaluation, expectedAmount, duplicates };
}

async function reevaluatePayment(paymentId, { keepProcessing = false, onlyPending = false, conn = db } = {}) {
  const result = await evaluatePayment(conn, paymentId);
  if (!result) return null;
  if (onlyPending && result.payment.status !== 'pending') return null;
  const { evaluation, expectedAmount, duplicates } = result;
  const overall = keepProcessing ? 'processing' : evaluation.overall;
  await conn.execute(`UPDATE payment_proof_scans SET overall_status=?,checks_json=?,summary=?,expected_amount=?,duplicate_payment_ids=? WHERE payment_id=?`, [
    overall, JSON.stringify(evaluation.checks), evaluation.summary, expectedAmount, duplicates.map(d => d.payment_id).join(',').slice(0, 250) || null, paymentId
  ]);
  return { ...result, overall, duplicateIds: duplicates.map(d => d.payment_id) };
}

async function reevaluateCustomerPending(customerId) {
  const [rows] = await db.execute(`SELECT ps.payment_id FROM payment_proof_scans ps JOIN payments p ON p.id=ps.payment_id JOIN invoices i ON i.id=p.invoice_id
    WHERE i.customer_id=? AND p.status='pending' AND ps.status='done'`, [customerId]);
  for (const r of rows) await reevaluatePayment(r.payment_id);
  return rows.length;
}

// Pengaman approval (dipanggil di dalam transaksi verify). Mengembalikan status terkini dan
// menolak approve tanpa alasan bila hasil cek bermasalah.
async function approvalGate(conn, payment, { reason = '', actorUserId = null } = {}) {
  if (!SCANNABLE_METHODS.has(payment.method) || !payment.proof_path) return { status: null };
  const [rows] = await conn.execute(`SELECT id,status,overall_status FROM payment_proof_scans WHERE payment_id=? LIMIT 1`, [payment.id]);
  if (!rows.length) return { status: null };
  let status = rows[0].overall_status;
  let summary = '';
  if (rows[0].status === 'done') {
    const fresh = await evaluatePayment(conn, payment.id);
    if (fresh) {
      status = fresh.evaluation.overall;
      summary = fresh.evaluation.summary;
      await conn.execute(`UPDATE payment_proof_scans SET overall_status=?,checks_json=?,summary=? WHERE id=?`, [status, JSON.stringify(fresh.evaluation.checks), summary, rows[0].id]);
    }
  }
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (NEEDS_REASON.has(status)) {
    if (cleanReason.length < 5) {
      const label = status === 'mismatch' ? 'TIDAK COCOK' : 'PERLU DICEK';
      const err = new Error(`Hasil pembacaan bukti ${label}: ${summary || 'cek detail bukti'} Isi alasan approval (min. 5 karakter) bila tetap ingin menyetujui.`);
      err.proofScanBlocked = true;
      throw err;
    }
    await conn.execute(`UPDATE payment_proof_scans SET override_reason=?,override_by=?,override_at=NOW() WHERE id=?`, [cleanReason, actorUserId, rows[0].id]);
  }
  return { status, summary, overridden: NEEDS_REASON.has(status), reason: cleanReason };
}

async function saveCustomerPayerAlias(conn, { customerId, payerName, userId }) {
  const norm = normalizeName(payerName);
  if (!customerId || !norm || norm.length < 3) return false;
  await conn.execute(`INSERT IGNORE INTO customer_payer_aliases(customer_id,payer_name,payer_name_norm,created_by) VALUES(?,?,?,?)`, [customerId, String(payerName).trim().slice(0, 150), norm.slice(0, 150), userId || null]);
  return true;
}

async function loadScansForPayments(paymentIds) {
  const ids = [...new Set((paymentIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const [rows] = await db.query(`SELECT payment_id,status,overall_status,ai_status,ai_error,summary,checks_json,amount_detected,transfer_at,transfer_has_time,sender_name,sender_bank,recipient_name,recipient_account,recipient_bank,ref_no,channel,expected_amount,override_reason,updated_at
    FROM payment_proof_scans WHERE payment_id IN (${ids.map(() => '?').join(',')})`, ids);
  const map = new Map();
  for (const r of rows) {
    let checks = [];
    try { checks = r.checks_json ? JSON.parse(r.checks_json) : []; } catch (_) { checks = []; }
    const senderCheck = checks.find(c => c.key === 'sender');
    map.set(Number(r.payment_id), {
      state: r.status,
      overall: r.status === 'done' ? r.overall_status : 'processing',
      aiStatus: r.ai_status,
      aiError: r.ai_error,
      summary: r.summary || '',
      checks,
      amount: r.amount_detected === null ? null : Number(r.amount_detected),
      expectedAmount: r.expected_amount === null ? null : Number(r.expected_amount),
      transferAt: r.transfer_at,
      transferHasTime: !!r.transfer_has_time,
      sender: r.sender_name,
      senderBank: r.sender_bank,
      recipient: [r.recipient_name, r.recipient_bank, r.recipient_account].filter(Boolean).join(' · '),
      ref: r.ref_no,
      channel: r.channel,
      overrideReason: r.override_reason,
      aliasSuggest: !!(r.sender_name && senderCheck && senderCheck.level === 'warn')
    });
  }
  return map;
}

// Cron tiap menit: pulihkan scan yang macet, antrekan bukti lama yang belum pernah di-scan
// (mis. pembayaran pending saat fitur ini baru dipasang), lalu proses antrean.
async function runProofScanSweep() {
  await db.query(`UPDATE payment_proof_scans SET status='queued',next_attempt_at=NOW() WHERE status='processing' AND (started_at IS NULL OR started_at<DATE_SUB(NOW(),INTERVAL 10 MINUTE))`);
  const [missing] = await db.query(`SELECT p.id FROM payments p LEFT JOIN payment_proof_scans ps ON ps.payment_id=p.id
    WHERE ps.id IS NULL AND p.status='pending' AND p.method IN ('transfer','qris') AND p.proof_path IS NOT NULL AND p.proof_path<>'' ORDER BY p.id LIMIT 20`);
  for (const r of missing) await queueProofScan(r.id, { kick: false });
  return processQueue();
}

async function recoverOnBoot() {
  await db.query(`UPDATE payment_proof_scans SET status='queued',next_attempt_at=NOW() WHERE status='processing'`);
}

module.exports = { getScanSettings, queueProofScan, processQueue, runScan, evaluatePayment, reevaluatePayment, reevaluateCustomerPending, approvalGate, saveCustomerPayerAlias, loadScansForPayments, runProofScanSweep, recoverOnBoot, SCANNABLE_METHODS, NEEDS_REASON };
