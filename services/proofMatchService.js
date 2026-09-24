// v1.29 — Aturan pencocokan hasil baca bukti transfer vs data tagihan (fungsi murni, mudah dites).
// Level tiap cek: ok (hijau) · warn (kuning, wajib alasan saat approve) · bad (merah, wajib alasan,
// dilewati approve massal) · info (netral).

const TITLE_WORDS = new Set(['BPK', 'BAPAK', 'BP', 'PAK', 'IBU', 'BU', 'IB', 'SDR', 'SDRI', 'SAUDARA', 'SAUDARI', 'MR', 'MRS', 'MS', 'NY', 'NN', 'TN', 'HJ', 'H', 'IR', 'DR', 'DRS', 'DRA', 'PROF', 'SH', 'SE', 'ST', 'SPD', 'SKOM', 'SKM', 'SKEP', 'MM', 'MT', 'AMD', 'SSOS', 'SAG', 'SIP', 'MPD']);
const COMPANY_WORDS = new Set(['PT', 'CV', 'TBK', 'UD', 'KOPERASI']);

function rupiah(value) {
  return `Rp${Math.round(Number(value || 0)).toLocaleString('id-ID')}`;
}

function normalizeName(value) {
  if (!value) return '';
  return String(value)
    .toUpperCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !TITLE_WORDS.has(t))
    .join(' ')
    .trim();
}

function tokens(value) {
  return normalizeName(value).split(' ').filter(t => t.length >= 2 && !COMPANY_WORDS.has(t));
}

function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array(a.length).fill(false), bM = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = bM[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Token dianggap sama bila identik, salah satunya awalan yang lain (nama terpotong bank,
// mis. "SANTOS" vs "SANTOSO") minimal 3 huruf, atau sangat mirip (typo 1 huruf).
function tokenEquals(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return true;
  if (s.length === 1 && l.startsWith(s)) return true; // inisial "M" = "MUHAMMAD"
  return s.length >= 4 && jaroWinkler(a, b) >= 0.93;
}

// Hasil: 'match' | 'partial' | 'mismatch' | 'unknown'
function compareNames(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 'unknown';
  if (ta.join(' ') === tb.join(' ')) return 'match';
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set();
  let hits = 0, strongHits = 0;
  for (const t of short) {
    const idx = long.findIndex((u, i) => !used.has(i) && tokenEquals(t, u));
    if (idx >= 0) { used.add(idx); hits++; if (t.length >= 3) strongHits++; }
  }
  if (hits === short.length && strongHits >= 1) return 'match';
  if (jaroWinkler(ta.join(' '), tb.join(' ')) >= 0.94) return 'match';
  if (strongHits >= 1) return 'partial';
  return 'mismatch';
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeRef(value) {
  const s = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 6 ? s.slice(0, 100) : null;
}

// Nomor rekening terbaca vs rekening INKAMNET. Bukti sering menyamarkan nomor (****1234),
// jadi yang dibandingkan adalah digit yang terlihat di bagian akhir.
function accountMatches(detected, ours) {
  const raw = String(detected || '');
  const o = digits(ours);
  if (o.length < 4 || !digits(raw)) return null;
  if (/[*xX\u2022]/.test(raw)) {
    const parts = raw.split(/[*xX\u2022]+/).map(digits);
    const head = parts[0] || '';
    const tail = parts[parts.length - 1] || '';
    if (head.length + tail.length < 3) return null;
    return (!head || o.startsWith(head)) && (!tail || o.endsWith(tail));
  }
  const d = digits(raw);
  if (d.length < 4) return null;
  if (d.length >= 8) return d === o || o.endsWith(d) || d.endsWith(o);
  return o.endsWith(d);
}

function toTimeKey(value) {
  if (!value) return '';
  if (value instanceof Date) return new Date(value.getTime() + 7 * 3600000).toISOString().slice(11, 16);
  return String(value).slice(11, 16);
}

function selectedAccountDigits(bankName) {
  const parts = String(bankName || '').split('\u00b7').map(x => x.trim());
  return digits(parts.length >= 2 ? parts[1] : bankName);
}

function dayDiff(a, b) {
  const da = new Date(String(a).slice(0, 10) + 'T00:00:00Z');
  const db = new Date(String(b).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

function toDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    // mysql2 memakai timezone +07:00 → ambil tanggal lokal WIB.
    const wib = new Date(value.getTime() + 7 * 3600000);
    return wib.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/**
 * @param {object} p
 *  scan        : baris payment_proof_scans (kolom hasil AI) — boleh tanpa hasil AI
 *  payment     : {id, method, amount, paid_at, bank_name, customer_id, customer_name}
 *  expectedAmount : total nominal pengajuan yang memakai bukti ini (1 bukti bisa untuk beberapa faktur)
 *  groupCount  : jumlah faktur dalam pengajuan yang sama
 *  banks       : rekening aktif INKAMNET [{bank_name, account_name, account_number}]
 *  recipientNames : nama penerima tambahan (merchant QRIS dsb.)
 *  aliases     : nama pengirim yang dikenal untuk pelanggan ini
 *  duplicates  : [{payment_id, reference, customer_name, same_customer, reason, strength:'strong'|'similar'}]
 *  settings    : {tolerance, maxDateDiffDays}
 *  aiState     : 'done' | 'disabled' | 'error' | 'skipped'
 */
function evaluateProof({ scan = {}, payment, expectedAmount, groupCount = 1, banks = [], recipientNames = [], aliases = [], duplicates = [], settings = {}, aiState = 'done', aiError = null, now = new Date() }) {
  const checks = [];
  const add = (key, level, label, detail) => checks.push({ key, level, label, detail });
  const tolerance = Math.max(0, Number(settings.tolerance || 0));
  const maxDateDiff = Math.max(1, Number(settings.maxDateDiffDays || 3));
  const expected = Number(expectedAmount ?? payment.amount);
  const hasAi = aiState === 'done';

  // 1) Duplikat — lokal, berlaku walau AI nonaktif.
  const strong = duplicates.filter(d => d.strength === 'strong');
  const similar = duplicates.filter(d => d.strength !== 'strong');
  const describe = list => list.slice(0, 3).map(d => `${d.reference || `#${d.payment_id}`} a.n. ${d.customer_name || '-'}`).join(', ') + (list.length > 3 ? `, +${list.length - 3} lainnya` : '');
  if (strong.length) {
    const otherCustomer = strong.filter(d => !d.same_customer);
    const reasons = [...new Set(strong.map(d => d.reason))].join(' / ');
    if (otherCustomer.length) add('duplicate', 'bad', 'Bukti ganda', `Bukti ini sudah dipakai di ${describe(otherCustomer)} (${reasons}).`);
    else add('duplicate', 'warn', 'Bukti ganda', `Bukti yang sama dipakai di pengajuan lain pelanggan ini: ${describe(strong)} (${reasons}). Jika 1 transfer untuk beberapa tagihan, ajukan dalam satu pencatatan.`);
  } else if (similar.length) {
    add('duplicate', 'warn', 'Mirip bukti lain', `Gambar sangat mirip dengan bukti ${describe(similar)}. Pastikan bukan bukti yang sama.`);
  } else {
    add('duplicate', 'ok', 'Bukti unik', 'Belum pernah dipakai di pembayaran lain.');
  }

  if (!hasAi) {
    const detail = aiState === 'disabled' ? 'Pembacaan AI nonaktif / API key belum diisi. Hanya cek duplikat yang dijalankan.'
      : aiState === 'skipped' ? (aiError || 'Bukti tidak dibaca otomatis.')
      : `Bukti gagal dibaca AI${aiError ? `: ${aiError}` : ''}.`;
    add('ai', 'info', 'Belum terbaca', detail);
    return finalize(checks, { aiMissing: true });
  }

  // 2) Jenis & status transaksi
  if (scan.is_transfer_proof === 0 || scan.is_transfer_proof === false) {
    add('type', 'bad', 'Bukan bukti transfer', 'Gambar tidak terbaca sebagai bukti transfer / pembayaran.');
  }
  if (scan.transaction_status === 'failed') add('status', 'bad', 'Transaksi gagal', 'Bukti menunjukkan transaksi GAGAL.');
  else if (scan.transaction_status === 'pending') add('status', 'warn', 'Transaksi pending', 'Bukti menunjukkan transaksi masih diproses/pending.');

  // 3) Nominal
  const detected = scan.amount_detected === null || scan.amount_detected === undefined ? null : Number(scan.amount_detected);
  const groupNote = groupCount > 1 ? ` (total ${groupCount} faktur dalam satu pengajuan)` : '';
  if (detected === null || !Number.isFinite(detected)) {
    add('amount', 'warn', 'Nominal tidak terbaca', `Nominal di bukti tidak terbaca jelas. Tagihan ${rupiah(expected)}${groupNote}.`);
  } else {
    const diff = detected - expected;
    const lowConfidence = scan.amount_confidence !== null && scan.amount_confidence !== undefined && Number(scan.amount_confidence) < 0.6;
    if (Math.abs(diff) === 0) add('amount', lowConfidence ? 'warn' : 'ok', 'Nominal sesuai', `${rupiah(detected)} = tagihan${groupNote}${lowConfidence ? ' · keyakinan baca rendah, cek gambar' : ''}.`);
    else if (Math.abs(diff) <= tolerance) add('amount', 'ok', 'Nominal sesuai (toleransi)', `Bukti ${rupiah(detected)}, tagihan ${rupiah(expected)}${groupNote} · selisih ${rupiah(Math.abs(diff))} masih dalam toleransi ${rupiah(tolerance)}.`);
    else if (diff < 0) add('amount', 'bad', 'Nominal kurang', `Bukti ${rupiah(detected)}, tagihan ${rupiah(expected)}${groupNote} · KURANG ${rupiah(-diff)}.`);
    else add('amount', 'bad', 'Nominal lebih', `Bukti ${rupiah(detected)}, tagihan ${rupiah(expected)}${groupNote} · LEBIH ${rupiah(diff)}.`);
  }

  // 4) Penerima = rekening INKAMNET?
  const recAcc = scan.recipient_account;
  const recName = scan.recipient_name;
  let recipientLevel = null, recipientDetail = '';
  const accResults = banks.map(b => ({ bank: b, hit: accountMatches(recAcc, b.account_number) }));
  const accHit = accResults.find(r => r.hit === true);
  const accComparable = accResults.some(r => r.hit !== null);
  const nameCandidates = [...banks.map(b => b.account_name), ...recipientNames].filter(Boolean);
  const nameHit = recName ? nameCandidates.find(n => compareNames(recName, n) === 'match') : null;
  const shown = [recName, recAcc].filter(Boolean).join(' · ') || '-';
  if (accHit) {
    recipientLevel = 'ok';
    recipientDetail = `${shown} = rekening ${accHit.bank.bank_name} ${accHit.bank.account_number}.`;
    const chosen = payment.method === 'transfer' ? selectedAccountDigits(payment.bank_name) : '';
    if (chosen.length >= 4 && chosen !== digits(accHit.bank.account_number)) {
      recipientLevel = 'warn';
      recipientDetail += ` Berbeda dengan bank tujuan yang dipilih admin (${payment.bank_name}).`;
    }
  } else if (accComparable) {
    recipientLevel = nameHit ? 'warn' : 'bad';
    recipientDetail = nameHit ? `Nama penerima cocok (${recName}) tetapi nomor rekening ${recAcc} tidak dikenal.` : `Rekening tujuan ${shown} BUKAN rekening INKAMNET yang terdaftar.`;
  } else if (nameHit) {
    recipientLevel = 'ok';
    recipientDetail = `Penerima ${recName} sesuai nama rekening/merchant INKAMNET.`;
  } else if (recName) {
    recipientLevel = 'bad';
    recipientDetail = `Penerima "${recName}" tidak cocok dengan rekening/merchant INKAMNET.`;
  } else {
    recipientLevel = 'warn';
    recipientDetail = 'Nama/rekening penerima tidak terlihat di bukti.';
  }
  add('recipient', recipientLevel, recipientLevel === 'ok' ? 'Penerima benar' : recipientLevel === 'warn' ? 'Cek penerima' : 'Penerima salah', recipientDetail);

  // 5) Pengirim vs pelanggan
  const sender = scan.sender_name;
  if (!sender) {
    add('sender', 'info', 'Pengirim tidak terlihat', `Nama pengirim tidak tercantum di bukti. Pelanggan: ${payment.customer_name}.`);
  } else {
    const direct = compareNames(sender, payment.customer_name);
    const aliasHit = direct === 'match' ? null : aliases.find(a => compareNames(sender, a) === 'match');
    if (direct === 'match') add('sender', 'ok', 'Pengirim = pelanggan', `${sender} sesuai nama pelanggan ${payment.customer_name}.`);
    else if (aliasHit) add('sender', 'ok', 'Pengirim dikenal', `${sender} tersimpan sebagai pengirim dikenal untuk ${payment.customer_name}.`);
    else if (direct === 'partial') add('sender', 'warn', 'Pengirim mirip', `Pengirim "${sender}" hanya sebagian cocok dengan pelanggan "${payment.customer_name}".`);
    else add('sender', 'warn', 'Pengirim beda', `Pengirim "${sender}" berbeda dengan pelanggan "${payment.customer_name}" (keluarga / pihak lain?).`);
  }

  // 6) Tanggal
  if (scan.transfer_at) {
    const proofDate = toDateKey(scan.transfer_at);
    const paidDate = toDateKey(payment.paid_at);
    const todayDate = toDateKey(now);
    const futureDiff = dayDiff(proofDate, todayDate);
    const diff = paidDate ? dayDiff(proofDate, paidDate) : null;
    if (futureDiff !== null && futureDiff > 1) add('date', 'bad', 'Tanggal janggal', `Tanggal bukti ${proofDate} berada di masa depan.`);
    else if (diff !== null && Math.abs(diff) > maxDateDiff) add('date', 'warn', 'Tanggal berbeda', `Tanggal bukti ${proofDate}, tanggal bayar dicatat ${paidDate} (selisih ${Math.abs(diff)} hari).`);
    else add('date', 'ok', 'Tanggal wajar', `Transfer ${proofDate}${scan.transfer_has_time ? ` ${toTimeKey(scan.transfer_at)}` : ''}.`);
  } else {
    add('date', 'info', 'Tanggal tidak terbaca', 'Tanggal transaksi tidak terbaca di bukti.');
  }

  return finalize(checks, { aiMissing: false });
}

function finalize(checks, { aiMissing }) {
  const hasBad = checks.some(c => c.level === 'bad');
  const hasWarn = checks.some(c => c.level === 'warn');
  const overall = hasBad ? 'mismatch' : hasWarn ? 'warning' : aiMissing ? 'unreadable' : 'ok';
  const problems = checks.filter(c => c.level === 'bad' || c.level === 'warn');
  const summary = problems.length ? problems.map(c => c.detail).join(' ')
    : overall === 'ok' ? 'Semua data bukti sesuai tagihan.'
    : (checks.find(c => c.key === 'ai')?.detail || '');
  return { overall, checks, summary: summary.slice(0, 1000) };
}

const NEEDS_REASON = new Set(['warning', 'mismatch']);

module.exports = { evaluateProof, compareNames, normalizeName, accountMatches, normalizeRef, digits, jaroWinkler, rupiah, toDateKey, toTimeKey, NEEDS_REASON };
