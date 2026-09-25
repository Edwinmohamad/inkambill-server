// PPP Secrets controller: tab Synced/Unsynced, inline action, bulk, Smart Sync, manual map.
(() => {
  const N = window.NMS;
  const app = document.getElementById('nmsSecrets');
  if (!N || !app) return;
  const { esc, api, toast } = N;
  const $ = id => document.getElementById(id);
  const st = { tab: app.dataset.tab, q: '', status: '', exempt: false, page: 1, rows: [], pages: 1, total: 0 };
  const selected = new Set();
  const pingCache = new Map();
  if (Number(app.dataset.routersOffline) > 0) N.setOffline(true);

  const COLS = {
    synced: ['', 'Nama Pelanggan', 'Site', 'PPP Username', 'Profile', 'IP Address', 'Status', 'Ping', 'Action'],
    unsynced: ['', 'PPP Username', 'Site / Router', 'Profile', 'IP Address', 'Caller-ID', 'Status', 'Ping', 'Action']
  };
  function head() {
    $('tHead').innerHTML = `<tr>${COLS[st.tab].map((c, i) => i === 0 ? `<th>${N.canControl ? '<input type="checkbox" id="chkAll" aria-label="Pilih semua">' : ''}</th>` : `<th>${c}</th>`).join('')}</tr>`;
    $('fExemptWrap').style.display = st.tab === 'unsynced' ? '' : 'none';
  }
  const stateBadge = r => `<span class="nms-state ${r.state}">${r.state === 'isolated' ? 'ISOLIR' : r.state.toUpperCase()}</span>${r.active_uptime && r.state === 'online' ? `<span class="sub mono">${esc(r.active_uptime)}</span>` : ''}`;
  const pingBadge = id => {
    const p = pingCache.get(id);
    if (!p) return '<span class="nms-ping-badge">—</span>';
    if (p.busy) return '<span class="nms-ping-badge">pinging…</span>';
    if (p.error) return `<span class="nms-ping-badge red" title="${esc(p.error)}">ERR</span>`;
    const cls = p.lossPct >= 50 ? 'red' : (p.lossPct > 0 || (p.avgMs || 0) > 80) ? 'yellow' : 'green';
    return `<span class="nms-ping-badge ${cls}" title="${p.received}/${p.sent} reply · min ${p.minMs ?? '-'} / max ${p.maxMs ?? '-'} ms">${p.avgMs == null ? '—' : p.avgMs + 'ms'} · ${p.lossPct}%</span>`;
  };
  function actions(r) {
    const b = (act, icon, title, cls = '') => `<button type="button" class="nms-btn xs ${cls}" data-act="${act}" data-id="${r.id}" title="${title}" aria-label="${title}"><i class="bi ${icon}"></i></button>`;
    const out = [b('ping', 'bi-activity', 'Live Ping 5x')];
    if (N.canControl) {
      if (st.tab === 'unsynced') out.push(`<button type="button" class="nms-btn xs primary" data-act="map" data-id="${r.id}"><i class="bi bi-link-45deg"></i>Map to Customer</button>`);
      out.push(r.is_isolated ? b('unisolate', 'bi-check2-circle', 'Reconnect / Un-Isolir', 'green') : b('isolate', 'bi-slash-circle', 'Isolir', 'red'));
      out.push(b('kick', 'bi-plug', 'Kick / Reset Session', 'yellow'));
      out.push(r.caller_id ? b('unlock-mac', 'bi-unlock', `Lepas MAC lock (${esc(r.caller_id)})`) : b('lock-mac', 'bi-lock', 'Lock MAC (Caller-ID) dari sesi aktif'));
      if (st.tab === 'synced') out.push(b('unmap', 'bi-x-lg', 'Lepas link pelanggan'));
    }
    return `<div class="nms-actions">${out.join('')}</div>`;
  }
  const chk = r => N.canControl ? `<input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="Pilih ${esc(r.username)}">` : '';
  const ip = r => `<span class="mono">${esc(r.active_address || r.remote_address || '—')}</span>`;
  function row(r) {
    if (st.tab === 'synced') return `<tr data-row="${r.id}" class="${selected.has(r.id) ? 'selected' : ''}"><td>${chk(r)}</td><td><b>${esc(r.customer_name)}</b><span class="sub">${esc(r.customer_code)}${r.package_name ? ' · ' + esc(r.package_name) : ''}</span></td><td>${esc(r.site_code)}</td><td class="mono">${esc(r.username)}${r.caller_id ? ' <i class="bi bi-lock-fill dim" title="MAC terkunci"></i>' : ''}<span class="sub">${esc(r.match_method || '')}</span></td><td>${esc(r.profile || '-')}${r.is_isolated && r.original_profile ? `<span class="sub">asal: ${esc(r.original_profile)}</span>` : ''}</td><td>${ip(r)}</td><td>${stateBadge(r)}</td><td data-ping="${r.id}">${pingBadge(r.id)}</td><td>${actions(r)}</td></tr>`;
    return `<tr data-row="${r.id}" class="${selected.has(r.id) ? 'selected' : ''}"><td>${chk(r)}</td><td class="mono"><b>${esc(r.username)}</b>${r.comment ? `<span class="sub">${esc(r.comment)}</span>` : ''}${r.is_exempt ? `<span class="sub" style="color:#F59E0B">exempt: ${esc(r.exempt_type)}</span>` : ''}</td><td>${esc(r.site_code)}<span class="sub">${esc(r.router_name)}</span></td><td>${esc(r.profile || '-')}</td><td>${ip(r)}</td><td class="mono">${esc(r.caller_id || r.active_caller_id || '—')}</td><td>${stateBadge(r)}</td><td data-ping="${r.id}">${pingBadge(r.id)}</td><td>${actions(r)}</td></tr>`;
  }
  function render() {
    head();
    $('tBody').innerHTML = st.rows.length ? st.rows.map(row).join('') : `<tr><td colspan="9" class="nms-empty">${st.tab === 'synced' ? 'Belum ada PPP secret yang terikat pelanggan. Jalankan Smart Sync dari tab Unsynced.' : 'Semua PPP secret sudah terikat ke pelanggan.'}</td></tr>`;
    $('pgInfo').textContent = `${st.total} secret · halaman ${st.page}/${st.pages}`;
    $('pgPrev').disabled = st.page <= 1; $('pgNext').disabled = st.page >= st.pages;
    syncBulkBar();
  }
  async function load() {
    const qs = new URLSearchParams({ tab: st.tab, page: st.page, limit: 50 });
    if (N.site) qs.set('site', N.site);
    if (st.q) qs.set('q', st.q);
    if (st.status) qs.set('status', st.status);
    if (st.exempt) qs.set('exempt', '1');
    try {
      const res = await api(`/nms/api/secrets?${qs}`);
      Object.assign(st, { rows: res.rows, pages: res.pages, total: res.total, page: res.page });
      render(); N.markUpdated();
    } catch (err) { $('tBody').innerHTML = `<tr><td colspan="9" class="nms-empty">Gagal memuat: ${esc(err.message)}</td></tr>`; }
  }
  async function loadCounts() {
    try {
      const { counts: c } = await api(`/nms/api/counts${N.site ? `?site=${N.site}` : ''}`);
      $('cOnline').textContent = c.online; $('cOffline').textContent = c.offline; $('cIsolated').textContent = c.isolated;
      $('cSyncPct').textContent = `${c.syncedPct}%`; $('cSynced').textContent = c.synced; $('cExempt').textContent = c.exempt;
      $('tabSynced').textContent = c.synced; $('tabUnsynced').textContent = c.unsynced;
    } catch (_) {}
  }

  // Tabs, filters, pager
  document.querySelectorAll('.nms-subtabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    st.tab = b.dataset.tab; st.page = 1; selected.clear();
    document.querySelectorAll('.nms-subtabs [data-tab]').forEach(x => x.classList.toggle('active', x === b));
    const u = new URL(location.href); u.searchParams.set('tab', st.tab); history.replaceState(null, '', u);
    load();
  }));
  let qTimer = null;
  $('fQ').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value.trim(); st.page = 1; load(); }, 250); });
  $('fStatus').addEventListener('change', e => { st.status = e.target.value; st.page = 1; load(); });
  $('fExempt').addEventListener('change', e => { st.exempt = e.target.checked; st.page = 1; load(); });
  $('pgPrev').addEventListener('click', () => { if (st.page > 1) { st.page--; load(); } });
  $('pgNext').addEventListener('click', () => { if (st.page < st.pages) { st.page++; load(); } });

  // Selection & bulk
  function syncBulkBar() {
    const bar = $('bulkBar'); if (!bar) return;
    bar.classList.toggle('show', selected.size > 0);
    $('bulkCount').textContent = selected.size;
    const all = $('chkAll'); if (all) all.checked = st.rows.length > 0 && st.rows.every(r => selected.has(r.id));
  }
  $('tBody').addEventListener('change', e => {
    const id = Number(e.target.dataset.sel); if (!id) return;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    e.target.closest('tr').classList.toggle('selected', e.target.checked); syncBulkBar();
  });
  $('tHead').addEventListener('change', e => {
    if (e.target.id !== 'chkAll') return;
    st.rows.forEach(r => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); }); render();
  });
  $('bulkClear')?.addEventListener('click', () => { selected.clear(); render(); });

  async function loadProfiles(select) {
    try {
      const { profiles, unreachable } = await api(`/nms/api/profiles${N.site ? `?site=${N.site}` : ''}`);
      const first = select.options[0]?.value === '' ? select.options[0].outerHTML : '';
      select.innerHTML = first + profiles.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      if (unreachable.length) toast(`Profile dari ${unreachable.join(', ')} tidak terbaca (router offline).`);
    } catch (err) { toast(err.message, 'err'); }
  }
  if ($('bulkProfile')) loadProfiles($('bulkProfile'));

  const ACTION_LABEL = { isolate: 'ISOLIR', unisolate: 'UN-ISOLIR', kick: 'KICK', profile: 'GANTI PROFILE' };
  async function runBulk(action, payload) {
    const out = await api('/nms/api/bulk', { method: 'POST', body: { action, ...payload } });
    const s = out.summary;
    toast(`${ACTION_LABEL[action]}: ${s.succeeded}/${s.total} berhasil${s.failed ? `, ${s.failed} gagal` : ''}.`, s.failed ? 'err' : 'ok');
    const failed = out.results.filter(r => !r.ok).slice(0, 5);
    if (failed.length) toast(failed.map(f => `#${f.secretId}: ${f.error}`).join(' | '), 'err');
    return out;
  }
  $('bulkBar')?.addEventListener('click', async e => {
    const action = e.target.closest('[data-bulk]')?.dataset.bulk; if (!action) return;
    const profile = $('bulkProfile').value;
    if (action === 'profile' && !profile) return toast('Pilih profile tujuan terlebih dahulu.', 'err');
    const ok = await N.confirmBox({ title: `Bulk ${ACTION_LABEL[action]}`, danger: action !== 'unisolate', okText: `Jalankan untuk ${selected.size} secret`, message: `Aksi <b>${ACTION_LABEL[action]}</b>${action === 'profile' ? ` → <b>${esc(profile)}</b>` : ''} akan dikirim ke RouterOS untuk <b>${selected.size}</b> secret dan dicatat di audit log.` });
    if (!ok) return;
    const btn = e.target.closest('button'); btn.classList.add('busy');
    try { await runBulk(action, { secretIds: [...selected], profile }); selected.clear(); await Promise.all([load(), loadCounts()]); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.classList.remove('busy'); }
  });

  // Inline actions
  const CONFIRM = {
    isolate: r => ({ title: 'Isolir Pelanggan', danger: true, okText: 'Isolir', message: `Profile <b>${esc(r.username)}</b> diubah ke isolir dan sesi aktif diputus agar redial mendapat IP isolir.` }),
    unisolate: r => ({ title: 'Reconnect / Un-Isolir', okText: 'Buka Isolir', message: `Profile <b>${esc(r.username)}</b> dikembalikan ke <b>${esc(r.original_profile || 'paket semula')}</b>, akun di-enable, dan sesi di-drop untuk memaksa redial.` }),
    kick: r => ({ title: 'Kick / Reset Session', danger: true, okText: 'Kick', message: `Sesi aktif <b>${esc(r.username)}</b> diputus tanpa mengubah status akun.` }),
    'lock-mac': r => ({ title: 'Lock MAC Address', okText: 'Kunci MAC', message: `Caller-ID dari sesi aktif <b>${esc(r.username)}</b>${r.active_caller_id ? ` (<span class="mono">${esc(r.active_caller_id)}</span>)` : ''} akan dikunci ke secret. Perangkat lain tidak akan bisa login dengan akun ini.` }),
    'unlock-mac': r => ({ title: 'Lepas MAC Lock', okText: 'Lepas', message: `Caller-ID <span class="mono">${esc(r.caller_id)}</span> dihapus dari secret <b>${esc(r.username)}</b>.` }),
    unmap: r => ({ title: 'Lepas Link Pelanggan', danger: true, okText: 'Lepas', message: `Secret <b>${esc(r.username)}</b> tidak lagi terikat ke <b>${esc(r.customer_name)}</b> (kembali ke tab Unsynced).` })
  };
  $('tBody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = Number(btn.dataset.id), act = btn.dataset.act, r = st.rows.find(x => x.id === id);
    if (!r) return;
    if (act === 'ping') return doPing(r);
    if (act === 'map') return openMap(r);
    if (CONFIRM[act] && !(await N.confirmBox(CONFIRM[act](r)))) return;
    btn.classList.add('busy');
    try {
      const url = act === 'unlock-mac' ? `/nms/api/secrets/${id}/lock-mac` : `/nms/api/secrets/${id}/${act}`;
      const out = await api(url, { method: 'POST', body: act === 'unlock-mac' ? { unlock: true } : {} });
      const res = out.result || {};
      const msg = { isolate: `${r.username} diisolir (${res.mode}).`, unisolate: `${r.username} dibuka isolirnya → ${res.restoredProfile}.`, kick: res.droppedSessions ? `Sesi ${r.username} di-reset.` : `${r.username} tidak memiliki sesi aktif.`, 'lock-mac': `MAC ${res.callerId} dikunci ke ${r.username}.`, 'unlock-mac': `MAC lock ${r.username} dilepas.`, unmap: `Link ${r.username} dilepas.` }[act];
      toast(msg, 'ok');
      await Promise.all([load(), loadCounts()]);
    } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
  });

  async function doPing(r) {
    pingCache.set(r.id, { busy: true }); paintPing(r.id);
    try { const { result } = await api(`/nms/api/secrets/${r.id}/ping`, { method: 'POST', body: {} }); pingCache.set(r.id, result); }
    catch (err) { pingCache.set(r.id, { error: err.message }); toast(err.message, 'err'); }
    paintPing(r.id);
  }
  function paintPing(id) { const cell = app.querySelector(`[data-ping="${id}"]`); if (cell) cell.innerHTML = pingBadge(id); }

  // Manual mapping (auto-complete)
  const mMap = N.modal('mMap');
  let mapSecret = null, mapPick = null, acTimer = null, acIdx = -1, acRows = [];
  function openMap(r) {
    mapSecret = r; mapPick = null;
    $('mMapSecret').textContent = `${r.username} · ${r.site_code} / ${r.router_name}`;
    $('mMapSite').value = String(r.site_id); $('mMapQ').value = ''; $('mMapList').hidden = true;
    $('mMapPicked').textContent = 'Belum memilih pelanggan.'; $('mMapSave').disabled = true;
    mMap.open();
  }
  async function searchCustomers() {
    const q = $('mMapQ').value.trim();
    if (q.length < 2) { $('mMapList').hidden = true; return; }
    try {
      const { rows } = await api(`/nms/api/customers/search?q=${encodeURIComponent(q)}&site=${$('mMapSite').value}`);
      acRows = rows; acIdx = -1;
      $('mMapList').innerHTML = rows.length ? rows.map((c, i) => `<button type="button" data-i="${i}" ${c.linked_username ? 'disabled' : ''}><b class="mono">${esc(c.customer_code)}</b><span style="flex:1">${esc(c.name)}</span><small class="dim">${esc(c.site_code)}${c.linked_username ? ' · sudah: ' + esc(c.linked_username) : ''}</small></button>`).join('') : '<div class="nms-empty">Tidak ditemukan.</div>';
      $('mMapList').hidden = false;
    } catch (err) { toast(err.message, 'err'); }
  }
  function pick(i) {
    const c = acRows[i]; if (!c || c.linked_username) return;
    mapPick = c; $('mMapQ').value = `${c.customer_code} · ${c.name}`; $('mMapList').hidden = true;
    $('mMapPicked').innerHTML = `Terpilih: <b>${esc(c.name)}</b> (${esc(c.customer_code)}) · site ${esc(c.site_code)}`; $('mMapSave').disabled = false;
  }
  $('mMapQ').addEventListener('input', () => { clearTimeout(acTimer); mapPick = null; $('mMapSave').disabled = true; acTimer = setTimeout(searchCustomers, 200); });
  $('mMapQ').addEventListener('keydown', e => {
    const items = [...$('mMapList').querySelectorAll('button:not(:disabled)')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acIdx = Math.max(0, Math.min(items.length - 1, acIdx + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((b, i) => b.classList.toggle('on', i === acIdx)); }
    if (e.key === 'Enter') { e.preventDefault(); if (items[acIdx]) pick(Number(items[acIdx].dataset.i)); }
  });
  $('mMapList').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
  $('mMapSite').addEventListener('change', searchCustomers);
  $('mMapSave').addEventListener('click', async () => {
    if (!mapSecret || !mapPick) return;
    $('mMapSave').classList.add('busy');
    try { await api(`/nms/api/secrets/${mapSecret.id}/map`, { method: 'POST', body: { customerId: mapPick.id } }); toast(`${mapSecret.username} → ${mapPick.name} tersimpan.`, 'ok'); mMap.close(); await Promise.all([load(), loadCounts()]); }
    catch (err) { toast(err.message, 'err'); }
    finally { $('mMapSave').classList.remove('busy'); }
  });

  // Smart Sync preview → commit
  const mSync = N.modal('mSync');
  let plan = null;
  $('btnSmartSync')?.addEventListener('click', async () => {
    plan = null; $('mSyncCommit').disabled = true; $('mSyncBody').innerHTML = '<div class="nms-empty">Menarik secret terbaru & mencocokkan dengan data pelanggan…</div>'; mSync.open();
    try {
      ({ plan } = await api(`/nms/api/sync/preview?refresh=1${N.site ? `&site=${N.site}` : ''}`));
      const s = plan.summary;
      $('mSyncBody').innerHTML = `<div class="nms-stat-row"><div class="nms-stat"><small>Dipindai</small><b>${s.scanned}</b></div><div class="nms-stat"><small>Siap di-link</small><b style="color:#10B981">${s.matched}</b></div><div class="nms-stat"><small>Konflik</small><b style="color:#F59E0B">${s.conflicts}</b></div><div class="nms-stat"><small>Tidak cocok</small><b>${s.unmatched}</b></div></div>
        <p class="dim" style="margin:0 0 8px">Pencocokan case-insensitive: <b>PPP Username</b> = <b>Customer ID</b> atau <b>Nama Pelanggan</b> di site yang sama. Hapus centang pasangan yang tidak ingin di-link.</p>
        <div class="nms-table-wrap" style="max-height:320px"><table class="nms-table"><thead><tr><th><input type="checkbox" id="spAll" checked aria-label="Semua"></th><th>Nama Pelanggan</th><th></th><th>PPP Username</th><th>Site</th><th>Cocok via</th></tr></thead><tbody>
        ${plan.pairs.map(p => `<tr><td><input type="checkbox" data-pair="${p.secretId}" checked></td><td><b>${esc(p.customerName)}</b><span class="sub">${esc(p.customerCode)}</span></td><td class="dim">⇄</td><td class="mono">${esc(p.username)}</td><td>${esc(p.siteCode)}</td><td><span class="nms-pill ${p.matchedOn === 'customer_code' ? 'green' : 'blue'}">${p.matchedOn === 'customer_code' ? 'Customer ID' : 'Nama'}</span></td></tr>`).join('') || '<tr><td colspan="6" class="nms-empty">Tidak ada pasangan yang cocok.</td></tr>'}
        </tbody></table></div>
        ${plan.conflicts.length ? `<details style="margin-top:10px"><summary style="cursor:pointer;color:#F59E0B">${plan.conflicts.length} konflik — perlu Map to Customer manual</summary><ul class="dim" style="margin:6px 0 0;padding-left:18px">${plan.conflicts.slice(0, 100).map(c => `<li><span class="mono">${esc(c.username)}</span> (${esc(c.siteCode)}): ${c.reason === 'multiple_customers' ? 'cocok ke >1 pelanggan' : 'pelanggan diklaim >1 secret'} — ${c.customers.map(x => esc(x.name)).join(', ')}</li>`).join('')}</ul></details>` : ''}`;
      $('mSyncExpire').textContent = `Plan ${plan.planId.slice(0, 8)} · berlaku s.d. ${N.hhmmss(plan.expiresAt)}`;
      $('mSyncCommit').disabled = plan.pairs.length === 0;
      $('spAll')?.addEventListener('change', e => { $('mSyncBody').querySelectorAll('[data-pair]').forEach(x => { x.checked = e.target.checked; }); });
    } catch (err) { $('mSyncBody').innerHTML = `<div class="nms-empty">Preview gagal: ${esc(err.message)}</div>`; }
  });
  $('mSyncCommit')?.addEventListener('click', async () => {
    if (!plan) return;
    const ids = [...$('mSyncBody').querySelectorAll('[data-pair]:checked')].map(x => Number(x.dataset.pair));
    if (!ids.length) return toast('Tidak ada pasangan yang dipilih.', 'err');
    $('mSyncCommit').classList.add('busy');
    try {
      const idSet = new Set(ids);
      const pairs = plan.pairs.filter(p => idSet.has(Number(p.secretId))).map(p => ({ secretId: p.secretId, customerId: p.customerId }));
      const out = await api('/nms/api/sync/commit', { method: 'POST', body: { planId: plan.planId, secretIds: ids, pairs, site_id: plan.siteId || N.site || null } });
      toast(`Smart Sync: ${out.summary.linked} di-link${out.summary.failed ? `, ${out.summary.failed} gagal` : ''}${out.summary.skipped ? `, ${out.summary.skipped} dilewati (data berubah sejak preview)` : ''}.`, out.summary.failed ? 'err' : 'ok');
      const bad = out.results.filter(r => !r.ok).slice(0, 5);
      if (bad.length) toast(bad.map(f => `${f.username}: ${f.error}`).join(' | '), 'err');
      mSync.close(); selected.clear(); await Promise.all([load(), loadCounts()]);
    } catch (err) { toast(err.message, 'err'); }
    finally { $('mSyncCommit').classList.remove('busy'); }
  });

  // Refresh from router
  $('btnRefresh')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.classList.add('busy');
    try {
      const { results } = await api(`/nms/api/secrets/refresh${N.site ? `?site=${N.site}` : ''}`, { method: 'POST', body: {} });
      const bad = results.filter(r => !r.ok);
      N.setOffline(bad.length > 0);
      toast(`${results.length - bad.length}/${results.length} router tersinkron${bad.length ? ' — sebagian offline, menampilkan data cache.' : '.'}`, bad.length ? 'err' : 'ok');
      await Promise.all([load(), loadCounts()]);
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.classList.remove('busy'); }
  });

  // Bulk per site / jatuh tempo (dry-run dulu)
  const mSite = N.modal('mSiteBulk');
  const sbPayload = () => ({ filter: { siteId: Number($('sbSite').value), overdueOnly: $('sbOverdue').checked, state: $('sbAction').value === 'unisolate' ? 'isolated' : $('sbAction').value === 'isolate' ? 'active' : null }, profile: $('sbProfile').value || null });
  const resetSb = () => { $('sbRun').disabled = true; $('sbCount').textContent = '—'; };
  $('btnSiteIsolir')?.addEventListener('click', () => { resetSb(); mSite.open(); });
  $('sbAction')?.addEventListener('change', () => { const isP = $('sbAction').value === 'profile'; $('sbProfileWrap').hidden = !isP; if (isP && !$('sbProfile').options.length) loadProfiles($('sbProfile')); resetSb(); });
  ['sbSite', 'sbOverdue', 'sbProfile'].forEach(id => $(id)?.addEventListener('change', resetSb));
  $('sbPreview')?.addEventListener('click', async () => {
    try { const out = await api('/nms/api/bulk', { method: 'POST', body: { action: $('sbAction').value, dryRun: true, ...sbPayload() } }); $('sbCount').textContent = `${out.count} secret`; $('sbRun').disabled = out.count === 0; }
    catch (err) { toast(err.message, 'err'); }
  });
  $('sbRun')?.addEventListener('click', async () => {
    const btn = $('sbRun'); btn.classList.add('busy');
    try { await runBulk($('sbAction').value, sbPayload()); mSite.close(); await Promise.all([load(), loadCounts()]); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.classList.remove('busy'); }
  });

  // Real-time: event PPP untuk baris yang tampil → reload ringan (debounce).
  let rt = null;
  const soon = () => { clearTimeout(rt); rt = setTimeout(() => { load(); loadCounts(); }, 1500); };
  N.stream({
    ppp: e => { if (st.rows.some(r => String(r.username).toLowerCase() === String(e.username || '').toLowerCase())) soon(); },
    router_state: s => { if (s.status === 'offline') { N.setOffline(true); toast('Router tidak terjangkau — data tabel dari cache database.', 'err'); } },
    sync: soon
  }, { fallback: async () => { await load(); await loadCounts(); }, fallbackMs: 30000 });

  head(); load();
})();
