(() => {
  const html = document.documentElement;
  const body = document.body;
  // Native Android shell marker. This is presentation-only; authentication and
  // permissions continue to be enforced by the server.
  if (navigator.userAgent.includes('INKAMNET-GO/')) body.classList.add('inkamnet-go-app');
  // v1.23 — WA Gateway connection flag, read once from the layout's <meta> tag (see middleware/common.js
  // res.locals.waGatewayConnected). Declared at the top of this IIFE so every block below can use it.
  const waGatewayConnectedGlobal = document.querySelector('meta[name="wa-gateway-connected"]')?.content === '1';
  const loader = document.getElementById('appLoader');
  const progress = document.getElementById('pageProgress');
  const operationLoader = document.getElementById('operationLoader');

  const updateClock = () => {
    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    });
    const value = `${formatter.format(new Date()).replaceAll('.', ':')} WIB`;
    document.querySelectorAll('[data-live-clock]').forEach(el => el.textContent = value);
  };
  updateClock();
  setInterval(updateClock, 1000);

  let loaderHidden = false;
  const hideLoader = () => {
    if (!loader || loaderHidden) return;
    loaderHidden = true;
    loader.classList.add('is-hidden');
    // Remove the splash from the DOM after the fade so it can never remain over the application.
    setTimeout(() => loader.remove(), 420);
  };
  if (document.readyState === 'complete') hideLoader();
  else window.addEventListener('load', hideLoader, { once:true });
  document.addEventListener('DOMContentLoaded', () => setTimeout(hideLoader, 700), { once:true });
  // Hard fallback for slow/blocked third-party assets.
  setTimeout(hideLoader, 1600);

  document.querySelectorAll('[data-sidebar-open]').forEach(btn => btn.addEventListener('click', () => body.classList.add('sidebar-open')));
  document.querySelectorAll('[data-sidebar-close]').forEach(btn => btn.addEventListener('click', () => body.classList.remove('sidebar-open')));

  const applyTheme = theme => {
    html.dataset.theme = theme;
    localStorage.setItem('inkamnet-theme', theme);
    document.querySelectorAll('[data-theme-toggle] i').forEach(i => i.className = theme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill');
    window.dispatchEvent(new CustomEvent('inkamnet:theme', { detail:{ theme } }));
  };
  applyTheme(localStorage.getItem('inkamnet-theme') || html.dataset.theme || 'dark');
  document.querySelectorAll('[data-theme-toggle]').forEach(btn => btn.addEventListener('click', () => applyTheme(html.dataset.theme === 'dark' ? 'light' : 'dark')));

  document.querySelectorAll('.metric-card,.data-card,.filter-card,.ink-kpi,.ink-panel').forEach((el,index)=>{
    el.style.setProperty('--enter-delay', `${Math.min(index*26,150)}ms`); el.classList.add('reveal-item');
  });


  // v1.17: pointer-following spotlight and 3D lighting intentionally disabled.
  // Static hover/reveal animations remain, but nothing follows the mouse cursor.

  const startProgress=()=>{if(!progress)return;progress.style.transition='none';progress.style.opacity='1';progress.style.width='18%';requestAnimationFrame(()=>{progress.style.transition='';progress.style.width='72%'});};
  const startOperationLoading=(message='Memproses data…')=>{
    startProgress();
    if(!operationLoader)return;
    const strong=operationLoader.querySelector('strong');if(strong)strong.textContent=message;
    operationLoader.hidden=false;
    requestAnimationFrame(()=>operationLoader.classList.add('show'));
  };
  window.inkamnetStartLoading=startOperationLoading;

  document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => {
    if(event.defaultPrevented)return;
    const button = event.submitter;
    // Form tanpa method/action ditangani controller AJAX halaman (mis. NMS) dan memiliki loading sendiri.
    if (!button || button.dataset.noLoading === 'true' || (!form.hasAttribute('method')&&!form.hasAttribute('action'))) return;
    if(form.dataset.submitting==='true'){event.preventDefault();return;}
    form.dataset.submitting='true';form.setAttribute('aria-busy','true');
    button.classList.add('is-loading');
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.style.minWidth=`${Math.ceil(button.getBoundingClientRect().width)}px`;
    button.innerHTML = `<span class="spinner-border spinner-border-sm"></span><span>${html.lang==='en'?'Processing...':'Memproses...'}</span>`;
    button.setAttribute('aria-disabled','true');
    startOperationLoading(form.dataset.loadingMessage||(html.lang==='en'?'Processing data…':'Memproses data…'));
  }));

  // Shared "something is happening" cue for both link navigation and instant filters,
  // so a filter change gets the exact same immediate feedback a link click already had.
  // GET filters react immediately to select/date/year changes; text search still submits with Enter.
  document.querySelectorAll('form[method="get"],form[method="GET"]').forEach(form=>{
    let submitting=false;
    const submit=()=>{
      if(submitting)return;submitting=true;
      try{sessionStorage.setItem('inkamnet-instant-filter','1')}catch(_){}
      form.setAttribute('aria-busy','true');
      form.classList.add('is-filtering');
      startProgress();
      HTMLFormElement.prototype.submit.call(form);
    };
    form.querySelectorAll('select,input[type="date"],input[type="month"],input[type="number"],input[type="radio"],input[type="checkbox"]').forEach(field=>field.addEventListener('change',submit));
    if(form.hasAttribute('data-auto-filter'))form.classList.add('auto-filter-enabled');
  });

  // Instant prefix search for rendered lists. This never submits the form, starts a loader,
  // or calls the server: typing "D" immediately keeps rows containing a word beginning with D.
  // Select filters remain server-backed so totals, charts, and approval data stay authoritative.
  const normalizeInstantSearch=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('id-ID').trim();
  document.querySelectorAll('[data-instant-prefix-form]').forEach(form=>{
    const input=form.querySelector('[data-instant-prefix-input]');
    const target=document.getElementById(form.dataset.instantTarget||'');
    if(!input||!target)return;
    // Do not send the live text to the server when Site/Kategori/Tipe changes; otherwise clearing
    // the field afterwards could not restore rows that the server had already excluded.
    input.removeAttribute('name');
    const rows=[...target.querySelectorAll('[data-instant-filter-row]')];
    const empty=target.querySelector('[data-instant-empty]');
    const count=document.querySelector('[data-instant-result-count]');
    const siteSuffix=count?.textContent.match(/\s·\s.+$/)?.[0]||'';
    const apply=()=>{
      const queries=normalizeInstantSearch(input.value).split(/\s+/).filter(Boolean);
      let visible=0;
      rows.forEach(row=>{
        const words=normalizeInstantSearch(row.dataset.instantSearchValue).split(/[^a-z0-9]+/).filter(Boolean);
        const match=!queries.length||queries.every(query=>words.some(word=>word.startsWith(query)));
        row.hidden=!match;
        if(match){visible+=1;const number=row.querySelector('[data-instant-number]');if(number)number.textContent=String(visible);}
        else row.querySelectorAll('[data-row-check]:checked').forEach(box=>{box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}));});
      });
      if(empty)empty.hidden=visible!==0;
      if(count)count.textContent=queries.length?`${visible} dari ${rows.length} transaksi${siteSuffix}`:`${rows.length} transaksi${siteSuffix}`;
    };
    input.addEventListener('input',apply);
    input.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
    form.addEventListener('submit',event=>{if(document.activeElement===input)event.preventDefault();});
    apply();
  });

  // Universal zero-wait search for all primary data tables. Results already rendered in the browser
  // are narrowed immediately; pressing Enter no longer causes a page reload or loading overlay.
  document.querySelectorAll('form[method="get"] input[name="q"],form[method="GET"] input[name="q"]').forEach(input=>{
    if(input.hasAttribute('data-instant-prefix-input'))return;
    const rows=[...document.querySelectorAll('.page-enter table.app-table tbody>tr')].filter(row=>!row.querySelector('.empty-state'));
    if(!rows.length)return;
    input.setAttribute('autocomplete','off');input.dataset.universalInstantSearch='1';
    const form=input.closest('form');
    let badge=input.closest('.search-box')?.querySelector('.universal-search-count');
    if(!badge&&input.closest('.search-box')){badge=document.createElement('span');badge.className='universal-search-count';input.closest('.search-box').appendChild(badge);}
    const apply=()=>{const queries=normalizeInstantSearch(input.value).split(/\s+/).filter(Boolean);let visible=0;rows.forEach(row=>{const words=normalizeInstantSearch(row.textContent).split(/[^a-z0-9]+/).filter(Boolean);const match=!queries.length||queries.every(q=>words.some(word=>word.startsWith(q)));row.hidden=!match;if(match)visible+=1;});if(badge){badge.textContent=queries.length?`${visible} hasil`:'';badge.hidden=!queries.length;}return visible;};
    input.addEventListener('input',apply);
    // Typing is always zero-wait against the rows already rendered. Enter remains a real
    // server search, so a record outside the current page can never become unreachable.
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();if(form?.hasAttribute('data-server-search-fallback')&&input.value.trim()){HTMLFormElement.prototype.submit.call(form);return;}apply();}});
  });

  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download') || link.href.startsWith('javascript:') || link.getAttribute('href').startsWith('#')) return;
    if (link.origin !== location.origin) return;
    startProgress();
  });
  window.addEventListener('pageshow',()=>{document.querySelectorAll('form[data-submitting="true"]').forEach(form=>{delete form.dataset.submitting;form.removeAttribute('aria-busy')});if(operationLoader){operationLoader.classList.remove('show');operationLoader.hidden=true}if(!progress)return;progress.style.width='100%';setTimeout(()=>{progress.style.opacity='0';progress.style.width='0'},180)});


  // Bootstrap modals are moved to <body> to avoid stacking-context bugs caused by animated page containers.
  document.querySelectorAll('.page-enter .modal').forEach(modal => document.body.appendChild(modal));
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('shown.bs.modal', () => modal.querySelector('input:not([type="hidden"]),select,textarea,button')?.focus());
  });

  // Friendly filename preview for XLSX/payment upload dropzones.
  document.querySelectorAll('input[type="file"]').forEach(input => input.addEventListener('change', () => {
    const label=input.closest('label')?.querySelector('[data-file-label]');
    if(label) label.textContent=input.files?.[0]?.name || 'Belum ada file dipilih';
  }));

  // Open the browser calendar whenever a date field is clicked.
  // This keeps all date-driven modules consistent without adding another UI dependency.
  document.querySelectorAll('input[type="date"],input[type="datetime-local"]').forEach(input => {
    input.classList.add('ink-date-picker');
    input.setAttribute('autocomplete','off');
    input.addEventListener('click', () => {
      if (input.disabled || input.readOnly || typeof input.showPicker !== 'function') return;
      try { input.showPicker(); } catch (_) {}
    });
  });

  const palette=document.getElementById('commandPalette');
  const input=document.getElementById('commandInput');
  const openPalette=()=>{if(!palette)return;palette.classList.add('open');palette.setAttribute('aria-hidden','false');setTimeout(()=>input?.focus(),50)};
  const closePalette=()=>{palette?.classList.remove('open');palette?.setAttribute('aria-hidden','true');if(input)input.value='';document.querySelectorAll('#commandList a').forEach(a=>a.classList.remove('hidden'))};
  document.querySelectorAll('[data-command-open]').forEach(b=>b.addEventListener('click',openPalette));
  document.querySelectorAll('[data-command-close]').forEach(b=>b.addEventListener('click',closePalette));
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette()}if(e.key==='Escape')closePalette()});
  input?.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();document.querySelectorAll('#commandList a').forEach(a=>a.classList.toggle('hidden',q && !(`${a.textContent} ${a.dataset.keywords||''}`).toLowerCase().includes(q))) });

  // Lightweight bilingual layer for legacy screens that still contain hard-coded labels.
  // The Billing/Invoices module is intentionally kept in Indonesian per business requirement.
  if (html.lang === 'en' && !location.pathname.startsWith('/invoices')) {
    const UI_EN = new Map(Object.entries({
      'Tambah Pelanggan':'Add Customer','Edit Pelanggan':'Edit Customer','Manajemen Pelanggan':'Customer Management','Pelanggan Aktif':'Active Customers','Total Pelanggan':'Total Customers','Semua Pelanggan':'All Customers','Semua Status':'All Status','Semua Site':'All Sites','Terapkan Filter':'Apply Filter','Pencarian':'Search','CARI':'SEARCH','Cari':'Search','Batal':'Cancel','Simpan':'Save','Simpan Pelanggan':'Save Customer','Kembali':'Back','Alamat':'Address','No. WhatsApp':'WhatsApp Number','Jatuh Tempo':'Due Date','Aktif Sejak':'Active Since','Catatan':'Notes','Status Pelanggan':'Customer Status','Data pelanggan tidak ditemukan':'Customer data not found','Database Pelanggan':'Customer Database','Tambah Paket':'Add Package','Nama Paket':'Package Name','Harga / Bulan':'Monthly Price','Tambah Ticket':'Add Ticket','Buat Ticket':'Create Ticket','Pelanggan':'Customer','Prioritas':'Priority','Deskripsi / Checklist':'Description / Checklist','Belum ditugaskan':'Unassigned','Simpan PIC':'Save PIC','Progress Harian':'Daily Progress','Catatan Progress':'Progress Note','Jadwal Teknisi':'Technician Schedule','Tambah Jadwal Teknisi':'Add Technician Schedule','Tanggal':'Date','Jam':'Time','Teknisi':'Technician','Pekerjaan':'Job','Jadwal Piket Server':'Server Duty Schedule','Tambah Piket':'Add Duty','Generate Rotasi':'Generate Rotation','Minggu Lalu':'Previous Week','Minggu Depan':'Next Week','Nama Manual':'Manual Name','Laporan':'Reports','Laporan Pelanggan':'Customer Report','Laporan Tagihan':'Billing Report','Laporan Arus Kas':'Cash Flow Report','Generate Report':'Generate Report','Arus Kas':'Cash Flow','Pendapatan':'Income','Pengeluaran':'Expense','Saldo':'Balance','Data Kas':'Cash Data','Kategori Kas':'Cash Categories','Tambah Data Kas':'Add Cash Entry','Pengaturan':'Settings','Perusahaan':'Company','Aplikasi':'Application','Karyawan':'Employees','Departemen':'Departments','Posisi':'Positions','Bank':'Bank','Payment Gateway':'Payment Gateway','Tambah Karyawan':'Add Employee','Tambah Departemen':'Add Department','Tambah Posisi':'Add Position','Tambah Bank':'Add Bank','Nama':'Name','Telepon':'Phone','Bahasa Default':'Default Language','Tema Default':'Default Theme','Simpan Aplikasi':'Save Application','Simpan Perusahaan':'Save Company','Aktif':'Active','Nonaktif':'Inactive','Belum dipilih':'Not selected','Tanpa akun login':'No login account','Tanggal Bergabung':'Join Date','Profil Saya':'My Profile','Keamanan Akun':'Account Security','Password Saat Ini':'Current Password','Password Baru':'New Password','Ganti Password':'Change Password','Simpan Profil':'Save Profile','Keluar':'Logout','Riwayat Pembayaran':'Payment History','Pembayaran':'Payments','Diskon':'Discounts','Biaya Tambahan':'Additional Charges','Rekonsiliasi':'Reconciliation','Stok Barang':'Inventory','Pergerakan Stok':'Stock Movements','Pemakaian Material':'Material Usage','Log Aktivitas':'Activity Log'
    }));
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode(node){const p=node.parentElement;if(!p||['SCRIPT','STYLE','TEXTAREA'].includes(p.tagName))return NodeFilter.FILTER_REJECT;return node.nodeValue.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}});
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    nodes.forEach(node=>{const raw=node.nodeValue,trim=raw.trim(),translated=UI_EN.get(trim);if(translated)node.nodeValue=raw.replace(trim,translated);});
    document.querySelectorAll('[placeholder]').forEach(el=>{const v=el.getAttribute('placeholder');if(UI_EN.has(v))el.setAttribute('placeholder',UI_EN.get(v));});
    document.querySelectorAll('[title]').forEach(el=>{const v=el.getAttribute('title');if(UI_EN.has(v))el.setAttribute('title',UI_EN.get(v));});
  }


  // v1.11 compact professional row-action popovers.
  // Menus are portaled to <body> and positioned with fixed coordinates so table overflow cannot clip them.
  let activeActionPopover=null;
  const closeActionPopover=()=>{
    if(!activeActionPopover)return;
    activeActionPopover.menu.hidden=true;
    activeActionPopover.button.setAttribute('aria-expanded','false');
    activeActionPopover.button.classList.remove('show');
    activeActionPopover=null;
  };
  const positionActionPopover=(button,menu)=>{
    const r=button.getBoundingClientRect();
    const gap=7;
    menu.hidden=false;
    menu.style.visibility='hidden';
    menu.style.left='0px';menu.style.top='0px';
    const m=menu.getBoundingClientRect();
    const vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight;
    let left=Math.min(vw-m.width-8,Math.max(8,r.right-m.width));
    let top=r.bottom+gap;
    if(top+m.height>vh-8 && r.top-m.height-gap>=8)top=r.top-m.height-gap;
    else top=Math.min(vh-m.height-8,Math.max(8,top));
    menu.style.left=`${Math.round(left)}px`;menu.style.top=`${Math.round(top)}px`;menu.style.visibility='visible';
  };
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action-popover-target]');
    if(button){
      event.preventDefault();event.stopPropagation();
      const id=button.dataset.actionPopoverTarget,menu=id?document.getElementById(id):null;
      if(!menu)return;
      if(activeActionPopover?.menu===menu){closeActionPopover();return;}
      closeActionPopover();
      if(menu.parentElement!==document.body)document.body.appendChild(menu);
      positionActionPopover(button,menu);
      button.setAttribute('aria-expanded','true');button.classList.add('show');
      activeActionPopover={button,menu};
      return;
    }
    if(activeActionPopover && event.target.closest('.ink-action-popover')!==activeActionPopover.menu)closeActionPopover();
  });
  document.addEventListener('click',event=>{if(event.target.closest('[data-action-close],.ink-action-popover a'))closeActionPopover();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeActionPopover();});
  window.addEventListener('resize',closeActionPopover);
  document.addEventListener('scroll',closeActionPopover,true);

  // v1.20 — shared Arsip vs Hapus Permanen modal. Any element with [data-delete-choice] plus
  // data-archive-url (always) and data-hard-delete-url (only when the row is eligible) opens it.
  // v1.20.1: also supports a "bulk mode" — when deleteChoiceBulkHandler is set (by the bulk "Hapus
  // Massal" button below), the Archive/Hard-delete buttons call that handler instead of submitting
  // the per-row hidden forms, so the same modal UI serves both a single row and a bulk selection.
  const deleteChoiceModalEl=document.getElementById('deleteChoiceModal');
  const deleteChoiceModal=deleteChoiceModalEl&&window.bootstrap?bootstrap.Modal.getOrCreateInstance(deleteChoiceModalEl):null;
  const deleteChoiceArchiveForm=document.getElementById('deleteChoiceArchiveForm');
  const deleteChoiceHardForm=document.getElementById('deleteChoiceHardForm');
  const deleteChoiceArchiveBtn=document.getElementById('deleteChoiceArchiveBtn');
  const deleteChoiceHardBtn=document.getElementById('deleteChoiceHardBtn');
  let deleteChoiceBulkHandler=null;
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-delete-choice]');
    if(!trigger||!deleteChoiceModal)return;
    event.preventDefault();
    closeActionPopover();
    deleteChoiceBulkHandler=null;
    const archiveUrl=trigger.dataset.archiveUrl||'',hardUrl=trigger.dataset.hardDeleteUrl||'';
    const label=trigger.dataset.entityLabel||'data ini';
    const targetEl=document.getElementById('deleteChoiceTarget');if(targetEl)targetEl.textContent=label;
    if(deleteChoiceArchiveForm)deleteChoiceArchiveForm.action=archiveUrl||'#';
    if(deleteChoiceArchiveBtn)deleteChoiceArchiveBtn.disabled=!archiveUrl;
    if(deleteChoiceHardForm)deleteChoiceHardForm.action=hardUrl||'#';
    if(deleteChoiceHardBtn){deleteChoiceHardBtn.disabled=!hardUrl;deleteChoiceHardBtn.title=hardUrl?'':'Data ini masih terikat transaksi finansial / jurnal resmi dan tidak dapat dihapus permanen.';}
    deleteChoiceModal.show();
  });
  deleteChoiceArchiveBtn?.addEventListener('click',()=>{
    if(deleteChoiceBulkHandler){if(!confirm(deleteChoiceBulkHandler.archiveConfirm))return;deleteChoiceBulkHandler.archive();deleteChoiceModal?.hide();return;}
    if(!deleteChoiceArchiveForm?.action||deleteChoiceArchiveForm.action.endsWith('#'))return;
    if(!confirm('Arsipkan data ini? Riwayat tetap tersimpan dan dapat dipulihkan kapan saja dari tab Data Diarsip.'))return;
    deleteChoiceArchiveForm.submit();
  });
  deleteChoiceHardBtn?.addEventListener('click',()=>{
    if(deleteChoiceBulkHandler){if(!confirm(deleteChoiceBulkHandler.hardConfirm))return;deleteChoiceBulkHandler.hard();deleteChoiceModal?.hide();return;}
    if(!deleteChoiceHardForm?.action||deleteChoiceHardForm.action.endsWith('#'))return;
    if(!confirm('Hapus PERMANEN data ini? Tindakan ini tidak dapat dibatalkan.'))return;
    deleteChoiceHardForm.submit();
  });

  // v1.20.1 — dedicated danger-only modal for the Data Diarsip tab (Section 2): [data-hard-delete-danger]
  // (per-row) always hard-deletes directly (no Arsipkan option, the row is already archived); a bulk
  // trigger sets hardDeleteDangerBulkHandler instead of the hidden form's action.
  const hardDeleteDangerModalEl=document.getElementById('hardDeleteDangerModal');
  const hardDeleteDangerModal=hardDeleteDangerModalEl&&window.bootstrap?bootstrap.Modal.getOrCreateInstance(hardDeleteDangerModalEl):null;
  const hardDeleteDangerForm=document.getElementById('hardDeleteDangerForm');
  const hardDeleteDangerConfirmBtn=document.getElementById('hardDeleteDangerConfirmBtn');
  let hardDeleteDangerBulkHandler=null;
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-hard-delete-danger]');
    if(!trigger||!hardDeleteDangerModal)return;
    event.preventDefault();
    closeActionPopover();
    hardDeleteDangerBulkHandler=null;
    const url=trigger.dataset.hardDeleteDanger||'';
    const label=trigger.dataset.entityLabel||'data ini';
    const targetEl=document.getElementById('hardDeleteDangerTarget');if(targetEl)targetEl.textContent=label;
    if(hardDeleteDangerForm)hardDeleteDangerForm.action=url||'#';
    hardDeleteDangerModal.show();
  });
  hardDeleteDangerConfirmBtn?.addEventListener('click',()=>{
    if(hardDeleteDangerBulkHandler){hardDeleteDangerBulkHandler();hardDeleteDangerModal?.hide();return;}
    if(!hardDeleteDangerForm?.action||hardDeleteDangerForm.action.endsWith('#'))return;
    hardDeleteDangerForm.submit();
  });

  // v1.21.0 — Section 4 (global delete-button audit): generic single-choice delete modal, reused by any
  // [data-simple-delete="/url"] trigger (per-row) plus [data-simple-delete-bulk] buttons (bulk mode, same
  // pattern as deleteChoiceBulkHandler above — sets simpleDeleteBulkHandler instead of the form action).
  const simpleDeleteModalEl=document.getElementById('simpleDeleteModal');
  const simpleDeleteModal=simpleDeleteModalEl&&window.bootstrap?bootstrap.Modal.getOrCreateInstance(simpleDeleteModalEl):null;
  const simpleDeleteForm=document.getElementById('simpleDeleteForm');
  const simpleDeleteConfirmBtn=document.getElementById('simpleDeleteConfirmBtn');
  const simpleDeleteKickerEl=document.getElementById('simpleDeleteKicker');
  const simpleDeleteTitleEl=document.getElementById('simpleDeleteTitle');
  const simpleDeleteWarningEl=document.getElementById('simpleDeleteWarning');
  const simpleDeleteConfirmIconEl=document.getElementById('simpleDeleteConfirmIcon');
  const simpleDeleteConfirmLabelEl=document.getElementById('simpleDeleteConfirmLabel');
  let simpleDeleteBulkHandler=null;
  // v1.25.5 (update) — this modal was originally built ONLY for destructive delete/cancel actions
  // (hence the hardcoded "HAPUS DATA" kicker + red "Ya, Hapus" button), but it's also reused by
  // non-destructive confirmations like "Approve Massal" on Menu Approval & Transaksi. Reusing the
  // hardcoded delete styling there was a bug (approve looked/read exactly like a delete). This helper
  // makes the whole modal chrome (kicker text/color, warning alert color, confirm button color/icon/
  // label) swap based on optional data-simple-delete-* attributes on the trigger — defaulting to the
  // exact same danger/"Ya, Hapus" look as before when a trigger doesn't set them, so every existing
  // delete/cancel button across the app is unaffected.
  function applySimpleDeleteVariant(source){
    const variant=source.dataset.simpleDeleteVariant==='success'?'success':'danger';
    const isSuccess=variant==='success';
    const kickerText=source.dataset.simpleDeleteKicker||(isSuccess?'KONFIRMASI':'HAPUS DATA');
    const confirmLabel=source.dataset.simpleDeleteConfirmLabel||(isSuccess?'Ya, Lanjutkan':'Ya, Hapus');
    const confirmIcon=source.dataset.simpleDeleteConfirmIcon||(isSuccess?'bi-check2-circle':'bi-trash3-fill');
    const warningIcon=isSuccess?'bi-info-circle-fill':'bi-exclamation-triangle-fill';
    if(simpleDeleteKickerEl){simpleDeleteKickerEl.textContent=kickerText;simpleDeleteKickerEl.classList.toggle('text-danger',!isSuccess);simpleDeleteKickerEl.classList.toggle('text-success',isSuccess);}
    if(simpleDeleteWarningEl){simpleDeleteWarningEl.classList.toggle('alert-danger',!isSuccess);simpleDeleteWarningEl.classList.toggle('alert-success',isSuccess);}
    if(simpleDeleteConfirmBtn){simpleDeleteConfirmBtn.classList.toggle('danger',!isSuccess);simpleDeleteConfirmBtn.classList.toggle('success',isSuccess);}
    if(simpleDeleteConfirmIconEl)simpleDeleteConfirmIconEl.className=`bi ${confirmIcon}`;
    if(simpleDeleteConfirmLabelEl)simpleDeleteConfirmLabelEl.textContent=confirmLabel;
    return warningIcon;
  }
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-simple-delete]');
    if(!trigger||!simpleDeleteModal)return;
    event.preventDefault();
    closeActionPopover();
    simpleDeleteBulkHandler=null;
    const url=trigger.dataset.simpleDelete||'';
    const label=trigger.dataset.entityLabel||'data ini';
    const title=trigger.dataset.simpleDeleteTitle||'Hapus data ini?';
    const warning=trigger.dataset.simpleDeleteWarning||'Tindakan ini tidak dapat dibatalkan.';
    const warningIcon=applySimpleDeleteVariant(trigger);
    const targetEl=document.getElementById('simpleDeleteTarget');if(targetEl)targetEl.textContent=label;
    if(simpleDeleteTitleEl)simpleDeleteTitleEl.textContent=title;
    if(simpleDeleteWarningEl)simpleDeleteWarningEl.innerHTML=`<i class="bi ${warningIcon} me-2"></i>${escapeHtml(warning)}`;
    if(simpleDeleteForm)simpleDeleteForm.action=url||'#';
    simpleDeleteModal.show();
  });
  simpleDeleteConfirmBtn?.addEventListener('click',()=>{
    if(simpleDeleteBulkHandler){simpleDeleteBulkHandler();simpleDeleteModal?.hide();return;}
    if(!simpleDeleteForm?.action||simpleDeleteForm.action.endsWith('#'))return;
    simpleDeleteForm.submit();
  });
  // Small helper other bulk-action wiring blocks below reuse: builds+submits a hidden POST form.
  const submitBulkForm=(actionUrl,fields)=>{
    const csrfTokenMeta=document.querySelector('meta[name="csrf-token"]')?.content||'';
    const form=document.createElement('form');
    form.method='post';form.action=actionUrl;form.style.display='none';
    const addField=(name,value)=>{const field=document.createElement('input');field.type='hidden';field.name=name;field.value=value;form.appendChild(field);};
    addField('_csrf',csrfTokenMeta);
    Object.entries(fields).forEach(([key,value])=>{
      if(Array.isArray(value))value.forEach(v=>addField(key,v));
      else addField(key,value);
    });
    document.body.appendChild(form);form.submit();
  };
  // v1.21.1 — "Hapus Paksa" (Force Delete, Master Admin only). Confirm button stays disabled until the
  // typed text exactly matches data-force-delete-match (the record's own code/number) — deliberately
  // slower than a plain confirm() so a destructive override can never fire from one misclick.
  const forceDeleteModalEl=document.getElementById('forceDeleteModal');
  const forceDeleteModal=forceDeleteModalEl&&window.bootstrap?bootstrap.Modal.getOrCreateInstance(forceDeleteModalEl):null;
  const forceDeleteForm=document.getElementById('forceDeleteForm');
  const forceDeleteInput=document.getElementById('forceDeleteInput');
  const forceDeleteConfirmBtn=document.getElementById('forceDeleteConfirmBtn');
  const forceDeleteMatchLabel=document.getElementById('forceDeleteMatchLabel');
  const forceDeleteWarningEl=document.getElementById('forceDeleteWarning');
  let forceDeleteMatchValue='';
  let forceDeleteBulkHandler=null;
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-force-delete]');
    if(!trigger||!forceDeleteModal)return;
    event.preventDefault();
    closeActionPopover();
    forceDeleteBulkHandler=null;
    const url=trigger.dataset.forceDelete||'';
    const label=trigger.dataset.entityLabel||'data ini';
    const matchValue=trigger.dataset.forceDeleteMatch||'';
    const warning=trigger.dataset.forceDeleteWarning||'Tindakan ini tidak dapat dibatalkan.';
    forceDeleteMatchValue=matchValue;
    const targetEl=document.getElementById('forceDeleteTarget');if(targetEl)targetEl.textContent=label;
    if(forceDeleteMatchLabel)forceDeleteMatchLabel.textContent=matchValue||'-';
    if(forceDeleteWarningEl)forceDeleteWarningEl.innerHTML=`<i class="bi bi-exclamation-octagon-fill me-2"></i>${escapeHtml(warning)}`;
    if(forceDeleteInput)forceDeleteInput.value='';
    if(forceDeleteConfirmBtn)forceDeleteConfirmBtn.disabled=true;
    if(forceDeleteForm)forceDeleteForm.action=url||'#';
    forceDeleteModal.show();
    setTimeout(()=>forceDeleteInput?.focus(),200);
  });
  forceDeleteInput?.addEventListener('input',()=>{
    if(forceDeleteConfirmBtn)forceDeleteConfirmBtn.disabled=forceDeleteInput.value.trim()!==forceDeleteMatchValue.trim()||!forceDeleteMatchValue;
  });
  forceDeleteConfirmBtn?.addEventListener('click',()=>{
    if(forceDeleteBulkHandler){forceDeleteBulkHandler();forceDeleteModal?.hide();return;}
    if(!forceDeleteForm?.action||forceDeleteForm.action.endsWith('#'))return;
    forceDeleteForm.submit();
  });
  // Bulk variant: [data-force-delete-bulk] buttons — the typed confirmation text is a fixed literal
  // (data-force-delete-match, e.g. "HAPUS PAKSA") since there's no single record code to retype for a batch.
  document.querySelectorAll('[data-force-delete-bulk]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const scopeEl=document.querySelector(`[data-bulk-scope="${btn.dataset.bulkScopeId}"]`);
      const ids=scopeEl?._bulkSelectedIds?.()||[];
      if(!ids.length||!forceDeleteModal)return;
      const idField=btn.dataset.bulkIdField||'ids[]';
      const actionField=btn.dataset.bulkActionField||'action';
      const actionValue=btn.dataset.bulkActionValue||'force_delete';
      const url=btn.dataset.bulkUrl;
      const matchValue=btn.dataset.forceDeleteMatch||'HAPUS PAKSA';
      forceDeleteMatchValue=matchValue;
      const label=btn.dataset.entityLabelPlural?`${ids.length} ${btn.dataset.entityLabelPlural} terpilih`:`${ids.length} data terpilih`;
      const targetEl=document.getElementById('forceDeleteTarget');if(targetEl)targetEl.textContent=label;
      if(forceDeleteMatchLabel)forceDeleteMatchLabel.textContent=matchValue;
      if(forceDeleteWarningEl)forceDeleteWarningEl.innerHTML=`<i class="bi bi-exclamation-octagon-fill me-2"></i>${escapeHtml(btn.dataset.forceDeleteWarning||'Tindakan ini tidak dapat dibatalkan, termasuk untuk data yang masih memiliki riwayat/keterikatan.')}`;
      if(forceDeleteInput)forceDeleteInput.value='';
      if(forceDeleteConfirmBtn)forceDeleteConfirmBtn.disabled=true;
      forceDeleteBulkHandler=()=>submitBulkForm(url,{[actionField]:actionValue,[idField]:ids});
      forceDeleteModal.show();
      setTimeout(()=>forceDeleteInput?.focus(),200);
    });
  });

  // Generic opener for [data-simple-delete-bulk] bulk buttons: reads its data-bulk-scope-id target's
  // selected ids, then posts them to data-bulk-url with data-bulk-action-field=data-bulk-action-value.
  document.querySelectorAll('[data-simple-delete-bulk]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const scopeEl=document.querySelector(`[data-bulk-scope="${btn.dataset.bulkScopeId}"]`);
      const ids=scopeEl?._bulkSelectedIds?.()||[];
      if(!ids.length||!simpleDeleteModal)return;
      const idField=btn.dataset.bulkIdField||'ids[]';
      const actionField=btn.dataset.bulkActionField||'action';
      const actionValue=btn.dataset.bulkActionValue||'delete';
      const url=btn.dataset.bulkUrl;
      const label=btn.dataset.entityLabelPlural?`${ids.length} ${btn.dataset.entityLabelPlural} terpilih`:`${ids.length} data terpilih`;
      const warningIcon=applySimpleDeleteVariant(btn);
      const targetEl=document.getElementById('simpleDeleteTarget');if(targetEl)targetEl.textContent=label;
      if(simpleDeleteTitleEl)simpleDeleteTitleEl.textContent=btn.dataset.simpleDeleteTitle||'Hapus data terpilih?';
      if(simpleDeleteWarningEl)simpleDeleteWarningEl.innerHTML=`<i class="bi ${warningIcon} me-2"></i>${escapeHtml(btn.dataset.simpleDeleteWarning||'Tindakan ini tidak dapat dibatalkan. Data yang masih terikat/dipakai akan otomatis dilewati oleh sistem.')}`;
      simpleDeleteBulkHandler=()=>submitBulkForm(url,{[actionField]:actionValue,[idField]:ids});
      simpleDeleteModal.show();
    });
  });

  // v1.23 — WA Gateway integration: [data-wa-send] links (the "Kirim Pengingat" WA buttons on
  // Tagihan) send a real message through the gateway when it's connected, instead of just opening a
  // wa.me deep-link. If the gateway isn't connected, we deliberately do nothing extra here and let the
  // element's normal href="https://wa.me/..." navigation proceed — same manual fallback as before.
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-wa-send]');
    if (!trigger || !waGatewayConnectedGlobal) return;
    if (trigger.dataset.waSending === '1') return;
    event.preventDefault();
    trigger.dataset.waSending = '1';
    const originalHtml = trigger.innerHTML;
    const phone = trigger.dataset.waPhone || '';
    const message = decodeURIComponent(trigger.dataset.waMessage || '');
    const customerId = trigger.dataset.waCustomerId || null;
    const invoiceId = trigger.dataset.waInvoiceId || null;
    fetch('/wa-gateway/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ phone, message, customer_id: customerId, invoice_id: invoiceId }),
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.message || 'Gagal mengirim pesan.');
        trigger.innerHTML = '<i class="bi bi-check2-circle"></i><span>Masuk antrean</span>';
      })
      .catch(err => {
        trigger.innerHTML = '<i class="bi bi-exclamation-triangle-fill"></i><span>Gagal — klik lagi untuk manual</span>';
        console.error('WA Gateway: gagal mengirim pesan:', err.message);
        trigger.dataset.waSending = '';
        return;
      })
      .then(() => { setTimeout(() => { trigger.innerHTML = originalHtml; trigger.dataset.waSending = ''; }, 3000); });
  });

  // v1.20 — generic checkbox select-all + floating bulk action bar, used by [data-bulk-scope].
  document.querySelectorAll('[data-bulk-scope]').forEach(scope=>{
    const selectAll=scope.querySelector('[data-select-all]');
    const rowChecks=()=>[...scope.querySelectorAll('[data-row-check]')];
    const bar=document.getElementById(scope.dataset.bulkScope);
    const countEl=bar?.querySelector('[data-bulk-count]');
    const updateBar=()=>{
      const checked=rowChecks().filter(c=>c.checked);
      if(bar)bar.hidden=!checked.length;
      if(countEl)countEl.textContent=checked.length;
      if(selectAll){const all=rowChecks();selectAll.checked=all.length>0&&checked.length===all.length;selectAll.indeterminate=checked.length>0&&checked.length<all.length;}
    };
    selectAll?.addEventListener('change',()=>{rowChecks().forEach(c=>c.checked=selectAll.checked);updateBar();});
    scope.addEventListener('change',event=>{if(event.target.matches('[data-row-check]'))updateBar();});
    bar?.querySelector('[data-bulk-clear]')?.addEventListener('click',()=>{rowChecks().forEach(c=>c.checked=false);updateBar();});
    scope._bulkSelectedIds=()=>rowChecks().filter(c=>c.checked).map(c=>c.value);
    updateBar();
  });

  // v1.20 — Customers bulk actions (Section 3): bulk delete/archive, WA reminder shortcuts, bulk change package.
  const customerBulkScope=document.querySelector('[data-bulk-scope="customerBulkBar"]');
  if(customerBulkScope){
    const csrfTokenMeta=document.querySelector('meta[name="csrf-token"]')?.content||'';
    const waGatewayConnected=document.querySelector('meta[name="wa-gateway-connected"]')?.content==='1';
    const customerBulkBarEl=document.getElementById('customerBulkBar');
    const customerBulkReturnStatus=customerBulkBarEl?.dataset.returnStatus||'';
    const submitCustomerBulk=(action,extra={})=>{
      const ids=customerBulkScope._bulkSelectedIds();
      if(!ids.length)return;
      const form=document.createElement('form');
      form.method='post';form.action='/customers/bulk';form.style.display='none';
      const addField=(name,value)=>{const field=document.createElement('input');field.type='hidden';field.name=name;field.value=value;form.appendChild(field);};
      addField('_csrf',csrfTokenMeta);addField('action',action);addField('return_status',customerBulkReturnStatus);
      ids.forEach(id=>addField('customer_ids[]',id));
      Object.entries(extra).forEach(([key,value])=>addField(key,value));
      document.body.appendChild(form);form.submit();
    };
    // v1.20.1 — Section 1 of the revision: bulk "Hapus" now opens the same Arsipkan vs Hapus
    // Permanen choice modal as the per-row action, instead of directly archiving.
    document.getElementById('customerBulkDelete')?.addEventListener('click',()=>{
      const count=customerBulkScope._bulkSelectedIds().length;
      if(!count||!deleteChoiceModal)return;
      const targetEl=document.getElementById('deleteChoiceTarget');if(targetEl)targetEl.textContent=`${count} pelanggan terpilih`;
      if(deleteChoiceArchiveBtn)deleteChoiceArchiveBtn.disabled=false;
      if(deleteChoiceHardBtn){deleteChoiceHardBtn.disabled=false;deleteChoiceHardBtn.title='Pelanggan yang sudah memiliki riwayat tagihan akan otomatis dilewati.';}
      deleteChoiceBulkHandler={
        archiveConfirm:`Arsipkan ${count} pelanggan terpilih? Riwayat tagihan & pembayaran tetap aman dan dapat dipulihkan dari tab Data Diarsip.`,
        archive:()=>submitCustomerBulk('archive'),
        hardConfirm:`Hapus PERMANEN ${count} pelanggan terpilih? Pelanggan yang sudah memiliki riwayat tagihan akan otomatis dilewati dan tetap perlu diarsipkan. Tindakan ini tidak dapat dibatalkan untuk sisanya.`,
        hard:()=>submitCustomerBulk('hard_delete'),
      };
      deleteChoiceModal.show();
    });
    // v1.20.1 — Section 2 of the revision: Data Diarsip tab bulk hard-delete via the dedicated danger modal.
    document.getElementById('customerBulkHardDelete')?.addEventListener('click',()=>{
      const count=customerBulkScope._bulkSelectedIds().length;
      if(!count||!hardDeleteDangerModal)return;
      const targetEl=document.getElementById('hardDeleteDangerTarget');if(targetEl)targetEl.textContent=`${count} pelanggan terpilih`;
      hardDeleteDangerBulkHandler=()=>submitCustomerBulk('hard_delete');
      hardDeleteDangerModal.show();
    });
    document.getElementById('customerBulkPackageSubmit')?.addEventListener('click',()=>{
      const select=document.getElementById('customerBulkPackageSelect');
      if(!select?.value){alert('Pilih paket tujuan terlebih dahulu.');return;}
      const count=customerBulkScope._bulkSelectedIds().length;
      if(!count)return;
      if(!confirm(`Ubah paket ${count} pelanggan terpilih ke paket yang dipilih? Pelanggan pada site yang tidak cocok akan dilewati.`))return;
      submitCustomerBulk('package',{package_id:select.value});
      bootstrap.Modal.getOrCreateInstance(document.getElementById('customerBulkPackageModal'))?.hide();
    });
    // v1.23 — when WA Gateway is connected, "Kirim WA Reminder Massal" now sends a real automated blast
    // (one message per selected customer's open invoice, queued+rate-limited server-side) instead of
    // opening the manual click-each-link modal below. That modal is kept as the fallback when the
    // gateway isn't connected, so nothing regresses for setups that never link a gateway.
    document.getElementById('customerBulkWa')?.addEventListener('click',async(event)=>{
      if(waGatewayConnected){
        const ids=customerBulkScope._bulkSelectedIds();
        if(!ids.length)return;
        if(!confirm(`Kirim WA Blast pengingat tagihan ke ${ids.length} pelanggan terpilih via WA Gateway?`))return;
        const btn=event.currentTarget;btn.disabled=true;
        try{
          const r=await fetch('/wa-gateway/blast',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfTokenMeta},body:JSON.stringify({customer_ids:ids})});
          const data=await r.json().catch(()=>({}));
          if(!r.ok||!data.ok)throw new Error(data.message||'Blast gagal.');
          alert(`${data.enqueued} pesan dimasukkan ke antrean pengiriman.${data.skippedNoWa?` ${data.skippedNoWa} dilewati (nomor WA tidak valid).`:''}${data.skippedNoInvoice?` ${data.skippedNoInvoice} dilewati (tidak ada tagihan terbuka).`:''}`);
        }catch(err){ alert(`Gagal mengirim blast: ${err.message}`); }
        finally{ btn.disabled=false; }
        return;
      }
      const ids=new Set(customerBulkScope._bulkSelectedIds());
      const rows=[...document.querySelectorAll('[data-customer-row]')].filter(row=>ids.has(row.dataset.customerRow));
      const list=document.getElementById('customerBulkWaList');
      const withWa=rows.filter(row=>row.dataset.customerWa);
      // v1.20.1: build nodes via DOM APIs (textContent), never innerHTML with row.dataset values —
      // .dataset decodes HTML entities back to raw text, so a customer name containing markup would
      // otherwise execute as stored XSS the moment this modal opens. See CHANGED-FILES changelog.
      if(list){
        list.innerHTML='';
        if(!withWa.length){
          const empty=document.createElement('div');empty.className='ink-empty';empty.textContent='Pelanggan terpilih tidak memiliki nomor WhatsApp yang tervalidasi.';list.appendChild(empty);
        }else{
          withWa.forEach(row=>{
            const name=row.dataset.customerName||'',code=row.dataset.customerCode||'',wa=row.dataset.customerWa;
            const message=`Halo ${name}, ini pengingat dari INKAMNET mengenai layanan internet Anda. Mohon segera hubungi kami bila ada kendala pembayaran atau layanan. Terima kasih.`;
            const a=document.createElement('a');a.href=`https://wa.me/${wa}?text=${encodeURIComponent(message)}`;a.target='_blank';a.rel='noopener noreferrer';
            const avatar=document.createElement('span');avatar.className='psb-avatar';avatar.textContent=(name||'?').charAt(0).toUpperCase();
            const info=document.createElement('div');
            const strong=document.createElement('strong');strong.textContent=name;
            const small=document.createElement('small');small.textContent=code;
            info.append(strong,small);
            const icon=document.createElement('i');icon.className='bi bi-whatsapp';
            a.append(avatar,info,icon);
            list.appendChild(a);
          });
        }
      }
      const totalEl=document.getElementById('customerBulkWaTotal');if(totalEl)totalEl.textContent=withWa.length;
      const modalEl=document.getElementById('customerBulkWaModal');
      if(modalEl&&window.bootstrap)bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });
  }

  // Header command center: approval/operational notifications and internal user messages.
  const notificationList=document.getElementById('headerNotificationList');
  const messageList=document.getElementById('headerMessageList');
  const notificationBadge=document.getElementById('headerNotificationBadge');
  const messageBadge=document.getElementById('headerMessageBadge');
  const recipientSelect=document.getElementById('headerMessageRecipient');
  const composeForm=document.getElementById('headerMessageComposeForm');
  const csrfToken=document.querySelector('meta[name="csrf-token"]')?.content||'';
  let headerMessages=new Map(),headerUsers=[];
  const escapeHtml=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const relativeTime=value=>{const date=new Date(value),seconds=Math.max(0,Math.round((Date.now()-date.getTime())/1000));if(seconds<60)return 'baru saja';if(seconds<3600)return `${Math.floor(seconds/60)} menit lalu`;if(seconds<86400)return `${Math.floor(seconds/3600)} jam lalu`;return date.toLocaleDateString('id-ID',{day:'2-digit',month:'short'})};
  const setHeaderBadge=(element,value)=>{if(!element)return;element.textContent=value>99?'99+':String(value);element.hidden=!value};
  const renderHeaderCenter=data=>{
    setHeaderBadge(notificationBadge,Number(data.notificationCount||0));setHeaderBadge(messageBadge,Number(data.unreadMessages||0));
    if(notificationList)notificationList.innerHTML=data.notifications?.length?data.notifications.map(item=>`<a class="header-center-item ${escapeHtml(item.tone||'')} ${item.persistent?(item.read_at?'read':'unread'):''}" href="${escapeHtml(item.href||'#')}" ${item.persistent?`data-header-notification="${item.id}"`:''}><i class="bi ${escapeHtml(item.icon||'bi-bell')}"></i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail||'')}</small></span><em class="bi bi-chevron-right"></em></a>`).join(''):'<div class="header-center-empty"><i class="bi bi-check2-circle"></i><strong>Semua terkendali</strong><small>Belum ada notifikasi yang perlu ditindaklanjuti.</small></div>';
    headerMessages=new Map((data.messages||[]).map(message=>[String(message.id),message]));
    if(messageList)messageList.innerHTML=data.messages?.length?data.messages.map(message=>`<button type="button" class="header-message-item ${message.read_at?'':'unread'}" data-header-message="${message.id}"><span class="header-message-avatar">${escapeHtml(String(message.sender_name||'?').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(message.sender_name)}</strong><b>${escapeHtml(message.subject)}</b><small>${escapeHtml(String(message.body||'').slice(0,90))}</small></span><time>${relativeTime(message.created_at)}</time></button>`).join(''):'<div class="header-center-empty"><i class="bi bi-chat-heart"></i><strong>Belum ada pesan</strong><small>Kirim pesan baru untuk berkomunikasi dengan tim.</small></div>';
    headerUsers=data.users||[];if(recipientSelect){const current=recipientSelect.value;recipientSelect.innerHTML='<option value="">Pilih user penerima…</option>'+headerUsers.map(user=>`<option value="${user.id}">${escapeHtml(user.name)} · ${escapeHtml(user.role)}</option>`).join('');if(headerUsers.some(user=>String(user.id)===String(current)))recipientSelect.value=current;}
  };
  const loadHeaderCenter=async()=>{if(!notificationList&&!messageList)return;try{const response=await fetch('/communication/header',{headers:{Accept:'application/json'}}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Gagal memuat header');renderHeaderCenter(data)}catch(error){const failed=`<div class="header-center-empty danger"><i class="bi bi-wifi-off"></i><strong>Data belum tersedia</strong><small>${escapeHtml(error.message)}</small></div>`;if(notificationList)notificationList.innerHTML=failed;if(messageList)messageList.innerHTML=failed;}};
  const communicationPost=async(url,payload={})=>{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken,Accept:'application/json'},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Permintaan gagal');return data};
  notificationList?.addEventListener('click',async event=>{const link=event.target.closest('[data-header-notification]');if(!link)return;event.preventDefault();const href=link.getAttribute('href')||'#';try{if(link.classList.contains('unread'))await communicationPost(`/communication/notifications/${link.dataset.headerNotification}/read`)}catch(_){}if(href&&href!=='#')window.location.href=href;else await loadHeaderCenter()});
  document.getElementById('headerNotificationReadAll')?.addEventListener('click',async()=>{try{await communicationPost('/communication/notifications/read-all');await loadHeaderCenter()}catch(_){}});
  messageList?.addEventListener('click',async event=>{const button=event.target.closest('[data-header-message]');if(!button)return;const message=headerMessages.get(button.dataset.headerMessage);if(!message)return;document.getElementById('headerMessageSender').textContent=`DARI ${message.sender_name}`;document.getElementById('headerMessageSubject').textContent=message.subject;document.getElementById('headerMessageTime').textContent=new Date(message.created_at).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'});document.getElementById('headerMessageBody').textContent=message.body;const reply=document.getElementById('headerMessageReply');reply.dataset.recipient=message.sender_id;reply.dataset.subject=message.subject;bootstrap.Modal.getOrCreateInstance(document.getElementById('headerMessageViewModal')).show();if(!message.read_at){button.classList.remove('unread');message.read_at=new Date().toISOString();try{await communicationPost(`/communication/messages/${message.id}/read`);setHeaderBadge(messageBadge,Math.max(0,Number(messageBadge.textContent||0)-1))}catch(_){}}});
  document.getElementById('headerMessageReadAll')?.addEventListener('click',async()=>{try{await communicationPost('/communication/messages/read-all');messageList?.querySelectorAll('.unread').forEach(item=>item.classList.remove('unread'));setHeaderBadge(messageBadge,0)}catch(_){}});
  document.getElementById('headerMessageReply')?.addEventListener('click',event=>{const button=event.currentTarget,compose=document.getElementById('headerMessageComposeModal'),view=document.getElementById('headerMessageViewModal');bootstrap.Modal.getOrCreateInstance(view).hide();if(recipientSelect)recipientSelect.value=button.dataset.recipient||'';if(composeForm?.elements.subject)composeForm.elements.subject.value=`Re: ${button.dataset.subject||''}`.slice(0,140);setTimeout(()=>bootstrap.Modal.getOrCreateInstance(compose).show(),180)});
  composeForm?.addEventListener('submit',async event=>{event.preventDefault();const status=document.getElementById('headerMessageStatus'),button=composeForm.querySelector('[type="submit"]');button.disabled=true;status.hidden=true;try{const data=Object.fromEntries(new FormData(composeForm));const out=await communicationPost('/communication/messages',data);status.className='header-message-status success';status.textContent=out.message;status.hidden=false;composeForm.reset();setTimeout(()=>bootstrap.Modal.getOrCreateInstance(document.getElementById('headerMessageComposeModal')).hide(),650);await loadHeaderCenter()}catch(error){status.className='header-message-status danger';status.textContent=error.message;status.hidden=false}finally{button.disabled=false}});
  document.getElementById('headerNotificationButton')?.addEventListener('shown.bs.dropdown',loadHeaderCenter);
  document.getElementById('headerMessageButton')?.addEventListener('shown.bs.dropdown',loadHeaderCenter);
  loadHeaderCenter();setInterval(loadHeaderCenter,45000);

  // Progressive reveal for dense admin screens without adding a heavy animation library.
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
      if(entry.isIntersecting){entry.target.classList.add('ink-viewport-visible');observer.unobserve(entry.target)}
    }),{threshold:.08,rootMargin:'0px 0px -24px 0px'});
    document.querySelectorAll('.command-panel,.command-kpi,.command-pulse,.plan-card,.data-card,.filter-card').forEach(el=>observer.observe(el));
  }

  // Apple-style redesign: replace native confirm() popups with a shared iOS-style alert sheet.
  // Scans for the legacy onsubmit/onclick="return confirm('...')" pattern once at load, extracts
  // the message, strips the inline attribute, and re-fires the original submit/click exactly once
  // after the user confirms (guarded by a one-shot dataset flag so this listener lets it through
  // the second time instead of looping).
  (function () {
    let overlay, titleEl, bodyEl, confirmBtn, cancelBtn, resolveFn;
    function ensureOverlay() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'ios-alert-backdrop';
      overlay.innerHTML =
        '<div class="ios-alert-card" role="alertdialog" aria-modal="true">' +
          '<div class="ios-alert-body"><h4></h4><p></p></div>' +
          '<div class="ios-alert-actions">' +
            '<button type="button" class="ios-alert-btn ios-alert-cancel">Batal</button>' +
            '<button type="button" class="ios-alert-btn ios-alert-confirm"></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      titleEl = overlay.querySelector('h4');
      bodyEl = overlay.querySelector('p');
      confirmBtn = overlay.querySelector('.ios-alert-confirm');
      cancelBtn = overlay.querySelector('.ios-alert-cancel');
      function close(result) {
        overlay.classList.remove('show');
        if (resolveFn) { const r = resolveFn; resolveFn = null; r(result); }
      }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      cancelBtn.addEventListener('click', function () { close(false); });
      confirmBtn.addEventListener('click', function () { close(true); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('show')) close(false);
      });
    }

    window.iosConfirm = function (message, opts) {
      opts = opts || {};
      ensureOverlay();
      const qIdx = message.indexOf('?');
      const title = qIdx >= 0 ? message.slice(0, qIdx + 1).trim() : message.trim();
      const body = qIdx >= 0 ? message.slice(qIdx + 1).trim() : '';
      const isDanger = opts.danger !== undefined ? opts.danger : /hapus|reboot|putuskan|nonaktif|kunci|batalkan/i.test(title);
      titleEl.textContent = title;
      bodyEl.textContent = body;
      bodyEl.hidden = !body;
      const firstWord = (title.match(/^[A-Za-zÀ-ÿ]+/) || [''])[0];
      confirmBtn.textContent = opts.confirmLabel || (firstWord ? ('Ya, ' + firstWord) : 'Lanjutkan');
      confirmBtn.className = 'ios-alert-btn ios-alert-confirm' + (isDanger ? ' danger' : '');
      overlay.classList.add('show');
      return new Promise(function (resolve) {
        resolveFn = resolve;
        setTimeout(function () { confirmBtn.focus(); }, 10);
      });
    };

    function bindConfirmIntercept(el, attr) {
      const raw = el.getAttribute(attr);
      const m = raw && raw.match(/confirm\(\s*(['"])([\s\S]*?)\1\s*\)/);
      if (!m) return;
      el.removeAttribute(attr);
      const eventName = attr === 'onsubmit' ? 'submit' : 'click';
      el.addEventListener(eventName, function (e) {
        if (el.dataset.iosConfirmed === '1') { delete el.dataset.iosConfirmed; return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        window.iosConfirm(m[2]).then(function (ok) {
          if (!ok) return;
          el.dataset.iosConfirmed = '1';
          if (eventName === 'submit') {
            if (el.requestSubmit) el.requestSubmit(); else el.submit();
          } else if (el.form) {
            el.form.requestSubmit(el);
          } else {
            el.click();
          }
        });
      }, true);
    }

    document.querySelectorAll('[onsubmit*="confirm("]').forEach(function (el) { bindConfirmIntercept(el, 'onsubmit'); });
    document.querySelectorAll('[onclick*="confirm("]').forEach(function (el) { bindConfirmIntercept(el, 'onclick'); });
  })();

})();

// MikroTik NMS — isolated page controller. Router credentials never enter this client.
(() => {
  const root=document.getElementById('nmsApp');
  if(!root||root.dataset.nmsV2==='1')return;
  const $=s=>root.querySelector(s), $$=s=>[...root.querySelectorAll(s)];
  const csrf=root.dataset.csrf, isAdmin=root.dataset.admin==='1';
  const modalEl=document.getElementById('nmsSecretModal'), form=document.getElementById('nmsSecretForm');
  const modal=modalEl&&window.bootstrap?bootstrap.Modal.getOrCreateInstance(modalEl):null;
  let snapshots=[], selectedSite='all', trafficPrevious=new Map(), timer=null;
  const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const bytes=n=>{n=Number(n||0);if(!n)return '0 bps';const units=['bps','Kbps','Mbps','Gbps'];let i=0;while(n>=1000&&i<3){n/=1000;i++}return `${n>=10?n.toFixed(0):n.toFixed(1)} ${units[i]}`};
  const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n||0));
  const toast=(message,type='success')=>{const el=$('#nmsToast');el.className=`nms-toast ${type}`;el.innerHTML=`<i class="bi ${type==='danger'?'bi-x-octagon-fill':'bi-check-circle-fill'}"></i>${esc(message)}`;el.hidden=false;clearTimeout(el._t);el._t=setTimeout(()=>el.hidden=true,4200)};
  const allSecrets=()=>snapshots.flatMap(s=>s.secrets.map(x=>({...x,routerId:s.id,routerName:s.name,siteCode:s.siteCode,profiles:s.profiles})));

  function trafficRows(snapshot){
    const now=Date.now();
    return snapshot.interfaces.filter(x=>x.dynamic!=='true'&&x.disabled!=='true').map(x=>{
      const key=`${snapshot.id}:${x.name}`,old=trafficPrevious.get(key),seconds=old?Math.max((now-old.at)/1000,1):0;
      const rx=old?Math.max((x.rxByte-old.rx)*8/seconds,0):0,tx=old?Math.max((x.txByte-old.tx)*8/seconds,0):0;
      trafficPrevious.set(key,{rx:x.rxByte,tx:x.txByte,at:now});return {...x,rxRate:rx,txRate:tx};
    }).sort((a,b)=>(b.rxRate+b.txRate)-(a.rxRate+a.txRate)).slice(0,3);
  }

  function renderCard(snapshot){
    const card=root.querySelector(`[data-router="${snapshot.id}"]`);if(!card)return;
    card.classList.remove('loading','online','offline');card.classList.add(snapshot.ok?'online':'offline');
    card.querySelector('.nms-health').textContent=snapshot.ok?'ONLINE':'UNREACHABLE';
    if(!snapshot.ok){card.querySelector('.nms-interface-bars').innerHTML=`<div class="nms-router-error"><i class="bi bi-exclamation-triangle-fill"></i><span>${esc(snapshot.error)}</span></div>`;return;}
    const cpu=Math.min(Number(snapshot.resource?.['cpu-load']||0),100),radar=card.querySelector('.nms-radar');radar.style.setProperty('--cpu',cpu);radar.querySelector('b').textContent=`${cpu}%`;
    const specs=card.querySelectorAll('.nms-router-spec b');specs[0].textContent=snapshot.resource?.version||'-';specs[1].textContent=snapshot.resource?.uptime||'-';specs[2].textContent=`${snapshot.latencyMs} ms`;
    ['online','offline','isolated','linked'].forEach((k,i)=>card.querySelectorAll('.nms-router-counts b')[i].textContent=snapshot.counts[k]||0);
    const traffic=trafficRows(snapshot);card.querySelector('.nms-interface-bars').innerHTML=traffic.length?traffic.map(x=>`<div class="nms-iface"><span><b><i class="bi bi-ethernet"></i>${esc(x.name)}</b><small class="${x.running==='true'?'up':''}">${x.running==='true'?'UP':'DOWN'}</small></span><div><em class="down"><i class="bi bi-arrow-down"></i>${bytes(x.rxRate)}</em><em class="up"><i class="bi bi-arrow-up"></i>${bytes(x.txRate)}</em></div></div>`).join(''):'<div class="nms-router-error"><span>Interface belum tersedia</span></div>';
  }
  function renderSummary(){
    const ok=snapshots.filter(x=>x.ok).length,total=snapshots.reduce((a,s)=>{for(const k of ['online','offline','isolated','linked'])a[k]+=Number(s.counts[k]||0);return a},{online:0,offline:0,isolated:0,linked:0});
    $('#nmsRouterCount').textContent=`${ok}/${snapshots.length}`;$('#nmsOnlineCount').textContent=total.online;$('#nmsOfflineCount').textContent=total.offline;$('#nmsIsolatedCount').textContent=total.isolated;$('#nmsLinkedCount').textContent=total.linked;
  }
  function renderTable(){
    const q=$('#nmsSearch').value.trim().toLowerCase(),status=$('#nmsStatusFilter').value;
    const rows=allSecrets().filter(x=>(selectedSite==='all'||x.siteCode===selectedSite)&&(status==='all'||x.status===status)&&(!q||`${x.name} ${x.customer?.name||''} ${x.customer?.customer_code||''} ${x.active?.address||''}`.toLowerCase().includes(q)));
    $('#nmsSecretRows').innerHTML=rows.length?rows.map(x=>`<tr class="nms-secret-row" data-status="${x.status}"><td><span class="nms-secret-status ${x.status}"><i></i>${x.status==='isolated'?'ISOLIR':x.status.toUpperCase()}</span></td><td><span class="cell-main">${esc(x.name)}</span><span class="cell-sub">${esc(x.comment||'Tanpa catatan')}</span></td><td>${x.customer?`<a class="nms-customer-link" href="/customers/${x.customer.id}"><b>${esc(x.customer.name)}</b><small>${esc(x.customer.customer_code)} · ${esc(x.customer.package_name||'-')}</small></a>`:'<span class="nms-unlinked"><i class="bi bi-link-45deg"></i>Belum terhubung</span>'}</td><td><span class="status-badge purple">${esc(x.siteCode)}</span><span class="cell-sub">${esc(x.routerName)}</span></td><td><span class="nms-profile">${esc(x.profile||'default')}</span></td><td>${x.active?`<span class="cell-main">${esc(x.active.address||'-')}</span><span class="cell-sub">${esc(x.active.uptime||'-')} · ${esc(x.active['caller-id']||'-')}</span>`:'<span class="cell-sub">Tidak ada sesi aktif</span>'}</td><td>${x.customer?`<span class="${Number(x.customer.outstanding)>0?'text-danger-soft':'text-success-soft'}">${money(x.customer.outstanding)}</span>`:'-'}</td><td>${isAdmin?`<button class="nms-row-action" data-secret-edit="${esc(x['.id'])}" data-router="${x.routerId}" title="Lihat dan ubah"><i class="bi bi-sliders2"></i></button>`:''}</td></tr>`).join(''):`<tr><td colspan="8"><div class="empty-state"><i class="bi bi-search"></i><strong>Secret tidak ditemukan</strong><small>Ubah site, status, atau kata pencarian.</small></div></td></tr>`;
  }
  function render(){snapshots.forEach(renderCard);renderSummary();renderTable();$$('.nms-router-card').forEach(x=>x.hidden=selectedSite!=='all'&&x.dataset.site!==selectedSite)}
  async function refresh(silent=false){
    const button=$('#nmsRefresh');button?.classList.add('spinning');
    try{const r=await fetch('/network/api/snapshot',{headers:{Accept:'application/json'}}),data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'Telemetry gagal');snapshots=data.snapshots;render();$('#nmsLastSync').textContent=new Date(data.generatedAt).toLocaleTimeString('id-ID');if(!silent)toast('Telemetry tiga site berhasil disinkronkan.');}
    catch(e){toast(e.message,'danger');$('#nmsLastSync').textContent='SYNC ERROR';}
    finally{button?.classList.remove('spinning')}
  }
  async function loadCustomers(routerId,selected=''){
    const select=form.elements.customer_id;select.innerHTML='<option value="">Memuat pelanggan…</option>';
    try{const r=await fetch(`/network/api/routers/${routerId}/customers`),data=await r.json();if(!r.ok)throw new Error(data.error);select.innerHTML='<option value="">Tanpa pelanggan billing</option>'+data.customers.map(c=>`<option value="${c.id}" ${String(c.id)===String(selected)?'selected':''}>${esc(c.customer_code)} · ${esc(c.name)}${c.pppoe_username?` (${esc(c.pppoe_username)})`:''}</option>`).join('');}catch(e){select.innerHTML='<option value="">Gagal memuat pelanggan</option>';toast(e.message,'danger')}
  }
  function setProfiles(routerId,selected='default'){const snapshot=snapshots.find(x=>String(x.id)===String(routerId)),select=form.elements.profile;select.innerHTML=(snapshot?.profiles?.length?snapshot.profiles:[{name:'default'}]).map(p=>`<option value="${esc(p.name)}" ${p.name===selected?'selected':''}>${esc(p.name)}${p['rate-limit']?` · ${esc(p['rate-limit'])}`:''}</option>`).join('')}
  function openForm(secret=null,routerId=''){
    form.reset();form.elements.secret_id.value=secret?.['.id']||'';form.elements.router_id.value=routerId||secret?.routerId||'';form.elements.router_id.disabled=!!secret;
    for(const name of ['name','service','local-address','remote-address','caller-id','comment'])if(form.elements[name])form.elements[name].value=secret?.[name]|| (name==='service'?'pppoe':'');
    form.elements.disabled.checked=secret?.disabled==='true';document.getElementById('nmsModalTitle').textContent=secret?`Kelola ${secret.name}`:'Secret PPPoE Baru';setProfiles(form.elements.router_id.value,secret?.profile||'default');loadCustomers(form.elements.router_id.value,secret?.customer?.id||'');modal?.show();
  }
  $('#nmsRefresh')?.addEventListener('click',()=>refresh());$('#nmsAddSecret')?.addEventListener('click',()=>openForm());
  $('#nmsSearch')?.addEventListener('input',renderTable);$('#nmsStatusFilter')?.addEventListener('change',renderTable);
  $$('.nms-site-tabs button').forEach(btn=>btn.addEventListener('click',()=>{$$('.nms-site-tabs button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');selectedSite=btn.dataset.site;render()}));
  form?.elements.router_id.addEventListener('change',e=>{setProfiles(e.target.value);loadCustomers(e.target.value)});
  form?.querySelector('[data-password-toggle]')?.addEventListener('click',e=>{const input=form.elements.password;input.type=input.type==='password'?'text':'password';e.currentTarget.querySelector('i').className=`bi ${input.type==='password'?'bi-eye':'bi-eye-slash'}`});
  root.addEventListener('click',e=>{const b=e.target.closest('[data-secret-edit]');if(!b)return;const secret=allSecrets().find(x=>String(x['.id'])===b.dataset.secretEdit&&String(x.routerId)===b.dataset.router);if(secret)openForm(secret,b.dataset.router)});
  form?.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('[type="submit"]'),data=Object.fromEntries(new FormData(form));data.router_id=form.elements.router_id.value;data.disabled=form.elements.disabled.checked?'true':'false';const id=data.secret_id;delete data.secret_id;button.disabled=true;try{const r=await fetch(id?`/network/secrets/${encodeURIComponent(id)}`:'/network/secrets',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,Accept:'application/json'},body:JSON.stringify(data)}),out=await r.json();if(!r.ok||!out.ok)throw new Error(out.error||'Gagal menyimpan');modal?.hide();toast(out.message);await refresh(true)}catch(err){toast(err.message,'danger')}finally{button.disabled=false}});
  refresh(true);timer=setInterval(()=>refresh(true),15000);window.addEventListener('beforeunload',()=>clearInterval(timer));
})();
