const express = require('express');
const db = require('../config/db');
const { cashAgingDays, streamSettlementReceipt } = require('../services/cashSettlementService');

const router = express.Router();

// v1.28 — "Cash Saya": setiap user (collector/teknisi/admin) melihat cash pelanggan yang ia pegang,
// umur cash, pembayaran yang masih menunggu approval, dan riwayat setorannya sendiri. Hanya membaca
// data milik user yang login; tidak butuh permission billing/finance.
router.get('/', async (req, res) => {
  const userId = Number(req.session.user.id);
  const agingDays = await cashAgingDays();
  const collectorExpr = 'COALESCE(p.collector_user_id,p.received_by)';
  const base = `FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id`;
  const [[held], [pending], [settlements], [[totals]]] = await Promise.all([
    db.execute(`SELECT p.id,p.amount,p.reference,p.paid_at,c.name customer_name,c.customer_code,i.invoice_number,s.code site_code,cl.name cluster_name,
        DATEDIFF(CURDATE(),DATE(p.paid_at)) age_days
      ${base} WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' AND ${collectorExpr}=? ORDER BY p.paid_at,p.id`, [userId]),
    db.execute(`SELECT p.id,p.amount,p.reference,p.paid_at,c.name customer_name,c.customer_code,i.invoice_number
      ${base} WHERE p.method='cash' AND p.status='pending' AND ${collectorExpr}=? ORDER BY p.paid_at DESC LIMIT 100`, [userId]),
    db.execute(`SELECT cs.id,cs.code,cs.settlement_date,cs.mode,cs.status,cs.handed_amount,cs.difference_amount,au.name created_by_name,
        COUNT(p.id) payment_count,COALESCE(SUM(p.amount),0) my_amount
      FROM cash_settlements cs JOIN payments p ON p.settlement_id=cs.id LEFT JOIN users au ON au.id=cs.created_by
      WHERE ${collectorExpr}=? GROUP BY cs.id,cs.code,cs.settlement_date,cs.mode,cs.status,cs.handed_amount,cs.difference_amount,au.name ORDER BY cs.id DESC LIMIT 60`, [userId]),
    db.execute(`SELECT
        COALESCE(SUM(CASE WHEN p.settlement_status='settled' AND p.settled_at>=DATE_FORMAT(CURDATE(),'%Y-%m-01') THEN p.amount ELSE 0 END),0) settled_month,
        COALESCE(SUM(CASE WHEN p.settlement_status='settled' AND p.settled_at>=DATE_FORMAT(CURDATE(),'%Y-%m-01') THEN 1 ELSE 0 END),0) settled_month_count
      FROM payments p WHERE p.method='cash' AND ${collectorExpr}=?`, [userId])
  ]);
  const heldTotal = held.reduce((a, p) => a + Number(p.amount || 0), 0);
  const overdue = held.filter(p => Number(p.age_days) > agingDays);
  res.render('payments/my-cash', {
    title: 'Cash Saya', held, pending, settlements, totals: totals || {}, heldTotal,
    overdueTotal: overdue.reduce((a, p) => a + Number(p.amount || 0), 0), overdueCount: overdue.length, agingDays
  });
});

router.get('/settlements/:id/receipt.pdf', async (req, res) => {
  const [[own]] = await db.execute(`SELECT 1 ok FROM payments p WHERE p.settlement_id=? AND COALESCE(p.collector_user_id,p.received_by)=? LIMIT 1`, [Number(req.params.id), Number(req.session.user.id)]);
  if (!own) return res.status(404).send('Tanda terima tidak ditemukan.');
  return streamSettlementReceipt(res, req.params.id, { disposition: req.query.download === '1' ? 'attachment' : 'inline' });
});

module.exports = router;
