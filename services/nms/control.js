// Kontrol pelanggan: Isolir / Un-isolir / Kick / Ping / Lock MAC + Bulk.
// Setiap aksi: (1) eksekusi di RouterOS, (2) update DB, (3) event ke live log, (4) audit_logs.
const db = require('../../config/db');
const ros = require('./rosApi');
const store = require('./secretStore');
const cache = require('./cache');
const bus = require('./eventBus');
const { audit } = require('../auditService');

const ISOLIR_PROFILE = store.ISOLIR_PROFILE;
const DEFAULT_PROFILE = String(process.env.NMS_DEFAULT_PROFILE || 'default').trim();
const ISOLIR_LIST = String(process.env.MIKROTIK_ISOLIR_LIST || 'ISOLIR').trim() || 'ISOLIR';
// profile (default): ganti profile ke ISOLIR & tetap enable → pelanggan redial & dapat IP isolir.
// disable: nonaktifkan secret (pelanggan tidak bisa dial sama sekali).
const ISOLIR_MODE = String(process.env.NMS_ISOLIR_MODE || 'profile').toLowerCase();
const ORIG_TAG = /\s*\[inkam:orig=([^\]]+)\]/;

async function recordEvent(secret, type, message, extra = {}) {
  const row = { routerId: secret.router_id, siteId: secret.site_id, username: secret.username, customerId: secret.customer_id || null, type, message, at: new Date().toISOString(), source: 'action', ...extra };
  await db.execute(`INSERT INTO nms_ppp_events (router_id, site_id, username, customer_id, event_type, message, source, address, caller_id) VALUES (?,?,?,?,?,?, 'action', ?, ?)`,
    [row.routerId, row.siteId, row.username, row.customerId, type, String(message || '').slice(0, 255), extra.address || null, extra.callerId || null]).catch(() => {});
  bus.emit('ppp', row);
}

async function audited(ctx, action, secret, details) {
  await audit({ userId: ctx.userId || null, action: `nms_${action}`, entityType: 'ppp_secret', entityId: secret.id, siteId: secret.site_id, ip: ctx.ip || null,
    description: `${action.toUpperCase()} ${secret.username}${secret.customer_id ? ` (customer #${secret.customer_id})` : ''}`,
    details: { username: secret.username, routerId: secret.router_id, customerId: secret.customer_id || null, source: ctx.source || 'manual', bulkId: ctx.bulkId || null, ...details } });
}

async function freshRosSecret(router, secret) {
  const live = await ros.secretByName(router, secret.username);
  if (!live) throw Object.assign(new Error(`Secret ${secret.username} tidak ada lagi di router ${router.name}.`), { status: 404 });
  return live;
}

async function routerHasProfile(router, name) {
  const profiles = await cache.wrap(`nms:profiles:${router.id}`, 300000, () => ros.profiles(router));
  return profiles.some(p => String(p.name).toLowerCase() === name.toLowerCase());
}

async function isolate(secretId, ctx = {}) {
  const secret = await store.secretById(secretId);
  const router = await store.routerById(secret.router_id);
  const live = await freshRosSecret(router, secret);
  const currentProfile = live.profile || DEFAULT_PROFILE;
  let mode = ISOLIR_MODE;
  if (mode === 'profile' && !(await routerHasProfile(router, ISOLIR_PROFILE))) mode = 'disable'; // fallback aman
  const already = store.isIsolirProfile(currentProfile) || String(live.disabled) === 'true';
  const originalProfile = store.isIsolirProfile(currentProfile) ? (secret.original_profile || (String(live.comment || '').match(ORIG_TAG) || [])[1] || DEFAULT_PROFILE) : currentProfile;
  if (!already) {
    const comment = `${String(live.comment || '').replace(ORIG_TAG, '')} [inkam:orig=${originalProfile}]`.trim().slice(0, 250);
    const patch = mode === 'profile' ? { profile: ISOLIR_PROFILE, disabled: 'false', comment } : { disabled: 'true', comment };
    await ros.patchSecret(router, live['.id'], patch);
  }
  const dropped = await ros.dropActive(router, secret.username);
  await db.execute(`UPDATE ppp_secrets SET is_isolated=1, original_profile=?, profile=?, disabled=?, is_online=0 WHERE id=?`,
    [originalProfile, mode === 'profile' ? ISOLIR_PROFILE : currentProfile, mode === 'disable' ? 1 : 0, secret.id]);
  if (secret.customer_id) await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'isolated',NOW(),status_changed_at), network_status='isolated', isolation_reason=? WHERE id=?`, [ctx.reason || 'manual', secret.customer_id]);
  cache.del('nms:dash');
  await recordEvent(secret, 'isolate', `Isolir (${mode}) · profile asal ${originalProfile}${dropped ? ' · sesi diputus' : ''}`);
  await audited(ctx, 'isolate', secret, { mode, originalProfile, droppedSessions: dropped, alreadyIsolated: already });
  return { secretId: secret.id, username: secret.username, mode, originalProfile, droppedSessions: dropped, alreadyIsolated: already };
}

async function unisolate(secretId, ctx = {}) {
  const secret = await store.secretById(secretId);
  const router = await store.routerById(secret.router_id);
  const live = await freshRosSecret(router, secret);
  const restore = secret.original_profile || (String(live.comment || '').match(ORIG_TAG) || [])[1] || (store.isIsolirProfile(live.profile) ? DEFAULT_PROFILE : live.profile) || DEFAULT_PROFILE;
  await ros.patchSecret(router, live['.id'], { profile: restore, disabled: 'false', comment: String(live.comment || '').replace(ORIG_TAG, '').trim() });
  // Bersihkan isolir berbasis firewall address-list (best effort).
  let addressListRemoved = 0;
  for (const ip of new Set([secret.active_address, /^\d+\.\d+\.\d+\.\d+$/.test(live['remote-address'] || '') ? live['remote-address'] : null].filter(Boolean))) {
    try { addressListRemoved += await ros.removeAddressList(router, ip, ISOLIR_LIST); } catch (_) {}
  }
  const dropped = await ros.dropActive(router, secret.username); // paksa redial → IP normal
  await db.execute(`UPDATE ppp_secrets SET is_isolated=0, disabled=0, profile=?, original_profile=NULL, is_online=0 WHERE id=?`, [restore, secret.id]);
  if (secret.customer_id) await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'offline',NOW(),status_changed_at), network_status='offline', isolation_reason=NULL WHERE id=?`, [secret.customer_id]);
  cache.del('nms:dash');
  await recordEvent(secret, 'unisolate', `Buka isolir · profile ${restore}${dropped ? ' · redial dipaksa' : ''}`);
  await audited(ctx, 'unisolate', secret, { restoredProfile: restore, droppedSessions: dropped, addressListRemoved });
  return { secretId: secret.id, username: secret.username, restoredProfile: restore, droppedSessions: dropped, addressListRemoved };
}

async function kick(secretId, ctx = {}) {
  const secret = await store.secretById(secretId);
  const router = await store.routerById(secret.router_id);
  const dropped = await ros.dropActive(router, secret.username);
  await db.execute(`UPDATE ppp_secrets SET is_online=0 WHERE id=?`, [secret.id]);
  await recordEvent(secret, 'kick', dropped ? 'Sesi di-reset (kick)' : 'Kick: tidak ada sesi aktif');
  await audited(ctx, 'kick', secret, { droppedSessions: dropped });
  return { secretId: secret.id, username: secret.username, droppedSessions: dropped };
}

const pingThrottle = new Map();
async function ping(secretId, ctx = {}) {
  const secret = await store.secretById(secretId);
  const last = pingThrottle.get(secret.id) || 0;
  if (Date.now() - last < 4000) throw Object.assign(new Error('Tunggu beberapa detik sebelum ping ulang.'), { status: 429 });
  pingThrottle.set(secret.id, Date.now());
  const router = await store.routerById(secret.router_id);
  const [session] = await ros.active(router, secret.username);
  const address = session?.address || null;
  if (!address) throw Object.assign(new Error('Pelanggan sedang offline — tidak ada IP aktif untuk di-ping.'), { status: 409 });
  // Ping dijalankan DARI router (vantage point yang benar untuk IP PPPoE privat).
  const result = await ros.ping(router, address, 5);
  await audited(ctx, 'ping', secret, { address, ...result });
  return { secretId: secret.id, username: secret.username, address, ...result, testedAt: new Date().toISOString() };
}

async function lockMac(secretId, ctx = {}, { unlock = false } = {}) {
  const secret = await store.secretById(secretId);
  const router = await store.routerById(secret.router_id);
  const live = await freshRosSecret(router, secret);
  let mac = '';
  if (!unlock) {
    const [session] = await ros.active(router, secret.username);
    mac = session?.['caller-id'] || '';
    if (!/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i.test(mac)) throw Object.assign(new Error('MAC aktif tidak ditemukan — pelanggan harus online saat Lock MAC.'), { status: 409 });
  }
  await ros.patchSecret(router, live['.id'], { 'caller-id': mac });
  await db.execute(`UPDATE ppp_secrets SET caller_id=? WHERE id=?`, [mac || null, secret.id]);
  await recordEvent(secret, 'lock_mac', unlock ? 'MAC lock dilepas' : `MAC dikunci ke ${mac}`, { callerId: mac || null });
  await audited(ctx, unlock ? 'unlock_mac' : 'lock_mac', secret, { previous: live['caller-id'] || null, callerId: mac || null });
  return { secretId: secret.id, username: secret.username, callerId: mac || null };
}

async function changeProfile(secretId, profile, ctx = {}) {
  const secret = await store.secretById(secretId);
  const router = await store.routerById(secret.router_id);
  if (!(await routerHasProfile(router, profile))) throw new Error(`Profile ${profile} tidak ada di router ${router.name}.`);
  const live = await freshRosSecret(router, secret);
  if (secret.is_isolated) {
    // Pelanggan terisolir: ganti "paket asal" saja, isolir tetap berlaku.
    await db.execute(`UPDATE ppp_secrets SET original_profile=? WHERE id=?`, [profile, secret.id]);
    await ros.patchSecret(router, live['.id'], { comment: `${String(live.comment || '').replace(ORIG_TAG, '')} [inkam:orig=${profile}]`.trim().slice(0, 250) });
  } else {
    await ros.patchSecret(router, live['.id'], { profile });
    await db.execute(`UPDATE ppp_secrets SET profile=? WHERE id=?`, [profile, secret.id]);
    await ros.dropActive(router, secret.username); // rate-limit baru berlaku setelah redial
  }
  await audited(ctx, 'profile_change', secret, { from: live.profile, to: profile, deferredUntilUnisolate: !!secret.is_isolated });
  return { secretId: secret.id, username: secret.username, from: live.profile, to: profile };
}

const BULK_ACTIONS = { isolate: (id, ctx) => isolate(id, ctx), unisolate: (id, ctx) => unisolate(id, ctx), profile: (id, ctx, o) => changeProfile(id, o.profile, ctx), kick: (id, ctx) => kick(id, ctx) };

/** Resolve target bulk: daftar id eksplisit, atau filter {siteId, overdueOnly}. */
async function resolveBulkTargets({ secretIds, filter }) {
  if (Array.isArray(secretIds) && secretIds.length) return [...new Set(secretIds.map(Number).filter(Boolean))];
  if (!filter?.siteId) throw new Error('Pilih secret atau site untuk aksi masal.');
  const params = [Number(filter.siteId)];
  let sql = `SELECT p.id FROM ppp_secrets p WHERE p.site_id=? AND p.removed_on_router_at IS NULL AND p.customer_id IS NOT NULL`;
  if (filter.overdueOnly) sql += ` AND EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id=p.customer_id AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND i.due_date < CURDATE())`;
  if (filter.state === 'isolated') sql += ' AND p.is_isolated=1';
  if (filter.state === 'active') sql += ' AND p.is_isolated=0';
  const [rows] = await db.query(sql, params);
  return rows.map(r => r.id);
}

async function bulk({ action, secretIds, filter, profile, dryRun = false }, ctx = {}) {
  const fn = BULK_ACTIONS[action];
  if (!fn) throw new Error('Aksi masal tidak dikenal.');
  if (action === 'profile' && !profile) throw new Error('Profile tujuan wajib dipilih.');
  const ids = await resolveBulkTargets({ secretIds, filter });
  if (ids.length > 500) throw new Error('Maksimal 500 secret per aksi masal.');
  if (dryRun) return { dryRun: true, action, count: ids.length, secretIds: ids };
  const bulkId = `bulk-${Date.now().toString(36)}`;
  const results = [];
  const queue = [...ids];
  // Paralel terbatas (3) — rosApi juga membatasi 2 in-flight per router.
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try { results.push({ ok: true, ...(await fn(id, { ...ctx, bulkId, source: 'bulk' }, { profile })) }); }
      catch (err) { results.push({ ok: false, secretId: id, error: err.message }); }
    }
  }));
  const summary = { action, bulkId, total: ids.length, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  await audit({ userId: ctx.userId, action: `nms_bulk_${action}`, entityType: 'ppp_secret_bulk', entityId: null, ip: ctx.ip, siteId: filter?.siteId || null, description: `Bulk ${action}: ${summary.succeeded}/${summary.total} berhasil`, details: { ...summary, filter: filter || null, profile: profile || null } });
  return { summary, results };
}

async function secretForCustomer(customerId) {
  const [[row]] = await db.query(`SELECT id FROM ppp_secrets WHERE customer_id=? AND removed_on_router_at IS NULL LIMIT 1`, [customerId]);
  return row?.id || null;
}

module.exports = { isolate, unisolate, kick, ping, lockMac, changeProfile, bulk, resolveBulkTargets, secretForCustomer, ISOLIR_MODE };
