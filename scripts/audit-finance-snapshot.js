// Read-only diagnostic. Amounts are ledger totals, NOT independently verified bank/cash balances.
// Run in an environment whose MariaDB credentials point to the intended database.
require('dotenv').config();
const db=require('../config/db');
(async()=>{
 try{
  const [siteRows]=await db.query(`
    SELECT COALESCE(s.code,'UNASSIGNED') site,
      COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE 0 END),0) income,
      COALESCE(SUM(CASE WHEN cc.type='expense' THEN ct.amount ELSE 0 END),0) expense,
      COUNT(*) approved_entries
    FROM cash_transactions ct
    JOIN cash_categories cc ON cc.id=ct.category_id
    LEFT JOIN sites s ON s.id=ct.site_id
    LEFT JOIN payments p ON ct.source_type='payment' AND p.id=ct.source_id
    WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED'
      AND ct.internal_transfer_key IS NULL
      AND (COALESCE(ct.source_type,'manual')<>'payment'
        OR (p.status='confirmed' AND (p.method<>'cash' OR p.settlement_status='settled')))
    GROUP BY COALESCE(s.code,'UNASSIGNED') ORDER BY site`);
  const [heldRows]=await db.query(`
    SELECT COALESCE(s.code,'UNASSIGNED') site,
      COALESCE(SUM(p.amount),0) held_by_staff,COUNT(*) payments
    FROM payments p JOIN invoices i ON i.id=p.invoice_id
    JOIN customers c ON c.id=i.customer_id
    LEFT JOIN sites s ON s.id=c.site_id
    WHERE p.method='cash' AND p.status='confirmed'
      AND p.settlement_status='held_by_staff'
    GROUP BY COALESCE(s.code,'UNASSIGNED') ORDER BY site`);
  const [pendingRows]=await db.query(`
    SELECT COALESCE(s.code,'UNASSIGNED') site,
      COALESCE(SUM(ct.amount),0) pending_amount,COUNT(*) transactions
    FROM cash_transactions ct LEFT JOIN sites s ON s.id=ct.site_id
    WHERE ct.approval_status='PENDING_APPROVAL'
    GROUP BY COALESCE(s.code,'UNASSIGNED') ORDER BY site`);
  const {auditFinancialIntegrity}=require('../services/financialIntegrityService');
  const integrity=await auditFinancialIntegrity();
  const snapshot={generated_at:new Date().toISOString(),basis:'ledger all-time; excludes internal transfers; opening balances and actual bank/cash count NOT included',site_ledger:siteRows.map(r=>({...r,net:Number(r.income)-Number(r.expense)})),cash_held:heldRows,pending_cash:pendingRows,integrity};
  console.log(JSON.stringify(snapshot,null,2));
  process.exitCode=integrity.anomalyCount>0?2:0;
 }catch(e){console.error('Financial snapshot failed:',e.message);process.exitCode=1}
 finally{await db.end()}
})();
