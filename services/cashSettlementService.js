const db = require('../config/db');

// v1.28 — Rekonsiliasi cash: pengingat umur cash di tim dan tanda terima WhatsApp pembayaran.

const DEFAULT_AGING_DAYS = 3;
const DEFAULT_RECEIPT_TEMPLATE = 'Yth. Bapak/Ibu {nama},\n\nTerima kasih, pembayaran tagihan layanan internet INKAMNET Anda telah kami terima dengan rincian sebagai berikut:\n\nNo. Faktur : {no_faktur}\nPeriode : {periode}\nJumlah Dibayar : {nominal}\nMetode Pembayaran : {metode}\nNo. Referensi : {referensi}\nSisa Tagihan : {sisa}\n\nMohon simpan pesan ini sebagai bukti pembayaran. Terima kasih atas kepercayaan Anda menggunakan layanan INKAMNET.\n\nHormat kami,\nTim Layanan Pelanggan INKAMNET';
const MONTH_NAMES_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const METHOD_LABEL = { cash: 'tunai', transfer: 'transfer', qris: 'QRIS', gateway: 'payment gateway', other: 'lainnya' };

function rupiahPlain(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
}

async function cashAgingDays(conn = db) {
  try {
    const [[row]] = await conn.query(`SELECT cash_aging_alert_days FROM settings WHERE id=1 LIMIT 1`);
    const days = Number(row?.cash_aging_alert_days);
    return Number.isInteger(days) && days >= 1 && days <= 60 ? days : DEFAULT_AGING_DAYS;
  } catch { return DEFAULT_AGING_DAYS; }
}

function jakartaParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// Sekali sehari (mulai 08:00 WIB): notifikasi ke admin untuk cash yang dipegang tim lebih lama dari
// batas hari, dan ke masing-masing collector untuk cash miliknya. Notifikasi ini ikut terkirim ke APK
// lewat push FCM / sinkronisasi berkala karena memakai system_notifications.
async function runCashAgingAlert(now = new Date()) {
  const { date, hour } = jakartaParts(now);
  if (hour < 8) return { ran: false, reason: 'not_yet_hour' };
  const [[settings]] = await db.query(`SELECT cash_aging_last_alert_date FROM settings WHERE id=1 LIMIT 1`);
  const last = settings?.cash_aging_last_alert_date ? new Date(settings.cash_aging_last_alert_date) : null;
  const lastKey = last ? `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}` : null;
  if (lastKey === date) return { ran: false, reason: 'already_ran_today' };
  const days = await cashAgingDays();
  const [rows] = await db.query(`SELECT COALESCE(p.collector_user_id,p.received_by) collector_id,COALESCE(u.name,'Tidak diketahui') collector_name,
      COUNT(*) transactions,COALESCE(SUM(p.amount),0) amount,MAX(DATEDIFF(CURDATE(),DATE(p.paid_at))) oldest_days
    FROM payments p LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff'
      AND DATEDIFF(CURDATE(),DATE(p.paid_at))>?
    GROUP BY COALESCE(p.collector_user_id,p.received_by),u.name ORDER BY amount DESC`, [days]);
  await db.execute(`UPDATE settings SET cash_aging_last_alert_date=? WHERE id=1`, [date]);
  if (!rows.length) return { ran: true, notified: 0 };
  const totalTx = rows.reduce((a, r) => a + Number(r.transactions), 0);
  const totalAmount = rows.reduce((a, r) => a + Number(r.amount), 0);
  const top = rows.slice(0, 3).map(r => `${r.collector_name} ${rupiahPlain(r.amount)}`).join(', ');
  const [admins] = await db.query(`SELECT id FROM users WHERE is_active=1 AND role IN ('admin','master_admin','masteradmin','superadmin')`);
  let notified = 0;
  for (const admin of admins) {
    await db.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id) VALUES(?,?,?,?,?,?,?,?,?)`, [
      admin.id, 'cash_aging', 'warning', 'bi-hourglass-split',
      `${totalTx} transaksi cash lebih dari ${days} hari di tim`,
      `Total ${rupiahPlain(totalAmount)} belum disetor. ${top}${rows.length > 3 ? ', ...' : ''}`.slice(0, 700),
      '/payments/reconciliation?aging=overdue#cashHeldTable', 'cash_aging', null
    ]);
    notified++;
  }
  const adminIds = new Set(admins.map(a => Number(a.id)));
  for (const r of rows) {
    if (!r.collector_id || adminIds.has(Number(r.collector_id))) continue;
    await db.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id) VALUES(?,?,?,?,?,?,?,?,?)`, [
      r.collector_id, 'cash_aging', 'warning', 'bi-cash-coin',
      `Segera setor cash ${rupiahPlain(r.amount)}`,
      `${r.transactions} pembayaran cash sudah ${r.oldest_days} hari belum disetor ke kas perusahaan.`,
      '/my-cash', 'cash_aging', null
    ]);
    notified++;
  }
  return { ran: true, notified, collectors: rows.length };
}

function renderReceiptTemplate(template, row) {
  const periode = `${MONTH_NAMES_ID[Number(row.period_month) - 1] || ''} ${row.period_year || ''}`.trim();
  return String(template || DEFAULT_RECEIPT_TEMPLATE)
    .replace(/\{nama\}/g, row.customer_name || '')
    .replace(/\{kode\}/g, row.customer_code || '')
    .replace(/\{periode\}/g, periode)
    .replace(/\{nominal\}/g, rupiahPlain(row.amount))
    .replace(/\{metode\}/g, METHOD_LABEL[row.method] || row.method || '')
    .replace(/\{no_faktur\}/g, row.invoice_number || '')
    .replace(/\{referensi\}/g, row.reference || `#${row.id}`)
    .replace(/\{sisa\}/g, rupiahPlain(row.outstanding));
}

// Dipanggil setelah approval (commit) — tidak pernah menggagalkan approval.
async function queuePaymentReceipts(paymentIds, userId = null) {
  const ids = [...new Set((paymentIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { queued: 0 };
  try {
    const [[settings]] = await db.query(`SELECT wa_payment_receipt_enabled,wa_payment_receipt_methods,wa_payment_receipt_template FROM settings WHERE id=1 LIMIT 1`);
    if (!Number(settings?.wa_payment_receipt_enabled)) return { queued: 0, reason: 'disabled' };
    const { enqueueWaMessage, approvalBatchKey } = require('./whatsappGatewayService');
    const [rows] = await db.query(`SELECT p.id,p.amount,p.method,p.reference,p.status,i.id invoice_id,i.invoice_number,i.period_month,i.period_year,i.outstanding,
        c.id customer_id,c.customer_code,c.name customer_name,c.phone,c.whatsapp_status
      FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
      WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids);
    let queued = 0;
    for (const row of rows) {
      if (row.status !== 'confirmed') continue;
      if (settings.wa_payment_receipt_methods !== 'all' && row.method !== 'cash') continue;
      if (!row.phone || row.whatsapp_status === 'invalid') continue;
      const [[already]] = await db.query(`SELECT id FROM wa_messages WHERE invoice_id=? AND message_type='payment_receipt' AND message LIKE ? LIMIT 1`, [row.invoice_id, `%${row.reference || `#${row.id}`}%`]);
      if (already) continue;
      await enqueueWaMessage({ phone: row.phone, message: renderReceiptTemplate(settings.wa_payment_receipt_template, row), customerId: row.customer_id, invoiceId: row.invoice_id, type: 'payment_receipt', userId, approvalBatch: approvalBatchKey('payment_receipt') });
      queued++;
    }
    return { queued };
  } catch (err) {
    console.error('Tanda terima WA pembayaran gagal diantrikan:', err.message);
    return { queued: 0, error: err.message };
  }
}

async function loadSettlement(settlementId) {
  const id = Number(settlementId);
  if (!Number.isInteger(id) || id < 1) return null;
  const [[settlement]] = await db.execute(`SELECT cs.*,cu.name collector_name,au.name created_by_name
    FROM cash_settlements cs LEFT JOIN users cu ON cu.id=cs.collector_user_id LEFT JOIN users au ON au.id=cs.created_by WHERE cs.id=? LIMIT 1`, [id]);
  if (!settlement) return null;
  const [payments] = await db.execute(`SELECT p.id,p.amount,p.reference,p.paid_at,p.settled_at,c.customer_code,c.name customer_name,i.invoice_number,s.code site_code,cl.name cluster_name,
      COALESCE(u.name,'Tidak diketahui') collector_name
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id
    LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.settlement_id=? ORDER BY p.paid_at,p.id`, [id]);
  const [cancelled] = await db.execute(`SELECT x.amount,x.reason,x.cancelled_at,c.name customer_name,u.name cancelled_by_name
    FROM cash_settlement_cancellations x JOIN payments p ON p.id=x.payment_id JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    LEFT JOIN users u ON u.id=x.cancelled_by WHERE x.settlement_id=? ORDER BY x.id`, [id]);
  return { settlement, payments, cancelled };
}

// Tanda terima setoran cash (PDF) — satu dokumen per nomor setoran, dengan kotak tanda tangan
// collector (menyerahkan) dan admin (menerima).
async function streamSettlementReceipt(res, settlementId, { disposition = 'inline' } = {}) {
  const { createReportPdf, rupiah, COLORS } = require('./reportPdf');
  const data = await loadSettlement(settlementId);
  if (!data) return res.status(404).send('Setoran tidak ditemukan.');
  const { settlement: st, payments, cancelled } = data;
  const fmt = v => v ? new Date(v).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-';
  const dateLabel = new Date(st.settlement_date).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  const collectorNames = [...new Set(payments.map(p => p.collector_name))];
  const collectorLabel = st.collector_name || (collectorNames.length === 1 ? collectorNames[0] : collectorNames.length ? `${collectorNames.length} collector` : '-');
  const rows = payments.map(p => ({
    customer: `${p.customer_name} (${p.customer_code})`, invoice: p.invoice_number, reference: p.reference || `#${p.id}`,
    siteCluster: `${p.site_code}${p.cluster_name ? ' · ' + p.cluster_name : ''}`, collector: p.collector_name,
    paidAt: fmt(p.paid_at), amount: rupiah(p.amount), _rawAmount: Number(p.amount || 0)
  }));
  const summaryItems = [
    { label: 'TOTAL DICOCOKKAN', value: rupiah(st.total_amount), color: COLORS.green },
    { label: 'TRANSAKSI', value: String(payments.length), color: COLORS.blue }
  ];
  if (st.handed_amount != null) {
    summaryItems.push({ label: 'UANG DISERAHKAN', value: rupiah(st.handed_amount), color: COLORS.blue });
    if (Number(st.difference_amount)) summaryItems.push({ label: 'SELISIH LEBIH', value: rupiah(st.difference_amount), color: COLORS.red });
  }
  const notes = [st.status === 'cancelled' ? 'DIBATALKAN' : '', st.notes ? `Catatan: ${st.notes}` : '', cancelled.length ? `${cancelled.length} transaksi dibatalkan dari setoran ini` : ''].filter(Boolean).join(' · ');
  return createReportPdf(res, {
    title: 'Tanda Terima Setoran',
    subtitle: `${st.code} · ${dateLabel} · Collector: ${collectorLabel}${notes ? ' · ' + notes : ''}`,
    filename: `tanda-terima-${st.code}.pdf`.toLowerCase(),
    watermark: st.status === 'cancelled' ? 'DIBATALKAN' : 'INKAMNET · SETORAN CASH',
    disposition,
    summaryItems,
    columns: [
      { label: 'Pelanggan', key: 'customer', width: 1.9, bold: true },
      { label: 'Faktur', key: 'invoice', width: 1.1 },
      { label: 'Ref. Bayar', key: 'reference', width: 1.2 },
      { label: 'Site / Cluster', key: 'siteCluster', width: 1.2 },
      { label: 'Collector', key: 'collector', width: 1.1 },
      { label: 'Dibayar', key: 'paidAt', width: 1.2 },
      { label: 'Nominal', key: 'amount', width: 1.1, align: 'right', total: true, totalBy: r => r._rawAmount }
    ],
    rows,
    layout: 'portrait',
    signatures: [
      { label: 'Diserahkan oleh (collector)', name: collectorLabel },
      { label: 'Diterima oleh (admin)', name: st.created_by_name || '' }
    ]
  });
}

module.exports = { loadSettlement, streamSettlementReceipt, DEFAULT_AGING_DAYS, DEFAULT_RECEIPT_TEMPLATE, cashAgingDays, runCashAgingAlert, queuePaymentReceipts, renderReceiptTemplate };
