const db = require('../config/db');

async function syncStockAlert(itemId, notify = true) {
  const [[item]] = await db.query(`SELECT id,name,qty,min_stock,is_active FROM inventory_items WHERE id=? LIMIT 1`, [itemId]);
  if (!item) return { exists: false };
  const qty = Number(item.qty || 0);
  const minimum = Number(item.min_stock || 0);
  if (!item.is_active || qty > minimum || minimum <= 0) {
    await db.execute(`UPDATE inventory_stock_alerts SET resolved_at=COALESCE(resolved_at,NOW()) WHERE item_id=? AND resolved_at IS NULL`, [itemId]);
    return { exists: true, low: false, qty, minimum };
  }
  const severity = qty <= Math.max(1, minimum / 2) ? 'critical' : 'low';
  const [[open]] = await db.query(`SELECT id,last_notified_at FROM inventory_stock_alerts WHERE item_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`, [itemId]);
  if (open) {
    await db.execute(`UPDATE inventory_stock_alerts SET current_qty=?,min_stock=?,severity=?,updated_at=NOW() WHERE id=?`, [qty, minimum, severity, open.id]);
  } else {
    await db.execute(`INSERT INTO inventory_stock_alerts(item_id,current_qty,min_stock,severity) VALUES(?,?,?,?)`, [itemId, qty, minimum, severity]);
  }
  if (notify && (!open || !open.last_notified_at || Date.now() - new Date(open.last_notified_at).getTime() > 86400000)) {
    const [admins] = await db.query(`SELECT id FROM users WHERE is_active=1 AND role IN ('admin','master_admin','masteradmin','superadmin')`);
    for (const admin of admins) {
      await db.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id) VALUES(?,?,?,?,?,?,?,?,?)`, [admin.id, 'inventory_low_stock', severity === 'critical' ? 'danger' : 'warning', 'bi-box-seam', `Stok rendah: ${item.name}`, `Sisa ${qty} dari minimum ${minimum}.`, '/inventory', 'inventory', item.id]);
    }
    await db.execute(`UPDATE inventory_stock_alerts SET last_notified_at=NOW() WHERE item_id=? AND resolved_at IS NULL`, [itemId]);
  }
  return { exists: true, low: true, severity, qty, minimum };
}

async function scanLowStock() {
  const [items] = await db.query(`SELECT id FROM inventory_items WHERE is_active=1 AND deleted_at IS NULL AND qty<=min_stock AND min_stock>0`);
  const results = [];
  for (const item of items) results.push(await syncStockAlert(item.id));
  return { scanned: items.length, low: results.filter(row => row.low).length };
}

module.exports = { syncStockAlert, scanLowStock };
