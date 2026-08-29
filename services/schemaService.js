const db = require('../config/db');
const { validateWhatsapp } = require('./whatsappService');

async function ensureV14Schema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ticket_updates (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT UNSIGNED NOT NULL,
      progress_date DATE NOT NULL,
      progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      status ENUM('open','progress','pending','closed') NOT NULL DEFAULT 'progress',
      note TEXT NOT NULL,
      updated_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ticket_updates_ticket(ticket_id),
      INDEX idx_ticket_updates_date(progress_date),
      CONSTRAINT fk_ticket_updates_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )
  `);
}

async function ensureV15Schema() {
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_language ENUM('id','en') NOT NULL DEFAULT 'id' AFTER default_theme`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo VARCHAR(255) NULL AFTER role`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS sales_id BIGINT UNSIGNED NULL AFTER cluster_id`);
  await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_employee_id BIGINT UNSIGNED NULL AFTER assigned_to`);
  await db.query(`ALTER TABLE technician_schedules ADD COLUMN IF NOT EXISTS technician_employee_id BIGINT UNSIGNED NULL AFTER technician_id`);

  await db.query(`CREATE TABLE IF NOT EXISTS departments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(30) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    description TEXT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS positions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id BIGINT UNSIGNED NULL,
    code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    category ENUM('sales','technical','admin','management','finance','other') NOT NULL DEFAULT 'other',
    description TEXT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_position_department(department_id),
    CONSTRAINT fk_position_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS employees (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    employee_code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) NULL,
    phone VARCHAR(50) NULL,
    department_id BIGINT UNSIGNED NULL,
    position_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    joined_at DATE NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_employee_name(name), INDEX idx_employee_department(department_id), INDEX idx_employee_position(position_id), INDEX idx_employee_user(user_id),
    CONSTRAINT fk_employee_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_employee_position FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE SET NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS banks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bank_name VARCHAR(120) NOT NULL,
    account_name VARCHAR(180) NOT NULL,
    account_number VARCHAR(80) NOT NULL,
    type ENUM('bank_transfer','cash','virtual_account','other') NOT NULL DEFAULT 'bank_transfer',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS payment_gateways (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    provider VARCHAR(120) NULL,
    channel VARCHAR(80) NULL,
    status ENUM('active','inactive','testing') NOT NULL DEFAULT 'inactive',
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS role_permissions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role_key VARCHAR(50) NOT NULL UNIQUE,
    role_name VARCHAR(100) NOT NULL,
    permissions_json JSON NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`INSERT IGNORE INTO departments(code,name,description) VALUES
    ('OPS','Operasional','Operasional jaringan, support dan administrasi'),
    ('COM','Komersial','Sales, akuisisi dan hubungan pelanggan'),
    ('FIN','Keuangan','Kas, billing dan rekonsiliasi'),
    ('MGT','Manajemen','Pengelolaan dan pengambilan keputusan')`);

  await db.query(`INSERT IGNORE INTO positions(department_id,code,name,category) VALUES
    ((SELECT id FROM departments WHERE code='COM'),'SALES','Sales','sales'),
    ((SELECT id FROM departments WHERE code='OPS'),'TECH-SUPPORT','Technical Support','technical'),
    ((SELECT id FROM departments WHERE code='OPS'),'ADMIN-OPS','Admin Operasional','admin'),
    ((SELECT id FROM departments WHERE code='OPS'),'NOC','NOC / Network','technical'),
    ((SELECT id FROM departments WHERE code='MGT'),'MANAGEMENT','Management','management'),
    ((SELECT id FROM departments WHERE code='FIN'),'FINANCE','Finance / Billing','finance'),
    ((SELECT id FROM departments WHERE code='OPS'),'HELPER-TECH','Helper Teknisi','technical')`);

  await db.query(`INSERT IGNORE INTO role_permissions(role_key,role_name,permissions_json) VALUES
    ('admin','Administrator',JSON_ARRAY('dashboard','customers','billing','finance','network','tickets','reports','settings')),
    ('staff','Staff',JSON_ARRAY('dashboard','customers','billing','tickets','reports'))`);

  // Make every existing login account available in the employee directory without guessing a department/position.
  await db.query(`INSERT IGNORE INTO employees(employee_code,name,user_id,is_active)
    SELECT CONCAT('USR-',LPAD(u.id,4,'0')),u.name,u.id,u.is_active
    FROM users u LEFT JOIN employees e ON e.user_id=u.id
    WHERE e.id IS NULL`);

  // Preserve existing ticket PIC by linking the corresponding employee record when possible.
  await db.query(`UPDATE tickets t JOIN employees e ON e.user_id=t.assigned_to SET t.assigned_employee_id=e.id WHERE t.assigned_employee_id IS NULL AND t.assigned_to IS NOT NULL`);
  await db.query(`UPDATE technician_schedules ts JOIN employees e ON e.user_id=ts.technician_id SET ts.technician_employee_id=e.id WHERE ts.technician_employee_id IS NULL AND ts.technician_id IS NOT NULL`);
}


async function ensureV16Schema() {
  await db.query(`ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS code VARCHAR(20) NULL AFTER name`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS transaction_code VARCHAR(60) NULL AFTER id`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS proof_path VARCHAR(255) NULL AFTER notes`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS proof_original_name VARCHAR(255) NULL AFTER proof_path`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS proof_mime VARCHAR(100) NULL AFTER proof_original_name`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS proof_size BIGINT UNSIGNED NULL AFTER proof_mime`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS proof_uploaded_by BIGINT UNSIGNED NULL AFTER proof_size`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS proof_uploaded_at DATETIME NULL AFTER proof_uploaded_by`);

  await db.query(`UPDATE cash_categories SET code='BILL' WHERE name='Pendapatan Billing' AND (code IS NULL OR code='')`);
  await db.query(`UPDATE cash_categories SET code='SETOR' WHERE name='Setoran Cash Pelanggan' AND (code IS NULL OR code='')`);
  await db.query(`UPDATE cash_categories SET code='OPS' WHERE name='Pengeluaran Operasional' AND (code IS NULL OR code='')`);

  // Kategori pengeluaran/pemasukan dibuat manual dari menu Kategori Kas.
  // Hanya kategori sistem pembayaran yang tetap dipertahankan jika sudah ada.

  await db.query(`UPDATE cash_categories SET code=CONCAT('CAT',LPAD(id,3,'0')) WHERE code IS NULL OR code=''`);
  await db.query(`UPDATE cash_categories c JOIN (SELECT code,MIN(id) keep_id FROM cash_categories WHERE code IS NOT NULL AND code<>'' GROUP BY code HAVING COUNT(*)>1) d ON d.code=c.code SET c.code=CONCAT(LEFT(c.code,10),'-',LPAD(c.id,6,'0')) WHERE c.id<>d.keep_id`);
  await db.query(`ALTER TABLE cash_categories ADD UNIQUE INDEX IF NOT EXISTS uniq_cash_category_code(code)`);
  await db.query(`UPDATE cash_transactions SET transaction_code=CONCAT('LEG-',DATE_FORMAT(transaction_date,'%Y%m'),'-',LPAD(id,6,'0')) WHERE transaction_code IS NULL OR transaction_code=''`);
  await db.query(`ALTER TABLE cash_transactions ADD UNIQUE INDEX IF NOT EXISTS uniq_cash_transaction_code(transaction_code)`);
}

async function ensureV17Schema() {
  // Paket internet dapat dibedakan per site. Data lama tetap valid sebagai paket global (site_id NULL).
  await db.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS site_id BIGINT UNSIGNED NULL AFTER id`);
  await db.query(`ALTER TABLE packages ADD INDEX IF NOT EXISTS idx_packages_site(site_id)`);
}

async function ensureV18Schema() {
  // Lampiran foto ticket dan progress harian.
  await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachment_path VARCHAR(255) NULL AFTER description`);
  await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachment_original_name VARCHAR(255) NULL AFTER attachment_path`);
  await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(100) NULL AFTER attachment_original_name`);
  await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachment_size BIGINT UNSIGNED NULL AFTER attachment_mime`);
  await db.query(`ALTER TABLE ticket_updates ADD COLUMN IF NOT EXISTS attachment_path VARCHAR(255) NULL AFTER note`);
  await db.query(`ALTER TABLE ticket_updates ADD COLUMN IF NOT EXISTS attachment_original_name VARCHAR(255) NULL AFTER attachment_path`);
  await db.query(`ALTER TABLE ticket_updates ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(100) NULL AFTER attachment_original_name`);
  await db.query(`ALTER TABLE ticket_updates ADD COLUMN IF NOT EXISTS attachment_size BIGINT UNSIGNED NULL AFTER attachment_mime`);

  // Bukti piket server.
  await db.query(`ALTER TABLE server_duty_schedules ADD COLUMN IF NOT EXISTS proof_path VARCHAR(255) NULL AFTER notes`);
  await db.query(`ALTER TABLE server_duty_schedules ADD COLUMN IF NOT EXISTS proof_original_name VARCHAR(255) NULL AFTER proof_path`);
  await db.query(`ALTER TABLE server_duty_schedules ADD COLUMN IF NOT EXISTS proof_mime VARCHAR(100) NULL AFTER proof_original_name`);
  await db.query(`ALTER TABLE server_duty_schedules ADD COLUMN IF NOT EXISTS proof_size BIGINT UNSIGNED NULL AFTER proof_mime`);
  await db.query(`ALTER TABLE server_duty_schedules ADD COLUMN IF NOT EXISTS proof_uploaded_by BIGINT UNSIGNED NULL AFTER proof_size`);
  await db.query(`ALTER TABLE server_duty_schedules ADD COLUMN IF NOT EXISTS proof_uploaded_at DATETIME NULL AFTER proof_uploaded_by`);

  // Kategori kas yang terlihat di UI sepenuhnya manual. Kategori internal billing tetap ada hanya untuk integritas jurnal otomatis dan disembunyikan dari UI.
  await db.query(`ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS is_system TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active`);
  await db.query(`UPDATE cash_categories SET is_system=1 WHERE name IN ('Pendapatan Billing','Setoran Cash Pelanggan')`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'BILL','Pendapatan Billing','income','Kategori internal jurnal pembayaran pelanggan',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE name='Pendapatan Billing')`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'SETOR','Setoran Cash Pelanggan','income','Kategori internal setoran cash pelanggan',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE name='Setoran Cash Pelanggan')`);
  const [[legacyUsage]] = await db.query(`SELECT COUNT(*) total FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE cc.name='Pengeluaran Operasional'`);
  if (Number(legacyUsage.total||0) === 0) {
    await db.query(`DELETE FROM cash_categories WHERE name='Pengeluaran Operasional'`);
  } else {
    await db.query(`UPDATE cash_categories SET is_system=1,is_active=0 WHERE name='Pengeluaran Operasional'`);
  }
}


async function ensureV19Schema() {
  // v1.9: sumber pembelian kas + nomor referensi pembayaran otomatis untuk data lama yang masih kosong.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS purchase_channel ENUM('online','offline') NULL AFTER notes`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS purchase_shop_name VARCHAR(160) NULL AFTER purchase_channel`);
  await db.query(`UPDATE payments SET reference=CONCAT('PAY-',DATE_FORMAT(paid_at,'%Y%m%d'),'-',LPAD(id,6,'0')) WHERE reference IS NULL OR TRIM(reference)=''`);
}

async function ensureV20Schema() {
  // Identitas khusus invoice. Nilai kosong akan menggunakan identitas perusahaan lama sebagai fallback.
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_company_name VARCHAR(180) NULL AFTER company_tagline`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_address TEXT NULL AFTER invoice_company_name`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_phone VARCHAR(80) NULL AFTER invoice_address`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_email VARCHAR(150) NULL AFTER invoice_phone`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_website VARCHAR(180) NULL AFTER invoice_email`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_tax_id VARCHAR(100) NULL AFTER invoice_website`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_footer TEXT NULL AFTER invoice_tax_id`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS invoice_logo_path VARCHAR(255) NULL AFTER invoice_footer`);
  await db.query(`UPDATE settings SET
    invoice_company_name=COALESCE(NULLIF(invoice_company_name,''),company_name),
    invoice_address=COALESCE(NULLIF(invoice_address,''),company_address),
    invoice_phone=COALESCE(NULLIF(invoice_phone,''),company_phone),
    invoice_email=COALESCE(NULLIF(invoice_email,''),company_email),
    invoice_website=COALESCE(NULLIF(invoice_website,''),company_website),
    invoice_footer=COALESCE(NULLIF(invoice_footer,''),'Dokumen digital resmi. Tidak memerlukan tanda tangan basah.')
    WHERE id=1`);

  // Migrasi matriks lama sekali saja; edit admin setelah migrasi tidak akan ditimpa saat restart.
  await db.query(`ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS permission_schema_version TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER permissions_json`);
  await db.query(`UPDATE role_permissions SET permissions_json=JSON_ARRAY('dashboard','customers','billing','warehouse','support','network','finance','reports','logs','settings'),permission_schema_version=2 WHERE role_key='admin' AND permission_schema_version<2`);
  await db.query(`UPDATE role_permissions SET permissions_json=JSON_ARRAY('dashboard','customers','billing','support','reports'),permission_schema_version=2 WHERE role_key='staff' AND permission_schema_version<2`);
  await db.query(`UPDATE role_permissions SET permission_schema_version=2 WHERE permission_schema_version<2`);
}

async function ensureV21Schema() {
  // Role master admin harus dapat disimpan tanpa bergantung pada ENUM lama.
  await db.query(`ALTER TABLE users MODIFY COLUMN role VARCHAR(50) NOT NULL DEFAULT 'staff'`);
  await db.query(`INSERT INTO role_permissions(role_key,role_name,permissions_json,permission_schema_version)
    VALUES('master_admin','Master Admin',JSON_ARRAY('dashboard','customers','billing','warehouse','support','network','finance','reports','logs','settings'),3)
    ON DUPLICATE KEY UPDATE role_name='Master Admin',permissions_json=VALUES(permissions_json),permission_schema_version=3`);

  // Status perubahan dipakai untuk riwayat pelanggan isolir/nonaktif. Validasi WA ditempatkan di master pelanggan.
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS status_changed_at DATETIME NULL AFTER network_status`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_status ENUM('unverified','valid','invalid') NOT NULL DEFAULT 'unverified' AFTER phone`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_verified_at DATETIME NULL AFTER whatsapp_status`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_verified_by BIGINT UNSIGNED NULL AFTER whatsapp_verified_at`);
  await db.query(`UPDATE customers SET status_changed_at=COALESCE(status_changed_at,updated_at,created_at) WHERE status_changed_at IS NULL`);
}

async function ensureV22Schema() {
  // Preferensi palet disimpan terpisah dari mode gelap/terang agar keduanya dapat dipilih independen.
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS ui_palette ENUM('nebula','ocean','emerald','sunset','rose','ice') NOT NULL DEFAULT 'nebula' AFTER default_theme`);

  // Akun master bootstrap dibuat satu kali. Hash adalah bcrypt dari password awal yang diminta;
  // startup berikutnya tidak menimpa password sehingga tetap bisa diganti dari menu profil.
  const masterPasswordHash = '$2b$12$jWCDPPi4xfy9s2fb6mkdvOn3bt2yQH7662vO4mIsKgNPF6SWDzF1W';
  await db.execute(`INSERT INTO users(name,username,password_hash,role,is_active)
    SELECT 'Master Administrator','masteradminn',?,'master_admin',1
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE username='masteradminn')`, [masterPasswordHash]);
  await db.query(`UPDATE users SET role='master_admin',is_active=1 WHERE username='masteradminn'`);
  await db.query(`INSERT INTO employees(employee_code,name,user_id,is_active)
    SELECT CONCAT('USR-',LPAD(u.id,4,'0')),u.name,u.id,1 FROM users u
    WHERE u.username='masteradminn' AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id=u.id)`);
}

async function ensureV23Schema() {
  // Data vendor tersimpan terstruktur agar durasi jasa dapat diaudit dan dianalisis.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(180) NULL AFTER purchase_shop_name`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS vendor_duration DECIMAL(8,2) NULL AFTER vendor_name`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS vendor_duration_unit ENUM('hour','day') NULL AFTER vendor_duration`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'VENDOR','Vendor','expense','Jasa vendor atau tenaga eksternal',1,0
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='VENDOR' OR LOWER(name)='vendor')`);

  // Nomor WhatsApp dinormalisasi dan divalidasi sistem saat startup; tidak ada status manual.
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_normalized VARCHAR(24) NULL AFTER whatsapp_status`);
  const [customers] = await db.query(`SELECT id,phone,whatsapp_status,whatsapp_normalized,whatsapp_verified_at FROM customers`);
  for (let offset = 0; offset < customers.length; offset += 250) {
    const chunk = customers.slice(offset, offset + 250);
    for (const customer of chunk) {
      const result = validateWhatsapp(customer.phone);
      const nextStatus = result.valid ? 'valid' : 'invalid';
      if (customer.whatsapp_status === nextStatus && String(customer.whatsapp_normalized || '') === String(result.normalized || '') && customer.whatsapp_verified_at) continue;
      await db.execute(`UPDATE customers SET whatsapp_status=?,whatsapp_normalized=?,whatsapp_verified_at=NOW(),whatsapp_verified_by=NULL WHERE id=?`, [
        nextStatus, result.normalized, customer.id
      ]);
    }
  }
}

async function ensureV24Schema() {
  // v1.14: reset satu kali sesuai kredensial yang diminta pengguna. Marker migrasi mencegah
  // restart aplikasi menimpa password yang nantinya sudah diganti dari menu profil.
  const validBootstrapHash = '$2b$12$jWCDPPi4xfy9s2fb6mkdvOn3bt2yQH7662vO4mIsKgNPF6SWDzF1W';
  await db.query(`CREATE TABLE IF NOT EXISTS schema_revisions (
    revision_key VARCHAR(100) PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`UPDATE users u LEFT JOIN schema_revisions r ON r.revision_key='v24_masteradmin_password_reset'
    SET u.password_hash=? WHERE u.username='masteradminn' AND r.revision_key IS NULL`, [validBootstrapHash]);
  await db.execute(`INSERT INTO users(name,username,password_hash,role,is_active)
    SELECT 'Master Administrator','masteradminn',?,'master_admin',1
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE username='masteradminn')`, [validBootstrapHash]);
  await db.query(`INSERT IGNORE INTO schema_revisions(revision_key) VALUES('v24_masteradmin_password_reset')`);

  // Kedua akun yang diminta menjadi Master Admin aktif. Pencocokan Edwin dibuat exact
  // (bukan LIKE) agar tidak menaikkan hak akun lain yang kebetulan memiliki nama serupa.
  await db.query(`UPDATE users SET role='master_admin',is_active=1
    WHERE username='masteradminn' OR LOWER(TRIM(username))='edwin' OR LOWER(TRIM(name))='edwin'`);
  await db.query(`INSERT INTO role_permissions(role_key,role_name,permissions_json,permission_schema_version)
    VALUES('master_admin','Master Admin',JSON_ARRAY('dashboard','customers','billing','warehouse','support','network','finance','reports','logs','settings'),4)
    ON DUPLICATE KEY UPDATE role_name='Master Admin',permissions_json=VALUES(permissions_json),permission_schema_version=4`);
  await db.query(`INSERT INTO employees(employee_code,name,user_id,is_active)
    SELECT CONCAT('USR-',LPAD(u.id,4,'0')),u.name,u.id,1 FROM users u
    WHERE (u.username='masteradminn' OR LOWER(TRIM(u.username))='edwin' OR LOWER(TRIM(u.name))='edwin')
      AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id=u.id)`);
  await db.query(`UPDATE employees e JOIN users u ON u.id=e.user_id SET e.is_active=1
    WHERE u.username='masteradminn' OR LOWER(TRIM(u.username))='edwin' OR LOWER(TRIM(u.name))='edwin'`);
}

async function ensureV25Schema() {
  // Pesan internal disimpan per penerima sehingga badge unread tetap konsisten
  // walaupun user membuka aplikasi dari perangkat berbeda.
  await db.query(`CREATE TABLE IF NOT EXISTS internal_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sender_id BIGINT UNSIGNED NOT NULL,
    recipient_id BIGINT UNSIGNED NOT NULL,
    subject VARCHAR(140) NOT NULL,
    body TEXT NOT NULL,
    read_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_internal_messages_recipient (recipient_id,read_at,created_at),
    INDEX idx_internal_messages_sender (sender_id,created_at)
  )`);
  await db.query(`UPDATE role_permissions SET permission_schema_version=5 WHERE permission_schema_version<5`);
}


async function ensureV26Schema() {
  // v1.17: alasan reject tersimpan terstruktur dan notifikasi operasional bersifat persisten.
  await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500) NULL AFTER notes`);
  await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS rejected_by BIGINT UNSIGNED NULL AFTER rejection_reason`);
  await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS rejected_at DATETIME NULL AFTER rejected_by`);
  await db.query(`CREATE TABLE IF NOT EXISTS system_notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    recipient_id BIGINT UNSIGNED NOT NULL,
    type VARCHAR(60) NOT NULL,
    tone VARCHAR(20) NOT NULL DEFAULT 'info',
    icon VARCHAR(80) NOT NULL DEFAULT 'bi-bell-fill',
    title VARCHAR(180) NOT NULL,
    detail VARCHAR(700) NULL,
    href VARCHAR(500) NULL,
    entity_type VARCHAR(60) NULL,
    entity_id BIGINT UNSIGNED NULL,
    read_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_system_notifications_recipient (recipient_id,read_at,created_at),
    INDEX idx_system_notifications_entity (entity_type,entity_id)
  )`);
}


async function ensureV27Schema() {
  // v1.19: manual cash entries require explicit Master Admin approval before they enter real finance totals.
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_status ENUM('PENDING_APPROVAL','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED' AFTER source_type`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS approval_reason VARCHAR(500) NULL AFTER approval_status`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS reviewed_by BIGINT UNSIGNED NULL AFTER approval_reason`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL AFTER reviewed_by`);
  await db.query(`ALTER TABLE cash_transactions ADD INDEX IF NOT EXISTS idx_cash_approval_status(approval_status)`);

  // Login events power the dashboard activity ticker without changing authentication behavior.
  await db.query(`CREATE TABLE IF NOT EXISTS user_login_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    logged_in_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    INDEX idx_user_login_events_user (user_id,logged_in_at),
    INDEX idx_user_login_events_time (logged_in_at)
  )`);
}

async function ensureV29Schema() {
  // v1.20 — Archive (soft-delete) columns for the Arsip vs Hapus Permanen workflow.
  // Archiving only sets archived_at (financial/history data is never touched); Restore
  // clears it. Hard delete stays a completely separate, guarded action per entity route.
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL AFTER status_changed_at`);
  await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL`);
  await db.query(`ALTER TABLE clusters ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL`);
  await db.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL`);
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS archived_at DATETIME NULL`);
  await db.query(`ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_customers_archived (archived_at)`);
  await db.query(`ALTER TABLE invoices ADD INDEX IF NOT EXISTS idx_invoices_archived (archived_at)`);
  await db.query(`ALTER TABLE clusters ADD INDEX IF NOT EXISTS idx_clusters_archived (archived_at)`);
  // Backfill: customers already archived under the old "terminated + no undo" flow become
  // visible in the new "Data Diarsip" tab immediately, instead of silently disappearing.
  await db.query(`UPDATE customers SET archived_at=COALESCE(status_changed_at,NOW()) WHERE customer_status='terminated' AND archived_at IS NULL`);
}

async function ensureV30Schema() {
  // v1.23 — WA Gateway (Baileys self-hosted). wa_messages is the outbound queue + audit log for every
  // message the gateway sends (manual / bulk blast / scheduled auto-reminder). Session credentials
  // themselves live on disk (storage/wa-session), never in the database.
  await db.query(`CREATE TABLE IF NOT EXISTS wa_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NULL,
    invoice_id BIGINT UNSIGNED NULL,
    phone VARCHAR(32) NOT NULL,
    message TEXT NOT NULL,
    message_type ENUM('manual','blast','auto_reminder') NOT NULL DEFAULT 'manual',
    status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
    error_message VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    INDEX idx_wa_messages_status (status),
    INDEX idx_wa_messages_created (created_at),
    INDEX idx_wa_messages_invoice_type (invoice_id,message_type,created_at)
  )`);

  // Single-row settings extension: auto-reminder scheduling config. Offsets are comma-separated days
  // relative to invoices.due_date (negative = before, 0 = on due date), e.g. '-3,-1,0'.
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_auto_reminder_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER default_grace_days`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_auto_reminder_hour TINYINT UNSIGNED NOT NULL DEFAULT 9 AFTER wa_auto_reminder_enabled`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_auto_reminder_offsets VARCHAR(50) NOT NULL DEFAULT '-3,-1,0' AFTER wa_auto_reminder_hour`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_auto_reminder_last_run_date DATE NULL AFTER wa_auto_reminder_offsets`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_auto_reminder_template TEXT NULL AFTER wa_auto_reminder_last_run_date`);
}

async function ensureV31Schema() {
  // v1.24.8 — "Wajib Bulanan" flag on cash_categories, requested after reviewing the user's real cash
  // flow export from their old billing system (WifiNetBill). That export showed a clear pattern: Sewa
  // (kontrakan), Listrik & Utilitas, and Operasional Jaringan (bandwidth/ISP) recur every month at
  // roughly the same amount per site, while everything else (Petty Cash, Maintenance, Transportasi,
  // Vendor, dll) is ad-hoc/variable. This column powers the "Checklist Pengeluaran Wajib Bulan Ini"
  // panel on the Data Kas page (views/finance/cash.ejs) — no separate template/due-date table needed,
  // it just cross-references active sites x mandatory categories against this month's cash_transactions.
  // v1.25 audit fix: this whole function re-runs on EVERY app boot (app.js awaits every ensureVXXSchema
  // in sequence with no "already migrated" gate), so the auto-flag UPDATE below used to silently re-flip
  // is_recurring_mandatory back to 1 on every restart even after an admin deliberately unchecked "Wajib
  // Bulanan" on one of these categories via Edit. Fix: only run the one-time auto-flag the very first
  // time this migration adds the column (fresh install / first upgrade) — check information_schema
  // BEFORE the ADD COLUMN IF NOT EXISTS so we know whether the column pre-existed. After that first run,
  // is_recurring_mandatory is fully admin-owned via the Edit modal and this function never touches it again.
  const [[colCheck]]=await db.query(`SELECT COUNT(*) cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cash_categories' AND COLUMN_NAME='is_recurring_mandatory'`);
  const columnAlreadyExisted=Number(colCheck.cnt)>0;
  await db.query(`ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS is_recurring_mandatory TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active`);
  if(!columnAlreadyExisted){
    // Auto-flag the three categories that matched the recurring pattern in the user's real data, but only
    // if they already exist with these exact names (categories in this app are user-created, not seeded —
    // see the "Contoh kategori" guide on the Kategori Kas page, which suggests these same names). Existing
    // installs get a sensible default; anything named differently can still be flagged manually via Edit.
    await db.query(`UPDATE cash_categories SET is_recurring_mandatory=1
      WHERE COALESCE(is_system,0)=0 AND type='expense'
        AND name IN ('Sewa','Listrik & Utilitas','Operasional Jaringan','Bandwidth / ISP')`);
  }

  // "Kasbon Karyawan" showed up as its own distinct category in the user's old system (cash advances to
  // staff, e.g. "KSB_Ali_Juli") with no equivalent in the suggested category list here — added as a real
  // (non-mandatory, ad-hoc) expense category so it doesn't get lumped into Petty Cash.
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system,is_recurring_mandatory)
    SELECT 'KASBON','Kasbon Karyawan','expense','Uang muka / pinjaman ke karyawan, dipotong dari gaji atau fee berikutnya',1,0,0
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='KASBON' OR LOWER(name)='kasbon karyawan')`);
}

async function ensureV32Schema() {
  // v1.25.1 — user reported the "Diskon" catalog (menu Keuangan → Diskon) had no way to actually be
  // attached to a customer, so a discount created there never affected any bill. Adds an OPTIONAL
  // per-customer discount link: customers.discount_id points at a discounts row, consumed by
  // services/invoiceService.js when generating each month's invoice (reduces subtotal → total/outstanding,
  // stored on invoices.discount so it still shows on the printed invoice like before). Nullable / no
  // default — a customer with no discount behaves exactly as before this migration.
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_id BIGINT UNSIGNED NULL AFTER package_id`);
}

async function ensureV33Schema() {
  // v1.25.5 (update susulan) — "Pengeluaran Wajib Bulanan" per site + "Komisi Pemasangan Baru".
  //
  // Pengeluaran Wajib: extends the existing v1.24.8 "Checklist Pengeluaran Wajib Bulan Ini" mechanism
  // (cash_categories.is_recurring_mandatory + optional site_id scoping) INSTEAD of introducing a parallel
  // master-table system — the checklist already cross-references active sites x mandatory categories per
  // month on Data Kas. What it lacked: a fixed expected nominal and a due date to tell "belum dicatat" apart
  // from "sudah terlambat". These two nullable columns add exactly that, without touching any existing
  // category that hasn't opted in (both stay NULL = behaves exactly like before this migration).
  await db.query(`ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS expected_amount DECIMAL(14,2) NULL AFTER is_recurring_mandatory`);
  await db.query(`ALTER TABLE cash_categories ADD COLUMN IF NOT EXISTS due_day TINYINT UNSIGNED NULL AFTER expected_amount`);

  // Komisi Pemasangan Baru: tiap paket bisa punya nominal komisi teknisi & sales (harus pas = harga paket,
  // divalidasi di routes/packages.js). NULL/NULL (default) berarti paket ini belum diatur skema komisinya —
  // pelanggan baru dengan paket itu tidak bisa ditandai "Pemasangan Baru" sampai diisi dulu.
  await db.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS commission_technician DECIMAL(12,2) NULL AFTER price`);
  await db.query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS commission_sales DECIMAL(12,2) NULL AFTER commission_technician`);

  // customers.is_new_install marks a customer created via the manual "Tambah Pelanggan Baru" form with
  // "Pemasangan Baru" ticked — teknisi/sales di pemasangan lapangan sering BUKAN karyawan tetap yang
  // terdaftar di sistem (per keputusan user), jadi ini sengaja nama bebas (custom text), bukan FK ke
  // employees seperti customers.sales_id yang sudah ada (itu tetap dipakai apa adanya, tujuannya beda).
  // Kolom ini TIDAK PERNAH diisi oleh jalur impor massal (routes/customers.js import) — INSERT di jalur
  // itu tidak menyebut kolom ini sama sekali, jadi otomatis tetap default 0/NULL untuk 350 pelanggan
  // migrasi, tanpa perlu logic pengecualian tambahan.
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_new_install TINYINT(1) NOT NULL DEFAULT 0 AFTER prorata_enabled`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS install_technician_name VARCHAR(150) NULL AFTER is_new_install`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS install_sales_name VARCHAR(150) NULL AFTER install_technician_name`);

  // Kategori kas baru: pendapatan pemasangan (pass-through) + dua komisi. Dicatat sebagai income+expense
  // SUNGGUH-SUNGGUH (bukan angka yang "dikecualikan" di query analitik) sehingga net cash flow-nya otomatis
  // ~0 tanpa logic pengecualian yang rawan lupa di-update di laporan lain — recorded symmetrically instead
  // of specially excluded, so it can never be missed by a report that forgets to filter it out.
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'PSB-IN','Pendapatan Pemasangan Baru','income','Pembayaran pertama pelanggan baru (pemasangan) — otomatis habis dibagi komisi teknisi & sales, bukan pendapatan rutin perusahaan.',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='PSB-IN')`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'KOMISI-TEK','Komisi Teknisi Pemasangan','expense','Komisi teknisi dari pembayaran pertama pelanggan baru.',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='KOMISI-TEK')`);
  await db.query(`INSERT INTO cash_categories(code,name,type,description,is_active,is_system)
    SELECT 'KOMISI-SLS','Komisi Sales Pemasangan','expense','Komisi sales dari pembayaran pertama pelanggan baru.',1,1
    WHERE NOT EXISTS (SELECT 1 FROM cash_categories WHERE code='KOMISI-SLS')`);
}

async function ensureV34Schema() {
  // v1.25.5 (update susulan #10) — REVISI Komisi Pemasangan Baru berdasarkan feedback user: skema komisi
  // ternyata SERAGAM untuk SEMUA paket (bukan diatur manual per-paket seperti susulan #9): Sales selalu
  // dapat nominal flat, Teknisi dapat sisanya (harga paket/total tagihan pertama dikurangi flat sales).
  // Contoh yang dikonfirmasi user: paket 170rb -> Sales 50rb (flat) + Teknisi 120rb (sisa).
  //
  // packages.commission_technician / packages.commission_sales (ditambahkan di ensureV33Schema) SENGAJA
  // DIBIARKAN APA ADANYA — tidak di-drop. Kolom itu mulai revisi ini tidak lagi dibaca oleh logic manapun
  // (routes/packages.js, routes/customers.js, services/invoiceService.js semua diubah untuk memakai nilai
  // flat di bawah ini, bukan kolom per-paket). DROP COLUMN adalah operasi destruktif yang tidak perlu untuk
  // sekadar mengganti behaviour aplikasi — membiarkannya NULL tidak berpengaruh apa-apa.
  //
  // Nilai flat disimpan di settings (baris tunggal) — bukan hardcode di kode — supaya admin bisa
  // mengubahnya sendiri lewat Menu Pengaturan -> Aplikasi kalau kebijakan komisi berubah, tanpa perlu patch
  // aplikasi baru. Default 50000 sesuai contoh yang diberikan user.
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS install_sales_flat_commission DECIMAL(12,2) NOT NULL DEFAULT 50000 AFTER wa_auto_reminder_template`);
}

module.exports = { ensureV14Schema, ensureV15Schema, ensureV16Schema, ensureV17Schema, ensureV18Schema, ensureV19Schema, ensureV20Schema, ensureV21Schema, ensureV22Schema, ensureV23Schema, ensureV24Schema, ensureV25Schema, ensureV26Schema, ensureV27Schema, ensureV29Schema, ensureV30Schema, ensureV31Schema, ensureV32Schema, ensureV33Schema, ensureV34Schema };
