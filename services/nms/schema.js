// NMS v2 schema (MariaDB 11 / MySQL 8 compatible). Idempotent: aman dijalankan tiap startup.
// PK memakai BIGINT UNSIGNED agar konsisten dengan tabel existing (customers, routers, sites,
// users) — bukan UUID — sehingga foreign key & join lama tetap berlaku tanpa migrasi data.
const db = require('../../config/db');

async function tryQuery(sql, label) {
  try { await db.query(sql); return true; }
  catch (err) {
    // FK/generated column bisa gagal pada instalasi lama dengan tipe kolom berbeda. Kegagalan
    // di sini tidak boleh mematikan startup — integritas tetap dijaga di lapisan service.
    if (!/Duplicate|already exists|errno: 121/i.test(err.message)) console.warn(`NMS schema (${label}) dilewati:`, err.message);
    return false;
  }
}

async function ensureNmsV2Schema() {
  await db.query(`CREATE TABLE IF NOT EXISTS ppp_secrets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    site_id BIGINT UNSIGNED NOT NULL,
    router_id BIGINT UNSIGNED NOT NULL,
    ros_id VARCHAR(32) NULL COMMENT 'RouterOS .id (mis. *1A)',
    username VARCHAR(128) NOT NULL,
    password_enc TEXT NULL COMMENT 'AES-256-GCM (cryptoService), tidak pernah dikirim ke browser',
    profile VARCHAR(64) NULL,
    original_profile VARCHAR(64) NULL COMMENT 'profile paket sebelum isolir, dipakai saat un-isolir',
    service VARCHAR(20) NULL,
    local_address VARCHAR(64) NULL,
    remote_address VARCHAR(64) NULL,
    caller_id VARCHAR(64) NULL COMMENT 'MAC lock',
    comment VARCHAR(255) NULL,
    disabled TINYINT(1) NOT NULL DEFAULT 0,
    is_isolated TINYINT(1) NOT NULL DEFAULT 0,
    is_exempt TINYINT(1) NOT NULL DEFAULT 0,
    exempt_type VARCHAR(20) NULL,
    customer_id BIGINT UNSIGNED NULL,
    match_method ENUM('pppoe_username','customer_code','customer_name','manual') NULL,
    sync_status ENUM('synced','unsynced') NOT NULL DEFAULT 'unsynced',
    is_online TINYINT(1) NOT NULL DEFAULT 0,
    active_address VARCHAR(64) NULL,
    active_caller_id VARCHAR(64) NULL,
    active_uptime VARCHAR(40) NULL,
    last_login_at DATETIME NULL,
    last_logout_at DATETIME NULL,
    last_seen_on_router_at DATETIME NULL,
    removed_on_router_at DATETIME NULL,
    last_synced_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ppp_router_username (router_id, username),
    UNIQUE KEY uq_ppp_customer (customer_id),
    INDEX idx_ppp_site_sync (site_id, sync_status),
    INDEX idx_ppp_online (site_id, is_online),
    INDEX idx_ppp_username (username)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS nms_ppp_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    router_id BIGINT UNSIGNED NULL,
    site_id BIGINT UNSIGNED NULL,
    username VARCHAR(128) NULL,
    customer_id BIGINT UNSIGNED NULL,
    event_type ENUM('login','logout','auth_failed','kick','isolate','unisolate','lock_mac') NOT NULL,
    address VARCHAR(64) NULL,
    caller_id VARCHAR(64) NULL,
    message VARCHAR(255) NULL,
    source ENUM('poll','webhook','log','action') NOT NULL DEFAULT 'poll',
    dedup_key VARCHAR(191) NULL,
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_nms_event_dedup (dedup_key),
    INDEX idx_nms_event_site_time (site_id, event_type, occurred_at),
    INDEX idx_nms_event_user_time (username, event_type, occurred_at),
    INDEX idx_nms_event_time (occurred_at)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS nms_ppp_anomalies (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    site_id BIGINT UNSIGNED NULL,
    router_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(128) NOT NULL,
    anomaly_type VARCHAR(40) NOT NULL,
    details_json LONGTEXT NULL,
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    UNIQUE KEY uq_nms_ppp_anomaly (router_id, username, anomaly_type),
    INDEX idx_nms_ppp_anomaly_open (anomaly_type, resolved_at, site_id)
  )`);
  // Klasifikasi manual harus tetap bertahan saat poller melihat sesi yang sama lagi.
  // Contoh utama: PPP Active dari RADIUS memang tidak mempunyai /ppp/secret lokal.
  await db.query(`ALTER TABLE nms_ppp_anomalies ADD COLUMN IF NOT EXISTS classification VARCHAR(40) NULL AFTER anomaly_type`);
  await db.query(`ALTER TABLE nms_ppp_anomalies ADD COLUMN IF NOT EXISTS resolution_note VARCHAR(255) NULL AFTER details_json`);
  await db.query(`ALTER TABLE nms_ppp_anomalies ADD COLUMN IF NOT EXISTS resolved_by BIGINT UNSIGNED NULL AFTER resolution_note`);

  await db.query(`CREATE TABLE IF NOT EXISTS nms_router_state (
    router_id BIGINT UNSIGNED PRIMARY KEY,
    status ENUM('online','offline','unknown') NOT NULL DEFAULT 'unknown',
    last_ok_at DATETIME NULL,
    last_error VARCHAR(500) NULL,
    telemetry_json LONGTEXT NULL COMMENT 'snapshot telemetry terakhir (fallback saat router offline)',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS nms_alerts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    alert_type ENUM('mass_disconnect','flapping','router_down') NOT NULL,
    severity ENUM('critical','warning','info') NOT NULL DEFAULT 'warning',
    site_id BIGINT UNSIGNED NULL,
    router_id BIGINT UNSIGNED NULL,
    title VARCHAR(255) NOT NULL,
    details LONGTEXT NULL,
    dedup_key VARCHAR(191) NOT NULL,
    opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    acknowledged_by BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_nms_alert_dedup (dedup_key),
    INDEX idx_nms_alert_open (resolved_at, alert_type)
  )`);

  // ---- NMS v2.1 (Apple UI + otomasi) ----
  await tryQuery(`ALTER TABLE nms_ppp_events MODIFY event_type ENUM('login','logout','auth_failed','kick','isolate','unisolate','lock_mac','profile','map','unmap','create','schedule') NOT NULL`, 'events enum v2.1');
  await tryQuery(`ALTER TABLE nms_alerts MODIFY alert_type ENUM('mass_disconnect','flapping','router_down','shared_account') NOT NULL`, 'alerts enum v2.1');
  await tryQuery(`ALTER TABLE ppp_secrets MODIFY match_method ENUM('pppoe_username','customer_code','customer_name','manual','phone','comment','fuzzy','created') NULL`, 'match_method v2.1');
  await db.query(`CREATE TABLE IF NOT EXISTS nms_settings (
    k VARCHAR(64) PRIMARY KEY,
    v TEXT NULL,
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nms_sync_batches (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    plan_id VARCHAR(64) NULL,
    site_id BIGINT UNSIGNED NULL,
    source ENUM('manual','auto','excel') NOT NULL DEFAULT 'manual',
    linked_count INT NOT NULL DEFAULT 0,
    pairs_json LONGTEXT NULL COMMENT '[{secretId, customerId, username, customerName, method}]',
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undone_at DATETIME NULL,
    undone_by BIGINT UNSIGNED NULL,
    INDEX idx_sync_batch_time (created_at)
  )`);
  await tryQuery(`ALTER TABLE nms_sync_batches MODIFY source ENUM('manual','auto','excel') NOT NULL DEFAULT 'manual'`, 'sync batch source excel');
  await db.query(`CREATE TABLE IF NOT EXISTS nms_scheduled_actions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    action ENUM('isolate','unisolate','kick','profile','package') NOT NULL,
    secret_ids LONGTEXT NOT NULL,
    profile VARCHAR(64) NULL,
    package_id BIGINT UNSIGNED NULL,
    run_at DATETIME NOT NULL,
    note VARCHAR(255) NULL,
    status ENUM('pending','running','done','failed','cancelled') NOT NULL DEFAULT 'pending',
    result_json LONGTEXT NULL,
    site_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    INDEX idx_nms_sched_due (status, run_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nms_approvals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(20) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    target_count INT NOT NULL DEFAULT 0,
    summary VARCHAR(255) NULL,
    status ENUM('pending','approved','rejected','expired','failed') NOT NULL DEFAULT 'pending',
    requested_by BIGINT UNSIGNED NULL,
    decided_by BIGINT UNSIGNED NULL,
    result_json LONGTEXT NULL,
    site_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME NULL,
    INDEX idx_nms_approval_status (status, created_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nms_secret_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    router_id BIGINT UNSIGNED NOT NULL,
    snap_date DATE NOT NULL,
    secrets_json LONGTEXT NOT NULL,
    secret_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_nms_snap (router_id, snap_date)
  )`);
  await tryQuery(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS isolate_hold_until DATE NULL`, 'customers.isolate_hold_until');
  // Fasum / exempt manual: tanda dari operator tidak boleh ditimpa deteksi otomatis saat tarik ulang router.
  await tryQuery(`ALTER TABLE ppp_secrets ADD COLUMN IF NOT EXISTS exempt_source VARCHAR(10) NULL COMMENT 'auto | manual'`, 'ppp_secrets.exempt_source');
  await tryQuery(`ALTER TABLE ppp_secrets ADD COLUMN IF NOT EXISTS exempt_note VARCHAR(255) NULL`, 'ppp_secrets.exempt_note');
  await tryQuery(`ALTER TABLE ppp_secrets ADD COLUMN IF NOT EXISTS exempt_at DATETIME NULL`, 'ppp_secrets.exempt_at');
  await tryQuery(`ALTER TABLE ppp_secrets ADD COLUMN IF NOT EXISTS exempt_by BIGINT UNSIGNED NULL`, 'ppp_secrets.exempt_by');
  await tryQuery(`CREATE INDEX IF NOT EXISTS idx_ppp_exempt ON ppp_secrets(is_exempt, exempt_type)`, 'ppp_secrets exempt index');
  // Sinkron pelanggan v3: tag CID, alias pilihan operator, pindah router.
  await tryQuery(`ALTER TABLE ppp_secrets ADD COLUMN IF NOT EXISTS cid_ignore VARCHAR(64) NULL COMMENT 'tag CID yang sengaja dilepas operator'`, 'ppp_secrets.cid_ignore');
  await tryQuery(`CREATE INDEX IF NOT EXISTS idx_ppp_ros ON ppp_secrets(router_id, ros_id)`, 'ppp_secrets ros index');
  await tryQuery(`ALTER TABLE ppp_secrets MODIFY match_method ENUM('pppoe_username','customer_code','customer_name','manual','phone','comment','fuzzy','created','cid_tag','alias','moved','mac','ip') NULL`, 'match_method v3');
  await db.query(`CREATE TABLE IF NOT EXISTS nms_sync_aliases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    site_id BIGINT UNSIGNED NOT NULL,
    username_key VARCHAR(128) NOT NULL COMMENT 'username PPP ternormalisasi (huruf kecil)',
    customer_id BIGINT UNSIGNED NOT NULL,
    source VARCHAR(20) NULL,
    hits INT UNSIGNED NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    UNIQUE KEY uq_alias_site_user (site_id, username_key),
    INDEX idx_alias_customer (customer_id)
  )`);
  await tryQuery(`ALTER TABLE nms_alerts MODIFY alert_type ENUM('mass_disconnect','flapping','router_down','shared_account','fasum_offline') NOT NULL`, 'alerts enum fasum');
  await tryQuery(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS isolate_hold_note VARCHAR(255) NULL`, 'customers.isolate_hold_note');

  await db.query(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS wan_interface VARCHAR(64) NULL`);
  await tryQuery(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS connector_type ENUM('rest','legacy_api') NOT NULL DEFAULT 'rest'`, 'routers.connector_type');
  await tryQuery(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS device_role ENUM('core','distribution','infrastructure') NOT NULL DEFAULT 'core'`, 'routers.device_role');
  await tryQuery(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS pppoe_enabled TINYINT(1) NOT NULL DEFAULT 1`, 'routers.pppoe_enabled');
  await tryQuery(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS legacy_host VARCHAR(191) NULL`, 'routers.legacy_host');
  await tryQuery(`ALTER TABLE routers ADD COLUMN IF NOT EXISTS legacy_port INT UNSIGNED NULL DEFAULT 8728`, 'routers.legacy_port');
  await db.query(`CREATE TABLE IF NOT EXISTS network_probe_targets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    category ENUM('internet','dns','video','social','gaming','streaming','custom') NOT NULL DEFAULT 'internet',
    probe_type ENUM('icmp','tcp','https') NOT NULL DEFAULT 'icmp',
    target VARCHAR(255) NOT NULL,
    port INT UNSIGNED NULL,
    path VARCHAR(255) NULL,
    warning_ms INT UNSIGNED NOT NULL DEFAULT 80,
    critical_ms INT UNSIGNED NOT NULL DEFAULT 150,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_network_probe_name(name)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS network_probe_samples (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    target_id BIGINT UNSIGNED NOT NULL,
    site_id BIGINT UNSIGNED NULL,
    status ENUM('up','degraded','down') NOT NULL,
    latency_ms DECIMAL(10,2) NULL,
    jitter_ms DECIMAL(10,2) NULL,
    packet_loss DECIMAL(6,2) NULL,
    error_message VARCHAR(500) NULL,
    sampled_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_network_probe_target_time(target_id,sampled_at),
    INDEX idx_network_probe_site_time(site_id,sampled_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS network_infra_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
    site_id BIGINT UNSIGNED NULL,
    router_id BIGINT UNSIGNED NULL,
    title VARCHAR(255) NOT NULL,
    details_json LONGTEXT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_network_infra_events_time(created_at),
    INDEX idx_network_infra_events_site(site_id,created_at)
  )`);
  await db.query(`INSERT IGNORE INTO network_probe_targets(name,category,probe_type,target,port,warning_ms,critical_ms,sort_order) VALUES
    ('Cloudflare DNS','dns','tcp','1.1.1.1',53,40,100,10),
    ('Google DNS','dns','tcp','8.8.8.8',53,40,100,20),
    ('Google','internet','https','www.google.com',443,100,250,30),
    ('YouTube','video','https','www.youtube.com',443,120,300,40),
    ('WhatsApp','social','https','web.whatsapp.com',443,150,350,50),
    ('Instagram','social','https','www.instagram.com',443,150,350,60),
    ('Netflix','streaming','https','www.netflix.com',443,180,400,70),
    ('Mobile Legends','gaming','tcp','www.mobilelegends.com',443,80,150,80),
    ('PUBG Mobile','gaming','tcp','www.pubgmobile.com',443,80,150,90),
    ('Riot Games','gaming','https','www.riotgames.com',443,80,150,100)
  `)
  await db.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details LONGTEXT NULL`);
  await db.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS site_id BIGINT UNSIGNED NULL`);
  await tryQuery(`CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(entity_type, entity_id)`, 'audit index');
  await tryQuery(`CREATE INDEX IF NOT EXISTS idx_audit_site_time ON audit_logs(site_id, created_at)`, 'audit site index');
  // Prevent legacy/manual writes from assigning the same PPP username twice on
  // one router.  If old data still contains duplicates this intentionally logs
  // a warning and leaves data untouched; operators can reconcile first.
  await tryQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_router_pppoe ON customers(router_id, pppoe_username)`, 'customer router PPP username unique');

  // Status layanan sesuai spesifikasi (active / isolated / suspended) diturunkan dari kolom
  // existing customer_status + network_status sebagai VIRTUAL column, supaya tidak ada dua
  // sumber kebenaran yang bisa drift. (Tidak dinamai "status" agar query JOIN lama yang
  // memakai kolom status tanpa alias tidak menjadi ambigu.)
  await tryQuery(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS service_status VARCHAR(12)
    GENERATED ALWAYS AS (CASE WHEN customer_status='suspended' THEN 'suspended' WHEN network_status='isolated' THEN 'isolated' ELSE 'active' END) VIRTUAL`, 'customers.service_status');

  await tryQuery(`ALTER TABLE ppp_secrets ADD CONSTRAINT fk_ppp_router FOREIGN KEY (router_id) REFERENCES routers(id) ON DELETE CASCADE`, 'fk_ppp_router');
  await tryQuery(`ALTER TABLE ppp_secrets ADD CONSTRAINT fk_ppp_site FOREIGN KEY (site_id) REFERENCES sites(id)`, 'fk_ppp_site');
  await tryQuery(`ALTER TABLE ppp_secrets ADD CONSTRAINT fk_ppp_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL`, 'fk_ppp_customer');
}

async function purgeNmsHistory() {
  await db.query(`DELETE FROM nms_ppp_events WHERE occurred_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
  await db.query(`DELETE FROM nms_alerts WHERE resolved_at IS NOT NULL AND resolved_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
  await db.query(`DELETE FROM nms_secret_snapshots WHERE snap_date < DATE_SUB(CURDATE(), INTERVAL 60 DAY)`).catch(() => {});
  await db.query(`DELETE FROM nms_scheduled_actions WHERE status IN ('done','cancelled','failed') AND created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`).catch(() => {});
  await db.query(`DELETE FROM pppoe_sync_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 365 DAY)`).catch(() => {});
  await db.query(`DELETE FROM nms_sync_batches WHERE created_at < DATE_SUB(NOW(), INTERVAL 365 DAY)`).catch(() => {});
}

module.exports = { ensureNmsV2Schema, purgeNmsHistory };
