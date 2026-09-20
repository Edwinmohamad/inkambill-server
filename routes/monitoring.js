const express=require('express');
const db=require('../config/db');
const {config:acsConfig}=require('../services/acsService');
const {getTrafficTrend,getResourceTrend}=require('../services/nmsTelemetryService');
const {oltSummaryRows}=require('../services/oltService');
const router=express.Router();

function hourBucket(date){const d=new Date(date);d.setMinutes(0,0,0);return d.toISOString();}
function clampScore(n){return Math.max(0,Math.min(100,Math.round(n)));}

router.get('/',(req,res)=>{res.render('monitoring/index',{title:'Dashboard Monitoring'});});

// ---------- ONT board ----------
router.get('/api/ont',async(req,res,next)=>{try{
  const [[summary]]=await db.query(`SELECT COUNT(*) total,SUM(online_status='online') online,SUM(online_status='offline') offline,SUM(signal_status='warning') warning,SUM(signal_status='critical') critical,SUM(NOT EXISTS(SELECT 1 FROM customer_ont_links l WHERE l.acs_device_id=acs_devices.id)) unlinked FROM acs_devices`);
  const total=Number(summary.total||0),online=Number(summary.online||0),offline=Number(summary.offline||0),warning=Number(summary.warning||0),critical=Number(summary.critical||0),unlinked=Number(summary.unlinked||0);
  const score=total?clampScore(((online-critical)/total)*100):null;

  const [attention]=await db.query(`SELECT d.id,d.serial_number,d.rx_power,d.temperature,d.online_status,d.signal_status,d.olt_name,d.pon_port,d.last_inform,c.name customer_name,s.code site_code
    FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id
    WHERE d.online_status='offline' OR d.signal_status IN ('critical','warning')
    ORDER BY FIELD(d.online_status,'offline','unknown','online'),FIELD(d.signal_status,'critical','warning','unknown','normal'),d.last_inform DESC LIMIT 8`);

  const [rawTrend]=await db.query(`SELECT sampled_at,SUM(online_status='online') online,COUNT(*) total FROM acs_device_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR) GROUP BY sampled_at ORDER BY sampled_at ASC`);
  const buckets=new Map();
  rawTrend.forEach(row=>{const key=hourBucket(row.sampled_at);const cur=buckets.get(key)||{online:0,total:0,n:0};cur.online+=Number(row.online||0);cur.total+=Number(row.total||0);cur.n++;buckets.set(key,cur);});
  const trend=[...buckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,pct:v.total?clampScore((v.online/v.total)*100):null}));

  const [[lastSync]]=await db.query(`SELECT finished_at,status FROM acs_sync_logs ORDER BY id DESC LIMIT 1`);
  res.set('Cache-Control','no-store').json({ok:true,summary:{total,online,offline,warning,critical,unlinked,score},attention,trend,lastSync:lastSync||null,acsConfigured:!!acsConfig().baseUrl});
}catch(err){next(err);}});

router.get('/api/ont/search',async(req,res,next)=>{try{
  const q=String(req.query.q||'').trim();
  if(!q)return res.json({ok:true,devices:[]});
  const like=`%${q}%`;
  const [devices]=await db.query(`SELECT d.id,d.serial_number,d.device_id,d.wan_ip,d.ssid,d.online_status,d.signal_status,d.rx_power,c.name customer_name FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id WHERE d.serial_number LIKE ? OR d.device_id LIKE ? OR c.name LIKE ? ORDER BY c.name,d.serial_number LIMIT 10`,[like,like,like]);
  res.json({ok:true,devices});
}catch(err){next(err);}});

// ---------- MikroTik board ----------
router.get('/api/mikrotik',async(req,res,next)=>{try{
  const [[summary]]=await db.query(`SELECT COUNT(*) total,SUM(last_status='online') online,SUM(last_status='offline') offline,SUM(last_status IS NULL) never FROM routers WHERE is_active=1`);
  const total=Number(summary.total||0),online=Number(summary.online||0),offline=Number(summary.offline||0),never=Number(summary.never||0);
  const score=total?clampScore((online/total)*100):null;

  const [[sessionRow]]=await db.query(`SELECT COUNT(*) active_sessions FROM nms_pppoe_sessions WHERE status='online'`);
  const [[custRow]]=await db.query(`SELECT SUM(network_status='online') online,SUM(network_status='isolated') isolated,COUNT(*) total FROM customers WHERE archived_at IS NULL AND customer_status='active'`);

  const [latestCpu]=await db.query(`SELECT ns.router_id,ns.cpu_load,ns.free_memory,ns.total_memory,ns.sampled_at FROM nms_resource_samples ns INNER JOIN (SELECT router_id,MAX(sampled_at) max_time FROM nms_resource_samples GROUP BY router_id) latest ON latest.router_id=ns.router_id AND latest.max_time=ns.sampled_at`);
  const cpuByRouter=new Map(latestCpu.map(r=>[Number(r.router_id),r]));
  const [routers]=await db.query(`SELECT r.id,r.name,r.last_status,r.last_error,r.last_seen_at,s.code site_code FROM routers r LEFT JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 ORDER BY r.name`);
  const enriched=routers.map(r=>{const cpu=cpuByRouter.get(Number(r.id));return {...r,cpu_load:cpu?Number(cpu.cpu_load):null,free_memory:cpu?Number(cpu.free_memory):null,total_memory:cpu?Number(cpu.total_memory):null};});
  const attention=enriched.filter(r=>r.last_status==='offline'||(r.cpu_load!==null&&r.cpu_load>=85)).sort((a,b)=>(a.last_status==='offline'?0:1)-(b.last_status==='offline'?0:1)).slice(0,8);

  const [trafficRows]=await db.query(`SELECT sampled_at,SUM(rx_bps) rx_bps,SUM(tx_bps) tx_bps FROM nms_interface_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR) GROUP BY sampled_at ORDER BY sampled_at ASC`);
  const trafficBuckets=new Map();
  trafficRows.forEach(row=>{const key=hourBucket(row.sampled_at);const cur=trafficBuckets.get(key)||{rx:0,tx:0,n:0};cur.rx+=Number(row.rx_bps||0);cur.tx+=Number(row.tx_bps||0);cur.n++;trafficBuckets.set(key,cur);});
  const trafficTrend=[...trafficBuckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,rxBps:v.n?Math.round(v.rx/v.n):0,txBps:v.n?Math.round(v.tx/v.n):0}));

  const [cpuRows]=await db.query(`SELECT sampled_at,AVG(cpu_load) avg_cpu FROM nms_resource_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR) GROUP BY sampled_at ORDER BY sampled_at ASC`);
  const cpuBuckets=new Map();
  cpuRows.forEach(row=>{const key=hourBucket(row.sampled_at);const cur=cpuBuckets.get(key)||{sum:0,n:0};cur.sum+=Number(row.avg_cpu||0);cur.n++;cpuBuckets.set(key,cur);});
  const cpuTrend=[...cpuBuckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,cpu:v.n?Math.round((v.sum/v.n)*10)/10:null}));

  res.set('Cache-Control','no-store').json({ok:true,summary:{total,online,offline,never,score,activeSessions:Number(sessionRow.active_sessions||0),customersOnline:Number(custRow.online||0),customersIsolated:Number(custRow.isolated||0),customersTotal:Number(custRow.total||0)},attention,trafficTrend,cpuTrend});
}catch(err){next(err);}});

router.get('/api/mikrotik/routers',async(req,res,next)=>{try{
  const [routers]=await db.query(`SELECT id,name FROM routers WHERE is_active=1 ORDER BY name`);
  res.json({ok:true,routers});
}catch(err){next(err);}});

router.get('/api/mikrotik/trend',async(req,res,next)=>{try{
  const [traffic,resource]=await Promise.all([
    getTrafficTrend({routerId:req.query.router_id,hours:req.query.hours||24}),
    getResourceTrend({routerId:req.query.router_id,hours:req.query.hours||24})
  ]);
  res.set('Cache-Control','no-store').json({ok:true,traffic,resource});
}catch(err){next(err);}});

// ---------- OLT board ----------
router.get('/api/olt',async(req,res,next)=>{try{
  const olts=await oltSummaryRows();
  const totalOnu=olts.reduce((a,o)=>a+o.onu_total,0);
  const online=olts.reduce((a,o)=>a+o.onu_online,0);
  const offline=olts.reduce((a,o)=>a+o.onu_offline,0);
  const warning=olts.reduce((a,o)=>a+o.onu_warning,0);
  const critical=olts.reduce((a,o)=>a+o.onu_critical,0);
  const score=totalOnu?clampScore(((online-critical)/totalOnu)*100):null;
  const attention=[...olts].filter(o=>o.onu_offline||o.onu_critical).slice(0,8);

  const cfg=acsConfig();
  const [rawTrend]=await db.query(`SELECT sampled_at,SUM(rx_power IS NOT NULL AND rx_power<=?) critical_count,COUNT(*) total FROM acs_device_samples WHERE sampled_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR)`+` AND acs_device_id IN (SELECT id FROM acs_devices WHERE olt_name IS NOT NULL AND olt_name<>'') GROUP BY sampled_at ORDER BY sampled_at ASC`,[cfg.critical]);
  const buckets=new Map();
  rawTrend.forEach(row=>{const key=hourBucket(row.sampled_at);const cur=buckets.get(key)||{critical:0,total:0};cur.critical+=Number(row.critical_count||0);cur.total+=Number(row.total||0);buckets.set(key,cur);});
  const trend=[...buckets.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([t,v])=>({t,critical:v.critical,total:v.total}));

  res.set('Cache-Control','no-store').json({ok:true,summary:{total:olts.length,totalOnu,online,offline,warning,critical,score},olts,attention,trend});
}catch(err){next(err);}});

module.exports=router;
