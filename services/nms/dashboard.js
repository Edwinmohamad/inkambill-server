// Agregasi payload NOC Dashboard (dipakai render awal, polling fallback, dan SSE snapshot).
const db = require('../../config/db');
const cache = require('./cache');
const store = require('./secretStore');
const poller = require('./poller');

const FLAP_THRESHOLD = Number(process.env.NMS_FLAP_THRESHOLD || 5);

async function flapping(siteId) {
  const params = siteId ? [Number(siteId), FLAP_THRESHOLD] : [FLAP_THRESHOLD];
  const [rows] = await db.query(`SELECT e.site_id, s.code site_code, e.username, COUNT(*) reconnects, MAX(e.occurred_at) last_at, p.id secret_id, c.name customer_name, c.customer_code
    FROM nms_ppp_events e JOIN sites s ON s.id=e.site_id
    LEFT JOIN ppp_secrets p ON p.router_id=e.router_id AND p.username=e.username
    LEFT JOIN customers c ON c.id=p.customer_id
    WHERE e.event_type='login' AND e.occurred_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) ${siteId ? 'AND e.site_id=?' : ''}
    GROUP BY e.site_id, s.code, e.username, p.id, c.name, c.customer_code HAVING COUNT(*) > ? ORDER BY reconnects DESC LIMIT 25`, params);
  return rows;
}

async function recentEvents(siteId, limit = 60) {
  const params = siteId ? [Number(siteId)] : [];
  const [rows] = await db.query(`SELECT e.id, e.site_id, s.code site_code, e.router_id, e.username, e.event_type type, e.address, e.caller_id, e.message, e.source, e.occurred_at at
    FROM nms_ppp_events e LEFT JOIN sites s ON s.id=e.site_id ${siteId ? 'WHERE e.site_id=?' : ''} ORDER BY e.id DESC LIMIT ?`, [...params, Math.min(200, limit)]);
  return rows;
}

async function openAlerts(siteId) {
  const params = siteId ? [Number(siteId)] : [];
  const [rows] = await db.query(`SELECT a.id, a.alert_type type, a.severity, a.site_id, s.code site_code, s.name site_name, a.router_id, a.title, a.details, a.opened_at, a.last_seen_at, a.acknowledged_by
    FROM nms_alerts a LEFT JOIN sites s ON s.id=a.site_id WHERE a.resolved_at IS NULL ${siteId ? 'AND a.site_id=?' : ''} ORDER BY FIELD(a.severity,'critical','warning','info'), a.opened_at DESC LIMIT 20`, params);
  return rows.map(r => { let d = {}; try { d = JSON.parse(r.details || '{}'); } catch (_) {} return { ...r, details: { count: d.count, stillOffline: d.stillOffline, error: d.error } }; });
}

async function getDashboard(siteId = null) {
  const key = `nms:dash:${siteId || 'all'}`;
  return cache.wrap(key, 5000, async () => {
    const params = siteId ? [Number(siteId)] : [];
    const siteWhere = siteId ? 'AND p.site_id=?' : '';
    const [routers, counts, alerts, flaps, events, freshnessRows, todayRows, impactRows] = await Promise.all([
      poller.routerSnapshots(siteId), store.counts(siteId), openAlerts(siteId), flapping(siteId), recentEvents(siteId),
      db.query(`SELECT MIN(p.last_seen_on_router_at) oldest, MAX(p.last_seen_on_router_at) newest FROM ppp_secrets p WHERE p.removed_on_router_at IS NULL ${siteWhere}`, params).then(([r]) => r[0] || {}),
      db.query(`SELECT COALESCE(SUM(linked_count),0) linked, COUNT(*) batches FROM nms_sync_batches WHERE created_at >= CURDATE() ${siteId ? 'AND site_id=?' : ''}`, params).then(([r]) => r[0] || {}),
      db.query(`SELECT p.router_id, COUNT(*) linked, SUM(p.is_online=1) online, SUM(p.is_isolated=1) isolated FROM ppp_secrets p WHERE p.removed_on_router_at IS NULL ${siteWhere} GROUP BY p.router_id`, params).then(([r]) => r || [])
    ]);
    const impact = new Map(impactRows.map(r => [Number(r.router_id), { linked: Number(r.linked || 0), online: Number(r.online || 0), isolated: Number(r.isolated || 0) }]));
    routers.forEach(router => { router.impact = impact.get(Number(router.routerId)) || { linked: 0, online: 0, isolated: 0 }; });
    const reachable = routers.filter(r => r.status === 'online').length;
    return {
      generatedAt: new Date().toISOString(), siteId: siteId ? Number(siteId) : null,
      degraded: routers.length > 0 && reachable < routers.length,
      allOffline: routers.length > 0 && reachable === 0,
      routers, customers: { online: counts.online, offline: counts.offline, isolated: counts.isolated, total: counts.total },
      sync: { synced: counts.synced, unsynced: counts.unsynced, exempt: counts.exempt, syncedPct: counts.syncedPct, linkedToday: Number(todayRows.linked || 0), batchesToday: Number(todayRows.batches || 0) },
      freshness: { oldest: freshnessRows.oldest || null, newest: freshnessRows.newest || null, stale: !freshnessRows.newest || Date.now() - new Date(freshnessRows.newest).getTime() > 10 * 60000 },
      healthScore: Math.max(0, Math.round((routers.length ? reachable / routers.length * 45 : 45) + counts.syncedPct * .45 + (alerts.filter(a => a.severity === 'critical').length ? 0 : 10))),
      alerts, flapping: flaps, events
    };
  });
}

async function sites() {
  const [rows] = await db.query(`SELECT s.id, s.code, s.name, COUNT(r.id) routers FROM sites s LEFT JOIN routers r ON r.site_id=s.id AND r.is_active=1 WHERE s.is_active=1 GROUP BY s.id, s.code, s.name ORDER BY s.code`);
  return rows;
}

module.exports = { getDashboard, sites, recentEvents, flapping, openAlerts };
