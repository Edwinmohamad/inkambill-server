const db = require('../config/db');

function asNumber(v) { return v == null ? 0 : Number(v); }
function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function classifyCustomer(row) {
  const daysLate = asNumber(row.days_late);
  const graceDays = Math.max(0, asNumber(row.grace_days));
  const pendingCount = asNumber(row.pending_payment_count);
  if (pendingCount > 0) return { key: 'pending', label: 'Menunggu Approval', priority: 2 };
  if (String(row.network_status || '').toLowerCase() === 'isolated') return { key: 'isolated', label: 'Sudah Isolir', priority: 3 };
  if (String(row.customer_status || '').toLowerCase() === 'active' && daysLate > graceDays) return { key: 'must_isolate', label: 'Wajib Isolir', priority: 5 };
  if (daysLate > 0) return { key: 'follow_up', label: 'Follow Up', priority: 4 };
  if (daysLate === 0) return { key: 'due_today', label: 'Jatuh Tempo Hari Ini', priority: 3 };
  return { key: 'not_due', label: 'Belum Jatuh Tempo', priority: 1 };
}

async function getBillingControlData(options = {}) {
  const now = new Date();
  const month = clampInt(options.month, now.getMonth() + 1, 1, 12);
  const year = clampInt(options.year, now.getFullYear(), 2020, 2100);
  const siteId = Number(options.siteId) || null;
  const siteWhere = siteId ? ' AND c.site_id=?' : '';
  const siteParams = siteId ? [siteId] : [];

  const [[summary]] = await db.execute(`SELECT
      COUNT(DISTINCT i.customer_id) billed_customers,
      COALESCE(SUM(i.total),0) billed_amount,
      COALESCE(SUM(i.paid_amount),0) collected_amount,
      COALESCE(SUM(CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 THEN i.outstanding ELSE 0 END),0) outstanding_amount,
      COUNT(DISTINCT CASE WHEN i.status='paid' OR i.outstanding<=0 THEN i.customer_id END) paid_customers,
      COUNT(DISTINCT CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 THEN i.customer_id END) open_customers
    FROM invoices i
    JOIN customers c ON c.id=i.customer_id
    WHERE c.archived_at IS NULL AND i.period_month=? AND i.period_year=?
      AND i.status NOT IN ('cancelled','refunded')${siteWhere}`,
    [month, year, ...siteParams]);

  const [[confirmedPayments]] = await db.execute(`SELECT COUNT(*) payment_count,COALESCE(SUM(p.amount),0) amount
    FROM payments p
    JOIN invoices i ON i.id=p.invoice_id
    JOIN customers c ON c.id=i.customer_id
    WHERE p.status='confirmed' AND i.period_month=? AND i.period_year=?${siteWhere}`,
    [month, year, ...siteParams]);

  const [rowsRaw] = await db.execute(`SELECT
      c.id customer_id,c.customer_code,c.name,c.phone,c.whatsapp_normalized,c.pppoe_username,
      c.customer_status,c.network_status,c.isolation_reason,
      s.id site_id,s.code site_code,s.name site_name,
      MIN(i.due_date) due_date,DAY(MIN(i.due_date)) due_day,
      COALESCE(c.grace_days,s.default_grace_days,st.default_grace_days,2) grace_days,
      DATEDIFF(CURDATE(),MIN(i.due_date)) days_late,
      COUNT(DISTINCT i.id) invoice_count,
      COALESCE(SUM(i.outstanding),0) outstanding,
      COALESCE(SUM(pp.pending_count),0) pending_payment_count,
      COALESCE(SUM(pp.pending_amount),0) pending_payment_amount
    FROM invoices i
    JOIN customers c ON c.id=i.customer_id
    JOIN sites s ON s.id=c.site_id
    LEFT JOIN settings st ON st.id=1
    LEFT JOIN (
      SELECT invoice_id,COUNT(*) pending_count,COALESCE(SUM(amount),0) pending_amount
      FROM payments WHERE status='pending' GROUP BY invoice_id
    ) pp ON pp.invoice_id=i.id
    WHERE c.archived_at IS NULL AND i.period_month=? AND i.period_year=?
      AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0${siteWhere}
    GROUP BY c.id,c.customer_code,c.name,c.phone,c.whatsapp_normalized,c.pppoe_username,
      c.customer_status,c.network_status,c.isolation_reason,s.id,s.code,s.name,
      COALESCE(c.grace_days,s.default_grace_days,st.default_grace_days,2)
    ORDER BY MIN(i.due_date) ASC,COALESCE(SUM(i.outstanding),0) DESC`,
    [month, year, ...siteParams]);

  const customers = rowsRaw.map(row => {
    const state = classifyCustomer(row);
    return {
      ...row,
      outstanding: asNumber(row.outstanding),
      pending_payment_amount: asNumber(row.pending_payment_amount),
      pending_payment_count: asNumber(row.pending_payment_count),
      days_late: asNumber(row.days_late),
      grace_days: asNumber(row.grace_days),
      action_status: state.key,
      action_label: state.label,
      action_priority: state.priority,
    };
  }).sort((a,b) => b.action_priority-a.action_priority || b.days_late-a.days_late || b.outstanding-a.outstanding);

  const actionCounts = customers.reduce((acc,row) => {
    acc[row.action_status] = (acc[row.action_status] || 0) + 1;
    return acc;
  }, { must_isolate:0, follow_up:0, isolated:0, pending:0, due_today:0, not_due:0 });

  const [siteStats] = await db.execute(`SELECT
      s.id,s.code,s.name,
      COUNT(DISTINCT CASE WHEN i.id IS NOT NULL THEN c.id END) billed_customers,
      COUNT(DISTINCT CASE WHEN i.status='paid' OR i.outstanding<=0 THEN c.id END) paid_customers,
      COUNT(DISTINCT CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 THEN c.id END) open_customers,
      COALESCE(SUM(CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 THEN i.outstanding ELSE 0 END),0) outstanding_amount,
      COUNT(DISTINCT CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND c.network_status='isolated' THEN c.id END) isolated_customers,
      COUNT(DISTINCT CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND c.network_status<>'isolated' AND CURDATE()>DATE_ADD(i.due_date,INTERVAL COALESCE(c.grace_days,s.default_grace_days,st.default_grace_days,2) DAY) THEN c.id END) must_isolate_customers,
      COUNT(DISTINCT CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND DATEDIFF(CURDATE(),i.due_date)>0 AND CURDATE()<=DATE_ADD(i.due_date,INTERVAL COALESCE(c.grace_days,s.default_grace_days,st.default_grace_days,2) DAY) THEN c.id END) follow_up_customers,
      COUNT(DISTINCT CASE WHEN pp.pending_count>0 THEN c.id END) pending_customers
    FROM sites s
    LEFT JOIN settings st ON st.id=1
    LEFT JOIN customers c ON c.site_id=s.id AND c.archived_at IS NULL
    LEFT JOIN invoices i ON i.customer_id=c.id AND i.period_month=? AND i.period_year=? AND i.status NOT IN ('cancelled','refunded')
    LEFT JOIN (SELECT invoice_id,COUNT(*) pending_count FROM payments WHERE status='pending' GROUP BY invoice_id) pp ON pp.invoice_id=i.id
    WHERE s.is_active=1${siteId?' AND s.id=?':''}
    GROUP BY s.id,s.code,s.name ORDER BY s.code`, [month,year,...(siteId?[siteId]:[])]);

  return {
    month, year,
    summary: {
      billedCustomers: asNumber(summary.billed_customers),
      billedAmount: asNumber(summary.billed_amount),
      collectedAmount: asNumber(summary.collected_amount),
      outstandingAmount: asNumber(summary.outstanding_amount),
      paidCustomers: asNumber(summary.paid_customers),
      openCustomers: asNumber(summary.open_customers),
      paymentCount: asNumber(confirmedPayments.payment_count),
      confirmedAmount: asNumber(confirmedPayments.amount),
    },
    actionCounts,
    customers,
    siteStats: siteStats.map(r => ({
      ...r,
      billed_customers:asNumber(r.billed_customers),paid_customers:asNumber(r.paid_customers),open_customers:asNumber(r.open_customers),
      outstanding_amount:asNumber(r.outstanding_amount),isolated_customers:asNumber(r.isolated_customers),
      must_isolate_customers:asNumber(r.must_isolate_customers),follow_up_customers:asNumber(r.follow_up_customers),pending_customers:asNumber(r.pending_customers)
    }))
  };
}

module.exports = { getBillingControlData, classifyCustomer };
