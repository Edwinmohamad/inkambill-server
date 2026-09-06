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
      const grouped = new Map();
      payments.forEach((payment) => {
        if (!grouped.has(Number(payment.debt_id))) grouped.set(Number(payment.debt_id), []);
        grouped.get(Number(payment.debt_id)).push(payment);
      });
      records.forEach((record) => { record.payments = grouped.get(Number(record.id)) || []; });
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
  try {
    const type = String(req.body.record_type || '').toUpperCase();
    const site = String(req.body.site_code || '').toUpperCase();
    const method = String(req.body.payment_method || '').toUpperCase();
    const party = String(req.body.party_name || '').trim().slice(0, 160);
    const purpose = String(req.body.purpose || '').trim().slice(0, 255);
    const principal = amount(req.body.principal_amount);
    const issueDate = validDate(req.body.issue_date) ? req.body.issue_date : '';
    const dueDate = validDate(req.body.due_date) ? req.body.due_date : null;
    const responsible = String(req.body.responsible_name || '').trim().slice(0, 160) || null;
    const notes = String(req.body.notes || '').trim().slice(0, 2000) || null;
    if (!['DEBT', 'RECEIVABLE'].includes(type) || !['GLOBAL', 'CDS', 'KBG'].includes(site) || !['ONCE', 'INSTALLMENT'].includes(method)) return res.status(400).send('Jenis, lokasi, atau metode pembayaran tidak valid.');
    if (!party || !purpose || principal <= 0 || !issueDate) return res.status(400).send('Pihak, keperluan, tanggal, dan nominal wajib diisi dengan benar.');
    if (dueDate && dueDate < issueDate) return res.status(400).send('Jatuh tempo tidak boleh sebelum tanggal pencatatan.');
    await db.execute(`INSERT INTO finance_debts(record_type,party_name,purpose,site_code,principal_amount,issue_date,due_date,payment_method,responsible_name,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [type, party, purpose, site, principal, issueDate, dueDate, method, responsible, notes, req.session.user.id]);
    req.session.flash = { type: 'success', message: `${type === 'DEBT' ? 'Hutang' : 'Piutang'} berhasil dicatat.` };
    res.redirect('/debts');
  } catch (err) { next(err); }
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
