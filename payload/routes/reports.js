const express=require('express');
const db=require('../config/db');
const { createReportPdf, rupiah, date, documentLabel, COLORS }=require('../services/reportPdf');
const { numbered, groupReportRows, integrityWarnings }=require('../services/reportDataService');
const router=express.Router();
const MONTHS=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function n(v,f){const x=Number(v);return Number.isFinite(x)?x:f;}
function iso(v,f){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):f;}
function common(req){
  const now=new Date();
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const month=Math.max(1,Math.min(12,n(req.query.month,Number(today.slice(5,7)))));
  const year=Math.max(2020,Math.min(2100,n(req.query.year,Number(today.slice(0,4)))));
  return {
    view:['customers','billing','cash','invoice'].includes(req.query.view)?req.query.view:'customers',
    month,year,site:req.query.site||'',cluster:req.query.cluster||'',status:req.query.status||'',package:req.query.package||'',customer:req.query.customer||'',
    category:req.query.category||'',flow_type:req.query.flow_type||'',method:req.query.method||'',q:String(req.query.q||'').trim(),
    from:iso(req.query.from,today.slice(0,7)+'-01'),
    to:iso(req.query.to,today),
    // v1.25.2 — filter tanggal jatuh tempo untuk Laporan Tagihan/Faktur. Opsional (kosong = tidak
    // membatasi), independen dari filter Bulan/Tahun periode penerbitan tagihan di atas.
    dueFrom:iso(req.query.due_from||req.query.dueFrom,''),dueTo:iso(req.query.due_to||req.query.dueTo,'')
  };
}

async function baseOptions(){
  const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const [packages]=await db.query(`SELECT p.id,p.name,p.site_id,s.code site_code FROM packages p LEFT JOIN sites s ON s.id=p.site_id WHERE p.is_active=1 ORDER BY COALESCE(s.code,'ZZZ'),p.price,p.name`);
  const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);
  const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.customer_status!='terminated' AND c.archived_at IS NULL ORDER BY s.code,cl.name,c.name`);
  const [categories]=await db.query(`SELECT id,name,type FROM cash_categories ORDER BY type,name`);
  return{sites,clusters,packages,customers,categories};
}

async function customerReport(f){
  const where=['c.archived_at IS NULL'],p=[];
  if(f.site){where.push('s.code=?');p.push(f.site);}
  if(f.cluster){where.push('c.cluster_id=?');p.push(Number(f.cluster));}
  if(f.package){where.push('p.id=?');p.push(f.package);}
  if(f.status){where.push('c.customer_status=?');p.push(f.status);}
  if(f.q){const like=`%${f.q}%`;where.push('(c.name LIKE ? OR c.customer_code LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)');p.push(like,like,like,like);}
  const [rows]=await db.execute(`SELECT c.customer_code,c.name,c.phone,c.email,c.address,s.code site_code,cl.name cluster_name,p.name package_name,p.price,c.customer_status,c.billing_status,c.activation_date FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id JOIN packages p ON p.id=c.package_id WHERE ${where.join(' AND ')} ORDER BY s.code,cl.name,c.name,c.id`,p);
  return rows;
}

async function billingReport(f){
  const where=[`c.customer_status='active'`,'c.archived_at IS NULL','i.archived_at IS NULL','i.period_month=?','i.period_year=?'],p=[f.month,f.year];
  if(f.site){where.push('s.code=?');p.push(f.site);}
  if(f.cluster){where.push('c.cluster_id=?');p.push(Number(f.cluster));}
  if(f.package){where.push('pk.id=?');p.push(f.package);}
  if(f.status){where.push('i.status=?');p.push(f.status);}else{where.push("i.status NOT IN ('cancelled','refunded')");}
  if(f.customer){where.push('c.id=?');p.push(f.customer);}
  if(f.q){const like=`%${f.q}%`;where.push('(c.name LIKE ? OR c.customer_code LIKE ? OR i.invoice_number LIKE ? OR s.code LIKE ? OR cl.name LIKE ?)');p.push(like,like,like,like,like);}
  if(f.dueFrom){where.push('i.due_date>=?');p.push(f.dueFrom);}
  if(f.dueTo){where.push('i.due_date<=?');p.push(f.dueTo);}
  const [rows]=await db.execute(`SELECT i.id,i.invoice_number,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,pk.name package_name,i.due_date,i.total,i.paid_amount,i.outstanding,i.status,COALESCE((SELECT SUM(payment.amount) FROM payments payment WHERE payment.invoice_id=i.id AND payment.status='confirmed'),0) confirmed_payment_amount FROM invoices i JOIN customers c ON c.id=i.customer_id JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id JOIN packages pk ON pk.id=c.package_id WHERE ${where.join(' AND ')} ORDER BY s.code,cl.name,c.name,i.due_date,i.id`,p);
  return rows;
}

async function cashReport(f){
  const where=["ct.transaction_date BETWEEN ? AND ?","COALESCE(ct.approval_status,'APPROVED')='APPROVED'"],p=[f.from,f.to];
  where.push("(COALESCE(ct.source_type,'manual')<>'payment' OR (p.status='confirmed' AND (p.method<>'cash' OR p.settlement_status='settled')))");
  if(f.site){where.push('s.code=?');p.push(f.site);}
  if(f.cluster){where.push('c.cluster_id=?');p.push(Number(f.cluster));}
  if(f.customer){where.push('c.id=?');p.push(f.customer);}
  if(f.q){const like=`%${f.q}%`;where.push('(ct.name LIKE ? OR ct.notes LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ?)');p.push(like,like,like,like);}
  if(f.category){where.push('cc.id=?');p.push(f.category);}
  if(f.flow_type){where.push('cc.type=?');p.push(f.flow_type);}
  if(f.method){where.push('p.method=?');p.push(f.method);}
  const [rows]=await db.execute(`SELECT ct.id,ct.transaction_date,CASE WHEN c.id IS NOT NULL THEN CONCAT(c.name,' [',c.customer_code,']') ELSE ct.name END name,cc.name category,cc.type,s.code site_code,cl.name cluster_name,ct.amount,ct.notes,ct.source_type,p.method,i.invoice_number,c.customer_code FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id LEFT JOIN payments p ON ct.source_type='payment' AND p.id=ct.source_id LEFT JOIN invoices i ON i.id=p.invoice_id LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE ${where.join(' AND ')} ORDER BY s.code,cl.name,cc.type,cc.name,ct.transaction_date,ct.id`,p);
  return rows;
}

router.get('/',async(req,res)=>{
  const filters=common(req),opts=await baseOptions();
  const customerRows=await customerReport(filters),billingRows=await billingReport(filters),cashRows=await cashReport(filters);
  const invoiceRows=billingRows;
  const summary={
    customers:customerRows.length,
    active:customerRows.filter(x=>x.customer_status==='active').length,
    billed:billingRows.reduce((a,x)=>a+Number(x.total||0),0),
    paid:billingRows.reduce((a,x)=>a+Number(x.paid_amount||0),0),
    outstanding:billingRows.reduce((a,x)=>a+Number(x.outstanding||0),0),
    income:cashRows.filter(x=>x.type==='income').reduce((a,x)=>a+Number(x.amount||0),0),
    expense:cashRows.filter(x=>x.type==='expense').reduce((a,x)=>a+Number(x.amount||0),0)
  };
  summary.balance=summary.income-summary.expense;
  const selectedRows=filters.view==='customers'?customerRows:filters.view==='cash'?cashRows:billingRows;
  const reportGroups=groupReportRows(filters.view,selectedRows),reportWarnings=integrityWarnings(filters.view,selectedRows),reportRowCount=selectedRows.length;
  res.render('reports/index',{title:'Laporan',filters,...opts,customerRows,billingRows,cashRows,invoiceRows,summary,reportGroups,reportWarnings,reportRowCount,monthNames:MONTHS});
});

// v1.25.2 — dipakai bersama oleh /pdf dan /txt (item "2 pilihan download txt atau pdf") supaya query,
// kolom, dan angka ringkasan pada kedua format SELALU identik (satu sumber kebenaran, tidak ada risiko
// PDF dan TXT menampilkan angka yang berbeda untuk filter yang sama).
async function buildReportPayload(req){
  const f=common(req);
  const type=['customers','billing','cash','invoice'].includes(req.query.type)?req.query.type:f.view;
  let rows=[],columns=[],summaryItems=[],title='',subtitle='',baseFilename='laporan-INKAMNET';
  let clusterLabel='';
  if(f.cluster){const [clusterRows]=await db.execute(`SELECT cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.id=? LIMIT 1`,[Number(f.cluster)]);if(clusterRows[0])clusterLabel=`${clusterRows[0].site_code} / ${clusterRows[0].name}`;}
  const dueRangeLabel=(f.dueFrom||f.dueTo)?` | Jatuh Tempo ${f.dueFrom?date(f.dueFrom):'awal'} s/d ${f.dueTo?date(f.dueTo):'akhir'}`:'';

  if(type==='customers'){
    rows=await customerReport(f);
    title='LAPORAN PELANGGAN';
    subtitle=`Scope: ${f.site||'Semua Site'}${clusterLabel?` | Cluster ${clusterLabel}`:''} | ${rows.length} pelanggan${f.status?` | Status ${documentLabel(f.status,'id')}`:''}`;
    baseFilename=`laporan-pelanggan-INKAMNET-${new Date().toISOString().slice(0,10)}`;
    summaryItems=[
      {label:'TOTAL PELANGGAN',value:rows.length,color:COLORS.purple},
      {label:'AKTIF',value:rows.filter(x=>x.customer_status==='active').length,color:COLORS.green},
      {label:'DITANGGUHKAN',value:rows.filter(x=>x.customer_status==='suspended').length,color:COLORS.red}
    ];
    columns=[
      {label:'Customer ID',width:1.15,key:'customer_code',bold:true},
      {label:'Nama Pelanggan',width:1.8,key:'name'},
      {label:'Site / Cluster',width:1.15,value:r=>`${r.site_code} / ${r.cluster_name||'-'}`},
      {label:'Paket',width:1.25,key:'package_name'},
      {label:'WhatsApp',width:1.1,key:'phone'},
      {label:'Status',width:.85,value:r=>documentLabel(r.customer_status,'id').toUpperCase()}
    ];
  } else if(type==='cash'){
    rows=await cashReport(f);
    const income=rows.filter(x=>x.type==='income').reduce((a,x)=>a+Number(x.amount||0),0);
    const expense=rows.filter(x=>x.type==='expense').reduce((a,x)=>a+Number(x.amount||0),0);
    title='LAPORAN ARUS KAS';
    subtitle=`Periode ${date(f.from)} s/d ${date(f.to)} | ${f.site||'Semua Site'}`;
    baseFilename=`laporan-arus-kas-INKAMNET-${f.from}-sd-${f.to}`;
    summaryItems=[
      {label:'PENDAPATAN',value:rupiah(income),color:COLORS.green},
      {label:'PENGELUARAN',value:rupiah(expense),color:COLORS.red},
      {label:'SALDO',value:rupiah(income-expense),color:income-expense>=0?COLORS.purple:COLORS.red},
      {label:'TRANSAKSI',value:rows.length,color:COLORS.blue}
    ];
    columns=[
      {label:'Tanggal',width:1,value:r=>date(r.transaction_date)},
      {label:'Nama / Referensi',width:2.2,value:r=>[r.name,`Kas #${r.id} · ${r.invoice_number||'Input manual'} · ${r.method||'manual'}`,r.notes].filter(Boolean).join(' · ')},
      {label:'Kategori',width:1.3,key:'category'},
      {label:'Site / Cluster',width:1.1,value:r=>[r.site_code||'GLOBAL',r.cluster_name].filter(Boolean).join(' / ')},
      {label:'Jenis',width:.8,value:r=>r.type==='income'?'MASUK':'KELUAR'},
      {label:'Nominal',width:1.2,value:r=>rupiah(r.amount),bold:true,align:'right'}
    ];
  } else {
    rows=await billingReport(f);
    const billed=rows.reduce((a,x)=>a+Number(x.total||0),0);
    const paid=rows.reduce((a,x)=>a+Number(x.paid_amount||0),0);
    const out=rows.reduce((a,x)=>a+Number(x.outstanding||0),0);
    title=type==='invoice'?'REGISTER FAKTUR':'LAPORAN TAGIHAN';
    subtitle=`Periode ${MONTHS[f.month-1]} ${f.year} | ${f.site||'Semua Site'}${clusterLabel?` | Cluster ${clusterLabel}`:''}${f.status?` | Status ${documentLabel(f.status,'id')}`:''}${dueRangeLabel}`;
    baseFilename=`${type==='invoice'?'register-faktur':'laporan-tagihan'}-INKAMNET-${f.year}-${String(f.month).padStart(2,'0')}`;
    summaryItems=[
      {label:'TOTAL TAGIHAN',value:rupiah(billed),color:COLORS.purple},
      {label:'TERBAYAR',value:rupiah(paid),color:COLORS.green},
      {label:'OUTSTANDING',value:rupiah(out),color:COLORS.red},
      {label:'JUMLAH FAKTUR',value:rows.length,color:COLORS.blue}
    ];
    columns=[
      {label:'Faktur',width:1.35,key:'invoice_number',bold:true},
      {label:'Pelanggan',width:1.65,value:r=>`${r.customer_name} (${r.customer_code})`},
      {label:'Site / Cluster',width:1,value:r=>`${r.site_code} / ${r.cluster_name||'-'}`},
      {label:'Jatuh Tempo',width:1,value:r=>date(r.due_date)},
      {label:'Tagihan',width:1.05,value:r=>rupiah(r.total),align:'right',total:true,totalBy:r=>Number(r.total||0)},
      {label:'Terbayar',width:1.05,value:r=>rupiah(r.paid_amount),align:'right',total:true,totalBy:r=>Number(r.paid_amount||0)},
      {label:'Sisa',width:1.05,value:r=>rupiah(r.outstanding),bold:true,align:'right',total:true,totalBy:r=>Number(r.outstanding||0)},
      {label:'Status',width:.85,value:r=>documentLabel(r.status,'id').toUpperCase()}
    ];
  }

  rows=numbered(rows);
  columns.unshift({label:'No.',key:'row_no',width:.42,align:'center'});
  const reportGroups=groupReportRows(type,rows),warnings=integrityWarnings(type,rows);
  return {type,rows,columns,summaryItems,title,subtitle,baseFilename,reportGroups,warnings};
}

router.get('/pdf',async(req,res)=>{
  const {rows,columns,summaryItems,title,subtitle,baseFilename,reportGroups,warnings}=await buildReportPayload(req);
  createReportPdf(res,{title,subtitle,filename:`${baseFilename}.pdf`,summaryItems,columns,rows,reportGroups,warnings,layout:'landscape'});
});

// v1.25.2 — item "buat 2 pilihan download txt atau pdf": versi teks polos dari laporan yang sama,
// memakai baris/kolom/ringkasan persis dari buildReportPayload() supaya konsisten dengan PDF-nya.
// Kolom dirender sebagai tabel rata-kolom (fixed width) khas file .txt, bukan CSV.
router.get('/txt',async(req,res)=>{
  const {rows,columns,summaryItems,title,subtitle,baseFilename,reportGroups,warnings}=await buildReportPayload(req);
  const pad=(str,width,align)=>{
    const s=String(str??'-');
    if(s.length>=width) return s.slice(0,Math.max(0,width-1))+(width>1?'…':'');
    const gap=' '.repeat(width-s.length);
    return align==='right'?gap+s:s+gap;
  };
  const colWidths=columns.map((c,i)=>{
    const headerLen=String(c.label||'').length;
    const maxDataLen=rows.reduce((m,r)=>Math.max(m,String((typeof c.value==='function'?c.value(r):r[c.key])??'-').length),0);
    return Math.min(42,Math.max(headerLen,maxDataLen,6))+2;
  });
  const lineWidth=colWidths.reduce((a,b)=>a+b,0);
  const sep='='.repeat(Math.min(100,lineWidth));
  const thin='-'.repeat(Math.min(100,lineWidth));
  const lines=[];
  lines.push('INKAMNET CONTROL CENTER');
  lines.push(safeTxt(title));
  if(subtitle) lines.push(safeTxt(subtitle));
  lines.push(`Dibuat: ${new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Jakarta'}).format(new Date())} WIB`);
  lines.push(sep);
  if(summaryItems.length){
    lines.push('RINGKASAN');
    summaryItems.forEach(it=>lines.push(`  ${it.label}: ${it.value}`));
    lines.push(sep);
  }
  if(warnings.length)lines.push(...warnings.map(w=>'PERLU REKONSILIASI: '+w));
  if(reportGroups.length){lines.push('RINCIAN PER SITE / KATEGORI');reportGroups.forEach((g,i)=>lines.push(`${i+1}. ${g.site} | ${g.flow||''} ${g.category} | ${g.count} baris | Masuk ${rupiah(g.income)} | Keluar ${rupiah(g.expense)} | Tagihan ${rupiah(g.billed)} | Terbayar ${rupiah(g.paid)} | Sisa ${rupiah(g.outstanding)}`));lines.push(sep);}
  lines.push(columns.map((c,i)=>pad(c.label,colWidths[i],c.align)).join(''));
  lines.push(thin);
  if(!rows.length){
    lines.push('Tidak ada data untuk filter yang dipilih.');
  } else {
    rows.forEach(r=>{
      lines.push(columns.map((c,i)=>pad(typeof c.value==='function'?c.value(r):r[c.key],colWidths[i],c.align)).join(''));
    });
    if(columns.some(c=>c.total)){
      lines.push(thin);
      lines.push(columns.map((c,i)=>{
        if(!c.total) return pad(i===0?'TOTAL':'',colWidths[i],c.align);
        const sum=rows.reduce((a,r)=>a+c.totalBy(r),0);
        return pad(rupiah(sum),colWidths[i],'right');
      }).join(''));
    }
  }
  lines.push(sep);
  lines.push('RINCIAN LENGKAP (TANPA PEMOTONGAN TEKS)');
  rows.forEach(r=>{lines.push(`No. ${r.row_no}`);columns.filter(c=>c.key!=='row_no').forEach(c=>lines.push(`  ${c.label}: ${typeof c.value==='function'?c.value(r):r[c.key]??'-'}`));});
  lines.push(sep);
  lines.push(`${rows.length} baris data · Dokumen digital dari INKAMNET Control Center.`);
  const body=lines.map(safeTxt).join('\r\n')+'\r\n';
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${baseFilename}.txt"`);
  res.send(body);
});

function safeTxt(v){return String(v??'').replace(/[\r\n]+/g,' ');}

module.exports=router;
