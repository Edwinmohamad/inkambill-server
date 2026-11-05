// Billing-only compatibility routes: PPPoE mapping and customer service actions.
const express=require('express');
const db=require('../config/db');
const {requireAdmin}=require('../middleware/auth');
const {checkCustomer,isolateCustomer,unisolateCustomer}=require('../services/networkService');
const {saveSecret,syncSecret,removeSecret,disconnectSecret,customersForRouter,customersForSync,smartSyncPlan,applySmartSync}=require('../services/nmsService');
const {audit}=require('../services/auditService');
const router=express.Router();
router.get(['/', '/monitor', '/subscribers', '/infrastructure', '/infrastructure/detail', '/infrastructure/wall', '/access', '/devices', '/tools'],async(req,res,next)=>{
  try {
    const params=new URLSearchParams();const scope=String(req.query.site||'').trim();
    if(/^\d+$/.test(scope))params.set('site',scope);
    else if(scope){const [[site]]=await db.query('SELECT id FROM sites WHERE code=? AND is_active=1 LIMIT 1',[scope]);if(site)params.set('site',String(site.id));}
    res.redirect('/nms/secrets'+(params.size?'?'+params.toString():''));
  }catch(error){next(error);}
});
router.get('/incidents',(req,res)=>res.redirect('/nms/insights'));
router.get('/api/routers/:routerId/customers', requireAdmin, async (req,res) => {
  try { res.json({ok:true,customers:await customersForRouter(req.params.routerId)}); }
  catch (error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets', requireAdmin, async (req,res) => {
  try {
    const result = await saveSecret(req.body.router_id,null,req.body,req.body.customer_id||null,{userId:req.session.user.id});
    await audit({userId:req.session.user.id,action:'create',entityType:'pppoe_secret',entityId:null,description:`Tambah PPPoE ${result.payload.name} di ${result.router.name}`,ip:req.ip});
    res.json({ok:true,message:'PPPoE secret berhasil ditambahkan dan integrasi pelanggan diperbarui.'});
  } catch (error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets/:secretId', requireAdmin, async (req,res) => {
  try {
    const result = await saveSecret(req.body.router_id,req.params.secretId,req.body,req.body.customer_id||null,{userId:req.session.user.id});
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

router.get('/api/sync-history', requireAdmin, async (req,res) => {
  try {
    const limit=Math.max(1,Math.min(200,Number(req.query.limit||50)));
    const [rows]=await db.execute(`SELECT l.*,c.customer_code,c.name customer_name,r.name router_name,s.code site_code
      FROM pppoe_sync_logs l JOIN customers c ON c.id=l.customer_id LEFT JOIN routers r ON r.id=l.router_id LEFT JOIN sites s ON s.id=c.site_id
      ORDER BY l.id DESC LIMIT ${limit}`);
    res.set('Cache-Control','no-store').json({ok:true,rows});
  } catch(error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/smart-sync', requireAdmin, async (req,res) => {
  try {
    const result=await applySmartSync(req.body.site_code||'',{userId:req.session.user.id});
    await audit({userId:req.session.user.id,action:'smart_sync',entityType:'pppoe_reconciliation',entityId:null,description:`Smart Sync PPPoE ${result.scope}: ${result.succeeded}/${result.processed} berhasil, ${result.failed} gagal`,ip:req.ip});
    res.json({ok:true,result,message:result.processed?`Smart Sync selesai: ${result.succeeded} berhasil${result.failed?`, ${result.failed} gagal`:''}.`:'Tidak ada kandidat high-confidence yang aman untuk disinkronkan.'});
  } catch(error) { res.status(400).json({ok:false,error:error.message}); }
});

router.post('/secrets/:secretId/sync', requireAdmin, async (req,res) => {
  try {
    const result=await syncSecret(req.body.router_id,req.params.secretId,req.body.customer_id,{source:'manual',userId:req.session.user.id});
    await audit({userId:req.session.user.id,action:'sync',entityType:'pppoe_secret',entityId:req.params.secretId,description:`Sinkron ${result.secret.name} ke ${result.customer.customer_code} - ${result.customer.name}`,ip:req.ip});
    res.json({ok:true,persisted:true,savedAt:result.persisted.pppoe_synced_at,message:`${result.secret.name} berhasil disinkronkan dan tersimpan ke ${result.customer.name}.`});
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

router.use('/api',(req,res)=>res.status(410).json({ok:false,error:'Endpoint monitoring sudah dihentikan.'}));
module.exports=router;
