const express=require('express');
const db=require('../config/db');
const { audit }=require('../services/auditService');
const { requireAdmin }=require('../middleware/auth');
const router=express.Router();

router.get('/',async(req,res)=>{
  const site=req.query.site||'';let sql=`SELECT i.*,s.code site_code,sp.name supplier_name FROM inventory_items i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id WHERE i.is_active=1`;const params=[];
  if(site){sql+=` AND s.code=?`;params.push(site);} sql+=` ORDER BY (i.qty<=i.min_stock) DESC,i.name`;
  const [items]=await db.execute(sql,params);const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);const [suppliers]=await db.query(`SELECT id,name FROM suppliers WHERE is_active=1 ORDER BY name`);
  const [[summary]]=await db.execute(`SELECT COUNT(*) items,COALESCE(SUM(i.qty*i.purchase_price),0) stock_value,SUM(i.qty<=i.min_stock) low_stock,COALESCE(SUM(i.qty),0) total_qty FROM inventory_items i LEFT JOIN sites s ON s.id=i.site_id WHERE i.is_active=1${site?` AND s.code=?`:''}`,site?[site]:[]);
  res.render('inventory/index',{title:'Stock Barang',items,sites,suppliers,summary:summary||{},site});
});
router.post('/',async(req,res)=>{const b=req.body;const [r]=await db.execute(`INSERT INTO inventory_items(item_code,name,category,site_id,supplier_id,qty,unit,min_stock,purchase_price,location,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[b.item_code||null,b.name,b.category||null,b.site_id||null,b.supplier_id||null,b.qty||0,b.unit||'pcs',b.min_stock||0,b.purchase_price||0,b.location||null,b.notes||null]);await audit({userId:req.session.user.id,action:'create',entityType:'inventory',entityId:r.insertId,description:`Tambah stock ${b.name}`,ip:req.ip});req.session.flash={type:'success',message:'Item gudang ditambahkan.'};res.redirect('/inventory');});
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
  await db.execute(`UPDATE inventory_items SET item_code=?,name=?,category=?,site_id=?,supplier_id=?,unit=?,min_stock=?,purchase_price=?,location=?,notes=? WHERE id=?`,
    [b.item_code||null,name,b.category||null,b.site_id||null,b.supplier_id||null,b.unit||'pcs',b.min_stock||0,b.purchase_price||0,b.location||null,b.notes||null,req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'inventory',entityId:req.params.id,description:`Update item ${name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Item ${name} berhasil diperbarui.`};
  res.redirect('/inventory');
});
router.post('/:id/adjust',async(req,res)=>{const qty=Number(req.body.qty||0);const type=req.body.movement_type||'adjustment';const signed=type==='out'?-Math.abs(qty):Math.abs(qty);const conn=await db.getConnection();try{await conn.beginTransaction();await conn.execute(`UPDATE inventory_items SET qty=GREATEST(0,qty+?) WHERE id=?`,[signed,req.params.id]);await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,?,?,?,?,?)`,[req.params.id,type,Math.abs(qty),req.body.reference||null,req.body.notes||null,req.session.user.id]);await conn.commit();req.session.flash={type:'success',message:'Stock berhasil diperbarui.'};}catch(e){await conn.rollback();throw e;}finally{conn.release();}res.redirect('/inventory');});

router.get('/movements',async(req,res)=>{
  const [movements]=await db.query(`SELECT m.*,i.name item_name,i.item_code,i.unit,u.name user_name FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 300`);
  const [[today]]=await db.query(`SELECT COALESCE(SUM(CASE WHEN movement_type='in' THEN qty ELSE 0 END),0) stock_in,COALESCE(SUM(CASE WHEN movement_type='out' THEN qty ELSE 0 END),0) stock_out,COUNT(*) movements FROM inventory_movements WHERE DATE(created_at)=CURDATE()`);
  res.render('inventory/movements',{title:'Pergerakan Stock',movements,today:today||{}});
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
    if(!m){await conn.rollback();conn.release();req.session.flash={type:'warning',message:'Entri pergerakan stock tidak ditemukan.'};return res.redirect('/inventory/movements');}
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
    return res.redirect('/inventory/movements');
  }
  conn.release();
  await audit({userId:req.session.user.id,action:'delete',entityType:'inventory_movement',entityId:req.params.id,description:`Hapus entri pergerakan stock #${req.params.id} (${deleted.movement_type} ${deleted.qty} · ${itemName||'item dihapus'}) — saldo stock otomatis dikoreksi balik`,ip:req.ip});
  req.session.flash={type:'success',message:'Entri pergerakan stock dihapus dan saldo stock otomatis dikoreksi.'};
  res.redirect('/inventory/movements');
});
router.post('/movements/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.movement_ids||[]).map(x=>Number(x)).filter(Boolean))];
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu entri terlebih dahulu.'};return res.redirect('/inventory/movements');}
  if(action!=='delete'){req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};return res.redirect('/inventory/movements');}
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
  res.redirect('/inventory/movements');
});

router.get('/usage',async(req,res)=>{
  const [usages]=await db.query(`SELECT mu.*,i.name item_name,i.unit,c.name customer_name,t.ticket_code,s.code site_code,u.name used_by_name FROM material_usages mu JOIN inventory_items i ON i.id=mu.item_id LEFT JOIN customers c ON c.id=mu.customer_id LEFT JOIN tickets t ON t.id=mu.ticket_id LEFT JOIN sites s ON s.id=mu.site_id LEFT JOIN users u ON u.id=mu.used_by ORDER BY mu.id DESC LIMIT 250`);
  const [items]=await db.query(`SELECT id,name,qty,unit FROM inventory_items WHERE is_active=1 ORDER BY name`);
  const [customers]=await db.query(`SELECT id,customer_code,name FROM customers WHERE customer_status='active' ORDER BY name LIMIT 1000`);
  const [tickets]=await db.query(`SELECT id,ticket_code,subject FROM tickets WHERE status IN ('open','progress','pending') ORDER BY id DESC LIMIT 300`);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('inventory/usage',{title:'Pemakaian Material',usages,items,customers,tickets,sites});
});
router.post('/usage',async(req,res)=>{
  const b=req.body, qty=Math.abs(Number(b.qty||0)); if(!qty) throw new Error('Qty harus lebih dari 0');
  const conn=await db.getConnection();
  try{await conn.beginTransaction();const [rows]=await conn.execute(`SELECT qty,name FROM inventory_items WHERE id=? FOR UPDATE`,[b.item_id]);if(!rows.length)throw new Error('Item tidak ditemukan');if(Number(rows[0].qty)<qty)throw new Error(`Stock ${rows[0].name} tidak cukup`);
    const [r]=await conn.execute(`INSERT INTO material_usages(item_id,customer_id,ticket_id,site_id,qty,purpose,reference,notes,used_by,used_at) VALUES(?,?,?,?,?,?,?,?,?,NOW())`,[b.item_id,b.customer_id||null,b.ticket_id||null,b.site_id||null,qty,b.purpose||'operasional',b.reference||null,b.notes||null,req.session.user.id]);
    await conn.execute(`UPDATE inventory_items SET qty=qty-? WHERE id=?`,[qty,b.item_id]);
    await conn.execute(`INSERT INTO inventory_movements(item_id,movement_type,qty,reference,notes,user_id) VALUES(?,'out',?,?,?,?)`,[b.item_id,qty,b.reference||`USAGE-${r.insertId}`,b.notes||b.purpose||'Pemakaian material',req.session.user.id]);
    await conn.commit();await audit({userId:req.session.user.id,action:'use',entityType:'inventory',entityId:b.item_id,description:`Pemakaian material qty ${qty}`,ip:req.ip});req.session.flash={type:'success',message:'Pemakaian material dicatat dan stock otomatis berkurang.'};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  res.redirect('/inventory/usage');
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
    if(!u){await conn.rollback();conn.release();req.session.flash={type:'warning',message:'Entri pemakaian material tidak ditemukan.'};return res.redirect('/inventory/usage');}
    const [[item]]=await conn.execute(`SELECT id,name FROM inventory_items WHERE id=? LIMIT 1 FOR UPDATE`,[u.item_id]);
    if(item)await conn.execute(`UPDATE inventory_items SET qty=qty+? WHERE id=?`,[Number(u.qty),u.item_id]);
    await conn.execute(`DELETE FROM material_usages WHERE id=?`,[req.params.id]);
    await conn.commit();
    deleted=u;itemName=item?.name||null;
  }catch(e){
    await conn.rollback();conn.release();
    req.session.flash={type:'danger',message:`Gagal menghapus entri: ${e.message}`};
    return res.redirect('/inventory/usage');
  }
  conn.release();
  await audit({userId:req.session.user.id,action:'delete',entityType:'material_usage',entityId:req.params.id,description:`Hapus entri pemakaian material #${req.params.id} (qty ${deleted.qty} · ${itemName||'item dihapus'}) — stock otomatis dikembalikan`,ip:req.ip});
  req.session.flash={type:'success',message:'Entri pemakaian material dihapus dan stock otomatis dikembalikan. Entri terkait di Pergerakan Stock (jika ada) tidak ikut terhapus otomatis.'};
  res.redirect('/inventory/usage');
});
router.post('/usage/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.usage_ids||[]).map(x=>Number(x)).filter(Boolean))];
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu entri terlebih dahulu.'};return res.redirect('/inventory/usage');}
  if(action!=='delete'){req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};return res.redirect('/inventory/usage');}
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
  res.redirect('/inventory/usage');
});

router.get('/suppliers',async(req,res)=>{const [suppliers]=await db.query(`SELECT sp.*,COUNT(i.id) item_count FROM suppliers sp LEFT JOIN inventory_items i ON i.supplier_id=sp.id AND i.is_active=1 GROUP BY sp.id ORDER BY sp.is_active DESC,sp.name`);res.render('inventory/suppliers',{title:'Supplier',suppliers});});
router.post('/suppliers',async(req,res)=>{const b=req.body;await db.execute(`INSERT INTO suppliers(name,phone,email,address,notes,is_active) VALUES(?,?,?,?,?,1)`,[b.name,b.phone||null,b.email||null,b.address||null,b.notes||null]);req.session.flash={type:'success',message:'Supplier ditambahkan.'};res.redirect('/inventory/suppliers');});
router.post('/suppliers/:id/edit',async(req,res)=>{const b=req.body;const name=String(b.name||'').trim();if(!name){req.session.flash={type:'danger',message:'Nama supplier wajib diisi.'};return res.redirect('/inventory/suppliers');}await db.execute(`UPDATE suppliers SET name=?,phone=?,email=?,address=?,notes=? WHERE id=?`,[name,b.phone||null,b.email||null,b.address||null,b.notes||null,req.params.id]);req.session.flash={type:'success',message:'Supplier berhasil diperbarui.'};res.redirect('/inventory/suppliers');});
router.post('/suppliers/:id/toggle',async(req,res)=>{await db.execute(`UPDATE suppliers SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/inventory/suppliers');});

module.exports=router;
