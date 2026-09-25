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
  // Router terjangkau di depan, lalu urut site & nama, supaya kartu yang offline tidak mendominasi baris pertama.
  const rank = r => r.status === 'online' ? 0 : r.status === 'offline' ? 2 : 1;
  const sorted = () => [...routers.values()].sort((a, b) => rank(a) - rank(b) || String(a.siteCode).localeCompare(String(b.siteCode)) || String(a.name).localeCompare(String(b.name)));
  const stateCls = r => r.status === 'online' ? 'online' : r.status === 'offline' ? 'isolated' : 'offline';

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
    // Pasang semua kartu dulu agar lebar grid final sebelum grafik diukur (grafik pertama tidak mengecil).
    list.forEach((r, i) => {
      let el = trafficEl.querySelector(`[data-router="${r.routerId}"]`);
      if (!el) { el = trafficShell(r); trafficEl.appendChild(el); }
      if (trafficEl.children[i] !== el) trafficEl.insertBefore(el, trafficEl.children[i]);
    });
    list.forEach(r => {
      const el = trafficEl.querySelector(`[data-router="${r.routerId}"]`);
      const w = r.wan || { history: [] };
      const online = r.status === 'online', down = r.status === 'offline';
      el.classList.toggle('offline', down);
      const st = el.querySelector('[data-st]'); st.className = `nx-state ${stateCls(r)}`; st.textContent = '';
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

  // ---------- Router: kesehatan + dampak pelanggan (klik untuk detail) ----------
  function routerCard(r) {
    const t = r.telemetry || {}, mem = t.memory || {}, disk = t.disk || {}, h = t.health || {}, impact = r.impact || {};
    const down = r.status === 'offline', waiting = r.status !== 'online' && !down;
    const diskUsed = disk.freePct == null ? null : Math.round((100 - disk.freePct) * 10) / 10;
    const tempTone = h.temperature == null ? '' : h.temperature >= 70 ? 'red' : h.temperature >= 55 ? 'orange' : '';
    const status = down ? `<span class="nx-pill red" title="${esc(r.lastError || '')}">Tidak terjangkau</span>` : waiting ? '<span class="nx-pill">Menunggu polling</span>' : '<span class="nx-pill green">Online</span>';
    const sub = [t.board, t.version ? `RouterOS ${t.version}` : null, t.uptimeSeconds && !down ? `uptime ${fmtUptime(t.uptimeSeconds)}` : null].filter(Boolean).map(esc).join(' · ');
    return `<button type="button" class="nx-router ${down ? 'offline' : ''}" data-router-detail="${r.routerId}">
      <div class="nx-router-top"><span class="nx-state ${stateCls(r)}"></span><b>${esc(r.name)}</b><span class="nx-pill">${esc(r.siteCode || '')}</span><span class="grow"></span>${status}</div>
      <div class="nx-router-sub">${down ? `Data terakhir ${r.lastOkAt ? esc(N.ago(r.lastOkAt)) : 'belum ada'}` : sub || '&nbsp;'}</div>
      <div class="nx-rings ${down ? 'stale' : ''}">${ring(down ? null : t.cpuPct, { label: 'CPU' })}${ring(down ? null : mem.pct, { label: 'RAM' })}${ring(diskUsed, { label: 'Disk' })}</div>
      <div class="nx-router-foot">
        <span><b class="num">${impact.linked || 0}</b> pelanggan</span><span><b class="num">${impact.online || 0}</b> online</span>
        ${h.temperature != null && !down ? `<span class="${tempTone ? 'tone-' + tempTone : ''}"><i class="bi bi-thermometer-half"></i>${h.temperature}°C</span>` : ''}
        ${r.activeSessions != null && !down ? `<span><b class="num">${r.activeSessions}</b> sesi</span>` : ''}
      </div></button>`;
  }
  function renderRouters() {
    const list = sorted();
    $('nmsRouters').innerHTML = list.length ? list.map(routerCard).join('') : '<div class="nx-card nx-span-all"><div class="nx-empty"><i class="bi bi-router"></i>Belum ada router aktif. Tambahkan di menu Router.</div></div>';
    const up = list.filter(r => r.status === 'online').length;
    $('kpiRouters').textContent = `${up}/${list.length}`;
    $('kpiRoutersSub').textContent = list.length && up < list.length ? `${list.length - up} tidak terjangkau` : 'polling tiap 15 detik';
  }
  function routerDetail(id) {
    const r = routers.get(Number(id)); if (!r) return;
    const t = r.telemetry || {}, impact = r.impact || {}, h = t.health || {};
    const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    N.sheet({ title: r.name, subtitle: `${esc(r.siteCode || '')} · ${r.status === 'online' ? 'Online' : r.status === 'offline' ? 'Tidak terjangkau' : 'Menunggu polling'}`, size: 'sm',
      body: `<div class="nx-mini-stats"><div><small>Pelanggan</small><b>${impact.linked || 0}</b></div><div><small>Online</small><b>${impact.online || 0}</b></div><div><small>Diisolir</small><b>${impact.isolated || 0}</b></div><div><small>Sesi aktif</small><b>${r.activeSessions ?? '—'}</b></div></div>
        ${r.status === 'offline' && r.lastError ? `<div class="nx-verdict bad" style="font-size:13px">${esc(r.lastError)}</div>` : ''}
        <dl class="nx-kv">${kv('Board', esc(t.board || '—'))}${kv('RouterOS', esc(t.version || '—'))}${kv('Uptime', t.uptimeSeconds ? fmtUptime(t.uptimeSeconds) : '—')}${kv('CPU', t.cpuPct == null ? '—' : `${t.cpuPct}%`)}${kv('RAM', t.memory?.total ? `${fmtBytes(t.memory.used)} / ${fmtBytes(t.memory.total)} (${t.memory.pct}%)` : '—')}${kv('Disk', t.disk?.freePct == null ? '—' : `${Math.round(100 - t.disk.freePct)}% terpakai`)}${h.temperature != null ? kv('Suhu', `${h.temperature}°C`) : ''}${h.voltage != null ? kv('Tegangan', `${h.voltage} V`) : ''}${kv('WAN', `<span class="mono">${esc(r.wan?.interface || 'auto')}</span> · ↓ ${fmtBps(r.wan?.rxBps)} · ↑ ${fmtBps(r.wan?.txBps)}`)}${kv('Terakhir online', r.lastOkAt ? esc(N.ago(r.lastOkAt)) : '—')}</dl>`,
      foot: `<a class="nx-btn ghost" href="/nms/secrets${N.qs({ site: r.siteId || undefined })}">PPP Secrets</a><span class="grow"></span><button type="button" class="nx-btn" data-close>Tutup</button>` });
  }
  $('nmsRouters').addEventListener('click', e => { const id = e.target.closest('[data-router-detail]')?.dataset.routerDetail; if (id) routerDetail(id); });

  // ---------- Sync ring + KPI ----------
  function renderSync() {
    const s = data.sync || {}, c = data.customers || {}, col = COLORS();
    $('kpiOnline').textContent = c.online ?? 0; $('kpiOffline').textContent = c.offline ?? 0; $('kpiIsolated').textContent = c.isolated ?? 0; $('kpiUnsynced').textContent = s.unsynced ?? 0;
    $('kpiHealth').textContent = data.healthScore ?? 0;
    $('kpiFreshness').textContent = data.freshness?.newest ? `${data.freshness.stale ? '⚠ mirror basi ' : 'mirror '}${N.ago(data.freshness.newest)}` : '⚠ belum ada mirror';
    const total = (s.synced || 0) + (s.unsynced || 0) + (s.exempt || 0);
    const seg = [[s.synced || 0, col.green], [s.unsynced || 0, col.purple], [s.exempt || 0, col.gray]];
    const R = 70, len = 2 * Math.PI * R; let off = 0;
    const arcs = total ? seg.filter(([v]) => v > 0).map(([v, color]) => { const l = v / total * len; const gap = seg.filter(([x]) => x > 0).length > 1 ? 3 : 0; const a = `<circle cx="85" cy="85" r="${R}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${Math.max(0, l - gap)} ${len}" stroke-dashoffset="${-off}" stroke-linecap="butt"/>`; off += l; return a; }).join('') : '';
    $('nxSyncRing').innerHTML = `<svg viewBox="0 0 170 170"><circle cx="85" cy="85" r="${R}" fill="none" stroke="${col.track}" stroke-width="16"/>${arcs}</svg><div class="c"><b>${s.syncedPct ?? 0}%</b><small>ter-link</small></div>`;
    $('nxSyncLegend').innerHTML = `<span><i style="background:${col.green}"></i>Ter-link <b>${s.synced ?? 0}</b></span><span><i style="background:${col.purple}"></i>Belum <b>${s.unsynced ?? 0}</b></span><span><i style="background:${col.gray}"></i>Exempt <b>${s.exempt ?? 0}</b></span><span>Hari ini <b>${s.linkedToday ?? 0}</b> · ${s.batchesToday ?? 0} batch</span>`;
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
    try { await api(`/nms/api/alerts/${id}/ack`, { method: 'POST', body: {} }); alerts = alerts.map(a => String(a.id) === id ? { ...a, acknowledged_by: 1 } : a); renderAlerts(); renderHero(); }
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
  $('nmsLogPause').addEventListener('click', e => { paused = !paused; const b = e.currentTarget; b.setAttribute('aria-pressed', String(paused)); b.title = paused ? 'Lanjutkan auto-scroll' : 'Jeda auto-scroll'; b.innerHTML = paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>'; if (!paused) consoleEl.scrollTop = consoleEl.scrollHeight; });

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
  const afterData = () => { renderTotal(); renderHero(); };
  async function refresh() {
    const res = await api(`/nms/api/dashboard${N.withSite()}`);
    data = res.data;
    (data.routers || []).forEach(r => routers.set(r.routerId, r));
    alerts = data.alerts || [];
    const lastId = Math.max(0, ...events.filter(e => e.id).map(e => e.id));
    (data.events || []).slice().reverse().filter(e => e.id > lastId).forEach(pushEvent);
    renderTraffic(); renderRouters(); renderSync(); renderAlerts(); renderFlapping(); afterData(); N.markUpdated(data.generatedAt);
  }

  renderAll();
  let frame = null, resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderTraffic, 150); });
  N.stream({
    telemetry: r => { if (N.site && Number(r.siteId) !== Number(N.site)) return; routers.set(r.routerId, r); if (!frame) frame = requestAnimationFrame(() => { frame = null; renderTraffic(); renderRouters(); afterData(); }); N.markUpdated(new Date().toISOString()); },
    router_state: s => { const r = routers.get(s.routerId); if (r) { r.status = s.status; r.lastError = s.error; renderRouters(); renderTraffic(); afterData(); } if (s.status === 'offline') toast(`Router ${r?.name || s.routerId} tidak terjangkau`, 'err'); },
    ppp: e => pushEvent(e),
    alert: a => { alerts = [{ ...a, opened_at: a.openedAt }, ...alerts.filter(x => x.id !== a.id)]; renderAlerts(); afterData(); toast(a.title, 'err'); },
    alert_resolved: () => refresh().catch(() => {}),
    sync: () => refresh().catch(() => {})
  }, { fallback: refresh, fallbackMs: 20000 });
  document.addEventListener('nx:changed', () => refresh().catch(() => {}));
  setInterval(() => { if (!document.hidden) refresh().catch(() => N.setLive('down')); }, 30000);
  // ---------- Hero: skor kesehatan, kalimat status, dan maskot ----------
  const mascot = window.NXMascot?.mount($('nxMascot'));
  function heroState() {
    const list = sorted(), up = list.filter(r => r.status === 'online').length, off = list.filter(r => r.status === 'offline');
    const openAlerts = alerts.filter(a => !a.acknowledged_by);
    const critical = openAlerts.filter(a => a.severity === 'critical');
    const flaps = (data.flapping || []).length;
    const score = Number(data.healthScore) || 0;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false }).format(new Date()));
    let mood = 'ok';
    if (list.length && up === 0) mood = 'dizzy';
    else if (critical.length || off.length) mood = 'panic';
    else if (data.freshness?.stale) mood = 'dizzy';
    else if (openAlerts.length || score < 60 || flaps >= 3) mood = 'worried';
    else if (hour >= 0 && hour < 5) mood = 'sleepy';
    else if (score >= 85) mood = 'happy';
    const affected = off.reduce((a, r) => a + (r.impact?.linked || 0), 0);
    const title = { happy: 'Jaringan sehat', ok: 'Jaringan normal', worried: 'Perlu perhatian', panic: 'Ada gangguan', dizzy: list.length && up === 0 ? 'Semua router tidak terjangkau' : 'Data router belum terbaru', sleepy: 'Malam yang tenang' }[mood];
    const parts = [];
    if (off.length) parts.push(`${off.map(r => r.name).slice(0, 2).join(', ')}${off.length > 2 ? ` +${off.length - 2}` : ''} tidak terjangkau · ±${affected} pelanggan terdampak`);
    else if (critical.length) parts.push(critical[0].title);
    else if (openAlerts.length) parts.push(openAlerts[0].title);
    else if (data.freshness?.stale) parts.push('Mirror secret lebih dari 10 menit. Cek koneksi API router.');
    if (!parts.length) parts.push(`${up}/${list.length} router online, ${data.customers?.online ?? 0} pelanggan terhubung.`);
    if (flaps && mood !== 'panic') parts.push(`${flaps} pelanggan putus-sambung`);
    return { mood, score, title, text: parts.join(' · '), up, total: list.length, openAlerts: openAlerts.length };
  }
  function gauge(score, color) {
    const r = 52, len = Math.PI * r, p = Math.max(0, Math.min(100, score)) / 100;
    return `<svg viewBox="0 0 128 76" aria-hidden="true"><path d="M12 68 A52 52 0 0 1 116 68" fill="none" stroke="var(--x-card3)" stroke-width="11" stroke-linecap="round"/><path d="M12 68 A52 52 0 0 1 116 68" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - p)}" style="transition:stroke-dashoffset .9s var(--x-ease),stroke .4s"/></svg><div class="v"><b>${Math.round(score)}</b><small>skor</small></div>`;
  }
  function renderHero() {
    const h = heroState(), c = COLORS();
    const color = { happy: c.green, ok: c.green, worried: c.orange, panic: c.red, dizzy: c.gray, sleepy: c.blue }[h.mood];
    $('nxHero').dataset.state = h.mood;
    $('nxGauge').innerHTML = gauge(h.score, color);
    $('nxHeroTitle').textContent = h.title;
    $('nxHeroText').textContent = h.text;
    const w = widgetData;
    const chips = [
      `<span class="nx-pill ${h.up === h.total ? 'green' : 'red'}"><i class="bi bi-router"></i>${h.up}/${h.total} router</span>`,
      `<span class="nx-pill blue"><i class="bi bi-people"></i>${data.customers?.online ?? 0} online</span>`,
      h.openAlerts ? `<span class="nx-pill orange"><i class="bi bi-bell"></i>${h.openAlerts} alert</span>` : '',
      w?.leak?.overdue?.online ? `<span class="nx-pill red"><i class="bi bi-cash-coin"></i>${w.leak.overdue.online} nunggak masih online</span>` : ''
    ];
    $('nxHeroChips').innerHTML = chips.join('');
    mascot?.setMood(h.mood, `${h.title}. ${h.text}`);
  }

  // ---------- Widget tambahan (/nms/api/widgets) ----------
  let widgetData = null;
  const errBox = e => `<div class="nx-empty"><i class="bi bi-exclamation-circle"></i>${esc(e)}</div>`;
  function renderActivity() {
    const el = $('nxActivity'), rows = widgetData?.activity;
    if (!rows) return;
    if (rows.error) { el.innerHTML = errBox(rows.error); return; }
    const c = COLORS();
    $('nxActivityLegend').innerHTML = `<span><i style="background:${c.green}"></i>Login <b>${rows.reduce((a, r) => a + r.login, 0)}</b></span><span><i style="background:${c.gray}"></i>Putus <b>${rows.reduce((a, r) => a + r.logout, 0)}</b></span><span><i style="background:${c.red}"></i>Ditolak <b>${rows.reduce((a, r) => a + r.failed, 0)}</b></span>`;
    const max = Math.max(1, ...rows.map(r => Math.max(r.login, r.logout + r.failed)));
    const hh = iso => new Date(iso).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false });
    el.innerHTML = `<div class="nx-bars-plot">${rows.map((r, i) => `<div class="nx-bar-col" title="${esc(hh(r.at))}.00 · login ${r.login} · putus ${r.logout} · ditolak ${r.failed}" style="--d:${i * 18}ms"><div class="nx-bar-pair"><i class="b-in" style="height:${(r.login / max * 100).toFixed(1)}%"></i><i class="b-out" style="height:${(r.logout / max * 100).toFixed(1)}%"><em style="height:${r.logout + r.failed ? (r.failed / (r.logout + r.failed) * 100).toFixed(1) : 0}%"></em></i></div><small>${i % 3 === 0 || i === rows.length - 1 ? esc(hh(r.at)) : ''}</small></div>`).join('')}</div>`;
  }
  function renderLeak() {
    const el = $('nxLeak'), l = widgetData?.leak;
    if (!l) return;
    if (l.error) { el.innerHTML = errBox(l.error); return; }
    const o = l.overdue || {}, u = l.unlinked || {};
    el.innerHTML = `<div class="nx-leak-amount"><small>Tunggakan pelanggan yang layanannya masih jalan</small><b>${N.rupiah(o.amount)}</b><span>${o.count || 0} pelanggan · ${o.online || 0} sedang online${o.held ? ` · ${o.held} ditunda` : ''}</span></div>
      <ul class="nx-list nx-list-flush">
        <li class="clickable" data-go="overdue_active"><span class="li-icon red"><i class="bi bi-cash-coin"></i></span><div class="li-main"><b>Lewat jatuh tempo, masih aktif</b><small>${o.error ? esc(o.error) : 'Isolir atau tunda dari daftar'}</small></div><b class="num">${o.count || 0}</b><i class="bi bi-chevron-right dim"></i></li>
        <li class="clickable" data-go="secret_no_customer"><span class="li-icon purple"><i class="bi bi-question-circle"></i></span><div class="li-main"><b>Secret tanpa pelanggan</b><small>${u.error ? esc(u.error) : `${u.online || 0} sedang online, tidak tertagih`}</small></div><b class="num">${u.count || 0}</b><i class="bi bi-chevron-right dim"></i></li>
      </ul>`;
  }
  $('nxLeak').addEventListener('click', e => { const li = e.target.closest('[data-go]'); if (li) location.assign(`/nms/insights${N.qs({ site: N.site || undefined, kind: li.dataset.go })}`); });
  function renderOutages() {
    const el = $('nxOutages'), o = widgetData?.outages;
    if (!o) return;
    if (o.error) { el.innerHTML = `<li><div class="li-main"><small>${esc(o.error)}</small></div></li>`; return; }
    const rows = [...(o.suspect || []).map(c => ({ ...c, bad: true })), ...(o.watch || [])];
    el.innerHTML = rows.length ? rows.map(c => `<li class="clickable" data-cl="${c.id}"><span class="li-icon ${c.bad ? 'red' : 'orange'}"><i class="bi bi-diagram-3"></i></span><div class="li-main"><b>${esc(c.name)}</b><small>${esc(c.site_code)} · ${Number(c.offline) || 0} dari ${c.customers} offline${c.last_drop ? ` · putus ${esc(N.ago(c.last_drop))}` : ''}</small></div><b class="num" style="color:var(--x-${c.bad ? 'red' : 'orange'})">${c.offlinePct}%</b></li>`).join('')
      : '<li><span class="li-icon green"><i class="bi bi-check-lg"></i></span><div class="li-main"><b>Tidak ada ODP bermasalah</b><small>Offline tersebar normal di semua cluster.</small></div></li>';
  }
  $('nxOutages').addEventListener('click', e => { if (e.target.closest('[data-cl]')) location.assign(`/nms/insights${N.withSite()}`); });
  const ACT = { isolate: 'Isolir', unisolate: 'Buka isolir', kick: 'Kick sesi', profile: 'Ganti profile', package: 'Ganti paket' };
  function renderAgenda() {
    const el = $('nxAgenda'), a = widgetData?.agenda;
    if (!a) return;
    if (a.error) { el.innerHTML = `<li><div class="li-main"><small>${esc(a.error)}</small></div></li>`; return; }
    const items = [
      ...(a.approvals || []).map(x => `<li class="clickable" data-go="1"><span class="li-icon orange"><i class="bi bi-person-check"></i></span><div class="li-main"><b>${esc(x.summary)}</b><small>Menunggu persetujuan · diminta ${esc(x.requested_by_name || 'sistem')} · ${esc(N.ago(x.created_at))}</small></div><span class="nx-pill orange">Persetujuan</span></li>`),
      ...(a.schedules || []).map(x => `<li class="clickable" data-go="1"><span class="li-icon blue"><i class="bi bi-calendar-event"></i></span><div class="li-main"><b>${esc(ACT[x.action] || x.action)}${x.package_name ? ` → ${esc(x.package_name)}` : x.profile ? ` → ${esc(x.profile)}` : ''} · ${x.count} secret</b><small>${esc(N.dateTime(x.run_at))} · ${esc((x.targets || []).slice(0, 3).join(', '))}${x.note ? ` · ${esc(x.note)}` : ''}</small></div><span class="nx-pill blue">${esc(countdown(x.run_at))}</span></li>`)
    ];
    el.innerHTML = items.length ? items.join('') : '<li><span class="li-icon gray"><i class="bi bi-calendar"></i></span><div class="li-main"><b>Tidak ada agenda</b><small>Jadwal isolir, ganti paket, dan persetujuan muncul di sini.</small></div></li>';
  }
  const countdown = iso => { const m = Math.round((new Date(iso) - Date.now()) / 60000); if (m <= 0) return 'sekarang'; if (m < 60) return `${m} mnt lagi`; if (m < 1440) return `${Math.round(m / 60)} jam lagi`; return `${Math.round(m / 1440)} hari lagi`; };
  $('nxAgenda').addEventListener('click', e => { if (e.target.closest('[data-go]')) location.assign(`/nms/automation${N.withSite()}`); });
  function renderTotal() {
    const list = sorted().filter(r => r.status === 'online');
    const rx = list.reduce((a, r) => a + (Number(r.wan?.rxBps) || 0), 0), tx = list.reduce((a, r) => a + (Number(r.wan?.txBps) || 0), 0);
    const [rv, ru] = splitBps(rx), [tv, tu] = splitBps(tx), c = COLORS();
    $('nxTrafficTotal').innerHTML = list.length ? `<div><small><i style="background:${c.blue}"></i>Total download</small><strong>${rv}<span>${ru}</span></strong></div><div><small><i style="background:${c.green}"></i>Total upload</small><strong>${tv}<span>${tu}</span></strong></div>` : '';
  }
  async function loadWidgets() {
    try { widgetData = (await api(`/nms/api/widgets${N.withSite()}`)).data; }
    catch (err) { widgetData = { activity: { error: err.message }, leak: { error: err.message }, outages: { error: err.message }, agenda: { error: err.message } }; }
    renderActivity(); renderLeak(); renderOutages(); renderAgenda(); renderHero();
  }

  // ---------- Atur dashboard: tampil/sembunyi & urutan widget (per browser) ----------
  const LKEY = 'nx-dash-layout-v1';
  const widgetEls = () => [...document.querySelectorAll('#nxWidgets > .nx-w')];
  const defaultOrder = widgetEls().map(w => w.dataset.w);
  let layout = { order: defaultOrder, hidden: [], mascot: true, rotate: 20 };
  try { layout = { ...layout, ...JSON.parse(localStorage.getItem(LKEY) || '{}') }; } catch (_) {}
  layout.order = [...layout.order.filter(k => defaultOrder.includes(k)), ...defaultOrder.filter(k => !layout.order.includes(k))];
  const saveLayout = () => { try { localStorage.setItem(LKEY, JSON.stringify(layout)); } catch (_) {} };
  function applyLayout() {
    widgetEls().forEach(w => { w.style.order = layout.order.indexOf(w.dataset.w); w.hidden = layout.hidden.includes(w.dataset.w); });
    $('nxMascot').hidden = !layout.mascot; $('nxHero').classList.toggle('no-mascot', !layout.mascot);
    setTimeout(renderTraffic, 30);
  }
  function openCustomize() {
    const title = k => document.querySelector(`#nxWidgets [data-w="${k}"]`)?.dataset.title || k;
    const s = N.sheet({ title: 'Atur dashboard', subtitle: 'Pilih widget yang tampil dan urutannya. Tersimpan di browser ini.', size: 'sm',
      body: `<ul class="nx-list nx-group nx-sortlist" data-list></ul>
        <div class="nx-group-title">Lainnya</div>
        <ul class="nx-list nx-group"><li><div class="li-main"><b>Maskot Nexi</b><small>Karakter di kartu status, ekspresinya mengikuti kesehatan jaringan.</small></div><label class="nx-switch"><input type="checkbox" data-mascot ${layout.mascot ? 'checked' : ''}><span></span></label></li>
        <li><div class="li-main"><b>Ganti panel layar penuh</b><small>Detik per panel di mode layar penuh.</small></div><select data-rotate style="width:auto">${[0, 15, 20, 30, 60].map(v => `<option value="${v}" ${Number(layout.rotate) === v ? 'selected' : ''}>${v ? `${v} detik` : 'Tidak berganti'}</option>`).join('')}</select></li></ul>`,
      foot: '<button type="button" class="nx-btn ghost" data-reset>Kembalikan default</button><span class="grow"></span><button type="button" class="nx-btn primary" data-close>Selesai</button>' });
    const paint = () => {
      s.$('[data-list]').innerHTML = layout.order.map((k, i) => `<li data-k="${k}"><label class="nx-check grow"><input type="checkbox" data-vis ${layout.hidden.includes(k) ? '' : 'checked'}><span>${esc(title(k))}</span></label><button type="button" class="nx-btn sm icon ghost" data-up ${i === 0 ? 'disabled' : ''} aria-label="Naik"><i class="bi bi-chevron-up"></i></button><button type="button" class="nx-btn sm icon ghost" data-down ${i === layout.order.length - 1 ? 'disabled' : ''} aria-label="Turun"><i class="bi bi-chevron-down"></i></button></li>`).join('');
    };
    paint();
    s.$('[data-list]').addEventListener('click', e => {
      const li = e.target.closest('[data-k]'); if (!li) return; const k = li.dataset.k, i = layout.order.indexOf(k);
      const mv = e.target.closest('[data-up]') ? -1 : e.target.closest('[data-down]') ? 1 : 0; if (!mv) return;
      layout.order.splice(i, 1); layout.order.splice(i + mv, 0, k); saveLayout(); applyLayout(); paint();
    });
    s.$('[data-list]').addEventListener('change', e => { const li = e.target.closest('[data-k]'); if (!li) return; const k = li.dataset.k; layout.hidden = e.target.checked ? layout.hidden.filter(x => x !== k) : [...layout.hidden, k]; saveLayout(); applyLayout(); });
    s.$('[data-mascot]').addEventListener('change', e => { layout.mascot = e.target.checked; saveLayout(); applyLayout(); });
    s.$('[data-rotate]').addEventListener('change', e => { layout.rotate = Number(e.target.value); saveLayout(); });
    s.$('[data-reset]').addEventListener('click', () => { layout = { order: [...defaultOrder], hidden: [], mascot: true, rotate: 20 }; saveLayout(); applyLayout(); s.close(); toast('Tata letak dikembalikan.', 'ok'); });
  }
  $('nxCustomize')?.addEventListener('click', openCustomize);

  // ---------- Layar penuh (mode TV NOC): panel berganti otomatis, jam besar, layar tetap menyala ----------
  const TV_GROUPS = [['overview', 'Ringkasan'], ['traffic', 'Traffic'], ['routers', 'Router'], ['problems', 'Masalah']];
  const tv = { on: false, idx: 0, timer: null, paused: false, lock: null, cursorT: null, clockT: null };
  const tvGroups = () => TV_GROUPS.filter(([g]) => widgetEls().some(w => w.dataset.tv === g && !layout.hidden.includes(w.dataset.w)));
  function tvShow(i) {
    const groups = tvGroups(); if (!groups.length) return;
    tv.idx = (i + groups.length) % groups.length;
    const g = groups[tv.idx][0];
    widgetEls().forEach(w => w.classList.toggle('tv-off', w.dataset.tv !== g));
    $('nxTvDots').innerHTML = groups.map(([k, l], j) => `<button type="button" class="${j === tv.idx ? 'on' : ''}" data-tv-go="${j}">${esc(l)}</button>`).join('');
    const wrap = $('nxWidgets'); wrap.classList.remove('tv-enter'); void wrap.offsetWidth; wrap.classList.add('tv-enter');
    setTimeout(renderTraffic, 40);
  }
  function tvSchedule() { clearInterval(tv.timer); tv.timer = null; if (tv.on && !tv.paused && Number(layout.rotate) > 0) tv.timer = setInterval(() => tvShow(tv.idx + 1), Number(layout.rotate) * 1000); }
  async function wake(on) { try { if (on && 'wakeLock' in navigator) tv.lock = await navigator.wakeLock.request('screen'); else { await tv.lock?.release(); tv.lock = null; } } catch (_) {} }
  const tvClock = () => { $('nxTvClock').textContent = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }); };
  const cursorIdle = () => { app.classList.remove('tv-cursor-off'); clearTimeout(tv.cursorT); tv.cursorT = setTimeout(() => { if (tv.on) app.classList.add('tv-cursor-off'); }, 3000); };
  function setTv(on) {
    tv.on = on; app.classList.toggle('noc-tv', on); $('nxTvBar').hidden = !on;
    const btn = $('nmsNocMode'); if (btn) btn.innerHTML = on ? '<i class="bi bi-fullscreen-exit"></i><span class="nx-hide-sm">Keluar</span>' : '<i class="bi bi-arrows-fullscreen"></i><span class="nx-hide-sm">Layar penuh</span>';
    if (on) { tvShow(0); tvSchedule(); wake(true); tvClock(); tv.clockT = setInterval(tvClock, 10000); cursorIdle(); }
    else { widgetEls().forEach(w => w.classList.remove('tv-off')); clearInterval(tv.timer); clearInterval(tv.clockT); wake(false); app.classList.remove('tv-cursor-off'); setTimeout(renderTraffic, 60); }
  }
  async function toggleTv(on) {
    setTv(on);
    try { if (on && !document.fullscreenElement) await app.requestFullscreen?.(); else if (!on && document.fullscreenElement) await document.exitFullscreen?.(); } catch (_) {}
  }
  $('nmsNocMode')?.addEventListener('click', () => toggleTv(!tv.on));
  $('nxTvExit').addEventListener('click', () => toggleTv(false));
  $('nxTvPause').addEventListener('click', e => { tv.paused = !tv.paused; e.currentTarget.innerHTML = tv.paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>'; tvSchedule(); });
  $('nxTvDots').addEventListener('click', e => { const b = e.target.closest('[data-tv-go]'); if (b) { tvShow(Number(b.dataset.tvGo)); tvSchedule(); } });
  app.addEventListener('mousemove', () => { if (tv.on) cursorIdle(); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && tv.on) setTv(false); });
  document.addEventListener('visibilitychange', () => { if (tv.on && !document.hidden) wake(true); });
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (typing || e.ctrlKey || e.metaKey || e.altKey || N.drawerOpen()) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleTv(!tv.on); }
    if (!tv.on) return;
    if (e.key === 'Escape' && !document.fullscreenElement) setTv(false);
    if (e.key === 'ArrowRight') { tvShow(tv.idx + 1); tvSchedule(); }
    if (e.key === 'ArrowLeft') { tvShow(tv.idx - 1); tvSchedule(); }
    if (e.key === ' ') { e.preventDefault(); $('nxTvPause').click(); }
  });

  applyLayout();
  renderHero(); renderTotal();
  loadWidgets();
  setInterval(() => { if (!document.hidden) loadWidgets(); }, 60000);
  document.addEventListener('nx:changed', () => setTimeout(loadWidgets, 800));
})();
