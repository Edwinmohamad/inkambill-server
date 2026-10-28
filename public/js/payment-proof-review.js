(()=>{
  const labels={ok:'Cocok',warning:'Tidak cocok',unreadable:'Perlu diperiksa',processing:'Sedang membaca bukti'};
  async function read(id){const r=await fetch(`/payments/${id}/proof-ocr`,{signal:AbortSignal.timeout(15000),cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw Error('Hasil OCR gagal dimuat; periksa bukti secara manual.');const body=await r.json();if(!body.ok||!body.item)throw Error('Hasil OCR tidak valid; periksa bukti secara manual.');return body.item;}
  function paint(target,item){target.replaceChildren();const title=document.createElement('strong');title.textContent=labels[item.overall]||'Perlu diperiksa';target.append(title);for(const check of item.checks||[]){const row=document.createElement('p');row.textContent=`${check.level==='ok'?'Cocok':check.level==='warn'?'Tidak cocok':'Perlu diperiksa'} — ${check.label}: ${check.detail}`;target.append(row);}const summary=document.createElement('p');summary.textContent=item.summary||'Periksa gambar secara manual.';target.append(summary);}
  const cells=[...document.querySelectorAll('[data-payment-ocr]')];
  const pending=[...cells];let active=0;
  function schedule(cell){if(cell.dataset.loading==='1')return;cell.dataset.loading='1';pending.push(cell);drain();}
  function drain(){while(active<3&&pending.length){const cell=pending.shift();active++;loadCell(cell).finally(()=>{active--;drain();});}}
  async function loadCell(cell){
    cell.dataset.loading='1';cell.textContent='Memeriksa bukti…';
    let processing=false;
    try{
      const item=await read(cell.dataset.paymentOcr);processing=item.overall==='processing';
      cell.replaceChildren();
      const badge=document.createElement('span');badge.className='status-badge '+({ok:'green',warning:'red',unreadable:'orange',processing:'purple'}[item.overall]||'orange');
      badge.textContent=processing?'Memproses':item.overall==='ok'?'Sesuai':item.overall==='warning'?'Tidak sesuai':'Perlu diperiksa';cell.append(badge);
      const brief=document.createElement('small');brief.className='cell-sub';
      brief.textContent=(item.checks||[]).filter(c=>['amount','date','account'].includes(c.key)).map(c=>({amount:'Nominal',date:'Tanggal',account:'Rekening'}[c.key])+' '+(c.level==='ok'?'✓':c.level==='warn'?'⚠':'?')).join(' · ')||item.summary||'Menunggu hasil OCR';cell.append(brief);
      if(!processing){const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');summary.textContent='Detail pemeriksaan';paint(body,item);details.append(summary,body);cell.append(details);}
    }catch(error){cell.textContent='Hasil OCR gagal dimuat. Periksa koneksi atau coba lagi.';}
    finally{cell.dataset.loading='0';}
    const attempts=Number(cell.dataset.attempts||0)+1;cell.dataset.attempts=String(attempts);
    if(processing&&attempts<12){setTimeout(()=>schedule(cell),2500);return;}
    if(processing){const note=document.createElement('small');note.className='cell-sub';note.textContent='Pembacaan belum selesai. Coba lagi atau periksa bukti secara manual.';cell.append(note);}
    if(!processing&&cell.children[0]?.textContent==='Sesuai')return;
    const retry=document.createElement('button');retry.type='button';retry.className='ocr-refresh';retry.textContent='Coba Lagi';retry.addEventListener('click',()=>{cell.dataset.attempts='0';schedule(cell);});cell.append(retry);
  }
  drain();
  let proofRequest=0;
  document.getElementById('proofViewerModal')?.addEventListener('show.bs.modal',async event=>{const btn=event.relatedTarget;if(!btn)return;const card=document.getElementById('proofOcrFields');if(!card)return;const request=++proofRequest;card.textContent='Membaca bukti…';document.getElementById('proofOcrStatus').textContent='Memproses';try{const id=btn.dataset.proofUrl.match(/payments\/(\d+)/)?.[1];let item=await read(id);for(let attempt=0;item.overall==='processing'&&attempt<10&&request===proofRequest;attempt++){await new Promise(resolve=>setTimeout(resolve,1500));item=await read(id);}if(request!==proofRequest)return;paint(card,item);document.getElementById('proofOcrStatus').textContent=labels[item.overall]||'Perlu diperiksa';}catch(e){if(request===proofRequest){card.textContent=e.message;document.getElementById('proofOcrStatus').textContent='Gagal dimuat';}}});
  const form=document.getElementById('paymentApproveForm');let approvalRequest=0;
  document.querySelectorAll('.payment-approve-btn').forEach(btn=>btn.addEventListener('click',async()=>{if(!form)return;const request=++approvalRequest;const target=form.querySelector('.approval-ocr-summary'),reason=form.elements.review_reason;reason.value='';reason.required=true;target.textContent='Memeriksa hasil OCR…';try{let item=await read(btn.dataset.paymentId);for(let attempt=0;item.overall==='processing'&&attempt<10&&request===approvalRequest;attempt++){await new Promise(resolve=>setTimeout(resolve,1500));item=await read(btn.dataset.paymentId);}if(request!==approvalRequest)return;paint(target,item);reason.required=item.overall!=='ok';reason.minLength=5;}catch(e){if(request===approvalRequest)target.textContent=e.message;}}));
  document.getElementById('paymentApproveModal')?.addEventListener('hidden.bs.modal',()=>{approvalRequest++;});
  const bulk=document.getElementById('bulkPaymentApproveForm');if(bulk){bulk.querySelector('.approval-ocr-summary').textContent='Periksa bukti masing-masing pembayaran sebelum approval massal. Alasan wajib untuk hasil berbeda atau belum jelas.';}
  const img=document.getElementById('proofViewerImage');if(img){img.style.cursor='zoom-in';img.addEventListener('click',()=>{const zoom=img.style.maxWidth==='none';img.style.maxWidth=zoom?'':'none';img.style.maxHeight=zoom?'':'none';img.style.cursor=zoom?'zoom-in':'zoom-out';});document.getElementById('proofViewerModal')?.addEventListener('hidden.bs.modal',()=>{proofRequest++;img.style.maxWidth='';img.style.maxHeight='';});}
})();
