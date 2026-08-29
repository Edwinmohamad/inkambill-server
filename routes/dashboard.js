const express = require('express');
const db = require('../config/db');
const { requirePermission } = require('../middleware/auth');
const { getServerResourceSnapshot } = require('../services/serverMonitorService');
const { getGatewayStatus, getQueueStats } = require('../services/whatsappGatewayService');
const router = express.Router();

// v1.21.0 — Dashboard Section 1, item 1: countdown to the next billing "closing" (isolir) date, derived
// from company defaults (settings.default_due_day + default_grace_days — the same fields already used by
// the billing/isolir engine, see services/invoiceService.js and the isolir scheduler). This is a company-
// wide approximation shown on the executive dashboard; per-site due days can differ slightly (see
// sites.default_due_day), which is out of scope for a single summary countdown widget.
function nextClosingCountdown(now, dueDay, graceDays) {
  const due = Math.max(1, Math.min(28, Number(dueDay) || 15));
  const grace = Math.max(0, Number(graceDays) || 0);
  const closingDayOfMonth = Math.min(28, due + grace);
  let closing = new Date(now.getFullYear(), now.getMonth(), closingDayOfMonth);
  closing.setHours(23, 59, 59, 999);
  if (closing < now) closing = new Date(now.getFullYear(), now.getMonth() + 1, closingDayOfMonth, 23, 59, 59, 999);
  const daysLeft = Math.max(0, Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  return { closingDate: closing, daysLeft, dueDay: due, graceDays: grace };
}

function safeInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function isoDate(d){
  const x=new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
}
function currentWeekRange(){
  const now=new Date();
  const day=now.getDay()||7;
  const start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-day+1);
  const end=new Date(start);end.setDate(end.getDate()+6);
  return {start:isoDate(start),end:isoDate(end)};
}

router.get('/collection-analysis',requirePermission('billing'),async(req,res)=>{
  const now=new Date();
  const selectedMonth=safeInt(req.query.month,now.getMonth()+1,1,12);
  const selectedYear=safeInt(req.query.year,now.getFullYear(),2020,2100);
  const windowMonths=safeInt(req.query.window,6,3,12);
  const selectedSiteCode=String(req.query.site||'').trim().toUpperCase();
  const [siteOptions]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const selectedSite=selectedSiteCode?siteOptions.find(site=>site.code===selectedSiteCode):null;
  const siteId=selectedSite?.id||null;
  const siteSql=siteId?' AND c.site_id=?':'';
  const siteParams=siteId?[siteId]:[];

  const [[summary]]=await db.execute(`SELECT COUNT(*) invoice_count,COALESCE(SUM(i.total),0) billed,COALESCE(SUM(i.paid_amount),0) collected,COALESCE(SUM(i.outstanding),0) outstanding,SUM(i.status='paid') paid_count,SUM(i.status IN ('unpaid','partial','overdue') AND i.outstanding>0) open_count FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')${siteSql}`,[selectedYear,selectedMonth,...siteParams]);
  const [[aging]]=await db.execute(`SELECT
    COALESCE(SUM(CASE WHEN i.outstanding>0 AND i.due_date>=CURDATE() THEN i.outstanding ELSE 0 END),0) not_due,
    COALESCE(SUM(CASE WHEN i.outstanding>0 AND DATEDIFF(CURDATE(),i.due_date) BETWEEN 1 AND 7 THEN i.outstanding ELSE 0 END),0) days_1_7,
    COALESCE(SUM(CASE WHEN i.outstanding>0 AND DATEDIFF(CURDATE(),i.due_date) BETWEEN 8 AND 30 THEN i.outstanding ELSE 0 END),0) days_8_30,
    COALESCE(SUM(CASE WHEN i.outstanding>0 AND DATEDIFF(CURDATE(),i.due_date)>30 THEN i.outstanding ELSE 0 END),0) days_31_plus
    FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.period_month=? AND i.status IN ('unpaid','partial','overdue')${siteSql}`,[selectedYear,selectedMonth,...siteParams]);

  const [behaviorRows]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.phone,s.code site_code,cl.name cluster_name,
    COUNT(i.id) invoice_count,COALESCE(SUM(i.status='paid'),0) paid_count,
    COALESCE(SUM(i.status IN ('unpaid','partial','overdue') AND i.outstanding>0),0) open_count,
    COALESCE(SUM(CASE WHEN i.status IN ('unpaid','partial','overdue') THEN i.outstanding ELSE 0 END),0) outstanding,
    COALESCE(SUM(CASE WHEN i.status='paid' AND DATE(lp.last_paid_at)<=i.due_date THEN 1 ELSE 0 END),0) on_time_count,
    COALESCE(SUM(CASE WHEN (i.status='paid' AND DATE(lp.last_paid_at)>i.due_date) OR (i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND i.due_date<CURDATE()) THEN 1 ELSE 0 END),0) late_count,
    ROUND(COALESCE(AVG(CASE WHEN i.status='paid' THEN GREATEST(DATEDIFF(lp.last_paid_at,i.due_date),0) WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND i.due_date<CURDATE() THEN DATEDIFF(CURDATE(),i.due_date) ELSE 0 END),0),1) avg_delay_days
    FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    LEFT JOIN invoices i ON i.customer_id=c.id AND i.invoice_date>=DATE_SUB(CURDATE(),INTERVAL ${windowMonths} MONTH) AND i.status NOT IN ('cancelled','refunded')
    LEFT JOIN (SELECT invoice_id,MAX(paid_at) last_paid_at FROM payments WHERE status='confirmed' GROUP BY invoice_id) lp ON lp.invoice_id=i.id
    WHERE c.customer_status='active'${siteSql}
    GROUP BY c.id,c.customer_code,c.name,c.phone,s.code,cl.name HAVING COUNT(i.id)>0`,siteParams);
  const behavior=behaviorRows.map(row=>({...row,onTimeRate:Number(row.paid_count)>0?Math.round(Number(row.on_time_count)/Number(row.paid_count)*100):0}));
  const reliable=behavior.filter(row=>Number(row.paid_count)>0&&Number(row.on_time_count)>0).sort((a,b)=>b.onTimeRate-a.onTimeRate||Number(a.avg_delay_days)-Number(b.avg_delay_days)||Number(b.invoice_count)-Number(a.invoice_count)).slice(0,10);
  const frequentLate=behavior.filter(row=>Number(row.late_count)>0).sort((a,b)=>Number(b.late_count)-Number(a.late_count)||Number(b.avg_delay_days)-Number(a.avg_delay_days)).slice(0,10);
  const [outstandingCustomers]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.phone,s.code site_code,cl.name cluster_name,COUNT(i.id) invoice_count,COALESCE(SUM(i.outstanding),0) outstanding,MIN(i.due_date) oldest_due,DATEDIFF(CURDATE(),MIN(i.due_date)) max_days_late FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE i.period_year=? AND i.period_month=? AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0${siteSql} GROUP BY c.id,c.customer_code,c.name,c.phone,s.code,cl.name ORDER BY outstanding DESC,max_days_late DESC LIMIT 50`,[selectedYear,selectedMonth,...siteParams]);
  const collectionRate=Number(summary.billed)>0?Math.min(100,Math.round(Number(summary.collected)/Number(summary.billed)*100)):0;
  res.render('dashboard/collection',{title:'Analisa Collection Rate',summary,aging,collectionRate,reliable,frequentLate,outstandingCustomers,siteOptions,selectedSiteCode:selectedSite?.code||'',selectedSiteName:selectedSite?.name||'Semua Site',selectedMonth,selectedYear,windowMonths});
});

router.get('/', async (req, res) => {
  const now = new Date();
  const selectedMonth = safeInt(req.query.month, now.getMonth() + 1, 1, 12);
  const selectedYear = safeInt(req.query.year, now.getFullYear(), 2020, 2100);
  const selectedSiteCode = String(req.query.site || '').trim().toUpperCase();
  const kpiMonth=safeInt(req.query.kpi_month,selectedMonth,1,12),kpiYear=safeInt(req.query.kpi_year,selectedYear,2020,2100);
  const kpiSiteCode=String(req.query.kpi_site||'').trim().toUpperCase();
  const psbMonth=safeInt(req.query.psb_month,selectedMonth,1,12),psbYear=safeInt(req.query.psb_year,selectedYear,2020,2100),psbSiteCode=String(req.query.psb_site??selectedSiteCode).trim().toUpperCase();
  const offMonth=safeInt(req.query.off_month,selectedMonth,1,12),offYear=safeInt(req.query.off_year,selectedYear,2020,2100),offSiteCode=String(req.query.off_site??selectedSiteCode).trim().toUpperCase();

  const [siteOptions] = await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const selectedSite = selectedSiteCode ? siteOptions.find(s => s.code === selectedSiteCode) : null;
  const siteId = selectedSite?.id || null;
  const customerScope = siteId ? ` AND c.site_id=?` : '';
  const customerParams = siteId ? [siteId] : [];
  const kpiSite=kpiSiteCode?siteOptions.find(s=>s.code===kpiSiteCode):null,kpiScope=kpiSite?` AND c.site_id=?`:'',kpiParams=kpiSite?[kpiSite.id]:[];
  const psbSite=psbSiteCode?siteOptions.find(s=>s.code===psbSiteCode):null,psbScope=psbSite?` AND c.site_id=?`:'',psbParams=psbSite?[psbSite.id]:[];
  const offSite=offSiteCode?siteOptions.find(s=>s.code===offSiteCode):null,offScope=offSite?` AND c.site_id=?`:'',offParams=offSite?[offSite.id]:[];

  const [[customerStats]] = await db.execute(`SELECT
    COUNT(*) total,
    SUM(c.customer_status='active') active,
    SUM(c.customer_status<>'active') inactive,
    SUM(c.network_status='isolated') isolated,
    SUM(c.customer_status='active' AND c.network_status IN ('offline','router_unreachable')) offline
    FROM customers c WHERE c.archived_at IS NULL${customerScope}`, customerParams);
  // v1.21.0: explicit null/undefined check (never `x||0`) — SUM(...) legitimately returns a real 0 when
  // every customer row fails the condition, and that 0 must be shown as-is, not confused with "no data".
  const nz=(v)=>v!=null?Number(v):0;
  const customer={total:nz(customerStats.total),active:nz(customerStats.active),inactive:nz(customerStats.inactive),isolated:nz(customerStats.isolated),offline:nz(customerStats.offline)};

  const [[revenue]] = await db.execute(`SELECT COALESCE(SUM(p.amount),0) total FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.status='confirmed' AND YEAR(p.paid_at)=? AND MONTH(p.paid_at)=?${customerScope}`,[selectedYear,selectedMonth,...customerParams]);
  const [[billed]] = await db.execute(`SELECT COUNT(*) count,COALESCE(SUM(i.total),0) total,COALESCE(SUM(i.paid_amount),0) collected,COALESCE(SUM(i.status='paid'),0) paid_count,COALESCE(SUM(i.status='unpaid'),0) unpaid_count,COALESCE(SUM(i.status='partial'),0) partial_count,COALESCE(SUM(i.status='overdue'),0) overdue_count FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')${kpiScope}`,[kpiYear,kpiMonth,...kpiParams]);
  const [[unpaid]] = await db.execute(`SELECT COUNT(*) count,COALESCE(SUM(i.outstanding),0) total FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.period_month=? AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0${kpiScope}`,[kpiYear,kpiMonth,...kpiParams]);
  const [[collectionBilling]]=await db.execute(`SELECT COALESCE(SUM(i.total),0) total,COALESCE(SUM(i.paid_amount),0) collected FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')${customerScope}`,[selectedYear,selectedMonth,...customerParams]);
  // v1.20.1: PSB/funnel counts must exclude archived (soft-deleted) customers — otherwise a
  // registration that's later archived (e.g. duplicate/mistaken entry) keeps inflating that
  // month's PSB numbers forever, since archiving never touches activation_date/created_at.
  const [[newCustomers]] = await db.execute(`SELECT COUNT(*) total FROM customers c WHERE c.archived_at IS NULL AND YEAR(COALESCE(c.activation_date,DATE(c.created_at)))=? AND MONTH(COALESCE(c.activation_date,DATE(c.created_at)))=?${psbScope}`,[psbYear,psbMonth,...psbParams]);
  const [[psbToday]] = await db.execute(`SELECT COUNT(*) total FROM customers c WHERE c.archived_at IS NULL AND DATE(COALESCE(c.activation_date,DATE(c.created_at)))=CURDATE()${psbScope}`,psbParams);
  const [psbCustomers]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.activation_date,c.customer_status,s.code site_code,cl.name cluster_name,p.name package_name,p.speed_label FROM customers c JOIN sites s ON s.id=c.site_id JOIN packages p ON p.id=c.package_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.archived_at IS NULL AND YEAR(COALESCE(c.activation_date,DATE(c.created_at)))=? AND MONTH(COALESCE(c.activation_date,DATE(c.created_at)))=?${psbScope} ORDER BY COALESCE(c.activation_date,DATE(c.created_at)) DESC,c.id DESC LIMIT 250`,[psbYear,psbMonth,...psbParams]);
  const [[network]] = await db.execute(`SELECT SUM(c.network_status='online') online,SUM(c.network_status='offline') offline,SUM(c.network_status='isolated') isolated,SUM(c.network_status='router_unreachable') unreachable FROM customers c WHERE c.customer_status='active'${customerScope}`,customerParams);

  const [[routerNoc]] = await db.execute(`SELECT COUNT(*) routers_total,SUM(last_status='online') routers_online FROM routers WHERE is_active=1${siteId?' AND site_id=?':''}`,customerParams);
  const [[ticketNoc]] = await db.execute(`SELECT COUNT(*) tickets_open FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.status IN ('open','progress','pending')${siteId?' AND c.site_id=?':''}`,customerParams);
  const [[cashHeldNoc]] = await db.execute(`SELECT COALESCE(SUM(p.amount),0) cash_held FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff'${customerScope}`,customerParams);
  const [[overdueNoc]] = await db.execute(`SELECT COUNT(DISTINCT i.customer_id) overdue_customers FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status='overdue' AND i.outstanding>0${customerScope}`,customerParams);
  const [[approvalNoc]]=await db.execute(`SELECT COUNT(*) pending_approvals,COALESCE(SUM(p.amount),0) pending_approval_total FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.status='pending'${customerScope}`,customerParams);
  const [[cashApprovalNoc]]=await db.execute(`SELECT COUNT(*) pending_cash_approvals,COALESCE(SUM(ct.amount),0) pending_cash_total FROM cash_transactions ct WHERE ct.approval_status='PENDING_APPROVAL'${siteId?' AND ct.site_id=?':''}`,customerParams);
  const [[pppoeNoc]]=await db.execute(`SELECT COUNT(*) pppoe_unlinked FROM customers c WHERE c.customer_status='active' AND (c.pppoe_username IS NULL OR c.router_id IS NULL)${customerScope}`,customerParams);
  const [[dueTodayNoc]]=await db.execute(`SELECT COUNT(*) due_today FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND i.due_date=CURDATE()${customerScope}`,customerParams);
  const [[criticalTicketNoc]]=await db.execute(`SELECT COUNT(*) critical_tickets FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.status IN ('open','progress','pending') AND t.priority='critical'${siteId?' AND c.site_id=?':''}`,customerParams);
  const noc={...routerNoc,...ticketNoc,...cashHeldNoc,...overdueNoc,...approvalNoc,...cashApprovalNoc,...pppoeNoc,...dueTodayNoc,...criticalTicketNoc};
  const [hardOverdueCustomers]=await db.execute(`SELECT c.id,c.customer_code,c.name,s.code site_code,i.id invoice_id,i.invoice_number,i.period_month,i.period_year,i.outstanding,DATEDIFF(CURDATE(),i.due_date) days_overdue FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND DATEDIFF(CURDATE(),i.due_date)>2${customerScope} ORDER BY days_overdue DESC,i.outstanding DESC LIMIT 20`,customerParams);
  // v1.20.1: archived_at exclusion added — an archived customer is always customer_status='terminated'
  // (set together, see routes/customers.js), so without this filter every archived account permanently
  // clutters the "customer nonaktif" review list even though it's meant to disappear once archived.
  const [inactiveCustomers]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.customer_status,c.status_changed_at,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.archived_at IS NULL AND c.customer_status<>'active' AND YEAR(COALESCE(c.status_changed_at,c.updated_at,c.created_at))=? AND MONTH(COALESCE(c.status_changed_at,c.updated_at,c.created_at))=?${offScope} ORDER BY COALESCE(c.status_changed_at,c.updated_at,c.created_at) DESC LIMIT 100`,[offYear,offMonth,...offParams]);
  const [isolatedCustomers]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.network_status,c.status_changed_at,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.archived_at IS NULL AND c.network_status='isolated' AND YEAR(COALESCE(c.status_changed_at,c.updated_at,c.created_at))=? AND MONTH(COALESCE(c.status_changed_at,c.updated_at,c.created_at))=?${offScope} ORDER BY COALESCE(c.status_changed_at,c.updated_at,c.created_at) DESC LIMIT 100`,[offYear,offMonth,...offParams]);

  // v1.20.1: archived customers excluded from the site breakdown grid via the JOIN condition (not
  // WHERE) so a site with zero live customers still shows a 0-row instead of disappearing entirely.
  const [siteCustomerRows]=await db.query(`SELECT s.id,s.code,s.name,
    COUNT(c.id) total,
    COALESCE(SUM(c.customer_status='active'),0) active,
    COALESCE(SUM(c.customer_status<>'active'),0) inactive,
    COALESCE(SUM(c.network_status='isolated'),0) isolated,
    COALESCE(SUM(c.customer_status='active' AND c.network_status IN ('offline','router_unreachable')),0) offline
    FROM sites s LEFT JOIN customers c ON c.site_id=s.id AND c.archived_at IS NULL
    WHERE s.is_active=1
    GROUP BY s.id,s.code,s.name ORDER BY s.code`);

  const [dailyPsbRows]=await db.execute(`SELECT DAY(COALESCE(c.activation_date,DATE(c.created_at))) day_no,COUNT(*) total
    FROM customers c
    WHERE c.archived_at IS NULL AND YEAR(COALESCE(c.activation_date,DATE(c.created_at)))=? AND MONTH(COALESCE(c.activation_date,DATE(c.created_at)))=?${psbScope}
    GROUP BY DAY(COALESCE(c.activation_date,DATE(c.created_at))) ORDER BY day_no`,[psbYear,psbMonth,...psbParams]);

  const [monthlyInvoiceRows]=await db.execute(`SELECT i.period_month month_no,COALESCE(SUM(i.total),0) total FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.status NOT IN ('cancelled','refunded')${customerScope} GROUP BY i.period_month ORDER BY i.period_month`,[selectedYear,...customerParams]);
  const [monthlyPaymentRows]=await db.execute(`SELECT MONTH(p.paid_at) month_no,COALESCE(SUM(p.amount),0) total FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.status='confirmed' AND YEAR(p.paid_at)=?${customerScope} GROUP BY MONTH(p.paid_at) ORDER BY MONTH(p.paid_at)`,[selectedYear,...customerParams]);
  const [recent]=await db.execute(`SELECT i.id,i.invoice_number,i.total,i.outstanding,i.status,c.name customer_name,s.code site_code,cl.name cluster_name FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE 1=1${customerScope} ORDER BY i.id DESC LIMIT 6`,customerParams);
  const [frequentLogins]=await db.query(`SELECT u.id,u.name,u.username,COUNT(le.id) login_count,MAX(le.logged_in_at) last_login FROM user_login_events le JOIN users u ON u.id=le.user_id WHERE le.logged_in_at>=DATE_SUB(NOW(),INTERVAL 30 DAY) GROUP BY u.id,u.name,u.username ORDER BY login_count DESC,last_login DESC LIMIT 5`);
  const [recentLogins]=await db.query(`SELECT u.id,u.name,u.username,le.logged_in_at FROM user_login_events le JOIN users u ON u.id=le.user_id ORDER BY le.logged_in_at DESC LIMIT 8`);
  const loginTicker=[...frequentLogins.map(x=>({kind:'frequent',name:x.name,detail:`${Number(x.login_count||0)} login / 30 hari`,time:x.last_login})),...recentLogins.map(x=>({kind:'recent',name:x.name,detail:'Last Login',time:x.logged_in_at}))];

  // v1.21.0 — Dashboard Section 1: five new widgets. Each query is scoped by the same `customerScope`
  // (site filter) already used everywhere else on this page, for consistency with the rest of the KPIs.
  const [[appSettings]]=await db.query(`SELECT default_due_day,default_grace_days FROM settings WHERE id=1 LIMIT 1`);
  const closing=nextClosingCountdown(now,appSettings?.default_due_day,appSettings?.default_grace_days);

  // v1.24.6 — the "Distribusi Paket" breakdown that used to live here was removed from the dashboard
  // (see UI/UX audit) and relocated to the Paket Internet page (views/packages/index.ejs), which already
  // computes a per-package customer_count of its own — no need to duplicate that query here anymore.

  // Item 3: WA Gateway & Automation Queue Status. IMPORTANT — this app does not (yet) integrate a real
  // WhatsApp Business API/gateway (no Baileys/Fonnte/Wablas connector exists in services/); reminders are
  // sent by staff manually clicking a wa.me deep link (see views/invoices/index.ejs). So this widget
  // reports what's genuinely knowable from the database — WhatsApp number validation coverage and how many
  // reminders are due today — rather than fabricating a fake "Connected" status with no real backing
  // service. If/when a real gateway is wired up, `waMode` below is the single place to flip to live status.
  // v1.23 — now backed by the real WA Gateway (services/whatsappGatewayService.js, Baileys). Mode
  // reflects the actual live connection state instead of a hardcoded 'manual' placeholder, and
  // queueToday/sentToday come straight from the wa_messages table once the gateway is connected.
  const [[waStats]]=await db.execute(`SELECT SUM(whatsapp_status='valid') valid_count,SUM(whatsapp_status='invalid') invalid_count,SUM(whatsapp_status='unverified') unverified_count FROM customers c WHERE c.archived_at IS NULL${customerScope}`,customerParams);
  const waGateway=getGatewayStatus();
  const waQueueStats=await getQueueStats();
  const waOverview={
    mode:waGateway.state==='connected'?'connected':'manual',
    state:waGateway.state,
    valid:nz(waStats?.valid_count),
    invalid:nz(waStats?.invalid_count),
    unverified:nz(waStats?.unverified_count),
    queueToday:waGateway.state==='connected'?waQueueStats.queued:nz(noc?.due_today),
    sentToday:waQueueStats.sentToday,
  };

  // Item 5: Local Billing Server Resource Monitor (CPU/RAM/Disk) — see services/serverMonitorService.js.
  const serverResource=getServerResourceSnapshot();

  // Item 4: Quick Action Launchpad — "Cek ODP Kosong" badge count, using the capacity_ports/used_ports
  // columns that already power the "X port tersedia" column on the Cluster/ODP page (views/clusters/index.ejs).
  const [[odpAvailability]]=await db.query(`SELECT COUNT(*) n FROM clusters WHERE status='active' AND capacity_ports IS NOT NULL AND capacity_ports>used_ports${siteId?' AND site_id=?':''}`,siteId?[siteId]:[]);
  const odpAvailableCount=nz(odpAvailability?.n);

  const week=currentWeekRange();
  const [weekDuty]=await db.execute(`SELECT d.id,d.duty_date,DATE_FORMAT(d.duty_date,'%Y-%m-%d') duty_date_key,d.staff_name,d.shift_name,d.status,d.proof_path,s.code site_code
    FROM server_duty_schedules d LEFT JOIN sites s ON s.id=d.site_id
    WHERE d.duty_date BETWEEN ? AND ?
    ORDER BY d.duty_date,COALESCE(d.start_time,'23:59:59'),d.staff_name`,[week.start,week.end]);

  const monthLabels=['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const daysInPsbMonth=new Date(psbYear,psbMonth,0).getDate(),psbLabels=Array.from({length:daysInPsbMonth},(_,i)=>String(i+1)),dailyPsb=Array(daysInPsbMonth).fill(0);
  const monthlyInvoices=Array(12).fill(0),monthlyPayments=Array(12).fill(0);
  monthlyInvoiceRows.forEach(r=>{monthlyInvoices[Number(r.month_no)-1]=Number(r.total||0)});
  monthlyPaymentRows.forEach(r=>{monthlyPayments[Number(r.month_no)-1]=Number(r.total||0)});
  dailyPsbRows.forEach(r=>{dailyPsb[Number(r.day_no)-1]=Number(r.total||0)});
  const collectionRate=Number(collectionBilling.total)>0?Math.min(100,Math.round((Number(collectionBilling.collected)/Number(collectionBilling.total))*100)):0;
  const routerRate=Number(noc.routers_total)>0?Math.round(Number(noc.routers_online||0)/Number(noc.routers_total)*100):100;
  const invoiceKpi={total:Number(billed.count||0),paid:Number(billed.paid_count||0),unpaid:Number(billed.unpaid_count||0),partial:Number(billed.partial_count||0),overdue:Number(billed.overdue_count||0)};
  const todayKey=isoDate(now),todayDuty=weekDuty.filter(row=>row.duty_date_key===todayKey);
  const jakartaHour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Jakarta'}).format(now));
  const greeting=jakartaHour<11?'Selamat pagi':jakartaHour<15?'Selamat siang':jakartaHour<18?'Selamat sore':'Selamat malam';
  const years=Array.from({length:5},(_,i)=>now.getFullYear()-2+i);for(const year of [selectedYear,kpiYear,psbYear,offYear])if(!years.includes(year))years.push(year);years.sort((a,b)=>a-b);

  res.render('dashboard/index',{
    title:'Dashboard',customer,revenue,billed,unpaid,newCustomers,psbToday,psbCustomers,network,noc,recent,loginTicker,siteOptions,siteCustomerRows,weekDuty,todayDuty,week,invoiceKpi,hardOverdueCustomers,inactiveCustomers,isolatedCustomers,
    selectedSiteCode:selectedSite?.code||'',selectedSiteName:selectedSite?.name||'Semua Site',collectionRate,routerRate,
    selectedMonth,selectedYear,years,kpiMonth,kpiYear,kpiSiteCode:kpiSite?.code||'',psbMonth,psbYear,psbSiteCode:psbSite?.code||'',offMonth,offYear,offSiteCode:offSite?.code||'',
    greeting,monthly:{labels:monthLabels,invoices:monthlyInvoices,payments:monthlyPayments,psbLabels,psb:dailyPsb},
    closing,waOverview,serverResource,odpAvailableCount,
    collectionBilled:nz(collectionBilling.total),collectionCollected:nz(collectionBilling.collected)
  });
});
module.exports=router;
