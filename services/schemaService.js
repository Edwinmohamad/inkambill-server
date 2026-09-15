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

async function ensureV35Schema() {
  await db.query(`CREATE TABLE IF NOT EXISTS closing_periods (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,period_start DATE NOT NULL,period_end DATE NOT NULL,closing_date DATE NULL,status ENUM('DRAFT','LOCKED') NOT NULL DEFAULT 'DRAFT',manual_revenue DECIMAL(14,2) NOT NULL DEFAULT 0,manual_expense DECIMAL(14,2) NOT NULL DEFAULT 0,manual_carry DECIMAL(14,2) NOT NULL DEFAULT 0,manual_salary_agung DECIMAL(14,2) NOT NULL DEFAULT 500000,manual_salary_padilah DECIMAL(14,2) NOT NULL DEFAULT 1000000,notes TEXT NULL,snapshot_json LONGTEXT NULL,created_by BIGINT UNSIGNED NULL,locked_by BIGINT UNSIGNED NULL,locked_at DATETIME NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uq_closing_period(period_start,period_end),INDEX idx_closing_status(status))`);
  await db.query(`CREATE TABLE IF NOT EXISTS closing_router_assets (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,customer_name VARCHAR(180) NOT NULL,site_code VARCHAR(30) NOT NULL DEFAULT 'CDS',owner_name VARCHAR(100) NOT NULL,units INT UNSIGNED NOT NULL DEFAULT 1,active_from DATE NOT NULL,active_until DATE NULL,status ENUM('ACTIVE','BROKEN','REPLACED','INACTIVE') NOT NULL DEFAULT 'ACTIVE',notes TEXT NULL,created_by BIGINT UNSIGNED NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_router_asset_period(active_from,active_until),INDEX idx_router_asset_owner(owner_name))`);
  await db.query(`CREATE TABLE IF NOT EXISTS closing_adjustments (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,closing_id BIGINT UNSIGNED NOT NULL,adjustment_type VARCHAR(40) NOT NULL,recipient_name VARCHAR(120) NULL,amount DECIMAL(14,2) NOT NULL DEFAULT 0,direction ENUM('ADD','DEDUCT') NOT NULL DEFAULT 'ADD',description VARCHAR(255) NULL,created_by BIGINT UNSIGNED NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_closing_adjustment(closing_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS closing_audit_logs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,closing_id BIGINT UNSIGNED NOT NULL,action VARCHAR(40) NOT NULL,details_json LONGTEXT NULL,actor_id BIGINT UNSIGNED NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_closing_audit(closing_id,created_at))`);
}

async function ensureV36Schema() {
  await db.query(`ALTER TABLE closing_router_assets ADD COLUMN IF NOT EXISTS cluster_name VARCHAR(80) NULL AFTER site_code`);
  await db.query(`UPDATE closing_router_assets SET cluster_name=COALESCE(NULLIF(cluster_name,''),UPPER(site_code)),site_code='CDS' WHERE UPPER(site_code) IN ('KRW','CLM')`);
  await db.query(`ALTER TABLE closing_router_assets ALTER COLUMN site_code SET DEFAULT 'CDS'`);
}

async function ensureV37Schema() {
  await db.query(`ALTER TABLE closing_adjustments ADD COLUMN IF NOT EXISTS site_code VARCHAR(30) NULL AFTER adjustment_type`);
  await db.query(`CREATE TABLE IF NOT EXISTS closing_entries (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,closing_id BIGINT UNSIGNED NOT NULL,entry_type ENUM('INCOME','EXPENSE') NOT NULL,site_code VARCHAR(30) NOT NULL,cluster_name VARCHAR(80) NULL,category VARCHAR(120) NOT NULL,amount DECIMAL(14,2) NOT NULL DEFAULT 0,entry_date DATE NOT NULL,description VARCHAR(255) NULL,created_by BIGINT UNSIGNED NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_closing_entries_period(closing_id,entry_type),INDEX idx_closing_entries_site(closing_id,site_code,cluster_name),INDEX idx_closing_entries_date(entry_date))`);
}

// v1.28 — operational intelligence foundation.  These tables are deliberately
// additive and avoid foreign keys so an older production database can be
// upgraded without locking or breaking existing billing history.
async function ensureV38Schema() {
  await db.query(`CREATE TABLE IF NOT EXISTS nms_interface_samples (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    router_id BIGINT UNSIGNED NOT NULL,
    interface_name VARCHAR(180) NOT NULL,
    sampled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rx_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    tx_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    rx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
    tx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
    running TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_nms_interface_router_time(router_id,interface_name,sampled_at),
    INDEX idx_nms_interface_time(sampled_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nms_pppoe_sessions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    router_id BIGINT UNSIGNED NOT NULL,
    secret_name VARCHAR(180) NOT NULL,
    session_id VARCHAR(180) NULL,
    customer_id BIGINT UNSIGNED NULL,
    address VARCHAR(80) NULL,
    caller_id VARCHAR(180) NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME NULL,
    last_uptime_seconds BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('online','offline') NOT NULL DEFAULT 'online',
    INDEX idx_nms_session_router_name(router_id,secret_name,last_seen_at),
    INDEX idx_nms_session_customer(customer_id,last_seen_at),
    INDEX idx_nms_session_status(status,last_seen_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nms_auto_isolate_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NULL,
    router_id BIGINT UNSIGNED NULL,
    action VARCHAR(30) NOT NULL,
    idempotency_key VARCHAR(190) NOT NULL UNIQUE,
    reason VARCHAR(500) NULL,
    error_message VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nms_isolate_customer(customer_id,created_at),
    INDEX idx_nms_isolate_router(router_id,created_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nms_router_backups (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    router_id BIGINT UNSIGNED NOT NULL,
    backup_type ENUM('rsc','backup') NOT NULL,
    file_path VARCHAR(500) NULL,
    file_size BIGINT UNSIGNED NULL,
    sha256 CHAR(64) NULL,
    status ENUM('success','failed','skipped') NOT NULL DEFAULT 'skipped',
    error_message VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nms_backup_router_time(router_id,created_at)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS inventory_categories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(140) NOT NULL UNIQUE,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_inventory_category_active(is_active,name)
  )`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(120) NULL`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS qr_payload TEXT NULL`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE inventory_items ADD INDEX IF NOT EXISTS idx_inventory_deleted(deleted_at)`);
  await db.query(`ALTER TABLE inventory_items ADD INDEX IF NOT EXISTS idx_inventory_barcode(barcode)`);
  await db.query(`ALTER TABLE inventory_items ADD INDEX IF NOT EXISTS idx_inventory_category(category_id)`);

  // Existing free-text categories become managed categories once, without
  // overwriting the original text (which remains the reporting fallback).
  const [legacyCategories] = await db.query(`SELECT DISTINCT TRIM(category) name FROM inventory_items WHERE category IS NOT NULL AND TRIM(category)<>''`);
  for (const row of legacyCategories) {
    const name = String(row.name || '').trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 130) || `kategori-${Date.now()}`;
    await db.execute(`INSERT IGNORE INTO inventory_categories(name,slug) VALUES(?,?)`, [name, slug]);
  }
  await db.query(`UPDATE inventory_items i JOIN inventory_categories c ON LOWER(TRIM(c.name))=LOWER(TRIM(i.category)) SET i.category_id=c.id WHERE i.category_id IS NULL AND i.category IS NOT NULL`);

  await db.query(`CREATE TABLE IF NOT EXISTS inventory_stock_alerts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED NOT NULL,
    current_qty DECIMAL(14,2) NOT NULL DEFAULT 0,
    min_stock DECIMAL(14,2) NOT NULL DEFAULT 0,
    severity ENUM('low','critical') NOT NULL DEFAULT 'low',
    resolved_at DATETIME NULL,
    last_notified_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_inventory_alert_item(item_id,resolved_at),
    INDEX idx_inventory_alert_open(resolved_at,updated_at)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS piket_proofs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    technician_name VARCHAR(150) NULL,
    proof_date DATE NOT NULL,
    site_id BIGINT UNSIGNED NULL,
    file_path VARCHAR(500) NOT NULL,
    file_url VARCHAR(500) NULL,
    mime_type VARCHAR(100) NULL,
    file_size BIGINT UNSIGNED NULL,
    caption VARCHAR(500) NULL,
    source VARCHAR(40) NOT NULL DEFAULT 'n8n',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_piket_proof_date(proof_date),
    INDEX idx_piket_proof_site(site_id,proof_date)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS n8n_webhook_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(190) NOT NULL UNIQUE,
    event_type VARCHAR(80) NOT NULL,
    payload_json LONGTEXT NULL,
    status ENUM('processed','failed','ignored') NOT NULL DEFAULT 'processed',
    error_message VARCHAR(1000) NULL,
    processed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_n8n_event_type_time(event_type,created_at)
  )`);
}

async function ensureV39Schema() {
  // Mobile diagnostics are deliberately small and sanitized by the route.
  // They make Android failures visible without embedding a third-party tracker.
  await db.query(`CREATE TABLE IF NOT EXISTS mobile_crash_reports (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    app_version VARCHAR(40) NULL,
    android_version VARCHAR(40) NULL,
    device_model VARCHAR(160) NULL,
    exception_class VARCHAR(240) NULL,
    message VARCHAR(1000) NULL,
    stack_trace TEXT NULL,
    occurred_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mobile_crash_user_time(user_id,created_at),
    INDEX idx_mobile_crash_created(created_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS mobile_push_tokens (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    token VARCHAR(500) NOT NULL,
    platform VARCHAR(20) NOT NULL DEFAULT 'android',
    device_model VARCHAR(160) NULL,
    app_version VARCHAR(40) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mobile_push_token(token),
    INDEX idx_mobile_push_user(user_id,is_active)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    notification_id BIGINT UNSIGNED NOT NULL,
    token_id BIGINT UNSIGNED NOT NULL,
    status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    response_code INT NULL,
    error_message VARCHAR(1000) NULL,
    sent_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mobile_push_delivery(notification_id,token_id),
    INDEX idx_mobile_push_status(status,updated_at)
  )`);
  await db.query(`ALTER TABLE mobile_push_deliveries ADD COLUMN IF NOT EXISTS attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER status`);
}

async function ensureV40Schema() {
  await db.query(`CREATE TABLE IF NOT EXISTS finance_debts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    record_type ENUM('DEBT','RECEIVABLE') NOT NULL DEFAULT 'DEBT',
    party_name VARCHAR(160) NOT NULL,
    purpose VARCHAR(255) NOT NULL,
    site_code ENUM('GLOBAL','CDS','KBG') NOT NULL DEFAULT 'GLOBAL',
    principal_amount DECIMAL(16,2) NOT NULL,
    issue_date DATE NOT NULL,
    due_date DATE NULL,
    payment_method ENUM('ONCE','INSTALLMENT') NOT NULL DEFAULT 'ONCE',
    responsible_name VARCHAR(160) NULL,
    notes TEXT NULL,
    status ENUM('ACTIVE','PAID','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_finance_debt_status(status,record_type,due_date),
    INDEX idx_finance_debt_site(site_code,status)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS finance_debt_payments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    debt_id BIGINT UNSIGNED NOT NULL,
    payment_date DATE NOT NULL,
    amount DECIMAL(16,2) NOT NULL,
    notes VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_finance_debt_payment(debt_id,payment_date),
    CONSTRAINT fk_finance_debt_payment FOREIGN KEY (debt_id) REFERENCES finance_debts(id) ON DELETE CASCADE
  )`);
  await db.query(`ALTER TABLE finance_debts ADD COLUMN IF NOT EXISTS installment_months SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER payment_method`);
  await db.query(`CREATE TABLE IF NOT EXISTS finance_debt_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    debt_id BIGINT UNSIGNED NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    quantity DECIMAL(12,2) NOT NULL DEFAULT 1,
    unit_price DECIMAL(16,2) NOT NULL,
    notes VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_finance_debt_item(debt_id,id),
    CONSTRAINT fk_finance_debt_item FOREIGN KEY (debt_id) REFERENCES finance_debts(id) ON DELETE CASCADE
  )`);
}

async function ensureV41Schema() {
  await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS booked_at DATE NULL AFTER paid_at`);
  await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS booked_date_mode ENUM('payment_date','approval_date','manual') NULL AFTER booked_at`);
  await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(190) NULL AFTER reference`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_source ENUM('new_install','migration','excel_import','manual_entry','restored') NOT NULL DEFAULT 'manual_entry' AFTER is_new_install`);
  await db.query(`UPDATE customers SET customer_source='new_install' WHERE is_new_install=1 AND customer_source='manual_entry'`);
  await db.query(`CREATE TABLE IF NOT EXISTS financial_audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,user_id BIGINT UNSIGNED NULL,action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(80) NOT NULL,entity_id BIGINT UNSIGNED NULL,before_json LONGTEXT NULL,after_json LONGTEXT NULL,
    reason VARCHAR(500) NOT NULL,ip_address VARCHAR(64) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_financial_audit_entity(entity_type,entity_id),INDEX idx_financial_audit_time(created_at))`);
  try { await db.query(`CREATE UNIQUE INDEX uq_payments_idempotency ON payments(idempotency_key)`); } catch (err) { if (!['ER_DUP_KEYNAME','ER_DUP_ENTRY'].includes(err.code)) throw err; }
  try { await db.query(`CREATE UNIQUE INDEX uq_cash_source ON cash_transactions(source_type,source_id)`); } catch (err) {
    if (!['ER_DUP_KEYNAME','ER_DUP_ENTRY'].includes(err.code)) throw err;
    if (err.code === 'ER_DUP_ENTRY') console.warn('Unique jurnal sumber belum dipasang: bersihkan duplikasi cash_transactions terlebih dahulu.');
  }
}

async function ensureV42Schema() {
  await db.query(`CREATE TABLE IF NOT EXISTS acs_devices (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,device_id VARCHAR(255) NOT NULL,serial_number VARCHAR(160) NULL,
    oui VARCHAR(40) NULL,manufacturer VARCHAR(120) NULL,product_class VARCHAR(160) NULL,software_version VARCHAR(160) NULL,
    pppoe_username VARCHAR(180) NULL,wan_ip VARCHAR(80) NULL,ssid VARCHAR(180) NULL,rx_power DECIMAL(8,2) NULL,
    temperature DECIMAL(8,2) NULL,active_clients INT UNSIGNED NULL,last_inform DATETIME NULL,
    online_status ENUM('online','offline','unknown') NOT NULL DEFAULT 'unknown',signal_status ENUM('normal','warning','critical','unknown') NOT NULL DEFAULT 'unknown',
    olt_name VARCHAR(120) NULL,pon_port VARCHAR(80) NULL,splitter_name VARCHAR(120) NULL,odp_name VARCHAR(120) NULL,
    last_synced_at DATETIME NULL,sync_error VARCHAR(500) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_acs_device_id(device_id),INDEX idx_acs_serial(serial_number),INDEX idx_acs_pppoe(pppoe_username),
    INDEX idx_acs_health(online_status,signal_status,last_inform),INDEX idx_acs_path(olt_name,pon_port,odp_name))`);
  await db.query(`CREATE TABLE IF NOT EXISTS customer_ont_links (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,customer_id BIGINT UNSIGNED NOT NULL,acs_device_id BIGINT UNSIGNED NOT NULL,
    match_method ENUM('pppoe','serial','tag','manual') NOT NULL DEFAULT 'manual',is_locked TINYINT(1) NOT NULL DEFAULT 0,
    linked_by BIGINT UNSIGNED NULL,linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_customer_ont(customer_id),UNIQUE KEY uq_ont_customer(acs_device_id),INDEX idx_ont_link_method(match_method,is_locked))`);
  await db.query(`CREATE TABLE IF NOT EXISTS acs_device_samples (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,acs_device_id BIGINT UNSIGNED NOT NULL,sampled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    online_status ENUM('online','offline','unknown') NOT NULL,rx_power DECIMAL(8,2) NULL,temperature DECIMAL(8,2) NULL,active_clients INT UNSIGNED NULL,
    INDEX idx_acs_sample_device_time(acs_device_id,sampled_at))`);
  await db.query(`CREATE TABLE IF NOT EXISTS acs_sync_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,status ENUM('running','success','failed','skipped') NOT NULL,device_count INT UNSIGNED NOT NULL DEFAULT 0,
    linked_count INT UNSIGNED NOT NULL DEFAULT 0,message VARCHAR(700) NULL,started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at DATETIME NULL,
    INDEX idx_acs_sync_time(started_at,status))`);
  await db.query(`CREATE TABLE IF NOT EXISTS acs_action_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,user_id BIGINT UNSIGNED NULL,action VARCHAR(80) NOT NULL,acs_device_id BIGINT UNSIGNED NULL,
    customer_id BIGINT UNSIGNED NULL,status ENUM('success','failed') NOT NULL,details VARCHAR(700) NULL,ip_address VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX idx_acs_action_time(created_at),INDEX idx_acs_action_device(acs_device_id,created_at))`);
}

async function ensureV43Schema() {
  await db.query(`CREATE TABLE IF NOT EXISTS network_map_nodes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,node_type ENUM('pop','olt','odc','odp','customer','pole','other') NOT NULL,
    name VARCHAR(180) NOT NULL,site_id BIGINT UNSIGNED NULL,customer_id BIGINT UNSIGNED NULL,acs_device_id BIGINT UNSIGNED NULL,
    latitude DECIMAL(10,7) NOT NULL,longitude DECIMAL(10,7) NOT NULL,capacity INT UNSIGNED NULL,notes VARCHAR(500) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,created_by BIGINT UNSIGNED NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_map_node_type(node_type,is_active),INDEX idx_map_node_site(site_id),INDEX idx_map_node_customer(customer_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS network_map_links (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,source_node_id BIGINT UNSIGNED NOT NULL,target_node_id BIGINT UNSIGNED NOT NULL,
    cable_type ENUM('backbone','distribution','drop','wireless','other') NOT NULL DEFAULT 'distribution',
    status_mode ENUM('automatic','manual') NOT NULL DEFAULT 'automatic',manual_status ENUM('online','warning','offline','unknown') NOT NULL DEFAULT 'online',
    cable_length_m DECIMAL(12,2) NULL,core_label VARCHAR(120) NULL,notes VARCHAR(500) NULL,is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_map_link(source_node_id,target_node_id),INDEX idx_map_link_status(status_mode,manual_status))`);
}
async function ensureV44Schema(){
  const statements=[
    `ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_customer_list(site_id,customer_status,archived_at,id)`,
    `ALTER TABLE invoices ADD INDEX IF NOT EXISTS idx_invoice_period_status(period_year,period_month,status,customer_id)`,
    `ALTER TABLE payments ADD INDEX IF NOT EXISTS idx_payment_invoice_status_date(invoice_id,status,paid_at)`,
    `ALTER TABLE cash_transactions ADD INDEX IF NOT EXISTS idx_cash_date_approval(transaction_date,approval_status,category_id,site_id)`,
    `ALTER TABLE tickets ADD INDEX IF NOT EXISTS idx_ticket_status_priority(status,priority,id)`,
    `ALTER TABLE acs_devices ADD INDEX IF NOT EXISTS idx_acs_list(online_status,signal_status,last_inform,id)`
  ];for(const sql of statements)await db.query(sql);
}

module.exports = { ensureV14Schema, ensureV15Schema, ensureV16Schema, ensureV17Schema, ensureV18Schema, ensureV19Schema, ensureV20Schema, ensureV21Schema, ensureV22Schema, ensureV23Schema, ensureV24Schema, ensureV25Schema, ensureV26Schema, ensureV27Schema, ensureV29Schema, ensureV30Schema, ensureV31Schema, ensureV32Schema, ensureV33Schema, ensureV34Schema, ensureV35Schema, ensureV36Schema, ensureV37Schema, ensureV38Schema, ensureV39Schema, ensureV40Schema, ensureV41Schema, ensureV42Schema, ensureV43Schema, ensureV44Schema };
