// WhatsApp notifications for ticket events, sent straight to WAHA (not via the wa_messages queue,
// which only handles personal numbers). Used by:
//   - routes/tickets.js          -> events that happen on the web UI
//   - waTicketCommandService.js  -> events from WA commands (to notify the OTHER chats)
// Target group(s) = WA_TICKET_GROUP_IDS (same allowlist the WA bot accepts commands from).
// A new ticket is also broadcast privately to every active technical employee that has a WA number.
// Set WA_TICKET_NOTIFY=false to silence all of this without touching the bot itself.
// Every send is best-effort: a WAHA outage must never break saving a ticket.
const db = require('../config/db');
const waha = require('./wahaClient');
const { validateWhatsapp } = require('./whatsappService');

const PRIORITY_LABEL = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi', critical: 'Kritis' };
const STATUS_LABEL = { open: 'Open', progress: 'Proses', pending: 'Pending', closed: 'Closed' };

function ticketGroupIds() {
  return String(process.env.WA_TICKET_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}
function notifyEnabled() {
  return String(process.env.WA_TICKET_NOTIFY || 'true').trim().toLowerCase() !== 'false';
}
function shortRef(code) { return String(code || '').split('-').pop(); }

async function technicalRecipientPhones() {
  const [rows] = await db.query(`SELECT e.phone
    FROM employees e
    LEFT JOIN positions p ON p.id=e.position_id
    WHERE e.is_active=1 AND e.phone IS NOT NULL AND e.phone<>''
      AND (p.category='technical' OR p.category IS NULL)`);
  const phones = new Set();
  for (const row of rows) {
    const wa = validateWhatsapp(row.phone);
    if (wa.valid) phones.add(wa.normalized);
  }
  return [...phones];
}

async function loadTicket(where, param) {
  const [rows] = await db.execute(`SELECT t.id,t.ticket_code,t.subject,t.type,t.priority,t.status,t.description,t.opened_at,t.closed_at,
      t.assigned_employee_id,t.assigned_to,t.customer_id,
      c.customer_code,c.name customer_name,c.phone customer_phone,c.address customer_address,s.code site_code,cl.name cluster_name,
      COALESCE(e.name,u.name) assigned_name,e.phone assigned_phone,
      (SELECT tu.progress_percent FROM ticket_updates tu WHERE tu.ticket_id=t.id ORDER BY tu.progress_date DESC,tu.id DESC LIMIT 1) progress_percent
    FROM tickets t
    LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    LEFT JOIN employees e ON e.id=t.assigned_employee_id LEFT JOIN users u ON u.id=t.assigned_to
    WHERE ${where} LIMIT 1`, [param]);
  return rows[0] || null;
}
const loadTicketById = id => loadTicket('t.id=?', Number(id));

function customerLine(t) {
  if (!t.customer_code) return 'Pelanggan: -';
  const place = [t.site_code, t.cluster_name].filter(Boolean).join('/');
  return `Pelanggan: ${t.customer_code} — ${t.customer_name}${place ? ` (${place})` : ''}`;
}

function eventMessage(type, t, { actorName, note, via } = {}) {
  const head = `*${t.ticket_code}* [${PRIORITY_LABEL[t.priority] || t.priority}]`;
  const by = actorName ? `\nOleh: ${actorName}${via ? ` (${via})` : ''}` : '';
  const noteLine = note ? `\nCatatan: ${note}` : '';
  switch (type) {
    case 'created':
      return `🆕 Tiket baru ${head}\n${customerLine(t)}\n${t.customer_address ? `Alamat: ${t.customer_address}\n` : ''}Keluhan: ${t.subject}${t.description ? `\n${t.description}` : ''}${by}\n\nBalas pesan ini:\n• proses\n• update <catatan>\n• pending <alasan>\n• selesai <catatan>`;
    case 'assigned':
      return `👷 ${head} ditugaskan ke *${t.assigned_name || '-'}*\n${customerLine(t)}\nKeluhan: ${t.subject}${by}`;
    case 'assigned_personal':
      return `👷 Anda ditugaskan ke tiket ${head}\n${customerLine(t)}${t.customer_address ? `\nAlamat: ${t.customer_address}` : ''}${t.customer_phone ? `\nHP: ${t.customer_phone}` : ''}\nKeluhan: ${t.subject}${t.description ? `\n${t.description}` : ''}${by}\n\nUpdate: #update ${shortRef(t.ticket_code)} 50% <catatan>\nSelesai: #close ${shortRef(t.ticket_code)} <catatan>`;
    case 'closed':
      return `✅ ${head} *CLOSED*\n${customerLine(t)}\nKeluhan: ${t.subject}${noteLine}${by}`;
    case 'pending':
      return `⏸️ ${head} *PENDING*\n${customerLine(t)}${noteLine}${by}`;
    case 'reopened':
      return `🔁 ${head} dibuka kembali\n${customerLine(t)}${noteLine}${by}`;
    default:
      return `${head} — ${STATUS_LABEL[t.status] || t.status}${noteLine}${by}`;
  }
}

async function safeSend(chatId, text) {
  try { await waha.sendToChat(chatId, text); return true; }
  catch (e) { console.error(`WA tiket: gagal kirim notifikasi ke ${chatId}:`, e.message); return false; }
}

// type: created | assigned | closed | pending | reopened
// excludeChatIds: chats that already got a direct reply (e.g. the group where the command was typed)
// excludePhone:   the actor's own number, so they aren't notified of their own assignment
async function notifyTicketEvent(type, ticketId, { actorName = null, note = null, via = 'web', excludeChatIds = [], excludePhone = null, skipGroups = false } = {}) {
  if (!notifyEnabled()) return;
  try {
    const t = await loadTicketById(ticketId);
    if (!t) return;
    const skip = new Set(excludeChatIds);
    for (const groupId of skipGroups ? [] : ticketGroupIds()) {
      if (!skip.has(groupId)) await safeSend(groupId, eventMessage(type, t, { actorName, note, via }));
    }
    // A newly created ticket is intentionally broadcast immediately: no PIC claim or confirmation
    // is required before every active technician receives the full ticket and reply shortcuts.
    if (type === 'created') {
      const recipients = await technicalRecipientPhones();
      for (const phone of recipients) {
        const chatId = `${phone}@c.us`;
        await safeSend(chatId, eventMessage(type, t, { actorName, note, via }));
      }
    }
    if (type === 'assigned' && t.assigned_phone) {
      const wa = validateWhatsapp(t.assigned_phone);
      if (wa.valid && wa.normalized !== excludePhone) {
        const chatId = `${wa.normalized}@c.us`;
        if (!skip.has(chatId)) await safeSend(chatId, eventMessage('assigned_personal', t, { actorName, via }));
      }
    }
  } catch (e) {
    console.error('WA tiket: gagal menyiapkan notifikasi:', e.message);
  }
}

// Fire-and-forget wrapper for web routes: never delays or fails the HTTP response.
function notifyTicketEventAsync(...args) {
  notifyTicketEvent(...args).catch(() => {});
}

module.exports = { notifyTicketEvent, notifyTicketEventAsync, loadTicket, loadTicketById, ticketGroupIds, technicalRecipientPhones, shortRef, customerLine, PRIORITY_LABEL, STATUS_LABEL };
