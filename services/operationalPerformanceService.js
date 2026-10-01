'use strict';

const db = require('../config/db');

const DEFAULT_TARGETS = {
  collection_rate: { label:'Collection', value:95, comparator:'min', unit:'%' },
  sla_rate: { label:'SLA', value:95, comparator:'min', unit:'%' },
  psb_active: { label:'PSB', value:30, comparator:'min', unit:' pelanggan' },
  work_completion: { label:'Work completion', value:90, comparator:'min', unit:'%' },
  network_health: { label:'Network health', value:98, comparator:'min', unit:'%' },
  backlog: { label:'Backlog', value:5, comparator:'max', unit:' pekerjaan' },
  churn_rate: { label:'Churn', value:2, comparator:'max', unit:'%' },
  mttr_hours: { label:'MTTR', value:3, comparator:'max', unit:' jam' }
};

function n(v){ return v == null ? 0 : Number(v) || 0; }
function pct(a,b){ return n(b) > 0 ? Math.max(0, Math.min(100, Math.round((n(a)/n(b))*1000)/10)) : 0; }
function iso(d){ return d.toISOString().slice(0,10); }
function bounded(v,min,max,fallback){ const x=Number(v); return Number.isInteger(x)&&x>=min&&x<=max?x:fallback; }
function periodRange(year,month){ const start=new Date(year,month-1,1),end=new Date(year,month,0); return {start:iso(start),end:iso(end)}; }
function prevPeriod(year,month){ const d=new Date(year,month-2,1); return {year:d.getFullYear(),month:d.getMonth()+1,...periodRange(d.getFullYear(),d.getMonth()+1)}; }
function monthKey(year,month){ return `${year}-${String(month).padStart(2,'0')}`; }
async function safeRows(sql,params=[]){ try{ const [rows]=await db.execute(sql,params); return rows||[]; }catch(e){ return []; } }
async function safeOne(sql,params=[],fallback={}){ const rows=await safeRows(sql,params); return rows[0]||fallback; }

async function ensurePerformanceSchema(){
  await db.query(`CREATE TABLE IF NOT EXISTS performance_kpi_targets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    metric_key VARCHAR(80) NOT NULL,
    scope_type ENUM('GLOBAL','SITE','ROLE','USER') NOT NULL DEFAULT 'GLOBAL',
    scope_value VARCHAR(120) NULL,
    target_value DECIMAL(16,3) NOT NULL,
    comparator ENUM('min','max') NOT NULL DEFAULT 'min',
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_performance_target(metric_key,scope_type,scope_value),
    INDEX idx_performance_target_scope(scope_type,scope_value)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS performance_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    period_year SMALLINT UNSIGNED NOT NULL,
    period_month TINYINT UNSIGNED NOT NULL,
    site_code VARCHAR(30) NULL,
    payload_json LONGTEXT NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_performance_snapshot(period_year,period_month,site_code),
    INDEX idx_performance_snapshot_period(period_year,period_month)
  )`);
}

async function loadTargets(siteCode=''){
  await ensurePerformanceSchema();
  const rows=await safeRows(`SELECT metric_key,scope_type,scope_value,target_value,comparator FROM performance_kpi_targets WHERE scope_type='GLOBAL' OR (scope_type='SITE' AND scope_value=?)`,[siteCode||'']);
  const out={}; for(const [key,def] of Object.entries(DEFAULT_TARGETS)) out[key]={...def};
  rows.sort((a,b)=>a.scope_type==='SITE'?1:-1).forEach(r=>{ if(out[r.metric_key]) out[r.metric_key]={...out[r.metric_key],value:n(r.target_value),comparator:r.comparator||out[r.metric_key].comparator,source:r.scope_type}; });
  return out;
}

function evaluate(actual,target){
  const t=n(target.value),a=n(actual);
  if(target.comparator==='max'){ if(a<=t) return 'on_target'; if(a<=t*1.25 || a<=t+2) return 'watch'; return 'attention'; }
  if(a>=t) return 'on_target'; if(a>=t*.9) return 'watch'; return 'attention';
}

async function billingMetrics(range,siteId){
  const where=siteId?' AND c.site_id=?':'',params=siteId?[siteId]:[];
  const x=await safeOne(`SELECT COUNT(DISTINCT i.customer_id) billed_customers,COALESCE(SUM(i.total),0) billed,COALESCE(SUM(i.paid_amount),0) collected,COALESCE(SUM(CASE WHEN i.status IN ('unpaid','partial','overdue') THEN i.outstanding ELSE 0 END),0) outstanding,COUNT(DISTINCT CASE WHEN i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 THEN i.customer_id END) open_customers,COUNT(DISTINCT CASE WHEN i.status='overdue' AND i.outstanding>0 THEN i.customer_id END) overdue_customers FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.period_year=? AND i.period_month=? AND i.status NOT IN ('cancelled','refunded')${where}`,[range.year,range.month,...params],{});
  return {...x,collection_rate:pct(x.collected,x.billed)};
}

async function customerGrowth(range,siteId){
  const where=siteId?' AND c.site_id=?':'',params=siteId?[siteId]:[];
  const x=await safeOne(`SELECT SUM(c.archived_at IS NULL AND c.customer_source='new_install' AND c.activation_date BETWEEN ? AND ?) psb,SUM(c.customer_status<>'active' AND DATE(COALESCE(c.status_changed_at,c.updated_at,c.created_at)) BETWEEN ? AND ?) churn,SUM(c.archived_at IS NULL AND c.customer_status='active') active FROM customers c WHERE 1=1${where}`,[range.start,range.end,range.start,range.end,...params],{});
  const psb=n(x.psb),churn=n(x.churn),active=n(x.active); return {psb,churn,active,net_growth:psb-churn,churn_rate:active?Math.round((churn/active)*1000)/10:0};
}

function slaHours(priority){ return priority==='critical'?4:priority==='high'?8:priority==='low'?48:24; }
async function ticketMetrics(range,siteId){
  const where=siteId?' AND c.site_id=?':'',params=siteId?[siteId]:[];
  const rows=await safeRows(`SELECT t.id,t.ticket_code,t.priority,t.status,t.opened_at,t.closed_at,t.customer_id,c.name customer_name,s.code site_code,COALESCE(e.name,u.name,'Belum assign') assigned_name FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN employees e ON e.id=t.assigned_employee_id LEFT JOIN users u ON u.id=t.assigned_to WHERE DATE(t.opened_at) BETWEEN ? AND ?${where}`,[range.start,range.end,...params]);
  let closed=0,met=0,breached=0,totalResolve=0,closedWithTime=0;
  for(const t of rows){ const opened=new Date(t.opened_at), end=t.closed_at?new Date(t.closed_at):new Date(); const hours=Math.max(0,(end-opened)/3600000),limit=slaHours(t.priority); if(t.status==='closed'){ closed++; totalResolve+=hours; closedWithTime++; if(hours<=limit) met++; } else if(hours>limit) breached++; if(t.status==='closed'&&hours>limit) breached++; }
  const backlog=await safeOne(`SELECT COUNT(*) total FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.status IN ('open','progress','pending')${where}`,params,{total:0});
  const repeats=await safeRows(`SELECT c.id,c.name,s.code site_code,COUNT(*) total FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id WHERE DATE(t.opened_at) BETWEEN ? AND ?${where} GROUP BY c.id,c.name,s.code HAVING COUNT(*)>=2 ORDER BY total DESC LIMIT 8`,[range.start,range.end,...params]);
  return {created:rows.length,closed,backlog:n(backlog.total),sla_met:met,sla_breached:breached,sla_rate:closed?pct(met,closed):100,mttr_hours:closedWithTime?Math.round((totalResolve/closedWithTime)*10)/10:0,repeats,rows};
}

async function workMetrics(range,siteId){
  const where=siteId?' AND COALESCE(ts.site_id,c.site_id)=?':'',params=siteId?[siteId]:[];
  const rows=await safeRows(`SELECT ts.id,ts.schedule_date,ts.status,ts.title,COALESCE(e.name,u.name,'Belum assign') technician_name,c.name customer_name,s.code site_code FROM technician_schedules ts LEFT JOIN employees e ON e.id=ts.technician_employee_id LEFT JOIN users u ON u.id=ts.technician_id LEFT JOIN customers c ON c.id=ts.customer_id LEFT JOIN sites s ON s.id=COALESCE(ts.site_id,c.site_id) WHERE ts.schedule_date BETWEEN ? AND ?${where}`,[range.start,range.end,...params]);
  const counts={scheduled:0,on_the_way:0,working:0,done:0,cancelled:0}; rows.forEach(r=>{ if(counts[r.status]!=null) counts[r.status]++; });
  const active=rows.filter(r=>r.status!=='cancelled').length, today=iso(new Date());
  const overdue=rows.filter(r=>r.status!=='done'&&r.status!=='cancelled'&&String(r.schedule_date).slice(0,10)<today).length;
  return {total:active,done:counts.done,overdue,completion_rate:active?pct(counts.done,active):100,counts,rows};
}

async function networkMetrics(range,siteId){
  const params=siteId?[siteId]:[];
  const routers=await safeOne(`SELECT COUNT(*) total,SUM(last_status='online') online FROM routers WHERE is_active=1${siteId?' AND site_id=?':''}`,params,{});
  const incidents=await safeOne(`SELECT COUNT(*) total,SUM(status='open') open_count,COALESCE(SUM(TIMESTAMPDIFF(MINUTE,opened_at,COALESCE(resolved_at,NOW()))),0) total_minutes FROM network_incidents WHERE DATE(opened_at) BETWEEN ? AND ?${siteId?' AND site_id=?':''}`,[range.start,range.end,...params],{});
  const olts=await safeOne(`SELECT COUNT(*) total,SUM(last_status='online') online FROM olt_devices WHERE is_active=1${siteId?' AND site_id=?':''}`,params,{});
  const health=n(routers.total)?pct(routers.online,routers.total):100;
  return {routers_total:n(routers.total),routers_online:n(routers.online),olts_total:n(olts.total),olts_online:n(olts.online),incidents:n(incidents.total),open_incidents:n(incidents.open_count),incident_minutes:n(incidents.total_minutes),health};
}

async function financeMetrics(range,siteId){
  const where=siteId?' AND c.site_id=?':'',params=siteId?[siteId]:[];
  const p=await safeOne(`SELECT COALESCE(SUM(p.amount),0) revenue,COUNT(*) payments FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.status='confirmed' AND DATE(p.paid_at) BETWEEN ? AND ?${where}`,[range.start,range.end,...params],{});
  const held=await safeOne(`SELECT COALESCE(SUM(p.amount),0) amount,COUNT(*) total FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff'${where}`,params,{});
  const diff=await safeOne(`SELECT COUNT(*) total,COALESCE(SUM(ABS(difference_amount)),0) amount FROM cash_settlements WHERE settlement_date BETWEEN ? AND ? AND ABS(COALESCE(difference_amount,0))>0`,[range.start,range.end],{});
  const debts=await safeOne(`SELECT COUNT(*) total,COALESCE(SUM(principal_amount),0) amount FROM finance_debts WHERE status='ACTIVE' AND due_date IS NOT NULL AND due_date<CURDATE()`,[],{});
  return {revenue:n(p.revenue),payments:n(p.payments),cash_held:n(held.amount),cash_held_count:n(held.total),recon_diff:n(diff.amount),recon_diff_count:n(diff.total),overdue_debts:n(debts.total),overdue_debt_amount:n(debts.amount)};
}

async function inventoryMetrics(siteId){
  const params=siteId?[siteId]:[];
  const x=await safeOne(`SELECT COUNT(*) total,SUM(i.qty<=0) empty_count,SUM(i.qty>0 AND i.qty<=i.min_stock) low_count,COALESCE(SUM(i.qty*i.purchase_price),0) stock_value FROM inventory_items i WHERE i.is_active=1 AND i.deleted_at IS NULL${siteId?' AND i.site_id=?':''}`,params,{});
  return {items:n(x.total),empty:n(x.empty_count),low:n(x.low_count),stock_value:n(x.stock_value)};
}

async function teamMetrics(range,siteId){
  const siteWhere=siteId?' AND c.site_id=?':'',siteParams=siteId?[siteId]:[];
  const employees=await safeRows(`SELECT e.id,e.name,e.employee_code,e.user_id,COALESCE(p.category,'other') category,COALESCE(p.name,'-') position_name FROM employees e LEFT JOIN positions p ON p.id=e.position_id WHERE e.is_active=1 ORDER BY e.name`);
  const out=[];
  for(const e of employees){
    const t=await safeOne(`SELECT COUNT(*) assigned,SUM(t.status='closed') closed,SUM(t.status<>'closed' AND TIMESTAMPDIFF(HOUR,t.opened_at,NOW())>CASE t.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 8 WHEN 'low' THEN 48 ELSE 24 END) breached FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.assigned_employee_id=? AND DATE(t.opened_at) BETWEEN ? AND ?${siteWhere}`,[e.id,range.start,range.end,...siteParams],{});
    const w=await safeOne(`SELECT COUNT(*) assigned,SUM(ts.status='done') done FROM technician_schedules ts LEFT JOIN customers c ON c.id=ts.customer_id WHERE ts.technician_employee_id=? AND ts.schedule_date BETWEEN ? AND ?${siteWhere}`,[e.id,range.start,range.end,...siteParams],{});
    const psb=await safeOne(`SELECT COUNT(*) total FROM customers c WHERE c.sales_id=? AND c.customer_source='new_install' AND c.archived_at IS NULL AND c.activation_date BETWEEN ? AND ?${siteId?' AND c.site_id=?':''}`,[e.id,range.start,range.end,...siteParams],{});
    const assigned=n(t.assigned),closed=n(t.closed),jobs=n(w.assigned),done=n(w.done),total=assigned+jobs,complete=closed+done,completion=total?pct(complete,total):100,breach=n(t.breached),sla=closed?Math.max(0,100-Math.round((breach/Math.max(closed,1))*1000)/10):100;
    const score=Math.round((completion*.55)+(sla*.30)+(Math.min(100,n(psb.total)*10)*.15));
    out.push({...e,assigned_tickets:assigned,closed_tickets:closed,assigned_jobs:jobs,done_jobs:done,psb:n(psb.total),completion_rate:completion,sla_rate:sla,overdue:breach,score,status:score>=90?'on_target':score>=75?'watch':'attention'});
  }
  return out;
}

async function siteComparison(range){
  const sites=await safeRows(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`),out=[];
  for(const s of sites){ const [billing,growth,tickets,work,network]=await Promise.all([billingMetrics(range,s.id),customerGrowth(range,s.id),ticketMetrics(range,s.id),workMetrics(range,s.id),networkMetrics(range,s.id)]); out.push({id:s.id,code:s.code,name:s.name,collection:billing.collection_rate,psb:growth.psb,churn:growth.churn,sla:tickets.sla_rate,backlog:tickets.backlog,work_completion:work.completion_rate,network:network.health}); }
  return out;
}

async function trend6(range,siteId){
  const out=[];
  for(let i=5;i>=0;i--){ const d=new Date(range.year,range.month-1-i,1),yy=d.getFullYear(),mm=d.getMonth()+1,rr={year:yy,month:mm,...periodRange(yy,mm)}; const [billing,growth,tickets,work]=await Promise.all([billingMetrics(rr,siteId),customerGrowth(rr,siteId),ticketMetrics(rr,siteId),workMetrics(rr,siteId)]); out.push({key:monthKey(yy,mm),label:new Intl.DateTimeFormat('id-ID',{month:'short',year:'2-digit'}).format(d),collection:billing.collection_rate,psb:growth.psb,sla:tickets.sla_rate,work:work.completion_rate,backlog:tickets.backlog}); }
  return out;
}

function finding(priority,area,title,detail,href){ return {priority,area,title,detail,href}; }
function buildFindings(data,targets){
  const f=[],{billing,growth,tickets,work,network,finance,inventory,previous}=data;
  if(evaluate(billing.collection_rate,targets.collection_rate)!=='on_target') f.push(finding('P1','Billing',`Collection ${billing.collection_rate}% di bawah target`,`${billing.overdue_customers} pelanggan overdue · outstanding Rp${Math.round(n(billing.outstanding)).toLocaleString('id-ID')}`,'/invoices?status=overdue'));
  if(tickets.sla_breached) f.push(finding(tickets.sla_rate<targets.sla_rate.value?'P1':'P2','SLA',`${tickets.sla_breached} tiket breach SLA`,`SLA bulan ini ${tickets.sla_rate}% · MTTR ${tickets.mttr_hours} jam`,'/tickets?status=active'));
  if(work.overdue) f.push(finding('P2','Work',`${work.overdue} pekerjaan teknisi overdue`,`Completion rate ${work.completion_rate}%`,'/schedules'));
  if(network.open_incidents) f.push(finding('P1','Network',`${network.open_incidents} incident jaringan masih open`,`${network.routers_online}/${network.routers_total} router online`,'/nms'));
  if(inventory.low||inventory.empty) f.push(finding('P2','Warehouse',`${inventory.low+inventory.empty} item perlu perhatian`,`Low stock ${inventory.low} · kosong ${inventory.empty}`,'/inventory?status=action'));
  if(finance.cash_held_count) f.push(finding('P2','Finance',`${finance.cash_held_count} cash payment belum disetor`,`Rp${Math.round(finance.cash_held).toLocaleString('id-ID')} masih di tim`,'/payments/reconciliation'));
  if(finance.recon_diff_count) f.push(finding('P1','Finance',`${finance.recon_diff_count} setoran punya selisih`,`Total selisih Rp${Math.round(finance.recon_diff).toLocaleString('id-ID')}`,'/payments/reconciliation?tab=history'));
  if(finance.overdue_debts) f.push(finding('P2','Finance',`${finance.overdue_debts} hutang/piutang lewat tempo`,`Nilai tercatat Rp${Math.round(finance.overdue_debt_amount).toLocaleString('id-ID')}`,'/debts'));
  if(growth.psb<targets.psb_active.value) f.push(finding('P3','Growth',`PSB ${growth.psb} dari target ${targets.psb_active.value}`,`Net growth ${growth.net_growth} · churn ${growth.churn}`,'/customers'));
  const colDelta=Math.round((billing.collection_rate-n(previous.billing.collection_rate))*10)/10; if(colDelta<=-3) f.push(finding('P2','Trend',`Collection turun ${Math.abs(colDelta)} poin vs bulan lalu`,`Bulan lalu ${previous.billing.collection_rate}%`,'/collection-analysis'));
  const slaDelta=Math.round((tickets.sla_rate-n(previous.tickets.sla_rate))*10)/10; if(slaDelta<=-3) f.push(finding('P2','Trend',`SLA turun ${Math.abs(slaDelta)} poin vs bulan lalu`,`Bulan lalu ${previous.tickets.sla_rate}%`,'/tickets'));
  return f.sort((a,b)=>({P1:0,P2:1,P3:2}[a.priority])-({P1:0,P2:1,P3:2}[b.priority])).slice(0,20);
}

function operationalHealth(parts){ const w={billing:.25,sla:.20,network:.20,psb:.15,work:.10,finance:.05,customer:.05}; return Math.round(parts.billing*w.billing+parts.sla*w.sla+parts.network*w.network+parts.psb*w.psb+parts.work*w.work+parts.finance*w.finance+parts.customer*w.customer); }

async function getPerformance({year,month,siteCode=''}={}){
  const now=new Date(); year=bounded(year,2020,2100,now.getFullYear()); month=bounded(month,1,12,now.getMonth()+1);
  const range={year,month,...periodRange(year,month)},prev=prevPeriod(year,month);
  const sites=await safeRows(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`),site=siteCode?sites.find(s=>String(s.code).toUpperCase()===String(siteCode).toUpperCase()):null,siteId=site?.id||null,targets=await loadTargets(site?.code||'');
  const [billing,growth,tickets,work,network,finance,inventory,team,sitesData,trend]=await Promise.all([billingMetrics(range,siteId),customerGrowth(range,siteId),ticketMetrics(range,siteId),workMetrics(range,siteId),networkMetrics(range,siteId),financeMetrics(range,siteId),inventoryMetrics(siteId),teamMetrics(range,siteId),siteComparison(range),trend6(range,siteId)]);
  const [pb,pg,pt,pw]=await Promise.all([billingMetrics(prev,siteId),customerGrowth(prev,siteId),ticketMetrics(prev,siteId),workMetrics(prev,siteId)]),previous={billing:pb,growth:pg,tickets:pt,work:pw};
  const day=now.getFullYear()===year&&now.getMonth()+1===month?now.getDate():new Date(year,month,0).getDate(),daysInMonth=new Date(year,month,0).getDate(),expectedPsb=Math.max(1,Math.round(targets.psb_active.value*day/daysInMonth)),pace=Math.round((growth.psb/expectedPsb)*100);
  const parts={billing:Math.min(100,billing.collection_rate/Math.max(targets.collection_rate.value,1)*100),sla:Math.min(100,tickets.sla_rate/Math.max(targets.sla_rate.value,1)*100),network:Math.min(100,network.health/Math.max(targets.network_health.value,1)*100),psb:Math.min(100,growth.psb/Math.max(targets.psb_active.value,1)*100),work:Math.min(100,work.completion_rate/Math.max(targets.work_completion.value,1)*100),finance:finance.recon_diff_count||finance.cash_held_count?70:100,customer:Math.max(0,100-(growth.churn_rate/Math.max(targets.churn_rate.value,1))*25)};
  const data={range,site,sites,targets,billing,growth,tickets,work,network,finance,inventory,team,siteComparison:sitesData,trend,previous,current:{billing,growth,tickets,work},pace:{psbExpected:expectedPsb,psbActual:growth.psb,psbPace:pace},parts};
  data.health=operationalHealth(parts); data.findings=buildFindings(data,targets); data.actionQueue=data.findings.slice(0,10); data.repeatProblems=tickets.repeats;
  data.variance={collection:Math.round((billing.collection_rate-pb.collection_rate)*10)/10,psb:growth.psb-pg.psb,sla:Math.round((tickets.sla_rate-pt.sla_rate)*10)/10,work:Math.round((work.completion_rate-pw.completion_rate)*10)/10,backlog:tickets.backlog-pt.backlog};
  data.freshness={generatedAt:new Date().toISOString(),billing:(await safeOne(`SELECT MAX(updated_at) t FROM invoices`,[],{})).t||null,ticket:(await safeOne(`SELECT MAX(COALESCE(closed_at,opened_at)) t FROM tickets`,[],{})).t||null,network:(await safeOne(`SELECT MAX(last_seen_at) t FROM routers`,[],{})).t||null,warehouse:(await safeOne(`SELECT MAX(created_at) t FROM inventory_movements`,[],{})).t||null};
  return data;
}

async function saveSnapshot({year,month,siteCode='',userId=null}){ const data=await getPerformance({year,month,siteCode}); const payload=JSON.stringify({range:data.range,site:data.site,health:data.health,parts:data.parts,billing:data.billing,growth:data.growth,tickets:data.tickets,work:data.work,network:data.network,finance:data.finance,inventory:data.inventory,team:data.team,siteComparison:data.siteComparison,trend:data.trend,variance:data.variance,findings:data.findings,targets:data.targets,savedAt:new Date().toISOString()}); await db.execute(`INSERT INTO performance_snapshots(period_year,period_month,site_code,payload_json,created_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE payload_json=VALUES(payload_json),created_by=VALUES(created_by),created_at=NOW()`,[data.range.year,data.range.month,siteCode||null,payload,userId]); return data; }
async function getSnapshots(limit=12){ await ensurePerformanceSchema(); return safeRows(`SELECT id,period_year,period_month,site_code,created_at FROM performance_snapshots ORDER BY period_year DESC,period_month DESC,id DESC LIMIT ?`,[Number(limit)||12]); }
async function saveTargets(body,userId){ await ensurePerformanceSchema(); const scopeType=String(body.scope_type||'GLOBAL').toUpperCase()==='SITE'?'SITE':'GLOBAL',scopeValue=scopeType==='SITE'?String(body.scope_value||'').trim().toUpperCase():null; for(const [key,def] of Object.entries(DEFAULT_TARGETS)){ const value=Number(body[key]); if(!Number.isFinite(value)||value<0) continue; await db.execute(`INSERT INTO performance_kpi_targets(metric_key,scope_type,scope_value,target_value,comparator,updated_by) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE target_value=VALUES(target_value),comparator=VALUES(comparator),updated_by=VALUES(updated_by),updated_at=NOW()`,[key,scopeType,scopeValue,value,def.comparator,userId]); } }

module.exports={DEFAULT_TARGETS,ensurePerformanceSchema,getPerformance,saveSnapshot,getSnapshots,saveTargets};
