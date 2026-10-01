// Tata letak dashboard NMS: kartu bisa diseret untuk pindah posisi dan ditarik sudutnya untuk ubah ukuran.
// Layout disimpan per user di server (/nms/api/layout) + cache di browser supaya tampil instan.
// Admin bisa menjadikan layout-nya default untuk semua user yang belum punya layout sendiri (dan layar TV).
// API: window.NXLayout.init({ app, onApply }) → { layout, toggleEdit, exitEdit, isEditing, widgets }
(() => {
  const WIDTHS = [3, 4, 6, 8, 12];
  const CACHE_KEY = 'nx-dash-layout-v2';
  const OLD_KEY = 'nx-dash-layout-v1';
  const SNAP_H = 20, MIN_H = 160;
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => window.matchMedia?.('(max-width: 760px)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const readCache = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
  const writeCache = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} };

  // Preset siap pakai. Kunci widget yang tidak disebut tetap ikut, di urutan belakang.
  const PRESETS = {
    noc: { label: 'NOC (lengkap)', order: ['sites', 'routers', 'traffic', 'activity', 'leak', 'attention', 'flapping', 'outages', 'sync', 'agenda', 'log'], hidden: [], sizes: {} },
    teknisi: { label: 'Teknisi lapangan', order: ['routers', 'outages', 'flapping', 'log', 'traffic', 'attention', 'sites'], hidden: ['leak', 'sync', 'agenda', 'activity'], sizes: { outages: { w: 6 }, flapping: { w: 6 } } },
    ringkas: { label: 'Ringkas', order: ['sites', 'attention', 'outages', 'traffic', 'routers'], hidden: ['activity', 'leak', 'flapping', 'sync', 'agenda', 'log'], sizes: { attention: { w: 6 }, outages: { w: 6 } } }
  };

  function init({ app, onApply = () => {} }) {
    const N = window.NX;
    const wrap = document.getElementById('nxWidgets');
    const esc = N?.esc || (s => String(s ?? ''));
    const widgets = () => [...wrap.querySelectorAll(':scope > .nx-w')];
    const byKey = k => wrap.querySelector(`:scope > .nx-w[data-w="${k}"]`);
    // Ukuran bawaan diambil dari class c-* di template.
    const baseW = {};
    widgets().forEach(w => { const m = w.className.match(/\bc-(\d+)\b/); baseW[w.dataset.w] = m ? Number(m[1]) : 12; });
    const defaultOrder = widgets().map(w => w.dataset.w);
    const builtIn = () => ({ v: 2, order: [...defaultOrder], hidden: [], sizes: {}, mascot: true, rotate: 20 });

    function normalize(raw) {
      const base = builtIn();
      const l = { ...base, ...(raw || {}) };
      l.order = [...(l.order || []).filter(k => defaultOrder.includes(k)), ...defaultOrder.filter(k => !(l.order || []).includes(k))];
      l.hidden = (l.hidden || []).filter(k => defaultOrder.includes(k));
      l.sizes = Object.fromEntries(Object.entries(l.sizes || {}).filter(([k]) => defaultOrder.includes(k)));
      l.mascot = l.mascot !== false;
      l.rotate = Number.isFinite(Number(l.rotate)) ? Number(l.rotate) : 20;
      return l;
    }
    // Migrasi dari layout lama (v1, hanya urutan + sembunyi, per browser).
    const old = readCache(OLD_KEY);
    let layout = normalize(readCache(CACHE_KEY) || (old ? { order: old.order, hidden: old.hidden, mascot: old.mascot, rotate: old.rotate } : null));
    let serverDefault = null;
    let editing = false;

    // ---------- Terapkan layout ke DOM ----------
    const widthOf = k => layout.sizes[k]?.w || baseW[k] || 12;
    function paintSizes(el) {
      const k = el.dataset.w, w = widthOf(k), h = layout.sizes[k]?.h || 0;
      el.classList.remove(...WIDTHS.map(n => `c-${n}`)); el.classList.add(`c-${w}`);
      el.style.height = h ? `${h}px` : ''; el.classList.toggle('nx-fixed-h', !!h);
      const chip = el.querySelector(':scope > .nx-w-tools [data-size]');
      if (chip) chip.textContent = `${w}/12${h ? ` · ${h}px` : ''}`;
    }
    function apply({ animate = false } = {}) {
      const before = animate ? snapshot() : null;
      layout.order.forEach(k => { const el = byKey(k); if (el) wrap.appendChild(el); });
      widgets().forEach(el => { el.style.order = ''; el.hidden = layout.hidden.includes(el.dataset.w); paintSizes(el); });
      if (before) flip(before);
      renderHiddenTray();
      onApply(layout);
    }

    // ---------- Simpan ----------
    let saveT = null;
    function save() {
      writeCache(CACHE_KEY, layout);
      clearTimeout(saveT);
      saveT = setTimeout(() => { N?.api('/nms/api/layout', { method: 'PUT', body: { layout } }).catch(err => N?.toast(`Tata letak belum tersimpan di server: ${err.message}`, 'err')); }, 700);
    }
    async function loadServer() {
      try {
        const res = await N.api('/nms/api/layout');
        serverDefault = res.defaultLayout ? normalize(res.defaultLayout) : null;
        const next = res.layout || res.defaultLayout;
        if (next) { layout = normalize(next); writeCache(CACHE_KEY, layout); apply(); }
        else if (old && !readCache(CACHE_KEY + '-migrated')) { writeCache(CACHE_KEY + '-migrated', 1); save(); }
      } catch (_) { /* tetap pakai cache browser */ }
    }

    // ---------- Animasi FLIP: kartu lain bergeser halus saat posisi berubah ----------
    function snapshot() { const m = new Map(); widgets().forEach(el => { if (!el.hidden && !el.classList.contains('nx-dragging')) m.set(el, el.getBoundingClientRect()); }); return m; }
    function flip(before) {
      if (reduce()) return;
      before.forEach((r0, el) => {
        if (el.hidden || el.classList.contains('nx-dragging')) return;
        const r1 = el.getBoundingClientRect();
        const dx = r0.left - r1.left, dy = r0.top - r1.top, sx = r0.width / (r1.width || 1), sy = r0.height / (r1.height || 1);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) return;
        el.animate([{ transformOrigin: 'top left', transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { transformOrigin: 'top left', transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    }

    // ---------- Mode edit ----------
    const bar = document.createElement('div');
    bar.className = 'nx-editbar'; bar.hidden = true;
    bar.innerHTML = `<div class="nx-editbar-main"><b>Mode atur tata letak</b><span class="dim nx-hide-sm">Seret kartu untuk memindah · tarik sudut kanan bawah untuk mengubah ukuran · klik ganda sudut untuk tinggi otomatis</span></div>
      <div class="nx-editbar-tray" data-tray></div>
      <div class="nx-editbar-actions">
        <select class="nx-select sm" data-preset aria-label="Preset tata letak"><option value="">Preset…</option>${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
        <button type="button" class="nx-btn sm ghost" data-settings><i class="bi bi-gear"></i><span class="nx-hide-sm">Opsi</span></button>
        <button type="button" class="nx-btn sm ghost" data-reset><i class="bi bi-arrow-counterclockwise"></i><span class="nx-hide-sm">Reset</span></button>
        ${N?.isAdmin ? '<button type="button" class="nx-btn sm ghost" data-default title="Pakai layout ini untuk semua user yang belum mengatur sendiri dan layar TV"><i class="bi bi-display"></i><span class="nx-hide-sm">Jadikan default</span></button>' : ''}
        <button type="button" class="nx-btn sm primary" data-done><i class="bi bi-check2"></i>Selesai</button>
      </div>`;
    wrap.parentNode.insertBefore(bar, wrap);

    function renderHiddenTray() {
      const tray = bar.querySelector('[data-tray]');
      const hid = layout.hidden.map(k => byKey(k)).filter(Boolean);
      tray.innerHTML = hid.length ? `<span class="dim">Tersembunyi:</span>${hid.map(el => `<button type="button" class="nx-chip sm" data-show="${el.dataset.w}"><i class="bi bi-plus"></i>${esc(el.dataset.title || el.dataset.w)}</button>`).join('')}` : '';
    }
    function addTools(el) {
      if (el.querySelector(':scope > .nx-w-tools')) return;
      const t = document.createElement('div');
      t.className = 'nx-w-tools';
      t.innerHTML = `<button type="button" class="nx-w-grip" data-grip aria-label="Seret untuk memindah ${esc(el.dataset.title || '')}"><i class="bi bi-grip-vertical"></i><span>${esc(el.dataset.title || el.dataset.w)}</span></button>
        <span class="nx-w-size" data-size></span>
        <button type="button" class="nx-w-hide" data-hide aria-label="Sembunyikan"><i class="bi bi-eye-slash"></i></button>
        <span class="nx-w-resize" data-resize aria-hidden="true"></span>`;
      el.appendChild(t);
      paintSizes(el);
    }
    function setEdit(on) {
      if (on && app.classList.contains('noc-tv')) return;
      editing = on;
      app.classList.toggle('nx-editing', on);
      bar.hidden = !on;
      widgets().forEach(el => on ? addTools(el) : el.querySelector(':scope > .nx-w-tools')?.remove());
      const btn = document.getElementById('nxCustomize');
      if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); }
      if (!on) document.dispatchEvent(new CustomEvent('nx:layout-done'));
    }
    // Saat mode edit, klik di dalam kartu tidak membuka link/detail.
    wrap.addEventListener('click', e => {
      if (!editing) return;
      if (e.target.closest('.nx-w-tools')) return;
      e.preventDefault(); e.stopPropagation();
    }, true);
    wrap.addEventListener('click', e => {
      const hide = e.target.closest('[data-hide]');
      if (hide) { const k = hide.closest('.nx-w').dataset.w; const before = snapshot(); layout.hidden = [...new Set([...layout.hidden, k])]; apply(); flip(before); save(); }
    });
    wrap.addEventListener('dblclick', e => {
      const rz = e.target.closest('[data-resize]'); if (!rz) return;
      const k = rz.closest('.nx-w').dataset.w; const before = snapshot();
      layout.sizes[k] = { ...(layout.sizes[k] || {}) }; delete layout.sizes[k].h;
      paintSizes(byKey(k)); flip(before); onApply(layout); save();
    });
    bar.addEventListener('click', e => {
      const show = e.target.closest('[data-show]');
      if (show) { const before = snapshot(); layout.hidden = layout.hidden.filter(k => k !== show.dataset.show); apply(); flip(before); save(); byKey(show.dataset.show)?.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'center' }); return; }
      if (e.target.closest('[data-done]')) { setEdit(false); N?.toast('Tata letak tersimpan.', 'ok'); return; }
      if (e.target.closest('[data-reset]')) { resetLayout(); return; }
      if (e.target.closest('[data-default]')) { saveDefault(); return; }
      if (e.target.closest('[data-settings]')) openSettings();
    });
    bar.querySelector('[data-preset]').addEventListener('change', e => {
      const p = PRESETS[e.target.value]; e.target.value = ''; if (!p) return;
      const before = snapshot();
      layout = normalize({ ...layout, order: p.order, hidden: p.hidden, sizes: JSON.parse(JSON.stringify(p.sizes)) });
      apply(); flip(before); save(); N?.toast(`Preset "${p.label}" dipakai.`, 'ok');
    });
    async function resetLayout() {
      const before = snapshot();
      try { await N.api('/nms/api/layout', { method: 'DELETE' }); } catch (_) {}
      layout = normalize(serverDefault || builtIn());
      writeCache(CACHE_KEY, layout); apply(); flip(before);
      N?.toast(serverDefault ? 'Kembali ke layout default dari Admin.' : 'Tata letak dikembalikan.', 'ok');
    }
    async function saveDefault() {
      try { const res = await N.api('/nms/api/layout/default', { method: 'PUT', body: { layout } }); serverDefault = normalize(res.layout); N.toast('Layout ini sekarang jadi default untuk user lain dan layar TV.', 'ok'); }
      catch (err) { N?.toast(err.message, 'err'); }
    }
    function openSettings() {
      const s = N.sheet({ title: 'Opsi dashboard', size: 'sm',
        body: `<ul class="nx-list nx-group">
          <li><div class="li-main"><b>Maskot Nexi</b><small>Bisa diambil dan dilempar dengan kursor, lalu hinggap di kartu. Klik ganda untuk memanggil pulang.</small></div><label class="nx-switch"><input type="checkbox" data-mascot ${layout.mascot ? 'checked' : ''}><span></span></label></li>
          <li><div class="li-main"><b>Ganti panel layar penuh</b><small>Detik per panel di mode layar penuh.</small></div><select data-rotate style="width:auto">${[0, 15, 20, 30, 60].map(v => `<option value="${v}" ${Number(layout.rotate) === v ? 'selected' : ''}>${v ? `${v} detik` : 'Tidak berganti'}</option>`).join('')}</select></li></ul>`,
        foot: '<span class="grow"></span><button type="button" class="nx-btn primary" data-close>Selesai</button>' });
      s.$('[data-mascot]').addEventListener('change', e => { layout.mascot = e.target.checked; apply(); save(); });
      s.$('[data-rotate]').addEventListener('change', e => { layout.rotate = Number(e.target.value); save(); onApply(layout); });
    }

    // ---------- Seret untuk memindah ----------
    let drag = null;
    function startDrag(el, ev) {
      const r = el.getBoundingClientRect();
      const ph = document.createElement('div');
      ph.className = `nx-w nx-w-ph ${[...el.classList].filter(c => /^c-\d+$/.test(c)).join(' ')}`;
      ph.style.height = `${r.height}px`;
      el.before(ph);
      drag = { el, ph, dx: ev.clientX - r.left, dy: ev.clientY - r.top, x: ev.clientX, y: ev.clientY, lastSwap: 0, raf: 0, fx: 0, fy: 0 };
      Object.assign(el.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 60, margin: 0 });
      el.classList.add('nx-dragging');
      // Koreksi bila ada ancestor ber-transform (position:fixed jadi relatif ke ancestor itu).
      const r2 = el.getBoundingClientRect(); drag.fx = r2.left - r.left; drag.fy = r2.top - r.top;
      document.body.classList.add('nx-drag-active');
      tick();
    }
    function moveDrag(ev) {
      if (!drag) return;
      drag.x = ev.clientX; drag.y = ev.clientY;
      const el = drag.el;
      const tilt = clamp((ev.movementX || 0) * .35, -3, 3);
      el.style.left = `${drag.x - drag.dx - drag.fx}px`; el.style.top = `${drag.y - drag.dy - drag.fy}px`;
      el.style.transform = `rotate(${tilt}deg) scale(1.01)`;
      const now = performance.now(); if (now - drag.lastSwap < 90) return;
      // Cari kartu di bawah kursor, lalu taruh placeholder sebelum/sesudahnya.
      const target = widgets().find(w => {
        if (w === el || w === drag.ph || w.hidden) return false;
        const b = w.getBoundingClientRect();
        return drag.x >= b.left && drag.x <= b.right && drag.y >= b.top && drag.y <= b.bottom;
      });
      if (!target) return;
      const b = target.getBoundingClientRect();
      const sameRow = b.width < wrap.clientWidth * .9;
      const after = sameRow ? drag.x > b.left + b.width / 2 : drag.y > b.top + b.height / 2;
      const ref = after ? target.nextElementSibling : target;
      if (ref === drag.ph || (after && target.nextElementSibling === drag.ph) || (!after && target.previousElementSibling === drag.ph)) return;
      const before = snapshot();
      wrap.insertBefore(drag.ph, ref);
      flip(before);
      drag.lastSwap = now;
    }
    // Scroll otomatis saat kartu diseret mendekati tepi layar.
    function tick() {
      if (!drag) return;
      const edge = 70, H = window.innerHeight;
      const scroller = app.classList.contains('noc-tv') ? app : window;
      if (drag.y < edge) scroller.scrollBy(0, -Math.ceil((edge - drag.y) / 4));
      else if (drag.y > H - edge) scroller.scrollBy(0, Math.ceil((drag.y - (H - edge)) / 4));
      drag.raf = requestAnimationFrame(tick);
    }
    function endDrag() {
      if (!drag) return;
      const { el, ph } = drag; cancelAnimationFrame(drag.raf);
      const from = el.getBoundingClientRect(), to = ph.getBoundingClientRect();
      ph.replaceWith(el);
      el.classList.remove('nx-dragging'); document.body.classList.remove('nx-drag-active');
      Object.assign(el.style, { position: '', left: '', top: '', width: '', height: '', zIndex: '', margin: '', transform: '' });
      paintSizes(el);
      if (!reduce()) el.animate([{ transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(1.01)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      drag = null;
      layout.order = widgets().map(w => w.dataset.w);
      save(); onApply(layout);
    }

    // ---------- Tarik sudut untuk ubah ukuran ----------
    let rs = null;
    function startResize(el, ev) {
      const r = el.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(wrap).columnGap) || 12;
      const unit = (wrap.clientWidth + gap) / 12;
      rs = { el, k: el.dataset.w, x0: ev.clientX, y0: ev.clientY, w0: r.width, h0: r.height, unit, gap, hTouched: !!layout.sizes[el.dataset.w]?.h };
      el.classList.add('nx-resizing'); document.body.classList.add('nx-resize-active');
    }
    function moveResize(ev) {
      if (!rs) return;
      const dx = ev.clientX - rs.x0, dy = ev.clientY - rs.y0;
      const raw = (rs.w0 + dx + rs.gap) / rs.unit;
      const w = WIDTHS.reduce((best, n) => Math.abs(n - raw) < Math.abs(best - raw) ? n : best, 12);
      if (Math.abs(dy) > 12) rs.hTouched = true;
      const h = rs.hTouched ? clamp(Math.round((rs.h0 + dy) / SNAP_H) * SNAP_H, MIN_H, 2000) : 0;
      const cur = layout.sizes[rs.k] || {};
      if (cur.w === w && (cur.h || 0) === h) return;
      const before = snapshot();
      layout.sizes[rs.k] = { w, ...(h ? { h } : {}) };
      paintSizes(rs.el); flip(before);
    }
    function endResize() {
      if (!rs) return;
      rs.el.classList.remove('nx-resizing'); document.body.classList.remove('nx-resize-active');
      rs = null; save(); onApply(layout);
    }

    wrap.addEventListener('pointerdown', ev => {
      if (!editing || ev.button > 0) return;
      const el = ev.target.closest('.nx-w'); if (!el || el.parentNode !== wrap) return;
      if (ev.target.closest('[data-hide]')) return;
      if (ev.target.closest('[data-resize]')) {
        if (narrow()) return;
        ev.preventDefault(); ev.target.setPointerCapture?.(ev.pointerId); startResize(el, ev); return;
      }
      // Di HP hanya pegangan (judul) yang bisa diseret supaya halaman tetap bisa di-scroll.
      const onGrip = !!ev.target.closest('[data-grip]');
      if (ev.pointerType === 'touch' && !onGrip) return;
      ev.preventDefault();
      const sx = ev.clientX, sy = ev.clientY;
      const pending = e2 => {
        if (Math.hypot(e2.clientX - sx, e2.clientY - sy) < 5) return;
        window.removeEventListener('pointermove', pending);
        startDrag(el, ev); moveDrag(e2);
      };
      window.addEventListener('pointermove', pending);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', pending), { once: true });
    });
    window.addEventListener('pointermove', ev => { if (drag) moveDrag(ev); else if (rs) moveResize(ev); });
    window.addEventListener('pointerup', () => { endDrag(); endResize(); });
    window.addEventListener('pointercancel', () => { endDrag(); endResize(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && editing && !document.querySelector('.nx-sheet.show')) setEdit(false); });

    apply();
    loadServer();
    return {
      get layout() { return layout; },
      toggleEdit: () => setEdit(!editing),
      exitEdit: () => setEdit(false),
      isEditing: () => editing,
      widgets
    };
  }
  window.NXLayout = { init, PRESETS };
})();
