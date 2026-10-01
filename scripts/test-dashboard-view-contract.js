const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes/dashboard.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/dashboard/index.ejs'), 'utf8');
const checks = [
  [view.includes('const bm=billingMonitor'), 'view memakai billingMonitor'],
  [route.includes('loadDashboardBillingMonitor'), 'route memuat billing monitor'],
  [route.includes('billingMonitor,billingMonth'), 'route mengirim billingMonitor ke view'],
  [route.includes('selectedMonth,selectedYear,selectedCycle,trendMonths'), 'route mengirim filter cycle dan trend'],
  [route.includes('emptyBillingMonitor'), 'fallback Dashboard bila monitor billing gagal'],
  [view.includes('selectedCycle') && view.includes('trendMonths'), 'view filter cycle dan trend tersedia']
];
for (const [valid, label] of checks) if (!valid) throw new Error(`Kontrak Dashboard gagal: ${label}`);
console.log(`Dashboard view-contract validation passed: ${checks.length} checks.`);
