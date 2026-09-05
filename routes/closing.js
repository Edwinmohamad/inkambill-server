const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { createReportPdf, rupiah } = require('../services/reportPdf');
const { money, personKey, siteBlock, locationText, buildClosingCalculation } = require('../services/closingCalculator');

const router = express.Router();
const DEFAULT_CLOSING_PIN_SHA256 = 'cc819c3e680dd46370437a0224ea316438d27b869e090347a4b9af058d75886c';
const pinHash = () => String(process.env.CLOSING_PIN_SHA256 || DEFAULT_CLOSING_PIN_SHA256).trim().toLowerCase();
const pinTtlMs = () => {
  const configured = Number(process.env.CLOSING_PIN_TTL_MINUTES || 30);
  const minutes = Number.isFinite(configured) ? Math.max(5, Math.min(240, configured)) : 30;
  return minutes * 60 * 1000;
};
const localNext = (value) => {
  const path = String(value || '').trim();
  return path === '/closing' || path.startsWith('/closing/') ? path : '/closing';
};
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const dateOr = (value, fallback) => validDate(value) ? String(value) : fallback;

function pinMatches(pin) {
  const expected = pinHash();
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = crypto.createHash('sha256').update(String(pin || ''), 'utf8').digest();
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function closingUnlocked(req) {
  const unlockedAt = Number(req.session?.closingUnlockedAt || 0);
  return unlockedAt > 0 && Date.now() - unlockedAt < pinTtlMs();
}

function localDateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function selectedPeriod(req) {
  const now = new Date();
  const requestedMode = String(req.query.mode || req.body?.mode || 'auto').toLowerCase();
  const previousStart = localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const previousEnd = localDateKey(new Date(now.getFullYear(), now.getMonth(), 0));
  return {
    start: dateOr(req.query.from || req.body?.from, previousStart),
    end: dateOr(req.query.to || req.body?.to, previousEnd),
    mode: requestedMode === 'manual' ? 'manual' : 'auto',
    hideEdwin: String(req.query.hide_edwin || req.body?.hide_edwin || '') === '1'
  };
}

function normalizeSiteCluster(rawSite, rawCluster) {
  const inputSite = String(rawSite || 'CDS').trim().toUpperCase();
  const inputCluster = String(rawCluster || '').trim().toUpperCase();
  const legacyCluster = inputSite === 'KRW' || inputSite === 'CLM' ? inputSite : '';
  const site = legacyCluster ? 'CDS' : inputSite;
  if (!['CDS', 'KBG'].includes(site)) return null;
  const cluster = site === 'CDS' && ['KRW', 'CLM'].includes(legacyCluster || inputCluster)
    ? (legacyCluster || inputCluster)
    : null;
  return { site, cluster };
}

function manualIncomeRow(row) {
  return {
    paid_date: row.entry_date,
    customer_name: row.description || row.category,
    customer_code: 'MANUAL',
    site_code: row.site_code,
    site_name: row.site_code,
    cluster_name: row.cluster_name,
    amount: row.amount,
    method: 'manual',
    category: row.category,
    notes: row.description,
    source_type: 'closing_manual',
    entry_id: row.id
  };
}

function manualExpenseRow(row) {
  return {
    transaction_date: row.entry_date,
    name: row.category,
    category: row.category,
    site_code: row.site_code,
    site_name: row.site_code,
    cluster_name: row.cluster_name,
    amount: row.amount,
    notes: row.description,
    source_type: 'closing_manual',
    entry_id: row.id
  };
}

async function loadClosing(start, end, mode = 'auto') {
  const selectedMode = mode === 'manual' ? 'manual' : 'auto';
  const [[period]] = await db.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
  const closing = period || { status: 'DRAFT', manual_revenue: 0, manual_expense: 0, manual_carry: 0, manual_salary_agung: 500000, manual_salary_padilah: 1000000, notes: '' };

  if (period?.status === 'LOCKED' && period.snapshot_json) {
    try {
      const snapshot = JSON.parse(period.snapshot_json);
      if (snapshot && snapshot.blocks && Array.isArray(snapshot.payments) && Array.isArray(snapshot.expenses)) {
        return { ...snapshot, payments: snapshot.payments, expenses: snapshot.expenses, heldCash: Array.isArray(snapshot.heldCash) ? snapshot.heldCash : [], routerAssets: Array.isArray(snapshot.routerAssets) ? snapshot.routerAssets : [], adjustments: Array.isArray(snapshot.adjustments) ? snapshot.adjustments : [], lineItems: Array.isArray(snapshot.lineItems) ? snapshot.lineItems : [], salaryRows: Array.isArray(snapshot.salaryRows) ? snapshot.salaryRows : [], salaryByOwner: snapshot.salaryByOwner || {}, closing: period, period, lockedSnapshot: true };
      }
    } catch (err) { console.error('Snapshot Closing tidak valid, memakai data live:', err.message); }
  }

  const [payments] = await db.execute(`SELECT DATE(p.paid_at) paid_date,c.name customer_name,c.customer_code,s.code site_code,s.name site_name,cl.name cluster_name,p.amount,p.method,'billing' source_type FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE p.status='confirmed' AND DATE(p.paid_at) BETWEEN ? AND ? ORDER BY p.paid_at DESC,p.id DESC`, [start, end]);
  // Cash income that is not the automatic billing journal is a real closing
  // revenue. Billing/settlement journal rows are excluded because the
  // confirmed payment above already represents that customer payment.
  const [cashIncomes] = await db.execute(`SELECT ct.transaction_date paid_date,ct.name customer_name,'CASH' customer_code,COALESCE(s.code,'-') site_code,COALESCE(s.name,'-') site_name,NULL cluster_name,ct.amount,'cash' method,cc.name category,ct.notes,'cash_income' source_type FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id WHERE cc.type='income' AND COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND ct.transaction_date BETWEEN ? AND ? AND COALESCE(ct.source_type,'') NOT IN ('payment','install_income') AND cc.name NOT IN ('Pendapatan Billing','Setoran Cash Pelanggan') ORDER BY ct.transaction_date DESC,ct.id DESC`, [start, end]);
  const [expenses] = await db.execute(`SELECT ct.transaction_date,ct.name,cc.name category,COALESCE(s.code,'-') site_code,COALESCE(s.name,'-') site_name,ct.amount,ct.notes,'cash' source_type FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id WHERE cc.type='expense' AND COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND ct.transaction_date BETWEEN ? AND ? ORDER BY ct.transaction_date DESC,ct.id DESC`, [start, end]);
  const [heldCash] = await db.execute(`SELECT DATE(p.paid_at) paid_date,c.name customer_name,s.code site_code,s.name site_name,cl.name cluster_name,p.amount,COALESCE(u.name,'Belum diketahui') holder_name FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by) WHERE p.status='confirmed' AND p.method='cash' AND p.settlement_status='held_by_staff' AND DATE(p.paid_at) BETWEEN ? AND ? ORDER BY p.paid_at DESC,p.id DESC`, [start, end]);
  const [routerAssets] = await db.execute(`SELECT id,customer_name,site_code,cluster_name,owner_name,units,status,active_from,active_until,notes FROM closing_router_assets WHERE active_from<=? AND (active_until IS NULL OR active_until>=?) AND status IN ('ACTIVE','BROKEN','REPLACED') ORDER BY site_code,cluster_name,customer_name`, [end, start]);
  const [adjustments] = period ? await db.execute('SELECT * FROM closing_adjustments WHERE closing_id=? ORDER BY id', [period.id]) : [[]];
  const [lineItems] = period ? await db.execute('SELECT * FROM closing_entries WHERE closing_id=? ORDER BY entry_date DESC,id DESC', [period.id]) : [[]];
  let scopedPayments = payments.concat(cashIncomes);
  let scopedExpenses = expenses;
  if (selectedMode === 'manual') {
    scopedPayments = payments.concat(cashIncomes, lineItems.filter((row) => row.entry_type === 'INCOME').map(manualIncomeRow));
    scopedExpenses = expenses.concat(lineItems.filter((row) => row.entry_type === 'EXPENSE').map(manualExpenseRow));
  }
  const calculated = buildClosingCalculation({ payments: scopedPayments, expenses: scopedExpenses, heldCash, routerAssets, adjustments, closing, mode: selectedMode, lineItems });
  return { ...calculated, closing, period, payments: scopedPayments, expenses: scopedExpenses, heldCash, routerAssets, lockedSnapshot: false };
}

async function ensureDraftPeriod(conn, start, end, userId) {
  let [rows] = await conn.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? FOR UPDATE', [start, end]);
  if (rows.length) return rows[0];
  const [created] = await conn.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_salary_agung,manual_salary_padilah,created_by) VALUES(?,?,CURDATE(),?,?,?)', [start, end, 500000, 1000000, userId]);
  [rows] = await conn.execute('SELECT * FROM closing_periods WHERE id=? FOR UPDATE', [created.insertId]);
  return rows[0];
}

router.get('/unlock', (req, res) => {
  if (closingUnlocked(req)) return res.redirect(localNext(req.query.next));
  res.render('closing/unlock', { title: 'Buka Closing', pageTitle: 'Buka Closing', next: localNext(req.query.next) });
});

router.post('/unlock', (req, res) => {
  const now = Date.now();
  const lockedUntil = Number(req.session.closingPinLockedUntil || 0);
  const next = localNext(req.body?.next);
  if (lockedUntil > now) {
    req.session.flash = { type: 'danger', message: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((lockedUntil - now) / 60000)} menit.` };
    return res.redirect(`/closing/unlock?next=${encodeURIComponent(next)}`);
  }
  if (!pinMatches(req.body?.pin)) {
    const attempts = Number(req.session.closingPinAttempts || 0) + 1;
    req.session.closingPinAttempts = attempts;
    if (attempts >= 5) req.session.closingPinLockedUntil = now + 15 * 60 * 1000;
    req.session.flash = { type: 'danger', message: attempts >= 5 ? 'PIN salah 5 kali. Akses dikunci 15 menit.' : 'PIN Closing salah.' };
    return res.redirect(`/closing/unlock?next=${encodeURIComponent(next)}`);
  }
  delete req.session.closingPinAttempts;
  delete req.session.closingPinLockedUntil;
  req.session.closingUnlockedAt = now;
  return res.redirect(next);
});

router.use((req, res, next) => {
  if (closingUnlocked(req)) return next();
  delete req.session.closingUnlockedAt;
  return res.redirect(`/closing/unlock?next=${encodeURIComponent(localNext(req.originalUrl))}`);
});

router.get('/', async (req, res, next) => {
  try {
    const { start, end, mode, hideEdwin } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const data = await loadClosing(start, end, mode);
    res.render('closing/index', { title: 'Closing', pageTitle: 'Closing', pageSubtitle: `${start} s/d ${end}`, start, end, mode, hideEdwin, money, locationText, ...data });
  } catch (err) { next(err); }
});

router.post('/save', async (req, res, next) => {
  try {
    const { start, end } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const n = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const [[old]] = await db.execute('SELECT id,status FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
    if (old?.status === 'LOCKED') return res.status(409).send('Closing sudah dikunci.');
    const values = [Math.max(0, n(req.body.manual_revenue)), Math.max(0, n(req.body.manual_expense)), n(req.body.manual_carry), Math.max(0, n(req.body.manual_salary_agung, 500000)), Math.max(0, n(req.body.manual_salary_padilah, 1000000)), String(req.body.notes || '').slice(0, 2000)];
    if (old) await db.execute('UPDATE closing_periods SET manual_revenue=?,manual_expense=?,manual_carry=?,manual_salary_agung=?,manual_salary_padilah=?,notes=? WHERE id=?', [...values, old.id]);
    else await db.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_revenue,manual_expense,manual_carry,manual_salary_agung,manual_salary_padilah,notes,created_by) VALUES(?,?,CURDATE(),?,?,?,?,?,?,?)', [start, end, ...values, req.session.user.id]);
    req.session.flash = { type: 'success', message: 'Pengaturan Closing tersimpan.' };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { next(err); }
});

router.post('/entries', async (req, res, next) => {
  const { start, end } = selectedPeriod(req);
  let conn;
  try {
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const entryType = String(req.body.entry_type || '').trim().toUpperCase();
    if (!['INCOME', 'EXPENSE'].includes(entryType)) return res.status(400).send('Jenis transaksi tidak valid.');
    const site = normalizeSiteCluster(req.body.site_code, req.body.cluster_name);
    if (!site) return res.status(400).send('Lokasi hanya boleh CDS atau KBG.');
    const entryDate = validDate(req.body.entry_date) ? req.body.entry_date : '';
    if (!entryDate || entryDate < start || entryDate > end) return res.status(400).send('Tanggal transaksi harus berada di dalam periode closing.');
    const amount = money(req.body.amount);
    if (amount <= 0) return res.status(400).send('Nominal harus lebih besar dari nol.');
    const category = String(req.body.category || (entryType === 'INCOME' ? 'Pendapatan pelanggan' : '')).trim().slice(0, 120);
    if (!category) return res.status(400).send('Kategori wajib diisi.');
    const description = String(req.body.description || '').trim().slice(0, 255) || null;
    conn = await db.getConnection();
    await conn.beginTransaction();
    const period = await ensureDraftPeriod(conn, start, end, req.session.user.id);
    if (period.status === 'LOCKED') { await conn.rollback(); return res.status(409).send('Closing sudah dikunci.'); }
    await conn.execute('INSERT INTO closing_entries(closing_id,entry_type,site_code,cluster_name,category,amount,entry_date,description,created_by) VALUES(?,?,?,?,?,?,?,?,?)', [period.id, entryType, site.site, site.cluster, category, amount, entryDate, description, req.session.user.id]);
    await conn.commit();
    req.session.flash = { type: 'success', message: `${entryType === 'INCOME' ? 'Pendapatan' : 'Pengeluaran'} ditambahkan ke kalkulator.` };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/entries/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Transaksi tidak valid.');
    const [[entry]] = await db.execute('SELECT ce.id,cp.status FROM closing_entries ce JOIN closing_periods cp ON cp.id=ce.closing_id WHERE ce.id=? LIMIT 1', [id]);
    if (!entry) return res.status(404).send('Transaksi tidak ditemukan.');
    if (entry.status === 'LOCKED') return res.status(409).send('Closing sudah dikunci.');
    await db.execute('DELETE FROM closing_entries WHERE id=?', [id]);
    req.session.flash = { type: 'success', message: 'Baris kalkulator dihapus.' };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { next(err); }
});

router.post('/adjustments', async (req, res, next) => {
  const { start, end } = selectedPeriod(req);
  let conn;
  try {
    const recipient = String(req.body.recipient_name || '').trim();
    const direction = String(req.body.direction || '').trim().toUpperCase();
    const site = normalizeSiteCluster(req.body.site_code, '');
    const amount = money(req.body.amount);
    const description = String(req.body.description || '').trim().slice(0, 255) || null;
    if (!['Edwin', 'Jon', 'Bopung', 'Mang Ali'].includes(recipient)) return res.status(400).send('Penerima potongan tidak valid.');
    if (!['ADD', 'DEDUCT'].includes(direction)) return res.status(400).send('Arah penyesuaian tidak valid.');
    if (!site || amount <= 0) return res.status(400).send('Lokasi dan nominal penyesuaian wajib valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const period = await ensureDraftPeriod(conn, start, end, req.session.user.id);
    if (period.status === 'LOCKED') { await conn.rollback(); return res.status(409).send('Closing sudah dikunci.'); }
    await conn.execute('INSERT INTO closing_adjustments(closing_id,adjustment_type,site_code,recipient_name,amount,direction,description,created_by) VALUES(?,?,?,?,?,?,?,?)', [period.id, 'MANUAL', site.site, recipient, amount, direction, description, req.session.user.id]);
    await conn.commit();
    req.session.flash = { type: 'success', message: 'Potongan/penyesuaian per orang tersimpan.' };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/adjustments/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Penyesuaian tidak valid.');
    const [[adjustment]] = await db.execute('SELECT ca.id,cp.status FROM closing_adjustments ca JOIN closing_periods cp ON cp.id=ca.closing_id WHERE ca.id=? LIMIT 1', [id]);
    if (!adjustment) return res.status(404).send('Penyesuaian tidak ditemukan.');
    if (adjustment.status === 'LOCKED') return res.status(409).send('Closing sudah dikunci.');
    await db.execute('DELETE FROM closing_adjustments WHERE id=?', [id]);
    req.session.flash = { type: 'success', message: 'Penyesuaian dihapus.' };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { next(err); }
});

router.post('/router-assets', async (req, res, next) => {
  try {
    const { start, end } = selectedPeriod(req);
    const name = String(req.body.customer_name || '').trim().slice(0, 180);
    const owner = String(req.body.owner_name || '').trim().slice(0, 100);
    const date = validDate(req.body.active_from) ? req.body.active_from : '';
    const site = normalizeSiteCluster(req.body.site_code, req.body.cluster_name);
    const rawUnits = Number(req.body.units);
    const units = Number.isFinite(rawUnits) ? Math.max(1, Math.min(100, Math.floor(rawUnits))) : 1;
    if (!name || !owner || !date || !site) return res.status(400).send('Nama pelanggan, site, dan tanggal mulai wajib diisi.');
    if (date > end) return res.status(400).send('Tanggal mulai router tidak boleh setelah akhir periode closing.');
    await db.execute('INSERT INTO closing_router_assets(customer_name,site_code,cluster_name,owner_name,units,active_from,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?)', [name, site.site, site.cluster, owner, units, date, 'ACTIVE', String(req.body.notes || '').slice(0, 500), req.session.user.id]);
    req.session.flash = { type: 'success', message: 'Data INVEST ROUTER tersimpan.' };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { next(err); }
});

router.post('/router-assets/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('ID router tidak valid.');
    const allowed = new Set(['ACTIVE', 'BROKEN', 'REPLACED', 'INACTIVE']);
    const status = String(req.body.status || '').trim().toUpperCase();
    const until = validDate(req.body.active_until) ? req.body.active_until : null;
    if (!Number.isInteger(id) || id < 1 || !allowed.has(status)) return res.status(400).send('Status router tidak valid.');
    const [[asset]] = await db.execute('SELECT id,active_from FROM closing_router_assets WHERE id=? LIMIT 1', [id]);
    if (!asset) return res.status(404).send('Data router tidak ditemukan.');
    if (until && until < localDateKey(asset.active_from)) return res.status(400).send('Tanggal berakhir tidak boleh sebelum tanggal mulai.');
    await db.execute('UPDATE closing_router_assets SET status=?,active_until=? WHERE id=?', [status, status === 'ACTIVE' ? until : (until || localDateKey(new Date())), id]);
    req.session.flash = { type: 'success', message: `Status router diperbarui menjadi ${status}.` };
    res.redirect(`/closing?from=${start}&to=${end}&mode=manual`);
  } catch (err) { next(err); }
});

router.post('/lock', async (req, res, next) => {
  const { start, end, mode } = selectedPeriod(req);
  let conn;
  let committed = false;
  try {
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const [[existing]] = await db.execute('SELECT id,status FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
    if (existing?.status === 'LOCKED') return res.redirect(`/closing?from=${start}&to=${end}&mode=${mode}`);
    const preview = await loadClosing(start, end, mode);
    const unknown = preview.blocks.other || {};
    if (money(unknown.revenue) !== 0 || money(unknown.expense) !== 0) return res.status(409).send('Closing belum dapat dikunci: masih ada data lokasi belum dipetakan.');
    const snapshot = JSON.stringify({ mode: preview.mode, payments: preview.payments, expenses: preview.expenses, heldCash: preview.heldCash, routerAssets: preview.routerAssets, adjustments: preview.adjustments, lineItems: preview.lineItems, blocks: preview.blocks, salaryTotal: preview.salaryTotal, salaryByOwner: preview.salaryByOwner, salaryRows: preview.salaryRows, manualApplied: preview.manualApplied });
    conn = await db.getConnection();
    await conn.beginTransaction();
    let [rows] = await conn.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? FOR UPDATE', [start, end]);
    if (!rows.length && mode === 'auto') {
      const [created] = await conn.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_salary_agung,manual_salary_padilah,created_by) VALUES(?,?,CURDATE(),?,?,?)', [start, end, 500000, 1000000, req.session.user.id]);
      [rows] = await conn.execute('SELECT * FROM closing_periods WHERE id=? FOR UPDATE', [created.insertId]);
    }
    if (!rows.length) { await conn.rollback(); return res.status(400).send('Simpan pengaturan manual dahulu sebelum mengunci mode manual.'); }
    if (rows[0].status === 'LOCKED') { await conn.rollback(); return res.redirect(`/closing?from=${start}&to=${end}&mode=${mode}`); }
    await conn.execute("UPDATE closing_periods SET status='LOCKED',locked_by=?,locked_at=NOW() WHERE id=?", [req.session.user.id, rows[0].id]);
    await conn.execute('UPDATE closing_periods SET snapshot_json=? WHERE id=?', [snapshot, rows[0].id]);
    await conn.execute('INSERT INTO closing_audit_logs(closing_id,action,details_json,actor_id) VALUES(?,?,?,?)', [rows[0].id, 'LOCK', JSON.stringify({ start, end, mode }), req.session.user.id]);
    await conn.commit();
    committed = true;
    req.session.flash = { type: 'success', message: 'Closing berhasil dikunci.' };
    res.redirect(`/closing?from=${start}&to=${end}&mode=${mode}`);
  } catch (err) { if (conn && !committed) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

const PEOPLE = {
  edwin: { name: 'Edwin', watermark: 'KHUSUS EDWIN' },
  jon: { name: 'Jon', watermark: 'KHUSUS JON' },
  bopung: { name: 'Bopung', watermark: 'KHUSUS BOPUNG' },
  'mang-ali': { key: 'mang ali', name: 'Mang Ali', watermark: 'KHUSUS MANG ALI' }
};

function personFromReport(value) {
  const key = String(value || 'edwin').trim().toLowerCase();
  return PEOPLE[key] ? { reportKey: key, ...PEOPLE[key], key: PEOPLE[key].key || key } : null;
}

function recipientShare(block, key) {
  return (Array.isArray(block?.shares) ? block.shares : []).find((share) => personKey(share.name) === key) || null;
}

function addPersonDetailRows(rows, data, recipient, allowedBlocks = null) {
  const key = recipient.key;
  (data.heldCash || []).filter((row) => personKey(row.holder_name) === key && (!allowedBlocks || allowedBlocks.has(siteBlock(row.site_code, row.cluster_name, row.site_name)))).forEach((row) => rows.push({ type: 'POTONGAN CASH', lokasi: locationText(row), penerima: recipient.name, detail: `${row.paid_date} · ${row.customer_name} · cash belum setor`, nominal: `- ${rupiah(row.amount)}` }));
  (data.routerAssets || []).filter((row) => personKey(row.owner_name) === key && (!allowedBlocks || allowedBlocks.has(siteBlock(row.site_code, row.cluster_name)))).forEach((row) => {
    const value = Math.max(0, Number(row.units || 0)) * 20000;
    const active = String(row.status || '').toUpperCase() === 'ACTIVE';
    rows.push({ type: active ? 'INVEST ROUTER' : 'ROUTER TIDAK DIHITUNG', lokasi: locationText(row), penerima: recipient.name, detail: `${row.customer_name} · ${row.units} unit · ${row.status}`, nominal: active ? rupiah(value) : rupiah(0) });
  });
  const salary = money(data.salaryByOwner?.[key] || 0);
  if (salary) rows.push({ type: 'POTONGAN GAJI', lokasi: 'CDS', penerima: recipient.name, detail: 'Beban Agung + Padilah sesuai persentase', nominal: `- ${rupiah(salary)}` });
  (data.adjustments || []).filter((item) => personKey(item.recipient_name) === key && (!allowedBlocks || allowedBlocks.has(siteBlock(item.site_code || 'CDS')))).forEach((item) => {
    const deduct = String(item.direction || '').toUpperCase() === 'DEDUCT';
    rows.push({ type: deduct ? 'POTONGAN MANUAL' : 'TAMBAHAN MANUAL', lokasi: String(item.site_code || 'CDS').toUpperCase(), penerima: recipient.name, detail: item.description || 'Penyesuaian manual', nominal: `${deduct ? '- ' : ''}${rupiah(item.amount)}` });
  });
}

router.get('/pdf', async (req, res, next) => {
  try {
    const { start, end, mode, hideEdwin } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const recipient = personFromReport(req.query.report);
    if (!recipient) return res.status(400).send('Penerima PDF tidak valid.');
    const data = await loadClosing(start, end, mode);
    const effectiveMode = data.mode || mode;
    const rows = [];
    let grossTotal = 0;
    let netTotal = 0;
    const allowedBlocks = recipient.key === 'mang ali' ? new Set(['kbg']) : new Set(['krwclm', 'kbg']);
    [['krwclm', data.blocks.krwclm], ['kbg', data.blocks.kbg]].forEach(([blockKey, block]) => {
      if (!allowedBlocks.has(blockKey)) return;
      if (!block) return;
      rows.push({ type: 'RINGKASAN', lokasi: block.label, penerima: '', detail: `Pendapatan ${rupiah(block.revenue)} · Pengeluaran gabungan ${rupiah(block.expense)}`, nominal: rupiah(block.profit) });
      if (blockKey === 'krwclm') Object.entries(block.clusterRevenue || {}).forEach(([cluster, amount]) => rows.push({ type: 'SUBTOTAL CLUSTER', lokasi: `CDS / ${cluster}`, penerima: recipient.name, detail: 'Subtotal pendapatan cluster (bukan transaksi tambahan)', nominal: rupiah(amount) }));
      const share = recipientShare(block, recipient.key);
      if (share) {
        grossTotal += money(share.gross);
        netTotal += money(share.amount);
        rows.push({ type: 'PEMBAGIAN', lokasi: block.label, penerima: recipient.name, detail: `${share.percent}% · Kotor ${rupiah(share.gross)} · Bersih setelah penyesuaian`, nominal: rupiah(share.amount) });
      } else rows.push({ type: 'PEMBAGIAN', lokasi: block.label, penerima: recipient.name, detail: 'Tidak ada alokasi untuk penerima ini pada lokasi tersebut', nominal: rupiah(0) });
    });
    const unknownBlock = data.blocks.other;
    if (unknownBlock && (money(unknownBlock.revenue) !== 0 || money(unknownBlock.expense) !== 0)) {
      rows.push({ type: 'PERLU PEMETAAN', lokasi: unknownBlock.label, penerima: '', detail: 'Data ini tidak dihitung ke pembagian dan harus dipetakan sebelum closing dikunci', nominal: rupiah(unknownBlock.revenue - unknownBlock.expense) });
    }
    (data.payments || []).forEach((row) => {
      const blockKey = siteBlock(row.site_code, row.cluster_name, row.site_name);
      if (blockKey === 'other') {
        rows.push({ type: 'PENDAPATAN BELUM DIPETAKAN', lokasi: locationText(row), penerima: row.customer_name, detail: `${row.paid_date} · perbaiki site sebelum lock`, nominal: rupiah(row.amount) });
        return;
      }
      if (!allowedBlocks.has(blockKey)) return;
      const manual = row.source_type === 'closing_manual';
      rows.push({ type: 'PENDAPATAN', lokasi: locationText(row), penerima: row.customer_name, detail: manual ? `${row.paid_date} · ${row.category || 'Manual'}${row.notes ? ` · ${row.notes}` : ''}` : `${row.paid_date} · ${row.method || '-'}`, nominal: rupiah(row.amount) });
    });
    (data.expenses || []).forEach((row) => {
      const blockKey = siteBlock(row.site_code, row.site_name, row.cluster_name);
      if (blockKey === 'other') {
        rows.push({ type: 'PENGELUARAN BELUM DIPETAKAN', lokasi: locationText(row), penerima: row.name, detail: `${row.transaction_date} · perbaiki site sebelum lock`, nominal: rupiah(row.amount) });
        return;
      }
      if (!allowedBlocks.has(blockKey)) return;
      rows.push({ type: 'PENGELUARAN', lokasi: locationText(row), penerima: row.name, detail: `${row.transaction_date} · ${row.category}${row.notes ? ` · ${row.notes}` : ''}`, nominal: rupiah(row.amount) });
    });
    addPersonDetailRows(rows, data, recipient, allowedBlocks);
    const adjustmentTotal = netTotal - grossTotal;
    const hiddenNote = hideEdwin && recipient.key !== 'edwin' ? ' · bagian Edwin disembunyikan sesuai opsi' : '';
    createReportPdf(res, {
      title: `Closing ${recipient.name}`,
      subtitle: `Periode transaksi ${start} s/d ${end} · ${effectiveMode === 'manual' ? 'manual + koreksi' : 'otomatis dari billing'} · rincian penerima${hiddenNote}`,
      filename: `closing-${recipient.reportKey}-${start}-${end}-${effectiveMode}.pdf`,
      watermark: recipient.watermark,
      summaryItems: [{ label: 'Total Bruto', value: rupiah(grossTotal), color: '#3478F6' }, { label: 'Penyesuaian Bersih', value: rupiah(adjustmentTotal), color: adjustmentTotal < 0 ? '#FF433E' : '#F4B64D' }, { label: 'TOTAL DITERIMA', value: rupiah(netTotal), color: netTotal >= 0 ? '#18A979' : '#FF433E' }],
      columns: [{ label: 'Jenis', key: 'type', width: 1.25 }, { label: 'Lokasi', key: 'lokasi', width: 1.25 }, { label: 'Penerima/Keterangan', key: 'penerima', width: 1.8 }, { label: 'Detail', key: 'detail', width: 2.45 }, { label: 'Nominal', key: 'nominal', width: 1.25, align: 'right' }],
      rows
    });
  } catch (err) { next(err); }
});

module.exports = router;
