// MikroTik NMS v2 + NOC Dashboard.
// Mount: app.use('/nms', requireAuth, requirePermission('network'), require('./routes/nms'))
// Baca data: permission 'network'. Aksi yang mengubah layanan pelanggan: Admin ATAU permission
// 'network_control' (dapat diberikan ke role operator NOC di Pengaturan → Role & Akses).
const express = require('express');
const crypto = require('crypto');
const { isAdminRole } = require('../middleware/auth');
const { audit } = require('../services/auditService');
const db = require('../config/db');
const store = require('../services/nms/secretStore');
const smartSync = require('../services/nms/smartSync');
const control = require('../services/nms/control');
const dashboard = require('../services/nms/dashboard');
const poller = require('../services/nms/poller');
const ros = require('../services/nms/rosApi');
const cache = require('../services/nms/cache');
const bus = require('../services/nms/eventBus');
const insights = require('../services/nms/insights');
const automation = require('../services/nms/automation');
const nmsSettings = require('../services/nms/settings');
const widgets = require('../services/nms/widgets');
const fasum = require('../services/nms/fasum');
const excelSync = require('../services/nms/excelSync');
const nmsExcelUpload = require('../middleware/nmsExcelUpload');

const router = express.Router();

// Multer error khusus endpoint XLSX harus tetap berbentuk JSON karena dipanggil dari modal NMS.
function uploadExcel(req, res, next) {
  nmsExcelUpload(req, res, err => {
    if (!err) return next();
    return res.status(400).json({ ok: false, error: err.message || 'Gagal membaca file Excel.' });
  });
}

const canControl = req => isAdminRole(req.session.user?.role) || (req.permissions || []).includes('network_control');
function requireNetworkControl(req, res, next) {
  if (canControl(req)) return next();
  return res.status(403).json({ ok: false, error: 'Aksi ini membutuhkan role Admin atau permission "Kontrol Jaringan".' });
}
function requireAdmin(req, res, next) {
  if (isAdminRole(req.session.user?.role)) return next();
  return res.status(403).json({ ok: false, error: 'Hanya Admin yang dapat melakukan aksi ini.' });
}
const ctxOf = req => ({ userId: req.session.user?.id || null, ip: req.ip, source: 'manual' });
const siteParam = req => { const n = Number(req.query.site || req.body?.site_id || 0); return Number.isFinite(n) && n > 0 ? n : null; };
const api = fn => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ ok: true, ...(await fn(req, res)) }); }
  catch (err) {
    const status = err.status || (err.code === 'ROUTER_UNREACHABLE' ? 503 : 400);
    res.status(status).json({ ok: false, error: err.message, code: err.code || null });
  }
};

// ---------- Pages ----------
router.get('/', async (req, res, next) => {
  try {
    const siteId = siteParam(req);
    const [sites, data] = await Promise.all([dashboard.sites(), dashboard.getDashboard(siteId)]);
    res.set('Cache-Control', 'no-store');
    res.render('nms/dashboard', { title: 'NOC Dashboard', sites, siteId, data, canControl: canControl(req), isAdmin: isAdminRole(req.session.user?.role), nmsPage: 'dashboard' });
  } catch (err) { next(err); }
});

// NOC Wall: tampilan padat layar penuh untuk monitor NOC (tanpa sidebar/layout aplikasi).
router.get('/wall', async (req, res, next) => {
  try {
    const siteId = siteParam(req);
    const safe = p => p.catch(err => ({ error: err.message }));
    const [sites, data, health] = await Promise.all([dashboard.sites(), dashboard.getDashboard(siteId), safe(insights.siteHealth())]);
    res.set('Cache-Control', 'no-store');
    res.render('nms/wall', { layout: false, title: 'NOC Wall', sites, siteId, boot: { data, health } });
  } catch (err) { next(err); }
});

router.get('/secrets', async (req, res, next) => {
  try {
    const siteId = siteParam(req);
    const [sites, counts] = await Promise.all([dashboard.sites(), store.counts(siteId)]);
    const [[offline]] = await db.query(`SELECT COUNT(*) n FROM routers r WHERE r.is_active=1 AND r.last_status='offline' ${siteId ? 'AND r.site_id=?' : ''}`, siteId ? [siteId] : []);
    res.set('Cache-Control', 'no-store');
    const packages = await packagesFor(siteId);
    res.render('nms/secrets', { title: 'MikroTik NMS · PPP Secrets', sites, siteId, counts, routersOffline: Number(offline.n || 0), tab: req.query.tab === 'unsynced' ? 'unsynced' : 'synced', canControl: canControl(req), isAdmin: isAdminRole(req.session.user?.role), nmsPage: 'secrets', isolirProfile: store.ISOLIR_PROFILE, isolirMode: control.ISOLIR_MODE, packages, focus: Number(req.query.focus) || null });
  } catch (err) { next(err); }
});

async function packagesFor(siteId) {
  const [rows] = await db.query(`SELECT p.id, p.name, p.site_id, p.price, p.mikrotik_profile, s.code site_code FROM packages p LEFT JOIN sites s ON s.id=p.site_id WHERE p.is_active=1 AND p.archived_at IS NULL ${siteId ? 'AND (p.site_id=? OR p.site_id IS NULL)' : ''} ORDER BY s.code, p.price`, siteId ? [siteId] : []).catch(() => [[]]);
  return rows;
}

router.get('/insights', async (req, res, next) => {
  try {
    const siteId = siteParam(req);
    const sites = await dashboard.sites();
    res.set('Cache-Control', 'no-store');
    res.render('nms/insights', { title: 'MikroTik NMS · Rekonsiliasi', sites, siteId, canControl: canControl(req), isAdmin: isAdminRole(req.session.user?.role), nmsPage: 'insights', packages: await packagesFor(siteId) });
  } catch (err) { next(err); }
});

router.get('/automation', async (req, res, next) => {
  try {
    const siteId = siteParam(req);
    const [sites, routers] = await Promise.all([dashboard.sites(), store.activeRouters(siteId)]);
    res.set('Cache-Control', 'no-store');
    res.render('nms/automation', { title: 'MikroTik NMS · Otomasi', sites, siteId, canControl: canControl(req), isAdmin: isAdminRole(req.session.user?.role), nmsPage: 'automation', routers: routers.map(r => ({ id: r.id, name: r.name, site_code: r.site_code })), settings: await nmsSettings.all(), packages: await packagesFor(siteId) });
  } catch (err) { next(err); }
});

// ---------- Dashboard & telemetry ----------
// ---------- Tata letak dashboard: per user (tersimpan di server) + default yang diatur Admin ----------
// user_id 0 = layout default (dipakai user yang belum menyimpan layout sendiri dan layar TV/NOC).
let layoutTableReady = null;
function ensureLayoutTable() {
  if (!layoutTableReady) {
    layoutTableReady = db.query(`CREATE TABLE IF NOT EXISTS nms_dashboard_layouts (
      user_id INT UNSIGNED NOT NULL PRIMARY KEY,
      layout MEDIUMTEXT NOT NULL,
      updated_by INT UNSIGNED NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(err => { layoutTableReady = null; throw err; });
  }
  return layoutTableReady;
}
const LAYOUT_KEY = /^[a-z0-9_-]{1,32}$/;
const LAYOUT_WIDTHS = [3, 4, 6, 8, 12];
function cleanLayout(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const keys = arr => (Array.isArray(arr) ? arr : []).map(String).filter(k => LAYOUT_KEY.test(k)).slice(0, 40);
  const sizes = {};
  Object.entries(src.sizes && typeof src.sizes === 'object' ? src.sizes : {}).slice(0, 40).forEach(([k, v]) => {
    if (!LAYOUT_KEY.test(k) || !v || typeof v !== 'object') return;
    const w = LAYOUT_WIDTHS.includes(Number(v.w)) ? Number(v.w) : null;
    const h = Number(v.h) >= 120 && Number(v.h) <= 2000 ? Math.round(Number(v.h)) : 0;
    if (w || h) sizes[k] = { ...(w ? { w } : {}), ...(h ? { h } : {}) };
  });
  const rotate = [0, 15, 20, 30, 60].includes(Number(src.rotate)) ? Number(src.rotate) : 20;
  return { v: 2, order: keys(src.order), hidden: keys(src.hidden), sizes, mascot: src.mascot !== false, rotate };
}
const parseLayout = row => { try { return row ? cleanLayout(JSON.parse(row.layout)) : null; } catch (_) { return null; } };
async function saveLayoutRow(userId, layout, by) {
  await ensureLayoutTable();
  const json = JSON.stringify(cleanLayout(layout));
  if (json.length > 20000) { const err = new Error('Tata letak terlalu besar.'); err.status = 400; throw err; }
  await db.execute(`INSERT INTO nms_dashboard_layouts (user_id, layout, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE layout = VALUES(layout), updated_by = VALUES(updated_by)`, [userId, json, by]);
  return JSON.parse(json);
}
router.get('/api/layout', api(async req => {
  await ensureLayoutTable();
  const uid = Number(req.session.user?.id) || 0;
  const [rows] = await db.execute(`SELECT user_id, layout FROM nms_dashboard_layouts WHERE user_id IN (0, ?)`, [uid]);
  return { layout: uid ? parseLayout(rows.find(r => Number(r.user_id) === uid)) : null, defaultLayout: parseLayout(rows.find(r => Number(r.user_id) === 0)) };
}));
router.put('/api/layout', api(async req => {
  const uid = Number(req.session.user?.id) || 0;
  if (!uid) { const err = new Error('Sesi tidak valid.'); err.status = 401; throw err; }
  return { layout: await saveLayoutRow(uid, req.body?.layout, uid) };
}));
router.delete('/api/layout', api(async req => {
  await ensureLayoutTable();
  const uid = Number(req.session.user?.id) || 0;
  if (uid) await db.execute(`DELETE FROM nms_dashboard_layouts WHERE user_id = ?`, [uid]);
  return {};
}));
router.put('/api/layout/default', requireAdmin, api(async req => {
  const layout = await saveLayoutRow(0, req.body?.layout, Number(req.session.user?.id) || null);
  await audit({ userId: req.session.user.id, action: 'update', entityType: 'nms_dashboard_layout', entityId: null, description: 'Tata letak default dashboard NMS diperbarui', ip: req.ip }).catch(() => {});
  return { layout };
}));

router.get('/api/dashboard', api(async req => ({ data: await dashboard.getDashboard(siteParam(req)) })));
router.get('/api/widgets', api(async req => ({ data: await widgets.all(siteParam(req)) })));
router.get('/api/events', api(async req => ({ rows: await dashboard.recentEvents(siteParam(req), Number(req.query.limit) || 60) })));

// Server-Sent Events: push telemetry/PPP log/alert tanpa polling dari browser.
router.get('/api/stream', (req, res) => {
  const siteId = siteParam(req);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  const send = (event, payload) => {
    if (siteId && payload && payload.siteId != null && Number(payload.siteId) !== siteId) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const handlers = ['telemetry', 'ppp', 'alert', 'alert_resolved', 'router_state', 'sync', 'approval'].map(evt => [evt, payload => send(evt, payload)]);
  handlers.forEach(([e, h]) => bus.on(e, h));
  const beat = setInterval(() => res.write(`: hb ${Date.now()}\n\n`), 25000);
  req.on('close', () => { clearInterval(beat); handlers.forEach(([e, h]) => bus.off(e, h)); });
});

router.post('/api/alerts/:id/ack', requireNetworkControl, api(async req => {
  await db.execute(`UPDATE nms_alerts SET acknowledged_by=? WHERE id=?`, [req.session.user.id, req.params.id]);
  await audit({ userId: req.session.user.id, action: 'nms_alert_ack', entityType: 'nms_alert', entityId: Number(req.params.id), ip: req.ip, description: 'Acknowledge alert NOC' });
  cache.del('nms:dash');
  return {};
}));

router.post('/api/routers/:id/wan-interface', requireNetworkControl, api(async req => {
  const name = String(req.body.interface || '').trim().slice(0, 64) || null;
  const r = await store.routerById(req.params.id);
  await db.execute(`UPDATE routers SET wan_interface=? WHERE id=?`, [name, r.id]);
  poller.resetWan(r.id); await poller.loadRouters();
  await audit({ userId: req.session.user.id, action: 'nms_set_wan', entityType: 'router', entityId: r.id, siteId: r.site_id, ip: req.ip, description: `WAN interface ${r.name} → ${name || 'auto'}`, details: { interface: name } });
  return { interface: name };
}));
router.get('/api/routers/:id/interfaces', api(async req => ({ rows: (await ros.interfaces(await store.routerById(req.params.id))).map(i => ({ name: i.name, type: i.type, comment: i.comment || null, running: String(i.running) === 'true' })) })));
router.get('/api/profiles', api(async req => {
  const routers = await store.activeRouters(siteParam(req));
  const names = new Set();
  const failed = [];
  for (const r of routers) {
    try { (await cache.wrap(`nms:profiles:${r.id}`, 300000, () => ros.profiles(r))).forEach(p => names.add(p.name)); }
    catch (err) { failed.push(r.name); }
  }
  return { profiles: [...names].sort(), unreachable: failed };
}));

// ---------- PPP Secrets ----------
router.get('/api/secrets', api(async req => store.listSecrets({ tab: req.query.tab, siteId: siteParam(req), q: String(req.query.q || '').trim().slice(0, 80), status: req.query.status, includeExempt: req.query.exempt === '1', page: req.query.page, limit: req.query.limit })));
router.get('/api/counts', api(async req => ({ counts: await store.counts(siteParam(req)) })));
router.post('/api/secrets/refresh', requireNetworkControl, api(async req => {
  const results = await poller.refreshSecrets(siteParam(req));
  await audit({ userId: req.session.user.id, action: 'nms_secret_refresh', entityType: 'router', ip: req.ip, siteId: siteParam(req), description: `Tarik PPP secret dari ${results.length} router`, details: { results } });
  return { results };
}));

// Smart Sync (dry-run preview → confirm & commit)
router.get('/api/sync/preview', requireNetworkControl, api(async req => ({ plan: await smartSync.preview({ siteId: siteParam(req), refresh: req.query.refresh === '1' }) })));
router.post('/api/sync/commit', requireNetworkControl, api(async req => {
  const out = await smartSync.commit({ planId: String(req.body.planId || ''), secretIds: req.body.secretIds, pairs: Array.isArray(req.body.pairs) ? req.body.pairs.slice(0, 5000) : null, manual: Array.isArray(req.body.manual) ? req.body.manual.slice(0, 2000) : null, siteId: siteParam(req), userId: req.session.user.id });
  await audit({ userId: req.session.user.id, action: 'nms_smart_sync', entityType: 'ppp_secret', ip: req.ip, siteId: out.siteId, description: `Smart Sync: ${out.summary.linked}/${out.summary.planned} di-link`, details: { planId: out.planId, summary: out.summary, linked: out.results.filter(r => r.ok).map(r => ({ secretId: r.secretId, username: r.username, customerId: r.customerId })), failed: out.results.filter(r => !r.ok) } });
  return out;
}));
router.get('/api/customers/unlinked', api(async req => ({ rows: await smartSync.unlinkedCustomers({ siteId: siteParam(req), secretId: Number(req.query.secret || 0) || null }) })));
router.get('/api/customers/search', api(async req => ({ rows: await smartSync.searchCustomers({ q: String(req.query.q || '').trim().slice(0, 80), siteId: siteParam(req) }) })));
router.post('/api/secrets/:id/map', requireNetworkControl, api(async req => {
  // Catatan opsional: mapping manual tidak boleh gagal hanya karena catatan kosong.
  const customerId = Number(req.body.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) throw Object.assign(new Error('Pilih pelanggan terlebih dahulu.'), { status: 400 });
  const reason = String(req.body.reason || '').trim().slice(0, 255) || 'Mapping manual dari NMS';
  const { secret, customer, released, replacedCustomer } = await smartSync.manualMap(Number(req.params.id), customerId);
  await audit({ userId: req.session.user.id, action: 'nms_manual_map', entityType: 'ppp_secret', entityId: secret.id, siteId: secret.site_id, ip: req.ip, description: `Map ${secret.username} → ${customer.customer_code} ${customer.name}${released?.length ? ` (dipindah dari ${released.join(', ')})` : ''}${replacedCustomer ? ` (menimpa ${replacedCustomer.code} ${replacedCustomer.name})` : ''}`, details: { username: secret.username, customerId: customer.id, reason, released, replacedCustomer } });
  return { secretId: secret.id, customerId: customer.id, customerName: customer.name, released: released || [], replacedCustomer: replacedCustomer || null };
}));
router.post('/api/secrets/:id/unmap', requireNetworkControl, api(async req => {
  const { secret, customerId, fallbackSecret, alreadyUnlinked } = await smartSync.unmap(Number(req.params.id));
  await audit({ userId: req.session.user.id, action: 'nms_unmap', entityType: 'ppp_secret', entityId: secret.id, siteId: secret.site_id, ip: req.ip, description: `Unmap ${secret.username}`, details: { customerId, fallbackSecret, alreadyUnlinked: !!alreadyUnlinked } });
  return { secretId: secret.id, customerId, fallbackSecret: fallbackSecret || null, alreadyUnlinked: !!alreadyUnlinked };
}));

// Inline actions
router.post('/api/secrets/:id/isolate', requireNetworkControl, api(async req => ({ result: await control.isolate(Number(req.params.id), { ...ctxOf(req), reason: 'manual' }) })));
router.post('/api/secrets/:id/unisolate', requireNetworkControl, api(async req => ({ result: await control.unisolate(Number(req.params.id), ctxOf(req)) })));
router.post('/api/secrets/:id/kick', requireNetworkControl, api(async req => ({ result: await control.kick(Number(req.params.id), ctxOf(req)) })));
router.post('/api/secrets/:id/ping', api(async req => ({ result: await control.ping(Number(req.params.id), ctxOf(req)) })));
router.post('/api/secrets/:id/lock-mac', requireNetworkControl, api(async req => ({ result: await control.lockMac(Number(req.params.id), ctxOf(req), { unlock: req.body.unlock === true || req.body.unlock === '1' }) })));

// Bulk: {action:'isolate'|'unisolate'|'profile'|'kick', secretIds?:[], filter?:{siteId, overdueOnly, state}, profile?, dryRun?}
router.post('/api/bulk', requireNetworkControl, api(async req => {
  const b = req.body || {};
  const filter = b.filter ? { siteId: Number(b.filter.siteId) || null, overdueOnly: !!b.filter.overdueOnly, state: b.filter.state || null } : null;
  const payload = { action: String(b.action || ''), secretIds: Array.isArray(b.secretIds) ? b.secretIds.map(Number).filter(Boolean) : null, filter, profile: b.profile ? String(b.profile).slice(0, 64) : null };
  if (!b.dryRun && payload.action !== 'kick') {
    const ids = await control.resolveBulkTargets(payload);
    const threshold = await automation.needsApproval(ids.length);
    if (threshold) {
      const label = { isolate: 'Isolir', unisolate: 'Buka isolir', profile: `Ganti profile → ${payload.profile}` }[payload.action] || payload.action;
      const { id } = await automation.requestApproval({ action: payload.action, payload: { ...payload, secretIds: ids, filter: null }, count: ids.length, summary: `${label} ${ids.length} secret`, siteId: filter?.siteId || siteParam(req) }, ctxOf(req));
      return { pendingApproval: true, approvalId: id, count: ids.length, threshold };
    }
  }
  return await control.bulk({ ...payload, dryRun: !!b.dryRun }, ctxOf(req));
}));

// ---------- Detail, diagnosa, timeline, traffic ----------
const sid = req => Number(req.params.id);
router.get('/api/secrets/:id/detail', api(async req => insights.detail(sid(req))));
router.post('/api/secrets/:id/diagnose', api(async req => ({ result: await insights.diagnose(sid(req)) })));
router.get('/api/secrets/:id/timeline', api(async req => insights.timeline(sid(req))));
router.get('/api/secrets/:id/traffic', api(async req => ({ sample: await automation.liveTraffic(sid(req)) })));
router.post('/api/audit/:id/revert', requireNetworkControl, api(async req => {
  const out = await insights.revert(Number(req.params.id), ctxOf(req));
  await audit({ userId: req.session.user.id, action: 'nms_revert', entityType: 'audit_log', entityId: Number(req.params.id), ip: req.ip, description: `Kembalikan aksi #${req.params.id} → ${out.action}` });
  return out;
}));
router.post('/api/secrets/:id/hold', requireNetworkControl, api(async req => ({ hold: await automation.setHold({ secretId: sid(req), until: req.body.until || null, note: req.body.note }, ctxOf(req)) })));
router.post('/api/secrets/:id/ticket', requireNetworkControl, api(async req => ({ ticket: await insights.createFlapTicket({ secretId: sid(req), userId: req.session.user.id }) })));
router.post('/api/secrets/:id/package', requireNetworkControl, api(async req => ({ result: await automation.changePackage(sid(req), Number(req.body.packageId), ctxOf(req)) })));
router.post('/api/secrets/:id/create-customer', requireNetworkControl, api(async req => ({ result: await automation.createCustomerFromSecret({ secretId: sid(req), name: req.body.name, phone: req.body.phone, packageId: Number(req.body.packageId), dueDay: req.body.dueDay, address: req.body.address }, ctxOf(req)) })));
router.post('/api/customers/:id/create-secret', requireNetworkControl, api(async req => ({ result: await automation.createSecretForCustomer({ customerId: Number(req.params.id), routerId: Number(req.body.routerId) || null, username: req.body.username, password: req.body.password, profile: req.body.profile, notifyPhone: req.body.notifyPhone || null }, ctxOf(req)) })));

// ---------- Palette (Cmd/Ctrl+K di halaman NMS) ----------
router.get('/api/palette', api(async req => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return { rows: [] };
  const like = `%${q}%`, site = siteParam(req);
  const [rows] = await db.query(`SELECT p.id, p.username, p.is_online, p.is_isolated, p.active_address, s.code site_code, c.name customer_name, c.customer_code
    FROM ppp_secrets p JOIN sites s ON s.id=p.site_id LEFT JOIN customers c ON c.id=p.customer_id
    WHERE p.removed_on_router_at IS NULL ${site ? 'AND p.site_id=?' : ''} AND (p.username LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ? OR p.active_address LIKE ? OR c.phone LIKE ?)
    ORDER BY (c.name LIKE ?) DESC, p.is_online DESC LIMIT 12`, [...(site ? [site] : []), like, like, like, like, like, `${q}%`]);
  return { rows: rows.map(r => ({ ...r, state: r.is_isolated ? 'isolated' : r.is_online ? 'online' : 'offline' })) };
}));

// ---------- Rekonsiliasi, kesehatan, akun bersama, ekspor ----------
router.get('/api/reconcile', api(async req => ({ groups: await insights.reconcile(siteParam(req), req.query.kind ? String(req.query.kind) : null) })));
router.get('/api/health', api(async () => insights.siteHealth()));
router.get('/api/shared', api(async req => insights.sharedAccounts(siteParam(req))));
router.get('/api/flapping', api(async req => ({ rows: await dashboard.flapping(siteParam(req)) })));
router.post('/api/clusters/:id/notify', requireNetworkControl, api(async req => {
  const out = await insights.notifyArea({ clusterId: Number(req.params.id), message: req.body.message, userId: req.session.user.id });
  await audit({ userId: req.session.user.id, action: 'nms_outage_notice', entityType: 'cluster', entityId: Number(req.params.id), ip: req.ip, description: `Info gangguan ke ${out.queued} pelanggan (menunggu persetujuan WA)` });
  return out;
}));
router.get('/api/export', async (req, res) => {
  try {
    const { name, csv } = await insights.exportCsv({ kind: String(req.query.kind || 'synced'), siteId: siteParam(req) });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-${automation.jakartaDate()}.csv"`, 'Cache-Control': 'no-store' });
    res.send(csv);
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ---------- Excel mapping PPP: export -> edit -> preview -> apply ----------
router.get('/api/excel/template', requireNetworkControl, async (req, res, next) => {
  try {
    const wb = await excelSync.templateWorkbook({ siteId: siteParam(req) });
    const scope = siteParam(req) ? `site-${siteParam(req)}` : 'all-site';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="template-mapping-ppp-${scope}.xlsx"`,
      'Cache-Control': 'no-store'
    });
    await wb.xlsx.write(res); res.end();
  } catch (err) { next(err); }
});

router.get('/api/excel/export', async (req, res, next) => {
  try {
    const kind = ['synced', 'unsynced', 'all'].includes(String(req.query.kind || 'all')) ? String(req.query.kind || 'all') : 'all';
    const wb = await excelSync.exportWorkbook({ siteId: siteParam(req), kind });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="nms-ppp-mapping-${kind}-${automation.jakartaDate()}.xlsx"`,
      'Cache-Control': 'no-store'
    });
    await wb.xlsx.write(res); res.end();
  } catch (err) { next(err); }
});

router.post('/api/excel/preview', requireNetworkControl, uploadExcel, api(async req => {
  if (!req.file?.buffer) throw Object.assign(new Error('Pilih file Excel .xlsx terlebih dahulu.'), { status: 400 });
  const preview = await excelSync.previewImport(req.file.buffer, { siteId: siteParam(req) });
  return { fileName: req.file.originalname, preview };
}));

router.post('/api/excel/apply', requireNetworkControl, uploadExcel, api(async req => {
  if (!req.file?.buffer) throw Object.assign(new Error('Pilih file Excel .xlsx terlebih dahulu.'), { status: 400 });
  const siteId = siteParam(req);
  const allowOverwrite = String(req.body?.allow_overwrite || '') === '1';
  const preview = await excelSync.previewImport(req.file.buffer, { siteId });
  if (preview.summary.error) {
    throw Object.assign(new Error(`Import dibatalkan: masih ada ${preview.summary.error} baris error. Perbaiki file lalu Preview ulang.`), { status: 400 });
  }
  if (preview.summary.warning && !allowOverwrite) {
    throw Object.assign(new Error(`Ada ${preview.summary.warning} konflik mapping. Centang izin pemindahan/overwrite setelah memeriksa Preview.`), { status: 409 });
  }

  const actionable = preview.rows.filter(r => r.status === 'ready' || (allowOverwrite && r.status === 'warning'));
  const unlinkRows = actionable.filter(r => r.action === 'UNLINK');
  const linkRows = actionable.filter(r => r.action === 'LINK');
  const unlinkResults = [];
  for (const r of unlinkRows) {
    try {
      const out = await smartSync.unmap(r.secretId);
      unlinkResults.push({ ok: true, row: r.row, secretId: r.secretId, username: r.username, customerId: out.customerId });
    } catch (err) {
      unlinkResults.push({ ok: false, row: r.row, secretId: r.secretId, username: r.username, error: err.message });
    }
  }

  let linkResult = { summary: { planned: 0, linked: 0, failed: 0, batchId: null }, results: [] };
  if (linkRows.length) {
    linkResult = await smartSync.commit({
      planId: `excel-${crypto.randomUUID()}`,
      pairs: [],
      manual: linkRows.map(r => ({ secretId: r.secretId, customerId: r.customerId, method: 'manual' })),
      siteId,
      userId: req.session.user.id,
      source: 'excel'
    });
  }

  const unlinkOk = unlinkResults.filter(r => r.ok).length;
  const unlinkFailed = unlinkResults.length - unlinkOk;
  const summary = {
    rows: preview.summary.total,
    unchanged: preview.summary.noop,
    linked: Number(linkResult.summary?.linked || 0),
    linkFailed: Number(linkResult.summary?.failed || 0),
    unlinked: unlinkOk,
    unlinkFailed,
    batchId: linkResult.summary?.batchId || null
  };
  await audit({
    userId: req.session.user.id,
    action: 'nms_excel_mapping_import',
    entityType: 'ppp_secret',
    entityId: null,
    siteId,
    ip: req.ip,
    description: `Import Excel mapping PPP: ${summary.linked} link, ${summary.unlinked} unlink, ${summary.linkFailed + summary.unlinkFailed} gagal`,
    details: { fileName: req.file.originalname, allowOverwrite, summary, unlinkFailed: unlinkResults.filter(r => !r.ok).slice(0, 20), linkFailed: (linkResult.results || []).filter(r => !r.ok).slice(0, 20) }
  }).catch(() => {});

  return { summary, unlinkResults, linkResults: linkResult.results || [] };
}));

router.get('/api/packages', api(async req => ({ rows: await packagesFor(siteParam(req)) })));
router.get('/api/routers', api(async req => ({ rows: (await store.activeRouters(siteParam(req))).map(r => ({ id: r.id, name: r.name, site_id: r.site_id, site_code: r.site_code })) })));

// ---------- Otomasi ----------
router.get('/api/schedules', api(async req => ({ rows: await automation.listScheduled({ status: req.query.status || null }) })));
router.post('/api/schedules', requireNetworkControl, api(async req => ({ schedule: await automation.schedule({ action: String(req.body.action || ''), secretIds: req.body.secretIds, runAt: req.body.runAt, profile: req.body.profile || null, packageId: Number(req.body.packageId) || null, note: req.body.note, siteId: siteParam(req) }, ctxOf(req)) })));
router.post('/api/schedules/:id/cancel', requireNetworkControl, api(async req => automation.cancelScheduled(Number(req.params.id), ctxOf(req))));
router.get('/api/approvals', api(async () => ({ rows: await automation.listApprovals() })));
router.post('/api/approvals/:id/approve', requireAdmin, api(async req => automation.decideApproval(Number(req.params.id), true, ctxOf(req))));
router.post('/api/approvals/:id/reject', requireAdmin, api(async req => automation.decideApproval(Number(req.params.id), false, ctxOf(req))));
// Tag [CID:…] di comment MikroTik
router.post('/api/cid-tags/write', requireNetworkControl, api(async req => ({ job: await smartSync.writeAllCidTags({ siteId: siteParam(req), userId: req.session.user.id }) })));
router.get('/api/cid-tags/status', api(async () => ({ job: smartSync.cidJobStatus() })));
// Fasum / exempt manual
router.post('/api/secrets/:id/exempt', requireNetworkControl, api(async req => fasum.setExempt([Number(req.params.id)], { type: req.body.type ?? 'fasum', note: req.body.note }, ctxOf(req))));
router.post('/api/exempt/bulk', requireNetworkControl, api(async req => fasum.setExempt(Array.isArray(req.body.secretIds) ? req.body.secretIds.slice(0, 500) : [], { type: req.body.type ?? 'fasum', note: req.body.note }, ctxOf(req))));
router.get('/api/fasum/report', api(async req => ({ report: await fasum.report({ siteId: siteParam(req), month: req.query.month }) })));
router.get('/api/fasum/report.csv', async (req, res, next) => {
  try {
    const { name, csv } = await fasum.reportCsv({ siteId: siteParam(req), month: req.query.month });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' });
    res.send(csv);
  } catch (err) { next(err); }
});
router.get('/api/sync/batches', api(async () => ({ rows: await smartSync.batches() })));
router.get('/api/sync/batches/:id/export', async (req, res, next) => {
  try {
    const { name, csv } = await smartSync.batchCsv(Number(req.params.id));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' });
    res.send(csv);
  } catch (err) { next(err); }
});
router.post('/api/sync/batches/:id/undo', requireNetworkControl, api(async req => {
  const out = await smartSync.undoBatch(Number(req.params.id), req.session.user.id);
  await audit({ userId: req.session.user.id, action: 'nms_smart_sync_undo', entityType: 'nms_sync_batch', entityId: out.batchId, siteId: out.siteId, ip: req.ip, description: `Undo Smart Sync #${out.batchId}: ${out.released} dilepas` });
  return out;
}));
router.get('/api/settings', api(async () => ({ settings: await nmsSettings.all() })));
router.post('/api/settings', requireAdmin, api(async req => {
  const values = nmsSettings.sanitize(req.body || {});
  const saved = await nmsSettings.set(values, req.session.user.id);
  await audit({ userId: req.session.user.id, action: 'nms_settings', entityType: 'nms_settings', ip: req.ip, description: 'Ubah pengaturan otomasi NMS', details: values });
  return { settings: saved };
}));
router.get('/api/summary/preview', api(async () => ({ text: await insights.morningSummaryText() })));
router.post('/api/summary/send', requireNetworkControl, api(async req => insights.sendSummary({ userId: req.session.user.id })));
router.post('/api/snapshots/take', requireNetworkControl, api(async () => automation.takeSnapshots()));
router.get('/api/routers/:id/diff', api(async req => ({ diff: await automation.configDiff({ routerId: Number(req.params.id), date: req.query.date || null }) })));

module.exports = router;
