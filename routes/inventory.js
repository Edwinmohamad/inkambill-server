const express=require('express');
const db=require('../config/db');
const { audit }=require('../services/auditService');
const { requireAdmin }=require('../middleware/auth');
const QRCode=require('qrcode');
const ExcelJS=require('exceljs');
const { syncStockAlert, scanLowStock }=require('../services/inventoryService');
const insight=require('../services/inventoryInsightService');
const router=express.Router();
const backTo=(req,fallback='/inventory')=>{const r=String(req.body?.return_to||'');return /^\/inventory(\/|\?|$)/.test(r)&&!r.startsWith('//')?r:fallback;};

// v1.25.5 (susulan #13) — return-context helpers for the Pergerakan Stock & Pemakaian Material filters,
// same reconstruct-from-hidden-fields pattern already used by Data Kas/Router MikroTik: every mutating
// action (delete/bulk) redirects back carrying whatever filter was active so the user doesn't lose context.
function movementsReturn(src){
  const item=src.return_item||'',type=src.return_type||'',dateFrom=src.return_date_from||'',dateTo=src.return_date_to||'',q=src.return_q||'';
  const p=new URLSearchParams();if(item)p.set('item',item);if(type)p.set('type',type);if(dateFrom)p.set('date_from',dateFrom);if(dateTo)p.set('date_to',dateTo);if(q)p.set('q',q);
  return `/inventory/movements${p.toString()?`?${p.toString()}`:''}`;
}
function usageReturn(src){
  const item=src.return_item||'',site=src.return_site||'',purpose=src.return_purpose||'',dateFrom=src.return_date_from||'',dateTo=src.return_date_to||'',q=src.return_q||'';
  const p=new URLSearchParams();if(item)p.set('item',item);if(site)p.set('site',site);if(purpose)p.set('purpose',purpose);if(dateFrom)p.set('date_from',dateFrom);if(dateTo)p.set('date_to',dateTo);if(q)p.set('q',q);
  return `/inventory/usage${p.toString()?`?${p.toString()}`:''}`;
}

router.get('/',async(req,res)=>{
  // v1.26 — Stock Monitoring: filter lengkap (cari/kategori/supplier/status), tab status, estimasi habis,
  // sparkline 30 hari, "Perlu Tindakan Hari Ini", gauge kesehatan stock, dan timeline aktivitas.
  const site=req.query.site||'';
  const q=String(req.query.q||'').trim();
  const category=String(req.query.category||'');
  const supplier=String(req.query.supplier||'');
  const status=['low','critical','soon','dead','ready','empty','action'].includes(req.query.status)?req.query.status:'';
  const sort=['name','qty','days','value','moved'].includes(req.query.sort)?req.query.sort:'';
  const all=await insight.enrichItems(await insight.loadItems({site}));
  const summary=insight.summarize(all);
  const scoped=all.filter(i=>(!category||String(i.category_id||'')===category||(category==='none'&&!i.category_id&&!i.category_name))&&(!supplier||String(i.supplier_id||'')===supplier));
  const tabCounts=insight.summarize(scoped).counts;
  const needle=q.toLowerCase();
  let items=scoped.filter(i=>{
    if(needle&&![i.name,i.item_code,i.barcode,i.location,i.category_name,i.supplier_name].some(v=>String(v||'').toLowerCase().includes(needle)))return false;
    if(status==='low')return i.status==='low';
    if(status==='critical')return i.status==='critical';
    if(status==='soon')return i.soon;
    if(status==='dead')return i.dead;
    if(status==='ready')return i.status==='ready';
    if(status==='empty')return i.qty<=0;
    if(status==='action')return i.needsAction;
    return true;
  });
  const cmp={name:(a,b)=>a.name.localeCompare(b.name),qty:(a,b)=>a.qty-b.qty,days:(a,b)=>(a.daysLeft??1e9)-(b.daysLeft??1e9),value:(a,b)=>b.value-a.value,moved:(a,b)=>(a.lastMoveDays??1e9)-(b.lastMoveDays??1e9)};
  items.sort(sort?cmp[sort]:(a,b)=>b.urgency-a.urgency||a.name.localeCompare(b.name));
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);const [suppliers]=await db.query(`SELECT id,name FROM suppliers WHERE is_active=1 ORDER BY name`);const [categories]=await db.query(`SELECT id,name FROM inventory_categories WHERE is_active=1 ORDER BY name`);const [allCategories]=await db.query(`SELECT id,name,is_active FROM inventory_categories ORDER BY is_active DESC,name`);
  const activity=await insight.recentActivity(12,{site});
  res.render('inventory/index',{title:'Stock Barang',items,allItems:all,currentUrl:req.originalUrl,sites,suppliers,categories,allCategories,summary,tabCounts,activity,site,filters:{q,category,supplier,status,sort},sparkSvg:insight.sparkSvg,daysLeftLabel:insight.daysLeftLabel,soonDays:insight.SOON_DAYS,deadDays:insight.DEAD_DAYS});
});
// v1.25.9 — Export / Import XLSX Stock Barang, supaya input barang dalam jumlah banyak tidak perlu
// submit satu per satu. Pola sama dengan Cluster/ODP (template → isi → upload). Kolom qty diperlakukan
// sebagai STOCK AKHIR: selisihnya dicatat otomatis sebagai inventory_movements (IMPORT-XLSX) sehingga
// saldo tetap sinkron dengan riwayat pergerakan/audit trail (qty tidak pernah diubah langsung tanpa movement).
const INV_COLUMNS=[['item_code',16],['name',32],['category',20],['site_code',12],['supplier',22],['qty',10],['unit',10],['min_stock',12],['purchase_price',16],['barcode',20],['location',16],['notes',36]];
function invCell(cell){const v=cell?.value;if(v==null)return'';if(v instanceof Date)return v.toISOString().slice(0,10);if(typeof v==='object'){if(v.text!=null)return String(v.text);if(v.result!=null)return v.result;if(Array.isArray(v.richText))return v.richText.map(x=>x.text||'').join('');}return v;}
function invStyle(ws){ws.views=[{state:'frozen',ySplit:1}];ws.autoFilter={from:'A1',to:ws.getRow(1).getCell(ws.columnCount).address};ws.getRow(1).eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF6030E0'}};c.border={bottom:{style:'thin',color:{argb:'FFFF433E'}}};});}
function invNum(v){if(v===''||v==null)return null;const n=Number(String(v).replace(/,/g,'.').replace(/[^0-9.\-]/g,''));return Number.isFinite(n)?n:NaN;}
function invSend(res,wb,filename){res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);return wb.xlsx.write(res).then(()=>res.end());}

router.get('/template.xlsx',async(req,res)=>{
  const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const [cats]=await db.query(`SELECT name FROM inventory_categories WHERE is_active=1 ORDER BY name`);
  const [sups]=await db.query(`SELECT name FROM suppliers WHERE is_active=1 ORDER BY name`);
  const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';
  const ws=wb.addWorksheet('STOCK');ws.columns=INV_COLUMNS.map(([header,width])=>({header,key:header,width}));
  ws.addRow({item_code:'ONT-HSGQ',name:'ONT HSGQ XPON',category:cats[0]?.name||'ONT',site_code:sites[0]?.code||'',supplier:sups[0]?.name||'',qty:10,unit:'pcs',min_stock:3,purchase_price:250000,barcode:'',location:'Rak A1',notes:'Contoh — hapus baris ini'});
  invStyle(ws);
  const info=wb.addWorksheet('PETUNJUK');info.columns=[{width:22},{width:100}];
  [['INKAMNET STOCK IMPORT','Isi sheet STOCK lalu upload lewat tombol Import XLSX di menu Stock Barang.'],
   ['WAJIB','name'],
   ['PENCOCOKAN','Barang dicocokkan berdasarkan item_code. Jika item_code kosong, dicocokkan berdasarkan name + site_code. Jika cocok → diperbarui, jika tidak → barang baru.'],
   ['QTY','qty = jumlah stock AKHIR. Selisih dengan stock sekarang dicatat otomatis di Pergerakan Stock (referensi IMPORT-XLSX). Kosongkan qty jika tidak ingin mengubah stock.'],
   ['SITE','Isi kode site aktif, atau kosongkan untuk Global.'],
   ['KATEGORI','Nama kategori. Kategori yang belum ada akan dibuat otomatis.'],
   ['SUPPLIER','Nama supplier yang sudah terdaftar (boleh kosong).'],
   ['TIPS','Cara termudah: Export XLSX dulu, edit di Excel, lalu Import kembali file yang sama.'],
   ['SITE AKTIF',sites.map(s=>s.code).join(', ')||'-'],
   ['SUPPLIER AKTIF',sups.map(s=>s.name).join(', ')||'-']].forEach(x=>info.addRow(x));
  info.getColumn(2).alignment={wrapText:true,vertical:'top'};
  await invSend(res,wb,'template-stock-barang-INKAMNET.xlsx');
});

router.get('/export.xlsx',async(req,res)=>{
  const site=req.query.site||'';
  let sql=`SELECT i.item_code,i.name,COALESCE(ic.name,i.category) category,s.code site_code,sp.name supplier,i.qty,i.unit,i.min_stock,i.purchase_price,i.barcode,i.location,i.notes FROM inventory_items i LEFT JOIN inventory_categories ic ON ic.id=i.category_id LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id WHERE i.is_active=1 AND i.deleted_at IS NULL`;const params=[];
  if(site){sql+=` AND s.code=?`;params.push(site);}sql+=` ORDER BY i.name`;
  const [rows]=await db.execute(sql,params);
  const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';const ws=wb.addWorksheet('STOCK');ws.columns=INV_COLUMNS.map(([header,width])=>({header,key:header,width}));
  rows.forEach(r=>ws.addRow({...r,qty:Number(r.qty||0),min_stock:Number(r.min_stock||0),purchase_price:Number(r.purchase_price||0)}));invStyle(ws);
  await invSend(res,wb,`stock-barang-${site||'ALL'}-${new Date().toISOString().slice(0,10)}.xlsx`);
});

router.post('/import',async(req,res)=>{
  try{
    if(!req.file)throw new Error('Pilih file XLSX terlebih dahulu.');
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(req.file.buffer);
    const ws=wb.getWorksheet('STOCK')||wb.worksheets[0];if(!ws)throw new Error('Sheet STOCK tidak ditemukan.');
    const headers={};ws.getRow(1).eachCell((c,i)=>headers[String(invCell(c)).trim().toLowerCase()]=i);
    if(!headers.name)throw new Error('Kolom name wajib ada.');
    const [sites]=await db.query(`SELECT id,code FROM sites WHERE is_active=1`);const siteMap=new Map(sites.map(s=>[String(s.code).toUpperCase(),s.id]));
    const [sups]=await db.query(`SELECT id,name FROM suppliers WHERE is_active=1`);const supMap=new Map(sups.map(s=>[String(s.name).trim().toLowerCase(),s.id]));
    const data=[],errors=[],seen=new Set();
    for(let n=2;n<=ws.rowCount;n++){
      const row=ws.getRow(n);const get=k=>headers[k]?invCell(row.getCell(headers[k])):'';const str=k=>String(get(k)??'').trim();
      const name=str('name'),code=str('item_code');if(!name&&!code)continue;
      if(!name){errors.push(`Baris ${n}: name kosong`);continue;}
      const siteCode=str('site_code').toUpperCase();let siteId=null;if(siteCode){siteId=siteMap.get(siteCode);if(!siteId)errors.push(`Baris ${n}: site ${siteCode} tidak ditemukan`);}
      const supName=str('supplier');let supplierId=null;if(supName){supplierId=supMap.get(supName.toLowerCase());if(!supplierId)errors.push(`Baris ${n}: supplier "${supName}" tidak terdaftar`);}
      const qty=invNum(get('qty')),minStock=invNum(get('min_stock')),price=invNum(get('purchase_price'));
      for(const [k,v] of [['qty',qty],['min_stock',minStock],['purchase_price',price]])if(Number.isNaN(v)||(v!=null&&v<0))errors.push(`Baris ${n}: ${k} tidak valid`);
      const key=code?`c:${code.toLowerCase()}`:`n:${name.toLowerCase()}|${siteId||0}`;if(seen.has(key))errors.push(`Baris ${n}: duplikat ${code||name} di file`);seen.add(key);
      data.push({n,code:code||null,name,category:str('category')||null,siteId,supplierId,qty,unit:str('unit')||'pcs',minStock:minStock??0,price:price??0,barcode:str('barcode')||null,location:str('location')||null,notes:str('notes')||null});
    }
    if(errors.length){req.session.flash={type:'danger',message:`Import dibatalkan (tidak ada data yang disimpan): ${errors.slice(0,8).join(' | ')}${errors.length>8?` | +${errors.length-8} error lain`:''}`};return res.redirect('/inventory');}
    if(!data.length)throw new Error('Tidak ada data barang di file.');
    const conn=await db.getConnection();let inserted=0,updated=0,moved=0;const touched=new Set();const userId=req.session.user.id;
    try{
      await conn.beginTransaction();
      const catCache=new Map();
      const catId=async name=>{if(!name)return null;const k=name.toLowerCase();if(catCache.has(k))return catCache.get(k);let [[c]]=await conn.execute(`SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1`,[name]);if(!c){const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,130)||`kategori-${Date.now()}`;const [r]=await conn.execute(`INSERT INTO inventory_categories(name,slug,created_by) VALUES(?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,[name,slug,userId]);c={id:r.insertId};}catCache.set(k,c.id);return c.id;};
      for(const d of data){
        const categoryId=await catId(d.category);
        let existing;
        if(d.code)[[existing]]=await conn.execute(`SELECT id,qty FROM inventory_items WHERE LOWER(item_code)=LOWER(?) AND is_active=1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,[d.code]);
        else [[existing]]=await conn.execute(`SELECT id,qty FROM inventory_items WHERE LOWER(name)=LOWER(?) AND (site_id<=>?) AND is_active=1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,[d.name,d.siteId]);
        if(existing){
          await conn.execute(`UPDATE inventory_items SET item_code=?,name=?,category=?,category_id=?,barcode=?,site_id=?,supplier_id=?,unit=?,min_stock=?,purchase_price=?,location=?,notes=? WHERE id=?`,[d.code,d.name,d.category,categoryId,d.barcode,d.siteId,d.supplierId,d.unit,d.minStock,d.price,d.location,d.notes,existing.id]);
          if(d.qty!=null){const oldQty=Number(existing.qty||0);const delta=Math.round((d.qty-oldQty)*100)/100;if(delta!==0){await conn.execute(`UPDATE inventory_items SET qty=? WHERE id=?`,[d.qty,existing.id]);await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,?,?,?,?,?)`,[existing.id,delta<0?'out':'adjustment',Math.abs(delta),'IMPORT-XLSX',`Import XLSX: stock ${oldQty} → ${d.qty}`,userId]);moved++;}}
          updated++;touched.add(existing.id);
        }else{
          const qty=d.qty??0;
          const [r]=await conn.execute(`INSERT INTO inventory_items(item_code,name,category,category_id,barcode,site_id,supplier_id,qty,unit,min_stock,purchase_price,location,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[d.code,d.name,d.category,categoryId,d.barcode,d.siteId,d.supplierId,qty,d.unit,d.minStock,d.price,d.location,d.notes]);
          if(qty>0){await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,'in',?,?,?,?)`,[r.insertId,qty,'OPENING-STOCK','Saldo awal dari Import XLSX',userId]);moved++;}
          inserted++;touched.add(r.insertId);
        }
      }
      await conn.commit();
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
    for(const id of touched){try{await syncStockAlert(id);}catch(e){console.error('Stock alert import gagal:',e.message);}}
    await audit({userId:req.session.user.id,action:'import',entityType:'inventory',entityId:null,description:`Import Stock Barang XLSX: ${inserted} baru, ${updated} diperbarui, ${moved} pergerakan stock`,ip:req.ip});
    req.session.flash={type:'success',message:`Import Stock Barang selesai: ${inserted} barang baru, ${updated} diperbarui, ${moved} pergerakan stock tercatat.`};
    res.redirect('/inventory');
  }catch(e){console.error('Import stock gagal:',e.message);req.session.flash={type:'danger',message:`Import Stock Barang gagal: ${e.message}`};res.redirect('/inventory');}
});

router.post('/',async(req,res)=>{const b=req.body;const name=String(b.name||'').trim();if(!name){req.session.flash={type:'danger',message:'Nama item wajib diisi.'};return res.redirect('/inventory');}const conn=await db.getConnection();try{await conn.beginTransaction();const [r]=await conn.execute(`INSERT INTO inventory_items(item_code,name,category,category_id,barcode,qr_payload,site_id,supplier_id,qty,unit,min_stock,purchase_price,location,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[b.item_code||null,name,b.category||null,Number(b.category_id)||null,b.barcode||null,b.qr_payload||null,b.site_id||null,b.supplier_id||null,Math.max(0,Number(b.qty||0)),b.unit||'pcs',Math.max(0,Number(b.min_stock||0)),Math.max(0,Number(b.purchase_price||0)),b.location||null,b.notes||null]);const initial=Number(b.qty||0);if(initial>0)await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,'in',?,?,?,?)`,[r.insertId,initial,'OPENING-STOCK','Saldo awal saat item dibuat',req.session.user.id]);await conn.commit();await syncStockAlert(r.insertId);await audit({userId:req.session.user.id,action:'create',entityType:'inventory',entityId:r.insertId,description:`Tambah stock ${name}`,ip:req.ip});req.session.flash={type:'success',message:'Item gudang ditambahkan.'};res.redirect('/inventory');}catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Gagal menambah item: ${e.message}`};res.redirect('/inventory');}finally{conn.release();}});
// v1.25 audit: item name/category/min_stock/purchase_price/location/supplier had no edit at all —
// deliberately does NOT touch `qty` here, since quantity is only ever changed through /:id/adjust so
// every change stays reconciled against an inventory_movements row (editing qty directly here would
// silently desync the running total from the movement history/audit trail).
router.post('/:id/edit',async(req,res)=>{
  const b=req.body;
  const [[item]]=await db.execute(`SELECT id,name FROM inventory_items WHERE id=? LIMIT 1`,[req.params.id]);
  if(!item){req.session.flash={type:'warning',message:'Item gudang tidak ditemukan.'};return res.redirect('/inventory');}
  const name=String(b.name||'').trim();
  if(!name){req.session.flash={type:'danger',message:'Nama item wajib diisi.'};return res.redirect('/inventory');}
  await db.execute(`UPDATE inventory_items SET item_code=?,name=?,category=?,category_id=?,barcode=?,site_id=?,supplier_id=?,unit=?,min_stock=?,purchase_price=?,location=?,notes=? WHERE id=?`,
    [b.item_code||null,name,b.category||null,Number(b.category_id)||null,b.barcode||null,b.site_id||null,b.supplier_id||null,b.unit||'pcs',Math.max(0,Number(b.min_stock||0)),Math.max(0,Number(b.purchase_price||0)),b.location||null,b.notes||null,req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'inventory',entityId:req.params.id,description:`Update item ${name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Item ${name} berhasil diperbarui.`};
  res.redirect(backTo(req));
});
router.post('/:id/delete',requireAdmin,async(req,res)=>{const [[item]]=await db.query(`SELECT id,name,qty FROM inventory_items WHERE id=? AND deleted_at IS NULL LIMIT 1`,[req.params.id]);if(!item){req.session.flash={type:'warning',message:'Item gudang tidak ditemukan.'};return res.redirect('/inventory');}if(Number(item.qty)>0){req.session.flash={type:'danger',message:'Item masih memiliki stock. Kosongkan stock atau lakukan penyesuaian terlebih dahulu.'};return res.redirect('/inventory');}await db.execute(`UPDATE inventory_items SET is_active=0,deleted_at=NOW() WHERE id=?`,[item.id]);await audit({userId:req.session.user.id,action:'archive',entityType:'inventory',entityId:item.id,description:`Arsipkan item ${item.name}`,ip:req.ip});req.session.flash={type:'success',message:`Item ${item.name} diarsipkan.`};res.redirect('/inventory');});
router.get('/:id/qr',async(req,res)=>{const [[item]]=await db.query(`SELECT id,item_code,name,barcode,qr_payload FROM inventory_items WHERE id=? AND deleted_at IS NULL LIMIT 1`,[req.params.id]);if(!item)return res.status(404).send('Item tidak ditemukan.');const payload=item.qr_payload||JSON.stringify({id:item.id,code:item.item_code||null,name:item.name,barcode:item.barcode||null});res.type('png').send(await QRCode.toBuffer(payload,{type:'png',width:420,margin:2,errorCorrectionLevel:'M'}));});
router.post('/categories',requireAdmin,async(req,res)=>{const name=String(req.body.name||'').trim();if(!name){req.session.flash={type:'danger',message:'Nama kategori wajib diisi.'};return res.redirect('/inventory');}const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,130)||`kategori-${Date.now()}`;try{await db.execute(`INSERT INTO inventory_categories(name,slug,created_by) VALUES(?,?,?)`,[name,slug,req.session.user.id]);req.session.flash={type:'success',message:'Kategori inventory ditambahkan.'};}catch(e){req.session.flash={type:'danger',message:e.code==='ER_DUP_ENTRY'?'Kategori sudah ada.':e.message};}res.redirect('/inventory');});
router.post('/categories/:id/edit',requireAdmin,async(req,res)=>{const name=String(req.body.name||'').trim();if(name)await db.execute(`UPDATE inventory_categories SET name=? WHERE id=?`,[name,req.params.id]);res.redirect('/inventory');});
router.post('/categories/:id/toggle',requireAdmin,async(req,res)=>{await db.execute(`UPDATE inventory_categories SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/inventory');});
router.post('/:id/adjust',async(req,res)=>{const qty=Math.abs(Number(req.body.qty||0));const type=['in','out','adjustment'].includes(req.body.movement_type)?req.body.movement_type:'adjustment';if(!qty){req.session.flash={type:'danger',message:'Qty harus lebih dari 0.'};return res.redirect(backTo(req));}const signed=type==='out'?-qty:qty;const conn=await db.getConnection();try{await conn.beginTransaction();const [[item]]=await conn.query(`SELECT id,name,qty FROM inventory_items WHERE id=? AND is_active=1 AND deleted_at IS NULL FOR UPDATE`,[req.params.id]);if(!item)throw new Error('Item tidak ditemukan.');if(Number(item.qty)+signed<0)throw new Error(`Stock ${item.name} tidak cukup.`);await conn.execute(`UPDATE inventory_items SET qty=qty+? WHERE id=?`,[signed,req.params.id]);await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,?,?,?,?,?)`,[req.params.id,type,qty,req.body.reference||null,req.body.notes||null,req.session.user.id]);await conn.commit();await syncStockAlert(req.params.id);req.session.flash={type:'success',message:'Stock berhasil diperbarui.'};}catch(e){await conn.rollback();req.session.flash={type:'danger',message:e.message};}finally{conn.release();}res.redirect(backTo(req));});

// ───────────── v1.26 — Stock Monitoring pages ─────────────
router.get('/insights',async(req,res)=>{
  const site=req.query.site||'';
  const items=await insight.enrichItems(await insight.loadItems({site}));
  const summary=insight.summarize(items);
  const data=await insight.analytics(items,{site});
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('inventory/insights',{title:'Analitik Gudang',site,sites,summary,data,deadDays:insight.DEAD_DAYS,daysLeftLabel:insight.daysLeftLabel});
});

router.get('/reorder',async(req,res)=>{
  const site=req.query.site||'';
  const items=await insight.enrichItems(await insight.loadItems({site}));
  const plan=insight.reorderSuggestions(items,req.query.cover);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('inventory/reorder',{title:'Saran Pembelian',site,sites,plan,highlight:Number(req.query.item)||0,daysLeftLabel:insight.daysLeftLabel});
});
router.get('/reorder.xlsx',async(req,res)=>{
  const site=req.query.site||'';
  const items=await insight.enrichItems(await insight.loadItems({site}));
  const plan=insight.reorderSuggestions(items,req.query.cover);
  const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';
  const cols=[['supplier',24],['item_code',16],['name',32],['site_code',10],['stock_now',11],['min_stock',11],['pemakaian_per_hari',18],['estimasi_habis',16],['saran_beli',12],['unit',8],['harga_beli',14],['estimasi_biaya',16]];
  const addSheet=(name,rows)=>{const ws=wb.addWorksheet(name.slice(0,31).replace(/[\\/*?:[\]]/g,'-'));ws.columns=cols.map(([header,width])=>({header,key:header,width}));rows.forEach(r=>ws.addRow({supplier:r.supplier_name||'Tanpa Supplier',item_code:r.item_code,name:r.name,site_code:r.site_code||'GLOBAL',stock_now:r.qty,min_stock:r.min_stock,pemakaian_per_hari:r.avgDaily,estimasi_habis:insight.daysLeftLabel(r),saran_beli:r.suggest,unit:r.unit,harga_beli:r.purchase_price,estimasi_biaya:r.cost}));invStyle(ws);ws.getColumn('harga_beli').numFmt='#,##0';ws.getColumn('estimasi_biaya').numFmt='#,##0';};
  addSheet('SEMUA',plan.rows);
  plan.groups.forEach(g=>addSheet(g.supplier,g.rows));
  await invSend(res,wb,`saran-pembelian-${site||'ALL'}-${new Date().toISOString().slice(0,10)}.xlsx`);
});

router.get('/opname',async(req,res)=>{
  const site=req.query.site||'';const category=String(req.query.category||'');
  let items=await insight.loadItems({site});
  if(category)items=items.filter(i=>String(i.category_id||'')===category);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const [categories]=await db.query(`SELECT id,name FROM inventory_categories WHERE is_active=1 ORDER BY name`);
  res.render('inventory/opname',{title:'Stock Opname',items,sites,categories,site,category});
});
router.post('/opname',async(req,res)=>{
  const counts=req.body.counts&&typeof req.body.counts==='object'?req.body.counts:{};
  const ref=String(req.body.reference||'').trim()||`OPNAME-${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
  const note=String(req.body.notes||'').trim();
  const back=req.body.return_to&&String(req.body.return_to).startsWith('/inventory')?String(req.body.return_to):'/inventory/opname';
  const entries=Object.entries(counts).map(([id,v])=>[Number(String(id).replace(/^i/,'')),String(v??'').trim()]).filter(([id,v])=>id&&v!=='');
  if(!entries.length){req.session.flash={type:'warning',message:'Belum ada jumlah fisik yang diisi.'};return res.redirect(back);}
  const bad=entries.filter(([,v])=>!Number.isFinite(Number(v.replace(',','.')))||Number(v.replace(',','.'))<0);
  if(bad.length){req.session.flash={type:'danger',message:`Opname dibatalkan: ${bad.length} jumlah fisik tidak valid.`};return res.redirect(back);}
  const conn=await db.getConnection();let checked=0,changed=0,plus=0,minus=0;const touched=[];
  try{
    await conn.beginTransaction();
    for(const [id,v] of entries){
      const physical=Math.round(Number(v.replace(',','.'))*100)/100;
      const [[item]]=await conn.execute(`SELECT id,name,qty FROM inventory_items WHERE id=? AND is_active=1 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,[id]);
      if(!item)continue;checked++;
      const oldQty=Number(item.qty||0);const delta=Math.round((physical-oldQty)*100)/100;
      if(delta===0)continue;
      await conn.execute(`UPDATE inventory_items SET qty=? WHERE id=?`,[physical,id]);
      await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,?,?,?,?,?)`,[id,delta<0?'out':'adjustment',Math.abs(delta),ref,`Stock opname: sistem ${oldQty} → fisik ${physical}${note?` · ${note}`:''}`,req.session.user.id]);
      changed++;if(delta>0)plus+=delta;else minus+=-delta;touched.push(id);
    }
    await conn.commit();
  }catch(e){await conn.rollback();conn.release();req.session.flash={type:'danger',message:`Opname gagal: ${e.message}`};return res.redirect(back);}
  conn.release();
  for(const id of touched){try{await syncStockAlert(id);}catch(_){}}
  await audit({userId:req.session.user.id,action:'opname',entityType:'inventory',entityId:null,description:`Stock opname ${ref}: ${checked} dihitung, ${changed} selisih (+${plus} / -${minus})`,ip:req.ip});
  req.session.flash={type:'success',message:`Stock opname tersimpan: ${checked} barang dihitung, ${changed} ada selisih (+${plus} / −${minus}). Referensi ${ref}.`};
  res.redirect(back);
});

router.get('/wall',async(req,res)=>{
  const site=req.query.site||'';
  const items=await insight.enrichItems(await insight.loadItems({site}));
  const summary=insight.summarize(items);
  const activity=await insight.recentActivity(14,{site});
  const [[today]]=await db.query(`SELECT COALESCE(SUM(CASE WHEN movement_type='out' THEN qty ELSE 0 END),0) out_qty,COALESCE(SUM(CASE WHEN movement_type<>'out' THEN qty ELSE 0 END),0) in_qty,COUNT(*) n FROM inventory_movements WHERE DATE(created_at)=CURDATE()`);
  res.render('inventory/wall',{layout:false,title:'Layar Gudang',site,summary,activity,today:today||{},daysLeftLabel:insight.daysLeftLabel,soonDays:insight.SOON_DAYS});
});

router.get('/labels',async(req,res)=>{
  const ids=[...new Set(String(req.query.ids||'').split(',').map(Number).filter(Boolean))].slice(0,200);
  let rows=[];
  if(ids.length){const [r]=await db.query(`SELECT i.id,i.item_code,i.name,i.barcode,i.qr_payload,i.location,i.unit,s.code site_code FROM inventory_items i LEFT JOIN sites s ON s.id=i.site_id WHERE i.id IN (${ids.map(()=>'?').join(',')}) AND i.deleted_at IS NULL ORDER BY i.name`,ids);rows=r;}
  const copies=Math.max(1,Math.min(20,Number(req.query.copies)||1));
  const labels=[];
  for(const item of rows){const payload=item.qr_payload||JSON.stringify({id:item.id,code:item.item_code||null,name:item.name,barcode:item.barcode||null});const qr=await QRCode.toDataURL(payload,{width:260,margin:1,errorCorrectionLevel:'M'});for(let c=0;c<copies;c++)labels.push({...item,qr});}
  res.render('inventory/labels',{layout:false,title:'Label QR Barang',labels,copies,ids:ids.join(',')});
});

router.post('/wa-digest',async(req,res)=>{
  try{const r=await insight.sendStockDigest({force:true});req.session.flash=r.sent?{type:'success',message:`Ringkasan stock dikirim ke ${r.sent} nomor WhatsApp (masuk antrean WA Gateway).`}:{type:'warning',message:`Ringkasan tidak terkirim: ${r.reason||'WA Gateway gagal menerima pesan.'}`};}
  catch(e){req.session.flash={type:'danger',message:`Gagal mengirim ringkasan: ${e.message}`};}
  res.redirect('/inventory');
});

router.get('/movements',async(req,res)=>{
  // v1.25.5 (susulan #13) — filter Barang/Type/Tanggal/Referensi, agar daftar yang sebelumnya selalu
  // terpotong 300 baris tanpa cara menyempitkannya bisa ditelusuri per barang atau per rentang tanggal.
  const item=Number(req.query.item)||'';
  const type=['in','out','adjustment'].includes(req.query.type)?req.query.type:'';
  const dateFrom=/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from||'')?req.query.date_from:'';
  const dateTo=/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to||'')?req.query.date_to:'';
  const q=String(req.query.q||'').trim();
  let sql=`SELECT m.*,i.name item_name,i.item_code,i.unit,u.name user_name FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN users u ON u.id=m.user_id WHERE 1=1`;
  const params=[];
  if(item){sql+=` AND m.item_id=?`;params.push(item);}
  if(type){sql+=` AND m.movement_type=?`;params.push(type);}
  if(dateFrom){sql+=` AND DATE(m.created_at)>=?`;params.push(dateFrom);}
  if(dateTo){sql+=` AND DATE(m.created_at)<=?`;params.push(dateTo);}
  if(q){sql+=` AND (m.reference LIKE ? OR m.notes LIKE ? OR i.name LIKE ?)`;const like=`%${q}%`;params.push(like,like,like);}
  sql+=` ORDER BY m.id DESC LIMIT 300`;
  const [movements]=await db.query(sql,params);
  const [items]=await db.query(`SELECT id,name,item_code FROM inventory_items WHERE is_active=1 AND deleted_at IS NULL ORDER BY name`);
  const [[today]]=await db.query(`SELECT COALESCE(SUM(CASE WHEN movement_type='in' THEN qty ELSE 0 END),0) stock_in,COALESCE(SUM(CASE WHEN movement_type='out' THEN qty ELSE 0 END),0) stock_out,COUNT(*) movements FROM inventory_movements WHERE DATE(created_at)=CURDATE()`);
  res.render('inventory/movements',{title:'Pergerakan Stock',movements,today:today||{},items,filters:{item,type,date_from:dateFrom,date_to:dateTo,q}});
});
// v1.25.5 — "Hapus Entri" (koreksi): menghapus satu baris riwayat pergerakan stock MEMBALIK efek qty-nya
// ke inventory_items (bukan cuma menghapus barisnya), supaya saldo stock tidak pernah nyangkut salah
// gara-gara entri riwayat yang keliru dihapus tanpa dikoreksi baliknya. 'out' mengurangi stock ketika
// dibuat (lihat POST /:id/adjust di atas — hanya 'out' yang mengurangi, 'in'/'adjustment' menambah), jadi
// menghapusnya berarti mengembalikan qty; sebaliknya untuk 'in'/'adjustment'. Cara mengoreksi entri yang
// salah adalah: hapus entri yang keliru (stock otomatis kembali), lalu catat ulang entri yang benar.
router.post('/movements/:id/delete',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  let deleted=null,itemName=null;
  try{
    await conn.beginTransaction();
    const [[m]]=await conn.execute(`SELECT id,item_id,movement_type,qty FROM inventory_movements WHERE id=? LIMIT 1 FOR UPDATE`,[req.params.id]);
    if(!m){await conn.rollback();conn.release();req.session.flash={type:'warning',message:'Entri pergerakan stock tidak ditemukan.'};return res.redirect(movementsReturn(req.body));}
    const [[item]]=await conn.execute(`SELECT id,name FROM inventory_items WHERE id=? LIMIT 1 FOR UPDATE`,[m.item_id]);
    if(item){
      const revert=m.movement_type==='out'?Number(m.qty):-Number(m.qty);
      await conn.execute(`UPDATE inventory_items SET qty=GREATEST(0,qty+?) WHERE id=?`,[revert,m.item_id]);
    }
    await conn.execute(`DELETE FROM inventory_movements WHERE id=?`,[req.params.id]);
    await conn.commit();
    deleted=m;itemName=item?.name||null;
  }catch(e){
    await conn.rollback();conn.release();
    req.session.flash={type:'danger',message:`Gagal menghapus entri: ${e.message}`};
    return res.redirect(movementsReturn(req.body));
  }
  conn.release();
  await audit({userId:req.session.user.id,action:'delete',entityType:'inventory_movement',entityId:req.params.id,description:`Hapus entri pergerakan stock #${req.params.id} (${deleted.movement_type} ${deleted.qty} · ${itemName||'item dihapus'}) — saldo stock otomatis dikoreksi balik`,ip:req.ip});
  req.session.flash={type:'success',message:'Entri pergerakan stock dihapus dan saldo stock otomatis dikoreksi.'};
  res.redirect(movementsReturn(req.body));
});
router.post('/movements/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.movement_ids||[]).map(x=>Number(x)).filter(Boolean))];
  const returnCtx=movementsReturn({...req.query,...req.body});
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu entri terlebih dahulu.'};return res.redirect(returnCtx);}
  if(action!=='delete'){req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};return res.redirect(returnCtx);}
  let done=0;
  for(const id of ids){
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[m]]=await conn.execute(`SELECT id,item_id,movement_type,qty FROM inventory_movements WHERE id=? LIMIT 1 FOR UPDATE`,[id]);
      if(!m){await conn.rollback();conn.release();continue;}
      const revert=m.movement_type==='out'?Number(m.qty):-Number(m.qty);
      await conn.execute(`UPDATE inventory_items SET qty=GREATEST(0,qty+?) WHERE id=?`,[revert,m.item_id]);
      await conn.execute(`DELETE FROM inventory_movements WHERE id=?`,[id]);
      await conn.commit();
      done++;
    }catch(e){await conn.rollback();}finally{conn.release();}
  }
  if(done)await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'inventory_movement',entityId:null,description:`Hapus massal ${done} entri pergerakan stock — saldo stock otomatis dikoreksi balik`,ip:req.ip});
  req.session.flash={type:done?'success':'warning',message:done?`${done} entri pergerakan stock dihapus, saldo stock otomatis dikoreksi.`:'Tidak ada entri yang berhasil dihapus.'};
  res.redirect(returnCtx);
});

router.get('/usage',async(req,res)=>{
  // v1.25.5 (susulan #13) — filter Barang/Site/Purpose/Tanggal/pencarian, agar daftar yang sebelumnya
  // selalu terpotong 250 baris tanpa cara menyempitkannya bisa ditelusuri per barang, site, atau tujuan.
  const item=Number(req.query.item)||'';
  const site=String(req.query.site||'').trim();
  const purpose=['PSB','maintenance','migrasi','ticket','operasional'].includes(req.query.purpose)?req.query.purpose:'';
  const dateFrom=/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from||'')?req.query.date_from:'';
  const dateTo=/^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to||'')?req.query.date_to:'';
  const q=String(req.query.q||'').trim();
  let sql=`SELECT mu.*,i.name item_name,i.unit,c.name customer_name,t.ticket_code,s.code site_code,u.name used_by_name FROM material_usages mu JOIN inventory_items i ON i.id=mu.item_id LEFT JOIN customers c ON c.id=mu.customer_id LEFT JOIN tickets t ON t.id=mu.ticket_id LEFT JOIN sites s ON s.id=mu.site_id LEFT JOIN users u ON u.id=mu.used_by WHERE 1=1`;
  const params=[];
  if(item){sql+=` AND mu.item_id=?`;params.push(item);}
  if(site){sql+=` AND s.code=?`;params.push(site);}
  if(purpose){sql+=` AND mu.purpose=?`;params.push(purpose);}
  if(dateFrom){sql+=` AND DATE(mu.used_at)>=?`;params.push(dateFrom);}
  if(dateTo){sql+=` AND DATE(mu.used_at)<=?`;params.push(dateTo);}
  if(q){sql+=` AND (c.name LIKE ? OR t.ticket_code LIKE ? OR mu.reference LIKE ? OR mu.notes LIKE ? OR i.name LIKE ?)`;const like=`%${q}%`;params.push(like,like,like,like,like);}
  sql+=` ORDER BY mu.id DESC LIMIT 250`;
  const [usages]=await db.query(sql,params);
  const [items]=await db.query(`SELECT id,name,qty,unit FROM inventory_items WHERE is_active=1 ORDER BY name`);
  const [customers]=await db.query(`SELECT id,customer_code,name FROM customers WHERE customer_status='active' ORDER BY name LIMIT 1000`);
  const [tickets]=await db.query(`SELECT id,ticket_code,subject FROM tickets WHERE status IN ('open','progress','pending') ORDER BY id DESC LIMIT 300`);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('inventory/usage',{title:'Pemakaian Material',usages,items,customers,tickets,sites,filters:{item,site,purpose,date_from:dateFrom,date_to:dateTo,q}});
});
router.post('/usage',async(req,res)=>{
  const b=req.body, qty=Math.abs(Number(b.qty||0)); if(!qty) throw new Error('Qty harus lebih dari 0');
  const conn=await db.getConnection();
  try{await conn.beginTransaction();const [rows]=await conn.execute(`SELECT qty,name FROM inventory_items WHERE id=? FOR UPDATE`,[b.item_id]);if(!rows.length)throw new Error('Item tidak ditemukan');if(Number(rows[0].qty)<qty)throw new Error(`Stock ${rows[0].name} tidak cukup`);
    const [r]=await conn.execute(`INSERT INTO material_usages(item_id,customer_id,ticket_id,site_id,qty,purpose,reference,notes,used_by,used_at) VALUES(?,?,?,?,?,?,?,?,?,NOW())`,[b.item_id,b.customer_id||null,b.ticket_id||null,b.site_id||null,qty,b.purpose||'operasional',b.reference||null,b.notes||null,req.session.user.id]);
    await conn.execute(`UPDATE inventory_items SET qty=qty-? WHERE id=?`,[qty,b.item_id]);
    await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,'out',?,?,?,?)`,[b.item_id,qty,b.reference||`USAGE-${r.insertId}`,b.notes||b.purpose||'Pemakaian material',req.session.user.id]);
    await conn.commit();await syncStockAlert(b.item_id);await audit({userId:req.session.user.id,action:'use',entityType:'inventory',entityId:b.item_id,description:`Pemakaian material qty ${qty}`,ip:req.ip});req.session.flash={type:'success',message:'Pemakaian material dicatat dan stock otomatis berkurang.'};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  res.redirect(usageReturn(req.body));
});
// v1.25.5 — "Hapus Entri" (koreksi) untuk Pemakaian Material: mengembalikan qty yang terpakai ke stock
// lalu menghapus barisnya. Catatan: entri terkait di Pergerakan Stock (movement_type='out') dibuat lewat
// referensi teks saja (tidak ada relasi/FK langsung ke material_usages), jadi TIDAK ikut terhapus otomatis
// di sini — kalau perlu, hapus juga entrinya secara terpisah di menu Pergerakan Stock.
router.post('/usage/:id/delete',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  let deleted=null,itemName=null;
  try{
    await conn.beginTransaction();
    const [[u]]=await conn.execute(`SELECT id,item_id,qty FROM material_usages WHERE id=? LIMIT 1 FOR UPDATE`,[req.params.id]);
    if(!u){await conn.rollback();conn.release();req.session.flash={type:'warning',message:'Entri pemakaian material tidak ditemukan.'};return res.redirect(usageReturn(req.body));}
    const [[item]]=await conn.execute(`SELECT id,name FROM inventory_items WHERE id=? LIMIT 1 FOR UPDATE`,[u.item_id]);
    if(item)await conn.execute(`UPDATE inventory_items SET qty=qty+? WHERE id=?`,[Number(u.qty),u.item_id]);
    await conn.execute(`DELETE FROM material_usages WHERE id=?`,[req.params.id]);
    await conn.commit();
    deleted=u;itemName=item?.name||null;
  }catch(e){
    await conn.rollback();conn.release();
    req.session.flash={type:'danger',message:`Gagal menghapus entri: ${e.message}`};
    return res.redirect(usageReturn(req.body));
  }
  conn.release();
  await audit({userId:req.session.user.id,action:'delete',entityType:'material_usage',entityId:req.params.id,description:`Hapus entri pemakaian material #${req.params.id} (qty ${deleted.qty} · ${itemName||'item dihapus'}) — stock otomatis dikembalikan`,ip:req.ip});
  req.session.flash={type:'success',message:'Entri pemakaian material dihapus dan stock otomatis dikembalikan. Entri terkait di Pergerakan Stock (jika ada) tidak ikut terhapus otomatis.'};
  res.redirect(usageReturn(req.body));
});
router.post('/usage/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.usage_ids||[]).map(x=>Number(x)).filter(Boolean))];
  const returnCtx=usageReturn({...req.query,...req.body});
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu entri terlebih dahulu.'};return res.redirect(returnCtx);}
  if(action!=='delete'){req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};return res.redirect(returnCtx);}
  let done=0;
  for(const id of ids){
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [[u]]=await conn.execute(`SELECT id,item_id,qty FROM material_usages WHERE id=? LIMIT 1 FOR UPDATE`,[id]);
      if(!u){await conn.rollback();conn.release();continue;}
      await conn.execute(`UPDATE inventory_items SET qty=qty+? WHERE id=?`,[Number(u.qty),u.item_id]);
      await conn.execute(`DELETE FROM material_usages WHERE id=?`,[id]);
      await conn.commit();
      done++;
    }catch(e){await conn.rollback();}finally{conn.release();}
  }
  if(done)await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'material_usage',entityId:null,description:`Hapus massal ${done} entri pemakaian material — stock otomatis dikembalikan`,ip:req.ip});
  req.session.flash={type:done?'success':'warning',message:done?`${done} entri pemakaian material dihapus, stock otomatis dikembalikan.`:'Tidak ada entri yang berhasil dihapus.'};
  res.redirect(returnCtx);
});

router.get('/suppliers',async(req,res)=>{const [suppliers]=await db.query(`SELECT sp.*,COUNT(i.id) item_count FROM suppliers sp LEFT JOIN inventory_items i ON i.supplier_id=sp.id AND i.is_active=1 GROUP BY sp.id ORDER BY sp.is_active DESC,sp.name`);res.render('inventory/suppliers',{title:'Supplier',suppliers});});
router.post('/suppliers',async(req,res)=>{const b=req.body;await db.execute(`INSERT INTO suppliers(name,phone,email,address,notes,is_active) VALUES(?,?,?,?,?,1)`,[b.name,b.phone||null,b.email||null,b.address||null,b.notes||null]);req.session.flash={type:'success',message:'Supplier ditambahkan.'};res.redirect('/inventory/suppliers');});
router.post('/suppliers/:id/edit',async(req,res)=>{const b=req.body;const name=String(b.name||'').trim();if(!name){req.session.flash={type:'danger',message:'Nama supplier wajib diisi.'};return res.redirect('/inventory/suppliers');}await db.execute(`UPDATE suppliers SET name=?,phone=?,email=?,address=?,notes=? WHERE id=?`,[name,b.phone||null,b.email||null,b.address||null,b.notes||null,req.params.id]);req.session.flash={type:'success',message:'Supplier berhasil diperbarui.'};res.redirect('/inventory/suppliers');});
router.post('/suppliers/:id/toggle',async(req,res)=>{await db.execute(`UPDATE suppliers SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/inventory/suppliers');});

// v1.26 — Detail barang: grafik saldo 90 hari + riwayat pergerakan & pemakaian. Ditaruh paling akhir
// supaya tidak menelan path literal lain (/movements, /usage, dst). Express 5 tidak mendukung regex
// di param, jadi id non-angka diteruskan ke handler berikutnya (404).
router.get('/:id',async(req,res,next)=>{
  if(!/^\d+$/.test(req.params.id))return next();
  const data=await insight.itemHistory(Number(req.params.id),90);
  if(!data){req.session.flash={type:'warning',message:'Item gudang tidak ditemukan.'};return res.redirect('/inventory');}
  res.render('inventory/detail',{title:`Detail · ${data.item.name}`,...data,daysLeftLabel:insight.daysLeftLabel});
});

module.exports=router;
