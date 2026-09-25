// Power Action Web Inbox: "Verifikasi Pembayaran & Buka Isolir" (1-klik).
//   1. Bukti transfer dari chat → pembayaran transfer 'pending' (atau pakai pengajuan pending yang sudah ada).
//   2. Master Admin: approval langsung (guard keuangan identik dengan menu Pembayaran) → tagihan LUNAS.
//   3. Buka isolir di MikroTik: enable PPP secret + hapus IP dari address-list ISOLIR.
//   4. Kirim Template D (Konfirmasi Pembayaran & Kuitansi Digital) ke pelanggan via antrean anti-ban.
// Non-Master-Admin: langkah 1 saja (pengajuan menunggu approval Master Admin) — kebijakan keuangan
// yang sudah berjalan tidak dilewati.
const fs = require('fs');
const db = require('../config/db');
const { isMasterAdminRole } = require('../middleware/auth');
const { audit } = require('./auditService');
const pay = require('./paymentVerificationService');
const inbox = require('./waInboxService');
const tpl = require('./waTemplateService');
const { unisolateCustomer } = require('./networkService');

async function proofFileFromChat(chatMessageId, conversationId) {
  if (!chatMessageId) return null;
  const [[m]] = await db.execute(`SELECT id,media_path,media_mime,media_name FROM wa_chat_messages WHERE id=? AND conversation_id=? AND direction='in'`, [chatMessageId, conversationId]);
  if (!m?.media_path) throw new Error('Pesan bukti yang dipilih tidak memiliki lampiran.');
  if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(m.media_mime || '')) throw new Error('Lampiran bukti harus JPG, PNG, WEBP, atau PDF.');
  const info = await inbox.mediaFileFor(m.id);
  const buffer = await fs.promises.readFile(info.file);
  return { buffer, mimetype: m.media_mime, originalname: m.media_name || `bukti-wa-${m.id}`, size: buffer.length };
}

async function verifyAndReactivate({ conversationId, invoiceIds = [], bankId = null, proofChatMessageId = null, user, ip = null }) {
  const conv = await inbox.loadConversation(conversationId);
  if (!conv) throw new Error('Percakapan tidak ditemukan.');
  if (!conv.customer_id) throw new Error('Percakapan belum ditautkan ke data pelanggan.');
  const ids = [...new Set([].concat(invoiceIds).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new Error('Pilih minimal satu tagihan.');
  const [invoices] = await db.query(`SELECT id,invoice_number,outstanding,status FROM invoices WHERE customer_id=? AND id IN (${ids.map(() => '?').join(',')})`, [conv.customer_id, ...ids]);
  if (invoices.length !== ids.length) throw new Error('Tagihan tidak cocok dengan pelanggan percakapan ini.');

  const master = isMasterAdminRole(user.role);
  const steps = [];
  // 1) Kumpulkan pembayaran pending: pakai yang sudah ada, sisanya dibuat dari bukti chat.
  const paymentIds = [];
  const needNew = [];
  for (const inv of invoices) {
    const [[p]] = await db.execute(`SELECT id FROM payments WHERE invoice_id=? AND status='pending' ORDER BY id DESC LIMIT 1`, [inv.id]);
    if (p) paymentIds.push(p.id); else if (Number(inv.outstanding) > 0) needNew.push(inv.id);
  }
  if (needNew.length) {
    const file = await proofFileFromChat(proofChatMessageId, conversationId);
    if (!file) throw new Error('Pilih foto/dokumen bukti transfer dari chat untuk tagihan yang belum memiliki pengajuan pembayaran.');
    const created = await pay.createPendingTransferPayments({ invoiceIds: needNew, bankId, file, userId: user.id, notes: `Bukti dari WhatsApp (percakapan #${conversationId})` });
    created.forEach(c => paymentIds.push(c.paymentId));
    steps.push(`${created.length} pengajuan pembayaran transfer dibuat dari bukti chat`);
    await audit({ userId: user.id, action: 'create', entityType: 'payment_batch', entityId: created[0]?.paymentId || null, description: `Pembayaran transfer ${created.length} faktur dari Web Inbox WA · bukti terlampir`, ip });
  }
  if (!paymentIds.length) throw new Error('Tidak ada pembayaran yang perlu diverifikasi (tagihan sudah lunas?).');

  if (!master) {
    await inbox.addSystemNote(conversationId, `${user.name} mengajukan ${paymentIds.length} pembayaran — menunggu approval Master Admin di menu Pembayaran.`);
    return { verified: false, pendingApproval: paymentIds.length, steps: [...steps, 'Menunggu approval Master Admin (kebijakan keuangan)'] };
  }

  // 2) Approval Master Admin (guard identik dengan POST /payments/:id/verify).
  let verified = 0; const errors = [];
  for (const id of paymentIds) {
    try {
      const { payment } = await pay.verifyPendingPayment(id, { userId: user.id, ip, bookDateMode: 'payment_date', skipReceipt: true });
      verified++;
      await audit({ userId: user.id, action: 'approve', entityType: 'payment', entityId: payment.id, description: `Approval Master Admin via Web Inbox WA untuk pembayaran ${payment.reference || payment.id}`, ip });
    } catch (e) { errors.push(e.message); }
  }
  if (!verified) throw new Error(errors[0] || 'Verifikasi gagal.');
  steps.push(`${verified} pembayaran diverifikasi — tagihan diperbarui`);

  // 3) Buka isolir bila semua tagihan terbuka sudah lunas.
  const [[left]] = await db.execute(`SELECT COUNT(*) n,COALESCE(SUM(outstanding),0) total FROM invoices WHERE customer_id=? AND status IN ('unpaid','partial','overdue') AND outstanding>0 AND archived_at IS NULL`, [conv.customer_id]);
  const [[cust]] = await db.execute(`SELECT network_status FROM customers WHERE id=?`, [conv.customer_id]);
  let reactivated = false;
  if (cust?.network_status === 'isolated') {
    if (Number(left.n) === 0) {
      try {
        const r = await unisolateCustomer(conv.customer_id, false);
        reactivated = true;
        steps.push(`Isolir dibuka di MikroTik (PPP secret aktif${r.addressList?.removed ? `, ${r.addressList.removed} entri address-list ISOLIR dihapus` : ''})`);
        await audit({ userId: user.id, action: 'unisolate', entityType: 'customer', entityId: conv.customer_id, description: 'Buka isolir via Web Inbox WA setelah verifikasi pembayaran', ip });
      } catch (e) {
        steps.push(`Gagal buka isolir otomatis: ${e.message}`);
        await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_unisolate','failed',?)`, [`inbox #${conversationId}: ${e.message}`.slice(0, 1000)]);
      }
    } else steps.push(`Isolir TIDAK dibuka: masih ada ${left.n} tagihan terbuka (${tpl.formatRupiah(left.total)})`);
  }

  // 4) Kuitansi digital (Template D) langsung ke chat pelanggan.
  try {
    const [[paid]] = await db.query(`SELECT SUM(p.amount) amount,GROUP_CONCAT(i.invoice_number SEPARATOR ', ') numbers FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.id IN (${paymentIds.map(() => '?').join(',')}) AND p.status='confirmed'`, paymentIds);
    const row = await tpl.loadCustomerRow(conv.customer_id);
    const bank = await tpl.getDefaultBank();
    const template = await tpl.getTemplate('receipt');
    const text = tpl.renderTemplate(template, tpl.buildVars({ ...row, amount: paid.amount, invoice_number: paid.numbers }, bank));
    await inbox.sendReply({ conversationId, text, userId: user.id });
    steps.push('Kuitansi digital dikirim ke pelanggan');
  } catch (e) { steps.push(`Kuitansi gagal dikirim: ${e.message}`); }
  await inbox.addSystemNote(conversationId, `${user.name}: ${steps.join(' · ')}`);
  return { verified, reactivated, steps, errors };
}

module.exports = { verifyAndReactivate };
