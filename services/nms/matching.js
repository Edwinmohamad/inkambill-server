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

const DEFAULT_FASUM_WORDS = ['fasum', 'masjid', 'musholla', 'mushola', 'musala', 'surau', 'gereja', 'vihara', 'pos ronda', 'poskamling', 'balai desa', 'balai warga', 'kantor desa', 'sekolah', 'posyandu', 'puskesmas'];
const fasumCache = new Map();
function fasumPattern(words) {
  const list = (Array.isArray(words) ? words : String(words || '').split(',')).map(w => normalizeKey(w)).filter(w => w.length >= 3);
  const key = list.join('|');
  if (!fasumCache.has(key)) {
    // Batas depan saja: "masjid_alikhlas", "masjidalikhlas", "MASJID Al Ikhlas" semuanya cocok.
    const alt = list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')).join('|');
    fasumCache.set(key, alt ? new RegExp(`(?:^|[^a-z0-9])(?:${alt})`, 'i') : null);
    if (fasumCache.size > 20) fasumCache.delete(fasumCache.keys().next().value);
  }
  return fasumCache.get(key);
}
function fasumMatch(secret, words = DEFAULT_FASUM_WORDS) {
  const text = normalizeKey([secret.username ?? secret.name, secret.profile, secret.comment].filter(Boolean).join(' ')).replace(/[_.\-/]+/g, ' ');
  const re = fasumPattern(words);
  return !!re && re.test(text);
}
function exemptOf(secret, { fasumWords = DEFAULT_FASUM_WORDS } = {}) {
  const text = [secret.username ?? secret.name, secret.profile, secret.comment].filter(Boolean).join(' ');
  // Tag eksplisit di comment RouterOS selalu menang.
  if (/\[ADMIN\]/i.test(text)) return 'admin';
  if (/\[FASUM\]/i.test(text)) return 'fasum';
  if (/\[FREE\]/i.test(text)) return 'free';
  if (fasumMatch(secret, fasumWords)) return 'fasum';
  const rule = EXEMPT_RULES.find(r => r.pattern.test(text));
  return rule ? rule.type : null;
}

// ---------- Tag ID pelanggan di comment RouterOS: "[CID:KBG-15-012]" ----------
const CID_RE = /\[CID:([^\]\s]{1,64})\]/i;
const CID_RE_ALL = /\s*\[CID:[^\]]*\]/gi;
function parseCid(comment) { const m = String(comment || '').match(CID_RE); return m ? m[1].trim() : null; }
function withoutCid(comment) { return String(comment || '').replace(CID_RE_ALL, '').replace(/\s{2,}/g, ' ').trim(); }
/** Comment baru dengan tepat satu tag CID di belakang (maks 250 karakter; teks lama yang dipotong, bukan tag). */
function withCid(comment, code) {
  const tag = `[CID:${String(code).replace(/[\]\s]+/g, '')}]`;
  const base = withoutCid(comment);
  const room = 250 - tag.length - 1;
  return `${base.length > room ? base.slice(0, room).trim() : base} ${tag}`.trim();
}

// ---------- Sinyal perangkat ----------
const macKey = v => { const s = String(v ?? '').toUpperCase().replace(/[^0-9A-F]/g, ''); return s.length === 12 && !/^0+$/.test(s) ? s : ''; };
const ipKey = v => { const s = String(v ?? '').trim(); return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && !/^0\./.test(s) ? s : ''; };

/**
 * Deteksi rename secret di RouterOS: .id (ros_id) sama, username berbeda, nama lama sudah tidak ada,
 * dan minimal satu bukti perangkat/kredensial sama (password, caller-id, atau remote-address statis).
 * Tanpa bukti tambahan tidak dianggap rename, karena .id bisa dipakai ulang setelah reset/restore router.
 * @param existing baris ppp_secrets router ini {id, ros_id, username, customer_id, password, caller_id, remote_address}
 * @param incoming hasil /ppp/secret {'.id', name, password, 'caller-id', 'remote-address'}
 */
function detectRenames(existing, incoming) {
  const byName = new Set(existing.map(r => normalizeKey(r.username)));
  const incomingNames = new Set(incoming.map(s => normalizeKey(s.name)));
  const byRos = new Map(existing.filter(r => r.ros_id && r.customer_id).map(r => [String(r.ros_id), r]));
  const out = [];
  const used = new Set();
  for (const s of incoming) {
    const name = String(s.name || '').trim();
    if (!name || byName.has(normalizeKey(name))) continue;
    const old = byRos.get(String(s['.id'] || ''));
    if (!old || used.has(old.id) || incomingNames.has(normalizeKey(old.username))) continue;
    const evidence = [];
    if (old.password && s.password && old.password === s.password) evidence.push('password');
    if (macKey(old.caller_id) && macKey(old.caller_id) === macKey(s['caller-id'])) evidence.push('caller-id');
    if (ipKey(old.remote_address) && ipKey(old.remote_address) === ipKey(s['remote-address'])) evidence.push('remote-address');
    if (!evidence.length) continue;
    used.add(old.id);
    out.push({ secretId: old.id, customerId: old.customer_id, from: old.username, to: name, evidence });
  }
  return out;
}

// ---------- Pola penamaan per site (dipelajari dari pasangan yang sudah ter-link) ----------
const wordsOf = name => normalizeKey(name).split(/[^a-z0-9]+/).filter(Boolean);
const lastDigits = v => (String(v ?? '').match(/(\d+)(?!.*\d)/) || [])[1] || '';
const PATTERNS = [
  { id: 'first_digits', label: 'nama depan + angka', test: (u, c) => { const w = wordsOf(c.name); return w[0]?.length >= 3 && /\d/.test(u) && u.replace(/\d+/g, '') === w[0]; } },
  { id: 'full_digits', label: 'nama lengkap + angka', test: (u, c) => { const w = wordsOf(c.name); return w.length >= 2 && /\d/.test(u) && u.replace(/\d+/g, '') === w.join(''); } },
  { id: 'first_last', label: 'nama depan + nama belakang', test: (u, c) => { const w = wordsOf(c.name); return w.length >= 3 && u === w[0] + w[w.length - 1]; } },
  { id: 'first_initial', label: 'nama depan + inisial', test: (u, c) => { const w = wordsOf(c.name); return w.length >= 2 && w[0].length >= 3 && u.replace(/\d+/g, '') === w[0] + w.slice(1).map(x => x[0]).join(''); } },
  { id: 'initials_digits', label: 'inisial + angka', test: (u, c) => { const w = wordsOf(c.name); return w.length >= 2 && /\d/.test(u) && u.replace(/\d+/g, '') === w.map(x => x[0]).join(''); } },
  { id: 'first_codeseq', label: 'nama depan + nomor urut Customer ID', test: (u, c) => { const w = wordsOf(c.name); const d = lastDigits(c.customer_code); return w[0]?.length >= 3 && !!d && u.replace(/\d+/g, '') === w[0] && Number(lastDigits(u)) === Number(d); } },
  { id: 'codeseq', label: 'nomor urut Customer ID', test: (u, c) => { const d = lastDigits(c.customer_code); return !!d && /^\d+$/.test(u) && Number(u) === Number(d); } },
  { id: 'phone', label: 'nomor HP', test: (u, c) => { const p = String(c.phone || '').replace(/\D+/g, ''); return p.length >= 9 && /^\d{9,}$/.test(u) && u.slice(-9) === p.slice(-9); } }
];
// Pola yang tergantung angka bebas di username (tidak memverifikasi angkanya) → skor sedikit lebih rendah.
const LOOSE_PATTERNS = new Set(['first_digits', 'full_digits', 'initials_digits', 'first_initial']);

/** @param linked [{site_id, username, name, customer_code, phone}] → Map(site_id → [{id,label,share,count}]) */
function learnPatterns(linked, { minCount = 3, minShare = 0.2 } = {}) {
  const sites = new Map();
  for (const l of linked) {
    const k = Number(l.site_id);
    const s = sites.get(k) || { total: 0, hits: new Map() };
    s.total++;
    const u = compactKey(l.username);
    for (const p of PATTERNS) if (p.test(u, l)) s.hits.set(p.id, (s.hits.get(p.id) || 0) + 1);
    sites.set(k, s);
  }
  const out = new Map();
  for (const [site, s] of sites) {
    const list = PATTERNS.map(p => ({ id: p.id, label: p.label, count: s.hits.get(p.id) || 0, share: s.total ? (s.hits.get(p.id) || 0) / s.total : 0 }))
      .filter(p => p.count >= minCount && p.share >= minShare).sort((a, b) => b.share - a.share);
    if (list.length) out.set(site, list);
  }
  return out;
}

/**
 * Bangun rencana Smart Sync.
 * @param {Array} secrets   ppp_secrets unsynced: {id, site_id, username, comment, profile, is_exempt, caller_id, remote_address, active_address}
 * @param {Array} customers pelanggan aktif: {id, site_id, customer_code, name, phone, mikrotik_profile, linked_secret_id}
 * @param {Object} ctx      sinyal tambahan (semua opsional): aliases, patterns, secretMacs, customerMacs, customerStaticIps, customerLiveIps
 * Urutan keyakinan: tag [CID:…] di comment → alias pilihan operator → username = Customer ID / nama persis.
 * Pasangan ambigu tidak di-auto-link, masuk conflicts. Sinyal lain (HP, comment, MAC, IP, pola, profile) hanya saran.
 */
function buildSmartSyncPlan(secrets, customers, ctx = {}) {
  const index = new Map(); // `${site}|${key}` -> Map(customerId -> {customer, on})
  const freeById = new Map();
  const byCode = new Map();
  const add = (customer, key, on) => {
    if (!key) return;
    const k = `${customer.site_id}|${key}`;
    const bucket = index.get(k) || new Map();
    if (!bucket.has(customer.id)) bucket.set(customer.id, { customer, on });
    index.set(k, bucket);
  };
  for (const c of customers) {
    if (c.linked_secret_id) continue; // sudah terikat ke secret lain
    freeById.set(Number(c.id), c);
    byCode.set(`${c.site_id}|${compactKey(c.customer_code)}`, c);
    add(c, 'n:' + normalizeKey(c.customer_code), 'customer_code');
    add(c, 'c:' + compactKey(c.customer_code), 'customer_code');
    add(c, 'n:' + normalizeKey(c.name), 'customer_name');
    add(c, 'c:' + compactKey(c.name), 'customer_name');
  }
  const aliases = ctx.aliases || new Map();
  const candidates = [];
  const conflicts = [];
  const push = (s, c, on) => candidates.push({ secretId: s.id, username: s.username, siteId: s.site_id, customerId: c.id, customerCode: c.customer_code, customerName: c.name, matchedOn: on });
  for (const s of secrets) {
    if (s.is_exempt) continue;
    const cid = parseCid(s.comment);
    const tagged = cid && byCode.get(`${s.site_id}|${compactKey(cid)}`);
    if (tagged) { push(s, tagged, 'cid_tag'); continue; }
    const aliasId = aliases.get(`${s.site_id}|${normalizeKey(s.username)}`);
    const aliased = aliasId && freeById.get(Number(aliasId));
    if (aliased && Number(aliased.site_id) === Number(s.site_id)) { push(s, aliased, 'alias'); continue; }
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
    push(s, hit.customer, hit.on);
  }
  // Satu pelanggan tidak boleh diklaim dua secret sekaligus.
  const byCustomer = new Map();
  for (const c of candidates) byCustomer.set(c.customerId, (byCustomer.get(c.customerId) || 0) + 1);
  const pairs = [];
  for (const c of candidates) {
    if (byCustomer.get(c.customerId) > 1) conflicts.push({ secretId: c.secretId, username: c.username, siteId: c.siteId, reason: 'customer_claimed_by_multiple_secrets', customers: [{ id: c.customerId, code: c.customerCode, name: c.customerName }] });
    else pairs.push(c);
  }
  const PAIR_SCORE = { cid_tag: 100, customer_code: 100, alias: 99, customer_name: 95 };
  pairs.forEach(p => { p.score = PAIR_SCORE[p.matchedOn] || 95; p.confidence = 'high'; });
  // Kandidat untuk konflik: dropdown pilihan di UI (diselesaikan inline, bukan map manual satu per satu).
  conflicts.forEach(c => { c.candidates = c.customers; });
  const pairedSecrets = new Set(pairs.map(p => Number(p.secretId)));
  const conflictSecrets = new Set(conflicts.map(c => Number(c.secretId)));
  const pairedCustomers = new Set(pairs.map(p => Number(p.customerId)));
  const free = customers.filter(c => !c.linked_secret_id && !pairedCustomers.has(Number(c.id)));
  const suggestions = suggestMatches(secrets.filter(s => !s.is_exempt && !pairedSecrets.has(Number(s.id)) && !conflictSecrets.has(Number(s.id))), free, { ctx });
  // Secret yang tidak terbaca sama sekali oleh Smart Sync: beri daftar pelanggan yang belum ter-sync
  // (site sama) + tebakan terdekat, supaya operator bisa memilih manual.
  const handled = new Set([...pairedSecrets, ...conflictSecrets, ...suggestions.map(x => Number(x.secretId))]);
  const unmatched = rankUnmatched(secrets.filter(s => !s.is_exempt && !handled.has(Number(s.id))), free, { ctx });
  const freeCustomers = {};
  free.forEach(c => { const k = String(c.site_id); (freeCustomers[k] = freeCustomers[k] || []).push({ id: c.id, code: c.customer_code, name: c.name, siteId: c.site_id, status: c.customer_status || null, pppoe: c.pppoe_username || null, profile: c.mikrotik_profile || null }); });
  Object.values(freeCustomers).forEach(list => list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id')));
  const patterns = {};
  for (const [site, list] of (ctx.patterns || new Map())) patterns[String(site)] = list.map(p => ({ id: p.id, label: p.label, pct: Math.round(p.share * 100), count: p.count }));
  return { pairs, conflicts, suggestions, unmatched, freeCustomers, patterns, summary: { scanned: secrets.length, matched: pairs.length, conflicts: conflicts.length, suggested: suggestions.length, unmatched: unmatched.length, freeCustomers: free.length, byTag: pairs.filter(p => p.matchedOn === 'cid_tag').length, byAlias: pairs.filter(p => p.matchedOn === 'alias').length } };
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
const setHas = (map, id, values) => { const set = map?.get(Number(id)); return !!set && values.some(v => v && set.has(v)); };
const profileMatch = (secret, customer) => !!secret.profile && !!customer.mikrotik_profile && normalizeKey(secret.profile) === normalizeKey(customer.mikrotik_profile);

/** Skor 0-100 terbaik untuk 1 secret terhadap 1 pelanggan (same-site). ctx = sinyal tambahan dari buildSmartSyncPlan. */
function scorePair(secret, customer, ctx = {}) {
  const reasons = [];
  let best = 0, on = null;
  const bump = (score, method, why) => { if (score > best) { best = score; on = method; } reasons.push(why); };
  const comment = String(secret.comment || '');
  const code = compactKey(customer.customer_code);
  if (code && code.length >= 4 && compactKey(comment).includes(code)) bump(92, 'comment', 'Customer ID ada di comment secret');
  // Perangkat yang sama dengan link lama pelanggan ini (Caller-ID yang pernah login).
  const macs = [macKey(secret.caller_id), macKey(secret.active_caller_id), ...[...(ctx.secretMacs?.get(Number(secret.id)) || [])]].filter(Boolean);
  if (macs.length && setHas(ctx.customerMacs, customer.id, macs)) bump(90, 'mac', 'MAC perangkat sama dengan link lama');
  // IP WAN ONT pelanggan (ACS) = IP sesi secret ini sekarang.
  const liveIps = [ipKey(secret.active_address), ipKey(secret.remote_address)].filter(Boolean);
  if (liveIps.length && setHas(ctx.customerLiveIps, customer.id, liveIps)) bump(90, 'ip', 'IP WAN ONT pelanggan sama dengan IP sesi');
  // IP statis (remote-address) sama dengan secret lama pelanggan ini.
  const staticIp = ipKey(secret.remote_address);
  if (staticIp && setHas(ctx.customerStaticIps, customer.id, [staticIp])) bump(88, 'ip', 'IP statis sama dengan link lama');
  const pk = phoneKey(customer.phone);
  if (pk && (phoneKey(secret.username) === pk || digitsOf(comment).includes(pk))) bump(88, 'phone', 'Nomor HP cocok');
  const nameKey = compactKey(customer.name);
  const user = compactKey(secret.username);
  if (nameKey.length >= 4 && stripDigits(secret.username) === nameKey) bump(86, 'fuzzy', 'Nama sama, beda angka di belakang');
  if (nameKey.length >= 5 && user.length >= 5 && (user.includes(nameKey) || nameKey.includes(user))) bump(78, 'fuzzy', 'Username memuat nama pelanggan');
  if (nameKey.length >= 4 && compactKey(comment).includes(nameKey)) bump(82, 'comment', 'Nama pelanggan ada di comment');
  const sim = Math.max(similarity(secret.username, customer.name), similarity(secret.username, customer.customer_code));
  if (sim >= 0.8) bump(Math.round(sim * 84), 'fuzzy', `Mirip ${Math.round(sim * 100)}%`);
  // Pola penamaan yang dominan di site ini.
  for (const p of ctx.patterns?.get(Number(secret.site_id)) || []) {
    const def = PATTERNS.find(x => x.id === p.id);
    if (!def || !def.test(user, customer)) continue;
    const base = LOOSE_PATTERNS.has(p.id) ? 70 : 76;
    bump(Math.min(89, Math.round(base + p.share * 16)), 'fuzzy', `Pola site: ${p.label} (${Math.round(p.share * 100)}% pelanggan)`);
    break;
  }
  // Profile = paket pelanggan: penguat saja, tidak pernah berdiri sendiri, dan tidak menyamai pasangan pasti.
  if (best > 0 && profileMatch(secret, customer)) { best = Math.min(94, best + 5); reasons.push('Profile sesuai paket'); }
  return { score: best, matchedOn: on, reasons: [...new Set(reasons)] };
}

function suggestMatches(secrets, customers, { minScore = 70, ctx = {} } = {}) {
  const bySite = new Map();
  customers.forEach(c => { const k = Number(c.site_id); if (!bySite.has(k)) bySite.set(k, []); bySite.get(k).push(c); });
  const raw = [];
  for (const s of secrets) {
    const pool = bySite.get(Number(s.site_id)) || [];
    const scored = pool.map(c => ({ c, ...scorePair(s, c, ctx) })).filter(x => x.score >= minScore).sort((a, b) => b.score - a.score);
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

/** Skor tebakan longgar (0-100) — dipakai hanya untuk mengurutkan opsi manual, tidak pernah auto-link. */
function guessScore(secret, customer, ctx = {}) {
  const strict = scorePair(secret, customer, ctx).score;
  const user = compactKey(secret.username);
  const name = compactKey(customer.name);
  const code = compactKey(customer.customer_code);
  let loose = Math.max(similarity(secret.username, customer.name), similarity(secret.username, customer.customer_code)) * 70;
  // Potongan kata yang sama ("budi" di "budi01" vs "Budi Santoso").
  const words = normalizeKey(customer.name).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (words.some(w => user.includes(w))) loose = Math.max(loose, 60);
  if (user.length >= 3 && (name.startsWith(user) || (code && code.startsWith(user)))) loose = Math.max(loose, 65);
  if (loose > 0 && profileMatch(secret, customer)) loose += 8;
  return Math.round(Math.min(100, Math.max(strict, loose)));
}

function rankUnmatched(secrets, freeCustomers, { limit = 5, minScore = 25, ctx = {} } = {}) {
  const bySite = new Map();
  freeCustomers.forEach(c => { const k = Number(c.site_id); if (!bySite.has(k)) bySite.set(k, []); bySite.get(k).push(c); });
  return secrets.map(s => {
    const pool = bySite.get(Number(s.site_id)) || [];
    const guesses = pool.map(c => ({ id: c.id, code: c.customer_code, name: c.name, score: guessScore(s, c, ctx) }))
      .filter(g => g.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit);
    return { secretId: s.id, username: s.username, comment: s.comment || '', siteId: s.site_id, poolSize: pool.length, guesses };
  });
}

module.exports = { normalizeKey, compactKey, exemptOf, fasumMatch, DEFAULT_FASUM_WORDS, buildSmartSyncPlan, suggestMatches, scorePair, guessScore, rankUnmatched, similarity, levenshtein, EXEMPT_RULES,
  parseCid, withCid, withoutCid, macKey, ipKey, detectRenames, learnPatterns, PATTERNS };
