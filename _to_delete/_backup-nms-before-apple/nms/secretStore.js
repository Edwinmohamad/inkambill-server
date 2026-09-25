// Mirror RouterOS /ppp/secret → tabel ppp_secrets, plus query untuk tab Synced / Unsynced.
const db = require('../../config/db');
const { encrypt } = require('../cryptoService');
const ros = require('./rosApi');
const { exemptOf, normalizeKey } = require('./matching');

const ISOLIR_PROFILE = String(process.env.NMS_ISOLIR_PROFILE || 'ISOLIR').trim();
const bool = v => v === true || String(v) === 'true' || String(v) === 'yes';
const isIsolirProfile = p => !!p && (p.toLowerCase() === ISOLIR_PROFILE.toLowerCase() || /isolir|isolate/i.test(p));

async function activeRouters(siteId = null) {
  const params = [];
  let sql = `SELECT r.*, s.code site_code, s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1`;
  if (siteId) { sql += ' AND r.site_id=?'; params.push(Number(siteId)); }
  const [rows] = await db.query(sql + ' ORDER BY s.code, r.name', params);
  return rows;
}
async function routerById(id) {
  const [[row]] = await db.query(`SELECT r.*, s.code site_code, s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.id=? AND r.is_active=1`, [id]);
  if (!row) throw Object.assign(new Error('Router tidak ditemukan / nonaktif.'), { status: 404 });
  return row;
}

/** Tarik semua secret dari 1 router lalu upsert. Juga meng-import link lama
 *  (customers.pppoe_username + router_id) sebagai "synced" — itu data billing, bukan tebakan. */
async function syncRouterSecrets(router) {
  const secrets = await ros.secrets(router);
  const seen = [];
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const s of secrets) {
      const username = String(s.name || '').trim();
      if (!username) continue;
      seen.push(username);
      const profile = s.profile || null;
      const exempt = exemptOf({ username, profile, comment: s.comment });
      const passwordEnc = s.password ? encrypt(s.password) : null;
      await conn.execute(`INSERT INTO ppp_secrets (site_id, router_id, ros_id, username, password_enc, profile, service, local_address, remote_address, caller_id, comment, disabled, is_isolated, is_exempt, exempt_type, last_seen_on_router_at, removed_on_router_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NULL)
        ON DUPLICATE KEY UPDATE site_id=VALUES(site_id), ros_id=VALUES(ros_id), password_enc=COALESCE(VALUES(password_enc), password_enc), profile=VALUES(profile), service=VALUES(service),
          local_address=VALUES(local_address), remote_address=VALUES(remote_address), caller_id=VALUES(caller_id), comment=VALUES(comment), disabled=VALUES(disabled),
          is_isolated=VALUES(is_isolated), is_exempt=VALUES(is_exempt), exempt_type=VALUES(exempt_type), last_seen_on_router_at=NOW(), removed_on_router_at=NULL`,
        [router.site_id, router.id, s['.id'] || null, username, passwordEnc, profile, s.service || null, s['local-address'] || null, s['remote-address'] || null,
          s['caller-id'] || null, s.comment ? String(s.comment).slice(0, 255) : null, bool(s.disabled) ? 1 : 0, (bool(s.disabled) || isIsolirProfile(profile)) ? 1 : 0, exempt ? 1 : 0, exempt]);
    }
    // Secret yang hilang dari router ditandai (tidak dihapus: histori & audit tetap utuh).
    if (seen.length) {
      await conn.query(`UPDATE ppp_secrets SET removed_on_router_at=COALESCE(removed_on_router_at,NOW()), is_online=0 WHERE router_id=? AND username NOT IN (?)`, [router.id, seen]);
    }
    // Import link billing existing (pppoe_username) yang belum tercermin di ppp_secrets.
    await conn.execute(`UPDATE ppp_secrets p JOIN customers c ON c.site_id=p.site_id AND LOWER(TRIM(c.pppoe_username))=LOWER(p.username) AND (c.router_id IS NULL OR c.router_id=p.router_id)
        LEFT JOIN ppp_secrets other ON other.customer_id=c.id
      SET p.customer_id=c.id, p.sync_status='synced', p.match_method='pppoe_username', p.last_synced_at=NOW()
      WHERE p.router_id=? AND p.customer_id IS NULL AND other.id IS NULL AND c.archived_at IS NULL`, [router.id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
  return { routerId: router.id, secrets: seen.length };
}

/** Terapkan snapshot /ppp/active ke ppp_secrets (flag online, IP, MAC aktif). */
async function applyActive(router, active) {
  const names = active.map(a => String(a.name || '')).filter(Boolean);
  await db.execute(`UPDATE ppp_secrets SET is_online=0, active_address=NULL, active_uptime=NULL WHERE router_id=? AND is_online=1`, [router.id]);
  for (let i = 0; i < active.length; i += 200) {
    const chunk = active.slice(i, i + 200).filter(a => a.name);
    if (!chunk.length) continue;
    const cases = f => chunk.map(() => 'WHEN ? THEN ?').join(' ');
    const p = f => chunk.flatMap(a => [String(a.name).toLowerCase(), a[f] || null]);
    await db.query(`UPDATE ppp_secrets SET is_online=1,
        active_address=CASE LOWER(username) ${cases()} END,
        active_caller_id=CASE LOWER(username) ${cases()} END,
        active_uptime=CASE LOWER(username) ${cases()} END
      WHERE router_id=? AND LOWER(username) IN (?)`, [...p('address'), ...p('caller-id'), ...p('uptime'), router.id, chunk.map(a => String(a.name).toLowerCase())]);
  }
  // Sinkronkan network_status pelanggan terhubung (dipakai modul billing/dashboard lama).
  await db.execute(`UPDATE customers c JOIN ppp_secrets p ON p.customer_id=c.id
      SET c.status_changed_at=IF(c.network_status <> (CASE WHEN p.is_isolated=1 THEN 'isolated' WHEN p.is_online=1 THEN 'online' ELSE 'offline' END), NOW(), c.status_changed_at),
          c.network_status=CASE WHEN p.is_isolated=1 THEN 'isolated' WHEN p.is_online=1 THEN 'online' ELSE 'offline' END
    WHERE p.router_id=?`, [router.id]);
  return names.length;
}

const TAB_SQL = {
  synced: `p.customer_id IS NOT NULL`,
  unsynced: `p.customer_id IS NULL`
};

async function listSecrets({ tab = 'synced', siteId = null, q = '', status = '', includeExempt = false, page = 1, limit = 50 } = {}) {
  const where = ['p.removed_on_router_at IS NULL', TAB_SQL[tab] || TAB_SQL.synced];
  const params = [];
  if (siteId) { where.push('p.site_id=?'); params.push(Number(siteId)); }
  if (tab === 'unsynced' && !includeExempt) where.push('p.is_exempt=0');
  if (status === 'online') where.push('p.is_online=1 AND p.is_isolated=0');
  if (status === 'offline') where.push('p.is_online=0 AND p.is_isolated=0');
  if (status === 'isolated') where.push('p.is_isolated=1');
  if (q) { where.push('(p.username LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ? OR p.active_address LIKE ? OR p.remote_address LIKE ?)'); const like = `%${q}%`; params.push(like, like, like, like, like); }
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const base = `FROM ppp_secrets p JOIN sites s ON s.id=p.site_id JOIN routers r ON r.id=p.router_id LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN packages pk ON pk.id=c.package_id WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await db.query(`SELECT COUNT(*) total ${base}`, params);
  const [rows] = await db.query(`SELECT p.id, p.site_id, s.code site_code, s.name site_name, p.router_id, r.name router_name, p.username, p.profile, p.original_profile,
      p.local_address, p.remote_address, p.caller_id, p.disabled, p.is_isolated, p.is_exempt, p.exempt_type, p.is_online, p.active_address, p.active_caller_id, p.active_uptime,
      p.sync_status, p.match_method, p.last_synced_at, p.last_login_at, p.last_logout_at, p.comment,
      c.id customer_id, c.customer_code, c.name customer_name, c.phone customer_phone, c.network_status, c.customer_status, pk.name package_name
    ${base} ORDER BY p.is_isolated DESC, p.is_online ASC, s.code, COALESCE(c.name, p.username) LIMIT ? OFFSET ?`, [...params, safeLimit, (safePage - 1) * safeLimit]);
  return { rows: rows.map(r => ({ ...r, state: r.is_isolated ? 'isolated' : r.is_online ? 'online' : 'offline' })), total, page: safePage, limit: safeLimit, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}

async function secretById(id) {
  const [[row]] = await db.query(`SELECT p.*, s.code site_code FROM ppp_secrets p JOIN sites s ON s.id=p.site_id WHERE p.id=?`, [id]);
  if (!row) throw Object.assign(new Error('PPP Secret tidak ditemukan.'), { status: 404 });
  return row;
}

async function counts(siteId = null) {
  const params = siteId ? [Number(siteId)] : [];
  const [[row]] = await db.query(`SELECT COUNT(*) total,
      SUM(customer_id IS NOT NULL) synced, SUM(customer_id IS NULL AND is_exempt=0) unsynced, SUM(customer_id IS NULL AND is_exempt=1) exempt,
      SUM(is_online=1 AND is_isolated=0) online, SUM(is_online=0 AND is_isolated=0 AND disabled=0) offline, SUM(is_isolated=1) isolated
    FROM ppp_secrets WHERE removed_on_router_at IS NULL ${siteId ? 'AND site_id=?' : ''}`, params);
  const n = k => Number(row?.[k] || 0);
  const billable = n('synced') + n('unsynced');
  return { total: n('total'), synced: n('synced'), unsynced: n('unsynced'), exempt: n('exempt'), online: n('online'), offline: n('offline'), isolated: n('isolated'), syncedPct: billable ? Math.round(n('synced') / billable * 1000) / 10 : 0 };
}

module.exports = { activeRouters, routerById, syncRouterSecrets, applyActive, listSecrets, secretById, counts, isIsolirProfile, ISOLIR_PROFILE, normalizeKey };
