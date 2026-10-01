'use strict';

const db=require('../config/db');

const n=v=>Number(v)||0;
const pct=(a,b)=>n(b)>0?Math.round(n(a)/n(b)*1000)/10:0;
const money=v=>Math.round(n(v));
const range=(year,month)=>({start:`${year}-${String(month).padStart(2,'0')}-01`,end:new Date(year,month,0).toISOString().slice(0,10)});

const REASONS=[
  ['payment','Pembayaran / menunggak'],
  ['service','Gangguan / kualitas layanan'],
  ['competitor','Pindah ke kompetitor'],
  ['relocation','Pindah rumah / lokasi'],
  ['unused','Tidak digunakan'],
  ['price','Harga'],
  ['device','Perangkat pelanggan'],
  ['other','Lainnya'],
  ['unclassified','Belum diklasifikasikan']
];

async function ensureRetentionSchema(){
  await db.query(`CREATE TABLE IF NOT EXISTS customer_retention_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    site_id BIGINT UNSIGNED NULL,
    event_type ENUM('OFF','TERMINATED','REACTIVATED','RETENTION_CONTACT','RETAINED','LOST') NOT NULL,
    reason_code VARCHAR(60) NULL,
    reason_text VARCHAR(500) NULL,
    mrr_value DECIMAL(14,2) NULL,
    event_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_retention_event_period(event_at,event_type),
    INDEX idx_retention_event_customer(customer_id,event_at),
    INDEX idx_retention_event_site(site_id,event_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS customer_retention_actions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    risk_score INT NOT NULL DEFAULT 0,
    risk_level ENUM('NORMAL','WATCH','PRIORITY') NOT NULL DEFAULT 'NORMAL',
    owner_user_id BIGINT UNSIGNED NULL,
    status ENUM('OPEN','CONTACTED','RETAINED','LOST','CLOSED') NOT NULL DEFAULT 'OPEN',
    due_at DATETIME NULL,
    note VARCHAR(700) NULL,
    result_note VARCHAR(700) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_retention_action_open(customer_id,status),
    INDEX idx_retention_action_status(status,risk_level,due_at)
  )`);
  // V4 enriches lifecycle history so future MRR loss is frozen at the time the status changes.
  await db.query(`ALTER TABLE customer_status_history ADD COLUMN IF NOT EXISTS mrr_value DECIMAL(14,2) NULL`);
  await db.query(`ALTER TABLE customer_status_history ADD COLUMN IF NOT EXISTS reason_code VARCHAR(60) NULL`);
}

async function periodEvents({year,month,siteId=null}){
  const {start,end}=range(year,month);
  const siteSql=siteId?' AND c.site_id=?':'',params=siteId?[siteId]:[];
  const [psb]=await db.execute(`SELECT c.id,c.name,c.activation_date,s.code site_code,COALESCE(p.price,0) mrr
    FROM customers c LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN packages p ON p.id=c.package_id
    WHERE c.customer_source='new_install' AND c.activation_date BETWEEN ? AND ?${siteSql}
    ORDER BY c.activation_date DESC`,[start,end,...params]);

  const [hist]=await db.execute(`SELECT h.id history_id,h.customer_id,c.name,h.from_status,h.to_status,h.changed_at,
      COALESCE(s.code,'-') site_code,COALESCE(h.mrr_value,p.price,0) mrr,
      COALESCE(re.reason_code,h.reason_code,'unclassified') reason_code,
      re.reason_text
    FROM customer_status_history h
    JOIN customers c ON c.id=h.customer_id
    LEFT JOIN sites s ON s.id=COALESCE(h.site_id,c.site_id)
    LEFT JOIN packages p ON p.id=c.package_id
    LEFT JOIN customer_retention_events re ON re.customer_id=h.customer_id
      AND ABS(TIMESTAMPDIFF(MINUTE,re.event_at,h.changed_at))<=10
      AND re.event_type IN ('OFF','TERMINATED')
    WHERE DATE(h.changed_at) BETWEEN ? AND ?${siteId?' AND COALESCE(h.site_id,c.site_id)=?':''}
    ORDER BY h.changed_at DESC`,[start,end,...params]);

  return {psb,hist};
}

async function reasonBreakdown({year,month,siteId=null}){
  const {start,end}=range(year,month);
  const params=[start,end],siteJoin=siteId?' AND COALESCE(re.site_id,c.site_id)=?':'';
  if(siteId)params.push(siteId);
  const [rows]=await db.execute(`SELECT COALESCE(re.reason_code,'unclassified') reason_code,COUNT(*) total,
      COALESCE(SUM(COALESCE(re.mrr_value,p.price,0)),0) mrr_lost
    FROM customer_retention_events re JOIN customers c ON c.id=re.customer_id
    LEFT JOIN packages p ON p.id=c.package_id
    WHERE re.event_type IN ('OFF','TERMINATED','LOST') AND DATE(re.event_at) BETWEEN ? AND ?${siteJoin}
    GROUP BY COALESCE(re.reason_code,'unclassified') ORDER BY total DESC,mrr_lost DESC`,params);
  const map=new Map(rows.map(r=>[r.reason_code,{...r,total:n(r.total),mrr_lost:money(r.mrr_lost)}]));
  return REASONS.map(([key,label])=>({key,label,total:map.get(key)?.total||0,mrrLost:map.get(key)?.mrr_lost||0})).filter(x=>x.total>0||x.key==='unclassified');
}

async function mrrMovement({year,month,siteId=null}){
  const {psb,hist}=await periodEvents({year,month,siteId});
  const gained=psb.reduce((a,x)=>a+n(x.mrr),0);
  let lost=0,reactivated=0;
  hist.forEach(h=>{
    if(['inactive','suspended','terminated'].includes(String(h.to_status||''))) lost+=n(h.mrr);
    if(h.to_status==='active'&&['inactive','suspended','terminated'].includes(String(h.from_status||''))) reactivated+=n(h.mrr);
  });
  return {gained:money(gained),lost:money(lost),reactivated:money(reactivated),net:money(gained+reactivated-lost)};
}

async function cohortRows({year,month,siteId=null}){
  const rows=[];
  for(let i=5;i>=0;i--){
    const d=new Date(year,month-1-i,1),y=d.getFullYear(),m=d.getMonth()+1,{start,end}=range(y,m);
    const params=[start,end],siteSql=siteId?' AND c.site_id=?':'';
    if(siteId)params.push(siteId);
    const [cohort]=await db.execute(`SELECT c.id,c.activation_date,c.customer_status,c.archived_at FROM customers c
      WHERE c.customer_source='new_install' AND c.activation_date BETWEEN ? AND ?${siteSql}`,params);
    let r30=0,r60=0,r90=0,eligible30=0,eligible60=0,eligible90=0;
    const now=Date.now();
    for(const c of cohort){
      const activated=new Date(c.activation_date).getTime();
      const [events]=await db.execute(`SELECT to_status,changed_at FROM customer_status_history WHERE customer_id=? ORDER BY changed_at`,[c.id]);
      const firstLoss=events.find(e=>['inactive','suspended','terminated'].includes(e.to_status));
      const lossAt=firstLoss?new Date(firstLoss.changed_at).getTime():Infinity;
      for(const [days,key] of [[30,'r30'],[60,'r60'],[90,'r90']]){
        if(now-activated>=days*86400000){
          if(key==='r30')eligible30++; if(key==='r60')eligible60++; if(key==='r90')eligible90++;
          if(lossAt>activated+days*86400000){
            if(key==='r30')r30++; if(key==='r60')r60++; if(key==='r90')r90++;
          }
        }
      }
    }
    rows.push({period:`${y}-${String(m).padStart(2,'0')}`,label:new Intl.DateTimeFormat('id-ID',{month:'short',year:'2-digit'}).format(d),
      total:cohort.length,r30:eligible30?pct(r30,eligible30):null,r60:eligible60?pct(r60,eligible60):null,r90:eligible90?pct(r90,eligible90):null});
  }
  return rows;
}

async function riskRows({siteId=null,limit=25}){
  const siteSql=siteId?' AND c.site_id=?':'',params=siteId?[siteId]:[];
  const [rows]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.customer_status,c.network_status,s.code site_code,
      COALESCE(p.price,0) mrr,
      (SELECT COUNT(*) FROM tickets t WHERE t.customer_id=c.id AND t.opened_at>=DATE_SUB(NOW(),INTERVAL 60 DAY)) tickets_60d,
      (SELECT COUNT(*) FROM tickets t WHERE t.customer_id=c.id AND t.status IN ('open','progress','pending')) active_tickets,
      (SELECT COUNT(*) FROM invoices i WHERE i.customer_id=c.id AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0) overdue_invoices,
      (SELECT COALESCE(MAX(DATEDIFF(CURDATE(),i.due_date)),0) FROM invoices i WHERE i.customer_id=c.id AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0) days_late,
      (SELECT COUNT(*) FROM customer_status_history h WHERE h.customer_id=c.id AND h.changed_at>=DATE_SUB(NOW(),INTERVAL 90 DAY) AND h.to_status IN ('inactive','suspended')) off_90d,
      ra.status retention_status,ra.owner_user_id,ru.name retention_owner
    FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN packages p ON p.id=c.package_id
    LEFT JOIN customer_retention_actions ra ON ra.id=(SELECT x.id FROM customer_retention_actions x WHERE x.customer_id=c.id AND x.status IN ('OPEN','CONTACTED') ORDER BY x.id DESC LIMIT 1)
    LEFT JOIN users ru ON ru.id=ra.owner_user_id
    WHERE c.archived_at IS NULL AND c.customer_status='active'${siteSql}`,params);
  return rows.map(r=>{
    let score=0; const factors=[];
    if(n(r.tickets_60d)>=3){score+=3;factors.push(`${r.tickets_60d} tiket/60h`)} else if(n(r.tickets_60d)>=1){score+=1;factors.push(`${r.tickets_60d} tiket`)};
    if(n(r.active_tickets)>0){score+=2;factors.push(`${r.active_tickets} tiket aktif`)};
    if(n(r.days_late)>30){score+=3;factors.push(`telat ${r.days_late}h`)} else if(n(r.days_late)>7){score+=2;factors.push(`telat ${r.days_late}h`)};
    if(n(r.overdue_invoices)>0){score+=1;factors.push(`${r.overdue_invoices} invoice overdue`)};
    if(String(r.network_status)==='isolated'){score+=3;factors.push('isolated')};
    if(n(r.off_90d)>=1){score+=2;factors.push(`${r.off_90d}x off/90h`)};
    const level=score>=7?'PRIORITY':score>=3?'WATCH':'NORMAL';
    return {...r,score,level,factors};
  }).filter(r=>r.level!=='NORMAL').sort((a,b)=>b.score-a.score||b.mrr-a.mrr).slice(0,limit);
}

async function recentLossCustomers({year,month,siteId=null}){
  const {hist}=await periodEvents({year,month,siteId});
  const seen=new Set(),out=[];
  for(const h of hist){
    if(!['inactive','suspended','terminated'].includes(String(h.to_status||''))||seen.has(h.customer_id))continue;
    seen.add(h.customer_id);
    out.push(h);
  }
  return out.slice(0,30);
}

async function timeline(customerId){
  const [[customer]]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.activation_date,c.customer_status,c.network_status,
      s.code site_code,p.name package_name,p.price package_price
    FROM customers c LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN packages p ON p.id=c.package_id WHERE c.id=? LIMIT 1`,[customerId]);
  if(!customer)return null;
  const events=[];
  if(customer.activation_date)events.push({at:customer.activation_date,type:'PSB',title:'Pelanggan aktif',detail:`${customer.package_name||'-'} · Rp${money(customer.package_price).toLocaleString('id-ID')}/bulan`});
  const [status]=await db.execute(`SELECT from_status,to_status,changed_at,reason_code FROM customer_status_history WHERE customer_id=? ORDER BY changed_at`,[customerId]);
  status.forEach(x=>events.push({at:x.changed_at,type:'STATUS',title:`${x.from_status||'-'} → ${x.to_status}`,detail:x.reason_code||''}));
  const [tickets]=await db.execute(`SELECT ticket_code,subject,status,opened_at,closed_at FROM tickets WHERE customer_id=? ORDER BY opened_at DESC LIMIT 20`,[customerId]);
  tickets.forEach(x=>events.push({at:x.opened_at,type:'TICKET',title:`${x.ticket_code} · ${x.subject}`,detail:x.status}));
  const [invoices]=await db.execute(`SELECT period_year,period_month,status,due_date,outstanding FROM invoices WHERE customer_id=? ORDER BY period_year DESC,period_month DESC LIMIT 12`,[customerId]);
  invoices.filter(x=>['overdue','unpaid','partial'].includes(x.status)).forEach(x=>events.push({at:x.due_date,type:'BILLING',title:`Tagihan ${x.period_month}/${x.period_year} · ${x.status}`,detail:`Outstanding Rp${money(x.outstanding).toLocaleString('id-ID')}`}));
  const [retention]=await db.execute(`SELECT event_type,reason_code,reason_text,event_at FROM customer_retention_events WHERE customer_id=? ORDER BY event_at`,[customerId]);
  retention.forEach(x=>events.push({at:x.event_at,type:'RETENTION',title:x.event_type,detail:[x.reason_code,x.reason_text].filter(Boolean).join(' · ')}));
  events.sort((a,b)=>new Date(a.at)-new Date(b.at));
  return {customer,events};
}

async function analyze({year,month,siteId=null}){
  await ensureRetentionSchema();
  const [reasons,mrr,cohorts,risk,recentLoss]=await Promise.all([
    reasonBreakdown({year,month,siteId}),mrrMovement({year,month,siteId}),cohortRows({year,month,siteId}),riskRows({siteId}),recentLossCustomers({year,month,siteId})
  ]);
  const totalChurn=reasons.reduce((a,x)=>a+x.total,0);
  const classified=reasons.filter(x=>x.key!=='unclassified').reduce((a,x)=>a+x.total,0);
  return {reasons,mrr,cohorts,risk,recentLoss,totalChurn,classificationRate:totalChurn?pct(classified,totalChurn):100};
}

async function saveReason({customerId,eventType,reasonCode,reasonText,eventAt,userId}){
  await ensureRetentionSchema();
  const [[c]]=await db.execute(`SELECT c.id,c.site_id,COALESCE(p.price,0) mrr FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.id=? LIMIT 1`,[customerId]);
  if(!c)throw new Error('Pelanggan tidak ditemukan.');
  const type=['OFF','TERMINATED','REACTIVATED','RETENTION_CONTACT','RETAINED','LOST'].includes(eventType)?eventType:'OFF';
  const reason=REASONS.some(x=>x[0]===reasonCode)?reasonCode:'other';
  await db.execute(`INSERT INTO customer_retention_events(customer_id,site_id,event_type,reason_code,reason_text,mrr_value,event_at,created_by)
    VALUES(?,?,?,?,?,?,?,?)`,[c.id,c.site_id,type,reason,reasonText||null,n(c.mrr),eventAt||new Date(),userId||null]);
}

async function createRetentionAction({customerId,ownerUserId,dueAt,note,userId}){
  const risks=await riskRows({limit:500});
  const r=risks.find(x=>Number(x.id)===Number(customerId));
  if(!r)throw new Error('Pelanggan tidak ada di retention risk queue saat ini.');
  const [[open]]=await db.execute(`SELECT id FROM customer_retention_actions WHERE customer_id=? AND status IN ('OPEN','CONTACTED') LIMIT 1`,[customerId]);
  if(open){
    await db.execute(`UPDATE customer_retention_actions SET owner_user_id=?,due_at=?,note=?,risk_score=?,risk_level=? WHERE id=?`,
      [ownerUserId||null,dueAt||null,note||null,r.score,r.level,open.id]);
    return open.id;
  }
  const [x]=await db.execute(`INSERT INTO customer_retention_actions(customer_id,risk_score,risk_level,owner_user_id,due_at,note,created_by)
    VALUES(?,?,?,?,?,?,?)`,[customerId,r.score,r.level,ownerUserId||null,dueAt||null,note||null,userId||null]);
  return x.insertId;
}

module.exports={REASONS,ensureRetentionSchema,analyze,timeline,saveReason,createRetentionAction};
