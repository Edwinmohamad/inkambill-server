const express = require('express');
const db = require('../config/db');
const { createActivity, addActivityUpdate, addMember } = require('../services/operationsActivityService');
const { setStage, addSupervisorNote } = require('../services/ticketSupervisorService');
const router = express.Router();

const TYPES = ['incident','psb','installation','maintenance','migration','survey','followup','other'];
const STATUSES = ['planned','in_progress','done','cancelled'];
const STAGES = ['OPEN','ASSIGNED','OTW','ON_SITE','WORKING','RESOLVED','VERIFIED','CLOSED'];

function n(v){ const x=Number(v); return Number.isFinite(x)&&x>0?x:null; }
function cleanDate(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):''; }

router.get('/', async (req,res,next)=>{
  try{
    const now=new Date();
    const filters={
      month: Math.min(12,Math.max(1,Number(req.query.month)||now.getMonth()+1)),
      year: Math.min(2100,Math.max(2020,Number(req.query.year)||now.getFullYear())),
      site:String(req.query.site||'').trim(), type:String(req.query.type||'').trim(), status:String(req.query.status||'').trim(),
      pic:n(req.query.pic), q:String(req.query.q||'').trim(), stage:String(req.query.stage||'').trim().toUpperCase()
    };
    const start=`${filters.year}-${String(filters.month).padStart(2,'0')}-01`;
    const lastDay=new Date(filters.year,filters.month,0).getDate();
    const end=`${filters.year}-${String(filters.month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const aParams=[start,end];
    let aWhere=`DATE(a.created_at) BETWEEN ? AND ?`;
    if(filters.site){aWhere+=` AND s.code=?`;aParams.push(filters.site);}
    if(filters.type && TYPES.includes(filters.type)){aWhere+=` AND a.activity_type=?`;aParams.push(filters.type);}
    if(filters.status && STATUSES.includes(filters.status)){aWhere+=` AND a.status=?`;aParams.push(filters.status);}
    if(filters.pic){aWhere+=` AND a.primary_employee_id=?`;aParams.push(filters.pic);}
    if(filters.q){const like=`%${filters.q}%`;aWhere+=` AND (a.activity_code LIKE ? OR a.title LIKE ? OR a.description LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ? OR e.name LIKE ?)`;aParams.push(like,like,like,like,like,like);}
    const [activities]=await db.execute(`SELECT a.*,s.code site_code,c.customer_code,c.name customer_name,e.name pic_name,t.ticket_code,
      TIMESTAMPDIFF(MINUTE,COALESCE(a.started_at,a.created_at),COALESCE(a.completed_at,NOW())) duration_minutes
      FROM operations_activities a LEFT JOIN sites s ON s.id=a.site_id LEFT JOIN customers c ON c.id=a.customer_id
      LEFT JOIN employees e ON e.id=a.primary_employee_id LEFT JOIN tickets t ON t.id=a.ticket_id
      WHERE ${aWhere} ORDER BY FIELD(a.status,'in_progress','planned','done','cancelled'),a.updated_at DESC LIMIT 500`,aParams);

    const tParams=[]; let tWhere=`t.status<>'closed'`;
    if(filters.site){tWhere+=` AND s.code=?`;tParams.push(filters.site);}
    if(filters.pic){tWhere+=` AND t.assigned_employee_id=?`;tParams.push(filters.pic);}
    if(filters.stage && STAGES.includes(filters.stage)){tWhere+=` AND COALESCE(ss.stage,CASE WHEN t.status='pending' THEN 'RESOLVED' WHEN t.status='progress' THEN 'WORKING' WHEN t.assigned_employee_id IS NOT NULL THEN 'ASSIGNED' ELSE 'OPEN' END)=?`;tParams.push(filters.stage);}
    const [tickets]=await db.execute(`SELECT t.id,t.ticket_code,t.subject,t.priority,t.opened_at,c.name customer_name,c.customer_code,s.code site_code,e.name pic_name,
      COALESCE(ss.stage,CASE WHEN t.status='pending' THEN 'RESOLVED' WHEN t.status='progress' THEN 'WORKING' WHEN t.assigned_employee_id IS NOT NULL THEN 'ASSIGNED' ELSE 'OPEN' END) stage,
      COALESCE(ss.last_activity_at,t.updated_at,t.opened_at) last_activity_at,ss.last_reminder_at,COALESCE(ss.reminder_count,0) reminder_count,ss.hold_until,
      TIMESTAMPDIFF(MINUTE,COALESCE(ss.last_activity_at,t.updated_at,t.opened_at),NOW()) idle_minutes,
      TIMESTAMPDIFF(MINUTE,t.opened_at,NOW()) age_minutes,
      CASE t.priority WHEN 'critical' THEN 240 WHEN 'high' THEN 480 WHEN 'low' THEN 2880 ELSE 1440 END sla_minutes
      FROM tickets t LEFT JOIN ticket_supervisor_state ss ON ss.ticket_id=t.id LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN employees e ON e.id=t.assigned_employee_id
      WHERE ${tWhere} ORDER BY (TIMESTAMPDIFF(MINUTE,t.opened_at,NOW())>CASE t.priority WHEN 'critical' THEN 240 WHEN 'high' THEN 480 WHEN 'low' THEN 2880 ELSE 1440 END) DESC,FIELD(t.priority,'critical','high','medium','low'),t.opened_at ASC`,tParams);
    tickets.forEach(t=>{t.over_sla=Number(t.age_minutes)>Number(t.sla_minutes);});

    const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
    const [employees]=await db.query(`SELECT id,employee_code,name FROM employees WHERE is_active=1 ORDER BY name`);
    const [siteRules]=await db.query(`SELECT r.site_id,r.primary_employee_id,r.backup_employee_id,s.code site_code,s.name site_name,p.name primary_name,b.name backup_name FROM operations_site_pic_rules r JOIN sites s ON s.id=r.site_id LEFT JOIN employees p ON p.id=r.primary_employee_id LEFT JOIN employees b ON b.id=r.backup_employee_id ORDER BY s.code`);
    const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,c.site_id,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.customer_status<>'terminated' ORDER BY s.code,c.name`);
    const summary={
      openTickets:tickets.length, overSla:tickets.filter(x=>x.over_sla).length, silent:tickets.filter(x=>Number(x.idle_minutes)>=60).length,
      inProgress:activities.filter(x=>x.status==='in_progress').length, done:activities.filter(x=>x.status==='done').length,
      psb:activities.filter(x=>x.activity_type==='psb').length
    };
    const [siteRows]=await db.execute(`SELECT s.code,
      COUNT(DISTINCT CASE WHEN t.status<>'closed' THEN t.id END) open_tickets,
      COUNT(DISTINCT CASE WHEN a.status='in_progress' AND DATE(a.created_at) BETWEEN ? AND ? THEN a.id END) active_activities,
      COUNT(DISTINCT CASE WHEN a.status='done' AND DATE(a.completed_at) BETWEEN ? AND ? THEN a.id END) done_activities
      FROM sites s LEFT JOIN customers c ON c.site_id=s.id LEFT JOIN tickets t ON t.customer_id=c.id LEFT JOIN operations_activities a ON a.site_id=s.id
      WHERE s.is_active=1 GROUP BY s.id,s.code ORDER BY s.code`,[start,end,start,end]);
    res.render('operations/index',{title:'Operations Center',activities,tickets,sites,employees,customers,siteRules,summary,siteRows,filters,types:TYPES,statuses:STATUSES,stages:STAGES,start,end});
  }catch(err){next(err);}
});

router.get('/activities/:id', async(req,res,next)=>{
  try{
    const [[activity]]=await db.execute(`SELECT a.*,s.code site_code,s.name site_name,c.customer_code,c.name customer_name,e.name pic_name,t.ticket_code
      FROM operations_activities a LEFT JOIN sites s ON s.id=a.site_id LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN employees e ON e.id=a.primary_employee_id LEFT JOIN tickets t ON t.id=a.ticket_id WHERE a.id=? LIMIT 1`,[req.params.id]);
    if(!activity) return res.status(404).send('Aktivitas tidak ditemukan.');
    const [updates]=await db.execute(`SELECT u.*,COALESCE(e.name,usr.name,'System') actor_name FROM operations_activity_updates u LEFT JOIN employees e ON e.id=u.actor_employee_id LEFT JOIN users usr ON usr.id=u.actor_user_id WHERE u.activity_id=? ORDER BY u.created_at DESC,u.id DESC`,[req.params.id]);
    const [members]=await db.execute(`SELECT m.*,e.name,e.employee_code FROM operations_activity_members m JOIN employees e ON e.id=m.employee_id WHERE m.activity_id=? ORDER BY FIELD(m.role,'pic','helper','observer'),e.name`,[req.params.id]);
    const [employees]=await db.query(`SELECT id,employee_code,name FROM employees WHERE is_active=1 ORDER BY name`);
    const [siteRules]=await db.query(`SELECT r.site_id,r.primary_employee_id,r.backup_employee_id,s.code site_code,s.name site_name,p.name primary_name,b.name backup_name FROM operations_site_pic_rules r JOIN sites s ON s.id=r.site_id LEFT JOIN employees p ON p.id=r.primary_employee_id LEFT JOIN employees b ON b.id=r.backup_employee_id ORDER BY s.code`);
    res.render('operations/detail',{title:`Aktivitas ${activity.activity_code}`,activity,updates,members,employees,statuses:STATUSES});
  }catch(err){next(err);}
});

router.post('/site-rules/:siteId', async(req,res)=>{
  try{
    const siteId=Number(req.params.siteId); if(!siteId) throw new Error('Site tidak valid.');
    const primary=n(req.body.primary_employee_id), backup=n(req.body.backup_employee_id);
    await db.execute(`INSERT INTO operations_site_pic_rules(site_id,primary_employee_id,backup_employee_id) VALUES(?,?,?) ON DUPLICATE KEY UPDATE primary_employee_id=VALUES(primary_employee_id),backup_employee_id=VALUES(backup_employee_id)`,[siteId,primary,backup]);
    req.session.flash={type:'success',message:'PIC default site diperbarui.'};
  }catch(err){req.session.flash={type:'danger',message:err.message};}
  res.redirect('/operations');
});

router.post('/activities', async(req,res)=>{
  try{
    await createActivity({
      activity_type:req.body.activity_type,title:req.body.title,description:req.body.description,site_id:n(req.body.site_id),customer_id:n(req.body.customer_id),ticket_id:n(req.body.ticket_id),
      status:req.body.status||'planned',priority:req.body.priority||'medium',primary_employee_id:n(req.body.primary_employee_id),source:'web',started_at:req.body.started_at||null
    },{user_id:req.session.user?.id,source:'web'});
    req.session.flash={type:'success',message:'Aktivitas operasional berhasil dibuat.'};
  }catch(err){req.session.flash={type:'danger',message:err.message};}
  res.redirect('/operations');
});

router.post('/activities/:id/update', async(req,res)=>{
  try{
    await addActivityUpdate(Number(req.params.id),{status:req.body.status,event_type:'manual_update',note:req.body.note,source:'web'},{user_id:req.session.user?.id,source:'web'});
    if(n(req.body.employee_id)) await addMember(Number(req.params.id),n(req.body.employee_id),req.body.role||'helper');
    req.session.flash={type:'success',message:'Aktivitas diperbarui.'};
  }catch(err){req.session.flash={type:'danger',message:err.message};}
  res.redirect('/operations');
});

router.post('/tickets/:id/stage', async(req,res)=>{
  try{
    await setStage(Number(req.params.id),req.body.stage,{note:req.body.note,source:'web',user_id:req.session.user?.id});
    req.session.flash={type:'success',message:'Stage tiket diperbarui.'};
  }catch(err){req.session.flash={type:'danger',message:err.message};}
  res.redirect('/operations');
});

router.post('/tickets/:id/note', async(req,res)=>{
  try{
    await addSupervisorNote(Number(req.params.id),req.body.note,{source:'web',user_id:req.session.user?.id,hold_until:req.body.hold_until||null});
    req.session.flash={type:'success',message:'Catatan supervisor tersimpan.'};
  }catch(err){req.session.flash={type:'danger',message:err.message};}
  res.redirect('/operations');
});

module.exports=router;
