const express=require('express');
const bcrypt=require('bcryptjs');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const db=require('../config/db');
const { requireAdmin, requireMasterAdmin, PERMISSIONS, normalizePermissions, normalizeRole, isMasterAdminRole }=require('../middleware/auth');
const { audit }=require('../services/auditService');
const router=express.Router();

const tabs=new Set(['company','invoice','application','accounts','employees','departments','positions','banks','gateways','roles','reset']);
const testDataResetTables=['payments','invoices','custom_invoices','cash_transactions','customers'];
const uiPalettes=new Set(['nebula','ocean','emerald','sunset','rose','ice']);
const clean=(v)=>String(v||'').trim();
const nullable=(v)=>clean(v)||null;
const invoiceLogoDir=path.join(__dirname,'..','storage','invoice-branding');
const permissionLabels={dashboard:'Dashboard',customers:'Pelanggan & Paket',billing:'Tagihan & Pembayaran',warehouse:'Gudang',support:'Dukungan',network:'Jaringan',network_control:'Kontrol Jaringan (Isolir/Kick/Lock MAC)',finance:'Keuangan',reports:'Laporan',logs:'Log Aktivitas',settings:'Pengaturan'};
fs.mkdirSync(invoiceLogoDir,{recursive:true});

function logoSignatureMatches(file){
  if(!file)return true;
  const b=file.buffer;
  if(file.mimetype==='image/jpeg')return b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
  if(file.mimetype==='image/png')return b.length>=8&&b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  return false;
}
async function removeInvoiceLogo(filename){
  if(!filename)return;
  try{await fs.promises.unlink(path.join(invoiceLogoDir,path.basename(filename)));}catch(e){if(e.code!=='ENOENT')console.error('Gagal menghapus logo invoice lama:',e.message);}
}

router.get('/',async(req,res)=>{
  const tab=tabs.has(req.query.tab)?req.query.tab:'company';
  const [[settings]]=await db.query(`SELECT * FROM settings WHERE id=1`);
  const [sites]=await db.query(`SELECT * FROM sites ORDER BY code`);
  const [users]=await db.query(`SELECT id,name,username,role,profile_photo,is_active,created_at FROM users ORDER BY is_active DESC,name`);
  const [departments]=await db.query(`SELECT * FROM departments ORDER BY is_active DESC,name`);
  const [positions]=await db.query(`SELECT p.*,d.name department_name FROM positions p LEFT JOIN departments d ON d.id=p.department_id ORDER BY p.is_active DESC,d.name,p.name`);
  const [employees]=await db.query(`SELECT e.*,d.name department_name,p.name position_name,p.category position_category,u.username FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN positions p ON p.id=e.position_id LEFT JOIN users u ON u.id=e.user_id ORDER BY e.is_active DESC,e.name`);
  const [banks]=await db.query(`SELECT * FROM banks ORDER BY is_active DESC,bank_name`);
  const [gateways]=await db.query(`SELECT * FROM payment_gateways ORDER BY FIELD(status,'active','testing','inactive'),name`);
  const [roles]=await db.query(`SELECT * FROM role_permissions ORDER BY role_key`);
  res.render('settings/index',{title:'Pengaturan',settings,sites,users,departments,positions,employees,banks,gateways,roles,tab,permissionCatalog:PERMISSIONS.map(key=>({key,label:permissionLabels[key]||key}))});
});

router.post('/',requireMasterAdmin,async(req,res)=>{
  const b=req.body;
  await db.execute(`UPDATE settings SET company_name=?,company_address=?,company_phone=?,company_email=?,company_website=?,company_tagline=? WHERE id=1`,[b.company_name,b.company_address||null,b.company_phone||null,b.company_email||null,b.company_website||null,b.company_tagline||'From the Village, Online Everywhere']);
  req.session.flash={type:'success',message:'Data perusahaan disimpan.'};res.redirect('/settings?tab=company');
});
router.post('/invoice-branding',requireMasterAdmin,async(req,res)=>{
  const b=req.body;
  const companyName=clean(b.invoice_company_name);
  if(!companyName){req.session.flash={type:'danger',message:'Nama PT / perusahaan wajib diisi.'};return res.redirect('/settings?tab=invoice');}
  const [[current]]=await db.query(`SELECT invoice_logo_path FROM settings WHERE id=1`);
  if(req.file&&!logoSignatureMatches(req.file)){
    req.session.flash={type:'danger',message:'Isi file logo tidak sesuai format JPG atau PNG.'};
    return res.redirect('/settings?tab=invoice');
  }
  const removeLogo=b.remove_logo==='1';
  const uploadedLogo=req.file?`invoice-logo-${Date.now()}-${crypto.randomUUID()}${req.file.mimetype==='image/png'?'.png':'.jpg'}`:null;
  if(uploadedLogo)await fs.promises.writeFile(path.join(invoiceLogoDir,uploadedLogo),req.file.buffer,{flag:'wx'});
  const nextLogo=removeLogo?null:(uploadedLogo||current?.invoice_logo_path||null);
  try{
    await db.execute(`UPDATE settings SET invoice_company_name=?,invoice_address=?,invoice_phone=?,invoice_email=?,invoice_website=?,invoice_tax_id=?,invoice_footer=?,invoice_logo_path=? WHERE id=1`,[
      companyName,nullable(b.invoice_address),nullable(b.invoice_phone),nullable(b.invoice_email),nullable(b.invoice_website),nullable(b.invoice_tax_id),nullable(b.invoice_footer),nextLogo
    ]);
  }catch(err){if(uploadedLogo)await removeInvoiceLogo(uploadedLogo);throw err;}
  if((req.file||removeLogo)&&current?.invoice_logo_path&&current.invoice_logo_path!==nextLogo)await removeInvoiceLogo(current.invoice_logo_path);
  await audit({userId:req.session.user.id,action:'update',entityType:'invoice_branding',entityId:1,description:`Identitas invoice diperbarui${uploadedLogo?' beserta logo baru':''}${removeLogo?' dan logo dihapus':''}`,ip:req.ip});
  req.session.flash={type:'success',message:'Identitas invoice berhasil disimpan dan langsung dipakai pada invoice cetak/PDF.'};
  res.redirect('/settings?tab=invoice');
});
router.post('/application',requireMasterAdmin,async(req,res)=>{
  const theme=['dark','light','system'].includes(req.body.default_theme)?req.body.default_theme:'dark';
  const palette=uiPalettes.has(req.body.ui_palette)?req.body.ui_palette:'nebula';
  // v1.25.5 (susulan #10) — "Komisi Pemasangan Baru" seragam semua paket: Sales selalu dapat nominal flat
  // ini, Teknisi dapat sisanya dari harga paket/total tagihan pertama (lihat services/invoiceService.js).
  // Disimpan di settings (bukan hardcode) supaya admin bisa mengubah kebijakan tanpa perlu patch aplikasi.
  const rawFlatCommission=Number(req.body.install_sales_flat_commission);
  const flatCommission=Number.isFinite(rawFlatCommission)&&rawFlatCommission>=0?rawFlatCommission:50000;
  // Network Incident & Alert Engine (services/networkAlertService.js) -- nomor WA dibersihkan
  // ringan di sini (batas panjang kolom VARCHAR(500)); validasi format nomor per-nomor sudah
  // dilakukan otomatis oleh whatsappGatewayService saat mengirim, jadi tidak perlu diulang di sini.
  const networkAlertWaNumbers=String(req.body.network_alert_wa_numbers||'').trim().slice(0,500);
  await db.execute(`UPDATE settings SET default_due_day=?,default_grace_days=?,invoice_generate_days=?,auto_isolate=?,default_theme=?,ui_palette=?,default_language=?,install_sales_flat_commission=?,network_alert_wa_enabled=?,network_alert_wa_numbers=?,network_alert_auto_ticket_enabled=? WHERE id=1`,[req.body.default_due_day,req.body.default_grace_days,req.body.invoice_generate_days,req.body.auto_isolate?1:0,theme,palette,req.body.default_language==='en'?'en':'id',flatCommission,req.body.network_alert_wa_enabled?1:0,networkAlertWaNumbers,req.body.network_alert_auto_ticket_enabled?1:0]);
  req.session.language=req.body.default_language==='en'?'en':'id';
  req.session.uiTheme=theme;req.session.uiPalette=palette;
  req.session.flash={type:'success',message:'Preferensi aplikasi disimpan.'};res.redirect('/settings?tab=application');
});
router.post('/sites/:id',requireMasterAdmin,async(req,res)=>{const b=req.body;await db.execute(`UPDATE sites SET name=?,default_due_day=?,default_grace_days=?,invoice_generate_days=? WHERE id=?`,[b.name,b.default_due_day||null,b.default_grace_days||null,b.invoice_generate_days||null,req.params.id]);req.session.flash={type:'success',message:'Default site diperbarui.'};res.redirect('/settings?tab=application');});

router.post('/employees',requireMasterAdmin,async(req,res)=>{
  const b=req.body;let code=clean(b.employee_code).toUpperCase();
  if(!code){const [[r]]=await db.query(`SELECT COALESCE(MAX(id),0)+1 seq FROM employees`);code=`EMP-${String(r.seq).padStart(4,'0')}`;}
  await db.execute(`INSERT INTO employees(employee_code,name,email,phone,department_id,position_id,user_id,joined_at,is_active,notes) VALUES(?,?,?,?,?,?,?,?,1,?)`,[code,clean(b.name),nullable(b.email),nullable(b.phone),b.department_id||null,b.position_id||null,b.user_id||null,b.joined_at||null,nullable(b.notes)]);
  req.session.flash={type:'success',message:`Karyawan ${b.name} ditambahkan.`};res.redirect('/settings?tab=employees');
});
router.post('/employees/:id',requireMasterAdmin,async(req,res)=>{const b=req.body;await db.execute(`UPDATE employees SET employee_code=?,name=?,email=?,phone=?,department_id=?,position_id=?,user_id=?,joined_at=?,notes=? WHERE id=?`,[clean(b.employee_code).toUpperCase(),clean(b.name),nullable(b.email),nullable(b.phone),b.department_id||null,b.position_id||null,b.user_id||null,b.joined_at||null,nullable(b.notes),req.params.id]);req.session.flash={type:'success',message:'Data karyawan diperbarui.'};res.redirect('/settings?tab=employees');});
router.post('/employees/:id/toggle',requireMasterAdmin,async(req,res)=>{await db.execute(`UPDATE employees SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/settings?tab=employees');});

router.post('/departments',requireMasterAdmin,async(req,res)=>{await db.execute(`INSERT INTO departments(code,name,description,is_active) VALUES(?,?,?,1)`,[clean(req.body.code).toUpperCase(),clean(req.body.name),nullable(req.body.description)]);req.session.flash={type:'success',message:'Departemen ditambahkan.'};res.redirect('/settings?tab=departments');});
router.post('/departments/:id',requireMasterAdmin,async(req,res)=>{const b=req.body;const code=clean(b.code).toUpperCase(),name=clean(b.name);if(!code||!name){req.session.flash={type:'danger',message:'Kode dan nama departemen wajib diisi.'};return res.redirect('/settings?tab=departments');}await db.execute(`UPDATE departments SET code=?,name=?,description=? WHERE id=?`,[code,name,nullable(b.description),req.params.id]);req.session.flash={type:'success',message:'Departemen diperbarui.'};res.redirect('/settings?tab=departments');});
router.post('/departments/:id/toggle',requireMasterAdmin,async(req,res)=>{await db.execute(`UPDATE departments SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/settings?tab=departments');});

router.post('/positions',requireMasterAdmin,async(req,res)=>{const allowed=new Set(['sales','technical','admin','management','finance','other']);const category=allowed.has(req.body.category)?req.body.category:'other';await db.execute(`INSERT INTO positions(department_id,code,name,category,description,is_active) VALUES(?,?,?,?,?,1)`,[req.body.department_id||null,clean(req.body.code).toUpperCase(),clean(req.body.name),category,nullable(req.body.description)]);req.session.flash={type:'success',message:'Posisi ditambahkan.'};res.redirect('/settings?tab=positions');});
router.post('/positions/:id',requireMasterAdmin,async(req,res)=>{const b=req.body;const allowed=new Set(['sales','technical','admin','management','finance','other']);const category=allowed.has(b.category)?b.category:'other';const code=clean(b.code).toUpperCase(),name=clean(b.name);if(!code||!name){req.session.flash={type:'danger',message:'Kode dan nama posisi wajib diisi.'};return res.redirect('/settings?tab=positions');}await db.execute(`UPDATE positions SET department_id=?,code=?,name=?,category=?,description=? WHERE id=?`,[b.department_id||null,code,name,category,nullable(b.description),req.params.id]);req.session.flash={type:'success',message:'Posisi diperbarui.'};res.redirect('/settings?tab=positions');});
router.post('/positions/:id/toggle',requireMasterAdmin,async(req,res)=>{await db.execute(`UPDATE positions SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/settings?tab=positions');});

router.post('/banks',requireMasterAdmin,async(req,res)=>{const allowed=new Set(['bank_transfer','cash','virtual_account','other']);await db.execute(`INSERT INTO banks(bank_name,account_name,account_number,type,is_active,notes) VALUES(?,?,?,?,1,?)`,[clean(req.body.bank_name),clean(req.body.account_name),clean(req.body.account_number),allowed.has(req.body.type)?req.body.type:'bank_transfer',nullable(req.body.notes)]);req.session.flash={type:'success',message:'Rekening bank ditambahkan.'};res.redirect('/settings?tab=banks');});
router.post('/banks/:id',requireMasterAdmin,async(req,res)=>{const b=req.body;const allowed=new Set(['bank_transfer','cash','virtual_account','other']);const bankName=clean(b.bank_name),accountName=clean(b.account_name),accountNumber=clean(b.account_number);if(!bankName||!accountName||!accountNumber){req.session.flash={type:'danger',message:'Nama bank, nama rekening, dan nomor rekening wajib diisi.'};return res.redirect('/settings?tab=banks');}await db.execute(`UPDATE banks SET bank_name=?,account_name=?,account_number=?,type=?,notes=? WHERE id=?`,[bankName,accountName,accountNumber,allowed.has(b.type)?b.type:'bank_transfer',nullable(b.notes),req.params.id]);req.session.flash={type:'success',message:'Rekening bank diperbarui.'};res.redirect('/settings?tab=banks');});
router.post('/banks/:id/toggle',requireMasterAdmin,async(req,res)=>{await db.execute(`UPDATE banks SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/settings?tab=banks');});

router.post('/gateways',requireMasterAdmin,async(req,res)=>{const allowed=new Set(['active','inactive','testing']);await db.execute(`INSERT INTO payment_gateways(name,provider,channel,status,notes) VALUES(?,?,?,?,?)`,[clean(req.body.name),nullable(req.body.provider),nullable(req.body.channel),allowed.has(req.body.status)?req.body.status:'inactive',nullable(req.body.notes)]);req.session.flash={type:'success',message:'Payment gateway ditambahkan.'};res.redirect('/settings?tab=gateways');});
router.post('/gateways/:id',requireMasterAdmin,async(req,res)=>{const b=req.body;const allowed=new Set(['active','inactive','testing']);const name=clean(b.name);if(!name){req.session.flash={type:'danger',message:'Nama payment gateway wajib diisi.'};return res.redirect('/settings?tab=gateways');}await db.execute(`UPDATE payment_gateways SET name=?,provider=?,channel=?,status=?,notes=? WHERE id=?`,[name,nullable(b.provider),nullable(b.channel),allowed.has(b.status)?b.status:'inactive',nullable(b.notes),req.params.id]);req.session.flash={type:'success',message:'Payment gateway diperbarui.'};res.redirect('/settings?tab=gateways');});
router.post('/gateways/:id/toggle',requireMasterAdmin,async(req,res)=>{await db.execute(`UPDATE payment_gateways SET status=IF(status='active','inactive','active') WHERE id=?`,[req.params.id]);res.redirect('/settings?tab=gateways');});

router.post('/roles',requireMasterAdmin,async(req,res)=>{
  const roleKey=normalizeRole(req.body.role_key);
  const roleName=(clean(req.body.role_name)||roleKey).slice(0,100);
  if(!/^[a-z][a-z0-9_]{2,49}$/.test(roleKey)){req.session.flash={type:'danger',message:'Kode role harus 3-50 karakter: huruf kecil, angka, dan underscore.'};return res.redirect('/settings?tab=roles');}
  const [exists]=await db.execute(`SELECT id FROM role_permissions WHERE role_key=? LIMIT 1`,[roleKey]);
  if(exists.length){req.session.flash={type:'warning',message:'Kode role sudah digunakan.'};return res.redirect('/settings?tab=roles');}
  const requested=Array.isArray(req.body.permissions)?req.body.permissions:[req.body.permissions].filter(Boolean);
  const permissions=normalizePermissions(requested,roleKey);
  const [result]=await db.execute(`INSERT INTO role_permissions(role_key,role_name,permissions_json,permission_schema_version) VALUES(?,?,?,5)`,[roleKey,roleName,JSON.stringify(permissions)]);
  await audit({userId:req.session.user.id,action:'create',entityType:'role_permission',entityId:result.insertId,description:`Custom role ${roleKey} dibuat: ${permissions.join(', ')}`,ip:req.ip});
  req.session.flash={type:'success',message:`Custom role ${roleName} berhasil dibuat.`};
  res.redirect('/settings?tab=roles');
});

router.post('/roles/:roleKey',requireMasterAdmin,async(req,res)=>{
  const roleKey=normalizeRole(req.params.roleKey);
  const [rows]=await db.execute(`SELECT id,role_key FROM role_permissions WHERE role_key=? LIMIT 1`,[roleKey]);
  if(!rows.length){req.session.flash={type:'danger',message:'Role tidak ditemukan.'};return res.redirect('/settings?tab=roles');}
  const requested=Array.isArray(req.body.permissions)?req.body.permissions:[req.body.permissions].filter(Boolean);
  const permissions=normalizePermissions(requested,roleKey);
  const roleName=(clean(req.body.role_name)||roleKey).slice(0,100);
  await db.execute(`UPDATE role_permissions SET role_name=?,permissions_json=? WHERE role_key=?`,[roleName,JSON.stringify(permissions),roleKey]);
  await audit({userId:req.session.user.id,action:'update',entityType:'role_permission',entityId:rows[0].id,description:`Permission role ${roleKey}: ${permissions.join(', ')}`,ip:req.ip});
  req.session.flash={type:'success',message:`Permission role ${roleName} berhasil diperbarui.`};
  res.redirect('/settings?tab=roles');
});

router.post('/roles/:roleKey/delete',requireMasterAdmin,async(req,res)=>{
  const roleKey=normalizeRole(req.params.roleKey);
  if(['master_admin','admin','staff'].includes(roleKey)){req.session.flash={type:'danger',message:'Role sistem tidak dapat dihapus.'};return res.redirect('/settings?tab=roles');}
  const [[usage]]=await db.execute(`SELECT COUNT(*) total FROM users WHERE role=?`,[roleKey]);
  if(Number(usage.total)>0){req.session.flash={type:'warning',message:`Role masih dipakai ${Number(usage.total)} akun. Pindahkan role akun terlebih dahulu.`};return res.redirect('/settings?tab=roles');}
  const [result]=await db.execute(`DELETE FROM role_permissions WHERE role_key=?`,[roleKey]);
  if(result.affectedRows)await audit({userId:req.session.user.id,action:'delete',entityType:'role_permission',entityId:null,description:`Custom role ${roleKey} dihapus`,ip:req.ip});
  req.session.flash={type:'success',message:'Custom role berhasil dihapus.'};res.redirect('/settings?tab=roles');
});

router.post('/users',requireAdmin,async(req,res)=>{
  const b=req.body,name=clean(b.name),username=clean(b.username).toLowerCase(),password=String(b.password||'');
  if(!name||!/^[-a-z0-9._]{3,50}$/i.test(username)||password.length<8){req.session.flash={type:'danger',message:'Nama, username 3-50 karakter, dan password minimal 8 karakter wajib diisi.'};return res.redirect('/settings?tab=accounts');}
  const requestedRole=normalizeRole(b.role);
  const [roleRows]=await db.execute(`SELECT role_key FROM role_permissions WHERE role_key=? LIMIT 1`,[requestedRole]);
  const role=roleRows.length?roleRows[0].role_key:'staff';
  if(role==='master_admin'&&!isMasterAdminRole(req.session.user.role)){req.session.flash={type:'danger',message:'Hanya Master Admin yang dapat membuat Master Admin baru.'};return res.redirect('/settings?tab=accounts');}
  const [duplicate]=await db.execute(`SELECT id FROM users WHERE username=? LIMIT 1`,[username]);
  if(duplicate.length){req.session.flash={type:'danger',message:'Username sudah digunakan akun lain.'};return res.redirect('/settings?tab=accounts');}
  const hash=await bcrypt.hash(password,12);
  const [result]=await db.execute(`INSERT INTO users(name,username,password_hash,role,is_active) VALUES(?,?,?,?,1)`,[name,username,hash,role]);
  await db.execute(`INSERT INTO employees(employee_code,name,user_id,is_active) VALUES(?,?,?,1)`,[`USR-${String(result.insertId).padStart(4,'0')}`,name,result.insertId]);
  await audit({userId:req.session.user.id,action:'create',entityType:'user',entityId:result.insertId,description:`Akun ${username} dibuat sebagai ${role}`,ip:req.ip});
  req.session.flash={type:'success',message:`Akun ${role==='master_admin'?'Master Admin':role} berhasil dibuat.`};res.redirect('/settings?tab=accounts');
});

router.post('/users/:id',requireAdmin,async(req,res)=>{
  const id=Number(req.params.id),name=clean(req.body.name),username=clean(req.body.username).toLowerCase();
  const [rows]=await db.execute(`SELECT id,username,role,is_active FROM users WHERE id=? LIMIT 1`,[id]);
  if(!rows.length){req.session.flash={type:'danger',message:'Akun tidak ditemukan.'};return res.redirect('/settings?tab=accounts');}
  const target=rows[0],actorIsMaster=isMasterAdminRole(req.session.user.role),requested=normalizeRole(req.body.role);
  const [roleRows]=await db.execute(`SELECT role_key FROM role_permissions WHERE role_key=? LIMIT 1`,[requested]);
  const role=roleRows.length?roleRows[0].role_key:'staff';
  if(!name||!/^[-a-z0-9._]{3,50}$/i.test(username)){req.session.flash={type:'danger',message:'Nama dan username akun tidak valid.'};return res.redirect('/settings?tab=accounts');}
  if((isMasterAdminRole(target.role)||role==='master_admin')&&!actorIsMaster){req.session.flash={type:'danger',message:'Hanya Master Admin yang dapat mengubah akun Master Admin.'};return res.redirect('/settings?tab=accounts');}
  if(id===Number(req.session.user.id)&&normalizeRole(target.role)!==role){req.session.flash={type:'warning',message:'Role akun yang sedang dipakai tidak dapat diubah sendiri.'};return res.redirect('/settings?tab=accounts');}
  if(isMasterAdminRole(target.role)&&role!=='master_admin'){
    const [[count]]=await db.query(`SELECT COUNT(*) total FROM users WHERE role='master_admin' AND is_active=1`);
    if(Number(count.total)<=1){req.session.flash={type:'danger',message:'Master Admin aktif terakhir tidak dapat diturunkan rolenya.'};return res.redirect('/settings?tab=accounts');}
  }
  const [duplicate]=await db.execute(`SELECT id FROM users WHERE username=? AND id<>? LIMIT 1`,[username,id]);
  if(duplicate.length){req.session.flash={type:'danger',message:'Username sudah digunakan akun lain.'};return res.redirect('/settings?tab=accounts');}
  await db.execute(`UPDATE users SET name=?,username=?,role=? WHERE id=?`,[name,username,role,id]);
  await db.execute(`UPDATE employees SET name=? WHERE user_id=?`,[name,id]);
  if(id===Number(req.session.user.id)){req.session.user.name=name;req.session.user.username=username;}
  await audit({userId:req.session.user.id,action:'update',entityType:'user',entityId:id,description:`Akun ${username} diperbarui sebagai ${role}`,ip:req.ip});
  req.session.flash={type:'success',message:'Konfigurasi akun berhasil diperbarui.'};res.redirect('/settings?tab=accounts');
});

router.post('/users/:id/toggle',requireAdmin,async(req,res)=>{
  const id=Number(req.params.id);
  if(id===Number(req.session.user.id)){req.session.flash={type:'warning',message:'Akun yang sedang dipakai tidak bisa dinonaktifkan.'};return res.redirect('/settings?tab=accounts');}
  const [rows]=await db.execute(`SELECT id,username,role,is_active FROM users WHERE id=? LIMIT 1`,[id]);
  if(!rows.length)return res.redirect('/settings?tab=accounts');
  const target=rows[0];
  if(isMasterAdminRole(target.role)&&!isMasterAdminRole(req.session.user.role)){req.session.flash={type:'danger',message:'Admin biasa tidak dapat menonaktifkan Master Admin.'};return res.redirect('/settings?tab=accounts');}
  if(isMasterAdminRole(target.role)&&target.is_active){const [[count]]=await db.query(`SELECT COUNT(*) total FROM users WHERE role='master_admin' AND is_active=1`);if(Number(count.total)<=1){req.session.flash={type:'danger',message:'Master Admin aktif terakhir tidak dapat dinonaktifkan.'};return res.redirect('/settings?tab=accounts');}}
  await db.execute(`UPDATE users SET is_active=IF(is_active=1,0,1) WHERE id=?`,[id]);
  await db.execute(`UPDATE employees SET is_active=(SELECT is_active FROM users WHERE id=?) WHERE user_id=?`,[id,id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'user',entityId:id,description:`Status akun ${target.username} diubah`,ip:req.ip});
  req.session.flash={type:'success',message:'Status akun berhasil diubah.'};res.redirect('/settings?tab=accounts');
});

router.post('/users/:id/password',requireAdmin,async(req,res)=>{
  const id=Number(req.params.id),password=String(req.body.password||'');
  if(password.length<8){req.session.flash={type:'danger',message:'Password baru minimal 8 karakter.'};return res.redirect('/settings?tab=accounts');}
  const [rows]=await db.execute(`SELECT username,role FROM users WHERE id=? LIMIT 1`,[id]);
  if(!rows.length)return res.redirect('/settings?tab=accounts');
  if(isMasterAdminRole(rows[0].role)&&!isMasterAdminRole(req.session.user.role)){req.session.flash={type:'danger',message:'Hanya Master Admin yang dapat mereset password Master Admin.'};return res.redirect('/settings?tab=accounts');}
  const hash=await bcrypt.hash(password,12);await db.execute(`UPDATE users SET password_hash=? WHERE id=?`,[hash,id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'user',entityId:id,description:`Password akun ${rows[0].username} direset`,ip:req.ip});
  req.session.flash={type:'success',message:'Password berhasil direset.'};res.redirect('/settings?tab=accounts');
});

// v1.24.4 — "Bersihkan Data Uji Coba": one-click in-app equivalent of BERSIHKAN-DATA-UJICOBA.sql,
// scoped ONLY to payments/invoices/custom_invoices/cash_transactions/customers so the currently-logged-in
// Master Admin's own account (and settings/packages/sites/routers/etc.) can never disappear mid-request.
// Master Admin only, and gated behind the app's existing retype-to-confirm Force Delete modal.
router.post('/reset-test-data',requireMasterAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  const results=[];
  try{
    await conn.query(`SET FOREIGN_KEY_CHECKS=0`);
    for(const tbl of testDataResetTables){
      const [[info]]=await conn.query(`SELECT COUNT(*) total FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?`,[tbl]);
      if(Number(info.total)>0){
        await conn.query(`TRUNCATE TABLE \`${tbl}\``);
        results.push(`${tbl}: dikosongkan`);
      }else{
        results.push(`${tbl}: tabel tidak ditemukan, dilewati`);
      }
    }
    await conn.query(`SET FOREIGN_KEY_CHECKS=1`);
    await audit({userId:req.session.user.id,action:'delete',entityType:'reset_test_data',entityId:null,description:`Reset data uji coba: ${results.join('; ')}`,ip:req.ip});
    req.session.flash={type:'success',message:'Data uji coba (Pelanggan, Tagihan, Pembayaran, dan Data Kas terkait) berhasil dibersihkan. Akun login, Pengaturan, Paket, Site, Router, dan Cluster/ODP TIDAK berubah.'};
  }catch(err){
    console.error('Gagal reset data uji coba:',err.message);
    req.session.flash={type:'danger',message:'Gagal membersihkan data uji coba: '+err.message};
  }finally{
    conn.release();
  }
  res.redirect('/settings?tab=reset');
});

module.exports=router;
