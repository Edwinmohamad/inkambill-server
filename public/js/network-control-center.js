(()=>{const root=document.querySelector('[data-network-control]');if(!root)return;
const data=JSON.parse(document.getElementById('networkControlData')?.textContent||'{}');
const scopeKey='inkamnet-network-scope',savedKey='inkamnet-network-saved-views',favoriteKey='inkamnet-network-favorites';
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmtBps=v=>{v=Number(v||0);if(v>=1e9)return (v/1e9).toFixed(2)+' Gbps';if(v>=1e6)return (v/1e6).toFixed(1)+' Mbps';if(v>=1e3)return (v/1e3).toFixed(1)+' Kbps';return v+' bps'};
const validScope=s=>['KRW','KBG','CLM'].includes(String(s||'').toUpperCase())?String(s).toUpperCase():'';const scopeSuffix=data.scope?'?site='+encodeURIComponent(data.scope):'';
const readJson=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||'')||fallback}catch(_){return fallback}};
const writeJson=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch(_){}};
function savedViews(){return readJson(savedKey,[]).filter(x=>x&&x.href&&x.name).slice(0,8)}
function favorites(){return readJson(favoriteKey,[]).filter(x=>x&&x.key&&x.name).slice(0,12)}
function saveCurrentView(){const rows=savedViews(),name=(data.scope?data.scope+' · ':'')+(document.querySelector('.netws-tabs a.active span')?.textContent||'Network');const href=location.pathname+location.search;const next=[{name,href},...rows.filter(x=>x.href!==href)].slice(0,8);writeJson(savedKey,next);paintPersonal()}
function toggleFavorite(item){const rows=favorites(),exists=rows.some(x=>x.key===item.key);const next=exists?rows.filter(x=>x.key!==item.key):[item,...rows].slice(0,12);writeJson(favoriteKey,next);paintPersonal();return !exists}
function paintPersonal(){
 const views=root.querySelector('[data-saved-views]'),favs=root.querySelector('[data-network-favorites]');
 if(views)views.innerHTML=savedViews().map(x=>'<a href="'+esc(x.href)+'"><i class="bi bi-bookmark-fill"></i>'+esc(x.name)+'</a>').join('')||'<span class="netws-personal-empty">No saved view</span>';
 if(favs)favs.innerHTML=favorites().map(x=>'<a href="'+esc(x.href||'#')+'"><i class="bi bi-star-fill"></i>'+esc(x.name)+'</a>').join('')||'<span class="netws-personal-empty">No favorite object</span>';
}


const url=new URL(location.href);const urlScope=validScope(url.searchParams.get('site'));const saved=validScope(localStorage.getItem(scopeKey));
if(!urlScope&&saved){url.searchParams.set('site',saved);location.replace(url.pathname+url.search+url.hash);return;}
root.querySelectorAll('[data-site]').forEach(btn=>btn.addEventListener('click',()=>{const site=validScope(btn.dataset.site);localStorage.setItem(scopeKey,site);const next=new URL(location.href);if(site)next.searchParams.set('site',site);else next.searchParams.delete('site');location.href=next.pathname+next.search+next.hash;}));

const inspector=document.querySelector('[data-net-inspector]'),inspectorTitle=inspector?.querySelector('[data-inspector-title]'),inspectorBody=inspector?.querySelector('[data-inspector-body]');
function openInspector(title,html){if(!inspector)return;inspectorTitle.textContent=title;inspectorBody.innerHTML=html;inspector.setAttribute('aria-hidden','false');document.documentElement.classList.add('netws-inspector-open');}
function closeInspector(){if(!inspector)return;inspector.setAttribute('aria-hidden','true');document.documentElement.classList.remove('netws-inspector-open');}
function bindFavorite(){inspector?.querySelectorAll('[data-favorite-object]').forEach(btn=>btn.addEventListener('click',()=>{const active=toggleFavorite({key:btn.dataset.key,name:btn.dataset.name,href:btn.dataset.href});btn.innerHTML='<i class="bi bi-star'+(active?'-fill':'')+'"></i>'+(active?'Favorited':'Favorite');}));}
document.querySelectorAll('[data-inspector-close]').forEach(x=>x.addEventListener('click',closeInspector));

function routerInspector(id){const r=(data.routers||[]).find(x=>Number(x.routerId)===Number(id));if(!r)return;
 const interfaces=(r.interfaces||[]).filter(i=>i.type!=='pppoe-in'&&i.type!=='pppoe-out');
 openInspector(r.name,`<div class="inspector-status"><i class="netws-state ${r.status==='online'?'up':'down'}"></i><b>${esc(String(r.status||'unknown').toUpperCase())}</b><span>${esc(r.siteCode||'-')}</span></div>
 <div class="inspector-kpis"><span><small>CPU</small><b>${esc(r.telemetry?.cpuPct??'-')}%</b></span><span><small>RAM</small><b>${esc(r.telemetry?.memory?.pct??'-')}%</b></span><span><small>WAN RX</small><b>${fmtBps(r.wan?.rxBps)}</b></span><span><small>WAN TX</small><b>${fmtBps(r.wan?.txBps)}</b></span></div>
 <div class="inspector-section"><small>DEVICE</small><p>${esc(r.telemetry?.board||'MikroTik')} · RouterOS ${esc(r.telemetry?.version||'-')}</p></div>
 <div class="inspector-section"><small>INTERFACES</small>${interfaces.slice(0,8).map(i=>`<div class="inspector-row"><span><i class="netws-state ${i.running&&!i.disabled?'up':'down'}"></i>${esc(i.name)}</span><em>↓ ${fmtBps(i.rxBps)} · ↑ ${fmtBps(i.txBps)}</em></div>`).join('')||'<p>No interface telemetry.</p>'}</div>
 <div class="inspector-actions"><button class="btn-tech" type="button" data-favorite-object data-key="router:${Number(r.routerId)}" data-name="${esc(r.name)}" data-href="/network/infrastructure${scopeSuffix}"><i class="bi bi-star"></i>Favorite</button><a class="btn-tech primary" href="/network/infrastructure/detail${scopeSuffix}">Open Deep Dive</a><a class="btn-tech" href="/routers">Configure</a></div>`);bindFavorite();}
function oltInspector(id){const o=(data.olts||[]).find(x=>Number(x.id)===Number(id));if(!o)return;
 openInspector(o.name,`<div class="inspector-status"><i class="netws-state ${o.last_status==='online'?'up':o.last_status==='offline'?'down':''}"></i><b>${esc(String(o.last_status||'unknown').toUpperCase())}</b><span>${esc(o.site_code||'UNMAPPED')}</span></div>
 <div class="inspector-kpis"><span><small>ONU</small><b>${Number(o.onu_online||0)}/${Number(o.onu_total||0)}</b></span><span><small>OFFLINE</small><b>${Number(o.onu_offline||0)}</b></span><span><small>PON</small><b>${Number(o.pon_ports_used||0)}</b></span><span><small>AVG RX</small><b>${o.avg_rx==null?'—':Number(o.avg_rx).toFixed(2)}</b></span></div>
 <div class="inspector-section"><small>MANAGEMENT</small><p>${esc(o.vendor||'Unknown vendor')} · ${esc(o.management_ip||'No management IP')}</p></div>
 <div class="inspector-section"><small>PON HEALTH</small>${(o.ponPorts||[]).slice(0,8).map(p=>`<div class="inspector-row"><span>PON ${esc(p.ponPort)}</span><em>${Number(p.onuOnline||0)}/${Number(p.onuTotal||0)} · ${p.avgRx==null?'—':Number(p.avgRx).toFixed(2)+' dBm'}</em></div>`).join('')||'<p>No PON metadata.</p>'}</div>
 <div class="inspector-actions"><button class="btn-tech" type="button" data-favorite-object data-key="olt:${Number(o.id)}" data-name="${esc(o.name)}" data-href="/network/infrastructure${scopeSuffix}"><i class="bi bi-star"></i>Favorite</button><a class="btn-tech primary" href="/network/infrastructure/detail${scopeSuffix}">Open Deep Dive</a><a class="btn-tech" href="/olt">Configure</a></div>`);bindFavorite();}
function subscriberInspector(id){const s=(data.subscribers||[]).find(x=>Number(x.id)===Number(id));if(!s)return;
 openInspector(s.name,`<div class="inspector-status"><i class="netws-state ${s.ppp_online?'up':'down'}"></i><b>${s.ppp_online?'PPPoE ONLINE':'PPPoE OFFLINE'}</b><span>${esc(s.site_code||'-')}</span></div>
 <div class="inspector-kpis"><span><small>PACKAGE</small><b>${esc(s.package_name||'-')}</b></span><span><small>ONT</small><b>${esc(String(s.ont_status||'unmapped').toUpperCase())}</b></span><span><small>RX</small><b>${s.rx_power==null?'—':Number(s.rx_power).toFixed(2)}</b></span><span><small>SIGNAL</small><b>${esc(String(s.signal_status||'unknown').toUpperCase())}</b></span></div>
 <div class="inspector-section"><small>PPPoE</small><p>${esc(s.pppoe_username||'No PPPoE username')} · ${esc(s.ppp_profile||'No profile')}</p></div>
 <div class="inspector-section"><small>ONT</small><p>${esc(s.serial_number||'No ONT mapping')} ${s.ssid?'· '+esc(s.ssid):''}</p></div>
 <div class="inspector-actions"><button class="btn-tech" type="button" data-favorite-object data-key="customer:${Number(s.id)}" data-name="${esc(s.name)}" data-href="/network/subscribers${scopeSuffix}"><i class="bi bi-star"></i>Favorite</button><a class="btn-tech primary" href="/customers/${Number(s.id)}">Customer</a><a class="btn-tech" href="/nms/secrets">PPPoE</a><a class="btn-tech" href="/acs">ONT</a><a class="btn-tech" href="/tickets?customer_id=${Number(s.id)}">Ticket</a></div>`);bindFavorite();}
function incidentInspector(id){const a=(data.alerts||[]).find(x=>Number(x.id)===Number(id));if(!a)return;
 openInspector('Incident',`<div class="inspector-status"><i class="netws-severity ${esc(a.severity||'info')}"></i><b>${esc(String(a.severity||'info').toUpperCase())}</b><span>${esc(a.site_code||'NETWORK')}</span></div>
 <div class="inspector-section"><small>INCIDENT</small><h3>${esc(a.title||'Alert')}</h3><p>${esc(a.router_name||'System')}</p></div>
 <div class="inspector-section"><small>OPENED</small><p>${a.opened_at?new Date(a.opened_at).toLocaleString('id-ID'):'—'}</p></div>
 <div class="inspector-actions"><a class="btn-tech primary" href="/network/infrastructure/detail${scopeSuffix}">Investigate</a></div>`);}

root.querySelectorAll('[data-inspect-router]').forEach(x=>x.addEventListener('click',()=>routerInspector(x.dataset.inspectRouter)));
root.querySelectorAll('[data-inspect-olt]').forEach(x=>x.addEventListener('click',()=>oltInspector(x.dataset.inspectOlt)));
root.querySelectorAll('[data-inspect-subscriber]').forEach(x=>x.addEventListener('click',()=>subscriberInspector(x.dataset.inspectSubscriber)));
root.querySelectorAll('[data-inspect-incident]').forEach(x=>x.addEventListener('click',()=>incidentInspector(x.dataset.inspectIncident)));

const command=document.querySelector('[data-network-command]'),input=command?.querySelector('[data-network-search-input]'),results=command?.querySelector('[data-network-search-results]');
const siteItems=(data.scopeOptions||[]).map(x=>({type:'Site',name:x.code,meta:x.name||'',href:(location.pathname||'/network')+'?site='+encodeURIComponent(x.code)}));
let searchSeq=0,searchTimer=null;
function paintSearch(rows=[]){if(!results)return;results.innerHTML=rows.map((x,i)=>`<button type="button" data-result-index="${i}"><small>${esc(x.type||'Object')}</small><span><b>${esc(x.name||'')}</b><em>${esc(x.meta||'')}</em></span><i class="bi bi-arrow-return-left"></i></button>`).join('')||'<div class="netws-empty">No matching network object.</div>';results.querySelectorAll('[data-result-index]').forEach(b=>b.addEventListener('click',()=>{const item=rows[Number(b.dataset.resultIndex)];if(!item)return;closeSearch();if(item.href)location.href=item.href;}));}
async function renderSearch(q=''){
  if(!results)return;
  const needle=String(q).trim();
  if(needle.length<2){paintSearch(siteItems);return;}
  const seq=++searchSeq;results.innerHTML='<div class="netws-empty">Searching network objects…</div>';
  try{
    const params=new URLSearchParams({q:needle});if(data.scope)params.set('site',data.scope);
    const r=await fetch('/network/api/control-search?'+params.toString(),{headers:{Accept:'application/json'}});
    const j=await r.json();if(seq!==searchSeq)return;
    paintSearch(j.ok?(j.results||[]):[]);
  }catch(_){if(seq===searchSeq)paintSearch([]);}
}
function openSearch(){if(!command)return;command.setAttribute('aria-hidden','false');renderSearch('');setTimeout(()=>input?.focus(),20);}
function closeSearch(){if(!command)return;command.setAttribute('aria-hidden','true');if(input)input.value='';}
document.querySelector('[data-network-search]')?.addEventListener('click',openSearch);
document.querySelectorAll('[data-network-search-close]').forEach(x=>x.addEventListener('click',closeSearch));
input?.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>renderSearch(input.value),140);});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();}if(e.key==='Escape'){closeSearch();closeInspector();}});

document.querySelector('[data-save-network-view]')?.addEventListener('click',()=>{saveCurrentView();const b=document.querySelector('[data-save-network-view]');if(b){const old=b.innerHTML;b.innerHTML='<i class="bi bi-check2"></i>Saved';setTimeout(()=>b.innerHTML=old,1200);}});
paintPersonal();

const csrf=document.querySelector('meta[name="csrf-token"]')?.content||'';
root.querySelector('[data-maintenance-form]')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,body=Object.fromEntries(new FormData(form).entries());const btn=form.querySelector('button[type="submit"]');if(btn)btn.disabled=true;try{const r=await fetch('/network/api/maintenance',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.error||'Maintenance gagal disimpan');location.reload();}catch(err){alert(err.message);}finally{if(btn)btn.disabled=false;}});
root.querySelectorAll('[data-cancel-maintenance]').forEach(btn=>btn.addEventListener('click',async()=>{if(!confirm('Batalkan maintenance ini?'))return;const r=await fetch('/network/api/maintenance/'+encodeURIComponent(btn.dataset.cancelMaintenance)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});const j=await r.json();if(j.ok)location.reload();else alert(j.error||'Gagal membatalkan maintenance');}));

const focusParams=new URLSearchParams(location.search);
const focus=Number(focusParams.get('focus')||0),focusRouter=Number(focusParams.get('focusRouter')||0),focusOlt=Number(focusParams.get('focusOlt')||0),focusIncident=Number(focusParams.get('focusIncident')||0);
if(focus)setTimeout(()=>subscriberInspector(focus),80);
else if(focusRouter)setTimeout(()=>routerInspector(focusRouter),80);
else if(focusOlt)setTimeout(()=>oltInspector(focusOlt),80);
else if(focusIncident)setTimeout(()=>incidentInspector(focusIncident),80);
})();