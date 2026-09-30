(function(){
  'use strict';
  const root=document.documentElement;
  function systemDark(){return !!(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)}
  function applyTheme(pref){
    const dark=pref==='dark'||(pref==='system'&&systemDark());
    root.dataset.theme=dark?'dark':'light';root.dataset.themePreference=pref;localStorage.setItem('fmt-theme',pref);
    const l=document.getElementById('themeLabel'),i=document.getElementById('themeIcon');
    if(l)l.textContent=pref==='system'?'System':pref[0].toUpperCase()+pref.slice(1);
    if(i)i.textContent=pref==='dark'?'☾':pref==='light'?'☀':'◐';
  }
  function toast(msg,type='good'){
    const h=document.getElementById('toastHost');if(!h)return;
    const x=document.createElement('div');x.className='toast '+type;x.textContent=msg;h.appendChild(x);setTimeout(()=>x.remove(),4200);
  }
  async function jsonPost(url,data){
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(data)});
    let j={};try{j=await r.json()}catch(_e){}
    if(!r.ok)throw new Error(j.detail||j.message||('Request failed '+r.status));return j;
  }
  function initCommon(){
    let pref=localStorage.getItem('fmt-theme')||'system';applyTheme(pref);
    document.getElementById('themeToggle')?.addEventListener('click',()=>{const a=['system','light','dark'];pref=a[(a.indexOf(pref)+1)%a.length];applyTheme(pref)});
    if(window.matchMedia)matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(pref==='system')applyTheme('system')});
    const sidebar=document.getElementById('sidebar'),overlay=document.getElementById('sidebarOverlay'),sideBtn=document.getElementById('sidebarToggle');
    const mobileSidebar=()=>window.matchMedia('(max-width:1024px)').matches;
    function toggleSidebar(){
      if(mobileSidebar()){sidebar?.classList.toggle('open');overlay?.classList.toggle('show');return}
      document.body.classList.toggle('sidebar-collapsed');
      const collapsed=document.body.classList.contains('sidebar-collapsed');
      localStorage.setItem('fmt-sidebar',collapsed?'collapsed':'expanded');
      root.classList.toggle('sidebar-precollapsed',collapsed);
    }
    if(!mobileSidebar()&&localStorage.getItem('fmt-sidebar')==='collapsed')document.body.classList.add('sidebar-collapsed');
    sideBtn?.addEventListener('click',toggleSidebar);overlay?.addEventListener('click',toggleSidebar);
    window.addEventListener('resize',()=>{if(!mobileSidebar()){sidebar?.classList.remove('open');overlay?.classList.remove('show')}});
    const profileBtn=document.getElementById('profileMenuBtn'),profileMenu=document.getElementById('profileMenu');
    profileBtn?.addEventListener('click',e=>{e.stopPropagation();const open=!profileMenu.hidden;profileMenu.hidden=open;profileBtn.setAttribute('aria-expanded',String(!open))});
    document.addEventListener('click',e=>{if(profileMenu&&!profileMenu.hidden&&!profileMenu.contains(e.target)&&e.target!==profileBtn){profileMenu.hidden=true;profileBtn?.setAttribute('aria-expanded','false')}});
    const notifyBtn=document.getElementById('notifyBtn'),notifyPanel=document.getElementById('notifyPanel');
    notifyBtn?.addEventListener('click',e=>{e.stopPropagation();const open=!notifyPanel.hidden;notifyPanel.hidden=open;notifyBtn.setAttribute('aria-expanded',String(!open));if(profileMenu&&!profileMenu.hidden){profileMenu.hidden=true;profileBtn?.setAttribute('aria-expanded','false')}});
    document.addEventListener('click',e=>{if(notifyPanel&&!notifyPanel.hidden&&!notifyPanel.contains(e.target)&&e.target!==notifyBtn){notifyPanel.hidden=true;notifyBtn?.setAttribute('aria-expanded','false')}});
    document.querySelectorAll('.nav-link').forEach(a=>{try{const u=new URL(a.href,location.origin),cur=new URL(location.href);let active=u.pathname===cur.pathname;if(active&&u.pathname==='/tickets'&&u.searchParams.get('type'))active=u.searchParams.get('type')===cur.searchParams.get('type');if(active)a.classList.add('active')}catch(_e){}});
    document.querySelectorAll('form[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!confirm(f.dataset.confirm))e.preventDefault()}));
    const modal=document.getElementById('commandModal'),btn=document.getElementById('commandBtn'),search=document.getElementById('commandSearch'),hints=modal?.querySelector('.command-hints');
    function openCmd(){if(!modal)return;modal.hidden=false;setTimeout(()=>search?.focus(),30)}function closeCmd(){if(modal)modal.hidden=true}
    btn?.addEventListener('click',openCmd);modal?.addEventListener('click',e=>{if(e.target===modal)closeCmd()});
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCmd()}if(e.key==='Escape')closeCmd()});
    let st;search?.addEventListener('input',()=>{clearTimeout(st);st=setTimeout(async()=>{const q=search.value.trim();if(q.length<2)return;try{const r=await fetch('/api/global-search?qtext='+encodeURIComponent(q),{cache:'no-store'});const j=await r.json();if(hints)hints.innerHTML=(j.results||[]).map(x=>`<a href="${x.url}"><b>${x.type}</b> ${x.title}<small>${x.meta||''}</small></a>`).join('')||'<span class="muted">No results</span>'}catch(_e){}},180)});
    const clock=document.getElementById('liveClock');if(clock){const tick=()=>{clock.textContent=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date())};tick();setInterval(tick,1000);}
    document.querySelectorAll('.sparkline').forEach(el=>{const vals=(el.dataset.values||'').split(',').filter(Boolean).map(Number);if(!vals.length)return;const max=Math.max(1,...vals);el.innerHTML='<svg viewBox="0 0 160 35" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="2" points="'+vals.map((v,i)=>`${i*(160/(vals.length-1||1))},${32-v/max*27}`).join(' ')+'"/></svg>'});
  }

  function initAttendanceUpload(){
    const form=document.getElementById('attendanceUploadForm');if(!form)return;
    const input=document.getElementById('attendancePdfInput'),drop=document.getElementById('attendanceDropzone'),list=document.getElementById('uploadFileList'),err=document.getElementById('uploadError'),btn=document.getElementById('attendanceUploadBtn'),progress=document.getElementById('uploadProgress'),bar=document.getElementById('uploadProgressBar'),txt=document.getElementById('uploadProgressText');
    const MAX=50*1024*1024;
    function human(n){if(n<1024*1024)return Math.max(1,Math.round(n/1024))+' KB';return (n/1024/1024).toFixed(1)+' MB'}
    function validate(files){const errors=[];for(const f of files){if(!/\.pdf$/i.test(f.name)||!['application/pdf','application/octet-stream',''].includes(f.type))errors.push(`${f.name}: PDF only`);if(f.size===0)errors.push(`${f.name}: file is empty`);if(f.size>MAX)errors.push(`${f.name}: exceeds 50 MB`)}return errors}
    function render(){const files=[...(input.files||[])];const errors=validate(files);if(err){err.hidden=!errors.length;err.textContent=errors.join(' • ')}if(list){list.hidden=!files.length;list.innerHTML=files.map(f=>`<div class="upload-file-item"><span class="file-icon">PDF</span><div><b title="${f.name.replace(/"/g,'&quot;')}">${f.name}</b><small>${human(f.size)}</small></div><span class="file-ok">${errors.some(e=>e.startsWith(f.name+':'))?'Check file':'Ready'}</span></div>`).join('')}if(btn)btn.disabled=!files.length||!!errors.length}
    input?.addEventListener('change',render);
    ['dragenter','dragover'].forEach(ev=>drop?.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('dragover')}));['dragleave','drop'].forEach(ev=>drop?.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('dragover')}));
    drop?.addEventListener('drop',e=>{if(!e.dataTransfer?.files?.length)return;const dt=new DataTransfer();[...e.dataTransfer.files].forEach(f=>dt.items.add(f));input.files=dt.files;render()});
    form.addEventListener('submit',e=>{
      e.preventDefault();const files=[...(input.files||[])],errors=validate(files);if(!files.length||errors.length){render();return}
      btn.disabled=true;btn.textContent='Uploading...';progress.hidden=false;bar.style.width='2%';txt.textContent=`Uploading ${files.length} PDF${files.length>1?'s':''}...`;
      const xhr=new XMLHttpRequest();xhr.open('POST',form.action,true);xhr.setRequestHeader('X-Requested-With','XMLHttpRequest');xhr.setRequestHeader('Accept','application/json');
      xhr.upload.onprogress=ev=>{if(ev.lengthComputable){const pct=Math.max(2,Math.min(96,Math.round(ev.loaded/ev.total*96)));bar.style.width=pct+'%';txt.textContent=`Uploading... ${pct}%`}};
      xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText||'{}')}catch(_e){}if(xhr.status>=200&&xhr.status<300&&data.redirect){bar.style.width='100%';txt.textContent=`${data.uploaded||files.length} PDF(s) uploaded. Opening signing workspace...`;setTimeout(()=>location.href=data.redirect,250);return}let msg=data.detail||data.message||'Upload failed. Please check the PDF files and try again.';if(xhr.status===401)msg='Session expired. Please sign in again.';err.hidden=false;err.textContent=msg;progress.hidden=true;btn.disabled=false;btn.textContent='Upload & Open Signing Workspace';toast(msg,'bad')};
      xhr.onerror=()=>{err.hidden=false;err.textContent='Network error while uploading. Check the connection to the server and try again.';progress.hidden=true;btn.disabled=false;btn.textContent='Upload & Open Signing Workspace';toast(err.textContent,'bad')};
      xhr.send(new FormData(form));
    });
    render();
  }

  function initSigning(){
    const ws=document.getElementById('signWorkspace');if(!ws)return;
    const pageImg=document.getElementById('pdfPageImage'),wrap=document.getElementById('pageWrap'),layer=document.getElementById('signatureLayer'),sigSel=document.getElementById('signatureSelect');
    const prevBtn=document.getElementById('prevPage'),nextBtn=document.getElementById('nextPage'),previewBtn=document.getElementById('previewExact'),signBtn=document.getElementById('signSelected');
    const pageJump=document.getElementById('pageJump'),pageTotal=document.getElementById('pageTotal'),viewport=document.getElementById('pdfViewport');
    let current=null,page=1,pages=1,previewVerified=false,dirty=false,navBusy=false,zoomMode='fit',zoomScale=.82;
    window.FMT_SIGNING=window.FMT_SIGNING||{placements:{},locks:{}};window.FMT_SIGNING.placements=window.FMT_SIGNING.placements||{};window.FMT_SIGNING.locks=window.FMT_SIGNING.locks||{};
    const selectChecks=()=>[...document.querySelectorAll('.doc-check:checked')].map(x=>Number(x.value));
    const sigById=id=>{const o=[...sigSel?.options||[]].find(x=>Number(x.value)===Number(id));return o&&o.value?{id:Number(o.value),src:o.dataset.src,name:o.dataset.name||o.textContent}:null};
    const currentSig=()=>sigById(sigSel?.value);
    const stateArr=(doc=current)=>window.FMT_SIGNING.placements[String(doc)]||window.FMT_SIGNING.placements[doc]||[];
    const pagePlacements=()=>stateArr().filter(x=>Number(x.page)===page);
    const setStateForDoc=(doc,arr)=>{window.FMT_SIGNING.placements[String(doc)]=arr};
    const lockRows=(doc=current)=>window.FMT_SIGNING.locks[String(doc)]||window.FMT_SIGNING.locks[doc]||[];
    const setLocksForDoc=(doc,arr)=>{window.FMT_SIGNING.locks[String(doc)]=arr||[]};
    const currentLock=()=>lockRows().find(x=>Number(x.target_page)===Number(page))||null;
    const currentLockTargets=()=>lockRows().filter(x=>Number(x.source_page)===Number(page)).map(x=>Number(x.target_page)).sort((a,b)=>a-b);
    function updateCount(){const n=selectChecks().length,c=document.getElementById('selectedCount'),q=document.getElementById('selectedQueueBadge');if(c)c.textContent=String(n);if(q)q.textContent=n+' selected';setNavState()}
    document.querySelectorAll('.doc-check').forEach(c=>c.addEventListener('change',updateCount));
    document.getElementById('selectAllDocs')?.addEventListener('change',e=>{document.querySelectorAll('.doc-check').forEach(c=>c.checked=e.target.checked);updateCount()});
    sigSel?.addEventListener('change',()=>{previewVerified=false;setNavState()});

    function nextSlot(sigId){const slots=pagePlacements().filter(x=>Number(x.signature_id)===Number(sigId)).map(x=>Number(x.placement_slot||1));document.querySelectorAll('.signature-box').forEach(b=>{if(Number(b.dataset.signatureId)===Number(sigId))slots.push(Number(b.dataset.slot||1))});return Math.max(0,...slots)+1}
    function defaultPlacement(offset=0){return {nx:.36+Math.min(.12,offset*.025),ny:.42+Math.min(.12,offset*.02),nw:.22,nh:.10}}
    function normFromEl(el){const r=wrap.getBoundingClientRect(),b=el.getBoundingClientRect();if(r.width<=0||r.height<=0)throw new Error('PDF preview is not ready');const out={nx:(b.left-r.left)/r.width,ny:(b.top-r.top)/r.height,nw:b.width/r.width,nh:b.height/r.height};for(const k of Object.keys(out))out[k]=Math.max(0,Math.min(1,out[k]));return out}
    function placementFromEl(el){return {attendance_id:current,signature_id:Number(el.dataset.signatureId),page,placement_slot:Number(el.dataset.slot||1),...normFromEl(el)}}
    function allBoxPlacements(){return [...layer.querySelectorAll('.signature-box')].map(placementFromEl)}
    function markDirty(){dirty=true;previewVerified=false;document.getElementById('previewBanner').hidden=true;setNavState()}

    function createBox(pl,focus=false){
      const sig=sigById(pl.signature_id);if(!sig)return null;
      const locked=!!currentLock();
      const el=document.createElement('div');el.className='signature-box'+(locked?' locked-signature-box':'');el.dataset.signatureId=String(sig.id);el.dataset.slot=String(pl.placement_slot||1);
      el.innerHTML=locked
        ? `<div class="signature-box-toolbar locked-toolbar"><span aria-hidden="true">🔒</span><span class="sig-box-label"></span></div><img alt="Signature">`
        : `<div class="signature-box-toolbar"><span class="sig-grip" title="Drag signature">⋮⋮</span><span class="sig-box-label"></span><button type="button" data-act="duplicate" title="Duplicate signature">＋</button><button type="button" data-act="delete" title="Remove signature">×</button></div><img alt="Signature"><span class="resize-handle" title="Resize"></span>`;
      el.querySelector('img').src=sig.src;el.querySelector('.sig-box-label').textContent=sig.name||'Signature';
      el.style.left=(Number(pl.nx)*100)+'%';el.style.top=(Number(pl.ny)*100)+'%';el.style.width=(Number(pl.nw)*100)+'%';el.style.height=(Number(pl.nh)*100)+'%';layer.appendChild(el);
      if(locked)return el;
      let drag=null,resize=null;
      el.addEventListener('pointerdown',e=>{if(e.target.closest('button')||e.target.classList.contains('resize-handle'))return;drag={x:e.clientX,y:e.clientY,left:el.offsetLeft,top:el.offsetTop};el.setPointerCapture(e.pointerId);e.preventDefault()});
      el.querySelector('.resize-handle').addEventListener('pointerdown',e=>{resize={x:e.clientX,y:e.clientY,w:el.offsetWidth,h:el.offsetHeight};el.setPointerCapture(e.pointerId);e.stopPropagation();e.preventDefault()});
      el.addEventListener('pointermove',e=>{if(drag){const maxX=Math.max(0,wrap.clientWidth-el.offsetWidth),maxY=Math.max(0,wrap.clientHeight-el.offsetHeight);el.style.left=Math.max(0,Math.min(maxX,drag.left+e.clientX-drag.x))+'px';el.style.top=Math.max(0,Math.min(maxY,drag.top+e.clientY-drag.y))+'px';markDirty()}if(resize){const w=Math.max(42,Math.min(wrap.clientWidth-el.offsetLeft,resize.w+e.clientX-resize.x)),h=Math.max(24,Math.min(wrap.clientHeight-el.offsetTop,resize.h+e.clientY-resize.y));el.style.width=w+'px';el.style.height=h+'px';markDirty()}});
      const clear=()=>{drag=null;resize=null};el.addEventListener('pointerup',clear);el.addEventListener('pointercancel',clear);
      el.querySelector('[data-act="delete"]').addEventListener('click',()=>{el.remove();markDirty();toast('Signature removed. Save the master page to sync locked pages.','good')});
      el.querySelector('[data-act="duplicate"]').addEventListener('click',()=>{const base=placementFromEl(el),slot=nextSlot(base.signature_id);base.placement_slot=slot;base.nx=Math.min(.78,base.nx+.025);base.ny=Math.min(.88,base.ny+.025);createBox(base,true);markDirty()});
      if(focus){el.classList.add('pulse-focus');setTimeout(()=>el.classList.remove('pulse-focus'),650)}return el;
    }
    function updateLockUI(){
      const lock=currentLock(),targets=currentLockTargets(),card=document.getElementById('lockStatusCard'),title=document.getElementById('lockStatusTitle'),text=document.getElementById('lockStatusText'),unlock=document.getElementById('unlockCurrentPage');
      card?.classList.toggle('is-locked',!!lock);card?.classList.toggle('is-master',!lock&&targets.length>0);
      if(lock){if(title)title.textContent=`Locked to master page ${lock.source_page}`;if(text)text.textContent='Position is synchronized automatically. Unlock this page to edit it independently.';if(unlock)unlock.hidden=false;}
      else if(targets.length){if(title)title.textContent=`Master page • ${targets.length} linked`;if(text)text.textContent=`Locked pages: ${targets.join(', ')}. Add/remove/move here, then Save to update all.`;if(unlock)unlock.hidden=true;}
      else{if(title)title.textContent='Current page is editable';if(text)text.textContent='Choose target pages and use Save & Lock to keep them synchronized.';if(unlock)unlock.hidden=true;}
    }
    function renderBoxes(){layer.innerHTML='';for(const pl of pagePlacements())createBox(pl);dirty=false;updateLockUI();setNavState()}
    function addCurrentSignature(){if(!current){toast('Select a PDF first','bad');return}if(currentLock()){toast(`Page ${page} is locked to master page ${currentLock().source_page}. Unlock it first.`,'bad');return}const sig=currentSig();if(!sig){toast('Select a signature first','bad');return}const slot=nextSlot(sig.id),pl={attendance_id:current,signature_id:sig.id,page,placement_slot:slot,...defaultPlacement(layer.children.length)};createBox(pl,true);markDirty()}
    document.getElementById('addSignatureBox')?.addEventListener('click',addCurrentSignature);

    function setNavState(){const ready=!!current&&layer.children.length>0,locked=!!currentLock();if(prevBtn)prevBtn.disabled=navBusy||!current||page<=1;if(nextBtn)nextBtn.disabled=navBusy||!current||page>=pages;if(previewBtn)previewBtn.disabled=navBusy||!ready;if(signBtn)signBtn.disabled=navBusy||!ready||!previewVerified||selectChecks().length===0;if(pageJump){pageJump.max=String(pages);pageJump.value=String(page);pageJump.disabled=!current}if(pageTotal)pageTotal.textContent=`/ ${current?pages:'—'}`;['addSignatureBox','saveCurrentPage','lockPagesBtn','copyNextPage','copyCustomPages'].forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=navBusy||!current||locked});document.querySelectorAll('.signing-progress>div').forEach((el,i)=>el.classList.toggle('active',i===0?selectChecks().length>0:i===1?ready:i===2?previewVerified:false));updateLockUI()}
    function applyZoom(){if(!wrap||wrap.hidden||!pageImg.naturalWidth)return;const avail=Math.max(320,(viewport?.clientWidth||760)-24);let w;if(zoomMode==='fit')w=Math.min(pageImg.naturalWidth,avail);else w=Math.min(pageImg.naturalWidth*1.5,Math.max(320,pageImg.naturalWidth*zoomScale));wrap.style.width=Math.round(w)+'px';document.getElementById('zoomLabel').textContent=zoomMode==='fit'?'Fit':Math.round(zoomScale*100)+'%'}
    document.getElementById('zoomOut')?.addEventListener('click',()=>{zoomMode='custom';zoomScale=Math.max(.45,(zoomMode==='fit'?.82:zoomScale)-.1);applyZoom()});
    document.getElementById('zoomIn')?.addEventListener('click',()=>{zoomMode='custom';zoomScale=Math.min(1.35,zoomScale+.1);applyZoom()});
    document.getElementById('zoomLabel')?.addEventListener('click',()=>{zoomMode='fit';applyZoom()});
    window.addEventListener('resize',()=>{if(zoomMode==='fit')applyZoom()});

    async function saveCurrentPage({silent=false,applySelected=null,remember=null}={}){
      if(!current)return null;if(currentLock())throw new Error(`Page ${page} is locked to master page ${currentLock().source_page}`);const placements=allBoxPlacements();
      const apply=(applySelected??!!document.getElementById('applySelected')?.checked)?selectChecks():[];
      const res=await jsonPost('/api/signing/page-placements',{attendance_id:current,page,placements,remember:remember??!!document.getElementById('rememberPosition')?.checked,apply_ids:apply});
      const arr=stateArr().filter(x=>Number(x.page)!==page);for(const pl of placements)arr.push(pl);setStateForDoc(current,arr);
      for(const id of (res.applied||[])){if(Number(id)===Number(current))continue;const a=stateArr(id).filter(x=>Number(x.page)!==page);for(const pl of placements)a.push({...pl,attendance_id:Number(id)});setStateForDoc(id,a)}
      for(const pn of (res.synced_pages||[])){const a=stateArr().filter(x=>Number(x.page)!==Number(pn));for(const pl of placements)a.push({...pl,attendance_id:current,page:Number(pn)});setStateForDoc(current,a)}
      dirty=false;if(!silent)toast(`Page ${page} saved${res.mismatched?.length?` • ${res.mismatched.length} PDF(s) skipped`:''}`,'good');return res;
    }
    document.getElementById('saveCurrentPage')?.addEventListener('click',async()=>{try{await saveCurrentPage()}catch(e){toast(e.message,'bad')}});

    async function goPage(target){if(!current||target<1||target>pages||target===page)return;try{navBusy=true;setNavState();if(dirty)await saveCurrentPage({silent:true,applySelected:false,remember:false});page=target;loadPage()}catch(e){toast(`Could not save page ${page}: ${e.message}`,'bad')}finally{navBusy=false;setNavState()}}
    prevBtn?.addEventListener('click',()=>goPage(page-1));nextBtn?.addEventListener('click',()=>goPage(page+1));
    pageJump?.addEventListener('change',()=>goPage(Math.max(1,Math.min(pages,Number(pageJump.value||page)))));

    function loadDoc(btn){if(!btn)return;const open=async()=>{if(current&&dirty){try{await saveCurrentPage({silent:true,applySelected:false,remember:false})}catch(e){toast(e.message,'bad');return}}current=Number(btn.dataset.id);pages=Math.max(1,Number(btn.dataset.pages||1));page=1;previewVerified=false;document.querySelectorAll('.queue-item').forEach(x=>x.classList.remove('active'));btn.closest('.queue-item')?.classList.add('active');const n=document.getElementById('currentDocName');if(n)n.textContent=btn.dataset.name||'Attendance PDF';wrap.hidden=false;document.getElementById('pdfEmpty').hidden=true;loadPage()};open()}
    function loadPage(){if(!current)return;previewVerified=false;dirty=false;document.getElementById('previewBanner').hidden=true;setNavState();const loading=document.getElementById('pdfLoading');if(loading)loading.hidden=false;pageImg.style.opacity='.15';layer.innerHTML='';pageImg.onload=()=>{if(loading)loading.hidden=true;pageImg.style.opacity='1';applyZoom();renderBoxes();setNavState()};pageImg.onerror=()=>{if(loading)loading.hidden=true;pageImg.style.opacity='1';toast('PDF preview could not be loaded. Please reopen the document.','bad');wrap.hidden=true;document.getElementById('pdfEmpty').hidden=false};pageImg.src=`/attendance/${current}/page/${page}.png?v=${Date.now()}`;const p=document.getElementById('pageInfo');if(p)p.textContent=`Page ${page} / ${pages}`}
    document.querySelectorAll('.doc-open').forEach(b=>b.addEventListener('click',()=>loadDoc(b)));

    function parsePages(raw){const out=new Set();for(const part of String(raw||'').split(',').map(x=>x.trim()).filter(Boolean)){if(part.includes('-')){let [a,b]=part.split('-').map(Number);if(Number.isFinite(a)&&Number.isFinite(b)){if(a>b)[a,b]=[b,a];for(let x=a;x<=b;x++)out.add(x)}}else{const n=Number(part);if(Number.isFinite(n))out.add(n)}}return [...out].filter(x=>x>=1&&x<=pages&&x!==page).sort((a,b)=>a-b)}
    async function lockPages(targets){
      if(!current)throw new Error('Select a PDF first');if(currentLock())throw new Error(`Page ${page} is locked to master page ${currentLock().source_page}. Unlock it first.`);if(!layer.children.length)throw new Error('Add at least one signature on the master page first');
      await saveCurrentPage({silent:true,applySelected:false});
      const r=await jsonPost('/api/signing/lock-pages',{attendance_id:current,source_page:page,target_pages:targets});
      setStateForDoc(current,r.placements||[]);setLocksForDoc(current,r.locks||[]);previewVerified=false;renderBoxes();
      const skipped=(r.skipped||[]).length;toast(`${r.locked.length} page(s) locked to page ${page}${skipped?` • ${skipped} skipped`:''}`,skipped?'bad':'good');return r;
    }
    document.getElementById('lockPagesBtn')?.addEventListener('click',async()=>{try{const t=parsePages(document.getElementById('lockPagesInput')?.value);if(!t.length)throw new Error('Enter target pages, for example 2-5 or 2,4,6-8');await lockPages(t)}catch(e){toast(e.message,'bad')}});
    document.getElementById('unlockCurrentPage')?.addEventListener('click',async()=>{try{const lock=currentLock();if(!lock)throw new Error('This page is not locked');const r=await jsonPost('/api/signing/unlock-page',{attendance_id:current,page});setLocksForDoc(current,r.locks||[]);renderBoxes();toast(`Page ${page} unlocked. It can now be edited independently.`,'good')}catch(e){toast(e.message,'bad')}});

    async function copyToPages(targets,navigateTo=null){if(!current)throw new Error('Select a PDF first');if(!layer.children.length)throw new Error('Add at least one signature on this page first');await saveCurrentPage({silent:true,applySelected:false});const r=await jsonPost('/api/signing/copy-page',{attendance_id:current,source_page:page,target_pages:targets});setStateForDoc(current,r.placements||[]);previewVerified=false;setNavState();toast(`${r.copied.length} page(s) copied${r.skipped.length?` • ${r.skipped.length} skipped`:''}`,r.skipped.length?'bad':'good');if(navigateTo&&r.copied.includes(navigateTo))await goPage(navigateTo);return r}
    document.getElementById('copyNextPage')?.addEventListener('click',async()=>{try{if(page>=pages)throw new Error('This is already the last page');await copyToPages([page+1],page+1)}catch(e){toast(e.message,'bad')}});
    document.getElementById('copyCustomPages')?.addEventListener('click',async()=>{try{const t=parsePages(document.getElementById('copyPagesInput')?.value);if(!t.length)throw new Error('Enter valid target pages, for example 2,4-6');await copyToPages(t)}catch(e){toast(e.message,'bad')}});

    document.getElementById('useTemplate')?.addEventListener('click',async()=>{try{previewVerified=false;const sig=currentSig();if(!sig)throw new Error('Select a signature first');let ids=selectChecks();if(current&&!ids.includes(current))ids.unshift(current);if(!ids.length)throw new Error('Select PDF(s)');const r=await jsonPost('/api/signing/apply-template',{signature_id:sig.id,attendance_ids:ids});for(const pl of (r.placements||[])){const key=String(pl.attendance_id),arr=(window.FMT_SIGNING.placements[key]||[]).filter(x=>!(Number(x.signature_id)===Number(pl.signature_id)&&Number(x.page)===Number(pl.page)&&Number(x.placement_slot||1)===Number(pl.placement_slot||1)));arr.push(pl);window.FMT_SIGNING.placements[key]=arr}if(current&&r.applied.includes(current))renderBoxes();setNavState();toast(`${r.applied.length} matched • ${r.mismatched.length} need adjustment`,r.mismatched.length?'bad':'good')}catch(e){toast(e.message,'bad')}});
    previewBtn?.addEventListener('click',async()=>{try{previewVerified=false;setNavState();await saveCurrentPage({silent:true});const img=document.getElementById('exactPreviewImg');img.onload=()=>{previewVerified=true;document.getElementById('previewBanner').hidden=false;document.getElementById('previewModal').hidden=false;setNavState();toast('Final preview verified','good')};img.onerror=()=>{previewVerified=false;setNavState();toast('Final preview could not be generated.','bad')};img.src=`/attendance/${current}/signed-preview/${page}.png?v=${Date.now()}`}catch(e){previewVerified=false;setNavState();toast(e.message,'bad')}});
    document.getElementById('closePreview')?.addEventListener('click',()=>document.getElementById('previewModal').hidden=true);document.getElementById('previewModal')?.addEventListener('click',e=>{if(e.target.id==='previewModal')e.currentTarget.hidden=true});
    signBtn?.addEventListener('click',async()=>{const ids=selectChecks();if(!ids.length){toast('Select at least one PDF','bad');return}if(!previewVerified){toast('Run Final Preview before signing.','bad');return}if(!confirm(`Sign ${ids.length} selected PDF(s)? Original files will be preserved.`))return;const btn=signBtn;try{btn.disabled=true;btn.textContent='Signing & verifying...';const r=await jsonPost('/api/signing/sign',{attendance_ids:ids});toast(`${r.signed} signed successfully${r.failed?` • ${r.failed} failed`:''}`,r.failed?'bad':'good');if(r.failed)console.error('Signing failures',r.results);setTimeout(()=>location.reload(),900)}catch(e){toast(e.message,'bad')}finally{btn.textContent='Sign Selected PDFs';setNavState()}});

    updateCount();setNavState();const requested=new URLSearchParams(location.search).get('doc');const first=(requested&&document.querySelector(`.doc-open[data-id="${CSS.escape(requested)}"]`))||document.querySelector('.doc-open');if(first)loadDoc(first);
  }

  document.addEventListener('DOMContentLoaded',()=>{try{initCommon();initAttendanceUpload();initSigning()}catch(e){console.error(e);toast('Interface initialization failed. Please refresh the page.','bad')}});
  window.fmtToast=toast;
})();
