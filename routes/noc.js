const express=require('express');
const db=require('../config/db');
const {oltSummaryRows}=require('../services/oltService');
const {getAlertSettings}=require('../services/networkAlertService');
const router=express.Router();
let summaryCache={expires:0,value:null};
let dashboardCache={expires:0,value:null};

// Aggregates OLT/ONU health the same way the per-router and per-ONT summaries above do, reusing
// the shared oltSummaryRows() so registered and merely-observed (unregistered) OLTs both count.
async function oltAggregate(){
  const rows=await oltSummaryRows();
  const pingable=rows.filter(o=>o.management_ip);
  return {
    total:rows.length,
    onuTotal:rows.reduce((a,o)=>a+o.onu_total,0),
    onuOnline:rows.reduce((a,o)=>a+o.onu_online,0),
    onuOffline:rows.reduce((a,o)=>a+o.onu_offline,0),
    onuCritical:rows.reduce((a,o)=>a+o.onu_critical,0),
    attention:rows.filter(o=>o.onu_offline||o.onu_critical).length,
    unreachable:pingable.filter(o=>o.last_status==='offline').length,
    pingChecked:pingable.length
  };
}

async function compactSummary(){if(summaryCache.value&&summaryCache.expires>Date.now())return summaryCache.value;const [routers,onts,customers,tickets,olts]=await Promise.all([db.query(`SELECT COUNT(*) total,SUM(last_status='online') online,SUM(last_status='offline') offline FROM routers WHERE is_active=1`),db.query(`SELECT COUNT(*) total,SUM(online_status='online') online,SUM(online_status='offline') offline,SUM(signal_status='critical') critical,SUM(signal_status='warning') warning FROM acs_devices`),db.query(`SELECT COUNT(*) total,SUM(network_status='online') online,SUM(network_status='isolated') isolated FROM customers WHERE archived_at IS NULL AND customer_status='active'`),db.query(`SELECT COUNT(*) total,SUM(priority='critical') critical FROM tickets WHERE status IN ('open','progress','pending')`),oltAggregate()]);summaryCache={expires:Date.now()+15000,value:{routers:routers[0][0],onts:onts[0][0],customers:customers[0][0],tickets:tickets[0][0],olts,generatedAt:new Date().toISOString()}};return summaryCache.value;}
router.get('/api/summary',async(req,res,next)=>{try{res.set('Cache-Control','private, max-age=10').json(await compactSummary());}catch(err){next(err);}});

// Full dashboard payload backing both the initial server render and the client-side polling
// (public/js/noc.js) that keeps the KPI cards, per-site table, and alarm list live without a
// manual reload. Cached briefly so several NOC screens polling at once don't each hit the DB.
async function loadDashboard(){
  if(dashboardCache.value&&dashboardCache.expires>Date.now())return dashboardCache.value;
  const [results,olts,alertSettings]=await Promise.all([
    Promise.all([
      db.query(`SELECT COUNT(*) total,SUM(COALESCE(last_status,'never')='online') online,SUM(last_status='offline') offline,SUM(last_status IS NULL) never FROM routers WHERE is_active=1`),
      db.query(`SELECT COUNT(*) total,SUM(online_status='online') online,SUM(online_status='offline') offline,SUM(signal_status='warning') warning,SUM(signal_status='critical') critical FROM acs_devices`),
      db.query(`SELECT COUNT(*) total,SUM(network_status='online') online,SUM(network_status='offline') offline,SUM(network_status='isolated') isolated,SUM(network_status='router_unreachable') unreachable FROM customers WHERE archived_at IS NULL AND customer_status='active'`),
      db.query(`SELECT COUNT(*) total,SUM(priority='critical') critical,SUM(status='open') open_count,SUM(status='progress') progress_count FROM tickets WHERE status IN ('open','progress','pending')`),
      db.query(`SELECT s.id,s.code,s.name,(SELECT COUNT(*) FROM customers c WHERE c.site_id=s.id AND c.archived_at IS NULL AND c.customer_status='active') customers,(SELECT COUNT(*) FROM routers r WHERE r.site_id=s.id AND r.is_active=1) routers,(SELECT COUNT(*) FROM routers r WHERE r.site_id=s.id AND r.is_active=1 AND r.last_status='offline') routers_offline,(SELECT COUNT(*) FROM customer_ont_links l JOIN customers c ON c.id=l.customer_id JOIN acs_devices d ON d.id=l.acs_device_id WHERE c.site_id=s.id AND d.online_status='offline') ont_offline,(SELECT COUNT(*) FROM customer_ont_links l JOIN customers c ON c.id=l.customer_id JOIN acs_devices d ON d.id=l.acs_device_id WHERE c.site_id=s.id AND d.signal_status='critical') ont_critical FROM sites s WHERE s.is_active=1 ORDER BY s.code`),
      db.query(`SELECT * FROM (SELECT 'router' kind,r.id entity_id,r.name title,CONCAT(s.code,' · ',COALESCE(r.last_error,'Router tidak terjangkau')) detail,r.last_seen_at event_at,'danger' tone,s.code site_code FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 AND r.last_status='offline' UNION ALL SELECT 'ont',d.id,COALESCE(c.name,d.serial_number,d.device_id),CONCAT(COALESCE(s.code,'-'),' · ',COALESCE(cl.name,d.odp_name,'ODP belum dipetakan'),' · RX ',COALESCE(d.rx_power,'N/A'),' dBm'),d.last_inform,IF(d.online_status='offline','danger','warning'),s.code FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE d.online_status='offline' OR d.signal_status IN ('critical','warning')) alarm_rows ORDER BY FIELD(tone,'danger','warning'),event_at DESC LIMIT 30`),
      db.query(`SELECT * FROM acs_sync_logs ORDER BY id DESC LIMIT 1`)
    ]),
    oltAggregate(),
    getAlertSettings()
  ]);
  const value={
    routers:results[0][0][0]||{},onts:results[1][0][0]||{},customers:results[2][0][0]||{},tickets:results[3][0][0]||{},
    sites:results[4][0],alarms:results[5][0],lastSync:results[6][0][0]||null,olts,alertSettings,generatedAt:new Date().toISOString()
  };
  dashboardCache={expires:Date.now()+8000,value};
  return value;
}
router.get('/api/dashboard',async(req,res,next)=>{try{res.set('Cache-Control','no-store').json(await loadDashboard());}catch(err){next(err);}});

router.get('/',async(req,res,next)=>{try{
  const data=await loadDashboard();
  res.set('Cache-Control','no-store');
  res.render('noc/index',{title:'NOC Terpadu',...data});
}catch(err){next(err);}});

module.exports=router;
