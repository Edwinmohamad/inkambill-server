// MikroTik NMS v2 + NOC Dashboard.
// Mount: app.use('/nms', requireAuth, requirePermission('network'), require('./routes/nms'))
// Baca data: permission 'network'. Aksi yang mengubah layanan pelanggan: Admin ATAU permission
// 'network_control' (dapat diberikan ke role operator NOC di Pengaturan → Role & Akses).
const express = require('express');
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

const router = express.Router();

const canControl = req => isAdminRole(req.session.user?.role) || (req.permissions || []).includes('network_control');
function requireNetworkControl(req, res, next) {
  if (canControl(req)) return next();
  return res.status(403).json({ ok: false, error: 'Aksi ini membutuhkan role Admin atau permission "Kontrol Jaringan".' });
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
    res.render('nms/dashboard', { title: 'NOC Dashboard', sites, siteId, data, canControl: canControl(req), nmsPage: 'dashboard' });
  } catch (err) { next(err); }
});

router.get('/secrets', async (req, res, next) => {
  try {
    const siteId = siteParam(req);
    const [sites, counts] = await Promise.all([dashboard.sites(), store.counts(siteId)]);
    const [[offline]] = await db.query(`SELECT COUNT(*) n FROM routers r WHERE r.is_active=1 AND r.last_status='offline' ${siteId ? 'AND r.site_id=?' : ''}`, siteId ? [siteId] : []);
    res.set('Cache-Control', 'no-store');
    res.render('nms/secrets', { title: 'MikroTik NMS · PPP Secrets', sites, siteId, counts, routersOffline: Number(offline.n || 0), tab: req.query.tab === 'unsynced' ? 'unsynced' : 'synced', canControl: canControl(req), nmsPage: 'secrets', isolirProfile: store.ISOLIR_PROFILE, isolirMode: control.ISOLIR_MODE });
  } catch (err) { next(err); }
});

// ---------- Dashboard & telemetry ----------
router.get('/api/dashboard', api(async req => ({ data: await dashboard.getDashboard(siteParam(req)) })));
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
  const handlers = ['telemetry', 'ppp', 'alert', 'alert_resolved', 'router_state', 'sync'].map(evt => [evt, payload => send(evt, payload)]);
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
  const out = await smartSync.commit({ planId: String(req.body.planId || ''), secretIds: req.body.secretIds });
  await audit({ userId: req.session.user.id, action: 'nms_smart_sync', entityType: 'ppp_secret', ip: req.ip, siteId: out.siteId, description: `Smart Sync: ${out.summary.linked}/${out.summary.planned} di-link`, details: { planId: out.planId, summary: out.summary, linked: out.results.filter(r => r.ok).map(r => ({ secretId: r.secretId, username: r.username, customerId: r.customerId })), failed: out.results.filter(r => !r.ok) } });
  return out;
}));
router.get('/api/customers/search', api(async req => ({ rows: await smartSync.searchCustomers({ q: String(req.query.q || '').trim().slice(0, 80), siteId: siteParam(req) }) })));
router.post('/api/secrets/:id/map', requireNetworkControl, api(async req => {
  const { secret, customer } = await smartSync.manualMap(Number(req.params.id), Number(req.body.customerId));
  await audit({ userId: req.session.user.id, action: 'nms_manual_map', entityType: 'ppp_secret', entityId: secret.id, siteId: secret.site_id, ip: req.ip, description: `Map ${secret.username} → ${customer.customer_code} ${customer.name}`, details: { username: secret.username, customerId: customer.id } });
  return { secretId: secret.id, customerId: customer.id, customerName: customer.name };
}));
router.post('/api/secrets/:id/unmap', requireNetworkControl, api(async req => {
  const { secret, customerId } = await smartSync.unmap(Number(req.params.id));
  await audit({ userId: req.session.user.id, action: 'nms_unmap', entityType: 'ppp_secret', entityId: secret.id, siteId: secret.site_id, ip: req.ip, description: `Unmap ${secret.username}`, details: { customerId } });
  return { secretId: secret.id };
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
  return await control.bulk({ action: String(b.action || ''), secretIds: b.secretIds, filter, profile: b.profile ? String(b.profile).slice(0, 64) : null, dryRun: !!b.dryRun }, ctxOf(req));
}));

module.exports = router;
