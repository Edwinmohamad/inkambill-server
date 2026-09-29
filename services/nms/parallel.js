// Otorisasi sesi PPPoE tambahan untuk NOC. Tidak mengubah binding billing utama.
const db = require('../../config/db');
const cache = require('./cache');

async function summary(siteId = null) {
  const scope = siteId ? 'AND p.site_id=?' : '';
  const params = siteId ? [Number(siteId)] : [];
  const [rows] = await db.query(`SELECT p.id secret_id,p.site_id,s.code site_code,p.router_id,r.name router_name,p.username,
      p.customer_id primary_customer_id,pl.customer_id parallel_customer_id,
      CASE WHEN r.last_status='online' THEN p.active_sessions ELSE 0 END active_sessions,p.is_online,p.is_isolated,p.removed_on_router_at,
      c.id customer_id,c.name customer_name,c.customer_code,c.pppoe_parallel_limit,c.network_status,pl.note
    FROM ppp_secrets p LEFT JOIN nms_parallel_links pl ON pl.secret_id=p.id
    LEFT JOIN customers c ON c.id=COALESCE(p.customer_id,pl.customer_id)
    JOIN sites s ON s.id=p.site_id JOIN routers r ON r.id=p.router_id
    WHERE p.removed_on_router_at IS NULL ${scope} ORDER BY c.id,p.id`, params);
  const groups = new Map(); let activeSessions = 0, linkedSessions = 0, unlinkedOnline = 0;
  for (const row of rows) {
    const count = Number(row.active_sessions || 0);
    activeSessions += count;
    if (!row.customer_id) { unlinkedOnline += count; continue; }
    linkedSessions += count;
    const id = Number(row.customer_id);
    if (!groups.has(id)) groups.set(id, { customerId:id, customerName:row.customer_name, customerCode:row.customer_code,
      siteId:row.site_id, siteCode:row.site_code, limit:Number(row.pppoe_parallel_limit || 1), networkStatus:row.network_status, hasPrimary:false, sessions:0, secrets:[] });
    const group = groups.get(id);
    group.sessions += count;
    if (row.primary_customer_id) group.hasPrimary = true;
    group.secrets.push({ id:row.secret_id, username:row.username, router:row.router_name, sessions:count,
      primary:!!row.primary_customer_id, registered:!!row.parallel_customer_id, note:row.note || null });
  }
  const online = [...groups.values()].filter(g => g.sessions > 0);
  const parallels = online.filter(g => g.sessions > 1 || g.secrets.some(x => x.registered && x.sessions > 0));
  const needsReview = parallels.filter(g => g.sessions > g.limit || g.networkStatus === 'isolated' || !g.hasPrimary);
  return { activeSessions, linkedSessions, onlineCustomers:online.length, unlinkedOnline,
    official:parallels.filter(g => !needsReview.includes(g)).length, needsReview:needsReview.length,
    groups:parallels.sort((a,b) => Number(b.sessions > b.limit) - Number(a.sessions > a.limit) || b.sessions-a.sessions).slice(0,100) };
}
async function candidates(siteId = null) {
  const params = siteId ? [Number(siteId)] : [];
  const [rows] = await db.query(`SELECT p.id,p.site_id,s.code site_code,r.name router_name,p.username,p.active_sessions
    FROM ppp_secrets p JOIN sites s ON s.id=p.site_id JOIN routers r ON r.id=p.router_id
    LEFT JOIN nms_parallel_links pl ON pl.secret_id=p.id
    WHERE p.customer_id IS NULL AND pl.secret_id IS NULL AND p.is_exempt=0 AND p.removed_on_router_at IS NULL
      AND r.last_status='online' AND p.active_sessions>0 ${siteId ? 'AND p.site_id=?' : ''} ORDER BY p.active_sessions DESC,s.code,p.username LIMIT 200`, params);
  return rows;
}
async function register({ secretId, customerId, limit, note, userId }) {
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 2 || cap > 8) throw new Error('Batas sesi paralel harus 2–8.');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.execute(`SELECT id,site_id,username,customer_id,is_exempt,removed_on_router_at FROM ppp_secrets WHERE id=? FOR UPDATE`,[secretId]);
    const [[c]] = await conn.execute(`SELECT id,site_id,name,customer_status,archived_at FROM customers WHERE id=? FOR UPDATE`,[customerId]);
    if (!p || p.removed_on_router_at || p.customer_id || p.is_exempt) throw new Error('Secret tidak tersedia untuk registrasi paralel.');
    if (!c || c.archived_at || c.customer_status !== 'active' || Number(c.site_id) !== Number(p.site_id)) throw new Error('Pelanggan harus aktif dan berada pada site yang sama.');
    const [[primary]] = await conn.execute(`SELECT id FROM ppp_secrets WHERE customer_id=? AND removed_on_router_at IS NULL LIMIT 1`,[customerId]);
    if (!primary) throw new Error('Pelanggan harus mempunyai secret utama yang terhubung terlebih dahulu.');
    await conn.execute(`INSERT INTO nms_parallel_links(secret_id,customer_id,note,created_by) VALUES(?,?,?,?)`,[secretId,customerId,String(note||'').trim().slice(0,255)||null,userId||null]);
    await conn.execute(`UPDATE customers SET pppoe_parallel_limit=? WHERE id=?`,[cap,customerId]);
    await conn.commit(); cache.del('nms:dash');
    return { secretId,customerId,limit:cap };
  } catch (e) { await conn.rollback().catch(()=>{}); throw e; }
  finally { conn.release(); }
}
async function setLimit(customerId, limit) {
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap < 1 || cap > 8) throw new Error('Batas sesi harus 1–8.');
  const [r] = await db.execute(`UPDATE customers SET pppoe_parallel_limit=? WHERE id=? AND archived_at IS NULL AND customer_status='active'`,[cap,customerId]);
  if (!r.affectedRows) throw new Error('Pelanggan aktif tidak ditemukan.');
  cache.del('nms:dash'); return { customerId,limit:cap };
}
async function remove(secretId) {
  const [r] = await db.execute(`DELETE FROM nms_parallel_links WHERE secret_id=?`,[secretId]);
  if (!r.affectedRows) throw new Error('Registrasi paralel tidak ditemukan.');
  cache.del('nms:dash'); return { secretId };
}
module.exports = { summary,candidates,register,setLimit,remove };
