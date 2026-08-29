const db = require('../config/db');

async function audit({ userId = null, action, entityType, entityId = null, description = null, ip = null }) {
  try {
    await db.execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, action, entityType, entityId, description, ip]
    );
  } catch (err) {
    console.error('Audit log gagal:', err.message);
  }
}

module.exports = { audit };
