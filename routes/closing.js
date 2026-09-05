const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { createReportPdf, rupiah } = require('../services/reportPdf');

const router = express.Router();
// The default is only a bootstrap PIN. Production can replace it safely with
// CLOSING_PIN_SHA256 in .env without ever storing the PIN itself in the repo.
const DEFAULT_CLOSING_PIN_SHA256 = '8473ca7eb3c627759eb71312bb23245d76174f1f572d81163c98f7408448cf54';
const pinHash = () => String(process.env.CLOSING_PIN_SHA256 || DEFAULT_CLOSING_PIN_SHA256).trim().toLowerCase();
const pinTtlMs = () => { const configured = Number(process.env.CLOSING_PIN_TTL_MINUTES || 30); const minutes = Number.isFinite(configured) ? Math.max(5, Math.min(240, configured)) : 30; return minutes * 60 * 1000; };
const localNext = (value) => { const path = String(value || '').trim(); return path.startsWith('/closing') ? path : '/closing'; };
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
const money = (value) => { const numeric = Number(value); return Number.isFinite(numeric) ? Math.round(numeric) : 0; };
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const dateOr = (value, fallback) => validDate(value) ? String(value) : fallback;
const siteBlock = (code) => { const value = String(code || '').trim().toUpperCase(); if (value === 'KBG' || value.includes('KUBANG')) return 'kbg'; if (value === 'KRW' || value === 'CLM') return 'krwclm'; return 'other'; };
const personKey = (value) => { const name = String(value || '').trim().toLowerCase(); if (name.includes('edwin')) return 'edwin'; if (name.includes('jon') || name.includes('roni')) return 'jon'; if (name.includes('bopung') || name.includes('eko')) return 'bopung'; if (name.includes('ali')) return 'mang ali'; return name; };

async function loadClosing(start, end, mode = 'auto') {
  const selectedMode = mode === 'manual' ? 'manual' : 'auto';
  const manualMode = selectedMode === 'manual';
  const [[period]] = await db.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
  const closing = period || { status: 'DRAFT', manual_revenue: 0, manual_expense: 0, manual_carry: 0, manual_salary_agung: 500000, manual_salary_padilah: 1000000, notes: '' };
  // Once a period is locked, always read the immutable snapshot captured at
  // lock time. Later billing edits must not silently change a distributed PDF.
  if (period?.status === 'LOCKED' && period.snapshot_json) {
    try {
      const snapshot = JSON.parse(period.snapshot_json);
      if (snapshot && snapshot.blocks && Array.isArray(snapshot.payments) && Array.isArray(snapshot.expenses)) {
        return { ...snapshot, closing: period, period, lockedSnapshot: true };
      }
    } catch (err) { console.error('Snapshot Closing tidak valid, memakai data live:', err.message); }
  }
  const [payments] = await db.execute(`SELECT DATE(p.paid_at) paid_date,c.name customer_name,c.customer_code,s.code site_code,p.amount,p.method FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id WHERE p.status='confirmed' AND DATE(p.paid_at) BETWEEN ? AND ? ORDER BY p.paid_at DESC,p.id DESC`, [start, end]);
  const [expenses] = await db.execute(`SELECT ct.transaction_date,ct.name,cc.name category,COALESCE(s.code,'-') site_code,ct.amount,ct.notes FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id WHERE cc.type='expense' AND COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND ct.transaction_date BETWEEN ? AND ? ORDER BY ct.transaction_date DESC,ct.id DESC`, [start, end]);
  const [heldCash] = await db.execute(`SELECT DATE(p.paid_at) paid_date,c.name customer_name,s.code site_code,p.amount,COALESCE(u.name,'Belum diketahui') holder_name FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by) WHERE p.status='confirmed' AND p.method='cash' AND p.settlement_status='held_by_staff' AND DATE(p.paid_at) BETWEEN ? AND ? ORDER BY p.paid_at DESC,p.id DESC`, [start, end]);
  const [routerAssets] = await db.execute(`SELECT id,customer_name,site_code,owner_name,units,status,active_from,active_until,notes FROM closing_router_assets WHERE active_from<=? AND (active_until IS NULL OR active_until>=?) AND status IN ('ACTIVE','BROKEN','REPLACED') ORDER BY site_code,customer_name`, [end, start]);
  const [adjustments] = period ? await db.execute('SELECT * FROM closing_adjustments WHERE closing_id=? ORDER BY id', [period.id]) : [[]];
  const blocks = { krwclm: { label: 'KRW + CLM', revenue: 0, expense: 0 }, kbg: { label: 'KBG', revenue: 0, expense: 0 }, other: { label: 'Lokasi belum dipetakan', revenue: 0, expense: 0, shares: [] } };
  payments.forEach((row) => { blocks[siteBlock(row.site_code)].revenue += money(row.amount); });
  expenses.forEach((row) => { blocks[siteBlock(row.site_code)].expense += money(row.amount); });
  // Automatic mode is deliberately read-only from billing/cash. Manual mode
  // adds only the saved corrections, preventing accidental double counting.
  if (manualMode) {
    blocks.krwclm.revenue += money(closing.manual_revenue);
    blocks.krwclm.expense += money(closing.manual_expense);
  }
  Object.values(blocks).forEach((block) => { block.profit = block.revenue - block.expense; });
  if (manualMode) blocks.krwclm.profit += money(closing.manual_carry);
  const heldBy = new Map(); heldCash.forEach((row) => { const key = personKey(row.holder_name); heldBy.set(key, (heldBy.get(key) || 0) + money(row.amount)); });
  const routerByOwner = new Map(); routerAssets.forEach((row) => { if (row.status === 'ACTIVE') { const key = personKey(row.owner_name); routerByOwner.set(key, (routerByOwner.get(key) || 0) + Math.max(0, Number(row.units || 0)) * 20000); } });
  const salaryTotal = money(closing.manual_salary_agung) + money(closing.manual_salary_padilah);
  const salaryByOwner = { edwin: salaryTotal * .50, jon: salaryTotal * .25, bopung: salaryTotal * .25 };
  const adjusted = (name, gross, includeSalary = false) => { const key = personKey(name); let value = gross + (routerByOwner.get(key) || 0) - (heldBy.get(key) || 0); if (includeSalary) value -= salaryByOwner[key] || 0; adjustments.filter((item) => personKey(item.recipient_name) === key).forEach((item) => { value += item.direction === 'DEDUCT' ? -money(item.amount) : money(item.amount); }); return money(value); };
  blocks.krwclm.shares = [{ name: 'Edwin', percent: 50, gross: money(blocks.krwclm.profit * .50), amount: adjusted('Edwin', blocks.krwclm.profit * .50, true) }, { name: 'Jon', percent: 25, gross: money(blocks.krwclm.profit * .25), amount: adjusted('Jon', blocks.krwclm.profit * .25, true) }, { name: 'Bopung', percent: 25, gross: money(blocks.krwclm.profit * .25), amount: adjusted('Bopung', blocks.krwclm.profit * .25, true) }];
  const pool = blocks.kbg.profit * .65;
  blocks.kbg.shares = [{ name: 'Edwin', percent: 41.418, gross: money(pool * .6372), amount: adjusted('Edwin', pool * .6372) }, { name: 'Jon', percent: 11.791, gross: money(pool * .1814), amount: adjusted('Jon', pool * .1814) }, { name: 'Bopung', percent: 11.791, gross: money(pool * .1814), amount: adjusted('Bopung', pool * .1814) }, { name: 'Mang Ali', percent: 35, gross: money(blocks.kbg.profit * .35), amount: adjusted('Mang Ali', blocks.kbg.profit * .35) }];
  return { mode: selectedMode, closing, period, payments, expenses, heldCash, routerAssets, blocks, salaryTotal, salaryRows: [{ name: 'Agung', amount: money(closing.manual_salary_agung) }, { name: 'Padilah', amount: money(closing.manual_salary_padilah) }], manualApplied: manualMode, lockedSnapshot: false };
}

function localDateKey(value) { if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10); const date = value instanceof Date ? value : new Date(value); const pad = (number) => String(number).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function selectedPeriod(req) { const now = new Date(); const requestedMode = String(req.query.mode || req.body?.mode || 'auto').toLowerCase(); const previousStart = localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)); const previousEnd = localDateKey(new Date(now.getFullYear(), now.getMonth(), 0)); return { start: dateOr(req.query.from || req.body?.from, previousStart), end: dateOr(req.query.to || req.body?.to, previousEnd), mode: requestedMode === 'manual' ? 'manual' : 'auto' }; }

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

// Every Closing endpoint, including PDF and POST actions, requires a recent PIN unlock.
router.use((req, res, next) => {
  if (closingUnlocked(req)) return next();
  delete req.session.closingUnlockedAt;
  return res.redirect(`/closing/unlock?next=${encodeURIComponent(localNext(req.originalUrl))}`);
});

router.get('/', async (req, res, next) => { try { const { start, end, mode } = selectedPeriod(req); if (start > end) return res.status(400).send('Periode tidak valid.'); const data = await loadClosing(start, end, mode); res.render('closing/index', { title: 'Closing', pageTitle: 'Closing', pageSubtitle: `${start} s/d ${end}`, start, end, mode, money, ...data }); } catch (err) { next(err); } });

router.post('/save', async (req, res, next) => { try { const { start, end } = selectedPeriod(req); if (start > end) return res.status(400).send('Periode tidak valid.'); const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback; const [[old]] = await db.execute('SELECT id,status FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]); if (old?.status === 'LOCKED') return res.status(409).send('Closing sudah dikunci.'); const values = [Math.max(0,n(req.body.manual_revenue)), Math.max(0,n(req.body.manual_expense)), n(req.body.manual_carry), Math.max(0,n(req.body.manual_salary_agung,500000)), Math.max(0,n(req.body.manual_salary_padilah,1000000)), String(req.body.notes || '').slice(0,2000)]; if (old) await db.execute('UPDATE closing_periods SET manual_revenue=?,manual_expense=?,manual_carry=?,manual_salary_agung=?,manual_salary_padilah=?,notes=? WHERE id=?', [...values, old.id]); else await db.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_revenue,manual_expense,manual_carry,manual_salary_agung,manual_salary_padilah,notes,created_by) VALUES(?,?,CURDATE(),?,?,?,?,?,?,?)', [start,end,...values,req.session.user.id]); req.session.flash={type:'success',message:'Penyesuaian Closing tersimpan.'}; res.redirect(`/closing?from=${start}&to=${end}&mode=manual`); } catch (err) { next(err); } });

router.post('/router-assets', async (req, res, next) => { try { const { start, end }=selectedPeriod(req); const name=String(req.body.customer_name||'').trim().slice(0,180); const owner=String(req.body.owner_name||'').trim().slice(0,100); const date=validDate(req.body.active_from)?req.body.active_from:''; const site=String(req.body.site_code||'CLM').trim().toUpperCase().slice(0,30); const rawUnits=Number(req.body.units); const units=Number.isFinite(rawUnits)?Math.max(1,Math.min(100,Math.floor(rawUnits))):1; if(!name||!owner||!date)return res.status(400).send('Nama pelanggan, pemilik, dan tanggal mulai wajib diisi.'); await db.execute('INSERT INTO closing_router_assets(customer_name,site_code,owner_name,units,active_from,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?)',[name,site,owner,units,date,'ACTIVE',String(req.body.notes||'').slice(0,500),req.session.user.id]); req.session.flash={type:'success',message:'Data INVEST ROUTER tersimpan.'}; res.redirect(`/closing?from=${start}&to=${end}&mode=manual`); } catch(err){next(err);} });

router.post('/router-assets/:id/status', async (req, res, next) => { try { const id = Number(req.params.id); const { start, end } = selectedPeriod(req); const allowed = new Set(['ACTIVE', 'BROKEN', 'REPLACED', 'INACTIVE']); const status = String(req.body.status || '').trim().toUpperCase(); const until = validDate(req.body.active_until) ? req.body.active_until : null; if (!Number.isInteger(id) || id < 1 || !allowed.has(status)) return res.status(400).send('Status router tidak valid.'); const [[asset]] = await db.execute('SELECT id,active_from FROM closing_router_assets WHERE id=? LIMIT 1', [id]); if (!asset) return res.status(404).send('Data router tidak ditemukan.'); if (until && until < localDateKey(asset.active_from)) return res.status(400).send('Tanggal berakhir tidak boleh sebelum tanggal mulai.'); await db.execute('UPDATE closing_router_assets SET status=?,active_until=? WHERE id=?', [status, status === 'ACTIVE' ? until : (until || localDateKey(new Date())), id]); req.session.flash = { type: 'success', message: `Status router diperbarui menjadi ${status}.` }; res.redirect(`/closing?from=${start}&to=${end}&mode=manual`); } catch (err) { next(err); } });

router.post('/lock', async (req, res, next) => {
  const { start, end, mode } = selectedPeriod(req);
  let conn;
  let committed = false;
  try {
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const [[existing]] = await db.execute('SELECT id,status FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
    if (existing?.status === 'LOCKED') return res.redirect(`/closing?from=${start}&to=${end}&mode=${mode}`);
    const preview = await loadClosing(start, end, mode);
    const snapshot = JSON.stringify({ mode: preview.mode, payments: preview.payments, expenses: preview.expenses, heldCash: preview.heldCash, routerAssets: preview.routerAssets, blocks: preview.blocks, salaryTotal: preview.salaryTotal, salaryRows: preview.salaryRows, manualApplied: preview.manualApplied });
    conn = await db.getConnection();
    await conn.beginTransaction();
    let [rows] = await conn.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? FOR UPDATE', [start, end]);
    // Automatic mode can be locked directly. Manual mode still requires the
    // operator to save its correction form first so the intent is explicit.
    if (!rows.length && mode === 'auto') {
      const [created] = await conn.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_salary_agung,manual_salary_padilah,created_by) VALUES(?,?,CURDATE(),?,?,?)', [start, end, 500000, 1000000, req.session.user.id]);
      [rows] = await conn.execute('SELECT * FROM closing_periods WHERE id=? FOR UPDATE', [created.insertId]);
    }
    if (!rows.length) { await conn.rollback(); return res.status(400).send('Simpan penyesuaian dahulu sebelum mengunci mode manual.'); }
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

router.get('/pdf', async (req, res, next) => {
  try {
    const { start, end, mode } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const data = await loadClosing(start, end, mode);
    const effectiveMode = data.mode || mode;
    const rows = [];
    Object.values(data.blocks).forEach((block) => rows.push({ type: 'RINGKASAN', lokasi: block.label, penerima: '', detail: `Pendapatan ${rupiah(block.revenue)} · Pengeluaran ${rupiah(block.expense)}`, nominal: rupiah(block.profit) }));
    Object.values(data.blocks).forEach((block) => (block.shares || []).forEach((share) => rows.push({ type: 'PEMBAGIAN', lokasi: block.label, penerima: share.name, detail: `${share.percent}% · Kotor ${rupiah(share.gross)}`, nominal: rupiah(share.amount) })));
    rows.push(...data.payments.map((row) => ({ type: 'PEMBAYARAN', lokasi: row.site_code, penerima: row.customer_name, detail: `${row.paid_date} · ${row.method || '-'}`, nominal: rupiah(row.amount) })));
    rows.push(...data.expenses.map((row) => ({ type: 'PENGELUARAN', lokasi: row.site_code, penerima: row.name, detail: `${row.transaction_date} · ${row.category}${row.notes ? ` · ${row.notes}` : ''}`, nominal: rupiah(row.amount) })));
    rows.push(...data.heldCash.map((row) => ({ type: 'CASH BELUM SETOR', lokasi: row.site_code, penerima: row.holder_name, detail: `${row.paid_date} · ${row.customer_name}`, nominal: `- ${rupiah(row.amount)}` })));
    rows.push(...data.routerAssets.map((row) => ({ type: 'INVEST ROUTER', lokasi: row.site_code, penerima: row.owner_name, detail: `${row.customer_name} · ${row.units} unit · ${row.status}`, nominal: rupiah(Number(row.units || 0) * 20000) })));
    rows.push(...data.salaryRows.map((row) => ({ type: 'GAJI', lokasi: 'KRW + CLM', penerima: row.name, detail: 'Beban pembagian Edwin 50% · Jon 25% · Bopung 25%', nominal: rupiah(row.amount) })));
    if (effectiveMode === 'manual') rows.push({ type: 'KOREKSI MANUAL', lokasi: 'KRW + CLM', penerima: 'Penyesuaian tersimpan', detail: `Pendapatan +${rupiah(data.closing.manual_revenue)} · Pengeluaran +${rupiah(data.closing.manual_expense)} · Carry ${rupiah(data.closing.manual_carry)}`, nominal: rupiah(money(data.closing.manual_revenue) - money(data.closing.manual_expense) + money(data.closing.manual_carry)) });
    createReportPdf(res, { title: 'Closing INKAMNET', subtitle: `Periode transaksi ${start} s/d ${end} · Mode ${effectiveMode === 'manual' ? 'manual + koreksi' : 'otomatis dari billing'}`, filename: `closing-${start}-${end}-${effectiveMode}.pdf`, summaryItems: Object.values(data.blocks).map((block) => ({ label: `${block.label} · Laba Bersih`, value: rupiah(block.profit), color: block.profit >= 0 ? '#18A979' : '#FF433E' })), columns: [{ label: 'Jenis', key: 'type', width: 1.1 }, { label: 'Lokasi', key: 'lokasi', width: 1 }, { label: 'Penerima/Keterangan', key: 'penerima', width: 2 }, { label: 'Detail', key: 'detail', width: 2.4 }, { label: 'Nominal', key: 'nominal', width: 1.2, align: 'right' }], rows });
  } catch (err) { next(err); }
});

module.exports = router;
