// Shared by individual and bulk approval, inside the payment transaction.
async function requireProofReview(conn,payment,reason){
  if(!['transfer','qris'].includes(payment.method))return '';
  const [rows]=await conn.execute('SELECT status,overall_status,summary,checks_json FROM payment_proof_ocr WHERE payment_id=? LIMIT 1',[payment.id]);
  const result=rows[0];
  let checks=[];try{checks=JSON.parse(result?.checks_json||'[]');}catch(_){}
  const complete=['amount','date','account'].every(key=>checks.some(c=>c.key===key&&c.level==='ok')) && checks.some(c=>c.key==='date'&&c.label==='Tanggal cocok');
  const note=String(reason||'').trim();
  if(note.length>500)throw new Error('Alasan pemeriksaan maksimal 500 karakter.');
  if((!result||result.status!=='done'||result.overall_status!=='ok'||!complete)&&note.length<5)throw new Error('Hasil bukti berbeda atau perlu diperiksa. Isi alasan pemeriksaan manual minimal 5 karakter sebelum menyetujui.');
  return `OCR: ${result?.overall_status||'belum tersedia'}. ${result?.summary||''}${note?' Pemeriksaan Master Admin: '+note:''}`;
}
module.exports={requireProofReview};
