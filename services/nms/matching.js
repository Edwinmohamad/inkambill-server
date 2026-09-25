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
  return { pairs, conflicts, summary: { scanned: secrets.length, matched: pairs.length, conflicts: conflicts.length, unmatched: secrets.filter(s => !s.is_exempt).length - pairs.length - conflicts.length } };
}

module.exports = { normalizeKey, compactKey, exemptOf, buildSmartSyncPlan, EXEMPT_RULES };
