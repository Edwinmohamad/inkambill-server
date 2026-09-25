// Rekonsiliasi billing ↔ router, kesehatan site/ODP + info gangguan, akun dipakai bersama, putus-sambung.
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
    switch (g.fix) {
      case 'isolate': return b('isolate', 'Isolir', 'red') + (g.key === 'overdue_active' && r.customer_id ? b('hold', 'Tunda', '') : '');
      case 'unisolate': return b('unisolate', 'Buka isolir', 'green');
      case 'map': return b('map', 'Hubungkan') + b('create-customer', 'Buat pelanggan', '');
      case 'create_secret': return b('create-secret', 'Buat secret');
      default: return '';
    }
  }
  function runFix(fix, r, s) {
    if (fix === 'detail') return N.drawer(r.secret_id);
    const row = { ...r, id: r.secret_id, is_isolated: fix === 'unisolate' ? 1 : 0 };
    if (fix === 'create-secret') return N.openCreateSecret(r, { onDone: () => { s.close(); loadRecon(); } });
    if (fix === 'map') return N.openMap(row, { onDone: () => { s.close(); loadRecon(); } });
    if (fix === 'create-customer') return N.openCreateCustomer(row, { onDone: () => { s.close(); loadRecon(); } });
    N.act(row, fix);
  }

  // ---------------------------------------------------------------- Kesehatan site + ODP
  // Ring online%: makin tinggi makin baik (kebalikan ring CPU/RAM), jadi warnanya ditentukan di sini.
  const onlineColor = s => { const c = N.COLORS(), p = Number(s.onlinePct) || 0; return !Number(s.secrets) ? c.gray : Number(s.routers_up) === 0 && Number(s.routers) > 0 ? c.red : p >= 80 ? c.green : p >= 50 ? c.orange : c.red; };
  let clusters = [];
  async function loadHealth() {
    try {
      const h = await api('/nms/api/health');
      const scoped = N.site ? h.sites.filter(s => String(s.id) === String(N.site)) : h.sites;
      $('nxSites').innerHTML = scoped.map(s => `<div class="nx-site">${N.ring(Number(s.secrets) ? s.onlinePct : null, { size: 58, stroke: 6, color: onlineColor(s) })}<div style="min-width:0"><b>${esc(s.code)} · ${esc(s.name)}</b><small>${Number(s.online) || 0} online · ${Number(s.offline) || 0} offline · ${Number(s.isolated) || 0} isolir</small><small>Router ${s.routers_up}/${s.routers}${Number(s.open_alerts) ? ` · <span style="color:var(--x-red)">${s.open_alerts} alert</span>` : ''}</small></div></div>`).join('') || '<div class="nx-card"><div class="nx-empty">Belum ada site aktif.</div></div>';
      clusters = N.site ? h.clusters.filter(c => String(c.site_id) === String(N.site)) : h.clusters;
      renderClusters();
    } catch (err) { $('nxSites').innerHTML = `<div class="nx-card"><div class="nx-empty">${esc(err.message)}</div></div>`; }
  }
  function renderClusters() {
    const only = $('nxOnlyOutage').checked;
    const list = clusters.filter(c => !only || c.suspectOutage).sort((a, b) => (b.suspectOutage - a.suspectOutage) || (b.offlinePct - a.offlinePct));
    $('nxClusters').innerHTML = list.length ? list.map(c => `<tr><td><b>${esc(c.name)}</b>${c.suspectOutage ? ' <span class="nx-pill red">dicurigai gangguan</span>' : ''}</td><td>${esc(c.site_code)}</td><td class="num">${c.customers}</td><td class="num">${Number(c.online) || 0}</td><td><span class="nx-score" style="--v:${c.offlinePct}%;--c:${c.offlinePct >= 60 ? 'var(--x-red)' : c.offlinePct >= 30 ? 'var(--x-orange)' : 'var(--x-green)'}"><i></i>${Number(c.offline) || 0} · ${c.offlinePct}%</span></td><td>${esc(dateTime(c.last_drop))}</td><td>${N.canControl ? `<button type="button" class="nx-btn sm ${c.suspectOutage ? 'orange' : 'ghost'}" data-notify="${c.id}"><i class="bi bi-megaphone"></i>Info gangguan</button>` : ''}</td></tr>`).join('') : `<tr><td colspan="7" class="nx-empty">${only ? 'Tidak ada ODP yang dicurigai gangguan.' : 'Belum ada pelanggan yang terhubung ke ODP / cluster.'}</td></tr>`;
  }
  $('nxOnlyOutage').addEventListener('change', renderClusters);
  $('nxClusters').addEventListener('click', e => {
    const b = e.target.closest('[data-notify]'); if (!b) return;
    const c = clusters.find(x => String(x.id) === b.dataset.notify); if (!c) return;
    const s = N.sheet({ title: 'Kirim info gangguan', subtitle: `${esc(c.name)} · ${c.customers} pelanggan. Pesan masuk antrean persetujuan WA Gateway dulu sebelum terkirim.`,
      body: `<div class="nx-field"><label>Pesan</label><textarea data-msg rows="6">Halo {nama}, saat ini sedang ada gangguan jaringan di area Anda. Teknisi kami sudah menangani dan layanan akan normal kembali secepatnya. Mohon maaf atas ketidaknyamanannya.</textarea><span class="hint">{nama} diganti otomatis dengan nama pelanggan.</span></div>`,
      foot: '<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-send>Antrekan pesan</button>' });
    s.$('[data-send]').addEventListener('click', async ev => {
      const btn = ev.currentTarget; btn.classList.add('busy');
      try { const out = await api(`/nms/api/clusters/${c.id}/notify`, { method: 'POST', body: { message: s.$('[data-msg]').value } }); toast(`${out.queued} pesan menunggu persetujuan di WA Gateway${out.failed ? `, ${out.failed} nomor tidak valid` : ''}.`, 'ok', { action: 'Buka', onAction: () => location.assign('/wa-gateway') }); s.close(); }
      catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  });

  // ---------------------------------------------------------------- Akun bersama
  let shared = null, sharedTab = 'mac';
  async function loadShared() {
    try { shared = await api(`/nms/api/shared${N.withSite()}`); $('nxSharedHint').textContent = `24 jam · ambang ${shared.threshold} MAC`; renderShared(); }
    catch (err) { $('nxShared').innerHTML = `<li><div class="li-main"><small>${esc(err.message)}</small></div></li>`; }
  }
  function renderShared() {
    if (!shared) return;
    const rows = sharedTab === 'mac' ? shared.multiMac : shared.multiUser;
    $('nxShared').innerHTML = rows.length ? rows.map(r => sharedTab === 'mac'
      ? `<li class="${r.secret_id ? 'clickable' : ''}" data-sid="${r.secret_id || ''}"><span class="li-icon orange"><i class="bi bi-people"></i></span><div class="li-main"><b>${esc(r.customer_name || r.username)}</b><small class="mono">${esc(r.username)} · ${esc(r.mac_list)}</small></div><b class="num">${r.macs} MAC</b></li>`
      : `<li><span class="li-icon purple"><i class="bi bi-hdd-network"></i></span><div class="li-main"><b class="mono">${esc(r.caller_id)}</b><small>${esc(r.user_list)}</small></div><b class="num">${r.users} akun</b></li>`).join('')
      : `<li><span class="li-icon green"><i class="bi bi-check-lg"></i></span><div class="li-main"><b>Tidak ada yang mencurigakan</b><small>${sharedTab === 'mac' ? 'Tidak ada akun yang login dari banyak perangkat.' : 'Tidak ada perangkat yang login ke banyak akun.'}</small></div></li>`;
  }
  $('nxSharedTabs').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; sharedTab = b.dataset.k; document.querySelectorAll('#nxSharedTabs button').forEach(x => x.classList.toggle('active', x === b)); renderShared(); });
  $('nxShared').addEventListener('click', e => { const li = e.target.closest('[data-sid]'); if (li?.dataset.sid) N.drawer(Number(li.dataset.sid)); });

  // ---------------------------------------------------------------- Putus-sambung
  async function loadFlap() {
    try {
      const { rows } = await api(`/nms/api/flapping${N.withSite()}`);
      $('nxFlap').innerHTML = rows.length ? rows.map(f => `<li class="${f.secret_id ? 'clickable' : ''}" data-sid="${f.secret_id || ''}"><span class="li-icon ${f.reconnects > 10 ? 'red' : 'orange'}"><i class="bi bi-arrow-repeat"></i></span><div class="li-main"><b>${esc(f.customer_name || f.username)}</b><small class="mono">${esc(f.username)} · ${esc(f.site_code)}</small></div><b class="num">${f.reconnects}×</b>${N.canControl && f.secret_id ? `<button type="button" class="nx-btn sm tint" data-ticket="${f.secret_id}">Tiket</button>` : ''}</li>`).join('') : '<li><span class="li-icon green"><i class="bi bi-check-lg"></i></span><div class="li-main"><b>Semua stabil</b><small>Tidak ada pelanggan putus-sambung dalam 1 jam.</small></div></li>';
    } catch (err) { $('nxFlap').innerHTML = `<li><div class="li-main"><small>${esc(err.message)}</small></div></li>`; }
  }
  $('nxFlap').addEventListener('click', async e => {
    const t = e.target.closest('[data-ticket]');
    if (t) { t.classList.add('busy'); try { const { ticket } = await api(`/nms/api/secrets/${t.dataset.ticket}/ticket`, { method: 'POST', body: {} }); toast(ticket.existing ? `Tiket ${ticket.code} sudah ada.` : `Tiket ${ticket.code} dibuat.`, 'ok'); } catch (err) { toast(err.message, 'err'); } t.classList.remove('busy'); return; }
    const li = e.target.closest('[data-sid]'); if (li?.dataset.sid) N.drawer(Number(li.dataset.sid));
  });

  const all = () => Promise.all([loadRecon(), loadHealth(), loadShared(), loadFlap()]).then(() => N.markUpdated());
  document.addEventListener('nx:changed', () => setTimeout(all, 600));
  N.stream({ sync: () => loadRecon() }, { fallback: all, fallbackMs: 60000 });
  all().then(() => { const k = new URL(location.href).searchParams.get('kind'); if (k && groups[k]) openRecon(k); });
})();
