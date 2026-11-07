(()=>{
  const modal=document.getElementById('customerDetailPanel');if(!modal)return;
  const content=modal.querySelector('[data-customer-detail-body]');let request=null,sequence=0;
  document.addEventListener('click',async event=>{
    const link=event.target.closest('a[data-customer-detail]');
    if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||!window.bootstrap)return;
    event.preventDefault();request?.abort();request=new AbortController();const current=++sequence;
    content.textContent='Memuat detail pelanggan…';content.setAttribute('aria-busy','true');
    bootstrap.Modal.getOrCreateInstance(modal).show(link);
    try{
      const url=new URL(link.href);url.searchParams.set('panel','1');
      const response=await fetch(url,{signal:request.signal,headers:{Accept:'text/html'},credentials:'same-origin'});
      if(!response.ok||response.redirected)throw new Error('Detail gagal dimuat. Muat ulang halaman atau masuk kembali.');
      const html=await response.text();if(current!==sequence)return;
      // Server-rendered, escaped customer partial; no credentials or scripts in this response.
      content.innerHTML=html;
    }catch(error){if(error.name!=='AbortError'&&current===sequence){content.textContent=error.message;const retry=document.createElement('a');retry.href=link.href;retry.className='btn-tech';retry.textContent='Buka detail lengkap';content.append(retry);}}
    finally{if(current===sequence)content.removeAttribute('aria-busy');}
  });
  modal.addEventListener('hidden.bs.modal',()=>{sequence++;request?.abort();content.replaceChildren();});
})();
