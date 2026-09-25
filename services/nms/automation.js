// Otomasi NMS: aksi terjadwal (isolir/buka/kick/ganti profile/ganti paket), persetujuan dua orang
// untuk aksi masal besar, tunda isolir (janji bayar), isolir harian di jam tertentu, provisioning
// secret ↔ pelanggan, traffic live, snapshot + diff konfigurasi PPP, auto Smart Sync & ringkasan pagi.
const crypto = require('crypto');
const db = require('../../config/db');
const ros = require('./rosApi');
const store = require('./secretStore');
const control = require('./control');
const settings = require('./settings');
const cache = require('./cache');
const bus = require('./eventBus');
const { audit } = require('../auditService');

const jakartaDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const jakartaHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(d));
const ACTIONS = new Set(['isolate', 'unisolate', 'kick', 'profile', 'package']);
const parseIds = v => { try { return JSON.parse(v || '[]').map(Number).filter(Boolean); } catch (_) { return []; } };

// ---------------------------------------------------------------- Aksi terjadwal
async function schedule({ action, secretIds, runAt, profile = null, packageId = null, note = null, siteId = null }, ctx = {}) {
  if (!ACTIONS.has(action)) throw new Error('Aksi terjadwal tidak dikenal.');
  const ids = [...new Set((secretIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error('Pilih minimal 1 secret.');
  if (ids.length > 500) throw new Error('Maksimal 500 secret per jadwal.');
  const when = new Date(runAt);
  if (Number.isNaN(when.getTime())) throw new Error('Waktu jadwal tidak valid.');
  if (when.getTime() < Date.now() - 60000) throw new Error('Waktu jadwal sudah lewat.');
  if (action === 'profile' && !profile) throw new Error('Profile tujuan wajib diisi.');
  let pkg = null;
  if (action === 'package') {
    [[pkg]] = await db.query(`SELECT id, name, mikrotik_profile FROM packages WHERE id=?`, [packageId]);
    if (!pkg) throw new Error('Paket tujuan tidak ditemukan.');
  }
  const [res] = await db.execute(`INSERT INTO nms_scheduled_actions (action, secret_ids, profile, package_id, run_at, note, site_id, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [action, JSON.stringify(ids), action === 'package' ? (pkg.mikrotik_profile || null) : profile, pkg?.id || null, when, note ? String(note).slice(0, 255) : null, siteId || null, ctx.userId || null]);
  await audit({ userId: ctx.userId, action: 'nms_schedule', entityType: 'nms_schedule', entityId: res.insertId, siteId, ip: ctx.ip, description: `Jadwalkan ${action} untuk ${ids.length} secret pada ${when.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`, details: { action, ids, profile, packageId } });
  return { id: res.insertId, count: ids.length, runAt: when.toISOString() };
}

async function listScheduled({ status = null, limit = 60 } = {}) {
  const where = status ? 'WHERE a.status=?' : '';
  const [rows] = await db.query(`SELECT a.*, u.name created_by_name, pk.name package_name, s.code site_code FROM nms_scheduled_actions a LEFT JOIN users u ON u.id=a.created_by LEFT JOIN packages pk ON pk.id=a.package_id LEFT JOIN sites s ON s.id=a.site_id
    ${where} ORDER BY (a.status='pending') DESC, a.run_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ?`, status ? [status, limit] : [limit]);
  const all = [...new Set(rows.flatMap(r => parseIds(r.secret_ids)))];
  const names = new Map();
  if (all.length) { const [n] = await db.query(`SELECT p.id, p.username, c.name customer_name FROM ppp_secrets p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id IN (?)`, [all.slice(0, 3000)]); n.forEach(x => names.set(Number(x.id), x.customer_name || x.username)); }
  return rows.map(r => { const ids = parseIds(r.secret_ids); let result = null; try { result = JSON.parse(r.result_json || 'null'); } catch (_) {} return { ...r, secret_ids: ids, count: ids.length, targets: ids.slice(0, 6).map(id => names.get(id) || `#${id}`), result }; });
}

async function cancelScheduled(id, ctx = {}) {
  const [res] = await db.execute(`UPDATE nms_scheduled_actions SET status='cancelled', finished_at=NOW() WHERE id=? AND status='pending'`, [id]);
  if (!res.affectedRows) throw new Error('Jadwal sudah berjalan / tidak ditemukan.');
  await audit({ userId: ctx.userId, action: 'nms_schedule_cancel', entityType: 'nms_schedule', entityId: Number(id), ip: ctx.ip, description: `Batalkan jadwal #${id}` });
  return { id: Number(id) };
}

async function changePackage(secretId, packageId, ctx) {
  const secret = await store.secretById(secretId);
  if (!secret.customer_id) throw new Error('Secret belum terikat pelanggan.');
  const [[pkg]] = await db.query(`SELECT id, name, mikrotik_profile FROM packages WHERE id=?`, [packageId]);
  if (!pkg) throw new Error('Paket tidak ditemukan.');
  await db.execute(`UPDATE customers SET package_id=? WHERE id=?`, [pkg.id, secret.customer_id]);
  let profile = null;
  if (pkg.mikrotik_profile) profile = (await control.changeProfile(secretId, pkg.mikrotik_profile, ctx)).to;
  await audit({ userId: ctx.userId, action: 'nms_package_change', entityType: 'ppp_secret', entityId: secret.id, siteId: secret.site_id, description: `Paket ${secret.username} → ${pkg.name}`, details: { packageId: pkg.id, profile, source: ctx.source } });
  return { secretId: secret.id, packageId: pkg.id, packageName: pkg.name, profile };
}

async function runOne(action, id, row, ctx) {
  if (action === 'isolate') return control.isolate(id, { ...ctx, reason: 'scheduled' });
  if (action === 'unisolate') return control.unisolate(id, ctx);
  if (action === 'kick') return control.kick(id, ctx);
  if (action === 'profile') return control.changeProfile(id, row.profile, ctx);
  if (action === 'package') return changePackage(id, row.package_id, ctx);
  throw new Error('Aksi tidak dikenal');
}

async function runDue() {
  const [due] = await db.query(`SELECT * FROM nms_scheduled_actions WHERE status='pending' AND run_at <= NOW() ORDER BY run_at LIMIT 5`);
  const done = [];
  for (const row of due) {
    const [lock] = await db.execute(`UPDATE nms_scheduled_actions SET status='running' WHERE id=? AND status='pending'`, [row.id]);
    if (!lock.affectedRows) continue;
    const ids = parseIds(row.secret_ids);
    const results = [];
    const ctx = { userId: row.created_by, source: 'scheduled', bulkId: `sched-${row.id}` };
    for (const id of ids) {
      try { await runOne(row.action, id, row, ctx); results.push({ ok: true, secretId: id }); }
      catch (err) { results.push({ ok: false, secretId: id, error: err.message }); }
    }
    const failed = results.filter(r => !r.ok).length;
    await db.execute(`UPDATE nms_scheduled_actions SET status=?, finished_at=NOW(), result_json=? WHERE id=?`, [failed === results.length && results.length ? 'failed' : 'done', JSON.stringify({ total: results.length, failed, errors: results.filter(r => !r.ok).slice(0, 20) }), row.id]);
    bus.emit('sync', { siteId: row.site_id, scheduled: row.id });
    done.push({ id: row.id, total: results.length, failed });
  }
  if (done.length) cache.del('nms:dash');
  return done;
}

// ---------------------------------------------------------------- Persetujuan dua orang
async function needsApproval(count) {
  const threshold = await settings.num('approval_threshold');
  return threshold > 0 && count > threshold ? threshold : 0;
}

async function requestApproval({ action, payload, count, summary, siteId }, ctx) {
  const [res] = await db.execute(`INSERT INTO nms_approvals (action, payload_json, target_count, summary, requested_by, site_id) VALUES (?,?,?,?,?,?)`,
    [action, JSON.stringify(payload), count, String(summary || '').slice(0, 255), ctx.userId || null, siteId || null]);
  await audit({ userId: ctx.userId, action: 'nms_approval_request', entityType: 'nms_approval', entityId: res.insertId, siteId, ip: ctx.ip, description: `Minta persetujuan: ${summary}` });
  bus.emit('approval', { id: res.insertId, action, count, summary, siteId });
  return { id: res.insertId };
}

async function listApprovals({ limit = 40 } = {}) {
  await db.execute(`UPDATE nms_approvals SET status='expired' WHERE status='pending' AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`).catch(() => {});
  const [rows] = await db.query(`SELECT a.*, u.name requested_by_name, u2.name decided_by_name FROM nms_approvals a LEFT JOIN users u ON u.id=a.requested_by LEFT JOIN users u2 ON u2.id=a.decided_by ORDER BY (a.status='pending') DESC, a.id DESC LIMIT ?`, [limit]);
  return rows.map(r => { let result = null; try { result = JSON.parse(r.result_json || 'null'); } catch (_) {} const { payload_json, ...rest } = r; return { ...rest, result }; });
}

async function decideApproval(id, approve, ctx) {
  const [[a]] = await db.query(`SELECT * FROM nms_approvals WHERE id=?`, [id]);
  if (!a) throw Object.assign(new Error('Permintaan tidak ditemukan.'), { status: 404 });
  if (a.status !== 'pending') throw new Error(`Permintaan sudah ${a.status}.`);
  if (approve && a.requested_by && Number(a.requested_by) === Number(ctx.userId)) throw Object.assign(new Error('Persetujuan harus dari admin lain, bukan yang mengajukan.'), { status: 403 });
  const [lock] = await db.execute(`UPDATE nms_approvals SET status=?, decided_by=?, decided_at=NOW() WHERE id=? AND status='pending'`, [approve ? 'approved' : 'rejected', ctx.userId, id]);
  if (!lock.affectedRows) throw new Error('Permintaan sudah diproses.');
  await audit({ userId: ctx.userId, action: approve ? 'nms_approval_approve' : 'nms_approval_reject', entityType: 'nms_approval', entityId: Number(id), ip: ctx.ip, description: `${approve ? 'Setujui' : 'Tolak'}: ${a.summary}` });
  if (!approve) return { id: Number(id), status: 'rejected' };
  const payload = JSON.parse(a.payload_json);
  try {
    const out = await control.bulk({ ...payload, dryRun: false }, { ...ctx, source: 'approved' });
    await db.execute(`UPDATE nms_approvals SET result_json=? WHERE id=?`, [JSON.stringify(out.summary), id]);
    return { id: Number(id), status: 'approved', ...out };
  } catch (err) {
    await db.execute(`UPDATE nms_approvals SET status='failed', result_json=? WHERE id=?`, [JSON.stringify({ error: err.message }), id]);
    throw err;
  }
}

// ---------------------------------------------------------------- Tunda isolir (janji bayar)
async function setHold({ secretId, customerId, until, note }, ctx = {}) {
  let cid = Number(customerId) || null;
  if (!cid && secretId) cid = (await store.secretById(secretId)).customer_id;
  if (!cid) throw new Error('Secret belum terikat pelanggan.');
  const date = until ? String(until).slice(0, 10) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Tanggal tidak valid.');
  if (date && date < jakartaDate()) throw new Error('Tanggal janji bayar sudah lewat.');
  await db.execute(`UPDATE customers SET isolate_hold_until=?, isolate_hold_note=? WHERE id=?`, [date, date ? (String(note || '').slice(0, 255) || null) : null, cid]);
  await audit({ userId: ctx.userId, action: date ? 'nms_isolate_hold' : 'nms_isolate_hold_clear', entityType: 'customer', entityId: cid, ip: ctx.ip, description: date ? `Tunda isolir s.d. ${date}${note ? ` · ${note}` : ''}` : 'Hapus tunda isolir' });
  return { customerId: cid, until: date };
}

/** Isolir otomatis harian di jam yang diatur (default 00, sama seperti sebelumnya). */
async function maybeRunDailyIsolation() {
  const hour = await settings.num('isolate_hour');
  const today = jakartaDate();
  if (jakartaHour() < hour || (await settings.get('last_isolate_date')) === today) return { ran: false };
  await settings.set({ last_isolate_date: today });
  const { runAutoIsolation } = require('../networkService');
  return { ran: true, ...(await runAutoIsolation()) };
}

// ---------------------------------------------------------------- Provisioning
const randomPassword = () => { const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(8), b => abc[b % abc.length]).join(''); };
const slugUser = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9.\-_@]+/g, '').slice(0, 64);

async function createSecretForCustomer({ customerId, routerId = null, username = null, password = null, profile = null, notifyPhone = null }, ctx = {}) {
  const [[c]] = await db.query(`SELECT c.*, pk.mikrotik_profile FROM customers c LEFT JOIN packages pk ON pk.id=c.package_id WHERE c.id=? AND c.archived_at IS NULL`, [customerId]);
  if (!c) throw Object.assign(new Error('Pelanggan tidak ditemukan.'), { status: 404 });
  const [[taken]] = await db.query(`SELECT username FROM ppp_secrets WHERE customer_id=? AND removed_on_router_at IS NULL LIMIT 1`, [c.id]);
  if (taken) throw new Error(`${c.name} sudah punya secret ${taken.username}.`);
  let router = null;
  if (routerId) router = await store.routerById(routerId);
  else if (c.router_id) router = await store.routerById(c.router_id).catch(() => null);
  if (!router) router = (await store.activeRouters(c.site_id))[0];
  if (!router) throw new Error('Tidak ada router aktif di site pelanggan.');
  if (Number(router.site_id) !== Number(c.site_id)) throw new Error('Router harus di site yang sama dengan pelanggan.');
  const user = slugUser(username || c.customer_code);
  if (!user) throw new Error('Username tidak valid.');
  const pass = String(password || '').trim() || randomPassword();
  const prof = String(profile || c.mikrotik_profile || control.DEFAULT_PROFILE).trim();
  if (!(await control.routerHasProfile(router, prof))) throw new Error(`Profile ${prof} tidak ada di router ${router.name}.`);
  if (await ros.secretByName(router, user)) throw new Error(`Username ${user} sudah ada di router ${router.name}.`);
  const { withCid } = require('./matching');
  const comment = (await settings.flag('cid_tag_enabled')) ? withCid(`${c.name}`.slice(0, 120), c.customer_code) : `${c.customer_code} ${c.name}`.slice(0, 120);
  const created = await ros.createSecret(router, { name: user, password: pass, service: 'pppoe', profile: prof, comment });
  const { encrypt } = require('../cryptoService');
  await db.execute(`INSERT INTO ppp_secrets (site_id, router_id, ros_id, username, password_enc, profile, service, comment, last_seen_on_router_at) VALUES (?,?,?,?,?,?,?,?,NOW())
    ON DUPLICATE KEY UPDATE ros_id=VALUES(ros_id), password_enc=VALUES(password_enc), profile=VALUES(profile), removed_on_router_at=NULL, last_seen_on_router_at=NOW()`,
  [router.site_id, router.id, created?.['.id'] || null, user, encrypt(pass), prof, 'pppoe', comment.slice(0, 255)]);
  const [[row]] = await db.query(`SELECT id FROM ppp_secrets WHERE router_id=? AND username=?`, [router.id, user]);
  const smartSync = require('./smartSync');
  await smartSync.manualMap(row.id, c.id, 'created');
  await control.recordEvent({ id: row.id, router_id: router.id, site_id: router.site_id, username: user, customer_id: c.id }, 'create', `Secret dibuat (profile ${prof})`);
  await audit({ userId: ctx.userId, action: 'nms_create_secret', entityType: 'ppp_secret', entityId: row.id, siteId: router.site_id, ip: ctx.ip, description: `Buat secret ${user} untuk ${c.customer_code} ${c.name}`, details: { router: router.name, profile: prof } });
  let notified = false;
  if (notifyPhone) {
    const { enqueueWaMessage } = require('../whatsappGatewayService');
    await enqueueWaMessage({ phone: notifyPhone, message: `*Akun PPPoE baru*\nPelanggan: ${c.name} (${c.customer_code})\nUsername: ${user}\nPassword: ${pass}\nProfile: ${prof}\nRouter: ${router.name}`, type: 'manual', userId: ctx.userId, customerId: c.id });
    notified = true;
  }
  cache.del('nms:dash');
  return { secretId: row.id, username: user, password: pass, profile: prof, router: router.name, notified };
}

async function createCustomerFromSecret({ secretId, name, phone = null, packageId, dueDay = null, address = null }, ctx = {}) {
  const secret = await store.secretById(secretId);
  if (secret.customer_id) throw new Error('Secret ini sudah terikat pelanggan.');
  const cleanName = String(name || '').trim().slice(0, 150);
  if (!cleanName) throw new Error('Nama pelanggan wajib diisi.');
  const [[pkg]] = await db.query(`SELECT id, site_id FROM packages WHERE id=? AND is_active=1`, [packageId]);
  if (!pkg || (pkg.site_id != null && Number(pkg.site_id) !== Number(secret.site_id))) throw new Error('Paket tidak sesuai dengan site secret.');
  const [[site]] = await db.query(`SELECT s.code, COALESCE(s.default_due_day, st.default_due_day, 15) due FROM sites s CROSS JOIN settings st WHERE s.id=? AND st.id=1`, [secret.site_id]);
  const due = Math.max(1, Math.min(28, Number(dueDay) || Number(site.due) || 15));
  const prefix = `${String(site.code).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${String(due).padStart(2, '0')}-`;
  const conn = await db.getConnection();
  let customerId, code;
  try {
    await conn.beginTransaction();
    const [[seqRow]] = await conn.execute(`SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(customer_code,'-',-1) AS UNSIGNED)),0) seq FROM customers WHERE customer_code LIKE ? FOR UPDATE`, [`${prefix}%`]);
    let seq = Number(seqRow.seq || 0) + 1;
    for (;;) { code = `${prefix}${String(seq).padStart(3, '0')}`; const [ex] = await conn.execute(`SELECT id FROM customers WHERE customer_code=? LIMIT 1`, [code]); if (!ex.length) break; seq++; }
    const { validateWhatsapp } = require('../whatsappService');
    const wa = validateWhatsapp(phone || '');
    const email = `${code.toLowerCase().replace(/[^a-z0-9]+/g, '')}@customer.inkamnet.local`;
    const [ins] = await conn.execute(`INSERT INTO customers (customer_code,name,phone,whatsapp_status,whatsapp_normalized,whatsapp_verified_at,email,address,site_id,router_id,package_id,pppoe_username,activation_date,due_day,customer_status,billing_status,network_status,status_changed_at,customer_source,notes)
      VALUES (?,?,?,?,?,NOW(),?,?,?,?,?,?,CURDATE(),?,'active','unpaid',?,NOW(),'manual_entry',?)`,
    [code, cleanName, phone || null, wa.valid ? 'valid' : 'invalid', wa.normalized || null, email, address || null, secret.site_id, secret.router_id, pkg.id, secret.username, due, secret.is_online ? 'online' : 'offline', `Dibuat dari PPP secret ${secret.username} (NMS)`]);
    customerId = ins.insertId;
    await conn.commit();
  } catch (err) { await conn.rollback().catch(() => {}); throw err; }
  finally { conn.release(); }
  const smartSync = require('./smartSync');
  await smartSync.manualMap(secret.id, customerId, 'created');
  await audit({ userId: ctx.userId, action: 'create', entityType: 'customer', entityId: customerId, ip: ctx.ip, siteId: secret.site_id, description: `Tambah ${code} - ${cleanName} dari PPP secret ${secret.username}` });
  return { customerId, customerCode: code, secretId: secret.id };
}

// ---------------------------------------------------------------- Traffic live per pelanggan
const trafficThrottle = new Map();
async function liveTraffic(secretId) {
  const secret = await store.secretById(secretId);
  const last = trafficThrottle.get(secret.id) || 0;
  if (Date.now() - last < 900) throw Object.assign(new Error('Terlalu cepat.'), { status: 429 });
  trafficThrottle.set(secret.id, Date.now());
  if (!secret.is_online) throw Object.assign(new Error('Pelanggan offline.'), { status: 409 });
  const router = await store.routerById(secret.router_id);
  // Interface dinamis PPPoE server di RouterOS: <pppoe-username>. rx di sisi router = upload pelanggan.
  const s = await ros.monitorTraffic(router, `<pppoe-${secret.username}>`);
  return { at: Date.now(), downloadBps: s.txBps, uploadBps: s.rxBps };
}

// ---------------------------------------------------------------- Snapshot + diff konfigurasi PPP
const SNAP_FIELDS = ['profile', 'disabled', 'caller_id', 'remote_address', 'local_address', 'service', 'comment'];
async function takeSnapshots() {
  const date = jakartaDate();
  const routers = await store.activeRouters();
  let taken = 0;
  for (const r of routers) {
    const [rows] = await db.query(`SELECT username, ${SNAP_FIELDS.join(', ')} FROM ppp_secrets WHERE router_id=? AND removed_on_router_at IS NULL ORDER BY username`, [r.id]);
    await db.execute(`INSERT INTO nms_secret_snapshots (router_id, snap_date, secrets_json, secret_count) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE secrets_json=VALUES(secrets_json), secret_count=VALUES(secret_count)`,
      [r.id, date, JSON.stringify(rows), rows.length]);
    taken++;
  }
  return { taken, date };
}

function diffSnapshots(before, after) {
  const a = new Map(before.map(s => [String(s.username).toLowerCase(), s]));
  const b = new Map(after.map(s => [String(s.username).toLowerCase(), s]));
  const added = [], removed = [], changed = [];
  for (const [k, s] of b) if (!a.has(k)) added.push(s);
  for (const [k, s] of a) if (!b.has(k)) removed.push(s);
  for (const [k, s] of b) {
    const old = a.get(k); if (!old) continue;
    const fields = SNAP_FIELDS.filter(f => String(old[f] ?? '') !== String(s[f] ?? '')).map(f => ({ field: f, from: old[f] ?? null, to: s[f] ?? null }));
    if (fields.length) changed.push({ username: s.username, fields });
  }
  return { added, removed, changed };
}

async function configDiff({ routerId, date = null }) {
  const [snaps] = await db.query(`SELECT snap_date, secrets_json, secret_count FROM nms_secret_snapshots WHERE router_id=? ${date ? 'AND snap_date<=?' : ''} ORDER BY snap_date DESC LIMIT 2`, date ? [routerId, date] : [routerId]);
  const [cur] = await db.query(`SELECT username, ${SNAP_FIELDS.join(', ')} FROM ppp_secrets WHERE router_id=? AND removed_on_router_at IS NULL`, [routerId]);
  if (!snaps.length) return { routerId: Number(routerId), from: null, to: 'sekarang', added: [], removed: [], changed: [], note: 'Belum ada snapshot. Snapshot pertama diambil otomatis tiap malam (atau klik Ambil snapshot).' };
  const today = jakartaDate();
  const toDate = d => d instanceof Date ? jakartaDate(d) : String(d).slice(0, 10);
  // Bandingkan snapshot sebelum hari ini dengan kondisi sekarang (mirror DB dari router).
  const base = snaps.find(s => toDate(s.snap_date) < today) || snaps[snaps.length - 1];
  const diff = diffSnapshots(JSON.parse(base.secrets_json || '[]'), cur);
  const [dates] = await db.query(`SELECT snap_date FROM nms_secret_snapshots WHERE router_id=? ORDER BY snap_date DESC LIMIT 30`, [routerId]);
  return { routerId: Number(routerId), from: toDate(base.snap_date), to: 'sekarang', ...diff, dates: dates.map(d => toDate(d.snap_date)) };
}

// ---------------------------------------------------------------- Auto Smart Sync + ringkasan (cron)
async function maybeAutoSync() {
  if (!(await settings.flag('auto_sync_enabled'))) return { ran: false };
  const last = Number(await settings.get('last_auto_sync_at')) || 0;
  if (Date.now() - last < 55 * 60000) return { ran: false };
  await settings.set({ last_auto_sync_at: String(Date.now()) });
  const smartSync = require('./smartSync');
  const out = await smartSync.autoRun({ commitHigh: await settings.flag('auto_sync_commit') });
  if ((out.newLastHour > 0 || out.linked > 0) && await settings.flag('auto_sync_notify')) {
    const numbers = await settings.summaryNumbers();
    const { enqueueWaMessage } = require('../whatsappGatewayService');
    const msg = `*Smart Sync otomatis*\n${out.newLastHour} secret baru dalam 1 jam terakhir.\n${out.linked ? `${out.linked} langsung ter-link (Customer ID/nama persis).\n` : ''}${out.suggested ? `${out.suggested} saran perlu dicek.\n` : ''}${out.conflicts ? `${out.conflicts} konflik.\n` : ''}Total belum ter-link: ${out.unsynced}.`;
    for (const phone of numbers) await enqueueWaMessage({ phone, message: msg, type: 'network_alert' }).catch(() => {});
  }
  return { ran: true, ...out };
}

async function maybeSendSummary() {
  if (!(await settings.flag('summary_enabled'))) return { ran: false };
  const today = jakartaDate();
  if (jakartaHour() < await settings.num('summary_hour') || (await settings.get('last_summary_date')) === today) return { ran: false };
  await settings.set({ last_summary_date: today });
  const insights = require('./insights');
  return { ran: true, ...(await insights.sendSummary()) };
}

module.exports = { schedule, listScheduled, cancelScheduled, runDue, changePackage, needsApproval, requestApproval, listApprovals, decideApproval, setHold, maybeRunDailyIsolation,
  createSecretForCustomer, createCustomerFromSecret, liveTraffic, takeSnapshots, diffSnapshots, configDiff, maybeAutoSync, maybeSendSummary, jakartaDate, jakartaHour };
