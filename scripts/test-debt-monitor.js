const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes/debts.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'services/schemaService.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/debts/index.ejs'), 'utf8');
const layout = fs.readFileSync(path.join(root, 'views/partials/layout.ejs'), 'utf8');

const checks = [
  [schema.includes('async function ensureV40Schema()'), 'schema V40'],
  [schema.includes('finance_debts') && schema.includes('finance_debt_payments'), 'tabel hutang dan pembayaran'],
  [schema.includes('finance_debt_items') && schema.includes('installment_months'), 'rincian pembelian dan durasi cicilan'],
  [app.includes("app.use('/debts', requireAuth, requirePermission('finance')"), 'route wajib login dan izin finance'],
  [app.includes('await ensureV40Schema()'), 'bootstrap schema'],
  [layout.includes('Hutang & Piutang') && layout.includes('href="/debts"'), 'navigasi keuangan'],
  [route.includes("router.post('/:id/payments'") && route.includes('FOR UPDATE'), 'pembayaran transaksional'],
  [route.includes('if (paid > remaining)'), 'proteksi kelebihan pembayaran'],
  [route.includes("router.post('/:id/payments/:paymentId/delete'") && route.includes('await refreshStatus(conn, id)'), 'koreksi pembayaran dan hitung ulang'],
  [route.includes("status='ARCHIVED'"), 'arsip non-destruktif'],
  [view.includes('Sisa Hutang') && view.includes('Sisa Piutang') && view.includes('Lewat Jatuh Tempo'), 'ringkasan monitoring'],
  [route.includes('function installmentSchedule(record)') && view.includes('Rincian & jadwal cicilan'), 'jadwal cicilan otomatis'],
  [view.includes('debtItemTemplate') && view.includes('Total otomatis'), 'input rincian item dinamis'],
  [view.includes('tidak otomatis masuk ke Closing'), 'proteksi hitung ganda'],
  [view.includes('debt-page-v2') && view.includes('debt-money-grid'), 'layout profesional dan kolom nominal'],
  [view.includes('data-debt-search') && view.includes("search?.addEventListener('input'"), 'pencarian instan'],
  [view.includes('data-auto-filter') && view.includes('debt-filter-reset'), 'filter otomatis dan reset']
];

for (const [valid, label] of checks) if (!valid) throw new Error(`Validasi Hutang gagal: ${label}`);
console.log(`Debt monitor validation passed: ${checks.length} checks.`);
