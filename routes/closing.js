const express = require('express');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const db = require('../config/db');
const { createClosingReportPdf, rupiah, date } = require('../services/reportPdf');
const { money, personKey, siteBlock, locationText, normalizeSiteCluster, isPsbRevenue, buildClosingCalculation } = require('../services/closingCalculator');
const { syncCashDataIntoClosing, countPendingCashData, selectUnsyncedCashRows } = require('../services/closingSyncService');
const { requireMasterAdmin } = require('../middleware/auth');
const { financialAudit } = require('../services/financialControlService');

const router = express.Router();
router.use(requireMasterAdmin);
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

// v2.2 — shared helper: month that is `monthOffset` months away from the month
// containing dateStr (e.g. monthRange(end, 1) = bulan berikutnya, monthRange(start, -1)
// = bulan kemarin). Used both for the header quick-nav links and for "Kunci & Lanjut
// ke Bulan Berikutnya".
function monthRange(dateStr, monthOffset) {
  const base = new Date(`${dateStr}T00:00:00`);
  const rangeStart = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);
  const rangeEnd = new Date(base.getFullYear(), base.getMonth() + monthOffset + 1, 0);
  return { start: localDateKey(rangeStart), end: localDateKey(rangeEnd) };
}

function selectedPeriod(req) {
  const now = new Date();
  const previousStart = localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const previousEnd = localDateKey(new Date(now.getFullYear(), now.getMonth(), 0));
  return {
    start: dateOr(req.query.from || req.body?.from, previousStart),
    end: dateOr(req.query.to || req.body?.to, previousEnd),
    hideEdwin: String(req.query.hide_edwin || req.body?.hide_edwin || '') === '1'
  };
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
    entry_source: row.source_type === 'cash_sync' ? 'cash_sync' : 'manual',
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
    entry_source: row.source_type === 'cash_sync' ? 'cash_sync' : 'manual',
    entry_id: row.id
  };
}

async function loadClosing(start, end) {
  const [[period]] = await db.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
  const closing = period || { status: 'DRAFT', mode: 'MANUAL', manual_revenue: 0, manual_expense: 0, manual_carry: 0, manual_salary_agung: 500000, manual_salary_padilah: 1000000, notes: '' };
  const selectedMode = String(closing.mode || 'MANUAL').toUpperCase() === 'AUTO' ? 'auto' : 'manual';

  // v1.29 — Closing is fully flexible now: every period always recalculates from
  // the live rows below (no more frozen snapshot_json / LOCKED short-circuit), so
  // edits made after a period was previously marked LOCKED show up immediately.
  // v2 — Mode Manual: semua angka diketik lewat form di bawah. Mode Otomatis:
  // /closing/sync menarik transaksi Data Kas APPROVED ke closing_entries (masih
  // bisa diedit/ditambah manual di atasnya). Baik manual maupun sync selalu
  // masuk lewat closing_entries, jadi kalkulasi di bawah ini sama untuk keduanya.
  const [adjustments] = period ? await db.execute('SELECT * FROM closing_adjustments WHERE closing_id=? ORDER BY id', [period.id]) : [[]];
  const [allEntries] = period ? await db.execute('SELECT * FROM closing_entries WHERE closing_id=? ORDER BY entry_date DESC,id DESC', [period.id]) : [[]];
  // Baris cash_sync yang "dihapus" dari Closing ditandai excluded_at (soft-exclude,
  // lihat /entries/:id/delete) bukan benar-benar DELETE, supaya cash_transaction_id-nya
  // tetap dianggap "sudah pernah ditarik" dan tidak tertarik ulang membingungkan pada
  // sync berikutnya. Baris yang dikecualikan tidak ikut dihitung dan tidak tampil di
  // tabel utama — hanya di seksi terpisah dengan tombol pulihkan.
  const lineItems = allEntries.filter((row) => !row.excluded_at);
  const excludedItems = allEntries.filter((row) => row.excluded_at);
  const manualPayments = lineItems.filter((row) => row.entry_type === 'INCOME').map(manualIncomeRow);
  const manualExpenses = lineItems.filter((row) => row.entry_type === 'EXPENSE').map(manualExpenseRow);
  const calculated = buildClosingCalculation({ payments: manualPayments, expenses: manualExpenses, heldCash: [], adjustments, closing, mode: selectedMode, lineItems });
  const lastSyncedText = closing.last_synced_at ? localDateKey(closing.last_synced_at) + ' ' + new Date(closing.last_synced_at).toTimeString().slice(0, 5) : null;
  return { ...calculated, closing, period, payments: manualPayments, expenses: manualExpenses, heldCash: [], lastSyncedText, excludedItems };
}

async function ensureDraftPeriod(conn, start, end, userId) {
  let [rows] = await conn.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? FOR UPDATE', [start, end]);
  if (rows.length) {
    if (rows[0].status === 'LOCKED') throw new Error('Periode Closing sudah dikunci. Buka kembali periode sebelum mengubah data.');
    return rows[0];
  }
  const [created] = await conn.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_salary_agung,manual_salary_padilah,created_by) VALUES(?,?,CURDATE(),?,?,?)', [start, end, 500000, 1000000, userId]);
  [rows] = await conn.execute('SELECT * FROM closing_periods WHERE id=? FOR UPDATE', [created.insertId]);
  return rows[0];
}

async function assertClosingChildDraft(table, id) {
  if (!['closing_entries','closing_adjustments'].includes(table)) throw new Error('Tabel closing tidak valid.');
  const [[row]]=await db.execute(`SELECT cp.status FROM ${table} child JOIN closing_periods cp ON cp.id=child.closing_id WHERE child.id=? LIMIT 1`,[id]);
  if (!row) throw new Error('Data Closing tidak ditemukan.');
  if (row.status==='LOCKED') throw new Error('Periode Closing sudah dikunci. Buka kembali sebelum mengubah data.');
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

// v1.29 — informational only: never joined into buildClosingCalculation, so it
// can never change Pendapatan/Bersih. Purely a reminder of who still owes money
// as of the end of this closing period, scoped to the same CDS/KBG sites.
async function loadUnpaidCustomers(end) {
  try {
    const [rows] = await db.execute(`SELECT c.id,c.customer_code,c.name,s.code site_code,cl.name cluster_name,
        COUNT(i.id) invoice_count, COALESCE(SUM(i.outstanding),0) outstanding
      FROM invoices i
      JOIN customers c ON c.id=i.customer_id
      JOIN sites s ON s.id=c.site_id
      LEFT JOIN clusters cl ON cl.id=c.cluster_id
      WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND i.due_date<=? AND s.code IN ('CDS','KBG')
      GROUP BY c.id,c.customer_code,c.name,s.code,cl.name
      ORDER BY outstanding DESC LIMIT 100`, [end]);
    const outstanding = rows.reduce((a, r) => a + Number(r.outstanding || 0), 0);
    return { unpaidCustomers: rows, unpaidSummary: { count: rows.length, outstanding } };
  } catch (err) {
    console.error('Gagal memuat pelanggan belum lunas untuk Closing:', err.message);
    return { unpaidCustomers: [], unpaidSummary: { count: 0, outstanding: 0 } };
  }
}

// v2.5 — ringkasan aktivitas pelanggan riil untuk periode closing: berapa PSB
// (pemasangan baru), berapa pelanggan off (nonaktif), dan berapa tagihan yang
// sudah/belum dibayar pada periode ini. Murni informasi pendukung dari tabel
// customers/invoices — sama seperti loadUnpaidCustomers, TIDAK PERNAH ikut ke
// buildClosingCalculation sehingga tidak bisa mengubah angka pembagian hasil.
// Dikelompokkan per lokasi (CDS/KBG) memakai siteBlock() yang sama dengan
// kalkulator supaya konsisten dengan rincian di bawahnya.
function emptyActivityBucket() {
  return { total: 0, krwclm: 0, kbg: 0, other: 0, list: [] };
}
function monthPairsInRange(start, end) {
  const pairs = [];
  let cursor = new Date(`${start}T00:00:00`);
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const last = new Date(`${end}T00:00:00`);
  const lastStart = new Date(last.getFullYear(), last.getMonth(), 1);
  while (cursor <= lastStart) {
    pairs.push([cursor.getFullYear(), cursor.getMonth() + 1]);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return pairs;
}
async function loadCustomerActivitySummary(start, end) {
  const empty = () => ({
    psb: emptyActivityBucket(),
    off: emptyActivityBucket(),
    billing: { total: 0, paid: 0, unpaid: 0, krwclm: { paid: 0, unpaid: 0 }, kbg: { paid: 0, unpaid: 0 }, other: { paid: 0, unpaid: 0 }, billedTotal: 0, collectedTotal: 0, outstandingTotal: 0 }
  });
  try {
    const [psbRows] = await db.execute(`SELECT c.id,c.customer_code,c.name,c.activation_date,s.code site_code,cl.name cluster_name
        FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
        WHERE c.archived_at IS NULL AND c.customer_source='new_install' AND c.activation_date BETWEEN ? AND ?
        ORDER BY c.activation_date DESC,c.id DESC`, [start, end]);
    const psb = emptyActivityBucket();
    psb.list = psbRows;
    psbRows.forEach((row) => { psb.total += 1; psb[siteBlock(row.site_code, row.cluster_name)] += 1; });

    const [offRows] = await db.execute(`SELECT c.id,c.customer_code,c.name,c.customer_status,
        COALESCE(c.status_changed_at,c.updated_at,c.created_at) changed_at,s.code site_code,cl.name cluster_name
        FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
        WHERE c.archived_at IS NULL AND c.customer_status<>'active'
          AND COALESCE(c.status_changed_at,c.updated_at,c.created_at) BETWEEN ? AND ?
        ORDER BY changed_at DESC,c.id DESC`, [`${start} 00:00:00`, `${end} 23:59:59`]);
    const off = emptyActivityBucket();
    off.list = offRows;
    offRows.forEach((row) => { off.total += 1; off[siteBlock(row.site_code, row.cluster_name)] += 1; });

    const monthPairs = monthPairsInRange(start, end);
    const monthCond = monthPairs.map(() => '(i.period_year=? AND i.period_month=?)').join(' OR ');
    const monthParams = monthPairs.flat();
    const [billingRows] = monthPairs.length ? await db.execute(`SELECT s.code site_code,cl.name cluster_name,i.status,COUNT(*) cnt,
          COALESCE(SUM(i.total),0) total_amt,COALESCE(SUM(i.paid_amount),0) paid_amt,COALESCE(SUM(i.outstanding),0) outstanding_amt
        FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
        WHERE i.status NOT IN ('cancelled','refunded') AND (${monthCond})
        GROUP BY s.code,cl.name,i.status`, monthParams) : [[]];
    const billing = { total: 0, paid: 0, unpaid: 0, krwclm: { paid: 0, unpaid: 0 }, kbg: { paid: 0, unpaid: 0 }, other: { paid: 0, unpaid: 0 }, billedTotal: 0, collectedTotal: 0, outstandingTotal: 0 };
    billingRows.forEach((row) => {
      const blockKey = siteBlock(row.site_code, row.cluster_name);
      const isPaid = row.status === 'paid';
      const cnt = Number(row.cnt) || 0;
      billing.total += cnt;
      billing.billedTotal += Number(row.total_amt) || 0;
      billing.collectedTotal += Number(row.paid_amt) || 0;
      billing.outstandingTotal += Number(row.outstanding_amt) || 0;
      if (isPaid) { billing.paid += cnt; billing[blockKey].paid += cnt; }
      else { billing.unpaid += cnt; billing[blockKey].unpaid += cnt; }
    });

    return { psb, off, billing };
  } catch (err) {
    console.error('Gagal memuat ringkasan aktivitas pelanggan untuk Closing:', err.message);
    return empty();
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { start, end, hideEdwin } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const data = await loadClosing(start, end);
    const unpaid = await loadUnpaidCustomers(end);
    const customerActivity = await loadCustomerActivitySummary(start, end);
    // v2.1 — mode Otomatis + masih DRAFT: hitung berapa transaksi Data Kas yang
    // masih menunggu approval, dan berapa yang sudah APPROVED tapi belum ditarik,
    // supaya kelihatan di banner sebelum Master Admin sempat lupa sync.
    let pending = null;
    // v2.4 — estimasi pendapatan per orang di mode Otomatis, dihitung dari data
    // yang sudah tersimpan di closing_entries DITAMBAH transaksi Data Kas APPROVED
    // yang belum ditarik (persis apa yang akan masuk kalau tombol Sync ditekan
    // sekarang) — tanpa perlu klik Sync dulu buat lihat kira-kira siapa dapat
    // berapa. Estimasi murni buat pratinjau; tidak menulis apa pun ke database.
    let estimate = null;
    if (data.closing.mode === 'AUTO' && data.closing.status !== 'LOCKED') {
      pending = await countPendingCashData({ db, closingId: data.period ? data.period.id : null, start, end });
      const unsyncedRows = await selectUnsyncedCashRows({ db, closingId: data.period ? data.period.id : null, start, end });
      const extraPayments = [];
      const extraExpenses = [];
      unsyncedRows.forEach((row) => {
        const site = normalizeSiteCluster(row.site_code, null);
        const amount = money(row.amount);
        if (!site || amount <= 0) return;
        const entry = { site_code: site.site, cluster_name: site.cluster, amount, category: row.category_name || 'Lain-lain', description: [row.name, row.notes].filter(Boolean).join(' · ') || null };
        if (row.category_type === 'income') extraPayments.push(entry); else extraExpenses.push(entry);
      });
      const estimateCalc = buildClosingCalculation({
        payments: [...data.payments, ...extraPayments],
        expenses: [...data.expenses, ...extraExpenses],
        heldCash: [],
        adjustments: data.adjustments,
        closing: data.closing,
        mode: 'auto',
        lineItems: [...data.lineItems, ...extraPayments, ...extraExpenses]
      });
      const perPerson = new Map();
      [estimateCalc.blocks.krwclm, estimateCalc.blocks.kbg].forEach((block) => {
        (block.shares || []).forEach((share) => { perPerson.set(share.name, (perPerson.get(share.name) || 0) + money(share.amount)); });
      });
      estimate = {
        people: ['Edwin', 'Jon', 'Bopung', 'Mang Ali'].map((name) => ({ name, amount: perPerson.get(name) || 0 })),
        pendingCount: unsyncedRows.length
      };
    }
    // v2.2 — navigasi cepat bulan sebelumnya/berikutnya selalu tersedia (tidak
    // cuma waktu periode terkunci) supaya Master Admin tidak perlu ketik tanggal
    // manual buat pindah periode. Dihitung dari rentang periode yang sedang dilihat.
    const prevPeriod = monthRange(start, -1);
    const nextPeriod = monthRange(end, 1);
    // v2.3 — tren laba bersih dibanding bulan sebelumnya. Cuma dihitung kalau
    // periode sebelumnya memang pernah diisi (punya baris `closing_periods`),
    // supaya tidak menampilkan persentase yang menyesatkan waktu belum ada
    // data pembanding (mis. bulan pertama pakai aplikasi ini).
    const prevData = await loadClosing(prevPeriod.start, prevPeriod.end);
    let trend = null;
    if (prevData.period) {
      const pctChange = (current, previous) => {
        if (previous === 0) return current === 0 ? 0 : null;
        return ((current - previous) / Math.abs(previous)) * 100;
      };
      trend = {
        krwclm: pctChange(money(data.blocks.krwclm.profit), money(prevData.blocks.krwclm.profit)),
        kbg: pctChange(money(data.blocks.kbg.profit), money(prevData.blocks.kbg.profit)),
        prevLabel: `${prevPeriod.start} s/d ${prevPeriod.end}`
      };
    }
    res.render('closing/index', { title: 'Closing', pageTitle: 'Closing', pageSubtitle: `${start} s/d ${end}`, start, end, hideEdwin, money, locationText, pending, estimate, prevPeriod, nextPeriod, trend, customerActivity, ...data, ...unpaid });
  } catch (err) { next(err); }
});

router.post('/save', async (req, res, next) => {
  try {
    const { start, end } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const n = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const [[old]] = await db.execute('SELECT id,status,manual_revenue,manual_expense,manual_salary_agung,manual_salary_padilah FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
    if(old?.status==='LOCKED') throw new Error('Periode Closing sudah dikunci.');
    // v1.29 — Closing is always editable now; the previous LOCKED 409 guard here
    // (and on every entries/adjustments route below) has been removed on purpose.
    // The simplified manual form no longer sends legacy total fields. Preserve
    // those values when an older draft is edited so saving salary/notes cannot
    // silently erase a previous manual total. Detailed rows remain authoritative
    // once they exist (see buildClosingCalculation).
    const hasLegacyRevenue = Object.prototype.hasOwnProperty.call(req.body || {}, 'manual_revenue');
    const hasLegacyExpense = Object.prototype.hasOwnProperty.call(req.body || {}, 'manual_expense');
    const legacyRevenue = hasLegacyRevenue ? Math.max(0, n(req.body.manual_revenue)) : Math.max(0, n(old?.manual_revenue));
    const legacyExpense = hasLegacyExpense ? Math.max(0, n(req.body.manual_expense)) : Math.max(0, n(old?.manual_expense));
    const values = [legacyRevenue, legacyExpense, n(req.body.manual_carry), Math.max(0, n(req.body.manual_salary_agung, old?.manual_salary_agung ?? 500000)), Math.max(0, n(req.body.manual_salary_padilah, old?.manual_salary_padilah ?? 1000000)), String(req.body.notes || '').slice(0, 2000)];
    if (old) await db.execute('UPDATE closing_periods SET manual_revenue=?,manual_expense=?,manual_carry=?,manual_salary_agung=?,manual_salary_padilah=?,notes=? WHERE id=?', [...values, old.id]);
    else await db.execute('INSERT INTO closing_periods(period_start,period_end,closing_date,manual_revenue,manual_expense,manual_carry,manual_salary_agung,manual_salary_padilah,notes,created_by) VALUES(?,?,CURDATE(),?,?,?,?,?,?,?)', [start, end, ...values, req.session.user.id]);
    req.session.flash = { type: 'success', message: 'Pengaturan Closing tersimpan.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { next(err); }
});

// v2 — Mode per periode. Hanya boleh diganti selama periode masih DRAFT; begitu
// dikunci, mode ikut membeku bersama snapshot periode itu.
router.post('/mode', async (req, res, next) => {
  const { start, end } = selectedPeriod(req);
  const requested = String(req.body.mode || '').trim().toUpperCase();
  let conn;
  try {
    if (start > end) return res.status(400).send('Periode tidak valid.');
    if (!['MANUAL', 'AUTO'].includes(requested)) return res.status(400).send('Mode tidak valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const period = await ensureDraftPeriod(conn, start, end, req.session.user.id);
    const before = { mode: period.mode || 'MANUAL' };
    await conn.execute('UPDATE closing_periods SET mode=? WHERE id=?', [requested, period.id]);
    await financialAudit({ conn, userId: req.session.user.id, action: 'set_closing_mode', entityType: 'closing_period', entityId: period.id, before, after: { mode: requested }, reason: `Ganti mode closing periode ${start} s/d ${end}`, ip: req.ip });
    await conn.commit();
    req.session.flash = { type: 'success', message: `Mode closing diganti ke ${requested === 'AUTO' ? 'Otomatis (sinkron Data Kas)' : 'Manual'}.` };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

// v2 — Mode Otomatis: tarik transaksi Data Kas (cash_transactions) yang sudah
// APPROVED Master Admin ke closing_entries periode ini. Idempoten lewat
// cash_transaction_id (lihat services/closingSyncService.js) sehingga tombol ini
// aman ditekan berkali-kali — hanya transaksi baru yang belum pernah ditarik
// yang ditambahkan.
router.post('/sync', async (req, res, next) => {
  const { start, end } = selectedPeriod(req);
  let conn;
  try {
    if (start > end) return res.status(400).send('Periode tidak valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [[existing]] = await conn.execute('SELECT * FROM closing_periods WHERE period_start=? AND period_end=? FOR UPDATE', [start, end]);
    if (!existing) throw new Error('Aktifkan mode otomatis untuk periode ini terlebih dahulu sebelum sinkronisasi.');
    if (existing.status === 'LOCKED') throw new Error('Periode Closing sudah dikunci.');
    if (String(existing.mode || 'MANUAL').toUpperCase() !== 'AUTO') throw new Error('Aktifkan mode otomatis untuk periode ini terlebih dahulu sebelum sinkronisasi.');
    const result = await syncCashDataIntoClosing({ conn, closingId: existing.id, start, end, userId: req.session.user.id });
    await conn.execute('UPDATE closing_periods SET last_synced_at=NOW() WHERE id=?', [existing.id]);
    await financialAudit({ conn, userId: req.session.user.id, action: 'sync_closing_cash', entityType: 'closing_period', entityId: existing.id, before: {}, after: result, reason: `Sinkron Data Kas periode ${start} s/d ${end}`, ip: req.ip });
    await conn.commit();
    const parts = [];
    if (result.inserted) parts.push(`${result.inserted} transaksi ditarik dari Data Kas`);
    if (result.skippedUnmapped) parts.push(`${result.skippedUnmapped} dilewati (lokasi bukan CDS/KBG)`);
    req.session.flash = { type: result.inserted ? 'success' : 'warning', message: parts.length ? `${parts.join(', ')}.` : 'Tidak ada transaksi Data Kas baru untuk periode ini.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/period-lock', async (req, res, next) => {
  const { start, end } = selectedPeriod(req); let conn;
  try {
    conn=await db.getConnection();await conn.beginTransaction();
    const period=await ensureDraftPeriod(conn,start,end,req.session.user.id);
    // v2.1 — kalau mode AUTO, jangan biarkan periode dikunci padahal masih ada
    // transaksi Data Kas APPROVED yang belum ditarik (gampang kelewat kalau
    // approve-nya belakangan). Master Admin bisa tetap lanjut dengan menyentang
    // "kunci walau belum sync semua" di form kalau memang itu yang dimaksud.
    if (String(period.mode||'MANUAL').toUpperCase()==='AUTO' && String(req.body.force_lock||'')!=='1') {
      const pending = await countPendingCashData({ db: conn, closingId: period.id, start, end });
      if (pending.unsyncedApproved > 0) {
        throw new Error(`Masih ada ${pending.unsyncedApproved} transaksi Data Kas APPROVED yang belum disinkron ke periode ini. Klik "Sync dari Data Kas" dulu, atau centang "Kunci walau belum sync semua" kalau memang sengaja.`);
      }
    }
    const data=await loadClosing(start,end);
    const before={status:period.status};
    await conn.execute(`UPDATE closing_periods SET status='LOCKED',snapshot_json=?,locked_by=?,locked_at=NOW() WHERE id=?`,[JSON.stringify(data),req.session.user.id,period.id]);
    await financialAudit({conn,userId:req.session.user.id,action:'lock_period',entityType:'closing_period',entityId:period.id,before,after:{status:'LOCKED',period_start:start,period_end:end},reason:String(req.body.reason||'Closing periode selesai'),ip:req.ip});
    await conn.commit();req.session.flash={type:'success',message:`Periode ${start} s/d ${end} dikunci. Transaksi pada tanggal tersebut sekarang ditolak.`};
    // v2.2 — tombol "Kunci & Lanjut ke Bulan Berikutnya" kirim go_next=1 supaya
    // langsung diarahkan ke draft bulan berikutnya alih-alih tetap di periode yang
    // baru saja dikunci.
    const target = String(req.body.go_next||'')==='1' ? monthRange(end, 1) : { start, end };
    res.redirect(`/closing?from=${target.start}&to=${target.end}`);
  } catch(err){if(conn)await conn.rollback();next(err);} finally{if(conn)conn.release();}
});

router.post('/period-reopen', async (req, res, next) => {
  const { start, end } = selectedPeriod(req);const reason=String(req.body.reason||'').trim();let conn;
  try {
    if(reason.length<5)throw new Error('Alasan buka kembali wajib diisi minimal 5 karakter.');
    conn=await db.getConnection();await conn.beginTransaction();
    const [[period]]=await conn.execute(`SELECT * FROM closing_periods WHERE period_start=? AND period_end=? FOR UPDATE`,[start,end]);
    if(!period||period.status!=='LOCKED')throw new Error('Periode ini tidak sedang dikunci.');
    await conn.execute(`UPDATE closing_periods SET status='DRAFT',locked_by=NULL,locked_at=NULL WHERE id=?`,[period.id]);
    await financialAudit({conn,userId:req.session.user.id,action:'reopen_period',entityType:'closing_period',entityId:period.id,before:{status:'LOCKED'},after:{status:'DRAFT'},reason,ip:req.ip});
    await conn.commit();req.session.flash={type:'warning',message:`Periode ${start} s/d ${end} dibuka kembali.`};
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch(err){if(conn)await conn.rollback();next(err);} finally{if(conn)conn.release();}
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
    await conn.execute('INSERT INTO closing_entries(closing_id,entry_type,site_code,cluster_name,category,amount,entry_date,description,created_by) VALUES(?,?,?,?,?,?,?,?,?)', [period.id, entryType, site.site, site.cluster, category, amount, entryDate, description, req.session.user.id]);
    await conn.commit();
    req.session.flash = { type: 'success', message: `${entryType === 'INCOME' ? 'Pendapatan' : 'Pengeluaran'} ditambahkan ke kalkulator.` };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/entries/:id/update', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Transaksi tidak valid.');
    await assertClosingChildDraft('closing_entries',id);
    const [[entry]] = await db.execute('SELECT id,entry_type FROM closing_entries WHERE id=? LIMIT 1', [id]);
    if (!entry) return res.status(404).send('Transaksi tidak ditemukan.');
    const site = normalizeSiteCluster(req.body.site_code, req.body.cluster_name);
    if (!site) return res.status(400).send('Lokasi hanya boleh CDS atau KBG.');
    const entryDate = validDate(req.body.entry_date) ? req.body.entry_date : '';
    if (!entryDate) return res.status(400).send('Tanggal tidak valid.');
    const amount = money(req.body.amount);
    if (amount <= 0) return res.status(400).send('Nominal harus lebih besar dari nol.');
    const category = String(req.body.category || (entry.entry_type === 'INCOME' ? 'Pendapatan pelanggan' : '')).trim().slice(0, 120);
    if (!category) return res.status(400).send('Kategori wajib diisi.');
    const description = String(req.body.description || '').trim().slice(0, 255) || null;
    await db.execute('UPDATE closing_entries SET site_code=?,cluster_name=?,category=?,amount=?,entry_date=?,description=? WHERE id=?', [site.site, site.cluster, category, amount, entryDate, description, id]);
    req.session.flash = { type: 'success', message: 'Baris kalkulator diperbarui.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { next(err); }
});

// Baris hasil sinkron Data Kas (source_type='cash_sync') tidak boleh benar-benar
// DELETE: cash_transaction_id-nya harus tetap "terpakai" supaya Sync berikutnya
// tidak menariknya lagi (lihat services/closingSyncService.js). Jadi baris itu
// cuma ditandai excluded_at (soft-exclude) — hilang dari tabel utama & kalkulasi,
// tapi masih ada di DB dan bisa dipulihkan lewat /entries/:id/restore. Baris
// manual (diketik sendiri) tidak punya isu ini, jadi tetap DELETE biasa.
router.post('/entries/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Transaksi tidak valid.');
    await assertClosingChildDraft('closing_entries',id);
    const [[entry]] = await db.execute('SELECT id,source_type FROM closing_entries WHERE id=? LIMIT 1', [id]);
    if (!entry) return res.status(404).send('Transaksi tidak ditemukan.');
    if (entry.source_type === 'cash_sync') {
      await db.execute('UPDATE closing_entries SET excluded_at=NOW(),excluded_by=? WHERE id=?', [req.session.user.id, id]);
      req.session.flash = { type: 'success', message: 'Baris hasil sinkron dikecualikan dari perhitungan. Bisa dipulihkan kapan saja di bagian "Baris dikecualikan" kalau berubah pikiran.' };
    } else {
      await db.execute('DELETE FROM closing_entries WHERE id=?', [id]);
      req.session.flash = { type: 'success', message: 'Baris kalkulator dihapus.' };
    }
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { next(err); }
});

router.post('/entries/:id/restore', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Transaksi tidak valid.');
    await assertClosingChildDraft('closing_entries',id);
    const [[entry]] = await db.execute("SELECT id FROM closing_entries WHERE id=? AND source_type='cash_sync' AND excluded_at IS NOT NULL LIMIT 1", [id]);
    if (!entry) return res.status(404).send('Baris dikecualikan tidak ditemukan.');
    await db.execute('UPDATE closing_entries SET excluded_at=NULL,excluded_by=NULL WHERE id=?', [id]);
    req.session.flash = { type: 'success', message: 'Baris dipulihkan dan ikut dihitung lagi.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { next(err); }
});

router.post('/adjustments', async (req, res, next) => {
  const { start, end } = selectedPeriod(req);
  let conn;
  try {
    const recipient = String(req.body.recipient_name || '').trim();
    const direction = String(req.body.direction || '').trim().toUpperCase();
    const adjustmentType = ['CASH_HOLD', 'MANUAL'].includes(String(req.body.adjustment_type || '').trim().toUpperCase())
      ? String(req.body.adjustment_type).trim().toUpperCase()
      : 'MANUAL';
    const site = normalizeSiteCluster(req.body.site_code, '');
    const amount = money(req.body.amount);
    const description = String(req.body.description || '').trim().slice(0, 255) || null;
    if (!['Edwin', 'Jon', 'Bopung', 'Mang Ali'].includes(recipient)) return res.status(400).send('Penerima potongan tidak valid.');
    if (!['ADD', 'DEDUCT'].includes(direction)) return res.status(400).send('Arah penyesuaian tidak valid.');
    if (adjustmentType === 'CASH_HOLD' && direction !== 'DEDUCT') return res.status(400).send('Cash belum setor harus menjadi potongan.');
    if (!site || amount <= 0) return res.status(400).send('Lokasi dan nominal penyesuaian wajib valid.');
    conn = await db.getConnection();
    await conn.beginTransaction();
    const period = await ensureDraftPeriod(conn, start, end, req.session.user.id);
    await conn.execute('INSERT INTO closing_adjustments(closing_id,adjustment_type,site_code,recipient_name,amount,direction,description,created_by) VALUES(?,?,?,?,?,?,?,?)', [period.id, adjustmentType, site.site, recipient, amount, direction, description, req.session.user.id]);
    await conn.commit();
    req.session.flash = { type: 'success', message: 'Potongan/penyesuaian per orang tersimpan.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { if (conn) await conn.rollback(); next(err); } finally { if (conn) conn.release(); }
});

router.post('/adjustments/:id/update', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Penyesuaian tidak valid.');
    await assertClosingChildDraft('closing_adjustments',id);
    const [[adjustment]] = await db.execute('SELECT id FROM closing_adjustments WHERE id=? LIMIT 1', [id]);
    if (!adjustment) return res.status(404).send('Penyesuaian tidak ditemukan.');
    const recipient = String(req.body.recipient_name || '').trim();
    const direction = String(req.body.direction || '').trim().toUpperCase();
    const adjustmentType = ['CASH_HOLD', 'MANUAL'].includes(String(req.body.adjustment_type || '').trim().toUpperCase())
      ? String(req.body.adjustment_type).trim().toUpperCase()
      : 'MANUAL';
    const site = normalizeSiteCluster(req.body.site_code, '');
    const amount = money(req.body.amount);
    const description = String(req.body.description || '').trim().slice(0, 255) || null;
    if (!['Edwin', 'Jon', 'Bopung', 'Mang Ali'].includes(recipient)) return res.status(400).send('Penerima potongan tidak valid.');
    if (!['ADD', 'DEDUCT'].includes(direction)) return res.status(400).send('Arah penyesuaian tidak valid.');
    if (adjustmentType === 'CASH_HOLD' && direction !== 'DEDUCT') return res.status(400).send('Cash belum setor harus menjadi potongan.');
    if (!site || amount <= 0) return res.status(400).send('Lokasi dan nominal penyesuaian wajib valid.');
    await db.execute('UPDATE closing_adjustments SET adjustment_type=?,site_code=?,recipient_name=?,amount=?,direction=?,description=? WHERE id=?', [adjustmentType, site.site, recipient, amount, direction, description, id]);
    req.session.flash = { type: 'success', message: 'Penyesuaian diperbarui.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { next(err); }
});

router.post('/adjustments/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { start, end } = selectedPeriod(req);
    if (!Number.isInteger(id) || id < 1) return res.status(400).send('Penyesuaian tidak valid.');
    await assertClosingChildDraft('closing_adjustments',id);
    const [[adjustment]] = await db.execute('SELECT id FROM closing_adjustments WHERE id=? LIMIT 1', [id]);
    if (!adjustment) return res.status(404).send('Penyesuaian tidak ditemukan.');
    await db.execute('DELETE FROM closing_adjustments WHERE id=?', [id]);
    req.session.flash = { type: 'success', message: 'Penyesuaian dihapus.' };
    res.redirect(`/closing?from=${start}&to=${end}`);
  } catch (err) { next(err); }
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

// v2.5 — susun ringkasan PSB/off/bayar-belum bayar per lokasi (hanya lokasi yang
// memang berlaku untuk penerima PDF ini) supaya bisa dirender sebagai tabel kecil
// di PDF, persis seperti blocks[] pada drawLocationShareCards.
function buildCustomerActivityRows(customerActivity, allowedBlocks) {
  const labels = { krwclm: 'CDS', kbg: 'KBG' };
  return ['krwclm', 'kbg'].filter((key) => allowedBlocks.has(key)).map((key) => ({
    lokasi: labels[key],
    psb: (customerActivity.psb && customerActivity.psb[key]) || 0,
    off: (customerActivity.off && customerActivity.off[key]) || 0,
    bayar: (customerActivity.billing && customerActivity.billing[key] && customerActivity.billing[key].paid) || 0,
    belumBayar: (customerActivity.billing && customerActivity.billing[key] && customerActivity.billing[key].unpaid) || 0
  }));
}

// v1.29 — replaces the old flat addPersonDetailRows()/rows[] builder. Builds the
// structured {blocks, adjustmentRows, transactionRows} shape the redesigned
// createClosingReportPdf() renders as separate sections instead of one long table.
function buildAdjustmentRows(data, recipient, allowedBlocks) {
  const key = recipient.key;
  const rows = [];
  const salary = money(data.salaryByOwner?.[key] || 0);
  if (salary && allowedBlocks.has('krwclm')) {
    const salaryPercent = key === 'edwin' ? 50 : (key === 'jon' || key === 'bopung') ? 25 : 0;
    rows.push({ jenis: 'Potongan gaji', lokasi: 'CDS', keterangan: `${salaryPercent}% dari total gaji Agung + Padilah (${rupiah(data.salaryTotal)}) — Agung ${rupiah(money(data.closing.manual_salary_agung))}, Padilah ${rupiah(money(data.closing.manual_salary_padilah))}`, nominal: -salary });
  }
  (data.adjustments || []).filter((item) => personKey(item.recipient_name) === key && allowedBlocks.has(siteBlock(item.site_code || 'CDS'))).forEach((item) => {
    const deduct = String(item.direction || '').toUpperCase() === 'DEDUCT';
    const jenis = String(item.adjustment_type || '').toUpperCase() === 'CASH_HOLD'
      ? 'Cash belum setor'
      : (deduct ? 'Potongan manual' : 'Tambahan manual');
    rows.push({ jenis, lokasi: String(item.site_code || 'CDS').toUpperCase(), keterangan: item.description || (jenis === 'Cash belum setor' ? 'Cash belum disetor' : 'Penyesuaian manual'), nominal: deduct ? -money(item.amount) : money(item.amount) });
  });
  return rows;
}
function buildTransactionRows(data, allowedBlocks, periodStart, periodEnd) {
  const rows = [];
  const periodLabel = `${date(periodStart)} - ${date(periodEnd)}`;
  // v1.30 — pendapatan pelanggan tidak lagi dirinci per transaksi di PDF (bisa
  // puluhan baris per bulan hasil sync Data Kas); digabung jadi satu baris total
  // per LOKASI (CDS/KRW, CDS/CLM, dan KBG masing-masing baris sendiri — bukan
  // digabung jadi satu baris CDS) supaya output PDF ringkas. Jumlah transaksi
  // yang digabung tetap dicatat di keterangan sebagai jejak audit.
  // v2.5 — pendapatan PSB (uang masuk pemasangan baru) dipisah dari pendapatan
  // langganan biasa, jadi bisa langsung dibandingkan dengan baris "Komisi
  // instalasi (PSB)" di bawah.
  // v2.6 — deteksi PSB sekarang pakai isPsbRevenue() terpusat dari
  // closingCalculator (sebelumnya /psb|pasang baru/i lokal di sini tidak pernah
  // cocok dengan kategori hasil sync "Pendapatan Pemasangan Baru", jadi
  // pendapatan PSB selalu kebaur ke "Pembayaran pelanggan" biasa). Pengeluaran
  // juga sekarang digabung per KATEGORI + lokasi (bukan lagi satu baris per
  // transaksi mentah) supaya tabel "Rincian Pendapatan & Pengeluaran" tetap
  // ringkas dan enak dibaca, konsisten dengan cara pendapatan sudah digabung.
  const incomeTotals = new Map();
  const incomeOrder = [];
  const psbRevenueTotals = new Map();
  const psbRevenueOrder = [];
  (data.payments || []).forEach((row) => {
    const blockKey = siteBlock(row.site_code, row.cluster_name, row.site_name);
    if (!allowedBlocks.has(blockKey)) return;
    const label = locationText(row);
    const amount = money(row.amount);
    const totals = isPsbRevenue(row.category) ? psbRevenueTotals : incomeTotals;
    const order = isPsbRevenue(row.category) ? psbRevenueOrder : incomeOrder;
    if (!totals.has(label)) { totals.set(label, { total: 0, count: 0 }); order.push(label); }
    const entry = totals.get(label);
    entry.total += amount;
    entry.count += 1;
  });
  incomeOrder.forEach((label) => {
    const entry = incomeTotals.get(label);
    rows.push({ tanggal: periodLabel, lokasi: label, jenis: 'Pendapatan', keterangan: `Pembayaran pelanggan · ${entry.count} transaksi`, nominal: entry.total });
  });
  psbRevenueOrder.forEach((label) => {
    const entry = psbRevenueTotals.get(label);
    rows.push({ tanggal: periodLabel, lokasi: label, jenis: 'Pendapatan', keterangan: `Pendapatan PSB (pemasangan baru) · ${entry.count} pelanggan`, nominal: entry.total });
  });
  const isInstallationCommission = (category) => /psb|komisi|instalasi/i.test(String(category || ''));
  const expenseTotals = new Map();
  const expenseOrder = [];
  (data.expenses || []).forEach((row) => {
    const blockKey = siteBlock(row.site_code, row.site_name, row.cluster_name);
    if (!allowedBlocks.has(blockKey)) return;
    const label = locationText(row);
    const categoryLabel = isInstallationCommission(row.category) ? 'Komisi instalasi (PSB)' : (String(row.category || 'Lain-lain').trim() || 'Lain-lain');
    const key = `${label}\u0001${categoryLabel}`;
    if (!expenseTotals.has(key)) { expenseTotals.set(key, { label, categoryLabel, total: 0, count: 0 }); expenseOrder.push(key); }
    const entry = expenseTotals.get(key);
    entry.total += money(row.amount);
    entry.count += 1;
  });
  const expenseRows = expenseOrder.map((key) => {
    const entry = expenseTotals.get(key);
    return { tanggal: periodLabel, lokasi: entry.label, jenis: 'Pengeluaran', keterangan: `${entry.categoryLabel} · ${entry.count} transaksi`, nominal: entry.total };
  }).sort((a, b) => b.nominal - a.nominal);
  return [...rows, ...expenseRows];
}

router.get('/pdf', async (req, res, next) => {
  try {
    const { start, end, hideEdwin } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const recipient = personFromReport(req.query.report);
    if (!recipient) return res.status(400).send('Penerima PDF tidak valid.');
    const data = await loadClosing(start, end);
    const customerActivity = await loadCustomerActivitySummary(start, end);
    const effectiveMode = data.mode || 'manual';
    let grossTotal = 0;
    let netTotal = 0;
    const allowedBlocks = recipient.key === 'mang ali' ? new Set(['kbg']) : new Set(['krwclm', 'kbg']);
    const blocks = [];
    [['krwclm', data.blocks.krwclm], ['kbg', data.blocks.kbg]].forEach(([blockKey, block]) => {
      if (!allowedBlocks.has(blockKey) || !block) return;
      const share = recipientShare(block, recipient.key);
      if (share) { grossTotal += money(share.gross); netTotal += money(share.amount); }
      blocks.push({ label: block.label, revenue: block.revenue, expense: block.expense, profit: block.profit, share, psbRevenue: block.psbRevenue, subscriptionRevenue: block.subscriptionRevenue, clusterRevenue: block.clusterRevenue, expenseByCategory: block.expenseByCategory });
    });
    const adjustmentRows = buildAdjustmentRows(data, recipient, allowedBlocks);
    const transactionRows = buildTransactionRows(data, allowedBlocks, start, end);
    const customerActivityRows = buildCustomerActivityRows(customerActivity, allowedBlocks);
    const adjustmentTotal = netTotal - grossTotal;
    const hiddenNote = hideEdwin && recipient.key !== 'edwin' ? ' · bagian Edwin disembunyikan sesuai opsi' : '';
    createClosingReportPdf(res, {
      title: `Closing ${recipient.name}`,
      subtitle: `Periode transaksi ${start} s/d ${end} · input manual · rincian penerima${hiddenNote}`,
      filename: `closing-${recipient.reportKey}-${start}-${end}-${effectiveMode}.pdf`,
      watermark: recipient.watermark,
      recipientName: recipient.name,
      summaryItems: [{ label: 'Total Bruto', value: rupiah(grossTotal), color: '#3478F6' }, { label: 'Penyesuaian Bersih', value: `${adjustmentTotal < 0 ? '- ' : '+ '}${rupiah(Math.abs(adjustmentTotal))}`, color: adjustmentTotal < 0 ? '#FF433E' : '#18A979' }, { label: 'TOTAL DITERIMA', value: rupiah(netTotal), color: netTotal >= 0 ? '#18A979' : '#FF433E' }],
      blocks,
      adjustmentRows,
      transactionRows,
      customerActivityRows
    });
  } catch (err) { next(err); }
});

// v1.29 — monthly recap/monitoring: lists every closing period (filterable by
// year/month) with its computed totals, so past months can be reviewed without
// re-opening each one individually.
router.get('/history', async (req, res, next) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = req.query.month ? Number(req.query.month) : null;
    const [periods] = await db.execute('SELECT id,period_start,period_end FROM closing_periods ORDER BY period_start DESC LIMIT 200');
    const filtered = periods.filter((p) => {
      const key = localDateKey(p.period_start);
      const y = Number(key.slice(0, 4));
      const m = Number(key.slice(5, 7));
      return y === year && (!month || m === month);
    });
    const rows = [];
    for (const p of filtered) {
      const start = localDateKey(p.period_start);
      const end = localDateKey(p.period_end);
      const data = await loadClosing(start, end);
      const totalRevenue = money(data.blocks.krwclm.revenue) + money(data.blocks.kbg.revenue);
      const totalExpense = money(data.blocks.krwclm.expense) + money(data.blocks.kbg.expense);
      const totalProfit = money(data.blocks.krwclm.profit) + money(data.blocks.kbg.profit);
      rows.push({ start, end, totalRevenue, totalExpense, totalProfit, entryCount: data.lineItems.length, mode: data.closing.mode === 'AUTO' ? 'AUTO' : 'MANUAL', status: data.closing.status === 'LOCKED' ? 'LOCKED' : 'DRAFT' });
    }
    res.render('closing/history', { title: 'Rekap Closing', pageTitle: 'Rekap Bulanan Closing', money, year, month, rows });
  } catch (err) { next(err); }
});

// v1.29 — income/expense export for a period, filterable by type/category, so
// the numbers can be shared outside the app (e.g. reporting to partners).
router.get('/export.xlsx', async (req, res, next) => {
  try {
    const { start, end } = selectedPeriod(req);
    if (start > end) return res.status(400).send('Periode tidak valid.');
    const category = String(req.query.category || '').trim();
    const type = String(req.query.type || '').trim().toUpperCase();
    const [[period]] = await db.execute('SELECT id FROM closing_periods WHERE period_start=? AND period_end=? LIMIT 1', [start, end]);
    let rows = [];
    if (period) {
      let sql = 'SELECT entry_type,site_code,cluster_name,category,amount,entry_date,description FROM closing_entries WHERE closing_id=?';
      const params = [period.id];
      if (['INCOME', 'EXPENSE'].includes(type)) { sql += ' AND entry_type=?'; params.push(type); }
      if (category) { sql += ' AND category=?'; params.push(category); }
      sql += ' ORDER BY entry_date DESC,id DESC';
      [rows] = await db.execute(sql, params);
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Closing');
    ws.columns = [
      { header: 'Tanggal', key: 'entry_date', width: 14 },
      { header: 'Jenis', key: 'entry_type', width: 14 },
      { header: 'Lokasi', key: 'site_code', width: 10 },
      { header: 'Cluster', key: 'cluster_name', width: 10 },
      { header: 'Kategori', key: 'category', width: 28 },
      { header: 'Keterangan', key: 'description', width: 40 },
      { header: 'Nominal', key: 'amount', width: 18 }
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow({ ...r, entry_type: r.entry_type === 'INCOME' ? 'Pendapatan' : 'Pengeluaran', entry_date: String(r.entry_date).slice(0, 10), cluster_name: r.cluster_name || '' }));
    ws.getColumn('amount').numFmt = '#,##0';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="closing-${start}-${end}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
