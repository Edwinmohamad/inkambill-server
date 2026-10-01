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
const antiBan = require('./waAntiBanService');
const tpl = require('./waTemplateService');
function realtime() { return require('./waRealtime'); }

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

// ---- Auto-reconnect watchdog state ----------------------------------------------------------------
// Bug lama: bila WAHA melaporkan STOPPED/FAILED (WAHA restart, container update, crash browser,
// koneksi WA putus) app hanya mencerminkan "disconnected" dan TIDAK PERNAH menyalakan ulang sesi —
// harus menunggu Admin klik Connect. Watchdog di bawah (dipanggil tiap menit dari app.js + saat
// webhook STOPPED/FAILED masuk) menyalakan ulang sesi otomatis dengan backoff.
let manualLogout = false;          // Admin sengaja logout → jangan auto-reconnect
let recoverAttempts = 0;
let nextRecoverAt = 0;
let lastRecoverAt = null;
let startingSince = null;          // kapan status STARTING pertama terlihat (deteksi sesi macet)
let reconcileFailures = 0;         // gagal menjangkau WAHA berturut-turut
let watchdogRunning = false;
let recoverTimer = null;
const MAX_UNREACHABLE_BEFORE_DISCONNECTED = 3;
const STARTING_STUCK_MS = 5 * 60 * 1000;
const RECOVER_BACKOFF_MS = [0, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3];

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
    autoReconnect: {
      enabled: !manualLogout,
      attempts: recoverAttempts,
      lastAttemptAt: lastRecoverAt,
      nextAttemptAt: nextRecoverAt ? new Date(nextRecoverAt) : null,
    },
  };
}

function resetRecoverBackoff() { recoverAttempts = 0; nextRecoverAt = 0; }

function resetGatewayState(reason = 'Konfigurasi WAHA diperbarui; hubungkan ulang sesi.') {
  connectionState = 'disconnected';
  qrDataUrl = null;
  connectedNumber = null;
  lastConnectedAt = null;
  lastDisconnectReason = reason;
  startingPromise = null;
  startingSince = null;
  reconcileFailures = 0;
  resetRecoverBackoff();
  return getGatewayStatus();
}

function applySessionSnapshot(session) {
  if (!session) {
    // Session name has never been created on WAHA — nothing to reconnect to yet, admin has to
    // press Connect (which creates it for the first time).
    connectionState = 'disconnected';
    qrDataUrl = null;
    connectedNumber = null;
    startingSince = null;
    return;
  }
  const status = String(session.status || '').toUpperCase();
  const previous = connectionState;
  connectionState = STATUS_MAP[status] || 'disconnected';
  startingSince = status === 'STARTING' ? (startingSince || Date.now()) : null;
  if (connectionState === 'connected') {
    qrDataUrl = null;
    connectedNumber = extractNumber(session?.me?.id) || connectedNumber;
    if (!lastConnectedAt || previous !== 'connected') lastConnectedAt = new Date();
    lastDisconnectReason = null;
    resetRecoverBackoff();
  } else {
    connectedNumber = null;
    if (connectionState !== 'qr_pending') qrDataUrl = null;
    if (status === 'FAILED') lastDisconnectReason = 'WAHA melaporkan status FAILED — sesi akan dinyalakan ulang otomatis.';
    else if (status === 'STOPPED' && previous === 'connected') lastDisconnectReason = 'Sesi WAHA berhenti (STOPPED) — sesi akan dinyalakan ulang otomatis.';
    else if (status === 'SCAN_QR_CODE' && previous === 'connected') lastDisconnectReason = 'Perangkat tertaut dilepas dari HP — scan ulang QR diperlukan.';
  }
}

// Pulls the current session state straight from WAHA over HTTP. This is the safety-net path —
// the webhook (handleWahaWebhookEvent) is what normally keeps the mirror fresh in real time.
async function reconcileGatewayStatus() {
  try {
    const session = await waha.getSession();
    reconcileFailures = 0;
    applySessionSnapshot(session);
    if (connectionState === 'qr_pending') {
      try { qrDataUrl = await waha.getQrDataUrl(); }
      catch (e) { console.error('WA Gateway: gagal ambil QR dari WAHA:', e.message); }
    }
  } catch (e) {
    // Satu-dua blip jaringan: tetap tampilkan status terakhir. Tapi bila WAHA benar-benar tidak
    // terjangkau beberapa kali berturut-turut, jangan terus mengaku "connected" (bug lama: /send
    // tetap menerima pesan lalu semuanya gagal permanen).
    reconcileFailures++;
    console.error(`WA Gateway: gagal sinkronisasi status dari WAHA (${reconcileFailures}x):`, e.message);
    if (reconcileFailures >= MAX_UNREACHABLE_BEFORE_DISCONNECTED && connectionState !== 'disconnected') {
      connectionState = 'disconnected';
      connectedNumber = null;
      qrDataUrl = null;
      lastDisconnectReason = `WAHA tidak dapat dijangkau: ${e.message}. Menyambung ulang otomatis...`;
    }
  }
  return getGatewayStatus();
}

function scheduleRecover(delayMs = 5000) {
  if (recoverTimer) return;
  recoverTimer = setTimeout(() => {
    recoverTimer = null;
    ensureGatewayAlive().catch(e => console.error('WA Gateway watchdog gagal:', e.message));
  }, delayMs);
  if (recoverTimer.unref) recoverTimer.unref();
}

// Called by routes/waha.js whenever WAHA pushes a webhook event. This is the fast path — updates
// the mirror immediately instead of waiting for the next poll/cron reconcile.
async function handleWahaWebhookEvent(event) {
  const type = event?.event;
  if (type === 'session.status') {
    // Malformed/empty payload (shouldn't happen, but webhook bodies are external input) — skip
    // rather than risk flipping the mirror to 'disconnected' on a payload we can't actually read.
    if (!event?.payload) return;
    // WAHA bisa memakai webhook global (WHATSAPP_HOOK_URL) untuk SEMUA sesi. Tanpa filter ini,
    // status sesi lain (mis. sesi uji "STOPPED") ikut memutus status gateway kita.
    const { sessionName } = await getWahaConfig();
    if (event.session && sessionName && String(event.session) !== String(sessionName)) return;
    // WAHA mengirim `me` di level atas event (bukan di payload); dukung keduanya.
    applySessionSnapshot({ status: event.payload.status, me: event.payload.me || event.me });
    reconcileFailures = 0;
    if (connectionState === 'qr_pending') {
      try { qrDataUrl = await waha.getQrDataUrl(); }
      catch (e) { console.error('WA Gateway: gagal ambil QR dari WAHA (webhook):', e.message); }
    }
    if (connectionState === 'connected') processQueue();
    const status = String(event.payload.status || '').toUpperCase();
    if ((status === 'STOPPED' || status === 'FAILED') && !manualLogout) scheduleRecover(5000);
  }
  if (type === 'message' || type === 'message.ack') {
    const { sessionName } = await getWahaConfig();
    if (event.session && sessionName && String(event.session) !== String(sessionName)) return;
    const inbox = require('./waInboxService');
    if (type === 'message') await inbox.ingestInbound(event.payload || {});
    else await inbox.handleAck(event.payload || {});
  }
}

async function startGateway({ manual = false } = {}) {
  if (manual) { manualLogout = false; resetRecoverBackoff(); }
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    try {
      // Bug lama: keputusan diambil dari mirror in-memory yang bisa basi ("connected" padahal WAHA
      // sudah STOPPED) sehingga tombol Connect tidak melakukan apa-apa. Selalu cek WAHA dulu.
      await reconcileGatewayStatus();
      if (connectionState === 'connected' || connectionState === 'qr_pending') return getGatewayStatus();
      if (connectionState === 'connecting' && !(startingSince && Date.now() - startingSince > STARTING_STUCK_MS)) return getGatewayStatus();
      connectionState = 'connecting';
      qrDataUrl = null;
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

// Watchdog auto-reconnect — dipanggil tiap menit dari app.js, saat boot, dan saat webhook
// STOPPED/FAILED. Aman dipanggil berulang: tidak pernah mengganggu sesi yang WORKING/SCAN_QR_CODE,
// memakai backoff agar tidak membanjiri WAHA saat WAHA sendiri sedang down.
async function ensureGatewayAlive() {
  if (watchdogRunning) return getGatewayStatus();
  watchdogRunning = true;
  try {
    let session;
    try {
      session = await waha.getSession();
      reconcileFailures = 0;
    } catch (e) {
      await reconcileGatewayStatus(); // hitung kegagalan & tandai disconnected bila perlu
      return getGatewayStatus();
    }
    applySessionSnapshot(session);
    if (connectionState === 'qr_pending' && !qrDataUrl) {
      try { qrDataUrl = await waha.getQrDataUrl(); } catch (_) { /* dicoba lagi pada poll berikut */ }
    }
    if (connectionState === 'connected') { processQueue(); return getGatewayStatus(); } // processQueue melepas pause 'disconnected'
    if (!session || manualLogout) return getGatewayStatus(); // belum pernah ditautkan / sengaja logout

    const status = String(session.status || '').toUpperCase();
    const stuckStarting = status === 'STARTING' && startingSince && Date.now() - startingSince > STARTING_STUCK_MS;
    if (!(status === 'STOPPED' || status === 'FAILED' || stuckStarting)) return getGatewayStatus();
    if (Date.now() < nextRecoverAt) return getGatewayStatus();

    recoverAttempts++;
    lastRecoverAt = new Date();
    nextRecoverAt = Date.now() + RECOVER_BACKOFF_MS[Math.min(recoverAttempts, RECOVER_BACKOFF_MS.length - 1)];
    console.log(`WA Gateway: sesi WAHA ${status}${stuckStarting ? ' (macet)' : ''} — auto-reconnect percobaan #${recoverAttempts}`);
    try {
      if (stuckStarting) {
        const config = await getWahaConfig();
        const name = encodeURIComponent(config.sessionName);
        try { await waha.request('POST', `/api/sessions/${name}/stop`, undefined, config); } catch (_) { /* lanjut start */ }
        startingSince = null;
      }
      connectionState = 'connecting';
      const config = await getWahaConfig({ fresh: true });
      await waha.startSession(callbackUrl(config));
      await reconcileGatewayStatus();
      if (connectionState === 'connected') console.log('WA Gateway: auto-reconnect berhasil.');
    } catch (e) {
      connectionState = 'disconnected';
      lastDisconnectReason = `Auto-reconnect gagal (#${recoverAttempts}): ${e.message}`;
      console.error('WA Gateway:', lastDisconnectReason);
    }
    return getGatewayStatus();
  } finally {
    watchdogRunning = false;
  }
}

// Used once at app boot (see app.js) to resume a session that was already linked before this
// restart, without requiring the admin to click Connect again.
async function initGatewayOnBoot() {
  await refreshWaFeatureFlags();
  await antiBan.getConfig({ fresh: true });
  await recoverStaleProcessing();
  // Pesan yang tertinggal di status lama tetap aman: antrean diproses setelah terhubung.
  try { await ensureGatewayAlive(); }
  catch (e) { console.error('WA Gateway: gagal sinkronisasi awal dengan WAHA saat startup:', e.message); }
  return getGatewayStatus();
}

async function logoutGateway() {
  manualLogout = true;
  resetRecoverBackoff();
  try { await waha.stopAndLogoutSession(); } catch (e) { console.error('WA Gateway: gagal logout dari WAHA:', e.message); }
  connectionState = 'disconnected';
  qrDataUrl = null;
  connectedNumber = null;
  lastConnectedAt = null;
  lastDisconnectReason = 'Diputuskan oleh Admin.';
}

// Enqueue a message for the send queue. Validates the phone number up front (via the existing
// whatsappService validator) so obviously-bad numbers fail fast instead of sitting in 'queued' forever.
// approvalBatch: bila diisi (lihat approvalBatchKey), pesan disimpan sebagai draf 'pending_approval'
// dan BARU masuk antrean setelah Admin mengonfirmasi batch tersebut di halaman WA Gateway. Semua pesan
// otomatis ke pelanggan wajib lewat jalur ini; pesan manual yang diketik/diklik staf langsung antre.
async function enqueueWaMessage({ phone, message, customerId = null, invoiceId = null, type = 'manual', userId = null, approvalBatch = null,
  broadcastId = null, conversationId = null, chatMessageId = null, scheduledAt = null, media = null }) {
  const wa = validateWhatsapp(phone);
  if (!wa.valid) {
    const [r] = await db.execute(
      `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,error_message,created_by,approval_batch,broadcast_id,conversation_id,chat_message_id) VALUES(?,?,?,?,?,'failed',?,?,?,?,?,?)`,
      [customerId, invoiceId, String(phone || ''), message, type, `Nomor WhatsApp tidak valid: ${wa.reason}`, userId, approvalBatch, broadcastId, conversationId, chatMessageId]
    );
    console.error(`WA queue: nomor tidak valid (${phone}) untuk pesan #${r.insertId}: ${wa.reason}`);
    return { id: r.insertId, status: 'failed', reason: wa.reason };
  }
  // Opt-out: pesan massal ke nomor yang sudah membalas STOP/BERHENTI tidak pernah dibuat.
  if (antiBan.BULK_TYPES.includes(type) && await antiBan.isBlacklisted(wa.normalized)) {
    const [r] = await db.execute(
      `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,error_message,created_by,approval_batch,broadcast_id) VALUES(?,?,?,?,?,'cancelled','Nomor opt-out (blacklist broadcast).',?,?,?)`,
      [customerId, invoiceId, wa.normalized, message, type, userId, approvalBatch, broadcastId]
    );
    return { id: r.insertId, status: 'cancelled', reason: 'blacklist' };
  }
  const status = approvalBatch ? 'pending_approval' : 'queued';
  const [r] = await db.execute(
    `INSERT INTO wa_messages(customer_id,invoice_id,phone,message,message_type,status,created_by,approval_batch,broadcast_id,conversation_id,chat_message_id,scheduled_at,next_attempt_at,media_path,media_mime,media_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [customerId, invoiceId, wa.normalized, message, type, status, userId, approvalBatch, broadcastId, conversationId, chatMessageId, scheduledAt, scheduledAt, media?.path || null, media?.mime || null, media?.name || null]
  );
  if (status === 'queued') {
    if (!antiBan.BULK_TYPES.includes(type)) priorityWaiting = true; // bangunkan worker dari jeda panjang
    processQueue();
  }
  return { id: r.insertId, status };
}

// ---- Konfirmasi Admin untuk pesan otomatis (per batch) -------------------------------------------
const BATCH_LABELS = {
  auto_reminder: 'Auto-Reminder Tagihan',
  payment_receipt: 'Tanda Terima Pembayaran',
  n8n_reminder: 'Reminder Tagihan (n8n)',
  n8n_ticket: 'Notifikasi Tiket ke Pelanggan (n8n)',
  isolation_notice: 'Pemberitahuan Isolir Layanan',
  outage_notice: 'Info Gangguan Area (NMS)',
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
const MAX_SEND_ATTEMPTS = 5;
const MEDIA_DIR = require('path').join(__dirname, '..', 'storage', 'wa-media');
let priorityWaiting = false;   // ada pesan non-massal (balasan inbox/manual) yang baru masuk
let bulkSinceLongPause = 0;    // hitungan pesan massal sejak long pause terakhir
let lastSendAt = 0;
let queueNote = null;          // alasan antrean massal sedang menunggu (jam kerja / kuota) untuk UI

function pickProviderId(response) {
  const id = response?.id;
  if (id && typeof id === 'object') return id._serialized || id.id || null;
  return id || response?.key?.id || response?._data?.id?._serialized || response?._data?.id?.id || null;
}

// Jeda yang bisa "dibangunkan" lebih awal oleh pesan prioritas, tapi tetap menjaga jarak minimal
// minDelay dari pengiriman terakhir supaya pola kirim tidak pernah beruntun.
async function humanPause(ms, config) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(Math.min(1000, end - Date.now()));
    if (priorityWaiting && Date.now() - lastSendAt >= config.minDelaySec * 1000) return;
  }
}

async function simulateTyping(chatId, config) {
  if (!config.simulateTyping) return;
  try { await waha.startTyping(chatId); } catch (_) { return; } // engine tidak mendukung → lewati
  await sleep(antiBan.randomMs(config.typingMinSec, config.typingMaxSec));
  try { await waha.stopTyping(chatId); } catch (_) { /* abaikan */ }
}

async function markChatMessage(row, patch) {
  if (!row.chat_message_id) return;
  try {
    await db.execute(`UPDATE wa_chat_messages SET ack=?,wa_message_id=COALESCE(?,wa_message_id),error_message=? WHERE id=?`, [patch.ack, patch.waId || null, patch.error || null, row.chat_message_id]);
    realtime().emit('message.ack', { conversationId: row.conversation_id, id: row.chat_message_id, ack: patch.ack, error: patch.error || null });
  } catch (e) { console.error('WA queue: gagal update status chat:', e.message); }
}

async function nextQueuedRow(bulkAllowed) {
  const bulkList = antiBan.BULK_TYPES.map(() => '?').join(',');
  const [[row]] = await db.execute(
    `SELECT * FROM wa_messages WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW())
       AND (broadcast_id IS NULL OR broadcast_id NOT IN (SELECT id FROM wa_broadcasts WHERE status IN ('paused','cancelled')))
       ${bulkAllowed ? '' : `AND message_type NOT IN (${bulkList})`}
     ORDER BY (message_type IN (${bulkList})) ASC, id ASC LIMIT 1`,
    bulkAllowed ? antiBan.BULK_TYPES : [...antiBan.BULK_TYPES, ...antiBan.BULK_TYPES]
  );
  return row || null;
}

// Single-worker queue processor dengan engine anti-ban (lihat services/waAntiBanService.js).
async function processQueue() {
  if (processingLock) return;
  processingLock = true;
  try {
    const config = await antiBan.getConfig();
    // Pause karena putus koneksi dilepas otomatis begitu gateway kembali terhubung.
    const pause = antiBan.getPauseState();
    if (pause.paused && pause.kind === 'disconnected' && connectionState === 'connected') await antiBan.resumeQueue('auto: gateway terhubung kembali');
    while (true) {
      if (connectionState !== 'connected') break;
      if (antiBan.getPauseState().paused) break;
      priorityWaiting = false;
      const gate = await antiBan.bulkGate(config);
      queueNote = gate.allowed ? null : gate.reason;
      const row = await nextQueuedRow(gate.allowed);
      if (!row) break;
      const isBulk = antiBan.BULK_TYPES.includes(row.message_type);
      if (isBulk && await antiBan.isBlacklisted(row.phone)) {
        await db.execute(`UPDATE wa_messages SET status='cancelled',error_message='Dibatalkan: nomor opt-out (blacklist broadcast).' WHERE id=?`, [row.id]);
        continue;
      }
      // Kunci baris: hanya satu pengiriman per pesan walau processQueue terpanggil paralel.
      const [lock] = await db.execute(`UPDATE wa_messages SET status='processing' WHERE id=? AND status='queued'`, [row.id]);
      if (!lock.affectedRows) continue;
      const chatId = `${row.phone}@c.us`;
      try {
        await simulateTyping(chatId, config);
        let response;
        if (row.media_path) {
          const buffer = await require('fs').promises.readFile(require('path').join(MEDIA_DIR, require('path').basename(row.media_path)));
          response = await waha.sendMedia(chatId, { buffer, mimetype: row.media_mime, filename: row.media_name, caption: row.message || '' });
        } else {
          response = await waha.sendText(row.phone, row.message);
        }
        const providerId = pickProviderId(response);
        await db.execute(`UPDATE wa_messages SET status='sent',sent_at=NOW(),attempts=attempts+1,next_attempt_at=NULL,error_message=NULL,provider_message_id=? WHERE id=?`, [providerId ? String(providerId).slice(0, 255) : null, row.id]);
        await markChatMessage(row, { ack: 'sent', waId: providerId ? String(providerId).slice(0, 255) : null });
        if (row.broadcast_id) realtime().emit('broadcast.progress', { broadcastId: row.broadcast_id });
      } catch (e) {
        const attempts = Number(row.attempts || 0) + 1;
        const message = String(e?.message || e);
        console.error(`WA queue: gagal kirim pesan #${row.id} (${row.message_type}) ke ${row.phone} [percobaan ${attempts}]: ${message}`);
        if (!e?.status && !e?.timeout) await reconcileGatewayStatus();
        const pauseKind = antiBan.classifyPauseError(e, connectionState);
        if (pauseKind) {
          // Auto-pause: pesan dikembalikan ke antrean (tidak hilang), seluruh antrean berhenti + alert admin.
          await db.execute(`UPDATE wa_messages SET status='queued',attempts=?,error_message=? WHERE id=?`, [attempts, `Antrean dijeda (${pauseKind}): ${message}`.slice(0, 500), row.id]);
          await antiBan.pauseQueue(pauseKind, message);
          if (pauseKind === 'disconnected') scheduleRecover(5000);
          break;
        }
        // Error sementara lain (5xx): jadwal ulang dengan backoff. Timeout TIDAK di-retry otomatis:
        // WAHA mungkin sudah mengirimnya (hindari pesan dobel ke pelanggan).
        if (e?.transient && !e?.timeout && attempts < MAX_SEND_ATTEMPTS) {
          const waitMinutes = Math.min(30, 2 ** (attempts - 1));
          await db.execute(`UPDATE wa_messages SET status='queued',attempts=?,next_attempt_at=DATE_ADD(NOW(),INTERVAL ? MINUTE),error_message=? WHERE id=?`,
            [attempts, waitMinutes, `Percobaan ${attempts} gagal, dicoba lagi ${waitMinutes} menit: ${message}`.slice(0, 500), row.id]);
        } else {
          const note = e?.timeout ? ' (timeout — cek HP apakah pesan sebenarnya terkirim sebelum retry)' : '';
          await db.execute(`UPDATE wa_messages SET status='failed',attempts=?,next_attempt_at=NULL,error_message=? WHERE id=?`, [attempts, `${message}${note}`.slice(0, 500), row.id]);
          await markChatMessage(row, { ack: 'failed', error: `${message}${note}`.slice(0, 500) });
        }
      }
      lastSendAt = Date.now();
      if (isBulk) bulkSinceLongPause++;
      if (isBulk && bulkSinceLongPause >= config.longPauseEvery) {
        bulkSinceLongPause = 0;
        const ms = antiBan.randomMs(config.longPauseMinSec, config.longPauseMaxSec);
        console.log(`WA anti-ban: long pause ${Math.round(ms / 1000)} dtk setelah ${config.longPauseEvery} pesan massal.`);
        await humanPause(ms, config);
      } else {
        await humanPause(antiBan.randomMs(config.minDelaySec, config.maxDelaySec), config);
      }
    }
  } catch (e) {
    console.error('WA queue: worker error:', e.message);
  } finally {
    processingLock = false;
  }
}

// Saat boot: pesan yang tertinggal 'processing' (app mati di tengah kirim) tidak dikirim ulang
// otomatis — statusnya tidak pasti, jadi ditandai gagal agar Admin bisa cek & retry manual.
async function recoverStaleProcessing() {
  try {
    const [r] = await db.execute(`UPDATE wa_messages SET status='failed',error_message='Status tidak pasti: aplikasi berhenti saat pesan sedang dikirim. Cek HP lalu Retry bila perlu.' WHERE status='processing'`);
    if (r.affectedRows) console.error(`WA queue: ${r.affectedRows} pesan 'processing' ditandai gagal saat startup.`);
  } catch (_) { /* kolom status lama belum punya 'processing' */ }
}

function getQueueNote() { return queueNote; }

async function getQueueStats() {
  const [[row]] = await db.query(`SELECT
    SUM(status='queued') queued,
    SUM(status='pending_approval') pending_approval,
    SUM(status='sent' AND DATE(created_at)=CURDATE()) sent_today,
    SUM(status='failed' AND DATE(created_at)=CURDATE()) failed_today,
    SUM(status='sent') sent_total,
    SUM(status='processing') processing
    FROM wa_messages`);
  return {
    queued: Number(row?.queued || 0),
    pendingApproval: Number(row?.pending_approval || 0),
    sentToday: Number(row?.sent_today || 0),
    failedToday: Number(row?.failed_today || 0),
    sentTotal: Number(row?.sent_total || 0),
    processing: Number(row?.processing || 0),
    queueNote,
    pause: antiBan.getPauseState(),
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

const DEFAULT_REMINDER_TEMPLATE = tpl.OFFICIAL_TEMPLATES.find(t => t.key === 'reminder').body;

// Render template pengingat. Mendukung variabel resmi ({nama_pelanggan}, {nama_bank}, ...), alias lama
// ({nama}, {kode}, {nominal}, {no_faktur}, {jatuh_tempo}, {periode}) dan Spintax {a|b}.
function renderReminderTemplate(template, invoice, bank = null) {
  return tpl.renderTemplate(template || DEFAULT_REMINDER_TEMPLATE, tpl.buildVars(invoice, bank));
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

  const bank = await tpl.getDefaultBank();
  const template = settingsRow.wa_auto_reminder_template || await tpl.getTemplate('reminder');
  const offsets = String(settingsRow.wa_auto_reminder_offsets || '-3,-1,0').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  let enqueued = 0, skippedNoWa = 0, skippedAlreadySent = 0;
  for (const offset of offsets) {
    const [invoices] = await db.query(
      `SELECT i.id invoice_id,i.invoice_number,i.outstanding,i.due_date,i.period_month,i.period_year,
              c.id customer_id,c.customer_code,c.name,c.phone,c.whatsapp_status,p.name package_name,p.speed_label
       FROM invoices i JOIN customers c ON c.id=i.customer_id LEFT JOIN packages p ON p.id=c.package_id
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
      const message = renderReminderTemplate(template, inv, bank);
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
  ensureGatewayAlive,
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
  getQueueNote,
};
