const express = require('express');
const db = require('../config/db');
const { runAutoIsolation } = require('../services/networkService');
const { enqueueWaMessage, runAutoReminderSweep, approvalBatchKey } = require('../services/whatsappGatewayService');
const { syncStockAlert } = require('../services/inventoryService');
const { handleWaTicketMessage } = require('../services/waTicketCommandService');
const router = express.Router();

async function beginEvent(eventType, req, keyOverride = null) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = String(keyOverride || req.get('x-idempotency-key') || body.event_key || `${eventType}:${Date.now()}:${Math.random()}`).slice(0, 190);
  const [result] = await db.execute(`INSERT IGNORE INTO n8n_webhook_events(event_key,event_type,payload_json,status,processed_at) VALUES(?,?,?,?,NOW())`, [key, eventType, JSON.stringify(body).slice(0, 200000), 'processed']);
  return { key, duplicate: result.affectedRows === 0 };
}

router.get('/health', (req, res) => res.json({ ok: true, service: 'inkambilling-n8n', now: new Date().toISOString() }));

router.post('/inventory/movement', async (req, res) => {
  const event = await beginEvent('inventory.movement', req);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key });
  const b = req.body || {};
  const itemId = Number(b.item_id);
  const qty = Math.abs(Number(b.qty));
  const type = ['in', 'out', 'adjustment'].includes(String(b.movement_type)) ? String(b.movement_type) : 'adjustment';
  if (!itemId || !qty || !Number.isFinite(qty)) return res.status(422).json({ ok: false, error: 'item_id dan qty wajib valid.' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[item]] = await conn.query(`SELECT id,name,qty FROM inventory_items WHERE id=? AND is_active=1 AND deleted_at IS NULL FOR UPDATE`, [itemId]);
    if (!item) throw new Error('Item tidak ditemukan atau sudah diarsipkan.');
    const signed = type === 'out' ? -qty : qty;
    if (Number(item.qty) + signed < 0) throw new Error(`Stock ${item.name} tidak cukup.`);
    await conn.execute(`UPDATE inventory_items SET qty=qty+? WHERE id=?`, [signed, itemId]);
    await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,?,?,?,?,?)`, [itemId, type, qty, b.reference || `N8N-${event.key}`, b.notes || null, null]);
    await conn.commit();
    await syncStockAlert(itemId);
    return res.json({ ok: true, eventKey: event.key, itemId, type, qty });
  } catch (error) {
    await conn.rollback();
    await db.execute(`UPDATE n8n_webhook_events SET status='failed',error_message=? WHERE event_key=?`, [error.message.slice(0, 1000), event.key]);
    return res.status(400).json({ ok: false, eventKey: event.key, error: error.message });
  } finally { conn.release(); }
});

router.post('/piket-proof', async (req, res) => {
  const event = await beginEvent('piket.proof', req);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key });
  const b = req.body || {};
  if (!b.file_path || !b.proof_date) return res.status(422).json({ ok: false, error: 'file_path dan proof_date wajib diisi.' });
  const [result] = await db.execute(`INSERT INTO piket_proofs(user_id,technician_name,proof_date,site_id,file_path,file_url,mime_type,file_size,caption,source) VALUES(?,?,?,?,?,?,?,?,?,?)`, [Number(b.user_id) || null, b.technician_name || null, b.proof_date, Number(b.site_id) || null, String(b.file_path).slice(0, 500), b.file_url || null, b.mime_type || null, Number(b.file_size) || null, b.caption || null, b.source || 'n8n']);
  res.status(201).json({ ok: true, eventKey: event.key, id: result.insertId });
});

router.post('/tickets', async (req, res) => {
  const event = await beginEvent('ticket.create', req);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key });
  const b = req.body || {};
  const subject = String(b.subject || '').trim();
  if (!subject) return res.status(422).json({ ok: false, error: 'subject wajib diisi.' });
  const code = `N8N-${Date.now().toString(36).toUpperCase()}`;
  const [[actor]] = await db.query(`SELECT id FROM users WHERE is_active=1 ORDER BY FIELD(role,'master_admin','admin'),id LIMIT 1`);
  const [result] = await db.execute(`INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,opened_by,opened_at,source) VALUES(?,?,?,?,?,'open',?,?,NOW(),'n8n')`, [code, Number(b.customer_id) || null, subject, b.type || 'Gangguan Internet', ['low', 'medium', 'high', 'critical'].includes(b.priority) ? b.priority : 'medium', b.description || null, Number(b.opened_by_id) || actor?.id || null]);
  res.status(201).json({ ok: true, eventKey: event.key, id: result.insertId, ticket_code: code });
});

router.patch('/tickets/:id', async (req, res) => {
  const event = await beginEvent('ticket.update', req);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key });
  const status = String(req.body?.status || '');
  if (!['open', 'progress', 'pending', 'closed'].includes(status)) return res.status(422).json({ ok: false, error: 'status tiket tidak valid.' });
  const [[ticket]] = await db.query(`SELECT t.id,t.ticket_code,c.phone,c.name customer_name FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=? LIMIT 1`, [req.params.id]);
  if (!ticket) return res.status(404).json({ ok: false, error: 'Tiket tidak ditemukan.' });
  await db.execute(`UPDATE tickets SET status=?,closed_at=IF(?='closed',COALESCE(closed_at,NOW()),NULL) WHERE id=?`, [status, status, ticket.id]);
  if (ticket.phone && req.body.notify_customer && req.body.message) await enqueueWaMessage({ phone: ticket.phone, message: String(req.body.message), customerId: null, type: 'manual', approvalBatch: approvalBatchKey('n8n_ticket') });
  res.json({ ok: true, eventKey: event.key, ticketId: ticket.id, status });
});

// WA ticket bot (n8n/06-wa-ticket-bot.json). Body = the raw WAHA webhook body ({ event, payload })
// or just the payload. Non-command chatter is answered with handled:false BEFORE being logged, so
// ordinary conversations never land in n8n_webhook_events. Idempotent on the WhatsApp message id:
// WAHA/n8n retries of the same message do not create a second ticket/update.
router.post('/wa/command', async (req, res) => {
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : (req.body || {});
  const text = String(payload.body || payload.caption || '').trim();
  const prefix = String(process.env.WA_TICKET_PREFIX || '#').trim() || '#';
  if (payload.fromMe || !text.startsWith(prefix)) return res.json({ ok: true, handled: false, reason: payload.fromMe ? 'from_me' : 'not_command', replies: [] });
  const messageKey = payload.id ? `wa.command:${payload.id}` : null;
  const event = await beginEvent('wa.ticket-command', req, messageKey);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key, replies: [] });
  try {
    const result = await handleWaTicketMessage(payload);
    return res.json({ ok: true, eventKey: event.key, ...result });
  } catch (error) {
    console.error('WA ticket bot error:', error);
    await db.execute(`UPDATE n8n_webhook_events SET status='failed',error_message=? WHERE event_key=?`, [String(error.message).slice(0, 1000), event.key]);
    const chatId = String(payload.from || '');
    return res.json({ ok: false, eventKey: event.key, error: error.message, replies: chatId ? [{ chatId, text: '⚠️ Maaf, perintah gagal diproses server. Coba lagi atau input lewat web.', reply_to: payload.id || null }] : [] });
  }
});

router.post('/billing/reminder', async (req, res) => {
  const event = await beginEvent('billing.reminder', req);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key });
  if (req.body?.invoice_id && req.body?.phone && req.body?.message) {
    await enqueueWaMessage({ phone: req.body.phone, message: String(req.body.message), invoiceId: Number(req.body.invoice_id) || null, customerId: Number(req.body.customer_id) || null, type: 'auto_reminder', approvalBatch: approvalBatchKey('n8n_reminder') });
    return res.json({ ok: true, eventKey: event.key, queued: 0, pendingApproval: 1 });
  }
  const result = await runAutoReminderSweep();
  res.json({ ok: true, eventKey: event.key, ...result });
});

router.post('/auto-isolate', async (req, res) => {
  const event = await beginEvent('network.auto-isolate', req);
  if (event.duplicate) return res.json({ ok: true, duplicate: true, eventKey: event.key });
  if (req.body?.apply !== true && String(req.body?.apply || '') !== '1') return res.json({ ok: true, eventKey: event.key, dryRun: true, message: 'Preview saja. Kirim apply=true untuk menjalankan isolasi.' });
  const result = await runAutoIsolation();
  res.json({ ok: true, eventKey: event.key, ...result });
});

// NMS v2 — real-time PPP event dari RouterOS (PPP profile on-up/on-down → /tool fetch) atau n8n.
// Body: { router_id | router_name, username, event: 'login'|'logout'|'auth_failed', address?, caller_id?, message?, occurred_at? }
router.post('/nms/ppp-event', async (req, res) => {
  try {
    const b = req.body || {};
    const type = ['login', 'logout', 'auth_failed'].includes(String(b.event)) ? String(b.event) : null;
    if (!type) return res.status(400).json({ ok: false, error: 'event wajib login|logout|auth_failed' });
    const [[routerRow]] = await db.query(`SELECT r.*, s.code site_code FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 AND (r.id=? OR r.name=?) LIMIT 1`, [Number(b.router_id) || 0, String(b.router_name || '')]);
    if (!routerRow) return res.status(404).json({ ok: false, error: 'Router tidak dikenal' });
    const { ingestEvent } = require('../services/nms/poller');
    const out = await ingestEvent({ router: routerRow, username: b.username ? String(b.username) : null, type, address: b.address || null, callerId: b.caller_id || null, message: b.message ? String(b.message).slice(0, 255) : null, source: 'webhook', occurredAt: b.occurred_at || null, dedup: b.event_key ? String(b.event_key).slice(0, 190) : null });
    res.json({ ok: true, ...out });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

module.exports = router;
