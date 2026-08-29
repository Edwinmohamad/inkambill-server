const express = require('express');
const db = require('../config/db');
const { requireMasterAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../services/auditService');
const {
  startGateway, logoutGateway, getGatewayStatus, enqueueWaMessage,
  getQueueStats, getRecentMessages, DEFAULT_REMINDER_TEMPLATE, renderReminderTemplate,
} = require('../services/whatsappGatewayService');
const router = express.Router();

// v1.25 audit: /send and /blast used to be reachable by ANY authenticated user (even one whose only
// permission is 'dashboard'), letting them relay arbitrary messages through the company's connected
// WhatsApp number. Restricted to staff who actually work with customers/billing — same permissions that
// already gate the Tagihan/Pelanggan pages these buttons live on.
function requireWaSendPermission(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const perms = req.permissions || [];
  if (perms.includes('billing') || perms.includes('support') || perms.includes('customers')) return next();
  return res.status(403).json({ ok: false, message: 'Anda tidak memiliki izin untuk mengirim pesan WhatsApp.' });
}

// The connection-management page (QR code, connect/disconnect, auto-reminder settings) is gated behind
// the 'settings' permission — same tier as the Payment Gateways settings tab — since it links a real
// personal WhatsApp number to the app.
router.get('/', requirePermission('settings'), async (req, res) => {
  const [[settingsRow]] = await db.query(
    `SELECT wa_auto_reminder_enabled,wa_auto_reminder_hour,wa_auto_reminder_offsets,wa_auto_reminder_template FROM settings WHERE id=1 LIMIT 1`
  );
  const [stats, messages] = await Promise.all([getQueueStats(), getRecentMessages(50)]);
  res.render('whatsapp-gateway/index', {
    title: 'WA Gateway',
    gateway: getGatewayStatus(),
    stats,
    messages,
    reminderSettings: {
      enabled: !!settingsRow?.wa_auto_reminder_enabled,
      hour: Number(settingsRow?.wa_auto_reminder_hour ?? 9),
      offsets: settingsRow?.wa_auto_reminder_offsets || '-3,-1,0',
      template: settingsRow?.wa_auto_reminder_template || DEFAULT_REMINDER_TEMPLATE,
    },
    defaultReminderTemplate: DEFAULT_REMINDER_TEMPLATE,
  });
});

// Polled every few seconds by the WA Gateway page while a QR is pending / connection is settling, so
// the admin sees state changes without a full page reload.
router.get('/status.json', requirePermission('settings'), async (req, res) => {
  const stats = await getQueueStats();
  res.json({ gateway: getGatewayStatus(), stats });
});

// Connecting/disconnecting the gateway links a real personal WhatsApp number to this app, so it is
// deliberately restricted to Master Admin — the same sensitivity tier as Force Delete.
router.post('/connect', requireMasterAdmin, async (req, res) => {
  await startGateway();
  await audit({ userId: req.session.user.id, action: 'connect', entityType: 'wa_gateway', entityId: null, description: 'Memulai koneksi WA Gateway.', ip: req.ip });
  req.session.flash = { type: 'success', message: 'Menghubungkan WA Gateway... Scan QR code di bawah menggunakan WhatsApp di HP Anda.' };
  res.redirect('/wa-gateway');
});

router.post('/logout', requireMasterAdmin, async (req, res) => {
  await logoutGateway();
  await audit({ userId: req.session.user.id, action: 'logout', entityType: 'wa_gateway', entityId: null, description: 'Memutuskan WA Gateway dan menghapus sesi tersimpan.', ip: req.ip });
  req.session.flash = { type: 'success', message: 'WA Gateway diputuskan. Nomor WhatsApp tidak lagi terhubung ke aplikasi.' };
  res.redirect('/wa-gateway');
});

router.post('/settings', requireMasterAdmin, async (req, res) => {
  const b = req.body;
  const hour = Math.min(23, Math.max(0, Number(b.hour) || 9));
  const offsets = String(b.offsets || '-3,-1,0').split(',').map(s => Number(String(s).trim())).filter(n => Number.isFinite(n));
  const offsetsClean = offsets.length ? offsets.join(',') : '-3,-1,0';
  const template = String(b.template || '').trim() || null;
  await db.execute(
    `UPDATE settings SET wa_auto_reminder_enabled=?,wa_auto_reminder_hour=?,wa_auto_reminder_offsets=?,wa_auto_reminder_template=? WHERE id=1`,
    [b.enabled ? 1 : 0, hour, offsetsClean, template]
  );
  await audit({ userId: req.session.user.id, action: 'update', entityType: 'wa_gateway_settings', entityId: null, description: `Update pengaturan auto-reminder WA: enabled=${b.enabled ? 1 : 0}, jam=${hour}, offset=${offsetsClean}`, ip: req.ip });
  req.session.flash = { type: 'success', message: 'Pengaturan auto-reminder WA disimpan.' };
  res.redirect('/wa-gateway');
});

// AJAX manual send — used by the "Kirim Pengingat" button on Tagihan/Pelanggan. Falls back to wa.me
// deep-links on the client side automatically when the gateway isn't connected (see public/js/app.js).
router.post('/send', requireWaSendPermission, async (req, res) => {
  const status = getGatewayStatus();
  if (status.state !== 'connected') {
    return res.status(409).json({ ok: false, reason: 'not_connected', message: 'WA Gateway belum terhubung.' });
  }
  const { phone, message, customer_id, invoice_id } = req.body || {};
  if (!phone || !message) return res.status(400).json({ ok: false, message: 'Nomor dan pesan wajib diisi.' });
  const result = await enqueueWaMessage({
    phone, message,
    customerId: customer_id ? Number(customer_id) : null,
    invoiceId: invoice_id ? Number(invoice_id) : null,
    type: 'manual',
    userId: req.session.user.id,
  });
  if (result.status === 'failed') return res.status(400).json({ ok: false, message: result.reason });
  res.json({ ok: true, message: 'Pesan dimasukkan ke antrean pengiriman.' });
});

// AJAX bulk blast — used by the "WA Blast Massal" bulk action on Tagihan/Pelanggan. Enqueues one
// message per selected customer's most relevant open invoice (skips customers without a valid/open
// invoice or invalid WhatsApp number, and reports the skip count back to the caller).
router.post('/blast', requireWaSendPermission, async (req, res) => {
  const status = getGatewayStatus();
  if (status.state !== 'connected') {
    return res.status(409).json({ ok: false, reason: 'not_connected', message: 'WA Gateway belum terhubung.' });
  }
  const ids = [...new Set([].concat(req.body?.customer_ids || []).map(x => Number(x)).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ ok: false, message: 'Tidak ada pelanggan terpilih.' });
  if (ids.length > 500) return res.status(400).json({ ok: false, message: 'Maksimal 500 pelanggan per blast.' });
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT c.id customer_id,c.customer_code,c.name,c.phone,c.whatsapp_status,
            i.id invoice_id,i.invoice_number,i.outstanding,i.due_date,i.period_month,i.period_year
     FROM customers c
     LEFT JOIN invoices i ON i.id=(SELECT i2.id FROM invoices i2 WHERE i2.customer_id=c.id AND i2.status IN ('unpaid','partial','overdue') AND i2.outstanding>0 ORDER BY i2.period_year DESC,i2.period_month DESC,i2.id DESC LIMIT 1)
     WHERE c.id IN (${placeholders})`,
    ids
  );
  const [[settingsRow]] = await db.query(`SELECT wa_auto_reminder_template FROM settings WHERE id=1 LIMIT 1`);
  let enqueued = 0, skippedNoWa = 0, skippedNoInvoice = 0;
  for (const row of rows) {
    if (row.whatsapp_status !== 'valid') { skippedNoWa++; continue; }
    if (!row.invoice_id) { skippedNoInvoice++; continue; }
    const message = renderReminderTemplate(req.body.template || settingsRow?.wa_auto_reminder_template, {
      name: row.name, customer_code: row.customer_code, outstanding: row.outstanding,
      invoice_number: row.invoice_number, due_date: row.due_date, period_month: row.period_month, period_year: row.period_year,
    });
    await enqueueWaMessage({ phone: row.phone, message, customerId: row.customer_id, invoiceId: row.invoice_id, type: 'blast', userId: req.session.user.id });
    enqueued++;
  }
  await audit({ userId: req.session.user.id, action: 'blast', entityType: 'wa_gateway', entityId: null, description: `WA Blast massal ke ${enqueued} pelanggan (${skippedNoWa} dilewati nomor tidak valid, ${skippedNoInvoice} dilewati tidak ada tagihan terbuka).`, ip: req.ip });
  res.json({ ok: true, enqueued, skippedNoWa, skippedNoInvoice });
});

module.exports = router;
