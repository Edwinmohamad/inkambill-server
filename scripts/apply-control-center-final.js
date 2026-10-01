#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const pkgRoot = path.resolve(__dirname, '..');

function die(msg){ console.error('\n[FAIL] '+msg); process.exit(1); }
function read(rel){ const p=path.join(ROOT,rel); if(!fs.existsSync(p)) die('File tidak ditemukan: '+rel); return fs.readFileSync(p,'utf8'); }
function rep(src, find, value, label){
  if (typeof find === 'string') {
    if(!src.includes(find)) die('Anchor berubah/tidak ditemukan: '+label);
    return src.replace(find,value);
  }
  if(!find.test(src)) die('Anchor berubah/tidak ditemukan: '+label);
  return src.replace(find,value);
}
function cp(rel){ const src=path.join(pkgRoot,rel), dst=path.join(ROOT,rel); fs.mkdirSync(path.dirname(dst),{recursive:true}); fs.copyFileSync(src,dst); }

const files = {
  dashboardRoute: read('routes/dashboard.js'),
  dashboardView: read('views/dashboard/index.ejs'),
  layout: read('views/partials/layout.ejs'),
  paymentsRoute: read('routes/payments.js'),
  reconView: read('views/payments/reconciliation.ejs'),
  communication: read('routes/communication.js'),
  customersRoute: read('routes/customers.js'),
  customersView: read('views/customers/index.ejs'),
};

let o={...files};

// Dashboard workspace
if(!o.dashboardRoute.includes("buildWorkspace")){
  o.dashboardRoute=rep(o.dashboardRoute,
    "const { getBillingControlData } = require('../services/dashboardBillingControlService');",
    "const { getBillingControlData } = require('../services/dashboardBillingControlService');\nconst { buildWorkspace } = require('../services/workspaceService');",
    'dashboard import workspace');
  o.dashboardRoute=rep(o.dashboardRoute,
    "  res.render('dashboard/index',{\n    title:'Dashboard',",
    "  const workspace=buildWorkspace({user:req.session.user,permissions:req.permissions||[]});\n  res.render('dashboard/index',{\n    title:'Dashboard',workspace,",
    'dashboard render workspace');
}
if(!o.dashboardView.includes("workspace-final")){
  o.dashboardView = `<link rel="stylesheet" href="/css/control-center-final.css?v=<%= assetVersion %>">\n` + o.dashboardView;
}
if(!o.dashboardView.includes("_role-workspace")){
  o.dashboardView=rep(o.dashboardView,
    "  </div>\n\n  <div class=\"dashboard-user-ticker\"",
    "  </div>\n\n  <%- include('_role-workspace') %>\n\n  <div class=\"dashboard-user-ticker\"",
    'dashboard role partial');
}

// Global asset for clickable NMS KPI.
if(!o.layout.includes("/js/control-center-final.js")){
  o.layout=rep(o.layout,
    '  <script src="/js/app.js?v=<%= assetVersion %>"></script>',
    '  <script src="/js/app.js?v=<%= assetVersion %>"></script>\n  <script src="/js/control-center-final.js?v=<%= assetVersion %>"></script>\n  <link rel="stylesheet" href="/css/control-center-final.css?v=<%= assetVersion %>">',
    'layout control center assets');
}

// Reconciliation intelligence
if(!o.paymentsRoute.includes("getReconciliationIntelligence")){
  o.paymentsRoute=rep(o.paymentsRoute,
    "const { cashAgingDays, queuePaymentReceipts, streamSettlementReceipt }=require('../services/cashSettlementService');",
    "const { cashAgingDays, queuePaymentReceipts, streamSettlementReceipt }=require('../services/cashSettlementService');\nconst { getReconciliationIntelligence }=require('../services/reconciliationIntelligenceService');",
    'payments recon intelligence import');
  o.paymentsRoute=rep(o.paymentsRoute,
    "  const historyData=tab==='history'?await loadReconciliationHistory(req):{history:[],historySummary:{},settlements:[],historyLimit:RECON_HISTORY_LIMIT,dateFrom:'',dateTo:'',status:'all',basis:'paid'};\n  let justSettled=null;",
    "  const historyData=tab==='history'?await loadReconciliationHistory(req):{history:[],historySummary:{},settlements:[],historyLimit:RECON_HISTORY_LIMIT,dateFrom:'',dateTo:'',status:'all',basis:'paid'};\n  const reconciliationIntelligence=await getReconciliationIntelligence();\n  let justSettled=null;",
    'payments recon intelligence load');
  o.paymentsRoute=rep(o.paymentsRoute,
    "res.render('payments/reconciliation',{title:'Rekonsiliasi Pembayaran',...data,...historyData,tab,justSettled,canCancelSettlement:isMasterAdminRole(req.session.user.role)});",
    "res.render('payments/reconciliation',{title:'Rekonsiliasi Pembayaran',...data,...historyData,tab,justSettled,reconciliationIntelligence,canCancelSettlement:isMasterAdminRole(req.session.user.role)});",
    'payments recon intelligence render');
}
if(!o.reconView.includes("recon-intelligence")){
  const block = `
  <% if(typeof reconciliationIntelligence!=='undefined'&&reconciliationIntelligence){ const ri=reconciliationIntelligence; %>
  <section class="recon-intelligence" aria-label="Reconciliation Intelligence">
    <div class="recon-intelligence-head"><span>RECONCILIATION INTELLIGENCE</span><small>Deteksi operasional · 90 hari</small></div>
    <div class="recon-intelligence-grid">
      <div class="recon-intel-card ok"><small>Matched</small><b><%= ri.summary.matched %></b></div>
      <div class="recon-intel-card warn"><small>Unmatched</small><b><%= ri.summary.unmatched %></b></div>
      <div class="recon-intel-card danger"><small>Duplicate payment</small><b><%= ri.summary.duplicates %></b></div>
      <div class="recon-intel-card warn"><small>Nominal tidak sesuai</small><b><%= ri.summary.nominalMismatch %></b></div>
      <div class="recon-intel-card danger"><small>Payment tanpa invoice</small><b><%= ri.summary.orphanPayments %></b></div>
    </div>
    <% if(ri.suggestions.length){ %><div class="recon-suggestions"><% ri.suggestions.forEach(s=>{ %><a class="<%= s.tone %>" href="<%= s.href %>" title="<%= s.detail %>"><i class="bi bi-stars"></i> <%= s.title %></a><% }) %></div><% } %>
  </section>
  <% } %>
`;
  o.reconView=rep(o.reconView,
    "  <% if(justSettled){ %>",
    block+"\n  <% if(justSettled){ %>",
    'reconciliation intelligence UI');
}

// Notification center: enrich existing dynamic list, all queries fail-safe.
if(!o.communication.includes("safeNotificationRow")){
  o.communication=rep(o.communication,
    "const clean = (value, max) => String(value || '').trim().slice(0, max);",
    `const clean = (value, max) => String(value || '').trim().slice(0, max);
async function safeNotificationRow(sql,params=[]){
  try{const [rows]=await db.execute(sql,params);return rows[0]||{};}catch(_){return {};}
}`,
    'communication safe helper');

  const notificationBlock = `
  // Control Center Final — notification sources. Every source is fail-safe so an optional
  // table/column cannot break the header notification endpoint.
  if (permissions.has('network')) {
    const down=await safeNotificationRow(\`SELECT COUNT(*) total FROM routers WHERE is_active=1 AND COALESCE(last_status,'offline')<>'online'\`);
    if(Number(down.total)) dynamicNotifications.push({type:'router_down',icon:'bi-router-fill',tone:'danger',title:\`\${Number(down.total)} router tidak online\`,detail:'Buka NOC untuk cek reachability dan dampak pelanggan.',href:'/nms'});
  }
  if (permissions.has('billing') || permissions.has('support')) {
    const failedWa=await safeNotificationRow(\`SELECT COUNT(*) total FROM wa_messages WHERE status='failed' AND created_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR)\`);
    if(Number(failedWa.total)) dynamicNotifications.push({type:'wa_failed',icon:'bi-whatsapp',tone:'warning',title:\`\${Number(failedWa.total)} pesan WA gagal dalam 24 jam\`,detail:'Periksa gateway, nomor pelanggan, lalu retry yang aman.',href:'/wa-gateway/broadcast'});
  }
  if (permissions.has('finance') || permissions.has('billing')) {
    const debts=await safeNotificationRow(\`SELECT COUNT(*) total FROM finance_debts WHERE status='ACTIVE' AND due_date IS NOT NULL AND due_date<=DATE_ADD(CURDATE(),INTERVAL 3 DAY)\`);
    if(Number(debts.total)) dynamicNotifications.push({type:'debt_due',icon:'bi-journal-check',tone:'warning',title:\`\${Number(debts.total)} hutang/piutang mendekati atau lewat jatuh tempo\`,detail:'Prioritaskan pencatatan pembayaran dan follow-up.',href:'/debts'});
  }
  if (isMasterAdminRole(req.session.user.role)) {
    const mismatch=await safeNotificationRow(\`SELECT COUNT(*) total,COALESCE(SUM(ABS(difference_amount)),0) amount FROM cash_settlements WHERE ABS(COALESCE(difference_amount,0))>0 AND settlement_date>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)\`);
    if(Number(mismatch.total)) dynamicNotifications.push({type:'recon_difference',icon:'bi-exclamation-diamond-fill',tone:'danger',title:\`\${Number(mismatch.total)} setoran memiliki selisih rekonsiliasi\`,detail:\`Total selisih Rp\${Number(mismatch.amount||0).toLocaleString('id-ID')}\`,href:'/payments/reconciliation?tab=history'});
    const large=await safeNotificationRow(\`SELECT COUNT(*) total,COALESCE(SUM(amount),0) amount FROM payments WHERE status='confirmed' AND DATE(paid_at)=CURDATE() AND amount>=1000000\`);
    if(Number(large.total)) dynamicNotifications.push({type:'large_payment',icon:'bi-cash-coin',tone:'green',title:\`\${Number(large.total)} pembayaran besar masuk hari ini\`,detail:\`Total Rp\${Number(large.amount||0).toLocaleString('id-ID')}\`,href:'/payments'});
  }
`;
  o.communication=rep(o.communication,
    "\n  res.set('Cache-Control', 'no-store').json({",
    "\n"+notificationBlock+"\n  res.set('Cache-Control', 'no-store').json({",
    'communication dynamic notifications');
}

// Customer operational risk indicators
if(!o.customersRoute.includes("risk_overdue_count")){
  o.customersRoute=rep(o.customersRoute,
    "let sql=`SELECT c.*,s.code site_code",
    "let sql=`SELECT c.*,(SELECT COUNT(*) FROM invoices ri WHERE ri.customer_id=c.id AND ri.status IN ('unpaid','partial','overdue') AND ri.outstanding>0 AND ri.due_date<CURDATE()) risk_overdue_count,(SELECT COALESCE(MAX(DATEDIFF(CURDATE(),ri2.due_date)),0) FROM invoices ri2 WHERE ri2.customer_id=c.id AND ri2.status IN ('unpaid','partial','overdue') AND ri2.outstanding>0 AND ri2.due_date<CURDATE()) risk_days_late,(SELECT COUNT(*) FROM tickets rt WHERE rt.customer_id=c.id AND rt.status IN ('open','progress','pending')) risk_open_tickets,s.code site_code",
    'customer risk query');
}
if(!o.customersView.includes("customer-risk")){
  o.customersView=rep(o.customersView,
    "<th>Harga Paket</th><th>Kontak</th><th class=\"text-center\">Tindakan</th>",
    "<th>Harga Paket</th><th>Kontak</th><th>Prioritas</th><th class=\"text-center\">Tindakan</th>",
    'customer risk header');
  o.customersView=rep(o.customersView,
    "<% if(c.whatsapp_status!=='valid'){ %><span class=\"wa-validation-badge invalid\"><i class=\"bi bi-exclamation-octagon-fill\"></i>Format nomor tidak valid</span><% } %></td>\n        <td class=\"text-center customer-action-cell\">",
    `<% if(c.whatsapp_status!=='valid'){ %><span class="wa-validation-badge invalid"><i class="bi bi-exclamation-octagon-fill"></i>Format nomor tidak valid</span><% } %></td>
        <% const riskPoints=(Number(c.risk_days_late||0)>30?3:Number(c.risk_days_late||0)>7?2:Number(c.risk_days_late||0)>0?1:0)+(Number(c.risk_overdue_count||0)>0?2:0)+(c.network_status==='isolated'?2:0)+(c.whatsapp_status!=='valid'?1:0)+(Number(c.risk_open_tickets||0)>0?1:0); const riskLevel=riskPoints>=5?'priority':riskPoints>=2?'watch':'normal'; const riskText=riskLevel==='priority'?'Prioritas':riskLevel==='watch'?'Pantau':'Normal'; %>
        <td><span class="customer-risk <%= riskLevel %>" title="Overdue <%= Number(c.risk_overdue_count||0) %> · maksimal <%= Number(c.risk_days_late||0) %> hari · tiket aktif <%= Number(c.risk_open_tickets||0) %>"><i></i><%= riskText %></span></td>
        <td class="text-center customer-action-cell">`,
    'customer risk cell');
  o.customersView=o.customersView.replace('colspan="8"><div class="empty-state"', 'colspan="9"><div class="empty-state"');
}

// Write only after every required anchor has succeeded.
const changes = {
  'routes/dashboard.js': o.dashboardRoute,
  'views/dashboard/index.ejs': o.dashboardView,
  'views/partials/layout.ejs': o.layout,
  'routes/payments.js': o.paymentsRoute,
  'views/payments/reconciliation.ejs': o.reconView,
  'routes/communication.js': o.communication,
  'routes/customers.js': o.customersRoute,
  'views/customers/index.ejs': o.customersView,
};

for(const [rel,content] of Object.entries(changes)){
  const original=files[
    rel==='routes/dashboard.js'?'dashboardRoute':
    rel==='views/dashboard/index.ejs'?'dashboardView':
    rel==='views/partials/layout.ejs'?'layout':
    rel==='routes/payments.js'?'paymentsRoute':
    rel==='views/payments/reconciliation.ejs'?'reconView':
    rel==='routes/communication.js'?'communication':
    rel==='routes/customers.js'?'customersRoute':'customersView'
  ];
  if(content===original) continue;
  const p=path.join(ROOT,rel);
  fs.copyFileSync(p,`${p}.bak-${stamp}`);
  fs.writeFileSync(p,content,'utf8');
  console.log('[PATCH]',rel);
}

for(const rel of [
  'services/workspaceService.js',
  'services/reconciliationIntelligenceService.js',
  'views/dashboard/_role-workspace.ejs',
  'public/css/control-center-final.css',
  'public/js/control-center-final.js'
]) { cp(rel); console.log('[ADD]',rel); }

console.log('\n[OK] Control Center Final patch terpasang.');
console.log('Backup file lama memakai suffix .bak-'+stamp);
console.log('\nValidasi wajib:');
console.log('  npm run check');
console.log('  node --check services/workspaceService.js');
console.log('  node --check services/reconciliationIntelligenceService.js');
console.log('  node --check public/js/control-center-final.js');
console.log('  npm run validate:final');
console.log('\nFitur existing yang dipertahankan: NMS undo 5 detik, archive/restore customer, cancel settlement, bulk actions existing.');
