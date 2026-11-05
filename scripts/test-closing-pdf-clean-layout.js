'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const PDFDocument = require('pdfkit');
const { cleanClosingDescription } = require('../services/closingPdfText');
const { createClosingReportPdf, rupiah } = require('../services/reportPdf');

assert.equal(cleanClosingDescription('PTC_Teh_Pucuk_Internal · habis rapat RT · Data Kas (sinkron otomatis)'), 'Teh Pucuk Internal · habis rapat RT');
assert.equal(cleanClosingDescription('Router · Data Closing'), 'Router');
assert.equal(cleanClosingDescription('Kabel\n20 meter · Input manual'), 'Kabel\n20 meter');

const drawCalls = [];
const originalText = PDFDocument.prototype.text;
PDFDocument.prototype.text = function(text, x, y, options) {
  drawCalls.push({text:String(text),x,y,options,page:this._pageBuffer.length,width:this.widthOfString(String(text))});
  return originalText.apply(this, arguments);
};
const income = {kind:'entry',jenis:'Pendapatan',tanggal:'05 Nov 2026',lokasi:'CDS / KRW',keterangan:'Pembayaran pelanggan · Data Kas (sinkron otomatis)',nominal:52315000};
const expenses = Array.from({length:350}, (_,index) => ({kind:'entry',jenis:'Pengeluaran',tanggal:'27 Okt 2026',lokasi:index%2?'KBG':'CDS / KRW',keterangan:`PTC_Material_${index+1} · Data Kas (sinkron otomatis)`,nominal:25000+index}));
// Longer than a whole page: every line, including its final marker, must survive.
expenses[349].keterangan = Array.from({length:90},(_,i)=>`Rincian material nomor ${i+1}: kabel dan perangkat jaringan.`).join('\n') + '\nAKHIR RINCIAN MATERIAL';
const expenseTotal=expenses.reduce((sum,row)=>sum+row.nominal,0);
const rows=[{kind:'group',jenis:'Pendapatan',category:'Pembayaran pelanggan',count:1},income,{kind:'subtotal',jenis:'Pendapatan',category:'Pembayaran pelanggan',nominal:income.nominal},
  {kind:'group',jenis:'Pengeluaran',category:'Petty Cash',count:expenses.length},...expenses,{kind:'subtotal',jenis:'Pengeluaran',category:'Petty Cash',nominal:expenseTotal}];
const stream=new PassThrough();
stream.setHeader=()=>{};
const chunks=[];stream.on('data',chunk=>chunks.push(chunk));
stream.on('finish',()=>{
  PDFDocument.prototype.text=originalText;
  try {
    const pdf=Buffer.concat(chunks);
    assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
    const text=drawCalls.map(call=>call.text).join('\n');
    assert.doesNotMatch(text,/sinkron otomatis|singkron otomatis|Data Closing|Input manual|JANGAN TAMPILKAN HUTANG|HUTANG INTERNAL|DOKUMEN RESMI|CATATAN DOKUMEN/i);
    assert(text.includes('AKHIR RINCIAN MATERIAL'));
    assert(text.includes('TOTAL PENDAPATAN'));
    assert(text.includes('TOTAL PENGELUARAN'));
    assert(text.includes('SALDO BERSIH PERIODE'));
    assert(text.includes(rupiah(income.nominal-expenseTotal)));
    for(const number of ['343','344','345','350','351']) {
      const matches=drawCalls.filter(call=>call.text===number);
      assert(matches.length>=1,`missing row ${number}`);
      for(const call of matches) {
        assert(call.options.width>=call.width,`row number ${number} is wider than its column`);
        assert.equal(call.options.lineBreak,false);
      }
    }
    console.log('PASS Closing PDF: clean descriptions, intact three-digit numbering, complete long notes, exact net total, and no debt table.');
  } catch(error) {console.error(error);process.exitCode=1;}
});
try {
  createClosingReportPdf(stream,{title:'Closing Tim',subtitle:'Periode 01 Okt 2026 s/d 31 Okt 2026',filename:'closing.pdf',transactionRows:rows,
    internalDebtRows:[{name:'JANGAN TAMPILKAN HUTANG',opening:999,newAmount:999,paidInPeriod:0,balance:1998}],internalDebtSummary:{people:1}});
} catch(error) {
  PDFDocument.prototype.text=originalText;
  console.error(error);process.exitCode=1;
}
