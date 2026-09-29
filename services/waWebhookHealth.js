'use strict';
const db = require('../config/db');
const startedAt = new Date().toISOString();
let lastEventAt = null, lastMessageAt = null, lastErrorAt = null, lastError = null;
let events = 0, inbound = 0;
async function persist(eventType, outcome) {
  try {
    await db.execute(`INSERT INTO wa_webhook_events(event_type,outcome) VALUES(?,?)`, [String(eventType || 'unknown').slice(0, 40), outcome]);
    // Low frequency maintenance; never delete recent diagnostics.
    if ((events % 200) === 0) await db.query(`DELETE FROM wa_webhook_events WHERE created_at<DATE_SUB(NOW(),INTERVAL 30 DAY)`);
  } catch (e) { console.error('WA webhook: gagal menyimpan diagnostik:', e.message); }
}
async function record(event, result) {
  lastEventAt = new Date().toISOString(); events++;
  if ((event === 'message' || event === 'message.any') && result && !result.skipped) {
    lastMessageAt = lastEventAt; inbound++;
    await persist(event, 'received');
  } else if (event === 'session.status') await persist(event, 'received');
}
async function error(err) {
  lastErrorAt = new Date().toISOString();
  lastError = String(err?.message || err).slice(0, 200);
  await persist('processing', 'error');
}
async function snapshot() {
  const [rows] = await db.query(`SELECT
    MAX(created_at) last_event,
    MAX(CASE WHEN event_type IN ('message','message.any') AND outcome='received' THEN created_at END) last_message,
    MAX(CASE WHEN outcome='error' THEN created_at END) last_error,
    SUM(CASE WHEN event_type IN ('message','message.any') AND outcome='received' THEN 1 ELSE 0 END) inbound_total
    FROM wa_webhook_events`);
  const h = rows[0] || {};
  return { startedAt, lastEventAt: h.last_event || lastEventAt, lastMessageAt: h.last_message || lastMessageAt,
    lastErrorAt: h.last_error || lastErrorAt, lastError: lastErrorAt ? lastError : (h.last_error ? 'Kegagalan pemrosesan webhook tercatat di log aplikasi.' : null),
    events, inbound: Number(h.inbound_total || inbound) };
}
module.exports = { record, error, snapshot };
