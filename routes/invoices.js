const express=require('express');
const fs=require('fs');
const path=require('path');
const ExcelJS=require('exceljs');
const db=require('../config/db');
const {paginate}=require('../utils/pagination');
const { generateMonthlyInvoices, applyInvoiceDiscount, refreshInvoiceStatus, nextInvoiceNumber }=require('../services/invoiceService');
const { requireAdmin, requireMasterAdmin, isMasterAdminRole }=require('../middleware/auth');
const { createCorporateInvoicePdf }=require('../services/reportPdf');
const { audit }=require('../services/auditService');
const router=express.Router();
const invoiceLogoDir=path.join(__dirname,'..','storage','invoice-branding');

const MONTH_NAMES=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function intInRange(value,min,max,fallback){const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function localReturn(value,fallback='/invoices'){const v=String(value||'').trim();return v.startsWith('/')&&!v.startsWith('//')?v:fallback;}
function periodDate(year,month){
  const now=new Date();
  const day=(now.getFullYear()===year && now.getMonth()+1===month)?now.getDate():1;
  return new Date(year,month-1,day);
}
function periodQuery(filters){
  const p=new URLSearchParams();
  p.set('month',filters.month);p.set('year',filters.year);
  if(filters.status) p.set('status',filters.status);
  if(filters.site) p.set('site',filters.site);
  if(filters.cluster) p.set('cluster',filters.cluster);
  if(filters.customer) p.set('customer',filters.customer);
  if(filters.q) p.set('q',filters.q);
  if(filters.dueBucket) p.set('due_bucket',filters.dueBucket);
  return p.toString();
}
const STATUS_LABELS={paid:'LUNAS',overdue:'TERLAMBAT',partial:'SEBAGIAN',cancelled:'DIBATALKAN',refunded:'REFUND',unpaid:'BELUM LUNAS'};

// v1.25.5 — Import Tagihan (Excel), mengikuti pola import Pelanggan (routes/customers.js): pencocokan
// header lewat alias, validasi SELURUH baris dulu (all-or-nothing) baru commit. Bisa MEMBUAT tagihan baru
// (insert) maupun MEMPERBARUI tagihan yang sudah ada (upsert), dicocokkan lewat No. Faktur (jika diisi)
// atau kombinasi Kode Pelanggan+Bulan+Tahun (jika kosong). Tagihan berstatus LUNAS/DIBATALKAN/REFUND
// tidak pernah disentuh nominalnya oleh import. Kolom "Sudah Dibayar" TIDAK langsung melunaskan tagihan —
// sistem membuat catatan pembayaran berstatus MENUNGGU APPROVAL (identik dengan alur pembayaran manual
// biasa), supaya Arus Kas/Laporan tetap konsisten dan tetap lewat approval Master Admin seperti biasa.
const INVOICE_IMPORT_ALIASES={
  invoice_number:['no. faktur','nomor faktur','no faktur','invoice_number'],
  customer_code:['kode pelanggan','customer_code','id pelanggan'],
  month:['bulan','month'],
  year:['tahun','year'],
  invoice_date:['tanggal faktur','invoice_date'],
  due_date:['jatuh tempo','due_date'],
  billing_type:['tipe tagihan','billing_type','tipe'],
  amount:['nominal tagihan','tagihan','amount'],
  discount:['diskon','discount'],
  paid_amount:['sudah dibayar','terbayar','paid_amount']
};
function plainInvoiceCell(cell){
  const v=cell?.value;
  if(v==null) return '';
  if(v instanceof Date) return v;
  if(typeof v==='object'){
    if(v.text!=null) return String(v.text);
    if(v.result!=null) return v.result;
    if(Array.isArray(v.richText)) return v.richText.map(x=>x.text||'').join('');
  }
  return v;
}
function invoiceDateString(value){
  if(!value) return null;
  if(value instanceof Date) return value.toISOString().slice(0,10);
  const s=String(value).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if(m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}
function normalizeInvoiceImportHeader(value){return String(value||'').trim().toLowerCase().replace(/\s+/g,' ');}
function findInvoiceImportHeaderRow(ws){
  for(let r=1;r<=Math.min(ws.rowCount,30);r++){
    const row=ws.getRow(r);
    const values=[];
    row.eachCell({includeEmpty:false},cell=>values.push(normalizeInvoiceImportHeader(plainInvoiceCell(cell))));
    const hasCustomer=values.some(v=>INVOICE_IMPORT_ALIASES.customer_code.includes(v));
    const hasMonth=values.some(v=>INVOICE_IMPORT_ALIASES.month.includes(v));
    const hasYear=values.some(v=>INVOICE_IMPORT_ALIASES.year.includes(v));
    const hasAmount=values.some(v=>INVOICE_IMPORT_ALIASES.amount.includes(v));
    if(hasCustomer&&hasMonth&&hasYear&&hasAmount)return r;
  }
  return 0;
}
function mapInvoiceImportHeaders(row){
  const headers={};
  row.eachCell((cell,col)=>{
    const raw=normalizeInvoiceImportHeader(plainInvoiceCell(cell));
    for(const [key,aliases] of Object.entries(INVOICE_IMPORT_ALIASES)){
      if(!headers[key]&&aliases.includes(raw))headers[key]=col;
    }
  });
  return headers;
}
function invoicePaymentReference(paymentId,date=new Date()){
  const d=new Date(date);
  const stamp=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `PAY-${stamp}-${String(paymentId).padStart(6,'0')}`;
}

// v1.25.4 — filter/query builder dipakai bersama oleh daftar tagihan (GET '/') dan export
// (GET '/export.xlsx') supaya keduanya TIDAK PERNAH berbeda hasil (baris yang tampil di layar harus
// selalu identik dengan baris yang diexport untuk kombinasi filter yang sama).
//
// "Menunggu Approval" (ada pembayaran berstatus 'pending' untuk tagihan tsb.) sekarang dipisah dari
// filter status biasa: memilih status "pending_approval" HANYA menampilkan tagihan yang menunggu
// approval, sedangkan memilih "open"/"unpaid"/"partial"/"overdue" TIDAK LAGI ikut menampilkan tagihan
// yang menunggu approval (supaya user tidak salah kira tagihan itu "belum dibayar sama sekali").
// Status paid/cancelled/refunded tidak diubah — approval pembayaran tidak relevan untuk status itu.
async function queryInvoiceList(req,{paged=false}={}){
  const now=new Date();
  const month=intInRange(req.query.month,1,12,now.getMonth()+1);
  const year=intInRange(req.query.year,2020,2100,now.getFullYear());
  const status=['open','unpaid','partial','paid','overdue','cancelled','refunded','pending_approval'].includes(req.query.status)?req.query.status:'';
  const site=String(req.query.site||'').trim();
  const cluster=String(req.query.cluster||'').trim();
  const customer=String(req.query.customer||'').trim();
  const q=String(req.query.q||'').trim();
  const dueBucket=['due15','due30'].includes(req.query.due_bucket)?req.query.due_bucket:'';

  // Daftar tagihan adalah daftar billing operasional. Invoice historis milik pelanggan
  // yang sudah diarsipkan tetap tersimpan di database, tetapi tidak boleh ikut muncul
  // kembali saat periode digenerate ulang (termasuk invoice lama yang sudah lunas).
  const commonWhere=[
    'i.period_year=?',
    'i.period_month=?',
    `c.customer_status='active'`,
    'c.archived_at IS NULL'
  ];
  const commonParams=[year,month];
  if(site){commonWhere.push('s.code=?');commonParams.push(site);}
  if(cluster){commonWhere.push('c.cluster_id=?');commonParams.push(Number(cluster));}
  if(customer){commonWhere.push('c.id=?');commonParams.push(Number(customer));}

  const listWhere=[...commonWhere];
  const listParams=[...commonParams];
  const pendingClause="EXISTS (SELECT 1 FROM payments pd WHERE pd.invoice_id=i.id AND pd.status='pending')";
  if(status==='pending_approval'){
    listWhere.push(pendingClause);
  }else if(status==='open'){
    listWhere.push("i.status IN ('unpaid','partial','overdue')");
    listWhere.push(`NOT ${pendingClause}`);
  }else if(status==='unpaid'||status==='partial'||status==='overdue'){
    listWhere.push('i.status=?');listParams.push(status);
    listWhere.push(`NOT ${pendingClause}`);
  }else if(status){
    listWhere.push('i.status=?');listParams.push(status);
  }
  if(q){listWhere.push('(c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)');const like=`%${q}%`;listParams.push(like,like,like,like,like);}
  // v1.25.5 (update) — filter Jatuh Tempo disederhanakan jadi 2 opsi saja (due15/due30), mengikuti
  // konvensi pengelompokan tanggal jatuh tempo yang sudah dipakai di services/analyticsService.js
  // (DAY(due_date)<=22 dianggap kelompok "tanggal 15", sisanya kelompok "tanggal 30").
  if(dueBucket==='due15'){listWhere.push('DAY(i.due_date)<=22');}
  else if(dueBucket==='due30'){listWhere.push('DAY(i.due_date)>22');}

  const listSql=`SELECT i.*,DATE_FORMAT(i.invoice_date,'%Y-%m-%d') invoice_date_key,DATE_FORMAT(i.due_date,'%Y-%m-%d') due_date_key,GREATEST(DATEDIFF(CURDATE(),i.due_date),0) days_overdue,c.customer_code,c.name customer_name,c.phone,c.whatsapp_status,c.due_day,c.archived_at customer_archived_at,p.name package_name,s.code site_code,cl.name cluster_name,
      (SELECT COUNT(*) FROM payments px WHERE px.invoice_id=i.id) payment_count,
      (SELECT COUNT(*) FROM payments pa WHERE pa.invoice_id=i.id AND pa.status IN ('confirmed','pending')) active_payment_count,
      (SELECT COUNT(*) FROM payments pd WHERE pd.invoice_id=i.id AND pd.status='pending') pending_payment_count
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN packages p ON p.id=c.package_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    WHERE ${listWhere.join(' AND ')} ORDER BY i.due_date ASC,c.name ASC`;
  let invoices,pagination=null;if(paged){const result=await paginate(db,listSql,listParams,req,500,500);invoices=result.rows;pagination=result.pagination;}else [invoices]=await db.execute(listSql,listParams);

  const filters={month,year,status,site,cluster,customer,q,dueBucket};
  return {invoices,filters,commonWhere,commonParams,pagination};
}

function styleInvoiceWorkbook(ws){
  ws.views=[{state:'frozen',ySplit:1}];
  ws.autoFilter={from:'A1',to:ws.getRow(1).getCell(ws.columnCount).address};
  const headerRow=ws.getRow(1);headerRow.height=25;
  headerRow.eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF6030E0'}};cell.alignment={vertical:'middle'};cell.border={bottom:{style:'thin',color:{argb:'FFF04030'}}};});
  ws.eachRow((r,n)=>{if(n>1)r.alignment={vertical:'middle'};});
}

async function loadInvoiceBranding(){
  const [[s]]=await db.query(`SELECT company_name,company_address,company_phone,company_email,company_website,company_tagline,invoice_company_name,invoice_address,invoice_phone,invoice_email,invoice_website,invoice_tax_id,invoice_footer,invoice_logo_path FROM settings WHERE id=1`);
  const configuredCompany=String(s?.invoice_company_name||s?.company_name||'PT INKAMNET NEXERA TECHNOLOGY').trim();
  const branding={
    companyName:/^PT(?:\.|\s)/i.test(configuredCompany)?configuredCompany:`PT ${configuredCompany}`,
    address:s?.invoice_address||s?.company_address||'',phone:s?.invoice_phone||s?.company_phone||'',email:s?.invoice_email||s?.company_email||'',website:s?.invoice_website||s?.company_website||'',
    taxId:s?.invoice_tax_id||'',footer:s?.invoice_footer||'Dokumen digital resmi. Tidak memerlukan tanda tangan basah.',tagline:s?.company_tagline||'From the Village, Online Everywhere',logoPath:s?.invoice_logo_path||null
  };
  branding.logoFilePath=branding.logoPath?path.join(invoiceLogoDir,path.basename(branding.logoPath)):null;
  if(branding.logoFilePath&&!fs.existsSync(branding.logoFilePath)){branding.logoFilePath=null;branding.logoPath=null;}
  return branding;
}

router.get('/',async(req,res)=>{
  await db.query(`UPDATE invoices SET status='overdue' WHERE status IN ('unpaid','partial') AND due_date < CURDATE()`);
  const {invoices,filters,commonWhere,commonParams,pagination}=await queryInvoiceList(req,{paged:true});res.locals.pagination=pagination;
  const {month,year,site,cluster,customer}=filters;

  const [[invoiceSummary]]=await db.execute(`SELECT
      COUNT(*) total_invoices,
      SUM(i.status='paid') paid_count,
      SUM(i.status IN ('unpaid','partial','overdue')) unpaid_count,
      COALESCE(SUM(i.paid_amount),0) paid_amount,
      COALESCE(SUM(i.outstanding),0) outstanding_amount
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id
    WHERE ${commonWhere.join(' AND ')}`,commonParams);

  const customerWhere=[`c.customer_status='active'`,`c.archived_at IS NULL`];
  const customerParams=[];
  if(site){customerWhere.push('s.code=?');customerParams.push(site);}
  if(cluster){customerWhere.push('c.cluster_id=?');customerParams.push(Number(cluster));}
  if(customer){customerWhere.push('c.id=?');customerParams.push(Number(customer));}
  const [[activeSummary]]=await db.execute(`SELECT COUNT(*) active_customers FROM customers c JOIN sites s ON s.id=c.site_id WHERE ${customerWhere.join(' AND ')}`,customerParams);

  const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.customer_status='active' AND c.archived_at IS NULL ORDER BY s.code,cl.name,c.name`);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);
  const issued=Number(invoiceSummary.total_invoices||0);
  const active=Number(activeSummary.active_customers||0);
  const summary={
    active,
    total:issued,
    issued,
    notIssued:Math.max(0,active-issued),
    paidCount:Number(invoiceSummary.paid_count||0),
    unpaidCount:Number(invoiceSummary.unpaid_count||0),
    paidAmount:Number(invoiceSummary.paid_amount||0),
    outstanding:Number(invoiceSummary.outstanding_amount||0)
  };
  const [openInvoices]=await db.query(`SELECT i.id,i.invoice_number,i.outstanding,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id
    WHERE c.customer_status='active' AND c.archived_at IS NULL
      AND i.status IN ('unpaid','partial','overdue') AND i.outstanding>0
      AND NOT EXISTS (SELECT 1 FROM payments pp WHERE pp.invoice_id=i.id AND pp.status='pending')
    ORDER BY s.code,cl.name,c.name,i.due_date`);
  const [staff]=await db.query(`SELECT id,name,role FROM users WHERE is_active=1 ORDER BY name`);
  const [banks]=await db.query(`SELECT id,bank_name,account_name,account_number,type FROM banks WHERE is_active=1 AND type IN ('bank_transfer','virtual_account','other') ORDER BY bank_name,account_number`);

  res.render('invoices/index',{title:'Tagihan',invoices,summary,customers,sites,clusters,openInvoices,staff,banks,filters,monthNames:MONTH_NAMES,periodQueryString:periodQuery(filters)});
});

// v1.25.4 — export Daftar Tagihan (sesuai filter yang sedang aktif) ke Excel, supaya admin bisa
// gampang mencatat/menginput data tagihan yang sudah masuk tanpa harus menyalin manual dari layar.
router.get('/export.xlsx',requireAdmin,async(req,res)=>{
  const {invoices,filters}=await queryInvoiceList(req);
  const wb=new ExcelJS.Workbook();
  wb.creator='INKAMNET Control Center';
  const ws=wb.addWorksheet('TAGIHAN');
  ws.columns=[
    ['No. Faktur',20],['Kode Pelanggan',16],['Nama Pelanggan',26],['Site',10],['Cluster',18],
    ['Periode',16],['Status',18],['Paket',20],['Tagihan',16],['Terbayar',16],['Sisa Tagihan',16],
    ['Tanggal Faktur',14],['Jatuh Tempo',14]
  ].map(([header,width])=>({header,key:header,width}));
  invoices.forEach(i=>{
    const hasPending=Number(i.pending_payment_count||0)>0;
    const statusLabel=hasPending?'MENUNGGU APPROVAL':(STATUS_LABELS[i.status]||String(i.status||'').toUpperCase());
    ws.addRow({
      'No. Faktur':i.invoice_number,
      'Kode Pelanggan':i.customer_code,
      'Nama Pelanggan':i.customer_name,
      'Site':i.site_code,
      'Cluster':i.cluster_name||'-',
      'Periode':`${MONTH_NAMES[i.period_month-1]} ${i.period_year}`,
      'Status':statusLabel,
      'Paket':i.package_name,
      'Tagihan':Number(i.total),
      'Terbayar':Number(i.paid_amount),
      'Sisa Tagihan':Number(i.outstanding),
      'Tanggal Faktur':i.invoice_date_key,
      'Jatuh Tempo':i.due_date_key
    });
  });
  styleInvoiceWorkbook(ws);
  ['Tagihan','Terbayar','Sisa Tagihan'].forEach(key=>{ws.getColumn(key).numFmt='#,##0';});
  ['Tanggal Faktur','Jatuh Tempo'].forEach(key=>{ws.getColumn(key).numFmt='yyyy-mm-dd';});
  const filename=`tagihan-INKAMNET-${filters.year}-${String(filters.month).padStart(2,'0')}${filters.site?'-'+filters.site:''}-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

router.get('/template.xlsx',requireAdmin,async(req,res)=>{
  const [customers]=await db.query(`SELECT c.customer_code FROM customers c WHERE c.customer_status='active' AND c.archived_at IS NULL ORDER BY c.customer_code LIMIT 2000`);
  const wb=new ExcelJS.Workbook();wb.creator='INKAMNET Control Center';wb.created=new Date();
  const ws=wb.addWorksheet('TAGIHAN',{views:[{state:'frozen',ySplit:11}]});
  const widths=[4,20,16,10,10,16,16,14,16,14,16];
  widths.forEach((w,i)=>ws.getColumn(i+1).width=w);

  ws.getCell('A1').value='#';ws.getCell('B1').value='INKAMNET - TEMPLATE EXCEL IMPORT TAGIHAN';
  ws.mergeCells('B1:K1');
  ws.getCell('B1').font={bold:true,size:16,color:{argb:'FF6030E0'}};
  ws.getCell('B1').alignment={vertical:'middle'};ws.getRow(1).height=28;

  const instructions=[
    'INSTRUKSI UNTUK IMPORT (HARAP DIBACA DULU)',
    'Kosongkan "No. Faktur" untuk MEMBUAT tagihan baru. Isi "No. Faktur" untuk MEMPERBARUI tagihan yang sudah ada.',
    'Jika No. Faktur dikosongkan, sistem mencocokkan otomatis lewat Kode Pelanggan + Bulan + Tahun.',
    'Tagihan berstatus LUNAS/DIBATALKAN/REFUND tidak akan diubah nominalnya oleh import ini (baris dilewati).',
    'Tagihan yang sudah punya riwayat pembayaran: Nominal/Diskon/Sudah Dibayar TIDAK diubah, hanya Tanggal Faktur/Jatuh Tempo/Tipe yang diperbarui.',
    'Kolom "Sudah Dibayar" TIDAK langsung membuat tagihan lunas — sistem membuat catatan pembayaran berstatus MENUNGGU APPROVAL, approve manual dari Menu Approval agar Arus Kas tetap sinkron.',
    'Format tanggal: DD/MM/YYYY atau YYYY-MM-DD.',
    'Seluruh baris divalidasi dahulu. Jika ada satu baris error, seluruh import dibatalkan agar data tidak masuk setengah-setengah.'
  ];
  instructions.forEach((txt,i)=>{
    const r=i+3;ws.getCell(`A${r}`).value='#';ws.getCell(`B${r}`).value=i===0?txt:`- ${txt}`;
    ws.mergeCells(`B${r}:K${r}`);
    ws.getCell(`B${r}`).font={bold:i===0,color:{argb:i===0?'FFF04030':'FF4B5563'}};
  });

  const requiredNotes=['#','Opsional (update)','*WAJIB','*WAJIB','*WAJIB','*WAJIB','*WAJIB','Opsional','*WAJIB (baru)','Opsional','Opsional'];
  const headers=['#','No. Faktur','Kode Pelanggan','Bulan','Tahun','Tanggal Faktur','Jatuh Tempo','Tipe Tagihan','Nominal Tagihan','Diskon','Sudah Dibayar'];
  ws.getRow(10).values=requiredNotes;
  ws.getRow(11).values=headers;
  ws.getRow(10).height=42;ws.getRow(11).height=24;
  ws.getRow(10).eachCell((cell,col)=>{
    cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
    cell.font={bold:col>1&&String(cell.value).includes('WAJIB'),color:{argb:col>1&&String(cell.value).includes('WAJIB')?'FFF04030':'FF667085'},size:10};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF8FAFC'}};
    cell.border={top:{style:'thin',color:{argb:'FFD0D5DD'}},bottom:{style:'thin',color:{argb:'FFD0D5DD'}}};
  });
  ws.getRow(11).eachCell((cell,col)=>{
    cell.font={bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:col===1?'FF111827':'FF6030E0'}};
    cell.alignment={vertical:'middle',horizontal:col===1?'center':'left'};
    cell.border={bottom:{style:'medium',color:{argb:'FFF04030'}}};
  });

  const now=new Date();
  const sampleCustomer=customers[0]?.customer_code||'KRW-15-001';
  ws.getRow(12).values=['#','',sampleCustomer,now.getMonth()+1,now.getFullYear(),now.toISOString().slice(0,10),now.toISOString().slice(0,10),'BULANAN',150000,0,0];
  ws.getRow(12).font={italic:true,color:{argb:'FF667085'}};

  const helperCol='AA';
  customers.forEach((c,i)=>ws.getCell(`${helperCol}${i+2}`).value=c.customer_code);
  ws.getColumn(helperCol).hidden=true;
  const typeHelperCol='AB';
  ['BULANAN','PRORATA'].forEach((x,i)=>ws.getCell(`${typeHelperCol}${i+2}`).value=x);
  ws.getColumn(typeHelperCol).hidden=true;

  for(let row=13;row<=2012;row++){
    if(customers.length)ws.getCell(`C${row}`).dataValidation={type:'list',allowBlank:false,formulae:[`$${helperCol}$2:$${helperCol}$${Math.max(2,customers.length+1)}`],showErrorMessage:true,errorTitle:'Kode Pelanggan',error:'Pilih Kode Pelanggan dari daftar pelanggan aktif, atau ketik manual jika pelanggan sudah diarsipkan.'};
    ws.getCell(`D${row}`).dataValidation={type:'whole',operator:'between',allowBlank:false,formulae:[1,12],showErrorMessage:true,errorTitle:'Bulan',error:'Isi angka 1-12.'};
    ws.getCell(`E${row}`).dataValidation={type:'whole',operator:'between',allowBlank:false,formulae:[2020,2100],showErrorMessage:true,errorTitle:'Tahun',error:'Isi tahun 2020-2100.'};
    ws.getCell(`F${row}`).numFmt='dd/mm/yyyy';ws.getCell(`G${row}`).numFmt='dd/mm/yyyy';
    ws.getCell(`H${row}`).dataValidation={type:'list',allowBlank:true,formulae:[`$${typeHelperCol}$2:$${typeHelperCol}$3`]};
    ws.getCell(`I${row}`).numFmt='#,##0';ws.getCell(`J${row}`).numFmt='#,##0';ws.getCell(`K${row}`).numFmt='#,##0';
  }
  ws.autoFilter={from:'B11',to:'K11'};

  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="template-import-tagihan-INKAMNET.xlsx"');
  await wb.xlsx.write(res);res.end();
});

router.post('/import',requireAdmin,async(req,res)=>{
  try{
    if(!req.file) throw new Error('Pilih file Excel .xlsx terlebih dahulu.');
    if(!req.file.buffer || req.file.buffer.length<4 || req.file.buffer.subarray(0,2).toString()!=='PK') throw new Error('Isi file bukan workbook XLSX yang valid.');
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(req.file.buffer);
    const ws=workbook.getWorksheet('TAGIHAN')||workbook.worksheets[0];if(!ws)throw new Error('Workbook tidak memiliki sheet tagihan.');
    if(ws.rowCount>3001) throw new Error('Maksimal 3.000 baris tagihan per sekali import. Pecah file menjadi beberapa batch.');
    const headerRow=findInvoiceImportHeaderRow(ws);if(!headerRow)throw new Error('Header tagihan tidak ditemukan. Gunakan template terbaru dari menu Download Format Import.');
    const headers=mapInvoiceImportHeaders(ws.getRow(headerRow));
    const required=['customer_code','month','year','invoice_date','due_date','amount'];
    const missing=required.filter(h=>!headers[h]);
    if(missing.length)throw new Error(`Kolom wajib tidak ada: ${missing.join(', ')}. Download template terbaru dan jangan ubah nama kolom wajib.`);

    const [customers]=await db.query(`SELECT c.id,c.customer_code,c.archived_at,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id`);
    const customerMap=new Map();for(const c of customers)customerMap.set(String(c.customer_code).trim().toUpperCase(),c);

    const value=(row,key)=>headers[key]?plainInvoiceCell(row.getCell(headers[key])):'';
    const parsed=[];const errors=[];const neededCustomerIds=new Set();
    for(let n=headerRow+1;n<=ws.rowCount;n++){
      const row=ws.getRow(n);
      const marker=String(plainInvoiceCell(row.getCell(1))||'').trim();if(marker==='#')continue;
      const customerCodeRaw=String(value(row,'customer_code')||'').trim();
      if(!customerCodeRaw)continue;
      const customer=customerMap.get(customerCodeRaw.toUpperCase());
      if(!customer)errors.push(`Baris ${n}: Kode Pelanggan '${customerCodeRaw}' tidak ditemukan`);
      const monthRaw=value(row,'month');const month=Number(monthRaw);
      if(!Number.isInteger(month)||month<1||month>12)errors.push(`Baris ${n}: Bulan harus angka 1-12`);
      const yearRaw=value(row,'year');const year=Number(yearRaw);
      if(!Number.isInteger(year)||year<2020||year>2100)errors.push(`Baris ${n}: Tahun tidak valid`);
      const invoiceDate=invoiceDateString(value(row,'invoice_date'));
      if(!invoiceDate)errors.push(`Baris ${n}: Tanggal Faktur wajib diisi & valid`);
      const dueDate=invoiceDateString(value(row,'due_date'));
      if(!dueDate)errors.push(`Baris ${n}: Jatuh Tempo wajib diisi & valid`);
      if(invoiceDate&&dueDate&&dueDate<invoiceDate)errors.push(`Baris ${n}: Jatuh Tempo tidak boleh sebelum Tanggal Faktur`);
      const billingTypeRaw=(String(value(row,'billing_type')||'').trim().toUpperCase())||'BULANAN';
      if(!['BULANAN','PRORATA'].includes(billingTypeRaw))errors.push(`Baris ${n}: Tipe Tagihan harus BULANAN atau PRORATA`);
      const isProrata=billingTypeRaw==='PRORATA'?1:0;
      const invoiceNumberRaw=String(value(row,'invoice_number')||'').trim();
      const amountRaw=value(row,'amount');const amount=amountRaw===''?null:Number(amountRaw);
      if(amount!==null&&(!Number.isFinite(amount)||amount<0))errors.push(`Baris ${n}: Nominal Tagihan tidak valid`);
      const discountRaw=value(row,'discount');const discount=discountRaw===''?0:Number(discountRaw);
      if(!Number.isFinite(discount)||discount<0)errors.push(`Baris ${n}: Diskon tidak valid`);
      const paidRaw=value(row,'paid_amount');const paidAmount=paidRaw===''?0:Number(paidRaw);
      if(!Number.isFinite(paidAmount)||paidAmount<0)errors.push(`Baris ${n}: Sudah Dibayar tidak valid`);
      if(customer)neededCustomerIds.add(customer.id);
      parsed.push({n,customer,month,year,invoiceDate,dueDate,isProrata,invoiceNumberRaw,amount,discount,paidAmount});
    }
    if(!parsed.length)throw new Error('Tidak ada data tagihan pada file.');
    if(errors.length){req.session.flash={type:'danger',message:`Import dibatalkan. ${errors.slice(0,8).join(' | ')}${errors.length>8?` | +${errors.length-8} error lain`:''}`};return res.redirect('/invoices');}

    const customerIds=[...neededCustomerIds];
    let existingInvoices=[];
    if(customerIds.length){
      const placeholders=customerIds.map(()=>'?').join(',');
      const [rows]=await db.query(`SELECT i.id,i.invoice_number,i.customer_id,i.period_year,i.period_month,i.status,i.total,(SELECT COUNT(*) FROM payments p WHERE p.invoice_id=i.id) payment_count FROM invoices i WHERE i.customer_id IN (${placeholders})`,customerIds);
      existingInvoices=rows;
    }
    const invoiceByNumber=new Map();const invoiceByCustomerPeriod=new Map();
    for(const inv of existingInvoices){
      invoiceByNumber.set(String(inv.invoice_number).trim().toUpperCase(),inv);
      invoiceByCustomerPeriod.set(`${inv.customer_id}-${inv.period_year}-${inv.period_month}`,inv);
    }

    const rowsToProcess=[];
    for(const r of parsed){
      if(!r.customer)continue;
      let existing=null;
      if(r.invoiceNumberRaw){
        existing=invoiceByNumber.get(r.invoiceNumberRaw.toUpperCase())||null;
        if(!existing){errors.push(`Baris ${r.n}: No. Faktur '${r.invoiceNumberRaw}' tidak ditemukan`);continue;}
        if(existing.customer_id!==r.customer.id){errors.push(`Baris ${r.n}: No. Faktur '${r.invoiceNumberRaw}' bukan milik pelanggan ${r.customer.customer_code}`);continue;}
        if(Number(existing.period_month)!==r.month||Number(existing.period_year)!==r.year){errors.push(`Baris ${r.n}: No. Faktur '${r.invoiceNumberRaw}' periodenya ${MONTH_NAMES[existing.period_month-1]} ${existing.period_year}, bukan ${MONTH_NAMES[r.month-1]||r.month} ${r.year}`);continue;}
      }else{
        existing=invoiceByCustomerPeriod.get(`${r.customer.id}-${r.year}-${r.month}`)||null;
      }
      const isInsert=!existing;
      if(isInsert&&(r.amount===null||r.amount<=0)){errors.push(`Baris ${r.n}: Nominal Tagihan wajib diisi (>0) untuk tagihan baru`);continue;}
      rowsToProcess.push({...r,existing,isInsert});
    }
    if(errors.length){req.session.flash={type:'danger',message:`Import dibatalkan. ${errors.slice(0,8).join(' | ')}${errors.length>8?` | +${errors.length-8} error lain`:''}`};return res.redirect('/invoices');}

    const conn=await db.getConnection();
    let created=0,updated=0,skippedSettled=0,financialSkipped=0,pendingPaymentsCreated=0;
    try{
      await conn.beginTransaction();
      for(const r of rowsToProcess){
        if(r.isInsert){
          const subtotal=r.amount;
          const discount=Math.max(0,Math.min(r.discount,subtotal));
          const total=subtotal-discount;
          const invoiceNumber=await nextInvoiceNumber(conn,r.customer.site_code,r.year,r.month-1);
          const [ins]=await conn.execute(`INSERT INTO invoices (invoice_number,customer_id,period_year,period_month,invoice_date,due_date,subtotal,discount,total,outstanding,status,is_prorata,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,'unpaid',?,?)`,[invoiceNumber,r.customer.id,r.year,r.month,r.invoiceDate,r.dueDate,subtotal,discount,total,total,r.isProrata,req.session.user.id]);
          const invoiceId=ins.insertId;created++;
          if(r.paidAmount>0){
            const applyAmount=Math.min(r.paidAmount,total);
            const [pr]=await conn.execute(`INSERT INTO payments (invoice_id,amount,method,reference,notes,status,settlement_status,paid_at,received_by,collector_user_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,[invoiceId,applyAmount,'cash',null,'Import Excel — data tagihan sudah masuk, menunggu approval','pending','not_applicable',r.invoiceDate,req.session.user.id,req.session.user.id]);
            await conn.execute(`UPDATE payments SET reference=? WHERE id=?`,[invoicePaymentReference(pr.insertId),pr.insertId]);
            pendingPaymentsCreated++;
            await refreshInvoiceStatus(conn,invoiceId);
          }
        }else{
          const existing=r.existing;
          if(['paid','cancelled','refunded'].includes(existing.status)){skippedSettled++;continue;}
          await conn.execute(`UPDATE invoices SET invoice_date=?,due_date=?,is_prorata=? WHERE id=?`,[r.invoiceDate,r.dueDate,r.isProrata,existing.id]);
          const touchesFinancials=r.amount!==null||r.paidAmount>0;
          if(Number(existing.payment_count)===0){
            let total=Number(existing.total);
            if(r.amount!==null){
              const subtotal=r.amount;
              const discount=Math.max(0,Math.min(r.discount,subtotal));
              total=subtotal-discount;
              await conn.execute(`UPDATE invoices SET subtotal=?,discount=?,total=?,outstanding=? WHERE id=?`,[subtotal,discount,total,total,existing.id]);
            }
            if(r.paidAmount>0){
              const applyAmount=Math.min(r.paidAmount,total);
              const [pr]=await conn.execute(`INSERT INTO payments (invoice_id,amount,method,reference,notes,status,settlement_status,paid_at,received_by,collector_user_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,[existing.id,applyAmount,'cash',null,'Import Excel — data tagihan sudah masuk, menunggu approval','pending','not_applicable',r.invoiceDate,req.session.user.id,req.session.user.id]);
              await conn.execute(`UPDATE payments SET reference=? WHERE id=?`,[invoicePaymentReference(pr.insertId),pr.insertId]);
              pendingPaymentsCreated++;
            }
          }else if(touchesFinancials){
            financialSkipped++;
          }
          await refreshInvoiceStatus(conn,existing.id);
          updated++;
        }
      }
      await conn.commit();
    }catch(e){try{await conn.rollback();}catch(_){}throw e;}finally{conn.release();}

    await audit({userId:req.session.user.id,action:'import',entityType:'invoice',entityId:null,description:`Excel import tagihan: ${created} baru, ${updated} diperbarui, ${skippedSettled} dilewati (sudah lunas/dibatalkan/refund), ${financialSkipped} nominal dilewati (sudah ada riwayat pembayaran), ${pendingPaymentsCreated} pembayaran baru menunggu approval`,ip:req.ip});
    req.session.flash={type:'success',message:`Import Excel selesai: ${created} tagihan baru, ${updated} tagihan diperbarui${skippedSettled?`, ${skippedSettled} dilewati (sudah lunas/dibatalkan/refund)`:''}${financialSkipped?`, ${financialSkipped} nominal tidak diubah (tagihan sudah punya riwayat pembayaran)`:''}${pendingPaymentsCreated?`. ${pendingPaymentsCreated} pembayaran baru tercatat MENUNGGU APPROVAL — cek Menu Approval.`:'.'}`};
    return res.redirect('/invoices');
  }catch(err){
    console.error('Invoice XLSX import gagal:',err.message);
    req.session.flash={type:'danger',message:`Import Excel gagal: ${err.message}`};
    return res.redirect('/invoices');
  }
});

router.post('/generate',async(req,res)=>{
  const now=new Date();
  const month=intInRange(req.body.month,1,12,now.getMonth()+1);
  const year=intInRange(req.body.year,2020,2100,now.getFullYear());
  const customerId=req.body.customer_id?Number(req.body.customer_id):null;
  const siteCode=String(req.body.site||'').trim()||null;
  const clusterId=req.body.cluster_id?Number(req.body.cluster_id):null;
  const result=await generateMonthlyInvoices(periodDate(year,month),true,req.session.user.id,{customerId,siteCode,clusterId});
  const target=customerId?'pelanggan terpilih':clusterId?`cluster terpilih`:siteCode?`site ${siteCode}`:'seluruh pelanggan aktif';
  req.session.flash={type:'success',message:`Refresh tagihan ${MONTH_NAMES[month-1]} ${year} untuk ${target}: ${result.created} baru, ${result.refreshed||0} nominal tagihan terbuka diperbarui. ${result.existingPaid||0} tagihan lunas dan ${result.existingOpen||0} tagihan yang sudah memiliki pembayaran tetap dipertahankan.`};
  res.redirect(`/invoices?month=${month}&year=${year}${siteCode?`&site=${encodeURIComponent(siteCode)}`:''}${clusterId?`&cluster=${clusterId}`:''}${customerId?`&customer=${customerId}`:''}`);
});


router.get('/branding/logo/:filename',(req,res)=>{
  const safe=path.basename(req.params.filename||'');
  const file=path.join(invoiceLogoDir,safe);
  if(!safe||!fs.existsSync(file))return res.status(404).end();
  res.setHeader('Cache-Control','private, max-age=3600');
  res.sendFile(file);
});

router.get('/:id/pdf',async(req,res)=>{
  const [rows]=await db.execute(`SELECT i.*,c.customer_code,c.name customer_name,c.phone,c.address,p.name package_name,s.code site_code,s.name site_name,cl.name cluster_name FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN packages p ON p.id=c.package_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE i.id=? LIMIT 1`,[req.params.id]);
  if(!rows.length)return res.status(404).send('Tagihan tidak ditemukan.');const x=rows[0];
  const [bankRows]=await db.query(`SELECT bank_name,account_name,account_number FROM banks WHERE is_active=1 ORDER BY id LIMIT 1`);
  const [payments]=await db.execute(`SELECT amount,method,reference,status,paid_at FROM payments WHERE invoice_id=? ORDER BY paid_at`,[req.params.id]);
  const branding=await loadInvoiceBranding();
  createCorporateInvoicePdf(res,{invoice:x,bank:bankRows[0]||null,payments,branding,language:req.session.language==='en'?'en':'id',filename:`invoice-${x.invoice_number.replace(/[^A-Za-z0-9_-]/g,'-')}.pdf`,disposition:req.query.download==='1'?'attachment':'inline'});
});

router.get('/:id/print',async(req,res)=>{
  const [rows]=await db.execute(`SELECT i.*,c.customer_code,c.name customer_name,c.phone,c.address,p.name package_name,p.price package_price,s.code site_code,s.name site_name,cl.name cluster_name
    FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN packages p ON p.id=c.package_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE i.id=? LIMIT 1`,[req.params.id]);
  if(!rows.length) return res.status(404).send('Tagihan tidak ditemukan.');
  const [payments]=await db.execute(`SELECT amount,method,reference,status,paid_at FROM payments WHERE invoice_id=? ORDER BY paid_at`,[req.params.id]);
  const [bankRows]=await db.query(`SELECT bank_name,account_name,account_number,type FROM banks WHERE is_active=1 ORDER BY id LIMIT 1`);
  const branding=await loadInvoiceBranding();
  res.render('invoices/print',{title:`Faktur ${rows[0].invoice_number}`,invoice:rows[0],payments,bank:bankRows[0]||null,branding});
});


router.post('/:id/update-meta',async(req,res)=>{
  const invoiceDate=String(req.body.invoice_date||'').trim();
  const dueDate=String(req.body.due_date||'').trim();
  const isProrata=req.body.is_prorata==='1'?1:0;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)||!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)){
    req.session.flash={type:'danger',message:'Tanggal faktur dan jatuh tempo wajib valid.'};
    return res.redirect(localReturn(req.body.return_to,'/invoices'));
  }
  if(new Date(`${dueDate}T00:00:00`)<new Date(`${invoiceDate}T00:00:00`)){
    req.session.flash={type:'danger',message:'Jatuh tempo tidak boleh sebelum tanggal faktur.'};
    return res.redirect(localReturn(req.body.return_to,'/invoices'));
  }
  const [rows]=await db.execute(`SELECT id,invoice_number,period_month,period_year,total,paid_amount,status FROM invoices WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length){req.session.flash={type:'danger',message:'Tagihan tidak ditemukan.'};return res.redirect('/invoices');}
  await db.execute(`UPDATE invoices SET invoice_date=?,due_date=?,is_prorata=?,status=CASE WHEN status='overdue' AND ?>=CURDATE() THEN 'unpaid' WHEN status='unpaid' AND ?<CURDATE() THEN 'overdue' ELSE status END WHERE id=?`,[invoiceDate,dueDate,isProrata,dueDate,dueDate,req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'invoice',entityId:req.params.id,description:`Edit metadata tagihan ${rows[0].invoice_number}: tanggal ${invoiceDate}, jatuh tempo ${dueDate}, tipe ${isProrata?'prorata':'bulanan'}; nominal tidak diubah`,ip:req.ip});
  req.session.flash={type:'success',message:'Metadata tagihan berhasil diperbarui. Nominal, pembayaran, dan saldo tagihan tidak diubah.'};
  res.redirect(localReturn(req.body.return_to,`/invoices?month=${rows[0].period_month}&year=${rows[0].period_year}`));
});

// v1.25.2 — "Tambah Diskon" row action (Daftar Tagihan): lets an admin set a one-off discount (flat
// rupiah or percent) directly on a single invoice, independent of the customer's discount_id. Formula:
// Total Akhir = Nominal Tagihan (subtotal) - Diskon, applied via applyInvoiceDiscount() which locks the
// row FOR UPDATE inside this transaction and refuses to touch an already paid/cancelled/refunded invoice
// so historical/settled invoices can never be corrupted by this action.
router.post('/:id/discount',requireAdmin,async(req,res)=>{
  const mode=req.body.discount_mode==='percent'?'percent':'flat';
  const rawValue=Number(req.body.discount_value);
  const returnTarget=(period)=>localReturn(req.body.return_to,period?`/invoices?month=${period.period_month}&year=${period.period_year}`:'/invoices');
  if(!Number.isFinite(rawValue)||rawValue<0){
    req.session.flash={type:'danger',message:'Nilai diskon tidak valid.'};
    return res.redirect(returnTarget(null));
  }
  if(mode==='percent'&&rawValue>100){
    req.session.flash={type:'danger',message:'Persentase diskon tidak boleh lebih dari 100%.'};
    return res.redirect(returnTarget(null));
  }
  const conn=await db.getConnection();
  let invoice=null,result=null;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT id,invoice_number,period_month,period_year,status FROM invoices WHERE id=? LIMIT 1`,[req.params.id]);
    if(!rows.length){await conn.rollback();req.session.flash={type:'danger',message:'Tagihan tidak ditemukan.'};return res.redirect('/invoices');}
    invoice=rows[0];
    result=await applyInvoiceDiscount(conn,invoice.id,mode,rawValue);
    if(!result){
      await conn.rollback();
      req.session.flash={type:'warning',message:`Tagihan ${invoice.invoice_number} sudah ${invoice.status==='paid'?'lunas':'tidak aktif'} sehingga diskonnya tidak bisa diubah lagi, agar riwayat tagihan tetap utuh. Gunakan “Jadikan Belum Lunas” terlebih dahulu jika benar-benar perlu.`};
      return res.redirect(returnTarget(invoice));
    }
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'update_discount',entityType:'invoice',entityId:invoice.id,description:`Diskon tagihan ${invoice.invoice_number} diperbarui menjadi ${mode==='percent'?`${rawValue}%`:`Rp${rawValue}`} (Rp${result.discount}). Total tagihan otomatis disesuaikan dari Rp${result.subtotal} menjadi Rp${result.total}.`,ip:req.ip});
  req.session.flash={type:'success',message:`Diskon tagihan ${invoice.invoice_number} berhasil disimpan. Total tagihan otomatis disesuaikan menjadi Rp${Number(result.total).toLocaleString('id-ID')}.`};
  res.redirect(returnTarget(invoice));
});


router.post('/:id/reset-unpaid',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  let invoice=null,reversedTotal=0,reversedCount=0;
  try{
    await conn.beginTransaction();
    const [invoiceRows]=await conn.execute(`SELECT id,invoice_number,period_year,period_month,total,paid_amount,outstanding,status,due_date FROM invoices WHERE id=? FOR UPDATE`,[req.params.id]);
    invoice=invoiceRows[0];
    if(!invoice)throw new Error('Tagihan tidak ditemukan.');
    const [payments]=await conn.execute(`SELECT id,amount,status,method,reference,notes FROM payments WHERE invoice_id=? AND status IN ('confirmed','pending') FOR UPDATE`,[invoice.id]);
    const ids=payments.map(x=>Number(x.id));
    reversedTotal=payments.filter(x=>x.status==='confirmed').reduce((a,x)=>a+Number(x.amount||0),0);
    reversedCount=payments.length;
    if(ids.length){
      const marks=ids.map(()=>'?').join(',');
      // Semua jurnal otomatis yang bersumber dari payment harus ikut dibalik. Ini termasuk
      // pendapatan billing biasa serta jurnal pemasangan baru/komisi yang memakai payment id sama.
      await conn.execute(`DELETE FROM cash_transactions WHERE source_id IN (${marks}) AND source_type IN ('payment','install_income','install_commission_technician','install_commission_sales')`,ids);
      const correction=`[KOREKSI ADMIN ${new Date().toISOString().slice(0,19).replace('T',' ')}] Pembayaran dibatalkan agar tagihan kembali belum lunas.`;
      await conn.execute(`UPDATE payments SET status='failed',settlement_status='not_applicable',notes=CONCAT_WS('\\n',NULLIF(notes,''),?) WHERE id IN (${marks})`,[correction,...ids]);
    }
    await conn.execute(`UPDATE invoices SET paid_amount=0,outstanding=total,status=CASE WHEN due_date<CURDATE() THEN 'overdue' ELSE 'unpaid' END WHERE id=?`,[invoice.id]);
    await conn.commit();
    await audit({userId:req.session.user.id,action:'financial_correction',entityType:'invoice',entityId:invoice.id,description:`Koreksi tagihan ${invoice.invoice_number} menjadi belum lunas. ${reversedCount} transaksi pembayaran dibatalkan, pendapatan terkonfirmasi dikurangi Rp${reversedTotal}. Nominal tagihan tetap Rp${Number(invoice.total||0)}.`,ip:req.ip});
    req.session.flash={type:'success',message:`Tagihan ${invoice.invoice_number} dikoreksi menjadi belum lunas. ${reversedCount} transaksi pembayaran terkait dibatalkan dan pendapatan otomatis dikurangi Rp${reversedTotal.toLocaleString('id-ID')}.`};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  res.redirect(localReturn(req.body.return_to,invoice?`/invoices?month=${invoice.period_month}&year=${invoice.period_year}`:'/invoices'));
});

// v1.20.1: cancel/delete now lock the invoice row (SELECT ... FOR UPDATE inside a real transaction,
// mirroring /reset-unpaid above and the confirm/reject flow in routes/payments.js which locks the same
// invoice row). Previously these did a plain SELECT then a separate UPDATE/DELETE with no lock, so a
// payment confirmed concurrently between the two statements could slip through — leaving a confirmed
// payment attached to an invoice that gets cancelled/deleted moments later.
router.post('/:id/cancel',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  let invoice=null;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT id,invoice_number,period_year,period_month,status,paid_amount,outstanding FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`,[req.params.id]);
    if(!rows.length){await conn.rollback();req.session.flash={type:'danger',message:'Tagihan tidak ditemukan.'};return res.redirect('/invoices');}
    invoice=rows[0];
    const [[active]]=await conn.execute(`SELECT COUNT(*) total FROM payments WHERE invoice_id=? AND status IN ('confirmed','pending') FOR UPDATE`,[invoice.id]);
    if(Number(active.total)>0 || Number(invoice.paid_amount)>0){
      await conn.rollback();
      req.session.flash={type:'warning',message:'Tagihan masih memiliki pembayaran aktif. Gunakan “Jadikan Belum Lunas” terlebih dahulu agar pembayaran dan pendapatan dikoreksi secara aman.'};
      return res.redirect(localReturn(req.body.return_to,`/invoices?month=${invoice.period_month}&year=${invoice.period_year}`));
    }
    await conn.execute(`UPDATE invoices SET status='cancelled',paid_amount=0,outstanding=0 WHERE id=?`,[invoice.id]);
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'cancel',entityType:'invoice',entityId:invoice.id,description:`Tagihan ${invoice.invoice_number} dibatalkan. Histori pembayaran lama dipertahankan untuk audit; tagihan tidak lagi dihitung sebagai outstanding.`,ip:req.ip});
  req.session.flash={type:'success',message:`Tagihan ${invoice.invoice_number} dibatalkan. Histori transaksi tetap disimpan untuk audit.`};
  res.redirect(localReturn(req.body.return_to,`/invoices?month=${invoice.period_month}&year=${invoice.period_year}`));
});

router.post('/:id/delete',requireAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  let invoice=null;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT id,period_year,period_month,paid_amount FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`,[req.params.id]);
    if(!rows.length){await conn.rollback();req.session.flash={type:'danger',message:'Tagihan tidak ditemukan.'};return res.redirect('/invoices');}
    invoice=rows[0];
    const [[pay]]=await conn.execute(`SELECT COUNT(*) total FROM payments WHERE invoice_id=? FOR UPDATE`,[invoice.id]);
    if(Number(invoice.paid_amount)>0 || Number(pay.total)>0){
      await conn.rollback();
      req.session.flash={type:'danger',message:'Tagihan yang sudah memiliki pembayaran tidak boleh dihapus.'};
      return res.redirect(`/invoices?month=${invoice.period_month}&year=${invoice.period_year}`);
    }
    await conn.execute(`DELETE FROM invoices WHERE id=?`,[invoice.id]);
    await conn.commit();
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  await audit({userId:req.session.user.id,action:'delete',entityType:'invoice',entityId:invoice.id,description:`Tagihan tanpa histori pembayaran dihapus permanen. Periode ${invoice.period_month}/${invoice.period_year}.`,ip:req.ip});
  req.session.flash={type:'success',message:'Tagihan yang belum pernah memiliki pembayaran berhasil dihapus permanen.'};
  res.redirect(localReturn(req.body.return_to,`/invoices?month=${invoice.period_month}&year=${invoice.period_year}`));
});

// v1.21.1 — "Hapus Paksa" (Force Delete), Master Admin only. Bypasses the normal guard (blocked while any
// payment exists) by deleting the invoice's payments first, then the invoice, inside one transaction — the
// exact "delete the dependent financial documents too" behavior requested. Confirmation is enforced
// client-side (retype the invoice number, see views/partials/layout.ejs #forceDeleteModal) and the route
// itself re-checks nothing except that the invoice exists, since the whole point is to bypass the guard.
router.post('/:id/force-delete',requireMasterAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  let invoice=null;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT id,invoice_number,period_year,period_month FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`,[req.params.id]);
    if(!rows.length){await conn.rollback();req.session.flash={type:'danger',message:'Tagihan tidak ditemukan.'};return res.redirect('/invoices');}
    invoice=rows[0];
    const [linkedPayments]=await conn.execute(`SELECT id FROM payments WHERE invoice_id=? FOR UPDATE`,[invoice.id]);
    const payCount={n:linkedPayments.length};
    if(linkedPayments.length){
      const marks=linkedPayments.map(()=>'?').join(',');
      await conn.execute(`DELETE FROM cash_transactions WHERE source_id IN (${marks}) AND source_type IN ('payment','install_income','install_commission_technician','install_commission_sales')`,linkedPayments.map(p=>p.id));
    }
    await conn.execute(`DELETE FROM payments WHERE invoice_id=?`,[invoice.id]);
    await conn.execute(`DELETE FROM invoices WHERE id=?`,[invoice.id]);
    await conn.commit();
    await audit({userId:req.session.user.id,action:'force_delete',entityType:'invoice',entityId:invoice.id,description:`HAPUS PAKSA tagihan ${invoice.invoice_number} beserta ${payCount.n} riwayat pembayarannya (Master Admin override).`,ip:req.ip});
    req.session.flash={type:'success',message:`Tagihan ${invoice.invoice_number} dan ${payCount.n} riwayat pembayarannya dihapus permanen (Hapus Paksa).`};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  res.redirect(localReturn(req.body.return_to,`/invoices?month=${invoice.period_month}&year=${invoice.period_year}`));
});

// v1.21.0 — Section 4 (global delete-button audit): Tagihan already had fully transaction-safe individual
// cancel/delete (see above). This adds the bulk counterpart the checkbox column (data-invoice-table-check)
// was still missing — reusing the EXACT same per-row guard/locking pattern in a loop (one `SELECT ... FOR
// UPDATE` transaction per invoice) rather than a single bulk UPDATE/DELETE, so a batch never bypasses the
// same financial-safety checks (active payments / paid_amount) that protect the single-row routes.
router.post('/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.invoice_ids||[]).map(x=>Number(x)).filter(Boolean))];
  const returnTo=localReturn(req.body.return_to,'/invoices');
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu tagihan terlebih dahulu.'};return res.redirect(returnTo);}
  if(ids.length>500){req.session.flash={type:'danger',message:'Maksimal 500 tagihan per aksi massal.'};return res.redirect(returnTo);}
  if(action==='cancel'){
    const done=[];const skipped=[];
    for(const id of ids){
      const conn=await db.getConnection();
      try{
        await conn.beginTransaction();
        const [rows]=await conn.execute(`SELECT id,invoice_number,status,paid_amount,outstanding FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`,[id]);
        if(!rows.length){await conn.rollback();continue;}
        const invoice=rows[0];
        const [[active]]=await conn.execute(`SELECT COUNT(*) total FROM payments WHERE invoice_id=? AND status IN ('confirmed','pending') FOR UPDATE`,[invoice.id]);
        if(Number(active.total)>0 || Number(invoice.paid_amount)>0 || invoice.status==='cancelled'){await conn.rollback();skipped.push(invoice);continue;}
        await conn.execute(`UPDATE invoices SET status='cancelled',paid_amount=0,outstanding=0 WHERE id=?`,[invoice.id]);
        await conn.commit();
        done.push(invoice);
      }catch(e){await conn.rollback();skipped.push({invoice_number:`#${id}`});}finally{conn.release();}
    }
    if(!done.length){req.session.flash={type:'danger',message:'Semua tagihan terpilih masih memiliki pembayaran aktif dan tidak dapat dibatalkan. Gunakan "Jadikan Belum Lunas" terlebih dahulu.'};return res.redirect(returnTo);}
    await audit({userId:req.session.user.id,action:'bulk_cancel',entityType:'invoice',entityId:null,description:`Batalkan massal ${done.length} tagihan: ${done.map(r=>r.invoice_number).slice(0,20).join(', ')}${done.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena masih memiliki pembayaran aktif)`:''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${done.length} tagihan dibatalkan. Histori transaksi tetap disimpan untuk audit.${skipped.length?` ${skipped.length} tagihan dilewati karena masih memiliki pembayaran aktif.`:''}`};
    return res.redirect(returnTo);
  }
  if(action==='delete'){
    const done=[];const skipped=[];
    for(const id of ids){
      const conn=await db.getConnection();
      try{
        await conn.beginTransaction();
        const [rows]=await conn.execute(`SELECT id,invoice_number,paid_amount FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`,[id]);
        if(!rows.length){await conn.rollback();continue;}
        const invoice=rows[0];
        const [[pay]]=await conn.execute(`SELECT COUNT(*) total FROM payments WHERE invoice_id=? FOR UPDATE`,[invoice.id]);
        if(Number(invoice.paid_amount)>0 || Number(pay.total)>0){await conn.rollback();skipped.push(invoice);continue;}
        await conn.execute(`DELETE FROM invoices WHERE id=?`,[invoice.id]);
        await conn.commit();
        done.push(invoice);
      }catch(e){await conn.rollback();skipped.push({invoice_number:`#${id}`});}finally{conn.release();}
    }
    if(!done.length){req.session.flash={type:'danger',message:'Semua tagihan terpilih sudah memiliki pembayaran dan tidak boleh dihapus permanen.'};return res.redirect(returnTo);}
    await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'invoice',entityId:null,description:`Hapus massal ${done.length} tagihan tanpa histori pembayaran: ${done.map(r=>r.invoice_number).slice(0,20).join(', ')}${done.length>20?', ...':''}${skipped.length?` (${skipped.length} dilewati karena sudah memiliki pembayaran)`:''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${done.length} tagihan dihapus permanen.${skipped.length?` ${skipped.length} tagihan dilewati karena sudah memiliki pembayaran.`:''}`};
    return res.redirect(returnTo);
  }
  // v1.21.1 — "Hapus Paksa" massal, Master Admin only (checked here explicitly since this whole route
  // is otherwise gated at `requireAdmin`, one level below Master Admin). Deletes payments + invoice for
  // every selected row unconditionally, same cascade as the single-row /force-delete above.
  if(action==='force_delete'){
    if(!isMasterAdminRole(req.session.user.role)){
      req.session.flash={type:'danger',message:'Hapus Paksa hanya dapat dilakukan oleh Master Admin.'};
      return res.redirect(returnTo);
    }
    const done=[];
    for(const id of ids){
      const conn=await db.getConnection();
      try{
        await conn.beginTransaction();
        const [rows]=await conn.execute(`SELECT id,invoice_number FROM invoices WHERE id=? LIMIT 1 FOR UPDATE`,[id]);
        if(!rows.length){await conn.rollback();continue;}
        const invoice=rows[0];
        const [linkedPayments]=await conn.execute(`SELECT id FROM payments WHERE invoice_id=? FOR UPDATE`,[invoice.id]);
        if(linkedPayments.length){
          const marks=linkedPayments.map(()=>'?').join(',');
          await conn.execute(`DELETE FROM cash_transactions WHERE source_id IN (${marks}) AND source_type IN ('payment','install_income','install_commission_technician','install_commission_sales')`,linkedPayments.map(p=>p.id));
        }
        await conn.execute(`DELETE FROM payments WHERE invoice_id=?`,[invoice.id]);
        await conn.execute(`DELETE FROM invoices WHERE id=?`,[invoice.id]);
        await conn.commit();
        done.push(invoice);
      }catch(e){await conn.rollback();}finally{conn.release();}
    }
    if(!done.length){req.session.flash={type:'warning',message:'Tagihan terpilih tidak ditemukan.'};return res.redirect(returnTo);}
    await audit({userId:req.session.user.id,action:'bulk_force_delete',entityType:'invoice',entityId:null,description:`HAPUS PAKSA massal ${done.length} tagihan beserta seluruh riwayat pembayarannya (Master Admin override): ${done.map(r=>r.invoice_number).slice(0,20).join(', ')}${done.length>20?', ...':''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${done.length} tagihan dihapus paksa beserta seluruh riwayat pembayarannya.`};
    return res.redirect(returnTo);
  }
  req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};
  res.redirect(returnTo);
});

module.exports=router;
