#!/usr/bin/env node
'use strict';

const fs=require('fs'),path=require('path');
const ROOT=process.cwd(),PKG=path.resolve(__dirname,'..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const die=m=>{console.error('\n[FAIL] '+m);process.exit(1)};
const read=rel=>{const p=path.join(ROOT,rel);if(!fs.existsSync(p))die('File tidak ditemukan: '+rel);return fs.readFileSync(p,'utf8')};
const one=(src,from,to,label)=>{if(!src.includes(from))die('Anchor tidak ditemukan: '+label+' — tidak ada file yang ditulis.');return src.replace(from,to)};
const copy=rel=>{const s=path.join(PKG,rel),d=path.join(ROOT,rel);if(!fs.existsSync(s))die('Payload tidak lengkap: '+rel);fs.mkdirSync(path.dirname(d),{recursive:true});fs.copyFileSync(s,d)};

let app=read('app.js'),layout=read('views/partials/layout.ejs'),customers=read('routes/customers.js');

if(!app.includes("'public/css/performance-center.css'")){
  app=one(app,"'public/css/wa-broadcast.css','public/js/app.js'","'public/css/wa-broadcast.css','public/css/performance-center.css','public/js/app.js'",'asset css');
  app=one(app,"'public/js/wa-inbox.js','public/js/wa-broadcast.js']","'public/js/wa-inbox.js','public/js/wa-broadcast.js','public/js/performance-center.js']",'asset js');
}
if(!app.includes("app.use('/performance'")) app=one(app,"app.use('/analytics', requireAuth, requirePermission('finance'), require('./routes/analytics'));","app.use('/analytics', requireAuth, requirePermission('finance'), require('./routes/analytics'));\napp.use('/performance', requireAuth, requirePermission('dashboard'), require('./routes/performance'));",'performance mount');

if(!layout.includes('href="/performance"')){
  layout=one(layout,`<a class="sidebar-link <%= currentPath === '/' ? 'active' : '' %>" href="/"><i class="bi bi-grid-1x2-fill"></i><span><%= t('dashboard') %></span><em>⌘</em></a>`,`<a class="sidebar-link <%= currentPath === '/' ? 'active' : '' %>" href="/"><i class="bi bi-grid-1x2-fill"></i><span><%= t('dashboard') %></span><em>⌘</em></a>\n          <a class="sidebar-link <%= currentPath.startsWith('/performance') ? 'active' : '' %>" href="/performance"><i class="bi bi-activity"></i><span>Performance Center</span><em>NEW</em></a>`,'sidebar');
  layout=one(layout,`<section><h3>Akun & Sistem</h3>`,`<section><h3>Performance</h3><div class="go-menu-grid"><a href="/performance"><i class="bi bi-activity"></i><span>Performance Center</span></a></div></section>\n      <section><h3>Akun & Sistem</h3>`,'mobile');
}

// Lifecycle tracking hook for direct edit.
if(!customers.includes("customerGrowthAnalysisService")){
  customers=one(customers,"const express=require('express');","const express=require('express');\nconst { recordStatusChange }=require('../services/customerGrowthAnalysisService');",'growth service import');
}
if(!customers.includes("source:'customer_edit'")){
  customers=one(customers,
    "const [[before]]=await db.execute(`SELECT discount_id,customer_status FROM customers WHERE id=? LIMIT 1`,[req.params.id]);",
    "const [[before]]=await db.execute(`SELECT discount_id,customer_status,site_id,package_id FROM customers WHERE id=? LIMIT 1`,[req.params.id]);",
    'edit before state');
  customers=one(customers,
    "  const isolation = ['suspended','terminated'].includes(String(b.customer_status||'').toLowerCase()) && String(before?.customer_status||'') !== String(b.customer_status||'') ? await isolateAfterStatusChange(req.params.id,'customer_status') : { attempted:false };",
    "  if(before&&String(before.customer_status||'')!==String(b.customer_status||'')) await recordStatusChange({customerId:req.params.id,siteId:siteId||before.site_id,fromStatus:before.customer_status,toStatus:b.customer_status,userId:req.session.user.id,source:'customer_edit'});\n  const isolation = ['suspended','terminated'].includes(String(b.customer_status||'').toLowerCase()) && String(before?.customer_status||'') !== String(b.customer_status||'') ? await isolateAfterStatusChange(req.params.id,'customer_status') : { attempted:false };",
    'edit history hook');
}

// Archive lifecycle.
if(!customers.includes("source:'customer_archive'")){
  customers=one(customers,
    "const [rows]=await db.execute(`SELECT id,customer_code,name,customer_status FROM customers WHERE id=? LIMIT 1`,[req.params.id]);",
    "const [rows]=await db.execute(`SELECT id,customer_code,name,customer_status,site_id,package_id FROM customers WHERE id=? LIMIT 1`,[req.params.id]);",
    'archive state');
  customers=one(customers,
    "  await db.execute(`UPDATE customers SET status_changed_at=NOW(),customer_status='terminated',network_status='offline',archived_at=NOW() WHERE id=?`,[c.id]);",
    "  await db.execute(`UPDATE customers SET status_changed_at=NOW(),customer_status='terminated',network_status='offline',archived_at=NOW() WHERE id=?`,[c.id]);\n  if(String(c.customer_status)!=='terminated') await recordStatusChange({customerId:c.id,siteId:c.site_id,fromStatus:c.customer_status,toStatus:'terminated',userId:req.session.user.id,source:'customer_archive'});",
    'archive history hook');
}

// Restore lifecycle.
if(!customers.includes("source:'customer_restore'")){
  customers=one(customers,
    "const [rows]=await db.execute(`SELECT id,customer_code,name FROM customers WHERE id=? AND archived_at IS NOT NULL LIMIT 1`,[req.params.id]);",
    "const [rows]=await db.execute(`SELECT id,customer_code,name,customer_status,site_id,package_id FROM customers WHERE id=? AND archived_at IS NOT NULL LIMIT 1`,[req.params.id]);",
    'restore state');
  customers=one(customers,
    "  await db.execute(`UPDATE customers SET archived_at=NULL,customer_status='active',customer_source='restored',status_changed_at=NOW() WHERE id=?`,[c.id]);",
    "  await db.execute(`UPDATE customers SET archived_at=NULL,customer_status='active',customer_source='restored',status_changed_at=NOW() WHERE id=?`,[c.id]);\n  await recordStatusChange({customerId:c.id,siteId:c.site_id,fromStatus:c.customer_status||'terminated',toStatus:'active',userId:req.session.user.id,source:'customer_restore'});",
    'restore history hook');
}

// Validation complete; write now.
for(const [rel,content] of Object.entries({'app.js':app,'views/partials/layout.ejs':layout,'routes/customers.js':customers})){
  const p=path.join(ROOT,rel);fs.copyFileSync(p,p+'.bak-'+stamp);fs.writeFileSync(p,content,'utf8');console.log('[PATCH]',rel);
}
for(const rel of [
  'routes/performance.js','services/operationalPerformanceService.js','services/performanceExecutionService.js',
  'services/customerGrowthAnalysisService.js','services/customerRetentionService.js',
  'views/performance/index.ejs','public/css/performance-center.css','public/js/performance-center.js'
]){copy(rel);console.log('[ADD/REPLACE]',rel)}

console.log('\n[OK] Performance Center V4 Retention & Churn Intelligence terpasang.');
console.log('Backup source: *.bak-'+stamp);
console.log('\nValidasi:');
console.log('  node --check routes/performance.js');
console.log('  node --check routes/customers.js');
console.log('  node --check services/customerGrowthAnalysisService.js');
console.log('  node --check services/customerRetentionService.js');
console.log('  node --check services/operationalPerformanceService.js');
console.log('  node --check services/performanceExecutionService.js');
console.log('  node --check public/js/performance-center.js');
console.log('  npm run check');
console.log('  npm run validate:final');
console.log('\nBuka: /performance#retention');
