// Logika inti pembayaran yang dipakai bersama oleh routes/payments.js DAN Web Inbox WhatsApp
// (tombol "Verifikasi Pembayaran & Buka Isolir"). Dipindahkan apa adanya dari routes/payments.js
// (v1.30) agar kedua jalur memakai guard keuangan yang identik: kunci baris FOR UPDATE, cek sisa
// tagihan, gate hasil scan bukti, jurnal kas, audit keuangan, auto-buka isolir, tanda terima WA.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const db=require('../config/db');
const { refreshInvoiceStatus }=require('./invoiceService');
const { unisolateCustomer }=require('./networkService');
const { assignCashTransactionCode }=require('./cashService');
const { resolveBookDate, financialAudit }=require('./financialControlService');
const { approvalGate, saveCustomerPayerAlias, reevaluateCustomerPending, queueProofScan, SCANNABLE_METHODS }=require('./proofScanService');

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
async function postCashTransaction(conn,{paymentId,invoiceId,amount,reference,bookDate,categoryName='Pendapatan Billing',prefix='Pembayaran',actorUserId=null}){
  const meta=await paymentCashMeta(conn,invoiceId);if(!meta)return;
  const catId=await billingCategory(conn,categoryName);if(!catId)return;
  const [exists]=await conn.execute(`SELECT id FROM cash_transactions WHERE source_type='payment' AND source_id=? LIMIT 1`,[paymentId]);
  if(exists.length)return;
  const [r]=await conn.execute(`INSERT INTO cash_transactions(transaction_date,name,category_id,site_id,amount,notes,source_type,source_id,created_by) VALUES(?,?,?,?,?,?,'payment',?,?)`,[
    bookDate,`${prefix} ${meta.customer_name}`,catId,meta.site_id,amount,`Faktur ${meta.invoice_number}${reference?` · ${reference}`:''}`,paymentId,actorUserId
  ]);
  await assignCashTransactionCode(conn,r.insertId,catId,new Date(`${bookDate}T12:00:00`));
}
async function maybeAutoUnisolate(invoiceId){
  const [paidRows]=await db.execute(`SELECT i.status,c.id customer_id,c.network_status,c.isolation_reason FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?`,[invoiceId]);
  if(paidRows[0]?.status==='paid'&&paidRows[0]?.network_status==='isolated'&&paidRows[0]?.isolation_reason==='billing'){
    try{await unisolateCustomer(paidRows[0].customer_id,true);}
    catch(netErr){await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('auto_unisolate','failed',?)`,[netErr.message.slice(0,1000)]);}
  }
}


// Approval Master Admin untuk satu pembayaran 'pending' (sama persis dengan POST /payments/:id/verify).
// Mengembalikan { payment, scanGate, aliasSaved }. Efek setelah commit (re-evaluasi alias, auto-buka
// isolir billing, antre tanda terima) dijalankan di sini juga kecuali skipReceipt=true.
async function verifyPendingPayment(paymentId,{userId,ip=null,bookDateMode,manualBookDate,scanOverrideReason,savePayerAlias=false,skipReceipt=false}={}){
  const conn=await db.getConnection();let aliasSaved=null;let p=null;let scanGate=null;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT * FROM payments WHERE id=? FOR UPDATE`,[paymentId]);
    p=rows[0];if(!p)throw new Error('Pembayaran tidak ditemukan');
    if(p.status!=='pending')throw new Error('Hanya pembayaran berstatus menunggu yang dapat disetujui.');
    if(['transfer','qris'].includes(p.method)&&!p.proof_path)throw new Error('Bukti transfer/QRIS wajib dilampirkan sebelum approval.');
    const booking=await resolveBookDate(conn,{mode:bookDateMode,paidAt:p.paid_at,manualDate:manualBookDate});
    const [invoiceRows]=await conn.execute(`SELECT i.outstanding,i.status
      FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.id=? AND c.customer_status='active' AND c.archived_at IS NULL FOR UPDATE`,[p.invoice_id]);
    if(!invoiceRows.length)throw new Error('Faktur pembayaran tidak ditemukan.');
    if(Number(p.amount)>Number(invoiceRows[0].outstanding))throw new Error('Nominal transfer melebihi sisa tagihan saat ini. Periksa pembayaran lain sebelum verifikasi.');
    // v1.29 — hasil scan bukti bermasalah (nominal/penerima/pengirim/duplikat) wajib disertai alasan.
    scanGate=await approvalGate(conn,p,{reason:scanOverrideReason,actorUserId:userId});
    if(savePayerAlias&&SCANNABLE_METHODS.has(p.method)){
      const [aliasRows]=await conn.execute(`SELECT ps.sender_name,i.customer_id FROM payment_proof_scans ps JOIN invoices i ON i.id=? WHERE ps.payment_id=? LIMIT 1`,[p.invoice_id,p.id]);
      if(aliasRows[0]?.sender_name)aliasSaved=await saveCustomerPayerAlias(conn,{customerId:aliasRows[0].customer_id,payerName:aliasRows[0].sender_name,userId})?aliasRows[0]:null;
    }
    await conn.execute(`UPDATE payments SET status='confirmed',settlement_status=?,booked_at=?,booked_date_mode=?,verified_by=?,verified_at=NOW() WHERE id=?`,[p.method==='cash'?'held_by_staff':'not_applicable',booking.date,booking.mode,userId,p.id]);
    await refreshInvoiceStatus(conn,p.invoice_id);
    if(p.method!=='cash')await postCashTransaction(conn,{paymentId:p.id,invoiceId:p.invoice_id,amount:p.amount,reference:p.reference,bookDate:booking.date,actorUserId:userId});
    await financialAudit({conn,userId,action:'approve',entityType:'payment',entityId:p.id,before:p,after:{status:'confirmed',booked_at:booking.date,booked_date_mode:booking.mode,proof_scan:scanGate.status||null},reason:`Approval pembayaran (${booking.mode})${scanGate.overridden?` · hasil scan bukti ${scanGate.status}, alasan: ${scanGate.reason}`:''}`,ip});
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  if(aliasSaved)reevaluateCustomerPending(aliasSaved.customer_id).catch(err=>console.error('Re-evaluasi pengirim dikenal gagal:',err.message));
  await maybeAutoUnisolate(p.invoice_id);
  if(!skipReceipt){const { queuePaymentReceipts }=require('./cashSettlementService');await queuePaymentReceipts([p.id],userId);}
  return {payment:p,scanGate,aliasSaved};
}

// Pengajuan pembayaran transfer (status 'pending') untuk satu/lebih faktur dengan satu file bukti —
// logika sama dengan POST /payments untuk metode transfer. file: {buffer,mimetype,originalname,size}.
async function createPendingTransferPayments({invoiceIds,bankId,file,userId,notes=null,paidDate=null}){
  const ids=[...new Set([].concat(invoiceIds||[]).map(Number).filter(n=>Number.isInteger(n)&&n>0))];
  if(!ids.length)throw new Error('Pilih minimal satu faktur yang akan dibayar.');
  const [bankRows]=await db.execute(`SELECT id,bank_name,account_name,account_number FROM banks WHERE id=? AND is_active=1 AND type IN ('bank_transfer','virtual_account','other') LIMIT 1`,[bankId||0]);
  if(!bankRows.length)throw new Error('Pilih bank tujuan yang aktif dari Pengaturan → Bank.');
  const bank=bankRows[0];const bankName=`${bank.bank_name} · ${bank.account_number} · ${bank.account_name}`;
  const day=paidDate||new Date().toISOString().slice(0,10);
  const requestKey=crypto.randomUUID();
  const conn=await db.getConnection();const created=[];const savedFiles=[];
  try{
    await conn.beginTransaction();
    for(const invoiceId of ids){
      const [invoiceRows]=await conn.execute(`SELECT i.id,i.outstanding,i.status FROM invoices i JOIN customers c ON c.id=i.customer_id
        WHERE i.id=? AND c.customer_status='active' AND c.archived_at IS NULL FOR UPDATE`,[invoiceId]);
      if(!invoiceRows.length)throw new Error(`Faktur #${invoiceId} tidak ditemukan.`);
      const invoice=invoiceRows[0];
      if(['paid','cancelled','refunded'].includes(invoice.status)||Number(invoice.outstanding)<=0)throw new Error(`Faktur #${invoiceId} sudah tidak memiliki sisa tagihan.`);
      const [[pending]]=await conn.execute(`SELECT COUNT(*) total FROM payments WHERE invoice_id=? AND status='pending'`,[invoiceId]);
      if(Number(pending.total)>0)throw new Error(`Faktur #${invoiceId} sudah memiliki pembayaran yang menunggu approval.`);
      const amount=Number(invoice.outstanding);
      let savedProof=null;
      if(file){savedProof=await saveProofFile(file);savedFiles.push(savedProof.filename);}
      const [r]=await conn.execute(`INSERT INTO payments (invoice_id,amount,method,reference,idempotency_key,notes,status,settlement_status,bank_name,proof_reference,proof_path,proof_original_name,proof_mime,proof_size,proof_uploaded_by,proof_uploaded_at,paid_at,received_by,collector_user_id,verified_by,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
        invoiceId,amount,'transfer',null,`${requestKey}:${invoiceId}`,notes,'pending','not_applicable',bankName,savedProof?.originalName||null,savedProof?.filename||null,savedProof?.originalName||null,savedProof?.mime||null,savedProof?.size||null,savedProof?userId:null,savedProof?new Date():null,`${day} 12:00:00`,userId,userId,null,null
      ]);
      const reference=paymentReference(r.insertId);
      await conn.execute(`UPDATE payments SET reference=? WHERE id=?`,[reference,r.insertId]);
      created.push({paymentId:r.insertId,invoiceId,amount,reference});
      await refreshInvoiceStatus(conn,invoiceId);
    }
    await conn.commit();
  }catch(e){await conn.rollback();for(const f of savedFiles)await removeProofFile(f);throw e;}finally{conn.release();}
  if(file){for(const [index,c] of created.entries()){try{await queueProofScan(c.paymentId,{kick:index===created.length-1});}catch(err){console.error('Antre scan bukti gagal:',err.message);}}}
  return created;
}

module.exports={PROOF_DIR,proofExtension,proofSignatureMatches,saveProofFile,removeProofFile,paymentReference,paymentCashMeta,billingCategory,postCashTransaction,maybeAutoUnisolate,verifyPendingPayment,createPendingTransferPayments};
