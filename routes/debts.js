const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');

const router = express.Router();
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const amount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};
const localDate = () => {
  const date = new Date();
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
};
const dateKey = (value) => {
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};
const addMonths = (dateValue, months) => {
  const [year, month, day] = dateKey(dateValue).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
};
function installmentSchedule(record) {
  const months = record.payment_method === 'INSTALLMENT' ? Math.max(1, Math.min(60, Number(record.installment_months || 1))) : 1;
  const principal = amount(record.principal_amount);
  const base = Math.floor(principal / months);
  let paidLeft = amount(record.paid_amount);
  const firstDue = dateKey(record.due_date || record.issue_date);
  return Array.from({ length: months }, (_, index) => {
    const target = index === months - 1 ? principal - (base * (months - 1)) : base;
    const applied = Math.min(target, Math.max(0, paidLeft));
    paidLeft -= applied;
    const dueDate = addMonths(firstDue, index);
    const status = applied >= target ? 'PAID' : applied > 0 ? 'PARTIAL' : dueDate < localDate() ? 'OVERDUE' : 'UPCOMING';
    return { number: index + 1, dueDate, target, paid: applied, remaining: target - applied, status };
  });
}

// v1.26 -- payment channel options for a cicilan/payment entry. Mirrors the cash/transfer/qris/other
// vocabulary already used by Payments & Cash so `statusLabel()` (middleware/common.js) renders the
// same Indonesian labels (Tunai/Transfer/QRIS/Lainnya) without any extra translation table here.
const PAYMENT_METHODS = new Set(['cash', 'transfer', 'qris', 'other']);
const PERIOD_OPTIONS = new Set(['today', 'month', 'custom']);

// v1.26 -- optional "Lampiran Bukti" attachment for a debt/receivable payment. Same
// memory-storage -> validate-signature -> write-once-to-disk pattern used for cash proofs
// (routes/finance.js) and payment proofs, kept local to this module for consistency.
const DEBT_PROOF_DIR = path.join(__dirname, '..', 'storage', 'debt-proofs');
fs.mkdirSync(DEBT_PROOF_DIR, { recursive: true });
function proofExtension(mime) { return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' })[mime] || ''; }
function proofSignatureMatches(file) {
  const b = file?.buffer;
  if (!b || b.length < 12) return false;
  if (file.mimetype === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (file.mimetype === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  if (file.mimetype === 'application/pdf') return b.subarray(0, 5).toString() === '%PDF-';
  return false;
}
async function saveDebtProof(file) {
  if (!file) return null;
  const ext = proofExtension(file.mimetype);
  if (!ext || !proofSignatureMatches(file)) throw new Error('Isi file lampiran bukti tidak sesuai format yang diizinkan.');
  const filename = `debt-${Date.now()}-${crypto.randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(DEBT_PROOF_DIR, filename), file.buffer, { flag: 'wx' });
  return { filename, originalName: file.originalname, mime: file.mimetype, size: file.size };
}
async function removeDebtProof(filename) {
  if (!filename) return;
  try { await fs.promises.unlink(path.join(DEBT_PROOF_DIR, path.basename(filename))); }
  catch (e) { if (e.code !== 'ENOENT') console.error('Gagal hapus lampiran bukti cicilan:', e.message); }
}

async function refreshStatus(conn, id) {
  await conn.execute(`UPDATE finance_debts d
    SET d.status=CASE
      WHEN d.status='ARCHIVED' THEN 'ARCHIVED'
      WHEN (SELECT COALESCE(SUM(p.amount),0) FROM finance_debt_payments p WHERE p.debt_id=d.id)>=d.principal_amount THEN 'PAID'
      ELSE 'ACTIVE' END
    WHERE d.id=?`, [id]);
}

router.get('/', async (req, res, next) => {
  try {
    const type = ['DEBT', 'RECEIVABLE'].includes(String(req.query.type || '').toUpperCase()) ? String(req.query.type).toUpperCase() : '';
    const status = ['ACTIVE', 'PAID', 'ARCHIVED'].includes(String(req.query.status || '').toUpperCase()) ? String(req.query.status).toUpperCase() : 'ACTIVE';
    const site = ['GLOBAL', 'CDS', 'KBG'].includes(String(req.query.site || '').toUpperCase()) ? String(req.query.site).toUpperCase() : '';
    const query = String(req.query.q || '').trim().slice(0, 100);
    // v1.26 -- quick period filter (Hari ini / Bulan ini / Custom) on top of the existing
    // type/site/status/search filters, scoped to when the record was recorded (issue_date).
    const period = PERIOD_OPTIONS.has(String(req.query.period || '')) ? String(req.query.period) : '';
    const periodFrom = validDate(req.query.from) ? String(req.query.from) : '';
    const periodTo = validDate(req.query.to) ? String(req.query.to) : '';
    const conditions = ['d.status=?'];
    const params = [status];
    if (type) { conditions.push('d.record_type=?'); params.push(type); }
    if (site) { conditions.push('d.site_code=?'); params.push(site); }
    if (query) { conditions.push('(d.party_name LIKE ? OR d.purpose LIKE ? OR d.responsible_name LIKE ?)'); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
    if (period === 'today') { conditions.push('d.issue_date = CURDATE()'); }
    else if (period === 'month') { conditions.push('MONTH(d.issue_date)=MONTH(CURDATE()) AND YEAR(d.issue_date)=YEAR(CURDATE())'); }
    else if (period === 'custom' && periodFrom && periodTo) { conditions.push('d.issue_date BETWEEN ? AND ?'); params.push(periodFrom, periodTo); }
    const [records] = await db.execute(`SELECT d.*,
      COALESCE(SUM(p.amount),0) paid_amount,
      GREATEST(d.principal_amount-COALESCE(SUM(p.amount),0),0) remaining_amount,
      CASE WHEN d.status='ACTIVE' AND d.due_date IS NOT NULL AND d.due_date<CURDATE() THEN 1 ELSE 0 END is_overdue,
      DATEDIFF(d.due_date,CURDATE()) days_to_due
      FROM finance_debts d LEFT JOIN finance_debt_payments p ON p.debt_id=d.id
      WHERE ${conditions.join(' AND ')} GROUP BY d.id ORDER BY is_overdue DESC,d.due_date IS NULL,d.due_date,d.id DESC`, params);
    if (records.length) {
      const ids = records.map((row) => Number(row.id));
      const placeholders = ids.map(() => '?').join(',');
      const [payments] = await db.execute(`SELECT id,debt_id,payment_date,amount,payment_method,notes,proof_path,proof_original_name,created_at FROM finance_debt_payments WHERE debt_id IN (${placeholders}) ORDER BY payment_date DESC,id DESC`, ids);
      const [items] = await db.execute(`SELECT id,debt_id,item_name,quantity,unit_price,notes FROM finance_debt_items WHERE debt_id IN (${placeholders}) ORDER BY debt_id,id`, ids);
      const grouped = new Map();
      const groupedItems = new Map();
      payments.forEach((payment) => {
        if (!grouped.has(Number(payment.debt_id))) grouped.set(Number(payment.debt_id), []);
        grouped.get(Number(payment.debt_id)).push(payment);
      });
      items.forEach((item) => {
        if (!groupedItems.has(Number(item.debt_id))) groupedItems.set(Number(item.debt_id), []);
        groupedItems.get(Number(item.debt_id)).push(item);
      });
      records.forEach((record) => {
        record.payments = grouped.get(Number(record.id)) || [];
        record.items = groupedItems.get(Number(record.id)) || [];
        record.installments = installmentSchedule(record);
        const nextInstallment = record.installments.find((item) => item.status !== 'PAID');
        record.next_installment = nextInstallment || null;
        record.is_overdue = record.installments.some((item) => item.status === 'OVERDUE');

        // v1.26 -- riwayat transaksi timeline: the record's creation ("penambahan piutang/hutang")
        // plus every payment, each carrying its own running "sisa saldo" so the UI never has to
        // recompute a balance client-side. Newest activity first, the original entry always last.
        const principal = Number(record.principal_amount || 0);
        const paymentsAsc = [...record.payments].sort((a, b) => {
          if (a.payment_date === b.payment_date) return Number(a.id) - Number(b.id);
          return a.payment_date < b.payment_date ? -1 : 1;
        });
        let cumulative = 0;
        const paymentEntries = paymentsAsc.map((p) => {
          cumulative += Number(p.amount);
          const remainingAfter = Math.max(0, principal - cumulative);
          return {
            kind: 'payment',
            id: p.id,
            date: p.payment_date,
            time: p.created_at,
            amount: Number(p.amount),
            method: p.payment_method || 'cash',
            notes: p.notes,
            hasProof: Boolean(p.proof_path),
            remainingAfter,
            entryStatus: remainingAfter <= 0 ? 'LUNAS' : 'DICICIL'
          };
        });
        record.timeline = [...paymentEntries].reverse().concat([{
          kind: 'created',
          id: null,
          date: record.issue_date,
          time: record.created_at || null,
          amount: principal,
          method: null,
          notes: record.purpose,
          hasProof: false,
          remainingAfter: principal,
          entryStatus: 'DIBUAT'
        }]);

        // Overall status badge for the card header: LUNAS (paid off) > TERLAMBAT (past due,
        // still owing) > DICICIL (partially paid) > BELUM DIBAYAR (nothing paid yet).
        const paidAmount = Number(record.paid_amount || 0);
        record.payment_status = record.status === 'PAID'
          ? 'LUNAS'
          : (record.is_overdue ? 'TERLAMBAT' : (paidAmount > 0 ? 'DICICIL' : 'BELUM DIBAYAR'));
      });
    }
    const [summaryRows] = await db.query(`SELECT d.record_type,
      SUM(GREATEST(d.principal_amount-COALESCE(x.paid,0),0)) remaining,
      SUM(CASE WHEN d.due_date<CURDATE() THEN GREATEST(d.principal_amount-COALESCE(x.paid,0),0) ELSE 0 END) overdue,
      COUNT(*) total
      FROM finance_debts d LEFT JOIN (SELECT debt_id,SUM(amount) paid FROM finance_debt_payments GROUP BY debt_id) x ON x.debt_id=d.id
      WHERE d.status='ACTIVE' GROUP BY d.record_type`);
    const summary = { DEBT: { remaining: 0, overdue: 0, total: 0 }, RECEIVABLE: { remaining: 0, overdue: 0, total: 0 } };
    summaryRows.forEach((row) => { summary[row.record_type] = { remaining: Number(row.remaining || 0), overdue: Number(row.overdue || 0), total: Number(row.total || 0) }; });
    res.render('debts/index', { title: 'Hutang & Piutang', pageTitle: 'Hutang & Piutang', records, summary, filters: { type, status, site, query, period, from: periodFrom, to: periodTo }, today: localDate() });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  let conn;
  try {
    const type = String(req.body.record_type || '').toUpperCase();
    const site = String(req.body.site_code || '').toUpperCase();
    const method = String(req.body.payment_method || '').toUpperCase();
    const party = String(req.body.party_name || '').trim().slice(0, 160);
    const purpose = String(req.body.purpose || '').trim().slice(0, 255);
    const itemNames = Array.isArray(req.body.item_name) ? req.body.item_name : [req.body.item_name];
    const quantities = Array.isArray(req.body.item_quantity) ? req.body.item_quantity : [req.body.item_quantity];
    const unitPrices = Array.isArray(req.body.item_unit_price) ? req.body.item_unit_price : [req.body.item_unit_price];
    const itemNotes = Array.isArray(req.body.item_notes) ? req.body.item_notes : [req.body.item_notes];
    const items = itemNames.map((name, index) => ({
      name: String(name || '').trim().slice(0, 255),
      quantity: Math.round(Math.max(0, Number(quantities[index] || 0)) * 100) / 100,
      unitPrice: amount(unitPrices[index]),
      notes: String(itemNotes[index] || '').trim().slice(0, 500) || null
    })).filter((item) => item.name && item.quantity > 0 && item.unitPrice > 0);
    const principal = items.reduce((total, item) => total + Math.round(item.quantity * item.unitPrice), 0);
    const issueDate = validDate(req.body.issue_date) ? req.body.issue_date : '';
    const dueDate = validDate(req.body.due_date) ? req.body.due_date : null;
    const responsible = String(req.body.responsible_name || '').trim().slice(0, 160) || null;
    const notes = String(req.body.notes || '').trim().slice(0, 2000) || null;
    const installmentMonths = method === 'INSTALLMENT' ? Math.max(2, Math.min(60, Number.parseInt(req.body.installment_months, 10) || 2)) : 1;
    if (!['DEBT', 'RECEIVABLE'].includes(type) || !['GLOBAL', 'CDS', 'KBG'].includes(site) || !['ONCE', 'INSTALLMENT'].includes(method)) return res.status(400).send('Jenis, lokasi, atau metode pembayaran tidak valid.');
    if (!party || !purpose || principal <= 0 || !issueDate || !items.length) return res.status(400).send('Pihak, keperluan, tanggal, dan minimal satu rincian pembelian wajib diisi.');
    if (dueDate && dueDate < issueDate) return res.status(400).send('Jatuh tempo tidak boleh sebelum tanggal pencatatan.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [created] = await conn.execute(`INSERT INTO finance_debts(record_type,party_name,purpose,site_code,principal_amount,issue_date,due_date,payment_method,installment_months,responsible_name,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [type, party, purpose, site, principal, issueDate, dueDate, method, installmentMonths, responsible, notes, req.session.user.id]);
    for (const item of items) await conn.execute('INSERT INTO finance_debt_items(debt_id,item_name,quantity,unit_price,notes) VALUES(?,?,?,?,?)', [created.insertId, item.name, item.quantity, item.unitPrice, item.notes]);
    await conn.commit();
    req.session.flash = { type: 'success', message: `${type === 'DEBT' ? 'Hutang' : 'Piutang'} berhasil dicatat.` };
    res.redirect('/debts');
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/:id/payments', async (req, res, next) => {
  let conn;
  let saved = null;
  try {
    const id = Number(req.params.id);
    const paid = amount(req.body.amount);
    const paymentDate = validDate(req.body.payment_date) ? req.body.payment_date : '';
    const method = PAYMENT_METHODS.has(String(req.body.payment_method || '').toLowerCase()) ? String(req.body.payment_method).toLowerCase() : 'cash';
    const notes = String(req.body.notes || '').trim().slice(0, 500) || null;
    if (!Number.isInteger(id) || id < 1 || paid <= 0 || !paymentDate) return res.status(400).send('Pembayaran tidak valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [[record]] = await conn.execute('SELECT id,status,principal_amount FROM finance_debts WHERE id=? FOR UPDATE', [id]);
    if (!record) { await conn.rollback(); return res.status(404).send('Data tidak ditemukan.'); }
    const [[totals]] = await conn.execute('SELECT COALESCE(SUM(amount),0) paid_amount FROM finance_debt_payments WHERE debt_id=?', [id]);
    const remaining = Number(record.principal_amount) - Number(totals.paid_amount);
    if (record.status === 'ARCHIVED') { await conn.rollback(); return res.status(409).send('Data yang diarsipkan tidak dapat menerima pembayaran.'); }
    if (paid > remaining) { await conn.rollback(); return res.status(400).send(`Pembayaran melebihi sisa Rp ${Math.max(0, remaining).toLocaleString('id-ID')}.`); }
    // Attachment is saved only after every business-rule check has passed, so a rejected
    // payment (over the remaining balance, archived record, ...) never leaves an orphan file.
    if (req.file) saved = await saveDebtProof(req.file);
    await conn.execute('INSERT INTO finance_debt_payments(debt_id,payment_date,amount,payment_method,notes,proof_path,proof_original_name,proof_mime,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, paymentDate, paid, method, notes, saved?.filename || null, saved?.originalName || null, saved?.mime || null, req.session.user.id]);
    await refreshStatus(conn, id);
    await conn.commit();
    req.session.flash = { type: 'success', message: 'Pembayaran berhasil dicatat dan sisa diperbarui.' };
    res.redirect('/debts');
  } catch (err) {
    if (conn) await conn.rollback();
    if (saved) await removeDebtProof(saved.filename);
    next(err);
  } finally { if (conn) conn.release(); }
});

router.get('/:id/payments/:paymentId/proof', async (req, res) => {
  const id = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(paymentId) || paymentId < 1) return res.status(400).send('Permintaan tidak valid.');
  const [rows] = await db.execute('SELECT proof_path,proof_original_name,proof_mime FROM finance_debt_payments WHERE id=? AND debt_id=? LIMIT 1', [paymentId, id]);
  const proof = rows[0];
  if (!proof?.proof_path) return res.status(404).send('Lampiran bukti tidak ditemukan.');
  const full = path.join(DEBT_PROOF_DIR, path.basename(proof.proof_path));
  if (!fs.existsSync(full)) return res.status(404).send('File lampiran tidak ditemukan di storage.');
  res.type(proof.proof_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(proof.proof_original_name || path.basename(proof.proof_path)).replace(/[\r\n"]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(full);
});

router.post('/:id/archive', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Data tidak valid.');
    const [result] = await db.execute("UPDATE finance_debts SET status='ARCHIVED' WHERE id=? AND status<>'ARCHIVED'", [id]);
    if (!result.affectedRows) return res.status(404).send('Data tidak ditemukan atau sudah diarsipkan.');
    req.session.flash = { type: 'success', message: 'Data dipindahkan ke arsip.' };
    res.redirect('/debts');
  } catch (err) { next(err); }
});

router.post('/:id/payments/:paymentId/delete', async (req, res, next) => {
  let conn;
  let removedProof = null;
  try {
    const id = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(paymentId) || paymentId < 1) return res.status(400).send('Pembayaran tidak valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [[record]] = await conn.execute('SELECT id,status FROM finance_debts WHERE id=? FOR UPDATE', [id]);
    if (!record) { await conn.rollback(); return res.status(404).send('Data tidak ditemukan.'); }
    if (record.status === 'ARCHIVED') { await conn.rollback(); return res.status(409).send('Data arsip tidak dapat diubah.'); }
    const [[paymentRow]] = await conn.execute('SELECT proof_path FROM finance_debt_payments WHERE id=? AND debt_id=?', [paymentId, id]);
    const [removed] = await conn.execute('DELETE FROM finance_debt_payments WHERE id=? AND debt_id=?', [paymentId, id]);
    if (!removed.affectedRows) { await conn.rollback(); return res.status(404).send('Riwayat pembayaran tidak ditemukan.'); }
    await refreshStatus(conn, id);
    await conn.commit();
    removedProof = paymentRow?.proof_path || null;
    if (removedProof) await removeDebtProof(removedProof);
    req.session.flash = { type: 'success', message: 'Pembayaran dihapus dan sisa dihitung ulang.' };
    res.redirect('/debts');
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

module.exports = router;
