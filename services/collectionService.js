const db = require('../config/db');

// v1.26 — status manual "follow-up collection" per pelanggan, dipakai di menu Tagihan (tab
// Prioritas Collection) dan ikut ditampilkan (read-only) di kartu Aging Piutang, Analitik Bisnis.
// Ini BUKAN status jaringan: tahap "isolated" di sini murni label internal untuk kebutuhan
// tracking tim collection dan TIDAK memicu isolir PPPoE ke MikroTik. Eksekusi isolir jaringan
// yang sungguhan tetap lewat menu Pelanggan (customer_status -> suspended/terminated, lihat
// isolateAfterStatusChange() di routes/customers.js).
const STAGES = ['none', 'followed_up', 'ready_isolir', 'isolated'];
const STAGE_LABELS = {
  none: 'Belum Ditindaklanjuti',
  followed_up: 'Sudah Follow-up',
  ready_isolir: 'Siap Isolir',
  isolated: 'Sudah Diisolir'
};
// Selaras dengan tone yang sudah dipakai .status-badge di seluruh aplikasi (green/red/orange/purple/gray).
const STAGE_TONES = { none: 'gray', followed_up: 'orange', ready_isolir: 'red', isolated: 'purple' };
const CHANNELS = ['whatsapp', 'telepon', 'kunjungan', 'lainnya'];
const CHANNEL_LABELS = { whatsapp: 'WhatsApp', telepon: 'Telepon', kunjungan: 'Kunjungan', lainnya: 'Lainnya' };

function normalizeStage(value) { return STAGES.includes(String(value || '')) ? String(value) : 'none'; }
function normalizeChannel(value) { return CHANNELS.includes(String(value || '')) ? String(value) : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Piutang berjalan per pelanggan (gabungan semua tagihan belum lunas, lintas periode) + status
// collection manual yang menempel di baris pelanggan yang sama. Query dasarnya sama dengan aging
// piutang di services/analyticsService.js supaya kedua halaman selalu konsisten satu sama lain.
async function getCollectionAging({ siteCode = null, clusterId = null, customerId = null, limit = 300 } = {}) {
  const where = [`i.status IN ('unpaid','partial','overdue')`, `i.outstanding>0`];
  const params = [];
  if (siteCode) { where.push('s.code=?'); params.push(siteCode); }
  if (clusterId) { where.push('c.cluster_id=?'); params.push(Number(clusterId)); }
  if (customerId) { where.push('c.id=?'); params.push(Number(customerId)); }
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 300));
  const [rows] = await db.execute(`
    SELECT c.id, c.customer_code, c.name customer_name, c.phone, s.code site_code, cl.name cluster_name,
      c.collection_stage, c.collection_stage_at, c.collection_stage_note, u.name collection_stage_by_name,
      MIN(i.due_date) oldest_due,
      COALESCE(SUM(i.outstanding),0) outstanding,
      MAX(DATEDIFF(CURDATE(), i.due_date)) days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    JOIN sites s ON s.id = c.site_id
    LEFT JOIN clusters cl ON cl.id = c.cluster_id
    LEFT JOIN users u ON u.id = c.collection_stage_by
    WHERE ${where.join(' AND ')}
    GROUP BY c.id, c.customer_code, c.name, c.phone, s.code, cl.name, c.collection_stage, c.collection_stage_at, c.collection_stage_note, u.name
    ORDER BY days_overdue DESC, outstanding DESC
    LIMIT ${safeLimit}`, params);
  return rows.map(row => {
    const daysOverdue = num(row.days_overdue);
    const stage = normalizeStage(row.collection_stage);
    // Sama persis dengan bucket H-3 / H+3 s/d 30 / >30 Hari yang sudah dipakai di Analitik Bisnis.
    // Pelanggan yang belum jatuh tempo dalam waktu dekat (>3 hari lagi) sengaja tidak masuk bucket
    // manapun — tetap muncul di tab "Semua", tapi tidak di salah satu tab bucket spesifik.
    const bucket = daysOverdue > 30 ? 'over30' : daysOverdue > 0 ? 'hplus3' : daysOverdue >= -3 ? 'h3' : null;
    return {
      ...row,
      days_overdue: daysOverdue,
      outstanding: num(row.outstanding),
      siapIsolir: daysOverdue > 7,
      stage,
      stageLabel: STAGE_LABELS[stage],
      stageTone: STAGE_TONES[stage],
      bucket
    };
  });
}

function bucketizeAging(aging) {
  return {
    h3: aging.filter(x => x.bucket === 'h3'),
    hplus3: aging.filter(x => x.bucket === 'hplus3'),
    over30: aging.filter(x => x.bucket === 'over30')
  };
}

async function setCollectionStage({ customerId, stage, channel, note, userId }) {
  const normalizedStage = normalizeStage(stage);
  const normalizedChannel = normalizeChannel(channel);
  const trimmedNote = String(note || '').trim().slice(0, 500) || null;
  await db.execute(
    `UPDATE customers SET collection_stage=?, collection_stage_at=NOW(), collection_stage_by=?, collection_stage_note=? WHERE id=?`,
    [normalizedStage, userId || null, trimmedNote, customerId]
  );
  await db.execute(
    `INSERT INTO customer_collection_logs (customer_id, stage, channel, note, created_by) VALUES (?,?,?,?,?)`,
    [customerId, normalizedStage, normalizedChannel, trimmedNote, userId || null]
  );
  return { stage: normalizedStage, channel: normalizedChannel, note: trimmedNote };
}

async function getCollectionLogs(customerId, limit = 10) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
  const [rows] = await db.execute(
    `SELECT l.id, l.stage, l.channel, l.note, l.created_at, u.name created_by_name
     FROM customer_collection_logs l LEFT JOIN users u ON u.id=l.created_by
     WHERE l.customer_id=? ORDER BY l.created_at DESC, l.id DESC LIMIT ${safeLimit}`,
    [customerId]
  );
  return rows.map(row => ({
    ...row,
    stageLabel: STAGE_LABELS[normalizeStage(row.stage)],
    channelLabel: row.channel ? CHANNEL_LABELS[row.channel] : null
  }));
}

module.exports = {
  STAGES, STAGE_LABELS, STAGE_TONES, CHANNELS, CHANNEL_LABELS,
  normalizeStage, normalizeChannel,
  getCollectionAging, bucketizeAging, setCollectionStage, getCollectionLogs
};
