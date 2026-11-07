const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict'),ejs=require('ejs');
const root=path.resolve(__dirname,'..'),common=require('../middleware/common');
const res={locals:{}};common({session:{user:{id:1,role:'master_admin',name:'Test'}},query:{},originalUrl:'/payments',path:'/payments',get:()=>''},res,()=>{});
const customer={id:1,name:'Pelanggan Contoh dengan Nama Panjang',customer_code:'KRW-15-001',customer_status:'active',phone:'081234567890',address:'Alamat pelanggan contoh',site_code:'KRW',cluster_name:'Cluster A',package_name:'Paket 20 Mbps',package_price:150000,due_day:15,pppoe_username:'pelanggan.001',router_name:'Router KRW'};
const data={...res.locals,assetVersion:'test',csrfToken:'test',isAdmin:true,isMasterAdmin:true,filters:{},payments:[{id:1,status:'pending',method:'transfer',amount:150000,paid_at:new Date(),invoice_number:'INV-001',customer_name:customer.name,customer_code:customer.customer_code,site_code:'KRW',invoice_id:1,period_month:11,period_year:2026,proof_path:'proof.svg',proof_mime:'image/svg+xml',invoice_outstanding:150000}],openInvoices:[],staff:[],banks:[],sites:[],clusters:[],cashApprovals:[],summary:{},missingProof:{},summaryMonth:11,summaryYear:2026,pagination:null,preselectedInvoiceId:null};
const render=(file,locals)=>ejs.renderFile(path.join(root,'views',file),locals);
let unmaps=0;
function shell(body,mobile){return `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="test"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/mobile-app.css"><link rel="stylesheet" href="/css/ui-coherence.css"><link rel="stylesheet" href="/css/operations-clean.css"></head><body class="${mobile?'inkamnet-go-app':''}"><main class="content-wrap"><div class="page-enter">${body}</div></main><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"></script>${mobile?'<script src="/js/mobile-app.js"></script>':''}</body></html>`;}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost'),mobile=url.searchParams.get('mobile')==='1';
 if(url.pathname==='/payments/1/proof'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1800"><rect width="900" height="1800" fill="white"/><text x="90" y="150" font-size="50">BUKTI TRANSFER CONTOH</text><text x="90" y="260" font-size="45">Rp150.000</text></svg>');}
 if(url.pathname.startsWith('/nms/api/')){
  let payload={ok:true};
  if(url.pathname.endsWith('/unmap')){unmaps++;payload.secretId=1;}
  else if(url.pathname.endsWith('/secrets'))payload={ok:true,rows:unmaps?[]:[{id:1,customer_id:1,customer_name:customer.name,customer_code:'KRW-001',username:'pelanggan.001',site_code:'KRW',site_id:1,router_name:'Router KRW',profile:'20M'}],page:1,pages:1,total:unmaps?0:1};
  else if(url.pathname.endsWith('/counts'))payload.counts={synced:unmaps?0:1,unsynced:unmaps?1:0,syncedPct:unmaps?0:100};
  else if(url.pathname.endsWith('/unlinked'))payload.rows=[];
  res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(payload));
 }
 if(url.pathname.startsWith('/css/')||url.pathname.startsWith('/js/')){const file=path.join(root,'public',url.pathname);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');return res.end(fs.readFileSync(file));}
 res.setHeader('Content-Type','text/html');
 if(url.pathname==='/customers/1')return res.end(await render('customers/_drawer.ejs',{...data,customer,invoices:[]}));
 if(url.pathname==='/proof')return res.end(shell(await render('payments/index.ejs',data),mobile));
 if(url.pathname==='/sync'){unmaps=0;return res.end(shell(await render('nms/secrets.ejs',{...data,siteId:null,canControl:true,isAdmin:true,nmsPage:'secrets',tab:'synced',routersOffline:0,focus:null,counts:{synced:1,unsynced:0,syncedPct:100}}),mobile));}
 const source=fs.readFileSync(path.join(root,'views/customers/index.ejs'),'utf8');const modal=source.slice(source.indexOf('<div class="modal" id="customerDetailPanel"'));
 return res.end(shell('<a href="/customers/1" data-customer-detail>Nama pelanggan</a>'+modal,mobile));
 }catch(e){res.statusCode=500;res.end(e.stack);}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();try{
 for(const width of [360,390,1366])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/**',route=>{
    const asset=route.request().url().split('/dist/')[1];
    return route.fulfill({path:require.resolve('bootstrap/dist/'+asset),contentType:asset.endsWith('.css')?'text/css':'application/javascript'});
  });
  const base='http://127.0.0.1:'+server.address().port,query='?mobile='+(width<768?1:0);
  for(const route of ['/drawer','/proof','/sync']){
   await page.goto(base+route+query);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   if(route==='/drawer'){
    await page.click('[data-customer-detail]');await page.waitForSelector('.customer-summary');
    const box=await page.locator('#customerDetailPanel .modal-content').boundingBox();assert(box.x>=0&&box.x+box.width<=width+1&&box.height<=850);
    assert.equal(await page.locator('.customer-summary-heading h3').textContent(),customer.name);
    if(process.env.MOBILE_SCREENSHOT_DIR&&width===390)await page.screenshot({path:path.join(process.env.MOBILE_SCREENSHOT_DIR,`revision-drawer-${theme}.png`)});
    await page.click('#customerDetailPanel .btn-close');
   }else if(route==='/proof'){
    await page.click('.proof-view-btn');await page.waitForSelector('#proofViewerModal.show');
    await page.waitForFunction(()=>document.getElementById('proofViewerImage').naturalWidth>0);
    const box=await page.locator('#proofViewerModal .modal-content').boundingBox();assert(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=851,JSON.stringify(box));
   }else{
    await page.waitForSelector('[data-act="unmap"]');assert.equal(await page.locator('[data-act="ping"], [data-label="Ping"]').count(),0);
    await page.click('[data-act="unmap"]');await page.click('.nx-sheet [data-ok]');await page.waitForFunction(()=>document.getElementById('tBody').textContent.includes('Belum ada secret'),{},{timeout:10000});assert.equal(unmaps,1);
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,route+' overflows '+width);
   if(process.env.MOBILE_SCREENSHOT_DIR&&width===390&&route!=='/drawer')await page.screenshot({path:path.join(process.env.MOBILE_SCREENSHOT_DIR,`revision-${route.slice(1)}-${theme}.png`)});
  }
  assert.deepEqual(errors,[]);console.log('PASS operations',width,theme);await page.close();
 }
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
