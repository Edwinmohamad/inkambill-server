const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ejs=require('ejs');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const layout=read('views/partials/layout.ejs');
const workspace=read('views/network/workspace.ejs');
const routes=read('routes/network.js');

for(const [name,src,file] of [['layout',layout,'views/partials/layout.ejs'],['workspace',workspace,'views/network/workspace.ejs']]){
  assert.doesNotThrow(()=>ejs.compile(src,{filename:path.join(root,file)}),name+' EJS must compile');
}
assert(layout.includes('href="/network"'),'sidebar must expose Network Operations');
for(const href of ['/network','/network/subscribers','/network/infrastructure','/network/incidents']){
  assert(workspace.includes('href="'+href),'control center must expose '+href);
}
for(const route of ["router.get('/',","router.get('/subscribers'","router.get('/access'","router.get('/devices'","router.get('/incidents'","router.get('/infrastructure'"]){
  assert(routes.includes(route),'network route missing: '+route);
}
assert(routes.includes("res.redirect(302,`/network/infrastructure"),'legacy Access/Devices routes must redirect into Infrastructure');
assert(layout.includes('Billing Tools'),'secondary billing links should be collapsed');
assert(layout.includes("language==='en'?'OPERATIONS':'OPERASIONAL'"),'support and warehouse must share Operations');
assert(layout.includes('Gudang & Material'),'warehouse must be nested under Operations');
assert(!layout.includes('<span>NOC Dashboard</span>'),'old top-level NOC Dashboard menu should not return');
assert(!layout.includes('<span>Monitoring ONT</span>'),'old top-level ONT monitoring menu should not return');
assert(!layout.includes('<span>Kelola Perangkat</span>'),'old top-level unified device monitor should not return');
assert(layout.includes("currentPath!=='/network/infrastructure/wall'"),'NOC Wall must remain free of admin context navigation');
console.log('Network Control Center navigation contract PASS');