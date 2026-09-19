(()=>{
  if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
  const root=document.documentElement,button=document.querySelector('[data-lite-toggle]');
  const apply=value=>{root.classList.toggle('lite-mode',value);localStorage.setItem('inkamnet-lite-mode',value?'1':'0');if(button){button.classList.toggle('active',value);button.title=value?'Nonaktifkan Mode Ringan':'Aktifkan Mode Ringan';}};
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;apply(localStorage.getItem('inkamnet-lite-mode')==='1'||reduced);
  button?.addEventListener('click',()=>apply(!root.classList.contains('lite-mode')));
  document.querySelectorAll('img:not([loading])').forEach(img=>{if(!img.closest('#appLoader,.sidebar-brand,.avatar')){img.loading='lazy';img.decoding='async';}});
  document.querySelectorAll('form[method="get"] select').forEach(select=>select.addEventListener('change',()=>select.closest('.data-card,.filter-card')?.classList.add('partial-skeleton')));
  window.addEventListener('pageshow',()=>document.querySelectorAll('.partial-skeleton').forEach(el=>el.classList.remove('partial-skeleton')));
  if(location.pathname==='/noc'){const refresh=()=>fetch('/noc/api/summary',{headers:{Accept:'application/json'}}).then(r=>r.ok?r.json():Promise.reject()).then(data=>window.dispatchEvent(new CustomEvent('inkamnet:noc-summary',{detail:data}))).catch(()=>{});refresh();setInterval(refresh,30000);}
})();
