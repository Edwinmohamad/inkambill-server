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
const { getWahaConfig, callbackUrl } = require('./wahaConfigService');

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
let blastEnabled = false; // cache settings.wa_blast_enabled (dibaca sinkron oleh middleware/common.js)

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

function resetGatewayState(reason = 'Konfigurasi WAHA diperbarui; hubungkan ulang sesi.') {
  connectionState = 'disconnected';
  qrDataUrl = null;
  connectedNumber = null;
  lastConnectedAt = null;
  lastDisconnectReason = reason;
  startingPromise = null;
  return getGatewayStatus();
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

async function startGateway() {
  if (connectionState === 'connecting' || connectionState === 'qr_pending' || connectionState === 'connected') {
    return getGatewayStatus();
  }
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    connectionState = 'connecting';
    qrDataUrl = null;
    try {
      const config = await getWahaConfig({ fresh: true });
      await waha.startSession(callbackUrl(config));
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
  await refreshWaFeatureFlags();
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
// approvalBatch: bila diisi (lihat approvalBatchKey), pesan disimpan sebagai draf 'pending_approval'
// dan BARU masuk antrean setelah Admin mengonfirmasi batch tersebut di halaman WA Gateway. Semua pesan
// otomatis ke pelanggan wajib lewat jalur ini; pesan manual yang diketik/diklik staf langsung antre.
async function enqueueWaMessage({ phone, message, customerId = null, invoiceId = null, type = 'manual', userId = null, approvalBatch = null }) {
  const wa = validateWhatsapp(phone);
  if (!wa.valid) {
    const [r] = await db.execute(
      `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,error_message,created_by,approval_batch) VALUES(?,?,?,?,?,'failed',?,?,?)`,
      [customerId, invoiceId, String(phone || ''), message, type, `Nomor WhatsApp tidak valid: ${wa.reason}`, userId, approvalBatch]
    );
    return { id: r.insertId, status: 'failed', reason: wa.reason };
  }
  const status = approvalBatch ? 'pending_approval' : 'queued';
  const [r] = await db.execute(
    `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,created_by,approval_batch) VALUES(?,?,?,?,?,?,?,?)`,
    [customerId, invoiceId, wa.normalized, message, type, status, userId, approvalBatch]
  );
  if (status === 'queued') processQueue();
  return { id: r.insertId, status };
}

// ---- Konfirmasi Admin untuk pesan otomatis (per batch) -------------------------------------------
const BATCH_LABELS = {
  auto_reminder: 'Auto-Reminder Tagihan',
  payment_receipt: 'Tanda Terima Pembayaran',
  n8n_reminder: 'Reminder Tagihan (n8n)',
  n8n_ticket: 'Notifikasi Tiket ke Pelanggan (n8n)',
};
function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Satu batch = satu sumber pesan otomatis per hari, mis. "auto_reminder:2026-09-24".
function approvalBatchKey(source, date = new Date()) { return `${source}:${localDateKey(date)}`; }
function describeBatch(key) {
  const [source, date] = String(key || '').split(':');
  return { key, source, date, label: BATCH_LABELS[source] || source };
}

async function listPendingBatches({ itemLimit = 500 } = {}) {
  const [batches] = await db.query(
    `SELECT approval_batch batch,COUNT(*) total,MIN(created_at) first_at,MAX(created_at) last_at
     FROM wa_messages WHERE status='pending_approval' AND approval_batch IS NOT NULL
     GROUP BY approval_batch ORDER BY MIN(created_at) ASC`
  );
  const result = [];
  for (const b of batches) {
    const [items] = await db.query(
      `SELECT wm.id,wm.phone,wm.message,wm.message_type,wm.created_at,c.name customer_name,c.customer_code,i.invoice_number
       FROM wa_messages wm LEFT JOIN customers c ON c.id=wm.customer_id LEFT JOIN invoices i ON i.id=wm.invoice_id
       WHERE wm.approval_batch=? AND wm.status='pending_approval' ORDER BY wm.id ASC LIMIT ${Math.max(1, Number(itemLimit) || 500)}`,
      [b.batch]
    );
    result.push({ ...describeBatch(b.batch), total: Number(b.total), firstAt: b.first_at, lastAt: b.last_at, items });
  }
  return result;
}

async function approveBatch(batch, userId) {
  // Reminder yang tagihannya sudah lunas sejak draf dibuat tidak ikut dikirim.
  const [stale] = await db.execute(
    `UPDATE wa_messages wm JOIN invoices i ON i.id=wm.invoice_id
     SET wm.status='rejected',wm.approved_by=?,wm.approved_at=NOW(),wm.error_message='Dibatalkan otomatis: tagihan sudah lunas saat dikonfirmasi.'
     WHERE wm.approval_batch=? AND wm.status='pending_approval' AND wm.message_type='auto_reminder' AND (i.outstanding<=0 OR i.status='paid')`,
    [userId, batch]
  );
  const [ok] = await db.execute(
    `UPDATE wa_messages SET status='queued',approved_by=?,approved_at=NOW(),next_attempt_at=NULL WHERE approval_batch=? AND status='pending_approval'`,
    [userId, batch]
  );
  if (ok.affectedRows) processQueue();
  return { approved: Number(ok.affectedRows || 0), skippedPaid: Number(stale.affectedRows || 0) };
}

async function rejectBatch(batch, userId) {
  const [r] = await db.execute(
    `UPDATE wa_messages SET status='rejected',approved_by=?,approved_at=NOW(),error_message='Dibatalkan oleh Admin.' WHERE approval_batch=? AND status='pending_approval'`,
    [userId, batch]
  );
  return { rejected: Number(r.affectedRows || 0) };
}

// ---- WA Blast opsional ---------------------------------------------------------------------------
async function refreshWaFeatureFlags() {
  try {
    const [[row]] = await db.query(`SELECT wa_blast_enabled FROM settings WHERE id=1 LIMIT 1`);
    blastEnabled = !!Number(row?.wa_blast_enabled);
  } catch (e) { console.error('WA Gateway: gagal membaca pengaturan fitur:', e.message); }
  return { blastEnabled };
}
function isBlastEnabled() { return blastEnabled; }

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
      const [[row]] = await db.execute(`SELECT * FROM wa_messages WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()) ORDER BY id ASC LIMIT 1`);
      if (!row) break;
      try {
        const response = await waha.sendText(row.phone, row.message);
        const providerId = response?.id || response?.key?.id || response?._data?.id?.id || response?._data?.id || null;
        await db.execute(`UPDATE wa_messages SET status='sent',sent_at=NOW(),attempts=attempts+1,next_attempt_at=NULL,error_message=NULL,provider_message_id=? WHERE id=?`, [providerId ? String(providerId).slice(0, 255) : null, row.id]);
      } catch (e) {
        await db.execute(`UPDATE wa_messages SET status='failed',attempts=attempts+1,next_attempt_at=NULL,error_message=? WHERE id=?`, [String(e?.message || e).slice(0, 500), row.id]);
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
    SUM(status='pending_approval') pending_approval,
    SUM(status='sent' AND DATE(created_at)=CURDATE()) sent_today,
    SUM(status='failed' AND DATE(created_at)=CURDATE()) failed_today,
    SUM(status='sent') sent_total
    FROM wa_messages`);
  return {
    queued: Number(row?.queued || 0),
    pendingApproval: Number(row?.pending_approval || 0),
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
const DEFAULT_REMINDER_TEMPLATE = 'Yth. Bapak/Ibu {nama},\n\nBersama pesan ini kami sampaikan informasi tagihan layanan internet INKAMNET Anda sebagai berikut:\n\nNo. Pelanggan : {kode}\nNo. Faktur : {no_faktur}\nPeriode : {periode}\nJumlah Tagihan : {nominal}\nJatuh Tempo : {jatuh_tempo}\n\nMohon kesediaan Bapak/Ibu untuk menyelesaikan pembayaran tepat waktu agar layanan tetap dapat digunakan tanpa gangguan. Apabila pembayaran telah dilakukan, mohon abaikan pesan ini.\n\nTerima kasih atas kepercayaan Anda.\n\nHormat kami,\nTim Layanan Pelanggan INKAMNET';

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
  // Tidak perlu menunggu gateway terhubung: sweep hanya membuat draf yang menunggu konfirmasi Admin,
  // dan antrean baru berjalan setelah dikonfirmasi & gateway terhubung.
  const batch = approvalBatchKey('auto_reminder', now);

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
      await enqueueWaMessage({ phone: inv.phone, message, customerId: inv.customer_id, invoiceId: inv.invoice_id, type: 'auto_reminder', userId: null, approvalBatch: batch });
      enqueued++;
    }
  }
  await db.execute(`UPDATE settings SET wa_auto_reminder_last_run_date=CURDATE() WHERE id=1`);
  return { ran: true, enqueued, skippedNoWa, skippedAlreadySent, approvalBatch: enqueued ? batch : null };
}

module.exports = {
  startGateway,
  initGatewayOnBoot,
  logoutGateway,
  getGatewayStatus,
  resetGatewayState,
  reconcileGatewayStatus,
  handleWahaWebhookEvent,
  enqueueWaMessage,
  processQueue,
  getQueueStats,
  getRecentMessages,
  runAutoReminderSweep,
  approvalBatchKey,
  describeBatch,
  listPendingBatches,
  approveBatch,
  rejectBatch,
  refreshWaFeatureFlags,
  isBlastEnabled,
  renderReminderTemplate,
  DEFAULT_REMINDER_TEMPLATE,
};
