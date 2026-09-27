const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const schema = read('services/procurementSchema.js');
const routes = read('routes/procurement.js');
const finance = read('routes/finance.js');
const reports = read('routes/reports.js');
const view = read('views/inventory/procurement.ejs');

for (const table of ['warehouse_shopping_lists', 'warehouse_shopping_list_items', 'warehouse_purchases', 'warehouse_purchase_items', 'warehouse_transfers', 'warehouse_transfer_items']) {
  assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Schema ${table} wajib tersedia`);
}
for (const code of ['WHBUY', 'WHTROUT', 'WHTRIN']) assert(schema.includes(code), `Kategori kas ${code} wajib tersedia`);
assert(routes.includes("approval_status,created_by,warehouse_purchase_id,warehouse_transfer_id,internal_transfer_key"), 'Integrasi Data Kas harus menyimpan referensi dokumen gudang');
assert(routes.includes("INSERT INTO inventory_movements"), 'Penerimaan/transfer wajib membuat audit pergerakan stok');
assert(routes.includes("FOR UPDATE"), 'Perubahan stok wajib memakai row lock');
assert(routes.includes("status === 'received'"), 'Penerimaan harus idempoten');
assert(finance.includes("Transaksi transfer internal dikunci sebagai pasangan"), 'Data Kas harus mengunci edit pasangan internal');
assert(finance.includes("ct.internal_transfer_key IS NULL"), 'Ringkasan konsolidasi harus mengeliminasi transfer internal');
assert(reports.includes("ct.internal_transfer_key IS NULL"), 'Laporan konsolidasi harus mengeliminasi transfer internal');
for (const tab of ['overview', 'purchase', 'lists', 'transfer']) assert(view.includes(`data-proc-pane="${tab}"`), `Pane UI ${tab} wajib tersedia`);
assert(view.includes('data-use-list'), 'Shopping List permanen harus dapat dipakai kembali');
assert(view.includes('data-grand-total'), 'Nominal faktur harus dihitung real-time');

console.log('Procurement regression test OK: shopping list, purchase invoice, stock, transfer, and consolidated cash guards.');
