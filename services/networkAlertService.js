const db = require('../config/db');
const { enqueueWaMessage } = require('./whatsappGatewayService');
const { oltSummaryRows } = require('./oltService');

// Network Incident & Alert Engine
// ---------------------------------------------------------------------------
// Dijalankan tiap 5 menit oleh cron di app.js (lihat evaluateNetworkIncidents()).
// Mendeteksi 3 jenis kondisi jaringan dan mencatatnya sebagai baris di
// `network_incidents` (satu baris permanen per entitas, status open/resolved
// dibalik-balik sesuai kondisi terkini -- lihat services/schemaService.js
// ensureV47Schema untuk skemanya):
//
//   1. router_offline      -- per router yang statusnya offline (entity_key: router:<id>)
//   2. olt_critical        -- per OLT yang ONU offline/kritisnya melewati ambang batas,
//                             indikasi gangguan massal di jalur PON (entity_key: olt:<nama>)
//   3. ont_mass_critical   -- lonjakan JUMLAH ONT kritis secara global (bukan per-ONT,
//                             karena redaman satu ONT naik-turun adalah hal rutin dan akan
//                             membuat WA/tiket spam jika dialarm satu-satu). Entity key
//                             tunggal (global:ont_critical).
//
// Hanya router_offline & olt_critical yang bisa membuat tiket otomatis (punya entitas
// jelas untuk di-assign); ont_mass_critical murni notifikasi WA untuk kewaspadaan NOC.
const OLT_OFFLINE_THRESHOLD = 5;
const OLT_CRITICAL_THRESHOLD = 5;
const ONT_MASS_CRITICAL_THRESHOLD = 10;
const REALERT_COOLDOWN_MINUTES = 60;

function nowJakarta() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

function parsePhones(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

async function getAlertSettings() {
  const [[row]] = await db.query(
    `SELECT network_alert_wa_enabled, network_alert_wa_numbers, network_alert_auto_ticket_enabled FROM settings WHERE id=1 LIMIT 1`
  );
  return {
    waEnabled: !!row?.network_alert_wa_enabled,
    numbers: parsePhones(row?.network_alert_wa_numbers),
    autoTicket: !!row?.network_alert_auto_ticket_enabled,
  };
}

async function getSystemUserId() {
  const [[row]] = await db.query(
    `SELECT id FROM users WHERE role='master_admin' AND is_active=1 ORDER BY id LIMIT 1`
  );
  return row ? Number(row.id) : null;
}

function ticketCode() {
  const d = new Date();
  const p = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
  return `TT-${p}-${String(Date.now()).slice(-6)}`;
}

async function findOnDutyEmployee(siteId) {
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const params = siteId ? [key, siteId] : [key];
  const [[row]] = await db.query(
    `SELECT em.id employee_id, em.user_id FROM server_duty_schedules d
     LEFT JOIN employees em ON em.user_id = d.user_id
     WHERE d.duty_date = ? AND d.status NOT IN ('absent','cancelled')${siteId ? ' AND (d.site_id=? OR d.site_id IS NULL)' : ''}
     ORDER BY (d.site_id IS NOT NULL) DESC, COALESCE(d.start_time,'23:59:59') LIMIT 1`,
    params
  );
  return row && row.employee_id ? { employeeId: Number(row.employee_id), userId: row.user_id ? Number(row.user_id) : null } : null;
}

async function createIncidentTicket({ subject, description, priority, siteId }) {
  const systemUserId = await getSystemUserId();
  if (!systemUserId) return null; // tidak ada akun master_admin aktif untuk atribusi tiket -- lebih aman dilewati daripada insert dengan opened_by tidak valid
  const onDuty = await findOnDutyEmployee(siteId);
  const code = ticketCode();
  try {
    const [r] = await db.execute(
      `INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,assigned_to,assigned_employee_id,opened_by,opened_at)
       VALUES(?,NULL,?,?,?,'open',?,?,?,?,NOW())`,
      [code, subject, 'Gangguan Jaringan', priority, description, onDuty?.userId || null, onDuty?.employeeId || null, systemUserId]
    );
    return { id: r.insertId, code };
  } catch (err) {
    console.error('[networkAlertService] gagal membuat tiket otomatis:', err.message);
    return null;
  }
}

async function sendAlertWa(numbers, message, type) {
  let sent = 0;
  for (const phone of numbers) {
    try {
      await enqueueWaMessage({ phone, message, type: 'network_alert' });
      sent++;
    } catch (err) {
      console.error('[networkAlertService] gagal enqueue WA ke', phone, err.message);
    }
  }
  return sent;
}

// Buka/perbarui satu baris insiden. Mengembalikan shouldAlert=true jika ini insiden baru
// (baru terbuka / baru terbuka-lagi setelah sempat resolved), atau jika sudah open tapi
// sudah lewat cooldown (agar tidak WA setiap 5 menit selama insiden masih berlangsung).
async function upsertIncident({ kind, entityKey, siteId, summary }) {
  const [[existing]] = await db.query(
    `SELECT id, status, ticket_id, last_alert_at FROM network_incidents WHERE kind=? AND entity_key=? LIMIT 1`,
    [kind, entityKey]
  );
  if (!existing) {
    const [r] = await db.execute(
      `INSERT INTO network_incidents(kind, entity_key, site_id, status, summary, opened_at, last_alert_at) VALUES(?,?,?,'open',?,NOW(),NOW())`,
      [kind, entityKey, siteId || null, summary]
    );
    return { isNew: true, incidentId: r.insertId, ticketId: null, shouldAlert: true };
  }
  if (existing.status === 'resolved') {
    await db.execute(
      `UPDATE network_incidents SET status='open', summary=?, site_id=?, opened_at=NOW(), resolved_at=NULL, ticket_id=NULL, last_alert_at=NOW() WHERE id=?`,
      [summary, siteId || null, existing.id]
    );
    return { isNew: true, incidentId: existing.id, ticketId: null, shouldAlert: true };
  }
  const lastAlert = existing.last_alert_at ? new Date(existing.last_alert_at) : null;
  const cooledDown = !lastAlert || (Date.now() - lastAlert.getTime()) >= REALERT_COOLDOWN_MINUTES * 60000;
  await db.execute(
    `UPDATE network_incidents SET summary=?${cooledDown ? ', last_alert_at=NOW()' : ''} WHERE id=?`,
    [summary, existing.id]
  );
  return { isNew: false, incidentId: existing.id, ticketId: existing.ticket_id, shouldAlert: cooledDown };
}

async function attachTicket(incidentId, ticketId) {
  await db.execute(`UPDATE network_incidents SET ticket_id=? WHERE id=?`, [ticketId, incidentId]);
}

// Tandai resolved semua insiden `kind` yang open tapi entity_key-nya tidak lagi ada
// di daftar `activeEntityKeys` (artinya kondisi buruknya sudah tidak terdeteksi lagi).
async function resolveMissingIncidents(kind, activeEntityKeys) {
  const [openRows] = await db.query(`SELECT id, entity_key, summary FROM network_incidents WHERE kind=? AND status='open'`, [kind]);
  const resolved = [];
  for (const row of openRows) {
    if (!activeEntityKeys.has(row.entity_key)) {
      await db.execute(`UPDATE network_incidents SET status='resolved', resolved_at=NOW() WHERE id=?`, [row.id]);
      resolved.push(row);
    }
  }
  return resolved;
}

async function evaluateNetworkIncidents() {
  const settings = await getAlertSettings();
  const summary = { opened: 0, resolved: 0, ticketsCreated: 0, waSent: 0 };

  try {
    // ---- 1) Router offline ----
    const [offlineRouters] = await db.query(
      `SELECT r.id, r.name, r.site_id, s.code site_code FROM routers r LEFT JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 AND r.last_status='offline'`
    );
    const activeRouterKeys = new Set(offlineRouters.map(r => `router:${r.id}`));
    for (const r of offlineRouters) {
      const entityKey = `router:${r.id}`;
      const summaryText = `Router ${r.name}${r.site_code ? ' (' + r.site_code + ')' : ''} offline`;
      const result = await upsertIncident({ kind: 'router_offline', entityKey, siteId: r.site_id, summary: summaryText });
      if (result.isNew) summary.opened++;
      if (settings.waEnabled && result.shouldAlert && settings.numbers.length) {
        summary.waSent += await sendAlertWa(
          settings.numbers,
          `\u{1F6A8} *ALERT JARINGAN*\n${summaryText}\nWaktu: ${nowJakarta()}`,
          'router_offline'
        );
      }
      if (result.isNew && settings.autoTicket && !result.ticketId) {
        const ticket = await createIncidentTicket({
          subject: `[Otomatis] ${summaryText}`,
          description: `Router terdeteksi offline oleh Dashboard Monitoring pada ${nowJakarta()}.`,
          priority: 'critical',
          siteId: r.site_id,
        });
        if (ticket) { await attachTicket(result.incidentId, ticket.id); summary.ticketsCreated++; }
      }
    }
    const resolvedRouters = await resolveMissingIncidents('router_offline', activeRouterKeys);
    for (const row of resolvedRouters) {
      if (settings.waEnabled && settings.numbers.length) {
        summary.waSent += await sendAlertWa(settings.numbers, `\u{2705} *PULIH*\n${row.summary} sudah kembali online.`, 'router_offline_resolved');
      }
    }
    summary.resolved += resolvedRouters.length;

    // ---- 2) OLT critical (agregat per jalur PON) ----
    const olts = await oltSummaryRows();
    const badOlts = olts.filter(o => o.onu_offline >= OLT_OFFLINE_THRESHOLD || o.onu_critical >= OLT_CRITICAL_THRESHOLD);
    const activeOltKeys = new Set(badOlts.map(o => `olt:${o.name}`));
    for (const o of badOlts) {
      const entityKey = `olt:${o.name}`;
      const summaryText = `OLT ${o.name}: ${o.onu_offline} ONU offline, ${o.onu_critical} ONU redaman kritis`;
      const result = await upsertIncident({ kind: 'olt_critical', entityKey, siteId: o.site_id, summary: summaryText });
      if (result.isNew) summary.opened++;
      if (settings.waEnabled && result.shouldAlert && settings.numbers.length) {
        summary.waSent += await sendAlertWa(
          settings.numbers,
          `\u{1F6A8} *ALERT JARINGAN*\n${summaryText}\nKemungkinan gangguan massal di jalur PON ini.\nWaktu: ${nowJakarta()}`,
          'olt_critical'
        );
      }
      if (result.isNew && settings.autoTicket && !result.ticketId) {
        const ticket = await createIncidentTicket({
          subject: `[Otomatis] ${summaryText}`,
          description: `OLT ${o.name} terdeteksi bermasalah oleh Dashboard Monitoring (kemungkinan fiber cut / power OLT). Segera cek lokasi. Waktu: ${nowJakarta()}.`,
          priority: 'critical',
          siteId: o.site_id,
        });
        if (ticket) { await attachTicket(result.incidentId, ticket.id); summary.ticketsCreated++; }
      }
    }
    const resolvedOlts = await resolveMissingIncidents('olt_critical', activeOltKeys);
    for (const row of resolvedOlts) {
      if (settings.waEnabled && settings.numbers.length) {
        summary.waSent += await sendAlertWa(settings.numbers, `\u{2705} *PULIH*\n${row.summary.split(':')[0]} sudah normal kembali.`, 'olt_critical_resolved');
      }
    }
    summary.resolved += resolvedOlts.length;

    // ---- 3) ONT mass-critical (agregat global, alert-only, tanpa tiket otomatis) ----
    const [[ontStats]] = await db.query(`SELECT SUM(signal_status='critical') n FROM acs_devices`);
    const criticalCount = Number(ontStats?.n || 0);
    const massKey = 'global:ont_critical';
    if (criticalCount >= ONT_MASS_CRITICAL_THRESHOLD) {
      const summaryText = `${criticalCount} ONT dalam kondisi redaman kritis secara bersamaan`;
      const result = await upsertIncident({ kind: 'ont_mass_critical', entityKey: massKey, siteId: null, summary: summaryText });
      if (result.isNew) summary.opened++;
      if (settings.waEnabled && result.shouldAlert && settings.numbers.length) {
        summary.waSent += await sendAlertWa(
          settings.numbers,
          `\u{1F6A8} *ALERT JARINGAN*\n${summaryText}.\nCek Dashboard Monitoring untuk detail per OLT/site.\nWaktu: ${nowJakarta()}`,
          'ont_mass_critical'
        );
      }
    } else {
      const resolvedMass = await resolveMissingIncidents('ont_mass_critical', new Set());
      summary.resolved += resolvedMass.length;
      if (resolvedMass.length && settings.waEnabled && settings.numbers.length) {
        summary.waSent += await sendAlertWa(settings.numbers, `\u{2705} *PULIH*\nJumlah ONT kritis sudah kembali normal.`, 'ont_mass_critical_resolved');
      }
    }
  } catch (err) {
    console.error('[networkAlertService] evaluateNetworkIncidents error:', err.message);
    summary.error = err.message;
  }

  return summary;
}

module.exports = { evaluateNetworkIncidents, getAlertSettings };
