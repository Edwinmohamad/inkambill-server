// NOC Wall -- versi ringkas: status, 6 angka utama, tabel router, "Perlu perhatian", traffic WAN.
// Data awal dari #nwBoot, lalu live: SSE /nms/api/stream (telemetry, alert, router_state) + polling
// /nms/api/dashboard (15 dtk) dan /nms/api/health (60 dtk). Murni monitoring, tidak ada aksi.
(() => {
  'use strict';
  const root = document.getElementById('nw');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const site = root.dataset.site || '';
  const qs = site ? `?site=${encodeURIComponent(site)}` : '';
  let boot = {};
  try { boot = JSON.parse($('nwBoot').textContent || '{}'); } catch (_) { boot = {}; }

  const S = { data: boot.data || {}, health: boot.health || {}, routers: new Map(), sound: false, seen: new Set(), first: true };
  (S.data.routers || []).forEach((r) => S.routers.set(Number(r.routerId), r));
  try { S.sound = localStorage.getItem('nw-sound') === '1'; } catch (_) { /* ignore */ }

  // ---------- format ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v || 0).toLocaleString('id-ID');
  const bps = (v) => {
    const n = Number(v || 0);
    if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} Gbps`;
    if (n >= 1e6) return `${Math.round(n / 1e6)} Mbps`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} Kbps`;
    return `${Math.round(n)} bps`;
  };
  const bpsShort = (v) => bps(v).replace(' Gbps', 'G').replace(' Mbps', 'M').replace(' Kbps', 'K').replace(' bps', '');
  const uptime = (s) => {
    s = Number(s || 0); if (!s) return '-';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}h ${h}j` : h ? `${h}j ${m}m` : `${m}m`;
  };
  const ago = (t) => {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 90) return 'baru saja';
    if (s < 3600) return `${Math.round(s / 60)} mnt`;
    if (s < 86400) return `${Math.round(s / 3600)} jam`;
    return `${Math.round(s / 86400)} hari`;
  };
  const tz = { timeZone: 'Asia/Jakarta', hour12: false };
  const hhmm = (t) => new Intl.DateTimeFormat('id-ID', { ...tz, hour: '2-digit', minute: '2-digit' }).format(new Date(t)).replace('.', ':');
  const lvl = (p, warn, bad) => (p >= bad ? 'bad' : p >= warn ? 'warn' : '');
  const routersArr = () => [...S.routers.values()].filter((r) => !site || Number(r.siteId) === Number(site));

  // ---------- "Perlu perhatian": semua sumber masalah jadi satu, urut paling parah ----------
  function problems() {
    const out = [];
    const offIds = new Set();
    routersArr().forEach((r) => {
      const t = r.telemetry || {};
      if (r.status === 'offline') {
        offIds.add(Number(r.routerId));
        out.push({ sev: 'bad', title: `${r.name} tidak terjangkau`, sub: `${r.siteCode || '-'} · ${num(r.impact?.linked)} pelanggan terdampak`, val: ago(r.lastOkAt) });
        return;
      }
      if (r.wan?.running === false) out.push({ sev: 'bad', title: `${r.name} · WAN down`, sub: `${r.siteCode || '-'} · ${r.wan.interface || 'WAN'}`, val: '' });
      if (Number(t.cpuPct) >= 85) out.push({ sev: 'warn', title: `${r.name} · CPU ${Math.round(t.cpuPct)}%`, sub: `${r.siteCode || '-'}${t.memory?.pct != null ? ` · RAM ${Math.round(t.memory.pct)}%` : ''}`, val: '' });
      else if (Number(t.memory?.pct) >= 90) out.push({ sev: 'warn', title: `${r.name} · RAM ${Math.round(t.memory.pct)}%`, sub: r.siteCode || '-', val: '' });
      if (Number(t.health?.temperature) >= 70) out.push({ sev: 'warn', title: `${r.name} · suhu ${Math.round(t.health.temperature)}°C`, sub: r.siteCode || '-', val: '' });
    });
    (S.data.alerts || []).forEach((a) => {
      if (a.router_id && offIds.has(Number(a.router_id))) return; // sudah tampil sebagai router tidak terjangkau
      out.push({ sev: a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : '', title: a.title, sub: `${a.site_code || '-'}${a.details?.count ? ` · ${num(a.details.count)} pelanggan` : ''}`, val: ago(a.opened_at), id: `a${a.id}` });
    });
    (S.health.clusters || []).filter((c) => (!site || Number(c.site_id) === Number(site)) && (c.suspectOutage || (c.offlinePct >= 30 && Number(c.offline) >= 3)))
      .forEach((c) => out.push({ sev: c.suspectOutage ? 'bad' : 'warn', title: `${c.name}${c.suspectOutage ? ' dicurigai gangguan' : ''}`, sub: `${c.site_code} · ${num(c.offline)} dari ${num(c.customers)} offline`, val: `${c.offlinePct}%` }));
    (S.data.flapping || []).forEach((f) => out.push({ sev: Number(f.reconnects) >= 15 ? 'warn' : '', title: f.customer_name || f.username, sub: `${f.site_code || '-'} · putus-sambung dalam 1 jam`, val: `${num(f.reconnects)}×` }));
    const rank = { bad: 0, warn: 1, '': 2 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }

  // ---------- render ----------
  function renderHead(list) {
    const rs = routersArr();
    const down = rs.filter((r) => r.status === 'offline');
    const bad = list.filter((p) => p.sev === 'bad');
    const warn = list.filter((p) => p.sev === 'warn');
    let state = '', title = 'Jaringan normal';
    if (S.data.allOffline) { state = 'bad'; title = 'Semua router tidak terjangkau'; }
    else if (down.length) { state = 'bad'; title = `${down.length} router tidak terjangkau`; }
    else if (bad.length) { state = 'bad'; title = bad[0].title; }
    else if (warn.length) { state = 'warn'; title = `${warn.length} hal perlu dicek`; }
    $('nwDot').className = `nw-dot ${state}`;
    $('nwTitle').textContent = title;
    const impacted = down.reduce((a, r) => a + Number(r.impact?.linked || 0), 0);
    const sites = (S.health.sites || []).filter((s) => !site || Number(s.id) === Number(site)).map((s) => `${s.code} ${s.onlinePct}% online`);
    $('nwSubtitle').textContent = [impacted ? `${num(impacted)} pelanggan terdampak` : null, ...sites, `update ${hhmm(Date.now())}`].filter(Boolean).join(' · ');
    document.title = `${state === 'bad' ? '(!) ' : ''}NOC Wall · INKAMNET`;
  }

  function renderKpis() {
    const c = S.data.customers || {};
    const rs = routersArr();
    const up = rs.filter((r) => r.status === 'online').length;
    const rx = rs.reduce((a, r) => a + Number(r.wan?.rxBps || 0), 0);
    const tx = rs.reduce((a, r) => a + Number(r.wan?.txBps || 0), 0);
    const link = (st) => `/nms/secrets?tab=synced${site ? `&site=${site}` : ''}&status=${st}`;
    const tiles = [
      { k: 'Online', v: num(c.online), c: 'var(--green)', href: link('online') },
      { k: 'Offline', v: num(c.offline), c: Number(c.offline) ? 'var(--orange)' : '', href: link('offline') },
      { k: 'Diisolir', v: num(c.isolated), c: '', href: link('isolated') },
      { k: 'Router online', v: `${up}<small>/${rs.length}</small>`, c: up < rs.length ? 'var(--red)' : 'var(--green)' },
      { k: 'Download', v: bps(rx), c: 'var(--blue)' },
      { k: 'Upload', v: bps(tx), c: 'var(--indigo)' }
    ];
    const box = $('nwKpis');
    const before = [...box.querySelectorAll('strong')].map((x) => x.innerHTML);
    box.innerHTML = tiles.map((t) => `<${t.href ? `a href="${t.href}"` : 'div'} class="nw-kpi" style="${t.c ? `--c:${t.c}` : ''}"><span>${t.k}</span><strong>${t.v}</strong></${t.href ? 'a' : 'div'}>`).join('');
    // Kilatan hanya untuk angka jumlah (bukan traffic yang berubah terus) supaya tidak ramai.
    [...box.querySelectorAll('.nw-kpi')].slice(0, 4).forEach((el, i) => { if (before.length && before[i] !== el.querySelector('strong').innerHTML) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); } });
  }

  const meter = (v, warn, bad) => {
    if (v == null) return '<span class="muted">-</span>';
    const p = Math.max(0, Math.min(100, Math.round(v)));
    return `<div class="nw-meter ${lvl(p, warn, bad)}"><i><b style="width:${p}%"></b></i><span>${p}%</span></div>`;
  };
  function renderRouters() {
    const rs = routersArr().sort((a, b) => ((b.status === 'offline') - (a.status === 'offline')) || String(a.siteCode || '').localeCompare(String(b.siteCode || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    const up = rs.filter((r) => r.status === 'online').length;
    $('nwRoutersSub').textContent = `${up} dari ${rs.length} online`;
    $('nwRouterRows').innerHTML = rs.length ? rs.map((r) => {
      const t = r.telemetry || {};
      const off = r.status === 'offline';
      const tags = [];
      if (!off && r.wan?.running === false) tags.push('<span class="nw-tag bad">WAN down</span>');
      if (!off && Number(t.health?.temperature) >= 70) tags.push(`<span class="nw-tag warn">${Math.round(t.health.temperature)}°C</span>`);
      return `<tr class="${off ? 'off' : ''}"><td><span class="s-dot ${off ? 'bad' : r.status === 'online' ? '' : 'warn'}"></span></td>
        <td class="name" title="${esc(r.name)}">${esc(r.name)}${tags.join('')}</td>
        <td class="site">${esc(r.siteCode || '-')}</td>
        <td>${off ? '<span class="muted">-</span>' : meter(t.cpuPct, 65, 85)}</td>
        <td>${off ? '<span class="muted">-</span>' : meter(t.memory?.pct, 75, 90)}</td>
        <td class="r rx">${off ? '-' : bpsShort(r.wan?.rxBps)}</td>
        <td class="r tx">${off ? '-' : bpsShort(r.wan?.txBps)}</td>
        <td class="r">${off ? '-' : (r.activeSessions != null ? num(r.activeSessions) : '-')}</td>
        <td class="r up muted">${off ? `down ${ago(r.lastOkAt)}` : uptime(t.uptimeSeconds)}</td></tr>`;
    }).join('') : '<tr><td colspan="9" class="muted" style="text-align:center;height:80px">Belum ada router aktif.</td></tr>';
  }

  function renderProblems(list) {
    const cnt = $('nwProblemCount');
    cnt.textContent = list.length;
    cnt.className = `nw-count ${list.some((p) => p.sev === 'bad') ? 'bad' : list.some((p) => p.sev === 'warn') ? 'warn' : ''}`;
    $('nwProblems').innerHTML = list.length
      ? list.slice(0, 40).map((p) => `<li><span class="sev ${p.sev}"></span><div class="m"><b title="${esc(p.title)}">${esc(p.title)}</b><small>${esc(p.sub)}</small></div>${p.val ? `<span class="v ${p.sev}">${esc(p.val)}</span>` : ''}</li>`).join('')
      : '<li class="nw-ok" style="border:0"><div><i class="bi bi-check-circle-fill"></i><b>Semua normal</b>Tidak ada yang perlu dicek.</div></li>';
  }

  function renderTraffic() {
    const rs = routersArr();
    const len = Math.max(0, ...rs.map((r) => (r.wan?.history || []).length));
    const series = [];
    for (let k = len - 1; k >= 0; k--) {
      let rx = 0, tx = 0, t = 0;
      rs.forEach((r) => { const h = r.wan?.history || []; const p = h[h.length - 1 - k]; if (p) { rx += p.rx || 0; tx += p.tx || 0; t = Math.max(t, p.t || 0); } });
      series.push({ rx, tx, t });
    }
    const nowRx = rs.reduce((a, r) => a + Number(r.wan?.rxBps || 0), 0);
    const nowTx = rs.reduce((a, r) => a + Number(r.wan?.txBps || 0), 0);
    $('nwTrafficNow').innerHTML = `<span class="rx">↓ ${bps(nowRx)}</span><span class="tx">↑ ${bps(nowTx)}</span>`;
    const box = $('nwChart');
    if (series.length < 2) { box.innerHTML = '<div class="empty">Menunggu sampel traffic…</div>'; return; }
    const W = Math.max(200, box.clientWidth || 500), H = Math.max(80, box.clientHeight || 160);
    const max = Math.max(1, ...series.map((p) => Math.max(p.rx, p.tx))) * 1.12;
    const L = 38, B = 14;
    const x = (i) => (L + i / (series.length - 1) * (W - L)).toFixed(1);
    const y = (v) => (H - B - v / max * (H - B - 4)).toFixed(1);
    const line = (key) => series.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[key])}`).join('');
    let grid = '';
    [0.5, 1].forEach((f) => { const v = max / 1.12 * f, yy = y(v); grid += `<line class="g" x1="${L}" x2="${W}" y1="${yy}" y2="${yy}" stroke-width=".5"/><text class="lbl" x="${L - 6}" y="${Number(yy) + 3}" text-anchor="end">${bpsShort(v)}</text>`; });
    const first = series[0].t, last = series[series.length - 1].t;
    const times = first && last ? `<text class="lbl" x="${L}" y="${H - 1}">${hhmm(first)}</text><text class="lbl" x="${W}" y="${H - 1}" text-anchor="end">${hhmm(last)}</text>` : '';
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="nwg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--blue);stop-opacity:.25"/><stop offset="1" style="stop-color:var(--blue);stop-opacity:0"/></linearGradient></defs>
      ${grid}${times}
      <path d="${line('rx')}L${x(series.length - 1)},${H - B}L${L},${H - B}Z" fill="url(#nwg)"/>
      <path d="${line('rx')}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <path d="${line('tx')}" fill="none" stroke="var(--indigo)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderAll() {
    const list = problems();
    renderHead(list); renderKpis(); renderRouters(); renderProblems(list); renderTraffic();
    alarm(list);
  }

  // ---------- alarm suara: hanya untuk masalah merah yang baru muncul ----------
  let audioCtx = null;
  function beep() {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach((d) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); const t0 = audioCtx.currentTime + d; o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2); o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.22); });
    } catch (_) { /* ignore */ }
  }
  function alarm(list) {
    const keys = list.filter((p) => p.sev === 'bad').map((p) => p.id || p.title);
    const fresh = keys.filter((k) => !S.seen.has(k));
    keys.forEach((k) => S.seen.add(k));
    if (!S.first && fresh.length) beep();
    S.first = false;
  }

  // ---------- data ----------
  const getJSON = async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  async function refreshDashboard() {
    try {
      const j = await getJSON(`/nms/api/dashboard${qs}`);
      if (!j.ok) return;
      S.data = j.data;
      (j.data.routers || []).forEach((r) => { const cur = S.routers.get(Number(r.routerId)); S.routers.set(Number(r.routerId), cur && (cur.wan?.history?.length || 0) > (r.wan?.history?.length || 0) ? { ...r, wan: cur.wan } : r); });
      renderAll();
    } catch (_) { /* tampilan lama tetap, coba lagi di siklus berikutnya */ }
  }
  async function refreshHealth() {
    try { const j = await getJSON('/nms/api/health'); if (j.ok) { S.health = { sites: j.sites, clusters: j.clusters }; renderAll(); } } catch (_) { /* ignore */ }
  }

  let frame = 0;
  const schedule = () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; renderAll(); }); };
  function connect() {
    if (!window.EventSource) return;
    const es = new EventSource(`/nms/api/stream${qs}`);
    es.addEventListener('telemetry', (m) => {
      let p; try { p = JSON.parse(m.data); } catch (_) { return; }
      const cur = S.routers.get(Number(p.routerId)) || {};
      S.routers.set(Number(p.routerId), { ...cur, ...p, impact: cur.impact });
      schedule();
    });
    ['alert', 'alert_resolved', 'router_state'].forEach((evt) => es.addEventListener(evt, () => setTimeout(refreshDashboard, 400)));
  }

  // ---------- auto-scroll pelan untuk daftar yang lebih panjang dari layar ----------
  function autoscroll() {
    document.querySelectorAll('[data-autoscroll]').forEach((el) => {
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 4 || getComputedStyle(el).overflowY !== 'hidden') return;
      const now = Date.now();
      if (Number(el.dataset.pause || 0) > now) return;
      if (el.scrollTop >= overflow - 1) { el.dataset.pause = String(now + 6000); setTimeout(() => { el.scrollTo({ top: 0, behavior: 'smooth' }); el.dataset.pause = String(Date.now() + 5000); }, 4000); return; }
      el.scrollTop += 1;
    });
  }

  // ---------- kontrol ----------
  let wakeLock = null;
  async function toggleFull() { try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); else await document.exitFullscreen(); } catch (_) { /* ignore */ } }
  document.addEventListener('fullscreenchange', async () => {
    const on = Boolean(document.fullscreenElement);
    $('nwFull').innerHTML = `<i class="bi ${on ? 'bi-fullscreen-exit' : 'bi-arrows-fullscreen'}"></i>`;
    try { if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); else if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (_) { /* ignore */ }
    setTimeout(renderTraffic, 200);
  });
  $('nwFull').addEventListener('click', toggleFull);

  function paintSound() { const b = $('nwSound'); b.classList.toggle('on', S.sound); b.innerHTML = `<i class="bi ${S.sound ? 'bi-volume-up-fill' : 'bi-volume-mute'}"></i>`; b.title = S.sound ? 'Alarm suara aktif (S)' : 'Alarm suara mati (S)'; }
  function toggleSound() { S.sound = !S.sound; try { localStorage.setItem('nw-sound', S.sound ? '1' : '0'); } catch (_) { /* ignore */ } paintSound(); if (S.sound) beep(); }
  $('nwSound').addEventListener('click', toggleSound);
  paintSound();

  function paintTheme() { const dark = document.documentElement.dataset.theme !== 'light'; $('nwTheme').innerHTML = `<i class="bi ${dark ? 'bi-sun' : 'bi-moon-stars'}"></i>`; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7'); }
  function toggleTheme() { const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; try { localStorage.setItem('nw-theme', next); } catch (_) { /* ignore */ } paintTheme(); }
  $('nwTheme').addEventListener('click', toggleTheme);
  paintTheme();

  function tickClock() {
    const now = new Date();
    $('nwClock').textContent = hhmm(now);
    $('nwDate').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' }).format(now);
  }

  let idle = 0;
  document.addEventListener('mousemove', () => { document.body.classList.remove('nw-idle'); clearTimeout(idle); idle = setTimeout(() => { if (document.fullscreenElement) document.body.classList.add('nw-idle'); }, 3000); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input,select,textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'f') { e.preventDefault(); toggleFull(); }
    else if (k === 's') { e.preventDefault(); toggleSound(); }
    else if (k === 't') { e.preventDefault(); toggleTheme(); }
    else if (k === 'r') { e.preventDefault(); refreshDashboard(); refreshHealth(); }
  });
  $('nwSite').addEventListener('change', (e) => { const v = e.target.value; location.href = `/nms/wall${v ? `?site=${encodeURIComponent(v)}` : ''}`; });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderTraffic, 150); });

  // ---------- mulai ----------
  renderAll();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(refreshDashboard, 15000);
  setInterval(refreshHealth, 60000);
  setInterval(() => { const list = problems(); renderHead(list); renderProblems(list); }, 30000); // perbarui label "x mnt"
  document.querySelectorAll('[data-autoscroll]').forEach((el) => { el.dataset.pause = String(Date.now() + 6000); }); // beri waktu baca sebelum mulai bergulir
  setInterval(autoscroll, 60);
  connect();
})();
