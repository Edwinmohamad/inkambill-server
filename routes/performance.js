'use strict';

const express=require('express');
const {requireMasterAdmin}=require('../middleware/auth');
const {audit}=require('../services/auditService');
const performance=require('../services/operationalPerformanceService');
const router=express.Router();

router.get('/',async(req,res)=>{
  await performance.ensurePerformanceSchema();
  const data=await performance.getPerformance({year:req.query.year,month:req.query.month,siteCode:req.query.site});
  const snapshots=await performance.getSnapshots(12);
  res.render('performance/index',{title:'Operational Performance',...data,snapshots});
});

router.get('/api',async(req,res)=>{
  const data=await performance.getPerformance({year:req.query.year,month:req.query.month,siteCode:req.query.site});
  res.set('Cache-Control','no-store').json({ok:true,data});
});

router.post('/snapshot',requireMasterAdmin,async(req,res)=>{
  const data=await performance.saveSnapshot({year:req.body.year,month:req.body.month,siteCode:req.body.site,userId:req.session.user.id});
  await audit({userId:req.session.user.id,action:'snapshot',entityType:'operational_performance',entityId:null,description:`Snapshot Performance ${data.range.month}/${data.range.year}${data.site?` · ${data.site.code}`:''}`,ip:req.ip});
  req.session.flash={type:'success',message:`Snapshot Performance ${data.range.month}/${data.range.year} tersimpan.`};
  res.redirect(`/performance?year=${data.range.year}&month=${data.range.month}${data.site?`&site=${encodeURIComponent(data.site.code)}`:''}`);
});

router.post('/targets',requireMasterAdmin,async(req,res)=>{
  await performance.saveTargets(req.body,req.session.user.id);
  await audit({userId:req.session.user.id,action:'update',entityType:'performance_target',entityId:null,description:'Update target KPI Performance Center',ip:req.ip});
  req.session.flash={type:'success',message:'Target KPI Performance Center diperbarui.'};
  res.redirect(`/performance?year=${encodeURIComponent(req.body.year||'')}&month=${encodeURIComponent(req.body.month||'')}${req.body.scope_type==='SITE'&&req.body.scope_value?`&site=${encodeURIComponent(req.body.scope_value)}`:''}`);
});

module.exports=router;
