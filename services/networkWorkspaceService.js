const db=require('../config/db');
const {overview: infrastructureOverview}=require('./networkInfrastructureService');
const {oltDetailRows}=require('./oltService');

async function scalar(sql,params=[]){try{const [[r]]=await db.query(sql,params);return r||{};}catch(_){return {};}}
async function networkWorkspace(section='overview'){
  const base=await infrastructureOverview().catch(()=>({health:0,summary:{},sites:[],routers:[],olts:[],probes:[],alerts:[],events:[]}));
  const [ppp,ont,devices,incidentCounts]=await Promise.all([
    scalar(`SELECT COUNT(*) total,
      SUM(is_online=1 AND is_isolated=0) online,
      SUM(is_online=0 AND is_isolated=0 AND disabled=0) offline,
      SUM(is_isolated=1) isolated,
      SUM(customer_id IS NULL AND is_exempt=0) unsynced
      FROM ppp_secrets WHERE removed_on_router_at IS NULL`),
    scalar(`SELECT COUNT(*) total,
      SUM(online_status='online') online,
      SUM(online_status='offline') offline,
      SUM(signal_status='warning') warning,
      SUM(signal_status='critical') critical
      FROM acs_devices`),
    scalar(`SELECT
      (SELECT COUNT(*) FROM routers WHERE is_active=1) routers,
      (SELECT COUNT(*) FROM olt_devices) olts,
      (SELECT COUNT(*) FROM sites WHERE is_active=1) sites,
      (SELECT COUNT(*) FROM acs_devices) onts`),
    scalar(`SELECT COUNT(*) total,
      SUM(severity='critical') critical,
      SUM(severity='warning') warning,
      SUM(acknowledged_by IS NOT NULL) acknowledged
      FROM nms_alerts WHERE resolved_at IS NULL`)
  ]);
  let alerts=[],events=[],olts=base.olts||[];
  if(section==='incidents'||section==='overview'){
    [alerts]=await db.query(`SELECT a.*,r.name router_name,s.code site_code
      FROM nms_alerts a LEFT JOIN routers r ON r.id=a.router_id LEFT JOIN sites s ON s.id=a.site_id
      WHERE a.resolved_at IS NULL
      ORDER BY FIELD(a.severity,'critical','warning','info'),a.opened_at DESC LIMIT 80`).catch(()=>[[]]);
    [events]=await db.query(`SELECT event_type,router_id,site_id,username,message,occurred_at
      FROM nms_ppp_events ORDER BY occurred_at DESC LIMIT 60`).catch(()=>[[]]);
  }
  if(section==='access' && !olts.length) olts=await oltDetailRows().catch(()=>[]);
  const experience=(base.probes||[]).reduce((acc,p)=>{
    const k=p.category||'other'; if(!acc[k])acc[k]={category:k,count:0,score:0,down:0};
    acc[k].count++;acc[k].score+=Number(p.score||0);if(p.status==='down')acc[k].down++;return acc;
  },{});
  Object.values(experience).forEach(x=>x.score=x.count?Math.round(x.score/x.count):0);
  return {
    section,generatedAt:new Date().toISOString(),health:Number(base.health||0),summary:base.summary||{},
    sites:base.sites||[],routers:base.routers||[],olts,probes:base.probes||[],
    ppp:{total:Number(ppp.total||0),online:Number(ppp.online||0),offline:Number(ppp.offline||0),isolated:Number(ppp.isolated||0),unsynced:Number(ppp.unsynced||0)},
    ont:{total:Number(ont.total||0),online:Number(ont.online||0),offline:Number(ont.offline||0),warning:Number(ont.warning||0),critical:Number(ont.critical||0)},
    devices:{routers:Number(devices.routers||0),olts:Number(devices.olts||0),sites:Number(devices.sites||0),onts:Number(devices.onts||0)},
    incidents:{total:Number(incidentCounts.total||0),critical:Number(incidentCounts.critical||0),warning:Number(incidentCounts.warning||0),acknowledged:Number(incidentCounts.acknowledged||0)},
    alerts,events,experience:Object.values(experience)
  };
}
module.exports={networkWorkspace};