// Request-driven reconciliation between customer billing and the PPPoE snapshot.
(() => {
  const N = window.NX;
  const app = document.getElementById('nmsInsights');
  if (!N || !app) return;
  const { esc, api, toast, qs, rupiah, dateOnly, dateTime } = N;
  const $ = id => document.getElementById(id);
  const ICON = { overdue_active: ['red', 'bi-cash-coin'], paid_isolated: ['orange', 'bi-emoji-frown'], inactive_online: ['red', 'bi-person-x'], secret_no_customer: ['purple', 'bi-question-circle'], customer_no_secret: ['blue', 'bi-person-plus'], removed_on_router: ['gray', 'bi-trash'], active_without_secret: ['red', 'bi-exclamation-triangle'], profile_mismatch: ['orange', 'bi-sliders'] };
  let groups = {};

  // ---------------------------------------------------------------- Rekonsiliasi
  async function loadRecon() {
    try { ({ groups } = await api(`/nms/api/reconcile${N.withSite()}`)); }
    catch (err) { $('nxRecon').innerHTML = `<div class="nx-card"><div class="nx-empty">${esc(err.message)}</div></div>`; return; }
    $('nxRecon').innerHTML = Object.values(groups).map(g => { const [cls, ic] = ICON[g.key] || ['gray', 'bi-dot']; return `<button type="button" class="nx-recon-tile ${g.count ? '' : 'zero'}" data-k="${g.key}"><div class="top"><strong>${g.count}</strong><span class="li-icon ${g.count ? cls : 'gray'}" style="width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#fff;background:var(--x-${g.count ? ({ red: 'red', orange: 'orange', purple: 'purple', blue: 'blue', gray: 'gray' }[cls]) : 'gray'})"><i class="bi ${ic}"></i></span></div><b>${esc(g.title)}</b><p>${esc(g.hint)}</p>${g.error ? `<p style="color:var(--x-red)">${esc(g.error)}</p>` : ''}</button>`; }).join('');
  }
  $('nxRecon').addEventListener('click', e => { const t = e.target.closest('[data-k]'); if (t) openRecon(t.dataset.k); });

  const rowName = r => r.customer_name || r.username;
  function cells(kind, r) {
    const hold = r.isolate_hold_until && String(r.isolate_hold_until).slice(0, 10) >= N.todayIso();
    switch (kind) {
      case 'overdue_active': return `<td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)} · <span class="mono">${esc(r.username)}</span></span></td><td>${esc(r.site_code)}</td><td class="num">${rupiah(r.outstanding)}</td><td>${r.days_late} hari${hold ? ` <span class="nx-pill orange">ditunda s.d. ${esc(dateOnly(r.isolate_hold_until))}</span>` : ''}</td><td><span class="nx-state ${r.is_online ? 'online' : 'offline'}">${r.is_online ? 'Online' : 'Offline'}</span></td>`;
      case 'paid_isolated': return `<td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)} · <span class="mono">${esc(r.username)}</span></span></td><td>${esc(r.site_code)}</td><td>${esc(r.profile || '—')}${r.original_profile ? `<span class="sub">asal ${esc(r.original_profile)}</span>` : ''}</td><td>${r.last_paid_at ? esc(dateTime(r.last_paid_at)) : '—'}</td><td>${esc(r.isolation_reason || '—')}</td>`;
      case 'inactive_online': return `<td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)} · <span class="mono">${esc(r.username)}</span></span></td><td>${esc(r.site_code)}</td><td><span class="nx-pill">${esc(r.customer_status)}</span></td><td colspan="2">${esc(r.profile || '')}</td>`;
      case 'secret_no_customer': return `<td><b class="mono">${esc(r.username)}</b>${r.comment ? `<span class="sub">${esc(r.comment)}</span>` : ''}</td><td>${esc(r.site_code)}<span class="sub">${esc(r.router_name)}</span></td><td>${esc(r.profile || '—')}</td><td class="mono">${esc(r.active_address || '—')}</td><td><span class="nx-state ${r.is_online ? 'online' : 'offline'}">${r.is_online ? 'Online' : dateTime(r.last_login_at)}</span></td>`;
      case 'customer_no_secret': return `<td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)}</span></td><td>${esc(r.site_code)}</td><td>${esc(r.package_name || '—')}${r.mikrotik_profile ? `<span class="sub">${esc(r.mikrotik_profile)}</span>` : ''}</td><td colspan="2">${esc(dateOnly(r.created_at))}</td>`;
      case 'removed_on_router': return `<td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)} · <span class="mono">${esc(r.username)}</span></span></td><td>${esc(r.site_code)}</td><td>${esc(r.profile || '—')}</td><td colspan="2">Hilang ${esc(dateTime(r.removed_on_router_at))}</td>`;
      case 'active_without_secret': return `<td><b class="mono">${esc(r.username)}</b><span class="sub">Aktif ${esc(r.active_uptime || '—')}</span></td><td>${esc(r.site_code)}<span class="sub">${esc(r.router_name)}</span></td><td class="mono">${esc(r.active_address || '—')}</td><td class="mono">${esc(r.active_caller_id || '—')}</td><td>${esc(dateTime(r.last_seen_at))}</td>`;
      case 'profile_mismatch': return `<td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)} · <span class="mono">${esc(r.username)}</span></span></td><td>${esc(r.site_code)}</td><td>${esc(r.profile || '—')}</td><td>${esc(r.package_profile || '—')}</td><td>${esc(r.package_name || '—')}</td>`;
      default: return '';
    }
  }
  const HEADS = {
    overdue_active: ['Pelanggan', 'Site', 'Tunggakan', 'Terlambat', 'Sesi'], paid_isolated: ['Pelanggan', 'Site', 'Profile', 'Bayar terakhir', 'Alasan isolir'],
    inactive_online: ['Pelanggan', 'Site', 'Status billing', 'Profile', ''], secret_no_customer: ['Username', 'Site / Router', 'Profile', 'IP', 'Sesi'],
    customer_no_secret: ['Pelanggan', 'Site', 'Paket', 'Dibuat', ''], removed_on_router: ['Pelanggan', 'Site', 'Profile', 'Keterangan', ''],
    active_without_secret: ['Username', 'Site / Router', 'IP', 'Caller-ID', 'Terlihat terakhir'], profile_mismatch: ['Pelanggan', 'Site', 'Profile MikroTik', 'Profile Paket', 'Paket']
  };
  async function openRecon(kind) {
    const g = groups[kind]; if (!g) return;
    const bulkable = ['isolate', 'unisolate'].includes(g.fix) && N.canControl;
    const s = N.sheet({ title: g.title, subtitle: esc(g.hint), size: 'lg', body: '<div class="nx-empty">Memuat…</div>',
      foot: `<a class="nx-btn" href="/nms/api/export${qs({ site: N.site || undefined, kind })}"><i class="bi bi-download"></i>CSV</a><span class="grow"></span><button type="button" class="nx-btn" data-close>Tutup</button>${bulkable ? `<button type="button" class="nx-btn ${g.fix === 'isolate' ? 'solid-red' : 'primary'}" data-bulk disabled>${esc(g.fixLabel)} yang dipilih</button>` : ''}` });
    let rows = [];
    try { ({ groups: { [kind]: { rows } } } = await api(`/nms/api/reconcile${qs({ site: N.site || undefined, kind })}`)); }
    catch (err) { s.body.innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; return; }
    if (!rows.length) { s.body.innerHTML = '<div class="nx-empty"><i class="bi bi-check-circle"></i>Tidak ada temuan. Semua cocok.</div>'; return; }
    const today = N.todayIso();
    s.body.innerHTML = `<div class="nx-table-wrap" style="max-height:60vh;border:1px solid var(--x-line);border-radius:12px"><table class="nx-table"><thead><tr>${bulkable ? '<th class="check"><input type="checkbox" data-all aria-label="Semua"></th>' : ''}${HEADS[kind].map(h => `<th>${h}</th>`).join('')}<th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-i="${i}">${bulkable ? `<td class="check"><input type="checkbox" data-pick="${i}" ${kind === 'overdue_active' && r.isolate_hold_until && String(r.isolate_hold_until).slice(0, 10) >= today ? '' : 'checked'}></td>` : ''}${cells(kind, r)}<td><div class="nx-actions">${fixButtons(g, r, i)}</div></td></tr>`).join('')}
    </tbody></table></div><p class="dim" style="font-size:12px;margin:8px 2px 0">${rows.length >= 300 ? 'Menampilkan 300 teratas. Unduh CSV untuk daftar lengkap.' : `${rows.length} temuan.`}</p>`;
    const picked = () => s.$$('[data-pick]:checked').map(x => rows[Number(x.dataset.pick)]).filter(r => r.secret_id);
    const upd = () => { const b = s.$('[data-bulk]'); if (!b) return; const n = picked().length; b.disabled = !n; b.textContent = n ? `${g.fixLabel} ${n} secret` : `${g.fixLabel} yang dipilih`; };
    s.$('[data-all]')?.addEventListener('change', e => { s.$$('[data-pick]').forEach(x => { x.checked = e.target.checked; }); upd(); });
    s.body.addEventListener('change', upd); upd();
    s.body.addEventListener('click', e => {
      const b = e.target.closest('[data-fix]');
      if (b) { e.stopPropagation(); return runFix(b.dataset.fix, rows[Number(b.dataset.row)], s); }
      const tr = e.target.closest('tr[data-i]');
      if (tr && !e.target.closest('input,button,a')) { const r = rows[Number(tr.dataset.i)]; if (r.secret_id) N.drawer(r.secret_id); }
    });
    s.$('[data-bulk]')?.addEventListener('click', async () => {
      const list = picked(); if (!list.length) return;
      s.close();
      const out = await N.deferred(`${g.fixLabel} ${list.length} secret…`, () => api('/nms/api/bulk', { method: 'POST', body: { action: g.fix, secretIds: list.map(r => r.secret_id) } }));
      if (!out) return;
      if (out.pendingApproval) { toast(`Butuh persetujuan admin lain. Permintaan #${out.approvalId} dikirim.`, 'info', { action: 'Lihat', onAction: () => location.assign(`/nms/automation${N.withSite()}`) }); return; }
      toast(`${g.fixLabel}: ${out.summary.succeeded}/${out.summary.total} berhasil${out.summary.failed ? `, ${out.summary.failed} gagal` : ''}.`, out.summary.failed ? 'err' : 'ok');
      N.changed();
    });
  }
  function fixButtons(g, r, i) {
    if (!N.canControl) return r.secret_id ? `<button type="button" class="nx-btn sm ghost" data-fix="detail" data-row="${i}">Detail</button>` : '';
    const b = (fix, label, cls = 'tint') => `<button type="button" class="nx-btn sm ${cls}" data-fix="${fix}" data-row="${i}">${label}</button>`;
    const ticket = b('ticket', 'Tiket teknisi', 'ghost');
    switch (g.fix) {
      case 'isolate': return b('isolate', 'Isolir', 'red') + (g.key === 'overdue_active' && r.customer_id ? b('hold', 'Tunda', '') : '') + ticket;
      case 'unisolate': return b('unisolate', 'Buka isolir', 'green') + ticket;
      case 'map': return b('map', 'Hubungkan') + b('create-customer', 'Buat pelanggan', '') + ticket;
      case 'create_secret': return b('create-secret', 'Buat ulang') + b('unmap', 'Putuskan mapping', 'ghost') + ticket;
      case 'recover_active': return b('refresh-active', 'Tarik ulang') + b('mark-radius', 'Tandai RADIUS', 'ghost') + ticket;
      case 'sync_profile': return b('sync-profile', 'Samakan profile') + ticket;
      default: return ticket;
    }
  }
  async function runFix(fix, r, s) {
    if (fix === 'detail') return N.drawer(r.secret_id);
    const row = { ...r, id: r.secret_id, is_isolated: fix === 'unisolate' ? 1 : 0 };
    if (fix === 'create-secret') return N.openCreateSecret(r, { onDone: () => { s.close(); loadRecon(); } });
    if (fix === 'map') return N.openMap(row, { onDone: () => { s.close(); loadRecon(); } });
    if (fix === 'create-customer') return N.openCreateCustomer(row, { onDone: () => { s.close(); loadRecon(); } });
    if (fix === 'unmap') { const out = await N.act(row, 'unmap'); if (out) { s.close(); loadRecon(); } return; }
    if (fix === 'sync-profile') {
      const yes = await N.confirmBox({ title: 'Samakan profile dengan paket?', okText: 'Samakan profile', message: `Profile <b class="mono">${esc(r.username)}</b> akan diubah dari <b>${esc(r.profile || '—')}</b> ke <b>${esc(r.package_profile || '—')}</b>. Sesi aktif diputus agar limit baru langsung berlaku.` });
      if (!yes) return;
      const out = await N.deferred(`Mengubah profile ${rowName(r)}…`, () => api(`/nms/api/secrets/${r.secret_id}/sync-profile`, { method: 'POST', body: {} }), { seconds: 4 });
      if (out) { toast(out.result.unchanged ? 'Profile sudah sesuai paket.' : `Profile ${r.username} disamakan ke ${out.result.to}.`, 'ok'); s.close(); N.changed(); }
      return;
    }
    if (fix === 'refresh-active') {
      try {
        const { result } = await api(`/nms/api/anomalies/${r.anomaly_id}/refresh`, { method: 'POST', body: {} });
        toast(result.recovered ? `${r.username} berhasil dipulihkan ke mirror NMS.` : `${r.username} tetap tidak ditemukan di /ppp/secret. Periksa RADIUS.`, result.recovered ? 'ok' : 'info');
        if (result.recovered) s.close(); loadRecon(); N.changed();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (fix === 'mark-radius') {
      const yes = await N.confirmBox({ title: 'Tandai sebagai sesi RADIUS?', okText: 'Tandai RADIUS', message: `Temuan <b class="mono">${esc(r.username)}</b> akan disembunyikan dari daftar “Active tanpa Secret Mirror”. Tidak ada konfigurasi router yang diubah.` });
      if (!yes) return;
      try { await api(`/nms/api/anomalies/${r.anomaly_id}/radius`, { method: 'POST', body: {} }); toast(`${r.username} ditandai sebagai sesi RADIUS.`, 'ok'); s.close(); loadRecon(); N.changed(); }
      catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (fix === 'ticket') {
      try {
        const { ticket: t } = await api('/nms/api/reconcile/ticket', { method: 'POST', body: { kind: g.key, secretId: r.secret_id || null, anomalyId: r.anomaly_id || null, customerId: r.customer_id || null } });
        toast(t.existing ? `Tiket ${t.code} sudah aktif.` : `Tiket ${t.code} dibuat.`, 'ok', { action: 'Buka', onAction: () => location.assign(`/tickets/${t.id}`) });
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    N.act(row, fix);
  }

  const all=()=>loadRecon().then(()=>N.markUpdated());
  document.addEventListener('nx:changed',()=>setTimeout(all,400));
  $('nxReconReload')?.addEventListener('click',all);
  $('nxReconPull')?.addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try {const {results}=await api('/nms/api/secrets/refresh'+N.withSite(),{method:'POST',body:{}});const failed=results.filter(r=>!r.ok);if(results.some(r=>r.activeWarning))toast('Sesi aktif belum seluruhnya terbaca; hasil rekonsiliasi koneksi memakai snapshot sebelumnya.','err');toast(failed.length?`${failed.length} router gagal diperbarui. Data sebelumnya dipertahankan.`:'Data PPPoE diperbarui.',failed.length?'err':'ok');await all();}
    catch(error){toast(error.message,'err');}finally{button.disabled=false;}
  });
  all().then(()=>{const kind=new URL(location.href).searchParams.get('kind');if(kind&&groups[kind])openRecon(kind);});
})();
