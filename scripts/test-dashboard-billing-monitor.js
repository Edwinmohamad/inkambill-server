const assert=require('assert');
const Module=require('module');
const originalLoad=Module._load;

function result(rows){return Promise.resolve([rows,[]]);}
const fakeDb={
  execute(sql,params=[]){
    if(sql.includes('COUNT(*) invoice_count')&&sql.includes('LEFT JOIN (SELECT invoice_id,COUNT(*) pending_count'))return result([
      {cycle:15,invoice_count:10,paid_count:7,pending_count:1,open_count:2,billed:1700000,collected:1190000,outstanding:510000,pending_amount:170000},
      {cycle:30,invoice_count:8,paid_count:4,pending_count:2,open_count:2,billed:1920000,collected:960000,outstanding:960000,pending_amount:480000}
    ]);
    if(sql.includes('NOT EXISTS (SELECT 1 FROM payments pp'))return result([{cycle:15,customer_id:1,customer_name:'Belum Bayar',customer_code:'KRW-15-001',site_code:'KRW',outstanding:170000,days_late:2}]);
    if(sql.includes("WHERE p.status='pending'")&&sql.includes('GROUP BY i.id'))return result([{cycle:30,customer_id:2,customer_name:'Pending',customer_code:'KRW-30-001',site_code:'KRW',pending_amount:240000}]);
    if(sql.includes('DATE_SUB(CURDATE(),INTERVAL 1 DAY)'))return result([{amount:500000}]);
    if(sql.includes("DATE(CASE WHEN p.method='cash' THEN p.settled_at ELSE p.verified_at END)=CURDATE()"))return result([{tx_count:3,amount:680000,transfer_amount:410000,qris_amount:100000,cash_amount:170000}]);
    if(sql.includes("p.status='pending' AND i.period_year=?"))return result([{tx_count:2,amount:410000}]);
    if(sql.includes('ORDER BY recognized_at DESC'))return result([{payment_id:9,amount:170000,method:'transfer',recognized_at:'2026-09-30 10:00:00',cycle:15,customer_id:1,customer_name:'Budi',site_code:'KRW'}]);
    if(sql.includes('GROUP BY DAY(CASE WHEN p.method'))return result([{day_no:15,tx_count:2,amount:340000},{day_no:30,tx_count:3,amount:680000}]);
    if(sql.includes('GROUP BY DATE(COALESCE(p.verified_at,p.paid_at)),cycle'))return result([{event_date:'2026-09-10',cycle:15,amount:340000},{event_date:'2026-09-28',cycle:30,amount:480000}]);
    if(sql.includes("i.status='paid'")&&sql.includes('DATE(MAX(COALESCE(p.verified_at,p.paid_at)))'))return result([{invoice_id:1,cycle:15,event_date:'2026-09-10'},{invoice_id:2,cycle:30,event_date:'2026-09-28'}]);
    if(sql.includes('DATEDIFF(DATE(MAX(p.paid_at)),i.due_date)'))return result([{invoice_id:1,cycle:15,timing_days:-2},{invoice_id:2,cycle:30,timing_days:2}]);
    if(sql.includes('(i.period_year*100+i.period_month) BETWEEN'))return result([
      {period_year:2026,period_month:8,cycle:15,invoice_count:10,paid_count:6,billed:1700000,collected:1020000},
      {period_year:2026,period_month:8,cycle:30,invoice_count:8,paid_count:5,billed:1920000,collected:1200000},
      {period_year:2026,period_month:9,cycle:15,invoice_count:10,paid_count:7,billed:1700000,collected:1190000},
      {period_year:2026,period_month:9,cycle:30,invoice_count:8,paid_count:4,billed:1920000,collected:960000}
    ]);
    throw new Error(`Unexpected SQL in dashboard monitor test:\n${sql}\nparams=${JSON.stringify(params)}`);
  }
};
Module._load=function(request,parent,isMain){
  if(request==='../config/db'&&parent?.filename?.endsWith('dashboardBillingMonitorService.js'))return fakeDb;
  return originalLoad.call(this,request,parent,isMain);
};

(async()=>{
  const svc=require('../services/dashboardBillingMonitorService');
  assert.equal(svc.normalizeCycle('15'),'15');
  assert.equal(svc.normalizeCycle('x'),'all');
  assert.equal(svc.normalizeTrendMonths('12'),12);
  assert.equal(svc.normalizeTrendMonths('9'),6);
  assert.equal(svc.paymentTimingLabel(-1),'early');
  assert.equal(svc.paymentTimingLabel(0),'on_time');
  assert.equal(svc.paymentTimingLabel(3),'h1_3');
  assert.equal(svc.paymentTimingLabel(4),'late');

  const monitor=await svc.loadDashboardBillingMonitor({month:9,year:2026,siteId:1,cycle:'all',trendMonths:6,now:new Date('2026-09-30T12:00:00+07:00')});
  assert.equal(monitor.today.amount,680000,'pendapatan hari ini hanya jurnal pembayaran yang sudah masuk kas');
  assert.equal(monitor.today.pendingCount,2,'pending periode terpilih harus terpisah dari pendapatan');
  assert.equal(monitor.cycles['15'].customerRate,70);
  assert.equal(monitor.cycles['30'].customerRate,50);
  assert.equal(monitor.cycles['15'].deltaCustomerRate,10,'perbandingan bulan lalu');
  assert.equal(monitor.timing.early,1);
  assert.equal(monitor.timing.h1_3,1);
  assert.equal(monitor.unpaid['15'].length,1);
  assert.equal(monitor.pending['30'].length,1);
  assert.equal(monitor.revenueSeries.income[14],340000);
  assert.equal(monitor.revenueSeries.income[29],680000);
  assert.equal(monitor.progress.cycles['15'].customer.at(-1),10,'1 dari 10 invoice lunas pada fixture progress');
  assert(monitor.trend.labels.length===6,'trend 6 bulan harus berisi 6 label');
  console.log('Dashboard billing monitor tests OK');
})().catch(err=>{console.error(err);process.exit(1);});
