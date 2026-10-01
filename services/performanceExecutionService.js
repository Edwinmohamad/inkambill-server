'use strict';

const db=require('../config/db');

const clean=(v,max=255)=>String(v||'').trim().slice(0,max);
const num=v=>Number(v)||0;
const dateKey=v=>v?new Date(v).toISOString().slice(0,10):null;

async function ensureExecutionSchema(){
  await db.query(`CREATE TABLE IF NOT EXISTS performance_goals(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(180) NOT NULL,
    metric_key VARCHAR(80) NULL,
    target_value DECIMAL(16,3) NULL,
    current_value DECIMAL(16,3) NULL,
    unit VARCHAR(30) NULL,
    period_type ENUM('MONTH','QUARTER','YEAR') NOT NULL DEFAULT 'MONTH',
    period_year SMALLINT UNSIGNED NOT NULL,
    period_month TINYINT UNSIGNED NULL,
    site_code VARCHAR(30) NULL,
    owner_user_id BIGINT UNSIGNED NULL,
    status ENUM('ACTIVE','ACHIEVED','PAUSED','CLOSED') NOT NULL DEFAULT 'ACTIVE',
    notes VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_performance_goal_period(period_year,period_month,status),
    INDEX idx_performance_goal_owner(owner_user_id,status)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS performance_actions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    source_key VARCHAR(160) NULL,
    title VARCHAR(220) NOT NULL,
    description VARCHAR(1000) NULL,
    priority ENUM('P1','P2','P3') NOT NULL DEFAULT 'P2',
    owner_user_id BIGINT UNSIGNED NULL,
    site_code VARCHAR(30) NULL,
    due_at DATETIME NULL,
    status ENUM('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED') NOT NULL DEFAULT 'OPEN',
    block_reason VARCHAR(300) NULL,
    result_note VARCHAR(1000) NULL,
    result_value VARCHAR(160) NULL,
    created_by BIGINT UNSIGNED NULL,
    resolved_by BIGINT UNSIGNED NULL,
    resolved_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_performance_action_status(status,priority,due_at),
    INDEX idx_performance_action_owner(owner_user_id,status),
    INDEX idx_performance_action_site(site_code,status)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS performance_action_logs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    action_id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(60) NOT NULL,
    note VARCHAR(1000) NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_performance_action_log(action_id,created_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS performance_work_blocks(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    entity_type ENUM('TICKET','SCHEDULE','PSB','BILLING','NETWORK','OTHER') NOT NULL,
    entity_id BIGINT UNSIGNED NULL,
    entity_key VARCHAR(160) NULL,
    title VARCHAR(220) NOT NULL,
    reason_code VARCHAR(60) NULL,
    reason_text VARCHAR(500) NOT NULL,
    owner_user_id BIGINT UNSIGNED NULL,
    site_code VARCHAR(30) NULL,
    blocked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    resolved_by BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL,
    INDEX idx_performance_block_open(resolved_at,blocked_at),
    INDEX idx_performance_block_owner(owner_user_id,resolved_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS performance_decisions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    decision_date DATE NOT NULL,
    title VARCHAR(220) NOT NULL,
    context_text VARCHAR(1000) NULL,
    decision_text VARCHAR(1500) NOT NULL,
    owner_user_id BIGINT UNSIGNED NULL,
    due_date DATE NULL,
    result_text VARCHAR(1000) NULL,
    status ENUM('OPEN','DONE','CANCELLED') NOT NULL DEFAULT 'OPEN',
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_performance_decision_date(decision_date,status)
  )`);
}

async function users(){
  const [rows]=await db.execute(`SELECT id,name,username,role FROM users WHERE is_active=1 ORDER BY name`);
  return rows;
}
async function goals({year,month,siteCode}){
  const params=[year],w=['g.period_year=?'];
  if(month){w.push('(g.period_month IS NULL OR g.period_month=?)');params.push(month);}
  if(siteCode){w.push('(g.site_code IS NULL OR g.site_code=?)');params.push(siteCode);}
  const [rows]=await db.execute(`SELECT g.*,u.name owner_name FROM performance_goals g LEFT JOIN users u ON u.id=g.owner_user_id
    WHERE ${w.join(' AND ')} ORDER BY FIELD(g.status,'ACTIVE','PAUSED','ACHIEVED','CLOSED'),g.id DESC`,params);
  return rows.map(r=>({...r,progress:Number(r.target_value)>0?Math.max(0,Math.min(100,Math.round(Number(r.current_value||0)/Number(r.target_value)*100))):0}));
}
async function actions({year,month,siteCode,status=''}) {
  const start=`${year}-${String(month).padStart(2,'0')}-01`;
  const end=new Date(year,month,0).toISOString().slice(0,10);
  const params=[start,end],w=["DATE(a.created_at) BETWEEN ? AND ?"];
  if(siteCode){w.push('(a.site_code IS NULL OR a.site_code=?)');params.push(siteCode);}
  if(status){w.push('a.status=?');params.push(status);}
  const [rows]=await db.execute(`SELECT a.*,u.name owner_name FROM performance_actions a LEFT JOIN users u ON u.id=a.owner_user_id
    WHERE ${w.join(' AND ')} ORDER BY FIELD(a.status,'BLOCKED','OPEN','IN_PROGRESS','DONE','CANCELLED'),FIELD(a.priority,'P1','P2','P3'),a.due_at IS NULL,a.due_at,a.id DESC`,params);
  const now=Date.now();
  return rows.map(r=>({...r,overdue:!['DONE','CANCELLED'].includes(r.status)&&r.due_at&&new Date(r.due_at).getTime()<now}));
}
async function blocks({siteCode}){
  const params=[],w=['b.resolved_at IS NULL'];
  if(siteCode){w.push('(b.site_code IS NULL OR b.site_code=?)');params.push(siteCode);}
  const [rows]=await db.execute(`SELECT b.*,u.name owner_name,TIMESTAMPDIFF(HOUR,b.blocked_at,NOW()) age_hours
    FROM performance_work_blocks b LEFT JOIN users u ON u.id=b.owner_user_id WHERE ${w.join(' AND ')}
    ORDER BY b.blocked_at ASC,b.id`,params);
  return rows.map(r=>({...r,age_bucket:num(r.age_hours)<24?'<24h':num(r.age_hours)<72?'1–3d':num(r.age_hours)<168?'4–7d':'>7d'}));
}
async function decisions({year,month}){
  const start=`${year}-${String(month).padStart(2,'0')}-01`,end=new Date(year,month,0).toISOString().slice(0,10);
  const [rows]=await db.execute(`SELECT d.*,u.name owner_name FROM performance_decisions d LEFT JOIN users u ON u.id=d.owner_user_id
    WHERE d.decision_date BETWEEN ? AND ? ORDER BY d.decision_date DESC,d.id DESC`,[start,end]);
  return rows;
}
function forecast(base){
  const today=new Date(),same=today.getFullYear()===base.range.year&&today.getMonth()+1===base.range.month;
  const days=new Date(base.range.year,base.range.month,0).getDate();
  const elapsed=same?today.getDate():days;
  const ratio=Math.max(1,days)/Math.max(1,elapsed);
  const project=v=>Math.round(num(v)*ratio*10)/10;
  const collectionProjected=Math.min(100,Math.round((num(base.billing.collection_rate)+(100-num(base.billing.collection_rate))*(elapsed/days))*10)/10);
  return {
    day:elapsed,days,
    psb:project(base.growth.psb),
    ticketCreated:project(base.tickets.created),
    workDone:project(base.work.done),
    revenue:Math.round(project(base.finance.revenue)),
    collection:collectionProjected,
    label:same?'Projected akhir bulan':'Final periode'
  };
}
function whatChanged(base){
  return [
    {label:'Collection',value:base.variance.collection,unit:'pp',good:base.variance.collection>=0},
    {label:'PSB',value:base.variance.psb,unit:'',good:base.variance.psb>=0},
    {label:'SLA',value:base.variance.sla,unit:'pp',good:base.variance.sla>=0},
    {label:'Work completion',value:base.variance.work,unit:'pp',good:base.variance.work>=0},
    {label:'Backlog',value:base.variance.backlog,unit:'',good:base.variance.backlog<=0}
  ];
}
function agingSummary(actionRows,blockRows){
  const buckets={'<24h':0,'1–3d':0,'4–7d':0,'>7d':0};
  const now=Date.now();
  actionRows.filter(a=>!['DONE','CANCELLED'].includes(a.status)).forEach(a=>{
    const h=Math.max(0,(now-new Date(a.created_at).getTime())/3600000);
    buckets[h<24?'<24h':h<72?'1–3d':h<168?'4–7d':'>7d']++;
  });
  blockRows.forEach(b=>{buckets[b.age_bucket]=(buckets[b.age_bucket]||0)+1;});
  return buckets;
}
async function dashboard(base){
  await ensureExecutionSchema();
  const [people,goalRows,actionRows,blockRows,decisionRows]=await Promise.all([
    users(),goals({year:base.range.year,month:base.range.month,siteCode:base.site?.code||''}),
    actions({year:base.range.year,month:base.range.month,siteCode:base.site?.code||''}),
    blocks({siteCode:base.site?.code||''}),decisions({year:base.range.year,month:base.range.month})
  ]);
  return {
    people,goals:goalRows,executionActions:actionRows,blocks:blockRows,decisions:decisionRows,
    forecast:forecast(base),whatChanged:whatChanged(base),aging:agingSummary(actionRows,blockRows),
    executionSummary:{
      open:actionRows.filter(x=>x.status==='OPEN').length,
      progress:actionRows.filter(x=>x.status==='IN_PROGRESS').length,
      blocked:actionRows.filter(x=>x.status==='BLOCKED').length+blockRows.length,
      overdue:actionRows.filter(x=>x.overdue).length,
      done:actionRows.filter(x=>x.status==='DONE').length
    }
  };
}

async function addGoal(body,userId){
  await ensureExecutionSchema();
  const title=clean(body.title,180); if(!title)throw new Error('Judul goal wajib diisi.');
  await db.execute(`INSERT INTO performance_goals(title,metric_key,target_value,current_value,unit,period_type,period_year,period_month,site_code,owner_user_id,notes,created_by)
    VALUES(?,?,?,?,?,'MONTH',?,?,?,?,?,?)`,[
      title,clean(body.metric_key,80)||null,Number(body.target_value)||0,Number(body.current_value)||0,clean(body.unit,30)||null,
      Number(body.year),Number(body.month)||null,clean(body.site_code,30)||null,Number(body.owner_user_id)||null,clean(body.notes,500)||null,userId
    ]);
}
async function updateGoal(id,body){
  const status=['ACTIVE','ACHIEVED','PAUSED','CLOSED'].includes(body.status)?body.status:'ACTIVE';
  await db.execute(`UPDATE performance_goals SET current_value=?,target_value=?,status=?,owner_user_id=?,notes=? WHERE id=?`,
    [Number(body.current_value)||0,Number(body.target_value)||0,status,Number(body.owner_user_id)||null,clean(body.notes,500)||null,id]);
}
async function addAction(body,userId){
  await ensureExecutionSchema();
  const title=clean(body.title,220); if(!title)throw new Error('Judul action wajib diisi.');
  const priority=['P1','P2','P3'].includes(body.priority)?body.priority:'P2';
  const [r]=await db.execute(`INSERT INTO performance_actions(source_type,source_key,title,description,priority,owner_user_id,site_code,due_at,status,created_by)
    VALUES(?,?,?,?,?,?,?,?, 'OPEN',?)`,[
      clean(body.source_type,50)||'MANUAL',clean(body.source_key,160)||null,title,clean(body.description,1000)||null,priority,
      Number(body.owner_user_id)||null,clean(body.site_code,30)||null,body.due_at||null,userId
    ]);
  await db.execute(`INSERT INTO performance_action_logs(action_id,event_type,note,actor_user_id) VALUES(?,'CREATED',?,?)`,[r.insertId,'Action dibuat',userId]);
  return r.insertId;
}
async function updateAction(id,body,userId){
  const [[before]]=await db.execute(`SELECT * FROM performance_actions WHERE id=? LIMIT 1`,[id]);
  if(!before)throw new Error('Action tidak ditemukan.');
  const status=['OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED'].includes(body.status)?body.status:before.status;
  const result=clean(body.result_note,1000)||null,block=clean(body.block_reason,300)||null;
  await db.execute(`UPDATE performance_actions SET status=?,owner_user_id=?,due_at=?,block_reason=?,result_note=?,result_value=?,
    resolved_by=IF(?='DONE',?,NULL),resolved_at=IF(?='DONE',NOW(),NULL) WHERE id=?`,
    [status,Number(body.owner_user_id)||null,body.due_at||null,block,result,clean(body.result_value,160)||null,status,userId,status,id]);
  await db.execute(`INSERT INTO performance_action_logs(action_id,event_type,note,actor_user_id) VALUES(?,?,?,?)`,
    [id,status,result||block||`Status ${status}`,userId]);
}
async function addBlock(body,userId){
  await ensureExecutionSchema();
  const title=clean(body.title,220),reason=clean(body.reason_text,500);
  if(!title||!reason)throw new Error('Judul dan alasan blocked wajib diisi.');
  await db.execute(`INSERT INTO performance_work_blocks(entity_type,entity_id,entity_key,title,reason_code,reason_text,owner_user_id,site_code,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`,[
      ['TICKET','SCHEDULE','PSB','BILLING','NETWORK','OTHER'].includes(body.entity_type)?body.entity_type:'OTHER',
      Number(body.entity_id)||null,clean(body.entity_key,160)||null,title,clean(body.reason_code,60)||null,reason,
      Number(body.owner_user_id)||null,clean(body.site_code,30)||null,userId
    ]);
}
async function resolveBlock(id,userId){
  await db.execute(`UPDATE performance_work_blocks SET resolved_at=NOW(),resolved_by=? WHERE id=? AND resolved_at IS NULL`,[userId,id]);
}
async function addDecision(body,userId){
  const title=clean(body.title,220),decision=clean(body.decision_text,1500);
  if(!title||!decision)throw new Error('Judul dan keputusan wajib diisi.');
  await db.execute(`INSERT INTO performance_decisions(decision_date,title,context_text,decision_text,owner_user_id,due_date,created_by)
    VALUES(?,?,?,?,?,?,?)`,[body.decision_date||new Date().toISOString().slice(0,10),title,clean(body.context_text,1000)||null,decision,Number(body.owner_user_id)||null,body.due_date||null,userId]);
}
async function updateDecision(id,body){
  const status=['OPEN','DONE','CANCELLED'].includes(body.status)?body.status:'OPEN';
  await db.execute(`UPDATE performance_decisions SET status=?,result_text=? WHERE id=?`,[status,clean(body.result_text,1000)||null,id]);
}

module.exports={ensureExecutionSchema,dashboard,addGoal,updateGoal,addAction,updateAction,addBlock,resolveBlock,addDecision,updateDecision};
