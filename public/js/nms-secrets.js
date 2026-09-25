// PPP Secrets: tab Ter-link / Belum ter-link, tampilan tersimpan, pilih banyak (Shift+klik),
// pintasan keyboard, aksi dengan undo 5 detik, simulasi aksi masal + persetujuan, Smart Sync v2.
(() => {
  const N = window.NX;
  const app = document.getElementById('nmsSecrets');
  if (!N || !app) return;
  const { esc, api, toast, qs } = N;
  const $ = id => document.getElementById(id);
  const url = new URL(location.href);
  const st = { tab: app.dataset.tab, q: url.searchParams.get('q') || '', status: url.searchParams.get('status') || '', exempt: false, page: 1, rows: [], pages: 1, total: 0 };
  const selected = new Set();
  const pending = new Set();
  let focusIdx = -1, lastClicked = null;
  if (Number(app.dataset.routersOffline) > 0) N.setOffline(true);
  const sites = [...($('nmsSiteSelect')?.options || [])].filter(o => o.value).map(o => ({ id: o.value, label: o.textContent }));
  if (st.q) $('fQ').value = st.q;

  // ---------------------------------------------------------------- Tampilan (chips) + tersimpan
  const BASE_VIEWS = [{ id: 'all', label: 'Semua', status: '' }, { id: 'online', label: 'Online', status: 'online' }, { id: 'offline', label: 'Offline', status: 'offline' }, { id: 'isolated', label: 'Diisolir', status: 'isolated' }];
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem('nx-views') || '[]'); } catch (_) { return []; } };
  const saveSaved = v => { try { localStorage.setItem('nx-views', JSON.stringify(v.slice(0, 12))); } catch (_) {} };
  function renderViews() {
    const saved = loadSaved();
    const isOn = v => (v.tab || st.tab) === st.tab && (v.status || '') === st.status && (v.q || '') === st.q && (!v.site || String(v.site) === String(N.site || ''));
    $('fViews').innerHTML = BASE_VIEWS.map(v => `<button type="button" class="nx-chip ${!st.q && v.status === st.status ? 'on' : ''}" data-view="${v.id}">${v.label}</button>`).join('')
      + saved.map((v, i) => `<button type="button" class="nx-chip ${isOn(v) ? 'on' : ''}" data-saved="${i}"><i class="bi bi-bookmark-fill" style="font-size:11px"></i>${esc(v.name)}<span class="x" data-del="${i}" aria-label="Hapus">×</span></button>`).join('')
      + `<button type="button" class="nx-chip add" id="saveView"><i class="bi bi-plus"></i>Simpan tampilan</button>`;
  }
  $('fViews').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); const v = loadSaved(); v.splice(Number(del.dataset.del), 1); saveSaved(v); renderViews(); return; }
    const b = e.target.closest('[data-view]');
    if (b) { const v = BASE_VIEWS.find(x => x.id === b.dataset.view); st.status = v.status; st.q = ''; $('fQ').value = ''; st.page = 1; load(); renderViews(); return; }
    const s = e.target.closest('[data-saved]');
    if (s) {
      const v = loadSaved()[Number(s.dataset.saved)]; if (!v) return;
      if (v.site && String(v.site) !== String(N.site || '')) { location.assign(`/nms/secrets${qs({ site: v.site, tab: v.tab, status: v.status, q: v.q })}`); return; }
      st.tab = v.tab || st.tab; st.status = v.status || ''; st.q = v.q || ''; $('fQ').value = st.q; st.page = 1; syncTabs(); load(); renderViews(); return;
    }
    if (e.target.closest('#saveView')) {
      const sh = N.sheet({ title: 'Simpan tampilan', subtitle: 'Filter tab, status, pencarian, dan site saat ini disimpan sebagai tombol.', size: 'sm', body: `<div class="nx-field"><label>Nama</label><input type="text" data-n autofocus placeholder="Contoh: Site A offline"></div>`, foot: '<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-s>Simpan</button>' });
      const go = () => { const name = sh.$('[data-n]').value.trim(); if (!name) return; const v = loadSaved(); v.push({ name: name.slice(0, 30), tab: st.tab, status: st.status, q: st.q, site: N.site || '' }); saveSaved(v); sh.close(); renderViews(); toast('Tampilan disimpan.', 'ok'); };
      sh.$('[data-s]').addEventListener('click', go); sh.$('[data-n]').addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
    }
  });

  // ---------------------------------------------------------------- Tabel
  const COLS = {
    synced: ['', 'Pelanggan', 'Site', 'Username', 'Profile', 'IP', 'Status', 'Ping', ''],
    unsynced: ['', 'Username', 'Site / Router', 'Profile', 'IP', 'Caller-ID', 'Status', 'Ping', '']
  };
  const STATE = { online: 'Online', offline: 'Offline', isolated: 'Diisolir' };
  const METHOD = { customer_code: 'Customer ID', customer_name: 'Nama', pppoe_username: 'Data billing', manual: 'Manual', phone: 'No. HP', comment: 'Comment', fuzzy: 'Mirip', created: 'Dibuat di NMS' };
  function head() {
    $('tHead').innerHTML = `<tr>${COLS[st.tab].map((c, i) => i === 0 ? `<th class="check">${N.canControl ? '<input type="checkbox" id="chkAll" aria-label="Pilih semua">' : ''}</th>` : `<th ${i === COLS[st.tab].length - 1 ? 'style="text-align:right"' : ''}>${c}</th>`).join('')}</tr>`;
    $('fExemptWrap').hidden = st.tab !== 'unsynced';
  }
  const chk = r => N.canControl ? `<input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="Pilih ${esc(r.username)}">` : '';
  const ip = r => `<span class="mono">${esc(r.active_address || r.remote_address || '—')}</span>`;
  const state = r => `<span class="nx-state ${r.state}">${STATE[r.state]}</span>${r.active_uptime && r.state === 'online' ? `<span class="sub mono">${esc(r.active_uptime)}</span>` : ''}`;
  function actions(r) {
    const b = (a, icon, title, cls = '') => `<button type="button" class="nx-btn sm icon ${cls}" data-act="${a}" data-id="${r.id}" title="${title}" aria-label="${title}"><i class="bi ${icon}"></i></button>`;
    let html = b('ping', 'bi-activity', 'Ping 5x (P)', 'ghost');
    if (N.canControl) {
      if (st.tab === 'unsynced') html += `<button type="button" class="nx-btn sm tint" data-act="map" data-id="${r.id}"><i class="bi bi-link-45deg"></i>Hubungkan</button>`;
      else html += r.is_isolated ? b('unisolate', 'bi-check2-circle', 'Buka isolir (U)', 'green') : b('isolate', 'bi-slash-circle', 'Isolir (I)', 'ghost');
    }
    html += b('more', 'bi-three-dots', 'Aksi lain', 'ghost');
    return `<div class="nx-actions">${html}</div>`;
  }
  function row(r, i) {
    const cls = [selected.has(r.id) ? 'selected' : '', pending.has(r.id) ? 'pending' : '', i === focusIdx ? 'focus' : ''].join(' ');
    if (st.tab === 'synced') return `<tr data-row="${r.id}" data-i="${i}" class="${cls}"><td class="check">${chk(r)}</td>
      <td class="first cust" data-open="${r.id}"><span class="name">${esc(r.customer_name)}</span><span class="sub">${esc(r.customer_code)}${r.package_name ? ' · ' + esc(r.package_name) : ''}</span></td>
      <td data-label="Site">${esc(r.site_code)}</td>
      <td data-label="Username"><span class="mono">${esc(r.username)}</span>${r.caller_id ? ' <i class="bi bi-lock-fill dim" title="MAC terkunci"></i>' : ''}<span class="sub">${esc(METHOD[r.match_method] || r.match_method || '')}</span></td>
      <td data-label="Profile">${esc(r.profile || '—')}${r.is_isolated && r.original_profile ? `<span class="sub">asal ${esc(r.original_profile)}</span>` : ''}</td>
      <td data-label="IP">${ip(r)}</td><td data-label="Status">${state(r)}</td><td data-label="Ping" data-ping="${r.id}">${N.pingBadge(r.id)}</td><td class="acts">${actions(r)}</td></tr>`;
    return `<tr data-row="${r.id}" data-i="${i}" class="${cls}"><td class="check">${chk(r)}</td>
      <td class="first cust" data-open="${r.id}"><span class="name mono">${esc(r.username)}</span>${r.comment ? `<span class="sub">${esc(r.comment)}</span>` : ''}${r.is_exempt ? `<span class="sub" style="color:var(--x-orange)">exempt: ${esc(r.exempt_type)}</span>` : ''}</td>
      <td data-label="Site">${esc(r.site_code)}<span class="sub">${esc(r.router_name)}</span></td>
      <td data-label="Profile">${esc(r.profile || '—')}</td><td data-label="IP">${ip(r)}</td>
      <td data-label="Caller-ID" class="mono">${esc(r.caller_id || r.active_caller_id || '—')}</td>
      <td data-label="Status">${state(r)}</td><td data-label="Ping" data-ping="${r.id}">${N.pingBadge(r.id)}</td><td class="acts">${actions(r)}</td></tr>`;
  }
  function render() {
    head();
    const empty = st.q || st.status ? '<i class="bi bi-search"></i>Tidak ada yang cocok dengan filter ini.' : st.tab === 'synced' ? '<i class="bi bi-link-45deg"></i>Belum ada secret yang terhubung ke pelanggan. Jalankan Smart Sync.' : '<i class="bi bi-check-circle"></i>Semua secret sudah terhubung ke pelanggan.';
    $('tBody').innerHTML = st.rows.length ? st.rows.map(row).join('') : `<tr><td colspan="9" class="nx-empty">${empty}</td></tr>`;
    $('pgInfo').textContent = `${st.total.toLocaleString('id-ID')} secret · halaman ${st.page} dari ${st.pages}`;
    $('pgPrev').disabled = st.page <= 1; $('pgNext').disabled = st.page >= st.pages;
    syncBulkBar();
  }
  async function load() {
    const params = { tab: st.tab, page: st.page, limit: 50, site: N.site || undefined, q: st.q || undefined, status: st.status || undefined, exempt: st.exempt || undefined };
    const u = new URL(location.href); ['tab', 'status', 'q'].forEach(k => { if (params[k]) u.searchParams.set(k, params[k]); else u.searchParams.delete(k); }); u.searchParams.delete('sync'); u.searchParams.delete('focus'); history.replaceState(null, '', u);
    try {
      const res = await api(`/nms/api/secrets${qs(params)}`);
      Object.assign(st, { rows: res.rows, pages: res.pages, total: res.total, page: res.page });
      if (focusIdx >= st.rows.length) focusIdx = st.rows.length - 1;
      render(); N.markUpdated();
    } catch (err) { $('tBody').innerHTML = `<tr><td colspan="9" class="nx-empty">Gagal memuat: ${esc(err.message)}</td></tr>`; }
  }
  async function loadCounts() {
    try {
      const { counts: c } = await api(`/nms/api/counts${N.withSite()}`);
      $('cOnline').textContent = c.online; $('cOffline').textContent = c.offline; $('cIsolated').textContent = c.isolated;
      $('cSyncPct').textContent = `${c.syncedPct}%`; $('cSynced').textContent = c.synced; $('cExempt').textContent = c.exempt;
      $('tabSynced').textContent = c.synced; $('tabUnsynced').textContent = c.unsynced;
    } catch (_) {}
  }
  const reload = () => Promise.all([load(), loadCounts()]);

  function syncTabs() { document.querySelectorAll('.nx-toolbar [data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === st.tab)); }
  document.querySelectorAll('.nx-toolbar [data-tab]').forEach(b => b.addEventListener('click', () => { st.tab = b.dataset.tab; st.page = 1; selected.clear(); focusIdx = -1; syncTabs(); load(); renderViews(); }));
  let qTimer = null;
  $('fQ').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value.trim(); st.page = 1; load(); renderViews(); }, 250); });
  $('fExempt').addEventListener('change', e => { st.exempt = e.target.checked; st.page = 1; load(); });
  $('pgPrev').addEventListener('click', () => { if (st.page > 1) { st.page--; focusIdx = -1; load(); } });
  $('pgNext').addEventListener('click', () => { if (st.page < st.pages) { st.page++; focusIdx = -1; load(); } });

  // ---------------------------------------------------------------- Seleksi (Shift+klik rentang)
  function syncBulkBar() {
    const bar = $('bulkBar'); if (!bar) return;
    bar.classList.toggle('show', selected.size > 0);
    $('bulkCount').textContent = selected.size;
    const all = $('chkAll'); if (all) { all.checked = st.rows.length > 0 && st.rows.every(r => selected.has(r.id)); all.indeterminate = !all.checked && st.rows.some(r => selected.has(r.id)); }
  }
  function toggle(id, on) { if (on) selected.add(id); else selected.delete(id); const tr = $('tBody').querySelector(`[data-row="${id}"]`); if (tr) { tr.classList.toggle('selected', on); const c = tr.querySelector('[data-sel]'); if (c) c.checked = on; } }
  $('tBody').addEventListener('click', e => {
    const box = e.target.closest('[data-sel]');
    if (box) {
      const id = Number(box.dataset.sel);
      if (e.shiftKey && lastClicked != null) {
        const a = st.rows.findIndex(r => r.id === lastClicked), b = st.rows.findIndex(r => r.id === id);
        if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let i = lo; i <= hi; i++) toggle(st.rows[i].id, box.checked); }
      } else toggle(id, box.checked);
      lastClicked = id; syncBulkBar(); return;
    }
    const btn = e.target.closest('[data-act]');
    if (btn) {
      const r = st.rows.find(x => x.id === Number(btn.dataset.id)); if (!r) return;
      if (btn.dataset.act === 'more') return N.menu(btn, N.actionItems(r));
      if (btn.dataset.act === 'map') return N.openMap(r);
      return N.act(r, btn.dataset.act);
    }
    const open = e.target.closest('[data-open]');
    if (open) N.drawer(Number(open.dataset.open));
  });
  $('tHead').addEventListener('change', e => { if (e.target.id !== 'chkAll') return; st.rows.forEach(r => toggle(r.id, e.target.checked)); syncBulkBar(); });
  $('bulkClear')?.addEventListener('click', () => { selected.clear(); render(); });
  document.addEventListener('nx:changed', () => { reload(); });
  document.addEventListener('nx:ping', e => { const cell = app.querySelector(`[data-ping="${e.detail}"]`); if (cell) cell.innerHTML = N.pingBadge(e.detail); });
  document.addEventListener('nx:pending', e => { const { id, on } = e.detail; if (on) pending.add(id); else pending.delete(id); $('tBody').querySelector(`[data-row="${id}"]`)?.classList.toggle('pending', on); });

  // ---------------------------------------------------------------- Aksi masal: simulasi → undo/persetujuan
  const ACTION_LABEL = { isolate: 'Isolir', unisolate: 'Buka isolir', kick: 'Kick sesi', profile: 'Ganti profile' };
  let profilesCache = null;
  async function profileOptions() { if (!profilesCache) { try { const { profiles, unreachable } = await api(`/nms/api/profiles${N.withSite()}`); profilesCache = profiles; if (unreachable.length) toast(`Profile dari ${unreachable.join(', ')} tidak terbaca (router offline).`, 'err'); } catch (err) { profilesCache = []; toast(err.message, 'err'); } } return profilesCache; }
  function targetsTable(targets) {
    const warnCount = targets.filter(t => t.warnings.length).length;
    return `<div class="nx-mini-stats"><div><small>Target</small><b>${targets.length}</b></div><div><small>Perlu dicek</small><b style="color:${warnCount ? 'var(--x-orange)' : 'inherit'}">${warnCount}</b></div></div>
      ${warnCount ? '<div class="nx-note" style="margin-bottom:10px">Baris bertanda oranye kemungkinan tidak perlu diproses. Hapus centangnya sebelum menjalankan.</div>' : ''}
      <div class="nx-table-wrap" style="max-height:340px;border:1px solid var(--x-line);border-radius:12px"><table class="nx-table"><thead><tr><th class="check"><input type="checkbox" data-all checked aria-label="Semua"></th><th>Pelanggan</th><th>Site</th><th>Catatan</th></tr></thead><tbody>
      ${targets.map(t => `<tr><td class="check"><input type="checkbox" data-t="${t.id}" ${t.warnings.length && t.warnings.some(w => /Tidak ada tunggakan|Baru bayar|Exempt|Ditunda|Sudah diisolir|Tidak sedang/.test(w)) ? '' : 'checked'}></td><td><b>${esc(t.customerName || t.username)}</b><span class="sub mono">${esc(t.username)}</span></td><td>${esc(t.siteCode)}</td><td>${t.warnings.length ? t.warnings.map(w => `<span class="nx-pill orange" style="margin:1px">${esc(w)}</span>`).join('') : '<span class="dim">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  async function runBulk(action, payload, count) {
    const out = await N.deferred(`${ACTION_LABEL[action]} ${count} secret…`, () => api('/nms/api/bulk', { method: 'POST', body: { action, ...payload } }));
    if (!out) return null;
    if (out.pendingApproval) { toast(`Butuh persetujuan admin lain (lebih dari ${out.threshold} target). Permintaan #${out.approvalId} dikirim.`, 'info', { action: 'Lihat', onAction: () => location.assign(`/nms/automation${N.withSite()}`), duration: 8000 }); N.loadBadges(); return out; }
    const s = out.summary;
    toast(`${ACTION_LABEL[action]}: ${s.succeeded}/${s.total} berhasil${s.failed ? `, ${s.failed} gagal` : ''}.`, s.failed ? 'err' : 'ok');
    const failed = out.results.filter(r => !r.ok).slice(0, 3);
    if (failed.length) toast(failed.map(f => `#${f.secretId}: ${f.error}`).join(' · '), 'err');
    N.changed();
    return out;
  }
  async function bulkSheet(action, { ids = null, filter = null, title = null } = {}) {
    let profile = null;
    const needProfile = action === 'profile';
    const s = N.sheet({ title: title || `${ACTION_LABEL[action]} masal`, subtitle: 'Simulasi dulu: periksa siapa saja yang kena sebelum perintah dikirim ke router.', size: 'lg',
      body: `${needProfile ? `<div class="nx-field"><label>Profile tujuan</label><select data-prof><option value="">Memuat profile…</option></select></div>` : ''}<div data-sim><div class="nx-empty">Menghitung target…</div></div>`,
      foot: `<span class="left" data-left></span><button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn ${action === 'unisolate' ? 'primary' : 'solid-red'}" data-run disabled>Jalankan</button>` });
    if (needProfile) { const p = await profileOptions(); s.$('[data-prof]').innerHTML = `<option value="">Pilih profile…</option>${p.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}`; }
    let targets = [];
    try { const out = await api('/nms/api/bulk', { method: 'POST', body: { action: action === 'profile' ? 'profile' : action, dryRun: true, secretIds: ids, filter, profile: 'x' } }); targets = out.targets || []; }
    catch (err) { s.$('[data-sim]').innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; return; }
    s.$('[data-sim]').innerHTML = targets.length ? targetsTable(targets) : '<div class="nx-empty">Tidak ada target yang cocok.</div>';
    const picked = () => s.$$('[data-t]:checked').map(x => Number(x.dataset.t));
    const refresh = () => { const n = picked().length; s.$('[data-run]').disabled = !n || (needProfile && !s.$('[data-prof]').value); s.$('[data-run]').textContent = n ? `${ACTION_LABEL[action]} ${n} secret` : 'Jalankan'; s.$('[data-left]').textContent = n ? 'Perintah dikirim setelah hitung mundur 5 detik (bisa dibatalkan).' : ''; };
    s.$('[data-all]')?.addEventListener('change', e => { s.$$('[data-t]').forEach(x => { x.checked = e.target.checked; }); refresh(); });
    s.body.addEventListener('change', refresh);
    refresh();
    s.$('[data-run]').addEventListener('click', async () => {
      const list = picked(); if (needProfile) profile = s.$('[data-prof]').value;
      s.close();
      const out = await runBulk(action, { secretIds: list, profile }, list.length);
      if (out && !out.pendingApproval) { selected.clear(); render(); }
    });
  }
  $('bulkBar')?.addEventListener('click', e => {
    const action = e.target.closest('[data-bulk]')?.dataset.bulk; if (!action) return;
    const ids = [...selected];
    if (action === 'schedule') return N.openSchedule(ids);
    bulkSheet(action, { ids });
  });

  function siteBulk() {
    const s = N.sheet({ title: 'Aksi masal per site', subtitle: 'Pilih target berdasarkan site dan status tagihan.', size: 'sm',
      body: `<div class="nx-field"><label>Aksi</label><select data-a><option value="isolate">Isolir</option><option value="unisolate">Buka isolir</option><option value="profile">Ganti profile</option></select></div>
        <div class="nx-field"><label>Site</label><select data-s>${sites.map(o => `<option value="${o.id}" ${String(o.id) === String(N.site) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <label class="nx-check"><input type="checkbox" data-o checked> Hanya pelanggan lewat jatuh tempo</label>`,
      foot: '<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-n>Simulasi</button>' });
    s.$('[data-n]').addEventListener('click', () => {
      const action = s.$('[data-a]').value;
      const filter = { siteId: Number(s.$('[data-s]').value), overdueOnly: s.$('[data-o]').checked, state: action === 'unisolate' ? 'isolated' : action === 'isolate' ? 'active' : null };
      s.close(); bulkSheet(action, { filter, title: `${ACTION_LABEL[action]} per site` });
    });
  }

  // ---------------------------------------------------------------- Menu toolbar
  $('btnMore').addEventListener('click', e => N.menu(e.currentTarget, [
    ...(N.canControl ? [{ label: 'Aksi masal per site…', icon: 'bi-collection', run: siteBulk }, '-'] : []),
    { label: 'Ekspor tab ini (CSV)', icon: 'bi-download', run: () => location.assign(`/nms/api/export${qs({ site: N.site || undefined, kind: st.tab })}`) },
    { label: 'Riwayat Smart Sync & undo', icon: 'bi-clock-history', run: () => location.assign(`/nms/automation${N.withSite()}#sync`) },
    { label: 'Pintasan keyboard', icon: 'bi-keyboard', run: () => document.getElementById('nxShortcuts')?.click() }
  ]));
  $('btnRefresh')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.classList.add('busy');
    try {
      const { results } = await api(`/nms/api/secrets/refresh${N.withSite()}`, { method: 'POST', body: {} });
      const bad = results.filter(r => !r.ok);
      N.setOffline(bad.length > 0);
      toast(`${results.length - bad.length}/${results.length} router tersinkron${bad.length ? '. Sebagian offline, menampilkan cache.' : '.'}`, bad.length ? 'err' : 'ok');
      await reload();
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.classList.remove('busy'); }
  });

  // ---------------------------------------------------------------- Smart Sync v2
  async function smartSync() {
    if (!N.canControl) return;
    const s = N.sheet({ title: 'Smart Sync', subtitle: 'Mencocokkan PPP secret dengan data pelanggan di site yang sama. Belum ada yang diubah sampai Anda menekan Hubungkan.', size: 'lg',
      body: '<div class="nx-empty"><i class="bi bi-magic"></i>Menarik secret terbaru dari router lalu mencocokkan…</div>',
      foot: '<span class="left" data-exp></span><button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-commit disabled>Hubungkan</button>' });
    let plan;
    try { ({ plan } = await api(`/nms/api/sync/preview${qs({ refresh: 1, site: N.site || undefined })}`)); }
    catch (err) { s.body.innerHTML = `<div class="nx-empty">Preview gagal: ${esc(err.message)}</div>`; return; }
    const sm = plan.summary;
    const score = v => { const c = v >= 95 ? 'var(--x-green)' : v >= 85 ? 'var(--x-blue)' : 'var(--x-orange)'; return `<span class="nx-score" style="--v:${v}%;--c:${c}"><i></i>${v}</span>`; };
    const cand = c => c.candidates || c.customers || [];
    const tabs = [['pairs', 'Siap', plan.pairs.length], ['suggestions', 'Saran', plan.suggestions.length], ['conflicts', 'Konflik', plan.conflicts.length]];
    s.body.innerHTML = `<div class="nx-mini-stats"><div><small>Dipindai</small><b>${sm.scanned}</b></div><div><small>Siap dihubungkan</small><b style="color:var(--x-green)">${sm.matched}</b></div><div><small>Saran</small><b style="color:var(--x-blue)">${sm.suggested || 0}</b></div><div><small>Konflik</small><b style="color:var(--x-orange)">${sm.conflicts}</b></div></div>
      <div class="nx-seg sm" data-stabs style="margin-bottom:10px">${tabs.map(([k, l, n], i) => `<button type="button" data-k="${k}" class="${i === 0 ? 'active' : ''}">${l} <span class="count">${n}</span></button>`).join('')}</div>
      <div data-pane="pairs">
        <p class="dim" style="margin:0 0 8px;font-size:12.5px">Username sama persis dengan Customer ID atau nama pelanggan (tidak peka huruf besar/kecil).</p>
        ${plan.pairs.length ? `<div class="nx-table-wrap" style="max-height:340px;border:1px solid var(--x-line);border-radius:12px"><table class="nx-table"><thead><tr><th class="check"><input type="checkbox" data-allp checked aria-label="Semua"></th><th>Pelanggan</th><th>Username</th><th>Site</th><th>Cocok via</th><th>Skor</th></tr></thead><tbody>
          ${plan.pairs.map(p => `<tr><td class="check"><input type="checkbox" data-pair="${p.secretId}" checked></td><td><b>${esc(p.customerName)}</b><span class="sub">${esc(p.customerCode)}</span></td><td class="mono">${esc(p.username)}</td><td>${esc(p.siteCode)}</td><td><span class="nx-pill ${p.matchedOn === 'customer_code' ? 'green' : 'blue'}">${p.matchedOn === 'customer_code' ? 'Customer ID' : 'Nama'}</span></td><td>${score(p.score || 100)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="nx-empty">Tidak ada pasangan yang cocok persis.</div>'}
      </div>
      <div data-pane="suggestions" hidden>
        <p class="dim" style="margin:0 0 8px;font-size:12.5px">Cocok lewat nomor HP, comment secret, atau nama yang mirip. Tidak dicentang otomatis, jadi periksa satu per satu.</p>
        ${plan.suggestions.length ? `<ul class="nx-list nx-group">${plan.suggestions.map(p => `<li><input type="checkbox" data-sug="${p.secretId}"><div class="li-main"><b><span class="mono">${esc(p.username)}</span> → ${esc(p.customerName)}</b><small>${esc(p.customerCode)} · ${esc(p.siteCode)} · ${esc((p.reasons || []).join(', '))}</small></div>${p.alternatives?.length ? `<select data-sugc="${p.secretId}" style="width:auto;max-width:220px"><option value="${p.customerId}">${esc(p.customerName)} (${p.score})</option>${p.alternatives.map(a => `<option value="${a.id}">${esc(a.name)} (${a.score})</option>`).join('')}</select>` : `<input type="hidden" data-sugc="${p.secretId}" value="${p.customerId}">`}${score(p.score)}</li>`).join('')}</ul>` : '<div class="nx-empty">Tidak ada saran tambahan.</div>'}
      </div>
      <div data-pane="conflicts" hidden>
        <p class="dim" style="margin:0 0 8px;font-size:12.5px">Satu secret cocok ke lebih dari satu pelanggan, atau satu pelanggan diklaim beberapa secret. Pilih pelanggan yang benar langsung di sini.</p>
        ${plan.conflicts.length ? `<ul class="nx-list nx-group">${plan.conflicts.slice(0, 200).map(c => `<li><span class="li-icon orange"><i class="bi bi-exclamation-lg"></i></span><div class="li-main"><b class="mono">${esc(c.username)}</b><small>${esc(c.siteCode)} · ${c.reason === 'multiple_customers' ? 'cocok ke beberapa pelanggan' : 'pelanggan diklaim beberapa secret'}</small></div><select data-conf="${c.secretId}" style="width:auto;max-width:240px"><option value="">Lewati</option>${cand(c).map(x => `<option value="${x.id}">${esc(x.name)} · ${esc(x.code)}</option>`).join('')}</select></li>`).join('')}</ul>` : '<div class="nx-empty">Tidak ada konflik.</div>'}
      </div>`;
    s.$('[data-exp]').textContent = `Berlaku sampai ${N.hhmm(plan.expiresAt)} WIB`;
    s.$('[data-stabs]').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; s.$$('[data-stabs] button').forEach(x => x.classList.toggle('active', x === b)); s.$$('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.k; }); });
    s.$('[data-allp]')?.addEventListener('change', e => { s.$$('[data-pair]').forEach(x => { x.checked = e.target.checked; }); count(); });
    const collect = () => {
      const ids = s.$$('[data-pair]:checked').map(x => Number(x.dataset.pair));
      const idSet = new Set(ids);
      const pairs = plan.pairs.filter(p => idSet.has(Number(p.secretId))).map(p => ({ secretId: p.secretId, customerId: p.customerId }));
      const manual = [];
      s.$$('[data-sug]:checked').forEach(x => { const sid = Number(x.dataset.sug); const sug = plan.suggestions.find(p => p.secretId === sid); const cid = Number(s.$(`[data-sugc="${sid}"]`)?.value || sug?.customerId); if (cid) manual.push({ secretId: sid, customerId: cid, method: sug?.matchedOn || 'fuzzy' }); });
      s.$$('[data-conf]').forEach(x => { if (x.value) manual.push({ secretId: Number(x.dataset.conf), customerId: Number(x.value), method: 'manual' }); });
      const used = new Map();
      [...pairs, ...manual].forEach(p => used.set(p.customerId, (used.get(p.customerId) || 0) + 1));
      const dup = [...used.values()].some(v => v > 1);
      return { ids, pairs, manual, dup, total: ids.length + manual.length };
    };
    const count = () => { const c = collect(); const btn = s.$('[data-commit]'); btn.disabled = !c.total || c.dup; btn.textContent = c.dup ? 'Ada pelanggan dipilih 2×' : c.total ? `Hubungkan ${c.total}` : 'Hubungkan'; };
    s.body.addEventListener('change', count);
    count();
    s.$('[data-commit]').addEventListener('click', async e => {
      const c = collect(); if (!c.total) return;
      const btn = e.currentTarget; btn.classList.add('busy');
      try {
        const out = await api('/nms/api/sync/commit', { method: 'POST', body: { planId: plan.planId, secretIds: c.ids.length ? c.ids : [-1], pairs: c.pairs, manual: c.manual, site_id: plan.siteId || N.site || null } });
        const sum = out.summary;
        toast(`${sum.linked} secret terhubung${sum.failed ? `, ${sum.failed} gagal` : ''}${sum.skipped ? `, ${sum.skipped} dilewati karena data berubah` : ''}.`, sum.failed ? 'err' : 'ok', sum.batchId ? { action: 'Undo', duration: 10000, onAction: async () => { try { const u = await api(`/nms/api/sync/batches/${sum.batchId}/undo`, { method: 'POST', body: {} }); toast(`${u.released} link dibatalkan.`, 'ok'); N.changed(); } catch (err) { toast(err.message, 'err'); } } } : {});
        const bad = out.results.filter(r => !r.ok).slice(0, 4);
        if (bad.length) toast(bad.map(f => `${f.username || '#' + f.secretId}: ${f.error}`).join(' · '), 'err');
        s.close(); selected.clear(); N.changed();
      } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  }
  $('btnSmartSync')?.addEventListener('click', smartSync);

  // ---------------------------------------------------------------- Keyboard
  function setFocus(i) {
    focusIdx = Math.max(0, Math.min(st.rows.length - 1, i));
    $('tBody').querySelectorAll('tr.focus').forEach(tr => tr.classList.remove('focus'));
    const tr = $('tBody').querySelector(`[data-i="${focusIdx}"]`);
    tr?.classList.add('focus'); tr?.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); $('fQ').focus(); return; }
    if (typing) { if (e.key === 'Escape' && document.activeElement === $('fQ')) $('fQ').blur(); if (e.key === 'ArrowDown' && document.activeElement === $('fQ')) { $('fQ').blur(); setFocus(0); } return; }
    if (e.ctrlKey || e.metaKey || e.altKey || N.drawerOpen()) return;
    const r = st.rows[focusIdx];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setFocus(focusIdx + 1); break;
      case 'ArrowUp': e.preventDefault(); setFocus(focusIdx - 1); break;
      case ' ': case 'x': if (r && N.canControl) { e.preventDefault(); toggle(r.id, !selected.has(r.id)); syncBulkBar(); } break;
      case 'Enter': if (r) { e.preventDefault(); N.drawer(r.id); } break;
      case 'p': case 'P': if (r) N.act(r, 'ping'); break;
      case 'd': case 'D': if (r) N.act(r, 'diagnose'); break;
      case 'i': case 'I': if (r && N.canControl && !r.is_isolated) N.act(r, 'isolate'); break;
      case 'u': case 'U': if (r && N.canControl && r.is_isolated) N.act(r, 'unisolate'); break;
      case 'k': case 'K': if (r && N.canControl) N.act(r, 'kick'); break;
      case 's': case 'S': smartSync(); break;
      case 'Escape': if (selected.size) { selected.clear(); render(); } break;
      default: break;
    }
  });

  // ---------------------------------------------------------------- Real-time
  let rt = null;
  const soon = () => { clearTimeout(rt); rt = setTimeout(reload, 1500); };
  N.stream({
    ppp: e => { if (st.rows.some(r => String(r.username).toLowerCase() === String(e.username || '').toLowerCase())) soon(); },
    router_state: s => { if (s.status === 'offline') { N.setOffline(true); toast('Router tidak terjangkau. Tabel memakai data cache.', 'err'); } },
    sync: soon
  }, { fallback: reload, fallbackMs: 30000 });

  renderViews(); syncTabs(); head(); load();
  if (url.searchParams.get('sync') === '1') setTimeout(smartSync, 300);
  if (Number(app.dataset.focus)) setTimeout(() => N.drawer(Number(app.dataset.focus)), 300);
})();
