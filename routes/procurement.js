const express = require('express');
const db = require('../config/db');
const { assignCashTransactionCode } = require('../services/cashService');
const { audit } = require('../services/auditService');
const router = express.Router();

const money = value => Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
const qty = value => Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : new Date().toISOString().slice(0, 10);
const text = (value, max = 255) => String(value || '').trim().slice(0, max) || null;
const pad = id => String(id).padStart(5, '0');
const ym = date => String(date).slice(0, 7).replace('-', '');

function rowsFromBody(body) {
  const ids = Array.isArray(body.item_id) ? body.item_id : [body.item_id];
  const quantities = Array.isArray(body.qty) ? body.qty : [body.qty];
  const prices = Array.isArray(body.unit_price) ? body.unit_price : [body.unit_price];
  const discounts = Array.isArray(body.line_discount) ? body.line_discount : [body.line_discount];
  return ids.map((id, index) => ({ itemId: Number(id), qty: qty(quantities[index]), price: money(prices[index]), discount: money(discounts[index]) }))
    .filter(row => Number.isInteger(row.itemId) && row.itemId > 0 && row.qty > 0);
}

async function siteById(conn, id) {
  const [[site]] = await conn.execute(`SELECT id,code,name FROM sites WHERE id=? AND is_active=1`, [id]);
  if (!site) throw new Error('Site tidak ditemukan atau nonaktif.');
  return site;
}

async function destinationItem(conn, source, site) {
  if (Number(source.site_id) === Number(site.id)) return source.id;
  const [[existing]] = await conn.execute(`SELECT id FROM inventory_items
    WHERE site_id=? AND is_active=1 AND deleted_at IS NULL
      AND ((? IS NOT NULL AND LOWER(item_code)=LOWER(?)) OR LOWER(name)=LOWER(?))
    ORDER BY (item_code IS NOT NULL AND LOWER(item_code)=LOWER(?)) DESC,id LIMIT 1 FOR UPDATE`,
  [site.id, source.item_code, source.item_code, source.name, source.item_code || '']);
  if (existing) return existing.id;
  const code = source.item_code ? `${String(source.item_code).slice(0, 78)}-${site.code}` : null;
  const [created] = await conn.execute(`INSERT INTO inventory_items
    (item_code,name,category,category_id,barcode,site_id,supplier_id,qty,unit,min_stock,purchase_price,location,notes)
    VALUES(?,?,?,?,NULL,?,?,0,?,?,?,?,?)`,
  [code, source.name, source.category || null, source.category_id || null, site.id, source.supplier_id || null, source.unit || 'pcs', source.min_stock || 0, source.purchase_price || 0, `Gudang ${site.code}`, `Dibuat otomatis untuk stock site ${site.code}`]);
  return created.insertId;
}

async function addCash(conn, { categoryCode, date, name, siteId, amount, notes, userId, purchaseId = null, transferId = null, internalKey = null }) {
  if (money(amount) <= 0) return null;
  const [[category]] = await conn.execute(`SELECT id FROM cash_categories WHERE code=? AND is_active=1 LIMIT 1`, [categoryCode]);
  if (!category) throw new Error(`Kategori Data Kas ${categoryCode} belum tersedia.`);
  const [result] = await conn.execute(`INSERT INTO cash_transactions
    (transaction_date,name,category_id,site_id,amount,notes,source_type,approval_status,created_by,warehouse_purchase_id,warehouse_transfer_id,internal_transfer_key)
    VALUES(?,?,?,?,?,?,'manual','PENDING_APPROVAL',?,?,?,?)`,
  [date, name, category.id, siteId || null, money(amount), notes || null, userId || null, purchaseId, transferId, internalKey]);
  await assignCashTransactionCode(conn, result.insertId, category.id, date);
  return result.insertId;
}

async function receivePurchase(conn, purchaseId, userId) {
  const [[purchase]] = await conn.execute(`SELECT p.*,s.code site_code,sp.name supplier_name
    FROM warehouse_purchases p JOIN sites s ON s.id=p.destination_site_id LEFT JOIN suppliers sp ON sp.id=p.supplier_id
    WHERE p.id=? FOR UPDATE`, [purchaseId]);
  if (!purchase) throw new Error('Faktur pembelian tidak ditemukan.');
  if (purchase.status === 'received') return purchase;
  if (purchase.status === 'cancelled') throw new Error('Faktur yang dibatalkan tidak dapat diterima.');
  const site = { id: purchase.destination_site_id, code: purchase.site_code };
  const [lines] = await conn.execute(`SELECT * FROM warehouse_purchase_items WHERE purchase_id=? ORDER BY id FOR UPDATE`, [purchaseId]);
  if (!lines.length) throw new Error('Faktur tidak memiliki barang.');
  for (const line of lines) {
    const [[source]] = await conn.execute(`SELECT * FROM inventory_items WHERE id=? AND is_active=1 AND deleted_at IS NULL FOR UPDATE`, [line.item_id]);
    if (!source) throw new Error(`Barang ${line.item_name} sudah tidak tersedia.`);
    const destinationId = await destinationItem(conn, source, site);
    await conn.execute(`UPDATE inventory_items SET qty=qty+?,purchase_price=? WHERE id=?`, [line.qty, line.unit_price, destinationId]);
    await conn.execute(`UPDATE warehouse_purchase_items SET destination_item_id=?,received_qty=? WHERE id=?`, [destinationId, line.qty, line.id]);
    await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id)
      VALUES(?,'in',?,?,?,?)`, [destinationId, line.qty, purchase.document_no, `Penerimaan ${purchase.supplier_name || purchase.shop_name || 'supplier'} · ${purchase.document_no}`, userId]);
  }
  let cashId = purchase.cash_transaction_id;
  if (!cashId && Number(purchase.paid_amount) > 0) {
    cashId = await addCash(conn, { categoryCode: 'WHBUY', date: purchase.purchase_date,
      name: `Pembelian gudang · ${purchase.document_no} · ${purchase.supplier_name || purchase.shop_name || 'Supplier'}`,
      siteId: purchase.payer_site_id || purchase.destination_site_id, amount: purchase.paid_amount,
      notes: `Otomatis dari faktur ${purchase.document_no}. Total ${purchase.grand_total}; pembayaran ${purchase.payment_type}.`, userId, purchaseId });
  }
  await conn.execute(`UPDATE warehouse_purchases SET status='received',received_by=?,received_at=NOW(),cash_transaction_id=? WHERE id=?`, [userId, cashId, purchaseId]);
  return { ...purchase, cash_transaction_id: cashId };
}

router.get('/', async (req, res) => {
  const [summaryResult, [sites], [suppliers], [items], [purchases], [lists], [transfers]] = await Promise.all([
    db.query(`SELECT
      (SELECT COUNT(*) FROM warehouse_purchases WHERE status='draft') draft_purchases,
      (SELECT COUNT(*) FROM warehouse_purchases WHERE status='received' AND purchase_date>=DATE_FORMAT(CURDATE(),'%Y-%m-01')) received_month,
      (SELECT COALESCE(SUM(grand_total-paid_amount),0) FROM warehouse_purchases WHERE status='received' AND grand_total>paid_amount) supplier_due,
      (SELECT COUNT(*) FROM warehouse_shopping_lists WHERE is_active=1) active_lists`),
    db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`),
    db.query(`SELECT id,name FROM suppliers WHERE is_active=1 ORDER BY name`),
    db.query(`SELECT i.id,i.item_code,i.name,i.qty,i.unit,i.purchase_price,i.site_id,s.code site_code,sp.name supplier_name
      FROM inventory_items i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id
      WHERE i.is_active=1 AND i.deleted_at IS NULL ORDER BY i.name,s.code`),
    db.query(`SELECT p.*,sp.name supplier_name,ds.code destination_code,ps.code payer_code,u.name creator_name,
      (p.grand_total-p.paid_amount) due_amount FROM warehouse_purchases p LEFT JOIN suppliers sp ON sp.id=p.supplier_id
      JOIN sites ds ON ds.id=p.destination_site_id LEFT JOIN sites ps ON ps.id=p.payer_site_id LEFT JOIN users u ON u.id=p.created_by
      ORDER BY p.id DESC LIMIT 40`),
    db.query(`SELECT l.*,sp.name supplier_name,s.code site_code,COUNT(li.id) item_count,COALESCE(SUM(li.default_qty*li.price_hint),0) estimate
      FROM warehouse_shopping_lists l LEFT JOIN suppliers sp ON sp.id=l.supplier_id LEFT JOIN sites s ON s.id=l.destination_site_id
      LEFT JOIN warehouse_shopping_list_items li ON li.shopping_list_id=l.id WHERE l.is_active=1 GROUP BY l.id ORDER BY l.updated_at DESC`),
    db.query(`SELECT t.*,os.code origin_code,ds.code destination_code,u.name creator_name
      FROM warehouse_transfers t JOIN sites os ON os.id=t.origin_site_id JOIN sites ds ON ds.id=t.destination_site_id
      LEFT JOIN users u ON u.id=t.created_by ORDER BY t.id DESC LIMIT 30`)
  ]);
  const summary = summaryResult[0][0] || {};
  const listIds = lists.map(row => row.id);
  let listItems = [];
  if (listIds.length) [listItems] = await db.query(`SELECT li.*,i.name item_name,i.item_code,i.unit FROM warehouse_shopping_list_items li JOIN inventory_items i ON i.id=li.item_id WHERE li.shopping_list_id IN (?) ORDER BY li.sort_order,li.id`, [listIds]);
  const byList = new Map();
  listItems.forEach(row => { if (!byList.has(row.shopping_list_id)) byList.set(row.shopping_list_id, []); byList.get(row.shopping_list_id).push(row); });
  lists.forEach(row => { row.items = byList.get(row.id) || []; });
  res.render('inventory/procurement', { title: 'Belanja & Transfer Gudang', summary: summary || {}, sites, suppliers, items, purchases, lists, transfers, today: new Date().toISOString().slice(0, 10) });
});

router.post('/lists', async (req, res) => {
  const name = text(req.body.name, 160);
  const lines = rowsFromBody(req.body);
  if (!name || !lines.length) { req.session.flash = { type: 'danger', message: 'Nama Shopping List dan minimal satu barang wajib diisi.' }; return res.redirect('/inventory/procurement#lists'); }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [created] = await conn.execute(`INSERT INTO warehouse_shopping_lists(name,supplier_id,destination_site_id,notes,created_by) VALUES(?,?,?,?,?)`, [name, Number(req.body.supplier_id) || null, Number(req.body.destination_site_id) || null, text(req.body.notes, 2000), req.session.user.id]);
    for (let index = 0; index < lines.length; index++) await conn.execute(`INSERT INTO warehouse_shopping_list_items(shopping_list_id,item_id,default_qty,price_hint,sort_order) VALUES(?,?,?,?,?)`, [created.insertId, lines[index].itemId, lines[index].qty, lines[index].price, index]);
    await conn.commit();
    await audit({ userId: req.session.user.id, action: 'create', entityType: 'warehouse_shopping_list', entityId: created.insertId, description: `Buat Shopping List permanen ${name}`, ip: req.ip });
    req.session.flash = { type: 'success', message: `Shopping List “${name}” disimpan permanen.` };
  } catch (error) { await conn.rollback(); req.session.flash = { type: 'danger', message: `Shopping List gagal disimpan: ${error.message}` }; }
  finally { conn.release(); }
  res.redirect('/inventory/procurement#lists');
});

router.post('/lists/:id/toggle', async (req, res) => {
  await db.execute(`UPDATE warehouse_shopping_lists SET is_active=IF(is_active=1,0,1) WHERE id=?`, [req.params.id]);
  res.redirect('/inventory/procurement#lists');
});

router.post('/purchases', async (req, res) => {
  const lines = rowsFromBody(req.body);
  if (!lines.length) { req.session.flash = { type: 'danger', message: 'Tambahkan minimal satu barang ke faktur.' }; return res.redirect('/inventory/procurement#purchase'); }
  const date = isoDate(req.body.purchase_date), destinationId = Number(req.body.destination_site_id), payerId = Number(req.body.payer_site_id) || destinationId;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const destination = await siteById(conn, destinationId); await siteById(conn, payerId);
    const sourceType = ['pandawa', 'online', 'supplier_other'].includes(req.body.source_type) ? req.body.source_type : 'supplier_other';
    const paymentType = ['cash', 'transfer', 'credit', 'partial'].includes(req.body.payment_type) ? req.body.payment_type : 'cash';
    let supplierId = Number(req.body.supplier_id) || null;
    if (sourceType === 'pandawa' && !supplierId) {
      let [[pandawa]] = await conn.execute(`SELECT id FROM suppliers WHERE LOWER(name)=LOWER('Pandawa') LIMIT 1`);
      if (!pandawa) { const [made] = await conn.execute(`INSERT INTO suppliers(name,is_active,notes) VALUES('Pandawa',1,'Dibuat otomatis dari modul Pengadaan Gudang')`); pandawa = { id: made.insertId }; }
      supplierId = pandawa.id;
    }
    let subtotal = 0;
    const snapshots = [];
    for (const line of lines) {
      const [[item]] = await conn.execute(`SELECT * FROM inventory_items WHERE id=? AND is_active=1 AND deleted_at IS NULL`, [line.itemId]);
      if (!item) throw new Error('Salah satu barang tidak ditemukan.');
      line.subtotal = Math.max(0, money(line.qty * line.price - line.discount)); subtotal += line.subtotal; snapshots.push({ line, item });
    }
    const headerDiscount = money(req.body.discount_amount), shipping = money(req.body.shipping_amount), tax = money(req.body.tax_amount);
    const grandTotal = Math.max(0, money(subtotal - headerDiscount + shipping + tax));
    let paid = paymentType === 'credit' ? 0 : paymentType === 'partial' ? Math.min(grandTotal, money(req.body.paid_amount)) : grandTotal;
    const [created] = await conn.execute(`INSERT INTO warehouse_purchases
      (supplier_id,source_type,marketplace,shop_name,external_invoice_no,destination_site_id,payer_site_id,purchase_date,payment_type,status,subtotal,discount_amount,shipping_amount,tax_amount,grand_total,paid_amount,due_date,notes,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)`,
    [supplierId, sourceType, text(req.body.marketplace, 100), text(req.body.shop_name, 160), text(req.body.external_invoice_no, 120), destination.id, payerId, date, paymentType, subtotal, headerDiscount, shipping, tax, grandTotal, paid, req.body.due_date || null, text(req.body.notes, 3000), req.session.user.id]);
    const doc = `PB-${destination.code}-${ym(date)}-${pad(created.insertId)}`;
    await conn.execute(`UPDATE warehouse_purchases SET document_no=? WHERE id=?`, [doc, created.insertId]);
    for (const { line, item } of snapshots) await conn.execute(`INSERT INTO warehouse_purchase_items(purchase_id,item_id,item_name,item_code,unit,qty,unit_price,discount_amount,subtotal) VALUES(?,?,?,?,?,?,?,?,?)`, [created.insertId, item.id, item.name, item.item_code || null, item.unit || 'pcs', line.qty, line.price, line.discount, line.subtotal]);
    if (req.body.action === 'receive') await receivePurchase(conn, created.insertId, req.session.user.id);
    await conn.commit();
    await audit({ userId: req.session.user.id, action: req.body.action === 'receive' ? 'receive' : 'create', entityType: 'warehouse_purchase', entityId: created.insertId, description: `${doc} · ${lines.length} barang · total ${grandTotal}`, ip: req.ip });
    req.session.flash = { type: 'success', message: req.body.action === 'receive' ? `${doc} diterima. Stok dan pengajuan Data Kas sudah dibuat.` : `${doc} disimpan sebagai draft.` };
    return res.redirect(`/inventory/procurement/purchases/${created.insertId}/invoice`);
  } catch (error) { await conn.rollback(); req.session.flash = { type: 'danger', message: `Faktur gagal disimpan: ${error.message}` }; return res.redirect('/inventory/procurement#purchase'); }
  finally { conn.release(); }
});

router.post('/purchases/:id/receive', async (req, res) => {
  const conn = await db.getConnection();
  try { await conn.beginTransaction(); const purchase = await receivePurchase(conn, Number(req.params.id), req.session.user.id); await conn.commit(); await audit({ userId: req.session.user.id, action: 'receive', entityType: 'warehouse_purchase', entityId: Number(req.params.id), description: `Terima barang ${purchase.document_no}`, ip: req.ip }); req.session.flash = { type: 'success', message: `${purchase.document_no} diterima dan terintegrasi ke stok/Data Kas.` }; }
  catch (error) { await conn.rollback(); req.session.flash = { type: 'danger', message: `Penerimaan gagal: ${error.message}` }; }
  finally { conn.release(); }
  res.redirect('/inventory/procurement');
});

router.get('/purchases/:id/invoice', async (req, res) => {
  const [[purchase]] = await db.query(`SELECT p.*,sp.name supplier_name,sp.phone supplier_phone,sp.address supplier_address,ds.code destination_code,ds.name destination_name,ps.code payer_code,u.name creator_name,ru.name receiver_name
    FROM warehouse_purchases p LEFT JOIN suppliers sp ON sp.id=p.supplier_id JOIN sites ds ON ds.id=p.destination_site_id LEFT JOIN sites ps ON ps.id=p.payer_site_id LEFT JOIN users u ON u.id=p.created_by LEFT JOIN users ru ON ru.id=p.received_by WHERE p.id=?`, [req.params.id]);
  if (!purchase) return res.status(404).send('Faktur tidak ditemukan.');
  const [lines] = await db.query(`SELECT * FROM warehouse_purchase_items WHERE purchase_id=? ORDER BY id`, [purchase.id]);
  res.render('inventory/purchase-invoice', { layout: false, title: purchase.document_no, purchase, lines });
});

router.post('/transfers', async (req, res) => {
  const lines = rowsFromBody(req.body), originId = Number(req.body.origin_site_id), destinationId = Number(req.body.destination_site_id), date = isoDate(req.body.transfer_date);
  if (!lines.length || !originId || !destinationId || originId === destinationId) { req.session.flash = { type: 'danger', message: 'Asal, tujuan, dan minimal satu barang transfer wajib valid.' }; return res.redirect('/inventory/procurement#transfer'); }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction(); const origin = await siteById(conn, originId), destination = await siteById(conn, destinationId);
    let subtotal = 0; const snapshots = [];
    for (const line of lines) {
      const [[item]] = await conn.execute(`SELECT * FROM inventory_items WHERE id=? AND site_id=? AND is_active=1 AND deleted_at IS NULL FOR UPDATE`, [line.itemId, origin.id]);
      if (!item) throw new Error('Barang tidak tersedia di site asal.');
      if (Number(item.qty) < line.qty) throw new Error(`Stok ${item.name} tidak cukup (${item.qty} ${item.unit}).`);
      line.subtotal = money(line.qty * line.price); subtotal += line.subtotal; snapshots.push({ line, item });
    }
    const shipping = money(req.body.shipping_amount), total = money(subtotal + shipping);
    if (total <= 0) throw new Error('Nilai transfer harus lebih dari 0 agar pasangan Data Kas dapat dibuat.');
    const [created] = await conn.execute(`INSERT INTO warehouse_transfers(origin_site_id,destination_site_id,transfer_date,status,subtotal,shipping_amount,grand_total,notes,created_by) VALUES(?,?,?,'received',?,?,?,?,?)`, [origin.id, destination.id, date, subtotal, shipping, total, text(req.body.notes, 3000), req.session.user.id]);
    const doc = `TRF-${origin.code}-${destination.code}-${ym(date)}-${pad(created.insertId)}`, internalKey = `WAREHOUSE:${created.insertId}:${origin.code}:${destination.code}`;
    await conn.execute(`UPDATE warehouse_transfers SET document_no=?,internal_transfer_key=?,received_by=?,received_at=NOW() WHERE id=?`, [doc, internalKey, req.session.user.id, created.insertId]);
    for (const { line, item } of snapshots) {
      const destinationItemId = await destinationItem(conn, item, destination);
      await conn.execute(`UPDATE inventory_items SET qty=qty-? WHERE id=?`, [line.qty, item.id]);
      await conn.execute(`UPDATE inventory_items SET qty=qty+?,purchase_price=? WHERE id=?`, [line.qty, line.price || item.purchase_price || 0, destinationItemId]);
      await conn.execute(`INSERT INTO warehouse_transfer_items(transfer_id,origin_item_id,destination_item_id,item_name,item_code,unit,qty,unit_price,subtotal) VALUES(?,?,?,?,?,?,?,?,?)`, [created.insertId, item.id, destinationItemId, item.name, item.item_code || null, item.unit || 'pcs', line.qty, line.price, line.subtotal]);
      await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,'out',?,?,?,?)`, [item.id, line.qty, doc, `Transfer ke ${destination.code}`, req.session.user.id]);
      await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,'in',?,?,?,?)`, [destinationItemId, line.qty, doc, `Transfer dari ${origin.code}`, req.session.user.id]);
    }
    const expenseId = await addCash(conn, { categoryCode: 'WHTROUT', date, name: `Transfer barang ${origin.code} → ${destination.code} · ${doc}`, siteId: destination.id, amount: total, notes: `Transaksi internal pasangan ${internalKey}`, userId: req.session.user.id, transferId: created.insertId, internalKey });
    const incomeId = await addCash(conn, { categoryCode: 'WHTRIN', date, name: `Transfer barang ${origin.code} → ${destination.code} · ${doc}`, siteId: origin.id, amount: total, notes: `Transaksi internal pasangan ${internalKey}`, userId: req.session.user.id, transferId: created.insertId, internalKey });
    await conn.execute(`UPDATE warehouse_transfers SET cash_expense_id=?,cash_income_id=? WHERE id=?`, [expenseId, incomeId, created.insertId]);
    await conn.commit();
    await audit({ userId: req.session.user.id, action: 'transfer', entityType: 'warehouse_transfer', entityId: created.insertId, description: `${doc} · ${lines.length} barang · ${total}`, ip: req.ip });
    req.session.flash = { type: 'success', message: `${doc} selesai. Stok dan pasangan Data Kas ${destination.code}/${origin.code} sudah dibuat.` };
  } catch (error) { await conn.rollback(); req.session.flash = { type: 'danger', message: `Transfer gagal: ${error.message}` }; }
  finally { conn.release(); }
  res.redirect('/inventory/procurement#transfer');
});

module.exports = router;
