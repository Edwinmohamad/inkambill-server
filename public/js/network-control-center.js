(()=>{const root=document.querySelector('[data-network-control]');if(!root)return;
const data=JSON.parse(document.getElementById('networkControlData')?.textContent||'{}');
const scopeKey='inkamnet-network-scope';
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmtBps=v=>{v=Number(v||0);if(v>=1e9)return (v/1e9).toFixed(2)+' Gbps';if(v>=1e6)return (v/1e6).toFixed(1)+' Mbps';if(v>=1e3)return (v/1e3).toFixed(1)+' Kbps';return v+' bps'};
const validScope=s=>['KRW','KBG','CLM'].includes(String(s||'').toUpperCase())?String(s).toUpperCase():'';

const url=new URL(location.href);const urlScope=validScope(url.searchParams.get('site'));const saved=validScope(localStorage.getItem(scopeKey));
if(!urlScope&&saved){url.searchParams.set('site',saved);location.replace(url.pathname+url.search+url.hash);return;}
root.querySelectorAll('[data-site]').forEach(btn=>btn.addEventListener('click',()=>{const site=validScope(btn.dataset.site);localStorage.setItem(scopeKey,site);const next=new URL(location.href);if(site)next.searchParams.set('site',site);else next.searchParams.delete('site');location.href=next.pathname+next.search+next.hash;}));

const inspector=document.querySelector('[data-net-inspector]'),inspectorTitle=inspector?.querySelector('[data-inspector-title]'),inspectorBody=inspector?.querySelector('[data-inspector-body]');
function openInspector(title,html){if(!inspector)return;inspectorTitle.textContent=title;inspectorBody.innerHTML=html;inspector.setAttribute('aria-hidden','false');document.documentElement.classList.add('netws-inspector-open');}
function closeInspector(){if(!inspector)return;inspector.setAttribute('aria-hidden','true');document.documentElement.classList.remove('netws-inspector-open');}
document.querySelectorAll('[data-inspector-close]').forEach(x=>x.addEventListener('click',closeInspector));

function routerInspector(id){const r=(data.routers||[]).find(x=>Number(x.routerId)===Number(id));if(!r)return;
 const interfaces=(r.interfaces||[]).filter(i=>i.type!=='pppoe-in'&&i.type!=='pppoe-out');
 openInspector(r.name,`<div class="inspector-status"><i class="netws-state ${r.status==='online'?'up':'down'}"></i><b>${esc(String(r.status||'unknown').toUpperCase())}</b><span>${esc(r.siteCode||'-')}</span></div>
 <div class="inspector-kpis"><span><small>CPU</small><b>${esc(r.telemetry?.cpuPct??'-')}%</b></span><span><small>RAM</small><b>${esc(r.telemetry?.memory?.pct??'-')}%</b></span><span><small>WAN RX</small><b>${fmtBps(r.wan?.rxBps)}</b></span><span><small>WAN TX</small><b>${fmtBps(r.wan?.txBps)}</b></span></div>
 <div class="inspector-section"><small>DEVICE</small><p>${esc(r.telemetry?.board||'MikroTik')} · RouterOS ${esc(r.telemetry?.version||'-')}</p></div>
 <div class="inspector-section"><small>INTERFACES</small>${interfaces.slice(0,8).map(i=>`<div class="inspector-row"><span><i class="netws-state ${i.running&&!i.disabled?'up':'down'}"></i>${esc(i.name)}</span><em>↓ ${fmtBps(i.rxBps)} · ↑ ${fmtBps(i.txBps)}</em></div>`).join('')||'<p>No interface telemetry.</p>'}</div>
 <div class="inspector-actions"><a class="btn-tech primary" href="/network/infrastructure/detail">Open Deep Dive</a><a class="btn-tech" href="/routers">Configure</a></div>`);}
function oltInspector(id){const o=(data.olts||[]).find(x=>Number(x.id)===Number(id));if(!o)return;
 openInspector(o.name,`<div class="inspector-status"><i class="netws-state ${o.last_status==='online'?'up':o.last_status==='offline'?'down':''}"></i><b>${esc(String(o.last_status||'unknown').toUpperCase())}</b><span>${esc(o.site_code||'UNMAPPED')}</span></div>
 <div class="inspector-kpis"><span><small>ONU</small><b>${Number(o.onu_online||0)}/${Number(o.onu_total||0)}</b></span><span><small>OFFLINE</small><b>${Number(o.onu_offline||0)}</b></span><span><small>PON</small><b>${Number(o.pon_ports_used||0)}</b></span><span><small>AVG RX</small><b>${o.avg_rx==null?'—':Number(o.avg_rx).toFixed(2)}</b></span></div>
 <div class="inspector-section"><small>MANAGEMENT</small><p>${esc(o.vendor||'Unknown vendor')} · ${esc(o.management_ip||'No management IP')}</p></div>
 <div class="inspector-section"><small>PON HEALTH</small>${(o.ponPorts||[]).slice(0,8).map(p=>`<div class="inspector-row"><span>PON ${esc(p.ponPort)}</span><em>${Number(p.onuOnline||0)}/${Number(p.onuTotal||0)} · ${p.avgRx==null?'—':Number(p.avgRx).toFixed(2)+' dBm'}</em></div>`).join('')||'<p>No PON metadata.</p>'}</div>
 <div class="inspector-actions"><a class="btn-tech primary" href="/network/infrastructure/detail">Open Deep Dive</a><a class="btn-tech" href="/olt">Configure</a></div>`);}
function subscriberInspector(id){const s=(data.subscribers||[]).find(x=>Number(x.id)===Number(id));if(!s)return;
 openInspector(s.name,`<div class="inspector-status"><i class="netws-state ${s.ppp_online?'up':'down'}"></i><b>${s.ppp_online?'PPPoE ONLINE':'PPPoE OFFLINE'}</b><span>${esc(s.site_code||'-')}</span></div>
 <div class="inspector-kpis"><span><small>PACKAGE</small><b>${esc(s.package_name||'-')}</b></span><span><small>ONT</small><b>${esc(String(s.ont_status||'unmapped').toUpperCase())}</b></span><span><small>RX</small><b>${s.rx_power==null?'—':Number(s.rx_power).toFixed(2)}</b></span><span><small>SIGNAL</small><b>${esc(String(s.signal_status||'unknown').toUpperCase())}</b></span></div>
 <div class="inspector-section"><small>PPPoE</small><p>${esc(s.pppoe_username||'No PPPoE username')} · ${esc(s.ppp_profile||'No profile')}</p></div>
 <div class="inspector-section"><small>ONT</small><p>${esc(s.serial_number||'No ONT mapping')} ${s.ssid?'· '+esc(s.ssid):''}</p></div>
 <div class="inspector-actions"><a class="btn-tech primary" href="/nms/secrets">PPPoE</a><a class="btn-tech" href="/acs">ONT</a></div>`);}
function incidentInspector(id){const a=(data.alerts||[]).find(x=>Number(x.id)===Number(id));if(!a)return;
 openInspector('Incident',`<div class="inspector-status"><i class="netws-severity ${esc(a.severity||'info')}"></i><b>${esc(String(a.severity||'info').toUpperCase())}</b><span>${esc(a.site_code||'NETWORK')}</span></div>
 <div class="inspector-section"><small>INCIDENT</small><h3>${esc(a.title||'Alert')}</h3><p>${esc(a.router_name||'System')}</p></div>
 <div class="inspector-section"><small>OPENED</small><p>${a.opened_at?new Date(a.opened_at).toLocaleString('id-ID'):'—'}</p></div>
 <div class="inspector-actions"><a class="btn-tech primary" href="/network/infrastructure/detail">Investigate</a></div>`);}

root.querySelectorAll('[data-inspect-router]').forEach(x=>x.addEventListener('click',()=>routerInspector(x.dataset.inspectRouter)));
root.querySelectorAll('[data-inspect-olt]').forEach(x=>x.addEventListener('click',()=>oltInspector(x.dataset.inspectOlt)));
root.querySelectorAll('[data-inspect-subscriber]').forEach(x=>x.addEventListener('click',()=>subscriberInspector(x.dataset.inspectSubscriber)));
root.querySelectorAll('[data-inspect-incident]').forEach(x=>x.addEventListener('click',()=>incidentInspector(x.dataset.inspectIncident)));

const command=document.querySelector('[data-network-command]'),input=command?.querySelector('[data-network-search-input]'),results=command?.querySelector('[data-network-search-results]');
const searchItems=[
 ...(data.subscribers||[]).map(x=>({type:'Customer',name:x.name,meta:`${x.site_code||''} · ${x.pppoe_username||''}`,run:()=>subscriberInspector(x.id)})),
 ...(data.routers||[]).map(x=>({type:'Router',name:x.name,meta:`${x.siteCode||''} · ${x.status||''}`,run:()=>routerInspector(x.routerId)})),
 ...(data.olts||[]).map(x=>({type:'OLT',name:x.name,meta:`${x.site_code||''} · ${x.management_ip||''}`,run:()=>oltInspector(x.id)})),
 ...(data.alerts||[]).map(x=>({type:'Incident',name:x.title,meta:`${x.site_code||''} · ${x.severity||''}`,run:()=>incidentInspector(x.id)})),
 ...(data.scopeOptions||[]).map(x=>({type:'Site',name:x.code,meta:x.name||'',run:()=>{localStorage.setItem(scopeKey,x.code);const u=new URL(location.href);u.searchParams.set('site',x.code);location.href=u.pathname+u.search;}}))
];
function renderSearch(q=''){if(!results)return;const needle=String(q).trim().toLowerCase();const rows=searchItems.filter(x=>!needle||(`${x.name} ${x.meta} ${x.type}`).toLowerCase().includes(needle)).slice(0,12);results.innerHTML=rows.map((x,i)=>`<button type="button" data-search-index="${searchItems.indexOf(x)}"><small>${esc(x.type)}</small><span><b>${esc(x.name)}</b><em>${esc(x.meta)}</em></span><i class="bi bi-arrow-return-left"></i></button>`).join('')||'<div class="netws-empty">No matching network object.</div>';results.querySelectorAll('[data-search-index]').forEach(b=>b.addEventListener('click',()=>{const item=searchItems[Number(b.dataset.searchIndex)];closeSearch();item?.run();}));}
function openSearch(){if(!command)return;command.setAttribute('aria-hidden','false');renderSearch('');setTimeout(()=>input?.focus(),20);}
function closeSearch(){if(!command)return;command.setAttribute('aria-hidden','true');if(input)input.value='';}
document.querySelector('[data-network-search]')?.addEventListener('click',openSearch);
document.querySelectorAll('[data-network-search-close]').forEach(x=>x.addEventListener('click',closeSearch));
input?.addEventListener('input',()=>renderSearch(input.value));
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();}if(e.key==='Escape'){closeSearch();closeInspector();}});
})();