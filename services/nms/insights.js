// Insight NMS: rekonsiliasi billing↔router, diagnosa "kenapa offline", timeline + revert,
// detail pelanggan, akun dipakai bersama, kesehatan site/ODP, ringkasan pagi, ekspor CSV.
const db = require('../../config/db');
const ros = require('./rosApi');
const store = require('./secretStore');
const settings = require('./settings');

const siteWhere = (col, siteId, params) => { if (!siteId) return ''; params.push(Number(siteId)); return ` AND ${col}=?`; };
const LIMIT = 300;

// ---------------------------------------------------------------- Rekonsiliasi
const RECON = {
  overdue_active: {
    title: 'Lewat jatuh tempo, layanan masih jalan', tone: 'red', fix: 'isolate', fixLabel: 'Isolir',
    hint: 'Tagihan sudah lewat masa tenggang tapi secret belum diisolir. Ini kebocoran pendapatan paling umum.',
    sql: (siteId, p) => `SELECT p.id secret_id, p.username, p.is_online, p.profile, s.code site_code, c.id customer_id, c.customer_code, c.name customer_name, c.phone,
        SUM(i.outstanding) outstanding, MIN(i.due_date) oldest_due, DATEDIFF(CURDATE(), MIN(i.due_date)) days_late, DATE_FORMAT(c.isolate_hold_until, '%Y-%m-%d') isolate_hold_until
      FROM customers c JOIN ppp_secrets p ON p.customer_id=c.id AND p.removed_on_router_at IS NULL JOIN sites s ON s.id=c.site_id
      JOIN invoices i ON i.customer_id=c.id AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
      CROSS JOIN settings st
      WHERE st.id=1 AND c.archived_at IS NULL AND c.customer_status='active' AND p.is_isolated=0 AND p.is_exempt=0
        AND CURDATE() > DATE_ADD(i.due_date, INTERVAL COALESCE(c.grace_days, s.default_grace_days, st.default_grace_days, 2) DAY)
        ${siteWhere('c.site_id', siteId, p)}
      GROUP BY p.id, p.username, p.is_online, p.profile, s.code, c.id, c.customer_code, c.name, c.phone, c.isolate_hold_until
      ORDER BY days_late DESC LIMIT ${LIMIT}`
  },
  paid_isolated: {
    title: 'Sudah lunas, masih diisolir', tone: 'orange', fix: 'unisolate', fixLabel: 'Buka isolir',
    hint: 'Tidak ada tunggakan tapi secret masih di profile isolir / disabled. Pelanggan ini kemungkinan sedang komplain.',
    sql: (siteId, p) => `SELECT p.id secret_id, p.username, p.is_online, p.profile, p.original_profile, s.code site_code, c.id customer_id, c.customer_code, c.name customer_name, c.phone, c.isolation_reason,
        (SELECT MAX(py.paid_at) FROM payments py JOIN invoices i2 ON i2.id=py.invoice_id WHERE i2.customer_id=c.id AND py.status='confirmed') last_paid_at
      FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id JOIN sites s ON s.id=p.site_id
      WHERE p.removed_on_router_at IS NULL AND p.is_isolated=1 AND c.archived_at IS NULL AND c.customer_status='active'
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id=c.id AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0)
        ${siteWhere('p.site_id', siteId, p)}
      ORDER BY last_paid_at DESC LIMIT ${LIMIT}`
  },
  inactive_online: {
    title: 'Pelanggan non-aktif masih online', tone: 'red', fix: 'isolate', fixLabel: 'Isolir',
    hint: 'Status pelanggan suspended / berhenti di billing, tapi sesi PPPoE-nya masih aktif.',
    sql: (siteId, p) => `SELECT p.id secret_id, p.username, p.is_online, p.profile, s.code site_code, c.id customer_id, c.customer_code, c.name customer_name, c.customer_status, c.phone
      FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id JOIN sites s ON s.id=p.site_id
      WHERE p.removed_on_router_at IS NULL AND p.is_isolated=0 AND p.is_online=1 AND (c.customer_status NOT IN ('active') OR c.archived_at IS NOT NULL)
        ${siteWhere('p.site_id', siteId, p)} ORDER BY c.name LIMIT ${LIMIT}`
  },
  secret_no_customer: {
    title: 'Secret aktif tanpa pelanggan', tone: 'purple', fix: 'map', fixLabel: 'Hubungkan / buat pelanggan',
    hint: 'Ada yang memakai internet tapi tidak tertagih. Hubungkan ke pelanggan yang ada, atau buat pelanggan baru dari secret.',
    sql: (siteId, p) => `SELECT p.id secret_id, p.username, p.is_online, p.profile, p.comment, p.active_address, s.code site_code, r.name router_name, p.last_login_at
      FROM ppp_secrets p JOIN sites s ON s.id=p.site_id JOIN routers r ON r.id=p.router_id
      WHERE p.removed_on_router_at IS NULL AND p.customer_id IS NULL AND p.is_exempt=0 AND p.disabled=0 AND p.is_isolated=0
        AND (p.is_online=1 OR p.last_login_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))
        ${siteWhere('p.site_id', siteId, p)} ORDER BY p.is_online DESC, p.username LIMIT ${LIMIT}`
  },
  customer_no_secret: {
    title: 'Pelanggan aktif tanpa secret', tone: 'blue', fix: 'create_secret', fixLabel: 'Buat secret',
    hint: 'Pelanggan ditagih tapi belum punya akun PPPoE yang terhubung. Buat secret baru langsung ke router.',
    sql: (siteId, p) => `SELECT c.id customer_id, c.customer_code, c.name customer_name, c.phone, s.code site_code, c.site_id, pk.name package_name, pk.mikrotik_profile, c.created_at
      FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN packages pk ON pk.id=c.package_id
      WHERE c.archived_at IS NULL AND c.customer_status='active' AND NOT EXISTS (SELECT 1 FROM ppp_secrets p WHERE p.customer_id=c.id AND p.removed_on_router_at IS NULL)
        ${siteWhere('c.site_id', siteId, p)} ORDER BY c.created_at DESC LIMIT ${LIMIT}`
  },
  removed_on_router: {
    title: 'Secret hilang dari router', tone: 'gray', fix: 'create_secret', fixLabel: 'Buat ulang secret',
    hint: 'Pelanggan terhubung ke secret yang sudah dihapus di router (mungkin lewat Winbox).',
    sql: (siteId, p) => `SELECT p.id secret_id, p.username, p.profile, s.code site_code, c.id customer_id, c.customer_code, c.name customer_name, p.removed_on_router_at, c.site_id
      FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id JOIN sites s ON s.id=p.site_id
      WHERE p.removed_on_router_at IS NOT NULL AND c.archived_at IS NULL AND c.customer_status='active'
        AND NOT EXISTS (SELECT 1 FROM ppp_secrets p2 WHERE p2.customer_id=c.id AND p2.removed_on_router_at IS NULL AND p2.id<>p.id)
        ${siteWhere('p.site_id', siteId, p)} ORDER BY p.removed_on_router_at DESC LIMIT ${LIMIT}`
  },
  active_without_secret: {
    title: 'PPPoE Active tanpa Secret Mirror', tone: 'red', fix: null, fixLabel: null,
    hint: 'Sesi terlihat aktif di MikroTik tetapi secret belum ada di mirror NMS. NMS mencoba recovery otomatis; yang tersisa perlu dicek di router/RADIUS.',
    sql: (siteId, p) => `SELECT a.username, a.site_id, s.code site_code, r.name router_name, a.first_seen_at, a.last_seen_at,
        JSON_UNQUOTE(JSON_EXTRACT(a.details_json,'$.address')) active_address,
        JSON_UNQUOTE(JSON_EXTRACT(a.details_json,'$.callerId')) active_caller_id,
        JSON_UNQUOTE(JSON_EXTRACT(a.details_json,'$.uptime')) active_uptime
      FROM nms_ppp_anomalies a JOIN sites s ON s.id=a.site_id JOIN routers r ON r.id=a.router_id
      WHERE a.anomaly_type='active_without_secret' AND a.resolved_at IS NULL
        ${siteWhere('a.site_id', siteId, p)} ORDER BY a.last_seen_at DESC LIMIT ${LIMIT}`
  },
  profile_mismatch: {
    title: 'Profile MikroTik berbeda dengan paket', tone: 'orange', fix: null, fixLabel: null,
    hint: 'Binding pelanggan tetap aman. NMS hanya menandai perbedaan dan tidak mengubah paket billing secara otomatis.',
    sql: (siteId, p) => `SELECT p.id secret_id, p.username, p.profile, s.code site_code, c.id customer_id, c.customer_code, c.name customer_name,
        pk.name package_name, pk.mikrotik_profile package_profile
      FROM ppp_secrets p JOIN customers c ON c.id=p.customer_id JOIN sites s ON s.id=p.site_id JOIN packages pk ON pk.id=c.package_id
      WHERE p.removed_on_router_at IS NULL AND p.is_isolated=0 AND c.archived_at IS NULL
        AND pk.mikrotik_profile IS NOT NULL AND pk.mikrotik_profile<>'' AND p.profile IS NOT NULL AND p.profile<>''
        AND LOWER(TRIM(pk.mikrotik_profile))<>LOWER(TRIM(p.profile))
        ${siteWhere('p.site_id', siteId, p)} ORDER BY s.code, c.name LIMIT ${LIMIT}`
  }
};

async function reconcile(siteId = null, kind = null) {
  const kinds = kind ? [kind] : Object.keys(RECON);
  const out = {};
  for (const k of kinds) {
    const def = RECON[k];
    if (!def) continue;
    const params = [];
    const sql = def.sql(siteId, params);
    let rows = [];
    try { [rows] = await db.query(sql, params); }
    catch (err) { out[k] = { ...meta(k), count: 0, rows: [], error: err.message }; continue; }
    out[k] = { ...meta(k), count: rows.length, rows: kind ? rows : rows.slice(0, 8) };
  }
  return out;
}
const meta = k => ({ key: k, title: RECON[k].title, tone: RECON[k].tone, fix: RECON[k].fix, fixLabel: RECON[k].fixLabel, hint: RECON[k].hint });

// ---------------------------------------------------------------- Diagnosa
async function diagnose(secretId) {
  const secret = await store.secretById(secretId);
  const router = await store.routerById(secret.router_id);
  const checks = [];
  const add = (key, label, status, detail, fix = null) => checks.push({ key, label, status, detail, fix });
  let reachable = false, live = null, session = null;
  try { live = await ros.secretByName(router, secret.username); reachable = true; add('router', `Router ${router.name}`, 'ok', 'Terjangkau dari server'); }
  catch (err) { add('router', `Router ${router.name}`, 'fail', err.message, null); }
  if (reachable) {
    if (!live) add('secret', 'Secret di router', 'fail', 'Secret tidak ada lagi di router', 'create_secret');
    else {
      add('secret', 'Secret di router', 'ok', `Profile ${live.profile || '-'}`);
      add('enabled', 'Akun aktif', String(live.disabled) === 'true' ? 'fail' : 'ok', String(live.disabled) === 'true' ? 'Secret disabled' : 'Tidak disabled', String(live.disabled) === 'true' ? 'unisolate' : null);
      const isolir = store.isIsolirProfile(live.profile);
      add('isolir', isolir ? 'Sedang diisolir' : 'Status isolir', isolir ? 'warn' : 'ok', isolir ? `Profile ${live.profile}. Pelanggan hanya dapat akses halaman isolir.` : 'Tidak diisolir', isolir ? 'unisolate' : null);
      const mac = live['caller-id'];
      if (mac) add('mac', 'MAC lock', 'warn', `Dikunci ke ${mac}. Kalau ONT/router pelanggan diganti, login akan ditolak.`, 'unlock-mac');
      else add('mac', 'MAC lock', 'ok', 'Tidak dikunci');
    }
    try { [session] = await ros.active(router, secret.username); } catch (_) {}
    if (session) {
      add('session', 'Sesi PPPoE', 'ok', `Online · ${session.address || '-'} · uptime ${session.uptime || '-'}`);
      try {
        const p = await ros.ping(router, session.address, 4);
        add('ping', 'Ping dari router', p.lossPct >= 50 ? 'fail' : p.lossPct > 0 ? 'warn' : 'ok', `${p.received}/${p.sent} reply · avg ${p.avgMs ?? '-'} ms · loss ${p.lossPct}%`);
      } catch (err) { add('ping', 'Ping dari router', 'warn', err.message); }
    } else add('session', 'Sesi PPPoE', 'fail', 'Tidak ada sesi aktif');
  }
  const [[lastEvents]] = await db.query(`SELECT
      (SELECT MAX(occurred_at) FROM nms_ppp_events WHERE router_id=? AND username=? AND event_type='logout') last_logout,
      (SELECT COUNT(*) FROM nms_ppp_events WHERE router_id=? AND username=? AND event_type='login' AND occurred_at>=DATE_SUB(NOW(), INTERVAL 1 HOUR)) logins_1h,
      (SELECT COUNT(*) FROM nms_ppp_events WHERE username=? AND event_type='auth_failed' AND occurred_at>=DATE_SUB(NOW(), INTERVAL 24 HOUR)) auth_fail_24h`,
  [secret.router_id, secret.username, secret.router_id, secret.username, secret.username]);
  if (Number(lastEvents.auth_fail_24h) > 0) add('auth', 'Login ditolak', 'fail', `${lastEvents.auth_fail_24h}× authentication failed dalam 24 jam. Cek password di ONT / MAC lock.`, 'unlock-mac');
  if (Number(lastEvents.logins_1h) > 5) add('flap', 'Stabilitas koneksi', 'warn', `${lastEvents.logins_1h}× reconnect dalam 1 jam. Kemungkinan kabel, ONT, atau listrik.`, 'ticket');
  if (!session && lastEvents.last_logout) add('lastseen', 'Terakhir terlihat', 'info', `Putus ${new Date(lastEvents.last_logout).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
  if (secret.customer_id) {
    const [[inv]] = await db.query(`SELECT COALESCE(SUM(outstanding),0) outstanding, MIN(due_date) oldest FROM invoices WHERE customer_id=? AND status IN ('unpaid','partial','overdue') AND outstanding>0`, [secret.customer_id]);
    add('billing', 'Tagihan', Number(inv.outstanding) > 0 ? 'warn' : 'ok', Number(inv.outstanding) > 0 ? `Tunggakan Rp ${Number(inv.outstanding).toLocaleString('id-ID')}` : 'Tidak ada tunggakan');
  }
  // Urutan penyebab: dari yang paling mendasar (router/secret/isolir) ke gejala (tidak ada sesi, ping).
  const PRIORITY = ['router', 'secret', 'enabled', 'isolir', 'auth', 'mac', 'session', 'ping', 'flap'];
  const first = checks.filter(c => (c.status === 'fail' || c.status === 'warn') && PRIORITY.includes(c.key) && !(c.key === 'mac' && session))
    .sort((x, y) => PRIORITY.indexOf(x.key) - PRIORITY.indexOf(y.key))[0];
  let verdict = session ? 'Pelanggan online.' : 'Pelanggan offline.';
  if (!reachable) verdict = 'Router tidak terjangkau. Masalah di sisi router / uplink, bukan di pelanggan.';
  else if (first) verdict = `${first.label}: ${first.detail}`;
  else if (!session) verdict = 'Konfigurasi di router normal. Kemungkinan perangkat pelanggan mati, kabel/FO putus, atau listrik padam.';
  return { secretId: secret.id, username: secret.username, online: !!session, verdict, checks, testedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- Timeline + revert
async function timeline(secretId, limit = 80) {
  const secret = await store.secretById(secretId);
  const [audits] = await db.query(`SELECT a.id, a.action, a.description, a.details, a.created_at at, u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.entity_type='ppp_secret' AND a.entity_id=? ORDER BY a.id DESC LIMIT ?`, [secret.id, limit]);
  const [events] = await db.query(`SELECT id, event_type type, message, address, caller_id, source, occurred_at at FROM nms_ppp_events WHERE router_id=? AND username=? ORDER BY id DESC LIMIT ?`, [secret.router_id, secret.username, limit]);
  const REVERTIBLE = new Set(['nms_isolate', 'nms_unisolate', 'nms_profile_change', 'nms_manual_map', 'nms_unmap', 'nms_lock_mac', 'nms_unlock_mac']);
  const items = [
    ...audits.map(a => { let d = {}; try { d = JSON.parse(a.details || '{}'); } catch (_) {} return { kind: 'action', id: a.id, action: a.action, text: a.description, user: a.user_name || (d.source ? `sistem · ${d.source}` : 'sistem'), at: a.at, revertible: REVERTIBLE.has(a.action), details: d }; }),
    ...events.filter(e => e.source !== 'action').map(e => ({ kind: 'event', id: `e${e.id}`, action: e.type, text: e.message || e.type, at: e.at, address: e.address, callerId: e.caller_id }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
  const latestRevertible = items.find(i => i.revertible);
  items.forEach(i => { i.canRevert = !!latestRevertible && i === latestRevertible; });
  return { secretId: secret.id, username: secret.username, items };
}

async function revert(auditId, ctx) {
  const control = require('./control');
  const smartSync = require('./smartSync');
  const [[a]] = await db.query(`SELECT * FROM audit_logs WHERE id=? AND entity_type='ppp_secret'`, [auditId]);
  if (!a) throw Object.assign(new Error('Riwayat aksi tidak ditemukan.'), { status: 404 });
  let d = {}; try { d = JSON.parse(a.details || '{}'); } catch (_) {}
  const id = Number(a.entity_id);
  const c = { ...ctx, source: 'revert' };
  switch (a.action) {
    case 'nms_isolate': return { action: 'unisolate', result: await control.unisolate(id, c) };
    case 'nms_unisolate': return { action: 'isolate', result: await control.isolate(id, { ...c, reason: 'manual' }) };
    case 'nms_profile_change': if (!d.from) throw new Error('Profile sebelumnya tidak tercatat.'); return { action: 'profile', result: await control.changeProfile(id, d.from, c) };
    case 'nms_manual_map': return { action: 'unmap', result: await smartSync.unmap(id) };
    case 'nms_unmap': if (!d.customerId) throw new Error('Pelanggan sebelumnya tidak tercatat.'); return { action: 'map', result: await smartSync.manualMap(id, d.customerId) };
    case 'nms_lock_mac': return { action: 'unlock-mac', result: await control.lockMac(id, c, { unlock: true }) };
    case 'nms_unlock_mac': {
      if (!d.previous) throw new Error('MAC sebelumnya tidak tercatat.');
      const secret = await store.secretById(id); const router = await store.routerById(secret.router_id);
      const live = await ros.secretByName(router, secret.username);
      if (!live) throw new Error('Secret tidak ada di router.');
      await ros.patchSecret(router, live['.id'], { 'caller-id': d.previous });
      await db.execute(`UPDATE ppp_secrets SET caller_id=? WHERE id=?`, [d.previous, id]);
      return { action: 'lock-mac', result: { callerId: d.previous } };
    }
    default: throw new Error('Aksi ini tidak bisa dikembalikan otomatis.');
  }
}

// ---------------------------------------------------------------- Detail panel
async function detail(secretId) {
  const [[row]] = await db.query(`SELECT p.*, s.code site_code, s.name site_name, r.name router_name, c.customer_code, c.name customer_name, c.phone, c.address, c.customer_status, c.network_status,
      c.isolation_reason, DATE_FORMAT(c.isolate_hold_until, '%Y-%m-%d') isolate_hold_until, c.isolate_hold_note, c.due_day, c.package_id, pk.name package_name, pk.price package_price, pk.mikrotik_profile package_profile, cl.name cluster_name
    FROM ppp_secrets p JOIN sites s ON s.id=p.site_id JOIN routers r ON r.id=p.router_id LEFT JOIN customers c ON c.id=p.customer_id
    LEFT JOIN packages pk ON pk.id=c.package_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE p.id=?`, [secretId]);
  if (!row) throw Object.assign(new Error('PPP Secret tidak ditemukan.'), { status: 404 });
  delete row.password_enc;
  let invoices = [];
  if (row.customer_id) [invoices] = await db.query(`SELECT id, invoice_number, period_year, period_month, total, outstanding, status, due_date FROM invoices WHERE customer_id=? ORDER BY id DESC LIMIT 6`, [row.customer_id]).catch(async () => db.query(`SELECT id, total, outstanding, status, due_date FROM invoices WHERE customer_id=? ORDER BY id DESC LIMIT 6`, [row.customer_id]));
  const [sessions] = await db.query(`SELECT DATE(occurred_at) d, SUM(event_type='login') logins, SUM(event_type='logout') logouts FROM nms_ppp_events
    WHERE router_id=? AND username=? AND occurred_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY DATE(occurred_at) ORDER BY d`, [row.router_id, row.username]);
  const [scheduled] = await db.query(`SELECT id, action, profile, run_at, note FROM nms_scheduled_actions WHERE status='pending' AND JSON_CONTAINS(secret_ids, ?) ORDER BY run_at LIMIT 5`, [String(row.id)]).catch(() => [[]]);
  return { secret: { ...row, state: row.is_isolated ? 'isolated' : row.is_online ? 'online' : 'offline' }, invoices, history7d: sessions, scheduled };
}

// ---------------------------------------------------------------- Akun dipakai bersama
async function sharedAccounts(siteId = null) {
  const threshold = await settings.num('shared_mac_threshold');
  const p1 = [threshold]; const w1 = siteId ? (p1.unshift(Number(siteId)), 'AND e.site_id=?') : '';
  const [multiMac] = await db.query(`SELECT e.router_id, e.username, COUNT(DISTINCT e.caller_id) macs, GROUP_CONCAT(DISTINCT e.caller_id ORDER BY e.caller_id SEPARATOR ', ') mac_list, MAX(e.occurred_at) last_at,
      p.id secret_id, c.name customer_name, s.code site_code
    FROM nms_ppp_events e LEFT JOIN ppp_secrets p ON p.router_id=e.router_id AND p.username=e.username LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN sites s ON s.id=e.site_id
    WHERE e.event_type='login' AND e.caller_id IS NOT NULL AND e.caller_id<>'' AND e.occurred_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ${w1}
    GROUP BY e.router_id, e.username, p.id, c.name, s.code HAVING COUNT(DISTINCT e.caller_id) >= ? ORDER BY macs DESC LIMIT 50`, p1);
  const p2 = []; const w2 = siteId ? (p2.push(Number(siteId)), 'AND e.site_id=?') : '';
  const [multiUser] = await db.query(`SELECT e.caller_id, COUNT(DISTINCT e.username) users, GROUP_CONCAT(DISTINCT e.username ORDER BY e.username SEPARATOR ', ') user_list, MAX(e.occurred_at) last_at, MAX(s.code) site_code
    FROM nms_ppp_events e LEFT JOIN sites s ON s.id=e.site_id
    WHERE e.event_type='login' AND e.caller_id IS NOT NULL AND e.caller_id<>'' AND e.occurred_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ${w2}
    GROUP BY e.caller_id HAVING COUNT(DISTINCT e.username) >= 2 ORDER BY users DESC LIMIT 50`, p2);
  return { threshold, multiMac, multiUser };
}

// ---------------------------------------------------------------- Kesehatan site / ODP
async function siteHealth() {
  const [sites] = await db.query(`SELECT s.id, s.code, s.name,
      COUNT(p.id) secrets, SUM(p.is_online=1 AND p.is_isolated=0) online, SUM(p.is_online=0 AND p.is_isolated=0 AND p.disabled=0) offline, SUM(p.is_isolated=1) isolated,
      (SELECT COUNT(*) FROM routers r WHERE r.site_id=s.id AND r.is_active=1) routers,
      (SELECT COUNT(*) FROM routers r WHERE r.site_id=s.id AND r.is_active=1 AND r.last_status='online') routers_up,
      (SELECT COUNT(*) FROM nms_alerts a WHERE a.site_id=s.id AND a.resolved_at IS NULL) open_alerts
    FROM sites s LEFT JOIN ppp_secrets p ON p.site_id=s.id AND p.removed_on_router_at IS NULL AND p.customer_id IS NOT NULL
    WHERE s.is_active=1 GROUP BY s.id, s.code, s.name ORDER BY s.code`);
  const [clusters] = await db.query(`SELECT cl.id, cl.name, cl.site_id, s.code site_code, COUNT(p.id) customers, SUM(p.is_online=1) online, SUM(p.is_online=0 AND p.is_isolated=0 AND p.disabled=0) offline,
      MAX(p.last_logout_at) last_drop
    FROM clusters cl JOIN sites s ON s.id=cl.site_id JOIN customers c ON c.cluster_id=cl.id AND c.archived_at IS NULL
    JOIN ppp_secrets p ON p.customer_id=c.id AND p.removed_on_router_at IS NULL
    WHERE cl.archived_at IS NULL GROUP BY cl.id, cl.name, cl.site_id, s.code HAVING COUNT(p.id) > 0 ORDER BY s.code, cl.name`).catch(() => [[]]);
  const routerUp = new Map(sites.map(s => [Number(s.id), Number(s.routers_up) > 0]));
  clusters.forEach(c => {
    const off = Number(c.offline) || 0, total = Number(c.customers) || 0;
    c.offlinePct = total ? Math.round(off / total * 100) : 0;
    c.suspectOutage = routerUp.get(Number(c.site_id)) && total >= 4 && off >= 3 && c.offlinePct >= 60;
  });
  return { sites: sites.map(s => ({ ...s, onlinePct: Number(s.secrets) ? Math.round(Number(s.online) / Number(s.secrets) * 100) : 0 })), clusters };
}

/** Kirim info gangguan ke pelanggan di 1 cluster/ODP — lewat batch persetujuan WA Gateway. */
async function notifyArea({ clusterId, message, userId }) {
  const { enqueueWaMessage, approvalBatchKey } = require('../whatsappGatewayService');
  const [rows] = await db.query(`SELECT c.id, c.phone, c.name FROM customers c WHERE c.cluster_id=? AND c.archived_at IS NULL AND c.customer_status='active' AND c.phone IS NOT NULL AND c.phone<>''`, [clusterId]);
  const text = String(message || '').trim().slice(0, 1000);
  if (!text) throw new Error('Isi pesan wajib diisi.');
  let queued = 0, failed = 0;
  for (const c of rows) {
    try { await enqueueWaMessage({ phone: c.phone, message: text.replace(/\{nama\}/gi, c.name), customerId: c.id, type: 'network_alert', userId, approvalBatch: approvalBatchKey('outage_notice') }); queued++; }
    catch (_) { failed++; }
  }
  return { queued, failed, total: rows.length };
}

// ---------------------------------------------------------------- Flapping → tiket
async function createFlapTicket({ secretId, userId }) {
  const secret = await store.secretById(secretId);
  const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM nms_ppp_events WHERE router_id=? AND username=? AND event_type='login' AND occurred_at>=DATE_SUB(NOW(), INTERVAL 1 HOUR)`, [secret.router_id, secret.username]);
  const [[open]] = await db.query(`SELECT id, ticket_code FROM tickets WHERE customer_id <=> ? AND status IN ('open','in_progress') AND subject LIKE ? LIMIT 1`, [secret.customer_id, `%${secret.username}%`]).catch(() => [[null]]);
  if (open) return { existing: true, id: open.id, code: open.ticket_code };
  const d = new Date();
  const code = `TT-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(Date.now()).slice(-6)}`;
  const [r] = await db.execute(`INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,opened_by,opened_at) VALUES(?,?,?,?,?,'open',?,?,NOW())`,
    [code, secret.customer_id || null, `Koneksi putus-sambung: ${secret.username}`, 'Gangguan Internet', Number(n) > 15 ? 'high' : 'medium',
      `Dibuat dari NMS. ${n}× reconnect dalam 1 jam terakhir (site ${secret.site_code}). Periksa kabel/FO, ONT, adaptor, dan listrik di lokasi pelanggan.`, userId]);
  return { existing: false, id: r.insertId, code };
}

// ---------------------------------------------------------------- Ringkasan pagi
async function morningSummaryText() {
  const [[c]] = await db.query(`SELECT SUM(is_online=1 AND is_isolated=0) online, SUM(is_isolated=1) isolated,
      SUM(is_online=0 AND is_isolated=0 AND disabled=0 AND customer_id IS NOT NULL AND (last_logout_at IS NULL OR last_logout_at < DATE_SUB(NOW(), INTERVAL 24 HOUR))) off24,
      SUM(customer_id IS NULL AND is_exempt=0) unsynced,
      SUM(customer_id IS NULL AND is_exempt=1 AND exempt_type='fasum') fasum, SUM(customer_id IS NULL AND is_exempt=1 AND exempt_type='fasum' AND is_online=0 AND disabled=0) fasum_off
    FROM ppp_secrets WHERE removed_on_router_at IS NULL`);
  const [[paid]] = await db.query(`SELECT COUNT(DISTINCT i.customer_id) n, COALESCE(SUM(py.amount),0) total FROM payments py JOIN invoices i ON i.id=py.invoice_id WHERE py.status='confirmed' AND py.paid_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`).catch(() => [[{ n: 0, total: 0 }]]);
  const [routers] = await db.query(`SELECT r.name, s.code FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 AND r.last_status='offline'`);
  const [alerts] = await db.query(`SELECT title FROM nms_alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC LIMIT 3`);
  const recon = await reconcile(null);
  const n = v => Number(v || 0).toLocaleString('id-ID');
  const date = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' });
  const lines = [
    `*Ringkasan Jaringan · ${date}*`, '',
    `Online: ${n(c.online)}`, `Diisolir: ${n(c.isolated)}`, `Offline >24 jam: ${n(c.off24)}`,
    `Bayar 24 jam terakhir: ${n(paid.n)} pelanggan (Rp ${n(paid.total)})`, '',
    ...(Number(c.fasum) ? [`Fasum: ${n(c.fasum)} (${n(c.fasum_off)} offline)`] : []),
    `Router bermasalah: ${routers.length ? routers.map(r => `${r.name} (${r.code})`).join(', ') : 'tidak ada'}`
  ];
  const leak = recon.overdue_active?.count || 0, stuck = recon.paid_isolated?.count || 0, free = recon.secret_no_customer?.count || 0;
  if (leak || stuck || free || Number(c.unsynced)) {
    lines.push('', '*Perlu dicek*');
    if (leak) lines.push(`• ${leak} lewat jatuh tempo tapi belum diisolir`);
    if (stuck) lines.push(`• ${stuck} sudah lunas tapi masih diisolir`);
    if (free) lines.push(`• ${free} secret aktif tanpa pelanggan`);
    if (Number(c.unsynced)) lines.push(`• ${n(c.unsynced)} secret belum ter-link (Smart Sync)`);
  }
  if (alerts.length) lines.push('', '*Alert terbuka*', ...alerts.map(a => `• ${a.title}`));
  return lines.join('\n');
}

async function sendSummary({ userId = null } = {}) {
  const { enqueueWaMessage } = require('../whatsappGatewayService');
  const numbers = await settings.summaryNumbers();
  if (!numbers.length) throw new Error('Nomor WA tujuan belum diisi (Otomasi → Ringkasan pagi, atau Pengaturan → Alert Jaringan).');
  const text = await morningSummaryText();
  let sent = 0;
  for (const phone of numbers) { try { await enqueueWaMessage({ phone, message: text, type: 'network_alert', userId }); sent++; } catch (_) {} }
  return { sent, numbers: numbers.length, text };
}

// ---------------------------------------------------------------- Ekspor CSV
const csvCell = v => { if (v == null) return ''; const s = v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows) {
  if (!rows.length) return 'kosong\n';
  const cols = Object.keys(rows[0]);
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}
async function exportCsv({ kind, siteId }) {
  if (RECON[kind]) { const r = await reconcile(siteId, kind); return { name: `nms-${kind}`, csv: toCsv(r[kind].rows) }; }
  const tab = kind === 'unsynced' ? 'unsynced' : 'synced';
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const res = await store.listSecrets({ tab, siteId, page, limit: 200, includeExempt: true });
    all.push(...res.rows);
    if (page >= res.pages) break;
  }
  const rows = all.map(r => ({ site: r.site_code, router: r.router_name, username: r.username, customer_code: r.customer_code, customer_name: r.customer_name, package: r.package_name, profile: r.profile,
    state: r.state, ip: r.active_address || r.remote_address, caller_id: r.caller_id || r.active_caller_id, match: r.match_method, last_login: r.last_login_at, last_logout: r.last_logout_at, exempt: r.exempt_type }));
  return { name: `nms-${tab}`, csv: toCsv(rows) };
}

module.exports = { RECON, reconcile, diagnose, timeline, revert, detail, sharedAccounts, siteHealth, notifyArea, createFlapTicket, morningSummaryText, sendSummary, exportCsv, toCsv };
