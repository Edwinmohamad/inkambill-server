// WhatsApp ticket bot for technicians/staff. Flow:
//   WAHA (incoming message) -> n8n (n8n/06-wa-ticket-bot.json) -> POST /api/n8n/wa/command
//   -> handleWaTicketMessage() -> { replies: [{ chatId, text, reply_to }] } -> n8n sends replies via WAHA.
// Cross-chat notifications (group / assigned technician) are sent directly by
// ticketWaNotifyService so web-originated events use the exact same path.
//
// Access control: the sender's number must match an ACTIVE employee's phone (Pengaturan -> Karyawan).
// Group commands are only accepted from groups listed in WA_TICKET_GROUP_IDS.
const path = require('path');
const db = require('../config/db');
const waha = require('./wahaClient');
const { audit } = require('./auditService');
const { normalizeWhatsapp } = require('./whatsappService');
const { savePhoto, removePhoto } = require('./photoAttachmentService');
const { parseCommand, parseReplyCommand, HELP_TEXT } = require('./waTicketParser');
const notify = require('./ticketWaNotifyService');

const TICKET_DIR = path.join(__dirname, '..', 'storage', 'ticket-attachments');
const PREFIX = String(process.env.WA_TICKET_PREFIX || '#').trim() || '#';
const { PRIORITY_LABEL, STATUS_LABEL, shortRef, customerLine } = notify;

function ticketCode() {
  const d = new Date();
  const p = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
  return `TT-${p}-${String(Date.now()).slice(-6)}`;
}

function jidDigits(jid) {
  const s = String(jid || '');
  if (!/@(c\.us|s\.whatsapp\.net)$/.test(s)) return null;
  return s.split('@')[0].split(':')[0].replace(/\D/g, '') || null;
}

// Private chat: sender = payload.from. Group: sender = payload.participant. Newer WhatsApp versions
// may give "<id>@lid" instead of a phone; WAHA/engine sometimes also includes the phone-number
// variant under _data.key.*Pn / *Alt, otherwise we ask WAHA to resolve the LID.
async function resolveSender(payload, isGroup) {
  const key = payload?._data?.key || {};
  const primary = isGroup ? (payload.participant || key.participant) : payload.from;
  const candidates = [primary, key.participantPn, key.senderPn, key.participantAlt, key.remoteJidAlt, payload.participantPn];
  for (const c of candidates) {
    const digits = jidDigits(c);
    if (digits) return { phone: normalizeWhatsapp(digits), rawId: primary };
  }
  const lid = [primary, key.participant].find(c => String(c || '').endsWith('@lid'));
  if (lid) {
    const digits = await waha.resolveLidToPhone(lid);
    if (digits) return { phone: normalizeWhatsapp(digits), rawId: lid };
  }
  return { phone: null, rawId: primary || null };
}

async function findEmployeeByPhone(phone) {
  if (!phone) return null;
  const [rows] = await db.query(`SELECT e.id,e.employee_code,e.name,e.phone,e.user_id,u.role FROM employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.is_active=1 AND e.phone IS NOT NULL AND e.phone<>''`);
  return rows.find(r => normalizeWhatsapp(r.phone) === phone) || null;
}

async function findEmployeeByCode(code) {
  const [rows] = await db.execute(`SELECT id,employee_code,name,phone,user_id FROM employees WHERE is_active=1 AND UPPER(employee_code)=? LIMIT 1`, [String(code).toUpperCase()]);
  return rows[0] || null;
}

// Accepts the full code or a unique suffix (e.g. the last 6 digits of TT-YYYYMMDD-XXXXXX).
async function findTicket(ref) {
  const code = String(ref || '').trim().toUpperCase();
  if (!code) return { error: 'Kode tiket wajib diisi.' };
  const exact = await notify.loadTicket('t.ticket_code=?', code);
  if (exact) return { ticket: exact };
  if (!/^[A-Z0-9-]{3,}$/.test(code)) return { error: `Tiket "${ref}" tidak ditemukan.` };
  const [rows] = await db.execute(`SELECT id,ticket_code,subject,status FROM tickets WHERE ticket_code LIKE ? ORDER BY id DESC LIMIT 6`, [`%${code}`]);
  if (rows.length === 1) return { ticket: await notify.loadTicketById(rows[0].id) };
  if (rows.length > 1) return { error: `Kode "${ref}" cocok dengan beberapa tiket, pakai kode lengkap:\n${rows.map(r => `• ${r.ticket_code} — ${r.subject} (${STATUS_LABEL[r.status] || r.status})`).join('\n')}` };
  return { error: `Tiket "${ref}" tidak ditemukan.` };
}

// WAHA uses different quoted-message shapes between engines/versions. The complete payload is
// searched only for a ticket-code marker, and plain reply actions are enabled only when it exists.
function repliedTicketRef(payload) {
  const serialized = JSON.stringify(payload?.quotedMsg || payload?.quotedMessage || payload?.contextInfo || payload?._data?.message || {});
  const match = serialized.match(/(?:TT-\d{8}-\d{6}|N8N-[A-Z0-9]+)/i);
  return match ? match[0].toUpperCase() : null;
}

async function fallbackUserId() {
  const [[row]] = await db.query(`SELECT id FROM users WHERE is_active=1 ORDER BY CASE role WHEN 'master_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,id LIMIT 1`);
  return row?.id || null;
}

async function savePayloadPhoto(payload, prefix) {
  if (!payload?.hasMedia || !payload?.media?.url) return { photo: null, warning: null };
  const declared = String(payload.media.mimetype || '').split(';')[0];
  if (declared && !['image/jpeg', 'image/png', 'image/webp'].includes(declared)) return { photo: null, warning: 'Lampiran bukan foto JPG/PNG/WEBP, tidak disimpan.' };
  try {
    const media = await waha.downloadMedia(payload.media.url);
    const mimetype = media.mimetype || declared;
    const photo = await savePhoto({ buffer: media.buffer, mimetype, originalname: payload.media.filename || `whatsapp-${payload.id || Date.now()}`, size: media.buffer.length }, TICKET_DIR, prefix);
    return { photo, warning: null };
  } catch (e) {
    return { photo: null, warning: `Foto tidak tersimpan: ${e.message}` };
  }
}

async function addProgress(ticket, employee, { status, percent, note, photo }) {
  const pct = Math.max(0, Math.min(100, Number(percent ?? ticket.progress_percent ?? 0)));
  await db.execute(`INSERT INTO ticket_updates(ticket_id,progress_date,progress_percent,status,note,attachment_path,attachment_original_name,attachment_mime,attachment_size,updated_by,source,actor_employee_id) VALUES(?,CURDATE(),?,?,?,?,?,?,?,?,'whatsapp',?)`,
    [ticket.id, pct, status, note, photo?.filename || null, photo?.originalName || null, photo?.mime || null, photo?.size || null, employee.user_id || null, employee.id]);
  await db.execute(`UPDATE tickets SET status=?,closed_at=IF(?='closed',COALESCE(closed_at,NOW()),NULL) WHERE id=?`, [status, status, ticket.id]);
  return pct;
}

function logAudit(employee, action, ticket, description) {
  return audit({ userId: employee.user_id || null, action, entityType: 'ticket', entityId: ticket.id, description: `[WA ${employee.employee_code || employee.name}] ${description}`, ip: 'whatsapp' });
}

function ticketSummary(t, updates = []) {
  const lines = [
    `*${t.ticket_code}* — ${STATUS_LABEL[t.status] || t.status} | ${PRIORITY_LABEL[t.priority] || t.priority} | ${t.progress_percent ?? 0}%`,
    customerLine(t),
    t.customer_address ? `Alamat: ${t.customer_address}` : null,
    t.customer_phone ? `HP: ${t.customer_phone}` : null,
    `Keluhan: ${t.subject}`,
    t.description ? t.description : null,
    `PIC: ${t.assigned_name || '-'}`,
    `Dibuka: ${new Date(t.opened_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
  ].filter(Boolean);
  if (updates.length) {
    lines.push('', '_Update terakhir:_');
    updates.forEach(u => lines.push(`• ${u.progress_percent}% ${STATUS_LABEL[u.status] || u.status} — ${String(u.note).slice(0, 160)} (${u.actor_name || 'System'})`));
  }
  return lines.join('\n');
}

function listLine(t) {
  return `• *${shortRef(t.ticket_code)}* ${PRIORITY_LABEL[t.priority] || t.priority} | ${STATUS_LABEL[t.status] || t.status} ${t.progress_percent ?? 0}% — ${t.customer_code ? `${t.customer_code} ` : ''}${String(t.subject).slice(0, 60)}${t.assigned_name ? ` [${t.assigned_name}]` : ''}`;
}

async function listTickets({ filter = 'active', employeeId = null }) {
  let sql = `SELECT t.ticket_code,t.subject,t.priority,t.status,c.customer_code,COALESCE(e.name,u.name) assigned_name,
      (SELECT tu.progress_percent FROM ticket_updates tu WHERE tu.ticket_id=t.id ORDER BY tu.progress_date DESC,tu.id DESC LIMIT 1) progress_percent
    FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN employees e ON e.id=t.assigned_employee_id LEFT JOIN users u ON u.id=t.assigned_to WHERE `;
  const params = [];
  if (filter === 'active') sql += `t.status IN ('open','progress','pending')`;
  else { sql += `t.status=?`; params.push(filter); }
  if (employeeId) { sql += ` AND t.assigned_employee_id=?`; params.push(employeeId); }
  sql += ` ORDER BY FIELD(t.status,'open','progress','pending','closed'),FIELD(t.priority,'critical','high','medium','low'),t.id DESC LIMIT 16`;
  const [rows] = await db.execute(sql, params);
  return rows;
}

const CLOSED_GUARD = t => `Tiket ${t.ticket_code} sudah CLOSED. Buka kembali dulu: #buka ${shortRef(t.ticket_code)} <alasan>`;

async function runCommand(cmd, ctx) {
  const { employee, payload, chatId } = ctx;
  const actor = employee.name;
  const notifyOpts = { actorName: actor, via: 'WhatsApp', excludeChatIds: [chatId], excludePhone: ctx.senderPhone };

  switch (cmd.command) {
    case 'help':
      return HELP_TEXT;

    case 'groupid':
      return `ID chat ini: ${chatId}`;

    case 'list':
    case 'mine': {
      const rows = await listTickets({ filter: cmd.command === 'mine' ? 'active' : cmd.filter, employeeId: cmd.command === 'mine' ? employee.id : null });
      const title = cmd.command === 'mine' ? `Tiket aktif untuk ${actor}` : `Tiket ${cmd.filter === 'active' ? 'aktif' : STATUS_LABEL[cmd.filter]}`;
      if (!rows.length) return `${title}: tidak ada.`;
      const more = rows.length > 15 ? '\n…dan lainnya, cek di web.' : '';
      return `*${title}*\n${rows.slice(0, 15).map(listLine).join('\n')}${more}\n\nDetail: #cek <kode>`;
    }

    case 'create': {
      let customer = null;
      if (cmd.customerRef) {
        const [rows] = await db.execute(`SELECT id,customer_code,name FROM customers WHERE UPPER(customer_code)=? LIMIT 1`, [cmd.customerRef.toUpperCase()]);
        customer = rows[0];
        if (!customer) return `Pelanggan "${cmd.customerRef}" tidak ditemukan. Cek kode pelanggan, atau pakai "-" jika tiket tanpa pelanggan.`;
      }
      const { photo, warning } = await savePayloadPhoto(payload, 'wa-ticket');
      const code = ticketCode();
      let insertId;
      try {
        const [r] = await db.execute(`INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,attachment_path,attachment_original_name,attachment_mime,attachment_size,opened_by,opened_at,source) VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,NOW(),'whatsapp')`,
          [code, customer?.id || null, cmd.subject, 'Gangguan Internet', cmd.priority, cmd.description, photo?.filename || null, photo?.originalName || null, photo?.mime || null, photo?.size || null, employee.user_id || await fallbackUserId()]);
        insertId = r.insertId;
      } catch (e) { if (photo) await removePhoto(TICKET_DIR, photo.filename); throw e; }
      await logAudit(employee, 'create', { id: insertId }, `Buat tiket ${code} via WhatsApp`);
      notify.notifyTicketEventAsync('created', insertId, notifyOpts);
      return `✅ Tiket *${code}* dibuat [${PRIORITY_LABEL[cmd.priority]}]\n${customer ? `Pelanggan: ${customer.customer_code} — ${customer.name}\n` : ''}Keluhan: ${cmd.subject}${photo ? '\nFoto terlampir.' : ''}${warning ? `\n⚠️ ${warning}` : ''}\n\nAmbil: #ambil ${shortRef(code)}`;
    }
  }

  // Everything below operates on an existing ticket.
  const found = await findTicket(cmd.ticketRef);
  if (found.error) return found.error;
  const t = found.ticket;

  switch (cmd.command) {
    case 'show': {
      const [updates] = await db.execute(`SELECT tu.progress_percent,tu.status,tu.note,COALESCE(u.name,e.name) actor_name FROM ticket_updates tu LEFT JOIN users u ON u.id=tu.updated_by LEFT JOIN employees e ON e.id=tu.actor_employee_id WHERE tu.ticket_id=? ORDER BY tu.progress_date DESC,tu.id DESC LIMIT 3`, [t.id]);
      return ticketSummary(t, updates);
    }

    case 'take':
    case 'assign': {
      if (t.status === 'closed') return CLOSED_GUARD(t);
      const target = cmd.command === 'take' ? employee : await findEmployeeByCode(cmd.employeeRef);
      if (!target) return `Karyawan "${cmd.employeeRef}" tidak ditemukan / tidak aktif.`;
      await db.execute(`UPDATE tickets SET assigned_employee_id=?,assigned_to=? WHERE id=?`, [target.id, target.user_id || null, t.id]);
      const nextStatus = t.status === 'open' ? 'progress' : t.status;
      const note = cmd.command === 'take' ? `Tiket diambil oleh ${actor} via WhatsApp` : `Ditugaskan ke ${target.name} oleh ${actor} via WhatsApp`;
      await addProgress(t, employee, { status: nextStatus, note });
      await logAudit(employee, 'assign', t, `${note} (${t.ticket_code})`);
      notify.notifyTicketEventAsync('assigned', t.id, notifyOpts);
      return cmd.command === 'take'
        ? `👷 Tiket *${t.ticket_code}* sekarang ditangani ${actor}. Status: ${STATUS_LABEL[nextStatus]}.\n${customerLine(t)}\nKeluhan: ${t.subject}${t.customer_address ? `\nAlamat: ${t.customer_address}` : ''}${t.customer_phone ? `\nHP: ${t.customer_phone}` : ''}`
        : `👷 Tiket *${t.ticket_code}* ditugaskan ke ${target.name}.`;
    }

    case 'update':
    case 'pending':
    case 'close': {
      if (t.status === 'closed') return CLOSED_GUARD(t);
      const status = cmd.command === 'update' ? 'progress' : cmd.command === 'pending' ? 'pending' : 'closed';
      const percent = cmd.command === 'close' ? 100 : cmd.percent;
      const note = cmd.note || (cmd.command === 'close' ? `Diselesaikan oleh ${actor} via WhatsApp` : '');
      const { photo, warning } = await savePayloadPhoto(payload, 'wa-progress');
      let pct;
      try { pct = await addProgress(t, employee, { status, percent, note, photo }); }
      catch (e) { if (photo) await removePhoto(TICKET_DIR, photo.filename); throw e; }
      // Whoever closes/updates an unassigned ticket becomes its PIC, so KPI/SLA reports have an owner.
      if (!t.assigned_employee_id) await db.execute(`UPDATE tickets SET assigned_employee_id=?,assigned_to=? WHERE id=? AND assigned_employee_id IS NULL`, [employee.id, employee.user_id || null, t.id]);
      await logAudit(employee, cmd.command === 'close' ? 'close' : 'progress', t, `Progress ${pct}% - ${status}${photo ? ' + foto' : ''} (${t.ticket_code})`);
      if (status === 'closed' || status === 'pending') notify.notifyTicketEventAsync(status, t.id, { ...notifyOpts, note });
      const icon = status === 'closed' ? '✅' : status === 'pending' ? '⏸️' : '📝';
      return `${icon} *${t.ticket_code}* → ${STATUS_LABEL[status]} ${pct}%${photo ? '\nFoto tersimpan.' : ''}${warning ? `\n⚠️ ${warning}` : ''}`;
    }

    case 'reopen': {
      if (t.status !== 'closed') return `Tiket ${t.ticket_code} belum closed (status: ${STATUS_LABEL[t.status]}).`;
      await addProgress(t, employee, { status: 'open', note: cmd.note });
      await logAudit(employee, 'reopen', t, `Buka kembali ${t.ticket_code}: ${cmd.note}`);
      notify.notifyTicketEventAsync('reopened', t.id, { ...notifyOpts, note: cmd.note });
      return `🔁 *${t.ticket_code}* dibuka kembali (Open).`;
    }

    case 'priority': {
      await db.execute(`UPDATE tickets SET priority=? WHERE id=?`, [cmd.priority, t.id]);
      await logAudit(employee, 'update', t, `Prioritas ${t.ticket_code}: ${t.priority} -> ${cmd.priority}`);
      return `Prioritas *${t.ticket_code}* → ${PRIORITY_LABEL[cmd.priority]}.`;
    }
  }
  return HELP_TEXT;
}

// payload = WAHA "message" event payload (or the whole webhook body; both accepted).
// Returns { handled, reason?, replies: [{ chatId, text, reply_to }] }. Never throws for user errors.
async function handleWaTicketMessage(input) {
  const payload = input?.payload && typeof input.payload === 'object' ? input.payload : (input || {});
  if (payload.fromMe) return { handled: false, reason: 'from_me', replies: [] };
  const text = String(payload.body || payload.caption || '').trim();
  const cmd = parseCommand(text, PREFIX) || parseReplyCommand(text, repliedTicketRef(payload));
  if (!cmd) return { handled: false, reason: 'not_command', replies: [] };

  const chatId = String(payload.from || '');
  const isGroup = chatId.endsWith('@g.us');
  const reply = message => ({ handled: true, command: cmd.command, replies: [{ chatId, text: message, reply_to: payload.id || null }] });
  const sender = await resolveSender(payload, isGroup);
  const employee = await findEmployeeByPhone(sender.phone);

  if (isGroup && !notify.ticketGroupIds().includes(chatId)) {
    // Lets an admin discover the group id to put in WA_TICKET_GROUP_IDS.
    if (cmd.command === 'groupid' && employee) return reply(`ID grup ini: ${chatId}\nTambahkan ke WA_TICKET_GROUP_IDS di .env server lalu restart app.`);
    return { handled: false, reason: 'group_not_allowed', replies: [] };
  }
  // In groups stay quiet for strangers and for ordinary hashtags (#semangat etc.) to avoid spam.
  if (!employee) {
    if (isGroup) return { handled: false, reason: 'unknown_sender', replies: [] };
    return reply(sender.phone
      ? `Nomor ${sender.phone} belum terdaftar sebagai karyawan aktif. Minta admin mengisi nomor HP Anda di Pengaturan → Karyawan.`
      : `Nomor pengirim tidak dapat dibaca (ID: ${sender.rawId || '-'}). Hubungi admin.`);
  }
  if (cmd.command === 'unknown') {
    if (isGroup) return { handled: false, reason: 'unknown_command', replies: [] };
    return reply(`Perintah "#${cmd.keyword}" tidak dikenal. Ketik #help untuk daftar perintah.`);
  }
  if (cmd.error) return reply(`⚠️ ${cmd.error}`);

  const text2 = await runCommand(cmd, { employee, payload, chatId, isGroup, senderPhone: sender.phone });
  return reply(text2);
}

module.exports = { handleWaTicketMessage, resolveSender, findTicket };
