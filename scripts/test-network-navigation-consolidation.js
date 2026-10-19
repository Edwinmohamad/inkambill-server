const fs=require('node:fs'),assert=require('node:assert/strict');
const layout=fs.readFileSync('views/partials/layout.ejs','utf8');
const workspace=fs.readFileSync('views/network/workspace.ejs','utf8');
const network=fs.readFileSync('routes/network.js','utf8');

for(const route of ["/network","/network/subscribers","/network/access","/network/infrastructure","/network/devices","/network/incidents"]){
  assert(workspace.includes(`href="${route}"`)||layout.includes(`href="${route}"`),`navigation route missing: ${route}`);
}
for(const route of ["'/subscribers'","'/access'","'/devices'","'/incidents'","'/infrastructure'"]){
  assert(network.includes(`router.get(${route}`),`network route missing: ${route}`);
}
const sidebarStart=layout.indexOf('<div class="sidebar-section-label">NETWORK</div>');
assert(sidebarStart>=0,'NETWORK sidebar section missing');
const sidebarEnd=layout.indexOf('<div class="sidebar-section-label">SYSTEM</div>',sidebarStart);
const networkSidebar=layout.slice(sidebarStart,sidebarEnd);
assert(networkSidebar.includes('Network Operations'),'single Network Operations entry missing');
assert.equal((networkSidebar.match(/class="sidebar-link/g)||[]).length,1,'NETWORK sidebar must expose exactly one primary link');
for(const legacy of ['Subscribers</span>','Access / OLT</span>','Infrastructure</span>','Devices</span>','Incidents</span>','Configuration</span>']){
  assert(!networkSidebar.includes(legacy),`legacy top-level network item still exposed: ${legacy}`);
}
assert(workspace.includes('Sessions & Secrets')&&workspace.includes('Subscriber Access'),'subscriber deep-dive links must remain available');
assert(workspace.includes('Router Registry')&&workspace.includes('OLT Registry'),'device configuration links must remain available');
console.log('Network navigation consolidation contract PASS');