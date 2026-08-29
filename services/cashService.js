function normalizeCategoryCode(value, fallback='TX'){
  const code=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,10);
  return code||fallback;
}
function yyyymm(value){
  const d=value instanceof Date?value:new Date(value||Date.now());
  if(Number.isNaN(d.getTime())) return new Date().toISOString().slice(0,7).replace('-','');
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
}
function normalizeApprovalReason(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,500);}
async function assignCashTransactionCode(conn, transactionId, categoryId, transactionDate){
  const [rows]=await conn.execute(`SELECT code,name,type FROM cash_categories WHERE id=? LIMIT 1`,[categoryId]);
  const c=rows[0]||{};
  const fallback=c.type==='income'?'INC':'EXP';
  const prefix=normalizeCategoryCode(c.code,fallback);
  const code=`${prefix}-${yyyymm(transactionDate)}-${String(transactionId).padStart(6,'0')}`;
  await conn.execute(`UPDATE cash_transactions SET transaction_code=? WHERE id=?`,[code,transactionId]);
  return code;
}
// v1.24.5 — the source_type='payment' ("AUTO BILLING") block was removed: since these rows can now be
// edited from Data Kas like manual entries (routes/finance.js POST /cash/:id/update), an edit resets
// them to PENDING_APPROVAL just like manual rows, so Master Admin must be able to approve/reject them
// here too — otherwise an edited AUTO BILLING row would get stuck in PENDING_APPROVAL forever.
async function approveCashTransaction(conn,transactionId,reviewerId){
  const [rows]=await conn.execute(`SELECT ct.id,ct.transaction_code,ct.name,ct.amount,ct.source_type,ct.approval_status,cc.type category_type FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE ct.id=? FOR UPDATE`,[transactionId]);
  const tx=rows[0];
  if(!tx)throw new Error('Transaksi kas tidak ditemukan.');
  if(tx.approval_status!=='PENDING_APPROVAL')throw new Error('Hanya transaksi PENDING_APPROVAL yang dapat disetujui.');
  await conn.execute(`UPDATE cash_transactions SET approval_status='APPROVED',approval_reason=NULL,reviewed_by=?,reviewed_at=NOW() WHERE id=?`,[reviewerId,transactionId]);
  return tx;
}
async function rejectCashTransaction(conn,transactionId,reviewerId,reason){
  const clean=normalizeApprovalReason(reason);
  if(clean.length<3)throw new Error('Alasan penolakan wajib diisi minimal 3 karakter.');
  const [rows]=await conn.execute(`SELECT ct.id,ct.transaction_code,ct.name,ct.amount,ct.source_type,ct.approval_status,cc.type category_type FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE ct.id=? FOR UPDATE`,[transactionId]);
  const tx=rows[0];
  if(!tx)throw new Error('Transaksi kas tidak ditemukan.');
  if(tx.approval_status!=='PENDING_APPROVAL')throw new Error('Hanya transaksi PENDING_APPROVAL yang dapat ditolak.');
  await conn.execute(`UPDATE cash_transactions SET approval_status='REJECTED',approval_reason=?,reviewed_by=?,reviewed_at=NOW() WHERE id=?`,[clean,reviewerId,transactionId]);
  return {...tx,approval_reason:clean};
}
module.exports={assignCashTransactionCode,normalizeCategoryCode,normalizeApprovalReason,approveCashTransaction,rejectCashTransaction};
