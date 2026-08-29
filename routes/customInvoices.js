const express=require('express');
const db=require('../config/db');
const {createReportPdf,rupiah,date,documentLabel,COLORS}=require('../services/reportPdf');
const router=express.Router();
// v1.20.1: the old invNo() used the last 6 digits of Date.now(), which repeats every ~16.7 minutes
// (1,000,000 ms) — two custom invoices created that far apart (or a double-submitted form) could get
// an identical invoice_number with zero uniqueness check before insert. Replaced with a sequential
// per-month counter (mirrors nextImportedCustomerCode in routes/customers.js) plus a check-and-retry
// loop and a named advisory lock so concurrent submissions can't race each other into a duplicate.
async function nextCustomInvoiceNumber(conn){
  const d=new Date();
  const prefix=`CINV/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/`;
  const [[row]]=await conn.execute(`SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_number,'/',-1) AS UNSIGNED)),0) seq FROM custom_invoices WHERE invoice_number LIKE ?`,[`${prefix}%`]);
  let seq=Number(row?.seq||0)+1,invoiceNumber='';
  while(seq<1000000){
    invoiceNumber=`${prefix}${String(seq).padStart(6,'0')}`;
    const [exists]=await conn.execute(`SELECT id FROM custom_invoices WHERE invoice_number=? LIMIT 1`,[invoiceNumber]);
    if(!exists.length)break;
    seq++;
  }
  if(!invoiceNumber)throw new Error('Tidak dapat membuat nomor faktur custom untuk periode ini.');
  return invoiceNumber;
}
router.get('/',async(req,res)=>{const q=String(req.query.q||'').trim(),site=String(req.query.site||'').trim(),cluster=String(req.query.cluster||'').trim();let sql=`SELECT ci.*,c.customer_code,s.code site_code,cl.name cluster_name FROM custom_invoices ci LEFT JOIN customers c ON c.id=ci.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE 1=1`;const params=[];if(site){sql+=` AND s.code=?`;params.push(site);}if(cluster){sql+=` AND c.cluster_id=?`;params.push(Number(cluster));}if(q){const like=`%${q}%`;sql+=` AND (ci.invoice_number LIKE ? OR ci.customer_name LIKE ? OR c.customer_code LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)`;params.push(like,like,like,like,like);}sql+=` ORDER BY ci.id DESC`;const [rows]=await db.execute(sql,params);const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.customer_status!='terminated' ORDER BY s.code,cl.name,c.name`);res.render('custom-invoices/index',{title:'Faktur Custom',invoices:rows,customers,sites,clusters,q,site,cluster});});

router.get('/:id/pdf',async(req,res)=>{const [rows]=await db.execute(`SELECT ci.*,c.customer_code,s.code site_code,cl.name cluster_name FROM custom_invoices ci LEFT JOIN customers c ON c.id=ci.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE ci.id=? LIMIT 1`,[req.params.id]);if(!rows.length)return res.status(404).send('Faktur custom tidak ditemukan.');const x=rows[0];createReportPdf(res,{title:`FAKTUR CUSTOM ${x.invoice_number}`,subtitle:`${x.customer_name||'-'}${x.customer_code?` · ${x.customer_code}`:''}${x.site_code?` · ${x.site_code} / Cluster ${x.cluster_name||'-'}`:''}`,filename:`faktur-custom-${String(x.invoice_number).replace(/[^A-Za-z0-9_-]/g,'-')}.pdf`,summaryItems:[{label:'TOTAL',value:rupiah(x.total),color:COLORS.purple},{label:'TANGGAL',value:date(x.invoice_date),color:COLORS.blue},{label:'JATUH TEMPO',value:date(x.due_date),color:COLORS.red},{label:'STATUS',value:documentLabel(x.status||'draft',req.session.language==='en'?'en':'id').toUpperCase(),color:x.status==='paid'?COLORS.green:COLORS.purple}],columns:[{label:'DESKRIPSI',width:4,value:()=>x.description||'Faktur custom INKAMNET'},{label:'NOMINAL',width:1.5,value:()=>rupiah(x.total),bold:true,align:'right'}],rows:[x],layout:'portrait',disposition:req.query.download==='0'?'inline':'attachment'});});

router.post('/',async(req,res)=>{
  const b=req.body;let customerName=b.customer_name||'';
  if(b.customer_id){const [c]=await db.execute(`SELECT name FROM customers WHERE id=?`,[b.customer_id]);if(c[0])customerName=c[0].name;}
  const conn=await db.getConnection();let lockHeld=false,invoiceNumber='';
  try{
    const [[lockRow]]=await conn.query(`SELECT GET_LOCK('inkamnet_custom_invoice_code',10) locked`);
    if(Number(lockRow?.locked)!==1)throw new Error('Pembuatan faktur custom sedang diproses oleh sesi lain. Coba lagi beberapa detik.');
    lockHeld=true;
    invoiceNumber=await nextCustomInvoiceNumber(conn);
    await conn.execute(`INSERT INTO custom_invoices(invoice_number,customer_id,customer_name,invoice_date,due_date,description,total,status,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,[invoiceNumber,b.customer_id||null,customerName,b.invoice_date||new Date().toISOString().slice(0,10),b.due_date||null,b.description||null,b.total||0,b.status||'draft',req.session.user.id]);
  }catch(e){
    req.session.flash={type:'danger',message:`Faktur custom gagal dibuat: ${e.message}`};
    if(lockHeld)try{await conn.query(`DO RELEASE_LOCK('inkamnet_custom_invoice_code')`);}catch(_){}
    conn.release();
    return res.redirect('/custom-invoices');
  }
  if(lockHeld)try{await conn.query(`DO RELEASE_LOCK('inkamnet_custom_invoice_code')`);}catch(_){}
  conn.release();
  req.session.flash={type:'success',message:`Faktur custom ${invoiceNumber} berhasil dibuat.`};res.redirect('/custom-invoices');
});

// v1.25 audit: Faktur Custom previously had Create + List + PDF only — no way to fix a wrong
// description/total/date or move it out of draft once entered. invoice_number stays immutable (it's the
// printed/shared reference); everything else is editable.
router.post('/:id/edit',async(req,res)=>{
  const b=req.body;
  const [[invoice]]=await db.execute(`SELECT id FROM custom_invoices WHERE id=? LIMIT 1`,[req.params.id]);
  if(!invoice){req.session.flash={type:'warning',message:'Faktur custom tidak ditemukan.'};return res.redirect('/custom-invoices');}
  let customerName=b.customer_name||'';
  if(b.customer_id){const [c]=await db.execute(`SELECT name FROM customers WHERE id=?`,[b.customer_id]);if(c[0])customerName=c[0].name;}
  const allowedStatus=new Set(['draft','sent','paid','cancelled']);
  await db.execute(`UPDATE custom_invoices SET customer_id=?,customer_name=?,invoice_date=?,due_date=?,description=?,total=?,status=? WHERE id=?`,
    [b.customer_id||null,customerName,b.invoice_date||new Date().toISOString().slice(0,10),b.due_date||null,b.description||null,b.total||0,allowedStatus.has(b.status)?b.status:'draft',req.params.id]);
  req.session.flash={type:'success',message:'Faktur custom berhasil diperbarui.'};
  res.redirect('/custom-invoices');
});
module.exports=router;
