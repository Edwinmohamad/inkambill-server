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

async function unisolateCustomer(customerId, onlyBilling=false) {
  const c=await getCustomerNetwork(customerId);
  if (onlyBilling && c.isolation_reason !== 'billing') return {skipped:true,reason:'not_billing_isolation'};
  await mt.unisolatePppoe(c,c.pppoe_username);
  await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'offline',NOW(),status_changed_at),network_status='offline',isolation_reason=NULL WHERE id=?`,[customerId]);
  return {skipped:false};
}

async function runAutoIsolation() {
  const [[settings]]=await db.query(`SELECT auto_isolate FROM settings WHERE id=1`);
  if (!settings?.auto_isolate) return {enabled:false,isolated:0,failed:0};
  await db.query(`UPDATE invoices SET status='overdue' WHERE status IN ('unpaid','partial') AND due_date<CURDATE()`);
  const [rows]=await db.query(`
    SELECT DISTINCT c.id,c.customer_code
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
    try { await isolateCustomer(row.id,'billing'); isolated++; }
    catch(e){ failed++; await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_isolate','failed',?)`,[`${row.customer_code}: ${e.message}`.slice(0,1000)]); }
  }
  await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_isolate','success',?)`,[`isolated=${isolated}, failed=${failed}`]);
  return {enabled:true,isolated,failed};
}

module.exports={checkCustomer,isolateCustomer,unisolateCustomer,runAutoIsolation};
