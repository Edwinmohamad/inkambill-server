const fs=require('node:fs'),assert=require('node:assert/strict');
const layout=fs.readFileSync('views/partials/layout.ejs','utf8');
const workspace=fs.readFileSync('views/network/workspace.ejs','utf8');
const network=fs.readFileSync('routes/network.js','utf8');

for(const route of ['/network','/network/subscribers','/network/infrastructure','/network/incidents']){
  assert(workspace.includes('href="'+route)||layout.includes('href="'+route),'primary navigation route missing: '+route);
}
for(const route of ["'/subscribers'","'/access'","'/devices'","'/incidents'","'/infrastructure'"]){
  assert(network.includes('router.get('+route),'compatibility route missing: '+route);
}
const sidebarStart=layout.indexOf('<div class="sidebar-section-label">NETWORK</div>');
assert(sidebarStart>=0,'NETWORK sidebar section missing');
const sidebarEnd=layout.indexOf('<div class="sidebar-section-label">SYSTEM</div>',sidebarStart);
const networkSidebar=layout.slice(sidebarStart,sidebarEnd);
assert(networkSidebar.includes('Network Operations'),'single Network Operations entry missing');
assert.equal((networkSidebar.match(/class="sidebar-link/g)||[]).length,1,'NETWORK sidebar must expose exactly one primary link');
for(const legacy of ['Subscribers</span>','Access / OLT</span>','Infrastructure</span>','Devices</span>','Incidents</span>','Configuration</span>']){
  assert(!networkSidebar.includes(legacy),'legacy top-level network item still exposed: '+legacy);
}
assert(workspace.includes('Customer ↔ PPPoE ↔ ONT'),'subscriber view must be customer-centric');
assert(workspace.includes('PPPoE Deep Dive')&&workspace.includes('ONT Deep Dive'),'subscriber deep-dive links must remain available');
assert(workspace.includes('Observe first. Configure when needed.'),'infrastructure must separate observe and configure intent');
assert(workspace.includes('href="/routers"')&&workspace.includes('href="/olt"'),'device configuration links must remain available');
assert(workspace.includes('data-scope-picker'),'persistent site scope must remain visible');
assert(workspace.includes('data-net-inspector')&&workspace.includes('data-network-command'),'inspector and command search must remain available');

assert(workspace.includes('ROOT CAUSE VIEW'),'incident root-cause view must remain available');
assert(workspace.includes('data-maintenance-form'),'maintenance workflow must remain available');
assert(workspace.includes('data-save-network-view')&&workspace.includes('data-network-favorites'),'saved views and favorites must remain available');
assert(network.includes("router.post('/api/maintenance'")&&network.includes("router.get('/api/config-drift'"),'maintenance and config drift APIs must remain available');

console.log('Network Control Center consolidation contract PASS');