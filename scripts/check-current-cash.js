require('dotenv').config();
const db=require('../config/db');

(async()=>{
  try{
    const from=process.argv[2]||'2026-09-01';
    const to=process.argv[3]||'2026-09-30';
    const [[cash]]=await db.execute(`SELECT
      COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE -ct.amount END),0) balance,
      COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE 0 END),0) income,
      COALESCE(SUM(CASE WHEN cc.type='expense' THEN ct.amount ELSE 0 END),0) expense
      FROM cash_transactions ct
      JOIN cash_categories cc ON cc.id=ct.category_id
      LEFT JOIN payments p ON ct.source_type='payment' AND p.id=ct.source_id
      WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED'
        AND (COALESCE(ct.source_type,'manual')<>'payment' OR (p.status='confirmed' AND (p.method<>'cash' OR p.settlement_status='settled')))
        AND ct.transaction_date BETWEEN ? AND ?`,[from,to]);
    const [[held]]=await db.execute(`SELECT COALESCE(SUM(amount),0) held,COUNT(*) held_count
      FROM payments WHERE method='cash' AND status='confirmed' AND settlement_status='held_by_staff'
        AND DATE(paid_at) BETWEEN ? AND ?`,[from,to]);
    const [[missing]]=await db.execute(`SELECT COALESCE(SUM(p.amount),0) amount,COUNT(*) total
      FROM payments p WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='settled'
        AND DATE(COALESCE(p.settled_at,p.booked_at,p.paid_at)) BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM cash_transactions ct WHERE ct.source_id=p.id AND ct.source_type IN ('payment','install_income'))`,[from,to]);
    console.log(JSON.stringify({period:{from,to},cash,held,settled_missing_journal:missing}));
  }catch(error){console.error(error.code||error.message);process.exitCode=1;}
  finally{await db.end();}
})();
