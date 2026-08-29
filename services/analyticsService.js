const db = require('../config/db');
const { normalizeWhatsapp } = require('./whatsappService');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function monthKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function lastMonths(count = 12, now = new Date()) {
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    rows.push({ key: monthKey(d), label: d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit', timeZone: 'Asia/Jakarta' }) });
  }
  return rows;
}
function shortDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date(value));
}
// The operational cash cut-off period runs from the 6th of a month through the
// 5th of the following month. Passing the 1-based `month` straight into the
// JS Date month slot (which is 0-based) naturally lands on "next month".
function cutoffWindow(month, year) {
  const start = new Date(year, month - 1, 6, 0, 0, 0);
  const end = new Date(year, month, 5, 23, 59, 59);
  return { start, end, label: `${shortDate(start)} – ${shortDate(end)}` };
}
function nextMonthOf(month, year) {
  return month >= 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

// ---------------------------------------------------------------------------
// Business-shape builders (used by both the real query path and the dummy
// fallback, so the two payloads are always structurally identical).
// ---------------------------------------------------------------------------
function buildFunnel(row = {}) {
  const values = [num(row.registered), num(row.survey_ready), num(row.provisioned), num(row.activated)];
  return [
    { key: 'registered', label: 'Leads / Registrasi', value: values[0], hint: 'Pelanggan dibuat pada periode' },
    { key: 'survey', label: 'Surveyed', value: values[1], hint: 'Alamat + cluster sudah terisi' },
    { key: 'fiber', label: 'Installed', value: values[2], hint: 'Router + PPPoE sudah diprovision' },
    { key: 'active', label: 'Activated', value: values[3], hint: 'Activation date terisi dan aktif' }
  ];
}
function odpTone(o) {
  if (num(o.capacity_ports) === 0) return 'unknown';
  if (num(o.remaining_ports) <= 1) return 'critical';
  if (num(o.utilization) >= 75) return 'warning';
  return 'healthy';
}
function buildAdvisories({ odp = [], dueDateMatrix = {}, siapIsolirCount = 0, pppoeUnlinked = 0, pendingCash = 0 } = {}) {
  const out = [];

  // 1. Rekonsiliasi kas tgl 5 vs tagihan tgl 30: apakah ada pelunasan yang jatuh
  // di tanggal 6-7 (setelah closing kas tgl 5) sehingga overlap ke periode berikutnya.
  const due30 = dueDateMatrix.due30 || {};
  const overlap = num(due30.overlapNextCutoffAmount);
  const withinCutoff = num(due30.withinCutoffAmount);
  if (overlap > 0) {
    out.push({
      tone: 'warning', icon: 'bi-arrow-left-right',
      title: `Rekonsiliasi kas: Rp ${overlap.toLocaleString('id-ID')} tagihan tgl 30 masuk di tgl 6-7`,
      detail: `Pelunasan ini terjadi setelah closing kas tanggal 5, jadi belum tercermin di laporan periode berjalan. Pastikan tim finance mencatatnya pada closing kas periode berikutnya.`,
      href: '/analytics?tab=finance'
    });
  } else if (withinCutoff > 0) {
    out.push({
      tone: 'success', icon: 'bi-check2-circle',
      title: 'Rekonsiliasi kas tgl 30 aman',
      detail: `Seluruh pelunasan tagihan tgl 30 yang tercatat (Rp ${withinCutoff.toLocaleString('id-ID')}) masuk sebelum closing kas tanggal 5. Tidak ada gap rekonsiliasi periode ini.`,
      href: '/analytics?tab=finance'
    });
  }

  // 2. ODP kritis (sisa port <= 1).
  const low = odp.filter(x => odpTone(x) === 'critical');
  if (low.length) {
    out.push({
      tone: 'danger', icon: 'bi-diagram-3-fill',
      title: `${low.length} ODP kritis (sisa port ≤ 1)`,
      detail: `Prioritaskan audit/ekspansi kapasitas: ${low.slice(0, 3).map(x => `${x.site_code}/${x.name} sisa ${x.remaining_ports}`).join(', ')}.`,
      href: '/clusters'
    });
  }

  // 3. WA blast untuk pelanggan siap-isolir (telat > 7 hari).
  if (siapIsolirCount > 0) {
    out.push({
      tone: 'danger', icon: 'bi-whatsapp',
      title: `${siapIsolirCount} pelanggan siap isolir (telat > 7 hari)`,
      detail: 'Rekomendasi: kirim WA Blast reminder segera dari tab Analitik Keuangan sebelum proses isolir berjalan.',
      href: '/analytics?tab=finance'
    });
  }

  if (pppoeUnlinked > 0) out.push({ tone: 'info', icon: 'bi-router-fill', title: `${pppoeUnlinked} pelanggan belum link PPPoE`, detail: 'Buka MikroTik NMS dan jalankan Smart Sync untuk rekonsiliasi billing ↔ PPPoE.', href: '/network/monitor' });
  if (pendingCash > 0) out.push({ tone: 'purple', icon: 'bi-shield-check', title: `${pendingCash} kas menunggu approval`, detail: 'Saldo real belum berubah sampai Owner / Master Admin memverifikasi transaksi.', href: '/payments#cash-approval' });
  if (!out.length) out.push({ tone: 'success', icon: 'bi-stars', title: 'Operasional dalam kondisi baik', detail: 'Tidak ada advisory kritis dari rekonsiliasi kas, kapasitas ODP, atau aging piutang saat ini.', href: '/' });
  return out;
}

// Assembles the compact bundle used by both the in-page "Generate Laporan"
// modal (rendered instantly from page-load data) and the /export-report
// JSON endpoint (always freshly queried).
function buildReportSummary(data) {
  const odpCritical = data.odp.filter(o => odpTone(o) === 'critical').length;
  const odpWarning = data.odp.filter(o => odpTone(o) === 'warning').length;
  const odpHealthy = data.odp.filter(o => odpTone(o) === 'healthy').length;
  const funnelActive = data.funnel.find(f => f.key === 'active')?.value || 0;
  const funnelLeads = data.funnel.find(f => f.key === 'registered')?.value || 0;
  return {
    generatedAt: new Date().toISOString(),
    period: { month: data.month, year: data.year, cutoffLabel: data.cutoff.label },
    site: data.selectedSiteName,
    executive: {
      mrr: data.kpis.mrr,
      cashRealizationCutoff: data.kpis.cashRealizationCutoff,
      activeCustomers: data.kpis.activeCustomers,
      churnRate: data.kpis.churnRate,
      accrualBilled: data.dualMatrix.accrualBasis.billed,
      cashCollected: data.dualMatrix.cashBasis.collected,
      variance: data.dualMatrix.variance
    },
    network: {
      avgSlaHours: data.sla.avgHours,
      slaSamples: data.sla.samples,
      psbConversionRate: funnelLeads ? Math.round((funnelActive / funnelLeads) * 100) : 0,
      odpCritical, odpWarning, odpHealthy
    },
    advisories: data.advisories.map(a => ({ tone: a.tone, title: a.title, detail: a.detail })),
    ownerWhatsapp: data.ownerWhatsapp || null
  };
}

// ---------------------------------------------------------------------------
// Real data path
// ---------------------------------------------------------------------------
async function fetchAnalytics({ siteCode = '', month, year }) {
  const now = new Date();
  month = Number(month) || now.getMonth() + 1;
  year = Number(year) || now.getFullYear();
  const cutoff = cutoffWindow(month, year);
  const next = nextMonthOf(month, year);
  const withinNextStart = new Date(next.year, next.month - 1, 1, 0, 0, 0);
  const withinNextEnd = new Date(next.year, next.month - 1, 5, 23, 59, 59);
  const overlapNextStart = new Date(next.year, next.month - 1, 6, 0, 0, 0);
  const overlapNextEnd = new Date(next.year, next.month - 1, 7, 23, 59, 59);

  const [sites] = await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const selected = siteCode ? sites.find(s => String(s.code).toUpperCase() === String(siteCode).toUpperCase()) : null;
  const siteId = selected?.id || null;
  const customerScope = siteId ? ' AND c.site_id=?' : '';
  const customerParams = siteId ? [siteId] : [];
  const cashScope = siteId ? ' AND ct.site_id=?' : '';
  const cashParams = siteId ? [siteId] : [];

  let ownerWhatsapp = null;
  try {
    const [[settingsRow]] = await db.query(`SELECT company_phone FROM settings WHERE id=1 LIMIT 1`);
    ownerWhatsapp = normalizeWhatsapp(settingsRow?.company_phone) || null;
  } catch (_) { ownerWhatsapp = null; }

  // --- Executive KPIs -------------------------------------------------------
  const [[exec]] = await db.execute(`SELECT COUNT(*) active_customers,COALESCE(SUM(p.price),0) mrr FROM customers c JOIN packages p ON p.id=c.package_id WHERE c.customer_status='active'${customerScope}`, customerParams);
  const [[churn]] = await db.execute(`SELECT SUM(c.customer_status IN ('inactive','terminated','suspended') AND c.status_changed_at IS NOT NULL AND MONTH(c.status_changed_at)=? AND YEAR(c.status_changed_at)=?) churned FROM customers c WHERE 1=1${customerScope}`, [month, year, ...customerParams]);
  const churnedCount = num(churn.churned);
  const activeCustomers = num(exec.active_customers);
  const churnRate = (activeCustomers + churnedCount) > 0 ? Math.round((churnedCount / (activeCustomers + churnedCount)) * 1000) / 10 : 0;

  // --- Dual-matrix: Cash Basis (collected in the cut-off window) vs Accrual Basis (billed this period) ---
  const [[cashBasisRow]] = await db.execute(`SELECT COUNT(*) count,COALESCE(SUM(p.amount),0) collected FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.status='confirmed' AND p.paid_at BETWEEN ? AND ?${customerScope}`, [cutoff.start, cutoff.end, ...customerParams]);
  const [[accrualRow]] = await db.execute(`SELECT COUNT(*) count,COALESCE(SUM(i.total),0) billed FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_month=? AND i.period_year=? AND i.status NOT IN ('cancelled','refunded')${customerScope}`, [month, year, ...customerParams]);
  const dualMatrix = {
    cashBasis: { collected: num(cashBasisRow.collected), count: num(cashBasisRow.count) },
    accrualBasis: { billed: num(accrualRow.billed), count: num(accrualRow.count) },
    variance: num(cashBasisRow.collected) - num(accrualRow.billed)
  };

  // --- Due-date matrix: Tgl 15 (grace s/d 20) vs Tgl 30 (grace s/d 7 bulan berikutnya) ---
  const [dueGroupRows] = await db.execute(`SELECT CASE WHEN DAY(i.due_date)<=22 THEN 'due15' ELSE 'due30' END grp,
      COUNT(*) total_invoices,COALESCE(SUM(i.total),0) billed,COALESCE(SUM(i.paid_amount),0) paid,COALESCE(SUM(i.outstanding),0) outstanding,
      SUM(i.status='paid') paid_count,SUM(i.status IN ('unpaid','partial','overdue')) unpaid_count
    FROM invoices i JOIN customers c ON c.id=i.customer_id
    WHERE i.period_month=? AND i.period_year=? AND i.status NOT IN ('cancelled','refunded')${customerScope}
    GROUP BY grp`, [month, year, ...customerParams]);
  const [[due30Recon]] = await db.execute(`SELECT
      COALESCE(SUM(CASE WHEN p.paid_at BETWEEN ? AND ? THEN p.amount ELSE 0 END),0) within_cutoff,
      COALESCE(SUM(CASE WHEN p.paid_at BETWEEN ? AND ? THEN p.amount ELSE 0 END),0) overlap_next
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.status='confirmed' AND DAY(i.due_date)>22 AND i.period_month=? AND i.period_year=?${customerScope}`,
    [withinNextStart, withinNextEnd, overlapNextStart, overlapNextEnd, month, year, ...customerParams]);
  const dueGroupMap = new Map(dueGroupRows.map(r => [r.grp, r]));
  function dueGroupShape(row) {
    return { totalInvoices: num(row?.total_invoices), billed: num(row?.billed), paid: num(row?.paid), outstanding: num(row?.outstanding), paidCount: num(row?.paid_count), unpaidCount: num(row?.unpaid_count) };
  }
  const dueDateMatrix = {
    due15: { label: 'Jatuh Tempo 15 (Grace s/d 20)', ...dueGroupShape(dueGroupMap.get('due15')) },
    due30: { label: 'Jatuh Tempo 30 (Grace s/d 7 bulan berikutnya)', ...dueGroupShape(dueGroupMap.get('due30')), withinCutoffAmount: num(due30Recon.within_cutoff), overlapNextCutoffAmount: num(due30Recon.overlap_next) }
  };

  // --- ODP capacity heatmap --------------------------------------------------
  const [odpRaw] = await db.execute(`SELECT cl.id,cl.name,cl.capacity_ports,cl.used_ports,GREATEST(COALESCE(cl.capacity_ports,0)-COALESCE(cl.used_ports,0),0) remaining_ports,s.code site_code,s.name site_name FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status<>'inactive'${siteId ? ' AND cl.site_id=?' : ''} ORDER BY s.code,remaining_ports,cl.name`, siteId ? [siteId] : []);
  const odp = odpRaw.map(x => {
    const capacity_ports = num(x.capacity_ports), used_ports = num(x.used_ports), remaining_ports = num(x.remaining_ports);
    const utilization = capacity_ports ? Math.min(100, Math.round((used_ports / capacity_ports) * 100)) : 0;
    return { ...x, capacity_ports, used_ports, remaining_ports, utilization, tone: odpTone({ capacity_ports, remaining_ports, utilization }) };
  });

  // --- Cashflow Stream: Inflow vs Outflow, trailing 6 months -----------------
  const [cashRows] = await db.execute(`SELECT DATE_FORMAT(ct.transaction_date,'%Y-%m') month_key,COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE 0 END),0) inflow,COALESCE(SUM(CASE WHEN cc.type='expense' THEN ct.amount ELSE 0 END),0) outflow FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND ct.transaction_date>=DATE_SUB(DATE_FORMAT(CURDATE(),'%Y-%m-01'),INTERVAL 5 MONTH)${cashScope} GROUP BY DATE_FORMAT(ct.transaction_date,'%Y-%m') ORDER BY month_key`, cashParams);
  const months = lastMonths(6, now);
  const cashMap = new Map(cashRows.map(x => [x.month_key, x]));
  const financeSeries = { labels: months.map(x => x.label), inflow: months.map(x => num(cashMap.get(x.key)?.inflow)), outflow: months.map(x => num(cashMap.get(x.key)?.outflow)) };

  // --- Aging piutang (with WhatsApp reminder number + "siap isolir" flag) ----
  const [agingRaw] = await db.execute(`SELECT c.id,c.customer_code,c.name customer_name,c.phone,s.code site_code,MIN(i.due_date) oldest_due,COALESCE(SUM(i.outstanding),0) outstanding,MAX(DATEDIFF(CURDATE(),i.due_date)) days_overdue FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0${customerScope} GROUP BY c.id,c.customer_code,c.name,c.phone,s.code ORDER BY days_overdue DESC,outstanding DESC LIMIT 150`, customerParams);
  const aging = agingRaw.map(row => ({ ...row, whatsappNumber: normalizeWhatsapp(row.phone) || null, siapIsolir: num(row.days_overdue) > 7 }));
  const agingBuckets = {
    h3: aging.filter(x => num(x.days_overdue) <= 0 && num(x.days_overdue) >= -3),
    hplus3: aging.filter(x => num(x.days_overdue) > 0 && num(x.days_overdue) <= 30),
    over30: aging.filter(x => num(x.days_overdue) > 30)
  };
  const siapIsolirCount = aging.filter(x => x.siapIsolir).length;

  // --- PSB funnel + technician SLA (in hours) --------------------------------
  // v1.20.1: archived_at exclusion — without it, a registration later archived (duplicate/mistaken
  // entry) keeps counting in this month's funnel/SLA numbers forever, since archiving never touches
  // created_at/activation_date.
  const [[funnelRow]] = await db.execute(`SELECT COUNT(*) registered,SUM(c.address IS NOT NULL AND c.address<>'' AND c.cluster_id IS NOT NULL) survey_ready,SUM(c.router_id IS NOT NULL AND c.pppoe_username IS NOT NULL AND c.pppoe_username<>'') provisioned,SUM(c.customer_status='active' AND c.activation_date IS NOT NULL) activated FROM customers c WHERE c.archived_at IS NULL AND YEAR(c.created_at)=? AND MONTH(c.created_at)=?${customerScope}`, [year, month, ...customerParams]);
  const [[slaRow]] = await db.execute(`SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR,c.created_at,c.activation_date)),1) avg_hours,COUNT(*) samples FROM customers c WHERE c.archived_at IS NULL AND c.activation_date IS NOT NULL AND YEAR(c.activation_date)=? AND MONTH(c.activation_date)=?${customerScope}`, [year, month, ...customerParams]);

  const [[sync]] = await db.execute(`SELECT COUNT(*) pppoe_unlinked FROM customers c WHERE c.customer_status='active' AND (c.router_id IS NULL OR c.pppoe_username IS NULL OR c.pppoe_username='')${customerScope}`, customerParams);
  const [[cashPending]] = await db.execute(`SELECT COUNT(*) pending_cash FROM cash_transactions ct WHERE ct.approval_status='PENDING_APPROVAL'${cashScope}`, cashParams);

  const kpis = {
    mrr: num(exec.mrr),
    cashRealizationCutoff: dualMatrix.cashBasis.collected,
    activeCustomers,
    churnRate
  };
  const advisories = buildAdvisories({ odp, dueDateMatrix, siapIsolirCount, pppoeUnlinked: num(sync.pppoe_unlinked), pendingCash: num(cashPending.pending_cash) });

  const result = {
    sites, selectedSiteCode: selected?.code || '', selectedSiteName: selected?.name || 'Semua Site',
    month, year, cutoff, kpis, dualMatrix, dueDateMatrix, advisories, financeSeries,
    aging, agingBuckets, siapIsolirCount,
    funnel: buildFunnel(funnelRow),
    sla: { avgHours: num(slaRow.avg_hours), samples: num(slaRow.samples) },
    odp, ownerWhatsapp, isDummy: false
  };
  result.report = buildReportSummary(result);
  return result;
}

// ---------------------------------------------------------------------------
// Dummy fallback — same exact shape as fetchAnalytics(), realistic numbers,
// used whenever any query above throws (fresh DB, missing column, migration
// not run yet, DB unreachable, etc.) so the page never 500s.
// ---------------------------------------------------------------------------
function buildDummyAnalytics({ siteCode = '', month, year } = {}) {
  const now = new Date();
  month = Number(month) || now.getMonth() + 1;
  year = Number(year) || now.getFullYear();
  const cutoff = cutoffWindow(month, year);
  const months = lastMonths(6, now);
  const wave = (base, amp, phase = 0) => months.map((_, i) => Math.max(0, Math.round(base + amp * Math.sin((i + phase) / 2))));
  const financeSeries = { labels: months.map(x => x.label), inflow: wave(38000000, 9000000), outflow: wave(24000000, 6000000, 1.4) };
  const dummySites = [{ id: 0, code: 'HQ', name: 'Kantor Pusat (contoh)' }];
  const selectedName = siteCode ? `${siteCode} (contoh)` : 'Semua Site (contoh)';

  const aging = [
    { id: 'demo-1', customer_code: 'DEMO-0001', customer_name: 'Contoh Pelanggan A', phone: null, whatsappNumber: null, site_code: 'HQ', oldest_due: new Date(now.getTime() - 2 * 86400000), outstanding: 350000, days_overdue: 2, siapIsolir: false },
    { id: 'demo-2', customer_code: 'DEMO-0002', customer_name: 'Contoh Pelanggan B', phone: null, whatsappNumber: null, site_code: 'HQ', oldest_due: new Date(now.getTime() - 10 * 86400000), outstanding: 275000, days_overdue: 10, siapIsolir: true },
    { id: 'demo-3', customer_code: 'DEMO-0003', customer_name: 'Contoh Pelanggan C', phone: null, whatsappNumber: null, site_code: 'HQ', oldest_due: new Date(now.getTime() - 40 * 86400000), outstanding: 520000, days_overdue: 40, siapIsolir: true }
  ];
  const agingBuckets = { h3: aging.filter(x => x.days_overdue <= 2), hplus3: aging.filter(x => x.days_overdue > 2 && x.days_overdue <= 30), over30: aging.filter(x => x.days_overdue > 30) };
  const siapIsolirCount = aging.filter(x => x.siapIsolir).length;

  const odpRaw = [
    { id: 'demo-odp-1', name: 'ODP Contoh 01', capacity_ports: 16, used_ports: 15, remaining_ports: 1, site_code: 'HQ', site_name: 'Kantor Pusat (contoh)' },
    { id: 'demo-odp-2', name: 'ODP Contoh 02', capacity_ports: 16, used_ports: 12, remaining_ports: 4, site_code: 'HQ', site_name: 'Kantor Pusat (contoh)' },
    { id: 'demo-odp-3', name: 'ODP Contoh 03', capacity_ports: 16, used_ports: 6, remaining_ports: 10, site_code: 'HQ', site_name: 'Kantor Pusat (contoh)' }
  ];
  const odp = odpRaw.map(x => { const utilization = Math.round((x.used_ports / x.capacity_ports) * 100); return { ...x, utilization, tone: odpTone({ ...x, utilization }) }; });

  const funnel = buildFunnel({ registered: 40, survey_ready: 34, provisioned: 28, activated: 22 });
  const dualMatrix = { cashBasis: { collected: 47000000, count: 118 }, accrualBasis: { billed: 61000000, count: 132 }, variance: 47000000 - 61000000 };
  const dueDateMatrix = {
    due15: { label: 'Jatuh Tempo 15 (Grace s/d 20)', totalInvoices: 70, billed: 32000000, paid: 27000000, outstanding: 5000000, paidCount: 60, unpaidCount: 10 },
    due30: { label: 'Jatuh Tempo 30 (Grace s/d 7 bulan berikutnya)', totalInvoices: 62, billed: 29000000, paid: 20000000, outstanding: 9000000, paidCount: 48, unpaidCount: 14, withinCutoffAmount: 15000000, overlapNextCutoffAmount: 5000000 }
  };
  const kpis = { mrr: 52000000, cashRealizationCutoff: dualMatrix.cashBasis.collected, activeCustomers: 842, churnRate: 1.8 };
  const advisories = buildAdvisories({ odp, dueDateMatrix, siapIsolirCount, pppoeUnlinked: 3, pendingCash: 2 });

  const result = {
    sites: dummySites, selectedSiteCode: siteCode || '', selectedSiteName: selectedName,
    month, year, cutoff, kpis, dualMatrix, dueDateMatrix, advisories, financeSeries,
    aging, agingBuckets, siapIsolirCount, funnel,
    sla: { avgHours: 26.4, samples: 22 }, odp, ownerWhatsapp: null, isDummy: true
  };
  result.report = buildReportSummary(result);
  return result;
}

async function getAnalytics(params = {}) {
  try {
    return await fetchAnalytics(params);
  } catch (error) {
    console.error('Analytics query gagal, menampilkan data contoh sementara:', error.message);
    return buildDummyAnalytics(params);
  }
}

module.exports = { getAnalytics, buildAdvisories, buildFunnel, lastMonths, buildDummyAnalytics, buildReportSummary, cutoffWindow };
