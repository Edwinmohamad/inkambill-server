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

async function resolveBookDate(conn, { mode, paidAt, manualDate, allowClosedReceipt = false }) {
  const normalized = ['payment_date', 'approval_date', 'manual'].includes(mode) ? mode : 'payment_date';
  const today = isoDate(new Date());
  const date = normalized === 'approval_date' ? today : normalized === 'manual' ? isoDate(manualDate) : isoDate(paidAt);
  if (!date) throw new Error('Tanggal pembukuan manual wajib diisi.');
  if (!allowClosedReceipt) await assertDateOpen(conn, date);
  return { date, mode: normalized };
}

async function financialAudit({ conn = db, userId = null, action, entityType, entityId = null, before = null, after = null, reason, ip = null }) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new Error('Alasan perubahan keuangan wajib diisi.');
  await conn.execute(`INSERT INTO financial_audit_logs(user_id,action,entity_type,entity_id,before_json,after_json,reason,ip_address)
    VALUES(?,?,?,?,?,?,?,?)`, [userId, action, entityType, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), cleanReason.slice(0, 500), String(ip || '').slice(0, 64) || null]);
}

// Call inside the same DB transaction that inserts the cash journal. Locking
// the same Closing row serializes payment posting with final period closure.
async function resolveAccountingPeriod(conn, { periodYear, periodMonth, bookDate, userId = null }) {
  const receipt = isoDate(bookDate);
  const year = Number(periodYear), month = Number(periodMonth);
  if (!receipt || !Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Periode faktur atau tanggal pembayaran tidak valid.');
  }
  const receiptCheck = new Date(`${receipt}T12:00:00Z`);
  if (Number.isNaN(receiptCheck.getTime()) || receiptCheck.toISOString().slice(0,10) !== receipt) throw new Error('Tanggal pembayaran tidak valid.');
  const monthStart = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
  const nextMonth = value => {
    const y = Number(value.slice(0, 4)), m = Number(value.slice(5, 7));
    return m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1);
  };
  let period = monthStart(year, month);
  for (let attempts = 0; attempts < 120; attempts++) {
    const next = nextMonth(period);
    const end = isoDate(new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 0, 12)));
    await conn.execute(`INSERT IGNORE INTO closing_periods(period_start,period_end,closing_date,created_by)
      VALUES(?,?,CURDATE(),?)`, [period, end, userId]);
    const [[closing]] = await conn.execute(`SELECT id,status FROM closing_periods
      WHERE period_start=? AND period_end=? FOR UPDATE`, [period, end]);
    if (!closing) throw new Error('Periode Closing tidak tersedia. Pembukuan dibatalkan.');
    if (closing.status === 'DRAFT') return period;
    if (closing.status !== 'LOCKED') throw new Error('Status Closing tidak dikenal. Pembukuan dibatalkan.');
    // A closed invoice month never receives new journals. Start at the later
    // of its following month and the receipt month, then skip closed months.
    period = next > receipt.slice(0, 7) + '-01' ? next : receipt.slice(0, 7) + '-01';
  }
  throw new Error('Tidak ditemukan periode pembukuan terbuka. Periksa status Closing.');
}

module.exports = { isoDate, lockedPeriodForDate, assertDateOpen, resolveBookDate, financialAudit, resolveAccountingPeriod };
