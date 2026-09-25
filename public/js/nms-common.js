// NMS shared client (Apple-style UI): API, HUD toast + undo, sheet, menu, palette (Ctrl/Cmd+K),
// drawer detail pelanggan, aksi pelanggan bersama, grafik SVG, SSE live. Tanpa dependency.
(() => {
  const root = document.querySelector('.nx');
  if (!root) return;
  const csrf = root.dataset.csrf;
  const canControl = root.dataset.canControl === '1';
  const isAdmin = root.dataset.isAdmin === '1';
  const currentSite = root.dataset.site || '';
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  document.querySelectorAll('.nx-kbd-mod').forEach(k => { k.textContent = isMac ? '⌘K' : 'Ctrl K'; });

  // ------------------------------------------------------------ format
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const splitBps = bps => { const n = Number(bps) || 0; if (n >= 1e9) return [(n / 1e9).toFixed(2), 'Gbps']; if (n >= 1e6) return [(n / 1e6).toFixed(n >= 1e8 ? 0 : 1), 'Mbps']; if (n >= 1e3) return [(n / 1e3).toFixed(0), 'Kbps']; return [String(Math.round(n)), 'bps']; };
  const fmtBps = bps => splitBps(bps).join(' ');
  const fmtBytes = b => { const n = Number(b) || 0; if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`; if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`; return `${(n / 1024).toFixed(0)} KB`; };
  const fmtUptime = s => { s = Math.max(0, Math.floor(Number(s) || 0)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}h ${h}j` : h ? `${h}j ${m}m` : `${m}m`; };
  const rupiah = n => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
  const ago = iso => { if (!iso) return '—'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 45) return 'baru saja'; if (s < 3600) return `${Math.round(s / 60)} mnt lalu`; if (s < 86400) return `${Math.round(s / 3600)} jam lalu`; return `${Math.round(s / 86400)} hari lalu`; };
  const TZ = { timeZone: 'Asia/Jakarta' };
  const hhmm = iso => new Date(iso).toLocaleTimeString('id-ID', { ...TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const hhmmss = iso => new Date(iso).toLocaleTimeString('id-ID', { ...TZ, hour12: false });
  const dateTime = iso => iso ? new Date(iso).toLocaleString('id-ID', { ...TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const dateOnly = iso => iso ? new Date(iso).toLocaleDateString('id-ID', { ...TZ, day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const tone = pct => pct == null ? 'gray' : pct > 80 ? 'red' : pct >= 60 ? 'orange' : 'green';
  const COLORS = () => { const cs = getComputedStyle(root); const g = k => cs.getPropertyValue(k).trim(); return { green: g('--x-green'), orange: g('--x-orange'), red: g('--x-red'), blue: g('--x-blue'), purple: g('--x-purple'), teal: g('--x-teal'), gray: g('--x-gray'), line: g('--x-line'), track: g('--x-card3'), accent: g('--x-accent') }; };
  const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const qs = obj => { const u = new URLSearchParams(); Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v != null && v !== false) u.set(k, v === true ? '1' : v); }); const s = u.toString(); return s ? `?${s}` : ''; };
  const withSite = (obj = {}) => qs({ ...obj, site: currentSite || undefined });

  // ------------------------------------------------------------ API
  async function api(url, { method = 'GET', body = null } = {}) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : null });
    let data = null; try { data = await res.json(); } catch (_) { throw new Error(res.status === 403 ? 'Akses ditolak atau sesi kedaluwarsa. Muat ulang halaman.' : `HTTP ${res.status}`); }
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
    return data;
  }

  // ------------------------------------------------------------ HUD toast
  const toastBox = root.querySelector('.nx-toasts') || root.appendChild(Object.assign(document.createElement('div'), { className: 'nx-toasts' }));
  function toast(message, kind = 'info', { action = null, onAction = null, duration = null } = {}) {
    const el = document.createElement('div');
    const icon = { ok: 'bi-check-circle-fill', err: 'bi-exclamation-circle-fill', info: 'bi-info-circle-fill' }[kind] || 'bi-info-circle-fill';
    el.className = `nx-toast ${kind}`;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = `<i class="bi ${icon} ic"></i><span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
    const ms = duration || (kind === 'err' ? 7000 : 3800);
    let timer = null;
    const close = () => { clearTimeout(timer); el.classList.add('leaving'); setTimeout(() => el.remove(), 250); };
    if (action) el.querySelector('button').addEventListener('click', () => { onAction?.(); close(); });
    toastBox.appendChild(el);
    timer = setTimeout(close, ms);
    while (toastBox.childElementCount > 4) toastBox.firstElementChild.remove();
    return { close, el };
  }

  /** Undo 5 detik: perintah baru dikirim ke router setelah hitung mundur, kecuali dibatalkan. */
  function deferred(label, run, { seconds = 5 } = {}) {
    return new Promise(resolve => {
      let cancelled = false;
      const t = toast(label, 'info', { action: 'Batalkan', onAction: () => { cancelled = true; resolve(null); toast('Dibatalkan. Tidak ada yang dikirim ke router.', 'ok'); }, duration: seconds * 1000 + 200 });
      const bar = document.createElement('i'); bar.className = 'bar'; bar.style.animationDuration = `${seconds}s`; t.el.appendChild(bar);
      setTimeout(async () => { if (cancelled) return; t.close(); try { resolve(await run()); } catch (err) { toast(err.message, 'err'); resolve(null); } }, seconds * 1000);
    });
  }

  // ------------------------------------------------------------ Sheet (modal)
  function sheet({ title, subtitle = '', body = '', foot = '', size = '' } = {}) {
    const el = document.createElement('div');
    el.className = 'nx-sheet';
    el.innerHTML = `<div class="nx-sheet-box ${size}" role="dialog" aria-modal="true"><div class="nx-sheet-head"><div class="grow"><h4>${esc(title)}</h4>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button type="button" class="nx-x" data-close aria-label="Tutup"><i class="bi bi-x-lg"></i></button></div><div class="nx-sheet-body">${body}</div>${foot ? `<div class="nx-sheet-foot">${foot}</div>` : ''}</div>`;
    root.appendChild(el);
    const s = {
      el, body: el.querySelector('.nx-sheet-body'), foot: el.querySelector('.nx-sheet-foot'),
      $: sel => el.querySelector(sel), $$: sel => [...el.querySelectorAll(sel)],
      close() { if (s.closed) return; s.closed = true; el.classList.remove('show'); document.removeEventListener('keydown', onKey, true); setTimeout(() => el.remove(), 260); s.onClose?.(); },
      onClose: null, closed: false
    };
    const onKey = e => { if (e.key === 'Escape') { const open = [...document.querySelectorAll('.nx-sheet.show')]; if (open[open.length - 1] === el) { e.stopPropagation(); s.close(); } } };
    el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) s.close(); });
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => { el.classList.add('show'); (el.querySelector('[autofocus]') || el.querySelector('.nx-sheet-foot .primary, .nx-sheet-foot .blue, .nx-sheet-foot .solid-red'))?.focus(); });
    return s;
  }
  function confirmBox({ title, message, okText = 'Lanjutkan', danger = false }) {
    return new Promise(resolve => {
      let done = false;
      const s = sheet({ title, size: 'sm', body: `<div style="font-size:14px;line-height:1.5">${message}</div>`, foot: `<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn ${danger ? 'solid-red' : 'primary'}" data-ok>${esc(okText)}</button>` });
      s.onClose = () => { if (!done) resolve(false); };
      s.$('[data-ok]').addEventListener('click', () => { done = true; s.close(); resolve(true); });
    });
  }

  // ------------------------------------------------------------ Context menu
  let openMenu = null;
  function menu(anchor, items) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'nx-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}"><i class="bi ${it.icon || 'bi-dot'}"></i>${esc(it.label)}</button>`).join('');
    root.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    el.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; closeMenu(); items[Number(b.dataset.i)].run?.(); });
    openMenu = el;
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }
  function closeMenu() { openMenu?.remove(); openMenu = null; }
  window.addEventListener('scroll', closeMenu, { passive: true });

  // ------------------------------------------------------------ SVG helpers
  function ring(pct, { size = 62, stroke = 7, color = null, label = '', text = null } = {}) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0)), r = (size - stroke) / 2, len = 2 * Math.PI * r;
    const c = COLORS();
    const col = color || c[tone(pct)] || c.gray;
    return `<div class="nx-ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${c.track}" stroke-width="${stroke}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${pct == null ? len : len * (1 - p / 100)}" style="transition:stroke-dashoffset .6s cubic-bezier(.32,.72,0,1)"/></svg><div class="v">${text ?? (pct == null ? '—' : Math.round(p) + '%')}${label ? `<small>${esc(label)}</small>` : ''}</div></div>`;
  }
  function smoothPath(pts) {
    if (!pts.length) return '';
    if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c2x = p2[0] - (p3[0] - p1[0]) / 6;
      // Batasi control point agar kurva tidak "overshoot" di bawah nol / di atas puncak.
      const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
      const c1y = Math.max(lo, Math.min(hi, p1[1] + (p2[1] - p0[1]) / 6)), c2y = Math.max(lo, Math.min(hi, p2[1] - (p3[1] - p1[1]) / 6));
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }
  const niceMax = v => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; };
  let gradSeq = 0;
  /** Grafik area multi-seri SVG murni, tema-aware, dengan tooltip hover. */
  function areaChart(el, { times = [], series = [], format = fmtBps, empty = 'Menunggu data…' } = {}) {
    const W = Math.max(200, el.clientWidth || 400), H = Math.max(80, el.clientHeight || 150), padL = 46, padB = 18, padT = 8;
    const n = times.length;
    if (n < 2) { el.innerHTML = `<div class="nx-empty" style="padding:44px 0">${esc(empty)}</div>`; return; }
    const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
    const x = i => padL + (i / (n - 1)) * (W - padL - 4), y = v => padT + (1 - v / max) * (H - padT - padB);
    const id = el.dataset.gid || (el.dataset.gid = `nxg${++gradSeq}`);
    const grid = [0, .5, 1].map(f => `<line x1="${padL}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${padL - 7}" y="${y(max * f) + 3}" text-anchor="end">${esc(format(max * f).replace(' ', ''))}</text>`).join('');
    const tl = [0, Math.floor((n - 1) / 2), n - 1].map(i => `<text x="${x(i)}" y="${H - 3}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(hhmm(times[i]))}</text>`).join('');
    const paths = series.map((s, si) => {
      const pts = s.values.map((v, i) => [x(i), y(v)]);
      const line = smoothPath(pts);
      return `<defs><linearGradient id="${id}-${si}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".26"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>
        <path d="${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="url(#${id}-${si})"/><path d="${line}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik traffic"><g class="grid">${grid}${tl}</g>${paths}<line class="cursor" x1="0" x2="0" y1="${padT}" y2="${H - padB}"/>${series.map((s, si) => `<circle data-dot="${si}" r="3.5" fill="${s.color}" stroke="var(--x-card)" stroke-width="2" style="opacity:0"/>`).join('')}</svg><div class="tip"></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), cur = el.querySelector('.cursor');
    svg.onmousemove = ev => {
      const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / ((W - padL - 4) / (n - 1)))));
      el.classList.add('hover');
      cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i));
      series.forEach((s, si) => { const d = el.querySelector(`[data-dot="${si}"]`); d.setAttribute('cx', x(i)); d.setAttribute('cy', y(s.values[i])); d.style.opacity = 1; });
      tip.innerHTML = `<b>${esc(hhmmss(times[i]))}</b><br>${series.map(s => `<span style="color:${s.color}">●</span> ${esc(s.name)} ${esc(format(s.values[i]))}`).join('<br>')}`;
      tip.style.left = `${Math.max(12, Math.min(88, (x(i) / W) * 100))}%`;
    };
    svg.onmouseleave = () => { el.classList.remove('hover'); el.querySelectorAll('[data-dot]').forEach(d => { d.style.opacity = 0; }); };
  }

  // ------------------------------------------------------------ Site select, clock, live, updated
  const siteSelect = document.getElementById('nmsSiteSelect');
  try {
    const saved = localStorage.getItem('nms-site');
    if (!new URLSearchParams(location.search).has('site') && saved && saved !== currentSite && siteSelect?.querySelector(`option[value="${CSS.escape(saved)}"]`)) {
      const u = new URL(location.href); u.searchParams.set('site', saved); location.replace(u); return;
    }
  } catch (_) {}
  siteSelect?.addEventListener('change', () => {
    try { localStorage.setItem('nms-site', siteSelect.value); } catch (_) {}
    const u = new URL(location.href);
    if (siteSelect.value) u.searchParams.set('site', siteSelect.value); else u.searchParams.delete('site');
    u.searchParams.delete('page');
    location.assign(u);
  });
  const clock = root.querySelector('[data-nms-clock]');
  const tick = () => { if (clock) clock.textContent = `${new Date().toLocaleTimeString('id-ID', { ...TZ, hour12: false })} WIB`; };
  tick(); setInterval(tick, 1000);
  let lastUpdated = null;
  const updatedEl = document.getElementById('nmsUpdated');
  const renderUpdated = () => { if (updatedEl) updatedEl.textContent = lastUpdated ? `Diperbarui ${ago(lastUpdated)}` : 'Memuat…'; };
  function markUpdated(iso) { lastUpdated = iso || new Date().toISOString(); renderUpdated(); }
  setInterval(renderUpdated, 5000);
  function setOffline(show) { document.getElementById('nmsOfflineBadge')?.classList.toggle('show', !!show); }
  function setLive(state) {
    const el = document.getElementById('nmsLive'); if (!el) return;
    const label = { live: 'Live', polling: 'Polling', down: 'Terputus', connecting: 'Menghubungkan' }[state] || 'Menghubungkan';
    el.className = `nx-live ${state}`; el.querySelector('span').textContent = label;
  }

  function stream(handlers, { fallback, fallbackMs = 20000 } = {}) {
    let es = null, pollTimer = null, retries = 0;
    const startPolling = () => { if (pollTimer || !fallback) return; setLive('polling'); pollTimer = setInterval(() => fallback().catch(() => setLive('down')), fallbackMs); };
    const all = { ...handlers, approval: a => { handlers.approval?.(a); loadBadges(); } };
    const connect = () => {
      if (!window.EventSource) return startPolling();
      es = new EventSource(`/nms/api/stream${currentSite ? `?site=${encodeURIComponent(currentSite)}` : ''}`);
      es.onopen = () => { retries = 0; setLive('live'); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
      es.onerror = () => { setLive('connecting'); if (++retries >= 3) { es.close(); startPolling(); setTimeout(() => { retries = 0; connect(); }, 60000); } };
      Object.entries(all).forEach(([evt, fn]) => es.addEventListener(evt, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.warn('NMS SSE', evt, err); } }));
    };
    connect();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && fallback) fallback().catch(() => {}); });
  }

  // Badge navigasi: jumlah temuan rekonsiliasi + persetujuan menunggu.
  async function loadBadges() {
    try {
      const [{ groups }, { rows }] = await Promise.all([api(`/nms/api/reconcile${withSite()}`), api('/nms/api/approvals')]);
      const n = Object.values(groups).filter(g => ['overdue_active', 'paid_isolated', 'inactive_online', 'secret_no_customer'].includes(g.key)).reduce((a, g) => a + g.count, 0);
      const rc = document.getElementById('nxReconCount'); if (rc) { rc.textContent = n; rc.hidden = !n; }
      const pend = rows.filter(r => r.status === 'pending').length;
      const ac = document.getElementById('nxApprovalCount'); if (ac) { ac.textContent = pend; ac.hidden = !pend; }
      document.dispatchEvent(new CustomEvent('nx:recon', { detail: groups }));
    } catch (_) {}
  }
  setTimeout(loadBadges, 400);
  setInterval(() => { if (!document.hidden) loadBadges(); }, 120000);

  const changed = () => { document.dispatchEvent(new CustomEvent('nx:changed')); setTimeout(loadBadges, 800); };

  // ------------------------------------------------------------ Aksi pelanggan (dipakai tabel, drawer, palette)
  const ACT_LABEL = { isolate: 'Isolir', unisolate: 'Buka isolir', kick: 'Kick sesi', 'lock-mac': 'Kunci MAC', 'unlock-mac': 'Lepas MAC', unmap: 'Lepas link' };
  const who = r => r.customer_name || r.username;
  async function act(r, action) {
    if (!r) return;
    const id = r.id;
    if (action === 'ping') return ping(r);
    if (action === 'detail') return drawer(id);
    if (action === 'diagnose') return drawer(id, 'diag');
    if (action === 'traffic') return drawer(id, 'traffic');
    if (action === 'timeline') return drawer(id, 'history');
    if (!canControl) return toast('Aksi ini butuh role Admin atau izin Kontrol Jaringan.', 'err');
    if (action === 'map') return openMap(r);
    if (action === 'create-customer') return openCreateCustomer(r);
    if (action === 'hold') return openHold(r);
    if (action === 'schedule') return openSchedule([r.id], who(r));
    if (action === 'package') return openPackage(r);
    if (action === 'ticket') { try { const { ticket } = await api(`/nms/api/secrets/${id}/ticket`, { method: 'POST', body: {} }); toast(ticket.existing ? `Tiket ${ticket.code} sudah ada.` : `Tiket ${ticket.code} dibuat.`, 'ok', { action: 'Buka', onAction: () => location.assign('/tickets') }); } catch (err) { toast(err.message, 'err'); } return; }
    if (!ACT_LABEL[action]) return;
    if (action === 'unmap' && !(await confirmBox({ title: 'Lepas link pelanggan?', danger: true, okText: 'Lepas', message: `Secret <b>${esc(r.username)}</b> tidak lagi terikat ke <b>${esc(r.customer_name || '')}</b> dan kembali ke daftar belum ter-link.` }))) return;
    if (action === 'lock-mac' && !(await confirmBox({ title: 'Kunci MAC address?', okText: 'Kunci', message: `Caller-ID dari sesi aktif <b>${esc(r.username)}</b> akan dikunci. Perangkat lain tidak bisa login dengan akun ini.` }))) return;
    document.dispatchEvent(new CustomEvent('nx:pending', { detail: { id, on: true } }));
    const out = await deferred(`${ACT_LABEL[action]} ${who(r)}…`, async () => {
      const url = action === 'unlock-mac' ? `/nms/api/secrets/${id}/lock-mac` : `/nms/api/secrets/${id}/${action}`;
      return api(url, { method: 'POST', body: action === 'unlock-mac' ? { unlock: true } : {} });
    }, { seconds: ['lock-mac', 'unlock-mac'].includes(action) ? 3 : 5 });
    document.dispatchEvent(new CustomEvent('nx:pending', { detail: { id, on: false } }));
    if (!out) return;
    const res = out.result || {};
    const msg = { isolate: `${who(r)} diisolir.`, unisolate: `${who(r)} aktif kembali (${res.restoredProfile || 'profile semula'}).`, kick: res.droppedSessions ? `Sesi ${who(r)} di-reset.` : `${who(r)} tidak punya sesi aktif.`, 'lock-mac': `MAC ${res.callerId} dikunci.`, 'unlock-mac': 'MAC lock dilepas.', unmap: `Link ${r.username} dilepas.` }[action];
    toast(msg, 'ok', action === 'unmap' ? {} : { action: 'Riwayat', onAction: () => drawer(id, 'history') });
    changed();
    return out;
  }
  const pingCache = new Map();
  async function ping(r) {
    pingCache.set(r.id, { busy: true }); document.dispatchEvent(new CustomEvent('nx:ping', { detail: r.id }));
    try { const { result } = await api(`/nms/api/secrets/${r.id}/ping`, { method: 'POST', body: {} }); pingCache.set(r.id, result); toast(`Ping ${who(r)}: ${result.avgMs ?? '—'} ms · loss ${result.lossPct}%`, result.lossPct >= 50 ? 'err' : 'ok'); }
    catch (err) { pingCache.set(r.id, { error: err.message }); toast(err.message, 'err'); }
    document.dispatchEvent(new CustomEvent('nx:ping', { detail: r.id }));
  }
  const pingBadge = id => {
    const p = pingCache.get(id);
    if (!p) return '<span class="nx-ping">—</span>';
    if (p.busy) return '<span class="nx-ping">ping…</span>';
    if (p.error) return `<span class="nx-ping red" title="${esc(p.error)}">gagal</span>`;
    const cls = p.lossPct >= 50 ? 'red' : (p.lossPct > 0 || (p.avgMs || 0) > 80) ? 'orange' : 'green';
    return `<span class="nx-ping ${cls}" title="${p.received}/${p.sent} reply">${p.avgMs == null ? '—' : p.avgMs + ' ms'} · ${p.lossPct}%</span>`;
  };

  /** Item menu "…" standar untuk 1 secret. */
  function actionItems(r, { skipView = false } = {}) {
    const items = skipView ? [] : [{ label: 'Detail pelanggan', icon: 'bi-person-vcard', run: () => act(r, 'detail') }, { label: 'Kenapa offline? (diagnosa)', icon: 'bi-heart-pulse', run: () => act(r, 'diagnose') }];
    if (!skipView && (r.state === 'online' || (r.is_online && !r.is_isolated))) items.push({ label: 'Traffic live', icon: 'bi-graph-up', run: () => act(r, 'traffic') });
    if (!skipView) items.push({ label: 'Riwayat & kembalikan', icon: 'bi-clock-history', run: () => act(r, 'timeline') });
    if (!canControl) return items;
    if (items.length) items.push('-');
    items.push(r.is_isolated ? { label: 'Buka isolir', icon: 'bi-check2-circle', run: () => act(r, 'unisolate') } : { label: 'Isolir', icon: 'bi-slash-circle', danger: true, run: () => act(r, 'isolate') });
    items.push({ label: 'Kick sesi', icon: 'bi-plug', run: () => act(r, 'kick') });
    items.push(r.caller_id ? { label: 'Lepas MAC lock', icon: 'bi-unlock', run: () => act(r, 'unlock-mac') } : { label: 'Kunci MAC dari sesi aktif', icon: 'bi-lock', run: () => act(r, 'lock-mac') });
    items.push({ label: 'Jadwalkan aksi…', icon: 'bi-calendar-event', run: () => act(r, 'schedule') });
    if (r.customer_id) {
      items.push({ label: 'Tunda isolir (janji bayar)…', icon: 'bi-hourglass-split', run: () => act(r, 'hold') });
      items.push({ label: 'Ganti paket…', icon: 'bi-speedometer', run: () => act(r, 'package') });
      items.push({ label: 'Buat tiket gangguan', icon: 'bi-ticket-perforated', run: () => act(r, 'ticket') });
      items.push('-', { label: 'Lepas link pelanggan', icon: 'bi-x-circle', danger: true, run: () => act(r, 'unmap') });
    } else {
      items.push('-', { label: 'Hubungkan ke pelanggan…', icon: 'bi-link-45deg', run: () => act(r, 'map') }, { label: 'Buat pelanggan dari secret…', icon: 'bi-person-plus', run: () => act(r, 'create-customer') });
    }
    return items;
  }

  // ------------------------------------------------------------ Sheets aksi
  let packagesCache = null;
  async function packages(siteId) {
    if (!packagesCache) packagesCache = (await api('/nms/api/packages')).rows;
    return packagesCache.filter(p => !siteId || !p.site_id || Number(p.site_id) === Number(siteId));
  }
  const sitesList = [...(siteSelect?.options || [])].filter(o => o.value).map(o => ({ id: o.value, label: o.textContent }));

  function openMap(r, { onDone } = {}) {
    const s = sheet({ title: 'Hubungkan ke pelanggan', subtitle: `<span class="mono">${esc(r.username)}</span> · ${esc(r.site_code || '')}${r.router_name ? ' / ' + esc(r.router_name) : ''}`, size: 'sm',
      body: `<div class="nx-field"><label>Site</label><select data-site>${sitesList.map(o => `<option value="${o.id}" ${Number(o.id) === Number(r.site_id) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
        <div class="nx-field nx-ac"><label>Pelanggan</label><input type="search" data-q placeholder="Ketik nama, Customer ID, atau HP" autocomplete="off" autofocus><div class="nx-ac-list" data-list hidden></div></div><div class="nx-note" data-picked>Belum memilih pelanggan.</div><div class="nx-field"><label>Alasan mapping manual</label><input type="text" data-reason minlength="5" maxlength="255" placeholder="Contoh: verifikasi pelanggan oleh teknisi"></div>`,
      foot: `<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save disabled>Hubungkan</button>` });
    let rows = [], pick = null, idx = -1, timer = null;
    const list = s.$('[data-list]');
    const search = async () => {
      const q = s.$('[data-q]').value.trim(); if (q.length < 2) { list.hidden = true; return; }
      try {
        ({ rows } = await api(`/nms/api/customers/search${qs({ q, site: s.$('[data-site]').value })}`)); idx = -1;
        list.innerHTML = rows.length ? rows.map((c, i) => `<button type="button" data-i="${i}" ${c.linked_username ? 'disabled' : ''}><b class="mono">${esc(c.customer_code)}</b><span class="grow">${esc(c.name)}</span><small class="dim">${c.linked_username ? 'sudah: ' + esc(c.linked_username) : esc(c.site_code)}</small></button>`).join('') : '<div class="nx-empty">Tidak ditemukan.</div>';
        list.hidden = false;
      } catch (err) { toast(err.message, 'err'); }
    };
    const choose = i => { const c = rows[i]; if (!c || c.linked_username) return; pick = c; s.$('[data-q]').value = `${c.customer_code} · ${c.name}`; list.hidden = true; s.$('[data-picked]').innerHTML = `Terpilih <b>${esc(c.name)}</b> · ${esc(c.customer_code)}`; s.$('[data-save]').disabled = false; };
    s.$('[data-q]').addEventListener('input', () => { clearTimeout(timer); pick = null; s.$('[data-save]').disabled = true; timer = setTimeout(search, 200); });
    s.$('[data-q]').addEventListener('keydown', e => { const items = [...list.querySelectorAll('button:not(:disabled)')]; if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); idx = Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((b, i) => b.classList.toggle('on', i === idx)); } if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) choose(Number(items[idx].dataset.i)); } });
    list.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) choose(Number(b.dataset.i)); });
    s.$('[data-site]').addEventListener('change', search);
    s.$('[data-save]').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.classList.add('busy');
      try { await api(`/nms/api/secrets/${r.id}/map`, { method: 'POST', body: { customerId: pick.id, reason: s.$('[data-reason]').value } }); toast(`${r.username} → ${pick.name}`, 'ok'); s.close(); onDone?.(); changed(); }
      catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  }

  async function openCreateCustomer(r, { onDone } = {}) {
    let pk = []; try { pk = await packages(r.site_id); } catch (_) {}
    const guess = String(r.comment || r.username || '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
    const match = pk.find(p => p.mikrotik_profile && String(p.mikrotik_profile).toLowerCase() === String(r.profile || '').toLowerCase());
    const s = sheet({ title: 'Buat pelanggan dari secret', subtitle: `Customer ID dibuat otomatis, lalu langsung terhubung ke <span class="mono">${esc(r.username)}</span>.`,
      body: `<div class="nx-field"><label>Nama pelanggan</label><input type="text" data-name value="${esc(guess)}" autofocus></div>
        <div class="nx-row"><div class="nx-field"><label>No. WhatsApp</label><input type="tel" data-phone placeholder="08…"></div><div class="nx-field"><label>Tanggal jatuh tempo</label><input type="number" data-due min="1" max="28" placeholder="Default site"></div></div>
        <div class="nx-field"><label>Paket</label><select data-pkg>${pk.map(p => `<option value="${p.id}" ${match && match.id === p.id ? 'selected' : ''}>${esc(p.name)} · ${rupiah(p.price)}${p.mikrotik_profile ? ` · ${esc(p.mikrotik_profile)}` : ''}</option>`).join('') || '<option value="">Belum ada paket untuk site ini</option>'}</select>${r.profile ? `<span class="hint">Profile secret saat ini: ${esc(r.profile)}</span>` : ''}</div>
        <div class="nx-field"><label>Alamat</label><input type="text" data-addr placeholder="Opsional"></div>`,
      foot: `<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save>Buat & hubungkan</button>` });
    s.$('[data-save]').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.classList.add('busy');
      try {
        const { result } = await api(`/nms/api/secrets/${r.id}/create-customer`, { method: 'POST', body: { name: s.$('[data-name]').value, phone: s.$('[data-phone]').value, packageId: s.$('[data-pkg]').value, dueDay: s.$('[data-due]').value, address: s.$('[data-addr]').value } });
        toast(`Pelanggan ${result.customerCode} dibuat dan terhubung.`, 'ok', { action: 'Lihat', onAction: () => location.assign(`/customers/${result.customerId}`) }); s.close(); onDone?.(); changed();
      } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  }

  async function openCreateSecret(c, { onDone } = {}) {
    let routers = []; try { routers = (await api(`/nms/api/routers${qs({ site: c.site_id })}`)).rows; } catch (_) {}
    const s = sheet({ title: 'Buat secret PPPoE', subtitle: `${esc(c.customer_name)} · ${esc(c.customer_code)}`,
      body: `<div class="nx-row"><div class="nx-field"><label>Router</label><select data-router>${routers.map(r => `<option value="${r.id}">${esc(r.site_code)} · ${esc(r.name)}</option>`).join('') || '<option value="">Tidak ada router di site ini</option>'}</select></div>
          <div class="nx-field"><label>Profile</label><input type="text" data-profile value="${esc(c.mikrotik_profile || '')}" placeholder="Dari paket"></div></div>
        <div class="nx-row"><div class="nx-field"><label>Username</label><input type="text" data-user value="${esc(String(c.customer_code || '').toLowerCase())}"></div><div class="nx-field"><label>Password</label><input type="text" data-pass placeholder="Acak otomatis"></div></div>
        <div class="nx-field"><label>Kirim kredensial ke WA teknisi</label><input type="tel" data-wa placeholder="Opsional, contoh 0812…"></div>`,
      foot: `<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save>Buat di router</button>` });
    s.$('[data-save]').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.classList.add('busy');
      try {
        const { result } = await api(`/nms/api/customers/${c.customer_id}/create-secret`, { method: 'POST', body: { routerId: s.$('[data-router]').value, profile: s.$('[data-profile]').value, username: s.$('[data-user]').value, password: s.$('[data-pass]').value, notifyPhone: s.$('[data-wa]').value } });
        s.body.innerHTML = `<div class="nx-verdict good">Secret dibuat di ${esc(result.router)}${result.notified ? ' dan kredensial dikirim ke WA teknisi' : ''}.</div><dl class="nx-kv"><dt>Username</dt><dd class="mono">${esc(result.username)}</dd><dt>Password</dt><dd class="mono">${esc(result.password)}</dd><dt>Profile</dt><dd>${esc(result.profile)}</dd></dl><p class="dim" style="font-size:12.5px">Catat password sekarang. Password tidak ditampilkan lagi.</p>`;
        s.foot.innerHTML = '<button type="button" class="nx-btn primary" data-close>Selesai</button>';
        onDone?.(); changed();
      } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  }

  const todayIso = () => new Intl.DateTimeFormat('en-CA', TZ).format(new Date());
  function openHold(r) {
    const d = new Intl.DateTimeFormat('en-CA', TZ).format(new Date(Date.now() + 3 * 86400000));
    const s = sheet({ title: 'Tunda isolir', subtitle: `${esc(who(r))} tidak akan diisolir otomatis sampai tanggal ini.`, size: 'sm',
      body: `<div class="nx-field"><label>Sampai tanggal</label><input type="date" data-until value="${d}" min="${todayIso()}"></div><div class="nx-field"><label>Catatan</label><input type="text" data-note placeholder="Contoh: janji transfer Jumat"></div>`,
      foot: `<button type="button" class="nx-btn ghost" data-clear>Hapus penundaan</button><span class="grow"></span><button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save>Simpan</button>` });
    const save = async until => { try { await api(`/nms/api/secrets/${r.id}/hold`, { method: 'POST', body: { until, note: s.$('[data-note]').value } }); toast(until ? `Isolir ${who(r)} ditunda s.d. ${dateOnly(until)}.` : 'Penundaan dihapus.', 'ok'); s.close(); changed(); } catch (err) { toast(err.message, 'err'); } };
    s.$('[data-save]').addEventListener('click', () => save(s.$('[data-until]').value));
    s.$('[data-clear]').addEventListener('click', () => save(null));
  }

  async function openPackage(r) {
    let pk = []; try { pk = await packages(r.site_id); } catch (_) {}
    const s = sheet({ title: 'Ganti paket', subtitle: `${esc(who(r))} · paket sekarang ${esc(r.package_name || '—')}`, size: 'sm',
      body: `<div class="nx-field"><label>Paket baru</label><select data-pkg>${pk.map(p => `<option value="${p.id}">${esc(p.name)} · ${rupiah(p.price)}${p.mikrotik_profile ? ` · ${esc(p.mikrotik_profile)}` : ' · tanpa profile'}</option>`).join('')}</select></div>
        <div class="nx-field"><label>Berlaku</label><div class="nx-seg sm" data-when><button type="button" class="active" data-v="now">Sekarang</button><button type="button" data-v="later">Tanggal tertentu</button></div></div>
        <div class="nx-field" data-at-wrap hidden><label>Tanggal & jam (WIB)</label><input type="datetime-local" data-at></div>
        <div class="nx-note">Paket di billing ikut berubah, jadi tagihan berikutnya memakai harga paket baru. Profile di router diganti ke profile paket, lalu sesi di-reset agar limit baru langsung berlaku.</div>`,
      foot: `<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save>Simpan</button>` });
    let when = 'now';
    s.$('[data-when]').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; when = b.dataset.v; s.$$('[data-when] button').forEach(x => x.classList.toggle('active', x === b)); s.$('[data-at-wrap]').hidden = when !== 'later'; });
    s.$('[data-save]').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.classList.add('busy');
      try {
        if (when === 'later') { const at = s.$('[data-at]').value; if (!at) throw new Error('Pilih tanggal.'); await api('/nms/api/schedules', { method: 'POST', body: { action: 'package', packageId: s.$('[data-pkg]').value, secretIds: [r.id], runAt: new Date(at).toISOString(), note: `Ganti paket ${who(r)}` } }); toast(`Ganti paket dijadwalkan ${dateTime(new Date(at).toISOString())}.`, 'ok'); }
        else { const { result } = await api(`/nms/api/secrets/${r.id}/package`, { method: 'POST', body: { packageId: s.$('[data-pkg]').value } }); toast(`Paket ${who(r)} → ${result.packageName}.`, 'ok'); }
        s.close(); changed();
      } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  }

  async function openSchedule(ids, label) {
    let pk = []; try { pk = await packages(currentSite || null); } catch (_) {}
    const def = new Date(Date.now() + 86400000); def.setHours(10, 0, 0, 0);
    const local = new Date(def.getTime() - def.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const s = sheet({ title: 'Jadwalkan aksi', subtitle: ids.length > 1 ? `${ids.length} secret dipilih` : esc(label || ''), size: 'sm',
      body: `<div class="nx-field"><label>Aksi</label><select data-act><option value="isolate">Isolir</option><option value="unisolate">Buka isolir</option><option value="kick">Kick sesi</option><option value="profile">Ganti profile</option><option value="package">Ganti paket</option></select></div>
        <div class="nx-field" data-prof-wrap hidden><label>Profile tujuan</label><input type="text" data-prof list="nxProfiles" placeholder="Nama profile di router"><datalist id="nxProfiles"></datalist></div>
        <div class="nx-field" data-pkg-wrap hidden><label>Paket tujuan</label><select data-pkg>${pk.map(p => `<option value="${p.id}">${esc(p.name)}${p.site_code ? ` · ${esc(p.site_code)}` : ''}</option>`).join('')}</select></div>
        <div class="nx-field"><label>Waktu</label><input type="datetime-local" data-at value="${local}"></div>
        <div class="nx-field"><label>Catatan</label><input type="text" data-note placeholder="Opsional"></div>`,
      foot: `<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-save>Jadwalkan</button>` });
    s.$('[data-act]').addEventListener('change', async () => {
      const a = s.$('[data-act]').value; s.$('[data-prof-wrap]').hidden = a !== 'profile'; s.$('[data-pkg-wrap]').hidden = a !== 'package';
      if (a === 'profile' && !s.$('#nxProfiles').childElementCount) { try { const { profiles } = await api(`/nms/api/profiles${withSite()}`); s.$('#nxProfiles').innerHTML = profiles.map(p => `<option value="${esc(p)}">`).join(''); } catch (_) {} }
    });
    s.$('[data-save]').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.classList.add('busy');
      try {
        const at = s.$('[data-at]').value; if (!at) throw new Error('Pilih waktu.');
        const out = await api(`/nms/api/schedules${withSite()}`, { method: 'POST', body: { action: s.$('[data-act]').value, profile: s.$('[data-prof]').value, packageId: s.$('[data-pkg]').value, secretIds: ids, runAt: new Date(at).toISOString(), note: s.$('[data-note]').value } });
        toast(`${out.schedule.count} secret dijadwalkan ${dateTime(out.schedule.runAt)}.`, 'ok', { action: 'Lihat', onAction: () => location.assign(`/nms/automation${withSite()}`) }); s.close(); changed();
      } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
    });
  }

  // ------------------------------------------------------------ Drawer detail pelanggan
  const drawerEl = document.createElement('div');
  drawerEl.className = 'nx-drawer';
  drawerEl.innerHTML = `<div class="scrim" data-dclose></div><aside class="panel" role="dialog" aria-modal="true" aria-label="Detail pelanggan"><div class="nx-drawer-head"><div class="nx-avatar" data-av>?</div><div class="grow" style="min-width:0"><h4 data-dn>—</h4><div class="meta" data-dm></div></div><button type="button" class="nx-x" data-dclose aria-label="Tutup"><i class="bi bi-x-lg"></i></button></div>
    <div class="nx-drawer-tabs"><div class="nx-seg sm" data-dtabs><button type="button" data-t="info" class="active">Ringkasan</button><button type="button" data-t="diag">Diagnosa</button><button type="button" data-t="traffic">Traffic</button><button type="button" data-t="history">Riwayat</button></div></div>
    <div class="nx-drawer-body" data-db></div><div class="nx-drawer-foot" data-df></div></aside>`;
  root.appendChild(drawerEl);
  const D = { id: null, data: null, tab: 'info', trafficTimer: null, samples: [] };
  const $d = sel => drawerEl.querySelector(sel);
  drawerEl.addEventListener('click', e => { if (e.target.closest('[data-dclose]')) closeDrawer(); });
  $d('[data-dtabs]').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b && D.data) showTab(b.dataset.t); });
  function closeDrawer() { drawerEl.classList.remove('show'); stopTraffic(); D.id = null; }
  async function drawer(id, tab = 'info') {
    D.id = id; D.tab = tab; D.samples = [];
    drawerEl.classList.add('show');
    $d('[data-db]').innerHTML = '<div class="nx-empty">Memuat…</div>'; $d('[data-df]').innerHTML = '';
    try { D.data = await api(`/nms/api/secrets/${id}/detail`); } catch (err) { $d('[data-db]').innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; return; }
    if (D.id !== id) return;
    const s = D.data.secret;
    $d('[data-av]').textContent = initials(s.customer_name || s.username);
    $d('[data-dn]').textContent = s.customer_name || s.username;
    $d('[data-dm]').innerHTML = `<span class="nx-state ${s.state}">${{ online: 'Online', offline: 'Offline', isolated: 'Diisolir' }[s.state]}</span> · <span class="mono">${esc(s.username)}</span> · ${esc(s.site_code)} / ${esc(s.router_name)}`;
    renderDrawerFoot();
    showTab(tab);
  }
  function renderDrawerFoot() {
    const s = D.data.secret;
    const b = (a, icon, label, cls = '') => `<button type="button" class="nx-btn sm ${cls}" data-da="${a}"><i class="bi ${icon}"></i>${label}</button>`;
    let html = b('ping', 'bi-activity', 'Ping');
    if (canControl) {
      html += s.is_isolated ? b('unisolate', 'bi-check2-circle', 'Buka isolir', 'green') : b('isolate', 'bi-slash-circle', 'Isolir', 'red');
      html += b('kick', 'bi-plug', 'Kick');
      if (!s.customer_id) html += b('map', 'bi-link-45deg', 'Hubungkan', 'tint');
    }
    html += `<span class="grow"></span>${canControl ? '<button type="button" class="nx-btn sm icon" data-da="more" aria-label="Aksi lain"><i class="bi bi-three-dots"></i></button>' : ''}`;
    $d('[data-df]').innerHTML = html;
  }
  $d('[data-df]').addEventListener('click', e => {
    const btn = e.target.closest('[data-da]'); if (!btn) return;
    const r = rowFromDetail();
    if (btn.dataset.da === 'more') return menu(btn, actionItems(r, { skipView: true }));
    act(r, btn.dataset.da);
  });
  const rowFromDetail = () => ({ ...D.data.secret });
  document.addEventListener('nx:changed', () => { if (D.id && drawerEl.classList.contains('show')) { const id = D.id, tab = D.tab === 'traffic' ? 'info' : D.tab; setTimeout(() => { if (D.id === id) drawer(id, tab); }, 1200); } });

  function showTab(t) {
    D.tab = t; stopTraffic();
    drawerEl.querySelectorAll('[data-dtabs] [data-t]').forEach(x => x.classList.toggle('active', x.dataset.t === t));
    ({ info: tabInfo, diag: tabDiag, traffic: tabTraffic, history: tabHistory }[t] || tabInfo)();
  }
  function tabInfo() {
    const { secret: s, invoices, history7d, scheduled } = D.data;
    const hold = s.isolate_hold_until && String(s.isolate_hold_until).slice(0, 10) >= todayIso();
    const fmtDay = d => new Intl.DateTimeFormat('en-CA', TZ).format(d);
    const byDay = new Map(history7d.map(h => [fmtDay(new Date(h.d)), Number(h.logins) || 0]));
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.now() - (6 - i) * 86400000); return { d, n: byDay.get(fmtDay(d)) || 0 }; });
    const max = Math.max(1, ...days.map(x => x.n));
    const dayName = d => d.toLocaleDateString('id-ID', { ...TZ, weekday: 'short' });
    const bars = `<div style="display:flex;gap:8px;align-items:flex-end;height:64px;margin:4px 0 4px">${days.map(x => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${esc(dateOnly(x.d))}: ${x.n} login"><div style="width:100%;max-width:26px;border-radius:6px;background:${x.n > 5 ? 'var(--x-orange)' : x.n ? 'var(--x-accent)' : 'var(--x-card3)'};height:${x.n ? Math.max(6, x.n / max * 46) : 4}px"></div><small class="dim" style="font-size:10.5px">${esc(dayName(x.d))}</small></div>`).join('')}</div><small class="dim">Jumlah login per hari. Oranye = lebih dari 5 kali (putus-sambung).</small>`;
    const statusLabel = { paid: 'Lunas', unpaid: 'Belum bayar', partial: 'Sebagian', overdue: 'Terlambat' };
    $d('[data-db]').innerHTML = `
      ${hold ? `<div class="nx-verdict warn"><i class="bi bi-hourglass-split"></i> Isolir ditunda s.d. ${esc(dateOnly(s.isolate_hold_until))}${s.isolate_hold_note ? ` · ${esc(s.isolate_hold_note)}` : ''}</div>` : ''}
      ${!s.customer_id ? `<div class="nx-verdict warn">Secret ini belum terhubung ke pelanggan, jadi pemakaiannya tidak tertagih.${canControl ? ` <div style="margin-top:8px;display:flex;gap:6px"><button type="button" class="nx-btn sm tint" data-q="map">Hubungkan</button><button type="button" class="nx-btn sm" data-q="create-customer">Buat pelanggan</button></div>` : ''}</div>` : ''}
      <div class="nx-group-title">Layanan</div>
      <div class="nx-group" style="padding:12px 14px"><dl class="nx-kv" style="margin:0">
        ${s.customer_id ? `<dt>Customer ID</dt><dd><a href="/customers/${s.customer_id}" class="mono" style="color:var(--x-accent)">${esc(s.customer_code)}</a></dd><dt>Paket</dt><dd>${esc(s.package_name || '—')}${s.package_price ? ` · ${rupiah(s.package_price)}` : ''}</dd>` : ''}
        <dt>Profile</dt><dd>${esc(s.profile || '—')}${s.is_isolated && s.original_profile ? ` <span class="dim">(asal ${esc(s.original_profile)})</span>` : ''}</dd>
        <dt>IP</dt><dd class="mono">${esc(s.active_address || s.remote_address || '—')}</dd>
        <dt>MAC</dt><dd class="mono">${esc(s.active_caller_id || s.caller_id || '—')}${s.caller_id ? ' <span class="nx-pill">terkunci</span>' : ''}</dd>
        <dt>Uptime</dt><dd>${esc(s.active_uptime || '—')}</dd>
        <dt>Login terakhir</dt><dd>${esc(dateTime(s.last_login_at))}</dd>
        <dt>Putus terakhir</dt><dd>${esc(dateTime(s.last_logout_at))}</dd>
        ${s.cluster_name ? `<dt>ODP / Cluster</dt><dd>${esc(s.cluster_name)}</dd>` : ''}
        ${s.phone ? `<dt>WhatsApp</dt><dd><a href="https://wa.me/${esc(String(s.phone).replace(/\D/g, '').replace(/^0/, '62'))}" target="_blank" rel="noopener" style="color:var(--x-accent)">${esc(s.phone)}</a></dd>` : ''}
      </dl></div>
      <div class="nx-group-title">Stabilitas</div><div class="nx-group" style="padding:12px 14px">${bars}</div>
      ${invoices.length ? `<div class="nx-group-title">Tagihan</div><ul class="nx-list nx-group">${invoices.map(i => `<li><div class="li-main"><b>${esc(i.invoice_number || `#${i.id}`)}</b><small>Jatuh tempo ${esc(dateOnly(i.due_date))}</small></div><div style="text-align:right"><b style="font-variant-numeric:tabular-nums">${rupiah(i.total)}</b><br><span class="nx-pill ${i.status === 'paid' ? 'green' : i.status === 'overdue' ? 'red' : 'orange'}">${esc(statusLabel[i.status] || i.status)}</span></div></li>`).join('')}</ul>` : ''}
      ${scheduled.length ? `<div class="nx-group-title">Terjadwal</div><ul class="nx-list nx-group">${scheduled.map(x => `<li><span class="li-icon blue"><i class="bi bi-calendar-event"></i></span><div class="li-main"><b>${esc({ isolate: 'Isolir', unisolate: 'Buka isolir', kick: 'Kick sesi', profile: 'Ganti profile', package: 'Ganti paket' }[x.action] || x.action)}${x.profile ? ` → ${esc(x.profile)}` : ''}</b><small>${esc(dateTime(x.run_at))}${x.note ? ` · ${esc(x.note)}` : ''}</small></div></li>`).join('')}</ul>` : ''}`;
    $d('[data-db]').querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => act(rowFromDetail(), b.dataset.q)));
  }
  async function tabDiag() {
    const body = $d('[data-db]');
    body.innerHTML = '<div class="nx-empty"><i class="bi bi-heart-pulse"></i>Memeriksa router, secret, sesi, ping, log, dan tagihan…</div>';
    const id = D.id;
    try {
      const { result } = await api(`/nms/api/secrets/${id}/diagnose`, { method: 'POST', body: {} });
      if (D.id !== id || D.tab !== 'diag') return;
      const bad = result.checks.some(c => c.status === 'fail'), warn = result.checks.some(c => c.status === 'warn');
      const icon = { ok: 'bi-check-lg', fail: 'bi-x-lg', warn: 'bi-exclamation-lg', info: 'bi-info-lg' };
      const fixLabel = { unisolate: 'Buka isolir', 'unlock-mac': 'Lepas MAC', ticket: 'Buat tiket' };
      body.innerHTML = `<div class="nx-verdict ${bad ? 'bad' : warn ? 'warn' : 'good'}">${esc(result.verdict)}</div>
        <ul class="nx-checks nx-group">${result.checks.map(c => `<li class="${c.status}"><span class="ic"><i class="bi ${icon[c.status]}"></i></span><div class="grow"><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div>${c.fix && canControl && fixLabel[c.fix] ? `<button type="button" class="nx-btn sm tint" data-fix="${c.fix}">${fixLabel[c.fix]}</button>` : ''}</li>`).join('')}</ul>
        <div style="display:flex;justify-content:space-between;align-items:center"><small class="dim">Dicek ${esc(hhmmss(result.testedAt))}</small><button type="button" class="nx-btn sm" data-rerun><i class="bi bi-arrow-clockwise"></i>Cek ulang</button></div>`;
      body.querySelector('[data-rerun]').addEventListener('click', tabDiag);
      body.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', () => act(rowFromDetail(), b.dataset.fix)));
    } catch (err) { if (D.id === id) body.innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; }
  }
  function stopTraffic() { clearInterval(D.trafficTimer); D.trafficTimer = null; }
  function tabTraffic() {
    const s = D.data.secret, body = $d('[data-db]'), c = COLORS();
    if (s.state !== 'online') { body.innerHTML = '<div class="nx-empty"><i class="bi bi-wifi-off"></i>Pelanggan sedang offline. Traffic live hanya bisa diukur saat ada sesi aktif.</div>'; return; }
    body.innerHTML = `<div class="nx-traffic-read"><div><small><i style="background:${c.blue}"></i>Download</small><strong data-dl>—</strong></div><div><small><i style="background:${c.green}"></i>Upload</small><strong data-ul>—</strong></div><div class="peak"><small>Puncak download</small><strong data-pk>—</strong></div></div>
      <div class="nx-chart" data-chart style="height:170px"></div><div class="nx-traffic-foot"><span data-st>Mengukur 30 detik…</span><span class="grow"></span><button type="button" class="nx-btn sm" data-again hidden><i class="bi bi-play-fill"></i>Ukur lagi</button></div>`;
    const start = () => {
      D.samples = []; body.querySelector('[data-again]').hidden = true; body.querySelector('[data-st]').textContent = 'Mengukur 30 detik…';
      const t0 = Date.now(), id = D.id;
      const once = async () => {
        if (D.id !== id || D.tab !== 'traffic') return stopTraffic();
        if (Date.now() - t0 > 30000) { stopTraffic(); body.querySelector('[data-st]').textContent = `Selesai · ${D.samples.length} sampel`; body.querySelector('[data-again]').hidden = false; return; }
        try {
          const { sample } = await api(`/nms/api/secrets/${id}/traffic`);
          if (D.id !== id || D.tab !== 'traffic') return;
          D.samples.push(sample);
          const [dv, du] = splitBps(sample.downloadBps), [uv, uu] = splitBps(sample.uploadBps);
          body.querySelector('[data-dl]').innerHTML = `${dv}<span>${du}</span>`; body.querySelector('[data-ul]').innerHTML = `${uv}<span>${uu}</span>`;
          body.querySelector('[data-pk]').textContent = fmtBps(Math.max(...D.samples.map(x => x.downloadBps)));
          areaChart(body.querySelector('[data-chart]'), { times: D.samples.map(x => x.at), series: [{ name: 'Download', color: c.blue, values: D.samples.map(x => x.downloadBps) }, { name: 'Upload', color: c.green, values: D.samples.map(x => x.uploadBps) }] });
        } catch (err) { if (err.status !== 429) { stopTraffic(); body.querySelector('[data-st]').textContent = err.message; body.querySelector('[data-again]').hidden = false; } }
      };
      once(); D.trafficTimer = setInterval(once, 1500);
    };
    body.querySelector('[data-again]').addEventListener('click', start);
    start();
  }
  async function tabHistory() {
    const body = $d('[data-db]'), id = D.id;
    body.innerHTML = '<div class="nx-empty">Memuat riwayat…</div>';
    try {
      const { items } = await api(`/nms/api/secrets/${id}/timeline`);
      if (D.id !== id || D.tab !== 'history') return;
      const label = { login: 'Login', logout: 'Putus', auth_failed: 'Login ditolak' };
      body.innerHTML = items.length ? `<ul class="nx-timeline">${items.map(i => `<li class="${i.kind === 'action' ? 'action' : esc(i.action)}"><b>${esc(i.kind === 'event' ? (label[i.action] || i.action) : i.text)}</b><small>${esc(dateTime(i.at))} · ${esc(i.kind === 'event' ? [i.address, i.callerId].filter(Boolean).join(' · ') || 'router' : i.user)}</small>${i.canRevert && canControl ? `<button type="button" class="nx-btn sm tint" style="margin-top:6px" data-revert="${i.id}"><i class="bi bi-arrow-counterclockwise"></i>Kembalikan ke sebelumnya</button>` : ''}</li>`).join('')}</ul>` : '<div class="nx-empty">Belum ada riwayat.</div>';
      body.querySelectorAll('[data-revert]').forEach(b => b.addEventListener('click', async () => {
        if (!(await confirmBox({ title: 'Kembalikan aksi terakhir?', okText: 'Kembalikan', message: 'Aksi terakhir pada secret ini dibalik (isolir → buka isolir, ganti profile → profile sebelumnya, dan seterusnya). Perintah langsung dikirim ke router.' }))) return;
        b.classList.add('busy');
        try { const out = await api(`/nms/api/audit/${b.dataset.revert}/revert`, { method: 'POST', body: {} }); toast(`Dikembalikan (${out.action}).`, 'ok'); changed(); tabHistory(); } catch (err) { toast(err.message, 'err'); b.classList.remove('busy'); }
      }));
    } catch (err) { if (D.id === id) body.innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; }
  }

  // ------------------------------------------------------------ Palette (Ctrl/Cmd+K)
  const pal = document.createElement('div');
  pal.className = 'nx-palette';
  pal.innerHTML = `<div class="nx-palette-box" role="dialog" aria-label="Cari"><div class="nx-palette-in"><i class="bi bi-search"></i><input type="text" placeholder="Cari nama, Customer ID, username, IP, HP…" aria-label="Cari" autocomplete="off"></div><div class="nx-palette-list"></div>
    <div class="nx-palette-foot"><span><kbd>↑↓</kbd> pilih</span><span><kbd>Enter</kbd> detail</span>${canControl ? '<span><kbd>Alt I</kbd> isolir</span><span><kbd>Alt U</kbd> buka</span><span><kbd>Alt K</kbd> kick</span>' : ''}<span><kbd>Alt P</kbd> ping</span><span><kbd>Esc</kbd> tutup</span></div></div>`;
  root.appendChild(pal);
  const palIn = pal.querySelector('input'), palList = pal.querySelector('.nx-palette-list');
  const COMMANDS = [
    { label: 'Smart Sync', hint: 'Cocokkan secret dengan data pelanggan', icon: 'bi-magic', run: () => location.assign(`/nms/secrets${qs({ site: currentSite || undefined, tab: 'unsynced', sync: 1 })}`) },
    { label: 'Rekonsiliasi billing ↔ router', hint: 'Kebocoran pendapatan & salah isolir', icon: 'bi-arrow-left-right', run: () => location.assign(`/nms/insights${withSite()}`) },
    { label: 'Otomasi & jadwal', hint: 'Persetujuan, jadwal, pengaturan', icon: 'bi-clock-history', run: () => location.assign(`/nms/automation${withSite()}`) },
    { label: 'Ringkasan jaringan', hint: 'Traffic, router, live log', icon: 'bi-speedometer2', run: () => location.assign(`/nms${withSite()}`) },
    { label: 'Ekspor secret ter-link (CSV)', hint: 'Unduh untuk laporan', icon: 'bi-download', run: () => location.assign(`/nms/api/export${qs({ site: currentSite || undefined, kind: 'synced' })}`) }
  ];
  let palRows = [], palIdx = 0, palTimer = null, palMode = 'cmd';
  const stateLabel = { online: 'Online', offline: 'Offline', isolated: 'Isolir' };
  function renderPal() {
    if (palMode === 'cmd') palList.innerHTML = `<div class="dim" style="padding:8px 12px 4px;font-size:12px;font-weight:600">Perintah</div>${COMMANDS.map((c, i) => `<div class="nx-palette-item ${i === palIdx ? 'on' : ''}" data-i="${i}"><span class="li-icon"><i class="bi ${c.icon}"></i></span><div class="li-main"><b>${esc(c.label)}</b><small>${esc(c.hint)}</small></div></div>`).join('')}`;
    else palList.innerHTML = palRows.length ? palRows.map((r, i) => `<div class="nx-palette-item ${i === palIdx ? 'on' : ''}" data-i="${i}"><span class="nx-avatar" style="width:32px;height:32px;font-size:12px">${esc(initials(r.customer_name || r.username))}</span><div class="li-main"><b>${esc(r.customer_name || r.username)}</b><small><span class="mono">${esc(r.username)}</span> · ${esc(r.site_code)}${r.active_address ? ' · ' + esc(r.active_address) : ''}</small></div><span class="nx-state ${r.state}">${stateLabel[r.state]}</span></div>`).join('') : '<div class="nx-empty">Tidak ada hasil.</div>';
  }
  function openPalette() { pal.classList.add('show'); palIn.value = ''; palMode = 'cmd'; palIdx = 0; renderPal(); setTimeout(() => palIn.focus(), 30); }
  function closePalette() { pal.classList.remove('show'); }
  palIn.addEventListener('input', () => {
    clearTimeout(palTimer);
    const q = palIn.value.trim();
    if (q.length < 2) { palMode = 'cmd'; palIdx = 0; renderPal(); return; }
    palTimer = setTimeout(async () => { try { ({ rows: palRows } = await api(`/nms/api/palette${qs({ q, site: currentSite || undefined })}`)); palMode = 'rows'; palIdx = 0; renderPal(); } catch (_) {} }, 160);
  });
  palIn.addEventListener('keydown', e => {
    const len = palMode === 'cmd' ? COMMANDS.length : palRows.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palIdx = (palIdx + (e.key === 'ArrowDown' ? 1 : -1) + len) % Math.max(1, len); renderPal(); palList.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); return; }
    if (e.key === 'Escape') return closePalette();
    if (palMode === 'cmd') { if (e.key === 'Enter') { e.preventDefault(); closePalette(); COMMANDS[palIdx]?.run(); } return; }
    const r = palRows[palIdx]; if (!r) return;
    const key = (e.code || '').startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    const a = e.key === 'Enter' ? 'detail' : e.altKey ? { i: 'isolate', u: 'unisolate', k: 'kick', p: 'ping', d: 'diagnose' }[key] : null;
    if (!a) return;
    e.preventDefault(); closePalette();
    act({ ...r, is_isolated: r.state === 'isolated' }, a);
  });
  palList.addEventListener('click', e => { const it = e.target.closest('[data-i]'); if (!it) return; closePalette(); if (palMode === 'cmd') COMMANDS[Number(it.dataset.i)]?.run(); else act(palRows[Number(it.dataset.i)], 'detail'); });
  pal.addEventListener('click', e => { if (e.target === pal) closePalette(); });
  document.getElementById('nxOpenPalette')?.addEventListener('click', openPalette);

  function showShortcuts() {
    const k = isMac ? '⌘' : 'Ctrl';
    sheet({ title: 'Pintasan keyboard', size: 'sm', body: `<div class="nx-shortcuts">
      <kbd>${k} K</kbd><span>Cari pelanggan & perintah</span><kbd>/</kbd><span>Fokus ke kolom cari tabel</span><kbd>↑ ↓</kbd><span>Pindah baris di tabel</span><kbd>Spasi / X</kbd><span>Pilih baris</span><kbd>Shift + klik</kbd><span>Pilih rentang baris</span>
      <kbd>Enter</kbd><span>Buka detail</span><kbd>P</kbd><span>Ping</span><kbd>D</kbd><span>Diagnosa</span>${canControl ? '<kbd>I</kbd><span>Isolir</span><kbd>U</kbd><span>Buka isolir</span><kbd>K</kbd><span>Kick sesi</span><kbd>S</kbd><span>Smart Sync</span>' : ''}<kbd>Esc</kbd><span>Tutup / batal pilih</span><kbd>?</kbd><span>Bantuan ini</span></div>` });
  }
  document.getElementById('nxShortcuts')?.addEventListener('click', showShortcuts);
  // Capture phase: menimpa palette global aplikasi selama berada di halaman NMS.
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopImmediatePropagation(); pal.classList.contains('show') ? closePalette() : openPalette(); return; }
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    if (e.key === 'Escape' && !document.querySelector('.nx-sheet.show')) { if (pal.classList.contains('show')) closePalette(); else if (drawerEl.classList.contains('show')) { e.stopImmediatePropagation(); closeDrawer(); } }
  }, true);
  const drawerOpen = () => drawerEl.classList.contains('show') || pal.classList.contains('show') || !!document.querySelector('.nx-sheet.show');

  window.NX = { root, csrf, canControl, isAdmin, site: currentSite, esc, fmtBps, splitBps, fmtBytes, fmtUptime, rupiah, ago, hhmm, hhmmss, dateTime, dateOnly, todayIso, tone, COLORS, initials, qs, withSite,
    api, toast, deferred, sheet, confirmBox, menu, ring, areaChart, markUpdated, setOffline, setLive, stream, changed, act, actionItems, pingBadge, drawer, drawerOpen, openMap, openCreateCustomer, openCreateSecret, openSchedule, openHold, openPalette, loadBadges };
  window.NMS = window.NX; // kompatibilitas modul lama
})();
