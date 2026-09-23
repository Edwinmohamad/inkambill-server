const fs=require('fs');
const read=file=>fs.readFileSync(file,'utf8');
const layout=read('views/partials/layout.ejs');
const css=read('public/css/mobile-app.css');
const js=read('public/js/mobile-app.js');
const common=read('middleware/common.js');
const app=read('app.js');
const paymentModal=read('views/payments/_payment-modal.ejs');
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
  [css,'height:calc(100dvh - 16px)','payment modal dynamic viewport height'],
  [css,'-webkit-overflow-scrolling:touch','touch scrolling for payment modal']
];
for(const [source,needle,label] of required)if(!source.includes(needle))throw new Error(`Mobile UI missing: ${label}`);
if(!/^body\.inkamnet-go-app/m.test(css))throw new Error('Mobile CSS is not scoped to the APK body.');
console.log(`Mobile UI validation passed: ${required.length} shell, permission, responsive, and action checks.`);
