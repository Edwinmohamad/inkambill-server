const express=require('express');
const db=require('../config/db');
const {config:acsConfig}=require('../services/acsService');
const {getTrafficTrend,getResourceTrend}=require('../services/nmsTelemetryService');
const {oltSummaryRows}=require('../services/oltService');
const router=express.Router();

const ALLOWED_HOURS=[24,168,720];
function clampHours(h){const n=Number(h);return ALLOWED_HOURS.includes(n)?n:24;}
function clampScore(n){return Math.max(0,Math.min(100,Math.round(n)));}
function bucketKey(date,hours){const d=new Date(date);if(Number.isNaN(d.getTime()))return null;if(hours<=48){d.setMinutes(0,0,0);}else{d.setHours(0,0,0,0);}return d.toISOString();}
function safeSite(value){const v=String(value||'').trim();return v?v.slice(0,30):'';}

// Resolves a site code to its numeric id (used by MikroTik/OLT filtering, which key on site_id).
async function siteIdByCode(code){
  if(!code)return null;
  const [[row]]=await db.query(`SELECT id FROM sites WHERE code=? AND is_active=1 LIMIT 1`,[code]);
  return row?Number(row.id):null;
}
// Resolves a site code to the acs_devices.id list belonging to it (via customer -> site), used to
// scope ONT summary/attention/trend queries. Returns null when no filter is active.
async function ontDeviceIdsForSite(code){
  if(!code)return null;
  const [rows]=await db.query(`SELECT d.id FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id WHERE s.code=?`,[code]);
  return rows.map(r=>Number(r.id));
}

router.get('/',async(req,res,next)=>{try{
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('monitoring/index',{title:'Dashboard Monitoring',sites});
}catch(err){next(err);}});

// ---------- Per-site combined summary (shown beneath all three boards) ----------
router.get('/api/sites',async(req,res,next)=>{try{
  const [rows]=await db.query(`SELECT s.id,s.code,s.name,
    (SELECT COUNT(*) FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id WHERE c.site_id=s.id) ont_total,
    (SELECT COUNT(*) FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id WHERE c.site_id=s.id AND d.online_status='online') ont_online,
    (SELECT COUNT(*) FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id WHERE c.site_id=s.id AND d.signal_status='critical') ont_critical,
    (SELECT COUNT(*) FROM routers r WHERE r.site_id=s.id AND r.is_active=1) router_total,
    (SELECT COUNT(*) FROM routers r WHERE r.site_id=s.id AND r.is_active=1 AND r.last_status='online') router_online
    FROM sites s WHERE s.is_active=1 ORDER BY s.code`);
  res.set('Cache-Control','no-store').json({ok:true,sites:rows.map(r=>({id:r.id,code:r.code,name:r.name,ontTotal:Number(r.ont_total||0),ontOnline:Number(r.ont_online||0),ontCritical:Number(r.ont_critical||0),routerTotal:Number(r.router_total||0),routerOnline:Number(r.router_online||0)}))});
}catch(err){next(err);}});

// ---------- ONT board ----------
router.get('/api/ont',async(req,res,next)=>{try{
  const site=safeSite(req.query.site);
  const hours=clampHours(req.query.hours);
  const ids=await ontDeviceIdsForSite(site);
  if(ids && !ids.length){
    return res.set('Cache-Control','no-store').json({ok:true,summary:{total:0,online:0,offline:0,warning:0,critical:0,unlinked:0,score:null},attention:[],trend:[],lastSync:null,acsConfigured:!!acsConfig().baseUrl,hours,site});
  }
  const scope=ids?' AND acs_devices.id IN (?)':'';
  const scopeParamsBase=ids?[ids]:[];

  const [[summary]]=await db.query(`SELECT COUNT(*) total,SUM(online_status='online') online,SUM(online_status='offline') offline,SUM(signal_status='warning') warning,SUM(signal_status='critical') critical,SUM(NOT EXISTS(SELECT 1 FROM customer_ont_links l WHERE l.acs_device_id=acs_devices.id)) unlinked FROM acs_devices WHERE 1=1${scope}`,scopeParamsBase);
  const total=Number(summary.total||0),online=Number(summary.online||0),offline=Number(summary.offline||0),warning=Number(summary.warning||0),critical=Number(summary.critical||0),unlinked=Number(summary.unlinked||0);
  const score=total?clampScore(((online-critical)/total)*100):null;

  const attnScope=ids?' AND d.id IN (?)':'';
  const [attention]=await db.query(`SELECT d.id,d.serial_number,d.rx_power,d.temperature,d.online_status,d.signal_status,d.olt_name,d.pon_port,d.last_inform,c.name customer_name,s.code site_code
    FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id
    WHERE (d.online_status='offline' OR d.signal_status IN ('critical','warning'))${attnScope}
    ORDER BY FIELD(d.online_status,'offline','unknown','online'),FIELD(d.signal_status,'critical','warning','unknown','normal'),d.last_inform DESC LIMIT 8`,ids?[ids]:[]);

  const trendScope=ids?' AND acs_device_id IN (?)':'';
  const [rawTrend]=await db.query(`SELECT sampled_at,SUM(online_status='online') online,COUNT(*) total FROM acs_device_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL ? HOUR)${trendScope} GROUP BY sampled_at ORDER BY sampled_at ASC`,ids?[hours,ids]:[hours]);
  const buckets=new Map();
  rawTrend.forEach(row=>{const key=bucketKey(row.sampled_at,hours);if(key===null)return;const cur=buckets.get(key)||{online:0,total:0};cur.online+=Number(row.online||0);cur.total+=Number(row.total||0);buckets.set(key,cur);});
  const trend=[...buckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,pct:v.total?clampScore((v.online/v.total)*100):null}));

  const [[lastSync]]=await db.query(`SELECT finished_at,status FROM acs_sync_logs ORDER BY id DESC LIMIT 1`);
  res.set('Cache-Control','no-store').json({ok:true,summary:{total,online,offline,warning,critical,unlinked,score},attention,trend,lastSync:lastSync||null,acsConfigured:!!acsConfig().baseUrl,hours,site});
}catch(err){next(err);}});

router.get('/api/ont/search',async(req,res,next)=>{try{
  const q=String(req.query.q||'').trim();
  if(!q)return res.json({ok:true,devices:[]});
  const like=`%${q}%`;
  const [devices]=await db.query(`SELECT d.id,d.serial_number,d.device_id,d.wan_ip,d.ssid,d.online_status,d.signal_status,d.rx_power,c.name customer_name FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id WHERE d.serial_number LIKE ? OR d.device_id LIKE ? OR c.name LIKE ? ORDER BY c.name,d.serial_number LIMIT 10`,[like,like,like]);
  res.json({ok:true,devices});
}catch(err){next(err);}});

// Drill-down list: powers clicking a Distribusi Sinyal bar, an OLT utilization bar, or an offline count tile.
router.get('/api/ont/list',async(req,res,next)=>{try{
  const where=['1=1'];const params=[];
  const signal=String(req.query.signal||'');
  if(signal==='normal_group'){where.push(`d.signal_status IN ('normal','unknown')`);}
  else if(['warning','critical'].includes(signal)){where.push('d.signal_status=?');params.push(signal);}
  if(['online','offline'].includes(req.query.status)){where.push('d.online_status=?');params.push(req.query.status);}
  if(req.query.olt){where.push('d.olt_name=?');params.push(String(req.query.olt).slice(0,120));}
  const site=safeSite(req.query.site);
  if(site){where.push('s.code=?');params.push(site);}
  const [rows]=await db.query(`SELECT d.id,d.serial_number,d.device_id,d.rx_power,d.signal_status,d.online_status,d.olt_name,d.pon_port,c.name customer_name,s.code site_code
    FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id
    WHERE ${where.join(' AND ')} ORDER BY FIELD(d.online_status,'offline','unknown','online'),FIELD(d.signal_status,'critical','warning','unknown','normal'),c.name LIMIT 150`,params);
  res.json({ok:true,devices:rows});
}catch(err){next(err);}});

// ---------- MikroTik board ----------
router.get('/api/mikrotik',async(req,res,next)=>{try{
  const site=safeSite(req.query.site);
  const hours=clampHours(req.query.hours);
  const siteId=await siteIdByCode(site);
  if(site && !siteId){
    return res.set('Cache-Control','no-store').json({ok:true,summary:{total:0,online:0,offline:0,never:0,score:null,activeSessions:0,customersOnline:0,customersIsolated:0,customersTotal:0},attention:[],trafficTrend:[],cpuTrend:[],hours,site});
  }
  const siteScope=siteId?' AND site_id=?':'';
  const siteParams=siteId?[siteId]:[];

  const [[summary]]=await db.query(`SELECT COUNT(*) total,SUM(last_status='online') online,SUM(last_status='offline') offline,SUM(last_status IS NULL) never FROM routers WHERE is_active=1${siteScope}`,siteParams);
  const total=Number(summary.total||0),online=Number(summary.online||0),offline=Number(summary.offline||0),never=Number(summary.never||0);
  const score=total?clampScore((online/total)*100):null;

  const [routerRows]=await db.query(`SELECT id,name,last_status,last_error,last_seen_at FROM routers WHERE is_active=1${siteScope} ORDER BY name`,siteParams);
  const routerIds=routerRows.map(r=>Number(r.id));

  const [[sessionRow]]=routerIds.length
    ?await db.query(`SELECT COUNT(*) active_sessions FROM nms_pppoe_sessions WHERE status='online' AND router_id IN (?)`,[routerIds])
    :[[{active_sessions:0}]];
  const [[custRow]]=await db.query(`SELECT SUM(network_status='online') online,SUM(network_status='isolated') isolated,COUNT(*) total FROM customers c WHERE c.archived_at IS NULL AND c.customer_status='active'${siteId?' AND c.site_id=?':''}`,siteId?[siteId]:[]);

  const [latestCpu]=routerIds.length
    ?await db.query(`SELECT ns.router_id,ns.cpu_load,ns.free_memory,ns.total_memory FROM nms_resource_samples ns INNER JOIN (SELECT router_id,MAX(sampled_at) max_time FROM nms_resource_samples WHERE router_id IN (?) GROUP BY router_id) latest ON latest.router_id=ns.router_id AND latest.max_time=ns.sampled_at`,[routerIds])
    :[[]];
  const cpuByRouter=new Map(latestCpu.map(r=>[Number(r.router_id),r]));
  const enriched=routerRows.map(r=>{const cpu=cpuByRouter.get(Number(r.id));return {...r,cpu_load:cpu?Number(cpu.cpu_load):null,free_memory:cpu?Number(cpu.free_memory):null,total_memory:cpu?Number(cpu.total_memory):null};});
  const attention=enriched.filter(r=>r.last_status==='offline'||(r.cpu_load!==null&&r.cpu_load>=85)).sort((a,b)=>(a.last_status==='offline'?0:1)-(b.last_status==='offline'?0:1)).slice(0,8);

  const [trafficRows]=routerIds.length
    ?await db.query(`SELECT sampled_at,SUM(rx_bps) rx_bps,SUM(tx_bps) tx_bps FROM nms_interface_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL ? HOUR) AND router_id IN (?) GROUP BY sampled_at ORDER BY sampled_at ASC`,[hours,routerIds])
    :[[]];
  const trafficBuckets=new Map();
  trafficRows.forEach(row=>{const key=bucketKey(row.sampled_at,hours);if(key===null)return;const cur=trafficBuckets.get(key)||{rx:0,tx:0};cur.rx+=Number(row.rx_bps||0);cur.tx+=Number(row.tx_bps||0);trafficBuckets.set(key,cur);});
  const trafficTrend=[...trafficBuckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,rxBps:v.rx,txBps:v.tx}));

  const [cpuRows]=routerIds.length
    ?await db.query(`SELECT sampled_at,AVG(cpu_load) avg_cpu FROM nms_resource_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL ? HOUR) AND router_id IN (?) GROUP BY sampled_at ORDER BY sampled_at ASC`,[hours,routerIds])
    :[[]];
  const cpuBuckets=new Map();
  cpuRows.forEach(row=>{const key=bucketKey(row.sampled_at,hours);if(key===null)return;const cur=cpuBuckets.get(key)||{sum:0,n:0};cur.sum+=Number(row.avg_cpu||0);cur.n++;cpuBuckets.set(key,cur);});
  const cpuTrend=[...cpuBuckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,cpu:v.n?Math.round((v.sum/v.n)*10)/10:null}));

  res.set('Cache-Control','no-store').json({ok:true,summary:{total,online,offline,never,score,activeSessions:Number(sessionRow.active_sessions||0),customersOnline:Number(custRow.online||0),customersIsolated:Number(custRow.isolated||0),customersTotal:Number(custRow.total||0)},attention,trafficTrend,cpuTrend,hours,site});
}catch(err){next(err);}});

router.post('/api/mikrotik/test/:routerId',async(req,res,next)=>{try{
  const {testConnection}=require('../services/mikrotikRest');
  const [[router_]]=await db.query(`SELECT * FROM routers WHERE id=? AND is_active=1 LIMIT 1`,[req.params.routerId]);
  if(!router_)return res.status(404).json({ok:false,error:'Router tidak ditemukan.'});
  try{
    const info=await testConnection(router_);
    await db.execute(`UPDATE routers SET last_status='online',last_error=NULL,last_seen_at=NOW() WHERE id=?`,[router_.id]);
    res.json({ok:true,message:`${router_.name}: koneksi OK · RouterOS ${info?.version||'-'} · uptime ${info?.uptime||'-'}`});
  }catch(err){
    await db.execute(`UPDATE routers SET last_status='offline',last_error=? WHERE id=?`,[err.message.slice(0,500),router_.id]);
    res.status(400).json({ok:false,error:`${router_.name}: ${err.message}`});
  }
}catch(err){next(err);}});

// ---------- OLT board ----------
router.get('/api/olt',async(req,res,next)=>{try{
  const site=safeSite(req.query.site);
  const hours=clampHours(req.query.hours);
  const olts=await oltSummaryRows(site);
  const totalOnu=olts.reduce((a,o)=>a+o.onu_total,0);
  const online=olts.reduce((a,o)=>a+o.onu_online,0);
  const offline=olts.reduce((a,o)=>a+o.onu_offline,0);
  const warning=olts.reduce((a,o)=>a+o.onu_warning,0);
  const critical=olts.reduce((a,o)=>a+o.onu_critical,0);
  const score=totalOnu?clampScore(((online-critical)/totalOnu)*100):null;
  const attention=[...olts].filter(o=>o.onu_offline||o.onu_critical).slice(0,8);

  const cfg=acsConfig();
  const ids=await ontDeviceIdsForSite(site);
  let trend=[];
  if(!(ids && !ids.length)){
    const scope=ids?' AND acs_device_id IN (?)':'';
    const baseScope=` AND acs_device_id IN (SELECT id FROM acs_devices WHERE olt_name IS NOT NULL AND olt_name<>'')`;
    const [rawTrend]=await db.query(`SELECT sampled_at,SUM(rx_power IS NOT NULL AND rx_power<=?) critical_count,COUNT(*) total FROM acs_device_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL ? HOUR)${baseScope}${scope} GROUP BY sampled_at ORDER BY sampled_at ASC`,ids?[cfg.critical,hours,ids]:[cfg.critical,hours]);
    const buckets=new Map();
    rawTrend.forEach(row=>{const key=bucketKey(row.sampled_at,hours);if(key===null)return;const cur=buckets.get(key)||{critical:0,total:0};cur.critical+=Number(row.critical_count||0);cur.total+=Number(row.total||0);buckets.set(key,cur);});
    trend=[...buckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,critical:v.critical,total:v.total}));
  }

  res.set('Cache-Control','no-store').json({ok:true,summary:{total:olts.length,totalOnu,online,offline,warning,critical,score},olts,attention,trend,hours,site});
}catch(err){next(err);}});

module.exports=router;
