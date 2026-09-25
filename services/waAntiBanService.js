// Engine Anti-Ban Multi-Layer untuk antrean WhatsApp (dipakai processQueue di whatsappGatewayService).
//  1. Jeda acak 5–15 dtk antar pesan + long pause 60–120 dtk tiap 20 pesan massal.
//  2. Spintax (lihat waTemplateService.spin) diterapkan saat pesan dirender.
//  3. Simulasi manusia: status "mengetik…" 2–4 dtk sebelum kirim; sendSeen sebelum membalas chat.
//  4. Pesan MASSAL hanya berjalan 08.00–17.00 WIB dan maksimal N pesan/jam; di luar itu tetap 'queued'.
//  5. Auto-pause + alert bila WAHA/WhatsApp membalas rate limit / unauthorized / sesi terputus.
//  6. Opt-out: nomor di wa_blacklist tidak menerima pesan massal.
const db = require('../config/db');

// Jenis pesan massal (kena jam kerja + kuota/jam + blacklist). Pesan transaksional/percakapan
// (balasan inbox, kirim manual, tanda terima, alert jaringan ke staf) tetap berjalan 24 jam.
const BULK_TYPES = ['broadcast', 'blast', 'auto_reminder', 'isolation_notice', 'outage_notice'];

const DEFAULTS = {
  minDelaySec: 5, maxDelaySec: 15,
  longPauseEvery: 20, longPauseMinSec: 60, longPauseMaxSec: 120,
  typingMinSec: 2, typingMaxSec: 4, simulateTyping: true, markReadBeforeReply: true,
  workStartHour: 8, workEndHour: 17, hourlyLimit: 80,
  optOutKeywords: ['STOP', 'BERHENTI', 'UNSUBSCRIBE', 'UNREG'],
};

let cache = null; let cacheUntil = 0;
let pauseState = { paused: false, kind: null, reason: null, at: null };

function clampNum(v, min, max, def) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  c.minDelaySec = clampNum(c.minDelaySec, 3, 120, DEFAULTS.minDelaySec);
  c.maxDelaySec = clampNum(c.maxDelaySec, c.minDelaySec, 300, DEFAULTS.maxDelaySec);
  c.longPauseEvery = clampNum(c.longPauseEvery, 5, 200, DEFAULTS.longPauseEvery);
  c.longPauseMinSec = clampNum(c.longPauseMinSec, 30, 900, DEFAULTS.longPauseMinSec);
  c.longPauseMaxSec = clampNum(c.longPauseMaxSec, c.longPauseMinSec, 1800, DEFAULTS.longPauseMaxSec);
  c.typingMinSec = clampNum(c.typingMinSec, 0, 10, DEFAULTS.typingMinSec);
  c.typingMaxSec = clampNum(c.typingMaxSec, c.typingMinSec, 15, DEFAULTS.typingMaxSec);
  c.workStartHour = clampNum(c.workStartHour, 0, 23, DEFAULTS.workStartHour);
  c.workEndHour = clampNum(c.workEndHour, c.workStartHour + 1, 24, DEFAULTS.workEndHour);
  c.hourlyLimit = clampNum(c.hourlyLimit, 10, 200, DEFAULTS.hourlyLimit);
  c.simulateTyping = c.simulateTyping !== false && c.simulateTyping !== '0';
  c.markReadBeforeReply = c.markReadBeforeReply !== false && c.markReadBeforeReply !== '0';
  const kw = Array.isArray(c.optOutKeywords) ? c.optOutKeywords : String(c.optOutKeywords || '').split(',');
  c.optOutKeywords = [...new Set(kw.map(k => String(k).trim().toUpperCase()).filter(Boolean))].slice(0, 20);
  if (!c.optOutKeywords.length) c.optOutKeywords = DEFAULTS.optOutKeywords;
  return c;
}

async function getConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() < cacheUntil) return cache;
  try {
    const [[row]] = await db.query(`SELECT wa_antiban_json,wa_queue_paused,wa_queue_paused_kind,wa_queue_paused_reason,wa_queue_paused_at FROM settings WHERE id=1 LIMIT 1`);
    let raw = {}; try { raw = row?.wa_antiban_json ? JSON.parse(row.wa_antiban_json) : {}; } catch (_) { raw = {}; }
    cache = normalizeConfig(raw);
    pauseState = { paused: !!Number(row?.wa_queue_paused), kind: row?.wa_queue_paused_kind || null, reason: row?.wa_queue_paused_reason || null, at: row?.wa_queue_paused_at || null };
  } catch (e) { cache = cache || normalizeConfig({}); }
  cacheUntil = Date.now() + 30000;
  return cache;
}

async function saveConfig(input = {}) {
  const c = normalizeConfig(input);
  await db.execute(`UPDATE settings SET wa_antiban_json=? WHERE id=1`, [JSON.stringify(c)]);
  cache = null; cacheUntil = 0;
  return getConfig({ fresh: true });
}

function jakartaHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(now));
}
function isWorkingHours(config, now = new Date()) {
  const h = jakartaHour(now);
  return h >= config.workStartHour && h < config.workEndHour;
}

async function bulkSentLastHour() {
  const [[row]] = await db.query(`SELECT COUNT(*) n FROM wa_messages WHERE status='sent' AND sent_at>=DATE_SUB(NOW(),INTERVAL 1 HOUR) AND message_type IN (${BULK_TYPES.map(() => '?').join(',')})`, BULK_TYPES);
  return Number(row?.n || 0);
}

// Apakah pesan massal boleh jalan sekarang? {allowed, reason}
async function bulkGate(config, now = new Date()) {
  if (!isWorkingHours(config, now)) return { allowed: false, reason: `Di luar jam operasional ${String(config.workStartHour).padStart(2, '0')}.00–${String(config.workEndHour).padStart(2, '0')}.00 WIB — pesan massal menunggu jam kerja berikutnya.` };
  const sent = await bulkSentLastHour();
  if (sent >= config.hourlyLimit) return { allowed: false, reason: `Kuota ${config.hourlyLimit} pesan massal/jam tercapai — dilanjutkan otomatis.`, sent };
  return { allowed: true, sent };
}

async function isBlacklisted(phone) {
  if (!phone) return false;
  const [rows] = await db.execute(`SELECT phone FROM wa_blacklist WHERE phone=? LIMIT 1`, [String(phone)]);
  return !!rows.length;
}

function randomMs(minSec, maxSec) { return Math.round((minSec + Math.random() * (maxSec - minSec)) * 1000); }

// Klasifikasi error dari WAHA → alasan auto-pause (null = bukan kondisi pause).
function classifyPauseError(err, connectionState = 'connected') {
  const msg = String(err?.message || err || '');
  const status = Number(err?.status || 0);
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid api key/i.test(msg)) return 'unauthorized';
  if (status === 429 || /rate.?limit|too many|spam|banned|blocked|restricted/i.test(msg)) return 'rate_limit';
  if (connectionState !== 'connected') return 'disconnected';
  if (err?.transient && !status && !err?.timeout) return 'disconnected';
  if ((status === 409 || status === 422) && /session|not working|starting|stopped|failed|scan_qr|disconnect/i.test(msg)) return 'disconnected';
  return null;
}
const PAUSE_LABEL = { unauthorized: 'Unauthorized (API key / sesi WAHA ditolak)', rate_limit: 'Rate limit / indikasi pembatasan dari WhatsApp', disconnected: 'Koneksi WhatsApp terputus', manual: 'Dijeda manual oleh Admin' };

async function notifyAdmins(title, detail, tone = 'danger') {
  try {
    const [admins] = await db.query(`SELECT id FROM users WHERE is_active=1 AND role IN ('master_admin','admin')`);
    for (const a of admins) {
      await db.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type) VALUES(?,?,?,?,?,?,?,?)`,
        [a.id, 'wa_queue_alert', tone, 'bi-whatsapp', title.slice(0, 180), String(detail || '').slice(0, 700), '/wa-gateway#antiban', 'wa_queue']);
    }
  } catch (e) { console.error('WA anti-ban: gagal membuat notifikasi admin:', e.message); }
}

async function pauseQueue(kind, reason, { notify = true } = {}) {
  const already = pauseState.paused && pauseState.kind === kind;
  pauseState = { paused: true, kind, reason: String(reason || '').slice(0, 500), at: new Date() };
  try { await db.execute(`UPDATE settings SET wa_queue_paused=1,wa_queue_paused_kind=?,wa_queue_paused_reason=?,wa_queue_paused_at=NOW() WHERE id=1`, [kind, pauseState.reason]); }
  catch (e) { console.error('WA anti-ban: gagal menyimpan status pause:', e.message); }
  console.error(`WA anti-ban: ANTREAN DIJEDA (${kind}) — ${pauseState.reason}`);
  if (notify && !already) await notifyAdmins(`Antrean WhatsApp dijeda: ${PAUSE_LABEL[kind] || kind}`, `${pauseState.reason}${kind === 'disconnected' ? ' Antrean lanjut otomatis setelah WhatsApp terhubung kembali.' : ' Periksa WAHA lalu lanjutkan antrean di WA Gateway → Anti-Ban.'}`);
  try { require('./waRealtime').emit('queue.paused', { ...pauseState, label: PAUSE_LABEL[kind] || kind }); } catch (_) {}
  return pauseState;
}

async function resumeQueue(by = 'manual') {
  pauseState = { paused: false, kind: null, reason: null, at: null };
  try { await db.execute(`UPDATE settings SET wa_queue_paused=0,wa_queue_paused_kind=NULL,wa_queue_paused_reason=NULL,wa_queue_paused_at=NULL WHERE id=1`); }
  catch (e) { console.error('WA anti-ban: gagal menyimpan status resume:', e.message); }
  console.log(`WA anti-ban: antrean dilanjutkan (${by}).`);
  try { require('./waRealtime').emit('queue.resumed', { by }); } catch (_) {}
  return pauseState;
}

function getPauseState() { return { ...pauseState, label: pauseState.kind ? (PAUSE_LABEL[pauseState.kind] || pauseState.kind) : null }; }

function isOptOutText(text, config) {
  const t = String(text || '').trim().toUpperCase().replace(/[.!?\s]+$/g, '');
  return !!t && (config?.optOutKeywords || DEFAULTS.optOutKeywords).includes(t);
}

async function addToBlacklist(phone, { customerId = null, reason = 'Opt-out via balasan', source = 'keyword', userId = null } = {}) {
  if (!phone) return false;
  await db.execute(`INSERT INTO wa_blacklist(phone,customer_id,reason,source,created_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE reason=VALUES(reason),source=VALUES(source)`,
    [String(phone), customerId, String(reason).slice(0, 255), source, userId]);
  // Pesan massal yang masih antre untuk nomor ini langsung dibatalkan.
  await db.execute(`UPDATE wa_messages SET status='cancelled',error_message='Dibatalkan: nomor opt-out (blacklist broadcast).' WHERE phone=? AND status IN ('queued','pending_approval') AND message_type IN (${BULK_TYPES.map(() => '?').join(',')})`, [String(phone), ...BULK_TYPES]);
  return true;
}
async function removeFromBlacklist(phone) { await db.execute(`DELETE FROM wa_blacklist WHERE phone=?`, [String(phone)]); }

module.exports = {
  BULK_TYPES, DEFAULTS, PAUSE_LABEL, normalizeConfig, getConfig, saveConfig, isWorkingHours, jakartaHour, bulkGate, bulkSentLastHour,
  isBlacklisted, randomMs, classifyPauseError, pauseQueue, resumeQueue, getPauseState, notifyAdmins,
  isOptOutText, addToBlacklist, removeFromBlacklist,
};
