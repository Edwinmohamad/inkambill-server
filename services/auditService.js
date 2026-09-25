const db = require('../config/db');

// Kolom audit_logs: entity_type/entity_id = target_type/target_id pada spesifikasi NMS v2.
// details (JSON) & site_id ditambahkan oleh services/nms/schema.js. Jika kolom baru belum ada
// (startup pertama sebelum migrasi selesai), insert jatuh kembali ke format lama.
async function audit({ userId = null, action, entityType, entityId = null, description = null, ip = null, details = null, siteId = null }) {
  const detailJson = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
  try {
    await db.execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, ip_address, details, site_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, action, entityType, entityId == null ? null : entityId, description, ip, detailJson, siteId || null]
    );
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await db.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, action, entityType, entityId, description, ip]);
        return;
      } catch (inner) { console.error('Audit log gagal:', inner.message); return; }
    }
    console.error('Audit log gagal:', err.message);
  }
}

module.exports = { audit };
