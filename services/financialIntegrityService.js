const db = require('../config/db');

// Audit read-only untuk memastikan tiga sumber keuangan tetap selaras:
// invoice <- payment confirmed <- jurnal Data Kas. Fungsi ini sengaja tidak
// memperbaiki data; perbaikan hanya boleh dilakukan melalui alur approval atau
// tool rekonsiliasi yang diaudit.
const CHECKS = {
  invoiceMismatch: `SELECT COUNT(*) total FROM invoices i
    LEFT JOIN (SELECT invoice_id,SUM(CASE WHEN status='confirmed' THEN amount ELSE 0 END) paid FROM payments GROUP BY invoice_id) p ON p.invoice_id=i.id
    WHERE i.status NOT IN ('cancelled','refunded') AND (
      ABS(COALESCE(i.paid_amount,0)-COALESCE(p.paid,0))>0.01 OR
      ABS(COALESCE(i.outstanding,0)-GREATEST(i.total-COALESCE(p.paid,0),0))>0.01 OR
      (i.status='paid')<>(COALESCE(p.paid,0)>=i.total)
    )`,
  duplicatePaymentJournal: `SELECT COUNT(*) total FROM (
    SELECT source_id FROM cash_transactions
    WHERE source_type='payment' AND COALESCE(approval_status,'APPROVED')='APPROVED'
    GROUP BY source_id HAVING COUNT(*)>1
  ) duplicate_rows`,
  missingPaymentJournal: `SELECT COUNT(*) total FROM payments p
    LEFT JOIN cash_transactions ct ON ct.source_type='payment' AND ct.source_id=p.id AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'
    WHERE p.status='confirmed' AND (p.method IN ('transfer','qris') OR (p.method='cash' AND p.settlement_status='settled')) AND ct.id IS NULL`,
  prematureCashJournal: `SELECT COUNT(*) total FROM cash_transactions ct
    JOIN payments p ON ct.source_type='payment' AND ct.source_id=p.id
    WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED'
      AND (p.status<>'confirmed' OR (p.method='cash' AND p.settlement_status<>'settled'))`,
  debtOverpaid: `SELECT COUNT(*) total FROM finance_debts d
    LEFT JOIN (SELECT debt_id,SUM(amount) paid FROM finance_debt_payments GROUP BY debt_id) p ON p.debt_id=d.id
    WHERE COALESCE(p.paid,0)>d.principal_amount+0.01`
};

async function auditFinancialIntegrity() {
  const totals = {};
  for (const [name, sql] of Object.entries(CHECKS)) {
    const [rows] = await db.query(sql);
    totals[name] = Number(rows[0]?.total || 0);
  }
  const anomalyCount = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return { checkedAt: new Date().toISOString(), anomalyCount, totals };
}

module.exports = { CHECKS, auditFinancialIntegrity };
