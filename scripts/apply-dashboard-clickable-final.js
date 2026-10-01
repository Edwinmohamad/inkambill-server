#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');

const ROOT=process.cwd();
const PKG=path.resolve(__dirname,'..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');

function die(m){console.error('[FAIL] '+m);process.exit(1);}
function read(rel){const p=path.join(ROOT,rel);if(!fs.existsSync(p))die('File tidak ditemukan: '+rel);return fs.readFileSync(p,'utf8');}
function one(src,from,to,label){
  if(!src.includes(from))die('Anchor tidak ditemukan: '+label+'. Patch dibatalkan sebelum file ditulis.');
  return src.replace(from,to);
}

let view=read('views/dashboard/index.ejs');
let layout=read('views/partials/layout.ejs');

if(!view.includes('data-bcc-summary-status="follow_up"')){
  view=one(view,
`      <article class="bcc-summary primary"><small>TERTAGIH</small><strong><%= formatRupiah(bc.summary.billedAmount||0) %></strong><span><%= Number(bc.summary.billedCustomers||0) %> pelanggan · <%= monthNames[billingMonth-1] %> <%= billingYear %></span></article>
      <article class="bcc-summary success"><small>TERKUMPUL</small><strong><%= formatRupiah(bc.summary.collectedAmount||0) %></strong><span><%= Number(bc.summary.paidCustomers||0) %> pelanggan lunas</span></article>
      <article class="bcc-summary warning"><small>FOLLOW UP</small><strong><%= Number(bc.actionCounts.follow_up||0)+Number(bc.actionCounts.due_today||0) %></strong><span>Perlu ditindaklanjuti</span></article>
      <article class="bcc-summary danger"><small>WAJIB ISOLIR</small><strong><%= Number(bc.actionCounts.must_isolate||0) %></strong><span>Lewat grace period</span></article>
      <article class="bcc-summary muted"><small>OUTSTANDING</small><strong><%= formatRupiah(bc.summary.outstandingAmount||0) %></strong><span><%= Number(bc.summary.openCustomers||0) %> pelanggan belum lunas</span></article>`,
`      <article class="bcc-summary primary" data-dashboard-href="/invoices?month=<%= billingMonth %>&year=<%= billingYear %><%= billingSiteCode?('&site='+encodeURIComponent(billingSiteCode)):'' %>" title="Buka seluruh tagihan periode ini"><small>TERTAGIH</small><strong><%= formatRupiah(bc.summary.billedAmount||0) %></strong><span><%= Number(bc.summary.billedCustomers||0) %> pelanggan · <%= monthNames[billingMonth-1] %> <%= billingYear %></span></article>
      <article class="bcc-summary success" data-dashboard-href="/payments?month=<%= billingMonth %>&year=<%= billingYear %><%= billingSiteCode?('&site='+encodeURIComponent(billingSiteCode)):'' %>" title="Buka pembayaran periode ini"><small>TERKUMPUL</small><strong><%= formatRupiah(bc.summary.collectedAmount||0) %></strong><span><%= Number(bc.summary.paidCustomers||0) %> pelanggan lunas</span></article>
      <article class="bcc-summary warning" data-bcc-summary-status="follow_up" title="Klik untuk filter pelanggan yang perlu follow-up"><small>FOLLOW UP</small><strong><%= Number(bc.actionCounts.follow_up||0)+Number(bc.actionCounts.due_today||0) %></strong><span>Perlu ditindaklanjuti</span></article>
      <article class="bcc-summary danger" data-bcc-summary-status="must_isolate" title="Klik untuk filter pelanggan wajib isolir"><small>WAJIB ISOLIR</small><strong><%= Number(bc.actionCounts.must_isolate||0) %></strong><span>Lewat grace period</span></article>
      <article class="bcc-summary muted" data-dashboard-href="/invoices?month=<%= billingMonth %>&year=<%= billingYear %>&status=open<%= billingSiteCode?('&site='+encodeURIComponent(billingSiteCode)):'' %>" title="Buka tagihan outstanding"><small>OUTSTANDING</small><strong><%= formatRupiah(bc.summary.outstandingAmount||0) %></strong><span><%= Number(bc.summary.openCustomers||0) %> pelanggan belum lunas</span></article>`,
'billing summary cards');

  view=one(view,
`      <div class="bcc-alert <%= Number(bc.actionCounts.must_isolate||0)>0?'danger':'clear' %>">`,
`      <div class="bcc-alert <%= Number(bc.actionCounts.must_isolate||0)>0?'danger':'clear' %>" data-bcc-alert-filter="must_isolate" title="Klik untuk tampilkan pelanggan wajib isolir">`,
'billing alert');

  view=one(view,
`    <article class="command-panel widget-collection-target">`,
`    <article class="command-panel widget-collection-target" data-dashboard-href="/collection-analysis?site=<%= selectedSiteCode %>&month=<%= selectedMonth %>&year=<%= selectedYear %>" title="Buka analisa collection">`,
'collection target widget');
}

if(!layout.includes('/js/dashboard-clickable-final.js')){
  layout=one(layout,
`  <script src="/js/app.js?v=<%= assetVersion %>"></script>`,
`  <script src="/js/app.js?v=<%= assetVersion %>"></script>
  <script src="/js/dashboard-clickable-final.js?v=<%= assetVersion %>"></script>
  <link rel="stylesheet" href="/css/dashboard-clickable-final.css?v=<%= assetVersion %>">`,
'layout assets');
}

// Only write after all anchors passed.
for(const [rel,data] of [['views/dashboard/index.ejs',view],['views/partials/layout.ejs',layout]]){
  const p=path.join(ROOT,rel);
  fs.copyFileSync(p,p+'.bak-'+stamp);
  fs.writeFileSync(p,data,'utf8');
  console.log('[PATCH]',rel);
}
for(const rel of ['public/js/dashboard-clickable-final.js','public/css/dashboard-clickable-final.css']){
  const src=path.join(PKG,rel),dst=path.join(ROOT,rel);
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  fs.copyFileSync(src,dst);
  console.log('[ADD]',rel);
}

console.log('\n[OK] Dashboard Clickable Final terpasang.');
console.log('Backup: *.bak-'+stamp);
console.log('\nValidasi:');
console.log('  node --check public/js/dashboard-clickable-final.js');
console.log('  npm run check');
console.log('  npm run validate:final');
