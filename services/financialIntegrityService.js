const db = require('../config/db');

// Audit read-only untuk memastikan tiga sumber keuangan tetap selaras:
// invoice <- payment confirmed <- jurnal Data Kas. Fungsi ini sengaja tidak
// memperbaiki data; perbaikan hanya boleh dilakukan melalui alur approval atau
// tool rekonsiliasi yang diaudit.
// Shared, read-only reconciliation predicate. Keep count and row diagnostics identical.
// A correct total with a wrong site/category/date is still a financial discrepancy.
const CLOSING_MISMATCH_SQL = `(
      ct.id IS NULL
      OR COALESCE(ct.approval_status,'APPROVED')<>'APPROVED'
      OR ct.internal_transfer_key IS NOT NULL
      OR ct.transaction_date NOT BETWEEN cp.period_start AND cp.period_end
      OR ABS(ce.amount-ct.amount)>0.01
      OR ce.entry_type<>CASE WHEN cc.type='income' THEN 'INCOME' ELSE 'EXPENSE' END
      OR ce.entry_date<>ct.transaction_date
      OR TRIM(COALESCE(ce.category,''))<>TRIM(COALESCE(cc.name,''))
      OR UPPER(COALESCE(ce.site_code,''))<>CASE
        WHEN UPPER(COALESCE(s.code,'')) IN ('CDS','KRW','CLM') THEN 'CDS'
        WHEN UPPER(COALESCE(s.code,'')) LIKE '%KUBANG%' OR UPPER(COALESCE(s.code,''))='KBG' THEN 'KBG'
        ELSE UPPER(COALESCE(s.code,'')) END
      OR UPPER(COALESCE(ce.cluster_name,''))<>CASE
        WHEN UPPER(COALESCE(s.code,'')) IN ('KRW','CLM') THEN UPPER(s.code) ELSE '' END
    )`;

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
  closingSyncedMismatch: `SELECT COUNT(*) total FROM closing_entries ce
    JOIN closing_periods cp ON cp.id=ce.closing_id
    LEFT JOIN cash_transactions ct ON ct.id=ce.cash_transaction_id
    LEFT JOIN cash_categories cc ON cc.id=ct.category_id
    LEFT JOIN sites s ON s.id=ct.site_id
    WHERE ce.source_type='cash_sync' AND ce.excluded_at IS NULL
      AND ${CLOSING_MISMATCH_SQL}`,
  debtOverpaid: `SELECT COUNT(*) total FROM finance_debts d
    LEFT JOIN (SELECT debt_id,SUM(amount) paid FROM finance_debt_payments GROUP BY debt_id) p ON p.debt_id=d.id
    WHERE COALESCE(p.paid,0)>d.principal_amount+0.01`
};

// Read-only row-level diagnostic for reconciliation. No customer PII or automatic writes.
async function diagnoseClosingMismatches(limit = 30) {
  const max = Math.max(1, Math.min(100, Number(limit)||30));
  const [rows] = await db.query(`SELECT ce.id closing_entry_id,ce.closing_id,cp.status closing_status,
    cp.period_start,cp.period_end,ce.cash_transaction_id,ce.entry_type,
    ce.amount closing_amount,ce.entry_date,ce.site_code closing_site,ce.cluster_name closing_cluster,
    ce.category closing_category,
    ct.id journal_id,ct.transaction_date journal_date,ct.amount journal_amount,ct.internal_transfer_key,
    ct.approval_status journal_approval,cc.type journal_type,cc.name journal_category,s.code journal_site
    FROM closing_entries ce
    JOIN closing_periods cp ON cp.id=ce.closing_id
    LEFT JOIN cash_transactions ct ON ct.id=ce.cash_transaction_id
    LEFT JOIN cash_categories cc ON cc.id=ct.category_id
    LEFT JOIN sites s ON s.id=ct.site_id
    WHERE ce.source_type='cash_sync' AND ce.excluded_at IS NULL
      AND ${CLOSING_MISMATCH_SQL}
    ORDER BY cp.period_start,ce.id LIMIT ?`,[max]);
  const date=v=>v instanceof Date? v.toISOString().slice(0,10):String(v||'').slice(0,10);
  return rows.map(row=>{
    const reasons=[];
    if(!row.journal_id)reasons.push('source_journal_missing');
    else{
      if(row.journal_approval!=='APPROVED')reasons.push('not_approved');
      if(date(row.journal_date)<date(row.period_start)||date(row.journal_date)>date(row.period_end))reasons.push('outside_closing_period');
      if(Math.abs(Number(row.closing_amount)-Number(row.journal_amount))>0.01)reasons.push('amount_mismatch');
      if(row.entry_type!==(row.journal_type==='income'?'INCOME':'EXPENSE'))reasons.push('flow_type_mismatch');
      if(row.internal_transfer_key)reasons.push('internal_transfer_not_operating');
      if(date(row.entry_date)!==date(row.journal_date))reasons.push('entry_date_mismatch');
      if(String(row.closing_category||'').trim().toLowerCase()!==String(row.journal_category||'').trim().toLowerCase())reasons.push('category_mismatch');
      const sourceSite=String(row.journal_site||'').trim().toUpperCase();
      const expectedSite=['CDS','KRW','CLM'].includes(sourceSite)?'CDS':(sourceSite==='KBG'||sourceSite.includes('KUBANG')?'KBG':sourceSite);
      const expectedCluster=['KRW','CLM'].includes(sourceSite)?sourceSite:'';
      if(String(row.closing_site||'').trim().toUpperCase()!==expectedSite)reasons.push('site_mismatch');
      if(String(row.closing_cluster||'').trim().toUpperCase()!==expectedCluster)reasons.push('cluster_mismatch');
    }
    return {...row,period_start:date(row.period_start),period_end:date(row.period_end),
      entry_date:date(row.entry_date),journal_date:date(row.journal_date),
      reasons};
  });
}

async function auditFinancialIntegrity() {
  const totals = {};
  for (const [name, sql] of Object.entries(CHECKS)) {
    const [rows] = await db.query(sql);
    totals[name] = Number(rows[0]?.total || 0);
  }
  const anomalyCount = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return { checkedAt: new Date().toISOString(), anomalyCount, totals };
}

module.exports = { CHECKS, auditFinancialIntegrity, diagnoseClosingMismatches };
