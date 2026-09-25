// Pure helpers: parsing RouterOS values, deteksi login/logout, FO-cut & flapping.

function uptimeSeconds(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 0;
  let total = 0;
  for (const m of text.matchAll(/(\d+)\s*(w|d|h|m(?!s)|s)/g)) total += Number(m[1]) * ({ w: 604800, d: 86400, h: 3600, m: 60, s: 1 })[m[2]];
  const clock = text.match(/(\d+):(\d{2}):(\d{2})$/);
  if (clock && !total) total = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return total;
}

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// RouterOS rtt: "1ms234us", "12ms", "850us", "00:00:00.012", "12.3ms".
function rttMs(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const clock = text.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (clock) return (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000;
  let ms = 0, matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|us|s)/g)) { matched = true; ms += Number(m[1]) * ({ s: 1000, ms: 1, us: 0.001 })[m[2]]; }
  if (matched) return Math.round(ms * 100) / 100;
  const n = Number(text); return Number.isFinite(n) ? n : null;
}

// Ringkas hasil POST /ping (array per-paket; baris terakhir memuat summary).
function summarizePing(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const last = [...list].reverse().find(r => r && r.sent !== undefined) || {};
  const sent = Number(last.sent ?? list.length) || 0;
  const received = Number(last.received ?? list.filter(r => r && r.time && !r.status).length) || 0;
  const times = list.filter(r => r && r.time && !r.status).map(r => rttMs(r.time)).filter(v => v != null);
  const avg = rttMs(last['avg-rtt']) ?? (times.length ? times.reduce((a, b) => a + b, 0) / times.length : null);
  const loss = last['packet-loss'] !== undefined ? Number(last['packet-loss']) : (sent ? Math.round((1 - received / sent) * 100) : 100);
  return { sent, received, lossPct: Number.isFinite(loss) ? loss : 100, avgMs: avg == null ? null : Math.round(avg * 100) / 100, minMs: rttMs(last['min-rtt']), maxMs: rttMs(last['max-rtt']) };
}

// Normalisasi /system/health (v6: objek, v7: array {name,value,type}).
function normalizeHealth(raw) {
  if (!raw) return { temperature: null, voltage: null };
  const rows = Array.isArray(raw) ? raw : [raw];
  const out = { temperature: null, voltage: null };
  for (const r of rows) {
    if (r && r.name !== undefined && r.value !== undefined) {
      const name = String(r.name);
      if (out.temperature == null && /temperature/.test(name)) out.temperature = Number(r.value);
      if (out.voltage == null && /^voltage$|psu\d*-voltage/.test(name)) out.voltage = Number(r.value);
    } else if (r) {
      if (r.temperature !== undefined) out.temperature = Number(r.temperature);
      else if (r['cpu-temperature'] !== undefined) out.temperature = Number(r['cpu-temperature']);
      if (r.voltage !== undefined) out.voltage = Number(r.voltage);
    }
  }
  if (!Number.isFinite(out.temperature)) out.temperature = null;
  if (!Number.isFinite(out.voltage)) out.voltage = null;
  return out;
}

function sessionKey(row) { return `${String(row.name || '').toLowerCase()}|${row['session-id'] || row['.id'] || row.address || ''}`; }

// Bandingkan dua snapshot /ppp/active → daftar login & logout.
function diffActive(previous, current) {
  const prev = new Map((previous || []).map(r => [sessionKey(r), r]));
  const curr = new Map((current || []).map(r => [sessionKey(r), r]));
  const logins = [...curr].filter(([k]) => !prev.has(k)).map(([, r]) => r);
  const logouts = [...prev].filter(([k]) => !curr.has(k)).map(([, r]) => r);
  // Reconnect cepat (session baru utk user yg sama) tetap tercatat sbg logout+login — sesuai
  // kebutuhan flapping detection.
  return { logins, logouts };
}

/**
 * FO Cut / Power Outage: >threshold pelanggan berbeda di satu site logout dalam windowMs
 * dan saat ini belum kembali online.
 * @param {Array} logouts [{siteId, username, at:ms}]
 * @param {Set} onlineNow set username (lowercase) yang saat ini online
 */
function detectMassDisconnect(logouts, onlineNow, { now = Date.now(), windowMs = 120000, threshold = 10 } = {}) {
  const bySite = new Map();
  for (const e of logouts) {
    if (now - e.at > windowMs) continue;
    const u = String(e.username || '').toLowerCase();
    if (!u || onlineNow.has(u)) continue;
    const set = bySite.get(e.siteId) || new Set();
    set.add(u); bySite.set(e.siteId, set);
  }
  return [...bySite].filter(([, set]) => set.size > threshold).map(([siteId, set]) => ({ siteId, count: set.size, usernames: [...set].slice(0, 200) }));
}

// Flapping: login > threshold kali dalam windowMs.
function detectFlapping(logins, { now = Date.now(), windowMs = 3600000, threshold = 5 } = {}) {
  const counts = new Map();
  for (const e of logins) {
    if (now - e.at > windowMs) continue;
    const k = `${e.siteId}|${String(e.username).toLowerCase()}`;
    const row = counts.get(k) || { siteId: e.siteId, username: e.username, count: 0, lastAt: 0 };
    row.count++; row.lastAt = Math.max(row.lastAt, e.at); counts.set(k, row);
  }
  return [...counts.values()].filter(r => r.count > threshold).sort((a, b) => b.count - a.count);
}

function loadTone(pct) { return pct == null ? 'unknown' : pct > 80 ? 'red' : pct >= 60 ? 'yellow' : 'green'; }

module.exports = { uptimeSeconds, formatUptime, rttMs, summarizePing, normalizeHealth, diffActive, detectMassDisconnect, detectFlapping, loadTone, sessionKey };
