// Web Inbox WhatsApp 2-arah: menyimpan pesan masuk dari WAHA (webhook 'message'), status centang
// ('message.ack'), balasan admin (lewat antrean anti-ban), catatan internal, penugasan, bot/human
// switch, opt-out STOP/BERHENTI, dan konteks pelanggan untuk sidebar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const waha = require('./wahaClient');
const antiBan = require('./waAntiBanService');
const tpl = require('./waTemplateService');
const { normalizeWhatsapp, validateWhatsapp } = require('./whatsappService');
function realtime() { return require('./waRealtime'); }
function gateway() { return require('./whatsappGatewayService'); }

const MEDIA_DIR = path.join(__dirname, '..', 'storage', 'wa-media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const HUMAN_TAKEOVER_MINUTES = 30;
const BOT_COOLDOWN_SECONDS = 120;
const TICKET_PREFIX = String(process.env.WA_TICKET_PREFIX || '#').trim() || '#';
const PAYMENT_RE = /\b(bukti|transfer|trf|tf|sudah\s*bayar|udah\s*bayar|lunas|bayar|pembayaran|struk)\b/i;
const OUTAGE_RE = /\b(gangguan|lemot|lambat|mati|los|lampu\s*merah|down|putus|error|tidak\s*bisa|gak\s*bisa|ga\s*bisa|nggak\s*bisa|offline|no\s*internet)\b/i;
const MEDIA_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3' };
const DEPARTMENTS = { finance: 'Divisi Keuangan', helpdesk: 'Divisi Helpdesk', technical: 'Divisi Teknis' };

function jidDigits(jid) {
  const s = String(jid || '');
  if (!/@(c\.us|s\.whatsapp\.net)$/.test(s)) return null;
  return s.split('@')[0].split(':')[0].replace(/\D/g, '') || null;
}

async function resolveSender(payload) {
  const key = payload?._data?.key || {};
  for (const c of [payload.from, key.remoteJidAlt, key.senderPn, payload._data?.from]) {
    const d = jidDigits(c); if (d) return normalizeWhatsapp(d);
  }
  const lid = [payload.from, key.remoteJid].find(c => String(c || '').endsWith('@lid'));
  if (lid) { const d = await waha.resolveLidToPhone(lid); if (d) return normalizeWhatsapp(d); }
  return null;
}

async function findCustomerByPhone(phone) {
  if (!phone) return null;
  const [rows] = await db.execute(`SELECT id,name,customer_code FROM customers WHERE archived_at IS NULL AND whatsapp_normalized=? ORDER BY customer_status='active' DESC,id DESC LIMIT 1`, [phone]);
  return rows[0] || null;
}

async function saveMediaBuffer(buffer, mimetype, originalName = null) {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_EXT[mime] || path.extname(String(originalName || '')).slice(0, 8) || '.bin';
  const filename = `wa-${Date.now()}-${crypto.randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(MEDIA_DIR, filename), buffer, { flag: 'wx' });
  return { path: filename, mime: mime || 'application/octet-stream', name: originalName || filename };
}

function preview(text, media) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 250);
  if (!media) return '';
  return /^image\//.test(media.mime) ? '📷 Foto' : /pdf/.test(media.mime) ? '📄 Dokumen' : '📎 Lampiran';
}

async function loadConversation(id) {
  const [rows] = await db.execute(`SELECT cv.*,c.name customer_name,c.customer_code,c.network_status,u.name assigned_name
    FROM wa_conversations cv LEFT JOIN customers c ON c.id=cv.customer_id LEFT JOIN users u ON u.id=cv.assigned_user_id WHERE cv.id=?`, [id]);
  return rows[0] || null;
}

async function emitConversation(id) {
  const conv = await loadConversation(id);
  if (conv) realtime().emit('conversation.updated', serializeConversation(conv));
  return conv;
}
function serializeConversation(c) {
  const humanActive = c.human_until && new Date(c.human_until) > new Date();
  return {
    id: c.id, chatId: c.chat_id, phone: c.phone, customerId: c.customer_id, customerName: c.customer_name, customerCode: c.customer_code,
    displayName: c.customer_name || c.display_name || (c.phone ? `+${c.phone}` : c.chat_id), category: c.category, status: c.status,
    unread: Number(c.unread_count || 0), lastMessageAt: c.last_message_at, lastPreview: c.last_message_preview, lastDirection: c.last_direction,
    botEnabled: !!c.bot_enabled, humanUntil: humanActive ? c.human_until : null, mode: (!c.bot_enabled || humanActive) ? 'manual' : 'bot',
    assignedUserId: c.assigned_user_id, assignedName: c.assigned_name || null, assignedDepartment: c.assigned_department, departmentLabel: DEPARTMENTS[c.assigned_department] || null,
    networkStatus: c.network_status || null,
  };
}
function serializeMessage(m) {
  return {
    id: m.id, conversationId: m.conversation_id, direction: m.direction, body: m.body, ack: m.ack, error: m.error_message,
    media: m.media_path ? { url: `/wa-inbox/media/${m.id}`, mime: m.media_mime, name: m.media_name } : null,
    isBot: !!m.is_bot, senderName: m.sender_name || null, createdAt: m.created_at,
  };
}

async function insertChatMessage(conversationId, { direction, body = null, media = null, waId = null, userId = null, isBot = false, ack = 'pending' }) {
  const [r] = await db.execute(`INSERT IGNORE INTO wa_chat_messages(conversation_id,direction,wa_message_id,body,media_path,media_mime,media_name,ack,sender_user_id,is_bot) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [conversationId, direction, waId, body, media?.path || null, media?.mime || null, media?.name || null, ack, userId, isBot ? 1 : 0]);
  if (!r.insertId) return null; // duplikat webhook
  const [rows] = await db.execute(`SELECT m.*,u.name sender_name FROM wa_chat_messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.id=?`, [r.insertId]);
  const msg = serializeMessage(rows[0]);
  realtime().emit('message.new', msg);
  return rows[0];
}

async function touchConversation(id, { direction, previewText, incrementUnread = false, resetUnread = false, category = null }) {
  await db.execute(`UPDATE wa_conversations SET last_message_at=NOW(),last_message_preview=?,last_direction=?,status='open',
      unread_count=${incrementUnread ? 'unread_count+1' : resetUnread ? '0' : 'unread_count'}
      ${category ? `,category=IF(category='general',?,category)` : ''} WHERE id=?`, category ? [previewText, direction, category, id] : [previewText, direction, id]);
}

async function upsertConversation({ chatId, phone, customerId, displayName }) {
  await db.execute(`INSERT INTO wa_conversations(chat_id,phone,customer_id,display_name) VALUES(?,?,?,?)
    ON DUPLICATE KEY UPDATE phone=COALESCE(VALUES(phone),phone),customer_id=COALESCE(customer_id,VALUES(customer_id)),display_name=COALESCE(VALUES(display_name),display_name)`,
    [chatId, phone, customerId, displayName]);
  const [[row]] = await db.execute(`SELECT * FROM wa_conversations WHERE chat_id=?`, [chatId]);
  return row;
}

// ---- Pesan masuk dari webhook WAHA --------------------------------------------------------------
async function ingestInbound(payload = {}) {
  if (!payload || payload.fromMe) return { skipped: 'from_me' };
  const from = String(payload.from || '');
  if (!from || /@g\.us$|@broadcast$|@newsletter$/.test(from) || from === 'status@broadcast') return { skipped: 'not_private' };
  const phone = await resolveSender(payload);
  const chatId = phone ? `${phone}@c.us` : from;
  const customer = await findCustomerByPhone(phone);
  const displayName = payload?._data?.notifyName || payload?._data?.pushName || payload?.notifyName || null;
  const conv = await upsertConversation({ chatId, phone, customerId: customer?.id || null, displayName: displayName ? String(displayName).slice(0, 180) : null });

  let media = null;
  if (payload.hasMedia && payload.media?.url) {
    try {
      const dl = await waha.downloadMedia(payload.media.url);
      media = await saveMediaBuffer(dl.buffer, payload.media.mimetype || dl.mimetype, payload.media.filename || null);
    } catch (e) { console.error('WA inbox: gagal unduh media:', e.message); }
  }
  const text = String(payload.body || payload.caption || '').slice(0, 8000);
  const isProofLike = media && (/^image\//.test(media.mime) || /pdf/.test(media.mime));
  const category = (isProofLike || PAYMENT_RE.test(text)) ? 'payment' : OUTAGE_RE.test(text) ? 'outage' : null;
  const saved = await insertChatMessage(conv.id, { direction: 'in', body: text || null, media, waId: payload.id ? String(payload.id).slice(0, 255) : null, ack: 'delivered' });
  if (!saved) return { skipped: 'duplicate' };
  await touchConversation(conv.id, { direction: 'in', previewText: preview(text, media), incrementUnread: true, category });
  await emitConversation(conv.id);

  const config = await antiBan.getConfig();
  // Opt-out / opt-in broadcast.
  if (phone && antiBan.isOptOutText(text, config)) {
    await antiBan.addToBlacklist(phone, { customerId: customer?.id || null, reason: `Balasan "${text.trim().slice(0, 30)}"` });
    await botReply(conv, 'Permintaan Anda telah kami terima. Nomor Anda tidak akan lagi menerima pesan informasi massal (broadcast) dari kami. Informasi penting terkait layanan Anda tetap dapat kami sampaikan melalui chat ini. Balas MULAI bila ingin menerima informasi kembali.', { force: true });
    await addSystemNote(conv.id, `Nomor masuk blacklist broadcast (opt-out: "${text.trim().slice(0, 30)}").`);
    return { conversationId: conv.id, optOut: true };
  }
  if (phone && /^(MULAI|START)$/i.test(text.trim()) && await antiBan.isBlacklisted(phone)) {
    await antiBan.removeFromBlacklist(phone);
    await botReply(conv, 'Terima kasih. Nomor Anda kembali terdaftar untuk menerima informasi layanan dari kami.', { force: true });
    await addSystemNote(conv.id, 'Nomor dihapus dari blacklist broadcast (balasan MULAI).');
    return { conversationId: conv.id, optIn: true };
  }
  await maybeAutoRespond(conv.id, { text, media, isProofLike, customer, config });
  return { conversationId: conv.id, messageId: saved.id };
}

// ---- Auto-responder sederhana (bisa dimatikan per percakapan) ------------------------------------
async function maybeAutoRespond(conversationId, { text, isProofLike, customer, config }) {
  const conv = await loadConversation(conversationId);
  if (!conv || !conv.bot_enabled) return;
  if (conv.human_until && new Date(conv.human_until) > new Date()) return;
  if (String(text || '').trim().startsWith(TICKET_PREFIX)) return; // perintah bot tiket (n8n)
  if (conv.last_bot_reply_at && Date.now() - new Date(conv.last_bot_reply_at).getTime() < BOT_COOLDOWN_SECONDS * 1000) return;
  let reply = null;
  if (isProofLike) reply = 'Terima kasih. Bukti pembayaran Anda telah kami terima dan akan segera diverifikasi oleh tim kami. Kami akan menginformasikan kembali setelah proses verifikasi selesai.';
  else if (/\b(rekening|no\.?\s*rek|norek|transfer\s*ke)\b/i.test(text)) reply = await renderQuickReply('rekening', customer?.id);
  else if (customer && /\b(tagihan|berapa|total\s*bayar|invoice)\b/i.test(text)) reply = await renderQuickReply('tagihan', customer.id);
  else if (OUTAGE_RE.test(text)) reply = 'Terima kasih atas laporan Anda. Laporan gangguan telah kami terima dan akan segera ditindaklanjuti oleh tim teknis kami.';
  else if (!antiBan.isWorkingHours(config)) reply = `Terima kasih telah menghubungi kami. Pesan Anda telah kami terima dan akan dibalas oleh petugas pada jam operasional ${String(config.workStartHour).padStart(2, '0')}.00–${String(config.workEndHour).padStart(2, '0')}.00 WIB.`;
  if (reply) await botReply(conv, reply);
}

async function botReply(conv, text, { force = false } = {}) {
  if (!conv.phone || !validateWhatsapp(conv.phone).valid) return null;
  const config = await antiBan.getConfig();
  if (config.markReadBeforeReply) { try { await waha.sendSeen(conv.chat_id); } catch (_) { /* engine tidak mendukung */ } }
  const msg = await insertChatMessage(conv.id, { direction: 'out', body: text, isBot: true });
  if (!msg) return null;
  const q = await gateway().enqueueWaMessage({ phone: conv.phone, message: text, customerId: conv.customer_id, type: 'bot_reply', conversationId: conv.id, chatMessageId: msg.id });
  await db.execute(`UPDATE wa_chat_messages SET queue_message_id=? WHERE id=?`, [q.id, msg.id]);
  await db.execute(`UPDATE wa_conversations SET last_bot_reply_at=NOW() WHERE id=?`, [conv.id]);
  await touchConversation(conv.id, { direction: 'out', previewText: preview(text) });
  if (!force) await emitConversation(conv.id); else await emitConversation(conv.id);
  return msg;
}

async function addSystemNote(conversationId, text) {
  await insertChatMessage(conversationId, { direction: 'note', body: `[Sistem] ${text}`, ack: 'sent' });
}

// ---- Status centang dari WAHA ('message.ack') ----------------------------------------------------
const ACK_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };
async function handleAck(payload = {}) {
  const id = String(payload.id || '');
  if (!id) return;
  const n = Number(payload.ack);
  const ack = n <= -1 ? 'failed' : n >= 3 ? 'read' : n === 2 ? 'delivered' : n === 1 ? 'sent' : null;
  if (!ack) return;
  const suffix = id.split('_').pop();
  const [rows] = await db.execute(`SELECT id,conversation_id,ack FROM wa_chat_messages WHERE direction='out' AND (wa_message_id=? OR wa_message_id LIKE ?) ORDER BY id DESC LIMIT 1`, [id, `%${suffix}`]);
  const m = rows[0];
  if (!m || (ACK_RANK[ack] <= ACK_RANK[m.ack] && ack !== 'failed')) return;
  await db.execute(`UPDATE wa_chat_messages SET ack=? WHERE id=?`, [ack, m.id]);
  realtime().emit('message.ack', { conversationId: m.conversation_id, id: m.id, ack });
}

// ---- Query untuk UI -------------------------------------------------------------------------------
async function listConversations({ filter = 'all', q = '', userId = null, limit = 100 } = {}) {
  const where = ['1=1']; const params = [];
  if (filter === 'unread') where.push('cv.unread_count>0');
  else if (filter === 'payment') where.push(`cv.category='payment'`);
  else if (filter === 'outage') where.push(`cv.category='outage'`);
  else if (filter === 'isolated') where.push(`c.network_status='isolated'`);
  else if (filter === 'mine' && userId) { where.push('cv.assigned_user_id=?'); params.push(userId); }
  if (q) {
    const like = `%${String(q).trim().slice(0, 80)}%`;
    where.push('(c.name LIKE ? OR c.customer_code LIKE ? OR c.address LIKE ? OR cv.phone LIKE ? OR cv.display_name LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const [rows] = await db.query(`SELECT cv.*,c.name customer_name,c.customer_code,c.network_status,u.name assigned_name
    FROM wa_conversations cv LEFT JOIN customers c ON c.id=cv.customer_id LEFT JOIN users u ON u.id=cv.assigned_user_id
    WHERE ${where.join(' AND ')} ORDER BY cv.last_message_at DESC,cv.id DESC LIMIT ${Math.min(300, Math.max(1, Number(limit) || 100))}`, params);
  const [[counts]] = await db.query(`SELECT COUNT(*) total,SUM(cv.unread_count>0) unread,SUM(cv.category='payment') payment,SUM(cv.category='outage') outage,SUM(c.network_status='isolated') isolated
    FROM wa_conversations cv LEFT JOIN customers c ON c.id=cv.customer_id`);
  return { conversations: rows.map(serializeConversation), counts: Object.fromEntries(Object.entries(counts || {}).map(([k, v]) => [k, Number(v || 0)])) };
}

async function getMessages(conversationId, { beforeId = null, limit = 80 } = {}) {
  const params = [conversationId]; let extra = '';
  if (beforeId) { extra = 'AND m.id<?'; params.push(Number(beforeId)); }
  const [rows] = await db.execute(`SELECT m.*,u.name sender_name FROM wa_chat_messages m LEFT JOIN users u ON u.id=m.sender_user_id
    WHERE m.conversation_id=? ${extra} ORDER BY m.id DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 80))}`, params);
  return rows.reverse().map(serializeMessage);
}

async function getCustomerContext(customerId) {
  if (!customerId) return null;
  const [rows] = await db.execute(`SELECT c.id,c.customer_code,c.name,c.address,c.phone,c.whatsapp_normalized,c.network_status,c.isolation_reason,c.pppoe_username,c.vlan,c.customer_status,
      p.name package_name,p.speed_label,p.price package_price,r.name router_name,cl.name cluster_name,s.code site_code,o.name olt_name
    FROM customers c LEFT JOIN packages p ON p.id=c.package_id LEFT JOIN routers r ON r.id=c.router_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
      LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN olt_devices o ON o.id=c.olt_id WHERE c.id=?`, [customerId]);
  const c = rows[0]; if (!c) return null;
  const [invoices] = await db.execute(`SELECT id,invoice_number,period_month,period_year,total,outstanding,due_date,status FROM invoices
    WHERE customer_id=? AND archived_at IS NULL ORDER BY period_year DESC,period_month DESC,id DESC LIMIT 6`, [customerId]);
  const open = invoices.filter(i => ['unpaid', 'partial', 'overdue'].includes(i.status) && Number(i.outstanding) > 0);
  const [payments] = await db.execute(`SELECT p.id,p.amount,p.method,p.status,p.paid_at,p.reference,i.invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id
    WHERE i.customer_id=? ORDER BY p.paid_at DESC,p.id DESC LIMIT 3`, [customerId]);
  let session = null;
  try { const [s] = await db.execute(`SELECT address,status,last_seen_at FROM nms_pppoe_sessions WHERE customer_id=? ORDER BY last_seen_at DESC LIMIT 1`, [customerId]); session = s[0] || null; } catch (_) {}
  const [[tickets]] = await db.execute(`SELECT COUNT(*) n FROM tickets WHERE customer_id=? AND status IN ('open','progress','pending')`, [customerId]);
  const outstanding = open.reduce((a, i) => a + Number(i.outstanding || 0), 0);
  const billingStatus = c.network_status === 'isolated' ? 'TERISOLIR' : open.some(i => new Date(i.due_date) < new Date(new Date().toDateString())) ? 'MENUNGGAK' : open.length ? 'BELUM BAYAR' : 'LUNAS';
  return {
    ...c, packageLabel: tpl.packageLabel(c.package_name, c.speed_label), ipAddress: session?.address || null, sessionStatus: session?.status || null, sessionSeenAt: session?.last_seen_at || null,
    invoices, openInvoices: open, outstanding, billingStatus, payments, openTickets: Number(tickets.n || 0),
  };
}

async function getConversationDetail(id) {
  const conv = await loadConversation(id);
  if (!conv) return null;
  return { conversation: serializeConversation(conv), messages: await getMessages(id), customer: await getCustomerContext(conv.customer_id) };
}

// ---- Aksi admin -------------------------------------------------------------------------------------
async function markRead(conversationId) {
  const conv = await loadConversation(conversationId);
  if (!conv) throw new Error('Percakapan tidak ditemukan.');
  await db.execute(`UPDATE wa_conversations SET unread_count=0 WHERE id=?`, [conversationId]);
  const config = await antiBan.getConfig();
  if (conv.unread_count > 0 && config.markReadBeforeReply) { try { await waha.sendSeen(conv.chat_id); } catch (_) {} }
  await emitConversation(conversationId);
}

async function sendReply({ conversationId, text, userId, file = null }) {
  const conv = await loadConversation(conversationId);
  if (!conv) throw new Error('Percakapan tidak ditemukan.');
  if (!conv.phone || !validateWhatsapp(conv.phone).valid) throw new Error('Nomor WhatsApp percakapan ini belum dikenali (format tidak valid) sehingga tidak bisa dibalas dari inbox.');
  const body = String(text || '').trim().slice(0, 4000);
  if (!body && !file) throw new Error('Pesan kosong.');
  let media = null;
  if (file) {
    if (file.size > 6 * 1024 * 1024) throw new Error('Lampiran maksimal 6 MB.');
    media = await saveMediaBuffer(file.buffer, file.mimetype, file.originalname);
  }
  // Read-status simulation: tandai pesan pelanggan sudah dibaca sebelum membalas.
  const config = await antiBan.getConfig();
  if (config.markReadBeforeReply) { try { await waha.sendSeen(conv.chat_id); } catch (_) {} }
  const msg = await insertChatMessage(conv.id, { direction: 'out', body: body || null, media, userId });
  const q = await gateway().enqueueWaMessage({ phone: conv.phone, message: body, customerId: conv.customer_id, type: 'inbox', userId, conversationId: conv.id, chatMessageId: msg.id, media });
  await db.execute(`UPDATE wa_chat_messages SET queue_message_id=? WHERE id=?`, [q.id, msg.id]);
  if (q.status === 'failed') {
    await db.execute(`UPDATE wa_chat_messages SET ack='failed',error_message=? WHERE id=?`, [String(q.reason || 'gagal').slice(0, 500), msg.id]);
    realtime().emit('message.ack', { conversationId: conv.id, id: msg.id, ack: 'failed', error: q.reason });
  }
  // Human intervention: bot diam 30 menit setelah admin membalas manual.
  await db.execute(`UPDATE wa_conversations SET human_until=DATE_ADD(NOW(),INTERVAL ${HUMAN_TAKEOVER_MINUTES} MINUTE),unread_count=0 WHERE id=?`, [conv.id]);
  await touchConversation(conv.id, { direction: 'out', previewText: preview(body, media), resetUnread: true });
  await emitConversation(conv.id);
  return { message: serializeMessage({ ...msg }), queue: q };
}

async function addNote({ conversationId, text, userId }) {
  const body = String(text || '').trim().slice(0, 4000);
  if (!body) throw new Error('Catatan kosong.');
  const msg = await insertChatMessage(conversationId, { direction: 'note', body, userId, ack: 'sent' });
  return serializeMessage(msg);
}

async function setBot({ conversationId, enabled }) {
  await db.execute(`UPDATE wa_conversations SET bot_enabled=?,human_until=${enabled ? 'NULL' : 'human_until'} WHERE id=?`, [enabled ? 1 : 0, conversationId]);
  await addSystemNote(conversationId, enabled ? 'Auto-responder bot diaktifkan.' : 'Auto-responder bot dimatikan (mode manual).');
  return serializeConversation(await emitConversation(conversationId));
}

async function assign({ conversationId, assigneeUserId = null, department = null, actorName = 'Admin' }) {
  const dept = DEPARTMENTS[department] ? department : null;
  const uid = Number(assigneeUserId) || null;
  let assigneeName = null;
  if (uid) { const [[u]] = await db.execute(`SELECT name FROM users WHERE id=? AND is_active=1`, [uid]); if (!u) throw new Error('Admin tujuan tidak ditemukan.'); assigneeName = u.name; }
  await db.execute(`UPDATE wa_conversations SET assigned_user_id=?,assigned_department=? WHERE id=?`, [uid, dept, conversationId]);
  const target = [assigneeName, DEPARTMENTS[dept]].filter(Boolean).join(' · ') || 'tidak ada (dilepas)';
  await addSystemNote(conversationId, `${actorName} mengalihkan percakapan ke ${target}.`);
  if (uid) {
    try { await db.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id) VALUES(?,?,?,?,?,?,?,?,?)`,
      [uid, 'wa_inbox_assign', 'info', 'bi-chat-dots', 'Percakapan WhatsApp dialihkan ke Anda', `${actorName} menugaskan satu percakapan pelanggan kepada Anda.`, `/wa-inbox?c=${conversationId}`, 'wa_conversation', conversationId]); } catch (_) {}
  }
  return serializeConversation(await emitConversation(conversationId));
}

async function linkCustomer({ conversationId, customerId }) {
  const id = Number(customerId) || null;
  if (id) { const [[c]] = await db.execute(`SELECT id,name FROM customers WHERE id=?`, [id]); if (!c) throw new Error('Pelanggan tidak ditemukan.'); await addSystemNote(conversationId, `Percakapan ditautkan ke pelanggan ${c.name}.`); }
  await db.execute(`UPDATE wa_conversations SET customer_id=? WHERE id=?`, [id, conversationId]);
  return serializeConversation(await emitConversation(conversationId));
}

async function listQuickReplies() {
  const [rows] = await db.query(`SELECT id,shortcut,title,body,is_active FROM wa_quick_replies ORDER BY shortcut`);
  return rows;
}
async function renderQuickReply(shortcut, customerId = null) {
  const [[q]] = await db.execute(`SELECT body FROM wa_quick_replies WHERE shortcut=? AND is_active=1 LIMIT 1`, [String(shortcut).replace(/^\//, '')]);
  if (!q) return null;
  const bank = await tpl.getDefaultBank();
  const row = customerId ? await tpl.loadCustomerRow(customerId) : null;
  return tpl.renderTemplate(q.body, tpl.buildVars(row || {}, bank), { spintax: true });
}

function ticketCode() {
  const d = new Date();
  return `TT-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(Date.now()).slice(-6)}`;
}
// Chat-to-Ticket: eskalasi keluhan ke Tiket Gangguan (modul teknisi / field support).
async function createTicketFromChat({ conversationId, subject, type = 'Gangguan Internet', priority = 'medium', description = '', userId, actorName = 'Admin' }) {
  const conv = await loadConversation(conversationId);
  if (!conv) throw new Error('Percakapan tidak ditemukan.');
  const subj = String(subject || '').trim().slice(0, 200);
  if (!subj) throw new Error('Judul tiket wajib diisi.');
  let desc = String(description || '').trim();
  if (!desc) {
    const [last] = await db.execute(`SELECT body FROM wa_chat_messages WHERE conversation_id=? AND direction='in' AND body IS NOT NULL ORDER BY id DESC LIMIT 5`, [conversationId]);
    desc = last.reverse().map(m => `> ${m.body}`).join('\n');
  }
  desc = `${desc}\n\n(Dibuat dari Web Inbox WhatsApp · +${conv.phone || conv.chat_id})`.slice(0, 5000);
  const code = ticketCode();
  const [r] = await db.execute(`INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,opened_by,opened_at,source) VALUES(?,?,?,?,?,'open',?,?,NOW(),'whatsapp')`,
    [code, conv.customer_id, subj, String(type || 'Gangguan Internet').slice(0, 80), ['low', 'medium', 'high', 'critical'].includes(priority) ? priority : 'medium', desc, userId]);
  await db.execute(`UPDATE wa_conversations SET category=IF(category='general','outage',category) WHERE id=?`, [conversationId]);
  await addSystemNote(conversationId, `${actorName} membuat tiket ${code}: ${subj}`);
  try { require('./ticketWaNotifyService').notifyTicketEventAsync('created', r.insertId, { actorName, via: 'web' }); } catch (_) {}
  await emitConversation(conversationId);
  return { id: r.insertId, code };
}

async function mediaFileFor(chatMessageId) {
  const [[m]] = await db.execute(`SELECT media_path,media_mime,media_name FROM wa_chat_messages WHERE id=?`, [chatMessageId]);
  if (!m?.media_path) return null;
  return { file: path.join(MEDIA_DIR, path.basename(m.media_path)), mime: m.media_mime, name: m.media_name };
}

module.exports = {
  MEDIA_DIR, DEPARTMENTS, HUMAN_TAKEOVER_MINUTES,
  ingestInbound, handleAck, listConversations, getConversationDetail, getMessages, getCustomerContext, loadConversation,
  markRead, sendReply, addNote, addSystemNote, setBot, assign, linkCustomer, listQuickReplies, renderQuickReply,
  createTicketFromChat, mediaFileFor, serializeConversation, saveMediaBuffer, botReply,
};
