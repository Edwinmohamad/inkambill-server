// WA Gateway — self-hosted WhatsApp automation using Baileys (multi-device WhatsApp Web protocol).
// Connects using the OWN WhatsApp number of whoever scans the QR code (Master Admin only, from the
// /wa-gateway page). No third-party API key is required, but this is an unofficial protocol: sending
// too fast / too many messages risks the number being rate-limited or banned by WhatsApp, which is why
// every send goes through a single queue with a randomized delay between messages (see processQueue()).
//
// State (connection/QR) lives in memory (module-level) since only one Node process manages the socket.
// Every message attempt — manual, bulk blast, or scheduled auto-reminder — is persisted to wa_messages
// so the WA Gateway page and the dashboard widget always reflect real, durable data instead of
// in-memory-only counters that reset on restart.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;
const db = require('../config/db');
const { validateWhatsapp } = require('./whatsappService');

const SESSION_DIR = path.join(__dirname, '..', 'storage', 'wa-session');
fs.mkdirSync(SESSION_DIR, { recursive: true });

let sock = null;
let connectionState = 'disconnected'; // disconnected | connecting | qr_pending | connected
let qrDataUrl = null;
let connectedNumber = null;
let lastConnectedAt = null;
let lastDisconnectReason = null;
let manualLogoutRequested = false;
let startingPromise = null;
let processingLock = false;
let reconnectTimer = null;

const logger = pino({ level: 'silent' });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay(minMs, maxMs) { return minMs + Math.floor(Math.random() * (maxMs - minMs)); }

function hasSavedSession() {
  try { return fs.existsSync(path.join(SESSION_DIR, 'creds.json')); }
  catch { return false; }
}

function getGatewayStatus() {
  return {
    state: connectionState,
    qrDataUrl: connectionState === 'qr_pending' ? qrDataUrl : null,
    connectedNumber,
    lastConnectedAt,
    lastDisconnectReason,
    hasSavedSession: hasSavedSession(),
  };
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
      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
      const { version } = await fetchLatestBaileysVersion();
      sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: Browsers.ubuntu('INKAMNET Gateway'),
        printQRInTerminal: false,
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          try { qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 }); }
          catch (e) { console.error('WA Gateway: gagal membuat QR image:', e.message); }
          connectionState = 'qr_pending';
        }
        if (connection === 'open') {
          connectionState = 'connected';
          qrDataUrl = null;
          connectedNumber = String(sock?.user?.id || '').split(':')[0].split('@')[0] || null;
          lastConnectedAt = new Date();
          lastDisconnectReason = null;
          console.log(`WA Gateway terhubung: ${connectedNumber || '(nomor tidak diketahui)'}`);
          processQueue();
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          connectionState = 'disconnected';
          qrDataUrl = null;
          connectedNumber = null;
          lastDisconnectReason = loggedOut ? 'logged_out' : (lastDisconnect?.error?.message || 'connection_closed');
          sock = null;
          if (!loggedOut && !manualLogoutRequested) {
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => { startingPromise = null; startGateway().catch(()=>{}); }, 8000);
          } else if (loggedOut) {
            // WhatsApp itself invalidated the session (e.g. unlinked from phone) — clear stale creds so
            // the next Connect attempt always shows a fresh QR instead of silently failing forever.
            fs.promises.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
          }
          manualLogoutRequested = false;
        }
      });
    } catch (e) {
      connectionState = 'disconnected';
      lastDisconnectReason = e.message;
      console.error('WA Gateway: gagal memulai koneksi:', e.message);
    } finally {
      startingPromise = null;
    }
    return getGatewayStatus();
  })();
  return startingPromise;
}

async function logoutGateway() {
  manualLogoutRequested = true;
  clearTimeout(reconnectTimer);
  try { if (sock) await sock.logout(); } catch (e) { /* ignore — we clear local session below regardless */ }
  sock = null;
  connectionState = 'disconnected';
  qrDataUrl = null;
  connectedNumber = null;
  lastConnectedAt = null;
  await fs.promises.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
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
      if (connectionState !== 'connected' || !sock) break;
      const [[row]] = await db.execute(`SELECT * FROM wa_messages WHERE status='queued' ORDER BY id ASC LIMIT 1`);
      if (!row) break;
      try {
        const jid = `${row.phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: row.message });
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
  logoutGateway,
  getGatewayStatus,
  enqueueWaMessage,
  processQueue,
  getQueueStats,
  getRecentMessages,
  runAutoReminderSweep,
  renderReminderTemplate,
  DEFAULT_REMINDER_TEMPLATE,
  hasSavedSession,
};
