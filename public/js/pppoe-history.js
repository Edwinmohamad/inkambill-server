(() => {
  const N=window.NX,root=document.getElementById('nmsHistory');
  if(!N||!root)return;
  const {api,esc,toast}=N;
  async function load(){
    try {
      const {rows}=await api('/nms/api/sync/batches');
      const selected=rows.filter(row=>!N.site||String(row.site_id)===String(N.site));
      document.getElementById('historyRows').innerHTML=selected.map(row=>`<tr><td>${esc(N.dateTime(row.created_at))}</td><td>${esc(row.site_code||'Semua')}</td><td>${esc(row.created_by_name||'—')}</td><td>${esc(row.source||'manual')}</td><td>${Number(row.linked_count)||0}</td><td>${row.undone_at?'Dibatalkan':'Tersimpan'}</td><td><a class="nx-btn sm" href="/nms/api/sync/batches/${Number(row.id)}/export">CSV</a>${row.can_undo&&N.canControl?` <button type="button" class="nx-btn sm" data-undo="${Number(row.id)}">Batalkan</button>`:''}</td></tr>`).join('')||'<tr><td colspan="7">Belum ada riwayat sinkronisasi.</td></tr>';
      const approval=document.getElementById('approvalRows');
      if(approval){
        const result=await api('/nms/api/approvals');
        approval.innerHTML=result.rows.filter(row=>row.status==='pending').map(row=>`<p>${esc(row.action)} · ${esc(row.reason||row.note||'Perubahan akun PPPoE')} <button class="nx-btn sm" type="button" data-approval="${Number(row.id)}" data-decision="approve">Setujui</button> <button class="nx-btn sm" type="button" data-approval="${Number(row.id)}" data-decision="reject">Tolak</button></p>`).join('')||'<p>Tidak ada perubahan yang menunggu persetujuan.</p>';
      }
      N.markUpdated();
    }catch(error){toast(error.message,'err');}
  }
  root.addEventListener('click',async event=>{
    const undo=event.target.closest('[data-undo]'),approval=event.target.closest('[data-approval]');
    if(!undo&&!approval)return;
    if(!await N.confirmBox({title:undo?'Batalkan mapping sinkronisasi?':'Konfirmasi keputusan',message:undo?'Link pelanggan dalam batch ini akan dibatalkan sesuai pemeriksaan server.':'Terapkan keputusan pada perubahan yang dipilih?',okText:'Lanjutkan'}))return;
    const button=undo||approval;button.disabled=true;
    try{await api(undo?`/nms/api/sync/batches/${undo.dataset.undo}/undo`:`/nms/api/approvals/${approval.dataset.approval}/${approval.dataset.decision}`,{method:'POST',body:{}});toast('Perubahan tersimpan.','ok');await load();}
    catch(error){toast(error.message,'err');}finally{button.disabled=false;}
  });
  document.getElementById('historyReload').addEventListener('click',load);
  load();
})();
