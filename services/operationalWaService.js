// Notifikasi operasional pribadi (SPV, billing, dan NOC).
// n8n hanya menjadwalkan endpoint; pengiriman tetap melewati WA Gateway supaya
// audit, retry, dan status pesan tersimpan di aplikasi.
const db = require('../config/db');
const { enqueueWaMessage } = require('./whatsappGatewayService');

const WEB_URL = String(process.env.APP_URL || 'https://inkambill.edwinpxmx.my.id').replace(/\/+$/, '');
const PHONE = {
  spv: () => String(process.env.WA_OP_SPV_PHONE || '').trim(),
  finance: () => String(process.env.WA_OP_FINANCE_PHONE || '').trim(),
  jon: () => String(process.env.WA_OP_TECH_JON_PHONE || '').trim(),
  bopung: () => String(process.env.WA_OP_TECH_BOPUNG_PHONE || '').trim(),
  agung: () => String(process.env.WA_OP_TECH_AGUNG_PHONE || '').trim(),
  ali: () => String(process.env.WA_OP_TECH_ALI_PHONE || '').trim()
};

async function sendMany(phones, message) {
  const unique = [...new Set(phones.filter(Boolean))];
  const results = await Promise.all(unique.map(phone => enqueueWaMessage({ phone, message, type: 'manual' })));
  return results.filter(result => result.status !== 'failed').length;
}

function techPhonesForSite(site) {
  const code = String(site || '').trim().toUpperCase();
  // Jon dan Bopung merupakan teknisi inti seluruh site. Ali khusus KBG/Kubang,
  // sedangkan Agung hanya KRW/CLM.
  if (['KBG', 'KUBANG'].includes(code)) return [PHONE.jon(), PHONE.bopung(), PHONE.ali()];
  if (['KRW', 'CLM'].includes(code)) return [PHONE.jon(), PHONE.bopung(), PHONE.agung()];
  return [PHONE.jon(), PHONE.bopung(), PHONE.agung(), PHONE.ali()];
}

async function sendBillingFollowUp() {
  const [[summary]] = await db.query(`SELECT COUNT(*) total,COALESCE(SUM(i.outstanding),0) amount,
    SUM(i.due_date<CURDATE()) overdue, SUM(i.due_date=CURDATE()) due_today,
    SUM(i.due_date=DATE_ADD(CURDATE(),INTERVAL 1 DAY)) due_tomorrow
    FROM invoices i JOIN customers c ON c.id=i.customer_id
    WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
      AND c.customer_status='active' AND c.archived_at IS NULL`);
  const total = Number(summary.total || 0);
  const amount = Number(summary.amount || 0).toLocaleString('id-ID');
  const taskMessage = `🔔 *TUGAS FOLLOW-UP TAGIHAN*\n\nHari ini ada *${total}* tagihan aktif perlu ditindaklanjuti.\n• Menunggak: *${Number(summary.overdue || 0)}*\n• Jatuh tempo hari ini: *${Number(summary.due_today || 0)}*\n• Jatuh tempo besok: *${Number(summary.due_tomorrow || 0)}*\n• Potensi tagihan: *Rp${amount}*\n\nBuka daftar kerja:\n${WEB_URL}/invoices?status=pending_approval\n\nCatat progres follow-up di web agar tidak dieskalasi otomatis.`;
  const sentToFinance = await sendMany([PHONE.finance()], taskMessage);
  return { total, amount: Number(summary.amount || 0), sentToFinance };
}

async function sendSpvBriefing({ period = 'PAGI' } = {}) {
  const [[billing]] = await db.query(`SELECT COUNT(*) total,COALESCE(SUM(outstanding),0) amount FROM invoices WHERE status IN ('unpaid','partial','overdue') AND outstanding>0`);
  const [[payments]] = await db.query(`SELECT COUNT(*) total,COALESCE(SUM(amount),0) amount FROM payments WHERE status='pending'`);
  const [[tickets]] = await db.query(`SELECT COUNT(*) total,SUM(priority='critical') critical,SUM(priority='high') high FROM tickets WHERE status IN ('open','progress','pending')`);
  const [[stock]] = await db.query(`SELECT COUNT(*) total FROM inventory_items WHERE is_active=1 AND deleted_at IS NULL AND min_stock>0 AND qty<=min_stock`);
  const [[cash]] = await db.query(`SELECT COUNT(*) total,COALESCE(SUM(amount),0) amount FROM cash_transactions WHERE approval_status='PENDING_APPROVAL'`);
  const message = `📊 *BRIEFING SPV — ${period}*\n\n*Billing*\n• ${Number(billing.total || 0)} tagihan berjalan · Rp${Number(billing.amount || 0).toLocaleString('id-ID')}\n• ${Number(payments.total || 0)} pembayaran pending · Rp${Number(payments.amount || 0).toLocaleString('id-ID')}\n\n*Operasional*\n• ${Number(tickets.total || 0)} tiket aktif (${Number(tickets.critical || 0)} kritis, ${Number(tickets.high || 0)} tinggi)\n• ${Number(stock.total || 0)} stok kritis\n• ${Number(cash.total || 0)} kas menunggu approval · Rp${Number(cash.amount || 0).toLocaleString('id-ID')}\n\nBuka kontrol operasional:\n${WEB_URL}/dashboard`;
  return { sentToSpv: await sendMany([PHONE.spv()], message) };
}

async function dispatchNocAlert({ site, title, detail = '', priority = 'high', ticketCode = '' }) {
  const normalizedPriority = ['low', 'medium', 'high', 'critical'].includes(String(priority)) ? String(priority) : 'high';
  const message = `⚠️ *${normalizedPriority === 'critical' ? 'INCIDENT KRITIS' : 'ALERT NOC'}*\n\n*Site:* ${String(site || 'SEMUA SITE').toUpperCase()}\n*Masalah:* ${String(title || 'Gangguan jaringan').slice(0, 180)}${detail ? `\n*Detail:* ${String(detail).slice(0, 600)}` : ''}${ticketCode ? `\n*Tiket:* ${ticketCode}` : ''}\n\nSegera ambil dan update progres melalui web:\n${WEB_URL}/tickets`;
  const recipients = techPhonesForSite(site);
  if (normalizedPriority === 'critical') recipients.push(PHONE.spv());
  return { sent: await sendMany(recipients, message), recipientCount: [...new Set(recipients.filter(Boolean))].length };
}

module.exports = { sendBillingFollowUp, sendSpvBriefing, dispatchNocAlert };
