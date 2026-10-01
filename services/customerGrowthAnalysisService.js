'use strict';

const db=require('../config/db');
const n=v=>Number(v)||0;
const pct=(a,b)=>n(b)>0?Math.round(n(a)/n(b)*1000)/10:0;
const dateRange=(year,month)=>({start:`${year}-${String(month).padStart(2,'0')}-01`,end:new Date(year,month,0).toISOString().slice(0,10)});

async function ensureGrowthSchema(){
  await db.query(`CREATE TABLE IF NOT EXISTS customer_status_history(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    site_id BIGINT UNSIGNED NULL,
    from_status VARCHAR(40) NULL,
    to_status VARCHAR(40) NOT NULL,
    changed_by BIGINT UNSIGNED NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source VARCHAR(40) NOT NULL DEFAULT 'customer_edit',
    note VARCHAR(500) NULL,
    INDEX idx_customer_status_history_period(changed_at,to_status),
    INDEX idx_customer_status_history_customer(customer_id,changed_at),
    INDEX idx_customer_status_history_site(site_id,changed_at)
  )`);
}

async function recordStatusChange({customerId,siteId,fromStatus,toStatus,userId,source='customer_edit',note=null}){
  if(!customerId||String(fromStatus||'')===String(toStatus||''))return;
  await ensureGrowthSchema();
  const [[c]]=await db.execute(`SELECT COALESCE(p.price,0) mrr FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.id=? LIMIT 1`,[customerId]);
  await db.execute(`INSERT INTO customer_status_history(customer_id,site_id,from_status,to_status,changed_by,source,note,mrr_value)
    VALUES(?,?,?,?,?,?,?,?)`,[customerId,siteId||null,fromStatus||null,toStatus,userId||null,source,note||null,n(c?.mrr)]);
}

async function sites(){
  const [rows]=await db.execute(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  return rows;
}

async function hasHistoryBefore(end){
  await ensureGrowthSchema();
  const [[r]]=await db.execute(`SELECT COUNT(*) total FROM customer_status_history WHERE changed_at<=?`,[`${end} 23:59:59`]);
  return n(r.total)>0;
}

async function movementForSite({year,month,siteId=null,siteCode='ALL'}){
  await ensureGrowthSchema();
  const {start,end}=dateRange(year,month);
  const siteClause=siteId?' AND c.site_id=?':'',siteParams=siteId?[siteId]:[];
  const histSiteClause=siteId?' AND COALESCE(h.site_id,c.site_id)=?':'';

  const [[closingRow]]=await db.execute(`SELECT
      SUM(c.archived_at IS NULL AND c.customer_status='active') active_now,
      COUNT(*) total_now
    FROM customers c WHERE 1=1${siteClause}`,siteParams);

  const [[psbRow]]=await db.execute(`SELECT COUNT(*) total FROM customers c
    WHERE c.customer_source='new_install' AND c.activation_date BETWEEN ? AND ?
      AND (c.archived_at IS NULL OR DATE(c.archived_at)>?)${siteClause}`,
    [start,end,end,...siteParams]);

  const [[statusHist]]=await db.execute(`SELECT
      SUM(h.to_status IN ('inactive','suspended')) off_count,
      SUM(h.to_status='active' AND h.from_status IN ('inactive','suspended','terminated')) reactivated_count,
      SUM(h.to_status='terminated') terminated_count
    FROM customer_status_history h JOIN customers c ON c.id=h.customer_id
    WHERE DATE(h.changed_at) BETWEEN ? AND ?${histSiteClause}`,
    [start,end,...siteParams]);

  // Fallback catches status changes that happened before this patch was installed.
  const [[fallback]]=await db.execute(`SELECT
      SUM(c.customer_status IN ('inactive','suspended') AND DATE(c.status_changed_at) BETWEEN ? AND ?) off_count,
      SUM((c.customer_status='terminated' OR c.archived_at IS NOT NULL) AND DATE(COALESCE(c.archived_at,c.status_changed_at)) BETWEEN ? AND ?) terminated_count
    FROM customers c WHERE 1=1${siteClause}`,
    [start,end,start,end,...siteParams]);

  const historyAvailable=await hasHistoryBefore(end);
  const psb=n(psbRow.total);
  const off=historyAvailable?n(statusHist.off_count):n(fallback.off_count);
  const reactivated=historyAvailable?n(statusHist.reactivated_count):0;
  const terminated=historyAvailable?n(statusHist.terminated_count):n(fallback.terminated_count);
  const churn=off+terminated;
  const net=psb+reactivated-churn;
  const closing=n(closingRow.active_now);
  // For current period this reconciles opening from observed movements. For historic periods
  // without monthly snapshots it is labeled estimated in dataConfidence below.
  const opening=Math.max(0,closing-net);
  const grossGrowth=psb+reactivated;
  const growthEfficiency=grossGrowth?pct(net,grossGrowth):0;
  const churnToPsb=psb?pct(churn,psb):(churn?100:0);
  const netGrowthRate=opening?pct(net,opening):0;

  return {
    siteId,siteCode,opening,psb,reactivated,off,terminated,churn,net,closing,
    grossGrowth,growthEfficiency,churnToPsb,netGrowthRate,
    quality:net<0?'attention':churnToPsb>=75?'watch':'healthy',
    dataConfidence:historyAvailable?'tracked':'estimated'
  };
}

async function sixMonthTrend({year,month,siteId=null,siteCode='ALL'}){
  const rows=[];
  for(let i=5;i>=0;i--){
    const d=new Date(year,month-1-i,1);
    const y=d.getFullYear(),m=d.getMonth()+1;
    const x=await movementForSite({year:y,month:m,siteId,siteCode});
    rows.push({period:`${y}-${String(m).padStart(2,'0')}`,label:new Intl.DateTimeFormat('id-ID',{month:'short',year:'2-digit'}).format(d),psb:x.psb,churn:x.churn,net:x.net});
  }
  return rows;
}

function insights(all,siteRows){
  const out=[];
  if(all.psb>0&&all.churn>0){
    out.push({tone:all.churnToPsb>=75?'warning':'info',title:`${all.churnToPsb}% pertumbuhan baru ter-offset pelanggan off/churn`,detail:`PSB +${all.psb}, reactivation +${all.reactivated}, churn -${all.churn}; net growth ${all.net>=0?'+':''}${all.net}.`});
  }
  if(all.net<0)out.push({tone:'danger',title:`Net customer growth negatif ${all.net}`,detail:'Jumlah pelanggan keluar pada periode ini lebih besar daripada penambahan bersih.'});
  const negatives=siteRows.filter(s=>s.net<0);
  negatives.forEach(s=>out.push({tone:'danger',title:`${s.siteCode} net growth ${s.net}`,detail:`PSB +${s.psb} tetapi churn/off -${s.churn}.`}));
  const highChurn=siteRows.filter(s=>s.psb>0&&s.churnToPsb>=75&&s.net>=0);
  highChurn.forEach(s=>out.push({tone:'warning',title:`${s.siteCode}: churn menyerap ${s.churnToPsb}% PSB`,detail:`Net growth hanya ${s.net>=0?'+':''}${s.net} dari PSB +${s.psb}.`}));
  const bestContribution=[...siteRows].sort((a,b)=>b.net-a.net)[0];
  if(bestContribution&&bestContribution.net>0)out.push({tone:'success',title:`Kontribusi growth terbesar: ${bestContribution.siteCode} +${bestContribution.net}`,detail:`PSB +${bestContribution.psb} · churn -${bestContribution.churn}.`});
  return out.slice(0,8);
}

async function analyze({year,month,selectedSiteCode=''}){
  const siteRowsRaw=await sites();
  const siteRows=[];
  for(const s of siteRowsRaw) siteRows.push({...await movementForSite({year,month,siteId:s.id,siteCode:s.code}),siteName:s.name});
  const all=await movementForSite({year,month,siteId:null,siteCode:'ALL'});
  // All Site is deliberately derived from the same site movements to prevent cross-widget mismatch.
  const aggregate={
    siteCode:'ALL',siteName:'Semua Site',
    opening:siteRows.reduce((a,x)=>a+x.opening,0),psb:siteRows.reduce((a,x)=>a+x.psb,0),
    reactivated:siteRows.reduce((a,x)=>a+x.reactivated,0),off:siteRows.reduce((a,x)=>a+x.off,0),
    terminated:siteRows.reduce((a,x)=>a+x.terminated,0),churn:siteRows.reduce((a,x)=>a+x.churn,0),
    net:siteRows.reduce((a,x)=>a+x.net,0),closing:siteRows.reduce((a,x)=>a+x.closing,0)
  };
  aggregate.grossGrowth=aggregate.psb+aggregate.reactivated;
  aggregate.growthEfficiency=aggregate.grossGrowth?pct(aggregate.net,aggregate.grossGrowth):0;
  aggregate.churnToPsb=aggregate.psb?pct(aggregate.churn,aggregate.psb):(aggregate.churn?100:0);
  aggregate.netGrowthRate=aggregate.opening?pct(aggregate.net,aggregate.opening):0;
  aggregate.quality=aggregate.net<0?'attention':aggregate.churnToPsb>=75?'watch':'healthy';
  aggregate.dataConfidence=siteRows.some(x=>x.dataConfidence==='estimated')?'estimated':'tracked';

  const selected=selectedSiteCode?siteRows.find(x=>x.siteCode===selectedSiteCode)||aggregate:aggregate;
  const trend=await sixMonthTrend({year,month,siteId:selected.siteId||null,siteCode:selected.siteCode});
  return {all:aggregate,selected,sites:siteRows,trend,insights:insights(aggregate,siteRows)};
}

module.exports={ensureGrowthSchema,recordStatusChange,analyze};
