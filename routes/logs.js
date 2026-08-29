const express=require('express');
const db=require('../config/db');
const router=express.Router();
router.get('/',async(req,res)=>{
  const q=String(req.query.q||'').trim();
  const params=[];
  let auditWhere='1=1';
  if(q){const like=`%${q}%`;auditWhere+=' AND (a.action LIKE ? OR a.entity_type LIKE ? OR a.description LIKE ? OR u.name LIKE ? OR a.ip_address LIKE ?)';params.push(like,like,like,like,like);}
  const [audit]=await db.execute(`SELECT a.*,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ${auditWhere} ORDER BY a.id DESC LIMIT 250`,params);
  const automationParams=[];let automationWhere='1=1';
  if(q){const like=`%${q}%`;automationWhere+=' AND (job_name LIKE ? OR status LIKE ? OR message LIKE ?)';automationParams.push(like,like,like);}
  const [automation]=await db.execute(`SELECT * FROM automation_logs WHERE ${automationWhere} ORDER BY id DESC LIMIT 250`,automationParams);
  const summary={audit:audit.length,automation:automation.length,failed:automation.filter(x=>x.status==='failed').length,success:automation.filter(x=>x.status==='success').length};
  res.render('logs/index',{title:'Log Aktivitas',audit,automation,summary,q});
});
module.exports=router;
