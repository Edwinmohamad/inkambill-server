(()=>{
  'use strict';
  const body=document.body, menu=document.getElementById('goMenu'), quick=document.getElementById('goQuickSheet');
  const setOpen=(node,open)=>{if(!node)return;node.classList.toggle('open',open);node.setAttribute('aria-hidden',String(!open));body.classList.toggle('go-overlay-open',open);};
  document.querySelector('[data-go-menu-open]')?.addEventListener('click',()=>setOpen(menu,true));
  document.querySelector('[data-go-menu-close]')?.addEventListener('click',()=>setOpen(menu,false));
  document.querySelector('[data-go-quick-open]')?.addEventListener('click',()=>setOpen(quick,true));
  document.querySelectorAll('[data-go-sheet-close]').forEach(el=>el.addEventListener('click',()=>setOpen(quick,false)));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){setOpen(menu,false);setOpen(quick,false);}});
  document.querySelectorAll('[data-go-cash-action]').forEach(link=>link.addEventListener('click',()=>{
    sessionStorage.setItem('inkamnet-go-cash-action',link.dataset.goCashAction||'');
  }));
  const cashAction=sessionStorage.getItem('inkamnet-go-cash-action');
  if(location.pathname==='/cash'&&cashAction){
    sessionStorage.removeItem('inkamnet-go-cash-action');
    requestAnimationFrame(()=>{
      const add=[...document.querySelectorAll('button,a')].find(el=>/data kas|tambah/i.test(el.textContent||''));
      add?.click();
      setTimeout(()=>{
        const target=[...document.querySelectorAll('button,label,[role="button"]')].find(el=>new RegExp(cashAction==='expense'?'pengeluaran':'pemasukan','i').test(el.textContent||''));
        target?.click();
      },250);
    });
  }
  document.querySelectorAll('.go-menu a,.go-quick-grid a').forEach(link=>link.addEventListener('click',()=>{link.classList.add('go-tapped');}));
})();
