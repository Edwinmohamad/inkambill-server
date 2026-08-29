const express=require('express');
const db=require('../config/db');
const { audit }=require('../services/auditService');
const { requireAdmin }=require('../middleware/auth');
const router=express.Router();
router.get('/',async(req,res)=>{const [sites]=await db.query(`SELECT s.*,COUNT(DISTINCT c.id) customers,COUNT(DISTINCT r.id) routers FROM sites s LEFT JOIN customers c ON c.site_id=s.id LEFT JOIN routers r ON r.site_id=s.id GROUP BY s.id ORDER BY s.code`);res.render('sites/index',{title:'Lokasi Server / POP',sites});});
router.post('/',async(req,res)=>{const b=req.body;await db.execute(`INSERT INTO sites(code,name,address,default_due_day,default_grace_days,invoice_generate_days,is_active) VALUES(?,?,?,?,?,?,1)`,[b.code.toUpperCase(),b.name,b.address||null,b.default_due_day||null,b.default_grace_days||null,b.invoice_generate_days||null]);req.session.flash={type:'success',message:'Lokasi server ditambahkan.'};res.redirect('/sites');});

// v1.21.0 — Section 4 (global delete-button audit): Site/POP previously had NO delete or even a way to
// deactivate it at all — `is_active` existed in the schema/view badge but nothing ever toggled it. Added
// a toggle (offered as the safe alternative whenever delete is blocked) plus individual + bulk delete.
// Guard: a site is "in use" if ANY customer, router, cluster/ODP, or package still references its id —
// every one of those entities' list/detail queries INNER JOINs sites, so an orphaned site_id would make
// that row silently vanish from its own menu, exactly the kind of breakage the Section 4 audit is meant
// to prevent (see the same reasoning already applied to Paket Internet and Cluster/ODP deletes).
async function siteUsage(siteId){
  const [[row]]=await db.execute(`SELECT
    (SELECT COUNT(*) FROM customers WHERE site_id=?) customers,
    (SELECT COUNT(*) FROM routers WHERE site_id=?) routers,
    (SELECT COUNT(*) FROM clusters WHERE site_id=?) clusters,
    (SELECT COUNT(*) FROM packages WHERE site_id=?) packages
  `,[siteId,siteId,siteId,siteId]);
  return row||{customers:0,routers:0,clusters:0,packages:0};
}
function usageMessage(name,usage){
  const parts=[];
  if(Number(usage.customers)>0)parts.push(`${usage.customers} pelanggan`);
  if(Number(usage.routers)>0)parts.push(`${usage.routers} router`);
  if(Number(usage.clusters)>0)parts.push(`${usage.clusters} cluster/ODP`);
  if(Number(usage.packages)>0)parts.push(`${usage.packages} paket`);
  return `Site ${name} masih memiliki ${parts.join(', ')} dan tidak dapat dihapus permanen. Nonaktifkan site terlebih dahulu (tombol Aktif/Nonaktif) atau pindahkan seluruh data tersebut ke site lain.`;
}
router.post('/:id/toggle',requireAdmin,async(req,res)=>{
  const [[site]]=await db.execute(`SELECT id,name,is_active FROM sites WHERE id=? LIMIT 1`,[req.params.id]);
  if(!site){req.session.flash={type:'warning',message:'Site tidak ditemukan.'};return res.redirect('/sites');}
  await db.execute(`UPDATE sites SET is_active=IF(is_active=1,0,1) WHERE id=?`,[site.id]);
  await audit({userId:req.session.user.id,action:'toggle',entityType:'site',entityId:site.id,description:`${site.is_active?'Nonaktifkan':'Aktifkan'} site ${site.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Site ${site.name} sekarang ${site.is_active?'NONAKTIF':'AKTIF'}.`};
  res.redirect('/sites');
});
router.post('/:id/edit',requireAdmin,async(req,res)=>{
  const b=req.body;
  const [[site]]=await db.execute(`SELECT id,name FROM sites WHERE id=? LIMIT 1`,[req.params.id]);
  if(!site){req.session.flash={type:'warning',message:'Site tidak ditemukan.'};return res.redirect('/sites');}
  const code=String(b.code||'').trim().toUpperCase();
  const name=String(b.name||'').trim();
  if(!code||!name){req.session.flash={type:'danger',message:'Code dan Nama wajib diisi.'};return res.redirect('/sites');}
  const [dup]=await db.execute(`SELECT id FROM sites WHERE code=? AND id<>? LIMIT 1`,[code,site.id]);
  if(dup.length){req.session.flash={type:'danger',message:`Code ${code} sudah dipakai site lain.`};return res.redirect('/sites');}
  await db.execute(`UPDATE sites SET code=?,name=?,address=? WHERE id=?`,[code,name,b.address||null,site.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'site',entityId:site.id,description:`Edit site ${site.name} -> ${name} (${code})`,ip:req.ip});
  req.session.flash={type:'success',message:`Site ${name} berhasil diperbarui.`};
  res.redirect('/sites');
});
router.post('/:id/delete',requireAdmin,async(req,res)=>{
  const [[site]]=await db.execute(`SELECT id,name FROM sites WHERE id=? LIMIT 1`,[req.params.id]);
  if(!site){req.session.flash={type:'warning',message:'Site tidak ditemukan.'};return res.redirect('/sites');}
  const usage=await siteUsage(site.id);
  if(Number(usage.customers)+Number(usage.routers)+Number(usage.clusters)+Number(usage.packages)>0){
    req.session.flash={type:'danger',message:usageMessage(site.name,usage)};
    return res.redirect('/sites');
  }
  await db.execute(`DELETE FROM sites WHERE id=?`,[site.id]);
  await audit({userId:req.session.user.id,action:'delete',entityType:'site',entityId:site.id,description:`Hapus site ${site.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Site ${site.name} dihapus permanen.`};
  res.redirect('/sites');
});
router.post('/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.site_ids||[]).map(x=>Number(x)).filter(Boolean))];
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu site terlebih dahulu.'};return res.redirect('/sites');}
  if(ids.length>500){req.session.flash={type:'danger',message:'Maksimal 500 site per aksi massal.'};return res.redirect('/sites');}
  if(action==='delete'){
    const placeholders=ids.map(()=>'?').join(',');
    const [rows]=await db.execute(`SELECT id,name FROM sites WHERE id IN (${placeholders})`,ids);
    if(!rows.length){req.session.flash={type:'warning',message:'Site terpilih tidak ditemukan.'};return res.redirect('/sites');}
    const eligible=[];const skipped=[];
    for(const row of rows){
      const usage=await siteUsage(row.id);
      if(Number(usage.customers)+Number(usage.routers)+Number(usage.clusters)+Number(usage.packages)>0)skipped.push(row);
      else eligible.push(row);
    }
    if(!eligible.length){
      req.session.flash={type:'danger',message:'Semua site terpilih masih memiliki data terkait (pelanggan/router/cluster/paket) dan tidak dapat dihapus permanen.'};
      return res.redirect('/sites');
    }
    const eligibleIds=eligible.map(r=>r.id);const eligiblePlaceholders=eligibleIds.map(()=>'?').join(',');
    await db.execute(`DELETE FROM sites WHERE id IN (${eligiblePlaceholders})`,eligibleIds);
    await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'site',entityId:null,description:`Hapus massal ${eligible.length} site: ${eligible.map(r=>r.name).slice(0,20).join(', ')}${eligible.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena masih memiliki data terkait)`:''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${eligible.length} site dihapus permanen.${skipped.length?` ${skipped.length} site dilewati karena masih memiliki pelanggan/router/cluster/paket terkait.`:''}`};
    return res.redirect('/sites');
  }
  req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};
  res.redirect('/sites');
});
module.exports=router;
