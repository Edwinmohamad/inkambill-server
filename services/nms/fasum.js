// Fasum (fasilitas umum) & exempt manual: tandai / lepas, laporan bulanan, dan alert offline.
// Secret Fasum tidak ditagih dan tidak ikut Smart Sync, tetapi tetap dipantau karena harus tetap hidup.
const db = require('../../config/db');
const cache = require('./cache');
const settings = require('./settings');
const { audit } = require('../auditService');

const TYPES = new Set(['fasum', 'admin', 'free']);
const TYPE_LABEL = { fasum: 'Fasum', admin: 'Admin', free: 'Gratis' };

/**
 * Tandai (type = fasum|admin|free) atau lepas tanda (type = null) untuk beberapa secret.
 * Selalu disimpan sebagai exempt_source='manual' sehingga tidak ditimpa deteksi otomatis.
 */
async function setExempt(secretIds, { type = 'fasum', note = null } = {}, ctx = {}) {
  const ids = [...new Set((Array.isArray(secretIds) ? secretIds : [secretIds]).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error('Pilih minimal satu secret.');
  if (ids.length > 500) throw new Error('Maksimal 500 secret sekaligus.');
  const t = type ? String(type).toLowerCase() : null;
  if (t && !TYPES.has(t)) throw new Error('Jenis exempt tidak dikenal.');
  const cleanNote = note == null ? null : String(note).trim().slice(0, 255) || null;
  const [rows] = await db.query(`SELECT p.id, p.site_id, p.username, p.customer_id, p.is_exempt, p.exempt_type, p.exempt_note, c.name customer_name
    FROM ppp_secrets p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id IN (?)`, [ids]);
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  const results = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) { results.push({ ok: false, secretId: id, error: 'PPP Secret tidak ditemukan.' }); continue; }
    if (t && r.customer_id) { results.push({ ok: false, secretId: id, username: r.username, error: `Terhubung ke pelanggan ${r.customer_name || '#' + r.customer_id}. Lepas link dulu.` }); continue; }
    const keepNote = cleanNote ?? (t ? r.exempt_note : null);
    await db.execute(`UPDATE ppp_secrets SET is_exempt=?, exempt_type=?, exempt_source='manual', exempt_note=?, exempt_at=NOW(), exempt_by=? WHERE id=?`,
      [t ? 1 : 0, t, keepNote, ctx.userId || null, id]);
    results.push({ ok: true, secretId: id, username: r.username, siteId: r.site_id, previous: r.is_exempt ? r.exempt_type : null });
  }
  const done = results.filter(r => r.ok);
  if (done.length) {
    await audit({ userId: ctx.userId || null, action: t ? `nms_exempt_${t}` : 'nms_exempt_clear', entityType: 'ppp_secret', entityId: done.length === 1 ? done[0].secretId : null, ip: ctx.ip || null, siteId: done[0].siteId || null,
      description: `${t ? `Tandai ${TYPE_LABEL[t]}` : 'Lepas tanda exempt'}: ${done.slice(0, 5).map(d => d.username).join(', ')}${done.length > 5 ? ` +${done.length - 5}` : ''}`,
      details: { type: t, note: cleanNote, secrets: done.map(d => ({ id: d.secretId, username: d.username, previous: d.previous })) } }).catch(() => {});
    cache.del('nms:dash');
  }
  return { summary: { total: ids.length, succeeded: done.length, failed: results.length - done.length }, results };
}

// ---------------------------------------------------------------- Laporan bulanan
const monthOf = m => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')) ? String(m) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date()));

/** Hitung durasi online (detik) dari urutan event login/logout dalam [start, end]. */
function onlineSeconds(events, { start, end, onlineNow }) {
  let total = 0, since = null;
  const s = start.getTime(), e = end.getTime();
  if (!events.length) return onlineNow ? Math.max(0, (e - s) / 1000) : 0;
  // Event pertama logout → sudah online sejak awal periode.
  if (events[0].type === 'logout') since = s;
  for (const ev of events) {
    const t = Math.min(e, Math.max(s, new Date(ev.at).getTime()));
    if (ev.type === 'login') { if (since == null) since = t; }
    else if (since != null) { total += t - since; since = null; }
  }
  if (since != null && onlineNow) total += e - since;
  return Math.max(0, Math.round(total / 1000));
}

async function report({ siteId = null, month = null } = {}) {
  const m = monthOf(month);
  const [[range]] = await db.query(`SELECT CAST(? AS DATETIME) start_at, LEAST(NOW(), DATE_ADD(CAST(? AS DATETIME), INTERVAL 1 MONTH)) end_at`, [`${m}-01 00:00:00`, `${m}-01 00:00:00`]);
  const start = new Date(range.start_at), end = new Date(range.end_at);
  const params = siteId ? [Number(siteId)] : [];
  const [rows] = await db.query(`SELECT p.id, p.site_id, s.code site_code, s.name site_name, p.router_id, r.name router_name, p.username, p.profile, p.comment, p.exempt_note, p.exempt_source,
      p.is_online, p.disabled, p.active_address, p.active_uptime, p.last_login_at, p.last_logout_at, p.exempt_at, u.name marked_by
    FROM ppp_secrets p JOIN sites s ON s.id=p.site_id JOIN routers r ON r.id=p.router_id LEFT JOIN users u ON u.id=p.exempt_by
    WHERE p.removed_on_router_at IS NULL AND p.customer_id IS NULL AND p.is_exempt=1 AND p.exempt_type='fasum' ${siteId ? 'AND p.site_id=?' : ''}
    ORDER BY s.code, p.username`, params);
  const events = new Map();
  if (rows.length && end > start) {
    const [ev] = await db.query(`SELECT router_id, LOWER(username) u, event_type type, occurred_at at FROM nms_ppp_events
      WHERE event_type IN ('login','logout') AND occurred_at >= ? AND occurred_at < ? AND router_id IN (?) AND LOWER(username) IN (?) ORDER BY occurred_at`,
    [start, end, [...new Set(rows.map(r => r.router_id))], [...new Set(rows.map(r => String(r.username).toLowerCase()))]]);
    ev.forEach(e => { const k = `${e.router_id}|${e.u}`; if (!events.has(k)) events.set(k, []); events.get(k).push(e); });
  }
  const periodSec = Math.max(1, (end - start) / 1000);
  const items = rows.map(r => {
    const ev = events.get(`${r.router_id}|${String(r.username).toLowerCase()}`) || [];
    const sec = onlineSeconds(ev, { start, end, onlineNow: !!Number(r.is_online) });
    return { id: r.id, siteId: r.site_id, siteCode: r.site_code, siteName: r.site_name, routerName: r.router_name, username: r.username, note: r.exempt_note || r.comment || '',
      source: r.exempt_source || 'auto', profile: r.profile, state: Number(r.disabled) ? 'disabled' : Number(r.is_online) ? 'online' : 'offline', address: r.active_address, uptime: r.active_uptime,
      lastLogin: r.last_login_at, lastLogout: r.last_logout_at, markedAt: r.exempt_at, markedBy: r.marked_by,
      logins: ev.filter(e => e.type === 'login').length, disconnects: ev.filter(e => e.type === 'logout').length,
      onlineHours: Math.round(sec / 360) / 10, availabilityPct: Math.min(100, Math.round(sec / periodSec * 1000) / 10) };
  });
  const sites = new Map();
  items.forEach(i => {
    const s = sites.get(i.siteId) || { siteId: i.siteId, siteCode: i.siteCode, siteName: i.siteName, count: 0, online: 0, offline: 0, onlineHours: 0, availabilitySum: 0 };
    s.count++; if (i.state === 'online') s.online++; else s.offline++;
    s.onlineHours += i.onlineHours; s.availabilitySum += i.availabilityPct;
    sites.set(i.siteId, s);
  });
  const bySite = [...sites.values()].map(({ availabilitySum, ...s }) => ({ ...s, onlineHours: Math.round(s.onlineHours * 10) / 10, availabilityPct: s.count ? Math.round(availabilitySum / s.count * 10) / 10 : 0 }));
  return { month: m, periodStart: start, periodEnd: end, periodHours: Math.round(periodSec / 360) / 10,
    totals: { count: items.length, online: items.filter(i => i.state === 'online').length, offline: items.filter(i => i.state !== 'online').length },
    bySite, items, note: 'Durasi online dihitung dari event login/logout yang tercatat NMS. Pemakaian data (GB) tidak tersedia karena router belum mengirim akuntansi traffic per sesi.' };
}

async function reportCsv(opts) {
  const rep = await report(opts);
  const esc = v => { const s = v == null ? '' : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : String(v); const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; return `"${safe.replace(/"/g, '""')}"`; };
  const head = ['bulan', 'site', 'router', 'username', 'catatan', 'status', 'jam_online', 'ketersediaan_pct', 'login', 'putus', 'login_terakhir', 'logout_terakhir', 'sumber_tanda', 'ditandai_oleh'];
  const lines = [head, ...rep.items.map(i => [rep.month, i.siteCode, i.routerName, i.username, i.note, i.state, i.onlineHours, i.availabilityPct, i.logins, i.disconnects, i.lastLogin, i.lastLogout, i.source, i.markedBy || ''])];
  return { name: `laporan-fasum-${rep.month}`, csv: '﻿' + lines.map(r => r.map(esc).join(',')).join('\n') };
}

module.exports = { setExempt, report, reportCsv, onlineSeconds, TYPES };
