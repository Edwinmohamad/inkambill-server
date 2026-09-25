// Smart Sync Engine: preview (dry-run) → commit, plus manual mapping.
const crypto = require('crypto');
const db = require('../../config/db');
const cache = require('./cache');
const { buildSmartSyncPlan } = require('./matching');
const store = require('./secretStore');
const bus = require('./eventBus');

const PLAN_TTL_MS = 10 * 60 * 1000;

async function loadInputs(siteId) {
  const sp = siteId ? [Number(siteId)] : [];
  const [secrets] = await db.query(`SELECT id, site_id, router_id, username, is_exempt FROM ppp_secrets WHERE customer_id IS NULL AND removed_on_router_at IS NULL ${siteId ? 'AND site_id=?' : ''}`, sp);
  const [customers] = await db.query(`SELECT c.id, c.site_id, c.customer_code, c.name, p.id linked_secret_id
    FROM customers c LEFT JOIN ppp_secrets p ON p.customer_id=c.id
    WHERE c.archived_at IS NULL AND c.customer_status IN ('active','suspended') ${siteId ? 'AND c.site_id=?' : ''}`, sp);
  return { secrets, customers };
}

/** Dry-run: tidak menulis DB. Rencana disimpan 10 menit dengan planId untuk di-commit. */
async function preview({ siteId = null, refresh = false } = {}) {
  if (refresh) {
    for (const router of await store.activeRouters(siteId)) { try { await store.syncRouterSecrets(router); } catch (_) { /* router offline → pakai cache DB */ } }
  }
  const { secrets, customers } = await loadInputs(siteId);
  const plan = buildSmartSyncPlan(secrets, customers);
  const [sites] = await db.query(`SELECT id, code FROM sites`);
  const siteCode = new Map(sites.map(s => [Number(s.id), s.code]));
  const decorate = row => ({ ...row, siteCode: siteCode.get(Number(row.siteId)) || null });
  const planId = crypto.randomUUID();
  const value = { planId, siteId: siteId ? Number(siteId) : null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(), summary: plan.summary, pairs: plan.pairs.map(decorate), conflicts: plan.conflicts.map(decorate) };
  cache.set(`nms:plan:${planId}`, value, PLAN_TTL_MS);
  return value;
}

/** Link 1 secret ↔ 1 customer di dalam transaksi (dipakai commit & manual map). */
async function linkSecret(conn, secretId, customerId, method) {
  const [[secret]] = await conn.execute(`SELECT id, site_id, router_id, username, customer_id FROM ppp_secrets WHERE id=? FOR UPDATE`, [secretId]);
  if (!secret) throw new Error('PPP Secret tidak ditemukan.');
  if (secret.customer_id && Number(secret.customer_id) !== Number(customerId)) throw new Error(`Secret ${secret.username} sudah terikat ke pelanggan lain.`);
  const [[customer]] = await conn.execute(`SELECT id, site_id, name, customer_code FROM customers WHERE id=? AND archived_at IS NULL FOR UPDATE`, [customerId]);
  if (!customer) throw new Error('Pelanggan tidak ditemukan / diarsipkan.');
  if (Number(customer.site_id) !== Number(secret.site_id)) throw new Error(`Site pelanggan ${customer.name} berbeda dengan site router secret ${secret.username}.`);
  const [[taken]] = await conn.execute(`SELECT id, username FROM ppp_secrets WHERE customer_id=? AND id<>? LIMIT 1`, [customerId, secretId]);
  if (taken) throw new Error(`${customer.name} sudah terikat ke secret ${taken.username}.`);
  await conn.execute(`UPDATE ppp_secrets SET customer_id=?, sync_status='synced', match_method=?, last_synced_at=NOW() WHERE id=?`, [customerId, method, secretId]);
  // Jaga kompatibilitas modul billing/auto-isolir yang masih membaca customers.pppoe_username.
  await conn.execute(`UPDATE customers SET router_id=?, pppoe_username=? WHERE id=?`, [secret.router_id, secret.username, customerId]);
  return { secret, customer };
}

async function commit({ planId, secretIds = null }) {
  const plan = cache.get(`nms:plan:${planId}`);
  if (!plan) throw Object.assign(new Error('Preview kedaluwarsa atau tidak ditemukan. Jalankan Smart Sync Preview lagi.'), { status: 410 });
  const allow = Array.isArray(secretIds) && secretIds.length ? new Set(secretIds.map(Number)) : null;
  const pairs = plan.pairs.filter(p => !allow || allow.has(Number(p.secretId)));
  const results = [];
  for (const pair of pairs) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const { secret, customer } = await linkSecret(conn, pair.secretId, pair.customerId, pair.matchedOn);
      await conn.commit();
      results.push({ ok: true, secretId: secret.id, username: secret.username, customerId: customer.id, customerName: customer.name, siteId: secret.site_id });
    } catch (err) {
      await conn.rollback().catch(() => {});
      results.push({ ok: false, secretId: pair.secretId, username: pair.username, customerId: pair.customerId, error: err.message });
    } finally { conn.release(); }
  }
  cache.del(`nms:plan:${planId}`);
  cache.del('nms:dash');
  const summary = { planned: pairs.length, linked: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  bus.emit('sync', { siteId: plan.siteId, ...summary });
  return { planId, siteId: plan.siteId, summary, results };
}

async function manualMap(secretId, customerId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await linkSecret(conn, secretId, customerId, 'manual');
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

module.exports = { preview, commit, manualMap, unmap, searchCustomers };
