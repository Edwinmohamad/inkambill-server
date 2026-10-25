const {selectUnsyncedCashRows,toDateKey}=require('./closingSyncService');
const {normalizeSiteCluster,buildClosingCalculation,money}=require('./closingCalculator');

// Read the operational ledger directly: cached/manual Closing rows cannot change it.
async function loadActualClosing({db,start,end,closing={},adjustments=[]}){
  const rows=await selectUnsyncedCashRows({db,closingId:null,start,end});
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
module.exports={loadActualClosing};
