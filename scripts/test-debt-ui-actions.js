const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const view = fs.readFileSync(path.join(root, 'views/debts/index.ejs'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/debts.css'), 'utf8');

const checks = [
  [view.includes('class="module-head hp-header"') && view.includes('class="metric-grid hp-stats"'), 'header dan ringkasan memakai design system aplikasi'],
  [view.includes('class="filter-card debt-filter"') && view.includes('debt-standard-filter-grid'), 'filter memakai pola filter-card standar'],
  [view.includes('data-card hp-section debt-record-card') && view.includes('data-card hp-section debt-people-card'), 'daftar catatan dan teknisi memakai data-card standar'],
  [view.includes('data-action-popover-target="debtAction<%= row.id %>"'), 'setiap item memiliki tombol Aksi standar'],
  [view.includes('<b>Lihat Rincian</b>') && view.includes('<b>Catat Pembayaran</b>'), 'aksi detail dan pembayaran tersedia'],
  [view.includes('action="/debts/payments"') && view.includes('name="debt_id" id="debtPayDebtId"'), 'form pembayaran memakai endpoint stabil dan ID eksplisit'],
  [view.includes('data-debt-payment-trigger') && view.includes('preparePayment'), 'konteks pembayaran disiapkan sebelum modal ditampilkan'],
  [view.includes('<b>Edit</b>') && view.includes('<b>Hapus</b>') && view.includes('<b>Arsipkan</b>'), 'aksi edit, hapus, dan arsip tersedia'],
  [view.includes('isAdmin && row.status !== \'ARCHIVED\''), 'aksi administratif dibatasi untuk admin'],
  [view.includes('data-debt-switch-modal="#debtEditModal"') && view.includes('data-debt-switch-modal="#debtPayModal"'), 'aksi dari detail memakai transisi modal aman'],
  [view.includes("current.addEventListener('hidden.bs.modal',openTarget,{once:true})"), 'modal berikutnya menunggu modal detail tertutup'],
  [view.includes("document.querySelectorAll('.modal-backdrop').forEach(backdrop=>backdrop.remove())"), 'backdrop yatim dibersihkan'],
  [css.includes('.hp-row-actions .action-menu-labeled'), 'tombol Aksi memiliki layout desktop dan mobile'],
  [css.includes('.debt-standard-page.hp-page') && css.includes('.debt-standard-filter-grid'), 'lapisan konsistensi Hutang tersedia untuk desktop dan mobile']
];

for (const [valid, label] of checks) {
  if (!valid) throw new Error(`Validasi UI Hutang gagal: ${label}`);
}

const blank = () => ({ remaining: 0, overdue: 0, total: 0 });
const record = {
  id: 7, document_number: 'HP-202610-000007', scope: 'INTERNAL', record_type: 'RECEIVABLE',
  party_name: 'Teknisi Uji', employee_name: 'Teknisi Uji', employee_code: 'T-007', employee_position: 'Teknisi', linked_username: 'teknisi.uji',
  purpose: 'Material instalasi', site_code: 'CDS', principal_amount: 500000, paid_amount: 100000, remaining_amount: 400000,
  issue_date: '2026-10-01', due_date: '2026-10-31', payment_method: 'INSTALLMENT', installment_months: 2,
  responsible_name: 'Admin', notes: 'Fixture UI', status: 'ACTIVE', payment_status: 'DICICIL', is_overdue: false, days_to_due: 29,
  items: [{ item_name: 'Kabel', quantity: 1, unit_price: 500000, notes: null }],
  installments: [{ number: 1, dueDate: '2026-10-15', target: 250000, remaining: 150000, status: 'PARTIAL' }],
  timeline: [{ kind: 'created', id: null, date: '2026-10-01', time: null, amount: 500000, method: null, notes: 'Material instalasi', hasProof: false, remainingAfter: 500000, entryStatus: 'DIBUAT' }]
};
const locals = {
  assetVersion: 'test', records: [record], techRows: [], people: [], today: '2026-10-02', csrfToken: 'test',
  summary: { DEBT: blank(), RECEIVABLE: blank(), INTERNAL: { DEBT: blank(), RECEIVABLE: blank() }, EXTERNAL: { DEBT: blank(), RECEIVABLE: blank() } },
  filters: { scope: '', type: '', status: 'ACTIVE', site: '', query: '', period: '', from: '', to: '', employee: 0 },
  formatDate: value => String(value || '-'), formatTime: () => '', statusLabel: value => String(value || '-')
};
const template = ejs.compile(view, { filename: path.join(root, 'views/debts/index.ejs') });
const adminHtml = template({ ...locals, isAdmin: true });
const staffHtml = template({ ...locals, isAdmin: false });
for (const match of adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);
if (!adminHtml.includes('<b>Edit</b>') || !adminHtml.includes('<b>Hapus</b>')) throw new Error('Validasi UI Hutang gagal: admin tidak mendapat aksi edit/hapus');
if (staffHtml.includes('<b>Edit</b>') || staffHtml.includes('<b>Hapus</b>')) throw new Error('Validasi UI Hutang gagal: aksi admin bocor ke staff');
if (!staffHtml.includes('<b>Lihat Rincian</b>') || !staffHtml.includes('<b>Catat Pembayaran</b>')) throw new Error('Validasi UI Hutang gagal: aksi operasional staff hilang');

console.log(`Debt UI actions validation passed: ${checks.length + 3} checks.`);
