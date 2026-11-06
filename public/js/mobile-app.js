(()=>{
  'use strict';
  const body=document.body, menu=document.getElementById('goMenu'), quick=document.getElementById('goQuickSheet');
  const overlays=[menu,quick].filter(Boolean);
  const layerState=()=>history.state?.inkamnetGoLayer||null;
  const syncBody=()=>body.classList.toggle('go-overlay-open',overlays.some(node=>node.classList.contains('open')));
  const clearLayerState=()=>{const state={...(history.state||{})};delete state.inkamnetGoLayer;history.replaceState(state,'',location.href);};
  const closeOverlay=(node,{consumeHistory=true,restoreFocus=true}={})=>{
    if(!node?.classList.contains('open'))return;
    node.classList.remove('open');node.setAttribute('aria-hidden','true');syncBody();
    const focus=node._goReturnFocus;delete node._goReturnFocus;
    if(restoreFocus&&focus?.isConnected)focus.focus({preventScroll:true});
    if(consumeHistory&&layerState()?.kind==='overlay'&&layerState()?.id===node.id)history.back();
  };
  const closeAllOverlays=options=>overlays.forEach(node=>closeOverlay(node,options));
  const openOverlay=node=>{
    if(!node||node.classList.contains('open'))return;
    closeAllOverlays({consumeHistory:false,restoreFocus:false});
    node._goReturnFocus=document.activeElement;node.classList.add('open');node.setAttribute('aria-hidden','false');syncBody();
    const focus=node.querySelector('[data-go-menu-close],[data-go-sheet-close],a,button');focus?.focus({preventScroll:true});
    const state={...(history.state||{}),inkamnetGoLayer:{kind:'overlay',id:node.id}};
    if(layerState())history.replaceState(state,'',location.href);else history.pushState(state,'',location.href);
  };
  document.querySelector('[data-go-menu-open]')?.addEventListener('click',()=>openOverlay(menu));
  document.querySelector('[data-go-menu-close]')?.addEventListener('click',()=>closeOverlay(menu));
  document.querySelector('[data-go-quick-open]')?.addEventListener('click',()=>openOverlay(quick));
  document.querySelectorAll('[data-go-sheet-close]').forEach(el=>el.addEventListener('click',()=>closeOverlay(quick)));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeAllOverlays();});
  window.addEventListener('popstate',()=>{
    closeAllOverlays({consumeHistory:false});
    const shown=document.querySelector('.modal.show');
    if(shown&&window.bootstrap)bootstrap.Modal.getOrCreateInstance(shown).hide();
  });
  document.querySelectorAll('[data-go-cash-action]').forEach(link=>link.addEventListener('click',()=>{
    sessionStorage.setItem('inkamnet-go-cash-action',link.dataset.goCashAction||'');
  }));
  const cashAction=sessionStorage.getItem('inkamnet-go-cash-action');
  if(location.pathname==='/cash'&&cashAction){
    sessionStorage.removeItem('inkamnet-go-cash-action');
    requestAnimationFrame(()=>{
      const add=document.querySelector('[data-go-cash-open]');
      const applyType=()=>{const select=document.querySelector('#cashModal select[name="category_id"]');const option=[...select?.options||[]].find(item=>item.dataset.type===cashAction);if(option){select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));}};
      document.getElementById('cashModal')?.addEventListener('shown.bs.modal',applyType,{once:true});
      add?.click();setTimeout(applyType,350);
    });
  }
  // Put the primary list filter directly below the page title. On desktop these forms
  // keep their original location; in the APK users no longer scroll past KPI cards first.
  const page=document.querySelector('.page-enter');
  const heading=page?.querySelector('.module-head');
  const primaryFilter=page?.querySelector('.billing-filter-panel,.filter-card');
  if(heading&&primaryFilter){
    primaryFilter.classList.add('go-primary-filter');
    heading.insertAdjacentElement('afterend',primaryFilter);
  }
  // Menu/quick-sheet links replace the overlay history entry instead of stacking after it.
  // Previously the leftover entry meant Android Back had to be pressed twice to leave a page.
  document.querySelectorAll('.go-menu a,.go-quick-grid a').forEach(link=>link.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    link.classList.add('go-tapped');setTimeout(()=>link.classList.remove('go-tapped'),180);
    const onLayer=layerState()?.kind==='overlay';
    closeAllOverlays({consumeHistory:false,restoreFocus:false});
    if(onLayer&&link.href){event.preventDefault();location.replace(link.href);}
    else clearLayerState();
  }));

  // Android WebView is configured without multi-window support. Links that use target="_blank"
  // (invoice PDF, receipts, WhatsApp and several report actions) can otherwise look dead. Route the
  // click through the current WebView; trusted links stay in-app and external schemes/hosts are then
  // handed to MainActivity's safe navigation handler.
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[target="_blank"]');
    if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const href=link.href;if(!href)return;
    event.preventDefault();
    location.href=href;
  });

  // Keep row-action portals from surviving a bfcache restore or orientation change. A stale fixed
  // popover can cover the LUNAS button even though its source row is no longer visible.
  const closeMobileActionPopovers=()=>{
    document.querySelectorAll('.ink-action-popover:not([hidden])').forEach(node=>{node.hidden=true;node.style.removeProperty('visibility');});
    document.querySelectorAll('[data-action-popover-target][aria-expanded="true"]').forEach(node=>{node.setAttribute('aria-expanded','false');node.classList.remove('show');});
  };
  window.addEventListener('orientationchange',()=>setTimeout(closeMobileActionPopovers,80));

  document.addEventListener('show.bs.modal',event=>{
    closeAllOverlays({consumeHistory:false,restoreFocus:false});
    const modal=event.target;if(!modal?.classList.contains('modal'))return;
    const state={...(history.state||{}),inkamnetGoLayer:{kind:'modal',id:modal.id}};
    if(layerState())history.replaceState(state,'',location.href);else history.pushState(state,'',location.href);
  });
  document.addEventListener('hidden.bs.modal',event=>{
    const modal=event.target;if(layerState()?.kind==='modal'&&layerState()?.id===modal.id)history.back();
  });
  const updateViewport=()=>document.documentElement.style.setProperty('--go-viewport-height',`${Math.round(window.visualViewport?.height||window.innerHeight)}px`);
  updateViewport();window.visualViewport?.addEventListener('resize',updateViewport);window.addEventListener('orientationchange',()=>setTimeout(updateViewport,100));
  // Arriving (via Back) on an entry that was pushed for a modal/overlay — e.g. after a form in a
  // modal was submitted — skip it so one Back press returns to the previous screen.
  if(layerState())history.back();
  window.addEventListener('pageshow',event=>{if(!event.persisted)return;closeAllOverlays({consumeHistory:false,restoreFocus:false});closeMobileActionPopovers();if(layerState()){history.back();}document.querySelectorAll('.go-tapped').forEach(node=>node.classList.remove('go-tapped'));document.querySelectorAll('.modal.show').forEach(node=>{window.bootstrap?.Modal.getInstance(node)?.dispose();node.classList.remove('show');node.style.display='none';node.setAttribute('aria-hidden','true');node.removeAttribute('aria-modal');node.removeAttribute('role');});body.classList.remove('modal-open');body.style.removeProperty('overflow');body.style.removeProperty('padding-right');document.querySelectorAll('.modal-backdrop').forEach(node=>node.remove());});

  // (v1.35) Animasi angka berhitung naik dihapus: APK dibuat seringan mungkin untuk HP RAM 4 GB.
})();

// INKAMBILL A+ (APK): tabel lebar diubah menjadi kartu agar pas di layar HP — tidak perlu geser ke
// samping. Label tiap nilai diambil dari judul kolom tabel. Bila skrip ini gagal, tabel tetap tampil
// sebagai tabel geser seperti sebelumnya. Tambahkan class "go-no-cards" pada tabel untuk mengecualikan.
(()=>{
  const SKIP='.invoice-table,.go-no-cards';
  const text=el=>(el?el.textContent:'').replace(/\s+/g,' ').trim();
  const isSeq=t=>/^(no\.?|#|nomor)$/i.test(t);
  const isAct=t=>/^(aksi|actions?|opsi|tindakan)$/i.test(t);
  function cardify(table){
    if(table.matches(SKIP)||table.closest('.go-no-cards'))return;
    const head=table.tHead&&table.tHead.rows[0];if(!head)return;
    const labels=[];let col=0;
    for(const th of head.cells){const span=th.colSpan||1;for(let i=0;i<span;i++)labels[col++]=text(th);}
    for(const body of table.tBodies)for(const tr of body.rows){
      if(tr.dataset.goCard)continue;tr.dataset.goCard='1';
      let c=0,titled=false;
      for(const td of tr.cells){
        const t=labels[c]||'';c+=td.colSpan||1;
        if(tr.cells.length===1){td.dataset.goCell='full';continue;}
        const onlyCheck=!text(td)&&td.querySelector('input[type="checkbox"]');
        if(td.classList.contains('app-check-col')||onlyCheck){td.dataset.goCell='check';continue;}
        if(isSeq(t)||td.classList.contains('app-seq-col')){td.dataset.goCell='seq';continue;}
        if(isAct(t)||(!t&&td.querySelector('button,.action-pill,.action-menu'))){td.dataset.goCell='actions';continue;}
        if(!titled&&text(td)){td.dataset.goCell='title';titled=true;continue;}
        td.dataset.goCell='field';if(t)td.dataset.goLabel=t;else delete td.dataset.goLabel;
      }
    }
    table.classList.add('go-cards');
  }
  const run=()=>document.querySelectorAll('table.app-table,table.table').forEach(table=>{try{cardify(table);}catch(_){}});
  run();
  // Baris yang dimuat belakangan (AJAX) ikut diubah; hanya bereaksi bila ada baris/tabel baru.
  if(typeof MutationObserver!=='function')return;
  let queued=false;
  new MutationObserver(list=>{
    if(queued)return;
    if(!list.some(m=>[...m.addedNodes].some(n=>n.nodeType===1&&(n.matches('tr,table,tbody')||n.querySelector('tr')))))return;
    queued=true;requestAnimationFrame(()=>{queued=false;run();});
  }).observe(document.body,{childList:true,subtree:true});
})();

// INKAMBILL APK (v1.35): filter ringkas. Yang selalu tampil hanya kolom pencarian + tombol "Filter"
// (dengan jumlah filter aktif dari URL). Pilihan lain muncul dalam grid 2 kolom saat tombol disentuh.
(()=>{
  const params=typeof URLSearchParams==='function'?new URLSearchParams(location.search):{get:()=>''};
  document.querySelectorAll('form.go-primary-filter').forEach(form=>{
    const grid=form.querySelector('.filter-grid,.billing-filter-grid');if(!grid||form.dataset.goFilter)return;
    form.dataset.goFilter='1';form.classList.add('go-filter','go-filter-collapsed');
    const items=[...grid.children].filter(el=>el.nodeType===1&&el.tagName!=='INPUT');
    let search=null;
    for(const item of items){
      const isSearch=item.querySelector('.search-box,input[name="q"]');
      const isAction=!item.querySelector('select,input:not([type="hidden"]):not([type="submit"])')&&item.querySelector('button,.btn-tech');
      if(isSearch&&!search){search=item;item.classList.add('go-f-search');}
      else if(isAction)item.classList.add('go-f-actions');
      else item.classList.add('go-f-field');
    }
    const names=new Set([...form.querySelectorAll('.go-f-field [name]')].map(el=>el.name));
    const active=[...names].filter(n=>n&&(params.get(n)||'').trim()!=='').length;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='go-filter-toggle';toggle.setAttribute('aria-expanded','false');
    toggle.innerHTML='<i class="bi bi-sliders" aria-hidden="true"></i><span>Filter</span>'+(active?'<b>'+active+'</b>':'');
    toggle.addEventListener('click',()=>{const open=form.classList.toggle('go-filter-collapsed')===false;toggle.setAttribute('aria-expanded',String(open));});
    if(search)search.appendChild(toggle);else{const row=document.createElement('div');row.className='go-f-search';row.appendChild(toggle);grid.prepend(row);}
  });
})();

// Pencarian di lembar Menu (v1.35): saring tile berdasarkan nama, grup kosong disembunyikan.
(()=>{
  const input=document.querySelector('[data-go-menu-search]');if(!input)return;
  const menu=input.closest('.go-menu');const empty=menu.querySelector('.go-menu-empty');
  input.addEventListener('input',()=>{
    const q=input.value.trim().toLowerCase();let shown=0;
    menu.querySelectorAll('.go-menu-group').forEach(group=>{
      let n=0;group.querySelectorAll('.go-menu-grid>a').forEach(a=>{const hit=!q||a.textContent.toLowerCase().includes(q);a.hidden=!hit;if(hit)n++;});
      group.hidden=!n;shown+=n;
    });
    if(empty)empty.hidden=shown>0;
  });
})();
