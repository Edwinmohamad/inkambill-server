// NMS v2 shared client helpers (dashboard + secrets). Tanpa dependency.
(() => {
  const root = document.querySelector('.nms-noc');
  if (!root) return;
  const csrf = root.dataset.csrf;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtBps = bps => { const n = Number(bps) || 0; if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`; if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`; if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`; return `${n} bps`; };
  const fmtBytes = b => { const n = Number(b) || 0; if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)}G`; if (n >= 1048576) return `${(n / 1048576).toFixed(0)}M`; return `${(n / 1024).toFixed(0)}K`; };
  const fmtUptime = s => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
  const ago = iso => { if (!iso) return '—'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return `${Math.round(s)}s ago`; if (s < 3600) return `${Math.round(s / 60)} mins ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };
  const hhmmss = iso => new Date(iso).toLocaleTimeString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' });
  const tone = pct => pct == null ? 'gray' : pct > 80 ? 'red' : pct >= 60 ? 'yellow' : 'green';

  async function api(url, { method = 'GET', body = null } = {}) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : null });
    let data = null; try { data = await res.json(); } catch (_) { throw new Error(res.status === 403 ? 'Akses ditolak / sesi CSRF kedaluwarsa — refresh halaman.' : `HTTP ${res.status}`); }
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
    return data;
  }

  function toast(message, kind = 'info') {
    const box = document.getElementById('nmsToasts') || root.appendChild(Object.assign(document.createElement('div'), { id: 'nmsToasts', className: 'nms-toasts' }));
    const el = document.createElement('div');
    el.className = `nms-toast ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4000);
  }

  // Modal minimal (tidak bergantung Bootstrap JS).
  function modal(id) {
    const el = document.getElementById(id);
    const api = { el, open() { el.classList.add('show'); el.querySelector('[autofocus]')?.focus(); }, close() { el.classList.remove('show'); } };
    if (el && !el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) api.close(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') api.close(); });
    }
    return api;
  }
  function confirmBox({ title, message, okText = 'Lanjutkan', danger = false }) {
    return new Promise(resolve => {
      let el = document.getElementById('nmsConfirm');
      if (!el) {
        el = document.createElement('div'); el.id = 'nmsConfirm'; el.className = 'nms-modal';
        el.innerHTML = `<div class="nms-modal-box sm" role="dialog" aria-modal="true"><div class="nms-modal-head"><h4></h4><button type="button" data-close aria-label="Tutup">&times;</button></div><div class="nms-modal-body"></div><div class="nms-modal-foot"><button type="button" class="nms-btn" data-close>Batal</button><button type="button" class="nms-btn" data-ok></button></div></div>`;
        root.appendChild(el);
      }
      el.querySelector('h4').textContent = title;
      el.querySelector('.nms-modal-body').innerHTML = message;
      const ok = el.querySelector('[data-ok]');
      ok.textContent = okText; ok.className = `nms-btn ${danger ? 'red' : 'primary'}`;
      const m = modal('nmsConfirm');
      const done = v => { m.close(); ok.onclick = null; el.removeEventListener('click', onClose); resolve(v); };
      const onClose = e => { if (e.target === el || e.target.closest('[data-close]')) done(false); };
      el.addEventListener('click', onClose);
      ok.onclick = () => done(true);
      m.open(); ok.focus();
    });
  }

  // Global Select Site — mengubah ?site= (server & SSE ikut terfilter), diingat per browser.
  const siteSelect = document.getElementById('nmsSiteSelect');
  const currentSite = root.dataset.site || '';
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
  const tick = () => { if (clock) clock.textContent = `${new Date().toLocaleTimeString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' })} WIB`; };
  tick(); setInterval(tick, 1000);

  let lastUpdated = null;
  const updatedEl = document.getElementById('nmsUpdated');
  function markUpdated(iso) { lastUpdated = iso || new Date().toISOString(); renderUpdated(); }
  function renderUpdated() { if (updatedEl) updatedEl.textContent = `Last Updated: ${ago(lastUpdated)}`; }
  setInterval(renderUpdated, 5000);

  function setOffline(show) { document.getElementById('nmsOfflineBadge')?.classList.toggle('show', !!show); }
  function setLive(stateName) {
    const el = document.getElementById('nmsLive'); if (!el) return;
    const map = { live: ['green', 'LIVE'], polling: ['yellow', 'POLLING'], down: ['red', 'DISCONNECTED'], connecting: ['yellow', 'CONNECTING'] };
    const [cls, label] = map[stateName] || map.connecting;
    el.className = `nms-pill ${cls}`; el.querySelector('span').textContent = label;
  }

  // SSE dengan fallback polling bila EventSource gagal (proxy lama / jaringan buruk).
  function stream(handlers, { fallback, fallbackMs = 20000 } = {}) {
    let es = null, pollTimer = null, retries = 0;
    const startPolling = () => { if (pollTimer || !fallback) return; setLive('polling'); pollTimer = setInterval(() => fallback().catch(() => setLive('down')), fallbackMs); };
    const connect = () => {
      if (!window.EventSource) return startPolling();
      es = new EventSource(`/nms/api/stream${currentSite ? `?site=${encodeURIComponent(currentSite)}` : ''}`);
      es.onopen = () => { retries = 0; setLive('live'); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
      es.onerror = () => { setLive('connecting'); if (++retries >= 3) { es.close(); startPolling(); setTimeout(() => { retries = 0; connect(); }, 60000); } };
      Object.entries(handlers).forEach(([evt, fn]) => es.addEventListener(evt, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.warn('NMS SSE', evt, err); } }));
    };
    connect();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && fallback) fallback().catch(() => {}); });
  }

  window.NMS = { root, csrf, esc, fmtBps, fmtBytes, fmtUptime, ago, hhmmss, tone, api, toast, modal, confirmBox, markUpdated, setOffline, setLive, stream, site: currentSite, canControl: root.dataset.canControl === '1' };
})();
