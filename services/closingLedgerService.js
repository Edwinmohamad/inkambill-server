const {toDateKey}=require('./closingSyncService');
const {normalizeSiteCluster,buildClosingCalculation,money}=require('./closingCalculator');


// Periode jurnal memakai aturan bersama Data Kas & Laporan Arus Kas (services/ledgerPeriodService.js).
const { LEDGER_PERIOD_SQL, ledgerPeriodParams } = require('./ledgerPeriodService');
const periodPredicate = LEDGER_PERIOD_SQL;
const periodParams = (start,end) => ledgerPeriodParams(start,end);
const sourceJoins = `LEFT JOIN payments source_payment ON ct.source_type IN ('payment','install_income') AND source_payment.id=ct.source_id
     LEFT JOIN invoices source_invoice ON source_invoice.id=source_payment.invoice_id`;

async function selectClosingCashRows({db,start,end}) {
  const [rows] = await db.execute(`SELECT ct.id,ct.transaction_date,ct.name,ct.amount,ct.notes,cc.type category_type,cc.name category_name,cc.code category_code,s.code site_code
    FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id
    LEFT JOIN sites s ON s.id=ct.site_id ${sourceJoins}
    WHERE ${periodPredicate} AND ct.internal_transfer_key IS NULL
      AND cc.code NOT IN ('FINPRIN','FINPROUT')
      AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'
      AND (COALESCE(ct.source_type,'manual') NOT IN ('payment','install_income') OR (source_payment.status='confirmed' AND (source_payment.method<>'cash' OR source_payment.settlement_status='settled')))
    ORDER BY ct.transaction_date,ct.id`,periodParams(start,end));
  return rows;
}

async function countPendingClosingCash({db,start,end}) {
  const [[row]] = await db.execute(`SELECT COUNT(*) n FROM cash_transactions ct ${sourceJoins}
    WHERE ${periodPredicate} AND ct.approval_status='PENDING_APPROVAL'`,periodParams(start,end));
  return Number(row.n || 0);
}

// Read the operational ledger directly: cached/manual Closing rows cannot change it.
async function loadActualClosing({db,start,end,closing={},adjustments=[]}){
  const rows=await selectClosingCashRows({db,start,end});
  const lineItems=rows.map(row=>{
    const site=row.site_code?normalizeSiteCluster(row.site_code,null):null;
    return {id:row.id,cash_transaction_id:row.id,source_type:'cash_sync',entry_type:row.category_type==='income'?'INCOME':'EXPENSE',site_code:site?.site||row.site_code||'UNASSIGNED',cluster_name:site?.cluster||null,category:row.category_name,amount:Number(row.amount),entry_date:toDateKey(row.transaction_date),description:[row.name,row.notes].filter(Boolean).join(' · ')};
  });
  const payments=lineItems.filter(r=>r.entry_type==='INCOME').map(r=>({...r,paid_date:r.entry_date,customer_name:r.description,entry_source:'cash_sync'}));
  const expenses=lineItems.filter(r=>r.entry_type==='EXPENSE').map(r=>({...r,transaction_date:r.entry_date,name:r.category,entry_source:'cash_sync'}));
  const settings={...closing,mode:'AUTO',manual_revenue:0,manual_expense:0};
  const calculation=buildClosingCalculation({payments,expenses,heldCash:[],adjustments,closing:settings,mode:'auto',lineItems});
  const income=payments.reduce((sum,r)=>sum+money(r.amount),0),expense=expenses.reduce((sum,r)=>sum+money(r.amount),0);
  const invalid=rows.filter(r=>!r.site_code||!normalizeSiteCluster(r.site_code,null)||Number(r.amount)<=0||!['income','expense'].includes(r.category_type)).length;
  return {...calculation,closing:settings,payments,expenses,heldCash:[],excludedItems:[],ledgerActual:true,ledgerSummary:{income,expense,net:income-expense,count:rows.length,invalid},lastSyncedText:null};
}
module.exports={loadActualClosing,countPendingClosingCash};
