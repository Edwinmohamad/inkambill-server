const express=require('express');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const ExcelJS=require('exceljs');
const db=require('../config/db');
const {paginate}=require('../utils/pagination');
const { refreshInvoiceStatus }=require('../services/invoiceService');
const { audit }=require('../services/auditService');
const { unisolateCustomer }=require('../services/networkService');
const { assignCashTransactionCode }=require('../services/cashService');
const { isoDate, assertDateOpen, resolveBookDate, financialAudit }=require('../services/financialControlService');
const { requireAdmin, requireMasterAdmin, isAdminRole, isMasterAdminRole }=require('../middleware/auth');
const { createReportPdf, rupiah, COLORS }=require('../services/reportPdf');
const { ensureV53Schema }=require('../services/schemaService');
const { cashAgingDays, queuePaymentReceipts, streamSettlementReceipt }=require('../services/cashSettlementService');
const router=express.Router();

// v1.26 — shared header styling for reconciliation export sheets (same convention as
// routes/customers.js / routes/clusters.js: bold white header row on a brand-purple fill,
// frozen header + autofilter so exported files are immediately usable in Excel).
function styleWorkbook(ws){
  ws.views=[{state:'frozen',ySplit:1}];
  ws.autoFilter={from:'A1',to:ws.getRow(1).getCell(ws.columnCount).address};
  const row=ws.getRow(1);row.height=22;
  row.eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF6030E0'}};cell.alignment={vertical:'middle'};cell.border={bottom:{style:'thin',color:{argb:'FFFF433E'}}};});
}

const { PROOF_DIR,saveProofFile,removeProofFile,paymentReference,postCashTransaction,maybeAutoUnisolate,verifyPendingPayment }=require('../services/paymentVerificationService');

// v1.30 — helper bukti & jurnal dipindah ke services/paymentVerificationService.js (dipakai juga Web Inbox WA).
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
async function openInvoiceOptions(site='',cluster=''){
  let sql=`SELECT i.id,i.invoice_number,i.outstanding,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    WHERE c.customer_status='active' AND c.archived_at IS NULL
      AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
      AND NOT EXISTS (SELECT 1 FROM payments pp WHERE pp.invoice_id=i.id AND pp.status='pending')`;
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
  // v1.29 — filter metode (cash/transfer/QRIS).
  const method=['cash','transfer','qris'].includes(String(req.query.method||''))?String(req.query.method):'';
  // Filter penerima dibuat eksplisit agar antrean approval cash dan transfer
  // dapat dipisahkan tanpa mengandalkan pencarian teks. Nilai URL sengaja hanya
  // memakai ID (bukan nama/rekening) lalu divalidasi terhadap data aktif.
  const recipient=String(req.query.recipient||'').trim();
  const staff=await staffOptions();
  const banks=await bankOptions();
  const cashRecipientId=/^cash:(\d+)$/.test(recipient)?Number(recipient.slice(5)):0;
  const transferRecipientId=/^transfer:(\d+)$/.test(recipient)?Number(recipient.slice(9)):0;
  const cashRecipient=cashRecipientId&&staff.some(member=>Number(member.id)===cashRecipientId)?cashRecipientId:0;
  const transferBank=transferRecipientId?banks.find(bank=>Number(bank.id)===transferRecipientId):null;
  const activeRecipient=cashRecipient?`cash:${cashRecipient}`:transferBank?`transfer:${transferBank.id}`:'';
  let sql=`SELECT p.*,i.invoice_number,i.due_date,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,u.name collector_name,v.name verifier_name,pu.name proof_uploader_name
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by) LEFT JOIN users v ON v.id=p.verified_by LEFT JOIN users pu ON pu.id=p.proof_uploaded_by
    WHERE 1=1`;
  const params=[];
  if(site){sql+=` AND s.code=?`;params.push(site);}
  if(cluster){sql+=` AND c.cluster_id=?`;params.push(Number(cluster));}
  if(month&&year){sql+=` AND MONTH(p.paid_at)=? AND YEAR(p.paid_at)=?`;params.push(month,year);}
  if(approval){sql+=` AND p.status=?`;params.push(approval);}
  if(method){sql+=` AND p.method=?`;params.push(method);}
  if(cashRecipient){sql+=` AND p.method='cash' AND COALESCE(p.collector_user_id,p.received_by)=?`;params.push(cashRecipient);}
  if(transferBank){
    const bankLabel=`${transferBank.bank_name} · ${transferBank.account_number} · ${transferBank.account_name}`;
    sql+=` AND p.method='transfer' AND p.bank_name=?`;params.push(bankLabel);
  }
  if(q){const like=`%${q}%`;sql+=` AND (c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR p.reference LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)`;params.push(like,like,like,like,like,like);}
  sql+=approval==='pending'?` ORDER BY p.id ASC`:` ORDER BY p.id DESC`;
  const pageResult=await paginate(db,sql,params,req,50);const payments=pageResult.rows;res.locals.pagination=pageResult.pagination;
  const countWhere=[];const countParams=[];
  if(site){countWhere.push('s.code=?');countParams.push(site);}if(cluster){countWhere.push('c.cluster_id=?');countParams.push(Number(cluster));}
  if(month&&year){countWhere.push('MONTH(p.paid_at)=? AND YEAR(p.paid_at)=?');countParams.push(month,year);}
  const countSql=countWhere.length?` AND ${countWhere.join(' AND ')}`:'';
  const [methodRows]=await db.execute(`SELECT p.method,COUNT(*) total,SUM(p.status='pending') pending FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id WHERE 1=1${countSql} GROUP BY p.method`,countParams);
  const methodCounts={cash:{total:0,pending:0},transfer:{total:0,pending:0},qris:{total:0,pending:0}};
  for(const r of methodRows)if(methodCounts[r.method])methodCounts[r.method]={total:Number(r.total||0),pending:Number(r.pending||0)};
  const openInvoices=await openInvoiceOptions(site,cluster);
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
  // v1.25.8 — visibility and authorization are intentionally separated.
  // Every user who can open Approval & Transaksi must be able to SEE pending manual-cash requests,
  // otherwise an Admin can submit Data Kas successfully and it appears to vanish. Approve/Reject
  // remain protected by requireMasterAdmin on the mutation routes.
  const [cashApprovals]=await db.query(`SELECT ct.id,ct.transaction_code,ct.transaction_date,ct.name,ct.amount,ct.notes,ct.proof_path,ct.proof_mime,COALESCE(ct.approval_status,'PENDING_APPROVAL') approval_status,cc.name category_name,cc.type category_type,s.code site_code,u.name creator_name FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id LEFT JOIN users u ON u.id=ct.created_by WHERE ct.approval_status='PENDING_APPROVAL' OR (ct.approval_status IS NULL AND COALESCE(ct.source_type,'manual')='manual') ORDER BY ct.transaction_date DESC,ct.id DESC LIMIT 250`);
  res.render('payments/index',{title:'Approval & Transaksi',payments,openInvoices,staff,banks,sites,clusters,cashApprovals,summary:summary||{},missingProof:missingProof||{total:0,amount:0},preselectedInvoiceId,filters:{q,site,cluster,month,year,approval,method,recipient:activeRecipient},methodCounts,summaryMonth,summaryYear});
});

router.post('/',requireAdmin,async(req,res)=>{
  const ids=selectedInvoiceIds(req.body);
  if(!ids.length)throw new Error('Pilih minimal satu faktur yang akan dibayar.');
  const {method,notes,collector_user_id}=req.body;
  const normalizedMethod=['transfer','cash','qris'].includes(method)?method:'transfer';
  const paidDate=isoDate(req.body.paid_at)||isoDate(new Date());
  const requestKey=String(req.body.idempotency_key||crypto.randomUUID()).slice(0,150);
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
      const [invoiceRows]=await conn.execute(`SELECT i.id,i.outstanding,i.status
        FROM invoices i JOIN customers c ON c.id=i.customer_id
        WHERE i.id=? AND c.customer_status='active' AND c.archived_at IS NULL FOR UPDATE`,[invoiceId]);
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
      const [r]=await conn.execute(`INSERT INTO payments (invoice_id,amount,method,reference,idempotency_key,notes,status,settlement_status,bank_name,proof_reference,proof_path,proof_original_name,proof_mime,proof_size,proof_uploaded_by,proof_uploaded_at,paid_at,received_by,collector_user_id,verified_by,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
        invoiceId,numericAmount,normalizedMethod,null,`${requestKey}:${invoiceId}`,notes||null,status,settlement,bankName,savedProof?.originalName||null,savedProof?.filename||null,savedProof?.originalName||null,savedProof?.mime||null,savedProof?.size||null,savedProof?req.session.user.id:null,savedProof?new Date():null,`${paidDate} 12:00:00`,req.session.user.id,collector,status==='confirmed'?req.session.user.id:null,status==='confirmed'?new Date():null
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

// Koreksi administratif yang aman: transfer/QRIS yang salah input dapat
// dipindahkan menjadi cash. Untuk pembayaran confirmed, jurnal transfer
// otomatis dibatalkan dan nominal kembali tercatat sebagai cash di collector.
router.post('/:id/method-to-cash',requireMasterAdmin,async(req,res)=>{
  const paymentId=Number(req.params.id);
  const collectorId=Number(req.body.collector_user_id);
  const reason=String(req.body.reason||'').trim().slice(0,500);
  const returnTo=localReturn(req.body.return_to,'/payments');
  if(!Number.isInteger(paymentId)||paymentId<1){req.session.flash={type:'danger',message:'Pembayaran tidak valid.'};return res.redirect(returnTo);}
  if(!Number.isInteger(collectorId)||collectorId<1){req.session.flash={type:'danger',message:'Pilih admin/collector yang menerima cash.'};return res.redirect(returnTo);}
  if(reason.length<3){req.session.flash={type:'danger',message:'Alasan koreksi wajib diisi minimal 3 karakter.'};return res.redirect(returnTo);}
  const conn=await db.getConnection();
  let auditDescription='';
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT p.id,p.method,p.status,p.settlement_status,p.reference,p.amount,p.invoice_id,p.paid_at,p.booked_at,u.name collector_name
      FROM payments p LEFT JOIN users u ON u.id=? WHERE p.id=? FOR UPDATE`,[collectorId,paymentId]);
    const payment=rows[0];
    if(!payment)throw new Error('Pembayaran tidak ditemukan.');
    // Sebelumnya memakai variabel `paidDate` yang tidak pernah didefinisikan sehingga koreksi selalu gagal.
    await assertDateOpen(conn,payment.booked_at||payment.paid_at);
    if(!['transfer','qris'].includes(payment.method))throw new Error('Hanya pembayaran transfer atau QRIS yang dapat dikoreksi menjadi cash.');
    if(!['pending','confirmed'].includes(payment.status))throw new Error('Pembayaran yang ditolak tidak dapat dikoreksi.');
    const [staffRows]=await conn.execute('SELECT id,name FROM users WHERE id=? AND is_active=1 LIMIT 1',[collectorId]);
    if(!staffRows.length)throw new Error('Admin/collector tidak ditemukan atau sudah tidak aktif.');
    if(payment.status==='confirmed'){
      await conn.execute("DELETE FROM cash_transactions WHERE source_type='payment' AND source_id=?",[payment.id]);
    }
    await conn.execute(`UPDATE payments SET method='cash',bank_name=NULL,collector_user_id=?,settlement_status=? WHERE id=?`,[
      collectorId,payment.status==='confirmed'?'held_by_staff':'not_applicable',payment.id
    ]);
    await conn.commit();
    auditDescription=`Koreksi metode ${payment.method} menjadi cash untuk ${payment.reference||`#${payment.id}`} · collector ${staffRows[0].name} · alasan: ${reason}`;
    await audit({userId:req.session.user.id,action:'correct_payment_method',entityType:'payment',entityId:payment.id,description:auditDescription,ip:req.ip});
    req.session.flash={type:'success',message:`Metode pembayaran berhasil diubah menjadi cash. ${payment.status==='confirmed'?'Jurnal transfer dibatalkan dan nominal masuk Cash Masih di Tim.':'Pembayaran tetap menunggu approval.'}`};
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Koreksi gagal: ${e.message}`};}finally{conn.release();}
  res.redirect(returnTo);
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
  try{
    const {payment:p}=await verifyPendingPayment(req.params.id,{userId:req.session.user.id,ip:req.ip,bookDateMode:req.body.book_date_mode,manualBookDate:req.body.manual_book_date});
    await audit({userId:req.session.user.id,action:'approve',entityType:'payment',entityId:p.id,description:`Approval Master Admin ${p.proof_path?'dengan bukti':'tanpa bukti'} untuk pembayaran ${p.reference||p.id}`,ip:req.ip});
    req.session.flash={type:'success',message:`Pembayaran disetujui Master Admin ${p.proof_path?'berdasarkan bukti':'tanpa bukti lampiran'}. Tagihan dan jurnal terkait sudah diperbarui.`};
  }catch(e){req.session.flash={type:'danger',message:`Verifikasi gagal: ${e.message}`};}
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
      if(['transfer','qris'].includes(p.method)&&!p.proof_path){await conn.rollback();skipped.push(p);continue;}
      const booking=await resolveBookDate(conn,{mode:req.body.book_date_mode,paidAt:p.paid_at,manualDate:req.body.manual_book_date});
      const [invoiceRows]=await conn.execute(`SELECT i.outstanding,i.status
        FROM invoices i JOIN customers c ON c.id=i.customer_id
        WHERE i.id=? AND c.customer_status='active' AND c.archived_at IS NULL FOR UPDATE`,[p.invoice_id]);
      if(!invoiceRows.length||Number(p.amount)>Number(invoiceRows[0].outstanding)){await conn.rollback();skipped.push(p);continue;}
      await conn.execute(`UPDATE payments SET status='confirmed',settlement_status=?,booked_at=?,booked_date_mode=?,verified_by=?,verified_at=NOW() WHERE id=?`,[p.method==='cash'?'held_by_staff':'not_applicable',booking.date,booking.mode,req.session.user.id,p.id]);
      await refreshInvoiceStatus(conn,p.invoice_id);
      if(p.method!=='cash')await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:p.reference,bookDate:booking.date,actorUserId:req.session.user.id});
      await financialAudit({conn,userId:req.session.user.id,action:'bulk_approve',entityType:'payment',entityId:p.id,before:p,after:{status:'confirmed',booked_at:booking.date,booked_date_mode:booking.mode},reason:'Approval pembayaran massal',ip:req.ip});
      await conn.commit();
      done.push(p);
    }catch(e){await conn.rollback();skipped.push({id});}finally{conn.release();}
  }
  if(done.length){
    for(const p of done){await maybeAutoUnisolate(p.invoice_id);}
    await queuePaymentReceipts(done.map(p=>p.id),req.session.user.id);
    await audit({userId:req.session.user.id,action:'bulk_approve',entityType:'payment',entityId:null,description:`Approval massal ${done.length} pembayaran: ${done.map(p=>p.reference||`#${p.id}`).slice(0,20).join(', ')}${done.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena sudah tidak menunggu / nominal melebihi sisa tagihan terkini)`:''}`,ip:req.ip});
  }
  if(!done.length){req.session.flash={type:'danger',message:`Tidak ada pembayaran yang disetujui. Pembayaran terpilih sudah tidak menunggu, nominalnya melebihi sisa tagihan saat ini.`};return res.redirect(returnTo);}
  req.session.flash={type:'success',message:`${done.length} pembayaran disetujui. Tagihan dan jurnal kas terkait sudah diperbarui.${skipped.length?` ${skipped.length} pembayaran dilewati (sudah tidak menunggu approval, nominal melebihi sisa tagihan, atau tanpa bukti).`:''}`};
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

// v1.26 — factored out of the GET /reconciliation handler so the Excel/PDF export routes below
// can reuse the exact same filtered dataset (same q/site/cluster semantics) instead of duplicating
// the SQL. Only `withLookups` (sites/clusters for the filter dropdowns) is skipped by the exporters,
// since a file download has no <select> to populate.
async function loadReconciliationData(req,{withLookups=false}={}){
  const q=String(req.query.q||'').trim();const site=String(req.query.site||'').trim();const cluster=String(req.query.cluster||'').trim();
  const agingDays=await cashAgingDays();
  const aging=req.query.aging==='overdue'?'overdue':'';
  const collector=Number(req.query.collector)>0?String(Number(req.query.collector)):'';
  let heldSql=`SELECT p.*,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,u.name collector_name,i.invoice_number,
    DATEDIFF(CURDATE(),DATE(p.paid_at)) age_days
    FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff'`;
  const heldParams=[];
  if(site){heldSql+=` AND s.code=?`;heldParams.push(site);}
  if(cluster){heldSql+=` AND c.cluster_id=?`;heldParams.push(Number(cluster));}
  if(q){const like=`%${q}%`;heldSql+=` AND (c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR u.name LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)`;heldParams.push(like,like,like,like,like,like);}
  if(collector){heldSql+=` AND COALESCE(p.collector_user_id,p.received_by)=?`;heldParams.push(Number(collector));}
  if(aging==='overdue'){heldSql+=` AND DATEDIFF(CURDATE(),DATE(p.paid_at))>?`;heldParams.push(agingDays);}
  heldSql+=` ORDER BY u.name,p.paid_at`;
  const [held]=await db.execute(heldSql,heldParams);
  const [staffBalances]=await db.query(`SELECT COALESCE(u.id,0) user_id,COALESCE(u.name,'Tidak diketahui') collector_name,COUNT(*) transactions,COALESCE(SUM(p.amount),0) amount,
    MAX(DATEDIFF(CURDATE(),DATE(p.paid_at))) oldest_days,SUM(DATEDIFF(CURDATE(),DATE(p.paid_at))>${Number(agingDays)}) overdue_count
    FROM payments p LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' GROUP BY u.id,u.name ORDER BY amount DESC`);
  const [[summary]]=await db.query(`SELECT
    COALESCE(SUM(CASE WHEN method='cash' AND status='confirmed' AND settlement_status='held_by_staff' THEN amount ELSE 0 END),0) held_total,
    COALESCE(SUM(CASE WHEN method='cash' AND status='confirmed' AND settlement_status='settled' AND DATE(settled_at)=CURDATE() THEN amount ELSE 0 END),0) settled_today,
    COALESCE(SUM(CASE WHEN method='transfer' AND status='confirmed' AND DATE(paid_at)=CURDATE() THEN amount ELSE 0 END),0) transfer_today,
    COALESCE(SUM(CASE WHEN method='cash' AND status='confirmed' AND settlement_status='held_by_staff' AND DATEDIFF(CURDATE(),DATE(paid_at))>${Number(agingDays)} THEN amount ELSE 0 END),0) overdue_total,
    COALESCE(SUM(method='cash' AND status='confirmed' AND settlement_status='held_by_staff' AND DATEDIFF(CURDATE(),DATE(paid_at))>${Number(agingDays)}),0) overdue_count
    FROM payments`);
  // Widget posisi cash (selalu tampil, tidak terpengaruh filter): cash yang masih dipegang
  // tiap collector + yang sudah disetor bulan berjalan.
  const monthStartSql=`DATE_FORMAT(CURDATE(),'%Y-%m-01')`;
  const [cashByCollector]=await db.query(`SELECT COALESCE(u.id,0) user_id,COALESCE(u.name,'Tidak diketahui') collector_name,
      COALESCE(SUM(CASE WHEN p.settlement_status='held_by_staff' THEN p.amount ELSE 0 END),0) held_amount,
      COALESCE(SUM(p.settlement_status='held_by_staff'),0) held_count,
      COALESCE(SUM(CASE WHEN p.settlement_status='settled' THEN p.amount ELSE 0 END),0) settled_month,
      COALESCE(SUM(p.settlement_status='settled'),0) settled_month_count
    FROM payments p LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by)
    WHERE p.method='cash' AND ((p.status='confirmed' AND p.settlement_status='held_by_staff') OR (p.settlement_status='settled' AND p.settled_at>=${monthStartSql}))
    GROUP BY u.id,u.name ORDER BY held_amount DESC,settled_month DESC`);
  const cashWidget={collectors:cashByCollector,held_total:0,held_count:0,settled_month:0,settled_month_count:0,settled_today:Number(summary?.settled_today||0)};
  cashByCollector.forEach(r=>{cashWidget.held_total+=Number(r.held_amount||0);cashWidget.held_count+=Number(r.held_count||0);cashWidget.settled_month+=Number(r.settled_month||0);cashWidget.settled_month_count+=Number(r.settled_month_count||0);});
  const result={held,staffBalances,summary:summary||{},cashWidget,q,site,cluster,collector,aging,agingDays};
  if(withLookups){
    // Daftar collector untuk dropdown filter: semua user yang pernah memegang pembayaran cash.
    const [collectors]=await db.query(`SELECT u.id,u.name FROM users u WHERE u.id IN (SELECT DISTINCT COALESCE(p.collector_user_id,p.received_by) FROM payments p WHERE p.method='cash') ORDER BY u.name`);
    result.collectors=collectors;
    const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);
    result.sites=sites;result.clusters=clusters;
  }
  return result;
}

// Tab "Histori & Status": daftar cash pelanggan per periode tanggal bayar, dengan filter status
// setoran — Semua / Belum Disetor (masih dipegang staff) / Sudah Disetor (sudah masuk kas perusahaan).
// Memakai filter q/site/cluster yang sama dengan tab Belum Disetor. Default periode: awal bulan
// berjalan s.d. hari ini (WIB).
const RECON_HISTORY_LIMIT=1000;
const RECON_STATUSES=['all','held','settled'];
function jakartaToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta'}).format(new Date());}
function validDateParam(value){const v=String(value||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())?v:'';}
let reconciliationHistorySchemaReady=null;
async function ensureReconciliationHistorySchema(){
  if(reconciliationHistorySchemaReady)return reconciliationHistorySchemaReady;
  reconciliationHistorySchemaReady=(async()=>{
    // Jangan jalankan migration v1.28 penuh ketika user membuka Histori.
    // Sebagian instalasi memakai MariaDB/MySQL yang tidak menerima syntax
    // `ALTER TABLE ... ADD INDEX IF NOT EXISTS`, sehingga route sebelumnya 500.
    // Histori hanya memastikan schema minimum yang benar-benar dibutuhkan.
    await db.query(`CREATE TABLE IF NOT EXISTS cash_settlements (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL,
      settlement_date DATE NOT NULL,
      collector_user_id BIGINT UNSIGNED NULL,
      mode ENUM('selected','partial') NOT NULL DEFAULT 'selected',
      payment_count INT UNSIGNED NOT NULL DEFAULT 0,
      total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      handed_amount DECIMAL(14,2) NULL,
      difference_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      notes VARCHAR(500) NULL,
      status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
      created_by BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cash_settlement_code (code),
      INDEX idx_cash_settlement_date (settlement_date),
      INDEX idx_cash_settlement_collector (collector_user_id,settlement_date)
    )`);

    const [paymentCols]=await db.query(`SHOW COLUMNS FROM payments`);
    const paymentColNames=new Set(paymentCols.map(c=>String(c.Field)));
    const addPaymentColumn=async(name,ddl)=>{
      if(paymentColNames.has(name))return;
      await db.query(`ALTER TABLE payments ADD COLUMN ${ddl}`);
      paymentColNames.add(name);
    };
    await addPaymentColumn('settlement_id','settlement_id BIGINT UNSIGNED NULL AFTER settlement_status');
    await addPaymentColumn('settled_by','settled_by BIGINT UNSIGNED NULL AFTER settlement_id');
    await addPaymentColumn('settled_at','settled_at DATETIME NULL AFTER settled_by');

    // Index dibuat dengan pemeriksaan SHOW INDEX agar kompatibel lintas MySQL/MariaDB.
    const [idx]=await db.query(`SHOW INDEX FROM payments WHERE Key_name='idx_payments_settlement'`);
    if(!idx.length){
      try{await db.query(`ALTER TABLE payments ADD INDEX idx_payments_settlement (settlement_id)`);}
      catch(err){if(!/duplicate|exists/i.test(String(err.message||'')))throw err;}
    }
  })().catch(err=>{reconciliationHistorySchemaReady=null;throw err;});
  return reconciliationHistorySchemaReady;
}
async function loadReconciliationHistory(req){
  // Histori bergantung pada settlement_id + cash_settlements (fitur v1.28).
  // Pastikan schema tersedia saat tab dibuka agar instalasi yang upgrade bertahap tidak 500.
  await ensureReconciliationHistorySchema();
  const q=String(req.query.q||'').trim();const site=String(req.query.site||'').trim();const cluster=String(req.query.cluster||'').trim();
  const status=RECON_STATUSES.includes(req.query.status)?req.query.status:'all';
  const collector=Number(req.query.collector)>0?String(Number(req.query.collector)):'';
  // Dasar tanggal periode: tanggal pelanggan bayar (default) atau tanggal uang masuk kas.
  const basis=req.query.basis==='settled'?'settled':'paid';
  const today=jakartaToday();
  let dateFrom=validDateParam(req.query.date_from)||`${today.slice(0,8)}01`;
  let dateTo=validDateParam(req.query.date_to)||today;
  if(dateFrom>dateTo)[dateFrom,dateTo]=[dateTo,dateFrom];
  const heldCond=`(p.status='confirmed' AND p.settlement_status='held_by_staff')`;
  const settledCond=`p.settlement_status='settled'`;
  let where=`WHERE p.method='cash' AND DATE(${basis==='settled'?'p.settled_at':'p.paid_at'}) BETWEEN ? AND ?`;
  const params=[dateFrom,dateTo];
  where+=status==='held'?` AND ${heldCond}`:status==='settled'?` AND ${settledCond}`:` AND (${heldCond} OR ${settledCond})`;
  let filterSql='';const filterParams=[];
  if(site){filterSql+=` AND s.code=?`;filterParams.push(site);}
  if(cluster){filterSql+=` AND c.cluster_id=?`;filterParams.push(Number(cluster));}
  if(collector){filterSql+=` AND COALESCE(p.collector_user_id,p.received_by)=?`;filterParams.push(Number(collector));}
  if(q){const like=`%${q}%`;filterSql+=` AND (c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR u.name LIKE ? OR su.name LIKE ? OR s.code LIKE ? OR cl.name LIKE ? OR p.reference LIKE ? OR cs.code LIKE ?)`;filterParams.push(like,like,like,like,like,like,like,like,like);}
  where+=filterSql;params.push(...filterParams);
  const from=`FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id
    LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN users u ON u.id=COALESCE(p.collector_user_id,p.received_by) LEFT JOIN users su ON su.id=p.settled_by
    LEFT JOIN cash_settlements cs ON cs.id=p.settlement_id`;
  const [history]=await db.execute(`SELECT p.id,p.amount,p.reference,p.paid_at,p.settled_at,TIMESTAMPDIFF(HOUR,p.paid_at,p.settled_at) settle_hours,p.settlement_status,p.settlement_id,cs.code settlement_code,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,
    i.invoice_number,COALESCE(u.name,'Tidak diketahui') collector_name,COALESCE(su.name,'-') settled_by_name
    ${from} ${where} ORDER BY ${basis==='settled'?'p.settled_at':'p.paid_at'} DESC,p.id DESC LIMIT ${RECON_HISTORY_LIMIT}`,params);
  const [[historySummary]]=await db.execute(`SELECT COUNT(*) transactions,COALESCE(SUM(p.amount),0) amount,COUNT(DISTINCT c.id) customers,
    COALESCE(SUM(CASE WHEN ${settledCond} THEN 1 ELSE 0 END),0) settled_count,COALESCE(SUM(CASE WHEN ${settledCond} THEN p.amount ELSE 0 END),0) settled_amount,
    COALESCE(SUM(CASE WHEN ${heldCond} THEN 1 ELSE 0 END),0) held_count,COALESCE(SUM(CASE WHEN ${heldCond} THEN p.amount ELSE 0 END),0) held_amount
    ${from} ${where}`,params);
  const [settlements]=await db.execute(`SELECT cs.id,cs.code,cs.settlement_date,cs.mode,cs.payment_count,cs.total_amount,cs.handed_amount,cs.difference_amount,cs.status,cs.notes,
      COALESCE(cu.name,'Beberapa collector') collector_name,au.name created_by_name
    FROM cash_settlements cs LEFT JOIN users cu ON cu.id=cs.collector_user_id LEFT JOIN users au ON au.id=cs.created_by
    WHERE cs.settlement_date BETWEEN ? AND ?${collector?' AND cs.collector_user_id=?':''} ORDER BY cs.id DESC LIMIT 200`,collector?[dateFrom,dateTo,Number(collector)]:[dateFrom,dateTo]);
  return {history,historySummary:historySummary||{},settlements,historyLimit:RECON_HISTORY_LIMIT,dateFrom,dateTo,status,basis,q,site,cluster,collector};
}

const reconStatusLabel=p=>p.settlement_status==='settled'?'Sudah Disetor':'Belum Disetor';
const reconStatusTitle={all:'Semua status',held:'Belum Disetor',settled:'Sudah Disetor'};

router.get('/reconciliation',requireAdmin,async(req,res)=>{
  const tab=req.query.tab==='history'?'history':'held';
  const data=await loadReconciliationData(req,{withLookups:true});
  const historyData=tab==='history'?await loadReconciliationHistory(req):{history:[],historySummary:{},settlements:[],historyLimit:RECON_HISTORY_LIMIT,dateFrom:'',dateTo:'',status:'all',basis:'paid'};
  let justSettled=null;
  if(Number(req.query.settled)>0){const [[row]]=await db.execute(`SELECT id,code,payment_count,total_amount,handed_amount,difference_amount FROM cash_settlements WHERE id=? LIMIT 1`,[Number(req.query.settled)]);justSettled=row||null;}
  res.render('payments/reconciliation',{title:'Rekonsiliasi Pembayaran',...data,...historyData,tab,justSettled,canCancelSettlement:isMasterAdminRole(req.session.user.role)});
});

// v1.26 — "Export Excel" untuk menu Rekonsiliasi: 3 sheet (rincian cash belum disetor, rekap per
// collector, dan ringkasan angka) supaya file bisa langsung dipakai untuk audit/lampiran tanpa buka
// aplikasi. Menghormati filter q/site/cluster yang sedang aktif di halaman.
router.get('/reconciliation/export.xlsx',requireAdmin,async(req,res)=>{
  if(req.query.tab==='history'){
    const {history,historySummary,dateFrom,dateTo,status,site:hSite}=await loadReconciliationHistory(req);
    const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';wb.created=new Date();
    const ws=wb.addWorksheet('Histori Cash');
    ws.columns=[['status','Status Setoran',16],['customer_name','Pelanggan',28],['customer_code','Customer ID',16],['invoice_number','Faktur',18],['site_code','Site',10],['cluster_name','Cluster',20],['collector_name','Collector',22],['amount','Nominal (Rp)',18],['paid_at','Dibayar Pelanggan',20],['settled_at','Diterima Kas',20],['settled_by_name','Dikonfirmasi Oleh',22],['settlement_code','No. Setoran',22]].map(([key,header,width])=>({header,key,width}));
    history.forEach(p=>ws.addRow({status:reconStatusLabel(p),customer_name:p.customer_name,customer_code:p.customer_code,invoice_number:p.invoice_number,site_code:p.site_code,cluster_name:p.cluster_name||'',collector_name:p.collector_name,amount:Number(p.amount),paid_at:p.paid_at?new Date(p.paid_at):'',settled_at:p.settled_at?new Date(p.settled_at):'',settled_by_name:p.settled_by_name==='-'?'':p.settled_by_name,settlement_code:p.settlement_code||''}));
    styleWorkbook(ws);ws.getColumn('amount').numFmt='#,##0';ws.getColumn('paid_at').numFmt='dd/mm/yyyy hh:mm';ws.getColumn('settled_at').numFmt='dd/mm/yyyy hh:mm';
    if(history.length){const totalRow=ws.addRow({status:'TOTAL',amount:history.reduce((a,p)=>a+Number(p.amount||0),0)});totalRow.font={bold:true};totalRow.getCell('amount').numFmt='#,##0';}
    const ws2=wb.addWorksheet('Ringkasan');
    ws2.columns=[['metric','Metrik',32],['value','Nilai',22]].map(([key,header,width])=>({header,key,width}));
    ws2.addRows([{metric:'Periode tanggal bayar',value:`${dateFrom} s.d. ${dateTo}`},{metric:'Filter status',value:reconStatusTitle[status]},{metric:'Jumlah transaksi',value:Number(historySummary.transactions||0)},{metric:'Jumlah pelanggan',value:Number(historySummary.customers||0)},{metric:'Sudah disetor (transaksi)',value:Number(historySummary.settled_count||0)},{metric:'Sudah disetor (Rp)',value:Number(historySummary.settled_amount||0)},{metric:'Belum disetor (transaksi)',value:Number(historySummary.held_count||0)},{metric:'Belum disetor (Rp)',value:Number(historySummary.held_amount||0)}]);
    styleWorkbook(ws2);
    const filename=`histori-cash-${status}${hSite?'-'+hSite:''}-${dateFrom}-sd-${dateTo}.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    await wb.xlsx.write(res);return res.end();
  }
  const {held,staffBalances,summary,site}=await loadReconciliationData(req);
  const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';wb.created=new Date();

  const ws=wb.addWorksheet('Cash Belum Disetor');
  ws.columns=[['collector_name','Collector',22],['customer_name','Pelanggan',28],['customer_code','Customer ID',16],['invoice_number','Faktur',18],['site_code','Site',10],['cluster_name','Cluster',20],['amount','Nominal (Rp)',18],['paid_at','Diterima',20],['status','Status',16]].map(([key,header,width])=>({header,key,width}));
  held.forEach(p=>ws.addRow({collector_name:p.collector_name||'Tidak diketahui',customer_name:p.customer_name,customer_code:p.customer_code,invoice_number:p.invoice_number,site_code:p.site_code,cluster_name:p.cluster_name||'',amount:Number(p.amount),paid_at:p.paid_at?new Date(p.paid_at):'',status:'Belum Disetor'}));
  styleWorkbook(ws);ws.getColumn('amount').numFmt='#,##0';ws.getColumn('paid_at').numFmt='dd/mm/yyyy hh:mm';
  if(held.length){const totalRow=ws.addRow({collector_name:'TOTAL',amount:held.reduce((a,p)=>a+Number(p.amount||0),0)});totalRow.font={bold:true};totalRow.getCell('amount').numFmt='#,##0';}

  const ws2=wb.addWorksheet('Rekap Collector');
  ws2.columns=[['collector_name','Collector',28],['transactions','Jumlah Transaksi',18],['amount','Total Nominal (Rp)',20]].map(([key,header,width])=>({header,key,width}));
  staffBalances.forEach(s=>ws2.addRow({collector_name:s.collector_name,transactions:Number(s.transactions),amount:Number(s.amount)}));
  styleWorkbook(ws2);ws2.getColumn('amount').numFmt='#,##0';

  const ws3=wb.addWorksheet('Ringkasan');
  ws3.columns=[['metric','Metrik',32],['value','Nilai (Rp)',22]].map(([key,header,width])=>({header,key,width}));
  ws3.addRows([
    {metric:'Cash Masih di Tim (belum disetor)',value:Number(summary.held_total||0)},
    {metric:'Setoran Cash Hari Ini',value:Number(summary.settled_today||0)},
    {metric:'Transfer Hari Ini',value:Number(summary.transfer_today||0)},
  ]);
  styleWorkbook(ws3);ws3.getColumn('value').numFmt='#,##0';
  ws3.addRow({});ws3.addRow({metric:'Diekspor pada',value:new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})});

  const filename=`rekonsiliasi-pembayaran${site?'-'+site:''}-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  await wb.xlsx.write(res);res.end();
});

// v1.26 — "Export PDF" untuk menu Rekonsiliasi: memakai layout laporan resmi yang sama (kop
// perusahaan, kartu ringkasan, tabel, watermark, footer bernomor halaman) dengan modul lain seperti
// Analitik/Laporan, supaya konsisten saat dicetak atau dilampirkan.
router.get('/reconciliation/export.pdf',requireAdmin,async(req,res)=>{
  if(req.query.tab==='history'){
    const {history,historySummary,dateFrom,dateTo,status,basis,q:hq,site:hSite,cluster:hCluster,collector:hCollector}=await loadReconciliationHistory(req);
    const hCollectorName=hCollector?(history[0]?.collector_name||`ID ${hCollector}`):'';
    const fmt=v=>v?new Date(v).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'}):'-';
    const rows=history.map(p=>({status:reconStatusLabel(p),customer:`${p.customer_name} (${p.customer_code})`,invoice:p.invoice_number,siteCluster:`${p.site_code}${p.cluster_name?' · '+p.cluster_name:''}`,collector:p.collector_name,amount:rupiah(p.amount),_rawAmount:Number(p.amount||0),paidAt:fmt(p.paid_at),settledAt:p.settled_at?`${fmt(p.settled_at)}${p.settlement_code?` · ${p.settlement_code}`:''}`:'-',settledBy:p.settled_by_name}));
    const filterLabel=[`Periode ${basis==='settled'?'masuk kas':'bayar'} ${dateFrom} s.d. ${dateTo}`,reconStatusTitle[status],hq?`Cari: "${hq}"`:'',hSite?`Site: ${hSite}`:'',hCluster?`Cluster ID: ${hCluster}`:'',hCollectorName?`Collector: ${hCollectorName}`:''].filter(Boolean).join(' · ');
    return createReportPdf(res,{
      title:'Histori Cash Pelanggan',
      subtitle:`Status setoran cash pelanggan ke kas perusahaan · ${filterLabel}`,
      filename:`histori-cash-${status}${hSite?'-'+hSite:''}-${dateFrom}-sd-${dateTo}.pdf`.toLowerCase(),
      watermark:'INKAMNET · REKONSILIASI',
      disposition:req.query.download==='0'?'inline':'attachment',
      summaryItems:[
        {label:'SUDAH DISETOR',value:rupiah(historySummary.settled_amount||0),color:COLORS.green},
        {label:'BELUM DISETOR',value:rupiah(historySummary.held_amount||0),color:COLORS.red},
        {label:'TRANSAKSI',value:String(Number(historySummary.transactions||0)),color:COLORS.blue},
        {label:'PELANGGAN',value:String(Number(historySummary.customers||0)),color:COLORS.purple},
      ],
      columns:[
        {label:'Status',key:'status',width:0.9,bold:true},
        {label:'Pelanggan',key:'customer',width:1.8},
        {label:'Faktur',key:'invoice',width:1.0},
        {label:'Site / Cluster',key:'siteCluster',width:1.1},
        {label:'Collector',key:'collector',width:1.0},
        {label:'Nominal',key:'amount',width:1.0,align:'right',total:true,totalBy:r=>r._rawAmount},
        {label:'Dibayar',key:'paidAt',width:1.1},
        {label:'Diterima Kas',key:'settledAt',width:1.1},
        {label:'Dikonfirmasi',key:'settledBy',width:0.9}
      ],
      rows,
      layout:'landscape'
    });
  }
  const {held,staffBalances,summary,q,site,cluster,collector,aging,agingDays}=await loadReconciliationData(req);
  const rows=held.map(p=>({collector:p.collector_name||'Tidak diketahui',customer:`${p.customer_name} (${p.customer_code})`,invoice:p.invoice_number,siteCluster:`${p.site_code}${p.cluster_name?' · '+p.cluster_name:''}`,amount:rupiah(p.amount),_rawAmount:Number(p.amount||0),receivedAt:new Date(p.paid_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'}),status:'Belum Disetor'}));
  const filterLabel=[q?`Cari: "${q}"`:'',site?`Site: ${site}`:'',cluster?`Cluster ID: ${cluster}`:'',collector?`Collector: ${held[0]?.collector_name||'ID '+collector}`:'',aging==='overdue'?`Lewat ${agingDays} hari`:''].filter(Boolean).join(' · ')||'Semua data';
  return createReportPdf(res,{
    title:'Rekonsiliasi Pembayaran',
    subtitle:`Cash belum disetor ke kas perusahaan · ${filterLabel}`,
    filename:`rekonsiliasi-pembayaran${site?'-'+site:''}-${new Date().toISOString().slice(0,10)}.pdf`.toLowerCase(),
    watermark:'INKAMNET · REKONSILIASI',
    disposition:req.query.download==='0'?'inline':'attachment',
    summaryItems:[
      {label:'CASH MASIH DI TIM',value:rupiah(summary.held_total||0),color:COLORS.red},
      {label:'SETORAN HARI INI',value:rupiah(summary.settled_today||0),color:COLORS.green},
      {label:'TRANSFER HARI INI',value:rupiah(summary.transfer_today||0),color:COLORS.blue},
      {label:'COLLECTOR AKTIF',value:String(staffBalances.length),color:COLORS.purple},
    ],
    columns:[
      {label:'Collector',key:'collector',width:1.3,bold:true},
      {label:'Pelanggan',key:'customer',width:1.9},
      {label:'Faktur',key:'invoice',width:1.1},
      {label:'Site / Cluster',key:'siteCluster',width:1.3},
      {label:'Nominal',key:'amount',width:1.1,align:'right',total:true,totalBy:r=>r._rawAmount},
      {label:'Diterima',key:'receivedAt',width:1.3},
      {label:'Status',key:'status',width:0.9}
    ],
    rows,
    layout:'landscape'
  });
});

// v1.28 — Setoran cash kini dicatat per batch di cash_settlements dengan nomor setoran
// (STR-YYYYMMDD-000123) supaya bisa dicetak sebagai tanda terima dan dibatalkan dengan jejak audit.
// Semua jalur (satu baris, massal, dan setoran sebagian per collector) memakai fungsi yang sama.
function settlementCode(id,date){return `STR-${String(date).replace(/-/g,'').slice(0,8)}-${String(id).padStart(6,'0')}`;}
function cleanMoney(value){const n=Number(String(value??'').replace(/[^\d.,-]/g,'').replace(/\./g,'').replace(',','.'));return Number.isFinite(n)?Math.round(n*100)/100:NaN;}
async function settleCashPayments(conn,{paymentIds,settlementDate,actorId,mode='selected',collectorId=null,handedAmount=null,notes=null,strict=false}){
  const [ins]=await conn.execute(`INSERT INTO cash_settlements(code,settlement_date,collector_user_id,mode,handed_amount,notes,created_by) VALUES(?,?,?,?,?,?,?)`,[
    `TMP-${crypto.randomUUID()}`,settlementDate,collectorId||null,mode,handedAmount,notes?String(notes).slice(0,500):null,actorId
  ]);
  const settlementId=ins.insertId;const code=settlementCode(settlementId,settlementDate);
  const done=[];const skipped=[];
  for(const id of paymentIds){
    const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[id]);
    const p=rows[0];
    if(strict){
      if(!p)throw new Error('Pembayaran tidak ditemukan');
      if(p.method!=='cash')throw new Error('Hanya pembayaran cash yang perlu disetor');
      if(p.status!=='confirmed')throw new Error('Pembayaran cash belum disetujui Master Admin. Setoran belum boleh masuk Data Kas.');
      if(p.settlement_status!=='held_by_staff')throw new Error('Pembayaran ini sudah disetor atau tidak sedang dipegang staff.');
    }
    if(!p||p.method!=='cash'||p.status!=='confirmed'||p.settlement_status!=='held_by_staff'){skipped.push(p||{id});continue;}
    await conn.execute(`UPDATE payments SET settlement_status='settled',settlement_id=?,settled_by=?,settled_at=NOW(),booked_at=COALESCE(booked_at,?) WHERE id=?`,[settlementId,actorId,settlementDate,p.id]);
    await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:`${p.reference||`#${p.id}`} · ${code}`,bookDate:settlementDate,categoryName:'Setoran Cash Pelanggan',prefix:'Setoran Cash',actorUserId:actorId});
    done.push(p);
  }
  if(!done.length)throw new Error('Semua setoran terpilih sudah disetor sebelumnya, atau bukan lagi cash yang tertahan di staff.');
  const total=Math.round(done.reduce((a,p)=>a+Number(p.amount||0),0)*100)/100;
  const collectors=[...new Set(done.map(p=>Number(p.collector_user_id||p.received_by||0)))];
  const resolvedCollector=collectorId||(collectors.length===1&&collectors[0]?collectors[0]:null);
  const difference=handedAmount==null?0:Math.round((Number(handedAmount)-total)*100)/100;
  await conn.execute(`UPDATE cash_settlements SET code=?,collector_user_id=?,payment_count=?,total_amount=?,difference_amount=? WHERE id=?`,[code,resolvedCollector,done.length,total,difference,settlementId]);
  return {settlementId,code,done,skipped,total,difference};
}

router.post('/:id/settle',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();let result;
  try{
    await conn.beginTransaction();
    const settlementDate=await assertDateOpen(conn,req.body.settlement_date||new Date());
    result=await settleCashPayments(conn,{paymentIds:[Number(req.params.id)],settlementDate,actorId:req.session.user.id,strict:true});
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'settle',entityType:'payment',entityId:result.done[0].id,description:`Konfirmasi setoran cash staff ke kas perusahaan · ${result.code}`,ip:req.ip});
  req.session.flash={type:'success',message:`Setoran cash dikonfirmasi dan masuk ke kas perusahaan (${result.code}).`};
  res.redirect(`/payments/reconciliation?settled=${result.settlementId}`);
});

// v1.25.5 (update) — "Konfirmasi Setoran Massal". Sejak v1.28 satu batch = satu nomor setoran dalam satu
// transaksi DB; baris yang sudah tidak tertahan di staff tetap dilewati, bukan menggagalkan batch.
router.post('/bulk-settle',requireAdmin,async(req,res)=>{
  const returnTo=localReturn(req.body.return_to,'/payments/reconciliation');
  const ids=selectedPaymentIds(req.body);
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu setoran terlebih dahulu.'};return res.redirect(returnTo);}
  if(ids.length>200){req.session.flash={type:'danger',message:'Maksimal 200 setoran per konfirmasi massal.'};return res.redirect(returnTo);}
  const conn=await db.getConnection();let result;
  try{
    await conn.beginTransaction();
    const settlementDate=await assertDateOpen(conn,req.body.settlement_date||new Date());
    result=await settleCashPayments(conn,{paymentIds:ids,settlementDate,actorId:req.session.user.id});
    await conn.commit();
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:e.message};return res.redirect(returnTo);}finally{conn.release();}
  const {done,skipped,code}=result;
  await audit({userId:req.session.user.id,action:'bulk_settle',entityType:'cash_settlement',entityId:result.settlementId,description:`Konfirmasi setoran massal ${code}: ${done.length} pembayaran cash (${done.map(p=>p.reference||`#${p.id}`).slice(0,20).join(', ')}${done.length>20?', ...':''})${skipped.length?` · ${skipped.length} dilewati`:''}`,ip:req.ip});
  req.session.flash={type:'success',message:`${done.length} setoran cash dikonfirmasi dengan nomor ${code} dan masuk ke kas perusahaan.${skipped.length?` ${skipped.length} dilewati karena sudah disetor sebelumnya.`:''}`};
  res.redirect(`/payments/reconciliation?settled=${result.settlementId}`);
});

// v1.28 — Setoran sebagian per collector: admin memasukkan nominal uang yang benar-benar diserahkan,
// sistem mencocokkan ke transaksi cash tertua (FIFO) yang muat utuh. Transaksi yang tidak muat tetap
// "Belum Disetor"; kelebihan uang yang tidak cocok ke transaksi mana pun dicatat sebagai selisih lebih.
router.post('/reconciliation/partial-settle',requireAdmin,async(req,res)=>{
  const returnTo='/payments/reconciliation';
  const collectorId=Number(req.body.collector_user_id);
  const handed=cleanMoney(req.body.handed_amount);
  if(!Number.isInteger(collectorId)||collectorId<1){req.session.flash={type:'danger',message:'Pilih collector yang menyetor.'};return res.redirect(returnTo);}
  if(!Number.isFinite(handed)||handed<=0){req.session.flash={type:'danger',message:'Nominal uang yang diserahkan harus lebih dari 0.'};return res.redirect(returnTo);}
  const conn=await db.getConnection();let result;let remaining=0;let remainingCount=0;
  try{
    await conn.beginTransaction();
    const settlementDate=await assertDateOpen(conn,req.body.settlement_date||new Date());
    const [candidates]=await conn.execute(`SELECT id,amount FROM payments WHERE method='cash' AND status='confirmed' AND settlement_status='held_by_staff'
      AND COALESCE(collector_user_id,received_by)=? ORDER BY paid_at,id FOR UPDATE`,[collectorId]);
    if(!candidates.length)throw new Error('Collector ini tidak sedang memegang cash yang belum disetor.');
    const picked=[];let sum=0;
    for(const row of candidates){
      const amount=Number(row.amount||0);
      // FIFO ketat: berhenti di transaksi tertua pertama yang tidak muat, supaya urutan setoran tetap jelas.
      if(sum+amount>handed+0.001)break;
      picked.push(row.id);sum+=amount;
    }
    if(!picked.length)throw new Error(`Nominal ${rupiah(handed)} belum cukup untuk transaksi tertua (${rupiah(candidates[0].amount)}). Transaksi tidak dipecah.`);
    result=await settleCashPayments(conn,{paymentIds:picked,settlementDate,actorId:req.session.user.id,mode:'partial',collectorId,handedAmount:handed,notes:req.body.notes});
    const left=candidates.filter(r=>!picked.includes(r.id));
    remaining=left.reduce((a,r)=>a+Number(r.amount||0),0);remainingCount=left.length;
    await financialAudit({conn,userId:req.session.user.id,action:'partial_settle',entityType:'cash_settlement',entityId:result.settlementId,before:null,
      after:{code:result.code,handed,matched:result.total,difference:result.difference,remaining},reason:`Setoran sebagian collector #${collectorId}`,ip:req.ip});
    await conn.commit();
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Setoran sebagian gagal: ${e.message}`};return res.redirect(returnTo);}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'partial_settle',entityType:'cash_settlement',entityId:result.settlementId,description:`Setoran sebagian ${result.code}: diserahkan ${rupiah(handed)}, dicocokkan ${rupiah(result.total)} (${result.done.length} transaksi)${result.difference?`, selisih lebih ${rupiah(result.difference)}`:''}`,ip:req.ip});
  const parts=[`Setoran ${result.code}: ${result.done.length} transaksi senilai ${rupiah(result.total)} masuk kas.`];
  if(remainingCount)parts.push(`Sisa ${remainingCount} transaksi (${rupiah(remaining)}) masih di collector.`);
  if(result.difference>0)parts.push(`Kelebihan ${rupiah(result.difference)} tidak cocok ke transaksi mana pun — tercatat sebagai selisih lebih di tanda terima.`);
  req.session.flash={type:result.difference>0?'warning':'success',message:parts.join(' ')};
  res.redirect(`/payments/reconciliation?settled=${result.settlementId}`);
});

router.post('/reconciliation/settings',requireMasterAdmin,async(req,res)=>{
  const days=Math.min(60,Math.max(1,Number.parseInt(req.body.cash_aging_alert_days,10)||3));
  await db.execute(`UPDATE settings SET cash_aging_alert_days=? WHERE id=1`,[days]);
  await audit({userId:req.session.user.id,action:'update',entityType:'reconciliation_settings',entityId:null,description:`Batas umur cash di tim diubah menjadi ${days} hari`,ip:req.ip});
  req.session.flash={type:'success',message:`Batas pengingat umur cash diset ${days} hari.`};
  res.redirect('/payments/reconciliation');
});

router.get('/settlements/:id/receipt.pdf',requireAdmin,async(req,res)=>{
  return streamSettlementReceipt(res,req.params.id,{disposition:req.query.download==='1'?'attachment':'inline'});
});

// v1.28 — Batalkan setoran (Master Admin, wajib alasan). Jurnal "Setoran Cash" di Data Kas dihapus,
// baris Closing hasil sinkron di-exclude, dan pembayaran kembali ke "Belum Disetor". Ditolak jika
// tanggal jurnalnya berada di periode Closing yang sudah dikunci.
async function cancelSettledPayment(conn,paymentId,{reason,actorId,ip}){
  const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[paymentId]);
  const p=rows[0];
  if(!p)throw new Error('Pembayaran tidak ditemukan.');
  if(p.method!=='cash'||p.settlement_status!=='settled')throw new Error(`Pembayaran ${p.reference||`#${p.id}`} tidak berstatus sudah disetor.`);
  const [txRows]=await conn.execute(`SELECT id,transaction_code,transaction_date FROM cash_transactions WHERE source_type='payment' AND source_id=? FOR UPDATE`,[p.id]);
  for(const tx of txRows)await assertDateOpen(conn,tx.transaction_date);
  if(txRows.length){
    const txIds=txRows.map(t=>t.id);const marks=txIds.map(()=>'?').join(',');
    await conn.execute(`UPDATE closing_entries SET excluded_at=NOW(),excluded_by=? WHERE cash_transaction_id IN (${marks}) AND excluded_at IS NULL`,[actorId,...txIds]);
    await conn.execute(`DELETE FROM cash_transactions WHERE id IN (${marks})`,txIds);
  }
  await conn.execute(`UPDATE payments SET settlement_status='held_by_staff',settlement_id=NULL,settled_by=NULL,settled_at=NULL WHERE id=?`,[p.id]);
  await conn.execute(`INSERT INTO cash_settlement_cancellations(settlement_id,payment_id,amount,cash_transaction_code,reason,cancelled_by) VALUES(?,?,?,?,?,?)`,[
    p.settlement_id||null,p.id,p.amount,txRows.map(t=>t.transaction_code).filter(Boolean).join(', ').slice(0,60)||null,reason,actorId
  ]);
  if(p.settlement_id){
    // MySQL/MariaDB mengevaluasi SET dari kiri ke kanan memakai nilai yang sudah diperbarui, jadi status dan
    // selisih dihitung dulu dari nilai lama sebelum jumlah/total dikurangi.
    await conn.execute(`UPDATE cash_settlements SET status=CASE WHEN payment_count<=1 THEN 'cancelled' ELSE status END,
      difference_amount=CASE WHEN handed_amount IS NULL THEN 0 ELSE handed_amount-GREATEST(total_amount-?,0) END,
      payment_count=GREATEST(payment_count-1,0),total_amount=GREATEST(total_amount-?,0) WHERE id=?`,[p.amount,p.amount,p.settlement_id]);
  }
  await financialAudit({conn,userId:actorId,action:'cancel_settlement',entityType:'payment',entityId:p.id,
    before:{settlement_status:'settled',settlement_id:p.settlement_id,settled_at:p.settled_at,cash_transactions:txRows.map(t=>t.transaction_code)},
    after:{settlement_status:'held_by_staff'},reason,ip});
  return p;
}
function cancelReason(body){return String(body.reason||'').trim().replace(/\s+/g,' ').slice(0,500);}

router.post('/:id/cancel-settlement',requireMasterAdmin,async(req,res)=>{
  const returnTo=localReturn(req.body.return_to,'/payments/reconciliation?tab=history');
  const reason=cancelReason(req.body);
  if(reason.length<5){req.session.flash={type:'danger',message:'Alasan pembatalan setoran wajib diisi minimal 5 karakter.'};return res.redirect(returnTo);}
  const conn=await db.getConnection();let p;
  try{
    await conn.beginTransaction();
    p=await cancelSettledPayment(conn,Number(req.params.id),{reason,actorId:req.session.user.id,ip:req.ip});
    await conn.commit();
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Pembatalan gagal: ${e.message}`};return res.redirect(returnTo);}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'cancel_settlement',entityType:'payment',entityId:p.id,description:`Batalkan setoran ${p.reference||`#${p.id}`} (${rupiah(p.amount)}) · alasan: ${reason}`,ip:req.ip});
  req.session.flash={type:'warning',message:`Setoran ${p.reference||`#${p.id}`} dibatalkan. Jurnal Data Kas dihapus dan pembayaran kembali ke Belum Disetor.`};
  res.redirect(returnTo);
});

router.post('/settlements/:id/cancel',requireMasterAdmin,async(req,res)=>{
  const returnTo=localReturn(req.body.return_to,'/payments/reconciliation?tab=history');
  const reason=cancelReason(req.body);
  if(reason.length<5){req.session.flash={type:'danger',message:'Alasan pembatalan setoran wajib diisi minimal 5 karakter.'};return res.redirect(returnTo);}
  const conn=await db.getConnection();let settlement;let count=0;let total=0;
  try{
    await conn.beginTransaction();
    const [[row]]=await conn.execute(`SELECT * FROM cash_settlements WHERE id=? FOR UPDATE`,[Number(req.params.id)]);
    if(!row)throw new Error('Setoran tidak ditemukan.');
    if(row.status==='cancelled')throw new Error(`Setoran ${row.code} sudah dibatalkan.`);
    settlement=row;
    const [paymentRows]=await conn.execute(`SELECT id FROM payments WHERE settlement_id=? ORDER BY id`,[row.id]);
    for(const pr of paymentRows){const p=await cancelSettledPayment(conn,pr.id,{reason,actorId:req.session.user.id,ip:req.ip});count++;total+=Number(p.amount||0);}
    await conn.execute(`UPDATE cash_settlements SET status='cancelled' WHERE id=?`,[row.id]);
    await conn.commit();
  }catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Pembatalan gagal: ${e.message}`};return res.redirect(returnTo);}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'cancel_settlement',entityType:'cash_settlement',entityId:settlement.id,description:`Batalkan setoran ${settlement.code}: ${count} transaksi (${rupiah(total)}) · alasan: ${reason}`,ip:req.ip});
  req.session.flash={type:'warning',message:`Setoran ${settlement.code} dibatalkan: ${count} transaksi kembali ke Belum Disetor dan jurnal Data Kas terkait dihapus.`};
  res.redirect(returnTo);
});

module.exports=router;
