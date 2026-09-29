// Broadcast selektif & terjadwal. Antrean fisiknya tetap wa_messages (message_type='broadcast'),
// sehingga semua lapisan anti-ban (jam kerja, kuota/jam, jeda acak, long pause, blacklist, auto-pause)
// berlaku otomatis. Tabel wa_broadcasts hanya menyimpan metadata kampanye + status pause/cancel.
const db = require('../config/db');
const crypto = require('crypto');
const tpl = require('./waTemplateService');
const { enqueueWaMessage } = require('./whatsappGatewayService');

const MAX_RECIPIENTS = 1000;
const APPROVAL_THRESHOLD = 100;
const BILLING_VARS = /\{(?:nominal_tagihan|nomor_invoice|tanggal_jatuh_tempo|periode|nominal|jatuh_tempo|no_faktur)\}/i;
function invoiceScope(value) {
  if (value === undefined || value === null || value === '') return 'current';
  if (!['current', 'previous', 'two_months', 'custom', 'all_open'].includes(value)) throw new Error('Pilihan periode tagihan tidak valid.');
  return value;
}
function invoiceSelection(src = {}) {
  const invoice_scope = invoiceScope(src.invoice_scope);
  const invoice_from = String(src.invoice_from || '');
  const invoice_to = String(src.invoice_to || '');
  if (invoice_scope === 'custom') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(invoice_from) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(invoice_to)) throw new Error('Isi bulan awal dan akhir tagihan dengan benar.');
    const [a, b] = [invoice_from, invoice_to].map(s => Number(s.slice(0, 4)) * 12 + Number(s.slice(5)));
    if (b < a || b - a >= 12) throw new Error('Rentang tagihan harus berurutan dan maksimal 12 bulan.');
  }
  return { invoice_scope, invoice_from: invoice_scope === 'custom' ? invoice_from : '', invoice_to: invoice_scope === 'custom' ? invoice_to : '' };
}
function scopedInvoicePredicate(filter) {
  const { invoice_scope: scope, invoice_from, invoice_to } = invoiceSelection(filter);
  const base = `ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL`;
  if (scope === 'all_open') return base;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const previous = month === 1 ? [year - 1, 12] : [year, month - 1];
  const periods = scope === 'previous' ? [previous] : scope === 'two_months' ? [previous, [year, month]] : scope === 'custom'
    ? Array.from({ length: (Number(invoice_to.slice(0, 4)) * 12 + Number(invoice_to.slice(5))) - (Number(invoice_from.slice(0, 4)) * 12 + Number(invoice_from.slice(5))) + 1 }, (_, i) => {
      const index = Number(invoice_from.slice(0, 4)) * 12 + Number(invoice_from.slice(5)) - 1 + i;
      return [Math.floor(index / 12), index % 12 + 1];
    }) : [[year, month]];
  return `${base} AND (${periods.map(([y, m]) => `(ix.period_year=${y} AND ix.period_month=${m})`).join(' OR ')})`;
}
const BILLING_FILTERS = {
  all: 'Semua pelanggan aktif',
  active: 'Aktif (tanpa tunggakan)',
  due_h3: 'Jatuh tempo H-3',
  due_h1: 'Jatuh tempo H-1',
  due_today: 'Jatuh tempo hari ini',
  follow_up: 'Lewat tempo · masa toleransi',
  isolation_ready: 'Memenuhi syarat isolir',
  overdue: 'Menunggak (lewat jatuh tempo)',
  isolated: 'Terisolir',
};

const OPEN_INV = `SELECT 1 FROM invoices ix WHERE ix.customer_id=c.id AND ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL`;
const GRACE_INV = `SELECT 1 FROM invoices ix JOIN sites sx ON sx.id=c.site_id CROSS JOIN settings st
  WHERE ix.customer_id=c.id AND ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL
  AND ix.due_date<CURDATE() AND CURDATE()<=DATE_ADD(ix.due_date, INTERVAL COALESCE(c.grace_days,sx.default_grace_days,st.default_grace_days,2) DAY)`;
const READY_INV = `SELECT 1 FROM invoices ix JOIN sites sx ON sx.id=c.site_id CROSS JOIN settings st
  WHERE ix.customer_id=c.id AND ix.status IN ('unpaid','partial','overdue') AND ix.outstanding>0 AND ix.archived_at IS NULL
  AND CURDATE()>DATE_ADD(ix.due_date, INTERVAL COALESCE(c.grace_days,sx.default_grace_days,st.default_grace_days,2) DAY)`;

function buildWhere(filter = {}) {
  const where = [`c.archived_at IS NULL`, `c.customer_status='active'`];
  const params = [];
  switch (filter.billing) {
    case 'active': where.push(`NOT EXISTS (${OPEN_INV} AND ix.due_date<CURDATE())`, `c.network_status<>'isolated'`); break;
    case 'due_h3': where.push(`EXISTS (${OPEN_INV} AND ix.due_date=DATE_ADD(CURDATE(),INTERVAL 3 DAY))`); break;
    case 'due_h1': where.push(`EXISTS (${OPEN_INV} AND ix.due_date=DATE_ADD(CURDATE(),INTERVAL 1 DAY))`); break;
    case 'due_today': where.push(`c.network_status<>'isolated'`, `EXISTS (${OPEN_INV} AND ix.due_date=CURDATE())`); break;
    case 'follow_up': where.push(`c.network_status<>'isolated'`, `EXISTS (${GRACE_INV})`); break;
    case 'isolation_ready': where.push(`c.network_status<>'isolated'`, `c.router_id IS NOT NULL`, `c.pppoe_username IS NOT NULL`,
      `(c.isolate_hold_until IS NULL OR c.isolate_hold_until<CURDATE())`, `EXISTS (${READY_INV})`); break;
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
  const ids = [].concat(filter.customer_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_RECIPIENTS);
  if (ids.length) { where.push(`c.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  return { sql: where.join(' AND '), params };
}

async function listCandidates(filter = {}, { limit = 500 } = {}) {
  const { sql, params } = buildWhere(filter);
  const scoped = scopedInvoicePredicate(filter);
  const [rows] = await db.query(`SELECT c.id,c.customer_code,c.name,c.phone,c.whatsapp_status,c.whatsapp_normalized,c.address,c.network_status,c.vlan,
      p.name package_name,p.speed_label,p.price package_price,cl.name cluster_name,r.name router_name,s.code site_code,
      (SELECT MIN(ix.due_date) FROM invoices ix WHERE ix.customer_id=c.id AND ${scoped}) next_due,
      (SELECT MIN(DATE_ADD(ix.due_date, INTERVAL COALESCE(c.grace_days,s.default_grace_days,(SELECT default_grace_days FROM settings WHERE id=1),2) DAY))
        FROM invoices ix WHERE ix.customer_id=c.id AND ${scoped}) grace_until,
      c.isolate_hold_until,
      (SELECT COALESCE(SUM(ix.outstanding),0) FROM invoices ix WHERE ix.customer_id=c.id AND ${scoped}) outstanding,
      (SELECT COUNT(*) FROM invoices ix WHERE ix.customer_id=c.id AND ${scoped}) open_invoice_count,
      (SELECT GROUP_CONCAT(ix.invoice_number ORDER BY ix.period_year,ix.period_month,ix.id SEPARATOR ', ') FROM invoices ix
        WHERE ix.customer_id=c.id AND ${scoped}) open_invoice_numbers,
      (SELECT GROUP_CONCAT(CONCAT(ix.period_year,'-',LPAD(ix.period_month,2,'0')) ORDER BY ix.period_year,ix.period_month SEPARATOR ', ') FROM invoices ix
        WHERE ix.customer_id=c.id AND ${scoped}) invoice_periods,
      (SELECT MIN(ix.id) FROM invoices ix WHERE ix.customer_id=c.id AND ${scoped}) scoped_invoice_id,
      EXISTS(SELECT 1 FROM wa_blacklist b WHERE b.phone=c.whatsapp_normalized) blacklisted
    FROM customers c LEFT JOIN packages p ON p.id=c.package_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
      LEFT JOIN routers r ON r.id=c.router_id LEFT JOIN sites s ON s.id=c.site_id
    WHERE ${sql} ORDER BY c.name ASC LIMIT ${Math.min(MAX_RECIPIENTS, Math.max(1, Number(limit) || 500))}`, params);
  const [[count]] = await db.query(`SELECT COUNT(*) total,
    SUM(CASE WHEN c.phone IS NOT NULL AND c.phone<>'' AND COALESCE(c.whatsapp_status,'')<>'invalid'
      AND NOT EXISTS(SELECT 1 FROM wa_blacklist b WHERE b.phone=c.whatsapp_normalized)
      ${filter.require_invoice ? `AND EXISTS(SELECT 1 FROM invoices ix WHERE ix.customer_id=c.id AND ${scoped})` : ''} THEN 1 ELSE 0 END) eligible
    FROM customers c WHERE ${sql}`, params);
  return { rows, total: Number(count.total || 0), eligible: Number(count.eligible || 0) };
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

function broadcastVars(row, candidate, bank, extra = {}) {
  if (!candidate) return tpl.buildVars(row || {}, bank, extra);
  const period = [...new Set(String(candidate.invoice_periods || '').split(', ').filter(Boolean))].map(value => {
    const [year, month] = value.split('-').map(Number);
    return `${new Intl.DateTimeFormat('id-ID', { month: 'long', timeZone: 'Asia/Jakarta' }).format(new Date(Date.UTC(year, month - 1, 1)))} ${year}`;
  }).join(' dan ');
  return { ...tpl.buildVars({ ...(row || {}), amount: candidate.outstanding,
    invoice_number: candidate.open_invoice_numbers || '-', due_date: candidate.next_due || null,
    period_month: null, period_year: null }, bank, extra), periode: period || '-' };
}

async function followUpSummary() {
  const keys = ['due_today', 'follow_up', 'isolation_ready', 'isolated'];
  const counts = await Promise.all(keys.map(async key => {
    const { sql, params } = buildWhere({ billing: key });
    const [[row]] = await db.query(`SELECT COUNT(*) total FROM customers c WHERE ${sql}`, params);
    return [key, Number(row?.total || 0)];
  }));
  const [[settings]] = await db.query('SELECT auto_isolate FROM settings WHERE id=1');
  return { counts: Object.fromEntries(counts), autoIsolate: !!Number(settings?.auto_isolate) };
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

async function createBroadcast({ name, templateKey = null, message, extra = {}, filter = {}, mode = 'direct', scheduledAt = null, userId = null, media = null, mediaFile = null, requestKey = null }) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Naskah pesan wajib diisi.');
  if (text.length > 4000) throw new Error('Naskah pesan maksimal 4000 karakter.');
  if ([].concat(filter.customer_ids || []).length > MAX_RECIPIENTS) throw new Error(`Maksimal ${MAX_RECIPIENTS} pelanggan per broadcast.`);
  const when = mode === 'scheduled' ? parseSchedule(scheduledAt) : null;
  if (mode === 'scheduled' && !when) throw new Error('Tanggal & jam jadwal wajib diisi.');
  const needsInvoice = BILLING_VARS.test(text);
  const { rows } = await listCandidates({ ...filter, require_invoice: needsInvoice }, { limit: MAX_RECIPIENTS });
  if ([].concat(filter.customer_ids || []).length) {
    const requested = new Set([].concat(filter.customer_ids).map(Number));
    if (rows.length !== requested.size) throw new Error('Sebagian pelanggan pilihan tidak aktif atau tidak ditemukan. Perbarui daftar penerima sebelum mengirim.');
  }
  if (!rows.length) throw new Error('Tidak ada penerima yang cocok dengan filter/pilihan.');
  const eligibleCount = rows.filter(c => c.whatsapp_status !== 'invalid' && c.phone && !Number(c.blacklisted) && (!needsInvoice || Number(c.open_invoice_count) > 0)).length;
  if (!eligibleCount) throw new Error('Tidak ada penerima dengan invoice terbuka pada periode pilihan dan nomor WhatsApp yang layak.');
  if (mediaFile) media = await require('./waInboxService').saveMediaBuffer(mediaFile.buffer, mediaFile.mimetype, mediaFile.originalname);
  const cleanExtra = {
    detail_gangguan: String(extra.detail_gangguan || '').slice(0, 500) || undefined,
    estimasi_selesai: String(extra.estimasi_selesai || '').slice(0, 120) || undefined,
    jadwal_pemeliharaan: String(extra.jadwal_pemeliharaan || '').slice(0, 180) || undefined,
    isi_pengumuman: String(extra.isi_pengumuman || '').slice(0, 1200) || undefined,
  };
  const needsApproval = eligibleCount > APPROVAL_THRESHOLD;
  const key = /^[a-f0-9-]{36}$/i.test(String(requestKey || '')) ? `${userId}:${requestKey}` : `${userId}:${crypto.randomUUID()}`;
  let r;
  try {
    [r] = await db.execute(`INSERT INTO wa_broadcasts(request_key,name,template_key,message_template,extra_vars_json,filter_json,mode,scheduled_at,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [key, String(name || 'Broadcast').slice(0, 160), templateKey, text, JSON.stringify(cleanExtra), JSON.stringify({ ...filter, customer_ids: undefined, selected: [].concat(filter.customer_ids || []).length }), mode, when, needsApproval ? 'pending_approval' : (when ? 'scheduled' : 'running'), userId]);
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const [[existing]] = await db.execute(`SELECT id,total_recipients,skipped_blacklist,skipped_invalid,scheduled_at,status FROM wa_broadcasts WHERE request_key=?`, [key]);
    if (!existing?.total_recipients) throw new Error('Permintaan ini masih disiapkan atau terhenti. Periksa riwayat broadcast sebelum mengirim ulang.');
    return { id: existing.id, queued: existing.total_recipients, skippedBlacklist: existing.skipped_blacklist, skippedInvalid: existing.skipped_invalid, skippedNoInvoice: 0, scheduledAt: existing.scheduled_at, pendingApproval: existing.status === 'pending_approval', duplicate: true };
  }
  const broadcastId = r.insertId;
  const batchDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  const approvalBatch = needsApproval ? `broadcast_${broadcastId}:${batchDate}` : null;
  const bank = await tpl.getDefaultBank();
  let queued = 0, skippedBlacklist = 0, skippedInvalid = 0, skippedNoInvoice = 0;
  for (const c of rows) {
    if (c.whatsapp_status === 'invalid' || !c.phone) { skippedInvalid++; continue; }
    if (Number(c.blacklisted)) { skippedBlacklist++; continue; }
    if (needsInvoice && !Number(c.open_invoice_count)) { skippedNoInvoice++; continue; }
    const row = await tpl.loadCustomerRow(c.id);
    const body = tpl.renderTemplate(text, broadcastVars(row || c, c, bank, cleanExtra));
    const res = await enqueueWaMessage({ phone: c.phone, message: body, customerId: c.id, invoiceId: Number(c.open_invoice_count) === 1 ? c.scoped_invoice_id : null, type: 'broadcast', userId, broadcastId, scheduledAt: when, approvalBatch, media });
    if (res.status === 'queued' || res.status === 'pending_approval') queued++; else if (res.status === 'cancelled') skippedBlacklist++; else skippedInvalid++;
  }
  await db.execute(`UPDATE wa_broadcasts SET total_recipients=?,skipped_blacklist=?,skipped_invalid=? WHERE id=?`, [queued, skippedBlacklist, skippedInvalid, broadcastId]);
  console.log(`WA broadcast #${broadcastId} "${name}": ${queued} antre, ${skippedBlacklist} blacklist, ${skippedInvalid} nomor tidak valid${when ? `, jadwal ${when.toISOString()}` : ''}`);
  return { id: broadcastId, queued, skippedBlacklist, skippedInvalid, skippedNoInvoice, scheduledAt: when, pendingApproval: needsApproval };
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
  } else if (action === 'retry') {
    if (b.status === 'cancelled') throw new Error('Broadcast yang dibatalkan tidak dapat dikirim ulang.');
    const [r] = await db.execute(`UPDATE wa_messages SET status='queued',attempts=0,next_attempt_at=NULL,error_message=NULL WHERE broadcast_id=? AND status='failed'`, [id]);
    if (!r.affectedRows) throw new Error('Tidak ada pesan gagal untuk dikirim ulang.');
    await db.execute(`UPDATE wa_broadcasts SET status='running' WHERE id=?`, [id]);
    require('./whatsappGatewayService').processQueue();
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

module.exports = { BILLING_FILTERS, MAX_RECIPIENTS, APPROVAL_THRESHOLD, BILLING_VARS, invoiceScope, invoiceSelection, buildWhere, listCandidates, filterOptions, followUpSummary, broadcastVars, createBroadcast, setBroadcastStatus, refreshBroadcastStatuses, listBroadcasts, parseSchedule };
