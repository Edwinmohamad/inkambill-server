const fs=require('fs');
const read=file=>fs.readFileSync(file,'utf8');
const layout=read('views/partials/layout.ejs');
const css=read('public/css/mobile-app.css');
const js=read('public/js/mobile-app.js');
const common=read('middleware/common.js');
const app=read('app.js');
const clientJs=read('public/js/app.js');
const paymentModal=read('views/payments/_payment-modal.ejs');
const cashView=read('views/finance/cash.ejs');
const invoiceView=read('views/invoices/index.ejs');
const required=[
  [common,"/INKAMNET-GO\\//i",'server-side app detection'],
  [layout,"class=\"<%= isMobileApp?'inkamnet-go-app':'' %>\"",'app body class'],
  [layout,'go-bottom-nav','bottom navigation'],[layout,'goQuickSheet','quick action sheet'],
  [layout,'goMenu','full menu'],[layout,"if(can('billing'))",'permission-aware billing'],
  [css,'env(safe-area-inset-bottom)','safe-area support'],[css,'.go-menu-grid','menu grid'],
  [css,'@media(max-width:374px)','small-phone layout'],[css,'.go-primary-filter','visible list filter'],[js,"sessionStorage.setItem('inkamnet-go-cash-action'",'cash quick action'],[js,"heading.insertAdjacentElement('afterend',primaryFilter)",'filter moved above list content'],
  [app,"'public/css/mobile-app.css'",'mobile asset cache version'],
  [paymentModal,'payment-entry-body','scrollable payment modal body'],
  [paymentModal,'payment-save-button','visible payment submit action'],
  [css,'body.inkamnet-go-app.modal-open .go-bottom-nav','bottom navigation hidden behind modal'],
  [css,'height:calc(var(--go-viewport-height,100dvh) - 16px)','modal dynamic viewport height'],
  [css,'-webkit-overflow-scrolling:touch','touch scrolling for payment modal']
  ,[css,'body.inkamnet-go-app .modal-body{min-height:0','all APK modal bodies scroll']
  ,[css,'.go-menu-scroll{flex:1 1 auto;min-height:0','full menu has a bounded scroll area']
  ,[js,"window.addEventListener('popstate'",'Android back closes active overlays']
  ,[js,"window.addEventListener('pageshow'",'back-forward cache overlay recovery']
  ,[js,"window.visualViewport?.addEventListener('resize'",'keyboard-aware viewport sizing']
  ,[invoiceView,'class="invoice-row','invoice rows have APK card hooks']
  ,[invoiceView,'go-invoice-ref','invoice reference visible on APK card']
  ,[invoiceView,'go-invoice-action-button','mobile action button hook']
  ,[css,'body.inkamnet-go-app .invoice-table tr.invoice-row','invoice card layout']
  ,[css,'body.inkamnet-go-app .invoice-pay-button span{display:inline!important}','LUNAS label remains visible in APK']
  ,[css,'body.inkamnet-go-app .ink-action-popover{','mobile action bottom sheet']
  ,[css,'body.inkamnet-go-app .customer-bulk-bar{','bulk actions stay above APK bottom nav']
  ,[css,'body.inkamnet-go-app .closing-sticky-bar{','closing actions stay above APK bottom nav']
  ,[css,'body.inkamnet-go-app .operation-loader{','operation loader stays above APK bottom nav']
  ,[js,'a[target="_blank"]','target blank fallback in WebView']
  ,[js,'closeMobileActionPopovers','stale action popover recovery']
  ,[js,"document.addEventListener('shown.bs.modal'",'modal history integration']
  ,[cashView,'data-go-cash-open','stable quick cash action target']
  ,[js,"item.dataset.type===cashAction",'quick income/expense category selection']
  ,[clientJs,"delete form.dataset.filterSubmitting",'filter state recovery after Android back']
  ,[clientJs,"button.dataset.originalHtml",'submit button recovery after Android back']
  ,[css,'--go-type-meta:.6875rem','readable mobile metadata scale']
  ,[css,'--go-radius:12px','consistent mobile surface radius']
  ,[css,':where(a,button,input,select,textarea,[tabindex]):focus-visible','visible APK keyboard focus']
  ,[css,'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text"','native Apple-style font stack']
  ,[css,'--go-motion-fast:120ms','consistent mobile motion timing']
  ,[css,'--go-ease:cubic-bezier(.22,1,.36,1)','consistent mobile motion easing']
  ,[css,'.modal.fade .modal-dialog{transform:translateY(12px)','restrained modal entrance motion']
  ,[css,'.module-head h1{font-size:1.32rem!important;line-height:1.2;color:var(--go-ink)!important;font-weight:600!important}','stable APK heading weight']
  ,[css,'.status-badge.orange{color:#8a4b00!important}','readable warning status color']
  ,[js,"setTimeout(()=>link.classList.remove('go-tapped'),180)",'short tap feedback']
];
for(const [source,needle,label] of required)if(!source.includes(needle))throw new Error(`Mobile UI missing: ${label}`);
if(!/^body\.inkamnet-go-app/m.test(css))throw new Error('Mobile CSS is not scoped to the APK body.');
for(const match of css.matchAll(/font-size:\.(\d+)rem/g)){
  const size=Number(`0.${match[1]}`);
  if(size<.625)throw new Error(`Mobile UI contains unreadable font-size: ${match[0]}`);
}
for(const match of css.matchAll(/font-weight:(\d+)/g)){
  if(!['400','500','600','700'].includes(match[1]))throw new Error(`Mobile UI contains inconsistent font weight: ${match[0]}`);
}
if(/letter-spacing:(?!0(?:[;}]))/.test(css))throw new Error('Mobile UI contains non-zero letter spacing.');
console.log(`Mobile UI validation passed: ${required.length} shell, permission, responsive, and action checks.`);
