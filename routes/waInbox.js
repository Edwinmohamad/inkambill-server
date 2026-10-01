// Web Inbox WhatsApp 2-arah (3 kolom) + API JSON yang dipakai public/js/wa-inbox.js.
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const db = require('../config/db');
const { isMasterAdminRole, isAdminRole } = require('../middleware/auth');
const { audit } = require('../services/auditService');
const inbox = require('../services/waInboxService');
const power = require('../services/waPowerActionService');
const antiBan = require('../services/waAntiBanService');
const { getGatewayStatus } = require('../services/whatsappGatewayService');
const { checkCustomer } = require('../services/networkService');
const router = express.Router();

const INBOX_PERMS = ['billing', 'support', 'customers', 'settings'];
function requireInbox(req, res, next) {
  if (!req.session.user) return req.path.startsWith('/api') ? res.status(401).json({ ok: false, message: 'Sesi berakhir, silakan login ulang.' }) : res.redirect('/login');
  if (INBOX_PERMS.some(p => (req.permissions || []).includes(p))) return next();
  if (req.path.startsWith('/api')) return res.status(403).json({ ok: false, message: 'Akses Web Inbox dibatasi.' });
  return res.status(403).render('errors/403', { title: 'Akses Dibatasi', requiredPermission: INBOX_PERMS.join(' / ') });
}
router.use(requireInbox);

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Lampiran harus JPG, PNG, WEBP, atau PDF.'))),
}).single('file');

// Bungkus handler API agar error selalu JSON (bukan halaman 500 HTML).
const api = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(`WA inbox API ${req.method} ${req.originalUrl}:`, e.message); if (!res.headersSent) res.status(e.status || 400).json({ ok: false, message: e.message }); }
};
const convId = req => { const id = Number(req.params.id); if (!Number.isInteger(id) || id <= 0) { const e = new Error('ID percakapan tidak valid.'); e.status = 400; throw e; } return id; };

router.get('/', async (req, res) => {
  const [admins] = await db.query(`SELECT id,name,role FROM users WHERE is_active=1 ORDER BY name`);
  const [banks] = await db.query(`SELECT id,bank_name,account_number,account_name FROM banks WHERE is_active=1 AND type IN ('bank_transfer','virtual_account','other') ORDER BY bank_name`);
  res.render('wa-inbox/index', {
    title: 'WA Inbox', admins, banks, departments: inbox.DEPARTMENTS,
    isMasterAdmin: isMasterAdminRole(req.session.user.role), isAdminUser: isAdminRole(req.session.user.role),
    initialConversationId: Number(req.query.c) || null, gateway: getGatewayStatus(), pause: antiBan.getPauseState(),
  });
});

router.get('/api/conversations', api(async (req, res) => {
  const data = await inbox.listConversations({ filter: String(req.query.filter || 'all'), q: String(req.query.q || ''), userId: req.session.user.id });
  res.set('Cache-Control', 'no-store').json({ ok: true, ...data, gateway: getGatewayStatus().state, pause: antiBan.getPauseState() });
}));

router.get('/api/conversations/:id', api(async (req, res) => {
  const detail = await inbox.getConversationDetail(convId(req));
  if (!detail) return res.status(404).json({ ok: false, message: 'Percakapan tidak ditemukan.' });
  res.set('Cache-Control', 'no-store').json({ ok: true, ...detail });
}));

router.get('/api/conversations/:id/messages', api(async (req, res) => {
  res.json({ ok: true, messages: await inbox.getMessages(convId(req), { beforeId: Number(req.query.before) || null }) });
}));

router.post('/api/conversations/:id/read', api(async (req, res) => { await inbox.markRead(convId(req)); res.json({ ok: true }); }));

router.post('/api/conversations/:id/messages', (req, res, next) => upload(req, res, err => err ? res.status(400).json({ ok: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Lampiran maksimal 6 MB.' : err.message }) : next()),
  api(async (req, res) => {
    const result = await inbox.sendReply({ conversationId: convId(req), text: req.body?.text, userId: req.session.user.id, file: req.file || null });
    res.json({ ok: true, ...result, gateway: getGatewayStatus().state });
  }));

router.post('/api/conversations/:id/notes', api(async (req, res) => {
  res.json({ ok: true, message: await inbox.addNote({ conversationId: convId(req), text: req.body?.text, userId: req.session.user.id }) });
}));

router.post('/api/conversations/:id/bot', api(async (req, res) => {
  res.json({ ok: true, conversation: await inbox.setBot({ conversationId: convId(req), enabled: !!req.body?.enabled }) });
}));

router.post('/api/conversations/:id/assign', api(async (req, res) => {
  const conversation = await inbox.assign({ conversationId: convId(req), assigneeUserId: req.body?.user_id, department: req.body?.department, actorName: req.session.user.name });
  res.json({ ok: true, conversation });
}));

router.post('/api/conversations/:id/link-customer', api(async (req, res) => {
  res.json({ ok: true, conversation: await inbox.linkCustomer({ conversationId: convId(req), customerId: req.body?.customer_id }) });
}));

router.post('/api/conversations/:id/ticket', api(async (req, res) => {
  if (!(req.permissions || []).includes('support') && !isAdminRole(req.session.user.role)) throw new Error('Butuh izin Support untuk membuat tiket.');
  const b = req.body || {};
  const t = await inbox.createTicketFromChat({ conversationId: convId(req), subject: b.subject, type: b.type, priority: b.priority, description: b.description, userId: req.session.user.id, actorName: req.session.user.name });
  await audit({ userId: req.session.user.id, action: 'create', entityType: 'ticket', entityId: t.id, description: `Tiket ${t.code} dibuat dari Web Inbox WA`, ip: req.ip });
  res.json({ ok: true, ticket: t });
}));

router.post('/api/conversations/:id/verify-payment', api(async (req, res) => {
  const perms = req.permissions || [];
  if (!perms.includes('billing') && !perms.includes('finance')) throw new Error('Butuh izin Billing/Finance untuk verifikasi pembayaran.');
  const b = req.body || {};
  const result = await power.verifyAndReactivate({ conversationId: convId(req), invoiceIds: b.invoice_ids, bankId: Number(b.bank_id) || null, proofChatMessageId: Number(b.proof_message_id) || null, user: req.session.user, ip: req.ip });
  res.json({ ok: true, ...result });
}));

router.post('/api/conversations/:id/check-network', api(async (req, res) => {
  const detail = await inbox.loadConversation(convId(req));
  if (!detail?.customer_id) throw new Error('Percakapan belum ditautkan ke pelanggan.');
  const r = await checkCustomer(detail.customer_id);
  res.json({ ok: true, status: r.status, ip: r.active?.address || null, uptime: r.active?.uptime || null, profile: r.secret?.profile || null });
}));

router.get('/api/quick-replies', api(async (req, res) => {
  const list = (await inbox.listQuickReplies()).filter(q => q.is_active);
  res.json({ ok: true, quickReplies: list });
}));
router.get('/api/quick-replies/:shortcut/render', api(async (req, res) => {
  const conv = req.query.c ? await inbox.loadConversation(Number(req.query.c)) : null;
  const text = await inbox.renderQuickReply(req.params.shortcut, conv?.customer_id || null);
  if (!text) return res.status(404).json({ ok: false, message: 'Balasan cepat tidak ditemukan.' });
  res.json({ ok: true, text });
}));

router.get('/api/customers/search', api(async (req, res) => {
  const like = `%${String(req.query.q || '').trim().slice(0, 60)}%`;
  const [rows] = await db.execute(`SELECT id,customer_code,name,phone,address FROM customers WHERE archived_at IS NULL AND (name LIKE ? OR customer_code LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 15`, [like, like, like]);
  res.json({ ok: true, customers: rows });
}));

// Media chat (foto bukti transfer, dokumen) — hanya untuk user login dengan izin inbox.
router.get('/media/:messageId', async (req, res) => {
  const info = await inbox.mediaFileFor(Number(req.params.messageId));
  if (!info || !fs.existsSync(info.file)) return res.status(404).send('Media tidak ditemukan.');
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.type(info.mime || 'application/octet-stream');
  if (!/^image\/|pdf/.test(info.mime || '')) res.set('Content-Disposition', `attachment; filename="${String(info.name || 'lampiran').replace(/["\r\n]/g, '')}"`);
  res.sendFile(info.file);
});

module.exports = router;
