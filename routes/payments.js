const express=require('express');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const db=require('../config/db');
const { refreshInvoiceStatus }=require('../services/invoiceService');
const { audit }=require('../services/auditService');
const { unisolateCustomer }=require('../services/networkService');
const { assignCashTransactionCode }=require('../services/cashService');
const { requireAdmin, requireMasterAdmin, isAdminRole, isMasterAdminRole }=require('../middleware/auth');
const router=express.Router();

const PROOF_DIR=path.join(__dirname,'..','storage','payment-proofs');
fs.mkdirSync(PROOF_DIR,{recursive:true});

function proofExtension(mime){
  return ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','application/pdf':'.pdf'})[mime]||'';
}
function proofSignatureMatches(file){
  const b=file?.buffer;if(!b||b.length<12)return false;
  if(file.mimetype==='image/jpeg')return b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
  if(file.mimetype==='image/png')return b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(file.mimetype==='image/webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
  if(file.mimetype==='application/pdf')return b.subarray(0,5).toString()==='%PDF-';
  return false;
}
async function saveProofFile(file){
  if(!file)return null;
  const ext=proofExtension(file.mimetype);
  if(!ext||!proofSignatureMatches(file))throw new Error('Isi file bukti tidak sesuai format JPG, PNG, WEBP, atau PDF yang diizinkan.');
  const filename=`proof-${Date.now()}-${crypto.randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(PROOF_DIR,filename),file.buffer,{flag:'wx'});
  return {filename,originalName:file.originalname,mime:file.mimetype,size:file.size};
}
async function removeProofFile(filename){
  if(!filename)return;
  try{await fs.promises.unlink(path.join(PROOF_DIR,path.basename(filename)));}catch(e){if(e.code!=='ENOENT')console.error('Gagal hapus bukti lama:',e.message);}
}
function localReturn(value,fallback='/payments'){
  const v=String(value||'');
  return v.startsWith('/')&&!v.startsWith('//')?v:fallback;
}
function selectedInvoiceIds(body){
  const raw=body.invoice_ids??body.invoice_id;
  const list=Array.isArray(raw)?raw:[raw];
  return [...new Set(list.map(Number).filter(Number.isInteger).filter(x=>x>0))];
}
function selectedPaymentIds(body){
  const raw=body.payment_ids??body.payment_id;
  const list=Array.isArray(raw)?raw:[raw];
  return [...new Set(list.map(Number).filter(Number.isInteger).filter(x=>x>0))];
}
function paymentReference(paymentId, date=new Date()){
  const d=new Date(date);
  const stamp=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `PAY-${stamp}-${String(paymentId).padStart(6,'0')}`;
}

async function paymentCashMeta(conn,invoiceId){
  const [rows]=await conn.execute(`SELECT c.site_id,c.name customer_name,c.customer_code,i.invoice_number FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?`,[invoiceId]);
  return rows[0]||null;
}
async function billingCategory(conn,name='Pendapatan Billing'){
  const [rows]=await conn.execute(`SELECT id FROM cash_categories WHERE name=? AND type='income' LIMIT 1`,[name]);
  return rows[0]?.id||null;
}
async function postCashTransaction(conn,{paymentId,invoiceId,amount,reference,categoryName='Pendapatan Billing',prefix='Pembayaran',actorUserId=null}){
  const meta=await paymentCashMeta(conn,invoiceId);if(!meta)return;
  const catId=await billingCategory(conn,categoryName);if(!catId)return;
  const [exists]=await conn.execute(`SELECT id FROM cash_transactions WHERE source_type='payment' AND source_id=? LIMIT 1`,[paymentId]);
  if(exists.length)return;
  const [r]=await conn.execute(`INSERT INTO cash_transactions(transaction_date,name,category_id,site_id,amount,notes,source_type,source_id,created_by) VALUES(CURDATE(),?,?,?,?,?,'payment',?,?)`,[
    `${prefix} ${meta.customer_name}`,catId,meta.site_id,amount,`Faktur ${meta.invoice_number}${reference?` · ${reference}`:''}`,paymentId,actorUserId
  ]);
  await assignCashTransactionCode(conn,r.insertId,catId,new Date());
}
async function maybeAutoUnisolate(invoiceId){
  const [paidRows]=await db.execute(`SELECT i.status,c.id customer_id,c.network_status,c.isolation_reason FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?`,[invoiceId]);
  if(paidRows[0]?.status==='paid'&&paidRows[0]?.network_status==='isolated'&&paidRows[0]?.isolation_reason==='billing'){
    try{await unisolateCustomer(paidRows[0].customer_id,true);}
    catch(netErr){await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_unisolate','failed',?)`,[netErr.message.slice(0,1000)]);}
  }
}

async function openInvoiceOptions(site='',cluster=''){
  let sql=`SELECT i.id,i.invoice_number,i.outstanding,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    WHERE i.status IN ('unpaid','partial','overdue') AND i.outstanding>0 AND NOT EXISTS (SELECT 1 FROM payments pp WHERE pp.invoice_id=i.id AND pp.status='pending')`;
  const params=[];if(site){sql+=` AND s.code=?`;params.push(site);}if(cluster){sql+=` AND c.cluster_id=?`;params.push(Number(cluster));}sql+=` ORDER BY s.code,cl.name,c.name,i.due_date`;
  const [rows]=await db.execute(sql,params);
  return rows;
}
async function staffOptions(){
  const [rows]=await db.query(`SELECT id,name,role FROM users WHERE is_active=1 ORDER BY name`);return rows;
}
async function bankOptions(){
  const [rows]=await db.query(`SELECT id,bank_name,account_name,account_number,type FROM banks WHERE is_active=1 AND type IN ('bank_transfer','virtual_account','other') ORDER BY bank_name,account_number`);return rows;
}

router.get('/',async(req,res)=>{
  const q=String(req.query.q||'').trim();
  const site=String(req.query.site||'').trim();
  const cluster=String(req.query.cluster||'').trim();
  const month=Number(req.query.month)>=1&&Number(req.query.month)<=12?Number(req.query.month):'';
  const year=Number(req.query.year)>=2020&&Number(req.query.year)<=2100?Number(req.query.year):'';
  const approval=['pending','confirmed','failed'].includes(String(req.query.approval||''))?String(req.query.approval):'';
  let sql=`SELECT p.*,i.invoice_number,i.due_date,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,u.name collector_name,v.name verifier_name,pu.name proof_uploader_name
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by) LEFT JOIN users v ON v.id=p.verified_by LEFT JOIN users pu ON pu.id=p.proof_uploaded_by WHERE 1=1`;
  const params=[];
  if(site){sql+=` AND s.code=?`;params.push(site);}
  if(cluster){sql+=` AND c.cluster_id=?`;params.push(Number(cluster));}
  if(month&&year){sql+=` AND MONTH(p.paid_at)=? AND YEAR(p.paid_at)=?`;params.push(month,year);}
  if(approval){sql+=` AND p.status=?`;params.push(approval);}
  if(q){const like=`%${q}%`;sql+=` AND (c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR p.reference LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)`;params.push(like,like,like,like,like,like);}
  sql+=` ORDER BY p.id DESC LIMIT 500`;
  const [payments]=await db.execute(sql,params);
  const openInvoices=await openInvoiceOptions(site,cluster);
  const staff=await staffOptions();
  const banks=await bankOptions();
  const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);
  const summaryMonth=month||new Date().getMonth()+1,summaryYear=year||new Date().getFullYear();
  const summaryWhere=['MONTH(p.paid_at)=?','YEAR(p.paid_at)=?'];const summaryParams=[summaryMonth,summaryYear];
  if(site){summaryWhere.push('s.code=?');summaryParams.push(site);}if(cluster){summaryWhere.push('c.cluster_id=?');summaryParams.push(Number(cluster));}
  const [[summary]]=await db.execute(`SELECT
    COALESCE(SUM(CASE WHEN p.status='confirmed' THEN p.amount ELSE 0 END),0) confirmed_total,
    COALESCE(SUM(CASE WHEN p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' THEN p.amount ELSE 0 END),0) cash_held,
    COALESCE(SUM(CASE WHEN p.status='pending' THEN p.amount ELSE 0 END),0) transfer_pending,
    SUM(p.status='confirmed') confirmed_count
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id WHERE ${summaryWhere.join(' AND ')}`,summaryParams);
  // Transactions Master Admin already approved but which never received a transfer/QRIS proof attachment.
  const [[missingProof]]=await db.execute(`SELECT COUNT(*) total,COALESCE(SUM(p.amount),0) amount FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id WHERE p.status='confirmed' AND p.method IN ('transfer','qris') AND (p.proof_path IS NULL OR p.proof_path='')${site?` AND s.code=?`:''}`,site?[site]:[]);
  const preselectedInvoiceId=Number(req.query.invoice_id||0)||null;
  let cashApprovals=[];
  if(isMasterAdminRole(req.session.user.role)){
    // v1.24.5 — the source_type='manual' filter was removed: an "AUTO BILLING" (source_type='payment')
    // row edited from Data Kas also drops back to PENDING_APPROVAL now, so it needs to surface here too,
    // otherwise it would be stuck pending with no visible queue to approve/reject it from.
    [cashApprovals]=await db.query(`SELECT ct.id,ct.transaction_code,ct.transaction_date,ct.name,ct.amount,ct.notes,ct.proof_path,ct.proof_mime,ct.approval_status,cc.name category_name,cc.type category_type,s.code site_code,u.name creator_name FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id LEFT JOIN users u ON u.id=ct.created_by WHERE ct.approval_status='PENDING_APPROVAL' ORDER BY ct.transaction_date DESC,ct.id DESC LIMIT 250`);
  }
  res.render('payments/index',{title:'Approval & Transaksi',payments,openInvoices,staff,banks,sites,clusters,cashApprovals,summary:summary||{},missingProof:missingProof||{total:0,amount:0},preselectedInvoiceId,filters:{q,site,cluster,month,year,approval},summaryMonth,summaryYear});
});

router.post('/',requireAdmin,async(req,res)=>{
  const ids=selectedInvoiceIds(req.body);
  if(!ids.length)throw new Error('Pilih minimal satu faktur yang akan dibayar.');
  const {method,notes,collector_user_id}=req.body;
  const normalizedMethod=['transfer','cash','qris'].includes(method)?method:'transfer';
  let bankName=null;
  if(normalizedMethod==='transfer'){
    const [bankRows]=await db.execute(`SELECT id,bank_name,account_name,account_number FROM banks WHERE id=? AND is_active=1 AND type IN ('bank_transfer','virtual_account','other') LIMIT 1`,[req.body.bank_id||0]);
    if(!bankRows.length)throw new Error('Pilih bank tujuan yang aktif dari Pengaturan → Bank.');
    const bank=bankRows[0];bankName=`${bank.bank_name} · ${bank.account_number} · ${bank.account_name}`;
  }else if(normalizedMethod==='qris')bankName='QRIS';
  const isAdmin=isAdminRole(req.session.user.role);
  const status='pending';
  const settlement='not_applicable';
  const collector=normalizedMethod==='cash'?(isAdmin?(collector_user_id||req.session.user.id):req.session.user.id):req.session.user.id;
  const conn=await db.getConnection();
  const created=[];const savedFiles=[];
  try{
    await conn.beginTransaction();
    for(const invoiceId of ids){
      const [invoiceRows]=await conn.execute(`SELECT id,outstanding,status FROM invoices WHERE id=? FOR UPDATE`,[invoiceId]);
      if(!invoiceRows.length)throw new Error(`Faktur #${invoiceId} tidak ditemukan.`);
      const invoice=invoiceRows[0];
      if(['paid','cancelled','refunded'].includes(invoice.status)||Number(invoice.outstanding)<=0)throw new Error(`Faktur #${invoiceId} sudah tidak memiliki sisa tagihan.`);
      // The invoice row is already locked above, so every competing payment flow is serialized here.
      const [[pending]]=await conn.execute(`SELECT COUNT(*) total FROM payments WHERE invoice_id=? AND status='pending'`,[invoiceId]);
      if(Number(pending.total)>0)throw new Error(`Faktur #${invoiceId} sudah memiliki pembayaran yang menunggu approval.`);
      const numericAmount=Number(invoice.outstanding);
      if(!Number.isFinite(numericAmount)||numericAmount<=0)throw new Error(`Nominal faktur #${invoiceId} harus lebih dari 0.`);
      if(numericAmount>Number(invoice.outstanding))throw new Error(`Nominal faktur #${invoiceId} melebihi sisa tagihan (${Number(invoice.outstanding).toLocaleString('id-ID')}).`);
      let savedProof=null;
      if(req.file){savedProof=await saveProofFile(req.file);savedFiles.push(savedProof.filename);}
      const [r]=await conn.execute(`INSERT INTO payments (invoice_id,amount,method,reference,notes,status,settlement_status,bank_name,proof_reference,proof_path,proof_original_name,proof_mime,proof_size,proof_uploaded_by,proof_uploaded_at,paid_at,received_by,collector_user_id,verified_by,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?)`,[
        invoiceId,numericAmount,normalizedMethod,null,notes||null,status,settlement,bankName,savedProof?.originalName||null,savedProof?.filename||null,savedProof?.originalName||null,savedProof?.mime||null,savedProof?.size||null,savedProof?req.session.user.id:null,savedProof?new Date():null,req.session.user.id,collector,status==='confirmed'?req.session.user.id:null,status==='confirmed'?new Date():null
      ]);
      const autoReference=paymentReference(r.insertId);
      await conn.execute(`UPDATE payments SET reference=? WHERE id=?`,[autoReference,r.insertId]);
      created.push({paymentId:r.insertId,invoiceId,amount:numericAmount,reference:autoReference});
      await refreshInvoiceStatus(conn,invoiceId);
    }
    await conn.commit();
    await audit({userId:req.session.user.id,action:'create',entityType:'payment_batch',entityId:created[0]?.paymentId||null,description:`Pembayaran ${normalizedMethod} ${created.length} faktur · total Rp${created.reduce((a,x)=>a+x.amount,0)}${req.file?' · bukti terupload':' · tanpa bukti'}`,ip:req.ip});
    const total=created.reduce((a,x)=>a+x.amount,0);
    req.session.flash={type:'success',message:`${created.length} pembayaran berhasil diajukan dengan total Rp${total.toLocaleString('id-ID')}${req.file?' beserta bukti':' tanpa bukti'}. Menunggu approval Master Admin sebelum tagihan dinyatakan lunas.`};
  }catch(e){await conn.rollback();for(const f of savedFiles)await removeProofFile(f);throw e;}finally{conn.release();}
  res.redirect(localReturn(req.body.return_to,'/payments'));
});

router.get('/:id/proof',async(req,res)=>{
  const [rows]=await db.execute(`SELECT proof_path,proof_original_name,proof_mime FROM payments WHERE id=? LIMIT 1`,[req.params.id]);
  const p=rows[0];if(!p?.proof_path)return res.status(404).send('Bukti pembayaran tidak ditemukan.');
  const filename=path.basename(p.proof_path);const fullPath=path.join(PROOF_DIR,filename);
  if(!fs.existsSync(fullPath))return res.status(404).send('File bukti pembayaran tidak ditemukan di storage.');
  res.type(p.proof_mime||'application/octet-stream');
  const safeOriginal=(p.proof_original_name||filename).replace(/[\r\n"]/g,'_');
  res.setHeader('Content-Disposition',`inline; filename="${safeOriginal}"`);res.setHeader('Cache-Control','private, max-age=300');res.setHeader('X-Content-Type-Options','nosniff');res.sendFile(fullPath);
});

router.post('/:id/proof',async(req,res)=>{
  if(!req.file)throw new Error('Pilih file bukti pembayaran terlebih dahulu.');
  const [rows]=await db.execute(`SELECT id,method,proof_path,received_by,collector_user_id FROM payments WHERE id=? LIMIT 1`,[req.params.id]);
  const payment=rows[0];if(!payment)throw new Error('Pembayaran tidak ditemukan.');
  const ownsPayment=Number(payment.received_by)===Number(req.session.user.id)||Number(payment.collector_user_id)===Number(req.session.user.id);
  if(!isAdminRole(req.session.user.role)&&!ownsPayment)throw new Error('Anda hanya dapat mengupload bukti untuk pembayaran yang Anda catat.');
  if(!['transfer','cash','qris','gateway','other'].includes(payment.method))throw new Error('Metode pembayaran tidak mendukung bukti.');
  let savedProof=null;
  try{
    savedProof=await saveProofFile(req.file);
    await db.execute(`UPDATE payments SET proof_reference=?,proof_path=?,proof_original_name=?,proof_mime=?,proof_size=?,proof_uploaded_by=?,proof_uploaded_at=NOW() WHERE id=?`,[
      savedProof.originalName,savedProof.filename,savedProof.originalName,savedProof.mime,savedProof.size,req.session.user.id,payment.id
    ]);
    await removeProofFile(payment.proof_path);
    await audit({userId:req.session.user.id,action:'upload_proof',entityType:'payment',entityId:payment.id,description:'Upload/ganti bukti pembayaran',ip:req.ip});
    req.session.flash={type:'success',message:'Bukti pembayaran berhasil diupload.'};
  }catch(e){if(savedProof)await removeProofFile(savedProof.filename);throw e;}
  res.redirect(localReturn(req.body.return_to,'/payments'));
});

router.post('/:id/verify',requireMasterAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[req.params.id]);
    const p=rows[0];if(!p)throw new Error('Pembayaran tidak ditemukan');
    if(p.status!=='pending')throw new Error('Hanya pembayaran berstatus menunggu yang dapat disetujui.');
    const [invoiceRows]=await conn.execute(`SELECT outstanding,status FROM invoices WHERE id=? FOR UPDATE`,[p.invoice_id]);
    if(!invoiceRows.length)throw new Error('Faktur pembayaran tidak ditemukan.');
    if(Number(p.amount)>Number(invoiceRows[0].outstanding))throw new Error('Nominal transfer melebihi sisa tagihan saat ini. Periksa pembayaran lain sebelum verifikasi.');
    await conn.execute(`UPDATE payments SET status='confirmed',settlement_status=?,verified_by=?,verified_at=NOW() WHERE id=?`,[p.method==='cash'?'held_by_staff':'not_applicable',req.session.user.id,p.id]);
    await refreshInvoiceStatus(conn,p.invoice_id);
    if(p.method!=='cash')await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:p.reference,actorUserId:req.session.user.id});
    await conn.commit();
    await audit({userId:req.session.user.id,action:'approve',entityType:'payment',entityId:p.id,description:`Approval Master Admin ${p.proof_path?'dengan bukti':'tanpa bukti'} untuk pembayaran ${p.reference||p.id}`,ip:req.ip});
    await maybeAutoUnisolate(p.invoice_id);
    req.session.flash={type:'success',message:`Pembayaran disetujui Master Admin ${p.proof_path?'berdasarkan bukti':'tanpa bukti lampiran'}. Tagihan dan jurnal terkait sudah diperbarui.`};
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Verifikasi gagal: ${e.message}`};}finally{conn.release();}
  res.redirect(localReturn(req.body.return_to,'/payments'));
});

// v1.25.2 — "Approve Massal": Master Admin can select several pending payments in the Riwayat
// Pembayaran table and approve them all at once. Reuses the EXACT same per-row guard/locking as the
// single /:id/verify route above (one `SELECT ... FOR UPDATE` transaction per payment, still checked
// against the invoice's CURRENT outstanding), just looped — so a batch never bypasses the same
// financial-safety checks that protect individual approvals. Payments that fail their own guard (already
// resolved, or amount now exceeds outstanding because of a race) are skipped rather than aborting the batch.
router.post('/bulk-verify',requireMasterAdmin,async(req,res)=>{
  const returnTo=localReturn(req.body.return_to,'/payments');
  const ids=selectedPaymentIds(req.body);
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu pembayaran terlebih dahulu.'};return res.redirect(returnTo);}
  if(ids.length>200){req.session.flash={type:'danger',message:'Maksimal 200 pembayaran per approval massal.'};return res.redirect(returnTo);}
  const done=[];const skipped=[];
  for(const id of ids){
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[id]);
      const p=rows[0];
      if(!p||p.status!=='pending'){await conn.rollback();continue;}
      const [invoiceRows]=await conn.execute(`SELECT outstanding,status FROM invoices WHERE id=? FOR UPDATE`,[p.invoice_id]);
      if(!invoiceRows.length||Number(p.amount)>Number(invoiceRows[0].outstanding)){await conn.rollback();skipped.push(p);continue;}
      await conn.execute(`UPDATE payments SET status='confirmed',settlement_status=?,verified_by=?,verified_at=NOW() WHERE id=?`,[p.method==='cash'?'held_by_staff':'not_applicable',req.session.user.id,p.id]);
      await refreshInvoiceStatus(conn,p.invoice_id);
      if(p.method!=='cash')await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:p.reference,actorUserId:req.session.user.id});
      await conn.commit();
      done.push(p);
    }catch(e){await conn.rollback();skipped.push({id});}finally{conn.release();}
  }
  if(done.length){
    for(const p of done){await maybeAutoUnisolate(p.invoice_id);}
    await audit({userId:req.session.user.id,action:'bulk_approve',entityType:'payment',entityId:null,description:`Approval massal ${done.length} pembayaran: ${done.map(p=>p.reference||`#${p.id}`).slice(0,20).join(', ')}${done.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena sudah tidak menunggu / nominal melebihi sisa tagihan terkini)`:''}`,ip:req.ip});
  }
  if(!done.length){req.session.flash={type:'danger',message:'Semua pembayaran terpilih sudah tidak berstatus menunggu, atau nominalnya melebihi sisa tagihan saat ini.'};return res.redirect(returnTo);}
  req.session.flash={type:'success',message:`${done.length} pembayaran disetujui. Tagihan dan jurnal kas terkait sudah diperbarui.${skipped.length?` ${skipped.length} pembayaran dilewati karena sudah tidak menunggu approval atau nominalnya melebihi sisa tagihan saat ini.`:''}`};
  res.redirect(returnTo);
});

router.post('/:id/reject',requireMasterAdmin,async(req,res)=>{
  const reason=String(req.body.reason||'').trim().slice(0,500);
  const returnTo=localReturn(req.body.return_to,'/payments');
  if(reason.length<3){
    req.session.flash={type:'danger',message:'Alasan penolakan wajib diisi minimal 3 karakter.'};
    return res.redirect(returnTo);
  }
  const conn=await db.getConnection();let payment=null;let notified=0;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT p.*,i.invoice_number,c.customer_code,c.name customer_name
      FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id
      WHERE p.id=? FOR UPDATE`,[req.params.id]);
    payment=rows[0];if(!payment)throw new Error('Pembayaran tidak ditemukan.');
    if(payment.status!=='pending')throw new Error('Hanya pembayaran berstatus menunggu yang dapat ditolak.');
    await conn.execute(`UPDATE payments SET status='failed',settlement_status='not_applicable',verified_by=?,verified_at=NOW(),rejection_reason=?,rejected_by=?,rejected_at=NOW(),notes=CONCAT_WS('\n',NULLIF(notes,''),?) WHERE id=?`,[req.session.user.id,reason,req.session.user.id,`DITOLAK MASTER ADMIN: ${reason}`,payment.id]);
    await refreshInvoiceStatus(conn,payment.invoice_id);
    const title=`Pembayaran ${payment.reference||payment.id} ditolak`;
    const detail=`${payment.customer_name} · ${payment.invoice_number} · Alasan: ${reason}`.slice(0,700);
    const href=`/payments?approval=failed&q=${encodeURIComponent(payment.reference||payment.invoice_number||payment.customer_code||'')}`;
    const [notifyResult]=await conn.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id)
      SELECT u.id,'payment_rejected','danger','bi-x-octagon-fill',?,?,?,'payment',? FROM users u
      WHERE u.is_active=1 AND (LOWER(TRIM(u.role)) IN ('admin','master_admin') OR LOWER(TRIM(u.name)) LIKE '%padilah%' OR LOWER(TRIM(u.username)) LIKE '%padilah%')`,[title,detail,href,payment.id]);
    notified=Number(notifyResult.affectedRows||0);
    await conn.commit();
    await audit({userId:req.session.user.id,action:'reject',entityType:'payment',entityId:payment.id,description:`Pembayaran ${payment.reference||payment.id} ditolak: ${reason}`,ip:req.ip});
    req.session.flash={type:'warning',message:`Pembayaran ditolak. Alasan tersimpan dan notifikasi dikirim ke ${notified} akun Admin/Padilah. Faktur tetap terbuka.`};
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Penolakan gagal: ${e.message}`};}finally{conn.release();}
  res.redirect(returnTo);
});

router.get('/reconciliation',requireAdmin,async(req,res)=>{
  const q=String(req.query.q||'').trim();const site=String(req.query.site||'').trim();const cluster=String(req.query.cluster||'').trim();
  let heldSql=`SELECT p.*,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,u.name collector_name,i.invoice_number
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff'`;
  const heldParams=[];
  if(site){heldSql+=` AND s.code=?`;heldParams.push(site);}
  if(cluster){heldSql+=` AND c.cluster_id=?`;heldParams.push(Number(cluster));}
  if(q){const like=`%${q}%`;heldSql+=` AND (c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR u.name LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)`;heldParams.push(like,like,like,like,like,like);}
  heldSql+=` ORDER BY u.name,p.paid_at`;
  const [held]=await db.execute(heldSql,heldParams);
  const [staffBalances]=await db.query(`SELECT COALESCE(u.id,0) user_id,COALESCE(u.name,'Tidak diketahui') collector_name,COUNT(*) transactions,COALESCE(SUM(p.amount),0) amount
    FROM payments p LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' GROUP BY u.id,u.name ORDER BY amount DESC`);
  const [[summary]]=await db.query(`SELECT
    COALESCE(SUM(CASE WHEN method='cash' AND status='confirmed' AND settlement_status='held_by_staff' THEN amount ELSE 0 END),0) held_total,
    COALESCE(SUM(CASE WHEN method='cash' AND status='confirmed' AND settlement_status='settled' AND DATE(settled_at)=CURDATE() THEN amount ELSE 0 END),0) settled_today,
    COALESCE(SUM(CASE WHEN method='transfer' AND status='confirmed' AND DATE(paid_at)=CURDATE() THEN amount ELSE 0 END),0) transfer_today
    FROM payments`);
  const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);
  res.render('payments/reconciliation',{title:'Rekonsiliasi Pembayaran',held,staffBalances,summary:summary||{},q,site,cluster,sites,clusters});
});

router.post('/:id/settle',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[req.params.id]);
    const p=rows[0];if(!p)throw new Error('Pembayaran tidak ditemukan');
    if(p.method!=='cash')throw new Error('Hanya pembayaran cash yang perlu disetor');
    if(p.settlement_status!=='settled'){
      await conn.execute(`UPDATE payments SET settlement_status='settled',settled_by=?,settled_at=NOW() WHERE id=?`,[req.session.user.id,p.id]);
      await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:p.reference,categoryName:'Setoran Cash Pelanggan',prefix:'Setoran Cash',actorUserId:req.session.user.id});
    }
    await conn.commit();
    await audit({userId:req.session.user.id,action:'settle',entityType:'payment',entityId:p.id,description:'Konfirmasi setoran cash staff ke kas perusahaan',ip:req.ip});
    req.session.flash={type:'success',message:'Setoran cash dikonfirmasi dan masuk ke kas perusahaan.'};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  res.redirect('/payments/reconciliation');
});

// v1.25.5 (update) — "Konfirmasi Setoran Massal": same idea as Approve Massal on Menu Approval &
// Transaksi. Loops the EXACT same per-row guard/locking as the single /:id/settle route above (one
// `SELECT ... FOR UPDATE` transaction per payment), so a batch can never settle something the single-row
// action would have refused. Rows that are no longer held-by-staff cash (already settled, or turned out
// not to be cash) are skipped rather than aborting the whole batch.
router.post('/bulk-settle',requireAdmin,async(req,res)=>{
  const returnTo=localReturn(req.body.return_to,'/payments/reconciliation');
  const ids=selectedPaymentIds(req.body);
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu setoran terlebih dahulu.'};return res.redirect(returnTo);}
  if(ids.length>200){req.session.flash={type:'danger',message:'Maksimal 200 setoran per konfirmasi massal.'};return res.redirect(returnTo);}
  const done=[];const skipped=[];
  for(const id of ids){
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[id]);
      const p=rows[0];
      if(!p||p.method!=='cash'||p.settlement_status!=='held_by_staff'){await conn.rollback();skipped.push(p||{id});continue;}
      await conn.execute(`UPDATE payments SET settlement_status='settled',settled_by=?,settled_at=NOW() WHERE id=?`,[req.session.user.id,p.id]);
      await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:p.reference,categoryName:'Setoran Cash Pelanggan',prefix:'Setoran Cash',actorUserId:req.session.user.id});
      await conn.commit();
      done.push(p);
    }catch(e){await conn.rollback();skipped.push({id});}finally{conn.release();}
  }
  if(done.length){
    await audit({userId:req.session.user.id,action:'bulk_settle',entityType:'payment',entityId:null,description:`Konfirmasi setoran massal ${done.length} pembayaran cash: ${done.map(p=>p.reference||`#${p.id}`).slice(0,20).join(', ')}${done.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena sudah disetor atau bukan lagi cash tertahan di staff)`:''}`,ip:req.ip});
  }
  if(!done.length){req.session.flash={type:'danger',message:'Semua setoran terpilih sudah disetor sebelumnya, atau bukan lagi cash yang tertahan di staff.'};return res.redirect(returnTo);}
  req.session.flash={type:'success',message:`${done.length} setoran cash dikonfirmasi dan masuk ke kas perusahaan.${skipped.length?` ${skipped.length} dilewati karena sudah disetor sebelumnya.`:''}`};
  res.redirect(returnTo);
});

module.exports=router;
