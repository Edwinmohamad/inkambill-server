const express = require('express');
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
    const conditions = ['d.status=?'];
    const params = [status];
    if (type) { conditions.push('d.record_type=?'); params.push(type); }
    if (site) { conditions.push('d.site_code=?'); params.push(site); }
    if (query) { conditions.push('(d.party_name LIKE ? OR d.purpose LIKE ? OR d.responsible_name LIKE ?)'); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
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
      const [payments] = await db.execute(`SELECT id,debt_id,payment_date,amount,notes,created_at FROM finance_debt_payments WHERE debt_id IN (${placeholders}) ORDER BY payment_date DESC,id DESC`, ids);
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
    res.render('debts/index', { title: 'Hutang & Piutang', pageTitle: 'Hutang & Piutang', records, summary, filters: { type, status, site, query }, today: localDate() });
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
  try {
    const id = Number(req.params.id);
    const paid = amount(req.body.amount);
    const paymentDate = validDate(req.body.payment_date) ? req.body.payment_date : '';
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
    await conn.execute('INSERT INTO finance_debt_payments(debt_id,payment_date,amount,notes,created_by) VALUES(?,?,?,?,?)', [id, paymentDate, paid, notes, req.session.user.id]);
    await refreshStatus(conn, id);
    await conn.commit();
    req.session.flash = { type: 'success', message: 'Pembayaran berhasil dicatat dan sisa diperbarui.' };
    res.redirect('/debts');
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
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
  try {
    const id = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(paymentId) || paymentId < 1) return res.status(400).send('Pembayaran tidak valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [[record]] = await conn.execute('SELECT id,status FROM finance_debts WHERE id=? FOR UPDATE', [id]);
    if (!record) { await conn.rollback(); return res.status(404).send('Data tidak ditemukan.'); }
    if (record.status === 'ARCHIVED') { await conn.rollback(); return res.status(409).send('Data arsip tidak dapat diubah.'); }
    const [removed] = await conn.execute('DELETE FROM finance_debt_payments WHERE id=? AND debt_id=?', [paymentId, id]);
    if (!removed.affectedRows) { await conn.rollback(); return res.status(404).send('Riwayat pembayaran tidak ditemukan.'); }
    await refreshStatus(conn, id);
    await conn.commit();
    req.session.flash = { type: 'success', message: 'Pembayaran dihapus dan sisa dihitung ulang.' };
    res.redirect('/debts');
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

module.exports = router;
