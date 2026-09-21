const db=require('../config/db');
const {pingHost}=require('./acsService');

// Real ONU/PON-port utilization derived from acs_devices.olt_name/pon_port metadata that
// operators already maintain per ONT -- no vendor SNMP access required. OLT names that show
// up on ONT records but have not yet been registered in olt_devices still appear here (with
// a default 64-port capacity) so nothing observed in the field is hidden pending registration.
// Shared by routes/olt.js (registry page) and routes/monitoring.js (Bento OLT board).
// siteCode (optional): scope to one site. An OLT explicitly registered to that site returns all
// of its ONUs (an OLT chassis normally serves one location); otherwise ONUs are scoped by their
// linked customer's site.
async function oltSummaryRows(siteCode){
  const params=[];
  let extraJoin='';
  let extraWhere='';
  if(siteCode){
    extraJoin=` LEFT JOIN customer_ont_links l2 ON l2.acs_device_id=d.id LEFT JOIN customers c2 ON c2.id=l2.customer_id LEFT JOIN sites s2 ON s2.id=c2.site_id`;
    extraWhere=` AND (s2.code=? OR (o.site_id IS NOT NULL AND o.site_id IN (SELECT id FROM sites WHERE code=?)))`;
    params.push(siteCode,siteCode);
  }
  const [rows]=await db.query(`
    SELECT COALESCE(o.id,0) id,COALESCE(o.name,d.olt_name) name,o.vendor,o.management_ip,o.pon_port_capacity,o.notes,o.site_id,o.last_status,o.last_error,o.last_seen_at,
      COUNT(d.id) onu_total,SUM(d.online_status='online') onu_online,SUM(d.online_status='offline') onu_offline,
      SUM(d.signal_status='warning') onu_warning,SUM(d.signal_status='critical') onu_critical,
      COUNT(DISTINCT d.pon_port) pon_ports_used,AVG(d.rx_power) avg_rx,
      SUM(d.pon_port IS NULL OR d.pon_port='') onu_no_port
    FROM acs_devices d
    LEFT JOIN olt_devices o ON o.name=d.olt_name
    ${extraJoin}
    WHERE d.olt_name IS NOT NULL AND d.olt_name<>''${extraWhere}
    GROUP BY COALESCE(o.id,0),COALESCE(o.name,d.olt_name),o.vendor,o.management_ip,o.pon_port_capacity,o.notes,o.site_id
    ORDER BY onu_critical DESC,onu_offline DESC,name`, params);
  const regParams=siteCode?[siteCode]:[];
  const [registeredOnly]=await db.query(`SELECT o.*,0 onu_total,0 onu_online,0 onu_offline,0 onu_warning,0 onu_critical,0 pon_ports_used,NULL avg_rx,0 onu_no_port FROM olt_devices o WHERE NOT EXISTS(SELECT 1 FROM acs_devices d WHERE d.olt_name=o.name)${siteCode?` AND o.site_id IN (SELECT id FROM sites WHERE code=?)`:''}`, regParams);
  return [...rows,...registeredOnly].map(r=>({...r,pon_port_capacity:Number(r.pon_port_capacity)||64,onu_total:Number(r.onu_total||0),onu_online:Number(r.onu_online||0),onu_offline:Number(r.onu_offline||0),onu_warning:Number(r.onu_warning||0),onu_critical:Number(r.onu_critical||0),pon_ports_used:Number(r.pon_ports_used||0),onu_no_port:Number(r.onu_no_port||0),avg_rx:r.avg_rx===null?null:Math.round(Number(r.avg_rx)*100)/100,is_registered:!!r.id}));
}

// Pings every registered OLT's management_ip (reused straight from acsService's pingHost,
// same ICMP mechanism already used for ONT ping) and records last_status/last_error/last_seen_at
// -- mirrors the routers.last_status pattern. Registered OLTs with no management_ip are left
// untouched (nothing to ping); OLTs only inferred from ONT telemetry (never registered) aren't
// pinged either, since there is no management_ip on file for them yet.
async function pingAllOlts(){
  const [olts]=await db.query(`SELECT id,name,management_ip FROM olt_devices WHERE management_ip IS NOT NULL AND management_ip<>''`);
  let online=0,offline=0;
  for(const olt of olts){
    try{
      const result=await pingHost(olt.management_ip);
      if(result.reachable){
        await db.execute(`UPDATE olt_devices SET last_status='online',last_error=NULL,last_seen_at=NOW() WHERE id=?`,[olt.id]);
        online++;
      }else{
        await db.execute(`UPDATE olt_devices SET last_status='offline',last_error=?,last_seen_at=NOW() WHERE id=?`,[`Ping timeout (loss ${result.lossPercent??'?'}%)`,olt.id]);
        offline++;
      }
    }catch(err){
      await db.execute(`UPDATE olt_devices SET last_status='offline',last_error=?,last_seen_at=NOW() WHERE id=?`,[err.message.slice(0,500),olt.id]).catch(()=>{});
      offline++;
    }
  }
  return {checked:olts.length,online,offline};
}

module.exports={oltSummaryRows,pingAllOlts};
