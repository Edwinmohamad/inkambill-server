(() => {
  const app = document.getElementById('nocApp');
  if (!app) return;
  const canSupport = app.dataset.canSupport === '1';
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v) => Number(v || 0);
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : null;

  let lastLoadAt = Date.now();
  let failCount = 0;
  let currentSite = '';
  let lastAlarms = [];
  let lastSitesCache = [];
  let knownAlarmKeys = null; // null = not initialized yet (avoid notifying on first load)

  function setKpi(id, tone, strongText, emText) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `noc-kpi ${tone}`;
    el.querySelector('strong').textContent = strongText;
    el.querySelector('em').textContent = emText;
  }

  function renderKpis(d) {
    setKpi('kpi-ont', n(d.onts.offline) ? 'danger' : 'success', `${n(d.onts.online)}/${n(d.onts.total)}`, `${n(d.onts.offline)} offline`);
    setKpi('kpi-critical', n(d.onts.critical) ? 'danger' : 'warning', `${n(d.onts.critical)}`, `${n(d.onts.warning)} warning`);
    setKpi('kpi-customers', n(d.customers.unreachable) ? 'danger' : 'success', `${n(d.customers.online)}/${n(d.customers.total)}`, `${n(d.customers.isolated)} isolir`);
    setKpi('kpi-router', n(d.routers.offline) ? 'danger' : 'success', `${n(d.routers.online)}/${n(d.routers.total)}`, `${n(d.routers.offline)} offline`);
    const oltUnreachable = n(d.olts.unreachable);
    setKpi('kpi-olt', (n(d.olts.onuOffline) + n(d.olts.onuCritical) + oltUnreachable) ? 'danger' : 'success', `${n(d.olts.onuOnline)}/${n(d.olts.onuTotal)}`, `${n(d.olts.total)} OLT${oltUnreachable ? ` · ${oltUnreachable} tidak terjangkau` : ''} · ${n(d.olts.onuCritical)} kritis`);
    setKpi('kpi-tickets', n(d.tickets.critical) ? 'danger' : 'warning', `${n(d.tickets.total)}`, `${n(d.tickets.critical)} critical`);
  }

  function renderSites(sites) {
    const body = document.getElementById('nocSiteTableBody');
    if (!body) return;
    body.innerHTML = sites.map((s) => {
      const bad = n(s.routers_offline) + n(s.ont_offline) + n(s.ont_critical);
      return `<tr class="noc-site-row ${currentSite === s.code ? 'active' : ''}" data-site="${esc(s.code)}" role="button" tabindex="0"><td><strong>${esc(s.code)}</strong><small>${esc(s.name)}</small></td><td>${n(s.customers)}</td><td>${n(s.routers)}</td><td>${n(s.ont_offline)}</td><td>${n(s.ont_critical)}</td><td><span class="status-badge ${bad ? 'red' : 'green'}">${bad ? 'PERLU CEK' : 'NORMAL'}</span></td></tr>`;
    }).join('');
    wireSiteRows();
  }

  function alarmRowHtml(a) {
    const href = a.kind === 'router' ? '/network/monitor' : `/acs?q=${encodeURIComponent(a.title)}`;
    const icon = a.kind === 'router' ? 'bi-router-fill' : 'bi-broadcast-pin';
    const ticketForm = canSupport
      ? `<form method="post" action="/tickets" class="noc-alarm-ticket-form"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="subject" value="[NOC] ${esc(a.title)}"><input type="hidden" name="type" value="Gangguan Jaringan"><input type="hidden" name="priority" value="${a.tone === 'danger' ? 'critical' : 'high'}"><input type="hidden" name="description" value="${esc(a.detail)} — dibuat manual dari Alarm Prioritas NOC."><button type="submit" class="btn-tech sm" title="Buat tiket dari alarm ini"><i class="bi bi-ticket-perforated"></i>Tiket</button></form>`
      : '';
    return `<div class="noc-alarm ${esc(a.tone)}" data-site="${esc(a.site_code || '')}"><a class="noc-alarm-link" href="${href}"><i class="bi ${icon}"></i><span><strong>${esc(a.title)}</strong><small>${esc(a.detail)}</small></span><time>${a.event_at ? esc(fmtTime(a.event_at)) : '-'}</time></a>${ticketForm}</div>`;
  }

  function renderAlarms() {
    const box = document.getElementById('nocAlarmList');
    const hint = document.getElementById('nocAlarmFilterHint');
    if (!box) return;
    const visible = currentSite ? lastAlarms.filter((a) => a.site_code === currentSite) : lastAlarms;
    if (hint) hint.textContent = currentSite ? `Difilter ke site ${currentSite}. Klik lagi barisnya untuk menampilkan semua.` : 'Router offline, ONT offline, dan redaman bermasalah.';
    if (!visible.length) {
      box.innerHTML = `<div class="empty-state"><i class="bi bi-shield-check"></i><strong>${currentSite ? 'Tidak ada alarm di site ini' : 'Semua jaringan normal'}</strong><small>${currentSite ? 'Coba pilih site lain atau tampilkan semua.' : 'Tidak ada alarm aktif.'}</small></div>`;
      return;
    }
    box.innerHTML = visible.map(alarmRowHtml).join('');
  }

  function wireSiteRows() {
    document.querySelectorAll('.noc-site-row[data-site]').forEach((row) => {
      row.addEventListener('click', () => {
        const code = row.dataset.site;
        currentSite = currentSite === code ? '' : code;
        renderSites(lastSitesCache);
        renderAlarms();
      });
    });
  }

  function renderLastSync(lastSync) {
    const el = document.getElementById('nocLastSync');
    if (!el) return;
    el.textContent = `ACS terakhir: ${lastSync?.finished_at ? fmtTime(lastSync.finished_at) : 'belum pernah sinkron'}`;
  }

  // ---------------- Browser notification on new critical alarms ----------------
  let notifyEnabled = false;
  function alarmKey(a) { return `${a.kind}:${a.title}`; }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; gain.gain.value = 0.08;
      osc.start(); osc.stop(ctx.currentTime + 0.18);
      setTimeout(() => ctx.close().catch(() => {}), 300);
    } catch (_) { /* audio not available, skip silently */ }
  }
  function checkNewCriticalAlarms(alarms) {
    const nowKeys = new Set(alarms.filter((a) => a.tone === 'danger').map(alarmKey));
    if (knownAlarmKeys === null) { knownAlarmKeys = nowKeys; return; } // first load, nothing to compare against yet
    const fresh = [...nowKeys].filter((k) => !knownAlarmKeys.has(k));
    knownAlarmKeys = nowKeys;
    if (!fresh.length || !notifyEnabled) return;
    beep();
    if (window.Notification && Notification.permission === 'granted') {
      const first = alarms.find((a) => fresh.includes(alarmKey(a)));
      const body = fresh.length > 1 ? `${fresh.length} alarm kritis baru terdeteksi.` : (first?.detail || '');
      try { new Notification(fresh.length > 1 ? `${fresh.length} Alarm Kritis Baru — NOC` : `Alarm Kritis: ${first?.title || ''}`, { body, tag: 'noc-alarm', renotify: true }); }
      catch (_) { /* Notification constructor can throw in some contexts (e.g. service-worker-only) */ }
    }
  }
  function updateNotifyButton() {
    const btn = document.getElementById('nocNotifyToggle');
    const label = document.getElementById('nocNotifyLabel');
    if (!btn) return;
    btn.classList.toggle('primary', notifyEnabled);
    if (label) label.textContent = notifyEnabled ? 'Notifikasi Aktif' : 'Notifikasi';
  }
  document.getElementById('nocNotifyToggle')?.addEventListener('click', async () => {
    if (notifyEnabled) { notifyEnabled = false; updateNotifyButton(); return; }
    if (!window.Notification) { notifyEnabled = true; updateNotifyButton(); return; } // browser lacks Notification API — beep-only fallback
    if (Notification.permission === 'granted') { notifyEnabled = true; updateNotifyButton(); return; }
    if (Notification.permission === 'denied') { alert('Izin notifikasi browser diblokir. Aktifkan lewat pengaturan situs di browser untuk memakai fitur ini.'); return; }
    const perm = await Notification.requestPermission().catch(() => 'denied');
    notifyEnabled = perm === 'granted';
    updateNotifyButton();
  });

  // ---------------- Wallboard / TV mode ----------------
  function setWallboard(on) {
    document.body.classList.toggle('wallboard-mode', on);
    const btn = document.getElementById('nocWallboardToggle');
    if (btn) btn.classList.toggle('primary', on);
    if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }
  document.getElementById('nocWallboardToggle')?.addEventListener('click', () => setWallboard(!document.body.classList.contains('wallboard-mode')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('wallboard-mode')) setWallboard(false); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('wallboard-mode'); });

  // ---------------- Polling ----------------
  async function refresh() {
    try {
      const res = await fetch('/noc/api/dashboard', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      renderKpis(d);
      lastSitesCache = d.sites;
      renderSites(d.sites);
      lastAlarms = d.alarms;
      checkNewCriticalAlarms(d.alarms);
      renderAlarms();
      renderLastSync(d.lastSync);
      lastLoadAt = Date.now();
      failCount = 0;
    } catch (err) {
      failCount += 1;
    }
  }

  function tickIndicator() {
    const el = document.getElementById('nocRefreshIndicator');
    if (!el) return;
    if (failCount > 0) { el.textContent = 'gagal memuat ulang'; el.classList.add('down'); return; }
    el.classList.remove('down');
    const secs = Math.max(0, Math.round((Date.now() - lastLoadAt) / 1000));
    el.textContent = secs < 2 ? 'live' : `diperbarui ${secs}d lalu`;
  }

  wireSiteRows(); // wire up the server-rendered rows immediately, before the first poll completes
  setInterval(tickIndicator, 1000);
  setInterval(refresh, 20000);
  refresh(); // populate lastAlarms/lastSitesCache right away so a site click filters correctly even before 20s pass
  tickIndicator();
})();
