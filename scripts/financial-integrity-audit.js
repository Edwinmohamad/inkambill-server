const db=require('../config/db');
(async()=>{try{
 const checks=[];
 const q=async(name,sql)=>{const [rows]=await db.query(sql);checks.push({name,count:Number(rows[0]?.n||0)});};
 await q('confirmed payment tanpa cash journal',`SELECT COUNT(*) n FROM payments p WHERE p.status='confirmed' AND (p.method<>'cash' OR p.settlement_status='settled') AND NOT EXISTS(SELECT 1 FROM cash_transactions ct WHERE ct.source_id=p.id AND ct.source_type IN ('payment','install_income'))`);
 await q('payment punya >1 income journal',`SELECT COUNT(*) n FROM (SELECT source_id FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE ct.source_id IS NOT NULL AND ct.source_type IN ('payment','install_income') AND cc.type='income' GROUP BY source_id HAVING COUNT(*)>1)x`);
 await q('cash held tapi journal sudah ada',`SELECT COUNT(*) n FROM payments p WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' AND EXISTS(SELECT 1 FROM cash_transactions ct WHERE ct.source_type='payment' AND ct.source_id=p.id)`);
 await q('invoice paid mismatch confirmed payment',`SELECT COUNT(*) n FROM invoices i LEFT JOIN (SELECT invoice_id,SUM(amount) a FROM payments WHERE status='confirmed' GROUP BY invoice_id)p ON p.invoice_id=i.id WHERE ABS(COALESCE(p.a,0)-COALESCE(i.paid_amount,0))>0.01 OR ABS(GREATEST(i.total-COALESCE(p.a,0),0)-COALESCE(i.outstanding,0))>0.01`);
 console.table(checks);const bad=checks.reduce((a,x)=>a+x.count,0);console.log(`FINANCIAL_INTEGRITY=${bad===0?'PASS':'FAIL'} anomalies=${bad}`);process.exitCode=bad?2:0;
 }catch(e){console.error(e);process.exitCode=1;}finally{await db.end();}})();
