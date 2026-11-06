// Satu aturan periode untuk Data Kas, Laporan Arus Kas, dan Closing (v1.35).
//
// Jurnal pembayaran tagihan masuk ke BULAN TAGIHAN-nya (tagihan Oktober yang dibayar November tetap
// Oktober), KECUALI bulan tagihan itu sudah dikunci (Closing LOCKED) sebelum pembayaran disetujui /
// cash disetor. Uang yang datang setelah bulannya dikunci masuk ke periode tanggal jurnalnya (periode
// terbuka), sehingga snapshot Closing yang terkunci tidak berubah dan uang tidak hilang dari periode mana pun.
// Jurnal lain (kas manual, pengeluaran) memakai tanggal transaksi.
//
// Waktu "masuk kas" = settled_at untuk cash (saat disetor ke perusahaan), verified_at untuk transfer/QRIS.
// Bila waktu itu kosong (data lama), jurnal dianggap masuk sebelum dikunci -> tetap bulan tagihan.
const LEDGER_PERIOD_KEY = `(SELECT lpi.period_year*100+lpi.period_month FROM payments lpp JOIN invoices lpi ON lpi.id=lpp.invoice_id
  WHERE ct.source_type IN ('payment','install_income') AND lpp.id=ct.source_id
    AND NOT EXISTS (SELECT 1 FROM closing_periods lpc WHERE lpc.status='LOCKED' AND lpc.locked_at IS NOT NULL
      AND lpc.locked_at < (CASE WHEN lpp.method='cash' THEN lpp.settled_at ELSE lpp.verified_at END)
      AND (MAKEDATE(lpi.period_year,1)+INTERVAL (lpi.period_month-1) MONTH) BETWEEN lpc.period_start AND lpc.period_end)
  LIMIT 1)`;

// Predikat periode: memakai alias `ct` untuk cash_transactions. Parameter: ledgerPeriodParams(start,end).
const LEDGER_PERIOD_SQL = `((${LEDGER_PERIOD_KEY}) BETWEEN ? AND ? OR ((${LEDGER_PERIOD_KEY}) IS NULL AND ct.transaction_date BETWEEN ? AND ?))`;

// Varian untuk JOIN ke closing_periods (alias cp), tanpa parameter.
const LEDGER_PERIOD_JOIN_SQL = `((${LEDGER_PERIOD_KEY}) BETWEEN YEAR(cp.period_start)*100+MONTH(cp.period_start) AND YEAR(cp.period_end)*100+MONTH(cp.period_end) OR ((${LEDGER_PERIOD_KEY}) IS NULL AND ct.transaction_date BETWEEN cp.period_start AND cp.period_end))`;
// Kunci bulan 'YYYY-MM' tempat jurnal dihitung (untuk grafik arus kas bulanan).
const LEDGER_MONTH_LABEL_SQL = `COALESCE(CONCAT(FLOOR((${LEDGER_PERIOD_KEY})/100),'-',LPAD(MOD((${LEDGER_PERIOD_KEY}),100),2,'0')),DATE_FORMAT(ct.transaction_date,'%Y-%m'))`;

const monthKey = date => Number(String(date).slice(0, 4)) * 100 + Number(String(date).slice(5, 7));
function ledgerPeriodParams(start, end) {
  const from = String(start).slice(0, 10), to = String(end).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Rentang periode tidak valid.');
  return [monthKey(from), monthKey(to), from, to];
}
function monthRange(year, month) {
  const y = Number(year), m = Number(month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

module.exports = { LEDGER_PERIOD_KEY, LEDGER_PERIOD_SQL, LEDGER_PERIOD_JOIN_SQL, LEDGER_MONTH_LABEL_SQL, ledgerPeriodParams, monthRange, monthKey };
