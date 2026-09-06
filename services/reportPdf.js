const PDFDocument=require('pdfkit');
const path=require('path');
const fs=require('fs');

const COLORS={ink:'#0B1020',ink2:'#121A2C',muted:'#667085',muted2:'#98A2B3',purple:'#603AEA',purpleSoft:'#F1EDFF',red:'#FF433E',redSoft:'#FFF0EF',green:'#18A979',greenSoft:'#EAFBF5',blue:'#3478F6',line:'#E4E7EC',soft:'#F8F9FC',white:'#FFFFFF',black:'#101828'};
const COMPANY='PT INKAMNET NEXERA TECHNOLOGY';
const TAGLINE='From the Village, Online Everywhere';
function rupiah(v){return 'Rp '+new Intl.NumberFormat('id-ID',{maximumFractionDigits:0}).format(Number(v||0));}
function date(v){if(!v)return'-';try{return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Jakarta'}).format(new Date(v));}catch{return String(v);}}
function safe(v){return String(v??'-').replace(/[\u2013\u2014]/g,'-').replace(/\u2022/g,'-').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');}
function documentLabel(value,language='id'){const key=String(value||'').toLowerCase();const labels={id:{paid:'Lunas',unpaid:'Belum Lunas',partial:'Bayar Sebagian',overdue:'Terlambat',pending:'Menunggu',confirmed:'Dikonfirmasi',cancelled:'Dibatalkan',refunded:'Dikembalikan',cash:'Tunai',transfer:'Transfer',qris:'QRIS',gateway:'Gateway'},en:{paid:'Paid',unpaid:'Unpaid',partial:'Partially Paid',overdue:'Overdue',pending:'Pending',confirmed:'Confirmed',cancelled:'Cancelled',refunded:'Refunded',cash:'Cash',transfer:'Transfer',qris:'QRIS',gateway:'Gateway'}};return labels[language==='en'?'en':'id'][key]||safe(value);}
function nowText(){return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Jakarta'}).format(new Date())+' WIB';}
function logoPath(){return path.join(__dirname,'../public/img/inkamnet-wordmark-hq.png');}
function drawLogo(doc,x,y,w=145,h=42){const logo=logoPath();if(fs.existsSync(logo)){try{doc.image(logo,x,y,{fit:[w,h],align:'left',valign:'center'});return;}catch{}}doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18).text('INKAMNET',x,y+8);}

function drawBrandHeader(doc,title,subtitle,compact=false){
  const width=doc.page.width,margin=doc.page.margins.left,usable=width-margin-doc.page.margins.right,h=compact?74:112;
  doc.save();
  // v1.25.2 redesign — gradasi halus alih-alih warna solid datar, plus pita aksen ganda di bawah header
  // dan lingkaran glow yang lebih lembut, supaya kop laporan terasa lebih premium/modern.
  const grad=doc.linearGradient(0,0,width,h);grad.stop(0,'#0B1020').stop(.62,'#121A2C').stop(1,'#1B1440');
  doc.rect(0,0,width,h).fill(grad);
  doc.circle(width-34,14,110).fillOpacity(.07).fill(COLORS.purple).fillOpacity(1);
  doc.circle(width*.36,h+6,70).fillOpacity(.05).fill(COLORS.red).fillOpacity(1);
  doc.rect(0,h-3,width*.66,3).fill(COLORS.purple);doc.rect(width*.66,h-3,width*.20,3).fill(COLORS.red);doc.rect(width*.86,h-3,width*.14,3).fill('#3478F6');
  drawLogo(doc,margin,compact?17:27,145,42);
  const titleX=Math.max(margin+165,width*.41),titleW=width-margin-titleX;
  doc.save();doc.roundedRect(titleX,compact?9:15,titleW,14,7).fillOpacity(.12).fill(COLORS.purple).fillOpacity(1);doc.restore();
  doc.fillColor('#C6B8FF').font('Helvetica-Bold').fontSize(6.8).text(COMPANY,titleX,compact?12:18,{width:titleW,align:'right',characterSpacing:.6});
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(compact?14:19).text(safe(title),titleX,compact?30:41,{width:titleW,align:'right'});
  if(!compact&&subtitle)doc.fillColor('#C8CEDA').font('Helvetica').fontSize(7.8).text(safe(subtitle),titleX,68,{width:titleW,align:'right',lineGap:2});
  doc.restore();doc.y=h+17;
  if(!compact){doc.save();doc.roundedRect(margin,doc.y,usable,34,7).fillAndStroke(COLORS.soft,COLORS.line);doc.roundedRect(margin,doc.y,3,34,1.5).fill(COLORS.purple);doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.8).text('DOKUMEN RESMI · INKAMNET CONTROL CENTER',margin+15,doc.y+11,{width:usable*.5});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.8).text(`Dibuat: ${nowText()}`,margin+usable*.48,doc.y+11,{width:usable*.48,align:'right'});doc.restore();doc.y+=47;}
}
function drawSectionLabel(doc,label){const x=doc.page.margins.left;doc.save();doc.roundedRect(x,doc.y-2,3,11,1.5).fill(COLORS.purple);doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7).text(safe(label).toUpperCase(),x+9,doc.y,{characterSpacing:.8});doc.restore();doc.y+=13;}
function drawSummary(doc,items){if(!items.length)return;drawSectionLabel(doc,'Ringkasan Eksekutif');const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,cols=Math.min(4,Math.max(1,items.length)),gap=9,cw=(total-gap*(cols-1))/cols;let y=doc.y;items.forEach((it,i)=>{if(i>0&&i%cols===0)y+=64;const xx=x+(i%cols)*(cw+gap),accent=it.color||COLORS.purple;doc.save();
    doc.roundedRect(xx+1.2,y+2.2,cw,54,10).fillOpacity(.05).fill(COLORS.ink).fillOpacity(1);
    doc.roundedRect(xx,y,cw,54,10).fillAndStroke(COLORS.white,COLORS.line);
    doc.roundedRect(xx,y,cw,54,10).clip();doc.roundedRect(xx,y,5,54,0).fill(accent);doc.restore();doc.save();
    doc.circle(xx+cw-14,y+14,17).fillOpacity(.09).fill(accent).fillOpacity(1);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.5).text(safe(it.label),xx+15,y+11,{width:cw-24,height:9,characterSpacing:.3,ellipsis:true,lineBreak:false});
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(11.5).text(safe(it.value),xx+15,y+28,{width:cw-24,height:16,ellipsis:true,lineBreak:false});
    doc.restore();});const rowsCount=Math.ceil(items.length/cols);doc.y=y+54+18+(rowsCount>1?(rowsCount-1)*64:0);}
function valueFor(column,row){return typeof column.value==='function'?column.value(row):row[column.key];}function colorFor(column,row){return typeof column.color==='function'?column.color(row):(column.color||COLORS.black);}
function drawTable(doc,columns,rows,title,subtitle){drawSectionLabel(doc,'Detail Data');const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,rawWidths=columns.map(c=>Number(c.width||1)),sum=rawWidths.reduce((a,b)=>a+b,0)||1,widths=rawWidths.map(v=>v/sum*total),headerH=29,hasTotalRow=columns.some(c=>c.total),bottomLimit=doc.page.height-doc.page.margins.bottom-(hasTotalRow?67:31);
  function head(){const y=doc.y;doc.save();const grad=doc.linearGradient(x,y,x+total,y);grad.stop(0,COLORS.ink2).stop(1,'#1B1440');doc.roundedRect(x,y,total,headerH,7).fill(grad);doc.rect(x,y+headerH-2.4,total,2.4).fill(COLORS.purple);let xx=x;columns.forEach((c,i)=>{doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(6.7).text(safe(c.label).toUpperCase(),xx+6,y+9,{width:Math.max(10,widths[i]-12),align:c.align||'left',ellipsis:true});xx+=widths[i];});doc.restore();doc.y=y+headerH+2;}
  function nextPage(){doc.addPage();drawBrandHeader(doc,title,subtitle,true);head();}head();if(!rows.length){doc.save();doc.roundedRect(x,doc.y,total,48,7).fillAndStroke(COLORS.soft,COLORS.line);doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text('Tidak ada data untuk filter yang dipilih.',x+12,doc.y+18,{width:total-24,align:'center'});doc.restore();doc.y+=58;return;}
  rows.forEach((row,ri)=>{const vals=columns.map(c=>safe(valueFor(c,row)));const heights=vals.map((v,i)=>doc.font(columns[i].bold?'Helvetica-Bold':'Helvetica').fontSize(7.05).heightOfString(v,{width:Math.max(20,widths[i]-12),lineGap:1}));let rh=Math.max(30,...heights.map(h=>h+14));rh=Math.min(rh,86);if(doc.y+rh>bottomLimit)nextPage();const y=doc.y;doc.save();if(ri%2===1)doc.rect(x,y,total,rh).fill('#FBFCFE');doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();let xx=x;columns.forEach((c,i)=>{doc.fillColor(colorFor(c,row)).font(c.bold?'Helvetica-Bold':'Helvetica').fontSize(7.05).text(vals[i],xx+6,y+8,{width:Math.max(20,widths[i]-12),height:rh-12,align:c.align||'left',ellipsis:true,lineGap:1});xx+=widths[i];});doc.restore();doc.y=y+rh;});
  // v1.25.2 — baris TOTAL: menjumlahkan setiap kolom yang ditandai `total:true` (mis. Tagihan, Sisa,
  // Nominal) tepat di bawah baris terakhir, dengan latar ungu lembut supaya langsung terlihat.
  if(hasTotalRow){
    const rh=32;if(doc.y+rh>bottomLimit+36)nextPage();const y=doc.y;doc.save();doc.rect(x,y,total,rh).fill(COLORS.purpleSoft);doc.rect(x,y,total,1.4).fill(COLORS.purple);let xx=x;
    columns.forEach((c,i)=>{
      const label=c.total?rupiah(rows.reduce((a,r)=>a+Number(c.totalBy?c.totalBy(r):0),0)):(i===0?'TOTAL':'');
      doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7.6).text(label,xx+6,y+9,{width:Math.max(10,widths[i]-12),align:c.align||'left',ellipsis:true});
      xx+=widths[i];
    });
    doc.restore();doc.y=y+rh;
  }
}
// v1.25.2 — FIX: keempat panggilan .text() di bawah sebelumnya memakai `doc.y+N` yang dibaca ULANG
// setiap kali — padahal setiap .text() otomatis MENGUBAH doc.y setelah menggambar. Akibatnya posisi
// baris ke-2/3/4 melenceng jauh ke bawah (menumpuk dari efek baris sebelumnya), membuat "PT INKAMNET..."
// dan tagline tampil di LUAR kotak abu-abu alih-alih rapi di dalamnya, dan pada kasus tertentu bahkan
// memicu halaman kosong tambahan karena posisi hasil rembesan itu melewati batas bawah halaman. Diperbaiki
// dengan menyimpan posisi atas kotak (`boxY`) sekali di awal dan memakainya untuk keempat teks + `height`
// eksplisit supaya tidak lagi memicu auto page-break bawaan PDFKit.
function drawReportSignoff(doc){const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;if(doc.y+86>doc.page.height-doc.page.margins.bottom)doc.addPage();doc.y+=18;const boxY=doc.y;doc.save();doc.roundedRect(x,boxY,total,64,8).fillAndStroke(COLORS.soft,COLORS.line);doc.roundedRect(x,boxY,3,64,1.5).fill(COLORS.purple);doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(7.5).text('CATATAN DOKUMEN',x+15,boxY+11,{width:total*.64,height:10,ellipsis:true,lineBreak:false});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text('Laporan ini dihasilkan secara elektronik dari INKAMNET Control Center berdasarkan data yang tersimpan pada saat dokumen dibuat.',x+15,boxY+26,{width:total*.64,height:28,lineGap:2,ellipsis:true});doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7).text(COMPANY,x+total*.70,boxY+26,{width:total*.27,align:'right',height:10,ellipsis:true,lineBreak:false});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text(TAGLINE,x+total*.70,boxY+39,{width:total*.27,align:'right',height:10,ellipsis:true,lineBreak:false});doc.restore();doc.y=boxY+76;}
function drawWatermarkOnAllPages(doc,text){const label=safe(text||'').trim();if(!label)return;const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(range.start+i);const cx=doc.page.width/2,cy=doc.page.height/2;doc.save();doc.fillOpacity(.055);doc.fillColor(COLORS.purple);doc.font('Helvetica-Bold').fontSize(34);doc.rotate(-32,{origin:[cx,cy]});doc.text(label,0,cy-22,{width:doc.page.width,height:48,align:'center',lineBreak:false,ellipsis:true});doc.restore();}}
// v1.25.2 — FIX: teks footer ditulis di y=page.height-27, yaitu DI BAWAH batas margin bawah (page.maxY())
// yang dipakai PDFKit untuk auto page-break. Tanpa `height` eksplisit pada .text(), PDFKit menganggap
// footer "meluap" dari halaman dan diam-diam memanggil continueOnNewPage() — menghasilkan halaman kosong
// tambahan pada SETIAP laporan (termasuk yang datanya cuma 1 baris). Menambahkan height+ellipsis di sini
// membuat .text() berhenti pada batasnya sendiri alih-alih memicu halaman baru (lihat kondisi
// `if (this.height != null) return false` pada LineWrapper.nextSection di pdfkit).
function drawFooterOnAllPages(doc,company=COMPANY){const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(range.start+i);const margin=doc.page.margins.left,y=doc.page.height-27,usable=doc.page.width-margin-doc.page.margins.right;doc.save();doc.strokeColor(COLORS.line).lineWidth(.7).moveTo(margin,y-8).lineTo(margin+usable,y-8).stroke();doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.7).text(safe(company),margin,y,{width:usable*.55,height:10,ellipsis:true,lineBreak:false});doc.text(`Halaman ${i+1} / ${range.count}`,margin+usable*.55,y,{width:usable*.45,align:'right',height:10,ellipsis:true,lineBreak:false});doc.restore();}}
// v1.29 — dedicated, section-based layout for the per-recipient Closing report.
// The old flat createReportPdf table mixed RINGKASAN/SUBTOTAL/PEMBAGIAN/PENDAPATAN/
// PENGELUARAN rows together under one "JENIS" column, which read as cluttered.
// This groups the same data into four purpose-built sections instead (location
// share cards, an adjustments-only table, and a simplified transaction table).
function drawLocationShareCards(doc,recipientName,blocks){
  drawSectionLabel(doc,'Ringkasan per Lokasi');
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,gap=12,cw=(total-gap)/2;
  const cardH=158;const y=doc.y;
  blocks.forEach((block,i)=>{
    const xx=x+i*(cw+gap);
    doc.save();
    doc.roundedRect(xx,y,cw,cardH,10).fillAndStroke(COLORS.white,COLORS.line);
    doc.roundedRect(xx,y,cw,28,10).clip();doc.roundedRect(xx,y,cw,28).fill(COLORS.ink2);doc.restore();
    doc.save();
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9.5).text(safe(block.label),xx+14,y+8,{width:cw-28,height:14,lineBreak:false,ellipsis:true});
    let ly=y+36;
    const line=(label,value,opts={})=>{
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.3).text(label,xx+14,ly,{width:cw*.5,height:11,lineBreak:false});
      doc.fillColor(opts.color||COLORS.black).font(opts.bold?'Helvetica-Bold':'Helvetica').fontSize(opts.size||7.6).text(value,xx+cw*.46,ly,{width:cw*.48,height:12,align:'right',lineBreak:false,ellipsis:true});
      ly+=opts.gap||16;
    };
    line('Pendapatan',rupiah(block.revenue));
    line('Pengeluaran',rupiah(block.expense));
    line('Laba Bersih',rupiah(block.profit),{bold:true,color:COLORS.green});
    doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(xx+14,ly+2).lineTo(xx+cw-14,ly+2).stroke();
    ly+=13;
    if(block.share){
      const shownPercent=block.share.displayPercent!=null?block.share.displayPercent:block.share.percent;
      doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7).text(`BAGIAN ${safe(recipientName).toUpperCase()} · ${String(shownPercent).replace('.',',')}%`,xx+14,ly,{width:cw-28,height:10,lineBreak:false,ellipsis:true});
      ly+=15;
      line('Kotor',rupiah(block.share.gross),{size:8.2});
      const diff=Number(block.share.amount)-Number(block.share.gross);
      line('Bersih',rupiah(block.share.amount),{bold:true,size:9.8,color:diff<0?COLORS.red:(diff>0?COLORS.green:COLORS.black),gap:0});
    } else {
      doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(7.2).text('Tidak ada alokasi untuk penerima ini di lokasi ini.',xx+14,ly,{width:cw-28,height:20,lineBreak:true});
    }
    doc.restore();
  });
  doc.y=y+cardH+18;
}
function drawAdjustmentTable(doc,rows,title,subtitle){
  drawSectionLabel(doc,'Penyesuaian Anda',`${rows.length} baris`);
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;
  const bottomLimit=doc.page.height-doc.page.margins.bottom-30;
  if(!rows.length){
    doc.save();doc.roundedRect(x,doc.y,total,36,7).fillAndStroke(COLORS.soft,COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.6).text('Tidak ada potongan atau tambahan untuk periode ini — Bersih sama dengan Kotor.',x+12,doc.y+13,{width:total-24,align:'center',height:12,lineBreak:false,ellipsis:true});
    doc.restore();doc.y+=46;return;
  }
  const cols=[{label:'Jenis',w:.22},{label:'Lokasi',w:.13},{label:'Keterangan',w:.42},{label:'Nominal',w:.23,align:'right'}];
  const widths=cols.map(c=>c.w*total);
  const headY=doc.y;doc.save();
  doc.roundedRect(x,headY,total,24,6).fill(COLORS.soft);
  let xx=x;cols.forEach((c,i)=>{doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.6).text(c.label.toUpperCase(),xx+10,headY+9,{width:widths[i]-16,align:c.align||'left',height:9,lineBreak:false,ellipsis:true});xx+=widths[i];});
  doc.restore();doc.y=headY+26;
  rows.forEach((row,ri)=>{
    const rh=24;
    if(doc.y+rh>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);}
    const y=doc.y;doc.save();
    if(ri%2===1)doc.rect(x,y,total,rh).fill('#FBFCFE');
    doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();
    let xx2=x;
    doc.fillColor(COLORS.black).font('Helvetica').fontSize(7.4).text(safe(row.jenis),xx2+10,y+7,{width:widths[0]-16,height:11,lineBreak:false,ellipsis:true});xx2+=widths[0];
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.4).text(safe(row.lokasi),xx2+10,y+7,{width:widths[1]-16,height:11,lineBreak:false,ellipsis:true});xx2+=widths[1];
    doc.fillColor(COLORS.black).font('Helvetica').fontSize(7.4).text(safe(row.keterangan),xx2+10,y+7,{width:widths[2]-16,height:11,lineBreak:false,ellipsis:true});xx2+=widths[2];
    const deduct=row.nominal<0;
    doc.fillColor(deduct?COLORS.red:COLORS.green).font('Helvetica-Bold').fontSize(7.6).text(`${deduct?'- ':'+ '}${rupiah(Math.abs(row.nominal))}`,xx2+10,y+7,{width:widths[3]-16,align:'right',height:11,lineBreak:false,ellipsis:true});
    doc.restore();doc.y=y+rh;
  });
  const netTotal=rows.reduce((a,r)=>a+r.nominal,0);
  if(doc.y+26>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);}
  const y=doc.y;doc.save();doc.rect(x,y,total,26).fill(COLORS.purpleSoft);doc.rect(x,y,total,1.4).fill(COLORS.purple);
  doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7.4).text('TOTAL PENYESUAIAN',x+10,y+9,{width:total*.6,height:10,lineBreak:false,ellipsis:true});
  doc.fillColor(netTotal<0?COLORS.red:COLORS.green).font('Helvetica-Bold').fontSize(8).text(`${netTotal<0?'- ':'+ '}${rupiah(Math.abs(netTotal))}`,x+total*.55,y+8,{width:total*.43,align:'right',height:11,lineBreak:false,ellipsis:true});
  doc.restore();doc.y=y+26+18;
}
function drawTransactionTable(doc,rows,title,subtitle){
  drawSectionLabel(doc,'Rincian Pendapatan & Pengeluaran',`${rows.length} baris`);
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;
  const bottomLimit=doc.page.height-doc.page.margins.bottom-30;
  const cols=[{label:'Tanggal',w:.13},{label:'Lokasi',w:.1},{label:'Jenis',w:.14},{label:'Keterangan',w:.40},{label:'Nominal',w:.23,align:'right'}];
  const widths=cols.map(c=>c.w*total);
  function drawHead(){
    const hy=doc.y;doc.save();
    const g=doc.linearGradient(x,hy,x+total,hy);g.stop(0,COLORS.ink2).stop(1,'#1B1440');
    doc.roundedRect(x,hy,total,24,6).fill(g);
    let xx=x;cols.forEach((c,i)=>{doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(6.6).text(c.label.toUpperCase(),xx+10,hy+9,{width:widths[i]-16,align:c.align||'left',height:9,lineBreak:false,ellipsis:true});xx+=widths[i];});
    doc.restore();doc.y=hy+26;
  }
  drawHead();
  if(!rows.length){
    doc.save();doc.roundedRect(x,doc.y,total,36,7).fillAndStroke(COLORS.soft,COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.6).text('Tidak ada data untuk filter yang dipilih.',x+12,doc.y+13,{width:total-24,align:'center',height:12,lineBreak:false,ellipsis:true});
    doc.restore();doc.y+=46;return;
  }
  rows.forEach((row,ri)=>{
    const rh=24;
    if(doc.y+rh>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);drawHead();}
    const y=doc.y;doc.save();
    if(ri%2===1)doc.rect(x,y,total,rh).fill('#FBFCFE');
    doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();
    let xx=x;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.3).text(safe(row.tanggal),xx+10,y+7,{width:widths[0]-16,height:11,lineBreak:false,ellipsis:true});xx+=widths[0];
    doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(7.3).text(safe(row.lokasi),xx+10,y+7,{width:widths[1]-16,height:11,lineBreak:false,ellipsis:true});xx+=widths[1];
    const income=row.jenis==='Pendapatan';
    doc.fillColor(income?COLORS.green:'#B54708').font('Helvetica-Bold').fontSize(6.8).text(safe(row.jenis).toUpperCase(),xx+10,y+8,{width:widths[2]-16,height:9,lineBreak:false,ellipsis:true});xx+=widths[2];
    doc.fillColor(COLORS.black).font('Helvetica').fontSize(7.3).text(safe(row.keterangan),xx+10,y+7,{width:widths[3]-16,height:11,lineBreak:false,ellipsis:true});xx+=widths[3];
    doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(7.4).text(rupiah(row.nominal),xx+10,y+7,{width:widths[4]-16,align:'right',height:11,lineBreak:false,ellipsis:true});
    doc.restore();doc.y=y+rh;
  });
  doc.y+=18;
}
function createClosingReportPdf(res,{title,subtitle,filename,recipientName='',summaryItems=[],blocks=[],adjustmentRows=[],transactionRows=[],disposition='attachment',watermark=''}){
  const doc=new PDFDocument({size:'A4',layout:'portrait',margins:{top:36,bottom:42,left:36,right:36},bufferPages:true,info:{Title:safe(title),Author:COMPANY,Subject:safe(subtitle||'')}});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`${disposition==='inline'?'inline':'attachment'}; filename="${String(filename).replace(/[\r\n"]/g,'-')}"`);
  doc.pipe(res);
  drawBrandHeader(doc,title,subtitle,false);
  drawSummary(doc,summaryItems);
  drawLocationShareCards(doc,recipientName,blocks);
  drawAdjustmentTable(doc,adjustmentRows,title,subtitle);
  drawTransactionTable(doc,transactionRows,title,subtitle);
  drawReportSignoff(doc);
  drawWatermarkOnAllPages(doc,watermark);
  drawFooterOnAllPages(doc);
  doc.end();
}
function createReportPdf(res,{title,subtitle,filename,summaryItems=[],columns=[],rows=[],disposition='attachment',layout=null,watermark=''}){const resolvedLayout=layout||((columns.length>=6)?'landscape':'portrait');const doc=new PDFDocument({size:'A4',layout:resolvedLayout,margins:{top:36,bottom:42,left:36,right:36},bufferPages:true,info:{Title:safe(title),Author:COMPANY,Subject:safe(subtitle||'')}});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`${disposition==='inline'?'inline':'attachment'}; filename="${String(filename).replace(/[\r\n"]/g,'-')}"`);doc.pipe(res);drawBrandHeader(doc,title,subtitle,false);drawSummary(doc,summaryItems);drawTable(doc,columns,rows,title,subtitle);drawReportSignoff(doc);drawWatermarkOnAllPages(doc,watermark);drawFooterOnAllPages(doc);doc.end();}

function createCorporateInvoicePdf(res,{invoice,bank=null,payments=[],branding={},filename,disposition='inline',language='id'}){
  const x=invoice,rawCompany=String(branding.companyName||COMPANY).trim(),company=/^PT(?:\.|\s)/i.test(rawCompany)?rawCompany:`PT ${rawCompany}`,tagline=branding.tagline||TAGLINE,footer=branding.footer||'Dokumen digital resmi. Tidak memerlukan tanda tangan basah.';
  const companyDetails=[branding.address,branding.phone?`Tel. ${branding.phone}`:null,branding.email,branding.website,branding.taxId?`NPWP/ID Pajak: ${branding.taxId}`:null].filter(Boolean).join(' · ');
  // Tidak memakai margin aliran PDFKit: seluruh elemen ditempatkan absolut di satu kanvas A4.
  // Teks panjang selalu diberi height/ellipsis sehingga tidak pernah membuat halaman tambahan.
  const doc=new PDFDocument({autoFirstPage:false,bufferPages:true,info:{Title:`${language==='en'?'Invoice':'Faktur'} ${safe(x.invoice_number)}`,Author:safe(company)}});doc.addPage({size:'A4',margins:{top:0,bottom:0,left:0,right:0}});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`${disposition==='attachment'?'attachment':'inline'}; filename="${String(filename).replace(/[\r\n"]/g,'-')}"`);doc.pipe(res);
  const W=doc.page.width,L=42,R=42,U=W-L-R,documentTitle=language==='en'?'INVOICE':'FAKTUR';doc.save();doc.rect(0,0,W,122).fill(COLORS.ink);doc.rect(0,119,W*.74,3).fill(COLORS.purple);doc.rect(W*.74,119,W*.26,3).fill(COLORS.red);if(branding.logoFilePath&&fs.existsSync(branding.logoFilePath)){try{doc.image(branding.logoFilePath,L,28,{fit:[150,45],align:'left',valign:'center'});}catch{drawLogo(doc,L,28,150,45);}}else drawLogo(doc,L,28,150,45);doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(25).text(documentTitle,W-230,22,{width:188,height:31,align:'right',ellipsis:true});doc.fillColor('#A99BFF').font('Helvetica-Bold').fontSize(8).text(safe(x.invoice_number),W-260,54,{width:218,height:11,align:'right',ellipsis:true});doc.fillColor('#C8CEDA').font('Helvetica').fontSize(7.3).text(safe(company),W-300,73,{width:258,height:11,align:'right',ellipsis:true});const contact=[branding.phone,branding.email].filter(Boolean).join(' · ');if(contact)doc.fontSize(6.2).text(safe(contact),W-320,91,{width:278,height:10,align:'right',ellipsis:true});doc.restore();
  let y=146;doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.5).text('DITAGIHKAN KEPADA',L,y,{height:9,characterSpacing:.8});doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(12).text(safe(x.customer_name),L,y+15,{width:U*.52,height:31,lineGap:1,ellipsis:true});doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.2).text(safe(x.customer_code),L,y+51,{width:U*.52,height:9,ellipsis:true});doc.font('Helvetica').fontSize(7.2).text(safe(x.address||'-'),L,y+64,{width:U*.52,height:22,lineGap:1.5,ellipsis:true});doc.text(safe(x.phone||'-'),L,y+91,{width:U*.52,height:9,ellipsis:true});
  const bx=L+U*.58,bw=U*.42;doc.save();doc.roundedRect(bx,y,bw,86,9).fillAndStroke(COLORS.soft,COLORS.line);const meta=[['Tanggal Faktur',date(x.invoice_date)],['Jatuh Tempo',date(x.due_date)],['Periode',`${String(x.period_month).padStart(2,'0')}/${x.period_year}`],['Site / Cluster',`${safe(x.site_code)} / ${safe(x.cluster_name||'-')}`]];meta.forEach((m,i)=>{doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text(m[0],bx+12,y+11+i*18,{width:bw*.45,height:9,ellipsis:true});doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(6.6).text(m[1],bx+bw*.46,y+11+i*18,{width:bw*.48,height:9,align:'right',ellipsis:true});});doc.restore();
  y+=111;doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7).text('RINCIAN LAYANAN',L,y,{characterSpacing:.8});y+=14;doc.save();doc.roundedRect(L,y,U,30,7).fill(COLORS.ink2);const cols=[L+12,L+U*.61,L+U*.72,L+U*.98];doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(6.7).text('DESKRIPSI',cols[0],y+10,{width:U*.52});doc.text('QTY',cols[1],y+10,{width:U*.08,align:'center'});doc.text('HARGA',cols[2],y+10,{width:U*.24,align:'right'});doc.restore();y+=32;
  const rowH=54;doc.save();doc.rect(L,y,U,rowH).fillAndStroke(COLORS.white,COLORS.line);doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(8.5).text(`${safe(x.package_name)}${x.is_prorata?' (Prorata)':''}`,L+12,y+10,{width:U*.52});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.8).text(`Layanan Internet INKAMNET · ${safe(x.site_code)} · Cluster ${safe(x.cluster_name||'-')}`,L+12,y+27,{width:U*.52});doc.fillColor(COLORS.black).font('Helvetica').fontSize(8).text('1',cols[1],y+17,{width:U*.08,align:'center'});doc.font('Helvetica-Bold').text(rupiah(x.subtotal),L+U*.72,y+17,{width:U*.25,align:'right'});doc.restore();y+=72;
  const leftW=U*.51,rightX=L+U*.57,rightW=U*.43;doc.save();doc.roundedRect(L,y,leftW,106,9).fillAndStroke(COLORS.soft,COLORS.line);doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(7.5).text('INFORMASI PEMBAYARAN',L+13,y+13);if(bank){doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(11).text(safe(bank.bank_name),L+13,y+34);doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(10).text(safe(bank.account_number),L+13,y+51);doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7).text(`a.n. ${safe(bank.account_name)}`,L+13,y+68,{width:leftW-26});}else doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text('Hubungi admin INKAMNET untuk informasi rekening pembayaran.',L+13,y+38,{width:leftW-26});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.3).text(language==='en'?'Include the invoice number in the payment reference.':'Cantumkan nomor faktur pada referensi pembayaran.',L+13,y+88,{width:leftW-26});doc.restore();
  const totals=[['Subtotal',rupiah(x.subtotal)],['Diskon',`- ${rupiah(x.discount)}`],[language==='en'?'Invoice Total':'Total Faktur',rupiah(x.total)],[language==='en'?'Paid':'Terbayar',rupiah(x.paid_amount)],[language==='en'?'AMOUNT DUE':'SISA TAGIHAN',rupiah(x.outstanding)]];doc.save();doc.roundedRect(rightX,y,rightW,146,9).fillAndStroke(COLORS.white,COLORS.line);totals.forEach((t,i)=>{const yy=y+14+i*25;const last=i===totals.length-1;if(i===2||last){doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(rightX+12,yy-6).lineTo(rightX+rightW-12,yy-6).stroke();}doc.fillColor(last?COLORS.black:COLORS.muted).font(last?'Helvetica-Bold':'Helvetica').fontSize(last?8:7).text(t[0],rightX+13,yy,{width:rightW*.44});doc.fillColor(last?(Number(x.outstanding)>0?COLORS.red:COLORS.green):COLORS.black).font('Helvetica-Bold').fontSize(last?12:8).text(t[1],rightX+rightW*.43,yy-1,{width:rightW*.51,align:'right'});});doc.restore();
  y+=164;const statusKey=String(x.status||'').toLowerCase(),status=documentLabel(statusKey,language).toUpperCase();doc.save();const sc=statusKey==='paid'?COLORS.green:(statusKey==='overdue'?COLORS.red:COLORS.purple),sf=statusKey==='paid'?COLORS.greenSoft:(statusKey==='overdue'?COLORS.redSoft:COLORS.purpleSoft);doc.roundedRect(L,y,142,25,12).fill(sf);doc.fillColor(sc).font('Helvetica-Bold').fontSize(7).text(`STATUS · ${status}`,L+10,y+9,{width:122,height:9,align:'center',ellipsis:true});doc.restore();
  if(payments.length){const compactPayments=payments.slice(0,3);y+=42;doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7).text(language==='en'?'PAYMENT HISTORY':'RIWAYAT PEMBAYARAN',L,y,{height:10,characterSpacing:.8});y+=14;compactPayments.forEach((p,i)=>{doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(7).text(rupiah(p.amount),L,y+i*17,{width:110,height:10,ellipsis:true});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.6).text(`${documentLabel(p.method,language).toUpperCase()} · ${documentLabel(p.status,language).toUpperCase()} · ${date(p.paid_at)}`,L+116,y+i*17,{width:U-116,height:10,ellipsis:true});});if(payments.length>compactPayments.length)doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(6.2).text(`+ ${payments.length-compactPayments.length} ${language==='en'?'other transactions are stored in the system':'transaksi lain tersimpan pada sistem'}`,L,y+compactPayments.length*17,{width:U,height:9,ellipsis:true});}
  // Fixed footer and bounded text guarantee the formal invoice remains exactly one A4 page.
  const footerY=722;doc.save();doc.strokeColor(COLORS.line).moveTo(L,footerY).lineTo(L+U,footerY).stroke();doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(7).text(safe(company),L,footerY+12,{width:U*.55,height:12,ellipsis:true});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(5.8).text(safe(companyDetails||footer),L,footerY+25,{width:U*.59,height:35,lineGap:1.5,ellipsis:true});doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(6.5).text(safe(tagline),L+U*.62,footerY+18,{width:U*.38,height:12,align:'right',ellipsis:true});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(5.8).text(safe(footer),L+U*.62,footerY+32,{width:U*.38,height:28,align:'right',lineGap:1.5,ellipsis:true});doc.restore();
  doc.save();doc.strokeColor(COLORS.line).lineWidth(.7).moveTo(L,806).lineTo(L+U,806).stroke();doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.2).text(`${safe(company)} · ${language==='en'?'Official invoice':'Faktur resmi'}`,L,813,{width:U*.7,height:10,ellipsis:true});doc.text(language==='en'?'Page 1 / 1':'Halaman 1 / 1',L+U*.7,813,{width:U*.3,height:10,align:'right'});doc.restore();doc.end();
}
module.exports={createReportPdf,createCorporateInvoicePdf,createClosingReportPdf,rupiah,date,documentLabel,COLORS};
