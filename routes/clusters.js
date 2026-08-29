const express=require('express');
const ExcelJS=require('exceljs');
const db=require('../config/db');
const { audit }=require('../services/auditService');
const { requireAdmin }=require('../middleware/auth');
const router=express.Router();

function cellValue(cell){const v=cell?.value;if(v==null)return'';if(typeof v==='object'){if(v.text!=null)return String(v.text);if(v.result!=null)return v.result;if(Array.isArray(v.richText))return v.richText.map(x=>x.text||'').join('');}return v;}
function styleWorkbook(ws){ws.views=[{state:'frozen',ySplit:1}];ws.autoFilter={from:'A1',to:ws.getRow(1).getCell(ws.columnCount).address};ws.getRow(1).eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF6030E0'}};c.border={bottom:{style:'thin',color:{argb:'FFFF433E'}}};});}

router.get('/',async(req,res)=>{
  const site=req.query.site||'';let sql=`SELECT cl.*,s.code site_code,s.name site_name,COUNT(c.id) customers FROM clusters cl JOIN sites s ON s.id=cl.site_id LEFT JOIN customers c ON c.cluster_id=cl.id AND c.customer_status='active' WHERE 1=1`;const params=[];if(site){sql+=` AND s.code=?`;params.push(site);}sql+=` GROUP BY cl.id ORDER BY s.code,cl.name`;
  const [clusters]=await db.execute(sql,params);const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);res.render('clusters/index',{title:'Clustering / ODP',clusters,sites,site});
});

router.get('/template.xlsx',async(req,res)=>{
  const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';const ws=wb.addWorksheet('ODP');
  ws.columns=[['site_code',14],['name',25],['type',14],['capacity_ports',16],['used_ports',14],['latitude',16],['longitude',16],['address',42],['status',16]].map(([header,width])=>({header,key:header,width}));
  ws.addRow({site_code:sites[0]?.code||'KRW',name:'ODP-KRW-001',type:'FTTH',capacity_ports:16,used_ports:0,latitude:'',longitude:'',address:'Alamat / area ODP',status:'active'});styleWorkbook(ws);
  for(let r=2;r<=1000;r++){ws.getCell(`C${r}`).dataValidation={type:'list',formulae:['"FTTH,WIRELESS,OTHER"']};ws.getCell(`I${r}`).dataValidation={type:'list',formulae:['"active,maintenance,inactive"']};}
  const info=wb.addWorksheet('PETUNJUK');info.columns=[{width:24},{width:90}];[['INKAMNET ODP IMPORT','Isi sheet ODP lalu upload di menu Cluster & ODP.'],['WAJIB','site_code, name'],['SITE','Gunakan kode site yang aktif.'],['MODE','Jika site_code + name sudah ada, data akan diperbarui.'],['FORMAT','Gunakan file XLSX. Hapus baris contoh sebelum import data asli.']].forEach(x=>info.addRow(x));
  const ref=wb.addWorksheet('REFERENSI');ref.state='veryHidden';ref.addRow(['SITE_CODE','SITE_NAME']);sites.forEach(x=>ref.addRow([x.code,x.name]));
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="template-cluster-odp-INKAMNET.xlsx"');await wb.xlsx.write(res);res.end();
});

router.get('/export.xlsx',async(req,res)=>{
  const site=req.query.site||'';let sql=`SELECT s.code site_code,cl.name,cl.type,cl.capacity_ports,cl.used_ports,cl.latitude,cl.longitude,cl.address,cl.status FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE 1=1`;const params=[];if(site){sql+=` AND s.code=?`;params.push(site);}sql+=` ORDER BY s.code,cl.name`;const [rows]=await db.execute(sql,params);
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('ODP');ws.columns=[['site_code',14],['name',25],['type',14],['capacity_ports',16],['used_ports',14],['latitude',16],['longitude',16],['address',42],['status',16]].map(([header,width])=>({header,key:header,width}));rows.forEach(r=>ws.addRow(r));styleWorkbook(ws);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="cluster-odp-${site||'ALL'}-${new Date().toISOString().slice(0,10)}.xlsx"`);await wb.xlsx.write(res);res.end();
});

router.post('/import',requireAdmin,async(req,res)=>{
  try{if(!req.file)throw new Error('Pilih file XLSX terlebih dahulu.');const wb=new ExcelJS.Workbook();await wb.xlsx.load(req.file.buffer);const ws=wb.getWorksheet('ODP')||wb.worksheets[0];if(!ws)throw new Error('Sheet ODP tidak ditemukan.');
    const headers={};ws.getRow(1).eachCell((c,i)=>headers[String(cellValue(c)).trim().toLowerCase()]=i);for(const k of ['site_code','name'])if(!headers[k])throw new Error(`Kolom ${k} wajib ada.`);
    const [sites]=await db.query(`SELECT id,code FROM sites WHERE is_active=1`);const siteMap=new Map(sites.map(s=>[s.code.toUpperCase(),s.id]));const data=[],errors=[];
    for(let n=2;n<=ws.rowCount;n++){const row=ws.getRow(n);const get=k=>headers[k]?cellValue(row.getCell(headers[k])):'';const siteCode=String(get('site_code')||'').trim().toUpperCase(),name=String(get('name')||'').trim();if(!siteCode&&!name)continue;const siteId=siteMap.get(siteCode);if(!siteId)errors.push(`Baris ${n}: site ${siteCode} tidak ditemukan`);if(!name)errors.push(`Baris ${n}: name kosong`);const type=String(get('type')||'FTTH').trim().toUpperCase();const status=String(get('status')||'active').trim().toLowerCase();if(!['FTTH','WIRELESS','OTHER'].includes(type))errors.push(`Baris ${n}: type tidak valid`);if(!['active','maintenance','inactive'].includes(status))errors.push(`Baris ${n}: status tidak valid`);data.push({siteId,name,type,capacity:Number(get('capacity_ports')||0)||null,used:Number(get('used_ports')||0)||0,lat:String(get('latitude')||'').trim()||null,lng:String(get('longitude')||'').trim()||null,address:String(get('address')||'').trim()||null,status});}
    if(errors.length){req.session.flash={type:'danger',message:`Import dibatalkan: ${errors.slice(0,8).join(' | ')}`};return res.redirect('/clusters');}if(!data.length)throw new Error('Tidak ada data ODP.');
    const conn=await db.getConnection();let inserted=0,updated=0;try{await conn.beginTransaction();for(const d of data){const [exists]=await conn.execute(`SELECT id FROM clusters WHERE site_id=? AND LOWER(name)=LOWER(?) LIMIT 1`,[d.siteId,d.name]);if(exists.length){await conn.execute(`UPDATE clusters SET type=?,capacity_ports=?,used_ports=?,latitude=?,longitude=?,address=?,status=? WHERE id=?`,[d.type,d.capacity,d.used,d.lat,d.lng,d.address,d.status,exists[0].id]);updated++;}else{await conn.execute(`INSERT INTO clusters(site_id,name,type,capacity_ports,used_ports,latitude,longitude,address,status) VALUES(?,?,?,?,?,?,?,?,?)`,[d.siteId,d.name,d.type,d.capacity,d.used,d.lat,d.lng,d.address,d.status]);inserted++;}}await conn.commit();}catch(e){await conn.rollback();throw e;}finally{conn.release();}
    await audit({userId:req.session.user.id,action:'import',entityType:'cluster',description:`Import ODP: ${inserted} baru, ${updated} update`,ip:req.ip});req.session.flash={type:'success',message:`Import ODP selesai: ${inserted} baru, ${updated} diperbarui.`};res.redirect('/clusters');
  }catch(e){console.error('ODP import gagal:',e.message);req.session.flash={type:'danger',message:`Import ODP gagal: ${e.message}`};res.redirect('/clusters');}
});

// v1.20.1: requireAdmin added to create/delete for consistency with /import (already admin-only) —
// individual create/delete of infrastructure records shouldn't need a lower bar than bulk import.
router.post('/',requireAdmin,async(req,res)=>{const b=req.body;const [r]=await db.execute(`INSERT INTO clusters(site_id,name,type,capacity_ports,used_ports,latitude,longitude,address,status) VALUES(?,?,?,?,?,?,?,?,?)`,[b.site_id,b.name,b.type||'FTTH',b.capacity_ports||null,b.used_ports||0,b.latitude||null,b.longitude||null,b.address||null,b.status||'active']);await audit({userId:req.session.user.id,action:'create',entityType:'cluster',entityId:r.insertId,description:`Tambah cluster ${b.name}`,ip:req.ip});req.session.flash={type:'success',message:'Cluster/ODP berhasil ditambahkan.'};res.redirect('/clusters');});
// v1.25 audit: Cluster/ODP previously had Create + Delete only — a typo'd name/address, wrong capacity,
// or a site mistakenly picked at creation had no fix short of deleting (blocked entirely once any
// customer is attached) and recreating. Edit added, admin-gated to match create/delete/import above.
router.post('/:id/edit',requireAdmin,async(req,res)=>{
  const b=req.body;
  const [[cluster]]=await db.execute(`SELECT id,name FROM clusters WHERE id=? LIMIT 1`,[req.params.id]);
  if(!cluster){req.session.flash={type:'warning',message:'Cluster/ODP tidak ditemukan.'};return res.redirect('/clusters');}
  const name=String(b.name||'').trim();
  if(!name||!b.site_id){req.session.flash={type:'danger',message:'Site dan nama cluster/ODP wajib diisi.'};return res.redirect('/clusters');}
  await db.execute(`UPDATE clusters SET site_id=?,name=?,type=?,capacity_ports=?,used_ports=?,latitude=?,longitude=?,address=?,status=? WHERE id=?`,
    [b.site_id,name,b.type||'FTTH',b.capacity_ports||null,b.used_ports||0,b.latitude||null,b.longitude||null,b.address||null,b.status||'active',req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'cluster',entityId:req.params.id,description:`Update cluster ${name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Cluster/ODP ${name} berhasil diperbarui.`};
  res.redirect('/clusters');
});
// v1.20.1: guard against deleting a cluster/ODP that still has customers attached — previously this
// unconditionally ran DELETE FROM clusters, which would silently orphan every customer.cluster_id
// pointing at the deleted row (broken foreign key reference, cluster_name showing as null everywhere).
router.post('/:id/delete',requireAdmin,async(req,res)=>{
  const [[cluster]]=await db.execute(`SELECT id,name FROM clusters WHERE id=? LIMIT 1`,[req.params.id]);
  if(!cluster){req.session.flash={type:'warning',message:'Cluster/ODP tidak ditemukan.'};return res.redirect('/clusters');}
  const [[bound]]=await db.execute(`SELECT COUNT(*) n FROM customers WHERE cluster_id=?`,[cluster.id]);
  if(Number(bound?.n||0)>0){
    req.session.flash={type:'danger',message:`Cluster/ODP ${cluster.name} masih memiliki ${bound.n} pelanggan terpasang dan tidak dapat dihapus. Pindahkan pelanggan ke cluster lain terlebih dahulu.`};
    return res.redirect('/clusters');
  }
  await db.execute(`DELETE FROM clusters WHERE id=?`,[cluster.id]);
  await audit({userId:req.session.user.id,action:'delete',entityType:'cluster',entityId:cluster.id,description:`Hapus cluster ${cluster.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Cluster/ODP ${cluster.name} dihapus.`};
  res.redirect('/clusters');
});
module.exports=router;
