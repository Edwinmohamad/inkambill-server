const db=require('../config/db');

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
    SELECT COALESCE(o.id,0) id,COALESCE(o.name,d.olt_name) name,o.vendor,o.management_ip,o.pon_port_capacity,o.notes,o.site_id,
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

module.exports={oltSummaryRows};
