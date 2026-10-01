// v1.30 — WhatsApp CRM: Web Inbox 2-arah, Broadcast selektif/terjadwal, Engine Anti-Ban.
// Semua perubahan ADITIF (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / perluasan ENUM),
// tidak ada kolom lama yang dihapus atau diubah artinya. Dipanggil dari bootstrap() di app.js.
const db = require('../config/db');
const { OFFICIAL_TEMPLATES, DEFAULT_QUICK_REPLIES } = require('./waTemplateService');

async function extendEnum(table, column, add, defaultValue, nullable = false) {
  const [cols] = await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!cols.length) return;
  const current = (cols[0].Type.match(/'([^']+)'/g) || []).map(v => v.slice(1, -1));
  if (add.every(v => current.includes(v))) return;
  const values = [...new Set([...current, ...add])];
  await db.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ENUM(${values.map(v => `'${v.replace(/'/g, '')}'`).join(',')}) ${nullable ? 'NULL' : 'NOT NULL'} DEFAULT '${defaultValue}'`);
}

// FK ke tabel lama ditambahkan terpisah & best-effort: bila tipe kolom id lama berbeda di instalasi
// tertentu, aplikasi tetap bisa boot (relasi tetap dijaga oleh kode aplikasi).
async function addForeignKey(table, name, ddl) {
  try {
    const [rows] = await db.query(`SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? LIMIT 1`, [table, name]);
    if (rows.length) return;
    await db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
  } catch (e) { console.error(`Skema WA CRM: FK ${name} dilewati (${e.message})`); }
}

async function ensureV56Schema() {
  // ---- Antrean kirim (wa_messages tetap menjadi satu-satunya queue + log) -------------------------
  // Status baru: processing (sedang dikirim), cancelled (dibatalkan admin/broadcast). 'queued' = pending.
  await extendEnum('wa_messages', 'status', ['pending_approval', 'queued', 'processing', 'sent', 'failed', 'rejected', 'cancelled'], 'queued');
  await extendEnum('wa_messages', 'message_type', ['manual', 'blast', 'auto_reminder', 'network_alert', 'payment_receipt', 'broadcast', 'inbox', 'isolation_notice', 'outage_notice', 'bot_reply'], 'manual');
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS broadcast_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS conversation_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS chat_message_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS scheduled_at DATETIME NULL`);
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_path VARCHAR(255) NULL`);
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_mime VARCHAR(100) NULL`);
  await db.query(`ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS media_name VARCHAR(255) NULL`);
  await db.query(`ALTER TABLE wa_messages ADD INDEX IF NOT EXISTS idx_wa_messages_broadcast(broadcast_id,status)`);
  await db.query(`ALTER TABLE wa_messages ADD INDEX IF NOT EXISTS idx_wa_messages_sent_at(status,sent_at)`);

  // ---- Kampanye broadcast ---------------------------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS wa_broadcasts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    template_key VARCHAR(40) NULL,
    message_template TEXT NOT NULL,
    extra_vars_json TEXT NULL,
    filter_json TEXT NULL,
    mode ENUM('direct','scheduled') NOT NULL DEFAULT 'direct',
    scheduled_at DATETIME NULL,
    status ENUM('scheduled','running','paused','completed','cancelled') NOT NULL DEFAULT 'running',
    total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
    skipped_blacklist INT UNSIGNED NOT NULL DEFAULT 0,
    skipped_invalid INT UNSIGNED NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_wa_broadcast_status(status,scheduled_at)
  )`);

  // ---- Web Inbox ------------------------------------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS wa_conversations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    chat_id VARCHAR(120) NOT NULL,
    phone VARCHAR(32) NULL,
    customer_id BIGINT UNSIGNED NULL,
    display_name VARCHAR(180) NULL,
    category ENUM('general','payment','outage') NOT NULL DEFAULT 'general',
    status ENUM('open','closed') NOT NULL DEFAULT 'open',
    unread_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_message_at DATETIME NULL,
    last_message_preview VARCHAR(255) NULL,
    last_direction ENUM('in','out','note') NULL,
    bot_enabled TINYINT(1) NOT NULL DEFAULT 1,
    human_until DATETIME NULL,
    last_bot_reply_at DATETIME NULL,
    assigned_user_id BIGINT UNSIGNED NULL,
    assigned_department ENUM('finance','helpdesk','technical') NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wa_conv_chat(chat_id),
    INDEX idx_wa_conv_last(last_message_at),
    INDEX idx_wa_conv_phone(phone),
    INDEX idx_wa_conv_customer(customer_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS wa_chat_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    direction ENUM('in','out','note') NOT NULL,
    wa_message_id VARCHAR(255) NULL,
    body TEXT NULL,
    media_path VARCHAR(255) NULL,
    media_mime VARCHAR(100) NULL,
    media_name VARCHAR(255) NULL,
    ack ENUM('pending','sent','delivered','read','failed') NOT NULL DEFAULT 'pending',
    error_message VARCHAR(500) NULL,
    sender_user_id BIGINT UNSIGNED NULL,
    is_bot TINYINT(1) NOT NULL DEFAULT 0,
    queue_message_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wa_chat_waid(wa_message_id),
    INDEX idx_wa_chat_conv(conversation_id,id),
    INDEX idx_wa_chat_queue(queue_message_id),
    CONSTRAINT fk_wa_chat_conv FOREIGN KEY (conversation_id) REFERENCES wa_conversations(id) ON DELETE CASCADE
  )`);

  // ---- Opt-out / blacklist broadcast ----------------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS wa_blacklist (
    phone VARCHAR(32) NOT NULL PRIMARY KEY,
    customer_id BIGINT UNSIGNED NULL,
    reason VARCHAR(255) NULL,
    source ENUM('keyword','manual') NOT NULL DEFAULT 'keyword',
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_wa_blacklist_customer(customer_id)
  )`);

  // ---- Template resmi & balasan cepat ---------------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS wa_templates (
    template_key VARCHAR(40) NOT NULL PRIMARY KEY,
    title VARCHAR(120) NOT NULL,
    body TEXT NOT NULL,
    updated_by BIGINT UNSIGNED NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  for (const t of OFFICIAL_TEMPLATES) {
    await db.execute(`INSERT IGNORE INTO wa_templates(template_key,title,body) VALUES(?,?,?)`, [t.key, t.title, t.body]);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS wa_quick_replies (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    shortcut VARCHAR(40) NOT NULL,
    title VARCHAR(120) NOT NULL,
    body TEXT NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wa_quick_shortcut(shortcut)
  )`);
  for (const q of DEFAULT_QUICK_REPLIES) {
    await db.execute(`INSERT IGNORE INTO wa_quick_replies(shortcut,title,body) VALUES(?,?,?)`, [q.shortcut, q.title, q.body]);
  }

  await addForeignKey('wa_conversations', 'fk_wa_conv_customer', 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL');
  await addForeignKey('wa_blacklist', 'fk_wa_blacklist_customer', 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL');
  await addForeignKey('wa_messages', 'fk_wa_messages_broadcast', 'FOREIGN KEY (broadcast_id) REFERENCES wa_broadcasts(id) ON DELETE SET NULL');
  await addForeignKey('wa_messages', 'fk_wa_messages_conversation', 'FOREIGN KEY (conversation_id) REFERENCES wa_conversations(id) ON DELETE SET NULL');

  // ---- Pengaturan anti-ban & guard ------------------------------------------------------------------
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_antiban_json TEXT NULL`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_queue_paused TINYINT(1) NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_queue_paused_kind VARCHAR(30) NULL`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_queue_paused_reason VARCHAR(500) NULL`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_queue_paused_at DATETIME NULL`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_default_bank_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS wa_isolation_notice_enabled TINYINT(1) NOT NULL DEFAULT 1`);

  // ---- Segmentasi teknis pelanggan (opsional, untuk filter broadcast) -------------------------------
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS olt_id BIGINT UNSIGNED NULL`);
  await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS vlan VARCHAR(20) NULL`);
  await db.query(`ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_customers_olt(olt_id)`);
  await db.query(`ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_customers_vlan(vlan)`);
}

module.exports = { ensureV56Schema };
