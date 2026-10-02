const db = require('../config/db');

// Dashboard Billing Monitor v1.26
// Satu sumber data untuk: pendapatan yang BENAR-BENAR sudah masuk Data Kas,
// collection siklus 15/30, progres approval harian, dan daftar pelanggan yang belum bayar.
//
// Aturan pengakuan pendapatan harian:
// - transfer/QRIS: saat pembayaran di-approve (verified_at) DAN jurnal Data Kas source=payment sudah ada.
// - cash: saat setoran cash dikonfirmasi (settled_at) DAN jurnal Data Kas source=payment sudah ada.
// Dengan begitu pembayaran pending tidak pernah dihitung sebagai pendapatan dan cash yang masih di tim
// juga belum dianggap uang kas perusahaan.

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
const CYCLE_EXPR = `CASE WHEN DAY(i.due_date)<=22 THEN 15 ELSE 30 END`;
const RECOGNIZED_AT_EXPR = `CASE WHEN p.method='cash' THEN p.settled_at ELSE p.verified_at END`;
const CASH_POSTED_EXISTS = `EXISTS (
  SELECT 1 FROM cash_transactions ct
  WHERE ct.source_type='payment' AND ct.source_id=p.id
    AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'
    AND ct.archived_at IS NULL
)`;

function normalizeCycle(value){
  const v=String(value||'all').trim();
  return v==='15'||v==='30'?v:'all';
}
function normalizeTrendMonths(value){
  const n=Number.parseInt(value,10);
  return [3,6,12].includes(n)?n:6;
}
function cycleWhere(cycle){
  if(cycle==='15') return ` AND DAY(i.due_date)<=22`;
  if(cycle==='30') return ` AND DAY(i.due_date)>22`;
  return '';
}
function siteWhere(siteId){ return siteId ? ` AND c.site_id=?` : ''; }
function siteParams(siteId){ return siteId ? [Number(siteId)] : []; }
function dateKey(value){
  const d=value instanceof Date?new Date(value):new Date(`${value}T12:00:00`);
  if(Number.isNaN(d.getTime()))return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addDays(value,days){ const d=new Date(value);d.setDate(d.getDate()+days);return d; }
function monthStart(year,month){ return new Date(Number(year),Number(month)-1,1,12,0,0,0); }
function monthEnd(year,month){ return new Date(Number(year),Number(month),0,12,0,0,0); }
function previousMonth(year,month){ const d=new Date(Number(year),Number(month)-2,1,12);return {year:d.getFullYear(),month:d.getMonth()+1}; }
function monthSequence(year,month,count){
  const rows=[];
  for(let offset=count-1;offset>=0;offset--){
    const d=new Date(Number(year),Number(month)-1-offset,1,12);
    rows.push({year:d.getFullYear(),month:d.getMonth()+1,key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,label:`${MONTH_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`});
  }
  return rows;
}
function emptyCycle(cycle){
  return {cycle,invoiceCount:0,paidCount:0,pendingCount:0,openCount:0,billed:0,collected:0,outstanding:0,pendingAmount:0,customerRate:0,nominalRate:0,previousCustomerRate:null,deltaCustomerRate:null};
}
function pct(value,total){ return Number(total)>0?Math.max(0,Math.min(100,Math.round(Number(value||0)/Number(total)*1000)/10)):0; }
function paymentTimingLabel(days){
  const n=Number(days);
  if(n<0)return 'early';
  if(n===0)return 'on_time';
  if(n<=3)return 'h1_3';
  return 'late';
}
function buildTimeline({year,month,now=new Date()}){
  const start=monthStart(year,month);
  let end=addDays(monthEnd(year,month),3);
  // Jangan menggambar hari yang belum terjadi. Untuk periode lampau yang masih berada
  // di jendela H+1..H+3 (mis. 1 Oktober saat melihat tagihan September), grafik berhenti
  // di hari ini dan akan memanjang otomatis sampai H+3 seiring waktu.
  const today=new Date(now);today.setHours(12,0,0,0);
  if(today>=start && today<end) end=today;
  const dates=[];for(let d=new Date(start);d<=end;d=addDays(d,1))dates.push(new Date(d));
  return dates;
}
function buildProgressSeries({year,month,cycles,nominalEvents,completionEvents,now}){
  const dates=buildTimeline({year,month,now});
  const start=dates[0]||monthStart(year,month);
  const labels=dates.map((d,index)=>{
    if(d.getMonth()+1===Number(month))return String(d.getDate());
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  });
  const iso=dates.map(dateKey);
  const out={labels,dates:iso,cycles:{}};
  for(const cycle of ['15','30']){
    const denom=cycles[cycle]||emptyCycle(Number(cycle));
    const nominal=nominalEvents.filter(r=>String(r.cycle)===cycle).map(r=>({date:dateKey(r.event_date),amount:Number(r.amount||0)})).filter(r=>r.date);
    const completed=completionEvents.filter(r=>String(r.cycle)===cycle).map(r=>dateKey(r.event_date)).filter(Boolean);
    let nominalBase=nominal.filter(r=>r.date<dateKey(start)).reduce((a,r)=>a+r.amount,0);
    let customerBase=completed.filter(d=>d<dateKey(start)).length;
    const nominalByDate=new Map();for(const row of nominal)nominalByDate.set(row.date,(nominalByDate.get(row.date)||0)+row.amount);
    const customerByDate=new Map();for(const d of completed)customerByDate.set(d,(customerByDate.get(d)||0)+1);
    const nominalRates=[],customerRates=[];let runningNominal=nominalBase,runningCustomer=customerBase;
    for(const d of iso){runningNominal+=Number(nominalByDate.get(d)||0);runningCustomer+=Number(customerByDate.get(d)||0);nominalRates.push(pct(runningNominal,denom.billed));customerRates.push(pct(runningCustomer,denom.invoiceCount));}
    out.cycles[cycle]={customer:customerRates,nominal:nominalRates};
  }
  return out;
}
function buildRevenueSeries({year,month,rows}){
  const days=new Date(Number(year),Number(month),0).getDate();
  const labels=Array.from({length:days},(_,i)=>String(i+1));
  const income=Array(days).fill(0),count=Array(days).fill(0);
  for(const row of rows){const day=Number(row.day_no);if(day>=1&&day<=days){income[day-1]=Number(row.amount||0);count[day-1]=Number(row.tx_count||0);}}
  return {labels,income,count};
}
function buildTrend({year,month,trendMonths,rows}){
  const periods=monthSequence(year,month,trendMonths);
  const indexed=new Map(rows.map(r=>[`${r.period_year}-${String(r.period_month).padStart(2,'0')}-${r.cycle}`,r]));
  const cycles={};
  for(const cycle of ['15','30']){
    cycles[cycle]={customer:[],nominal:[]};
    for(const period of periods){const r=indexed.get(`${period.year}-${String(period.month).padStart(2,'0')}-${cycle}`)||{};cycles[cycle].customer.push(pct(r.paid_count,r.invoice_count));cycles[cycle].nominal.push(pct(r.collected,r.billed));}
  }
  return {labels:periods.map(p=>p.label),periods:periods.map(p=>p.key),cycles};
}

async function loadDashboardBillingMonitor({month,year,siteId=null,cycle='all',trendMonths=6,incomeDate=null,now=new Date()}={}){
  const selectedCycle=normalizeCycle(cycle);const selectedTrend=normalizeTrendMonths(trendMonths);
  const selectedIncomeDate=/^\d{4}-\d{2}-\d{2}$/.test(String(incomeDate||''))?String(incomeDate):dateKey(now);
  const sw=siteWhere(siteId),sp=siteParams(siteId),cw=cycleWhere(selectedCycle);
  const trendPeriods=monthSequence(year,month,selectedTrend);const firstTrend=trendPeriods[0];

  const cycleSummarySql=`SELECT ${CYCLE_EXPR} cycle,
      COUNT(*) invoice_count,
      COALESCE(SUM(i.status='paid'),0) paid_count,
      COALESCE(SUM(CASE WHEN COALESCE(pend.pending_count,0)>0 THEN 1 ELSE 0 END),0) pending_count,
      COALESCE(SUM(CASE WHEN i.outstanding>0 AND COALESCE(pend.pending_count,0)=0 THEN 1 ELSE 0 END),0) open_count,
      COALESCE(SUM(i.total),0) billed,
      COALESCE(SUM(i.paid_amount),0) collected,
      COALESCE(SUM(i.outstanding),0) outstanding,
      COALESCE(SUM(COALESCE(pend.pending_amount,0)),0) pending_amount
    FROM invoices i JOIN customers c ON c.id=i.customer_id
    LEFT JOIN (SELECT invoice_id,COUNT(*) pending_count,COALESCE(SUM(amount),0) pending_amount FROM payments WHERE status='pending' GROUP BY invoice_id) pend ON pend.invoice_id=i.id
    WHERE i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}
    GROUP BY ${CYCLE_EXPR} ORDER BY cycle`;

  const unpaidSql=`SELECT i.id invoice_id,i.invoice_number,i.due_date,i.outstanding,c.id customer_id,c.customer_code,c.name customer_name,(c.is_new_install=1 AND COALESCE(c.activation_date,c.created_at)>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)) is_new_customer,c.phone,s.code site_code,cl.name cluster_name,
      ${CYCLE_EXPR} cycle,DATEDIFF(CURDATE(),i.due_date) days_late
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    WHERE i.period_year=? AND i.period_month=? AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
      AND c.customer_status='active' AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM payments pp WHERE pp.invoice_id=i.id AND pp.status='pending')${sw}
    ORDER BY cycle,i.due_date,c.name LIMIT 500`;

  const pendingListSql=`SELECT i.id invoice_id,i.invoice_number,i.due_date,i.outstanding,c.id customer_id,c.customer_code,c.name customer_name,(c.is_new_install=1 AND COALESCE(c.activation_date,c.created_at)>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)) is_new_customer,c.phone,s.code site_code,cl.name cluster_name,
      ${CYCLE_EXPR} cycle,COALESCE(SUM(p.amount),0) pending_amount,MIN(p.paid_at) paid_at
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    WHERE p.status='pending' AND i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}
    GROUP BY i.id,i.invoice_number,i.due_date,i.outstanding,c.id,c.customer_code,c.name,c.phone,s.code,cl.name,cycle
    ORDER BY cycle,paid_at,c.name LIMIT 500`;

  const todayRevenueSql=`SELECT COUNT(*) tx_count,COALESCE(SUM(p.amount),0) amount,
      COALESCE(SUM(CASE WHEN p.method='transfer' THEN p.amount ELSE 0 END),0) transfer_amount,
      COALESCE(SUM(CASE WHEN p.method='qris' THEN p.amount ELSE 0 END),0) qris_amount,
      COALESCE(SUM(CASE WHEN p.method='cash' THEN p.amount ELSE 0 END),0) cash_amount
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.status='confirmed' AND ${RECOGNIZED_AT_EXPR} IS NOT NULL AND DATE(${RECOGNIZED_AT_EXPR})=?
      AND ${CASH_POSTED_EXISTS}${sw}${cw}`;

  const yesterdayRevenueSql=`SELECT COALESCE(SUM(p.amount),0) amount
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.status='confirmed' AND ${RECOGNIZED_AT_EXPR} IS NOT NULL AND DATE(${RECOGNIZED_AT_EXPR})=DATE_SUB(?,INTERVAL 1 DAY)
      AND ${CASH_POSTED_EXISTS}${sw}${cw}`;

  const pendingSummarySql=`SELECT COUNT(*) tx_count,COALESCE(SUM(p.amount),0) amount
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.status='pending' AND i.period_year=? AND i.period_month=?
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}${cw}`;

  const recentIncomeSql=`SELECT p.id payment_id,p.amount,p.method,p.bank_name,p.reference,${RECOGNIZED_AT_EXPR} recognized_at,
      i.id invoice_id,i.invoice_number,${CYCLE_EXPR} cycle,c.id customer_id,c.customer_code,c.name customer_name,(c.is_new_install=1 AND COALESCE(c.activation_date,c.created_at)>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)) is_new_customer,s.code site_code
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id
    WHERE p.status='confirmed' AND ${RECOGNIZED_AT_EXPR} IS NOT NULL AND ${CASH_POSTED_EXISTS}
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}${cw}
    ORDER BY recognized_at DESC,p.id DESC LIMIT 8`;

  const revenueDailySql=`SELECT DAY(${RECOGNIZED_AT_EXPR}) day_no,COUNT(*) tx_count,COALESCE(SUM(p.amount),0) amount
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.status='confirmed' AND ${RECOGNIZED_AT_EXPR} IS NOT NULL
      AND YEAR(${RECOGNIZED_AT_EXPR})=? AND MONTH(${RECOGNIZED_AT_EXPR})=? AND ${CASH_POSTED_EXISTS}
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}${cw}
    GROUP BY DAY(${RECOGNIZED_AT_EXPR}) ORDER BY day_no`;

  const nominalProgressSql=`SELECT DATE(COALESCE(p.verified_at,p.paid_at)) event_date,${CYCLE_EXPR} cycle,COALESCE(SUM(p.amount),0) amount
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
    WHERE p.status='confirmed' AND i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}
    GROUP BY DATE(COALESCE(p.verified_at,p.paid_at)),cycle ORDER BY event_date`;

  const completionProgressSql=`SELECT i.id invoice_id,${CYCLE_EXPR} cycle,DATE(MAX(COALESCE(p.verified_at,p.paid_at))) event_date
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN payments p ON p.invoice_id=i.id AND p.status='confirmed'
    WHERE i.period_year=? AND i.period_month=? AND i.status='paid' AND c.customer_status='active' AND c.archived_at IS NULL${sw}
    GROUP BY i.id,cycle ORDER BY event_date`;

  const timingSql=`SELECT i.id invoice_id,${CYCLE_EXPR} cycle,DATEDIFF(DATE(MAX(p.paid_at)),i.due_date) timing_days
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN payments p ON p.invoice_id=i.id AND p.status='confirmed'
    WHERE i.period_year=? AND i.period_month=? AND i.status='paid' AND c.customer_status='active' AND c.archived_at IS NULL${sw}
    GROUP BY i.id,i.due_date,cycle`;

  const trendSql=`SELECT i.period_year,i.period_month,${CYCLE_EXPR} cycle,COUNT(*) invoice_count,
      COALESCE(SUM(i.status='paid'),0) paid_count,COALESCE(SUM(i.total),0) billed,COALESCE(SUM(i.paid_amount),0) collected
    FROM invoices i JOIN customers c ON c.id=i.customer_id
    WHERE (i.period_year*100+i.period_month) BETWEEN ? AND ? AND i.status NOT IN ('cancelled','refunded')
      AND c.customer_status='active' AND c.archived_at IS NULL${sw}
    GROUP BY i.period_year,i.period_month,cycle ORDER BY i.period_year,i.period_month,cycle`;

  const endPeriod=Number(year)*100+Number(month),startPeriod=Number(firstTrend.year)*100+Number(firstTrend.month);
  const [
    [cycleRows],[unpaidRows],[pendingRows],[[todayRow]],[[yesterdayRow]],[[pendingSummary]],[recentIncome],[revenueDaily],[nominalEvents],[completionEvents],[timingRows],[trendRows]
  ]=await Promise.all([
    db.execute(cycleSummarySql,[year,month,...sp]),
    db.execute(unpaidSql,[year,month,...sp]),
    db.execute(pendingListSql,[year,month,...sp]),
    db.execute(todayRevenueSql,[selectedIncomeDate,...sp]),
    db.execute(yesterdayRevenueSql,[selectedIncomeDate,...sp]),
    db.execute(pendingSummarySql,[year,month,...sp]),
    db.execute(recentIncomeSql,sp),
    db.execute(revenueDailySql,[year,month,...sp]),
    db.execute(nominalProgressSql,[year,month,...sp]),
    db.execute(completionProgressSql,[year,month,...sp]),
    db.execute(timingSql,[year,month,...sp]),
    db.execute(trendSql,[startPeriod,endPeriod,...sp])
  ]);

  const cycles={'15':emptyCycle(15),'30':emptyCycle(30)};
  for(const row of cycleRows){const key=String(row.cycle);if(!cycles[key])continue;cycles[key]={cycle:Number(row.cycle),invoiceCount:Number(row.invoice_count||0),paidCount:Number(row.paid_count||0),pendingCount:Number(row.pending_count||0),openCount:Number(row.open_count||0),billed:Number(row.billed||0),collected:Number(row.collected||0),outstanding:Number(row.outstanding||0),pendingAmount:Number(row.pending_amount||0),customerRate:pct(row.paid_count,row.invoice_count),nominalRate:pct(row.collected,row.billed),previousCustomerRate:null,deltaCustomerRate:null};}

  const trend=buildTrend({year,month,trendMonths:selectedTrend,rows:trendRows});
  const prev=previousMonth(year,month);const prevIdx=trend.periods.indexOf(`${prev.year}-${String(prev.month).padStart(2,'0')}`);
  if(prevIdx>=0){for(const c of ['15','30']){const raw=trendRows.find(r=>Number(r.period_year)===prev.year&&Number(r.period_month)===prev.month&&String(r.cycle)===c);if(Number(raw?.invoice_count||0)>0){cycles[c].previousCustomerRate=trend.cycles[c].customer[prevIdx];cycles[c].deltaCustomerRate=Math.round((cycles[c].customerRate-cycles[c].previousCustomerRate)*10)/10;}}}

  const timing={early:0,on_time:0,h1_3:0,late:0,total:0,cycles:{'15':{early:0,on_time:0,h1_3:0,late:0,total:0},'30':{early:0,on_time:0,h1_3:0,late:0,total:0}}};
  for(const row of timingRows){const c=String(row.cycle);if(!timing.cycles[c])continue;const key=paymentTimingLabel(row.timing_days);timing[key]++;timing.total++;timing.cycles[c][key]++;timing.cycles[c].total++;}

  const todayAmount=Number(todayRow?.amount||0),yesterdayAmount=Number(yesterdayRow?.amount||0);
  const deltaPct=yesterdayAmount>0?Math.round(((todayAmount-yesterdayAmount)/yesterdayAmount)*1000)/10:null;
  const progress=buildProgressSeries({year,month,cycles,nominalEvents,completionEvents,now});
  const revenueSeries=buildRevenueSeries({year,month,rows:revenueDaily});

  return {
    filters:{cycle:selectedCycle,trendMonths:selectedTrend,incomeDate:selectedIncomeDate},
    today:{amount:todayAmount,count:Number(todayRow?.tx_count||0),transfer:Number(todayRow?.transfer_amount||0),qris:Number(todayRow?.qris_amount||0),cash:Number(todayRow?.cash_amount||0),yesterdayAmount,deltaPct,pendingCount:Number(pendingSummary?.tx_count||0),pendingAmount:Number(pendingSummary?.amount||0)},
    cycles,
    unpaid:{'15':unpaidRows.filter(r=>Number(r.cycle)===15),'30':unpaidRows.filter(r=>Number(r.cycle)===30)},
    pending:{'15':pendingRows.filter(r=>Number(r.cycle)===15),'30':pendingRows.filter(r=>Number(r.cycle)===30)},
    recent:recentIncome,
    progress,
    trend,
    revenueSeries,
    timing
  };
}

module.exports={loadDashboardBillingMonitor,normalizeCycle,normalizeTrendMonths,pct,paymentTimingLabel,buildProgressSeries,buildRevenueSeries,buildTrend,RECOGNIZED_AT_EXPR,CASH_POSTED_EXISTS};
