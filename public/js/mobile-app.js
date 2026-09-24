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
    history.pushState({...(history.state||{}),inkamnetGoLayer:{kind:'overlay',id:node.id}},'',location.href);
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
    link.classList.add('go-tapped');setTimeout(()=>link.classList.remove('go-tapped'),800);
    const onLayer=layerState()?.kind==='overlay';
    closeAllOverlays({consumeHistory:false,restoreFocus:false});
    if(onLayer&&link.href){event.preventDefault();location.replace(link.href);}
    else clearLayerState();
  }));

  document.addEventListener('show.bs.modal',()=>closeAllOverlays({consumeHistory:false,restoreFocus:false}));
  document.addEventListener('shown.bs.modal',event=>{
    const modal=event.target;if(!modal?.classList.contains('modal'))return;
    if(layerState()?.kind!=='modal'||layerState()?.id!==modal.id)history.pushState({...(history.state||{}),inkamnetGoLayer:{kind:'modal',id:modal.id}},'',location.href);
  });
  document.addEventListener('hidden.bs.modal',event=>{
    const modal=event.target;if(layerState()?.kind==='modal'&&layerState()?.id===modal.id)history.back();
  });
  const updateViewport=()=>document.documentElement.style.setProperty('--go-viewport-height',`${Math.round(window.visualViewport?.height||window.innerHeight)}px`);
  updateViewport();window.visualViewport?.addEventListener('resize',updateViewport);window.addEventListener('orientationchange',()=>setTimeout(updateViewport,100));
  // Arriving (via Back) on an entry that was pushed for a modal/overlay — e.g. after a form in a
  // modal was submitted — skip it so one Back press returns to the previous screen.
  if(layerState())history.back();
  window.addEventListener('pageshow',event=>{if(!event.persisted)return;closeAllOverlays({consumeHistory:false,restoreFocus:false});if(layerState()){history.back();}document.querySelectorAll('.go-tapped').forEach(node=>node.classList.remove('go-tapped'));document.querySelectorAll('.modal.show').forEach(node=>{node.classList.remove('show');node.style.display='none';node.setAttribute('aria-hidden','true');});body.classList.remove('modal-open');body.style.removeProperty('overflow');body.style.removeProperty('padding-right');document.querySelectorAll('.modal-backdrop').forEach(node=>node.remove());});
})();
