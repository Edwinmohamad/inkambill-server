// Smart Sync Engine: preview (dry-run) → commit, manual mapping, riwayat batch + undo, auto sync.
const crypto = require('crypto');
const db = require('../../config/db');
const cache = require('./cache');
const { buildSmartSyncPlan } = require('./matching');
const store = require('./secretStore');
const bus = require('./eventBus');

const PLAN_TTL_MS = 30 * 60 * 1000;
const UNDO_WINDOW_H = 24;
const METHODS = new Set(['pppoe_username', 'customer_code', 'customer_name', 'manual', 'phone', 'comment', 'fuzzy', 'created']);

async function loadInputs(siteId) {
  const sp = siteId ? [Number(siteId)] : [];
  const [secrets] = await db.query(`SELECT id, site_id, router_id, username, comment, is_exempt FROM ppp_secrets WHERE customer_id IS NULL AND removed_on_router_at IS NULL ${siteId ? 'AND site_id=?' : ''}`, sp);
  const [customers] = await db.query(`SELECT c.id, c.site_id, c.customer_code, c.name, c.phone, p.id linked_secret_id
    FROM customers c LEFT JOIN ppp_secrets p ON p.customer_id=c.id
    WHERE c.archived_at IS NULL AND c.customer_status IN ('active','suspended') ${siteId ? 'AND c.site_id=?' : ''}`, sp);
  return { secrets, customers };
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
  const { secrets, customers } = await loadInputs(siteId);
  const plan = buildSmartSyncPlan(secrets, customers);
  const [sites] = await db.query(`SELECT id, code FROM sites`);
  const siteCode = new Map(sites.map(s => [Number(s.id), s.code]));
  const decorate = row => ({ ...row, siteCode: siteCode.get(Number(row.siteId)) || null });
  const planId = crypto.randomUUID();
  const value = { planId, siteId: siteId ? Number(siteId) : null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    summary: plan.summary, pairs: plan.pairs.map(decorate), conflicts: plan.conflicts.map(decorate), suggestions: plan.suggestions.map(decorate), refreshResults };
  cache.set(`nms:plan:${planId}`, value, PLAN_TTL_MS);
  return value;
}

/** Link 1 secret ↔ 1 customer di dalam transaksi (dipakai commit & manual map). */
async function linkSecret(conn, secretId, customerId, method) {
  const [[secret]] = await conn.execute(`SELECT id, site_id, router_id, username, customer_id, removed_on_router_at, is_exempt FROM ppp_secrets WHERE id=? FOR UPDATE`, [secretId]);
  if (!secret) throw new Error('PPP Secret tidak ditemukan.');
  if (secret.removed_on_router_at) throw new Error(`PPP Secret ${secret.username} sudah tidak ada di router.`);
  if (Number(secret.is_exempt)) throw new Error(`PPP Secret ${secret.username} dikecualikan dari Smart Sync.`);
  if (secret.customer_id && Number(secret.customer_id) !== Number(customerId)) throw new Error(`Secret ${secret.username} sudah terikat ke pelanggan lain.`);
  const [[customer]] = await conn.execute(`SELECT id, site_id, name, customer_code, customer_status, router_id, pppoe_username FROM customers WHERE id=? AND archived_at IS NULL FOR UPDATE`, [customerId]);
  if (!customer) throw new Error('Pelanggan tidak ditemukan / diarsipkan.');
  if (!['active', 'suspended'].includes(String(customer.customer_status))) throw new Error(`Pelanggan ${customer.name} tidak aktif sehingga tidak dapat dihubungkan.`);
  if (Number(customer.site_id) !== Number(secret.site_id)) throw new Error(`Site pelanggan ${customer.name} berbeda dengan site router secret ${secret.username}.`);
  const [[taken]] = await conn.execute(`SELECT id, username FROM ppp_secrets WHERE customer_id=? AND id<>? LIMIT 1`, [customerId, secretId]);
  if (taken) throw new Error(`${customer.name} sudah terikat ke secret ${taken.username}.`);
  await conn.execute(`UPDATE ppp_secrets SET customer_id=?, sync_status='synced', match_method=?, last_synced_at=NOW() WHERE id=?`, [customerId, METHODS.has(method) ? method : 'manual', secretId]);
  // Jaga kompatibilitas modul billing/auto-isolir yang masih membaca customers.pppoe_username.
  const source = method === 'manual' ? 'manual' : 'smart';
  await conn.execute(`UPDATE customers SET router_id=?, pppoe_username=?, pppoe_synced_at=NOW(), pppoe_sync_source=? WHERE id=?`, [secret.router_id, secret.username, source, customerId]);
  // Durable audit proves that the billing-side link was committed.  This is
  // deliberately in the same transaction as both records, so a partial sync
  // can never be reported as successful.
  await conn.execute(`INSERT INTO pppoe_sync_logs (customer_id, router_id, secret_id, secret_name, previous_router_id, previous_username, sync_source, match_score, status)
    VALUES (?,?,?,?,?,?,?,?,'success')`, [customer.id, secret.router_id, String(secret.id), secret.username, customer.router_id || null, customer.pppoe_username || null, source, method === 'customer_code' ? 100 : method === 'customer_name' ? 95 : null]);
  return { secret, customer, previous: { routerId: customer.router_id || null, username: customer.pppoe_username || null } };
}

async function linkMany(pairs) {
  const results = [];
  for (const pair of pairs) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const out = await linkSecret(conn, pair.secretId, pair.customerId, pair.matchedOn || pair.method);
      const { secret, customer } = out;
      await conn.commit();
      results.push({ ok: true, secretId: secret.id, username: secret.username, customerId: customer.id, customerName: customer.name, siteId: secret.site_id, method: pair.matchedOn || pair.method || 'manual', previous: out.previous });
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
    const { secrets, customers } = await loadInputs(siteId);
    const fresh = buildSmartSyncPlan(secrets, customers);
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
  const lockName = `nms_smart_sync_site_${plan.siteId || 'all'}`;
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
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await linkSecret(conn, secretId, customerId, method);
    await conn.commit();
    cache.del('nms:dash');
    return out;
  } catch (err) { await conn.rollback().catch(() => {}); throw err; }
  finally { conn.release(); }
}

async function unmap(secretId) {
  const secret = await store.secretById(secretId);
  if (!secret.customer_id) return { secret, customerId: null };
  await db.execute(`UPDATE ppp_secrets SET customer_id=NULL, sync_status='unsynced', match_method=NULL, last_synced_at=NOW() WHERE id=?`, [secretId]);
  await db.execute(`UPDATE customers SET pppoe_username=NULL WHERE id=? AND LOWER(pppoe_username)=LOWER(?)`, [secret.customer_id, secret.username]);
  cache.del('nms:dash');
  return { secret, customerId: secret.customer_id };
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
      await conn.execute(`UPDATE ppp_secrets SET customer_id=NULL, sync_status='unsynced', match_method=NULL, last_synced_at=NOW() WHERE id=?`, [p.secretId]);
      // Restore the customer-side link captured at commit time.  The guard
      // preserves a later manual edit instead of overwriting it during undo.
      const old = p.previous || {};
      await conn.execute(`UPDATE customers SET router_id=?, pppoe_username=?, pppoe_synced_at=NOW(), pppoe_sync_source='smart'
        WHERE id=? AND router_id=? AND LOWER(COALESCE(pppoe_username,''))=LOWER(?)`,
      [old.routerId || null, old.username || null, p.customerId, row.router_id, row.username]);
      await conn.commit(); released++;
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
  const [rows] = await db.query(`SELECT c.id, c.customer_code, c.name, c.site_id, s.code site_code, c.customer_status, p.username linked_username
    FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN ppp_secrets p ON p.customer_id=c.id
    WHERE ${where.join(' AND ')} ORDER BY (p.id IS NULL) DESC, c.name LIMIT ?`, [...params, Math.min(50, Number(limit) || 20)]);
  return rows;
}

module.exports = { preview, commit, manualMap, unmap, searchCustomers, batches, batchCsv, undoBatch, autoRun, linkSecret };
