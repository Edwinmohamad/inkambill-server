// Ringkasan Jaringan: widget traffic WAN per router (mengikuti filter site), router health,
// sinkronisasi, perlu perhatian, live log, dan putus-sambung. Real-time via SSE.
(() => {
  const N = window.NX;
  const app = document.getElementById('nmsDashboard');
  if (!N || !app) return;
  const { esc, fmtBps, splitBps, fmtBytes, fmtUptime, hhmmss, api, toast, ring, areaChart, COLORS } = N;
  let data = JSON.parse(document.getElementById('nmsBoot').textContent || '{}');
  const routers = new Map((data.routers || []).map(r => [r.routerId, r]));
  let events = (data.events || []).slice().reverse();
  let alerts = data.alerts || [];
  let logFilter = 'all', paused = false;
  const $ = id => document.getElementById(id);
  const sorted = () => [...routers.values()].sort((a, b) => String(a.siteCode).localeCompare(String(b.siteCode)) || String(a.name).localeCompare(String(b.name)));

  // ---------- Traffic WAN: 1 widget per router di scope ----------
  const trafficEl = $('nxTraffic');
  function trafficShell(r) {
    const el = document.createElement('article');
    el.className = 'nx-card nx-traffic';
    el.dataset.router = r.routerId;
    el.innerHTML = `<div class="nx-traffic-head"><span class="nx-state" data-st></span><b data-name></b><span class="nx-pill" data-site></span><span class="grow"></span><span class="nx-pill mono" data-if></span>${N.canControl ? `<button type="button" class="nx-btn sm icon ghost" data-wan title="Atur interface WAN" aria-label="Atur interface WAN"><i class="bi bi-sliders"></i></button>` : ''}</div>
      <div class="nx-traffic-read"><div><small><i data-c="rx"></i>Download</small><strong data-rx>—</strong></div><div><small><i data-c="tx"></i>Upload</small><strong data-tx>—</strong></div><div class="peak"><small>Puncak 30 mnt</small><strong data-peak>—</strong></div></div>
      <div class="nx-chart" data-chart></div>
      <div class="nx-traffic-foot"><span data-foot></span><span class="grow"></span><span data-sess></span></div>`;
    el.querySelector('[data-wan]')?.addEventListener('click', () => editWan(r.routerId));
    return el;
  }
  function renderTraffic() {
    const list = sorted();
    const c = COLORS();
    $('nxTrafficSub').textContent = list.length ? `${list.length} router${N.site ? ' di site ini' : ' di semua site'} · 30 menit terakhir` : '';
    if (!list.length) { trafficEl.innerHTML = '<div class="nx-card"><div class="nx-empty"><i class="bi bi-router"></i>Belum ada router aktif di scope ini.</div></div>'; return; }
    const ids = new Set(list.map(r => String(r.routerId)));
    [...trafficEl.children].forEach(ch => { if (!ids.has(ch.dataset.router)) ch.remove(); });
    list.forEach((r, i) => {
      let el = trafficEl.querySelector(`[data-router="${r.routerId}"]`);
      if (!el) { el = trafficShell(r); trafficEl.appendChild(el); }
      if (trafficEl.children[i] !== el) trafficEl.insertBefore(el, trafficEl.children[i]);
      const w = r.wan || { history: [] };
      const online = r.status === 'online', down = r.status === 'offline';
      el.classList.toggle('offline', down);
      const st = el.querySelector('[data-st]'); st.className = `nx-state ${online ? 'online' : down ? 'isolated' : 'offline'}`; st.textContent = '';
      el.querySelector('[data-name]').textContent = r.name;
      el.querySelector('[data-site]').textContent = r.siteCode || '';
      el.querySelector('[data-if]').textContent = w.interface || 'auto';
      el.querySelector('[data-c="rx"]').style.background = c.blue;
      el.querySelector('[data-c="tx"]').style.background = c.green;
      const [rv, ru] = splitBps(w.rxBps), [tv, tu] = splitBps(w.txBps);
      el.querySelector('[data-rx]').innerHTML = online ? `${rv}<span>${ru}</span>` : '—';
      el.querySelector('[data-tx]').innerHTML = online ? `${tv}<span>${tu}</span>` : '—';
      el.querySelector('[data-peak]').textContent = `↓ ${fmtBps(w.peakRxBps)} · ↑ ${fmtBps(w.peakTxBps)}`;
      el.querySelector('[data-foot]').textContent = online ? (w.running === false ? 'Interface WAN down' : 'Live') : down ? `Tidak terjangkau · data terakhir ${r.lastOkAt ? N.ago(r.lastOkAt) : 'belum ada'}` : 'Menunggu polling pertama · menampilkan data tersimpan';
      el.querySelector('[data-sess]').textContent = r.activeSessions != null ? `${r.activeSessions} sesi aktif` : '';
      const h = (w.history || []);
      areaChart(el.querySelector('[data-chart]'), { times: h.map(p => p.t), series: [{ name: 'Download', color: c.blue, values: h.map(p => p.rx) }, { name: 'Upload', color: c.green, values: h.map(p => p.tx) }], empty: down ? 'Router tidak terjangkau' : 'Mengumpulkan sampel…' });
    });
  }
  async function editWan(routerId) {
    try {
      const { rows } = await api(`/nms/api/routers/${routerId}/interfaces`);
      const current = routers.get(routerId)?.wan?.interface || '';
      const s = N.sheet({ title: 'Interface WAN', subtitle: `${esc(routers.get(routerId)?.name || '')} · dipakai untuk grafik traffic`, size: 'sm',
        body: `<div class="nx-field"><label>Interface</label><select data-if><option value="">Deteksi otomatis</option>${rows.map(i => `<option value="${esc(i.name)}" ${i.name === current ? 'selected' : ''}>${esc(i.name)} · ${esc(i.type)}${i.comment ? ' · ' + esc(i.comment) : ''}${i.running ? '' : ' (down)'}</option>`).join('')}</select></div>`,
        foot: '<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save>Simpan</button>' });
      s.$('[data-save]').addEventListener('click', async () => {
        try { await api(`/nms/api/routers/${routerId}/wan-interface`, { method: 'POST', body: { interface: s.$('[data-if]').value } }); toast('Interface WAN disimpan. Grafik mulai ulang di polling berikutnya.', 'ok'); s.close(); }
        catch (err) { toast(err.message, 'err'); }
      });
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---------- Router health ----------
  function routerCard(r) {
    const t = r.telemetry || {}, mem = t.memory || {}, disk = t.disk || {}, h = t.health || {};
    const stale = r.status === 'offline', waiting = r.status !== 'online' && !stale;
    const diskUsed = disk.freePct == null ? null : 100 - disk.freePct;
    const tempTone = h.temperature == null ? '' : h.temperature >= 70 ? 'red' : h.temperature >= 55 ? 'orange' : 'green';
    return `<div class="nx-router ${stale ? 'offline' : ''}">
      <div class="nx-router-top"><span class="nx-state ${stale ? 'isolated' : waiting ? 'offline' : 'online'}"></span><div class="grow" style="min-width:0"><b>${esc(r.name)}</b><small> · ${esc(r.siteCode)}${t.board ? ' · ' + esc(t.board) : ''}${t.version ? ' · v' + esc(t.version) : ''}</small></div></div>
      <div class="nx-rings">${ring(stale ? null : t.cpuPct, { label: 'CPU' })}${ring(mem.pct, { label: 'RAM' })}${ring(diskUsed, { label: 'DISK' })}
        <div style="min-width:0;font-size:12.5px;line-height:1.6"><div class="muted">Uptime</div><b>${t.uptimeSeconds ? fmtUptime(t.uptimeSeconds) : '—'}</b><div class="muted" style="margin-top:2px">RAM</div><span class="num" style="font-size:12px">${mem.total ? `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}` : '—'}</span></div></div>
      <div class="nx-router-meta">
        ${stale ? `<span class="nx-pill red" title="${esc(r.lastError || '')}">Tidak terjangkau · ${r.lastOkAt ? N.ago(r.lastOkAt) : 'belum pernah online'}</span>` : waiting ? '<span class="nx-pill">Menunggu polling</span>' : '<span class="nx-pill green">Online</span>'}
        ${h.temperature != null ? `<span class="nx-pill ${tempTone}"><i class="bi bi-thermometer-half"></i>${h.temperature}°C</span>` : ''}
        ${h.voltage != null ? `<span class="nx-pill"><i class="bi bi-lightning-charge"></i>${h.voltage} V</span>` : ''}
        ${r.activeSessions != null ? `<span class="nx-pill blue">${r.activeSessions} sesi</span>` : ''}
      </div></div>`;
  }
  function renderRouters() {
    const list = sorted();
    $('nmsRouters').innerHTML = list.length ? list.map(routerCard).join('') : '<div class="nx-empty">Belum ada router aktif. Tambahkan di menu Router.</div>';
    const up = list.filter(r => r.status === 'online').length;
    $('kpiRouters').textContent = `${up}/${list.length}`;
    N.setOffline(list.some(r => r.status === 'offline'));
  }

  // ---------- Sync ring + KPI ----------
  function renderSync() {
    const s = data.sync || {}, c = data.customers || {}, col = COLORS();
    $('kpiOnline').textContent = c.online ?? 0; $('kpiOffline').textContent = c.offline ?? 0; $('kpiIsolated').textContent = c.isolated ?? 0; $('kpiUnsynced').textContent = s.unsynced ?? 0;
    const total = (s.synced || 0) + (s.unsynced || 0) + (s.exempt || 0);
    const seg = [[s.synced || 0, col.green], [s.unsynced || 0, col.purple], [s.exempt || 0, col.gray]];
    const R = 70, len = 2 * Math.PI * R; let off = 0;
    const arcs = total ? seg.filter(([v]) => v > 0).map(([v, color]) => { const l = v / total * len; const gap = seg.filter(([x]) => x > 0).length > 1 ? 3 : 0; const a = `<circle cx="85" cy="85" r="${R}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${Math.max(0, l - gap)} ${len}" stroke-dashoffset="${-off}" stroke-linecap="butt"/>`; off += l; return a; }).join('') : '';
    $('nxSyncRing').innerHTML = `<svg viewBox="0 0 170 170"><circle cx="85" cy="85" r="${R}" fill="none" stroke="${col.track}" stroke-width="16"/>${arcs}</svg><div class="c"><b>${s.syncedPct ?? 0}%</b><small>ter-link</small></div>`;
    $('nxSyncLegend').innerHTML = `<span><i style="background:${col.green}"></i>Ter-link <b>${s.synced ?? 0}</b></span><span><i style="background:${col.purple}"></i>Belum <b>${s.unsynced ?? 0}</b></span><span><i style="background:${col.gray}"></i>Exempt <b>${s.exempt ?? 0}</b></span>`;
  }

  // ---------- Perlu perhatian (dari rekonsiliasi) ----------
  const ATT_ICON = { overdue_active: ['red', 'bi-cash-coin'], paid_isolated: ['orange', 'bi-emoji-frown'], inactive_online: ['red', 'bi-person-x'], secret_no_customer: ['purple', 'bi-question-circle'], customer_no_secret: ['blue', 'bi-person-plus'], removed_on_router: ['gray', 'bi-trash'] };
  document.addEventListener('nx:recon', e => {
    const groups = Object.values(e.detail || {}).filter(g => g.count > 0);
    $('nxAttention').innerHTML = groups.length ? groups.map(g => { const [cls, ic] = ATT_ICON[g.key] || ['gray', 'bi-dot']; return `<li class="clickable" data-k="${g.key}"><span class="li-icon ${cls}"><i class="bi ${ic}"></i></span><div class="li-main"><b>${esc(g.title)}</b></div><b class="num">${g.count}</b><i class="bi bi-chevron-right dim"></i></li>`; }).join('') : '<li><span class="li-icon green"><i class="bi bi-check-lg"></i></span><div class="li-main"><b>Semua cocok</b><small>Billing dan router selaras.</small></div></li>';
  });
  $('nxAttention').addEventListener('click', e => { const li = e.target.closest('[data-k]'); if (li) location.assign(`/nms/insights${N.qs({ site: N.site || undefined, kind: li.dataset.k })}`); });

  // ---------- Alerts ----------
  function renderAlerts() {
    $('nmsAlerts').innerHTML = alerts.map(a => `<div class="nx-alert ${a.severity === 'critical' ? 'critical' : ''} ${a.acknowledged_by ? 'acked' : ''}"><span class="ic"><i class="bi bi-exclamation-lg"></i></span><div class="grow"><b>${esc(a.title)}</b><div class="muted" style="font-size:12.5px">Sejak ${esc(hhmmss(a.opened_at))}${a.details?.stillOffline != null ? ` · masih offline ${a.details.stillOffline}` : ''}</div></div>${N.canControl && !a.acknowledged_by ? `<button type="button" class="nx-btn sm" data-ack="${a.id}">Tandai sudah dilihat</button>` : ''}</div>`).join('');
  }
  $('nmsAlerts').addEventListener('click', async e => {
    const id = e.target.closest('[data-ack]')?.dataset.ack; if (!id) return;
    try { await api(`/nms/api/alerts/${id}/ack`, { method: 'POST', body: {} }); alerts = alerts.map(a => String(a.id) === id ? { ...a, acknowledged_by: 1 } : a); renderAlerts(); }
    catch (err) { toast(err.message, 'err'); }
  });

  // ---------- Live log ----------
  const TAG = { login: ['green', 'Login'], logout: ['', 'Putus'], auth_failed: ['red', 'Ditolak'], kick: ['orange', 'Kick'], isolate: ['red', 'Isolir'], unisolate: ['green', 'Buka isolir'], lock_mac: ['blue', 'Lock MAC'], profile: ['purple', 'Profile'], create: ['blue', 'Dibuat'] };
  const ACTIONS = ['kick', 'isolate', 'unisolate', 'lock_mac', 'profile', 'create'];
  const matches = e => logFilter === 'all' || (logFilter === 'action' ? ACTIONS.includes(e.type) : e.type === logFilter);
  const siteCodeOf = id => [...routers.values()].find(r => Number(r.siteId) === Number(id))?.siteCode || '';
  const line = (e, fresh) => { const [cls, label] = TAG[e.type] || ['', e.type]; return `<div class="ln ${fresh ? 'fresh' : ''}"><span class="t">${esc(hhmmss(e.at))}</span><span><span class="nx-pill ${cls}">${esc(label)}</span></span><span class="u" title="${esc(e.message || '')}">${esc(e.username || '—')}<small>${esc(e.site_code || e.siteCode || siteCodeOf(e.siteId ?? e.site_id))}${e.address ? ' · ' + esc(e.address) : ''}${e.message && !/^PPP (Login|Disconnect)/.test(e.message) ? ' · ' + esc(e.message) : ''}</small></span></div>`; };
  const consoleEl = $('nmsConsole');
  function renderLog() { consoleEl.innerHTML = events.filter(matches).slice(-300).map(e => line(e)).join('') || '<div class="nx-empty">Menunggu event PPP…</div>'; if (!paused) consoleEl.scrollTop = consoleEl.scrollHeight; }
  function pushEvent(e) {
    events.push(e); if (events.length > 500) events.splice(0, events.length - 500);
    if (!matches(e)) return;
    if (consoleEl.querySelector('.nx-empty')) consoleEl.innerHTML = '';
    consoleEl.insertAdjacentHTML('beforeend', line(e, true));
    while (consoleEl.childElementCount > 300) consoleEl.firstElementChild.remove();
    if (!paused) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  $('nmsLogFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; logFilter = b.dataset.f; document.querySelectorAll('#nmsLogFilter button').forEach(x => x.classList.toggle('active', x === b)); renderLog(); });
  $('nmsLogPause').addEventListener('click', e => { paused = !paused; e.currentTarget.innerHTML = paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>'; });

  // ---------- Putus-sambung ----------
  function renderFlapping() {
    const rows = data.flapping || [];
    $('nmsFlapping').innerHTML = rows.length ? rows.map(f => `<li class="${f.secret_id ? 'clickable' : ''}" data-sid="${f.secret_id || ''}"><span class="li-icon ${f.reconnects > 10 ? 'red' : 'orange'}"><i class="bi bi-arrow-repeat"></i></span><div class="li-main"><b>${esc(f.customer_name || f.username)}</b><small class="mono">${esc(f.username)} · ${esc(f.site_code)}</small></div><b class="num">${f.reconnects}×</b>${N.canControl && f.secret_id ? `<button type="button" class="nx-btn sm tint" data-ticket="${f.secret_id}">Tiket</button>` : ''}</li>`).join('') : '<li><span class="li-icon green"><i class="bi bi-check-lg"></i></span><div class="li-main"><b>Semua stabil</b><small>Tidak ada pelanggan putus-sambung dalam 1 jam.</small></div></li>';
  }
  $('nmsFlapping').addEventListener('click', async e => {
    const t = e.target.closest('[data-ticket]');
    if (t) { e.stopPropagation(); t.classList.add('busy'); try { const { ticket } = await api(`/nms/api/secrets/${t.dataset.ticket}/ticket`, { method: 'POST', body: {} }); toast(ticket.existing ? `Tiket ${ticket.code} sudah ada.` : `Tiket ${ticket.code} dibuat.`, 'ok'); } catch (err) { toast(err.message, 'err'); } t.classList.remove('busy'); return; }
    const li = e.target.closest('[data-sid]'); if (li?.dataset.sid) N.drawer(Number(li.dataset.sid));
  });

  function renderAll() { renderTraffic(); renderRouters(); renderSync(); renderAlerts(); renderLog(); renderFlapping(); N.markUpdated(data.generatedAt); }
  async function refresh() {
    const res = await api(`/nms/api/dashboard${N.withSite()}`);
    data = res.data;
    (data.routers || []).forEach(r => routers.set(r.routerId, r));
    alerts = data.alerts || [];
    const lastId = Math.max(0, ...events.filter(e => e.id).map(e => e.id));
    (data.events || []).slice().reverse().filter(e => e.id > lastId).forEach(pushEvent);
    renderTraffic(); renderRouters(); renderSync(); renderAlerts(); renderFlapping(); N.markUpdated(data.generatedAt);
  }

  renderAll();
  let frame = null, resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderTraffic, 150); });
  N.stream({
    telemetry: r => { if (N.site && Number(r.siteId) !== Number(N.site)) return; routers.set(r.routerId, r); if (!frame) frame = requestAnimationFrame(() => { frame = null; renderTraffic(); renderRouters(); }); N.markUpdated(new Date().toISOString()); },
    router_state: s => { const r = routers.get(s.routerId); if (r) { r.status = s.status; r.lastError = s.error; renderRouters(); renderTraffic(); } if (s.status === 'offline') toast(`Router ${r?.name || s.routerId} tidak terjangkau`, 'err'); },
    ppp: e => pushEvent(e),
    alert: a => { alerts = [{ ...a, opened_at: a.openedAt }, ...alerts.filter(x => x.id !== a.id)]; renderAlerts(); toast(a.title, 'err'); },
    alert_resolved: () => refresh().catch(() => {}),
    sync: () => refresh().catch(() => {})
  }, { fallback: refresh, fallbackMs: 20000 });
  document.addEventListener('nx:changed', () => refresh().catch(() => {}));
  setInterval(() => { if (!document.hidden) refresh().catch(() => N.setLive('down')); }, 30000);
})();
