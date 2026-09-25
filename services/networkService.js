const db = require('../config/db');
const mt = require('./mikrotikRest');

async function getCustomerNetwork(customerId) {
  const [rows] = await db.execute(`
    SELECT c.id,c.customer_code,c.name,c.pppoe_username,c.network_status,c.isolation_reason,
           r.* FROM customers c LEFT JOIN routers r ON r.id=c.router_id WHERE c.id=?
  `,[customerId]);
  if (!rows.length) throw new Error('Pelanggan tidak ditemukan');
  const c=rows[0];
  if (!c.router_id || !c.base_url) throw new Error('Router pelanggan belum dipilih');
  if (!c.pppoe_username) throw new Error('PPPoE username pelanggan belum diisi');
  return c;
}

async function checkCustomer(customerId) {
  const c=await getCustomerNetwork(customerId);
  try {
    const secret=await mt.findSecret(c,c.pppoe_username);
    const active=await mt.findActive(c,c.pppoe_username);
    const status=active ? 'online' : (secret?.disabled==='true' ? 'isolated' : 'offline');
    await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>?,NOW(),status_changed_at),network_status=? WHERE id=?`,[status,status,customerId]);
    return {customer:c,secret,active,status};
  } catch(e) {
    await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'router_unreachable',NOW(),status_changed_at),network_status='router_unreachable' WHERE id=?`,[customerId]);
    throw e;
  }
}

async function isolateCustomer(customerId, reason='manual') {
  const c=await getCustomerNetwork(customerId);
  await mt.isolatePppoe(c,c.pppoe_username);
  await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'isolated',NOW(),status_changed_at),network_status='isolated',isolation_reason=? WHERE id=?`,[reason,customerId]);
  return true;
}

const ISOLIR_LIST = String(process.env.MIKROTIK_ISOLIR_LIST || 'ISOLIR').trim() || 'ISOLIR';

// v1.30 — selain enable PPP secret, hapus juga IP pelanggan dari address-list ISOLIR (bila router
// memakai isolir berbasis firewall). Best-effort: kegagalan di sini tidak membatalkan buka isolir.
async function clearIsolirAddressList(c, customerId) {
  const ips = new Set();
  try { const a = await mt.findActive(c, c.pppoe_username); if (a?.address) ips.add(a.address); } catch (_) {}
  try { const ra = await mt.secretRemoteAddress(c, c.pppoe_username); if (ra && /^\d+\.\d+\.\d+\.\d+$/.test(ra)) ips.add(ra); } catch (_) {}
  try { const [s] = await db.execute(`SELECT address FROM nms_pppoe_sessions WHERE customer_id=? AND address IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`, [customerId]); if (s[0]?.address) ips.add(s[0].address); } catch (_) {}
  let removed = 0; const errors = [];
  for (const ip of ips) {
    try { removed += (await mt.removeFromAddressList(c, ip, ISOLIR_LIST)).removed; }
    catch (e) { errors.push(`${ip}: ${e.message}`); }
  }
  if (errors.length) console.error(`Buka isolir ${c.customer_code}: gagal bersihkan address-list ${ISOLIR_LIST}:`, errors.join('; '));
  return { ips: [...ips], removed, errors };
}

async function unisolateCustomer(customerId, onlyBilling=false) {
  const c=await getCustomerNetwork(customerId);
  if (onlyBilling && c.isolation_reason !== 'billing') return {skipped:true,reason:'not_billing_isolation'};
  await mt.unisolatePppoe(c,c.pppoe_username);
  const addressList = await clearIsolirAddressList(c, customerId);
  await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'offline',NOW(),status_changed_at),network_status='offline',isolation_reason=NULL WHERE id=?`,[customerId]);
  return {skipped:false, addressList};
}

async function runAutoIsolation() {
  const [[settings]]=await db.query(`SELECT auto_isolate FROM settings WHERE id=1`);
  if (!settings?.auto_isolate) return {enabled:false,isolated:0,failed:0};
  await db.query(`UPDATE invoices SET status='overdue' WHERE status IN ('unpaid','partial') AND due_date<CURDATE()`);
  const [rows]=await db.query(`
    SELECT DISTINCT c.id,c.customer_code,c.router_id
    FROM invoices i JOIN customers c ON c.id=i.customer_id
    JOIN sites s ON s.id=c.site_id
    CROSS JOIN settings st
    WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
      AND c.customer_status='active' AND c.router_id IS NOT NULL AND c.pppoe_username IS NOT NULL
      AND CURDATE() > DATE_ADD(i.due_date, INTERVAL COALESCE(c.grace_days,s.default_grace_days,st.default_grace_days,2) DAY)
      AND (c.network_status <> 'isolated' OR c.isolation_reason IS NULL)
  `);
  let isolated=0,failed=0;
  for(const row of rows){
    try { await isolateCustomer(row.id,'billing'); isolated++; queueIsolationNotice(row.id).catch(()=>{}); await db.execute(`INSERT IGNORE INTO nms_auto_isolate_logs(customer_id,router_id,action,idempotency_key,reason) VALUES(?,?,?,?,?)`,[row.id,row.router_id,'isolate',`billing:${row.id}:${new Date().toISOString().slice(0,10)}`,'invoice overdue + grace period']); }
    catch(e){ failed++; await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_isolate','failed',?)`,[`${row.customer_code}: ${e.message}`.slice(0,1000)]); }
  }
  await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_isolate','success',?)`,[`isolated=${isolated}, failed=${failed}`]);
  return {enabled:true,isolated,failed};
}

// Template "Pemberitahuan Isolir" → draf batch 'isolation_notice' yang wajib dikonfirmasi Admin
// (kebijakan: semua pesan otomatis ke pelanggan lewat persetujuan), lalu dikirim via antrean anti-ban.
async function queueIsolationNotice(customerId) {
  try {
    const [[st]] = await db.query(`SELECT wa_isolation_notice_enabled FROM settings WHERE id=1`);
    if (st && !Number(st.wa_isolation_notice_enabled)) return { queued: false, reason: 'disabled' };
    const tpl = require('./waTemplateService');
    const { enqueueWaMessage, approvalBatchKey } = require('./whatsappGatewayService');
    const { text, row } = await tpl.renderForCustomer('isolation', customerId, { isKey: true });
    if (!row.phone || row.whatsapp_status === 'invalid') return { queued: false, reason: 'no_wa' };
    const [[already]] = await db.execute(`SELECT id FROM wa_messages WHERE customer_id=? AND message_type='isolation_notice' AND DATE(created_at)=CURDATE() LIMIT 1`, [customerId]);
    if (already) return { queued: false, reason: 'already_today' };
    await enqueueWaMessage({ phone: row.phone, message: text, customerId, invoiceId: row.invoice_id || null, type: 'isolation_notice', approvalBatch: approvalBatchKey('isolation_notice') });
    return { queued: true };
  } catch (e) { console.error('Pemberitahuan isolir WA gagal diantrikan:', e.message); return { queued: false, error: e.message }; }
}

module.exports={checkCustomer,isolateCustomer,unisolateCustomer,runAutoIsolation,clearIsolirAddressList,queueIsolationNotice,ISOLIR_LIST};
