const express = require('express');
const db = require('../config/db');
const { requireAdmin } = require('../middleware/auth');
const { checkCustomer, isolateCustomer, unisolateCustomer } = require('../services/networkService');
const { allSnapshots, saveSecret, syncSecret, removeSecret, disconnectSecret, customersForRouter, customersForSync, smartSyncPlan, applySmartSync } = require('../services/nmsService');
const { audit } = require('../services/auditService');
const { proxyInfrastructure } = require('../services/infrastructureProxy');
const router = express.Router();

const INFRA_GROUPS=[
  {key:'server',name:'Server & OS',icon:'bi-server',tools:[
    {key:'proxmox',name:'Proxmox VE',description:'Virtualisasi VM / LXC dan resource server',url:process.env.INFRA_PROXMOX_URL||'https://inkampxmx.edwinpxmx.my.id',icon:'bi-boxes',tone:'orange'},
    {key:'casaos',name:'CasaOS',description:'Workspace aplikasi, storage, dan service host',url:process.env.INFRA_CASAOS_URL||'https://kasaos.edwinpxmx.my.id/',icon:'bi-grid-3x3-gap-fill',tone:'cyan'}
  ]},
  {key:'management',name:'TR-069 & Management',icon:'bi-router-fill',tools:[
    {key:'genieacs',name:'GenieACS Portal',description:'TR-069 provisioning dan management ONT/CPE',url:process.env.INFRA_GENIEACS_URL||'https://geniinkamnet.edwinpxmx.my.id',icon:'bi-broadcast-pin',tone:'green'},
    {key:'webfig',name:'MikroTik WebFig',description:'Panel RouterOS berbasis web',url:process.env.INFRA_MIKROTIK_WEBFIG_URL||'',icon:'bi-router',tone:'purple'},
    {key:'nms',name:'MikroTik NMS',description:'NMS pelanggan dan sinkronisasi PPPoE INKAMNET',internal:'/network/monitor',icon:'bi-activity',tone:'blue'}
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

router.get('/monitor', async (req,res) => {
  const [routers] = await db.query(`SELECT r.id,r.name,r.last_status,r.last_seen_at,r.last_error,s.code site_code,s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 ORDER BY s.code,r.name`);
  const [sites] = await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('network/monitor',{title:'NMS MikroTik',routers,sites});
});

router.get('/api/snapshot', async (req,res) => {
  try { res.set('Cache-Control','no-store').json({ok:true,generatedAt:new Date().toISOString(),snapshots:await allSnapshots()}); }
  catch (error) { res.status(502).json({ok:false,error:error.message}); }
});

router.get('/api/routers/:routerId/customers', requireAdmin, async (req,res) => {
  try { res.json({ok:true,customers:await customersForRouter(req.params.routerId)}); }
  catch (error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets', requireAdmin, async (req,res) => {
  try {
    const result = await saveSecret(req.body.router_id,null,req.body,req.body.customer_id||null);
    await audit({userId:req.session.user.id,action:'create',entityType:'pppoe_secret',entityId:null,description:`Tambah PPPoE ${result.payload.name} di ${result.router.name}`,ip:req.ip});
    res.json({ok:true,message:'PPPoE secret berhasil ditambahkan dan integrasi pelanggan diperbarui.'});
  } catch (error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets/:secretId', requireAdmin, async (req,res) => {
  try {
    const result = await saveSecret(req.body.router_id,req.params.secretId,req.body,req.body.customer_id||null);
    await audit({userId:req.session.user.id,action:'update',entityType:'pppoe_secret',entityId:req.params.secretId,description:`Ubah PPPoE ${result.payload.name} di ${result.router.name}`,ip:req.ip});
    res.json({ok:true,message:'PPPoE secret berhasil diperbarui.'});
  } catch (error) { res.status(400).json({ok:false,error:error.message}); }
});

router.get('/api/sync-customers', requireAdmin, async (req,res) => {
  try { res.set('Cache-Control','no-store').json({ok:true,customers:await customersForSync()}); }
  catch (error) { res.status(400).json({ok:false,error:error.message}); }
});

router.get('/api/smart-sync-plan', requireAdmin, async (req,res) => {
  try { res.set('Cache-Control','no-store').json({ok:true,plan:await smartSyncPlan(req.query.site_code||'')}); }
  catch(error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/smart-sync', requireAdmin, async (req,res) => {
  try {
    const result=await applySmartSync(req.body.site_code||'');
    await audit({userId:req.session.user.id,action:'smart_sync',entityType:'pppoe_reconciliation',entityId:null,description:`Smart Sync PPPoE ${result.scope}: ${result.succeeded}/${result.processed} berhasil, ${result.failed} gagal`,ip:req.ip});
    res.json({ok:true,result,message:result.processed?`Smart Sync selesai: ${result.succeeded} berhasil${result.failed?`, ${result.failed} gagal`:''}.`:'Tidak ada kandidat high-confidence yang aman untuk disinkronkan.'});
  } catch(error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets/:secretId/sync', requireAdmin, async (req,res) => {
  try {
    const result=await syncSecret(req.body.router_id,req.params.secretId,req.body.customer_id);
    await audit({userId:req.session.user.id,action:'sync',entityType:'pppoe_secret',entityId:req.params.secretId,description:`Sinkron ${result.secret.name} ke ${result.customer.customer_code} - ${result.customer.name}`,ip:req.ip});
    res.json({ok:true,message:`${result.secret.name} berhasil disinkronkan ke ${result.customer.name}.`});
  } catch(error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets/:secretId/delete', requireAdmin, async (req,res) => {
  try {
    const result=await removeSecret(req.body.router_id,req.params.secretId);
    await audit({userId:req.session.user.id,action:'delete',entityType:'pppoe_secret',entityId:req.params.secretId,description:`Hapus PPPoE ${result.secret.name} dari ${result.router.name}; unlink=${result.linkedCustomers.length}`,ip:req.ip});
    res.json({ok:true,message:`Secret ${result.secret.name} dihapus${result.disconnected?' dan sesi aktif diputus':''}. ${result.linkedCustomers.length} link billing dilepas.`});
  } catch(error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets/:secretId/disconnect', requireAdmin, async (req,res) => {
  try {
    const result=await disconnectSecret(req.body.router_id,req.params.secretId);
    await audit({userId:req.session.user.id,action:'disconnect',entityType:'pppoe_session',entityId:req.params.secretId,description:`Putus sesi PPPoE ${result.secret.name} dari ${result.router.name}; secret dipertahankan`,ip:req.ip});
    res.json({ok:true,message:result.disconnected?`Koneksi ${result.secret.name} diputus. Akun PPPoE tetap tersimpan.`:`${result.secret.name} tidak memiliki sesi aktif. Akun PPPoE tetap tersimpan.`});
  } catch(error) { res.status(400).json({ok:false,error:error.message}); }
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
