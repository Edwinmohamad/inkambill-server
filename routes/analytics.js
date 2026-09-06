const express = require('express');
const ExcelJS = require('exceljs');
const { getAnalytics } = require('../services/analyticsService');
const { createReportPdf, rupiah } = require('../services/reportPdf');
const router = express.Router();

function queryParams(req) {
  return { siteCode: String(req.query.site || '').trim().toUpperCase(), month: req.query.month, year: req.query.year };
}

// Main dashboard page: Smart Overview, Analitik Keuangan & Cut-off, Analitik PSB & Infrastruktur.
router.get('/', async (req, res) => {
  const data = await getAnalytics(queryParams(req));
  res.render('analytics/index', { title: 'Analitik Keuangan & PSB', ...data });
});

// JSON endpoint powering the "Generate Laporan Analitik" modal — always
// re-queried fresh so Download/Print/WA-to-owner reflect the latest numbers.
// ?download=1 forces a file-download response instead of an inline JSON body.
router.get('/export-report', async (req, res) => {
  const data = await getAnalytics(queryParams(req));
  const report = data.report;
  if (String(req.query.download || '') === '1') {
    const filename = `analitik-${data.selectedSiteCode || 'semua-site'}-${data.month}-${data.year}.json`.toLowerCase();
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  res.set('Cache-Control', 'no-store').json({ ok: true, isDummy: data.isDummy, report });
});

router.get('/export.pdf', async (req, res) => {
  const data = await getAnalytics(queryParams(req));
  const rows = (data.aging || []).map(row => ({ customer: `${row.customer_name} (${row.customer_code})`, site: row.site_code, due: row.oldest_due, overdue: `${Number(row.days_overdue || 0)} hari`, outstanding: rupiah(row.outstanding), status: row.siapIsolir ? 'Siap Isolir' : 'Review' }));
  return createReportPdf(res, {
    title: 'Laporan Analitik Operasional',
    subtitle: `${data.selectedSiteName} · ${data.month}/${data.year} · ${data.cutoff.label}`,
    filename: `analitik-${data.selectedSiteCode || 'semua-site'}-${data.month}-${data.year}.pdf`.toLowerCase(),
    watermark: 'INKAMNET · ANALYTICS',
    summaryItems: [
      { label: 'MRR', value: rupiah(data.kpis.mrr), color: '#603AEA' },
      { label: 'Kas Cut-off', value: rupiah(data.kpis.cashRealizationCutoff), color: '#18A979' },
      { label: 'Pelanggan Aktif', value: String(data.kpis.activeCustomers), color: '#3478F6' },
      { label: 'Churn Rate', value: `${data.kpis.churnRate}%`, color: '#FF433E' },
      { label: 'Proyeksi Net', value: rupiah(data.projection?.projectedNet), color: '#18A979' }
    ],
    columns: [
      { label: 'Pelanggan', key: 'customer', width: 3, bold: true },
      { label: 'Site', key: 'site', width: 1 },
      { label: 'Jatuh Tempo', key: 'due', width: 1.2 },
      { label: 'Umur', key: 'overdue', width: 1 },
      { label: 'Outstanding', key: 'outstanding', width: 1.5, align: 'right' },
      { label: 'Status', key: 'status', width: 1.2 }
    ],
    rows,
    layout: 'landscape'
  });
});

router.get('/export.xlsx', async (req, res) => {
  const data = await getAnalytics(queryParams(req));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INKAMNET Control Center';
  const sheet = workbook.addWorksheet('Ringkasan');
  sheet.columns = [{ header: 'Metrik', key: 'metric', width: 28 }, { header: 'Nilai', key: 'value', width: 24 }];
  sheet.addRows([
    { metric: 'Site', value: data.selectedSiteName }, { metric: 'Periode', value: `${data.month}/${data.year}` },
    { metric: 'MRR', value: Number(data.kpis.mrr) }, { metric: 'Kas cut-off', value: Number(data.kpis.cashRealizationCutoff) },
    { metric: 'Pelanggan aktif', value: Number(data.kpis.activeCustomers) }, { metric: 'Churn rate (%)', value: Number(data.kpis.churnRate) },
    { metric: 'Proyeksi inflow', value: Number(data.projection?.projectedInflow || 0) }, { metric: 'Proyeksi outflow', value: Number(data.projection?.projectedOutflow || 0) }, { metric: 'Proyeksi net', value: Number(data.projection?.projectedNet || 0) }
  ]);
  const aging = workbook.addWorksheet('Aging Piutang');
  aging.columns = [{ header: 'Kode', key: 'code', width: 16 }, { header: 'Pelanggan', key: 'name', width: 28 }, { header: 'Site', key: 'site', width: 12 }, { header: 'Jatuh Tempo', key: 'due', width: 16 }, { header: 'Hari', key: 'days', width: 10 }, { header: 'Outstanding', key: 'outstanding', width: 18 }, { header: 'Siap Isolir', key: 'isolate', width: 14 }];
  aging.addRows((data.aging || []).map(row => ({ code: row.customer_code, name: row.customer_name, site: row.site_code, due: row.oldest_due, days: Number(row.days_overdue || 0), outstanding: Number(row.outstanding || 0), isolate: row.siapIsolir ? 'YA' : 'TIDAK' })));
  const churn = workbook.addWorksheet('Churn');
  churn.columns = [{ header: 'Alasan', key: 'reason', width: 30 }, { header: 'Jumlah', key: 'total', width: 12 }];
  churn.addRows(data.churnReasons || []);
  for (const ws of workbook.worksheets) { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A3150' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; }
  const filename = `analitik-${data.selectedSiteCode || 'semua-site'}-${data.month}-${data.year}.xlsx`.toLowerCase();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
