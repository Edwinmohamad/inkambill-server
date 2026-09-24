const PDFDocument=require('pdfkit');
const path=require('path');
const fs=require('fs');

// v2.6 — Apple-style redesign: putih bersih, garis tipis, warna dipakai
// seperlunya (bukan lagi gradient navy-ungu + kartu warna-warni). Nama key
// COLORS dipertahankan sama persis (ink, ink2, muted, muted2, purple,
// purpleSoft, red, redSoft, green, greenSoft, blue, line, soft, white, black)
// karena beberapa routes/*.js lain (customInvoices, payments, reports) masih
// mengimpor COLORS.blue/green/purple/red langsung — hanya NILAI hex-nya yang
// diperhalus, bukan nama key-nya, supaya tidak ada yang patah di luar file ini.
const COLORS={
  ink:'#1D1D1F',ink2:'#1D1D1F',
  muted:'#6E6E73',muted2:'#86868B',
  purple:'#5B4FE3',purpleSoft:'#F2F0FC',
  red:'#FF3B30',redSoft:'#FFF1F0',
  green:'#1DA463',greenSoft:'#EAFBF3',
  blue:'#0071E3',blueSoft:'#EAF4FE',
  line:'#E5E5EA',soft:'#F5F5F7',white:'#FFFFFF',black:'#1D1D1F'
};
const COMPANY='PT INKAMNET NEXERA TECHNOLOGY';
const TAGLINE='From the Village, Online Everywhere';
function rupiah(v){return 'Rp '+new Intl.NumberFormat('id-ID',{maximumFractionDigits:0}).format(Number(v||0));}
function date(v){if(!v)return'-';try{return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Jakarta'}).format(new Date(v));}catch{return String(v);}}
function safe(v){return String(v??'-').replace(/[–—]/g,'-').replace(/•/g,'-').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');}
function documentLabel(value,language='id'){const key=String(value||'').toLowerCase();const labels={id:{paid:'Lunas',unpaid:'Belum Lunas',partial:'Bayar Sebagian',overdue:'Terlambat',pending:'Menunggu',confirmed:'Dikonfirmasi',cancelled:'Dibatalkan',refunded:'Dikembalikan',cash:'Tunai',transfer:'Transfer',qris:'QRIS',gateway:'Gateway'},en:{paid:'Paid',unpaid:'Unpaid',partial:'Partially Paid',overdue:'Overdue',pending:'Pending',confirmed:'Confirmed',cancelled:'Cancelled',refunded:'Refunded',cash:'Cash',transfer:'Transfer',qris:'QRIS',gateway:'Gateway'}};return labels[language==='en'?'en':'id'][key]||safe(value);}
function nowText(){return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Jakarta'}).format(new Date())+' WIB';}
function logoPath(){return path.join(__dirname,'../public/img/inkamnet-wordmark-hq.png');}
function drawLogo(doc,x,y,w=145,h=42){const logo=logoPath();if(fs.existsSync(logo)){try{doc.image(logo,x,y,{fit:[w,h],align:'left',valign:'center'});return;}catch{}}doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(18).text('INKAMNET',x,y+8);}

// v2.6 — header sekarang latar putih polos: logo kiri, judul dokumen kanan,
// satu garis tipis di bawah + satu aksen ungu pendek (bukan lagi pita
// gradient navy-ungu dengan lingkaran glow). Meniru bahasa visual yang sudah
// dipakai di views/invoices/print.ejs supaya semua dokumen INKAMNET terasu
// satu keluarga.
function drawBrandHeader(doc,title,subtitle,compact=false){
  const width=doc.page.width,margin=doc.page.margins.left,usable=width-margin-doc.page.margins.right,h=compact?52:82;
  doc.save();
  doc.rect(0,0,width,h).fill(COLORS.white);
  drawLogo(doc,margin,compact?13:19,compact?96:132,compact?27:39);
  const titleX=Math.max(margin+160,width*.42),titleW=width-margin-titleX;
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.6).text(COMPANY,titleX,compact?11:15,{width:titleW,align:'right',characterSpacing:.6});
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(compact?13:18.5).text(safe(title),titleX,compact?23:33,{width:titleW,align:'right'});
  if(!compact&&subtitle)doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.6).text(safe(subtitle),titleX,57,{width:titleW,align:'right',lineGap:2});
  doc.strokeColor(COLORS.line).lineWidth(1).moveTo(margin,h).lineTo(width-margin,h).stroke();
  doc.rect(margin,h-1.5,34,1.5).fill(COLORS.purple);
  doc.restore();doc.y=h+16;
  if(!compact){doc.fillColor(COLORS.muted2).font('Helvetica').fontSize(6.8).text(`DOKUMEN RESMI · INKAMNET CONTROL CENTER · Dibuat ${nowText()}`,margin,doc.y,{width:usable,characterSpacing:.2});doc.y+=18;}
}
// v2.6 — label section polos (huruf kecil muted, bukan lagi kotak ungu
// bergaris tebal di kiri), dengan garis tipis penuh lebar di bawahnya. `meta`
// (mis. "5 baris") sekarang benar-benar dirender rata kanan — sebelumnya
// parameter ini diterima tapi tidak pernah dipakai.
function drawSectionLabel(doc,label,meta){
  // v3.0 — penjaga: kalau doc.y sudah terlalu dekat ke batas bawah halaman,
  // pindah halaman DULU sebelum doc.save() dibuka. Tanpa ini, pdfkit bisa
  // pindah halaman sendiri di tengah teks di bawah (karena tidak diberi
  // `height` eksplisit) — save() kebuka di halaman lama, restore()
  // ke-panggil di halaman baru, dan PDF-nya jadi rusak (state ganjil).
  if(doc.y+25>doc.page.height-doc.page.margins.bottom)doc.addPage();
  const x=doc.page.margins.left,width=doc.page.width-x-doc.page.margins.right;
  doc.save();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.4).text(safe(label).toUpperCase(),x,doc.y,{characterSpacing:.9,lineBreak:false});
  if(meta){doc.fillColor(COLORS.muted2).font('Helvetica').fontSize(6.8).text(safe(meta),x,doc.y,{width,align:'right',lineBreak:false});}
  doc.restore();doc.y+=12;
  doc.save();doc.strokeColor(COLORS.line).lineWidth(.75).moveTo(x,doc.y).lineTo(x+width,doc.y).stroke();doc.restore();doc.y+=9;
}
// v2.6 — kartu ringkasan polos (border tipis, tanpa bar warna kiri, tanpa
// lingkaran glow/shadow) — label muted kecil, angka besar berwarna aksen.
function drawSummary(doc,items){if(!items.length)return;drawSectionLabel(doc,'Ringkasan Eksekutif');const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,cols=Math.min(4,Math.max(1,items.length)),gap=10,cw=(total-gap*(cols-1))/cols;let y=doc.y;items.forEach((it,i)=>{if(i>0&&i%cols===0)y+=62;const xx=x+(i%cols)*(cw+gap),accent=it.color||COLORS.purple;doc.save();
    doc.roundedRect(xx,y,cw,52,10).lineWidth(1).fillAndStroke(COLORS.white,COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.5).text(safe(it.label),xx+14,y+11,{width:cw-24,height:9,characterSpacing:.3,ellipsis:true,lineBreak:false});
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(12).text(safe(it.value),xx+14,y+27,{width:cw-24,height:16,ellipsis:true,lineBreak:false});
    doc.restore();});const rowsCount=Math.ceil(items.length/cols);doc.y=y+52+16+(rowsCount>1?(rowsCount-1)*62:0);}
function valueFor(column,row){return typeof column.value==='function'?column.value(row):row[column.key];}function colorFor(column,row){return typeof column.color==='function'?column.color(row):(column.color||COLORS.black);}
// v2.6 — header tabel jadi abu-abu terang + garis tipis (bukan gradient
// navy-ungu dengan teks putih).
function drawTable(doc,columns,rows,title,subtitle){drawSectionLabel(doc,'Detail Data',rows.length?`${rows.length} baris`:undefined);const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,rawWidths=columns.map(c=>Number(c.width||1)),sum=rawWidths.reduce((a,b)=>a+b,0)||1,widths=rawWidths.map(v=>v/sum*total),headerH=25,hasTotalRow=columns.some(c=>c.total),bottomLimit=doc.page.height-doc.page.margins.bottom-(hasTotalRow?62:30);
  function head(){const y=doc.y;doc.save();doc.rect(x,y,total,headerH).fill(COLORS.soft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,y+headerH).lineTo(x+total,y+headerH).stroke();let xx=x;columns.forEach((c,i)=>{doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.7).text(safe(c.label).toUpperCase(),xx+8,y+9,{width:Math.max(10,widths[i]-14),align:c.align||'left',ellipsis:true});xx+=widths[i];});doc.restore();doc.y=y+headerH+2;}
  function nextPage(){doc.addPage();drawBrandHeader(doc,title,subtitle,true);head();}head();if(!rows.length){doc.save();doc.roundedRect(x,doc.y,total,44,8).fillAndStroke(COLORS.soft,COLORS.line);doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text('Tidak ada data untuk filter yang dipilih.',x+12,doc.y+16,{width:total-24,align:'center'});doc.restore();doc.y+=54;return;}
  rows.forEach((row,ri)=>{const vals=columns.map(c=>safe(valueFor(c,row)));const heights=vals.map((v,i)=>doc.font(columns[i].bold?'Helvetica-Bold':'Helvetica').fontSize(7.05).heightOfString(v,{width:Math.max(20,widths[i]-14),lineGap:1}));let rh=Math.max(28,...heights.map(h=>h+13));rh=Math.min(rh,86);if(doc.y+rh>bottomLimit)nextPage();const y=doc.y;doc.save();if(ri%2===1)doc.rect(x,y,total,rh).fill(COLORS.soft);doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();let xx=x;columns.forEach((c,i)=>{doc.fillColor(colorFor(c,row)).font(c.bold?'Helvetica-Bold':'Helvetica').fontSize(7.05).text(vals[i],xx+8,y+7,{width:Math.max(20,widths[i]-14),height:rh-11,align:c.align||'left',ellipsis:true,lineGap:1});xx+=widths[i];});doc.restore();doc.y=y+rh;});
  if(hasTotalRow){
    const rh=30;if(doc.y+rh>bottomLimit+36)nextPage();const y=doc.y;doc.save();doc.rect(x,y,total,rh).fill(COLORS.purpleSoft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,y).lineTo(x+total,y).stroke();let xx=x;
    columns.forEach((c,i)=>{
      const label=c.total?rupiah(rows.reduce((a,r)=>a+Number(c.totalBy?c.totalBy(r):0),0)):(i===0?'TOTAL':'');
      doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7.6).text(label,xx+8,y+9,{width:Math.max(10,widths[i]-14),align:c.align||'left',ellipsis:true});
      xx+=widths[i];
    });
    doc.restore();doc.y=y+rh;
  }
}
function drawReportSignoff(doc){const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;if(doc.y+80>doc.page.height-doc.page.margins.bottom)doc.addPage();doc.y+=16;const boxY=doc.y;doc.save();doc.roundedRect(x,boxY,total,60,10).lineWidth(1).fillAndStroke(COLORS.soft,COLORS.line);doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.3).text('CATATAN DOKUMEN',x+16,boxY+12,{width:total*.64,height:10,ellipsis:true,lineBreak:false});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.9).text('Laporan ini dihasilkan secara elektronik dari INKAMNET Control Center berdasarkan data yang tersimpan pada saat dokumen dibuat.',x+16,boxY+25,{width:total*.64,height:26,lineGap:2,ellipsis:true});doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7).text(COMPANY,x+total*.70,boxY+24,{width:total*.27,align:'right',height:10,ellipsis:true,lineBreak:false});doc.fillColor(COLORS.muted2).font('Helvetica').fontSize(6.4).text(TAGLINE,x+total*.70,boxY+37,{width:total*.27,align:'right',height:10,ellipsis:true,lineBreak:false});doc.restore();doc.y=boxY+72;}
function drawWatermarkOnAllPages(doc,text){const label=safe(text||'').trim();if(!label)return;const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(range.start+i);const cx=doc.page.width/2,cy=doc.page.height/2;doc.save();doc.fillOpacity(.035);doc.fillColor(COLORS.ink);doc.font('Helvetica-Bold').fontSize(34);doc.rotate(-32,{origin:[cx,cy]});doc.text(label,0,cy-22,{width:doc.page.width,height:48,align:'center',lineBreak:false,ellipsis:true});doc.restore();}}
function drawFooterOnAllPages(doc,company=COMPANY){const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(range.start+i);const margin=doc.page.margins.left,y=doc.page.height-27,usable=doc.page.width-margin-doc.page.margins.right;doc.save();doc.strokeColor(COLORS.line).lineWidth(.7).moveTo(margin,y-8).lineTo(margin+usable,y-8).stroke();doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.7).text(safe(company),margin,y,{width:usable*.55,height:10,ellipsis:true,lineBreak:false});doc.text(`Halaman ${i+1} / ${range.count}`,margin+usable*.55,y,{width:usable*.45,align:'right',height:10,ellipsis:true,lineBreak:false});doc.restore();}}

// v2.6 — kartu lokasi sekarang plain white + border tipis (bukan header
// strip gelap), dan menambahkan dua breakdown baru yang sebelumnya cuma ada
// di angka mentah tapi tidak pernah dirender: pendapatan PSB vs langganan
// biasa, dan pengeluaran per kategori. Tinggi kartu dihitung dinamis supaya
// tidak kepotong kalau breakdown-nya ada.
function drawLocationShareCards(doc,recipientName,blocks,title,subtitle){
  drawSectionLabel(doc,'Ringkasan per Lokasi',`${blocks.length} lokasi`);
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,gap=12,cw=(total-gap)/2;
  // v2.7 — bagian "BAGIAN <nama> · <persen>" sebelumnya dirender sebagai satu
  // baris teks kecil (6.8pt) mirip subtitle, gampang kebaca sebagai label
  // biasa padahal ini angka paling penting di kartu (jatah penerima). Sekarang
  // jadi panel tersendiri berlatar ungu muda: nama & persen dipisah (persen
  // jadi pil bulat di kanan supaya tidak menyatu jadi satu kalimat panjang),
  // dan "Bersih" tampil sebagai angka besar — bukan baris kecil sejajar
  // "Kotor" seperti sebelumnya.
  const SHARE_PANEL_H=76;
  // v3.0 — rincian Pendapatan/Pengeluaran dulu satu baris caption abu-abu
  // yang dirangkum & tetap bisa terpotong kalau kepanjangan. Sekarang setiap
  // kategori jadi barisnya sendiri ("Petty Cash · Rp 5.266.500"), diakhiri
  // baris "Total Pendapatan"/"Total Pengeluaran" — tidak ada lagi teks yang
  // disingkat, dirangkum, atau dipotong; tinggi tiap baris dihitung dari teks
  // sungguhan (heightOfString) jadi nama kategori sepanjang apa pun tetap
  // utuh (melipat ke baris baru kalau perlu, bukan terpotong).
  const padX=16,contentW=cw-padX*2,labelW=contentW*.58,valueW=contentW-labelW;
  function itemRowH(label,bold){
    doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(bold?7.7:7.3);
    return Math.max(12.5,doc.heightOfString(safe(label),{width:labelW,lineGap:1})+3);
  }
  function revenueRows(block){
    if(money(block.psbRevenue)>0)return[
      {label:'Langganan',value:rupiah(block.subscriptionRevenue)},
      {label:'PSB',value:rupiah(block.psbRevenue)},
      {label:'Total Pendapatan',value:rupiah(block.revenue),bold:true,divider:true}
    ];
    return[{label:'Total Pendapatan',value:rupiah(block.revenue),bold:true}];
  }
  function expenseRows(block){
    const cats=Object.entries(block.expenseByCategory||{}).sort((a,b)=>b[1]-a[1]);
    if(cats.length)return[
      ...cats.map(([k,v])=>({label:k,value:rupiah(v)})),
      {label:'Total Pengeluaran',value:rupiah(block.expense),bold:true,divider:true}
    ];
    return[{label:'Total Pengeluaran',value:rupiah(block.expense),bold:true}];
  }
  function rowsH(rows){return rows.reduce((a,r)=>a+itemRowH(r.label,r.bold)+(r.divider?5:0),0);}
  const cardHeight=(block)=>{
    let h=43+rowsH(revenueRows(block))+8+rowsH(expenseRows(block))+10+16;
    h+=block.share?(8+SHARE_PANEL_H+16):37;
    return h;
  };
  // v3.1 — dulu fungsi ini SELALU mengasumsikan tepat 2 kartu dalam 1 baris
  // (mis. CDS + KBG). Sekarang lokasi CDS bisa pecah jadi beberapa kartu (KRW,
  // CLM, ringkasan gabungan, dst — lihat routes/closing.js), jadi kartu-kartu
  // ditata dalam grid 2 kolom yang melipat ke baris berikutnya, dan setiap
  // baris punya tinggi dan pengecekan pindah-halaman sendiri (bukan satu
  // tinggi seragam untuk semua kartu sekaligus, yang akan boros halaman kalau
  // satu kartu jauh lebih tinggi dari yang lain).
  const cols=2;
  for(let rowStart=0;rowStart<blocks.length;rowStart+=cols){
    const rowBlocks=blocks.slice(rowStart,rowStart+cols);
    const rowH=Math.max(...rowBlocks.map(cardHeight),150);
    if(doc.y+rowH>doc.page.height-doc.page.margins.bottom){doc.addPage();if(title)drawBrandHeader(doc,title,subtitle,true);drawSectionLabel(doc,'Ringkasan per Lokasi',`${blocks.length} lokasi`);}
    drawCardRow(rowBlocks,rowH);
    doc.y+=18;
  }
  function drawCardRow(rowBlocks,cardH){
  const y=doc.y;
  rowBlocks.forEach((block,i)=>{
    const xx=x+i*(cw+gap);
    doc.save();doc.roundedRect(xx,y,cw,cardH,10).lineWidth(1).fillAndStroke(COLORS.white,COLORS.line);doc.restore();
    doc.save();
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(safe(block.label),xx+16,y+14,{width:cw-32,height:14,lineBreak:false,ellipsis:true});
    doc.strokeColor(COLORS.line).lineWidth(.75).moveTo(xx+16,y+35).lineTo(xx+cw-16,y+35).stroke();
    let ly=y+43;
    const drawRows=(rows)=>{
      rows.forEach(r=>{
        const size=r.bold?7.7:7.3;
        const h=itemRowH(r.label,r.bold);
        if(r.divider){doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(xx+16,ly+1).lineTo(xx+cw-16,ly+1).stroke();ly+=5;}
        // `height:h` eksplisit (h dari heightOfString di itemRowH) penting:
        // tanpa ini pdfkit bisa auto pindah halaman di tengah blok save()
        // milik kartu ini kalau kartu lain di baris yang sama membuat
        // doc.y akhirnya dekat ke batas bawah — lihat catatan di
        // drawSectionLabel.
        doc.fillColor(r.bold?COLORS.ink:COLORS.muted).font(r.bold?'Helvetica-Bold':'Helvetica').fontSize(size).text(safe(r.label),xx+16,ly,{width:labelW,height:h,lineGap:1});
        doc.fillColor(COLORS.ink).font(r.bold?'Helvetica-Bold':'Helvetica').fontSize(size).text(r.value,xx+16+labelW,ly,{width:valueW,align:'right',height:h,lineGap:1});
        ly+=h;
      });
    };
    drawRows(revenueRows(block));
    ly+=8;
    drawRows(expenseRows(block));
    ly+=10;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.7).text('Laba Bersih',xx+16,ly,{width:cw*.5,height:12,lineBreak:false});
    // v3.1 — dulu warnanya selalu hijau, tidak masalah selama tidak ada kartu
    // yang bisa rugi. Sekarang kartu breakdown per cluster (mis. "CDS -
    // Lainnya" yang cuma berisi pengeluaran tanpa pendapatan) bisa betulan
    // minus, jadi warnanya ikut tanda seperti "Bersih diterima" di bawah.
    doc.fillColor(block.profit<0?COLORS.red:COLORS.green).font('Helvetica-Bold').fontSize(9.2).text(rupiah(block.profit),xx+16+labelW,ly-1,{width:valueW,align:'right',height:13,lineBreak:false,ellipsis:true});
    ly+=16;
    if(block.share){
      const shownPercent=block.share.displayPercent!=null?block.share.displayPercent:block.share.percent;
      const percentText=`${String(shownPercent).replace('.',',')}%`;
      const diff=Number(block.share.amount)-Number(block.share.gross);
      const shareColor=diff<0?COLORS.red:(diff>0?COLORS.green:COLORS.ink);
      const panelX=xx+16,panelW=cw-32,panelY=ly+8,padX=12;
      doc.roundedRect(panelX,panelY,panelW,SHARE_PANEL_H,8).fill(COLORS.purpleSoft);
      // header row: nama penerima kiri, persen sebagai pil di kanan — dipisah
      // biar tidak jadi satu untai kalimat kecil yang harus diurai pembaca.
      const pillText=percentText,pillFontSize=7.2;
      const pillW=doc.font('Helvetica-Bold').fontSize(pillFontSize).widthOfString(pillText)+16;
      const headY=panelY+11;
      doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(8.4).text(`Bagian ${safe(recipientName)}`,panelX+padX,headY,{width:panelW-padX*2-pillW-8,height:12,lineBreak:false,ellipsis:true});
      doc.roundedRect(panelX+panelW-padX-pillW,headY-2,pillW,15,7.5).fill(COLORS.purple);
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(pillFontSize).text(pillText,panelX+panelW-padX-pillW,headY+2,{width:pillW,align:'center',lineBreak:false});
      // baris Kotor: rincian pendukung, kecil & muted.
      const kotorY=headY+21;
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.2).text('Kotor',panelX+padX,kotorY,{width:panelW*.5,height:10,lineBreak:false});
      doc.fillColor(COLORS.muted2).font('Helvetica').fontSize(7.4).text(rupiah(block.share.gross),panelX+padX,kotorY,{width:panelW-padX*2,align:'right',height:10,lineBreak:false,ellipsis:true});
      // baris Bersih: angka utama, besar & tegas — ini yang dicari penerima.
      const bersihY=kotorY+18;
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text('Bersih diterima',panelX+padX,bersihY+6,{width:panelW*.46,height:13,lineBreak:false});
      doc.fillColor(shareColor).font('Helvetica-Bold').fontSize(12.5).text(rupiah(block.share.amount),panelX+padX,bersihY,{width:panelW-padX*2,align:'right',height:17,lineBreak:false,ellipsis:true});
      ly=panelY+SHARE_PANEL_H;
    } else {
      ly+=13;
      doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(xx+16,ly-4).lineTo(xx+cw-16,ly-4).stroke();
      // v3.1 — `shareNote` dipakai kartu breakdown-only (mis. KRW/CLM) supaya
      // pesannya jelas ("dihitung gabungan, lihat kartu Total CDS") — bukan
      // pesan generik "tidak ada alokasi" yang salah arti di sini (uangnya
      // ADA, cuma ditampilkan di kartu lain).
      doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(7).text(safe(block.shareNote||'Tidak ada alokasi untuk penerima ini di lokasi ini.'),xx+16,ly,{width:cw-32,height:20,lineBreak:true});
    }
    doc.restore();
  });
  doc.y=y+cardH;
  }
}
// v3.2 — baris "Penyesuaian Anda" sekarang diberi nomor urut (kolom NO) supaya
// gampang dirujuk waktu diskusi/cek silang. Batas tinggi baris Keterangan yang
// dulu dipatok keras 96pt (memotong teks panjang di tengah kalimat tanpa tanda
// apa pun) sekarang jadi 220pt + ellipsis sebagai jaring pengaman terakhir —
// keterangan biasa selalu tampil utuh, dan hanya teks yang benar-benar ekstrem
// panjang yang dipotong, itu pun dengan "..." yang jelas menandakannya.
function drawAdjustmentTable(doc,rows,title,subtitle){
  drawSectionLabel(doc,'Penyesuaian Anda',`${rows.length} baris`);
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;
  const bottomLimit=doc.page.height-doc.page.margins.bottom-30;
  if(!rows.length){
    doc.save();doc.roundedRect(x,doc.y,total,36,7).fillAndStroke(COLORS.soft,COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.6).text('Tidak ada potongan atau tambahan untuk periode ini — Bersih sama dengan Kotor.',x+12,doc.y+13,{width:total-24,align:'center',height:12,lineBreak:false,ellipsis:true});
    doc.restore();doc.y+=46;return;
  }
  const cols=[{label:'No',w:.05,align:'center'},{label:'Jenis',w:.21},{label:'Lokasi',w:.12},{label:'Keterangan',w:.40},{label:'Nominal',w:.22,align:'right'}];
  const widths=cols.map(c=>c.w*total);
  const headY=doc.y;doc.save();
  doc.rect(x,headY,total,24).fill(COLORS.soft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,headY+24).lineTo(x+total,headY+24).stroke();
  let xx=x;cols.forEach((c,i)=>{doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.6).text(c.label.toUpperCase(),xx+10,headY+9,{width:widths[i]-16,align:c.align||'left',height:9,lineBreak:false,ellipsis:true});xx+=widths[i];});
  doc.restore();doc.y=headY+26;
  rows.forEach((row,ri)=>{
    const keteranganText=safe(row.keterangan);
    const keteranganH=doc.font('Helvetica').fontSize(7.4).heightOfString(keteranganText,{width:widths[3]-16,lineGap:1});
    const rh=Math.max(24,Math.min(220,keteranganH)+14);
    if(doc.y+rh>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);}
    const y=doc.y;doc.save();
    if(ri%2===1)doc.rect(x,y,total,rh).fill(COLORS.soft);
    doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();
    let xx2=x;
    doc.fillColor(COLORS.muted2).font('Helvetica-Bold').fontSize(7.2).text(String(ri+1),xx2+10,y+7,{width:widths[0]-16,align:'center',height:rh-10,lineBreak:false,ellipsis:true});xx2+=widths[0];
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.4).text(safe(row.jenis),xx2+10,y+7,{width:widths[1]-16,height:rh-10,lineBreak:false,ellipsis:true});xx2+=widths[1];
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.4).text(safe(row.lokasi),xx2+10,y+7,{width:widths[2]-16,height:rh-10,lineBreak:false,ellipsis:true});xx2+=widths[2];
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.4).text(keteranganText,xx2+10,y+7,{width:widths[3]-16,height:rh-10,lineGap:1,ellipsis:true});xx2+=widths[3];
    const deduct=row.nominal<0;
    doc.fillColor(deduct?COLORS.red:COLORS.green).font('Helvetica-Bold').fontSize(7.6).text(`${deduct?'- ':'+ '}${rupiah(Math.abs(row.nominal))}`,xx2+10,y+7,{width:widths[4]-16,align:'right',height:rh-10,lineBreak:false,ellipsis:true});
    doc.restore();doc.y=y+rh;
  });
  const netTotal=rows.reduce((a,r)=>a+r.nominal,0);
  if(doc.y+26>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);}
  const y=doc.y;doc.save();doc.rect(x,y,total,26).fill(COLORS.purpleSoft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,y).lineTo(x+total,y).stroke();
  doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7.4).text('TOTAL PENYESUAIAN',x+10,y+9,{width:total*.6,height:10,lineBreak:false,ellipsis:true});
  doc.fillColor(netTotal<0?COLORS.red:COLORS.green).font('Helvetica-Bold').fontSize(8).text(`${netTotal<0?'- ':'+ '}${rupiah(Math.abs(netTotal))}`,x+total*.55,y+8,{width:total*.43,align:'right',height:11,lineBreak:false,ellipsis:true});
  doc.restore();doc.y=y+26+18;
}
// v3.2 — tabel "Rincian Pendapatan & Pengeluaran" sekarang diberi nomor urut
// (kolom NO, jalan terus lintas kategori & lintas halaman lewat `entryNo`,
// tidak dihitung ulang di baris grup/subtotal). Batas tinggi baris yang dulu
// dipatok keras 96pt (memotong Tanggal/Lokasi/Keterangan panjang di tengah
// tanpa tanda apa pun) sekarang jadi 220pt + ellipsis sebagai jaring pengaman —
// konsisten dengan drawAdjustmentTable() di atas.
function drawTransactionTable(doc,rows,title,subtitle){
  const entries=rows.filter(row=>row.kind==='entry');
  drawSectionLabel(doc,'Rincian Pendapatan & Pengeluaran',`${entries.length} transaksi`);
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;
  const bottomLimit=doc.page.height-doc.page.margins.bottom-30;
  const cols=[{label:'No',w:.05,align:'center'},{label:'Tanggal',w:.12},{label:'Lokasi',w:.12},{label:'Jenis',w:.14},{label:'Keterangan',w:.34},{label:'Nominal',w:.23,align:'right'}];
  const widths=cols.map(c=>c.w*total);
  function drawHead(){
    const hy=doc.y;doc.save();
    doc.rect(x,hy,total,24).fill(COLORS.soft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,hy+24).lineTo(x+total,hy+24).stroke();
    let xx=x;cols.forEach((c,i)=>{doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.6).text(c.label.toUpperCase(),xx+10,hy+9,{width:widths[i]-16,align:c.align||'left',height:9,lineBreak:false,ellipsis:true});xx+=widths[i];});
    doc.restore();doc.y=hy+26;
  }
  drawHead();
  if(!entries.length){
    doc.save();doc.roundedRect(x,doc.y,total,36,7).fillAndStroke(COLORS.soft,COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.6).text('Tidak ada data untuk filter yang dipilih.',x+12,doc.y+13,{width:total-24,align:'center',height:12,lineBreak:false,ellipsis:true});
    doc.restore();doc.y+=46;return;
  }
  let totalIncome=0,totalExpense=0,entryNo=0;
  rows.forEach((row,ri)=>{
    if(row.kind==='group'){
      if(doc.y+58>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);drawHead();}
      const y=doc.y;doc.save();doc.roundedRect(x,y,total,22,5).fill(row.jenis==='Pendapatan'?COLORS.greenSoft:COLORS.redSoft);
      doc.fillColor(row.jenis==='Pendapatan'?COLORS.green:'#B54708').font('Helvetica-Bold').fontSize(7.3).text(`${row.jenis.toUpperCase()} · ${safe(row.category)}`,x+10,y+8,{width:total*.72,height:10,ellipsis:true,lineBreak:false});
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.7).text(`${row.count} transaksi`,x+total*.74,y+8,{width:total*.24,align:'right',height:10});doc.restore();doc.y=y+28;return;
    }
    if(row.kind==='subtotal'){
      if(doc.y+28>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);drawHead();}
      const y=doc.y;doc.save();doc.rect(x,y,total,26).fill(COLORS.purpleSoft);doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(7.1).text(`SUBTOTAL ${safe(row.category).toUpperCase()}`,x+10,y+9,{width:total*.68,height:10,ellipsis:true});doc.fillColor(row.jenis==='Pendapatan'?COLORS.green:'#B54708').font('Helvetica-Bold').fontSize(8).text(rupiah(row.nominal),x+total*.72,y+8,{width:total*.26,align:'right',height:11});doc.restore();doc.y=y+32;if(row.jenis==='Pendapatan')totalIncome+=Number(row.nominal||0);else totalExpense+=Number(row.nominal||0);return;
    }
    const tanggalText=safe(row.tanggal);
    const lokasiText=safe(row.lokasi);
    const keteranganText=safe(row.keterangan);
    const tanggalH=doc.font('Helvetica').fontSize(7.3).heightOfString(tanggalText,{width:widths[1]-16,lineGap:1});
    const lokasiH=doc.font('Helvetica-Bold').fontSize(7.3).heightOfString(lokasiText,{width:widths[2]-16,lineGap:1});
    const keteranganH=doc.font('Helvetica').fontSize(7.3).heightOfString(keteranganText,{width:widths[4]-16,lineGap:1});
    const rh=Math.max(24,Math.min(220,Math.max(tanggalH,lokasiH,keteranganH))+14);
    if(doc.y+rh>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);drawHead();}
    entryNo+=1;
    const y=doc.y;doc.save();
    if(ri%2===1)doc.rect(x,y,total,rh).fill(COLORS.soft);
    doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();
    let xx=x;
    doc.fillColor(COLORS.muted2).font('Helvetica-Bold').fontSize(7.1).text(String(entryNo),xx+10,y+7,{width:widths[0]-16,align:'center',height:rh-10,lineBreak:false,ellipsis:true});xx+=widths[0];
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.3).text(tanggalText,xx+10,y+7,{width:widths[1]-16,height:rh-10,lineGap:1,ellipsis:true});xx+=widths[1];
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.3).text(lokasiText,xx+10,y+7,{width:widths[2]-16,height:rh-10,lineGap:1,ellipsis:true});xx+=widths[2];
    const income=row.jenis==='Pendapatan';
    doc.fillColor(income?COLORS.green:'#B54708').font('Helvetica-Bold').fontSize(6.8).text(safe(row.jenis).toUpperCase(),xx+10,y+8,{width:widths[3]-16,height:rh-12,lineGap:1});xx+=widths[3];
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.3).text(keteranganText,xx+10,y+7,{width:widths[4]-16,height:rh-10,lineGap:1,ellipsis:true});xx+=widths[4];
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.4).text(rupiah(row.nominal),xx+10,y+7,{width:widths[5]-16,align:'right',height:rh-10,lineBreak:false,ellipsis:true});
    doc.restore();doc.y=y+rh;
  });
  // v2.6 — baris total Pendapatan/Pengeluaran di bawah tabel, supaya tidak
  // perlu jumlah manual buat cek total dari daftar per-kategori di atasnya.
  if(doc.y+30>bottomLimit+30){doc.addPage();drawBrandHeader(doc,title,subtitle,true);}
  const fy=doc.y;doc.save();doc.rect(x,fy,total,30).fill(COLORS.purpleSoft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,fy).lineTo(x+total,fy).stroke();
  doc.fillColor(COLORS.green).font('Helvetica-Bold').fontSize(7.4).text(`TOTAL PENDAPATAN · ${rupiah(totalIncome)}`,x+10,fy+10,{width:total*.5-10,height:11,lineBreak:false,ellipsis:true});
  doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(7.4).text(`TOTAL PENGELUARAN · ${rupiah(totalExpense)}`,x+total*.5,fy+10,{width:total*.5-10,align:'right',height:11,lineBreak:false,ellipsis:true});
  doc.restore();doc.y=fy+30+10;
}
function drawCustomerActivityTable(doc,rows,title,subtitle){
  if(!Array.isArray(rows)||!rows.length)return;
  drawSectionLabel(doc,'PSB, Pelanggan Off & Status Bayar',`${rows.length} lokasi`);
  const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right;
  const bottomLimit=doc.page.height-doc.page.margins.bottom-30;
  const cols=[{label:'Lokasi',w:.26},{label:'PSB',w:.18,align:'center'},{label:'Pelanggan Off',w:.22,align:'center'},{label:'Bayar',w:.17,align:'center'},{label:'Belum Bayar',w:.17,align:'center'}];
  const widths=cols.map(c=>c.w*total);
  const headY=doc.y;doc.save();
  doc.rect(x,headY,total,24).fill(COLORS.soft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(x,headY+24).lineTo(x+total,headY+24).stroke();
  let xx=x;cols.forEach((c,i)=>{doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.6).text(c.label.toUpperCase(),xx+10,headY+9,{width:widths[i]-16,align:c.align||'left',height:9,lineBreak:false,ellipsis:true});xx+=widths[i];});
  doc.restore();doc.y=headY+26;
  rows.forEach((row,ri)=>{
    const rh=27;
    if(doc.y+rh>bottomLimit){doc.addPage();drawBrandHeader(doc,title,subtitle,true);}
    const y=doc.y;doc.save();
    if(ri%2===1)doc.rect(x,y,total,rh).fill(COLORS.soft);
    doc.strokeColor(COLORS.line).lineWidth(.6).moveTo(x,y+rh).lineTo(x+total,y+rh).stroke();
    let xx2=x;
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.8).text(safe(row.lokasi),xx2+10,y+9,{width:widths[0]-16,height:12,lineBreak:false,ellipsis:true});xx2+=widths[0];
    doc.fillColor(COLORS.green).font('Helvetica-Bold').fontSize(8.4).text(String(row.psb||0),xx2+10,y+8,{width:widths[1]-16,align:'center',height:13,lineBreak:false,ellipsis:true});xx2+=widths[1];
    doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(8.4).text(String(row.off||0),xx2+10,y+8,{width:widths[2]-16,align:'center',height:13,lineBreak:false,ellipsis:true});xx2+=widths[2];
    doc.fillColor(COLORS.green).font('Helvetica-Bold').fontSize(7.8).text(String(row.bayar||0),xx2+10,y+9,{width:widths[3]-16,align:'center',height:12,lineBreak:false,ellipsis:true});xx2+=widths[3];
    doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(7.8).text(String(row.belumBayar||0),xx2+10,y+9,{width:widths[4]-16,align:'center',height:12,lineBreak:false,ellipsis:true});
    doc.restore();doc.y=y+rh;
  });
  doc.y+=18;
}
function money(v){const n=Number(v);return Number.isFinite(n)?Math.round(n):0;}
// v2.8 — rincian kategori (mis. di bawah "Pengeluaran") dulu digabung jadi
// satu baris `A Rp.. · B Rp.. · C Rp..` lalu dipotong paksa (ellipsis) begitu
// kepanjangan — hasilnya angka terakhir kepotong di tengah ("Lain-lain
// Rp..."), bukan cuma teksnya yang dipendekkan. Sekarang: ukur lebar teks
// yang sebenarnya (nama kategori bisa panjang, mis. "Liability / Kewajiban"),
// tampilkan sebanyak yang muat secara utuh, sisanya dijumlah jadi satu
// ringkasan "+N lainnya Rp x" — jadi tidak pernah kepotong di tengah kata
// atau di tengah angka.
function summarizeCategoryBreakdown(doc,cats,availWidth,fontSize=6.7,font='Helvetica'){
  if(!cats.length)return'';
  const sep=' · ';doc.save();doc.font(font).fontSize(fontSize);
  let shown=[];
  for(let i=0;i<cats.length;i++){
    const trial=cats.slice(0,i+1),remaining=cats.length-trial.length;
    const restSum=remaining>0?cats.slice(trial.length).reduce((a,[,v])=>a+v,0):0;
    const tail=remaining>0?`${sep}+${remaining} lainnya ${rupiah(restSum)}`:'';
    const text=trial.map(([k,v])=>`${k} ${rupiah(v)}`).join(sep)+tail;
    if(doc.widthOfString(text)<=availWidth){shown=trial;}
    else{if(shown.length===0)shown=trial;break;}
  }
  doc.restore();
  const remaining=cats.length-shown.length,restSum=remaining>0?cats.slice(shown.length).reduce((a,[,v])=>a+v,0):0;
  const mainText=shown.map(([k,v])=>`${k} ${rupiah(v)}`).join(sep);
  return remaining>0?`${mainText}${sep}+${remaining} lainnya ${rupiah(restSum)}`:mainText;
}
function createClosingReportPdf(res,{title,subtitle,filename,recipientName='',summaryItems=[],blocks=[],adjustmentRows=[],transactionRows=[],customerActivityRows=[],disposition='attachment',watermark=''}){
  const doc=new PDFDocument({size:'A4',layout:'portrait',margins:{top:36,bottom:42,left:36,right:36},bufferPages:true,info:{Title:safe(title),Author:COMPANY,Subject:safe(subtitle||'')}});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`${disposition==='inline'?'inline':'attachment'}; filename="${String(filename).replace(/[\r\n"]/g,'-')}"`);
  doc.pipe(res);
  drawBrandHeader(doc,title,subtitle,false);
  drawSummary(doc,summaryItems);
  drawLocationShareCards(doc,recipientName,blocks,title,subtitle);
  drawCustomerActivityTable(doc,customerActivityRows,title,subtitle);
  drawAdjustmentTable(doc,adjustmentRows,title,subtitle);
  drawTransactionTable(doc,transactionRows,title,subtitle);
  drawReportSignoff(doc);
  drawWatermarkOnAllPages(doc,watermark);
  drawFooterOnAllPages(doc);
  doc.end();
}
// v1.28 — kotak tanda tangan opsional (mis. tanda terima setoran cash: Diserahkan / Diterima).
function drawSignatureBoxes(doc,signatures){if(!signatures||!signatures.length)return;const x=doc.page.margins.left,total=doc.page.width-doc.page.margins.left-doc.page.margins.right,gap=18,w=(total-gap*(signatures.length-1))/signatures.length,h=74;if(doc.y+h+24>doc.page.height-doc.page.margins.bottom)doc.addPage();doc.y+=14;const y=doc.y;signatures.forEach((sig,i)=>{const bx=x+i*(w+gap);doc.save();doc.roundedRect(bx,y,w,h,9).lineWidth(.8).stroke(COLORS.line);doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.8).text(safe(String(sig.label||'').toUpperCase()),bx+12,y+10,{width:w-24,height:10,ellipsis:true,lineBreak:false,characterSpacing:.6});doc.strokeColor(COLORS.line).lineWidth(.7).moveTo(bx+12,y+h-26).lineTo(bx+w-12,y+h-26).stroke();doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.6).text(safe(sig.name||'(..............................)'),bx+12,y+h-20,{width:w-24,height:10,align:'center',ellipsis:true,lineBreak:false});doc.restore();});doc.y=y+h+4;}
function createReportPdf(res,{title,subtitle,filename,summaryItems=[],columns=[],rows=[],disposition='attachment',layout=null,watermark='',signatures=[]}){const resolvedLayout=layout||((columns.length>=6)?'landscape':'portrait');const doc=new PDFDocument({size:'A4',layout:resolvedLayout,margins:{top:36,bottom:42,left:36,right:36},bufferPages:true,info:{Title:safe(title),Author:COMPANY,Subject:safe(subtitle||'')}});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`${disposition==='inline'?'inline':'attachment'}; filename="${String(filename).replace(/[\r\n"]/g,'-')}"`);doc.pipe(res);drawBrandHeader(doc,title,subtitle,false);drawSummary(doc,summaryItems);drawTable(doc,columns,rows,title,subtitle);drawSignatureBoxes(doc,signatures);drawReportSignoff(doc);drawWatermarkOnAllPages(doc,watermark);drawFooterOnAllPages(doc);doc.end();}

function createCorporateInvoicePdf(res,{invoice,bank=null,payments=[],branding={},filename,disposition='inline',language='id'}){
  const x=invoice,rawCompany=String(branding.companyName||COMPANY).trim(),company=/^PT(?:\.|\s)/i.test(rawCompany)?rawCompany:`PT ${rawCompany}`,tagline=branding.tagline||TAGLINE,footer=branding.footer||'Dokumen digital resmi. Tidak memerlukan tanda tangan basah.';
  const companyDetails=[branding.address,branding.phone?`Tel. ${branding.phone}`:null,branding.email,branding.website,branding.taxId?`NPWP/ID Pajak: ${branding.taxId}`:null].filter(Boolean).join(' · ');
  // Tidak memakai margin aliran PDFKit: seluruh elemen ditempatkan absolut di satu kanvas A4.
  // Teks panjang selalu diberi height/ellipsis sehingga tidak pernah membuat halaman tambahan.
  const doc=new PDFDocument({autoFirstPage:false,bufferPages:true,info:{Title:`${language==='en'?'Invoice':'Faktur'} ${safe(x.invoice_number)}`,Author:safe(company)}});doc.addPage({size:'A4',margins:{top:0,bottom:0,left:0,right:0}});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`${disposition==='attachment'?'attachment':'inline'}; filename="${String(filename).replace(/[\r\n"]/g,'-')}"`);doc.pipe(res);
  // v2.6 — header sekarang putih + garis tipis (bukan lagi blok gelap penuh),
  // konsisten dengan drawBrandHeader() di laporan lain. Semua koordinat tetap
  // sama persis supaya layout satu-halaman-pas di bawahnya tidak bergeser.
  const W=doc.page.width,L=42,R=42,U=W-L-R,documentTitle=language==='en'?'INVOICE':'FAKTUR';doc.save();doc.rect(0,0,W,122).fill(COLORS.white);if(branding.logoFilePath&&fs.existsSync(branding.logoFilePath)){try{doc.image(branding.logoFilePath,L,28,{fit:[150,45],align:'left',valign:'center'});}catch{drawLogo(doc,L,28,150,45);}}else drawLogo(doc,L,28,150,45);doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(25).text(documentTitle,W-230,22,{width:188,height:31,align:'right',ellipsis:true});doc.fillColor(COLORS.purple).font('Helvetica-Bold').fontSize(8).text(safe(x.invoice_number),W-260,54,{width:218,height:11,align:'right',ellipsis:true});doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.3).text(safe(company),W-300,73,{width:258,height:11,align:'right',ellipsis:true});const contact=[branding.phone,branding.email].filter(Boolean).join(' · ');if(contact)doc.fillColor(COLORS.muted2).fontSize(6.2).text(safe(contact),W-320,91,{width:278,height:10,align:'right',ellipsis:true});doc.strokeColor(COLORS.line).lineWidth(1).moveTo(L,119).lineTo(W-R,119).stroke();doc.rect(L,119.6,34,1.6).fill(COLORS.purple);doc.restore();
  let y=146;doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.5).text('DITAGIHKAN KEPADA',L,y,{height:9,characterSpacing:.8});doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(12).text(safe(x.customer_name),L,y+15,{width:U*.52,height:31,lineGap:1,ellipsis:true});doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.2).text(safe(x.customer_code),L,y+51,{width:U*.52,height:9,ellipsis:true});doc.font('Helvetica').fontSize(7.2).text(safe(x.address||'-'),L,y+64,{width:U*.52,height:22,lineGap:1.5,ellipsis:true});doc.text(safe(x.phone||'-'),L,y+91,{width:U*.52,height:9,ellipsis:true});
  const bx=L+U*.58,bw=U*.42;doc.save();doc.roundedRect(bx,y,bw,86,9).fillAndStroke(COLORS.soft,COLORS.line);const meta=[['Tanggal Faktur',date(x.invoice_date)],['Jatuh Tempo',date(x.due_date)],['Periode',`${String(x.period_month).padStart(2,'0')}/${x.period_year}`],['Site / Cluster',`${safe(x.site_code)} / ${safe(x.cluster_name||'-')}`]];meta.forEach((m,i)=>{doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5).text(m[0],bx+12,y+11+i*18,{width:bw*.45,height:9,ellipsis:true});doc.fillColor(COLORS.black).font('Helvetica-Bold').fontSize(6.6).text(m[1],bx+bw*.46,y+11+i*18,{width:bw*.48,height:9,align:'right',ellipsis:true});});doc.restore();
  y+=111;doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7).text('RINCIAN LAYANAN',L,y,{characterSpacing:.8});y+=14;doc.save();doc.rect(L,y,U,30).fill(COLORS.soft);doc.strokeColor(COLORS.line).lineWidth(.8).moveTo(L,y+30).lineTo(L+U,y+30).stroke();const cols=[L+12,L+U*.61,L+U*.72,L+U*.98];doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.7).text('DESKRIPSI',cols[0],y+10,{width:U*.52});doc.text('QTY',cols[1],y+10,{width:U*.08,align:'center'});doc.text('HARGA',cols[2],y+10,{width:U*.24,align:'right'});doc.restore();y+=32;
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
