// Pure logic (tanpa DB) untuk Smart Sync — dapat diuji unit tanpa MySQL/RouterOS.
const EXEMPT_RULES = [
  { type: 'admin', pattern: /\[ADMIN\]|\b(admin|administrator|noc|monitor(?:ing)?|router|server|teknisi|technical|staff)\b/i },
  { type: 'free', pattern: /\[FREE\]|\b(free|gratis|complimentary|sponsor|internal|owner)\b/i }
];

// Case-insensitive, whitespace-collapsed, diacritic-free key.
function normalizeKey(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}
// Variant tanpa spasi/tanda baca: "Budi Santoso" == "budi.santoso" == "BUDI_SANTOSO".
function compactKey(value) { return normalizeKey(value).replace(/[^a-z0-9]+/g, ''); }

function exemptOf(secret) {
  const text = [secret.username ?? secret.name, secret.profile, secret.comment].filter(Boolean).join(' ');
  const rule = EXEMPT_RULES.find(r => r.pattern.test(text));
  return rule ? rule.type : null;
}

/**
 * Bangun rencana Smart Sync.
 * @param {Array} secrets   ppp_secrets unsynced: {id, site_id, username, is_exempt}
 * @param {Array} customers pelanggan aktif: {id, site_id, customer_code, name, linked_secret_id}
 * Aturan: username PPP dicocokkan (case-insensitive) dengan customer_code ATAU name,
 * hanya di site yang sama. Pasangan ambigu (1 secret → >1 pelanggan, atau 1 pelanggan
 * → >1 secret) tidak di-auto-link, masuk daftar conflicts untuk dipetakan manual.
 */
function buildSmartSyncPlan(secrets, customers) {
  const index = new Map(); // `${site}|${key}` -> Map(customerId -> {customer, on})
  const add = (customer, key, on) => {
    if (!key) return;
    const k = `${customer.site_id}|${key}`;
    const bucket = index.get(k) || new Map();
    if (!bucket.has(customer.id)) bucket.set(customer.id, { customer, on });
    index.set(k, bucket);
  };
  for (const c of customers) {
    if (c.linked_secret_id) continue; // sudah terikat ke secret lain
    add(c, 'n:' + normalizeKey(c.customer_code), 'customer_code');
    add(c, 'c:' + compactKey(c.customer_code), 'customer_code');
    add(c, 'n:' + normalizeKey(c.name), 'customer_name');
    add(c, 'c:' + compactKey(c.name), 'customer_name');
  }
  const candidates = [];
  const conflicts = [];
  for (const s of secrets) {
    if (s.is_exempt) continue;
    const found = new Map();
    for (const key of ['n:' + normalizeKey(s.username), 'c:' + compactKey(s.username)]) {
      const bucket = index.get(`${s.site_id}|${key}`);
      if (!bucket) continue;
      for (const [id, hit] of bucket) {
        const prev = found.get(id);
        // customer_code lebih kuat daripada nama bila keduanya cocok
        if (!prev || (prev.on === 'customer_name' && hit.on === 'customer_code')) found.set(id, hit);
      }
    }
    if (!found.size) continue;
    if (found.size > 1) {
      conflicts.push({ secretId: s.id, username: s.username, siteId: s.site_id, reason: 'multiple_customers', customers: [...found.values()].map(h => ({ id: h.customer.id, code: h.customer.customer_code, name: h.customer.name })) });
      continue;
    }
    const hit = [...found.values()][0];
    candidates.push({ secretId: s.id, username: s.username, siteId: s.site_id, customerId: hit.customer.id, customerCode: hit.customer.customer_code, customerName: hit.customer.name, matchedOn: hit.on });
  }
  // Satu pelanggan tidak boleh diklaim dua secret sekaligus.
  const byCustomer = new Map();
  for (const c of candidates) byCustomer.set(c.customerId, (byCustomer.get(c.customerId) || 0) + 1);
  const pairs = [];
  for (const c of candidates) {
    if (byCustomer.get(c.customerId) > 1) conflicts.push({ secretId: c.secretId, username: c.username, siteId: c.siteId, reason: 'customer_claimed_by_multiple_secrets', customers: [{ id: c.customerId, code: c.customerCode, name: c.customerName }] });
    else pairs.push(c);
  }
  pairs.forEach(p => { p.score = p.matchedOn === 'customer_code' ? 100 : 95; p.confidence = 'high'; });
  // Kandidat untuk konflik: dropdown pilihan di UI (diselesaikan inline, bukan map manual satu per satu).
  conflicts.forEach(c => { c.candidates = c.customers; });
  const suggestions = suggestMatches(secrets.filter(s => !s.is_exempt && !pairs.some(p => p.secretId === s.id) && !conflicts.some(c => c.secretId === s.id)),
    customers.filter(c => !c.linked_secret_id && !pairs.some(p => p.customerId === c.id)));
  return { pairs, conflicts, suggestions, summary: { scanned: secrets.length, matched: pairs.length, conflicts: conflicts.length, suggested: suggestions.length, unmatched: secrets.filter(s => !s.is_exempt).length - pairs.length - conflicts.length - suggestions.length } };
}

// ---------- Pencocokan "pintar" (tidak pernah auto-link; tampil sebagai saran dengan skor) ----------
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function similarity(a, b) {
  a = compactKey(a); b = compactKey(b);
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
const digitsOf = v => String(v ?? '').replace(/\D+/g, '');
const phoneKey = v => { const d = digitsOf(v); return d.length >= 9 ? d.slice(-9) : ''; };
const stripDigits = v => compactKey(v).replace(/\d+$/, '');

/** Skor 0-100 terbaik untuk 1 secret terhadap 1 pelanggan (same-site). */
function scorePair(secret, customer) {
  const reasons = [];
  let best = 0, on = null;
  const bump = (score, method, why) => { if (score > best) { best = score; on = method; } reasons.push(why); };
  const comment = String(secret.comment || '');
  const code = compactKey(customer.customer_code);
  if (code && code.length >= 4 && compactKey(comment).includes(code)) bump(92, 'comment', 'Customer ID ada di comment secret');
  const pk = phoneKey(customer.phone);
  if (pk && (phoneKey(secret.username) === pk || digitsOf(comment).includes(pk))) bump(88, 'phone', 'Nomor HP cocok');
  const nameKey = compactKey(customer.name);
  const user = compactKey(secret.username);
  if (nameKey.length >= 4 && stripDigits(secret.username) === nameKey) bump(86, 'fuzzy', 'Nama sama, beda angka di belakang');
  if (nameKey.length >= 5 && user.length >= 5 && (user.includes(nameKey) || nameKey.includes(user))) bump(78, 'fuzzy', 'Username memuat nama pelanggan');
  if (nameKey.length >= 4 && compactKey(comment).includes(nameKey)) bump(82, 'comment', 'Nama pelanggan ada di comment');
  const sim = Math.max(similarity(secret.username, customer.name), similarity(secret.username, customer.customer_code));
  if (sim >= 0.8) bump(Math.round(sim * 84), 'fuzzy', `Mirip ${Math.round(sim * 100)}%`);
  return { score: best, matchedOn: on, reasons: [...new Set(reasons)] };
}

function suggestMatches(secrets, customers, { minScore = 70 } = {}) {
  const bySite = new Map();
  customers.forEach(c => { const k = Number(c.site_id); if (!bySite.has(k)) bySite.set(k, []); bySite.get(k).push(c); });
  const raw = [];
  for (const s of secrets) {
    const pool = bySite.get(Number(s.site_id)) || [];
    const scored = pool.map(c => ({ c, ...scorePair(s, c) })).filter(x => x.score >= minScore).sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    const top = scored[0];
    raw.push({ secretId: s.id, username: s.username, siteId: s.site_id, customerId: top.c.id, customerCode: top.c.customer_code, customerName: top.c.name,
      matchedOn: top.matchedOn, score: top.score, confidence: top.score >= 85 ? 'medium' : 'low', reasons: top.reasons,
      alternatives: scored.slice(1, 4).map(x => ({ id: x.c.id, code: x.c.customer_code, name: x.c.name, score: x.score })) });
  }
  // 1 pelanggan hanya boleh disarankan ke 1 secret (skor tertinggi menang).
  const bestFor = new Map();
  raw.forEach(r => { const cur = bestFor.get(r.customerId); if (!cur || r.score > cur.score) bestFor.set(r.customerId, r); });
  return raw.filter(r => bestFor.get(r.customerId) === r);
}

module.exports = { normalizeKey, compactKey, exemptOf, buildSmartSyncPlan, suggestMatches, scorePair, similarity, levenshtein, EXEMPT_RULES };
