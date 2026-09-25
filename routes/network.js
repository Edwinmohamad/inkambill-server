const express = require('express');
const db = require('../config/db');
const { requireAdmin, requireMasterAdmin } = require('../middleware/auth');
const { checkCustomer, isolateCustomer, unisolateCustomer } = require('../services/networkService');
const { audit } = require('../services/auditService');
const { proxyInfrastructure } = require('../services/infrastructureProxy');
const { captureAllNmsTelemetry, getTrafficTrend, getSessionHistory, runRouterBackup, backupAllRouters } = require('../services/nmsTelemetryService');
const router = express.Router();

const INFRA_GROUPS=[
  {key:'server',name:'Server & OS',icon:'bi-server',tools:[
    {key:'proxmox',name:'Proxmox VE',description:'Virtualisasi VM / LXC dan resource server',url:process.env.INFRA_PROXMOX_URL||'https://inkampxmx.edwinpxmx.my.id',icon:'bi-boxes',tone:'orange'},
    {key:'casaos',name:'CasaOS',description:'Workspace aplikasi, storage, dan service host',url:process.env.INFRA_CASAOS_URL||'https://kasaos.edwinpxmx.my.id/',icon:'bi-grid-3x3-gap-fill',tone:'cyan'}
  ]},
  {key:'management',name:'TR-069 & Management',icon:'bi-router-fill',tools:[
    {key:'genieacs',name:'GenieACS Portal',description:'TR-069 provisioning dan management ONT/CPE',url:process.env.INFRA_GENIEACS_URL||'https://geniinkamnet.edwinpxmx.my.id',icon:'bi-broadcast-pin',tone:'green'},
    {key:'webfig',name:'MikroTik WebFig',description:'Panel RouterOS berbasis web',url:process.env.INFRA_MIKROTIK_WEBFIG_URL||'',icon:'bi-router',tone:'purple'},
    {key:'nms',name:'MikroTik NMS',description:'NMS pelanggan dan sinkronisasi PPPoE INKAMNET',internal:'/nms',icon:'bi-activity',tone:'blue'}
  ]},
  {key:'containers',name:'Container Services',icon:'bi-box-seam-fill',tools:[
    {key:'portainer',name:'Portainer / Docker',description:'Management container dan Docker stack',url:process.env.INFRA_PORTAINER_URL||'',icon:'bi-box-seam-fill',tone:'blue'}
  ]}
];
function allInfrastructureTools(){return INFRA_GROUPS.flatMap(group=>group.tools.map(tool=>({...tool,groupKey:group.key,groupName:group.name})));}
function infrastructureTool(key){return allInfrastructureTools().find(tool=>tool.key===String(key||''));}

router.get('/tools',(req,res)=>{
  const groupKey=String(req.query.group||'').trim();
  const requested=String(req.query.tool||'').trim();
  const group=INFRA_GROUPS.find(x=>x.key===groupKey)||INFRA_GROUPS[0];
  const selected=infrastructureTool(requested)||group.tools[0]||allInfrastructureTools()[0];
  const workspaceUrl=selected ? (selected.internal || (selected.url ? `/network/tools/proxy/${selected.key}/` : '')) : '';
  res.render('network/tools',{title:'Infrastructure Hub',groups:INFRA_GROUPS,selected,workspaceUrl});
});

router.use('/tools/proxy/:toolKey',(req,res)=>{
  const tool=infrastructureTool(req.params.toolKey);
  if(!tool||tool.internal)return res.status(404).send('Infrastructure tool tidak ditemukan.');
  if(!tool.url)return res.status(503).send('URL tool belum dikonfigurasi di environment.');
  return proxyInfrastructure(req,res,{targetUrl:tool.url,prefix:`/network/tools/proxy/${tool.key}`});
});

// v2 NMS rebuild: halaman lama /network/monitor + API snapshot/secret CRUD/smart-sync lama
// digantikan modul /nms (routes/nms.js). Redirect dipertahankan agar bookmark lama tetap jalan.
router.get('/monitor',(req,res)=>res.redirect(301,'/nms/secrets'));

// Persisted traffic and session history endpoints. They never call a router
// directly, so charts stay fast even when one device is unreachable.
router.get('/api/traffic', async (req, res) => {
  try {
    const rows = await getTrafficTrend({ routerId: req.query.router_id, interfaceName: req.query.interface, hours: req.query.hours });
    res.set('Cache-Control', 'no-store').json({ ok: true, rows });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.get('/api/session-history', async (req, res) => {
  try {
    const rows = await getSessionHistory({ customerId: req.query.customer_id, routerId: req.query.router_id, hours: req.query.hours });
    res.set('Cache-Control', 'no-store').json({ ok: true, rows });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.post('/api/telemetry/capture', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, result: await captureAllNmsTelemetry() }); }
  catch (error) { res.status(502).json({ ok: false, error: error.message }); }
});

router.post('/api/auto-isolate', requireAdmin, async (req, res) => {
  try {
    if (req.body?.apply !== true && String(req.body?.apply || '') !== '1') return res.json({ ok: true, dryRun: true, message: 'Preview aman. Kirim apply=1 untuk menjalankan isolasi otomatis.' });
    const { runAutoIsolation } = require('../services/networkService');
    const result = await runAutoIsolation();
    await audit({ userId: req.session.user.id, action: 'auto_isolate', entityType: 'network', description: `Auto-isolate: ${result.isolated || 0} berhasil, ${result.failed || 0} gagal`, ip: req.ip });
    res.json({ ok: true, result });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.post('/api/backups', requireMasterAdmin, async (req, res) => {
  try {
    const types = Array.isArray(req.body?.types) ? req.body.types : ['rsc', 'backup'];
    const result = req.body?.router_id ? await runRouterBackup(req.body.router_id, types) : await backupAllRouters(types);
    await audit({ userId: req.session.user.id, action: 'backup', entityType: 'router', description: `Backup NMS dijalankan: ${result.length} job`, ip: req.ip });
    res.json({ ok: true, result });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.get('/api/backups', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT b.*,r.name router_name,s.code site_code FROM nms_router_backups b JOIN routers r ON r.id=b.router_id LEFT JOIN sites s ON s.id=r.site_id WHERE (? IS NULL OR b.router_id=?) ORDER BY b.id DESC LIMIT 200`, [req.query.router_id ? Number(req.query.router_id) : null, req.query.router_id ? Number(req.query.router_id) : null]);
    res.json({ ok: true, rows });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.post('/:customerId/check',async(req,res)=>{
  try{const r=await checkCustomer(req.params.customerId);req.session.flash={type:'success',message:`PPPoE: ${r.status}. Profile: ${r.secret?.profile||'-'}${r.active?` · IP ${r.active.address||'-'} · uptime ${r.active.uptime||'-'}`:''}`};}
  catch(e){req.session.flash={type:'danger',message:`Cek PPPoE gagal: ${e.message}`};}
  res.redirect(`/customers/${req.params.customerId}`);
});
// v1.20.1: requireAdmin added — isolate/unisolate directly cuts/restores a customer's internet
// service, and every other mutating route in this file (secrets, smart-sync) already requires
// full Admin on top of the 'network' permission gate applied at the /network mount in app.js. If this
// turns out to be too strict for day-to-day NOC staff who only hold 'network' permission, tell me and
// I'll relax it back (or introduce a narrower permission) instead of leaving the inconsistency in place.
router.post('/:customerId/isolate',requireAdmin,async(req,res)=>{
  try{await isolateCustomer(req.params.customerId,'manual');await audit({userId:req.session.user.id,action:'isolate',entityType:'customer',entityId:req.params.customerId,description:'Manual isolate PPPoE',ip:req.ip});req.session.flash={type:'success',message:'Pelanggan berhasil diisolir dan sesi aktif diputus.'};}
  catch(e){req.session.flash={type:'danger',message:`Isolir gagal: ${e.message}`};}
  res.redirect(`/customers/${req.params.customerId}`);
});
router.post('/:customerId/unisolate',requireAdmin,async(req,res)=>{
  try{await unisolateCustomer(req.params.customerId,false);await audit({userId:req.session.user.id,action:'unisolate',entityType:'customer',entityId:req.params.customerId,description:'Manual unisolate PPPoE',ip:req.ip});req.session.flash={type:'success',message:'Isolir dibuka. PPPoE secret sudah aktif.'};}
  catch(e){req.session.flash={type:'danger',message:`Buka isolir gagal: ${e.message}`};}
  res.redirect(`/customers/${req.params.customerId}`);
});

module.exports=router;
