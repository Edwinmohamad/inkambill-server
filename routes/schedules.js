const express=require('express');
const db=require('../config/db');
const router=express.Router();
router.get('/',async(req,res)=>{
  const date=req.query.date||new Date().toISOString().slice(0,10);const q=String(req.query.q||'').trim();const site=String(req.query.site||'').trim();const cluster=String(req.query.cluster||'').trim();
  let sql=`SELECT ts.*,COALESCE(e.name,u.name) technician_name,e.employee_code,c.name customer_name,c.customer_code,t.ticket_code,s.code site_code,cl.name cluster_name
    FROM technician_schedules ts LEFT JOIN employees e ON e.id=ts.technician_employee_id LEFT JOIN users u ON u.id=ts.technician_id LEFT JOIN customers c ON c.id=ts.customer_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN tickets t ON t.id=ts.ticket_id LEFT JOIN sites s ON s.id=COALESCE(ts.site_id,c.site_id)
    WHERE ts.schedule_date=?`;
  const params=[date];if(site){sql+=` AND s.code=?`;params.push(site);}if(cluster){sql+=` AND c.cluster_id=?`;params.push(Number(cluster));}if(q){const like=`%${q}%`;sql+=` AND (ts.title LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ? OR COALESCE(e.name,u.name) LIKE ? OR t.ticket_code LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)`;params.push(like,like,like,like,like,like,like);}sql+=` ORDER BY ts.schedule_time,COALESCE(e.name,u.name)`;
  const [schedules]=await db.execute(sql,params);
  const [staff]=await db.query(`SELECT e.id,e.employee_code,e.name,e.user_id,p.name position_name FROM employees e LEFT JOIN positions p ON p.id=e.position_id WHERE e.is_active=1 AND (p.category='technical' OR p.category IS NULL) ORDER BY e.name`);
  const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.customer_status='active' ORDER BY s.code,cl.name,c.name LIMIT 2000`);
  const [tickets]=await db.query(`SELECT id,ticket_code,subject FROM tickets WHERE status IN ('open','progress','pending') ORDER BY id DESC LIMIT 300`);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);
  res.render('schedules/index',{title:'Jadwal Teknisi',date,q,site,cluster,schedules,staff,customers,tickets,sites,clusters});
});
router.post('/',async(req,res)=>{const b=req.body;const [rows]=await db.execute(`SELECT id,user_id FROM employees WHERE id=? AND is_active=1 LIMIT 1`,[b.technician_employee_id]);if(!rows.length){req.session.flash={type:'danger',message:'Pilih teknisi dari data karyawan.'};return res.redirect(`/schedules?date=${encodeURIComponent(b.schedule_date)}`);}const emp=rows[0];await db.execute(`INSERT INTO technician_schedules(schedule_date,schedule_time,technician_id,technician_employee_id,customer_id,ticket_id,site_id,title,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,'scheduled',?,?)`,[b.schedule_date,b.schedule_time||null,emp.user_id||null,emp.id,b.customer_id||null,b.ticket_id||null,b.site_id||null,b.title,b.notes||null,req.session.user.id]);req.session.flash={type:'success',message:'Jadwal teknisi ditambahkan.'};res.redirect(`/schedules?date=${encodeURIComponent(b.schedule_date)}`);});
// v1.25 audit: previously a mis-scheduled job (wrong date/time/technician/title) had no way to be
// corrected other than deleting and re-creating it — but there wasn't even a delete route, so a typo was
// permanent. Added a genuine Edit alongside the existing status-only update.
router.post('/:id/edit',async(req,res)=>{
  const b=req.body;
  const [rows]=await db.execute(`SELECT id,user_id FROM employees WHERE id=? AND is_active=1 LIMIT 1`,[b.technician_employee_id]);
  if(!rows.length){req.session.flash={type:'danger',message:'Pilih teknisi dari data karyawan.'};return res.redirect(`/schedules?date=${encodeURIComponent(b.schedule_date)}`);}
  const emp=rows[0];
  await db.execute(`UPDATE technician_schedules SET schedule_date=?,schedule_time=?,technician_id=?,technician_employee_id=?,customer_id=?,ticket_id=?,site_id=?,title=?,notes=? WHERE id=?`,
    [b.schedule_date,b.schedule_time||null,emp.user_id||null,emp.id,b.customer_id||null,b.ticket_id||null,b.site_id||null,b.title,b.notes||null,req.params.id]);
  req.session.flash={type:'success',message:'Jadwal teknisi diperbarui.'};
  res.redirect(`/schedules?date=${encodeURIComponent(b.schedule_date)}`);
});
const SCHEDULE_STATUSES=new Set(['scheduled','on_the_way','working','done','cancelled']);
router.post('/:id/status',async(req,res)=>{
  if(!SCHEDULE_STATUSES.has(req.body.status)){req.session.flash={type:'danger',message:'Status jadwal tidak valid.'};return res.redirect(`/schedules?date=${encodeURIComponent(req.body.date)}${req.body.q?`&q=${encodeURIComponent(req.body.q)}`:''}`);}
  await db.execute(`UPDATE technician_schedules SET status=? WHERE id=?`,[req.body.status,req.params.id]);res.redirect(`/schedules?date=${encodeURIComponent(req.body.date)}${req.body.q?`&q=${encodeURIComponent(req.body.q)}`:''}`);});
module.exports=router;
