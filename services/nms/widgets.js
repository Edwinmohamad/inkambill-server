// Data widget tambahan NOC Dashboard: aktivitas PPP 24 jam, potensi kebocoran pendapatan,
// ODP yang dicurigai gangguan, dan agenda otomasi. Tiap bagian gagal secara terpisah
// (widget menampilkan pesan error sendiri) supaya satu query bermasalah tidak mengosongkan dashboard.
const db = require('../../config/db');
const cache = require('./cache');
const insights = require('./insights');
const automation = require('./automation');

async function activity24h(siteId) {
  const params = siteId ? [Number(siteId)] : [];
  // Bucket dihitung relatif terhadap NOW() database (ago = 0..23 jam) supaya tidak bergantung
  // pada zona waktu container Node vs server MySQL.
  const [rows] = await db.query(`SELECT TIMESTAMPDIFF(HOUR, occurred_at, NOW()) ago,
      SUM(event_type='login') login, SUM(event_type='logout') logout, SUM(event_type='auth_failed') failed
    FROM nms_ppp_events WHERE occurred_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) ${siteId ? 'AND site_id=?' : ''}
    GROUP BY ago`, params);
  const byAgo = new Map(rows.map(r => [Number(r.ago), r]));
  const now = Date.now();
  return Array.from({ length: 24 }, (_, i) => {
    const ago = 23 - i, r = byAgo.get(ago) || {};
    return { ago, at: new Date(now - ago * 3600000).toISOString(), login: Number(r.login || 0), logout: Number(r.logout || 0), failed: Number(r.failed || 0) };
  });
}

async function leak(siteId) {
  const r = await insights.reconcile(siteId, 'overdue_active');
  const rows = r.overdue_active?.rows || [];
  const today = new Date().toISOString().slice(0, 10);
  const active = rows.filter(x => !(x.isolate_hold_until && String(x.isolate_hold_until).slice(0, 10) >= today));
  const unlinked = await insights.reconcile(siteId, 'secret_no_customer');
  const un = unlinked.secret_no_customer?.rows || [];
  return {
    overdue: { count: active.length, amount: active.reduce((a, x) => a + Number(x.outstanding || 0), 0), online: active.filter(x => Number(x.is_online)).length, held: rows.length - active.length, error: r.overdue_active?.error || null },
    unlinked: { count: un.length, online: un.filter(x => Number(x.is_online)).length, error: unlinked.secret_no_customer?.error || null }
  };
}

async function outages(siteId) {
  const h = await insights.siteHealth();
  const list = (h.clusters || []).filter(c => !siteId || Number(c.site_id) === Number(siteId));
  return { suspect: list.filter(c => c.suspectOutage).slice(0, 6), watch: list.filter(c => !c.suspectOutage && c.offlinePct >= 30).sort((a, b) => b.offlinePct - a.offlinePct).slice(0, 4) };
}

async function agenda() {
  const [schedules, approvals] = await Promise.all([automation.listScheduled({ status: 'pending', limit: 5 }), automation.listApprovals({ limit: 20 })]);
  return {
    schedules: schedules.slice(0, 4).map(s => ({ id: s.id, action: s.action, run_at: s.run_at, count: s.count, targets: s.targets, note: s.note, profile: s.profile, package_name: s.package_name })),
    approvals: approvals.filter(a => a.status === 'pending').slice(0, 3).map(a => ({ id: a.id, summary: a.summary, requested_by_name: a.requested_by_name, created_at: a.created_at }))
  };
}

const safe = async fn => { try { return await fn(); } catch (err) { return { error: err.message }; } };

async function all(siteId = null) {
  return cache.wrap(`nms:widgets:${siteId || 'all'}`, 30000, async () => {
    const [activity, leakData, outage, agendaData] = await Promise.all([safe(() => activity24h(siteId)), safe(() => leak(siteId)), safe(() => outages(siteId)), safe(() => agenda())]);
    return { generatedAt: new Date().toISOString(), activity, leak: leakData, outages: outage, agenda: agendaData };
  });
}

module.exports = { all, activity24h, leak, outages, agenda };
