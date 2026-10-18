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
    WHERE source_type IN ('payment','install_income') AND COALESCE(approval_status,'APPROVED')='APPROVED'
    GROUP BY source_id HAVING COUNT(*)>1
  ) duplicate_rows`,
  missingPaymentJournal: `SELECT COUNT(*) total FROM payments p
    LEFT JOIN cash_transactions ct ON ct.source_type IN ('payment','install_income') AND ct.source_id=p.id AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'
    WHERE p.status='confirmed' AND (p.method IN ('transfer','qris') OR (p.method='cash' AND p.settlement_status='settled')) AND ct.id IS NULL`,
  prematureCashJournal: `SELECT COUNT(*) total FROM cash_transactions ct
    JOIN payments p ON ct.source_type='payment' AND ct.source_id=p.id
    WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED'
      AND (p.status<>'confirmed' OR (p.method='cash' AND p.settlement_status<>'settled'))`,
  orphanApprovedCash: `SELECT COUNT(*) total FROM cash_transactions ct LEFT JOIN payments p ON ct.source_type='payment' AND ct.source_id=p.id WHERE ct.source_type='payment' AND p.id IS NULL AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'`,
  journalAmountMismatch: `SELECT COUNT(*) total FROM cash_transactions ct JOIN payments p ON ct.source_type='payment' AND ct.source_id=p.id WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND ABS(ct.amount-p.amount)>0.01`,
  pendingPaymentJournal: `SELECT COUNT(*) total FROM payments p JOIN cash_transactions ct ON ct.source_type='payment' AND ct.source_id=p.id WHERE p.status='pending' AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'`,
  invalidApprovedManualCash: `SELECT COUNT(*) total FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE (ct.source_type IS NULL OR ct.source_type='manual') AND COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND (ct.amount<=0 OR cc.type NOT IN ('income','expense'))`,
  closingSyncedMismatch: `SELECT COUNT(*) total FROM closing_entries ce JOIN closing_periods cp ON cp.id=ce.closing_id LEFT JOIN cash_transactions ct ON ct.id=ce.cash_transaction_id LEFT JOIN cash_categories cc ON cc.id=ct.category_id WHERE ce.source_type='cash_sync' AND ce.excluded_at IS NULL AND (ct.id IS NULL OR COALESCE(ct.approval_status,'APPROVED')<>'APPROVED' OR ct.transaction_date NOT BETWEEN cp.period_start AND cp.period_end OR ABS(ce.amount-ct.amount)>0.01 OR ce.entry_type<>CASE WHEN cc.type='income' THEN 'INCOME' ELSE 'EXPENSE' END)`,
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
