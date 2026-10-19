const db=require('../config/db');
const {overview: infrastructureOverview}=require('./networkInfrastructureService');

async function scalar(sql,params=[]){try{const [[r]]=await db.query(sql,params);return r||{};}catch(_){return {};}}
const cleanScope=value=>['KRW','KBG','CLM'].includes(String(value||'').toUpperCase())?String(value).toUpperCase():'';

async function networkWorkspace(section='overview',scope=''){
  const siteScope=cleanScope(scope);
  const base=await infrastructureOverview().catch(()=>({health:0,summary:{},sites:[],routers:[],olts:[],probes:[],alerts:[],events:[],server:{}}));
  const siteClause=siteScope?' AND s.code=?':'';
  const pppClause=siteScope?' AND p.site_id=(SELECT id FROM sites WHERE code=? LIMIT 1)':'';
  const incidentClause=siteScope?' AND a.site_id=(SELECT id FROM sites WHERE code=? LIMIT 1)':'';

  const [ppp,ont,devices,incidentCounts,siteOptions]=await Promise.all([
    scalar(`SELECT COUNT(*) total,
      SUM(p.is_online=1 AND p.is_isolated=0) online,
      SUM(p.is_online=0 AND p.is_isolated=0 AND p.disabled=0) offline,
      SUM(p.is_isolated=1) isolated,
      SUM(p.customer_id IS NULL AND p.is_exempt=0) unsynced
      FROM ppp_secrets p WHERE p.removed_on_router_at IS NULL${pppClause}`,siteScope?[siteScope]:[]),
    scalar(`SELECT COUNT(*) total,
      SUM(d.online_status='online') online,
      SUM(d.online_status='offline') offline,
      SUM(d.signal_status='warning') warning,
      SUM(d.signal_status='critical') critical
      FROM acs_devices d
      LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id
      LEFT JOIN customers c ON c.id=l.customer_id
      LEFT JOIN sites s ON s.id=c.site_id
      WHERE 1=1${siteClause}`,siteScope?[siteScope]:[]),
    scalar(`SELECT
      (SELECT COUNT(*) FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1${siteScope?' AND s.code=?':''}) routers,
      (SELECT COUNT(*) FROM olt_devices o LEFT JOIN sites s ON s.id=o.site_id WHERE 1=1${siteScope?' AND s.code=?':''}) olts,
      (SELECT COUNT(*) FROM sites s WHERE s.is_active=1${siteScope?' AND s.code=?':''}) sites,
      (SELECT COUNT(*) FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id WHERE 1=1${siteScope?' AND s.code=?':''}) onts`,
      siteScope?[siteScope,siteScope,siteScope,siteScope]:[]),
    scalar(`SELECT COUNT(*) total,
      SUM(a.severity='critical') critical,
      SUM(a.severity='warning') warning,
      SUM(a.acknowledged_by IS NOT NULL) acknowledged
      FROM nms_alerts a WHERE a.resolved_at IS NULL${incidentClause}`,siteScope?[siteScope]:[]),
    db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY FIELD(code,'KRW','KBG','CLM'),code`).then(([rows])=>rows).catch(()=>[])
  ]);

  const baseSites=siteScope?(base.sites||[]).filter(s=>s.code===siteScope):(base.sites||[]);
  const baseRouters=siteScope?(base.routers||[]).filter(r=>r.siteCode===siteScope):(base.routers||[]);
  const baseOlts=siteScope?(base.olts||[]).filter(o=>o.site_code===siteScope):(base.olts||[]);
  const baseProbes=siteScope?(base.probes||[]).filter(p=>p.site_code===siteScope):(base.probes||[]);

  let alerts=[],events=[];
  if(section==='incidents'||section==='overview'){
    const params=[];
    let filter='';
    if(siteScope){filter=' AND a.site_id=(SELECT id FROM sites WHERE code=? LIMIT 1)';params.push(siteScope);}
    [alerts]=await db.query(`SELECT a.*,r.name router_name,s.code site_code
      FROM nms_alerts a LEFT JOIN routers r ON r.id=a.router_id LEFT JOIN sites s ON s.id=a.site_id
      WHERE a.resolved_at IS NULL${filter}
      ORDER BY FIELD(a.severity,'critical','warning','info'),a.opened_at DESC LIMIT 80`,params).catch(()=>[[]]);

    const eventParams=[];
    let eventFilter='';
    if(siteScope){eventFilter=' WHERE e.site_id=(SELECT id FROM sites WHERE code=? LIMIT 1)';eventParams.push(siteScope);}
    [events]=await db.query(`SELECT e.event_type,e.router_id,e.site_id,e.username,e.message,e.occurred_at
      FROM nms_ppp_events e${eventFilter} ORDER BY e.occurred_at DESC LIMIT 60`,eventParams).catch(()=>[[]]);
  }

  let subscribers=[];
  if(section==='subscribers'){
    const params=[];
    let filter=`c.archived_at IS NULL`;
    if(siteScope){filter+=` AND s.code=?`;params.push(siteScope);}
    [subscribers]=await db.query(`SELECT c.id,c.customer_code,c.name,s.code site_code,pk.name package_name,c.pppoe_username,
      ps.is_online ppp_online,ps.is_isolated,ps.profile ppp_profile,
      d.id ont_id,d.serial_number,d.online_status ont_status,d.rx_power,d.signal_status,d.ssid
      FROM customers c
      JOIN sites s ON s.id=c.site_id
      LEFT JOIN packages pk ON pk.id=c.package_id
      LEFT JOIN ppp_secrets ps ON ps.customer_id=c.id AND ps.removed_on_router_at IS NULL
      LEFT JOIN customer_ont_links l ON l.customer_id=c.id
      LEFT JOIN acs_devices d ON d.id=l.acs_device_id
      WHERE ${filter}
      ORDER BY (ps.is_online=0 OR ps.is_online IS NULL) DESC,(d.online_status='offline') DESC,(d.signal_status IN ('critical','warning')) DESC,s.code,c.name
      LIMIT 250`,params).catch(()=>[[]]);
  }

  const experience=baseProbes.reduce((acc,p)=>{
    const k=p.category||'other';if(!acc[k])acc[k]={category:k,count:0,score:0,down:0};
    acc[k].count++;acc[k].score+=Number(p.score||0);if(p.status==='down')acc[k].down++;return acc;
  },{});
  Object.values(experience).forEach(x=>x.score=x.count?Math.round(x.score/x.count):0);

  const scopedRouterOnline=baseRouters.filter(r=>r.status==='online').length;
  const scopedHealth=siteScope
    ? Math.max(0,Math.round(((baseRouters.length?scopedRouterOnline/baseRouters.length:1)*60)+((baseProbes.length?baseProbes.reduce((a,b)=>a+Number(b.score||0),0)/baseProbes.length:100)*.4)-Number(incidentCounts.critical||0)*8))
    : Number(base.health||0);

  return {
    section,scope:siteScope,scopeOptions:siteOptions,generatedAt:new Date().toISOString(),health:scopedHealth,
    summary:siteScope?{
      ...(base.summary||{}),
      routersOnline:scopedRouterOnline,routersTotal:baseRouters.length,
      pppOnline:Number(ppp.online||0),customers:baseSites.reduce((a,b)=>a+Number(b.customers||0),0),
      rxBps:baseRouters.reduce((a,b)=>a+Number(b.wan?.rxBps||0),0),txBps:baseRouters.reduce((a,b)=>a+Number(b.wan?.txBps||0),0),
      criticalAlerts:Number(incidentCounts.critical||0)
    }:(base.summary||{}),
    sites:baseSites,routers:baseRouters,olts:baseOlts,probes:baseProbes,server:base.server||{},
    ppp:{total:Number(ppp.total||0),online:Number(ppp.online||0),offline:Number(ppp.offline||0),isolated:Number(ppp.isolated||0),unsynced:Number(ppp.unsynced||0)},
    ont:{total:Number(ont.total||0),online:Number(ont.online||0),offline:Number(ont.offline||0),warning:Number(ont.warning||0),critical:Number(ont.critical||0)},
    devices:{routers:Number(devices.routers||0),olts:Number(devices.olts||0),sites:Number(devices.sites||0),onts:Number(devices.onts||0)},
    incidents:{total:Number(incidentCounts.total||0),critical:Number(incidentCounts.critical||0),warning:Number(incidentCounts.warning||0),acknowledged:Number(incidentCounts.acknowledged||0)},
    alerts,events,subscribers,experience:Object.values(experience)
  };
}
module.exports={networkWorkspace,cleanScope};