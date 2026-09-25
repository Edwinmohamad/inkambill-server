// Pengaturan modul NMS (key/value di tabel nms_settings). Nilai default dipakai bila baris belum ada,
// sehingga instalasi lama tetap berperilaku sama sampai Admin mengubahnya dari halaman Otomasi.
const db = require('../../config/db');
const cache = require('./cache');

const DEFAULTS = {
  auto_sync_enabled: '0',          // Smart Sync otomatis tiap jam
  auto_sync_commit: '0',           // 1 = pasangan keyakinan tinggi langsung di-link; 0 = hanya notifikasi
  auto_sync_notify: '1',           // kirim WA ke nomor NOC saat ada secret baru belum ter-link
  summary_enabled: '0',            // ringkasan pagi via WA
  summary_hour: '7',               // jam kirim ringkasan (WIB)
  summary_numbers: '',             // kosong → pakai settings.network_alert_wa_numbers
  approval_threshold: '20',        // aksi masal > N target butuh persetujuan admin kedua (0 = nonaktif)
  isolate_hour: '0',               // jam isolir otomatis harian (WIB)
  flap_ticket_threshold: '10',     // reconnect/jam yang dianggap layak dibuatkan tiket
  shared_mac_threshold: '3',       // >= N MAC berbeda per secret dalam 24 jam → curiga dipakai bersama
  last_summary_date: '',
  last_isolate_date: '',
  last_auto_sync_at: ''
};
const PUBLIC_KEYS = Object.keys(DEFAULTS).filter(k => !k.startsWith('last_'));

async function all() {
  return cache.wrap('nms:settings', 30000, async () => {
    const out = { ...DEFAULTS };
    try { const [rows] = await db.query(`SELECT k, v FROM nms_settings`); rows.forEach(r => { if (r.k in out) out[r.k] = r.v ?? ''; }); } catch (_) {}
    return out;
  });
}
async function get(key) { return (await all())[key]; }
async function num(key) { const n = Number(await get(key)); return Number.isFinite(n) ? n : Number(DEFAULTS[key]) || 0; }
async function flag(key) { return String(await get(key)) === '1'; }
async function set(values, userId = null) {
  const entries = Object.entries(values || {}).filter(([k]) => k in DEFAULTS);
  for (const [k, v] of entries) {
    await db.execute(`INSERT INTO nms_settings (k, v, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE v=VALUES(v), updated_by=VALUES(updated_by)`, [k, String(v ?? '').slice(0, 2000), userId]);
  }
  cache.del('nms:settings');
  return all();
}
function sanitize(body = {}) {
  const b = {}, bool = v => (v === true || v === '1' || v === 'on' || v === 1) ? '1' : '0';
  const int = (v, min, max) => String(Math.max(min, Math.min(max, Math.round(Number(v) || 0))));
  if ('auto_sync_enabled' in body) b.auto_sync_enabled = bool(body.auto_sync_enabled);
  if ('auto_sync_commit' in body) b.auto_sync_commit = bool(body.auto_sync_commit);
  if ('auto_sync_notify' in body) b.auto_sync_notify = bool(body.auto_sync_notify);
  if ('summary_enabled' in body) b.summary_enabled = bool(body.summary_enabled);
  if ('summary_hour' in body) b.summary_hour = int(body.summary_hour, 0, 23);
  if ('isolate_hour' in body) b.isolate_hour = int(body.isolate_hour, 0, 23);
  if ('approval_threshold' in body) b.approval_threshold = int(body.approval_threshold, 0, 500);
  if ('flap_ticket_threshold' in body) b.flap_ticket_threshold = int(body.flap_ticket_threshold, 3, 500);
  if ('shared_mac_threshold' in body) b.shared_mac_threshold = int(body.shared_mac_threshold, 2, 50);
  if ('summary_numbers' in body) b.summary_numbers = String(body.summary_numbers || '').split(/[,;\n]+/).map(x => x.replace(/[^0-9+]/g, '')).filter(x => x.replace(/\D/g, '').length >= 9).slice(0, 10).join(',');
  return b;
}
async function summaryNumbers() {
  const own = String(await get('summary_numbers') || '').trim();
  if (own) return own.split(',').filter(Boolean);
  try { const [[row]] = await db.query(`SELECT network_alert_wa_numbers FROM settings WHERE id=1`); return String(row?.network_alert_wa_numbers || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 10); }
  catch (_) { return []; }
}

module.exports = { DEFAULTS, PUBLIC_KEYS, all, get, num, flag, set, sanitize, summaryNumbers };
