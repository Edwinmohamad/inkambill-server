const db = require('../config/db');

async function ensureProcurementSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS warehouse_shopping_lists (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    supplier_id BIGINT UNSIGNED NULL,
    destination_site_id BIGINT UNSIGNED NULL,
    notes TEXT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_wh_list_active(is_active,updated_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS warehouse_shopping_list_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    shopping_list_id BIGINT UNSIGNED NOT NULL,
    item_id BIGINT UNSIGNED NOT NULL,
    default_qty DECIMAL(14,2) NOT NULL DEFAULT 1,
    price_hint DECIMAL(14,2) NOT NULL DEFAULT 0,
    notes VARCHAR(255) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_wh_list_item(shopping_list_id,item_id),
    INDEX idx_wh_list_items(shopping_list_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS warehouse_purchases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    document_no VARCHAR(50) NULL,
    supplier_id BIGINT UNSIGNED NULL,
    source_type ENUM('pandawa','online','supplier_other') NOT NULL DEFAULT 'pandawa',
    marketplace VARCHAR(100) NULL,
    shop_name VARCHAR(160) NULL,
    external_invoice_no VARCHAR(120) NULL,
    destination_site_id BIGINT UNSIGNED NOT NULL,
    payer_site_id BIGINT UNSIGNED NULL,
    purchase_date DATE NOT NULL,
    payment_type ENUM('cash','transfer','credit','partial') NOT NULL DEFAULT 'cash',
    status ENUM('draft','received','cancelled') NOT NULL DEFAULT 'draft',
    subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    shipping_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    grand_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    paid_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    due_date DATE NULL,
    notes TEXT NULL,
    cash_transaction_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL,
    received_by BIGINT UNSIGNED NULL,
    received_at DATETIME NULL,
    cancelled_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wh_purchase_doc(document_no),
    INDEX idx_wh_purchase_status(status,purchase_date),
    INDEX idx_wh_purchase_supplier(supplier_id,purchase_date)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS warehouse_purchase_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    purchase_id BIGINT UNSIGNED NOT NULL,
    item_id BIGINT UNSIGNED NOT NULL,
    destination_item_id BIGINT UNSIGNED NULL,
    item_name VARCHAR(180) NOT NULL,
    item_code VARCHAR(100) NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'pcs',
    qty DECIMAL(14,2) NOT NULL,
    unit_price DECIMAL(14,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
    received_qty DECIMAL(14,2) NOT NULL DEFAULT 0,
    INDEX idx_wh_purchase_items(purchase_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS warehouse_transfers (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    document_no VARCHAR(50) NULL,
    origin_site_id BIGINT UNSIGNED NOT NULL,
    destination_site_id BIGINT UNSIGNED NOT NULL,
    transfer_date DATE NOT NULL,
    status ENUM('draft','shipped','received','cancelled') NOT NULL DEFAULT 'draft',
    subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
    shipping_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    grand_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    internal_transfer_key VARCHAR(80) NULL,
    cash_expense_id BIGINT UNSIGNED NULL,
    cash_income_id BIGINT UNSIGNED NULL,
    notes TEXT NULL,
    created_by BIGINT UNSIGNED NULL,
    received_by BIGINT UNSIGNED NULL,
    received_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wh_transfer_doc(document_no),
    UNIQUE KEY uq_wh_transfer_key(internal_transfer_key),
    INDEX idx_wh_transfer_status(status,transfer_date)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transfer_id BIGINT UNSIGNED NOT NULL,
    origin_item_id BIGINT UNSIGNED NOT NULL,
    destination_item_id BIGINT UNSIGNED NULL,
    item_name VARCHAR(180) NOT NULL,
    item_code VARCHAR(100) NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'pcs',
    qty DECIMAL(14,2) NOT NULL,
    unit_price DECIMAL(14,2) NOT NULL DEFAULT 0,
    subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
    INDEX idx_wh_transfer_items(transfer_id)
  )`);

  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS warehouse_purchase_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS warehouse_transfer_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS internal_transfer_key VARCHAR(80) NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_wh_purchase ON cash_transactions(warehouse_purchase_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cash_wh_transfer ON cash_transactions(warehouse_transfer_id)`);

  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'WHBUY','Pembelian Barang Gudang','expense','Pengeluaran otomatis dari faktur pembelian/penerimaan gudang',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='WHBUY')`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'WHTROUT','Transfer Barang Masuk Site','expense','Pengeluaran internal site penerima transfer barang',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='WHTROUT')`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'WHTRIN','Transfer Barang Keluar Site','income','Pendapatan internal site pengirim transfer barang',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='WHTRIN')`);
}

module.exports = { ensureProcurementSchema };
