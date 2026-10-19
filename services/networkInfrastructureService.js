const db=require('../config/db');
const poller=require('./nms/poller');
const ros=require('./nms/rosApi');
const store=require('./nms/secretStore');
const { oltDetailRows }=require('./oltService');

const SITE_META={
  KRW:{provider:'NETLAND',wan:'103.155.167.110/30',gateway:'103.155.167.109',role:'Core / Hub',accent:'blue',
    ports:[['ether1-WAN','WAN / Uplink Netland','103.155.167.110/30','NETLAND'],['ether2-OLT 1P-HSGQ-01','OLT Access','bridge-OLT','OLT-01 · 20.20.20.2'],['ether3-OLT 2P-HSGQ-02','OLT Access','bridge-OLT','OLT-02 · 20.20.20.3'],['ether4-LAN','Server / LAN','192.168.77.1/24','SERVER-ADMIN · 192.168.77.2'],['ether5-MGT','Management','192.168.254.1/24','Emergency management']],
    logical:[['VLAN 100','PPPoE','10.10.10.1/24'],['VLAN 200','OLT Management','20.20.20.1/24'],['VLAN 1011','TR-069','11.11.11.1/24'],['WG-MGMT','Inter-site','10.66.66.1/24'],['L2TP','Management','60.60.60.1']]},
  KBG:{provider:'NETLAND',wan:'103.155.167.82/30',gateway:'103.155.167.81',role:'Distribution POP',accent:'purple',
    ports:[['ether1-NETLAND','Backup uplink','VLAN 2008','10.103.20.30/30'],['ether2-OLT','OLT trunk','10.20.30.1/24','OLT / access'],['ether3-LAN','Local LAN','192.168.88.1/24','Management'],['ether4-BACKUP-NETLAND','Main uplink','VLAN 3005','103.155.167.82/30'],['ether5-WAN','Spare','—','No active IP']],
    logical:[['VLAN 100','PPPoE','10.10.10.1/24'],['VLAN 200','Management','20.20.20.1/24'],['VLAN 400','Management','20.20.21.1/24'],['WG-KBG','Inter-site','10.200.200.1/24'],['WG-MGMT','Backbone','10.66.66.12']]},
  CLM:{provider:'MORATEL',wan:'103.79.155.30/30',gateway:'103.79.155.29',role:'Distribution POP',accent:'green',
    ports:[['ether1','Spare / DHCP','—','Inactive'],['ether2','Access / LAN','bridge1-LOAD','Bridge member'],['ether3','LAN / PPPoE','bridge1-LOAD','PPPoE'],['ether4','Access / LAN','bridge1-LOAD','Bridge member'],['ether5-WAN','Moratel WAN','103.79.155.30/30','MORATEL']],
    logical:[['bridge1-LOAD','LAN / PPPoE','192.168.22.1/24'],['WG-KRW','Inter-site','10.66.66.11/24'],['EoIP-RoMON-KRW','RoMON','10.66.66.11 ↔ 10.66.66.1'],['L2TP','Management','60.60.60.3']]}
};
const SERVER_META={name:'SERVER-ADMIN',site:'KRW',ip:'192.168.100.1',upstream:'192.168.77.2',lan:'192.168.100.0/24',routeros:'6.49.22',
  ports:[['ether1-WAN','KRW Core','192.168.77.2/24'],['ether2-PRTG','BR-SERVER','Server distribution'],['ether3-PROXMOX','BR-SERVER','Proxmox'],['ether4-HOTSPOT','BR-HOTSPOT','10.15.15.1/24'],['ether5-SERVER','BR-SERVER','Server distribution']],
  services:[['Proxmox VE','192.168.100.100','hypervisor'],['CasaOS','192.168.100.110','container host'],['INKAMBILL','192.168.100.111','application'],['PRTG','192.168.100.254','monitoring'],['GenieACS','192.168.100.66','TR-069'],['GenieACS Test','192.168.100.253','TR-069 test']]};

function n(v){return Number(v||0)}
function scoreStatus(latency,loss,status,warning,critical){
  if(status==='down')return 0;
  const l=n(latency),p=n(loss);
  let s=100;
  if(l>critical)s-=45; else if(l>warning)s-=20; else if(l>warning*.6)s-=8;
  if(p>=10)s-=50; else if(p>=5)s-=30; else if(p>=1)s-=12;
  return Math.max(0,Math.min(100,Math.round(s)));
}
async function latestProbes(){
  const [rows]=await db.query(`SELECT s.*,t.name,t.category,t.target,t.warning_ms,t.critical_ms,si.code site_code
    FROM network_probe_samples s
    JOIN network_probe_targets t ON t.id=s.target_id
    LEFT JOIN sites si ON si.id=s.site_id
    JOIN (SELECT target_id,site_id,MAX(id) id FROM network_probe_samples GROUP BY target_id,site_id) x ON x.id=s.id
    WHERE t.is_active=1 ORDER BY t.sort_order,t.name,si.code`).catch(()=>[[]]);
  return rows.map(r=>({...r,score:scoreStatus(r.latency_ms,r.packet_loss,r.status,r.warning_ms,r.critical_ms)}));
}
async function overview(){
  const [snapshots,probeRows,olts]=await Promise.all([poller.routerSnapshots(),latestProbes(),oltDetailRows().catch(()=>[])]);
  const [siteRows]=await db.query(`SELECT s.id,s.code,s.name,
    (SELECT COUNT(*) FROM customers c WHERE c.site_id=s.id AND c.archived_at IS NULL) customers,
    (SELECT COUNT(*) FROM ppp_secrets p WHERE p.site_id=s.id AND p.removed_on_router_at IS NULL AND p.is_online=1 AND p.is_isolated=0) ppp_online,
    (SELECT COUNT(*) FROM ppp_secrets p WHERE p.site_id=s.id AND p.removed_on_router_at IS NULL AND p.is_online=0 AND p.is_isolated=0 AND p.disabled=0) ppp_offline,
    (SELECT COUNT(*) FROM ppp_secrets p WHERE p.site_id=s.id AND p.removed_on_router_at IS NULL AND p.is_isolated=1) isolated
    FROM sites s WHERE s.is_active=1 ORDER BY s.code`).catch(()=>[[]]);
  const [alerts]=await db.query(`SELECT a.*,r.name router_name,s.code site_code FROM nms_alerts a LEFT JOIN routers r ON r.id=a.router_id LEFT JOIN sites s ON s.id=a.site_id WHERE a.resolved_at IS NULL ORDER BY FIELD(a.severity,'critical','warning','info'),a.opened_at DESC LIMIT 30`).catch(()=>[[]]);
  const [events]=await db.query(`SELECT 'infra' source,event_type,severity,title,created_at FROM network_infra_events
    UNION ALL SELECT 'nms',event_type,'info',CONCAT(COALESCE(username,'Network'),' · ',COALESCE(message,event_type)),occurred_at FROM nms_ppp_events
    ORDER BY created_at DESC LIMIT 40`).catch(()=>[[]]);
  const routers=snapshots.map(x=>({...x,rxBps:n(x.wan?.rxBps),txBps:n(x.wan?.txBps)}));
  const bySite={};
  for(const row of siteRows){bySite[row.code]={...row,...SITE_META[row.code],routers:routers.filter(r=>r.siteCode===row.code)};}
  const relevant=routers.filter(r=>['core','distribution','infrastructure'].includes(r.deviceRole||'core'));
  const online=relevant.filter(r=>r.status==='online').length;
  const routerHealth=relevant.length?online/relevant.length*100:100;
  const probeScore=probeRows.length?probeRows.reduce((a,b)=>a+b.score,0)/probeRows.length:100;
  const critical=alerts.filter(a=>a.severity==='critical').length;
  const health=Math.max(0,Math.round(routerHealth*.6+probeScore*.4-critical*8));
  return {
    generatedAt:new Date().toISOString(),health,
    summary:{routersOnline:online,routersTotal:relevant.length,pppOnline:siteRows.reduce((a,b)=>a+n(b.ppp_online),0),customers:siteRows.reduce((a,b)=>a+n(b.customers),0),rxBps:routers.reduce((a,b)=>a+b.rxBps,0),txBps:routers.reduce((a,b)=>a+b.txBps,0),criticalAlerts:critical},
    sites:Object.values(bySite),routers,olts,probes:probeRows,alerts,events,server:SERVER_META
  };
}
async function probeRouter(router,target){
  const started=Date.now();
  try{
    const result=await ros.ping(router,target.target,3);
    const latency=n(result.avgMs ?? result.avg ?? result.time ?? (Date.now()-started));
    const loss=n(result.lossPct ?? result.packetLoss ?? 0);
    const status=loss>=100?'down':(latency>n(target.critical_ms)||loss>=5?'degraded':'up');
    return {status,latencyMs:latency,jitterMs:n(result.jitterMs||0),loss,error:null};
  }catch(err){return {status:'down',latencyMs:null,jitterMs:null,loss:100,error:String(err.message||err).slice(0,500)};}
}
async function runExperienceProbes(){
  const routers=(await store.activeRouters()).filter(r=>Number(r.pppoe_enabled??1)===1);
  const [targets]=await db.query(`SELECT * FROM network_probe_targets WHERE is_active=1 ORDER BY sort_order,id`);
  let saved=0;
  for(const router of routers){
    for(const target of targets){
      const r=await probeRouter(router,target);
      await db.execute(`INSERT INTO network_probe_samples(target_id,site_id,status,latency_ms,jitter_ms,packet_loss,error_message) VALUES(?,?,?,?,?,?,?)`,
        [target.id,router.site_id,r.status,r.latencyMs,r.jitterMs,r.loss,r.error]);
      saved++;
    }
  }
  await db.query(`DELETE FROM network_probe_samples WHERE sampled_at<DATE_SUB(NOW(),INTERVAL 30 DAY)`).catch(()=>{});
  return {routers:routers.length,targets:targets.length,saved};
}
async function probeTargets(){const [rows]=await db.query(`SELECT * FROM network_probe_targets ORDER BY sort_order,id`);return rows;}
module.exports={overview,runExperienceProbes,probeTargets,SITE_META,SERVER_META};