(() => {
  'use strict';
  const root=document.getElementById('performanceCenter');
  if(!root)return;
  root.querySelectorAll('[data-opc-auto] select').forEach(el=>el.addEventListener('change',()=>el.form.submit()));
  const links=[...root.querySelectorAll('.opc-tabs a')];
  const targets=links.map(a=>document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if('IntersectionObserver' in window){
    const obs=new IntersectionObserver(entries=>{
      const visible=entries.filter(x=>x.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
      if(!visible)return;
      links.forEach(a=>a.classList.toggle('active',a.getAttribute('href')===`#${visible.target.id}`));
    },{rootMargin:'-20% 0px -65% 0px',threshold:[.05,.2,.5]});
    targets.forEach(x=>obs.observe(x));
  }
  const boot=document.getElementById('opcBoot');
  if(!boot||typeof Chart==='undefined')return;
  let data={};try{data=JSON.parse(boot.textContent||'{}')}catch(_){}
  const trend=data.trend||[],canvas=document.getElementById('opcTrendChart');
  if(!canvas||!trend.length)return;
  new Chart(canvas,{type:'line',data:{labels:trend.map(x=>x.label),datasets:[{label:'Collection',data:trend.map(x=>x.collection),borderWidth:2,tension:.32,pointRadius:2},{label:'SLA',data:trend.map(x=>x.sla),borderWidth:2,tension:.32,pointRadius:2},{label:'Work',data:trend.map(x=>x.work),borderWidth:2,tension:.32,pointRadius:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:8,boxHeight:8,font:{size:9}}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${Number(c.raw||0)}%`}}},scales:{y:{min:0,max:100,ticks:{callback:v=>`${v}%`,font:{size:8}},grid:{color:'rgba(148,163,184,.08)'}},x:{ticks:{font:{size:8}},grid:{display:false}}}}});
})();

;(() => {
  const boot=document.getElementById('customerGrowthBoot');
  const canvas=document.getElementById('customerGrowthTrendChart');
  if(!boot||!canvas||typeof Chart==='undefined')return;
  let data={};try{data=JSON.parse(boot.textContent||'{}')}catch(_){}
  const rows=data.trend||[];if(!rows.length)return;
  new Chart(canvas,{
    type:'bar',
    data:{labels:rows.map(x=>x.label),datasets:[
      {label:'PSB',data:rows.map(x=>x.psb),borderRadius:5},
      {label:'Churn',data:rows.map(x=>x.churn),borderRadius:5},
      {label:'Net Growth',data:rows.map(x=>x.net),type:'line',borderWidth:2,tension:.28,pointRadius:3}
    ]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'bottom',labels:{boxWidth:8,boxHeight:8,font:{size:9}}}},
      scales:{x:{grid:{display:false},ticks:{font:{size:8}}},y:{beginAtZero:true,grid:{color:'rgba(148,163,184,.08)'},ticks:{precision:0,font:{size:8}}}}}
  });
})();

;(() => {
  const drawer=document.getElementById('opcLifecycleDrawer');
  const backdrop=document.getElementById('opcLifecycleBackdrop');
  const body=document.getElementById('opcLifecycleBody');
  const title=document.getElementById('opcLifecycleTitle');
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const close=()=>{if(!drawer)return;drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');if(backdrop)backdrop.hidden=true;};
  document.getElementById('opcLifecycleClose')?.addEventListener('click',close);
  backdrop?.addEventListener('click',close);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
  document.querySelectorAll('[data-lifecycle]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!drawer||!body)return;
    backdrop.hidden=false;drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');body.innerHTML='<div class="opc-empty compact">Memuat lifecycle…</div>';
    try{
      const r=await fetch(`/performance/customer/${encodeURIComponent(btn.dataset.lifecycle)}/lifecycle`,{headers:{Accept:'application/json'}});
      const j=await r.json();if(!j.ok)throw new Error(j.error||'Gagal memuat');
      title.textContent=`${j.data.customer.name} · ${j.data.customer.customer_code}`;
      body.innerHTML=(j.data.events||[]).map(x=>`<div class="opc-timeline-item"><i class="bi ${x.type==='PSB'?'bi-person-plus-fill':x.type==='TICKET'?'bi-life-preserver':x.type==='BILLING'?'bi-receipt':x.type==='RETENTION'?'bi-person-heart':'bi-arrow-left-right'}"></i><span><small>${esc(new Date(x.at).toLocaleString('id-ID'))} · ${esc(x.type)}</small><b>${esc(x.title)}</b><em>${esc(x.detail||'')}</em></span></div>`).join('')||'<div class="opc-empty compact">Belum ada lifecycle event.</div>';
    }catch(e){body.innerHTML=`<div class="opc-empty compact">${esc(e.message)}</div>`}
  }));
  document.querySelectorAll('[data-retention-action]').forEach(btn=>btn.addEventListener('click',()=>{
    const input=document.getElementById('opcRetentionCustomerId'),ttl=document.getElementById('opcRetentionActionTitle');
    if(input)input.value=btn.dataset.retentionAction||'';
    if(ttl)ttl.textContent=`Follow-up · ${btn.dataset.customerName||'Pelanggan'}`;
    const modal=document.getElementById('opcRetentionActionModal');
    if(modal&&window.bootstrap)bootstrap.Modal.getOrCreateInstance(modal).show();
  }));
})();
