const express=require('express');
const db=require('../config/db');
const {paginate}=require('../utils/pagination');
const router=express.Router();
router.get('/',async(req,res)=>{
  const q=String(req.query.q||'').trim();
  // v1.25.5 (susulan #13) — filter Tanggal, Aksi (audit) & Status (automation), agar mudah menyisir log
  // yang sudah 250 baris per tab. Rentang tanggal & q berlaku untuk KEDUA tab (audit + automation)
  // karena keduanya sama-sama punya created_at; action hanya relevan untuk tab Aktivitas Pengguna,
  // status hanya relevan untuk tab Automation — masing-masing diabaikan begitu saja pada tab yang lain.
  const dateFrom=/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from||'')?req.query.date_from:'';
  const dateTo=/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to||'')?req.query.date_to:'';
  const action=String(req.query.action||'').trim();
  const status=['success','failed'].includes(req.query.status)?req.query.status:'';

  const params=[];
  let auditWhere='1=1';
  if(q){const like=`%${q}%`;auditWhere+=' AND (a.action LIKE ? OR a.entity_type LIKE ? OR a.description LIKE ? OR u.name LIKE ? OR a.ip_address LIKE ?)';params.push(like,like,like,like,like);}
  if(dateFrom){auditWhere+=' AND DATE(a.created_at)>=?';params.push(dateFrom);}
  if(dateTo){auditWhere+=' AND DATE(a.created_at)<=?';params.push(dateTo);}
  if(action){auditWhere+=' AND a.action=?';params.push(action);}
  const auditPage=await paginate(db,`SELECT a.*,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ${auditWhere} ORDER BY a.id DESC`,params,req,50);const audit=auditPage.rows;res.locals.pagination=auditPage.pagination;

  const automationParams=[];let automationWhere='1=1';
  if(q){const like=`%${q}%`;automationWhere+=' AND (job_name LIKE ? OR status LIKE ? OR message LIKE ?)';automationParams.push(like,like,like);}
  if(dateFrom){automationWhere+=' AND DATE(created_at)>=?';automationParams.push(dateFrom);}
  if(dateTo){automationWhere+=' AND DATE(created_at)<=?';automationParams.push(dateTo);}
  if(status){automationWhere+=' AND status=?';automationParams.push(status);}
  const [automation]=await db.execute(`SELECT * FROM automation_logs WHERE ${automationWhere} ORDER BY id DESC LIMIT 250`,automationParams);

  const crashParams=[];let crashWhere='1=1';
  if(q){const like=`%${q}%`;crashWhere+=' AND (m.exception_class LIKE ? OR m.message LIKE ? OR m.device_model LIKE ? OR u.name LIKE ?)';crashParams.push(like,like,like,like);}
  if(dateFrom){crashWhere+=' AND DATE(m.created_at)>=?';crashParams.push(dateFrom);}
  if(dateTo){crashWhere+=' AND DATE(m.created_at)<=?';crashParams.push(dateTo);}
  const [mobileCrashes]=await db.execute(`SELECT m.*,u.name user_name FROM mobile_crash_reports m LEFT JOIN users u ON u.id=m.user_id WHERE ${crashWhere} ORDER BY m.id DESC LIMIT 150`,crashParams);

  const [actionRows]=await db.execute(`SELECT DISTINCT action FROM audit_logs WHERE action IS NOT NULL AND action<>'' ORDER BY action`);
  const actions=actionRows.map(r=>r.action);

  const summary={audit:audit.length,automation:automation.length,failed:automation.filter(x=>x.status==='failed').length,success:automation.filter(x=>x.status==='success').length,mobileCrashes:mobileCrashes.length};
  res.render('logs/index',{title:'Log Aktivitas',audit,automation,mobileCrashes,summary,q,actions,filters:{date_from:dateFrom,date_to:dateTo,action,status}});
});
module.exports=router;
