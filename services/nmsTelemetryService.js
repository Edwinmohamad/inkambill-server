const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const mt = require('./mikrotikRest');

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function uptimeSeconds(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 0;
  let total = 0;
  const parts = text.match(/(\d+)\s*(w|d|h|m|s)/g) || [];
  for (const part of parts) {
    const match = part.match(/(\d+)\s*(w|d|h|m|s)/);
    if (!match) continue;
    const unit = match[2];
    const multiplier = unit === 'w' ? 604800 : unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    total += Number(match[1]) * multiplier;
  }
  return total;
}

async function routerRecord(routerId) {
  const [[router]] = await db.query(`SELECT r.*,s.code site_code FROM routers r LEFT JOIN sites s ON s.id=r.site_id WHERE r.id=? AND r.is_active=1 LIMIT 1`, [routerId]);
  if (!router) throw new Error('Router tidak ditemukan atau tidak aktif.');
  return router;
}

async function captureInterfaceTraffic(router) {
  const interfaces = await mt.listInterfaces(router);
  let saved = 0;
  for (const item of interfaces) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const rx = number(item['rx-byte']);
    const tx = number(item['tx-byte']);
    const [[previous]] = await db.query(`SELECT sampled_at,rx_bytes,tx_bytes FROM nms_interface_samples WHERE router_id=? AND interface_name=? ORDER BY sampled_at DESC LIMIT 1`, [router.id, name]);
    const elapsed = previous ? Math.max(1, (Date.now() - new Date(previous.sampled_at).getTime()) / 1000) : 0;
    const rxBps = previous && rx >= number(previous.rx_bytes) ? Math.round((rx - number(previous.rx_bytes)) / elapsed) : 0;
    const txBps = previous && tx >= number(previous.tx_bytes) ? Math.round((tx - number(previous.tx_bytes)) / elapsed) : 0;
    await db.execute(`INSERT INTO nms_interface_samples(router_id,interface_name,rx_bytes,tx_bytes,rx_bps,tx_bps,running) VALUES(?,?,?,?,?,?,?)`, [router.id, name, rx, tx, rxBps, txBps, item.running === true || String(item.running) === 'true' ? 1 : 0]);
    saved++;
  }
  await db.execute(`DELETE FROM nms_interface_samples WHERE router_id=? AND sampled_at < DATE_SUB(NOW(),INTERVAL 14 DAY)`, [router.id]);
  return { routerId: router.id, interfaces: saved };
}

async function captureResourceSample(router) {
  const info = await mt.testConnection(router);
  const cpuLoad = Number(info?.['cpu-load']);
  const freeMemory = number(info?.['free-memory']);
  const totalMemory = number(info?.['total-memory']);
  await db.execute(`INSERT INTO nms_resource_samples(router_id,cpu_load,free_memory,total_memory,uptime_seconds,board_name,version) VALUES(?,?,?,?,?,?,?)`,
    [router.id, Number.isFinite(cpuLoad) ? cpuLoad : null, freeMemory || null, totalMemory || null, uptimeSeconds(info?.uptime) || null, info?.['board-name'] || null, info?.version || null]);
  await db.execute(`UPDATE routers SET last_status='online',last_error=NULL,last_seen_at=NOW() WHERE id=?`, [router.id]);
  await db.execute(`DELETE FROM nms_resource_samples WHERE router_id=? AND sampled_at < DATE_SUB(NOW(),INTERVAL 14 DAY)`, [router.id]);
  return { routerId: router.id, cpuLoad: Number.isFinite(cpuLoad) ? cpuLoad : null, freeMemory, totalMemory };
}

async function capturePppoeSessions(router) {
  const active = await mt.listActive(router);
  const seen = new Set();
  for (const row of active) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const sessionId = String(row['session-id'] || row['.id'] || `${name}:${row.address || ''}`);
    const key = `${name}|${sessionId}`;
    seen.add(key);
    const [[customer]] = await db.query(`SELECT id FROM customers WHERE router_id=? AND pppoe_username=? LIMIT 1`, [router.id, name]);
    const seconds = uptimeSeconds(row.uptime);
    const [[current]] = await db.query(`SELECT id,started_at FROM nms_pppoe_sessions WHERE router_id=? AND secret_name=? AND session_id=? AND status='online' ORDER BY id DESC LIMIT 1`, [router.id, name, sessionId]);
    if (current) {
      await db.execute(`UPDATE nms_pppoe_sessions SET last_seen_at=NOW(),customer_id=?,address=?,caller_id=?,last_uptime_seconds=?,status='online',ended_at=NULL WHERE id=?`, [customer?.id || null, row.address || null, row['caller-id'] || null, seconds, current.id]);
    } else {
      const startedAt = seconds ? new Date(Date.now() - seconds * 1000) : new Date();
      await db.execute(`INSERT INTO nms_pppoe_sessions(router_id,secret_name,session_id,customer_id,address,caller_id,started_at,last_seen_at,last_uptime_seconds,status) VALUES(?,?,?,?,?,?,?,NOW(),?,'online')`, [router.id, name, sessionId, customer?.id || null, row.address || null, row['caller-id'] || null, startedAt, seconds]);
    }
  }
  // A session absent for two consecutive minutes is considered offline. This
  // preserves its last_seen/ended timestamps for uptime and downtime reports.
  await db.execute(`UPDATE nms_pppoe_sessions SET status='offline',ended_at=COALESCE(ended_at,NOW()) WHERE router_id=? AND status='online' AND last_seen_at < DATE_SUB(NOW(),INTERVAL 2 MINUTE)`, [router.id]);
  return { routerId: router.id, active: active.length, seen: seen.size };
}

async function captureRouterTelemetry(router) {
  const results = await Promise.allSettled([captureInterfaceTraffic(router), capturePppoeSessions(router), captureResourceSample(router)]);
  if (results[2].status === 'rejected') {
    await db.execute(`UPDATE routers SET last_status='offline',last_error=? WHERE id=?`, [String(results[2].reason.message || 'Gagal terhubung').slice(0, 500), router.id]).catch(() => {});
  }
  return { routerId: router.id, traffic: results[0].status === 'fulfilled' ? results[0].value : { error: results[0].reason.message }, sessions: results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason.message }, resource: results[2].status === 'fulfilled' ? results[2].value : { error: results[2].reason.message } };
}

async function captureAllNmsTelemetry() {
  const [routers] = await db.query(`SELECT r.*,s.code site_code FROM routers r LEFT JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 ORDER BY r.id`);
  const results = await Promise.all(routers.map(router => captureRouterTelemetry(router)));
  return { routers: routers.length, results };
}

async function getTrafficTrend({ routerId, interfaceName = '', hours = 24 } = {}) {
  const safeHours = Math.min(168, Math.max(1, Number(hours) || 24));
  let sql = `SELECT router_id,interface_name,sampled_at,rx_bps,tx_bps,running FROM nms_interface_samples WHERE sampled_at >= DATE_SUB(NOW(),INTERVAL ? HOUR)`;
  const params = [safeHours];
  if (routerId) { sql += ' AND router_id=?'; params.push(Number(routerId)); }
  if (interfaceName) { sql += ' AND interface_name=?'; params.push(String(interfaceName).slice(0, 180)); }
  sql += ' ORDER BY sampled_at ASC,interface_name ASC LIMIT 10000';
  const [rows] = await db.execute(sql, params);
  return rows.map(row => ({ ...row, rx_bps: number(row.rx_bps), tx_bps: number(row.tx_bps), running: Boolean(row.running) }));
}

async function getSessionHistory({ customerId, routerId, hours = 168 } = {}) {
  const safeHours = Math.min(720, Math.max(1, Number(hours) || 168));
  let sql = `SELECT h.*,r.name router_name,s.code site_code FROM nms_pppoe_sessions h JOIN routers r ON r.id=h.router_id LEFT JOIN sites s ON s.id=r.site_id WHERE h.last_seen_at >= DATE_SUB(NOW(),INTERVAL ? HOUR)`;
  const params = [safeHours];
  if (customerId) { sql += ' AND h.customer_id=?'; params.push(Number(customerId)); }
  if (routerId) { sql += ' AND h.router_id=?'; params.push(Number(routerId)); }
  sql += ' ORDER BY h.last_seen_at DESC LIMIT 5000';
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function getResourceTrend({ routerId, hours = 24 } = {}) {
  const safeHours = Math.min(168, Math.max(1, Number(hours) || 24));
  let sql = `SELECT router_id,sampled_at,cpu_load,free_memory,total_memory,uptime_seconds,board_name,version FROM nms_resource_samples WHERE sampled_at >= DATE_SUB(NOW(),INTERVAL ? HOUR)`;
  const params = [safeHours];
  if (routerId) { sql += ' AND router_id=?'; params.push(Number(routerId)); }
  sql += ' ORDER BY sampled_at ASC LIMIT 10000';
  const [rows] = await db.execute(sql, params);
  return rows.map(row => ({ ...row, cpu_load: row.cpu_load === null ? null : Number(row.cpu_load), free_memory: number(row.free_memory), total_memory: number(row.total_memory) }));
}

function backupRoot() {
  const configured = String(process.env.NMS_BACKUP_DIR || 'storage/nms-backups');
  return path.isAbsolute(configured) ? configured : path.join(__dirname, '..', configured);
}

async function recordBackup(row) {
  await db.execute(`INSERT INTO nms_router_backups(router_id,backup_type,file_path,file_size,sha256,status,error_message) VALUES(?,?,?,?,?,?,?)`, [row.routerId, row.type, row.filePath || null, row.fileSize || null, row.sha256 || null, row.status, row.error || null]);
}

async function runRouterBackup(routerId, types = ['rsc', 'backup']) {
  const router = await routerRecord(routerId);
  const dir = path.join(backupRoot(), String(router.id));
  await fs.mkdir(dir, { recursive: true });
  const results = [];
  for (const type of [...new Set(types)].filter(item => ['rsc', 'backup'].includes(item))) {
    const base = `${router.name || `router-${router.id}`}`.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60);
    const fileName = `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.${type}`;
    const filePath = path.join(dir, fileName);
    try {
      // RouterOS REST exposes these commands as POST endpoints. Some older
      // RouterOS versions do not expose /export; the failed row is retained so
      // the operator can see exactly which backup type needs an upgrade.
      const endpoint = type === 'rsc' ? '/export' : '/system/backup/save';
      const payload = type === 'rsc' ? {} : { name: fileName.replace(/\.backup$/, '') };
      const response = await mt.request(router, 'POST', endpoint, payload, 30000);
      const text = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
      await fs.writeFile(filePath, text, 'utf8');
      const stat = await fs.stat(filePath);
      const sha256 = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
      const result = { routerId: router.id, type, filePath, fileSize: stat.size, sha256, status: 'success' };
      await recordBackup(result);
      results.push(result);
    } catch (error) {
      const result = { routerId: router.id, type, status: 'failed', error: error.message };
      await recordBackup(result);
      results.push(result);
    }
  }
  return results;
}

async function backupAllRouters(types) {
  const [routers] = await db.query(`SELECT id FROM routers WHERE is_active=1 ORDER BY id`);
  const settled = await Promise.all(routers.map(router => runRouterBackup(router.id, types)));
  return settled.flat();
}

module.exports = { uptimeSeconds, captureRouterTelemetry, captureAllNmsTelemetry, getTrafficTrend, getSessionHistory, getResourceTrend, captureResourceSample, runRouterBackup, backupAllRouters };
