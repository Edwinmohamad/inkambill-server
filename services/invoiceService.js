const db = require('../config/db');
const { assignCashTransactionCode } = require('./cashService');

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function toSqlDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function calcProrata(price, activationDate, year, monthIndex) {
  const active = new Date(activationDate);
  const days = lastDayOfMonth(year, monthIndex);
  if (active.getFullYear() !== year || active.getMonth() !== monthIndex) return Number(price);
  const billableDays = Math.max(1, days - active.getDate() + 1);
  return Math.round((Number(price) / days) * billableDays);
}

// v1.25.5 (susulan #9/#10) — "Komisi Pemasangan Baru". Called right after a customer's FIRST-EVER invoice
// is inserted (guarded by the caller checking this really is invoice #1 for this customer_id — not just
// "no invoice this period", since a customer could in theory be created mid-cycle and this must still
// only fire once, on their true first bill). customers.is_new_install is set ONLY by the manual "Tambah
// Pelanggan Baru" form (never by bulk import — see routes/customers.js), so migrated customers can never
// reach this path no matter what activation_date they're given.
//
// Design: instead of "excluding" this payment from profit reports (easy to forget in some future report
// query), it is recorded as REAL symmetric income + expense — Pendapatan Pemasangan Baru in, Komisi
// Teknisi + Komisi Sales out — amounts that by construction always sum to exactly `total` (the invoice
// total actually billed, i.e. already net of any discount). Net cash effect is therefore always ~0 without
// any special-case filter anywhere else in the app.
//
// v1.25.5 (susulan #10) — REVISI: the split is no longer read from a per-package commission_technician/
// commission_sales pair (that was susulan #9's design). User confirmed the real-world scheme is UNIFORM
// across every package: Sales always gets a flat amount (settings.install_sales_flat_commission, editable
// at Menu Pengaturan -> Aplikasi), Teknisi gets whatever remains of `total`. Computed against `total` (not
// the raw package price) so this stays correct even if a discount happens to apply to a new-install
// customer's very first invoice.
//
// Gracefully no-ops (invoice stays a completely normal unpaid invoice, admins get notified) if `total`
// isn't large enough for the split to make sense (total <= flat sales commission — e.g. an unusually cheap
// package or a heavy discount on the first invoice) — better to fall back to normal billing + a manual
// follow-up than to silently record a zero/negative technician commission.
async function settleNewInstallCommission(conn, { invoiceId, customer, total, actorUserId }) {
  const [[settingsRow]] = await conn.execute(`SELECT install_sales_flat_commission FROM settings WHERE id=1 LIMIT 1`);
  const salesCommission = Number(settingsRow?.install_sales_flat_commission ?? 50000);
  if (!(Number(total) > salesCommission)) {
    const message = `Customer ${customer.id} (${customer.customer_code||''}) ditandai Pemasangan Baru tapi total tagihan pertama (Rp${Number(total).toLocaleString('id-ID')}) tidak lebih besar dari Komisi Sales flat saat ini (Rp${salesCommission.toLocaleString('id-ID')}) — invoice #${invoiceId} dibiarkan normal (belum lunas), perlu ditangani manual.`;
    await db.execute(`INSERT INTO automation_logs (job_name, status, message) VALUES ('install_commission','skipped',?)`, [message]).catch(() => {});
    await db.execute(
      `INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id)
       SELECT u.id,'install_commission_skipped','warning','bi-exclamation-triangle-fill',?,?,?,'customer',? FROM users u
       WHERE u.is_active=1 AND LOWER(TRIM(u.role)) IN ('admin','master_admin')
         AND NOT EXISTS (SELECT 1 FROM system_notifications WHERE type='install_commission_skipped' AND entity_type='customer' AND entity_id=?)`,
      [`Komisi Pemasangan Baru tidak otomatis: ${customer.name}`, message, `/customers?q=${encodeURIComponent(customer.customer_code||customer.name)}`, customer.id, customer.id]
    ).catch(() => {});
    return;
  }
  const technicianCommission = Number(total) - salesCommission;
  const techName = String(customer.install_technician_name || '').trim() || 'Teknisi (tidak diisi)';
  const salesName = String(customer.install_sales_name || '').trim() || 'Sales (tidak diisi)';

  const [payRes] = await conn.execute(
    `INSERT INTO payments (invoice_id,amount,method,reference,status,settlement_status,paid_at,received_by,verified_by,verified_at,notes)
     VALUES (?,?,?,?,?,?,NOW(),?,?,NOW(),?)`,
    [invoiceId, total, 'cash', 'Pemasangan Baru', 'confirmed', 'settled', actorUserId, actorUserId,
      `Dibayar tunai saat pemasangan (otomatis lunas) — dibagi komisi teknisi (${techName}) & sales (${salesName}).`]
  );
  const paymentId = payRes.insertId;
  await refreshInvoiceStatus(conn, invoiceId);

  const catIds = {};
  for (const code of ['PSB-IN', 'KOMISI-TEK', 'KOMISI-SLS']) {
    const [[row]] = await conn.execute(`SELECT id FROM cash_categories WHERE code=? LIMIT 1`, [code]);
    catIds[code] = row?.id || null;
  }
  const entries = [
    catIds['PSB-IN'] && { code: 'PSB-IN', amount: total, label: `Pemasangan Baru ${customer.name}`, sourceType: 'install_income' },
    catIds['KOMISI-TEK'] && { code: 'KOMISI-TEK', amount: technicianCommission, label: `Komisi Teknisi ${techName} - ${customer.name}`, sourceType: 'install_commission_technician' },
    catIds['KOMISI-SLS'] && { code: 'KOMISI-SLS', amount: salesCommission, label: `Komisi Sales ${salesName} - ${customer.name}`, sourceType: 'install_commission_sales' },
  ].filter(Boolean);
  for (const entry of entries) {
    const [exists] = await conn.execute(`SELECT id FROM cash_transactions WHERE source_type=? AND source_id=? LIMIT 1`, [entry.sourceType, paymentId]);
    if (exists.length) continue;
    const [r] = await conn.execute(
      `INSERT INTO cash_transactions(transaction_date,name,category_id,site_id,amount,notes,source_type,source_id,created_by) VALUES(CURDATE(),?,?,?,?,?,?,?,?)`,
      [entry.label, catIds[entry.code], customer.site_id, entry.amount, `Faktur pemasangan pelanggan ${customer.customer_code||customer.id}`, entry.sourceType, paymentId, actorUserId]
    );
    await assignCashTransactionCode(conn, r.insertId, catIds[entry.code], new Date());
  }
}

async function nextInvoiceNumber(conn, siteCode, year, monthIndex) {
  const ym = `${year}/${String(monthIndex + 1).padStart(2, '0')}`;
  const [rows] = await conn.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_number,'/',-1) AS UNSIGNED)),0) AS max_seq
     FROM invoices WHERE period_year=? AND period_month=?`,
    [year, monthIndex + 1]
  );
  const seq = String(Number(rows[0].max_seq) + 1).padStart(6, '0');
  return `INV/INK/${siteCode}/${ym}/${seq}`;
}

/**
 * Generate/refresh tagihan bulanan secara idempotent.
 * - Satu customer hanya boleh memiliki satu invoice per periode (DB unique key + application check).
 * - Invoice yang sudah ada, termasuk PAID, tidak pernah di-reset / dibuat ulang.
 * - force=true hanya melewati batas hari generate, bukan melewati proteksi duplicate.
 * - Pelanggan yang aktivasi setelah akhir periode tidak akan dibuatkan tagihan periode lama.
 */
async function generateMonthlyInvoices(referenceDate = new Date(), force = false, actorUserId = null, options = {}) {
  const year = referenceDate.getFullYear();
  const monthIndex = referenceDate.getMonth();
  const month = monthIndex + 1;
  const todayOnly = new Date(year, monthIndex, referenceDate.getDate());
  const periodEnd = `${year}-${String(month).padStart(2,'0')}-${String(lastDayOfMonth(year,monthIndex)).padStart(2,'0')}`;
  const lockName = `inkamnet:invoice:${year}-${String(month).padStart(2,'0')}`;
  const conn = await db.getConnection();
  let created = 0;
  let skipped = 0;
  let eligible = 0;
  let existingPaid = 0;
  let existingOpen = 0;
  let skippedSchedule = 0;
  let lockAcquired = false;

  try {
    const [[lockRow]] = await conn.execute(`SELECT GET_LOCK(?,10) AS locked`,[lockName]);
    if (Number(lockRow?.locked) !== 1) throw new Error('Generate tagihan sedang dijalankan proses lain. Coba lagi beberapa detik.');
    lockAcquired = true;
    await conn.beginTransaction();

    const where = [`c.customer_status='active'`, `(c.activation_date IS NULL OR c.activation_date<=?)`];
    const params = [periodEnd];
    if (options.customerId) {
      where.push('c.id=?');
      params.push(Number(options.customerId));
    }
    if (options.siteCode) {
      where.push('s.code=?');
      params.push(String(options.siteCode));
    }
    if (options.clusterId) {
      where.push('c.cluster_id=?');
      params.push(Number(options.clusterId));
    }

    const [customers] = await conn.execute(`
      SELECT c.*, p.price AS package_price, p.name AS package_name, s.code AS site_code,
             COALESCE(c.due_day, s.default_due_day, st.default_due_day, 5) AS effective_due_day,
             COALESCE(c.grace_days, s.default_grace_days, st.default_grace_days, 2) AS effective_grace_days,
             COALESCE(s.invoice_generate_days, st.invoice_generate_days, 3) AS generate_days,
             d.type AS discount_type, d.amount AS discount_rule_amount, d.is_active AS discount_is_active
      FROM customers c
      JOIN packages p ON p.id=c.package_id
      JOIN sites s ON s.id=c.site_id
      LEFT JOIN discounts d ON d.id=c.discount_id
      CROSS JOIN settings st
      WHERE ${where.join(' AND ')}
      ORDER BY s.code,c.name
    `, params);

    eligible = customers.length;

    for (const c of customers) {
      const [exists] = await conn.execute(
        `SELECT id,status,paid_amount,outstanding FROM invoices WHERE customer_id=? AND period_year=? AND period_month=? LIMIT 1`,
        [c.id, year, month]
      );
      if (exists.length) {
        skipped++;
        if (exists[0].status === 'paid' || Number(exists[0].outstanding) <= 0) existingPaid++;
        else existingOpen++;
        continue;
      }

      const dueDay = Math.min(Number(c.effective_due_day), lastDayOfMonth(year, monthIndex));
      const dueDate = new Date(year, monthIndex, dueDay);
      const generateFrom = new Date(dueDate);
      generateFrom.setDate(generateFrom.getDate() - Number(c.generate_days || 3));
      if (!force && todayOnly < generateFrom) { skipped++; skippedSchedule++; continue; }

      let amount = Number(c.package_price);
      let isProrata = 0;
      // v1.25.5 (susulan) — a "Pemasangan Baru" customer's first payment is a fixed, full-price amount
      // collected in cash at install time and split 100% into technician+sales commission (see
      // settleNewInstallCommission below); it is never prorated by day-of-month like a normal recurring
      // subscription invoice, regardless of which day in the month they activated.
      if (c.prorata_enabled && c.activation_date && !c.is_new_install) {
        const a = new Date(c.activation_date);
        if (a.getFullYear() === year && a.getMonth() === monthIndex) {
          amount = calcProrata(amount, c.activation_date, year, monthIndex);
          isProrata = 1;
        }
      }

      // v1.25.1 — optional per-customer discount (customers.discount_id, set via the customer form's
      // "Diskon" field) recurs on every monthly invoice generated for that customer, as long as the
      // discount rule is still active. Computed against the (post-prorata) subtotal, clamped so total
      // never goes below 0, and stored on invoices.discount so it prints on the invoice like before.
      let discountAmount = 0;
      if (c.discount_id && Number(c.discount_is_active) === 1) {
        discountAmount = c.discount_type === 'percent'
          ? Math.round(amount * Number(c.discount_rule_amount || 0) / 100)
          : Number(c.discount_rule_amount || 0);
        discountAmount = Math.max(0, Math.min(discountAmount, amount));
      }
      const total = amount - discountAmount;

      const invoiceNumber = await nextInvoiceNumber(conn, c.site_code, year, monthIndex);
      let insertedInvoiceId = null;
      try {
        const [ins] = await conn.execute(`
          INSERT INTO invoices
          (invoice_number, customer_id, period_year, period_month, invoice_date, due_date,
           subtotal, discount, total, outstanding, status, is_prorata, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?)
        `, [invoiceNumber, c.id, year, month, toSqlDate(referenceDate), toSqlDate(dueDate), amount, discountAmount, total, total, isProrata, actorUserId]);
        created++;
        insertedInvoiceId = ins.insertId;
      } catch (err) {
        // Proteksi terakhir jika request paralel / cron sempat membuat customer-period yang sama.
        if (err && err.code === 'ER_DUP_ENTRY') { skipped++; existingOpen++; continue; }
        throw err;
      }

      // v1.25.5 (susulan) — "Komisi Pemasangan Baru": only ever fires on this customer's true first
      // invoice ever (not just first-this-period) so re-running generation in a later month never
      // re-splits a customer's second+ invoice as commission.
      if (c.is_new_install) {
        const [[countRow]] = await conn.execute(`SELECT COUNT(*) n FROM invoices WHERE customer_id=?`, [c.id]);
        if (Number(countRow.n) === 1) {
          await settleNewInstallCommission(conn, { invoiceId: insertedInvoiceId, customer: c, total, actorUserId });
        }
      }
    }

    await conn.commit();
    await db.execute(
      `INSERT INTO automation_logs (job_name, status, message) VALUES ('generate_monthly_invoices','success',?)`,
      [`Period ${year}-${String(month).padStart(2,'0')} · created ${created}, skipped ${skipped}, paid preserved ${existingPaid}, open preserved ${existingOpen}, schedule skipped ${skippedSchedule}, eligible ${eligible}${options.customerId?` · customer ${options.customerId}`:''}${options.siteCode?` · site ${options.siteCode}`:''}${options.clusterId?` · cluster ${options.clusterId}`:''}`]
    );
    return { created, skipped, eligible, existingPaid, existingOpen, skippedSchedule };
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    await db.execute(
      `INSERT INTO automation_logs (job_name, status, message) VALUES ('generate_monthly_invoices','failed',?)`,
      [String(err.message).slice(0, 1000)]
    ).catch(() => {});
    throw err;
  } finally {
    if (lockAcquired) await conn.execute(`SELECT RELEASE_LOCK(?)`,[lockName]).catch(()=>{});
    conn.release();
  }
}

async function refreshInvoiceStatus(conn, invoiceId) {
  const [rows] = await conn.execute(`
    SELECT i.total, COALESCE(SUM(CASE WHEN p.status='confirmed' THEN p.amount ELSE 0 END),0) AS paid
    FROM invoices i LEFT JOIN payments p ON p.invoice_id=i.id
    WHERE i.id=? GROUP BY i.id
  `, [invoiceId]);
  if (!rows.length) return;
  const total = Number(rows[0].total);
  const paid = Number(rows[0].paid);
  const outstanding = Math.max(0, total - paid);
  let status = 'unpaid';
  if (paid > 0 && outstanding > 0) status = 'partial';
  if (outstanding <= 0) status = 'paid';
  await conn.execute(`UPDATE invoices SET paid_amount=?, outstanding=?, status=? WHERE id=?`, [paid, outstanding, status, invoiceId]);
}

// v1.25.2 — CRITICAL FIX: previously, changing/removing a customer's discount_id only affected
// invoices generated AFTER the change (see generateMonthlyInvoices above); any invoice already
// generated for the customer kept whatever discount was baked in at generation time, which is what
// admins reported as the discount feature "not working" (they'd change a customer's discount and see
// no change on the customer's current/ongoing invoice). This recomputes discount/total for every OPEN
// invoice belonging to the customer against the NEW discount rule (or removes the discount entirely if
// discountId is null), then reuses refreshInvoiceStatus so paid_amount/outstanding/status stay
// consistent with the existing single source of truth.
//
// Safety constraint (per spec): must NEVER touch historical invoices that are already settled — so this
// only targets invoices with status NOT IN ('paid','cancelled','refunded'). A 'partial' invoice is still
// considered "berjalan" (ongoing) and is included; refreshInvoiceStatus will re-derive paid/outstanding
// against the new total afterward (clamped at 0, so a discount that now exceeds what's already been
// paid simply resolves the invoice to 'paid', it never goes negative).
//
// Call this ONLY when discount_id actually changed (compare old vs new before calling) so re-saving a
// customer form without touching the discount field never disturbs a discount an admin manually set on
// one specific invoice via "Tambah Diskon".
async function syncCustomerDiscountToOpenInvoices(conn, customerId, discountId) {
  let rule = null;
  if (discountId) {
    const [[d]] = await conn.execute(`SELECT type,amount FROM discounts WHERE id=? AND is_active=1 LIMIT 1`, [discountId]);
    rule = d || null; // if the rule is inactive/missing by the time we get here, treat as "no discount"
  }
  const [invoices] = await conn.execute(
    `SELECT id, subtotal FROM invoices WHERE customer_id=? AND status NOT IN ('paid','cancelled','refunded') FOR UPDATE`,
    [customerId]
  );
  for (const inv of invoices) {
    const subtotal = Number(inv.subtotal);
    let discountAmount = 0;
    if (rule) {
      discountAmount = rule.type === 'percent'
        ? Math.round(subtotal * Number(rule.amount || 0) / 100)
        : Number(rule.amount || 0);
      discountAmount = Math.max(0, Math.min(discountAmount, subtotal));
    }
    const total = subtotal - discountAmount;
    await conn.execute(`UPDATE invoices SET discount=?, total=? WHERE id=?`, [discountAmount, total, inv.id]);
    await refreshInvoiceStatus(conn, inv.id);
  }
  return invoices.length;
}

// v1.25.2 — backs the per-invoice "Tambah Diskon" action (Daftar Tagihan row menu): lets an admin set a
// one-off discount (flat rupiah or percent) directly on a single invoice, independent of the customer's
// discount_id. Guarded the same way as syncCustomerDiscountToOpenInvoices: refuses to touch an invoice
// that is already 'paid'/'cancelled'/'refunded' so historical/settled invoices can never be corrupted.
// Returns null (no-op) if the invoice doesn't exist or isn't eligible; otherwise the recomputed
// {subtotal, discount, total}. Caller is expected to already hold/open the transaction and to audit +
// flash the result.
async function applyInvoiceDiscount(conn, invoiceId, mode, rawValue) {
  const [rows] = await conn.execute(`SELECT id,subtotal,status FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`, [invoiceId]);
  if (!rows.length) return null;
  const invoice = rows[0];
  if (['paid', 'cancelled', 'refunded'].includes(invoice.status)) return null;
  const subtotal = Number(invoice.subtotal);
  let discountAmount = mode === 'percent' ? Math.round(subtotal * Number(rawValue || 0) / 100) : Number(rawValue || 0);
  discountAmount = Math.max(0, Math.min(discountAmount, subtotal));
  const total = subtotal - discountAmount;
  await conn.execute(`UPDATE invoices SET discount=?, total=? WHERE id=?`, [discountAmount, total, invoiceId]);
  await refreshInvoiceStatus(conn, invoiceId);
  return { subtotal, discount: discountAmount, total };
}

module.exports = { generateMonthlyInvoices, refreshInvoiceStatus, calcProrata, syncCustomerDiscountToOpenInvoices, applyInvoiceDiscount, nextInvoiceNumber, settleNewInstallCommission };
