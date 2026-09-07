const db = require('../config/db');

function isoDate(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function lockedPeriodForDate(conn, value) {
  const date = isoDate(value);
  if (!date) throw new Error('Tanggal transaksi tidak valid.');
  const [rows] = await conn.execute(`SELECT id,period_start,period_end FROM closing_periods
    WHERE status='LOCKED' AND ? BETWEEN period_start AND period_end ORDER BY period_end DESC LIMIT 1`, [date]);
  return rows[0] || null;
}

async function assertDateOpen(conn, value) {
  const date = isoDate(value);
  const locked = await lockedPeriodForDate(conn, date);
  if (locked) throw new Error(`Periode ${isoDate(locked.period_start)} s/d ${isoDate(locked.period_end)} sudah dikunci. Buka kembali Closing terlebih dahulu.`);
  return date;
}

async function resolveBookDate(conn, { mode, paidAt, manualDate }) {
  const normalized = ['payment_date', 'approval_date', 'manual'].includes(mode) ? mode : 'payment_date';
  const today = isoDate(new Date());
  const date = normalized === 'approval_date' ? today : normalized === 'manual' ? isoDate(manualDate) : isoDate(paidAt);
  if (!date) throw new Error('Tanggal pembukuan manual wajib diisi.');
  await assertDateOpen(conn, date);
  return { date, mode: normalized };
}

async function financialAudit({ conn = db, userId = null, action, entityType, entityId = null, before = null, after = null, reason, ip = null }) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new Error('Alasan perubahan keuangan wajib diisi.');
  await conn.execute(`INSERT INTO financial_audit_logs(user_id,action,entity_type,entity_id,before_json,after_json,reason,ip_address)
    VALUES(?,?,?,?,?,?,?,?)`, [userId, action, entityType, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), cleanReason.slice(0, 500), String(ip || '').slice(0, 64) || null]);
}

module.exports = { isoDate, lockedPeriodForDate, assertDateOpen, resolveBookDate, financialAudit };
