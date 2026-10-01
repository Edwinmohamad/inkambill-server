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
