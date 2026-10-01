#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const ROOT=process.cwd(),PKG=path.resolve(__dirname,'..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
function die(m){console.error('\n[FAIL] '+m);process.exit(1)}
function read(rel){const p=path.join(ROOT,rel);if(!fs.existsSync(p))die('File tidak ditemukan: '+rel);return fs.readFileSync(p,'utf8')}
function replaceOnce(src,from,to,label){if(!src.includes(from))die('Anchor berubah/tidak ditemukan: '+label+' — patch berhenti sebelum menulis file.');return src.replace(from,to)}
function copy(rel){const s=path.join(PKG,rel),d=path.join(ROOT,rel);if(!fs.existsSync(s))die('Payload tidak lengkap: '+rel);fs.mkdirSync(path.dirname(d),{recursive:true});fs.copyFileSync(s,d)}

let app=read('app.js'),layout=read('views/partials/layout.ejs'),customers=read('routes/customers.js');

if(!app.includes("'public/css/performance-center.css'")){
  app=replaceOnce(app,"'public/css/wa-broadcast.css','public/js/app.js'","'public/css/wa-broadcast.css','public/css/performance-center.css','public/js/app.js'",'assetVersion CSS');
  app=replaceOnce(app,"'public/js/wa-inbox.js','public/js/wa-broadcast.js']","'public/js/wa-inbox.js','public/js/wa-broadcast.js','public/js/performance-center.js']",'assetVersion JS');
}
if(!app.includes("app.use('/performance'")) app=replaceOnce(app,"app.use('/analytics', requireAuth, requirePermission('finance'), require('./routes/analytics'));","app.use('/analytics', requireAuth, requirePermission('finance'), require('./routes/analytics'));\napp.use('/performance', requireAuth, requirePermission('dashboard'), require('./routes/performance'));",'mount route');

if(!layout.includes('href="/performance"')){
  layout=replaceOnce(layout,`<a class="sidebar-link <%= currentPath === '/' ? 'active' : '' %>" href="/"><i class="bi bi-grid-1x2-fill"></i><span><%= t('dashboard') %></span><em>⌘</em></a>`,`<a class="sidebar-link <%= currentPath === '/' ? 'active' : '' %>" href="/"><i class="bi bi-grid-1x2-fill"></i><span><%= t('dashboard') %></span><em>⌘</em></a>\n          <a class="sidebar-link <%= currentPath.startsWith('/performance') ? 'active' : '' %>" href="/performance"><i class="bi bi-activity"></i><span>Performance Center</span><em>NEW</em></a>`,'sidebar');
  layout=replaceOnce(layout,`<section><h3>Akun & Sistem</h3>`,`<section><h3>Performance</h3><div class="go-menu-grid"><a href="/performance"><i class="bi bi-activity"></i><span>Performance Center</span></a></div></section>\n      <section><h3>Akun & Sistem</h3>`,'mobile');
  layout=replaceOnce(layout,`<% if(can('customers')){ %><a href="/customers/new" data-keywords="pelanggan baru psb tambah">`,`<a href="/performance" data-keywords="performance kpi sla ticket psb churn growth site team operational"><i class="bi bi-activity"></i><div><strong>Performance Center</strong><small>KPI, growth, SLA, team & findings</small></div><span>→</span></a>\n        <% if(can('customers')){ %><a href="/customers/new" data-keywords="pelanggan baru psb tambah">`,'palette');
}

// Lifecycle hook: accurate off/reactivation/termination tracking from the moment V3 is installed.
if(!customers.includes("customerGrowthAnalysisService")){
  const firstRequire="const express=require('express');";
  customers=replaceOnce(customers,firstRequire,firstRequire+"\nconst { recordStatusChange }=require('../services/customerGrowthAnalysisService');",'customer growth import');
}
if(!customers.includes("recordStatusChange({customerId:")){
  const beforeAnchor="const [[before]]=await db.execute(`SELECT discount_id,customer_status FROM customers WHERE id=? LIMIT 1`,[req.params.id]);";
  customers=replaceOnce(customers,beforeAnchor,
    "const [[before]]=await db.execute(`SELECT discount_id,customer_status,site_id FROM customers WHERE id=? LIMIT 1`,[req.params.id]);",
    'customer before status/site');
  const commitAnchor="    await conn.commit();\n  }catch(e){await conn.rollback();throw e;}finally{conn.release();}";
  customers=replaceOnce(customers,commitAnchor,
    "    await conn.commit();\n  }catch(e){await conn.rollback();throw e;}finally{conn.release();}\n  if(before&&String(before.customer_status||'')!==String(b.customer_status||'')) await recordStatusChange({customerId:req.params.id,siteId:siteId||before.site_id,fromStatus:before.customer_status,toStatus:b.customer_status,userId:req.session.user.id,source:'customer_edit'});",
    'customer status history hook');
}

// All validation passed, now write.
for(const [rel,content] of Object.entries({'app.js':app,'views/partials/layout.ejs':layout,'routes/customers.js':customers})){
  const p=path.join(ROOT,rel);fs.copyFileSync(p,p+'.bak-'+stamp);fs.writeFileSync(p,content,'utf8');console.log('[PATCH]',rel);
}
for(const rel of ['routes/performance.js','services/operationalPerformanceService.js','services/performanceExecutionService.js','services/customerGrowthAnalysisService.js','views/performance/index.ejs','public/css/performance-center.css','public/js/performance-center.js']){copy(rel);console.log('[ADD/REPLACE]',rel)}

console.log('\n[OK] Performance Center V3 Customer Growth terpasang.');
console.log('Lifecycle history mulai tercatat dari patch ini.');
console.log('Backup source: *.bak-'+stamp);
console.log('\nValidasi:');
console.log('  node --check routes/performance.js');
console.log('  node --check routes/customers.js');
console.log('  node --check services/customerGrowthAnalysisService.js');
console.log('  node --check services/operationalPerformanceService.js');
console.log('  node --check services/performanceExecutionService.js');
console.log('  node --check public/js/performance-center.js');
console.log('  npm run check');
console.log('  npm run validate:final');
console.log('\nBuka: /performance#customerGrowth');
