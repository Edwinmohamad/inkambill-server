const db=require('../config/db');

// Payment-date receipts are separate from ledger recognition / cash settlement.
// No invoice-period filter: a transfer today may pay an older invoice.
async function loadCustomerReceipts({date,siteId=null}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date)throw new Error('Tanggal pembayaran tidak valid');
  const params=[date,date];
  const site=siteId?' AND c.site_id=?':'';if(siteId)params.push(Number(siteId));
  const [rows]=await db.execute(`SELECT p.method,p.status,p.settlement_status,
    COUNT(*) transaction_count,COALESCE(SUM(p.amount),0) amount
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.paid_at>=? AND p.paid_at<DATE_ADD(?,INTERVAL 1 DAY)
      AND p.status IN ('confirmed','pending')${site}
    GROUP BY p.method,p.status,p.settlement_status`,params);
  const result={date,amount:0,count:0,transfer:0,cash:0,qris:0,cashHeld:0,pending:0,pendingCount:0};
  for(const row of rows){
    const amount=Number(row.amount||0),count=Number(row.transaction_count||0);
    if(row.status==='pending'){result.pending+=amount;result.pendingCount+=count;continue;}
    if(!['cash','transfer','qris'].includes(row.method))continue;
    result[row.method]+=amount;result.amount+=amount;result.count+=count;
    if(row.method==='cash'&&row.settlement_status==='held_by_staff')result.cashHeld+=amount;
  }
  return result;
}
module.exports={loadCustomerReceipts};
