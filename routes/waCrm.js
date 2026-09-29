// WA CRM: Broadcast selektif/terjadwal, pengaturan Anti-Ban, template resmi, balasan cepat, blacklist.
// Dipasang di /wa-gateway bersama routes/whatsappGateway.js (path berbeda, tidak bentrok).
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../config/db');
const { requireMasterAdmin, isAdminRole } = require('../middleware/auth');
const { audit } = require('../services/auditService');
const antiBan = require('../services/waAntiBanService');
const tpl = require('../services/waTemplateService');
const bc = require('../services/waBroadcastService');
const { isBlastEnabled, processQueue, getGatewayStatus } = require('../services/whatsappGatewayService');
const router = express.Router();
const broadcastUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Lampiran harus JPG, PNG, WEBP, atau PDF.')) }).single('file');

const SEND_PERMS = ['billing', 'support', 'customers'];
function requireBroadcaster(req, res, next) {
  const ok = !!req.session.user && isAdminRole(req.session.user.role) && SEND_PERMS.some(p => (req.permissions || []).includes(p));
  if (ok) return next();
  if (req.accepts(['html', 'json']) === 'json' || req.path.includes('/api/') || req.method !== 'GET') return res.status(403).json({ ok: false, message: 'Broadcast hanya untuk Admin dengan izin Billing/Support/Pelanggan.' });
  req.session.flash = { type: 'danger', message: 'Broadcast hanya untuk Admin.' };
  return res.redirect('/wa-gateway');
}
const api = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(`WA CRM ${req.method} ${req.originalUrl}:`, e.message); if (!res.headersSent) res.status(400).json({ ok: false, message: e.message }); }
};
function filterFrom(src = {}) {
  return {
    billing: bc.BILLING_FILTERS[src.billing] ? src.billing : 'all',
    ...bc.invoiceSelection(src), require_invoice: src.require_invoice === '1',
    site_id: src.site_id, cluster_id: src.cluster_id, router_id: src.router_id, olt_id: src.olt_id, package_id: src.package_id,
    vlan: src.vlan || '', q: src.q || '', customer_ids: src.customer_ids ? [].concat(src.customer_ids) : [],
  };
}
function back(req, res, tab, flash) { req.session.flash = flash; res.redirect(`/wa-gateway#${tab}`); }

// ---- Broadcast ------------------------------------------------------------------------------------
router.get('/broadcast', requireBroadcaster, async (req, res) => {
  const [templates] = await db.query(`SELECT template_key,title,body FROM wa_templates ORDER BY FIELD(template_key,'reminder','isolation','outage','receipt'),template_key`);
  res.render('whatsapp-gateway/broadcast', {
    title: 'Pusat Pesan WA', options: await bc.filterOptions(), followUp: await bc.followUpSummary(), billingFilters: bc.BILLING_FILTERS, templates,
    variables: tpl.VARIABLES, broadcasts: await bc.listBroadcasts(20), blastEnabled: isBlastEnabled(),
    antiban: await antiBan.getConfig(), pause: antiBan.getPauseState(), gateway: getGatewayStatus(), maxRecipients: bc.MAX_RECIPIENTS,
  });
});
router.get('/broadcast/api/follow-up', requireBroadcaster, api(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, ...(await bc.followUpSummary()) });
}));
router.get('/broadcast/api/candidates', requireBroadcaster, api(async (req, res) => {
  const { rows, total, eligible } = await bc.listCandidates(filterFrom(req.query), { limit: 500 });
  res.set('Cache-Control', 'no-store').json({ ok: true, total, eligible, rows: rows.map(r => ({ ...r, blacklisted: !!Number(r.blacklisted), package: tpl.packageLabel(r.package_name, r.speed_label) })) });
}));
router.post('/broadcast/api/preview', requireBroadcaster, api(async (req, res) => {
  const b = req.body || {};
  const bank = await tpl.getDefaultBank();
  const row = Number(b.customer_id) ? await tpl.loadCustomerRow(Number(b.customer_id)) : { customer_name: 'Budi Santoso', customer_code: 'PLG-0001', package_name: 'Home', speed_label: '10Mbps', outstanding: 150000, due_date: new Date(Date.now() + 3 * 864e5), invoice_number: 'INV-CONTOH-001' };
  const candidate = Number(b.customer_id) ? (await bc.listCandidates({ customer_ids: [Number(b.customer_id)], ...bc.invoiceSelection(b) }, { limit: 1 })).rows[0] : null;
  if (candidate && bc.BILLING_VARS.test(String(b.message || '')) && !Number(candidate.open_invoice_count)) throw new Error('Pelanggan ini tidak memiliki invoice terbuka pada periode tagihan pilihan.');
  const vars = bc.broadcastVars(row || {}, candidate, bank, { detail_gangguan: b.detail_gangguan || undefined, estimasi_selesai: b.estimasi_selesai || undefined, jadwal_pemeliharaan: b.jadwal_pemeliharaan || undefined, isi_pengumuman: b.isi_pengumuman || undefined });
  const samples = [0, 1, 2].map(() => tpl.renderTemplate(String(b.message || ''), vars));
  res.json({ ok: true, samples: [...new Set(samples)] });
}));
router.post('/broadcast/api/test-send', requireBroadcaster, api(async (req, res) => {
  if (getGatewayStatus().state !== 'connected') throw new Error('WA Gateway belum terhubung.');
  const b = req.body || {}; const phone = String(b.phone || '').trim();
  if (!phone) throw new Error('Nomor WhatsApp tujuan uji wajib diisi.');
  const bank = await tpl.getDefaultBank();
  const row = Number(b.customer_id) ? await tpl.loadCustomerRow(Number(b.customer_id)) : { customer_name: 'Pelanggan Contoh', customer_code: 'TEST', package_name: 'Paket Internet', outstanding: 150000, due_date: new Date(), invoice_number: 'INV-TEST' };
  const candidate = Number(b.customer_id) ? (await bc.listCandidates({ customer_ids: [Number(b.customer_id)], ...bc.invoiceSelection(b) }, { limit: 1 })).rows[0] : null;
  if (candidate && bc.BILLING_VARS.test(String(b.message || '')) && !Number(candidate.open_invoice_count)) throw new Error('Pelanggan ini tidak memiliki invoice terbuka pada periode tagihan pilihan.');
  const extra = { detail_gangguan: b.detail_gangguan, estimasi_selesai: b.estimasi_selesai, jadwal_pemeliharaan: b.jadwal_pemeliharaan, isi_pengumuman: b.isi_pengumuman };
  const message = `[PESAN UJI — TIDAK UNTUK PELANGGAN]\n\n${tpl.renderTemplate(String(b.message || ''), bc.broadcastVars(row || {}, candidate, bank, extra))}`;
  if (!String(b.message || '').trim()) throw new Error('Naskah pesan wajib diisi.');
  const result = await require('../services/whatsappGatewayService').enqueueWaMessage({ phone, message, customerId: row?.customer_id || null, type: 'manual', userId: req.session.user.id });
  if (result.status === 'failed') throw new Error(result.reason || 'Nomor uji tidak valid.');
  res.json({ ok: true, id: result.id });
}));
router.get('/broadcast/api/list', requireBroadcaster, api(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, broadcasts: await bc.listBroadcasts(20), pause: antiBan.getPauseState() });
}));
router.post('/broadcast', requireBroadcaster, (req, res, next) => broadcastUpload(req, res, err => err ? res.status(400).json({ ok: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Lampiran maksimal 6 MB.' : err.message }) : next()), api(async (req, res) => {
  if (!isBlastEnabled()) throw new Error('Fitur WA Blast/Broadcast massal sedang dinonaktifkan. Aktifkan di WA Gateway → Pesan Otomatis (Master Admin).');
  const b = req.body || {};
  const filter = filterFrom(b);
  if (b.target_mode === 'selected' && !filter.customer_ids.length) throw new Error('Belum ada pelanggan yang dipilih.');
  if (b.target_mode === 'selected') {
    // Pilihan dapat dikumpulkan dari beberapa pencarian/site. Filter terakhir hanya
    // mengatur daftar yang tampil, bukan membatasi penerima yang telah dipilih.
    Object.assign(filter, { billing: 'all', site_id: null, cluster_id: null, router_id: null,
      olt_id: null, package_id: null, vlan: '', q: '' });
  } else filter.customer_ids = [];
  const result = await bc.createBroadcast({ name: b.name, templateKey: b.template_key || null, message: b.message, extra: { detail_gangguan: b.detail_gangguan, estimasi_selesai: b.estimasi_selesai, jadwal_pemeliharaan: b.jadwal_pemeliharaan, isi_pengumuman: b.isi_pengumuman }, filter, mode: b.mode === 'scheduled' ? 'scheduled' : 'direct', scheduledAt: b.scheduled_at, userId: req.session.user.id, mediaFile: req.file || null, requestKey: b.request_key });
  if (!result.duplicate) await audit({ userId: req.session.user.id, action: 'blast', entityType: 'wa_broadcast', entityId: result.id, description: `Broadcast WA "${String(b.name || '').slice(0, 80)}": ${result.queued} penerima${result.scheduledAt ? ` · terjadwal` : ''} (${result.skippedBlacklist} blacklist, ${result.skippedInvalid} nomor tidak valid)`, ip: req.ip });
  res.json({ ok: true, ...result });
}));
router.post('/broadcast/api/manual-send', requireBroadcaster, api(async (req, res) => {
  const id = Number(req.body?.customer_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Pilih satu pelanggan terlebih dahulu.');
  const { rows } = await bc.listCandidates({ billing: 'all', customer_ids: [id], ...bc.invoiceSelection(req.body) }, { limit: 1 });
  const customer = rows[0];
  if (!customer || customer.whatsapp_status !== 'valid' || !customer.phone || Number(customer.blacklisted)) {
    throw new Error('Pelanggan tidak aktif, nomor WhatsApp belum valid, atau menolak pesan broadcast.');
  }
  const draft = String(req.body?.message || '').trim();
  if (!draft || draft.length > 4000) throw new Error('Pesan wajib diisi (maksimal 4000 karakter).');
  if (bc.BILLING_VARS.test(draft) && !Number(customer.open_invoice_count)) throw new Error('Pelanggan ini tidak memiliki invoice terbuka pada periode tagihan pilihan.');
  const bank = await tpl.getDefaultBank();
  const row = await tpl.loadCustomerRow(id);
  const extra = { detail_gangguan: req.body?.detail_gangguan, estimasi_selesai: req.body?.estimasi_selesai,
    jadwal_pemeliharaan: req.body?.jadwal_pemeliharaan, isi_pengumuman: req.body?.isi_pengumuman };
  const message = tpl.renderTemplate(draft, bc.broadcastVars(row || customer, customer, bank, extra));
  const requestKey = String(req.body?.request_key || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)) throw new Error('Kunci pengiriman tidak valid. Muat ulang halaman lalu coba lagi.');
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify([id, message])).digest('hex');
  try {
    await db.execute(`INSERT INTO wa_manual_requests(user_id,request_key,customer_id,payload_hash) VALUES(?,?,?,?)`, [req.session.user.id, requestKey, id, payloadHash]);
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const [[previous]] = await db.execute(`SELECT r.customer_id,r.payload_hash,r.wa_message_id,m.status FROM wa_manual_requests r
      LEFT JOIN wa_messages m ON m.id=r.wa_message_id WHERE r.user_id=? AND r.request_key=?`, [req.session.user.id, requestKey]);
    if (!previous || Number(previous.customer_id) !== id || previous.payload_hash !== payloadHash) throw new Error('Isi permintaan berubah. Perbarui halaman sebelum mengirim lagi.');
    if (!previous.wa_message_id) throw new Error('Status pengiriman sebelumnya belum pasti. Periksa Log Pengiriman sebelum mencoba lagi.');
    if (previous.status === 'failed') throw new Error('Permintaan sebelumnya gagal. Periksa Log Pengiriman, lalu muat ulang halaman sebelum mencoba lagi.');
    return res.json({ ok: true, id: previous.wa_message_id, customer: customer.name, duplicate: true, status: previous.status });
  }
  const { enqueueWaMessage } = require('../services/whatsappGatewayService');
  const result = await enqueueWaMessage({ phone: customer.phone, message, customerId: id, type: 'manual', userId: req.session.user.id });
  await db.execute(`UPDATE wa_manual_requests SET wa_message_id=? WHERE user_id=? AND request_key=?`, [result.id, req.session.user.id, requestKey]);
  if (result.status === 'failed') throw new Error(result.reason || 'Nomor WhatsApp tidak valid.');
  await audit({ userId: req.session.user.id, action: 'send', entityType: 'wa_message', entityId: result.id,
    description: `Pesan manual ke pelanggan ${customer.customer_code || id}`, ip: req.ip });
  res.json({ ok: true, id: result.id, customer: customer.name });
}));
router.get('/broadcast/:id/recipients', requireBroadcaster, api(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('ID broadcast tidak valid.');
  const [[campaign]] = await db.execute(`SELECT id FROM wa_broadcasts WHERE id=?`, [id]);
  if (!campaign) return res.status(404).json({ ok: false, message: 'Broadcast tidak ditemukan.' });
  const [rows] = await db.execute(`SELECT m.id,m.phone,m.status,m.error_message,m.sent_at,m.created_at,
    c.name customer_name,c.customer_code FROM wa_messages m LEFT JOIN customers c ON c.id=m.customer_id
    WHERE m.broadcast_id=? ORDER BY m.id ASC LIMIT 1000`, [id]);
  res.set('Cache-Control', 'no-store').json({ ok: true, recipients: rows });
}));
router.post('/broadcast/:id/:action', requireBroadcaster, api(async (req, res) => {
  if (!['pause', 'resume', 'cancel', 'retry'].includes(req.params.action)) throw new Error('Aksi tidak dikenal.');
  await bc.setBroadcastStatus(Number(req.params.id), req.params.action, req.session.user.id);
  await audit({ userId: req.session.user.id, action: req.params.action, entityType: 'wa_broadcast', entityId: Number(req.params.id), description: `Broadcast WA #${req.params.id}: ${req.params.action}`, ip: req.ip });
  res.json({ ok: true });
}));

// ---- Anti-ban & guard antrean -----------------------------------------------------------------------
router.post('/antiban-settings', requireMasterAdmin, async (req, res) => {
  const b = req.body || {};
  const c = await antiBan.saveConfig({
    minDelaySec: b.min_delay, maxDelaySec: b.max_delay, longPauseEvery: b.long_pause_every, longPauseMinSec: b.long_pause_min, longPauseMaxSec: b.long_pause_max,
    typingMinSec: b.typing_min, typingMaxSec: b.typing_max, simulateTyping: !!b.simulate_typing, markReadBeforeReply: !!b.mark_read,
    workStartHour: b.work_start, workEndHour: b.work_end, hourlyLimit: b.hourly_limit, optOutKeywords: b.optout_keywords,
  });
  await db.execute(`UPDATE settings SET wa_isolation_notice_enabled=? WHERE id=1`, [b.isolation_notice ? 1 : 0]);
  await audit({ userId: req.session.user.id, action: 'update', entityType: 'wa_antiban', entityId: null, description: `Anti-ban WA: jeda ${c.minDelaySec}-${c.maxDelaySec}s, long pause ${c.longPauseMinSec}-${c.longPauseMaxSec}s/${c.longPauseEvery} pesan, jam ${c.workStartHour}-${c.workEndHour}, ${c.hourlyLimit}/jam`, ip: req.ip });
  back(req, res, 'antiban', { type: 'success', message: 'Pengaturan anti-ban disimpan.' });
});
router.post('/queue/:action', async (req, res) => {
  if (!['pause', 'resume'].includes(req.params.action)) return back(req, res, 'antiban', { type: 'danger', message: 'Aksi tidak dikenal.' });
  if (!isAdminRole(req.session.user?.role)) return back(req, res, 'antiban', { type: 'danger', message: 'Hanya Admin yang dapat menjeda/melanjutkan antrean.' });
  if (req.params.action === 'pause') await antiBan.pauseQueue('manual', `Dijeda oleh ${req.session.user.name}`, { notify: false });
  else { await antiBan.resumeQueue(`manual: ${req.session.user.name}`); processQueue(); }
  await audit({ userId: req.session.user.id, action: req.params.action, entityType: 'wa_queue', entityId: null, description: `Antrean WA ${req.params.action === 'pause' ? 'dijeda' : 'dilanjutkan'}`, ip: req.ip });
  back(req, res, 'antiban', { type: 'success', message: req.params.action === 'pause' ? 'Seluruh antrean pengiriman dijeda.' : 'Antrean pengiriman dilanjutkan.' });
});

// ---- Template resmi ---------------------------------------------------------------------------------
router.post('/templates/:key', requireMasterAdmin, async (req, res) => {
  const key = String(req.params.key);
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  if (!body) return back(req, res, 'template', { type: 'danger', message: 'Isi template tidak boleh kosong.' });
  const [r] = await db.execute(`UPDATE wa_templates SET body=?,updated_by=? WHERE template_key=?`, [body, req.session.user.id, key]);
  await audit({ userId: req.session.user.id, action: 'update', entityType: 'wa_template', entityId: null, description: `Template WA "${key}" diperbarui`, ip: req.ip });
  back(req, res, 'template', { type: r.affectedRows ? 'success' : 'warning', message: r.affectedRows ? 'Template disimpan.' : 'Template tidak ditemukan.' });
});
router.post('/templates/:key/reset', requireMasterAdmin, async (req, res) => {
  const def = tpl.OFFICIAL_TEMPLATES.find(t => t.key === req.params.key);
  if (def) await db.execute(`UPDATE wa_templates SET body=?,updated_by=? WHERE template_key=?`, [def.body, req.session.user.id, def.key]);
  back(req, res, 'template', { type: def ? 'success' : 'warning', message: def ? 'Template dikembalikan ke naskah resmi.' : 'Template tidak dikenal.' });
});
router.post('/default-bank', requireMasterAdmin, async (req, res) => {
  const id = Number(req.body?.bank_id) || null;
  await db.execute(`UPDATE settings SET wa_default_bank_id=? WHERE id=1`, [id]);
  tpl.invalidateBankCache();
  back(req, res, 'template', { type: 'success', message: 'Rekening tujuan untuk variabel {nama_bank}/{nomor_rekening} disimpan.' });
});

// ---- Balasan cepat (slash command) ------------------------------------------------------------------
router.post('/quick-replies', requireMasterAdmin, async (req, res) => {
  const b = req.body || {};
  const shortcut = String(b.shortcut || '').trim().replace(/^\//, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const title = String(b.title || '').trim().slice(0, 120); const body = String(b.body || '').trim().slice(0, 4000);
  if (!shortcut || !title || !body) return back(req, res, 'quickreply', { type: 'danger', message: 'Shortcut, judul, dan isi wajib diisi.' });
  await db.execute(`INSERT INTO wa_quick_replies(shortcut,title,body,is_active) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),body=VALUES(body),is_active=VALUES(is_active)`, [shortcut, title, body, b.is_active === '0' ? 0 : 1]);
  back(req, res, 'quickreply', { type: 'success', message: `Balasan cepat /${shortcut} disimpan.` });
});
router.post('/quick-replies/:id/delete', requireMasterAdmin, async (req, res) => {
  await db.execute(`DELETE FROM wa_quick_replies WHERE id=?`, [Number(req.params.id)]);
  back(req, res, 'quickreply', { type: 'success', message: 'Balasan cepat dihapus.' });
});

// ---- Blacklist broadcast (opt-out) -----------------------------------------------------------------
router.post('/blacklist', async (req, res) => {
  if (!isAdminRole(req.session.user?.role)) return back(req, res, 'antiban', { type: 'danger', message: 'Hanya Admin.' });
  const { validateWhatsapp } = require('../services/whatsappService');
  const wa = validateWhatsapp(req.body?.phone);
  if (!wa.valid) return back(req, res, 'antiban', { type: 'danger', message: `Nomor tidak valid: ${wa.reason}` });
  await antiBan.addToBlacklist(wa.normalized, { reason: String(req.body?.reason || 'Ditambahkan manual').slice(0, 255), source: 'manual', userId: req.session.user.id });
  back(req, res, 'antiban', { type: 'success', message: `+${wa.normalized} masuk blacklist broadcast.` });
});
router.post('/blacklist/:phone/delete', async (req, res) => {
  if (!isAdminRole(req.session.user?.role)) return back(req, res, 'antiban', { type: 'danger', message: 'Hanya Admin.' });
  await antiBan.removeFromBlacklist(String(req.params.phone).replace(/\D/g, ''));
  back(req, res, 'antiban', { type: 'success', message: 'Nomor dihapus dari blacklist.' });
});

module.exports = router;
