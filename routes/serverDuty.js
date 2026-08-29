const express = require('express');
const path = require('path');
const db = require('../config/db');
const { audit } = require('../services/auditService');
const { requireAdmin } = require('../middleware/auth');
const { savePhoto, removePhoto, sendPhoto } = require('../services/photoAttachmentService');
const router = express.Router();
const DUTY_PROOF_DIR=path.join(__dirname,'..','storage','server-duty-proofs');

function isoDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
}
function mondayOf(input) {
  const d = input ? new Date(`${input}T00:00:00`) : new Date();
  if (Number.isNaN(d.getTime())) return mondayOf();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return isoDate(d);
}

router.get('/', async (req, res) => {
  const weekStart = mondayOf(req.query.week);
  const start = new Date(`${weekStart}T00:00:00`);
  const end = new Date(start); end.setDate(end.getDate()+6);
  const weekEnd = isoDate(end);
  const [duties] = await db.execute(`
    SELECT d.*, DATE_FORMAT(d.duty_date,'%Y-%m-%d') duty_date_key, u.name account_name, s.code site_code, pu.name proof_uploader_name
    FROM server_duty_schedules d
    LEFT JOIN users u ON u.id=d.user_id
    LEFT JOIN sites s ON s.id=d.site_id
    LEFT JOIN users pu ON pu.id=d.proof_uploaded_by
    WHERE d.duty_date BETWEEN ? AND ?
    ORDER BY d.duty_date, COALESCE(d.start_time,'23:59:59'), d.staff_name
  `,[weekStart,weekEnd]);
  const [staff] = await db.query(`SELECT e.id,e.employee_code,e.name,e.user_id,p.name position_name FROM employees e LEFT JOIN positions p ON p.id=e.position_id WHERE e.is_active=1 ORDER BY e.name`);
  const [sites] = await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const days = Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return {date:isoDate(d), label:d.toLocaleDateString('id-ID',{weekday:'short',day:'2-digit',month:'short'})};});
  const prev=new Date(start);prev.setDate(prev.getDate()-7); const next=new Date(start);next.setDate(next.getDate()+7);
  res.render('server-duty/index',{title:'Jadwal Piket Server',duties,staff,sites,days,weekStart,weekEnd,prevWeek:isoDate(prev),nextWeek:isoDate(next)});
});

router.post('/generate-rotation', requireAdmin, async(req,res)=>{
  const rotation=['Padilah','Jon','Bopung','Edwin','Agung'];
  const firstMonday=mondayOf(req.body.start_week||req.body.week);
  const weeks=Math.max(1,Math.min(20,Number(req.body.weeks||5)));
  const [employees]=await db.query(`SELECT id,name,user_id FROM employees WHERE is_active=1`);
  let created=0,skipped=0;
  const conn=await db.getConnection();
  try{await conn.beginTransaction();
    for(let w=0;w<weeks;w++){
      const staffName=rotation[w%rotation.length];const employee=employees.find(e=>String(e.name).trim().toLowerCase()===staffName.toLowerCase());const monday=new Date(`${firstMonday}T00:00:00`);monday.setDate(monday.getDate()+w*7);
      for(let d=0;d<7;d++){
        const date=new Date(monday);date.setDate(date.getDate()+d);const dutyDate=isoDate(date);
        const [exists]=await conn.execute(`SELECT id FROM server_duty_schedules WHERE duty_date=? AND LOWER(staff_name)=LOWER(?) LIMIT 1`,[dutyDate,staffName]);
        if(exists.length){skipped++;continue;}
        await conn.execute(`INSERT INTO server_duty_schedules(duty_date,shift_name,user_id,staff_name,status,notes,created_by) VALUES(?,'Piket Mingguan',?,?, 'scheduled',?,?)`,[dutyDate,employee?.user_id||null,staffName,`Rotasi otomatis minggu ${w+1}/${weeks}`,req.session.user.id]);created++;
      }
    }
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'generate',entityType:'server_duty',description:`Generate rotasi ${weeks} minggu: ${created} jadwal`,ip:req.ip});req.session.flash={type:'success',message:`Rotasi piket dibuat: ${weeks} minggu untuk Padilah, Jon, Bopung, Edwin, Agung. ${created} assignment baru, ${skipped} dilewati.`};res.redirect(`/server-duty?week=${firstMonday}`);
});

router.post('/', requireAdmin, async (req,res)=>{
  const b=req.body;
  const selectedEmployee=b.employee_id?Number(b.employee_id):null;
  let selectedUser=null;
  let staffName=(b.staff_name||'').trim();
  if(selectedEmployee){
    const [rows]=await db.execute(`SELECT id,name,user_id FROM employees WHERE id=? AND is_active=1`,[selectedEmployee]);
    if(!rows.length) throw new Error('Data karyawan tidak ditemukan.');
    staffName=rows[0].name;selectedUser=rows[0].user_id||null;
  }
  if(!staffName) throw new Error('Nama petugas piket wajib diisi.');
  const [result]=await db.execute(`INSERT INTO server_duty_schedules(duty_date,shift_name,start_time,end_time,user_id,staff_name,site_id,status,notes,created_by) VALUES(?,?,?,?,?,?,?,'scheduled',?,?)`,[
    b.duty_date,b.shift_name||'Piket Server',b.start_time||null,b.end_time||null,selectedUser,staffName,b.site_id||null,b.notes||null,req.session.user.id
  ]);
  await audit({userId:req.session.user.id,action:'create',entityType:'server_duty',entityId:result.insertId,description:`Piket ${staffName} ${b.duty_date}`,ip:req.ip});
  req.session.flash={type:'success',message:'Jadwal piket server berhasil ditambahkan.'};
  res.redirect(`/server-duty?week=${encodeURIComponent(b.duty_date)}`);
});

// v1.25 audit: a mis-scheduled duty (wrong date/shift/time/staff) previously had no fix short of
// deleting (admin-only) and recreating. Edit added — open to whoever can create the schedule, matching
// that route's own permission level.
router.post('/:id/edit', async(req,res)=>{
  const b=req.body;
  const [[duty]]=await db.execute(`SELECT id FROM server_duty_schedules WHERE id=? LIMIT 1`,[req.params.id]);
  if(!duty){req.session.flash={type:'warning',message:'Jadwal piket tidak ditemukan.'};return res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);}
  const selectedEmployee=b.employee_id?Number(b.employee_id):null;
  let selectedUser=null,staffName=(b.staff_name||'').trim();
  if(selectedEmployee){
    const [rows]=await db.execute(`SELECT id,name,user_id FROM employees WHERE id=? AND is_active=1`,[selectedEmployee]);
    if(!rows.length){req.session.flash={type:'danger',message:'Data karyawan tidak ditemukan.'};return res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);}
    staffName=rows[0].name;selectedUser=rows[0].user_id||null;
  }
  if(!staffName){req.session.flash={type:'danger',message:'Nama petugas piket wajib diisi.'};return res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);}
  await db.execute(`UPDATE server_duty_schedules SET duty_date=?,shift_name=?,start_time=?,end_time=?,user_id=?,staff_name=?,site_id=?,notes=? WHERE id=?`,
    [b.duty_date,b.shift_name||'Piket Server',b.start_time||null,b.end_time||null,selectedUser,staffName,b.site_id||null,b.notes||null,req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'server_duty',entityId:req.params.id,description:`Update piket ${staffName} ${b.duty_date}`,ip:req.ip});
  req.session.flash={type:'success',message:'Jadwal piket berhasil diperbarui.'};
  res.redirect(`/server-duty?week=${encodeURIComponent(b.duty_date||req.body.week||'')}`);
});

router.post('/:id/status', async(req,res)=>{
  const allowed=new Set(['scheduled','present','absent','swapped','cancelled']);
  const status=allowed.has(req.body.status)?req.body.status:'scheduled';
  await db.execute(`UPDATE server_duty_schedules SET status=? WHERE id=?`,[status,req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'server_duty',entityId:req.params.id,description:`Status piket → ${status}`,ip:req.ip});
  res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);
});

router.post('/:id/proof', async(req,res)=>{
  if(!req.file){req.session.flash={type:'danger',message:'Pilih foto bukti piket terlebih dahulu.'};return res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);}
  const [rows]=await db.execute(`SELECT id,proof_path FROM server_duty_schedules WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length)return res.status(404).send('Jadwal piket tidak ditemukan.');
  let saved=null;
  try{
    saved=await savePhoto(req.file,DUTY_PROOF_DIR,'duty');
    await db.execute(`UPDATE server_duty_schedules SET proof_path=?,proof_original_name=?,proof_mime=?,proof_size=?,proof_uploaded_by=?,proof_uploaded_at=NOW(),status='present' WHERE id=?`,[saved.filename,saved.originalName,saved.mime,saved.size,req.session.user.id,req.params.id]);
    if(rows[0].proof_path)await removePhoto(DUTY_PROOF_DIR,rows[0].proof_path);
    await audit({userId:req.session.user.id,action:'proof',entityType:'server_duty',entityId:req.params.id,description:'Upload bukti piket dan tandai hadir',ip:req.ip});
    req.session.flash={type:'success',message:'Bukti piket berhasil diupload dan status ditandai Hadir.'};
    res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);
  }catch(e){if(saved)await removePhoto(DUTY_PROOF_DIR,saved.filename);throw e;}
});

router.get('/:id/proof',async(req,res)=>{const [rows]=await db.execute(`SELECT proof_path,proof_original_name,proof_mime FROM server_duty_schedules WHERE id=? LIMIT 1`,[req.params.id]);return sendPhoto(res,DUTY_PROOF_DIR,rows[0]);});

router.post('/:id/delete', requireAdmin, async(req,res)=>{
  const [rows]=await db.execute(`SELECT proof_path FROM server_duty_schedules WHERE id=? LIMIT 1`,[req.params.id]);
  await db.execute(`DELETE FROM server_duty_schedules WHERE id=?`,[req.params.id]);
  if(rows[0]?.proof_path)await removePhoto(DUTY_PROOF_DIR,rows[0].proof_path);
  await audit({userId:req.session.user.id,action:'delete',entityType:'server_duty',entityId:req.params.id,description:'Hapus jadwal piket',ip:req.ip});
  req.session.flash={type:'success',message:'Jadwal piket dihapus.'};
  res.redirect(`/server-duty?week=${encodeURIComponent(req.body.week||'')}`);
});

module.exports=router;
