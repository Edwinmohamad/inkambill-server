const express=require('express');
const db=require('../config/db');
const { audit }=require('../services/auditService');
const { requireAdmin }=require('../middleware/auth');
const router=express.Router();

function normalizeSiteId(value){
  const id=Number(value||0);
  return Number.isInteger(id)&&id>0?id:null;
}

async function validateSite(siteId){
  if(!siteId) return null;
  const [rows]=await db.execute(`SELECT id,code,name FROM sites WHERE id=? AND is_active=1 LIMIT 1`,[siteId]);
  return rows[0]||null;
}

// v1.25.5 (susulan #10) — REVISI: skema Komisi Pemasangan Baru ternyata SERAGAM untuk semua paket (Sales
// selalu dapat nominal flat dari Menu Pengaturan -> Aplikasi, Teknisi dapat sisanya dari harga paket), jadi
// tidak lagi diatur manual per-paket di sini seperti susulan #9. resolveCommissionFields() & kolom
// packages.commission_technician/commission_sales dihapus dari alur ini (kolom DB dibiarkan ada, lihat
// services/schemaService.js ensureV34Schema — bukan operasi destruktif untuk sekadar ganti behaviour).
// Lihat services/invoiceService.js settleNewInstallCommission() untuk perhitungan split yang baru.

router.get('/', async(req,res)=>{
  const selectedSite=normalizeSiteId(req.query.site);
  const params=[];
  let where='1=1';
  if(selectedSite){where+=' AND p.site_id=?';params.push(selectedSite);}
  const [packages]=await db.execute(`SELECT p.*,s.code site_code,s.name site_name,
      (SELECT COUNT(*) FROM customers c WHERE c.package_id=p.id AND c.customer_status='active') customer_count
    FROM packages p
    LEFT JOIN sites s ON s.id=p.site_id
    WHERE ${where}
    ORDER BY COALESCE(s.code,'ZZZ'),p.price,p.name`,params);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const [siteStats]=await db.query(`SELECT s.id,s.code,s.name,COUNT(p.id) package_count,COALESCE(SUM(p.is_active=1),0) active_count FROM sites s LEFT JOIN packages p ON p.site_id=s.id WHERE s.is_active=1 GROUP BY s.id,s.code,s.name ORDER BY s.code`);
  res.render('packages/index',{title:'Paket Internet',packages,sites,siteStats,selectedSite:selectedSite||''});
});

router.post('/', requireAdmin, async(req,res)=>{
  const b=req.body;
  const name=String(b.name||'').trim();
  const siteId=normalizeSiteId(b.site_id);
  const price=Number(b.price||0);
  if(!name){req.session.flash={type:'danger',message:'Nama paket wajib diisi.'};return res.redirect('/packages');}
  if(!siteId){req.session.flash={type:'danger',message:'Pilih Site / POP untuk paket baru.'};return res.redirect('/packages');}
  const site=await validateSite(siteId);
  if(!site){req.session.flash={type:'danger',message:'Site paket tidak valid atau sudah nonaktif.'};return res.redirect('/packages');}
  if(!Number.isFinite(price)||price<0){req.session.flash={type:'danger',message:'Harga paket tidak valid.'};return res.redirect('/packages');}
  const [dups]=await db.execute(`SELECT id FROM packages WHERE site_id=? AND LOWER(name)=LOWER(?) LIMIT 1`,[siteId,name]);
  if(dups.length){req.session.flash={type:'danger',message:`Paket ${name} sudah ada di site ${site.code}.`};return res.redirect(`/packages?site=${siteId}`);}
  const [r]=await db.execute(`INSERT INTO packages (site_id,name,speed_label,price,mikrotik_profile,is_active) VALUES (?,?,?,?,?,1)`,[siteId,name,String(b.speed_label||'').trim()||null,price,String(b.mikrotik_profile||'').trim()||null]);
  await audit({userId:req.session.user.id,action:'create',entityType:'package',entityId:r.insertId,description:`Tambah paket ${name} site ${site.code}`,ip:req.ip});
  req.session.flash={type:'success',message:`Paket ${name} untuk site ${site.code} berhasil ditambahkan.`};
  res.redirect(`/packages?site=${siteId}`);
});

router.post('/:id/edit', requireAdmin, async(req,res)=>{
  const id=Number(req.params.id);
  const b=req.body;
  const name=String(b.name||'').trim();
  const siteId=normalizeSiteId(b.site_id);
  const price=Number(b.price||0);
  if(!name){req.session.flash={type:'danger',message:'Nama paket wajib diisi.'};return res.redirect('/packages');}
  if(!siteId){req.session.flash={type:'danger',message:'Pilih Site / POP paket.'};return res.redirect('/packages');}
  const site=await validateSite(siteId);
  if(!site){req.session.flash={type:'danger',message:'Site paket tidak valid atau sudah nonaktif.'};return res.redirect('/packages');}
  if(!Number.isFinite(price)||price<0){req.session.flash={type:'danger',message:'Harga paket tidak valid.'};return res.redirect('/packages');}
  const [dups]=await db.execute(`SELECT id FROM packages WHERE site_id=? AND LOWER(name)=LOWER(?) AND id<>? LIMIT 1`,[siteId,name,id]);
  if(dups.length){req.session.flash={type:'danger',message:`Paket ${name} sudah ada di site ${site.code}.`};return res.redirect(`/packages?site=${siteId}`);}
  const [[usage]]=await db.execute(`SELECT COUNT(*) total,COUNT(DISTINCT site_id) site_count,MIN(site_id) first_site FROM customers WHERE package_id=?`,[id]);
  if(Number(usage.total)>0 && Number(usage.site_count)>1){
    req.session.flash={type:'danger',message:'Paket lama ini masih dipakai pelanggan di lebih dari satu site. Pisahkan paket per site terlebih dahulu sebelum mengubah Site paket.'};
    return res.redirect('/packages');
  }
  if(Number(usage.total)>0 && usage.first_site && Number(usage.first_site)!==siteId){
    req.session.flash={type:'danger',message:'Site paket tidak boleh berbeda dengan site pelanggan yang masih memakai paket ini.'};
    return res.redirect('/packages');
  }
  const [result]=await db.execute(`UPDATE packages SET site_id=?,name=?,speed_label=?,price=?,mikrotik_profile=? WHERE id=?`,[siteId,name,String(b.speed_label||'').trim()||null,price,String(b.mikrotik_profile||'').trim()||null,id]);
  if(!result.affectedRows){req.session.flash={type:'danger',message:'Paket tidak ditemukan.'};return res.redirect('/packages');}
  await audit({userId:req.session.user.id,action:'update',entityType:'package',entityId:id,description:`Update paket ${name} site ${site.code}`,ip:req.ip});
  req.session.flash={type:'success',message:`Paket ${name} berhasil diperbarui.`};
  res.redirect(`/packages?site=${siteId}`);
});

router.post('/:id/toggle', requireAdmin, async(req,res)=>{
  await db.execute(`UPDATE packages SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);
  res.redirect('/packages');
});

// v1.21.0 — Section 3: individual + bulk delete for Paket Internet.
// Safety Validation: a package that's still referenced by ANY customer (not only 'active' ones — every
// customer list/detail query INNER JOINs packages on c.package_id, so leaving even one inactive/suspended
// customer pointed at a deleted package would silently break that customer's row everywhere) is blocked
// from hard delete. The existing `is_active` toggle above already IS this app's package "Arsip" mechanism
// (NONAKTIF badge, hidden from the active-package pickers used at customer create/edit), so the warning
// below offers it explicitly instead of duplicating a second archive flag.
router.post('/:id/delete', requireAdmin, async(req,res)=>{
  const id=Number(req.params.id);
  const [[pkg]]=await db.execute(`SELECT id,name,site_id FROM packages WHERE id=? LIMIT 1`,[id]);
  if(!pkg){req.session.flash={type:'warning',message:'Paket tidak ditemukan.'};return res.redirect('/packages');}
  // v1.22: only NON-archived customers count as "still in use" — an archived customer's package_id
  // reference is historical (their row is already hidden from the active list), and should not block
  // deletion. This fixes a reported bug where "0 pelanggan aktif" still showed this block, because the
  // old query counted archived rows too. See routes/customers.js customerSql() — the packages JOIN was
  // switched to LEFT JOIN so an archived customer whose package is later deleted still renders fine
  // (blank package name) instead of silently vanishing from Data Diarsip.
  const [[usage]]=await db.execute(`SELECT COUNT(*) n FROM customers WHERE package_id=? AND archived_at IS NULL`,[id]);
  if(Number(usage?.n||0)>0){
    req.session.flash={type:'danger',message:`Paket ${pkg.name} masih dipakai ${usage.n} pelanggan aktif dan tidak dapat dihapus permanen. Gunakan tombol Aktif/Nonaktif (Arsipkan Paket) agar paket berhenti ditawarkan tanpa memutus data pelanggan yang sudah memakainya.`};
    return res.redirect('/packages');
  }
  await db.execute(`DELETE FROM packages WHERE id=?`,[id]);
  await audit({userId:req.session.user.id,action:'delete',entityType:'package',entityId:id,description:`Hapus paket ${pkg.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Paket ${pkg.name} dihapus permanen.`};
  res.redirect('/packages');
});

router.post('/bulk', requireAdmin, async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.package_ids||[]).map(x=>Number(x)).filter(Boolean))];
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu paket terlebih dahulu.'};return res.redirect('/packages');}
  if(ids.length>500){req.session.flash={type:'danger',message:'Maksimal 500 paket per aksi massal.'};return res.redirect('/packages');}
  const placeholders=ids.map(()=>'?').join(',');
  if(action==='delete'){
    const [rows]=await db.execute(`SELECT id,name FROM packages WHERE id IN (${placeholders})`,ids);
    if(!rows.length){req.session.flash={type:'warning',message:'Paket terpilih tidak ditemukan.'};return res.redirect('/packages');}
    const rowIds=rows.map(r=>r.id);const rowPlaceholders=rowIds.map(()=>'?').join(',');
    const [usageCounts]=await db.execute(`SELECT package_id,COUNT(*) n FROM customers WHERE package_id IN (${rowPlaceholders}) AND archived_at IS NULL GROUP BY package_id`,rowIds);
    const boundIds=new Set(usageCounts.filter(r=>Number(r.n)>0).map(r=>r.package_id));
    const eligible=rows.filter(r=>!boundIds.has(r.id));
    const skipped=rows.length-eligible.length;
    if(!eligible.length){
      req.session.flash={type:'danger',message:'Semua paket terpilih masih dipakai pelanggan dan tidak dapat dihapus permanen. Gunakan Aktif/Nonaktif untuk menghentikan penawarannya.'};
      return res.redirect('/packages');
    }
    const eligibleIds=eligible.map(r=>r.id);const eligiblePlaceholders=eligibleIds.map(()=>'?').join(',');
    await db.execute(`DELETE FROM packages WHERE id IN (${eligiblePlaceholders})`,eligibleIds);
    await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'package',entityId:null,description:`Hapus massal ${eligible.length} paket: ${eligible.map(r=>r.name).slice(0,20).join(', ')}${eligible.length>20?', ...':''}${skipped?` (${skipped} dilewati karena masih dipakai pelanggan)`:''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${eligible.length} paket dihapus permanen.${skipped?` ${skipped} paket dilewati karena masih dipakai pelanggan — gunakan Aktif/Nonaktif untuk itu.`:''}`};
    return res.redirect('/packages');
  }
  req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};
  res.redirect('/packages');
});
module.exports=router;
