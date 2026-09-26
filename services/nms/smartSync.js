// Smart Sync Engine: preview (dry-run) → commit, manual mapping, riwayat batch + undo, auto sync.
const crypto = require('crypto');
const db = require('../../config/db');
const cache = require('./cache');
const { buildSmartSyncPlan, guessScore, learnPatterns, parseCid, withCid, withoutCid, macKey, ipKey, normalizeKey } = require('./matching');
const store = require('./secretStore');
const bus = require('./eventBus');
const ros = require('./rosApi');
const settings = require('./settings');

const PLAN_TTL_MS = 30 * 60 * 1000;
const UNDO_WINDOW_H = 24;
const METHODS = new Set(['pppoe_username', 'customer_code', 'customer_name', 'manual', 'phone', 'comment', 'fuzzy', 'created', 'cid_tag', 'alias', 'moved', 'mac', 'ip']);
// Keputusan operator (bukan kecocokan pasti) → diingat sebagai alias username ↔ pelanggan.
const OPERATOR_METHODS = new Set(['manual', 'phone', 'comment', 'fuzzy', 'mac', 'ip', 'alias']);
const LOG_SCORE = { cid_tag: 100, customer_code: 100, alias: 99, moved: 100, customer_name: 95, mac: 90, ip: 88, phone: 88 };

const mappingLockName = siteId => `nms_ppp_mapping_site_${Number(siteId) || 'all'}`;
const networkStateOf = secret => Number(secret?.is_isolated) ? 'isolated' : Number(secret?.is_online) ? 'online' : 'offline';

async function reconcileCustomerMirror(conn, customerId, { source = 'manual' } = {}) {
  if (!customerId) return null;
  const [[linked]] = await conn.execute(`SELECT id, router_id, username, is_online, is_isolated
    FROM ppp_secrets
    WHERE customer_id=? AND removed_on_router_at IS NULL
    ORDER BY last_synced_at DESC, id DESC LIMIT 1 FOR UPDATE`, [customerId]);
  if (linked) {
    const status = networkStateOf(linked);
    await conn.execute(`UPDATE customers
      SET status_changed_at=IF(network_status<>?,NOW(),status_changed_at),
          router_id=?, pppoe_username=?, pppoe_synced_at=NOW(), pppoe_sync_source=?, network_status=?
      WHERE id=?`, [status, linked.router_id, linked.username, source, status, customerId]);
    return linked;
  }
  await conn.execute(`UPDATE customers
    SET status_changed_at=IF(network_status<>'offline',NOW(),status_changed_at),
        router_id=NULL, pppoe_username=NULL, pppoe_synced_at=NOW(), pppoe_sync_source=NULL, network_status='offline'
    WHERE id=?`, [customerId]);
  return null;
}

async function loadInputs(siteId) {
  const sp = siteId ? [Number(siteId)] : [];
  const [rawSecrets] = await db.query(`SELECT id, site_id, router_id, username, comment, profile, caller_id, active_caller_id, remote_address, active_address, is_exempt, cid_ignore
    FROM ppp_secrets WHERE customer_id IS NULL AND removed_on_router_at IS NULL ${siteId ? 'AND site_id=?' : ''}`, sp);
  // Tag CID yang sengaja dilepas operator (unmap/undo) tidak boleh menautkan ulang.
  const secrets = rawSecrets.map(s => (s.cid_ignore && parseCid(s.comment) === s.cid_ignore ? { ...s, comment: withoutCid(s.comment) } : s));
  // Secret lama yang sudah hilang dari router tidak dihitung "terikat": pelanggannya boleh dicocokkan ke secret baru.
  const [customers] = await db.query(`SELECT c.id, c.site_id, c.customer_code, c.name, c.phone, c.customer_status, c.pppoe_username, pk.mikrotik_profile, p.id linked_secret_id
    FROM customers c LEFT JOIN packages pk ON pk.id=c.package_id LEFT JOIN ppp_secrets p ON p.customer_id=c.id AND p.removed_on_router_at IS NULL
    WHERE c.archived_at IS NULL AND c.customer_status IN ('active','suspended') ${siteId ? 'AND c.site_id=?' : ''}`, sp);
  const ctx = await loadSignals(siteId, secrets);
  return { secrets, customers, ctx };
}

/** Sinyal tambahan Smart Sync: alias operator, pola penamaan site, MAC/IP link lama, IP WAN ONT (ACS). Semua best effort. */
async function loadSignals(siteId, secrets) {
  const sp = siteId ? [Number(siteId)] : [];
  const rows = async (sql, params = sp) => { try { const [r] = await db.query(sql, params); return r; } catch (_) { return []; } };
  const addTo = (map, id, v) => { if (!v) return; const k = Number(id); if (!map.has(k)) map.set(k, new Set()); map.get(k).add(v); };
  const ctx = { aliases: new Map(), patterns: new Map(), secretMacs: new Map(), customerMacs: new Map(), customerStaticIps: new Map(), customerLiveIps: new Map() };
  (await rows(`SELECT site_id, username_key, customer_id FROM nms_sync_aliases ${siteId ? 'WHERE site_id=?' : ''}`)).forEach(a => ctx.aliases.set(`${a.site_id}|${a.username_key}`, Number(a.customer_id)));
  ctx.patterns = learnPatterns(await rows(`SELECT p.site_id, p.username, c.name, c.customer_code, c.phone FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id
    WHERE p.removed_on_router_at IS NULL ${siteId ? 'AND p.site_id=?' : ''}`));
  // Perangkat & IP yang pernah dipakai pelanggan (termasuk secret lama yang sudah dihapus dari router).
  for (const r of await rows(`SELECT customer_id, caller_id, active_caller_id, remote_address FROM ppp_secrets WHERE customer_id IS NOT NULL ${siteId ? 'AND site_id=?' : ''}`)) {
    addTo(ctx.customerMacs, r.customer_id, macKey(r.caller_id)); addTo(ctx.customerMacs, r.customer_id, macKey(r.active_caller_id));
    addTo(ctx.customerStaticIps, r.customer_id, ipKey(r.remote_address));
  }
  for (const r of await rows(`SELECT customer_id, caller_id FROM nms_ppp_events WHERE customer_id IS NOT NULL AND event_type='login' AND caller_id IS NOT NULL AND caller_id<>''
      AND occurred_at >= DATE_SUB(NOW(), INTERVAL 180 DAY) ${siteId ? 'AND site_id=?' : ''} GROUP BY customer_id, caller_id`)) addTo(ctx.customerMacs, r.customer_id, macKey(r.caller_id));
  (await rows(`SELECT l.customer_id, d.wan_ip FROM customer_ont_links l JOIN acs_devices d ON d.id=l.acs_device_id WHERE d.wan_ip IS NOT NULL AND d.last_inform >= DATE_SUB(NOW(), INTERVAL 1 DAY)`, []))
    .forEach(r => addTo(ctx.customerLiveIps, r.customer_id, ipKey(r.wan_ip)));
  // MAC yang pernah login memakai secret yang belum ter-link.
  const secretKey = new Map(secrets.map(s => [`${s.router_id}|${String(s.username).toLowerCase()}`, s.id]));
  if (secretKey.size) {
    for (const r of await rows(`SELECT router_id, LOWER(username) u, caller_id FROM nms_ppp_events WHERE customer_id IS NULL AND event_type='login' AND caller_id IS NOT NULL AND caller_id<>''
        AND occurred_at >= DATE_SUB(NOW(), INTERVAL 60 DAY) ${siteId ? 'AND site_id=?' : ''} GROUP BY router_id, u, caller_id`)) {
      const id = secretKey.get(`${r.router_id}|${r.u}`); if (id) addTo(ctx.secretMacs, id, macKey(r.caller_id));
    }
  }
  return ctx;
}

/** Dry-run: tidak menulis DB. Rencana disimpan 30 menit dengan planId untuk di-commit. */
async function preview({ siteId = null, refresh = false } = {}) {
  const refreshResults = [];
  if (refresh) {
    // A stale mirror must never be used as the basis for a mutating Smart Sync.
    // The previous behavior silently continued with cached data when a router
    // was offline, which could link a customer to a secret that had been removed
    // or changed on RouterOS.
    for (const router of await store.activeRouters(siteId)) {
      try { refreshResults.push({ routerId: router.id, ok: true, ...(await store.syncRouterSecrets(router)) }); }
      catch (err) { refreshResults.push({ routerId: router.id, routerName: router.name, ok: false, error: err.message }); }
    }
    const failed = refreshResults.filter(r => !r.ok);
    if (failed.length) {
      const error = new Error(`Smart Sync ditahan: ${failed.map(r => r.routerName || r.routerId).join(', ')} tidak dapat diverifikasi. Tarik ulang setelah router kembali online.`);
      error.code = 'ROUTER_UNREACHABLE';
      error.refreshResults = refreshResults;
      throw error;
    }
  }
  // Pindah router dalam site yang sama: link dibawa sebelum rencana dihitung.
  const carried = await carryOverLinks(siteId).catch(err => { console.warn('NMS carry-over:', err.message); return []; });
  const { secrets, customers, ctx } = await loadInputs(siteId);
  const plan = buildSmartSyncPlan(secrets, customers, ctx);
  const [sites] = await db.query(`SELECT id, code FROM sites`);
  const siteCode = new Map(sites.map(s => [Number(s.id), s.code]));
  const decorate = row => ({ ...row, siteCode: siteCode.get(Number(row.siteId)) || null });
  const planId = crypto.randomUUID();
  const value = { planId, siteId: siteId ? Number(siteId) : null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    summary: plan.summary, pairs: plan.pairs.map(decorate), conflicts: plan.conflicts.map(decorate), suggestions: plan.suggestions.map(decorate), unmatched: plan.unmatched.map(decorate), freeCustomers: plan.freeCustomers, patterns: plan.patterns, carried, refreshResults };
  cache.set(`nms:plan:${planId}`, value, PLAN_TTL_MS);
  return value;
}

/** Link 1 secret ↔ 1 customer di dalam transaksi (dipakai commit & manual map). */
// opts.manual = operator memilih pasangan secara eksplisit (tombol Hubungkan / pilihan konflik):
// secret exempt boleh dihubungkan, dan bila pelanggan masih terikat ke secret lain, link lama
// dipindahkan ke secret ini (bukan gagal). Secret lama yang sudah hilang dari router selalu dilepas.
async function linkSecret(conn, secretId, customerId, method, { manual = false, allowExempt = false } = {}) {
  const [[secret]] = await conn.execute(`SELECT id, site_id, router_id, username, customer_id, removed_on_router_at, is_exempt, is_online, is_isolated, comment
    FROM ppp_secrets WHERE id=? FOR UPDATE`, [secretId]);
  if (!secret) throw new Error('PPP Secret tidak ditemukan.');
  if (secret.removed_on_router_at) throw new Error(`PPP Secret ${secret.username} sudah tidak ada di router.`);
  if (Number(secret.is_exempt) && !manual && !allowExempt) throw new Error(`PPP Secret ${secret.username} dikecualikan dari Smart Sync. Hubungkan manual bila memang milik pelanggan.`);

  const [[customer]] = await conn.execute(`SELECT id, site_id, name, customer_code, customer_status, router_id, pppoe_username
    FROM customers WHERE id=? AND archived_at IS NULL FOR UPDATE`, [customerId]);
  if (!customer) throw new Error('Pelanggan tidak ditemukan / diarsipkan.');
  if (!['active', 'suspended'].includes(String(customer.customer_status))) throw new Error(`Pelanggan ${customer.name} tidak aktif sehingga tidak dapat dihubungkan.`);
  if (Number(customer.site_id) !== Number(secret.site_id)) throw new Error(`Site pelanggan ${customer.name} berbeda dengan site router secret ${secret.username}.`);

  const previousOwnerId = secret.customer_id && Number(secret.customer_id) !== Number(customerId) ? Number(secret.customer_id) : null;
  if (previousOwnerId && !manual) throw new Error(`Secret ${secret.username} sudah terikat ke pelanggan lain. Gunakan Hubungkan manual bila ingin menimpa link.`);
  let previousOwner = null;
  if (previousOwnerId) {
    const [[row]] = await conn.execute(`SELECT id, name, customer_code, router_id, pppoe_username FROM customers WHERE id=? FOR UPDATE`, [previousOwnerId]);
    previousOwner = row || null;
  }

  const [takenRows] = await conn.execute(`SELECT id, router_id, username, removed_on_router_at, comment
    FROM ppp_secrets WHERE customer_id=? AND id<>? FOR UPDATE`, [customerId, secretId]);
  const blocking = takenRows.filter(t => !t.removed_on_router_at);
  if (blocking.length && !manual) throw new Error(`${customer.name} sudah terikat ke secret ${blocking[0].username}. Gunakan Hubungkan manual untuk memindahkan link.`);

  const releasedSecrets = takenRows.map(t => ({ id: Number(t.id), username: t.username, routerId: Number(t.router_id), removed: !!t.removed_on_router_at }));
  if (takenRows.length) {
    await conn.execute(`UPDATE ppp_secrets
      SET customer_id=NULL, sync_status='unsynced', match_method=NULL, last_synced_at=NOW(), cid_ignore=?
      WHERE id IN (${takenRows.map(() => '?').join(',')})`, [customer.customer_code || null, ...takenRows.map(t => t.id)]);
  }

  await conn.execute(`UPDATE ppp_secrets
    SET customer_id=?, sync_status='synced', match_method=?, last_synced_at=NOW(), cid_ignore=NULL
      ${manual || allowExempt ? ", is_exempt=0, exempt_type=NULL, exempt_source='manual'" : ''}
    WHERE id=?`, [customerId, METHODS.has(method) ? method : 'manual', secretId]);

  const source = method === 'manual' ? 'manual' : 'smart';
  if (OPERATOR_METHODS.has(method)) {
    await conn.execute(`INSERT INTO nms_sync_aliases (site_id, username_key, customer_id, source) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id), source=VALUES(source), hits=hits+1, last_used_at=NOW()`,
    [secret.site_id, normalizeKey(secret.username), customer.id, method]).catch(() => {});
  }

  const status = networkStateOf(secret);
  await conn.execute(`UPDATE customers
    SET status_changed_at=IF(network_status<>?,NOW(),status_changed_at),
        router_id=?, pppoe_username=?, pppoe_synced_at=NOW(), pppoe_sync_source=?, network_status=?
    WHERE id=?`, [status, secret.router_id, secret.username, source, status, customerId]);
  if (previousOwnerId) {
    await conn.execute(`DELETE FROM nms_sync_aliases WHERE site_id=? AND username_key=? AND customer_id=?`,
      [secret.site_id, normalizeKey(secret.username), previousOwnerId]).catch(() => {});
    await reconcileCustomerMirror(conn, previousOwnerId, { source: 'manual' });
  }

  const [[verifiedSecret]] = await conn.execute(`SELECT customer_id, sync_status FROM ppp_secrets WHERE id=? FOR UPDATE`, [secretId]);
  const [[verifiedCustomer]] = await conn.execute(`SELECT router_id, pppoe_username FROM customers WHERE id=? FOR UPDATE`, [customerId]);
  const [[duplicate]] = await conn.execute(`SELECT id, username FROM ppp_secrets
    WHERE customer_id=? AND id<>? AND removed_on_router_at IS NULL LIMIT 1 FOR UPDATE`, [customerId, secretId]);
  if (!verifiedSecret || Number(verifiedSecret.customer_id) !== Number(customerId) || verifiedSecret.sync_status !== 'synced') {
    throw new Error('Verifikasi link PPP Secret gagal: binding secret tidak tersimpan.');
  }
  if (!verifiedCustomer || Number(verifiedCustomer.router_id) !== Number(secret.router_id)
      || normalizeKey(verifiedCustomer.pppoe_username) !== normalizeKey(secret.username)) {
    throw new Error('Verifikasi link PPP Secret gagal: data pelanggan belum mengikuti secret.');
  }
  if (duplicate) throw new Error(`Verifikasi link gagal: pelanggan masih terikat ke secret ${duplicate.username}.`);

  await conn.execute(`INSERT INTO pppoe_sync_logs
    (customer_id, router_id, secret_id, secret_name, previous_router_id, previous_username, sync_source, match_score, status)
    VALUES (?,?,?,?,?,?,?,?,'success')`,
  [customer.id, secret.router_id, String(secret.id), secret.username, customer.router_id || null, customer.pppoe_username || null, source, LOG_SCORE[method] ?? null]);

  return {
    secret, customer,
    released: releasedSecrets.map(t => t.username),
    releasedSecrets,
    replacedCustomer: previousOwner ? { id: previousOwner.id, name: previousOwner.name, code: previousOwner.customer_code } : null,
    previous: { routerId: customer.router_id || null, username: customer.pppoe_username || null }
  };
}

async function linkMany(pairs) {
  const results = [];
  for (const pair of pairs) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const out = await linkSecret(conn, pair.secretId, pair.customerId, pair.matchedOn || pair.method, { manual: !pair.matchedOn && pair.method === 'manual' });
      const { secret, customer } = out;
      await conn.commit();
      queueCidTag(secret.id);
      for (const old of out.releasedSecrets || []) queueCidTag(old.id, { remove: true });
      results.push({
        ok: true, secretId: secret.id, username: secret.username, customerId: customer.id, customerName: customer.name,
        siteId: secret.site_id, method: pair.matchedOn || pair.method || 'manual', previous: out.previous,
        released: out.released || [], replacedCustomer: out.replacedCustomer || null
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      results.push({ ok: false, secretId: pair.secretId, username: pair.username, customerId: pair.customerId, error: err.message });
    } finally { conn.release(); }
  }
  return results;
}

async function recordBatch({ planId, siteId, source, results, userId }) {
  const linked = results.filter(r => r.ok);
  if (!linked.length) return null;
  const [res] = await db.execute(`INSERT INTO nms_sync_batches (plan_id, site_id, source, linked_count, pairs_json, created_by) VALUES (?,?,?,?,?,?)`,
    [planId || null, siteId || null, source, linked.length, JSON.stringify(linked.map(r => ({ secretId: r.secretId, customerId: r.customerId, username: r.username, customerName: r.customerName, method: r.method, previous: r.previous || null }))), userId || null]).catch(() => [{}]);
  return res.insertId || null;
}

/**
 * Commit rencana. Bila plan di memori hilang (restart/redeploy/instance lain/TTL), rencana dibangun
 * ulang dari DB dan hanya pasangan yang dikirim browser DAN masih identik yang di-link.
 * `manual`: pilihan eksplisit user (konflik diselesaikan inline / saran yang dicentang) → divalidasi
 * ulang oleh linkSecret (site sama, belum terikat).
 */
async function commit({ planId, secretIds = null, pairs: clientPairs = null, manual = null, siteId = null, userId = null, source = 'manual' }) {
  let plan = cache.get(`nms:plan:${planId}`);
  let revalidated = false;
  const extra = (Array.isArray(manual) ? manual : []).map(m => ({ secretId: Number(m.secretId), customerId: Number(m.customerId), method: METHODS.has(m.method) ? m.method : 'manual' })).filter(m => m.secretId && m.customerId);
  if (!plan) {
    const wanted = Array.isArray(clientPairs) ? clientPairs.filter(p => p && Number(p.secretId) && Number(p.customerId)) : [];
    if (!wanted.length && !extra.length) throw Object.assign(new Error('Preview kedaluwarsa atau tidak ditemukan. Jalankan Smart Sync Preview lagi.'), { status: 410 });
    const { secrets, customers, ctx } = await loadInputs(siteId);
    const fresh = buildSmartSyncPlan(secrets, customers, ctx);
    const key = p => `${Number(p.secretId)}:${Number(p.customerId)}`;
    const wantedKeys = new Set(wanted.map(key));
    plan = { planId, siteId: siteId ? Number(siteId) : null, pairs: fresh.pairs.filter(p => wantedKeys.has(key(p))) };
    plan.skipped = wanted.length - plan.pairs.length;
    revalidated = true;
  }
  const allow = Array.isArray(secretIds) && secretIds.length ? new Set(secretIds.map(Number)) : null;
  const manualIds = new Set(extra.map(m => m.secretId));
  const pairs = plan.pairs.filter(p => (!allow || allow.has(Number(p.secretId))) && !manualIds.has(Number(p.secretId)));
  // One operator per scope at a time.  Without this lock, two browser tabs can
  // preview the same candidates and race at commit; DB constraints protect
  // integrity, but the operator would receive a confusing partial result.
  const lockConn = await db.getConnection();
  const lockName = mappingLockName(plan.siteId);
  let locked = false;
  let results;
  try {
    const [[row]] = await lockConn.execute(`SELECT GET_LOCK(?, 8) locked`, [lockName]);
    locked = Number(row?.locked) === 1;
    if (!locked) throw Object.assign(new Error('Smart Sync untuk scope ini sedang diproses pengguna lain. Coba lagi beberapa saat.'), { status: 409 });
    results = await linkMany([...pairs, ...extra]);
  } finally {
    if (locked) await lockConn.execute(`SELECT RELEASE_LOCK(?)`, [lockName]).catch(() => {});
    lockConn.release();
  }
  cache.del(`nms:plan:${planId}`);
  cache.del('nms:dash');
  const batchId = await recordBatch({ planId, siteId: plan.siteId, source, results, userId });
  const summary = { planned: pairs.length + extra.length, linked: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, revalidated, skipped: plan.skipped || 0, batchId };
  bus.emit('sync', { siteId: plan.siteId, ...summary });
  return { planId, siteId: plan.siteId, summary, results };
}

async function manualMap(secretId, customerId, method = 'manual') {
  const initial = await store.secretById(secretId);
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[lock]] = await conn.execute(`SELECT GET_LOCK(?, 8) locked`, [mappingLockName(initial.site_id)]);
    locked = Number(lock?.locked) === 1;
    if (!locked) throw Object.assign(new Error('Mapping PPP site ini sedang diproses pengguna lain. Coba lagi.'), { status: 409 });
    await conn.beginTransaction();
    const out = await linkSecret(conn, secretId, customerId, method, { manual: true });
    await conn.commit();

    queueCidTag(secretId);
    for (const old of out.releasedSecrets || []) queueCidTag(old.id, { remove: true });
    cache.del('nms:dash');
    bus.emit('sync', {
      siteId: out.secret.site_id, manual: true, secretId: out.secret.id, customerId: out.customer.id,
      released: out.released || [], replacedCustomerId: out.replacedCustomer?.id || null
    });
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (locked) await conn.execute(`SELECT RELEASE_LOCK(?)`, [mappingLockName(initial.site_id)]).catch(() => {});
    conn.release();
  }
}

async function unmap(secretId) {
  const initial = await store.secretById(secretId);
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[lock]] = await conn.execute(`SELECT GET_LOCK(?, 8) locked`, [mappingLockName(initial.site_id)]);
    locked = Number(lock?.locked) === 1;
    if (!locked) throw Object.assign(new Error('Mapping PPP site ini sedang diproses pengguna lain. Coba lagi.'), { status: 409 });
    await conn.beginTransaction();

    const [[secret]] = await conn.execute(`SELECT id, site_id, router_id, username, customer_id, comment
      FROM ppp_secrets WHERE id=? FOR UPDATE`, [secretId]);
    if (!secret) throw Object.assign(new Error('PPP Secret tidak ditemukan.'), { status: 404 });
    if (!secret.customer_id) {
      await conn.commit();
      return { secret, customerId: null, alreadyUnlinked: true };
    }

    const customerId = Number(secret.customer_id);
    const [[cust]] = await conn.execute(`SELECT id, customer_code, router_id, pppoe_username FROM customers WHERE id=? FOR UPDATE`, [customerId]);
    const ignoreCid = parseCid(secret.comment) || cust?.customer_code || null;

    await conn.execute(`UPDATE ppp_secrets
      SET customer_id=NULL, sync_status='unsynced', match_method=NULL, last_synced_at=NOW(), cid_ignore=?
      WHERE id=?`, [ignoreCid, secretId]);
    await conn.execute(`DELETE FROM nms_sync_aliases WHERE site_id=? AND username_key=? AND customer_id=?`,
      [secret.site_id, normalizeKey(secret.username), customerId]).catch(() => {});

    const fallback = await reconcileCustomerMirror(conn, customerId, { source: 'manual' });

    const [[verified]] = await conn.execute(`SELECT customer_id, sync_status, cid_ignore FROM ppp_secrets WHERE id=? FOR UPDATE`, [secretId]);
    const [[customerAfter]] = await conn.execute(`SELECT router_id, pppoe_username FROM customers WHERE id=? FOR UPDATE`, [customerId]);
    if (!verified || verified.customer_id !== null || verified.sync_status !== 'unsynced') {
      throw new Error('Verifikasi lepas link gagal: PPP Secret masih terhubung.');
    }
    if (!fallback && customerAfter && (customerAfter.router_id !== null || String(customerAfter.pppoe_username || '').trim() !== '')) {
      throw new Error('Verifikasi lepas link gagal: data pelanggan masih menyimpan PPPoE lama.');
    }

    await conn.commit();
    queueCidTag(secretId, { remove: true });
    cache.del('nms:dash');
    bus.emit('sync', { siteId: secret.site_id, unmap: true, secretId: secret.id, customerId });
    return { secret, customerId, fallbackSecret: fallback ? { id: fallback.id, username: fallback.username } : null };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (locked) await conn.execute(`SELECT RELEASE_LOCK(?)`, [mappingLockName(initial.site_id)]).catch(() => {});
    conn.release();
  }
}

async function batches({ limit = 30 } = {}) {
  const [rows] = await db.query(`SELECT b.id, b.plan_id, b.site_id, s.code site_code, b.source, b.linked_count, b.pairs_json, b.created_at, b.undone_at, u.name created_by_name, u2.name undone_by_name,
      (b.undone_at IS NULL AND b.created_at >= DATE_SUB(NOW(), INTERVAL ${UNDO_WINDOW_H} HOUR)) can_undo
    FROM nms_sync_batches b LEFT JOIN sites s ON s.id=b.site_id LEFT JOIN users u ON u.id=b.created_by LEFT JOIN users u2 ON u2.id=b.undone_by
    ORDER BY b.id DESC LIMIT ?`, [Math.min(100, Number(limit) || 30)]);
  return rows.map(r => { let pairs = []; try { pairs = JSON.parse(r.pairs_json || '[]'); } catch (_) {} const { pairs_json, ...rest } = r; return { ...rest, can_undo: !!Number(r.can_undo), pairs }; });
}

async function batchCsv(batchId) {
  const [[batch]] = await db.query(`SELECT b.id, b.created_at, b.source, b.pairs_json, s.code site_code FROM nms_sync_batches b LEFT JOIN sites s ON s.id=b.site_id WHERE b.id=?`, [batchId]);
  if (!batch) throw Object.assign(new Error('Batch Smart Sync tidak ditemukan.'), { status: 404 });
  let pairs = []; try { pairs = JSON.parse(batch.pairs_json || '[]'); } catch (_) {}
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const safe = v => /^[=+\-@]/.test(String(v ?? '')) ? `'${v}` : v;
  const lines = [['batch_id', 'site', 'created_at', 'source', 'secret_id', 'username', 'customer_id', 'customer_name', 'method', 'previous_router_id', 'previous_username'], ...pairs.map(p => [batch.id, batch.site_code || '', batch.created_at, batch.source, p.secretId, safe(p.username), p.customerId, safe(p.customerName), p.method || '', p.previous?.routerId || '', safe(p.previous?.username || '')])];
  return { name: `smart-sync-batch-${batch.id}`, csv: '\ufeff' + lines.map(row => row.map(esc).join(',')).join('\n') };
}

/** Batalkan 1 batch Smart Sync: hanya pasangan yang MASIH terikat ke pelanggan yang sama yang dilepas. */
async function undoBatch(batchId, userId = null) {
  const [[b]] = await db.query(`SELECT * FROM nms_sync_batches WHERE id=?`, [batchId]);
  if (!b) throw Object.assign(new Error('Batch Smart Sync tidak ditemukan.'), { status: 404 });
  if (b.undone_at) throw new Error('Batch ini sudah dibatalkan.');
  if (Date.now() - new Date(b.created_at).getTime() > UNDO_WINDOW_H * 3600000) throw new Error(`Undo hanya bisa dalam ${UNDO_WINDOW_H} jam setelah sync.`);
  let pairs = []; try { pairs = JSON.parse(b.pairs_json || '[]'); } catch (_) {}
  let released = 0, kept = 0;
  for (const p of pairs) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(`SELECT id, customer_id, router_id, username FROM ppp_secrets WHERE id=? FOR UPDATE`, [p.secretId]);
      if (!row || Number(row.customer_id) !== Number(p.customerId)) { kept++; await conn.rollback(); continue; }
      await conn.execute(`UPDATE ppp_secrets SET customer_id=NULL, sync_status='unsynced', match_method=NULL, last_synced_at=NOW(), cid_ignore=(SELECT customer_code FROM customers WHERE id=?) WHERE id=?`, [p.customerId, p.secretId]);
      await conn.execute(`DELETE FROM nms_sync_aliases WHERE username_key=? AND customer_id=?`, [normalizeKey(row.username), p.customerId]).catch(() => {});
      // Restore the customer-side link captured at commit time.  The guard
      // preserves a later manual edit instead of overwriting it during undo.
      const old = p.previous || {};
      await conn.execute(`UPDATE customers SET router_id=?, pppoe_username=?, pppoe_synced_at=NOW(), pppoe_sync_source='smart'
        WHERE id=? AND router_id=? AND LOWER(COALESCE(pppoe_username,''))=LOWER(?)`,
      [old.routerId || null, old.username || null, p.customerId, row.router_id, row.username]);
      await conn.commit(); released++;
      queueCidTag(p.secretId, { remove: true });
    } catch (err) {
      await conn.rollback().catch(() => {}); kept++;
    } finally { conn.release(); }
  }
  await db.execute(`UPDATE nms_sync_batches SET undone_at=NOW(), undone_by=? WHERE id=?`, [userId, batchId]);
  cache.del('nms:dash');
  bus.emit('sync', { siteId: b.site_id, undone: batchId, released });
  return { batchId: Number(batchId), released, kept, siteId: b.site_id };
}

/** Auto Smart Sync (cron): commit hanya pasangan exact (keyakinan tinggi) bila diizinkan. */
async function autoRun({ commitHigh = false } = {}) {
  // Auto mode is still a mutating operation when commitHigh is enabled; it
  // must receive the same RouterOS freshness guarantee as a manual commit.
  const plan = await preview({ refresh: true });
  let committed = null;
  if (commitHigh && plan.pairs.length) committed = await commit({ planId: plan.planId, secretIds: plan.pairs.map(p => p.secretId), source: 'auto' });
  const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM ppp_secrets WHERE customer_id IS NULL AND is_exempt=0 AND removed_on_router_at IS NULL`);
  const [[{ fresh }]] = await db.query(`SELECT COUNT(*) fresh FROM ppp_secrets WHERE customer_id IS NULL AND is_exempt=0 AND removed_on_router_at IS NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`);
  return { unsynced: Number(n), newLastHour: Number(fresh), matched: plan.pairs.length, suggested: plan.suggestions.length, conflicts: plan.conflicts.length, linked: committed?.summary.linked || 0 };
}

async function searchCustomers({ q = '', siteId = null, limit = 20 }) {
  const where = [`c.archived_at IS NULL`];
  const params = [];
  if (siteId) { where.push('c.site_id=?'); params.push(Number(siteId)); }
  if (q) { where.push('(c.name LIKE ? OR c.customer_code LIKE ? OR c.phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const [rows] = await db.query(`SELECT c.id, c.customer_code, c.name, c.site_id, s.code site_code, c.customer_status,
      p.id linked_secret_id, p.username linked_username
    FROM customers c JOIN sites s ON s.id=c.site_id
      LEFT JOIN ppp_secrets p ON p.customer_id=c.id AND p.removed_on_router_at IS NULL
    WHERE ${where.join(' AND ')}
    ORDER BY (p.id IS NULL) DESC, c.name LIMIT ?`, [...params, Math.min(50, Number(limit) || 20)]);
  return rows;
}

/** Pelanggan aktif/suspended yang belum terhubung ke secret mana pun, diurutkan dari yang paling mirip dengan secret. */
async function unlinkedCustomers({ siteId = null, secretId = null, limit = 500 }) {
  let secret = null;
  if (secretId) { const [[row]] = await db.query(`SELECT id, site_id, router_id, username, comment, profile, caller_id, active_caller_id, remote_address, active_address FROM ppp_secrets WHERE id=?`, [Number(secretId)]); secret = row || null; }
  const site = siteId || secret?.site_id || null;
  const [rows] = await db.query(`SELECT c.id, c.customer_code, c.name, c.phone, c.site_id, s.code site_code, c.customer_status, pk.mikrotik_profile
    FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN packages pk ON pk.id=c.package_id LEFT JOIN ppp_secrets p ON p.customer_id=c.id AND p.removed_on_router_at IS NULL
    WHERE c.archived_at IS NULL AND c.customer_status IN ('active','suspended') AND p.id IS NULL ${site ? 'AND c.site_id=?' : ''}
    ORDER BY c.name LIMIT ?`, [...(site ? [Number(site)] : []), Math.min(2000, Number(limit) || 500)]);
  const ctx = secret ? await loadSignals(site, [secret]) : {};
  const out = rows.map(c => ({ ...c, score: secret ? guessScore(secret, c, ctx) : 0 }));
  if (secret) out.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), 'id'));
  return out;
}

// ---------------------------------------------------------------- Tag [CID:…] di comment RouterOS
/** Tulis (atau hapus) tag Customer ID ke comment secret di router. Tidak pernah melempar ke pemanggil link. */
async function writeCidTag(secretId, { remove = false } = {}) {
  const secret = await store.secretById(secretId);
  let code = null;
  if (!remove) {
    if (!secret.customer_id) return { skipped: 'unlinked' };
    const [[c]] = await db.query(`SELECT customer_code FROM customers WHERE id=?`, [secret.customer_id]);
    code = c?.customer_code; if (!code) return { skipped: 'no_code' };
  }
  const router = await store.routerById(secret.router_id);
  const live = await ros.secretByName(router, secret.username);
  if (!live) return { skipped: 'missing' };
  const current = String(live.comment || '').trim();
  const next = remove ? withoutCid(current) : withCid(current, code);
  if (next === current) { if (remove) await db.execute(`UPDATE ppp_secrets SET cid_ignore=NULL WHERE id=?`, [secret.id]); return { unchanged: true }; }
  await ros.patchSecret(router, live['.id'], { comment: next });
  await db.execute(`UPDATE ppp_secrets SET comment=?${remove ? ', cid_ignore=NULL' : ''} WHERE id=?`, [next.slice(0, 255) || null, secret.id]);
  return { written: true, comment: next };
}
function queueCidTag(secretId, opts = {}) {
  settings.flag('cid_tag_enabled').then(on => (on ? writeCidTag(secretId, opts) : null))
    .catch(err => console.warn(`NMS tag CID #${secretId}:`, err.message));
}

/**
 * Self-healing CID binding.
 * customer_id di database adalah binding utama setelah secret pernah ter-link. Comment RouterOS
 * hanya marker durable untuk recovery. Bila teknisi mengubah/menghapus comment dari Winbox,
 * marker CID yang benar ditulis kembali tanpa mengubah teks comment lainnya.
 */
async function healLinkedCidTags(routerId, { limit = 25 } = {}) {
  if (!(await settings.flag('cid_tag_enabled'))) return { checked: 0, healed: 0, failed: 0, disabled: true };
  const [rows] = await db.query(`SELECT p.id, p.comment, c.customer_code
    FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id
    WHERE p.router_id=? AND p.removed_on_router_at IS NULL AND c.archived_at IS NULL
    ORDER BY p.id`, [Number(routerId)]);
  const max = Math.max(1, Math.min(200, Number(limit) || 25));
  const wrong = rows.filter(r => String(parseCid(r.comment) || '').toLowerCase() !== String(r.customer_code || '').toLowerCase()).slice(0, max);
  let healed = 0, failed = 0;
  for (const r of wrong) {
    try { const out = await writeCidTag(r.id); if (out.written || out.unchanged) healed++; }
    catch (err) { failed++; console.warn(`NMS self-heal CID #${r.id}:`, err.message); }
  }
  return { checked: rows.length, mismatched: wrong.length, healed, failed };
}

/** Tulis tag ke semua secret ter-link yang belum/salah tag. Berjalan di latar; progres di cache nms:cidjob. */
async function writeAllCidTags({ siteId = null, userId = null } = {}) {
  const running = cache.get('nms:cidjob');
  if (running && !running.done) throw Object.assign(new Error('Penulisan tag CID masih berjalan.'), { status: 409 });
  const [rows] = await db.query(`SELECT p.id, p.comment, c.customer_code FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id
    WHERE p.removed_on_router_at IS NULL ${siteId ? 'AND p.site_id=?' : ''}`, siteId ? [Number(siteId)] : []);
  const todo = rows.filter(r => String(parseCid(r.comment) || '').toLowerCase() !== String(r.customer_code || '').toLowerCase());
  const job = { total: todo.length, done: false, written: 0, unchanged: 0, failed: 0, errors: [], startedAt: new Date().toISOString(), siteId };
  cache.set('nms:cidjob', job, 6 * 3600000);
  (async () => {
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const r = queue.shift();
        try { const out = await writeCidTag(r.id); if (out.written) job.written++; else job.unchanged++; }
        catch (err) { job.failed++; if (job.errors.length < 5) job.errors.push(`#${r.id}: ${err.message}`); }
      }
    }));
    job.done = true; job.finishedAt = new Date().toISOString();
    bus.emit('sync', { siteId, cidTags: job.written });
    const { audit } = require('../auditService');
    audit({ userId, action: 'nms_cid_tags', entityType: 'ppp_secret_bulk', siteId, description: `Tulis tag CID: ${job.written} ditulis, ${job.failed} gagal dari ${job.total}`, details: job }).catch(() => {});
  })().catch(err => { job.done = true; job.failed = job.total; job.errors.push(err.message); });
  return job;
}
const cidJobStatus = () => cache.get('nms:cidjob') || null;

/** Pulihkan link dari tag [CID:…] (router di-reset / restore backup). Hanya pelanggan yang belum punya secret aktif. */
async function relinkByCid(routerId) {
  const [rows] = await db.query(`SELECT id, site_id, username, comment, cid_ignore FROM ppp_secrets
    WHERE router_id=? AND customer_id IS NULL AND removed_on_router_at IS NULL AND comment LIKE '%[CID:%'`, [routerId]);
  const linked = [];
  for (const r of rows) {
    const code = parseCid(r.comment);
    if (!code || (r.cid_ignore && r.cid_ignore === code)) continue;
    const [[c]] = await db.query(`SELECT c.id FROM customers c LEFT JOIN ppp_secrets p ON p.customer_id=c.id AND p.removed_on_router_at IS NULL
      WHERE c.site_id=? AND c.customer_code=? AND c.archived_at IS NULL AND c.customer_status IN ('active','suspended') AND p.id IS NULL LIMIT 1`, [r.site_id, code]);
    if (!c) continue;
    const conn = await db.getConnection();
    try { await conn.beginTransaction(); await linkSecret(conn, r.id, c.id, 'cid_tag'); await conn.commit(); linked.push({ secretId: r.id, customerId: c.id, username: r.username }); }
    catch (err) { await conn.rollback().catch(() => {}); }
    finally { conn.release(); }
  }
  if (linked.length) { cache.del('nms:dash'); bus.emit('sync', { routerId, relinkedByTag: linked.length }); }
  return linked;
}

/** Pelanggan pindah router di site yang sama: username sama muncul di router lain, secret lama sudah hilang → link dibawa. */
async function carryOverLinks(siteId = null) {
  const [rows] = await db.query(`SELECT n.id new_id, n.username, o.id old_id, o.customer_id, o.router_id old_router_id
    FROM ppp_secrets n JOIN ppp_secrets o ON o.site_id=n.site_id AND o.router_id<>n.router_id AND LOWER(o.username)=LOWER(n.username)
    WHERE n.customer_id IS NULL AND n.removed_on_router_at IS NULL AND o.customer_id IS NOT NULL AND o.removed_on_router_at IS NOT NULL ${siteId ? 'AND n.site_id=?' : ''}
    ORDER BY o.removed_on_router_at DESC`, siteId ? [Number(siteId)] : []);
  const seenCustomer = new Set(), seenSecret = new Set(), moved = [];
  for (const r of rows) {
    if (seenCustomer.has(r.customer_id) || seenSecret.has(r.new_id)) continue;
    seenCustomer.add(r.customer_id); seenSecret.add(r.new_id);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      // Pelanggan sudah punya secret aktif lain → bukan pindah router, jangan diubah.
      const [[active]] = await conn.execute(`SELECT id FROM ppp_secrets WHERE customer_id=? AND removed_on_router_at IS NULL LIMIT 1`, [r.customer_id]);
      if (active) { await conn.rollback(); continue; }
      await linkSecret(conn, r.new_id, r.customer_id, 'moved', { allowExempt: true });
      await conn.commit();
      moved.push({ secretId: r.new_id, customerId: r.customer_id, username: r.username, fromRouterId: r.old_router_id });
      queueCidTag(r.new_id);
    } catch (err) { await conn.rollback().catch(() => {}); }
    finally { conn.release(); }
  }
  if (moved.length) {
    cache.del('nms:dash');
    for (const m of moved) await db.execute(`INSERT INTO nms_ppp_events (site_id, username, customer_id, event_type, message, source) SELECT site_id, username, customer_id, 'map', ?, 'action' FROM ppp_secrets WHERE id=?`, [`Link dibawa dari router lama (pindah router)`, m.secretId]).catch(() => {});
    bus.emit('sync', { siteId, moved: moved.length });
  }
  return moved;
}

module.exports = { preview, commit, manualMap, unmap, searchCustomers, unlinkedCustomers, writeCidTag, writeAllCidTags, cidJobStatus, healLinkedCidTags, relinkByCid, carryOverLinks, loadInputs, batches, batchCsv, undoBatch, autoRun, linkSecret };
