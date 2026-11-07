// Performa Bulanan (v1.35): penagihan per periode tagihan + arus kas per periode jurnal.
// Arus kas memakai aturan periode yang sama dengan Data Kas, Laporan, dan Closing
// (services/ledgerPeriodService.js lewat loadMonthlyCashFlow), jadi angka di sini selalu sinkron.
const { loadMonthlyCashFlow } = require('./operationalCashFlowService');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const num = v => Number(v || 0);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

async function safe(warnings, label, fallback, fn) {
  try { return await fn(); } catch (err) { warnings.push(`${label}: ${err.message}`); return fallback; }
}

async function getMonthlyPerformance(db, { year, month }) {
  const warnings = [];
  const [invoiceRows, onTimeRows, methodRows, closingRows, cashRows, siteRows] = await Promise.all([
    safe(warnings, 'tagihan', [], async () => (await db.execute(
      `SELECT i.period_month m, COUNT(*) n, COALESCE(SUM(i.total),0) total, COALESCE(SUM(i.paid_amount),0) paid,
              COALESCE(SUM(i.outstanding),0) outstanding, SUM(i.status='paid') paid_n
         FROM invoices i WHERE i.period_year=? AND i.status<>'cancelled' GROUP BY i.period_month`, [year]))[0]),
    safe(warnings, 'ketepatan bayar', [], async () => (await db.execute(
      `SELECT i.period_month m, COUNT(*) on_time FROM invoices i
        WHERE i.period_year=? AND i.status='paid' AND i.due_date IS NOT NULL
          AND (SELECT DATE(MAX(p.paid_at)) FROM payments p WHERE p.invoice_id=i.id AND p.status='confirmed') <= i.due_date
        GROUP BY i.period_month`, [year]))[0]),
    safe(warnings, 'metode bayar', [], async () => (await db.execute(
      `SELECT i.period_month m, p.method, COALESCE(SUM(p.amount),0) total FROM payments p JOIN invoices i ON i.id=p.invoice_id
        WHERE i.period_year=? AND p.status='confirmed' GROUP BY i.period_month, p.method`, [year]))[0]),
    safe(warnings, 'status closing', [], async () => (await db.execute(
      `SELECT period_start, status FROM closing_periods WHERE YEAR(period_start)=?`, [year]))[0]),
    safe(warnings, 'arus kas', [], () => loadMonthlyCashFlow({ db, start: `${year}-01-01`, end: `${year}-12-31` })),
    safe(warnings, 'per site', [], async () => (await db.execute(
      `SELECT s.code site, COUNT(*) n, COALESCE(SUM(i.total),0) total, COALESCE(SUM(i.paid_amount),0) paid, COALESCE(SUM(i.outstanding),0) outstanding
         FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id
        WHERE i.period_year=? AND i.period_month=? AND i.status<>'cancelled' GROUP BY s.code`, [year, month]))[0])
  ]);

  const months = MONTHS.map((label, i) => ({ month: i + 1, label, invoices: 0, billed: 0, paid: 0, outstanding: 0, paidCount: 0, onTime: 0, transfer: 0, cash: 0, income: 0, expense: 0, closing: null }));
  for (const r of invoiceRows) { const m = months[num(r.m) - 1]; if (!m) continue; m.invoices = num(r.n); m.billed = num(r.total); m.paid = num(r.paid); m.outstanding = num(r.outstanding); m.paidCount = num(r.paid_n); }
  for (const r of onTimeRows) { const m = months[num(r.m) - 1]; if (m) m.onTime = num(r.on_time); }
  for (const r of methodRows) { const m = months[num(r.m) - 1]; if (!m) continue; if (r.method === 'cash') m.cash += num(r.total); else m.transfer += num(r.total); }
  for (const r of cashRows) { const key = String(r.month_key || ''); if (Number(key.slice(0, 4)) !== year) continue; const m = months[Number(key.slice(5, 7)) - 1]; if (m) { m.income = num(r.inflow); m.expense = num(r.outflow); } }
  for (const r of closingRows) { const d = r.period_start instanceof Date ? r.period_start : new Date(r.period_start); const m = months[d.getMonth()]; if (m) m.closing = r.status === 'LOCKED' ? 'LOCKED' : 'DRAFT'; }
  for (const m of months) { m.rate = pct(m.paid, m.billed); m.onTimeRate = pct(m.onTime, m.paidCount); m.net = m.income - m.expense; }

  const cur = months[month - 1], prev = month > 1 ? months[month - 2] : null;
  const delta = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10);
  const active = months.filter(m => m.billed > 0);
  const best = active.length ? active.reduce((a, b) => ((b.rate || 0) > (a.rate || 0) ? b : a)) : null;
  const sites = siteRows.map(r => ({ site: r.site, invoices: num(r.n), billed: num(r.total), paid: num(r.paid), outstanding: num(r.outstanding), rate: pct(num(r.paid), num(r.total)) }))
    .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101));
  const maxBilled = Math.max(1, ...months.map(m => m.billed));
  const maxFlow = Math.max(1, ...months.map(m => Math.max(m.income, m.expense)));
  const totals = months.reduce((t, m) => ({ billed: t.billed + m.billed, paid: t.paid + m.paid, outstanding: t.outstanding + m.outstanding, income: t.income + m.income, expense: t.expense + m.expense }), { billed: 0, paid: 0, outstanding: 0, income: 0, expense: 0 });
  totals.rate = pct(totals.paid, totals.billed); totals.net = totals.income - totals.expense;

  return { year, month, months, cur, prev, rateDelta: delta(cur.rate, prev?.rate), netDelta: prev ? cur.net - prev.net : null, best, sites, maxBilled, maxFlow, totals, warnings };
}

module.exports = { getMonthlyPerformance, MONTHS };
