// WA Gateway — WhatsApp automation via WAHA (WhatsApp HTTP API, https://waha.devlike.pro), a
// separate self-hosted service already running on this same server (localhost:3000). WAHA owns
// the actual WhatsApp connection (session auth, QR pairing, reconnects) in its own process, so
// this app no longer holds a live socket in-process — it only talks HTTP to WAHA and receives a
// push webhook back from it. See services/wahaClient.js for the WAHA HTTP client and
// middleware/waha.js + routes/waha.js for the inbound webhook.
//
// This file keeps the exact same state shape and DB-backed queue as before (wa_messages table,
// randomized delay between sends, auto-reminder sweep) — only how connectionState/qrDataUrl get
// populated changed: instead of Baileys connection.update events firing in-process, they now
// arrive via WAHA's webhook (handleWahaWebhookEvent, fast path) with a periodic HTTP reconcile
// as a safety net (reconcileGatewayStatus, called from the status.json poll and the 5-min cron
// watchdog in app.js) in case a webhook delivery is ever missed.
const db = require('../config/db');
const { validateWhatsapp } = require('./whatsappService');
const waha = require('./wahaClient');

// In-memory mirror of WAHA's session state, shaped exactly like before so routes/views don't
// need to change. Only one Node process serves this app, so module-level state is fine — same
// assumption the old Baileys-based version made.
let connectionState = 'disconnected'; // disconnected | connecting | qr_pending | connected
let qrDataUrl = null;
let connectedNumber = null;
let lastConnectedAt = null;
let lastDisconnectReason = null;
let startingPromise = null;
let processingLock = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs)); }

// Maps WAHA's session.status values onto this app's existing state vocabulary. Verify these
// against your WAHA version's Swagger UI (GET /api/sessions/{session} -> "status") — the set
// below (STOPPED / STARTING / SCAN_QR_CODE / WORKING / FAILED) matches the commonly documented
// WAHA API; add/adjust entries here if your version reports different values.
const STATUS_MAP = {
  STOPPED: 'disconnected',
  STARTING: 'connecting',
  SCAN_QR_CODE: 'qr_pending',
  WORKING: 'connected',
  FAILED: 'disconnected',
};

function extractNumber(waId) {
  // WAHA typically reports the connected account as something like "6281234567890@c.us".
  if (!waId) return null;
  return String(waId).split('@')[0].split(':')[0] || null;
}

function getGatewayStatus() {
  return {
    state: connectionState,
    qrDataUrl: connectionState === 'qr_pending' ? qrDataUrl : null,
    connectedNumber,
    lastConnectedAt,
    lastDisconnectReason,
  };
}

function applySessionSnapshot(session) {
  if (!session) {
    // Session name has never been created on WAHA — nothing to reconnect to yet, admin has to
    // press Connect (which creates it for the first time).
    connectionState = 'disconnected';
    qrDataUrl = null;
    connectedNumber = null;
    return;
  }
  const status = String(session.status || '').toUpperCase();
  connectionState = STATUS_MAP[status] || 'disconnected';
  if (connectionState === 'connected') {
    qrDataUrl = null;
    connectedNumber = extractNumber(session?.me?.id) || connectedNumber;
    if (!lastConnectedAt) lastConnectedAt = new Date();
    lastDisconnectReason = null;
  } else {
    connectedNumber = null;
    if (connectionState !== 'qr_pending') qrDataUrl = null;
    if (status === 'FAILED') lastDisconnectReason = 'WAHA melaporkan status FAILED — cek log WAHA untuk detail.';
  }
}

// Pulls the current session state straight from WAHA over HTTP. This is the safety-net path —
// the webhook (handleWahaWebhookEvent) is what normally keeps the mirror fresh in real time, but
// this covers the case where a webhook call never arrived (WAHA restarted mid-flight, a network
// hiccup, etc). Called on every /wa-gateway status.json poll and every 5 minutes from app.js.
async function reconcileGatewayStatus() {
  try {
    const session = await waha.getSession();
    applySessionSnapshot(session);
    if (connectionState === 'qr_pending') {
      try { qrDataUrl = await waha.getQrDataUrl(); }
      catch (e) { console.error('WA Gateway: gagal ambil QR dari WAHA:', e.message); }
    }
  } catch (e) {
    // Transient WAHA/network hiccup — keep showing the last known state rather than flashing to
    // "disconnected" on every blip.
    console.error('WA Gateway: gagal sinkronisasi status dari WAHA:', e.message);
  }
  return getGatewayStatus();
}

// Called by routes/waha.js whenever WAHA pushes a webhook event. This is the fast path — updates
// the mirror immediately instead of waiting for the next poll/cron reconcile.
async function handleWahaWebhookEvent(event) {
  const type = event?.event;
  if (type === 'session.status') {
    // Malformed/empty payload (shouldn't happen, but webhook bodies are external input) — skip
    // rather than risk flipping the mirror to 'disconnected' on a payload we can't actually read.
    if (!event?.payload) return;
    applySessionSnapshot({ status: event.payload.status, me: event.payload.me });
    if (connectionState === 'qr_pending') {
      try { qrDataUrl = await waha.getQrDataUrl(); }
      catch (e) { console.error('WA Gateway: gagal ambil QR dari WAHA (webhook):', e.message); }
    }
    if (connectionState === 'connected') processQueue();
  }
  // event === 'message' (incoming messages) is intentionally a no-op for now — this module only
  // handles outbound reminders/blast today. The webhook is already wired up, so a future two-way
  // feature (auto-reply, "reply STOP to opt out", etc.) just needs a handler added here.
}

function webhookCallbackUrl() {
  // WAHA_WEBHOOK_CALLBACK_URL lets you override this explicitly (e.g. when WAHA can't reach this
  // app at the same address APP_URL describes — see .env.example). Otherwise it's derived from
  // APP_URL (already used as this app's own base URL) + the webhook route mounted in app.js.
  const explicit = String(process.env.WAHA_WEBHOOK_CALLBACK_URL || '').trim();
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const base = explicit || (appUrl ? `${appUrl}/api/waha/webhook` : '');
  if (!base) return null; // nothing to build a callback from — reconcile-by-polling only, see .env.example
  const token = String(process.env.WAHA_WEBHOOK_TOKEN || '').trim();
  if (!token) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

async function startGateway() {
  if (connectionState === 'connecting' || connectionState === 'qr_pending' || connectionState === 'connected') {
    return getGatewayStatus();
  }
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    connectionState = 'connecting';
    qrDataUrl = null;
    try {
      await waha.startSession(webhookCallbackUrl());
      await reconcileGatewayStatus();
    } catch (e) {
      connectionState = 'disconnected';
      lastDisconnectReason = e.message;
      console.error('WA Gateway: gagal memulai sesi WAHA:', e.message);
    } finally {
      startingPromise = null;
    }
    return getGatewayStatus();
  })();
  return startingPromise;
}

// Used once at app boot (see app.js) to resume a session that was already linked before this
// restart, without requiring the admin to click Connect again. Unlike the old Baileys version,
// WAHA keeps the WhatsApp session alive in its own process independent of this app's lifecycle,
// so this mostly just needs to sync the in-memory mirror — but we still call startSession() in
// case WAHA itself was restarted and the session needs to be resumed there too.
async function initGatewayOnBoot() {
  try {
    const existing = await waha.getSession();
    if (!existing) return getGatewayStatus(); // never connected — wait for admin to press Connect
    await startGateway();
  } catch (e) {
    console.error('WA Gateway: gagal sinkronisasi awal dengan WAHA saat startup:', e.message);
  }
  return getGatewayStatus();
}

async function logoutGateway() {
  try { await waha.stopAndLogoutSession(); } catch (e) { console.error('WA Gateway: gagal logout dari WAHA:', e.message); }
  connectionState = 'disconnected';
  qrDataUrl = null;
  connectedNumber = null;
  lastConnectedAt = null;
}

// Enqueue a message for the send queue. Validates the phone number up front (via the existing
// whatsappService validator) so obviously-bad numbers fail fast instead of sitting in 'queued' forever.
async function enqueueWaMessage({ phone, message, customerId = null, invoiceId = null, type = 'manual', userId = null }) {
  const wa = validateWhatsapp(phone);
  if (!wa.valid) {
    const [r] = await db.execute(
      `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,error_message,created_by) VALUES(?,?,?,?,?,'failed',?,?)`,
      [customerId, invoiceId, String(phone || ''), message, type, `Nomor WhatsApp tidak valid: ${wa.reason}`, userId]
    );
    return { id: r.insertId, status: 'failed', reason: wa.reason };
  }
  const [r] = await db.execute(
    `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,created_by) VALUES(?,?,?,?,?,'queued',?)`,
    [customerId, invoiceId, wa.normalized, message, type, userId]
  );
  processQueue();
  return { id: r.insertId, status: 'queued' };
}

// Single-worker queue processor. Only ever one instance runs at a time (processingLock); each send is
// followed by a randomized delay to keep the sending rate human-like and reduce ban risk. If the
// gateway is not connected, processing simply stops — enqueueWaMessage() or the queue watchdog cron in
// app.js will kick it again once reconnected, so nothing is lost, only delayed.
async function processQueue() {
  if (processingLock) return;
  processingLock = true;
  try {
    while (true) {
      if (connectionState !== 'connected') break;
      const [[row]] = await db.execute(`SELECT * FROM wa_messages WHERE status='queued' ORDER BY id ASC LIMIT 1`);
      if (!row) break;
      try {
        await waha.sendText(row.phone, row.message);
        await db.execute(`UPDATE wa_messages SET status='sent',sent_at=NOW() WHERE id=?`, [row.id]);
      } catch (e) {
        await db.execute(`UPDATE wa_messages SET status='failed',error_message=? WHERE id=?`, [String(e?.message || e).slice(0, 500), row.id]);
      }
      await sleep(randomDelay(4000, 9000));
    }
  } finally {
    processingLock = false;
  }
}

async function getQueueStats() {
  const [[row]] = await db.query(`SELECT
    SUM(status='queued') queued,
    SUM(status='sent' AND DATE(created_at)=CURDATE()) sent_today,
    SUM(status='failed' AND DATE(created_at)=CURDATE()) failed_today,
    SUM(status='sent') sent_total
    FROM wa_messages`);
  return {
    queued: Number(row?.queued || 0),
    sentToday: Number(row?.sent_today || 0),
    failedToday: Number(row?.failed_today || 0),
    sentTotal: Number(row?.sent_total || 0),
  };
}

async function getRecentMessages(limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const [rows] = await db.query(
    `SELECT wm.*,c.name customer_name,c.customer_code,i.invoice_number
     FROM wa_messages wm
     LEFT JOIN customers c ON c.id=wm.customer_id
     LEFT JOIN invoices i ON i.id=wm.invoice_id
     ORDER BY wm.id DESC LIMIT ${safeLimit}`
  );
  return rows;
}

const MONTH_NAMES_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const DEFAULT_REMINDER_TEMPLATE = 'Halo {nama}, kami mengingatkan tagihan INKAMNET periode {periode} sebesar {nominal}. No. faktur {no_faktur}, jatuh tempo {jatuh_tempo}. Mohon segera diselesaikan agar layanan tidak terganggu. Terima kasih.';

function formatRupiahPlain(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
}
function formatDateIndo(value) {
  if (!value) return '-';
  const d = new Date(value);
  return `${d.getDate()} ${MONTH_NAMES_ID[d.getMonth()]} ${d.getFullYear()}`;
}
function renderReminderTemplate(template, invoice) {
  const periode = `${MONTH_NAMES_ID[Number(invoice.period_month) - 1] || ''} ${invoice.period_year}`;
  return String(template || DEFAULT_REMINDER_TEMPLATE)
    .replace(/\{nama\}/g, invoice.name || '')
    .replace(/\{kode\}/g, invoice.customer_code || '')
    .replace(/\{periode\}/g, periode)
    .replace(/\{nominal\}/g, formatRupiahPlain(invoice.outstanding))
    .replace(/\{no_faktur\}/g, invoice.invoice_number || '')
    .replace(/\{jatuh_tempo\}/g, formatDateIndo(invoice.due_date));
}

// Scheduled auto-reminder sweep — called from a cron watchdog in app.js every few minutes. Runs at
// most ONCE per calendar day (tracked via settings.wa_auto_reminder_last_run_date), once the current
// hour reaches settings.wa_auto_reminder_hour, and only when settings.wa_auto_reminder_enabled=1.
// Offsets are days relative to invoices.due_date (e.g. '-3,-1,0' = H-3, H-1, and due-date-day itself).
async function runAutoReminderSweep(now = new Date()) {
  const [[settingsRow]] = await db.query(
    `SELECT wa_auto_reminder_enabled,wa_auto_reminder_hour,wa_auto_reminder_offsets,wa_auto_reminder_last_run_date,wa_auto_reminder_template FROM settings WHERE id=1 LIMIT 1`
  );
  if (!settingsRow || !Number(settingsRow.wa_auto_reminder_enabled)) return { ran: false, reason: 'disabled' };
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lastRunKey = settingsRow.wa_auto_reminder_last_run_date ? new Date(settingsRow.wa_auto_reminder_last_run_date).toISOString().slice(0, 10) : null;
  if (lastRunKey === todayKey) return { ran: false, reason: 'already_ran_today' };
  if (now.getHours() < Number(settingsRow.wa_auto_reminder_hour ?? 9)) return { ran: false, reason: 'not_yet_hour' };
  if (connectionState !== 'connected') return { ran: false, reason: 'gateway_not_connected' };

  const offsets = String(settingsRow.wa_auto_reminder_offsets || '-3,-1,0').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  let enqueued = 0, skippedNoWa = 0, skippedAlreadySent = 0;
  for (const offset of offsets) {
    const [invoices] = await db.query(
      `SELECT i.id invoice_id,i.invoice_number,i.outstanding,i.due_date,i.period_month,i.period_year,
              c.id customer_id,c.customer_code,c.name,c.phone,c.whatsapp_status
       FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
         AND i.due_date=DATE_ADD(CURDATE(),INTERVAL ? DAY)
         AND c.archived_at IS NULL AND c.customer_status='active'`,
      [offset]
    );
    for (const inv of invoices) {
      if (inv.whatsapp_status !== 'valid') { skippedNoWa++; continue; }
      const [[already]] = await db.query(
        `SELECT id FROM wa_messages WHERE invoice_id=? AND message_type='auto_reminder' AND DATE(created_at)=CURDATE() LIMIT 1`,
        [inv.invoice_id]
      );
      if (already) { skippedAlreadySent++; continue; }
      const message = renderReminderTemplate(settingsRow.wa_auto_reminder_template, inv);
      await enqueueWaMessage({ phone: inv.phone, message, customerId: inv.customer_id, invoiceId: inv.invoice_id, type: 'auto_reminder', userId: null });
      enqueued++;
    }
  }
  await db.execute(`UPDATE settings SET wa_auto_reminder_last_run_date=CURDATE() WHERE id=1`);
  return { ran: true, enqueued, skippedNoWa, skippedAlreadySent };
}

module.exports = {
  startGateway,
  initGatewayOnBoot,
  logoutGateway,
  getGatewayStatus,
  reconcileGatewayStatus,
  handleWahaWebhookEvent,
  enqueueWaMessage,
  processQueue,
  getQueueStats,
  getRecentMessages,
  runAutoReminderSweep,
  renderReminderTemplate,
  DEFAULT_REMINDER_TEMPLATE,
};
