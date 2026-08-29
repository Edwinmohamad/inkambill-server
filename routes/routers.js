const express=require('express');
const db=require('../config/db');
const { encrypt }=require('../services/cryptoService');
const { testConnection }=require('../services/mikrotikRest');
const { requireAdmin }=require('../middleware/auth');
const { audit }=require('../services/auditService');
const router=express.Router();

function routerInput(body,{passwordRequired=false}={}){
  const siteId=Number(body.site_id);
  const name=String(body.name||'').trim().slice(0,120);
  const username=String(body.username||'').trim().slice(0,120);
  const password=String(body.password||'');
  let baseUrl=String(body.base_url||'').trim().replace(/\/+$/,'');
  if(!Number.isInteger(siteId)||siteId<=0)throw new Error('Site router wajib dipilih.');
  if(!name)throw new Error('Nama router wajib diisi.');
  if(!username)throw new Error('Username REST wajib diisi.');
  if(passwordRequired&&!password)throw new Error('Password REST wajib diisi.');
  let parsed;
  try{parsed=new URL(baseUrl);}catch(_){throw new Error('REST Base URL tidak valid. Contoh: https://192.168.77.1:8443/rest');}
  if(!['http:','https:'].includes(parsed.protocol))throw new Error('REST Base URL hanya boleh menggunakan HTTP atau HTTPS.');
  baseUrl=parsed.toString().replace(/\/$/,'');
  return {siteId,name,username,password,baseUrl,verifyTls:body.verify_tls?1:0};
}

router.get('/',async(req,res)=>{
  const [routers]=await db.query(`SELECT r.id,r.site_id,r.name,r.base_url,r.username,r.verify_tls,r.is_active,r.last_status,r.last_error,r.last_seen_at,s.code site_code,
    (SELECT COUNT(*) FROM customers c WHERE c.router_id=r.id) linked_customers
    FROM routers r JOIN sites s ON s.id=r.site_id ORDER BY s.code,r.name`);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('routers/index',{title:'Router MikroTik',routers,sites});
});

router.post('/',requireAdmin,async(req,res)=>{
  try{
    const b=routerInput(req.body,{passwordRequired:true});
    const [site]=await db.execute(`SELECT id FROM sites WHERE id=? AND is_active=1 LIMIT 1`,[b.siteId]);
    if(!site.length)throw new Error('Site tidak ditemukan atau tidak aktif.');
    const passwordEnc=encrypt(b.password);
    const [result]=await db.execute(`INSERT INTO routers(site_id,name,base_url,username,password_enc,verify_tls,is_active) VALUES(?,?,?,?,?,?,1)`,[b.siteId,b.name,b.baseUrl,b.username,passwordEnc,b.verifyTls]);
    await audit({userId:req.session.user.id,action:'create',entityType:'router',entityId:result.insertId,description:`Tambah router ${b.name}`,ip:req.ip});
    req.session.flash={type:'success',message:'Router tersimpan. Jalankan Test untuk memvalidasi koneksi.'};
  }catch(e){req.session.flash={type:'danger',message:`Router gagal disimpan: ${e.message}`};}
  res.redirect('/routers');
});

router.post('/:id/update',requireAdmin,async(req,res)=>{
  try{
    const id=Number(req.params.id);if(!Number.isInteger(id)||id<=0)throw new Error('ID router tidak valid.');
    const b=routerInput(req.body);
    const [rows]=await db.execute(`SELECT id,site_id,name FROM routers WHERE id=? LIMIT 1`,[id]);
    const current=rows[0];if(!current)throw new Error('Router tidak ditemukan.');
    const [site]=await db.execute(`SELECT id FROM sites WHERE id=? AND is_active=1 LIMIT 1`,[b.siteId]);if(!site.length)throw new Error('Site tidak ditemukan atau tidak aktif.');
    const [[usage]]=await db.execute(`SELECT COUNT(*) total FROM customers WHERE router_id=?`,[id]);
    if(Number(current.site_id)!==b.siteId&&Number(usage.total)>0)throw new Error(`Site tidak dapat diubah karena router masih terhubung ke ${Number(usage.total)} pelanggan.`);
    if(b.password){
      await db.execute(`UPDATE routers SET site_id=?,name=?,base_url=?,username=?,password_enc=?,verify_tls=?,last_error=NULL WHERE id=?`,[b.siteId,b.name,b.baseUrl,b.username,encrypt(b.password),b.verifyTls,id]);
    }else{
      await db.execute(`UPDATE routers SET site_id=?,name=?,base_url=?,username=?,verify_tls=?,last_error=NULL WHERE id=?`,[b.siteId,b.name,b.baseUrl,b.username,b.verifyTls,id]);
    }
    await audit({userId:req.session.user.id,action:'update',entityType:'router',entityId:id,description:`Ubah router ${current.name} menjadi ${b.name}`,ip:req.ip});
    req.session.flash={type:'success',message:`Router ${b.name} berhasil diperbarui. Jalankan Test untuk memastikan endpoint baru aktif.`};
  }catch(e){req.session.flash={type:'danger',message:`Update router gagal: ${e.message}`};}
  res.redirect('/routers');
});

router.post('/:id/delete',requireAdmin,async(req,res)=>{
  try{
    const id=Number(req.params.id);if(!Number.isInteger(id)||id<=0)throw new Error('ID router tidak valid.');
    const [rows]=await db.execute(`SELECT id,name FROM routers WHERE id=? LIMIT 1`,[id]);const current=rows[0];if(!current)throw new Error('Router tidak ditemukan.');
    const [[usage]]=await db.execute(`SELECT COUNT(*) total FROM customers WHERE router_id=?`,[id]);
    if(Number(usage.total)>0)throw new Error(`Router masih digunakan ${Number(usage.total)} pelanggan. Pindahkan/unlink pelanggan terlebih dahulu.`);
    await db.execute(`DELETE FROM routers WHERE id=?`,[id]);
    await audit({userId:req.session.user.id,action:'delete',entityType:'router',entityId:id,description:`Hapus router ${current.name}`,ip:req.ip});
    req.session.flash={type:'success',message:`Router ${current.name} berhasil dihapus.`};
  }catch(e){req.session.flash={type:'danger',message:`Hapus router gagal: ${e.message}`};}
  res.redirect('/routers');
});

// v1.21.0 — Section 4 (global delete-button audit): per-row delete already existed and was already
// correctly guarded (blocked while any customer still has router_id=this router). Router Config was
// simply missing the checkbox/bulk-selection UI the other menus have, so this adds bulk delete reusing
// the exact same per-row guard, looped one router at a time (skipped ones are reported, not silently lost).
router.post('/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.router_ids||[]).map(x=>Number(x)).filter(Boolean))];
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu router terlebih dahulu.'};return res.redirect('/routers');}
  if(ids.length>500){req.session.flash={type:'danger',message:'Maksimal 500 router per aksi massal.'};return res.redirect('/routers');}
  if(action==='delete'){
    const deleted=[];const skipped=[];
    for(const id of ids){
      const [[current]]=await db.execute(`SELECT id,name FROM routers WHERE id=? LIMIT 1`,[id]);
      if(!current)continue;
      const [[usage]]=await db.execute(`SELECT COUNT(*) total FROM customers WHERE router_id=?`,[id]);
      if(Number(usage.total)>0){skipped.push(current);continue;}
      await db.execute(`DELETE FROM routers WHERE id=?`,[id]);
      deleted.push(current);
    }
    if(!deleted.length){
      req.session.flash={type:'danger',message:'Semua router terpilih masih digunakan pelanggan dan tidak dapat dihapus. Pindahkan/unlink pelanggan terlebih dahulu.'};
      return res.redirect('/routers');
    }
    await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'router',entityId:null,description:`Hapus massal ${deleted.length} router: ${deleted.map(r=>r.name).slice(0,20).join(', ')}${deleted.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena masih dipakai pelanggan)`:''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${deleted.length} router dihapus permanen.${skipped.length?` ${skipped.length} router dilewati karena masih digunakan pelanggan.`:''}`};
    return res.redirect('/routers');
  }
  req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};
  res.redirect('/routers');
});

router.post('/:id/test',async(req,res)=>{
  const [rows]=await db.execute(`SELECT * FROM routers WHERE id=?`,[req.params.id]);
  if(!rows.length)return res.status(404).send('Router tidak ditemukan');
  try{
    const info=await testConnection(rows[0]);
    await db.execute(`UPDATE routers SET last_status='online',last_error=NULL,last_seen_at=NOW() WHERE id=?`,[req.params.id]);
    req.session.flash={type:'success',message:`Koneksi OK: ${info?.['board-name']||'MikroTik'} · RouterOS ${info?.version||'-'} · uptime ${info?.uptime||'-'}`};
  }catch(e){
    await db.execute(`UPDATE routers SET last_status='offline',last_error=? WHERE id=?`,[e.message.slice(0,500),req.params.id]);
    req.session.flash={type:'danger',message:`Koneksi gagal: ${e.message}`};
  }
  res.redirect('/routers');
});
module.exports=router;
