'use strict';

const express=require('express');
const {requireMasterAdmin}=require('../middleware/auth');
const {audit}=require('../services/auditService');
const performance=require('../services/operationalPerformanceService');
const execution=require('../services/performanceExecutionService');
const customerGrowth=require('../services/customerGrowthAnalysisService');
const retention=require('../services/customerRetentionService');
const router=express.Router();

const back=req=>`/performance?year=${encodeURIComponent(req.body.year||req.query.year||'')}&month=${encodeURIComponent(req.body.month||req.query.month||'')}${(req.body.site||req.query.site)?`&site=${encodeURIComponent(req.body.site||req.query.site)}`:''}`;

router.get('/',async(req,res)=>{
  await Promise.all([performance.ensurePerformanceSchema(),execution.ensureExecutionSchema(),customerGrowth.ensureGrowthSchema(),retention.ensureRetentionSchema()]);
  const data=await performance.getPerformance({year:req.query.year,month:req.query.month,siteCode:req.query.site});
  const [snapshots,exec,growthAnalysis,retentionAnalysis]=await Promise.all([
    performance.getSnapshots(12),
    execution.dashboard(data),
    customerGrowth.analyze({year:data.range.year,month:data.range.month,selectedSiteCode:data.site?.code||''}),
    retention.analyze({year:data.range.year,month:data.range.month,siteId:data.site?.id||null})
  ]);
  res.render('performance/index',{title:'Operational Performance',...data,...exec,growthAnalysis,retentionAnalysis,retentionReasons:retention.REASONS,snapshots});
});

router.get('/api',async(req,res)=>{
  const data=await performance.getPerformance({year:req.query.year,month:req.query.month,siteCode:req.query.site});
  const [exec,growthAnalysis,retentionAnalysis]=await Promise.all([
    execution.dashboard(data),
    customerGrowth.analyze({year:data.range.year,month:data.range.month,selectedSiteCode:data.site?.code||''}),
    retention.analyze({year:data.range.year,month:data.range.month,siteId:data.site?.id||null})
  ]);
  res.set('Cache-Control','no-store').json({ok:true,data:{...data,...exec,growthAnalysis,retentionAnalysis}});
});

router.post('/snapshot',requireMasterAdmin,async(req,res)=>{
  const data=await performance.saveSnapshot({year:req.body.year,month:req.body.month,siteCode:req.body.site,userId:req.session.user.id});
  await audit({userId:req.session.user.id,action:'snapshot',entityType:'operational_performance',entityId:null,description:`Snapshot Performance ${data.range.month}/${data.range.year}${data.site?` · ${data.site.code}`:''}`,ip:req.ip});
  req.session.flash={type:'success',message:`Snapshot Performance ${data.range.month}/${data.range.year} tersimpan.`};
  res.redirect(back(req));
});
router.post('/targets',requireMasterAdmin,async(req,res)=>{
  await performance.saveTargets(req.body,req.session.user.id);
  await audit({userId:req.session.user.id,action:'update',entityType:'performance_target',entityId:null,description:'Update target KPI Performance Center',ip:req.ip});
  req.session.flash={type:'success',message:'Target KPI Performance Center diperbarui.'};res.redirect(back(req));
});

router.post('/goals',requireMasterAdmin,async(req,res)=>{
  try{await execution.addGoal(req.body,req.session.user.id);await audit({userId:req.session.user.id,action:'create',entityType:'performance_goal',entityId:null,description:`Goal: ${String(req.body.title||'').slice(0,180)}`,ip:req.ip});req.session.flash={type:'success',message:'Goal ditambahkan.'};}
  catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#goals');
});
router.post('/goals/:id',requireMasterAdmin,async(req,res)=>{
  try{await execution.updateGoal(req.params.id,req.body);await audit({userId:req.session.user.id,action:'update',entityType:'performance_goal',entityId:req.params.id,description:'Update progress goal',ip:req.ip});req.session.flash={type:'success',message:'Goal diperbarui.'};}
  catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#goals');
});

router.post('/actions',async(req,res)=>{
  try{const id=await execution.addAction(req.body,req.session.user.id);await audit({userId:req.session.user.id,action:'create',entityType:'performance_action',entityId:id,description:`Action: ${String(req.body.title||'').slice(0,180)}`,ip:req.ip});req.session.flash={type:'success',message:'Action ditambahkan dan masuk Execution Queue.'};}
  catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#execution');
});
router.post('/actions/:id',async(req,res)=>{
  try{await execution.updateAction(req.params.id,req.body,req.session.user.id);await audit({userId:req.session.user.id,action:'update',entityType:'performance_action',entityId:req.params.id,description:`Action status → ${req.body.status||'-'}`,ip:req.ip});req.session.flash={type:'success',message:'Action diperbarui.'};}
  catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#execution');
});

router.post('/blocks',async(req,res)=>{
  try{await execution.addBlock(req.body,req.session.user.id);await audit({userId:req.session.user.id,action:'block',entityType:'performance_work',entityId:null,description:`Blocked: ${String(req.body.title||'').slice(0,180)}`,ip:req.ip});req.session.flash={type:'success',message:'Blocked work dicatat.'};}
  catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#blocked');
});
router.post('/blocks/:id/resolve',async(req,res)=>{
  await execution.resolveBlock(req.params.id,req.session.user.id);
  await audit({userId:req.session.user.id,action:'resolve_block',entityType:'performance_work',entityId:req.params.id,description:'Blocked work resolved',ip:req.ip});
  req.session.flash={type:'success',message:'Block ditandai selesai.'};res.redirect(back(req)+'#blocked');
});

router.post('/decisions',requireMasterAdmin,async(req,res)=>{
  try{await execution.addDecision(req.body,req.session.user.id);await audit({userId:req.session.user.id,action:'create',entityType:'performance_decision',entityId:null,description:`Decision: ${String(req.body.title||'').slice(0,180)}`,ip:req.ip});req.session.flash={type:'success',message:'Decision log ditambahkan.'};}
  catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#decisions');
});
router.post('/decisions/:id',requireMasterAdmin,async(req,res)=>{
  await execution.updateDecision(req.params.id,req.body);
  await audit({userId:req.session.user.id,action:'update',entityType:'performance_decision',entityId:req.params.id,description:'Update decision result',ip:req.ip});
  req.session.flash={type:'success',message:'Decision log diperbarui.'};res.redirect(back(req)+'#decisions');
});

module.exports=router;


router.get('/customer/:id/lifecycle',async(req,res)=>{
  const data=await retention.timeline(req.params.id);
  if(!data)return res.status(404).json({ok:false,error:'Pelanggan tidak ditemukan.'});
  res.set('Cache-Control','no-store').json({ok:true,data});
});

router.post('/retention/reason',async(req,res)=>{
  try{
    await retention.saveReason({
      customerId:Number(req.body.customer_id),eventType:req.body.event_type,reasonCode:req.body.reason_code,
      reasonText:String(req.body.reason_text||'').trim(),eventAt:req.body.event_at,userId:req.session.user.id
    });
    await audit({userId:req.session.user.id,action:'retention_reason',entityType:'customer',entityId:req.body.customer_id,description:`Retention reason ${req.body.reason_code||'-'}`,ip:req.ip});
    req.session.flash={type:'success',message:'Alasan churn/off tersimpan.'};
  }catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#retention');
});

router.post('/retention/action',async(req,res)=>{
  try{
    const id=await retention.createRetentionAction({
      customerId:Number(req.body.customer_id),ownerUserId:Number(req.body.owner_user_id)||null,dueAt:req.body.due_at||null,
      note:String(req.body.note||'').trim(),userId:req.session.user.id
    });
    await audit({userId:req.session.user.id,action:'create',entityType:'retention_action',entityId:id,description:`Retention action customer ${req.body.customer_id}`,ip:req.ip});
    req.session.flash={type:'success',message:'Pelanggan masuk Retention Action Queue.'};
  }catch(e){req.session.flash={type:'danger',message:e.message};}
  res.redirect(back(req)+'#retention');
});
