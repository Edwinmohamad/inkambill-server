const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const { audit } = require('../services/auditService');
const { financialAudit } = require('../services/financialControlService');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const amount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};
const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const SCOPES = new Set(['INTERNAL', 'EXTERNAL']);
// Kembali ke tampilan/filter yang sama setelah catat bayar/arsip (mis. tetap di tab Internal).
const backTo = (req) => {
  try { const u = new URL(String(req.get('referer') || ''), 'http://x'); if (u.pathname === '/debts') return `/debts${u.search}`; } catch { /* ignore */ }
  return '/debts';
};

// v1.30 -- daftar karyawan aktif untuk dropdown Hutang Internal. Teknisi (kategori jabatan
// 'technical') ditaruh paling atas karena merekalah yang paling sering berhutang.
async function internalPeople() {
  const [rows] = await db.query(`SELECT e.id,e.employee_code,e.name,e.user_id,e.phone,p.name position_name,p.category,u.username
    FROM employees e LEFT JOIN positions p ON p.id=e.position_id LEFT JOIN users u ON u.id=e.user_id
    WHERE e.is_active=1 ORDER BY (p.category='technical') DESC,e.name`);
  return rows;
}
const JKT_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateKey = (value) => {
  if (typeof value === 'string') return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : JKT_DATE.format(date);
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
  const targets = Array.from({length:months},(_,i)=>i===months-1?principal-base*(months-1):base);
  const applied = Array(months).fill(0);
  const payments = Array.isArray(record.payments) ? [...record.payments].sort((a,b)=>String(a.payment_date).localeCompare(String(b.payment_date))||Number(a.id)-Number(b.id)) : [];
  // Allocate explicitly numbered payments first so each instalment keeps its own history.
  for (const p of payments) {
    const n=Number(p.installment_number);
    if (Number.isInteger(n) && n>=1 && n<=months) applied[n-1]+=amount(p.amount);
  }
  // Legacy unnumbered payments are projected oldest-first; never mutate their history.
  for (const p of payments) {
    const n=Number(p.installment_number);
    if (Number.isInteger(n) && n>=1 && n<=months) continue;
    let unallocated=amount(p.amount);
    for(let i=0;i<months&&unallocated>0;i++){
      const take=Math.min(Math.max(0,targets[i]-applied[i]),unallocated);
      applied[i]+=take;unallocated-=take;
    }
  }
  const firstDue=dateKey(record.due_date || (record.payment_method==='INSTALLMENT' ? addMonths(record.issue_date,1) : record.issue_date));
  const today=localDate();
  return targets.map((target,index)=>{
    const paid=Math.max(0,applied[index]);
    const dueDate=addMonths(firstDue,index);
    const remaining=Math.max(0,target-paid);
    const status=remaining===0?'PAID':dueDate<today?'OVERDUE':paid>0?'PARTIAL':'UPCOMING';
    return {number:index+1,dueDate,target,paid,remaining,status,overdue:dueDate<today&&remaining>0};
  });
}

// v1.26 -- payment channel options for a cicilan/payment entry. Mirrors the cash/transfer/qris/other
// vocabulary already used by Payments & Cash so `statusLabel()` (middleware/common.js) renders the
// same Indonesian labels (Tunai/Transfer/QRIS/Lainnya) without any extra translation table here.
const PAYMENT_METHODS = new Set(['cash', 'transfer']);
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
      WHEN (SELECT COALESCE(SUM(p.amount),0) FROM finance_debt_payments p WHERE p.debt_id=d.id AND p.voided_at IS NULL)>=d.principal_amount THEN 'PAID'
      ELSE 'ACTIVE' END
    WHERE d.id=?`, [id]);
}

router.get('/', async (req, res, next) => {
  try {
    const type = ['DEBT', 'RECEIVABLE'].includes(String(req.query.type || '').toUpperCase()) ? String(req.query.type).toUpperCase() : '';
    const scope = SCOPES.has(String(req.query.scope || '').toUpperCase()) ? String(req.query.scope).toUpperCase() : '';
    const employeeFilter = Number.parseInt(req.query.employee, 10) > 0 ? Number.parseInt(req.query.employee, 10) : 0;
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
    if (scope) { conditions.push('d.scope=?'); params.push(scope); }
    if (employeeFilter) { conditions.push('d.employee_id=?'); params.push(employeeFilter); }
    if (site) { conditions.push('d.site_code=?'); params.push(site); }
    if (query) { conditions.push('(d.party_name LIKE ? OR d.purpose LIKE ? OR d.responsible_name LIKE ? OR e.name LIKE ? OR e.employee_code LIKE ?)'); params.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`); }
    if (period === 'today') { conditions.push('d.issue_date = CURDATE()'); }
    else if (period === 'month') { conditions.push('MONTH(d.issue_date)=MONTH(CURDATE()) AND YEAR(d.issue_date)=YEAR(CURDATE())'); }
    else if (period === 'custom' && periodFrom && periodTo) { conditions.push('d.issue_date BETWEEN ? AND ?'); params.push(periodFrom, periodTo); }
    const [records] = await db.execute(`SELECT d.*,e.employee_code,e.name employee_name,pos.name employee_position,u.username linked_username,
      COALESCE(SUM(p.amount),0) paid_amount,
      GREATEST(d.principal_amount-COALESCE(SUM(p.amount),0),0) remaining_amount,
      CASE WHEN d.status='ACTIVE' AND d.due_date IS NOT NULL AND d.due_date<CURDATE() THEN 1 ELSE 0 END is_overdue,
      DATEDIFF(d.due_date,CURDATE()) days_to_due
      FROM finance_debts d LEFT JOIN finance_debt_payments p ON p.debt_id=d.id AND p.voided_at IS NULL
      LEFT JOIN employees e ON e.id=d.employee_id LEFT JOIN positions pos ON pos.id=e.position_id LEFT JOIN users u ON u.id=d.user_id
      WHERE ${conditions.join(' AND ')} GROUP BY d.id ORDER BY is_overdue DESC,d.due_date IS NULL,d.due_date,d.id DESC`, params);
    if (records.length) {
      const ids = records.map((row) => Number(row.id));
      const placeholders = ids.map(() => '?').join(',');
      const [payments] = await db.execute(`SELECT id,debt_id,installment_number,payment_date,amount,payment_method,notes,proof_path,proof_original_name,created_at,voided_at,void_reason FROM finance_debt_payments WHERE debt_id IN (${placeholders}) ORDER BY payment_date DESC,id DESC`, ids);
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
        record.payments = (grouped.get(Number(record.id)) || []).filter(p=>!p.voided_at);
        record.allPaymentHistory = grouped.get(Number(record.id)) || [];
        record.items = groupedItems.get(Number(record.id)) || [];
        record.installments = installmentSchedule(record);
        const nextInstallment = record.installments.find((item) => item.status !== 'PAID');
        record.next_installment = nextInstallment || null;
        record.is_overdue = record.installments.some((item) => item.status === 'OVERDUE');

        // v1.26 -- riwayat transaksi timeline: the record's creation ("penambahan piutang/hutang")
        // plus every payment, each carrying its own running "sisa saldo" so the UI never has to
        // recompute a balance client-side. Newest activity first, the original entry always last.
        const principal = Number(record.principal_amount || 0);
        const paymentsAsc = [...record.allPaymentHistory].sort((a, b) => {
          if (a.payment_date === b.payment_date) return Number(a.id) - Number(b.id);
          return a.payment_date < b.payment_date ? -1 : 1;
        });
        let cumulative = 0;
        const paymentEntries = paymentsAsc.map((p) => {
          if(!p.voided_at)cumulative += Number(p.amount);
          const remainingAfter = Math.max(0, principal - cumulative);
          return {
            kind: 'payment',
            id: p.id,
            date: p.payment_date,
            time: p.created_at,
            amount: Number(p.amount),
            method: p.payment_method || 'cash',
            installmentNumber: p.installment_number ? Number(p.installment_number) : null,
            voided: Boolean(p.voided_at),
            voidReason: p.void_reason || null,
            notes: p.notes,
            hasProof: Boolean(p.proof_path),
            remainingAfter,
            entryStatus: p.voided_at ? 'BATAL' : remainingAfter <= 0 ? 'LUNAS' : 'DICICIL'
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
    const [summaryRows] = await db.query(`SELECT d.scope,d.record_type,
      SUM(GREATEST(d.principal_amount-COALESCE(x.paid,0),0)) remaining,
      SUM(CASE WHEN d.due_date<CURDATE() THEN GREATEST(d.principal_amount-COALESCE(x.paid,0),0) ELSE 0 END) overdue,
      COUNT(*) total
      FROM finance_debts d LEFT JOIN (SELECT debt_id,SUM(amount) paid FROM finance_debt_payments WHERE voided_at IS NULL GROUP BY debt_id) x ON x.debt_id=d.id
      WHERE d.status='ACTIVE' GROUP BY d.scope,d.record_type`);
    const blank = () => ({ remaining: 0, overdue: 0, total: 0 });
    const summary = { DEBT: blank(), RECEIVABLE: blank(), INTERNAL: { DEBT: blank(), RECEIVABLE: blank() }, EXTERNAL: { DEBT: blank(), RECEIVABLE: blank() } };
    summaryRows.forEach((row) => {
      const v = { remaining: Number(row.remaining || 0), overdue: Number(row.overdue || 0), total: Number(row.total || 0) };
      const agg = summary[row.record_type];
      agg.remaining += v.remaining; agg.overdue += v.overdue; agg.total += v.total;
      if (summary[row.scope]) summary[row.scope][row.record_type] = v;
    });
    // v1.30 -- ringkasan per teknisi: siapa saja yang masih punya hutang ke kantor.
    const [techRows] = await db.query(`SELECT d.employee_id,COALESCE(e.name,d.party_name) name,e.employee_code,pos.name position_name,
      SUM(CASE WHEN d.record_type='RECEIVABLE' THEN GREATEST(d.principal_amount-COALESCE(x.paid,0),0) ELSE 0 END) owed_to_office,
      SUM(CASE WHEN d.record_type='DEBT' THEN GREATEST(d.principal_amount-COALESCE(x.paid,0),0) ELSE 0 END) owed_by_office,
      COUNT(*) total
      FROM finance_debts d LEFT JOIN (SELECT debt_id,SUM(amount) paid FROM finance_debt_payments GROUP BY debt_id) x ON x.debt_id=d.id
      LEFT JOIN employees e ON e.id=d.employee_id LEFT JOIN positions pos ON pos.id=e.position_id
      WHERE d.status='ACTIVE' AND d.scope='INTERNAL'
      GROUP BY d.employee_id,COALESCE(e.name,d.party_name),e.employee_code,pos.name ORDER BY owed_to_office DESC,name`);
    const people = await internalPeople();
    res.render('debts/index', { title: 'Hutang & Piutang', pageTitle: 'Hutang & Piutang', records, summary, techRows, people, filters: { type, scope, employee: employeeFilter, status, site, query, period, from: periodFrom, to: periodTo }, today: localDate() });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  let conn;
  try {
    const type = String(req.body.record_type || '').toUpperCase();
    const scope = SCOPES.has(String(req.body.scope || '').toUpperCase()) ? String(req.body.scope).toUpperCase() : 'EXTERNAL';
    const site = String(req.body.site_code || '').toUpperCase();
    const method = String(req.body.payment_method || '').toUpperCase();
    let party = String(req.body.party_name || '').trim().slice(0, 160);
    let employeeId = null;
    let userId = null;
    if (scope === 'INTERNAL') {
      // Hutang internal wajib ditautkan ke karyawan/teknisi, nama pihak diambil dari data karyawan
      // (bukan diketik) supaya rekap per teknisi di Closing tidak pecah karena beda ejaan.
      const [[employee]] = await db.execute('SELECT id,name,user_id FROM employees WHERE id=? AND is_active=1 LIMIT 1', [Number(req.body.employee_id) || 0]);
      if (!employee) return res.status(400).send('Pilih teknisi / karyawan untuk hutang internal.');
      employeeId = employee.id; userId = employee.user_id || null; party = String(employee.name).slice(0, 160);
    }
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
    if(method==='INSTALLMENT'&&installmentMonths>principal)return res.status(400).send('Jumlah cicilan tidak boleh melebihi nominal rupiah hutang.');
    if (dueDate && dueDate < issueDate) return res.status(400).send('Jatuh tempo tidak boleh sebelum tanggal pencatatan.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [created] = await conn.execute(`INSERT INTO finance_debts(record_type,scope,party_name,employee_id,user_id,purpose,site_code,principal_amount,issue_date,due_date,payment_method,installment_months,responsible_name,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [type, scope, party, employeeId, userId, purpose, site, principal, issueDate, dueDate, method, installmentMonths, responsible, notes, req.session.user.id]);
    const documentNumber=`HP-${issueDate.slice(0,7).replace('-','')}-${String(created.insertId).padStart(6,'0')}`;
    await conn.execute('UPDATE finance_debts SET document_number=? WHERE id=?',[documentNumber,created.insertId]);
    for (const item of items) await conn.execute('INSERT INTO finance_debt_items(debt_id,item_name,quantity,unit_price,notes) VALUES(?,?,?,?,?)', [created.insertId, item.name, item.quantity, item.unitPrice, item.notes]);
    await conn.commit();
    await audit({userId:req.session.user.id,action:'create',entityType:'finance_debt',entityId:created.insertId,description:`Dokumen hutang #${created.insertId} dibuat · ${type} ${scope} · ${party} · pokok Rp${principal.toLocaleString('id-ID')}`,ip:req.ip,details:{record_type:type,scope,party_name:party,principal_amount:principal,issue_date:issueDate,due_date:dueDate}});
    req.session.flash = { type: 'success', message: scope === 'INTERNAL'
      ? `${type === 'RECEIVABLE' ? 'Hutang' : 'Talangan'} ${party} berhasil dicatat.`
      : `${type === 'DEBT' ? 'Hutang' : 'Piutang'} berhasil dicatat.` };
    res.redirect(scope === 'INTERNAL' ? '/debts?scope=INTERNAL' : '/debts');
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/:id/edit',requireAdmin,async(req,res,next)=>{
  const id=Number(req.params.id);let conn;
  try{
    if(!Number.isInteger(id)||id<1)return res.status(400).send('Data tidak valid.');
    const b=req.body,reason=String(b.change_reason||'').trim().slice(0,500);
    if(!reason){req.session.flash={type:'danger',message:'Alasan perubahan wajib diisi untuk audit.'};return res.redirect(backTo(req));}
    const principal=amount(b.principal_amount),issueDate=validDate(b.issue_date)?String(b.issue_date):'',dueDate=validDate(b.due_date)?String(b.due_date):null;
    const site=['GLOBAL','CDS','KBG'].includes(String(b.site_code||'').toUpperCase())?String(b.site_code).toUpperCase():'GLOBAL';
    if(principal<=0||!issueDate||!String(b.purpose||'').trim())throw new Error('Pokok, tanggal, dan keperluan wajib diisi.');
    if(b.payment_method==='INSTALLMENT'&&Math.max(1,Math.min(60,Number(b.installment_months)||1))>principal)throw new Error('Jumlah cicilan melebihi nominal pokok.');
    if(dueDate&&dueDate<issueDate)throw new Error('Jatuh tempo tidak boleh sebelum tanggal pencatatan.');
    conn=await db.getConnection();await conn.beginTransaction();
    const [[before]]=await conn.execute('SELECT * FROM finance_debts WHERE id=? FOR UPDATE',[id]);if(!before)throw new Error('Data Hutang tidak ditemukan.');
    if(before.status==='ARCHIVED')throw new Error('Data arsip tidak dapat diedit.');
    const [[paid]]=await conn.execute('SELECT COALESCE(SUM(amount),0) total FROM finance_debt_payments WHERE debt_id=? AND voided_at IS NULL',[id]);
    if(principal<Number(paid.total||0))throw new Error('Pokok tidak boleh lebih kecil dari total pembayaran yang sudah tercatat.');
    // Changing the schedule after recorded installments would silently reassign payments.
    if(Number(paid.total)>0 && (principal!==amount(before.principal_amount)
      || String(issueDate)!==dateKey(before.issue_date)
      || String(dueDate||'')!==String(before.due_date?dateKey(before.due_date):'')
      || String(b.payment_method||'ONCE')!==String(before.payment_method)
      || (b.payment_method==='INSTALLMENT'?Math.max(1,Math.min(60,Number(b.installment_months)||1)):1)!==Number(before.installment_months||1))){
      throw new Error('Pokok, tanggal, dan jadwal cicilan tidak boleh diubah setelah ada pembayaran. Koreksi perlu proses audit khusus.');
    }
    await conn.execute(`UPDATE finance_debts SET purpose=?,site_code=?,principal_amount=?,issue_date=?,due_date=?,payment_method=?,installment_months=?,responsible_name=?,notes=?,updated_by=? WHERE id=?`,[
      String(b.purpose).trim().slice(0,255),site,principal,issueDate,dueDate,b.payment_method==='INSTALLMENT'?'INSTALLMENT':'ONCE',Math.max(1,Math.min(60,Number(b.installment_months)||1)),String(b.responsible_name||'').trim().slice(0,160)||null,String(b.notes||'').trim().slice(0,2000)||null,req.session.user.id,id]);
    await refreshStatus(conn,id);await conn.commit();
    await audit({userId:req.session.user.id,action:'update',entityType:'finance_debt',entityId:id,description:`${before.document_number||`HP-${id}`} diperbarui · alasan: ${reason}`,ip:req.ip,details:{reason,before,after:{purpose:b.purpose,site_code:site,principal_amount:principal,issue_date:issueDate,due_date:dueDate,payment_method:b.payment_method}}});
    req.session.flash={type:'success',message:`${before.document_number||'Dokumen'} berhasil diperbarui dan tercatat di audit trail.`};res.redirect(backTo(req));
  }catch(err){if(conn)await conn.rollback();req.session.flash={type:'danger',message:err.message};res.redirect(backTo(req));}finally{if(conn)conn.release();}
});

router.post('/:id/delete',requireAdmin,async(req,res,next)=>{
  const id=Number(req.params.id),reason=String(req.body.reason||'').trim().slice(0,500);let conn;
  try{
    if(!reason){req.session.flash={type:'danger',message:'Alasan hapus wajib diisi.'};return res.redirect(backTo(req));}
    conn=await db.getConnection();await conn.beginTransaction();
    const [[row]]=await conn.execute('SELECT * FROM finance_debts WHERE id=? FOR UPDATE',[id]);if(!row)throw new Error('Data tidak ditemukan.');
    const [[history]]=await conn.execute('SELECT COUNT(*) total FROM finance_debt_payments WHERE debt_id=?',[id]);
    if(Number(history.total)>0)throw new Error('Dokumen memiliki riwayat pembayaran dan tidak boleh dihapus. Gunakan Arsipkan.');
    await conn.execute('DELETE FROM finance_debts WHERE id=?',[id]);await conn.commit();
    await audit({userId:req.session.user.id,action:'delete',entityType:'finance_debt',entityId:id,description:`${row.document_number||`HP-${id}`} dihapus · alasan: ${reason}`,ip:req.ip,details:{reason,deleted:row}});
    req.session.flash={type:'success',message:'Dokumen tanpa riwayat pembayaran berhasil dihapus.'};res.redirect(backTo(req));
  }catch(err){if(conn)await conn.rollback();req.session.flash={type:'danger',message:err.message};res.redirect(backTo(req));}finally{if(conn)conn.release();}
});

async function recordPayment(req, res) {
  let conn;
  let saved = null;
  let committed = false;
  try {
    // The shared payment modal posts to a stable endpoint. Keep accepting the old
    // parameterised URL as well so bookmarks/older rendered pages remain valid.
    const id = Number(req.params.id || req.body.debt_id);
    const paid = amount(req.body.amount);
    const requestedInstallment = Number(req.body.installment_number || 0);
    const paymentDate = validDate(req.body.payment_date) ? req.body.payment_date : '';
    const method = String(req.body.payment_method || '').toLowerCase();
    if(!PAYMENT_METHODS.has(method))throw new Error('Metode pembayaran hutang/piutang hanya Cash atau Transfer.');
    const notes = String(req.body.notes || '').trim().slice(0, 500) || null;
    if (!Number.isInteger(id) || id < 1 || paid <= 0 || !paymentDate) {
      req.session.flash = { type: 'danger', message: 'Pembayaran tidak valid. Periksa nominal dan tanggal pembayaran.' };
      return res.redirect(backTo(req));
    }
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [[record]] = await conn.execute('SELECT id,status,principal_amount,record_type,site_code,payment_method,installment_months,issue_date,due_date FROM finance_debts WHERE id=? FOR UPDATE', [id]);
    if (!record) throw new Error('Data hutang/piutang tidak ditemukan.');
    const [previousPayments] = await conn.execute('SELECT id,amount,payment_date,installment_number FROM finance_debt_payments WHERE debt_id=? AND voided_at IS NULL ORDER BY payment_date,id', [id]);
    const paidTotal=previousPayments.reduce((n,p)=>n+amount(p.amount),0);
    const remaining=Math.max(0,amount(record.principal_amount)-paidTotal);
    const schedule=installmentSchedule({...record,due_date:record.due_date,issue_date:record.issue_date,
      payment_method:record.payment_method,installment_months:record.installment_months,payments:previousPayments});
    if (record.status === 'ARCHIVED') throw new Error('Data yang diarsipkan tidak dapat menerima pembayaran.');
    if (remaining <= 0) throw new Error('Dokumen ini sudah lunas dan tidak dapat menerima pembayaran baru.');
    if (paid > remaining) throw new Error(`Pembayaran melebihi sisa Rp ${remaining.toLocaleString('id-ID')}.`);
    // An older client without an explicit number defaults to the oldest unpaid installment.
    const selected=requestedInstallment===0?schedule.find(x=>x.remaining>0)?.number:requestedInstallment;
    if(!Number.isInteger(selected)||selected<1||selected>schedule.length)throw new Error('Nomor cicilan tidak valid.');
    const installment=schedule[selected-1];
    if(paid>installment.remaining)throw new Error(`Cicilan ke-${selected} tersisa Rp ${installment.remaining.toLocaleString('id-ID')}. Nominal melebihi sisa cicilan.`);
    // Debt tracking intentionally does NOT post to Data Kas or affect Closing.
    // Data Kas is entered manually after actual cash/transfer verification.
    // Attachment is saved only after every business-rule check has passed, so a rejected
    // payment (over the remaining balance, archived record, ...) never leaves an orphan file.
    if (req.file) saved = await saveDebtProof(req.file);
    const [posted] = await conn.execute('INSERT INTO finance_debt_payments(debt_id,installment_number,payment_date,amount,payment_method,notes,proof_path,proof_original_name,proof_mime,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [id,selected,paymentDate,paid,method,notes,saved?.filename||null,saved?.originalName||null,saved?.mime||null,req.session.user.id]);
    if(!posted.insertId)throw new Error('ID pembayaran hutang/piutang tidak tersedia; transaksi dibatalkan.');
    await financialAudit({conn,userId:req.session.user.id,action:'record_debt_installment',entityType:'finance_debt_payment',
      entityId:posted.insertId,before:null,after:{debt_id:id,installment_number:selected,amount:paid,payment_date:paymentDate,method},
      reason:'Pencatatan pembayaran cicilan hutang/piutang; kas dicatat manual terpisah',ip:req.ip});
    await refreshStatus(conn, id);
    await conn.commit();
    committed = true;
    // The authoritative financial audit was committed in the payment transaction.
    // Ancillary activity logging must not make a successfully posted payment look failed.
    await audit({userId:req.session.user.id,action:'payment',entityType:'finance_debt',entityId:id,description:`Pembayaran hutang #${id} Rp${paid.toLocaleString('id-ID')} dicatat`,ip:req.ip,details:{payment_date:paymentDate,amount:paid,method,installment_number:selected,has_proof:Boolean(saved)}}).catch(err=>console.error('Activity audit unavailable after committed payment:',err.message));
    req.session.flash = { type: 'success', message: `Pembayaran cicilan ke-${selected} berhasil dicatat. Data Kas tidak berubah; catat Cash/Transfer manual bila uang benar-benar berpindah.` };
    res.redirect(backTo(req));
  } catch (err) {
    if (conn && !committed) await conn.rollback();
    if (saved && !committed) await removeDebtProof(saved.filename);
    console.error('Gagal mencatat pembayaran hutang:', err.message);
    req.session.flash = { type: 'danger', message: err.message || 'Pembayaran gagal dicatat.' };
    res.redirect(backTo(req));
  } finally { if (conn) conn.release(); }
}

router.post('/payments', recordPayment);
router.post('/:id/payments', recordPayment);

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
    const reason=String(req.body.reason||'').trim().slice(0,500);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Data tidak valid.');
    if(!reason){req.session.flash={type:'danger',message:'Alasan arsip wajib diisi agar jejak audit lengkap.'};return res.redirect(backTo(req));}
    const [rows]=await db.execute('SELECT party_name,purpose,status FROM finance_debts WHERE id=? LIMIT 1',[id]);
    const [result] = await db.execute("UPDATE finance_debts SET status='ARCHIVED',archived_reason=?,archived_by=?,archived_at=NOW() WHERE id=? AND status<>'ARCHIVED'", [reason,req.session.user.id,id]);
    if (!result.affectedRows) return res.status(404).send('Data tidak ditemukan atau sudah diarsipkan.');
    await audit({userId:req.session.user.id,action:'archive',entityType:'finance_debt',entityId:id,description:`Dokumen hutang #${id} diarsipkan: ${reason}`,ip:req.ip,details:{reason,before:rows[0]||null}});
    req.session.flash = { type: 'success', message: 'Data dipindahkan ke arsip.' };
    res.redirect(backTo(req));
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
    const [[paymentRow]] = await conn.execute('SELECT * FROM finance_debt_payments WHERE id=? AND debt_id=? FOR UPDATE', [paymentId, id]);
    if(!paymentRow || paymentRow.voided_at)throw new Error('Pembayaran tidak ditemukan atau sudah dibatalkan.');
    const [[financing]] = await conn.execute('SELECT id FROM finance_debt_cash_movements WHERE debt_payment_id=? FOR UPDATE',[paymentId]);
    if(financing)throw new Error('Pembayaran legacy telah tercatat dalam ledger pembiayaan. Koreksi memerlukan review administrasi; histori lama tetap dilindungi.');
    const reason=String(req.body.reason||'').trim();
    if(reason.length<5)throw new Error('Alasan pembatalan pembayaran minimal 5 karakter wajib diisi.');
    const [removed] = await conn.execute('UPDATE finance_debt_payments SET voided_at=NOW(),voided_by=?,void_reason=? WHERE id=? AND debt_id=? AND voided_at IS NULL', [req.session.user.id,reason,paymentId, id]);
    if (!removed.affectedRows) { await conn.rollback(); return res.status(404).send('Riwayat pembayaran tidak ditemukan.'); }
    await refreshStatus(conn, id);
    await financialAudit({conn,userId:req.session.user.id,action:'void_debt_installment',entityType:'finance_debt_payment',
      entityId:paymentId,before:paymentRow,after:{voided:true,void_reason:reason},reason,ip:req.ip});
    await conn.commit();
    // Keep original proof and payment row permanently for audit.
    await audit({userId:req.session.user.id,action:'delete_payment',entityType:'finance_debt',entityId:id,description:`Pembayaran #${paymentId} pada dokumen hutang #${id} dibatalkan`,ip:req.ip,details:{payment_id:paymentId,had_proof:Boolean(removedProof)}}).catch(err=>console.error('Activity audit unavailable after committed void:',err.message));
    req.session.flash = { type: 'success', message: 'Pembayaran dibatalkan (histori dan bukti tetap tersimpan); sisa cicilan dihitung ulang.' };
    res.redirect(backTo(req));
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

module.exports = router;
module.exports.recordPayment = recordPayment;
module.exports.installmentSchedule = installmentSchedule;
