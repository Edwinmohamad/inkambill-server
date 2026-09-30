// INKAMBILL Local OCR Proof Validation — no AI / no external OCR API.
// Uses local Tesseract CLI only. All OCR findings are advisory: approval is never blocked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const db = require('../config/db');

const PROOF_DIR = path.join(__dirname, '..', 'storage', 'payment-proofs');
const SCANNABLE_METHODS = new Set(['transfer', 'qris']);
const OCR_TIMEOUT_MS = Math.max(5000, Number(process.env.PROOF_OCR_TIMEOUT_MS || 25000));
const MAX_RAW_TEXT = 60000;
const queue = [];
const queued = new Set();
let draining = false;
let tesseractCache = null;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\b(PT|CV|TBK|UD|BAPAK|BPK|BP|PAK|IBU|BU|MR|MRS|MS)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compareNames(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 'unknown';
  if (x === y || x.includes(y) || y.includes(x)) return 'match';
  const xa = x.split(' ').filter(t => t.length >= 2);
  const ya = y.split(' ').filter(t => t.length >= 2);
  if (!xa.length || !ya.length) return 'unknown';
  const hits = xa.filter(t => ya.some(u => u === t || (t.length >= 4 && (u.startsWith(t) || t.startsWith(u))))).length;
  const ratio = hits / Math.min(xa.length, ya.length);
  if (ratio >= 0.75) return 'match';
  if (hits >= 1) return 'partial';
  return 'mismatch';
}

function accountMatches(detected, ours) {
  const raw = String(detected || '');
  const target = digits(ours);
  const visible = digits(raw);
  if (target.length < 4 || visible.length < 4) return null;
  const masked = /[*xX\u2022]/.test(raw);
  if (masked) return target.endsWith(visible.slice(-Math.min(visible.length, 8)));
  if (visible.length >= 8) return visible === target || target.endsWith(visible) || visible.endsWith(target);
  return target.endsWith(visible);
}

function parseRupiahNumber(value) {
  const raw = String(value || '').replace(/rp\.?/ig, '').replace(/\s+/g, '').trim();
  if (!raw) return null;
  const only = raw.match(/[0-9][0-9.,]*/)?.[0];
  if (!only) return null;
  // Indonesian format: 170.000 / 170.000,00. Also tolerate 170,000.00.
  let compact = only;
  if (/[,\.]\d{1,2}$/.test(compact)) compact = compact.slice(0, -compact.match(/[,\.]\d{1,2}$/)[0].length);
  compact = compact.replace(/[.,]/g, '');
  const n = Number(compact);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  return Math.round(n);
}

const MONTHS = {
  jan: 1, januari: 1, january: 1,
  feb: 2, februari: 2, february: 2,
  mar: 3, maret: 3, march: 3,
  apr: 4, april: 4,
  mei: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  agu: 8, agt: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10, oct: 10, october: 10,
  nov: 11, november: 11,
  des: 12, desember: 12, dec: 12, december: 12
};

function validDateParts(y, m, d, hh = 12, mi = 0, ss = 0) {
  const date = new Date(Date.UTC(y, m - 1, d, hh, mi, ss));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function mysqlDateTime(y, m, d, hh = 12, mi = 0, ss = 0) {
  if (!validDateParts(y, m, d, hh, mi, ss)) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mi)}:${pad(ss)}`;
}

function parseDateTime(text) {
  const s = normalizeText(text);
  let m;
  // yyyy-mm-dd hh:mm[:ss]
  m = s.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T,]+(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?/i);
  if (m) {
    const at = mysqlDateTime(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 12 : Number(m[4]), m[5] === undefined ? 0 : Number(m[5]), m[6] === undefined ? 0 : Number(m[6]));
    if (at) return { at, hasTime: m[4] !== undefined };
  }
  // dd/mm/yyyy hh:mm[:ss]
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?:[ ,T]+(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?/i);
  if (m) {
    const at = mysqlDateTime(Number(m[3]), Number(m[2]), Number(m[1]), m[4] === undefined ? 12 : Number(m[4]), m[5] === undefined ? 0 : Number(m[5]), m[6] === undefined ? 0 : Number(m[6]));
    if (at) return { at, hasTime: m[4] !== undefined };
  }
  // dd Sep 2026 hh:mm
  m = s.match(/\b(\d{1,2})\s+(jan(?:uari|uary)?|feb(?:ruari|ruary)?|mar(?:et|ch)?|apr(?:il)?|mei|may|jun(?:i|e)?|jul(?:i|y)?|agu(?:stus)?|agt|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)\s+(20\d{2})(?:[ ,]+(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?/i);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    const at = mon ? mysqlDateTime(Number(m[3]), mon, Number(m[1]), m[4] === undefined ? 12 : Number(m[4]), m[5] === undefined ? 0 : Number(m[5]), m[6] === undefined ? 0 : Number(m[6])) : null;
    if (at) return { at, hasTime: m[4] !== undefined };
  }
  return { at: null, hasTime: false };
}

function cleanCandidate(value, max = 180) {
  const s = normalizeText(value).replace(/^[:\-–—\s]+/, '').trim();
  return s ? s.slice(0, max) : null;
}

function lineAfterLabel(lines, regex, { maxAhead = 2, reject = null } = {}) {
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    const same = cleanCandidate(lines[i].replace(regex, ''));
    if (same && (!reject || !reject.test(same))) return same;
    for (let j = 1; j <= maxAhead && i + j < lines.length; j++) {
      const next = cleanCandidate(lines[i + j]);
      if (next && (!reject || !reject.test(next))) return next;
    }
  }
  return null;
}

function parseReference(lines) {
  const rx = /(no\.?\s*(?:referensi|ref(?:erence)?|transaksi)|(?:transaction|trx)\s*(?:id|no)|id\s*transaksi|referensi|reference)\s*[:#-]?\s*/i;
  for (let i = 0; i < lines.length; i++) {
    if (!rx.test(lines[i])) continue;
    const joined = [lines[i], lines[i + 1] || ''].join(' ');
    const tail = joined.replace(rx, ' ');
    const parts = tail.match(/[A-Z0-9][A-Z0-9\-_.\/]{5,}/ig) || [];
    const hit = parts.find(v => digits(v).length >= 4 || /[A-Z]/i.test(v));
    if (hit) return hit.slice(0, 100);
  }
  return null;
}

function extractAccountToken(value) {
  const candidates = String(value || '').match(/(?:\*|x|X|\u2022|\d)[\d\s*Xx\u2022-]{3,30}/g) || [];
  for (const c of candidates) {
    const d = digits(c);
    if (d.length >= 4 && d.length <= 20) return c.replace(/\s+/g, '').slice(0, 60);
  }
  return null;
}

function parseRecipientAccount(lines, banks = []) {
  const accountLabel = /(rekening\s*(?:tujuan|penerima)?|no\.?\s*rek(?:ening)?|account\s*(?:no|number)?|nomor\s*rekening|ke\s*rekening)/i;
  for (let i = 0; i < lines.length; i++) {
    if (!accountLabel.test(lines[i])) continue;
    for (let j = 0; j <= 2 && i + j < lines.length; j++) {
      const hit = extractAccountToken(lines[i + j]);
      if (hit) return hit;
    }
  }
  const full = lines.join(' ');
  for (const bank of banks) {
    const n = digits(bank.account_number);
    if (n.length >= 4 && full.replace(/\s/g, '').includes(n)) return n;
  }
  const masked = full.match(/(?:\*|x|X|\u2022){2,}[\s-]*\d{4,8}/);
  return masked ? masked[0].replace(/\s+/g, '') : null;
}

function detectKnownBank(text) {
  const s = String(text || '').toUpperCase();
  const names = [
    ['BANK CENTRAL ASIA', 'BCA'], ['MYBCA', 'BCA'], ['BCA MOBILE', 'BCA'], ['BCA', 'BCA'],
    ['BANK RAKYAT INDONESIA', 'BRI'], ['BRIMO', 'BRI'], ['BRI', 'BRI'],
    ['BANK NEGARA INDONESIA', 'BNI'], ['WONDR', 'BNI'], ['BNI', 'BNI'],
    ['BANK MANDIRI', 'MANDIRI'], ['LIVIN', 'MANDIRI'], ['MANDIRI', 'MANDIRI'],
    ['BSI MOBILE', 'BSI'], ['BANK SYARIAH INDONESIA', 'BSI'], ['BSI', 'BSI'],
    ['CIMB NIAGA', 'CIMB NIAGA'], ['OCTO', 'CIMB NIAGA'],
    ['SEABANK', 'SEABANK'], ['JAGO', 'BANK JAGO'], ['PERMATA', 'PERMATA'],
    ['DANA', 'DANA'], ['GOPAY', 'GOPAY'], ['OVO', 'OVO'], ['SHOPEEPAY', 'SHOPEEPAY']
  ];
  return names.find(([needle]) => s.includes(needle))?.[1] || null;
}

function detectChannel(text) {
  const s = String(text || '').toUpperCase();
  const channels = ['MYBCA', 'BCA MOBILE', 'BRIMO', 'LIVIN', 'WONDR', 'BNI MOBILE', 'BSI MOBILE', 'OCTO MOBILE', 'DANA', 'GOPAY', 'OVO', 'SHOPEEPAY', 'QRIS', 'ATM'];
  return channels.find(x => s.includes(x)) || null;
}

function parseAmount(lines, expectedAmount = null) {
  const candidates = [];
  const labeledRx = /(nominal|jumlah|amount|total\s*transfer|nilai\s*transfer|transfer\s*sebesar|uang\s*yang\s*dikirim)/i;
  const rejectRx = /(biaya|admin|fee|saldo|balance|cashback|diskon)/i;
  for (const line of lines) {
    const values = line.match(/(?:rp\.?\s*)?\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|(?:rp\.?\s*)\d{4,12}/ig) || [];
    for (const token of values) {
      const n = parseRupiahNumber(token);
      if (!n) continue;
      const labeled = labeledRx.test(line);
      const rejected = rejectRx.test(line);
      candidates.push({ n, labeled, rejected, line });
    }
  }
  let pool = candidates.filter(c => c.labeled && !c.rejected);
  if (!pool.length) pool = candidates.filter(c => !c.rejected);
  if (!pool.length) return null;
  const expected = Number(expectedAmount);
  if (Number.isFinite(expected) && expected > 0) {
    const exact = pool.find(c => c.n === expected);
    if (exact) return exact.n;
    pool.sort((a, b) => Math.abs(a.n - expected) - Math.abs(b.n - expected));
    return pool[0].n;
  }
  return pool[0].n;
}

function parseSenderName(lines) {
  const reject = /(rekening|account|bank|tanggal|date|nominal|jumlah|rp\b|\d{5,})/i;
  return lineAfterLabel(lines, /(nama\s*pengirim|pengirim|sender|dari)\s*[:\-]?\s*/i, { maxAhead: 2, reject });
}

function parseRecipientName(lines, banks = []) {
  const all = normalizeName(lines.join(' '));
  for (const bank of banks) {
    const name = normalizeName(bank.account_name);
    if (name && all.includes(name)) return bank.account_name;
  }
  const reject = /(rekening|account|bank|tanggal|date|nominal|jumlah|rp\b|\d{5,})/i;
  return lineAfterLabel(lines, /(nama\s*penerima|penerima|recipient|kepada)\s*[:\-]?\s*/i, { maxAhead: 2, reject });
}

function detectTransactionStatus(text) {
  const s = normalizeText(text).toLowerCase();
  if (/\b(gagal|failed|ditolak|declined|dibatalkan|cancelled)\b/.test(s)) return 'failed';
  if (/\b(pending|diproses|processing|menunggu)\b/.test(s)) return 'pending';
  if (/\b(berhasil|sukses|success|successful|selesai|completed)\b/.test(s)) return 'success';
  return 'unknown';
}

function parseReceipt(text, { expectedAmount = null, banks = [] } = {}) {
  const lines = String(text || '').split(/\r?\n/).map(normalizeText).filter(Boolean);
  const date = parseDateTime(lines.join('\n'));
  const recipientAccount = parseRecipientAccount(lines, banks);
  let recipientBank = detectKnownBank(lines.join('\n'));
  if (recipientAccount) {
    const bankHit = banks.find(b => accountMatches(recipientAccount, b.account_number) === true);
    if (bankHit?.bank_name) recipientBank = bankHit.bank_name;
  }
  return {
    amount: parseAmount(lines, expectedAmount),
    transferAt: date.at,
    transferHasTime: date.hasTime,
    senderName: parseSenderName(lines),
    senderBank: null,
    recipientName: parseRecipientName(lines, banks),
    recipientBank,
    recipientAccount,
    referenceNumber: parseReference(lines),
    channel: detectChannel(lines.join('\n')),
    transactionStatus: detectTransactionStatus(lines.join('\n'))
  };
}

function rupiah(value) {
  return `Rp${Math.round(Number(value || 0)).toLocaleString('id-ID')}`;
}

function evaluateLocalProof({ payment, parsed, banks = [], duplicates = [], confidence = null, engineState = 'done', engineError = null }) {
  const checks = [];
  const add = (key, level, label, detail) => checks.push({ key, level, label, detail });
  const expected = Number(payment.amount || 0);

  if (engineState !== 'done') {
    const label = engineState === 'unavailable' ? 'OCR lokal tidak tersedia' : engineState === 'skipped' ? 'OCR tidak dijalankan' : 'OCR belum berhasil';
    add('ocr', 'info', label, engineError || 'Lakukan verifikasi manual pada bukti.');
  }

  if (parsed.transactionStatus === 'failed') add('status', 'warn', 'Status transaksi bermasalah', 'Teks bukti terindikasi menunjukkan transaksi gagal/ditolak. Verifikasi manual.');
  else if (parsed.transactionStatus === 'pending') add('status', 'warn', 'Transaksi masih diproses', 'Teks bukti terindikasi pending/diproses. Verifikasi manual.');

  if (parsed.amount == null) add('amount', 'info', 'Nominal belum terbaca', `Tagihan ${rupiah(expected)}. Verifikasi nominal dari gambar.`);
  else if (Number(parsed.amount) === expected) add('amount', 'ok', 'Nominal sesuai', `${rupiah(parsed.amount)} sesuai tagihan.`);
  else add('amount', 'warn', 'Nominal berbeda', `OCR membaca ${rupiah(parsed.amount)}, sedangkan tagihan ${rupiah(expected)}.`);

  if (parsed.transferAt) add('date', 'ok', 'Tanggal terbaca', parsed.transferAt.replace(' ', ' · '));
  else add('date', 'info', 'Tanggal belum terbaca', 'Tanggal transaksi tidak terbaca jelas oleh OCR.');

  const accResults = parsed.recipientAccount ? banks.map(bank => ({ bank, match: accountMatches(parsed.recipientAccount, bank.account_number) })) : [];
  const accHit = accResults.find(x => x.match === true);
  if (parsed.recipientAccount && accHit) {
    const masked = /[*xX\u2022]/.test(String(parsed.recipientAccount));
    add('account', masked ? 'ok' : 'ok', masked ? 'Rekening cocok (tersamar)' : 'Rekening resmi', `${parsed.recipientAccount} cocok dengan rekening ${accHit.bank.bank_name} yang terdaftar di Billing.`);
  } else if (parsed.recipientAccount) {
    add('account', 'warn', 'Rekening tujuan tidak terdaftar', `${parsed.recipientAccount} tidak cocok dengan rekening aktif di Pengaturan → Bank. Ini hanya peringatan; Master Admin tetap dapat approve.`);
  } else {
    add('account', 'info', 'Rekening belum terbaca', 'Nomor rekening tujuan tidak terbaca jelas oleh OCR.');
  }

  if (parsed.recipientName) {
    const nameHit = banks.find(b => compareNames(parsed.recipientName, b.account_name) === 'match');
    if (nameHit) add('recipient', 'ok', 'Penerima sesuai', `${parsed.recipientName} cocok dengan nama rekening resmi.`);
    else add('recipient', 'warn', 'Nama penerima berbeda', `OCR membaca penerima “${parsed.recipientName}”. Cocokkan manual dengan rekening Billing.`);
  } else add('recipient', 'info', 'Penerima belum terbaca', 'Nama penerima tidak terbaca jelas oleh OCR.');

  const dupStrong = duplicates.filter(d => d.strength === 'strong');
  if (dupStrong.length) add('duplicate', 'warn', 'Kemungkinan bukti ganda', `Ditemukan kecocokan dengan ${dupStrong.slice(0, 3).map(d => d.reference || `#${d.payment_id}`).join(', ')}${dupStrong.length > 3 ? ` +${dupStrong.length - 3} lainnya` : ''}.`);
  else add('duplicate', 'ok', 'Bukti unik', 'Hash/reference belum ditemukan pada pembayaran lain di luar batch yang sama.');

  if (parsed.referenceNumber) add('reference', 'ok', 'Reference terbaca', parsed.referenceNumber);
  else add('reference', 'info', 'Reference belum terbaca', 'Nomor referensi/transaksi tidak terbaca jelas.');

  const hasWarn = checks.some(c => c.level === 'warn');
  const hasOk = checks.some(c => c.level === 'ok');
  const overall = hasWarn ? 'warning' : hasOk ? 'ok' : 'unreadable';
  return {
    overall,
    canApprove: true,
    confidence: confidence == null ? null : Math.max(0, Math.min(100, Math.round(Number(confidence)))),
    checks,
    summary: hasWarn ? checks.filter(c => c.level === 'warn').map(c => c.detail).join(' ').slice(0, 1000) : overall === 'ok' ? 'Data utama bukti tidak menunjukkan perbedaan dengan data Billing.' : 'OCR belum cukup jelas; lakukan verifikasi manual.'
  };
}

function parseTsv(tsv) {
  const rows = String(tsv || '').split(/\r?\n/);
  const lineMap = new Map();
  const confidences = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i]) continue;
    const cols = rows[i].split('\t');
    if (cols.length < 12) continue;
    const text = normalizeText(cols.slice(11).join('\t'));
    if (!text) continue;
    const conf = Number(cols[10]);
    if (Number.isFinite(conf) && conf >= 0) confidences.push(conf);
    const key = `${cols[1]}:${cols[2]}:${cols[3]}:${cols[4]}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push(text);
  }
  const lines = [...lineMap.values()].map(words => words.join(' ').trim()).filter(Boolean);
  const confidence = confidences.length ? confidences.reduce((a, n) => a + n, 0) / confidences.length : null;
  return { text: lines.join('\n'), confidence };
}

function spawnWithTimeout(command, args, { input = null, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.once('error', error => finish(error));
    child.once('close', code => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) finish(null, { stdout, stderr });
      else {
        const e = new Error((stderr || `Command ${command} exit ${code}`).trim().slice(0, 1000));
        e.code = code;
        finish(e);
      }
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      const e = new Error(`OCR timeout setelah ${timeoutMs} ms`);
      e.code = 'OCR_TIMEOUT';
      finish(e);
    }, timeoutMs);
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

async function getTesseractInfo({ refresh = false } = {}) {
  if (tesseractCache && !refresh) return tesseractCache;
  try {
    const version = await spawnWithTimeout('tesseract', ['--version'], { timeoutMs: 5000 });
    const langs = await spawnWithTimeout('tesseract', ['--list-langs'], { timeoutMs: 5000 });
    const list = langs.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^[a-z_]{3,}$/i.test(s));
    const language = list.includes('ind') && list.includes('eng') ? 'ind+eng' : list.includes('eng') ? 'eng' : list.includes('ind') ? 'ind' : (list[0] || null);
    tesseractCache = { available: !!language, language, version: normalizeText(version.stdout.split(/\r?\n/)[0]).slice(0, 120), error: language ? null : 'Tesseract ada tetapi language data tidak tersedia.' };
  } catch (err) {
    tesseractCache = { available: false, language: null, version: null, error: `Tesseract tidak tersedia: ${err.message}`.slice(0, 500) };
  }
  return tesseractCache;
}

async function runLocalOcr(buffer, mime) {
  if (mime === 'application/pdf') return { state: 'skipped', text: '', confidence: null, error: 'Bukti PDF tidak diproses OCR otomatis. Verifikasi manual atau upload JPG/PNG/WEBP.' };
  const info = await getTesseractInfo();
  if (!info.available) return { state: 'unavailable', text: '', confidence: null, error: info.error };
  try {
    const result = await spawnWithTimeout('tesseract', ['stdin', 'stdout', '-l', info.language, '--psm', '6', 'tsv'], { input: buffer });
    const parsed = parseTsv(result.stdout);
    if (!parsed.text) return { state: 'error', text: '', confidence: parsed.confidence, error: 'Tesseract selesai tetapi tidak menemukan teks pada gambar.' };
    return { state: 'done', text: parsed.text.slice(0, MAX_RAW_TEXT), confidence: parsed.confidence, error: null, engineVersion: info.version, language: info.language };
  } catch (err) {
    return { state: 'error', text: '', confidence: null, error: `Tesseract gagal: ${err.message}`.slice(0, 500) };
  }
}

function batchPrefix(idempotencyKey) {
  const key = String(idempotencyKey || '');
  const idx = key.lastIndexOf(':');
  return idx > 0 ? key.slice(0, idx) : null;
}

async function loadContext(conn, paymentId) {
  const [rows] = await conn.execute(`SELECT p.id,p.amount,p.method,p.reference,p.bank_name,p.proof_path,p.proof_mime,p.idempotency_key,p.status,p.invoice_id,c.id customer_id,c.name customer_name
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.id=? LIMIT 1`, [paymentId]);
  if (!rows.length) return null;
  const [banks] = await conn.query(`SELECT id,bank_name,account_name,account_number FROM banks WHERE is_active=1 AND type IN ('bank_transfer','virtual_account','other') ORDER BY id`);
  return { payment: rows[0], banks };
}

async function findDuplicates(conn, payment, row) {
  const found = new Map();
  const prefix = batchPrefix(payment.idempotency_key);
  const push = (r, reason) => {
    if (Number(r.payment_id) === Number(payment.id)) return;
    if (prefix && batchPrefix(r.idempotency_key) === prefix) return;
    found.set(Number(r.payment_id), { payment_id: Number(r.payment_id), reference: r.reference, customer_name: r.customer_name, strength: 'strong', reason });
  };
  const base = `SELECT o.payment_id,o.file_sha256,o.ref_no,o.amount_detected,o.transfer_at,p.reference,p.idempotency_key,c.name customer_name
    FROM payment_proof_ocr o JOIN payments p ON p.id=o.payment_id JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE o.payment_id<>?`;
  if (row.file_sha256) {
    const [rows] = await conn.execute(`${base} AND o.file_sha256=?`, [payment.id, row.file_sha256]);
    rows.forEach(r => push(r, 'file identik'));
  }
  if (row.ref_no && String(row.ref_no).length >= 6) {
    const [rows] = await conn.execute(`${base} AND UPPER(REPLACE(REPLACE(o.ref_no,'-',''),' ',''))=UPPER(REPLACE(REPLACE(?,'-',''),' ',''))`, [payment.id, row.ref_no]);
    rows.forEach(r => push(r, 'nomor referensi sama'));
  }
  if (row.amount_detected && row.transfer_at) {
    const [rows] = await conn.execute(`${base} AND o.amount_detected=? AND o.transfer_at=?`, [payment.id, row.amount_detected, row.transfer_at]);
    rows.forEach(r => push(r, 'nominal dan waktu sama'));
  }
  return [...found.values()];
}

async function saveEvaluation(conn, paymentId, engineState, engineError, rawText, confidence, parsed, evaluation, fileHash, engineVersion = null) {
  await conn.execute(`UPDATE payment_proof_ocr SET status=?,engine='tesseract',engine_version=?,error_message=?,raw_text=?,ocr_confidence=?,amount_detected=?,transfer_at=?,transfer_has_time=?,sender_name=?,sender_bank=?,recipient_name=?,recipient_bank=?,recipient_account=?,ref_no=?,channel=?,transaction_status=?,parsed_json=?,overall_status=?,checks_json=?,summary=?,can_approve=1,file_sha256=?,finished_at=NOW() WHERE payment_id=?`, [
    engineState === 'done' ? 'done' : engineState,
    engineVersion,
    engineError,
    rawText || null,
    confidence == null ? null : Math.max(0, Math.min(100, Number(confidence))),
    parsed.amount,
    parsed.transferAt,
    parsed.transferHasTime ? 1 : 0,
    parsed.senderName,
    parsed.senderBank,
    parsed.recipientName,
    parsed.recipientBank,
    parsed.recipientAccount,
    parsed.referenceNumber,
    parsed.channel,
    parsed.transactionStatus,
    JSON.stringify(parsed),
    evaluation.overall,
    JSON.stringify(evaluation.checks),
    evaluation.summary,
    fileHash,
    paymentId
  ]);
}

async function processPaymentOcr(paymentId) {
  const conn = await db.getConnection();
  try {
    const ctx = await loadContext(conn, paymentId);
    if (!ctx || !ctx.payment.proof_path || !SCANNABLE_METHODS.has(ctx.payment.method)) return null;
    await conn.execute(`UPDATE payment_proof_ocr SET status='processing',started_at=NOW(),error_message=NULL WHERE payment_id=?`, [paymentId]);
    const fullPath = path.join(PROOF_DIR, path.basename(ctx.payment.proof_path));
    let buffer;
    try { buffer = await fs.promises.readFile(fullPath); }
    catch (err) {
      const parsed = parseReceipt('', { expectedAmount: ctx.payment.amount, banks: ctx.banks });
      const evaluation = evaluateLocalProof({ payment: ctx.payment, parsed, banks: ctx.banks, engineState: 'error', engineError: 'File bukti tidak ditemukan di storage.' });
      await saveEvaluation(conn, paymentId, 'error', 'File bukti tidak ditemukan di storage.', '', null, parsed, evaluation, null);
      return evaluation;
    }
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const ocr = await runLocalOcr(buffer, ctx.payment.proof_mime);
    const parsed = parseReceipt(ocr.text, { expectedAmount: ctx.payment.amount, banks: ctx.banks });
    const dupRow = { file_sha256: fileHash, ref_no: parsed.referenceNumber, amount_detected: parsed.amount, transfer_at: parsed.transferAt };
    const duplicates = await findDuplicates(conn, ctx.payment, dupRow);
    const evaluation = evaluateLocalProof({ payment: ctx.payment, parsed, banks: ctx.banks, duplicates, confidence: ocr.confidence, engineState: ocr.state, engineError: ocr.error });
    await saveEvaluation(conn, paymentId, ocr.state, ocr.error, ocr.text, ocr.confidence, parsed, evaluation, fileHash, ocr.engineVersion || null);
    await conn.execute(`UPDATE payment_proof_ocr SET duplicate_payment_ids=? WHERE payment_id=?`, [duplicates.map(d => d.payment_id).join(',').slice(0, 250) || null, paymentId]);
    return evaluation;
  } finally {
    conn.release();
  }
}

function scheduleDrain() {
  setImmediate(() => drainQueue().catch(err => console.error('Local OCR queue gagal:', err.message)));
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      queued.delete(id);
      try { await processPaymentOcr(id); }
      catch (err) {
        console.error('Local OCR payment', id, 'gagal:', err.message);
        await db.execute(`UPDATE payment_proof_ocr SET status='error',error_message=?,overall_status='unreadable',can_approve=1,finished_at=NOW() WHERE payment_id=?`, [String(err.message).slice(0, 500), id]).catch(() => {});
      }
    }
  } finally {
    draining = false;
  }
}

async function queueProofOcr(paymentId) {
  try {
    const [rows] = await db.execute(`SELECT id,method,proof_path,proof_mime FROM payments WHERE id=? LIMIT 1`, [paymentId]);
    const payment = rows[0];
    if (!payment || !payment.proof_path || !SCANNABLE_METHODS.has(payment.method)) return false;
    let hash = null;
    try {
      const buffer = await fs.promises.readFile(path.join(PROOF_DIR, path.basename(payment.proof_path)));
      hash = crypto.createHash('sha256').update(buffer).digest('hex');
    } catch (_) {}
    await db.execute(`INSERT INTO payment_proof_ocr(payment_id,proof_path,file_sha256,status,overall_status,can_approve)
      VALUES(?,?,?,'queued','processing',1)
      ON DUPLICATE KEY UPDATE proof_path=VALUES(proof_path),file_sha256=VALUES(file_sha256),status='queued',overall_status='processing',can_approve=1,error_message=NULL,raw_text=NULL,ocr_confidence=NULL,amount_detected=NULL,transfer_at=NULL,transfer_has_time=0,sender_name=NULL,sender_bank=NULL,recipient_name=NULL,recipient_bank=NULL,recipient_account=NULL,ref_no=NULL,channel=NULL,transaction_status=NULL,parsed_json=NULL,checks_json=NULL,summary=NULL,duplicate_payment_ids=NULL,started_at=NULL,finished_at=NULL`, [payment.id, payment.proof_path, hash]);
    const id = Number(payment.id);
    if (!queued.has(id)) { queued.add(id); queue.push(id); scheduleDrain(); }
    return true;
  } catch (err) {
    console.error('Local OCR: gagal antre pembayaran', paymentId, err.message);
    return false;
  }
}

function rowToUi(row) {
  if (!row) return null;
  let checks = [];
  try { checks = row.checks_json ? JSON.parse(row.checks_json) : []; } catch (_) {}
  return {
    state: row.status,
    overall: row.overall_status || (row.status === 'done' ? 'unreadable' : 'processing'),
    canApprove: true,
    engine: row.engine || 'tesseract',
    confidence: row.ocr_confidence == null ? null : Math.round(Number(row.ocr_confidence)),
    amount: row.amount_detected == null ? null : Number(row.amount_detected),
    transferAt: row.transfer_at_text || (row.transfer_at ? String(row.transfer_at) : null),
    transferHasTime: !!row.transfer_has_time,
    sender: row.sender_name,
    senderBank: row.sender_bank,
    recipient: row.recipient_name,
    recipientBank: row.recipient_bank,
    recipientAccount: row.recipient_account,
    reference: row.ref_no,
    channel: row.channel,
    transactionStatus: row.transaction_status,
    checks,
    summary: row.summary || '',
    error: row.error_message || null
  };
}

async function loadOcrRow(paymentId) {
  const [rows] = await db.execute(`SELECT o.*,DATE_FORMAT(o.transfer_at,'%Y-%m-%d %H:%i:%s') transfer_at_text FROM payment_proof_ocr o WHERE payment_id=? LIMIT 1`, [paymentId]);
  return rows[0] || null;
}

async function getPaymentOcrForUi(paymentId, { queueIfMissing = true, waitMs = 1200 } = {}) {
  const [paymentRows] = await db.execute(`SELECT id,method,proof_path FROM payments WHERE id=? LIMIT 1`, [paymentId]);
  const payment = paymentRows[0];
  if (!payment) return { state: 'missing', overall: 'unreadable', canApprove: true, checks: [], summary: 'Pembayaran tidak ditemukan.' };
  if (!payment.proof_path || !SCANNABLE_METHODS.has(payment.method)) return { state: 'skipped', overall: 'unreadable', canApprove: true, checks: [], summary: 'Metode pembayaran ini tidak memerlukan OCR lokal.' };
  let row = await loadOcrRow(paymentId);
  if (!row && queueIfMissing) {
    await queueProofOcr(paymentId);
    row = await loadOcrRow(paymentId);
  }
  const deadline = Date.now() + Math.max(0, Number(waitMs || 0));
  while (row && ['queued', 'processing'].includes(row.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    row = await loadOcrRow(paymentId);
  }
  return rowToUi(row) || { state: 'processing', overall: 'processing', canApprove: true, checks: [], summary: 'OCR lokal sedang memproses bukti.' };
}

async function runProofOcrSweep() {
  await db.query(`UPDATE payment_proof_ocr SET status='queued',overall_status='processing',can_approve=1 WHERE status='processing' AND (started_at IS NULL OR started_at<DATE_SUB(NOW(),INTERVAL 10 MINUTE))`);
  const [rows] = await db.query(`SELECT p.id FROM payments p LEFT JOIN payment_proof_ocr o ON o.payment_id=p.id
    WHERE p.status='pending' AND p.method IN ('transfer','qris') AND p.proof_path IS NOT NULL AND p.proof_path<>''
      AND (o.id IS NULL OR o.status='queued') ORDER BY p.id LIMIT 20`);
  for (const row of rows) await queueProofOcr(row.id);
  return { queued: rows.length };
}

async function recoverProofOcrOnBoot() {
  await db.query(`UPDATE payment_proof_ocr SET status='queued',overall_status='processing',can_approve=1 WHERE status='processing'`);
  const engine = await getTesseractInfo({ refresh: true });
  if (engine.available) await db.query(`UPDATE payment_proof_ocr SET status='queued',overall_status='processing',can_approve=1 WHERE status IN ('unavailable','error')`);
  const [rows] = await db.query(`SELECT payment_id FROM payment_proof_ocr WHERE status='queued' ORDER BY id LIMIT 50`);
  for (const row of rows) {
    const id = Number(row.payment_id);
    if (!queued.has(id)) { queued.add(id); queue.push(id); }
  }
  if (queue.length) scheduleDrain();
}

module.exports = {
  SCANNABLE_METHODS,
  queueProofOcr,
  getPaymentOcrForUi,
  runProofOcrSweep,
  recoverProofOcrOnBoot,
  processPaymentOcr,
  getTesseractInfo,
  parseReceipt,
  parseDateTime,
  parseRupiahNumber,
  accountMatches,
  compareNames,
  evaluateLocalProof
};
