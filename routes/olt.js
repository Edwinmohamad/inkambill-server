const express=require('express');
const db=require('../config/db');
const {requireAdmin}=require('../middleware/auth');
const {audit}=require('../services/auditService');
const {oltSummaryRows}=require('../services/oltService');
const router=express.Router();

function oltInput(body){
  const name=String(body.name||'').trim().slice(0,120);
  const vendor=String(body.vendor||'').trim().slice(0,80)||null;
  const managementIp=String(body.management_ip||'').trim().slice(0,80)||null;
  const siteId=Number(body.site_id)||null;
  const capacity=Math.max(1,Math.min(4096,Number(body.pon_port_capacity)||64));
  const notes=String(body.notes||'').trim().slice(0,500)||null;
  if(!name)throw new Error('Nama OLT wajib diisi.');
  return {name,vendor,managementIp,siteId,capacity,notes};
}

router.get('/',async(req,res,next)=>{try{
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const olts=await oltSummaryRows();
  res.render('olt/index',{title:'Registry OLT',olts,sites});
}catch(err){next(err);}});

router.get('/api/summary',async(req,res,next)=>{try{
  res.set('Cache-Control','private, max-age=15').json({ok:true,olts:await oltSummaryRows()});
}catch(err){next(err);}});

router.post('/',requireAdmin,async(req,res)=>{try{
  const b=oltInput(req.body);
  const [result]=await db.execute(`INSERT INTO olt_devices(name,vendor,management_ip,site_id,pon_port_capacity,notes,created_by) VALUES(?,?,?,?,?,?,?)`,[b.name,b.vendor,b.managementIp,b.siteId,b.capacity,b.notes,req.session.user.id]);
  await audit({userId:req.session.user.id,action:'create',entityType:'olt_device',entityId:result.insertId,description:`Tambah OLT ${b.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`OLT ${b.name} berhasil didaftarkan.`};
}catch(err){req.session.flash={type:'danger',message:`OLT gagal disimpan: ${err.code==='ER_DUP_ENTRY'?'Nama OLT sudah terdaftar.':err.message}`};}res.redirect('/olt');});

router.post('/:id/update',requireAdmin,async(req,res)=>{try{
  const b=oltInput(req.body);
  const [rows]=await db.execute(`SELECT id,name FROM olt_devices WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length)throw new Error('OLT tidak ditemukan.');
  await db.execute(`UPDATE olt_devices SET name=?,vendor=?,management_ip=?,site_id=?,pon_port_capacity=?,notes=? WHERE id=?`,[b.name,b.vendor,b.managementIp,b.siteId,b.capacity,b.notes,req.params.id]);
  if(rows[0].name!==b.name)await db.execute(`UPDATE acs_devices SET olt_name=? WHERE olt_name=?`,[b.name,rows[0].name]);
  await audit({userId:req.session.user.id,action:'update',entityType:'olt_device',entityId:req.params.id,description:`Ubah OLT ${rows[0].name} menjadi ${b.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`OLT ${b.name} berhasil diperbarui.`};
}catch(err){req.session.flash={type:'danger',message:`Update OLT gagal: ${err.code==='ER_DUP_ENTRY'?'Nama OLT sudah terdaftar.':err.message}`};}res.redirect('/olt');});

router.post('/:id/delete',requireAdmin,async(req,res)=>{try{
  const [rows]=await db.execute(`SELECT id,name FROM olt_devices WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length)throw new Error('OLT tidak ditemukan.');
  await db.execute(`DELETE FROM olt_devices WHERE id=?`,[req.params.id]);
  await audit({userId:req.session.user.id,action:'delete',entityType:'olt_device',entityId:req.params.id,description:`Hapus registrasi OLT ${rows[0].name} (metadata ONT tetap tersimpan)`,ip:req.ip});
  req.session.flash={type:'success',message:`Registrasi OLT ${rows[0].name} dihapus. ONT yang mengarah ke OLT ini tetap tampil dengan kapasitas default.`};
}catch(err){req.session.flash={type:'danger',message:`Hapus OLT gagal: ${err.message}`};}res.redirect('/olt');});

module.exports=router;
