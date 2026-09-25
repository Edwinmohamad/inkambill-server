// NOC Dashboard controller: render widget dari boot JSON, lalu update real-time via SSE.
(() => {
  const N = window.NMS;
  const app = document.getElementById('nmsDashboard');
  if (!N || !app) return;
  const { esc, fmtBps, fmtBytes, fmtUptime, hhmmss, tone, api, toast } = N;
  let data = JSON.parse(document.getElementById('nmsBoot').textContent || '{}');
  const routers = new Map((data.routers || []).map(r => [r.routerId, r]));
  let events = (data.events || []).slice().reverse(); // oldest → newest
  let alerts = data.alerts || [];
  let logFilter = 'all', paused = false;
  let bwChart = null, syncChart = null;
  const bwSelect = document.getElementById('nmsBwRouter');
  let bwRouterId = null;
  try { bwRouterId = Number(localStorage.getItem('nms-bw-router')) || null; } catch (_) {}

  // ---------- Router health cards ----------
  function gauge(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const color = { green: '#10B981', yellow: '#F59E0B', red: '#EF4444', gray: '#6B7280' }[tone(pct)];
    const len = Math.PI * 38, off = len * (1 - p / 100);
    return `<div class="nms-gauge"><svg viewBox="0 0 92 56" aria-hidden="true"><path d="M8 50 A38 38 0 0 1 84 50" fill="none" stroke="#0B0F19" stroke-width="9" stroke-linecap="round"/><path d="M8 50 A38 38 0 0 1 84 50" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${off}"/></svg><span class="val" style="color:${color}">${pct == null ? '—' : Math.round(p) + '%'}</span><span class="lbl">CPU</span></div>`;
  }
  const meter = (label, pct, text, cls) => `<div class="nms-meter-row"><span>${label}</span><div class="nms-meter"><i class="${cls || tone(pct)}" style="width:${Math.max(0, Math.min(100, Number(pct) || 0))}%"></i></div><span class="num">${text}</span></div>`;
  function routerCard(r) {
    const t = r.telemetry || {};
    const mem = t.memory || {}, disk = t.disk || {}, h = t.health || {};
    const stale = r.status !== 'online';
    const tempTone = h.temperature == null ? 'gray' : h.temperature >= 70 ? 'red' : h.temperature >= 55 ? 'yellow' : 'green';
    const voltTone = h.voltage == null ? 'gray' : (h.voltage < 10 || h.voltage > 30) ? 'yellow' : 'green';
    return `<div class="nms-router ${stale ? 'offline stale' : ''}" data-router="${r.routerId}">
      <div class="nms-router-top"><span class="nms-status-dot ${esc(r.status)}"></span><div><b>${esc(r.name)}</b><small> · ${esc(r.siteCode)} ${t.board ? '· ' + esc(t.board) : ''} ${t.version ? 'v' + esc(t.version) : ''}</small></div></div>
      <div class="nms-router-body">${gauge(stale ? null : t.cpuPct)}<div class="nms-meters">
        ${meter('RAM', mem.pct, mem.total ? `${fmtBytes(mem.used)}/${fmtBytes(mem.total)} · ${mem.pct}%` : '—')}
        ${meter('DISK', disk.freePct == null ? 0 : 100 - disk.freePct, disk.freePct == null ? '—' : `${disk.freePct}% free`)}
        <div class="nms-meter-row"><span>UP</span><span class="num" style="grid-column:span 2">${t.uptimeSeconds ? fmtUptime(t.uptimeSeconds) : '—'}</span></div>
      </div></div>
      <div class="nms-router-foot">
        <span class="nms-pill ${stale ? 'red' : 'green'}">${stale ? 'UNREACHABLE' : 'ONLINE'}</span>
        ${h.temperature != null ? `<span class="nms-pill ${tempTone}"><i class="bi bi-thermometer-half"></i>${h.temperature}°C</span>` : ''}
        ${h.voltage != null ? `<span class="nms-pill ${voltTone}"><i class="bi bi-lightning-charge"></i>${h.voltage}V</span>` : ''}
        ${r.activeSessions != null ? `<span class="nms-pill blue">${r.activeSessions} sesi</span>` : ''}
        ${stale ? `<span class="nms-pill gray" title="${esc(r.lastError || '')}">cache · ${r.lastOkAt ? N.ago(r.lastOkAt) : "belum pernah online"}</span>` : ''}
      </div></div>`;
  }
  function renderRouters() {
    const list = [...routers.values()].sort((a, b) => String(a.siteCode).localeCompare(String(b.siteCode)) || String(a.name).localeCompare(String(b.name)));
    const el = document.getElementById('nmsRouters');
    el.innerHTML = list.length ? list.map(routerCard).join('') : '<div class="nms-empty">Belum ada router aktif. Tambahkan di menu Router MikroTik.</div>';
    const up = list.filter(r => r.status === 'online').length;
    document.getElementById('kpiRouters').textContent = `${up}/${list.length}`;
    N.setOffline(list.length && up < list.length);
    const opts = list.map(r => `<option value="${r.routerId}">${esc(r.siteCode)} · ${esc(r.name)}</option>`).join('');
    if (bwSelect.dataset.opts !== opts) { bwSelect.innerHTML = opts; bwSelect.dataset.opts = opts; }
    if (!routers.has(bwRouterId)) bwRouterId = list[0]?.routerId || null;
    if (bwRouterId) bwSelect.value = String(bwRouterId);
  }

  // ---------- Bandwidth ----------
  function renderBandwidth() {
    const r = routers.get(bwRouterId);
    const w = r?.wan || { history: [] };
    document.getElementById('bwRx').textContent = fmtBps(w.rxBps);
    document.getElementById('bwTx').textContent = fmtBps(w.txBps);
    document.getElementById('bwPeakRx').textContent = fmtBps(w.peakRxBps);
    document.getElementById('bwPeakTx').textContent = fmtBps(w.peakTxBps);
    document.getElementById('bwIface').textContent = w.interface || 'auto';
    if (!window.Chart) return;
    const labels = (w.history || []).map(p => hhmmss(p.t));
    const rx = (w.history || []).map(p => +(p.rx / 1e6).toFixed(2));
    const tx = (w.history || []).map(p => +(p.tx / 1e6).toFixed(2));
    if (!bwChart) {
      bwChart = new Chart(document.getElementById('nmsBwChart'), {
        type: 'line',
        data: { labels, datasets: [
          { label: 'RX Mbps', data: rx, borderColor: '#10B981', backgroundColor: 'rgba(16,185,129,.12)', fill: true, tension: .3, pointRadius: 0, borderWidth: 1.6 },
          { label: 'TX Mbps', data: tx, borderColor: '#3B82F6', backgroundColor: 'rgba(59,130,246,.08)', fill: true, tension: .3, pointRadius: 0, borderWidth: 1.6 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: '#9CA3AF', boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y} Mbps` } } },
          scales: { x: { ticks: { color: '#6B7280', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(55,67,87,.35)' } }, y: { beginAtZero: true, ticks: { color: '#6B7280', font: { size: 10 } }, grid: { color: 'rgba(55,67,87,.35)' } } } }
      });
    } else {
      bwChart.data.labels = labels; bwChart.data.datasets[0].data = rx; bwChart.data.datasets[1].data = tx; bwChart.update('none');
    }
  }
  bwSelect.addEventListener('change', () => { bwRouterId = Number(bwSelect.value); try { localStorage.setItem('nms-bw-router', bwRouterId); } catch (_) {} renderBandwidth(); });

  document.getElementById('nmsWanEdit')?.addEventListener('click', async () => {
    if (!bwRouterId) return;
    try {
      const { rows } = await api(`/nms/api/routers/${bwRouterId}/interfaces`);
      const current = routers.get(bwRouterId)?.wan?.interface || '';
      const ok = await N.confirmBox({ title: 'Interface WAN / Uplink', okText: 'Simpan', message: `<div class="nms-field"><label>Interface</label><select id="nmsWanPick"><option value="">Auto-detect</option>${rows.map(i => `<option value="${esc(i.name)}" ${i.name === current ? 'selected' : ''}>${esc(i.name)} · ${esc(i.type)}${i.comment ? ' · ' + esc(i.comment) : ''}${i.running ? '' : ' (down)'}</option>`).join('')}</select></div>` });
      if (!ok) return;
      const val = document.getElementById('nmsWanPick').value;
      await api(`/nms/api/routers/${bwRouterId}/wan-interface`, { method: 'POST', body: { interface: val } });
      toast('Interface WAN disimpan. Grafik mulai ulang pada polling berikutnya.', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- Sync donut & KPI ----------
  function renderSync() {
    const s = data.sync || {};
    document.getElementById('syncPct').textContent = `${s.syncedPct ?? 0}%`;
    document.getElementById('syncSynced').textContent = s.synced ?? 0;
    document.getElementById('syncUnsynced').textContent = s.unsynced ?? 0;
    document.getElementById('syncExempt').textContent = s.exempt ?? 0;
    const c = data.customers || {};
    document.getElementById('kpiOnline').textContent = c.online ?? 0;
    document.getElementById('kpiOffline').textContent = c.offline ?? 0;
    document.getElementById('kpiIsolated').textContent = c.isolated ?? 0;
    document.getElementById('kpiUnsynced').textContent = s.unsynced ?? 0;
    if (!window.Chart) return;
    const values = [s.synced || 0, s.unsynced || 0, s.exempt || 0];
    if (!syncChart) {
      syncChart = new Chart(document.getElementById('nmsSyncChart'), { type: 'doughnut', data: { labels: ['Synced', 'Unsynced', 'Exempt'], datasets: [{ data: values, backgroundColor: ['#10B981', '#EF4444', '#374357'], borderColor: '#1F2937', borderWidth: 2 }] }, options: { cutout: '72%', responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } } });
    } else { syncChart.data.datasets[0].data = values; syncChart.update('none'); }
  }

  // ---------- Alerts ----------
  function renderAlerts() {
    const box = document.getElementById('nmsAlerts');
    box.innerHTML = alerts.map(a => `<div class="nms-alert ${a.severity === 'critical' && !a.acknowledged_by ? 'critical' : 'warning'}" data-alert="${a.id}"><i class="bi bi-exclamation-triangle-fill"></i><span class="grow">${esc(a.title)}${a.details?.stillOffline != null ? ` <small>· masih offline: ${a.details.stillOffline}</small>` : ''} <small>· sejak ${esc(hhmmss(a.opened_at))}</small></span>${N.canControl && !a.acknowledged_by ? `<button type="button" data-ack="${a.id}">ACK</button>` : ''}</div>`).join('');
  }
  document.getElementById('nmsAlerts').addEventListener('click', async e => {
    const id = e.target.closest('[data-ack]')?.dataset.ack; if (!id) return;
    try { await api(`/nms/api/alerts/${id}/ack`, { method: 'POST', body: {} }); alerts = alerts.map(a => String(a.id) === id ? { ...a, acknowledged_by: 1 } : a); renderAlerts(); }
    catch (err) { toast(err.message, 'err'); }
  });

  // ---------- Live log ----------
  const labels = { login: 'LOGIN', logout: 'DISCONNECT', auth_failed: 'AUTH FAIL', kick: 'KICK', isolate: 'ISOLIR', unisolate: 'UNISOLIR', lock_mac: 'LOCK MAC' };
  const matchesFilter = e => logFilter === 'all' || (logFilter === 'action' ? ['kick', 'isolate', 'unisolate', 'lock_mac'].includes(e.type) : e.type === logFilter);
  const line = (e, fresh) => `<div class="ln ${fresh ? 'fresh' : ''}"><span class="t">${esc(hhmmss(e.at))}</span><span class="${esc(e.type)}">${labels[e.type] || esc(e.type)}</span><span title="${esc(e.username || '')}">${esc(e.username || '-')}</span><span class="dim">${esc(e.site_code || e.siteCode || siteCodeOf(e.siteId ?? e.site_id))} ${esc(e.address || '')} ${esc(e.message && !/^PPP (Login|Disconnect)/.test(e.message) ? e.message : '')}</span></div>`;
  const siteCodeOf = id => [...routers.values()].find(r => Number(r.siteId) === Number(id))?.siteCode || '';
  const consoleEl = document.getElementById('nmsConsole');
  function renderLog() { consoleEl.innerHTML = events.filter(matchesFilter).slice(-300).map(e => line(e)).join('') || '<div class="dim">Menunggu event PPP…</div>'; if (!paused) consoleEl.scrollTop = consoleEl.scrollHeight; }
  function pushEvent(e) {
    events.push(e); if (events.length > 500) events.splice(0, events.length - 500);
    if (!matchesFilter(e)) return;
    if (consoleEl.firstElementChild?.classList.contains('dim')) consoleEl.innerHTML = '';
    consoleEl.insertAdjacentHTML('beforeend', line(e, true));
    while (consoleEl.childElementCount > 300) consoleEl.firstElementChild.remove();
    if (!paused) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  document.getElementById('nmsLogFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    logFilter = b.dataset.f; document.querySelectorAll('#nmsLogFilter button').forEach(x => x.classList.toggle('on', x === b)); renderLog();
  });
  document.getElementById('nmsLogPause').addEventListener('click', e => { paused = !paused; e.currentTarget.innerHTML = paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>'; });

  // ---------- Flapping ----------
  function renderFlapping() {
    const rows = data.flapping || [];
    document.getElementById('nmsFlapping').innerHTML = rows.length ? rows.map(f => `<tr><td>${esc(f.customer_name || f.username)}<span class="sub mono">${esc(f.username)}</span></td><td>${esc(f.site_code)}</td><td><span class="nms-pill ${f.reconnects > 10 ? 'red' : 'yellow'}">${f.reconnects}×</span></td></tr>`).join('') : '<tr><td colspan="3" class="nms-empty">Tidak ada pelanggan flapping.</td></tr>';
  }

  function renderAll() { renderRouters(); renderBandwidth(); renderSync(); renderAlerts(); renderLog(); renderFlapping(); N.markUpdated(data.generatedAt); }
  async function refresh() {
    const res = await api(`/nms/api/dashboard${N.site ? `?site=${N.site}` : ''}`);
    data = res.data;
    (data.routers || []).forEach(r => routers.set(r.routerId, r));
    alerts = data.alerts || [];
    const lastId = Math.max(0, ...events.filter(e => e.id).map(e => e.id));
    (data.events || []).slice().reverse().filter(e => e.id > lastId).forEach(pushEvent);
    renderRouters(); renderBandwidth(); renderSync(); renderAlerts(); renderFlapping(); N.markUpdated(data.generatedAt);
  }

  // Chart.js dimuat defer — render awal setelah semua script siap.
  const boot = () => { renderAll(); };
  if (window.Chart) boot(); else window.addEventListener('load', boot, { once: true });

  let bwFrame = null;
  N.stream({
    telemetry: r => { routers.set(r.routerId, r); if (!bwFrame) bwFrame = requestAnimationFrame(() => { bwFrame = null; renderRouters(); renderBandwidth(); }); N.markUpdated(new Date().toISOString()); },
    router_state: s => { const r = routers.get(s.routerId); if (r) { r.status = s.status; r.lastError = s.error; renderRouters(); } if (s.status === 'offline') toast(`Router ${r?.name || s.routerId} UNREACHABLE`, 'err'); },
    ppp: e => pushEvent(e),
    alert: a => { alerts = [{ ...a, opened_at: a.openedAt }, ...alerts.filter(x => x.id !== a.id)]; renderAlerts(); toast(a.title, 'err'); },
    alert_resolved: () => refresh().catch(() => {}),
    sync: () => refresh().catch(() => {})
  }, { fallback: refresh, fallbackMs: 20000 });
  // Counter pelanggan & flapping berasal dari DB → segarkan ringan tiap 30 detik.
  setInterval(() => { if (!document.hidden) refresh().catch(() => N.setLive('down')); }, 30000);
})();
