'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const root=path.join(__dirname,'..');
const layout=fs.readFileSync(path.join(root,'views/partials/layout.ejs'),'utf8');
assert.doesNotThrow(()=>ejs.compile(layout));
for(const link of ['/nms/secrets','/nms/insights','/routers'])assert(layout.includes('href="'+link+'"'),link);
const locals={assetVersion:'test',csrfToken:'test',siteId:1,sites:[{id:1,code:'KBG',name:'Kubang'}],canControl:true,isAdmin:true,nmsPage:'secrets',tab:'synced',counts:{synced:1,unsynced:0,total:1,online:1,offline:0,isolated:0,exempt:0,syncedPct:100,fasum:0,fasumOffline:0},packages:[],routersOffline:0,isolirProfile:'ISOLIR',isolirMode:'profile',focus:null};
for(const [page,nmsPage] of [['secrets','secrets'],['insights','insights'],['sync-history','history']]){
  const filename=path.join(root,'views/nms/'+page+'.ejs');
  const html=ejs.render(fs.readFileSync(filename,'utf8'),{...locals,nmsPage},{filename});
  assert(html.includes('/nms/secrets')&&html.includes('/nms/insights'));
  assert(!html.includes('/nms/wall'));
  assert(!html.includes('Traffic WAN')&&!html.includes('Kesehatan site')&&!html.includes('NOC Dashboard'));
}
assert(layout.includes('Billing Tools')&&layout.includes('Gudang & Material'),'billing/warehouse navigation must remain intact');
console.log('PASS network navigation: PPPoE, reconciliation and sync history render without monitoring links.');
