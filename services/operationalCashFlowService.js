// Operational basis shared with Data Kas and Closing: exclude internal transfers and loan principal.
async function loadMonthlyCashFlow({db,start,end,siteId=null}) {
  const [rows]=await db.execute(`SELECT DATE_FORMAT(ct.transaction_date,'%Y-%m') month_key,COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE 0 END),0) inflow,COALESCE(SUM(CASE WHEN cc.type='expense' THEN ct.amount ELSE 0 END),0) outflow FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN payments source_payment ON ct.source_type IN ('payment','install_income') AND source_payment.id=ct.source_id WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND ct.internal_transfer_key IS NULL AND cc.code NOT IN ('FINPRIN','FINPROUT') AND (COALESCE(ct.source_type,'manual') NOT IN ('payment','install_income') OR (source_payment.status='confirmed' AND (source_payment.method<>'cash' OR source_payment.settlement_status='settled'))) AND ct.transaction_date BETWEEN ? AND ?${siteId ? ' AND ct.site_id=?' : ''} GROUP BY DATE_FORMAT(ct.transaction_date,'%Y-%m') ORDER BY month_key`,[start,end,...(siteId?[siteId]:[])]);
  return rows;
}
module.exports={loadMonthlyCashFlow};
