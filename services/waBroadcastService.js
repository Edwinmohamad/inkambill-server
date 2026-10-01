// Broadcast selektif & terjadwal. Antrean fisiknya tetap wa_messages (message_type='broadcast'),
// sehingga semua lapisan anti-ban (jam kerja, kuota/jam, jeda acak, long pause, blacklist, auto-pause)
// berlaku otomatis. Tabel wa_broadcasts hanya menyimpan metadata kampanye + status pause/cancel.
const db = require('../config/db');
const tpl = require('./waTemplateService');
const { enqueueWaMessage } = require('./whatsappGatewayService');

const MAX_RECIPIENTS = 1000;
const BILLING_FILTERS = {
  all: 'Semua pelanggan aktif',
  active: 'Aktif (tanpa tunggakan)',
  due_h3: 'Jatuh tempo H-3',
  due_h1: 'Jatuh tempo H-1',
  overdue: 'Menunggak (lewat jatuh tempo)',
  isolated: 'Terisolir',
};

const OPEN_INV = `SELECT 1 FROM invoices ix WHERE ix.customer_id=c.id AND ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL`;

function buildWhere(filter = {}) {
  const where = [`c.archived_at IS NULL`, `c.customer_status='active'`];
  const params = [];
  switch (filter.billing) {
    case 'active': where.push(`NOT EXISTS (${OPEN_INV} AND ix.due_date<CURDATE())`, `c.network_status<>'isolated'`); break;
    case 'due_h3': where.push(`EXISTS (${OPEN_INV} AND ix.due_date=DATE_ADD(CURDATE(),INTERVAL 3 DAY))`); break;
    case 'due_h1': where.push(`EXISTS (${OPEN_INV} AND ix.due_date=DATE_ADD(CURDATE(),INTERVAL 1 DAY))`); break;
    case 'overdue': where.push(`EXISTS (${OPEN_INV} AND ix.due_date<CURDATE())`); break;
    case 'isolated': where.push(`c.network_status='isolated'`); break;
    default: break;
  }
  for (const [key, col] of [['site_id', 'c.site_id'], ['cluster_id', 'c.cluster_id'], ['router_id', 'c.router_id'], ['olt_id', 'c.olt_id'], ['package_id', 'c.package_id']]) {
    const v = Number(filter[key]); if (Number.isInteger(v) && v > 0) { where.push(`${col}=?`); params.push(v); }
  }
  if (filter.vlan) { where.push(`c.vlan=?`); params.push(String(filter.vlan).trim().slice(0, 20)); }
  if (filter.q) {
    const like = `%${String(filter.q).trim().slice(0, 80)}%`;
    where.push(`(c.name LIKE ? OR c.customer_code LIKE ? OR c.phone LIKE ? OR c.whatsapp_normalized LIKE ? OR c.address LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  const ids = [].concat(filter.customer_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length) { where.push(`c.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids.slice(0, MAX_RECIPIENTS)); }
  return { sql: where.join(' AND '), params };
}

async function listCandidates(filter = {}, { limit = 500 } = {}) {
  const { sql, params } = buildWhere(filter);
  const [rows] = await db.query(`SELECT c.id,c.customer_code,c.name,c.phone,c.whatsapp_status,c.whatsapp_normalized,c.address,c.network_status,c.vlan,
      p.name package_name,p.speed_label,cl.name cluster_name,r.name router_name,s.code site_code,
      (SELECT MIN(ix.due_date) FROM invoices ix WHERE ix.customer_id=c.id AND ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL) next_due,
      (SELECT COALESCE(SUM(ix.outstanding),0) FROM invoices ix WHERE ix.customer_id=c.id AND ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL) outstanding,
      EXISTS(SELECT 1 FROM wa_blacklist b WHERE b.phone=c.whatsapp_normalized) blacklisted
    FROM customers c LEFT JOIN packages p ON p.id=c.package_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
      LEFT JOIN routers r ON r.id=c.router_id LEFT JOIN sites s ON s.id=c.site_id
    WHERE ${sql} ORDER BY c.name ASC LIMIT ${Math.min(MAX_RECIPIENTS, Math.max(1, Number(limit) || 500))}`, params);
  const [[count]] = await db.query(`SELECT COUNT(*) total FROM customers c WHERE ${sql}`, params);
  return { rows, total: Number(count.total || 0) };
}

async function filterOptions() {
  const q = async sql => { try { const [r] = await db.query(sql); return r; } catch (_) { return []; } };
  return {
    sites: await q(`SELECT id,code,name FROM sites ORDER BY code`),
    clusters: await q(`SELECT id,name FROM clusters ORDER BY name`),
    routers: await q(`SELECT id,name FROM routers ORDER BY name`),
    olts: await q(`SELECT id,name FROM olt_devices ORDER BY name`),
    packages: await q(`SELECT id,name,speed_label FROM packages WHERE archived_at IS NULL ORDER BY name`),
    vlans: (await q(`SELECT DISTINCT vlan FROM customers WHERE vlan IS NOT NULL AND vlan<>'' ORDER BY vlan`)).map(r => r.vlan),
  };
}

// scheduledAt: string "YYYY-MM-DDTHH:mm" (waktu WIB dari input datetime-local) atau Date.
function parseSchedule(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) throw new Error('Format jadwal tidak valid.');
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+07:00`);
  if (Number.isNaN(d.getTime())) throw new Error('Jadwal tidak valid.');
  if (d.getTime() < Date.now() - 60000) throw new Error('Jadwal broadcast tidak boleh di masa lalu.');
  return d;
}

async function createBroadcast({ name, templateKey = null, message, extra = {}, filter = {}, mode = 'direct', scheduledAt = null, userId = null }) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Naskah pesan wajib diisi.');
  if (text.length > 4000) throw new Error('Naskah pesan maksimal 4000 karakter.');
  const when = mode === 'scheduled' ? parseSchedule(scheduledAt) : null;
  if (mode === 'scheduled' && !when) throw new Error('Tanggal & jam jadwal wajib diisi.');
  const { rows } = await listCandidates(filter, { limit: MAX_RECIPIENTS });
  if (!rows.length) throw new Error('Tidak ada penerima yang cocok dengan filter/pilihan.');
  const cleanExtra = { detail_gangguan: String(extra.detail_gangguan || '').slice(0, 500) || undefined, estimasi_selesai: String(extra.estimasi_selesai || '').slice(0, 120) || undefined };
  const [r] = await db.execute(`INSERT INTO wa_broadcasts(name,template_key,message_template,extra_vars_json,filter_json,mode,scheduled_at,status,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,
    [String(name || 'Broadcast').slice(0, 160), templateKey, text, JSON.stringify(cleanExtra), JSON.stringify({ ...filter, customer_ids: undefined, selected: [].concat(filter.customer_ids || []).length }), mode, when, when ? 'scheduled' : 'running', userId]);
  const broadcastId = r.insertId;
  const bank = await tpl.getDefaultBank();
  let queued = 0, skippedBlacklist = 0, skippedInvalid = 0;
  for (const c of rows) {
    if (c.whatsapp_status === 'invalid' || !c.phone) { skippedInvalid++; continue; }
    if (Number(c.blacklisted)) { skippedBlacklist++; continue; }
    const row = await tpl.loadCustomerRow(c.id);
    const body = tpl.renderTemplate(text, tpl.buildVars(row || c, bank, cleanExtra));
    const res = await enqueueWaMessage({ phone: c.phone, message: body, customerId: c.id, invoiceId: row?.invoice_id || null, type: 'broadcast', userId, broadcastId, scheduledAt: when });
    if (res.status === 'queued') queued++; else if (res.status === 'cancelled') skippedBlacklist++; else skippedInvalid++;
  }
  await db.execute(`UPDATE wa_broadcasts SET total_recipients=?,skipped_blacklist=?,skipped_invalid=? WHERE id=?`, [queued, skippedBlacklist, skippedInvalid, broadcastId]);
  console.log(`WA broadcast #${broadcastId} "${name}": ${queued} antre, ${skippedBlacklist} blacklist, ${skippedInvalid} nomor tidak valid${when ? `, jadwal ${when.toISOString()}` : ''}`);
  return { id: broadcastId, queued, skippedBlacklist, skippedInvalid, scheduledAt: when };
}

async function setBroadcastStatus(id, action, userId = null) {
  const [[b]] = await db.execute(`SELECT * FROM wa_broadcasts WHERE id=?`, [id]);
  if (!b) throw new Error('Broadcast tidak ditemukan.');
  if (action === 'pause') {
    if (!['running', 'scheduled'].includes(b.status)) throw new Error('Hanya broadcast berjalan/terjadwal yang bisa dijeda.');
    await db.execute(`UPDATE wa_broadcasts SET status='paused' WHERE id=?`, [id]);
  } else if (action === 'resume') {
    if (b.status !== 'paused') throw new Error('Broadcast tidak sedang dijeda.');
    await db.execute(`UPDATE wa_broadcasts SET status=IF(scheduled_at IS NOT NULL AND scheduled_at>NOW(),'scheduled','running') WHERE id=?`, [id]);
    require('./whatsappGatewayService').processQueue();
  } else if (action === 'cancel') {
    if (['completed', 'cancelled'].includes(b.status)) throw new Error('Broadcast sudah selesai/dibatalkan.');
    await db.execute(`UPDATE wa_broadcasts SET status='cancelled' WHERE id=?`, [id]);
    await db.execute(`UPDATE wa_messages SET status='cancelled',error_message='Broadcast dibatalkan Admin.' WHERE broadcast_id=? AND status IN ('queued','pending_approval')`, [id]);
  } else throw new Error('Aksi tidak dikenal.');
  return { ok: true };
}

// Dipanggil tiap menit: scheduled → running saat waktunya tiba; running → completed saat antrean habis.
async function refreshBroadcastStatuses() {
  await db.query(`UPDATE wa_broadcasts SET status='running' WHERE status='scheduled' AND scheduled_at<=NOW()`);
  await db.query(`UPDATE wa_broadcasts b SET status='completed' WHERE status='running'
    AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.broadcast_id=b.id AND m.status IN ('queued','processing'))`);
}

async function listBroadcasts(limit = 30) {
  const [rows] = await db.query(`SELECT b.*,u.name created_by_name,
      (SELECT COUNT(*) FROM wa_messages m WHERE m.broadcast_id=b.id AND m.status='sent') sent,
      (SELECT COUNT(*) FROM wa_messages m WHERE m.broadcast_id=b.id AND m.status IN ('queued','processing')) pending,
      (SELECT COUNT(*) FROM wa_messages m WHERE m.broadcast_id=b.id AND m.status='failed') failed,
      (SELECT COUNT(*) FROM wa_messages m WHERE m.broadcast_id=b.id AND m.status='cancelled') cancelled
    FROM wa_broadcasts b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.id DESC LIMIT ${Math.min(100, Math.max(1, Number(limit) || 30))}`);
  return rows;
}

module.exports = { BILLING_FILTERS, MAX_RECIPIENTS, buildWhere, listCandidates, filterOptions, createBroadcast, setBroadcastStatus, refreshBroadcastStatuses, listBroadcasts, parseSchedule };
