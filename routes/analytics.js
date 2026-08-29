const express = require('express');
const { getAnalytics } = require('../services/analyticsService');
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

module.exports = router;
