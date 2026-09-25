// NMS Poller: satu-satunya komponen yang polling RouterOS secara periodik.
//  telemetry (resource + counter WAN)   tiap NMS_TELEMETRY_MS  (default 15s) — 2 GET ringan
//  health (suhu/voltase)                tiap 4x telemetry (±60s)
//  /ppp/active diff → login/logout      tiap NMS_ACTIVE_MS     (default 20s)
//  /ppp/secret mirror                   tiap NMS_SECRETS_MS    (default 5m)
//  /log (auth failed, opsional)         tiap 60s bila NMS_LOG_POLL=1
// Hasil disimpan di memori (live) + nms_router_state (fallback saat router offline / restart).
const crypto = require('crypto');
const db = require('../../config/db');
const ros = require('./rosApi');
const store = require('./secretStore');
const bus = require('./eventBus');
const cache = require('./cache');
const { uptimeSeconds, diffActive, detectMassDisconnect } = require('./analytics');

const TELEMETRY_MS = Math.max(10000, Number(process.env.NMS_TELEMETRY_MS || 15000));
const ACTIVE_MS = Math.max(10000, Number(process.env.NMS_ACTIVE_MS || 20000));
const SECRETS_MS = Math.max(60000, Number(process.env.NMS_SECRETS_MS || 300000));
const MASS_WINDOW_MS = Number(process.env.NMS_MASS_WINDOW_MS || 120000);
const MASS_THRESHOLD = Number(process.env.NMS_MASS_THRESHOLD || 10);
const HISTORY_POINTS = 120; // 30 menit @15s

const state = new Map();      // routerId -> live state
let routers = [];
let recentLogouts = [];       // {siteId, username, at}
const running = { telemetry: false, active: false, secrets: false, logs: false };
let started = false;

function stateFor(router) {
  if (!state.has(router.id)) state.set(router.id, { id: router.id, name: router.name, siteId: router.site_id, siteCode: router.site_code, siteName: router.site_name,
    status: 'unknown', lastOkAt: null, lastError: null, offlineTicks: 0, telemetry: null, wan: { interface: router.wan_interface || null, rxBps: 0, txBps: 0, peakRxBps: 0, peakTxBps: 0, history: [] },
    counters: null, active: null, activeSeeded: false, tick: 0, persistedAt: 0, lastLogId: null });
  const s = state.get(router.id);
  Object.assign(s, { name: router.name, siteId: router.site_id, siteCode: router.site_code, siteName: router.site_name });
  if (router.wan_interface) s.wan.interface = router.wan_interface;
  return s;
}

async function loadRouters() {
  routers = await store.activeRouters();
  const ids = new Set(routers.map(r => r.id));
  for (const id of state.keys()) if (!ids.has(id)) state.delete(id);
  routers.forEach(stateFor);
  return routers;
}

async function detectWan(router) {
  const list = await cache.wrap(`nms:ifaces:${router.id}`, 600000, () => ros.interfaces(router));
  const pick = list.find(i => /\b(wan|uplink|isp|internet|upstream)\b/i.test(`${i.name} ${i.comment || ''}`) && String(i.disabled) !== 'true')
    || list.find(i => i.type === 'ether' && String(i.running) === 'true') || list[0];
  return pick?.name || 'ether1';
}

async function persistState(s, force = false) {
  if (!force && Date.now() - s.persistedAt < 60000) return;
  s.persistedAt = Date.now();
  const payload = JSON.stringify({ telemetry: s.telemetry, wan: { ...s.wan, history: s.wan.history.slice(-40) }, lastOkAt: s.lastOkAt });
  await db.execute(`INSERT INTO nms_router_state (router_id, status, last_ok_at, last_error, telemetry_json) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE status=VALUES(status), last_ok_at=COALESCE(VALUES(last_ok_at), last_ok_at), last_error=VALUES(last_error), telemetry_json=IF(VALUES(status)='online', VALUES(telemetry_json), telemetry_json)`,
  [s.id, s.status, s.lastOkAt ? new Date(s.lastOkAt) : null, s.lastError, payload]).catch(err => console.error('NMS persist state:', err.message));
}

async function setStatus(s, status, error = null) {
  const changed = s.status !== status;
  s.status = status; s.lastError = error;
  if (status === 'online') { s.lastOkAt = Date.now(); s.offlineTicks = 0; } else s.offlineTicks++;
  if (changed) {
    await db.execute(status === 'online' ? `UPDATE routers SET last_status='online', last_error=NULL, last_seen_at=NOW() WHERE id=?` : `UPDATE routers SET last_status='offline', last_error=? WHERE id=?`,
      status === 'online' ? [s.id] : [String(error || '').slice(0, 500), s.id]).catch(() => {});
    bus.emit('router_state', { routerId: s.id, siteId: s.siteId, status, error, at: new Date().toISOString() });
    await persistState(s, true);
  }
  if (status === 'offline' && s.offlineTicks === 2) await openAlert({ type: 'router_down', severity: 'critical', siteId: s.siteId, routerId: s.id, title: `ROUTER DOWN: ${s.name} (${s.siteCode}) tidak terjangkau`, key: `router_down:${s.id}`, details: { error } });
  if (status === 'online' && changed) await resolveAlert(`router_down:${s.id}`);
}

async function telemetryRouter(router) {
  const s = stateFor(router);
  s.tick++;
  try {
    if (!s.wan.interface) s.wan.interface = await detectWan(router);
    const wantHealth = s.tick % 4 === 1;
    const [res, counters, health] = await Promise.all([ros.resource(router), ros.interfaceCounters(router, s.wan.interface), wantHealth ? ros.health(router) : Promise.resolve(null)]);
    const totalMem = Number(res['total-memory']) || 0, freeMem = Number(res['free-memory']) || 0;
    const totalHdd = Number(res['total-hdd-space']) || 0, freeHdd = Number(res['free-hdd-space']) || 0;
    const prevHealth = s.telemetry?.health || { temperature: null, voltage: null };
    s.telemetry = {
      uptimeSeconds: uptimeSeconds(res.uptime), cpuPct: Number(res['cpu-load']) || 0,
      memory: { total: totalMem, used: Math.max(0, totalMem - freeMem), pct: totalMem ? Math.round((totalMem - freeMem) / totalMem * 1000) / 10 : null },
      disk: { total: totalHdd, free: freeHdd, freePct: totalHdd ? Math.round(freeHdd / totalHdd * 1000) / 10 : null },
      health: health || prevHealth, board: res['board-name'] || null, version: res.version || null, sampledAt: new Date().toISOString()
    };
    if (counters) {
      const now = Date.now(), rx = Number(counters['rx-byte']) || 0, tx = Number(counters['tx-byte']) || 0;
      if (s.counters && now > s.counters.at && rx >= s.counters.rx && tx >= s.counters.tx) {
        const secs = (now - s.counters.at) / 1000;
        s.wan.rxBps = Math.round((rx - s.counters.rx) * 8 / secs);
        s.wan.txBps = Math.round((tx - s.counters.tx) * 8 / secs);
        s.wan.history.push({ t: now, rx: s.wan.rxBps, tx: s.wan.txBps });
        if (s.wan.history.length > HISTORY_POINTS) s.wan.history.shift();
        s.wan.peakRxBps = Math.max(...s.wan.history.map(p => p.rx));
        s.wan.peakTxBps = Math.max(...s.wan.history.map(p => p.tx));
      }
      s.counters = { rx, tx, at: now };
      s.wan.running = String(counters.running) === 'true';
    }
    await setStatus(s, 'online');
    await persistState(s);
  } catch (err) {
    s.counters = null;
    await setStatus(s, 'offline', err.message);
  }
  bus.emit('telemetry', publicState(s));
}

async function recordPppEvents(router, rows, type) {
  if (!rows.length) return;
  const values = rows.map(r => [router.id, router.site_id, String(r.name).slice(0, 128), type, r.address || null, r['caller-id'] || null, type === 'login' ? `PPP Login ${r.address || ''}`.trim() : 'PPP Disconnect', 'poll']);
  await db.query(`INSERT INTO nms_ppp_events (router_id, site_id, username, event_type, address, caller_id, message, source) VALUES ?`, [values]).catch(err => console.error('NMS event insert:', err.message));
  const names = rows.map(r => String(r.name).toLowerCase());
  await db.query(`UPDATE ppp_secrets SET ${type === 'login' ? 'last_login_at' : 'last_logout_at'}=NOW() WHERE router_id=? AND LOWER(username) IN (?)`, [router.id, names]).catch(() => {});
  const at = new Date().toISOString();
  rows.slice(0, 50).forEach(r => bus.emit('ppp', { routerId: router.id, siteId: router.site_id, username: r.name, type, address: r.address || null, callerId: r['caller-id'] || null, at, source: 'poll' }));
}

async function activeRouter(router) {
  const s = stateFor(router);
  if (s.status === 'offline') { s.activeSeeded = false; return; }
  let current;
  try { current = await ros.active(router); }
  catch (err) { s.activeSeeded = false; return; }
  if (s.activeSeeded && s.active) {
    const { logins, logouts } = diffActive(s.active, current);
    await recordPppEvents(router, logins, 'login');
    await recordPppEvents(router, logouts, 'logout');
    const at = Date.now();
    logouts.forEach(r => recentLogouts.push({ siteId: router.site_id, username: r.name, at }));
  }
  s.active = current; s.activeSeeded = true; s.activeCount = current.length;
  await store.applyActive(router, current).catch(err => console.error('NMS applyActive:', err.message));
}

async function evaluateMassDisconnect() {
  recentLogouts = recentLogouts.filter(e => Date.now() - e.at < 15 * 60000);
  const onlineNow = new Set();
  for (const s of state.values()) (s.active || []).forEach(a => onlineNow.add(String(a.name).toLowerCase()));
  const hits = detectMassDisconnect(recentLogouts, onlineNow, { windowMs: MASS_WINDOW_MS, threshold: MASS_THRESHOLD });
  const [sites] = await db.query(`SELECT id, code, name FROM sites`);
  const siteName = new Map(sites.map(x => [Number(x.id), x]));
  for (const hit of hits) {
    const site = siteName.get(Number(hit.siteId));
    await openAlert({ type: 'mass_disconnect', severity: 'critical', siteId: hit.siteId, title: `CRITICAL ALERT: Potential FO Cut / Power Outage at Site ${site?.name || site?.code || hit.siteId} - ${hit.count} Customers Disconnected!`, key: `mass_disconnect:${hit.siteId}`, details: { count: hit.count, usernames: hit.usernames, stillOffline: hit.count } });
  }
  // Resolusi: mayoritas pelanggan terdampak sudah kembali online.
  const [open] = await db.query(`SELECT id, site_id, details, dedup_key, opened_at FROM nms_alerts WHERE alert_type='mass_disconnect' AND resolved_at IS NULL`);
  for (const a of open) {
    let d = {}; try { d = JSON.parse(a.details || '{}'); } catch (_) {}
    const affected = d.usernames || [];
    const stillOffline = affected.filter(u => !onlineNow.has(String(u).toLowerCase())).length;
    const siteRoutersOnline = [...state.values()].some(s => Number(s.siteId) === Number(a.site_id) && s.status === 'online');
    if (siteRoutersOnline && stillOffline <= Math.max(2, Math.floor(affected.length * 0.2))) await resolveAlert(a.dedup_key);
    else if (stillOffline !== d.stillOffline) await db.execute(`UPDATE nms_alerts SET details=?, last_seen_at=NOW() WHERE id=?`, [JSON.stringify({ ...d, stillOffline }), a.id]);
  }
}

async function openAlert({ type, severity, siteId = null, routerId = null, title, key, details }) {
  const [res] = await db.execute(`INSERT INTO nms_alerts (alert_type, severity, site_id, router_id, title, details, dedup_key) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE last_seen_at=NOW(), title=VALUES(title), details=VALUES(details)`, [type, severity, siteId, routerId, title, JSON.stringify(details || {}), key]).catch(err => { console.error('NMS alert:', err.message); return [{}]; });
  if (res.affectedRows === 1) { // baru dibuka (bukan update)
    bus.emit('alert', { id: res.insertId, type, severity, siteId, routerId, title, details, openedAt: new Date().toISOString() });
    cache.del('nms:dash');
  }
}
async function resolveAlert(key) {
  const [res] = await db.execute(`UPDATE nms_alerts SET resolved_at=NOW(), dedup_key=CONCAT(dedup_key, ':', id) WHERE dedup_key=? AND resolved_at IS NULL`, [key]).catch(() => [{}]);
  if (res.affectedRows) { bus.emit('alert_resolved', { key, at: new Date().toISOString() }); cache.del('nms:dash'); }
}

async function pollLogs(router) {
  const s = stateFor(router);
  if (s.status !== 'online') return;
  const rows = await ros.logs(router).catch(() => []);
  const idNum = id => parseInt(String(id || '').replace('*', ''), 16) || 0;
  const fresh = rows.filter(r => idNum(r['.id']) > (s.lastLogId || 0));
  if (s.lastLogId == null) { s.lastLogId = rows.length ? Math.max(...rows.map(r => idNum(r['.id']))) : 0; return; } // seed
  for (const r of fresh) {
    const msg = String(r.message || '');
    if (!/authentication failed|login failed|bad password|user .* not found/i.test(msg)) continue;
    const user = (msg.match(/user\s+(\S+)/i) || msg.match(/<pppoe-([^>]+)>/i) || [])[1] || null;
    await ingestEvent({ router, username: user, type: 'auth_failed', message: msg.slice(0, 255), source: 'log', dedup: `log:${router.id}:${r['.id']}:${r.time}` });
  }
  if (fresh.length) s.lastLogId = Math.max(...fresh.map(r => idNum(r['.id'])));
}

/** Event dari webhook n8n / RouterOS script / log poll. */
async function ingestEvent({ router, username, type, address = null, callerId = null, message = null, source = 'webhook', occurredAt = null, dedup = null }) {
  const at = occurredAt ? new Date(occurredAt) : new Date();
  const key = dedup || crypto.createHash('sha1').update(`${router.id}|${username}|${type}|${Math.floor(at.getTime() / 1000)}`).digest('hex');
  const [res] = await db.execute(`INSERT IGNORE INTO nms_ppp_events (router_id, site_id, username, event_type, address, caller_id, message, source, dedup_key, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [router.id, router.site_id, username ? String(username).slice(0, 128) : null, type, address, callerId, message, source, key, at]);
  if (!res.affectedRows) return { duplicate: true };
  if (type === 'logout' && username) recentLogouts.push({ siteId: router.site_id, username, at: at.getTime() });
  if ((type === 'login' || type === 'logout') && username) {
    await db.execute(`UPDATE ppp_secrets SET is_online=?, ${type === 'login' ? 'last_login_at' : 'last_logout_at'}=?, active_address=IF(?, ?, active_address) WHERE router_id=? AND LOWER(username)=LOWER(?)`,
      [type === 'login' ? 1 : 0, at, type === 'login' ? 1 : 0, address, router.id, username]).catch(() => {});
  }
  bus.emit('ppp', { routerId: router.id, siteId: router.site_id, username, type, address, callerId, message, at: at.toISOString(), source });
  return { duplicate: false };
}

function publicState(s) {
  const stale = s.status !== 'online';
  return { routerId: s.id, name: s.name, siteId: s.siteId, siteCode: s.siteCode, siteName: s.siteName, status: s.status, stale, lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null, lastError: s.lastError,
    telemetry: s.telemetry, wan: { interface: s.wan.interface, rxBps: stale ? 0 : s.wan.rxBps, txBps: stale ? 0 : s.wan.txBps, peakRxBps: s.wan.peakRxBps, peakTxBps: s.wan.peakTxBps, running: s.wan.running ?? null, history: s.wan.history.slice(-HISTORY_POINTS) },
    activeSessions: s.activeCount ?? null };
}

/** Snapshot router untuk dashboard; router tanpa data live memakai nms_router_state (cache). */
async function routerSnapshots(siteId = null) {
  if (!routers.length) await loadRouters().catch(() => {});
  const scoped = [...state.values()].filter(s => !siteId || Number(s.siteId) === Number(siteId));
  const needCache = scoped.filter(s => !s.telemetry);
  if (needCache.length) {
    const [rows] = await db.query(`SELECT * FROM nms_router_state WHERE router_id IN (?)`, [needCache.map(s => s.id)]).catch(() => [[]]);
    for (const row of rows) {
      const s = state.get(Number(row.router_id)); if (!s || s.telemetry) continue;
      try { const j = JSON.parse(row.telemetry_json || '{}'); s.telemetry = j.telemetry || null; if (j.wan) s.wan = { ...s.wan, ...j.wan, history: j.wan.history || [] }; } catch (_) {}
      s.lastOkAt = s.lastOkAt || (row.last_ok_at ? new Date(row.last_ok_at).getTime() : null);
      if (s.status === 'unknown') { s.status = row.status === 'online' ? 'unknown' : row.status; s.lastError = row.last_error; }
    }
  }
  return scoped.map(publicState);
}

async function refreshSecrets(siteId = null) {
  const targets = (await store.activeRouters(siteId));
  const results = [];
  for (const r of targets) {
    try { results.push({ ok: true, ...(await store.syncRouterSecrets(r)) }); const cur = await ros.active(r); await store.applyActive(r, cur); }
    catch (err) { results.push({ ok: false, routerId: r.id, error: err.message }); }
  }
  cache.del('nms:dash');
  return results;
}

function guard(name, fn) {
  return async () => {
    if (running[name]) return; // tick sebelumnya belum selesai → skip, jangan menumpuk
    running[name] = true;
    try { await fn(); } catch (err) { console.error(`NMS ${name} tick gagal:`, err.message); }
    finally { running[name] = false; }
  };
}

function start() {
  if (started || process.env.NMS_POLLER_ENABLED === '0') return;
  started = true;
  const every = (ms, fn) => setInterval(fn, ms).unref();
  const telemetryTick = guard('telemetry', async () => { await Promise.all(routers.map(telemetryRouter)); });
  const activeTick = guard('active', async () => { await Promise.all(routers.map(activeRouter)); await evaluateMassDisconnect(); });
  const secretsTick = guard('secrets', async () => { for (const r of routers) { if (stateFor(r).status === 'online') await store.syncRouterSecrets(r).catch(err => console.error(`NMS secret sync ${r.name}:`, err.message)); } });
  const logsTick = guard('logs', async () => { await Promise.all(routers.map(pollLogs)); });
  loadRouters().then(async () => { await telemetryTick(); await secretsTick(); await activeTick(); }).catch(err => console.error('NMS poller init:', err.message));
  every(60000, () => loadRouters().catch(() => {}));
  every(TELEMETRY_MS, telemetryTick);
  every(ACTIVE_MS, activeTick);
  every(SECRETS_MS, secretsTick);
  if (process.env.NMS_LOG_POLL === '1') every(60000, logsTick);
  console.log(`NMS poller aktif: telemetry ${TELEMETRY_MS / 1000}s, active ${ACTIVE_MS / 1000}s, secrets ${SECRETS_MS / 1000}s`);
}

module.exports = { start, evaluateMassDisconnect, routerSnapshots, refreshSecrets, ingestEvent, loadRouters, openAlert, resolveAlert, resetWan: id => { const s = state.get(Number(id)); if (s) { s.wan = { interface: null, rxBps: 0, txBps: 0, peakRxBps: 0, peakTxBps: 0, history: [] }; s.counters = null; } } };
