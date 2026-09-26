// Nexi — maskot NOC Dashboard (v2, gaya garis datar mengikuti tema).
// - Matanya mengikuti kursor, bisa diambil & dilempar (fisika sederhana), lalu hinggap di kartu mana saja.
// - Posisi hinggap diingat per browser; klik ganda = pulang ke kartu status.
// - Bereaksi pada kejadian nyata: nms-noc.js memanggil goTo() saat router down, glance() saat ada event PPP.
// - Di HP / reduce-motion: diam di kartu status (tanpa drag), tetap menampilkan status.
// API: window.NXMascot.mount(laneEl, { app }) → { setMood, say, goTo, glance, home, setEnabled, mood }
(() => {
  const MOODS = {
    happy:   { eyes: 'happy', mouth: 'smile', walk: 34 },
    ok:      { eyes: 'round', mouth: 'flat', walk: 28 },
    worried: { eyes: 'round', mouth: 'wavy', walk: 40 },
    panic:   { eyes: 'wide', mouth: 'o', walk: 90 },
    dizzy:   { eyes: 'x', mouth: 'wavy', walk: 14 },
    sleepy:  { eyes: 'closed', mouth: 'flat', walk: 0 }
  };
  let W = 58, H = 66; const G = 2400, PERCH_KEY = 'nx-mascot-perch';
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const narrow = () => window.matchMedia?.('(max-width: 820px)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);

  const eye = (cx) => `
    <g data-eyes="round"><circle cx="${cx}" cy="33" r="2.4" class="f"/></g>
    <g data-eyes="wide"><circle cx="${cx}" cy="33" r="3.3" class="s"/><circle cx="${cx}" cy="33" r="1.2" class="f"/></g>
    <g data-eyes="happy"><path d="M${cx - 2.6} 34.4 q2.6 -3.2 5.2 0" class="s"/></g>
    <g data-eyes="closed"><path d="M${cx - 2.6} 33.6 h5.2" class="s"/></g>
    <g data-eyes="x"><path d="M${cx - 2.2} 30.8 l4.4 4.4 M${cx + 2.2} 30.8 l-4.4 4.4" class="s"/></g>`;
  const SVG = `<svg class="mx-svg" viewBox="0 0 64 72" aria-hidden="true">
    <ellipse class="mx-shadow" cx="32" cy="69" rx="17" ry="2.6"/>
    <g class="mx-ant l"><line x1="21" y1="20" x2="16" y2="8"/><circle class="mx-led" cx="15.5" cy="6.5" r="3"/></g>
    <g class="mx-ant r"><line x1="43" y1="20" x2="48" y2="8"/><circle class="mx-led d2" cx="48.5" cy="6.5" r="3"/></g>
    <g class="mx-arm l"><path d="M8 33 q-5 5 -3.5 12"/></g>
    <g class="mx-arm r"><path d="M56 33 q5 5 3.5 12"/></g>
    <g class="mx-leg l"><path d="M24 55 v8 h-4.5"/></g>
    <g class="mx-leg r"><path d="M40 55 v8 h4.5"/></g>
    <rect class="mx-body" x="7" y="20" width="50" height="35" rx="8"/>
    <rect class="mx-screen" x="13" y="25" width="38" height="18.5" rx="4"/>
    <g class="mx-face"><g class="mx-look">${eye(25)}${eye(39)}</g>
      <g data-mouth="flat"><path d="M29 39.6 h6" class="s"/></g>
      <g data-mouth="smile"><path d="M28.8 38.8 q3.2 2.6 6.4 0" class="s"/></g>
      <g data-mouth="wavy"><path d="M28 40 q1.6 -1.6 3.2 0 t3.2 0 t1.6 0" class="s"/></g>
      <g data-mouth="o"><circle cx="32" cy="39.8" r="1.7" class="s"/></g>
    </g>
    <g class="mx-ports"><rect x="16.5" y="47.5" width="5" height="3.4" rx="1"/><rect x="24.5" y="47.5" width="5" height="3.4" rx="1"/><rect x="32.5" y="47.5" width="5" height="3.4" rx="1"/><rect x="40.5" y="47.5" width="5" height="3.4" rx="1"/></g>
    <g class="mx-zzz"><text x="54" y="16">z</text><text x="59" y="9">z</text></g>
  </svg>`;

  function mount(lane, { app = lane?.closest('.nx') } = {}) {
    if (!lane || !app || lane.dataset.mxMounted) return null;
    lane.dataset.mxMounted = '1';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'mx';
    btn.setAttribute('aria-label', 'Maskot Nexi');
    btn.innerHTML = `<span class="mx-bubble" role="status"></span><span class="mx-actor"><span class="mx-dir">${SVG}</span></span>`;
    app.appendChild(btn);
    const actor = btn.querySelector('.mx-actor'), dir = btn.querySelector('.mx-dir'), bubble = btn.querySelector('.mx-bubble'), look = btn.querySelector('.mx-look');

    const st = {
      mode: 'home', x: 0, y: 0, vx: 0, vy: 0, facing: 1,
      hx: 0, hdir: 1, idleUntil: 0, perch: null, travel: null,
      mood: 'ok', text: '', enabled: true, visible: true, t: 0,
      mouse: { x: -1e4, y: -1e4, at: 0, speed: 0 }, lookAt: null, lookUntil: 0,
      wanderAt: performance.now() + rnd(6000, 12000), wanderTo: null, hopAt: 0, lastLand: 0
    };
    const interactive = () => st.enabled && !narrow() && !reduce();

    // ---------- koordinat: semua posisi relatif terhadap konten .nx ----------
    const origin = () => { const a = app.getBoundingClientRect(); return { x: a.left - app.scrollLeft, y: a.top - app.scrollTop }; };
    const shown = el => { if (!el || !el.isConnected || el.closest('[hidden],.tv-off')) return false; const r = el.getBoundingClientRect(); return r.width > 70 && r.height > 36; };
    const SURF = '#nxWidgets > .nx-w, .nx-stat, .nx-router, .nx-site-card, .nx-traffic';
    function keyOf(el) {
      if (el.matches('.nx-router')) return `r:${el.dataset.routerDetail}`;
      if (el.matches('.nx-traffic')) return `t:${el.dataset.router}`;
      if (el.matches('.nx-w')) return `w:${el.dataset.w}`;
      const list = [...app.querySelectorAll(el.matches('.nx-stat') ? '.nx-stat' : '.nx-site-card')];
      return `${el.matches('.nx-stat') ? 's' : 'c'}:${list.indexOf(el)}`;
    }
    function elOf(key) {
      if (!key) return null;
      const [t, v] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (t === 'r') return app.querySelector(`.nx-router[data-router-detail="${CSS.escape(v)}"]`);
      if (t === 't') return app.querySelector(`.nx-traffic[data-router="${CSS.escape(v)}"]`);
      if (t === 'w') return app.querySelector(`#nxWidgets > .nx-w[data-w="${CSS.escape(v)}"]`);
      if (t === 's') return app.querySelectorAll('.nx-stat')[Number(v)] || null;
      if (t === 'c') return app.querySelectorAll('.nx-site-card')[Number(v)] || null;
      return null;
    }
    function laneFloor(o) { const r = lane.getBoundingClientRect(); return { left: r.left - o.x, right: r.right - o.x, top: r.bottom - o.y - 12 }; }
    function surfaces(o) {
      const out = [];
      if (shown(lane)) { const f = laneFloor(o); out.push({ key: 'home', left: f.left, right: f.right, top: f.top }); }
      app.querySelectorAll(SURF).forEach(el => { if (el === btn || !shown(el)) return; const r = el.getBoundingClientRect(); out.push({ key: keyOf(el), left: r.left - o.x, right: r.right - o.x, top: r.top - o.y }); });
      return out;
    }

    // ---------- wajah & ekspresi ----------
    function face(eyes, mouth) { btn.dataset.eyes = eyes; btn.dataset.mouth = mouth; }
    function moodFace() { const m = MOODS[st.mood]; face(m.eyes, m.mouth); }
    let bubbleT = 0;
    function say(text, ms = 3600) {
      if (!text) return;
      bubble.textContent = text; btn.classList.add('talk');
      const right = app.clientWidth - (st.x + W);
      btn.classList.toggle('bubble-left', right < 110); btn.classList.toggle('bubble-right', st.x < 110);
      clearTimeout(bubbleT); bubbleT = setTimeout(() => btn.classList.remove('talk'), ms);
    }
    function pulse(cls, ms) { if (reduce()) return; actor.classList.remove(cls); void actor.offsetWidth; actor.classList.add(cls); setTimeout(() => actor.classList.remove(cls), ms); }
    const blink = () => {
      if (['round', 'wide', 'happy'].includes(btn.dataset.eyes) && !btn.classList.contains('held')) { const prev = btn.dataset.eyes; btn.dataset.eyes = 'closed'; setTimeout(() => { if (btn.dataset.eyes === 'closed') btn.dataset.eyes = prev; }, 120); }
      setTimeout(blink, rnd(2400, 5600));
    };
    setTimeout(blink, 2000);

    // ---------- hinggap & simpan ----------
    function perchOn(key, dx, { quiet = false } = {}) {
      if (key === 'home' || !key) { st.mode = 'home'; st.perch = null; if (!quiet) storePerch(null); return; }
      st.mode = 'perch'; st.perch = { key, dx };
      if (!quiet) storePerch({ key, dx });
    }
    function storePerch(v) { try { v ? localStorage.setItem(PERCH_KEY, JSON.stringify(v)) : localStorage.removeItem(PERCH_KEY); } catch (_) {} }
    function land(key, x, top, speed) {
      const o = origin();
      st.y = top - H + 4; st.vx = 0; st.vy = 0;
      if (key === 'home') { st.hx = clamp(x - laneFloor(o).left, 0, Math.max(0, lane.clientWidth - W)); perchOn('home'); }
      else { const el = elOf(key); const r = el.getBoundingClientRect(); perchOn(key, x - (r.left - o.x)); }
      st.lastLand = performance.now();
      if (speed > 500) pulse('mx-land', 320);
      moodFace();
    }

    // ---------- lompat ke target (reaksi) ----------
    function travelTo(key, text) {
      const target = key === 'home' ? lane : elOf(key);
      if (!target || !shown(target)) { if (text) say(text); return; }
      const r = target.getBoundingClientRect();
      const dx = key === 'home' ? Math.max(0, lane.clientWidth * .25) : clamp(r.width - W - 24, 8, Math.max(8, r.width - W));
      st.travel = { key, dx, x0: st.x, y0: st.y, t0: performance.now(), dur: 0, text };
      const o = origin(), tx = r.left - o.x + dx, ty = (key === 'home' ? laneFloor(o).top : r.top - o.y) - H + 4;
      st.travel.dur = clamp(Math.hypot(tx - st.x, ty - st.y) / 1.1, 520, 1400);
      st.mode = 'travel'; face('wide', 'o');
    }

    // ---------- input: ambil, lempar, klik ----------
    let grab = null;
    btn.addEventListener('pointerdown', e => {
      if (!interactive() || e.button > 0) return;
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      const r = btn.getBoundingClientRect();
      grab = { ox: e.clientX - r.left, oy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
    });
    btn.addEventListener('pointermove', e => {
      if (!grab) return;
      if (!grab.moved && Math.hypot(e.clientX - grab.sx, e.clientY - grab.sy) < 5) return;
      if (!grab.moved) { grab.moved = true; st.mode = 'held'; st.travel = null; btn.classList.add('held'); btn.classList.remove('talk'); face('wide', 'o'); }
      const o = origin();
      st.x = e.clientX - grab.ox - o.x; st.y = e.clientY - grab.oy - o.y;
      const now = performance.now(); grab.samples.push({ x: e.clientX, y: e.clientY, t: now });
      while (grab.samples.length > 2 && now - grab.samples[0].t > 90) grab.samples.shift();
    });
    const release = () => {
      if (!grab) return;
      const g = grab; grab = null; btn.classList.remove('held');
      if (!g.moved) { pulse('mx-nod', 520); say(st.text || 'Memantau jaringan.'); return; }
      const a = g.samples[0], b = g.samples[g.samples.length - 1], dt = Math.max(16, b.t - a.t) / 1000;
      st.vx = clamp((b.x - a.x) / dt, -2600, 2600); st.vy = clamp((b.y - a.y) / dt, -2600, 2600);
      st.mode = 'fall'; st.surf = surfaces(origin()); st.surfAt = performance.now();
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('click', e => { if (!interactive()) say(st.text || 'Memantau jaringan.'); e.stopPropagation(); });
    btn.addEventListener('dblclick', e => { e.preventDefault(); if (interactive()) travelTo('home', 'Kembali ke kartu status.'); });
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); say(st.text || 'Memantau jaringan.'); } });
    let hoverT = 0;
    btn.addEventListener('mouseenter', () => { clearTimeout(hoverT); hoverT = setTimeout(() => { if (!grab && !btn.classList.contains('talk')) say(st.text, 2600); }, 650); });
    btn.addEventListener('mouseleave', () => clearTimeout(hoverT));
    window.addEventListener('pointermove', e => {
      const m = st.mouse, now = performance.now(), dt = Math.max(1, now - m.at);
      m.speed = m.at ? Math.hypot(e.clientX - m.x, e.clientY - m.y) / dt * 1000 : 0;
      m.x = e.clientX; m.y = e.clientY; m.at = now;
    }, { passive: true });

    // ---------- loop animasi ----------
    function frame(ts) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.04, (ts - (st.t || ts)) / 1000); st.t = ts;
      if (!st.enabled || !st.visible || document.hidden) return;
      W = btn.offsetWidth || 58; H = btn.offsetHeight || 66;
      const o = origin();
      const m = MOODS[st.mood];
      let walking = false;

      if (!interactive() && st.mode !== 'home') { st.mode = 'home'; st.travel = null; }

      if (st.mode === 'home') {
        const f = laneFloor(o), max = Math.max(0, (f.right - f.left) - W);
        if (interactive() && m.walk && ts > st.idleUntil) {
          walking = true; st.hx += st.hdir * m.walk * dt;
          if (st.hx <= 0) { st.hx = 0; st.hdir = 1; } if (st.hx >= max) { st.hx = max; st.hdir = -1; }
          if (Math.random() < dt / 5) { st.idleUntil = ts + rnd(2500, 6000); if (Math.random() < .35) st.hdir = -st.hdir; }
          st.facing = st.hdir;
        }
        if (!interactive()) st.hx = Math.min(st.hx || max * .3, max);
        st.hx = Math.min(st.hx, max);
        st.x = f.left + st.hx; st.y = f.top - H + 4;
      } else if (st.mode === 'perch') {
        const el = elOf(st.perch?.key);
        if (!shown(el)) { st.mode = 'fall'; st.vx = 0; st.vy = 0; st.surf = surfaces(o); st.surfAt = ts; }
        else {
          const r = el.getBoundingClientRect(), maxDx = Math.max(0, r.width - W);
          // Sesekali jalan pelan di tepi kartu supaya terasa hidup.
          if (m.walk && ts > st.wanderAt && !st.wanderTo) st.wanderTo = clamp(st.perch.dx + rnd(-90, 90), 0, maxDx);
          if (st.wanderTo != null) {
            const d = st.wanderTo - st.perch.dx, step = Math.sign(d) * Math.min(Math.abs(d), m.walk * .8 * dt);
            st.perch.dx += step; walking = Math.abs(d) > .5; st.facing = Math.sign(d) || st.facing;
            if (!walking) { st.wanderTo = null; st.wanderAt = ts + rnd(8000, 16000); storePerch(st.perch); }
          }
          st.perch.dx = clamp(st.perch.dx, 0, maxDx);
          st.x = r.left - o.x + st.perch.dx; st.y = r.top - o.y - H + 4;
        }
      } else if (st.mode === 'fall') {
        if (ts - st.surfAt > 250) { st.surf = surfaces(o); st.surfAt = ts; }
        const prevBottom = st.y + H - 4;
        st.vy += G * dt; st.vx *= Math.pow(.6, dt);
        st.x += st.vx * dt; st.y += st.vy * dt;
        const maxX = app.clientWidth - W;
        if (st.x < 0) { st.x = 0; st.vx = -st.vx * .45; }
        if (st.x > maxX) { st.x = maxX; st.vx = -st.vx * .45; }
        if (st.y < -20) { st.y = -20; st.vy = Math.abs(st.vy) * .3; }
        const bottom = st.y + H - 4, cx = st.x + W / 2;
        if (st.vy > 0) {
          const hit = (st.surf || []).filter(s => s.top >= prevBottom - 2 && s.top <= bottom + 1 && cx >= s.left + 6 && cx <= s.right - 6).sort((a, b) => a.top - b.top)[0];
          if (hit) {
            if (st.vy > 1400) { st.vy = -st.vy * .28; st.y = hit.top - H + 4; pulse('mx-land', 260); }
            else land(hit.key, st.x, hit.top, st.vy);
          }
        }
        const floor = app.scrollHeight - H;
        if (st.mode === 'fall' && st.y > floor) { st.y = floor; st.vy = 0; travelTo('home'); }
        st.facing = st.vx >= 0 ? 1 : -1;
      } else if (st.mode === 'travel') {
        const tr = st.travel, target = tr.key === 'home' ? lane : elOf(tr.key);
        if (!shown(target)) { st.mode = 'fall'; st.surf = surfaces(o); st.surfAt = ts; }
        else {
          const r = target.getBoundingClientRect();
          const tx = (tr.key === 'home' ? laneFloor(o).left : r.left - o.x) + tr.dx;
          const ty = (tr.key === 'home' ? laneFloor(o).top : r.top - o.y) - H + 4;
          const p = clamp((ts - tr.t0) / tr.dur, 0, 1), e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
          const arc = Math.min(160, 60 + Math.hypot(tx - tr.x0, ty - tr.y0) * .25);
          st.x = tr.x0 + (tx - tr.x0) * e; st.y = tr.y0 + (ty - tr.y0) * e - arc * 4 * p * (1 - p);
          st.facing = tx >= tr.x0 ? 1 : -1;
          if (p >= 1) { land(tr.key, tx, ty + H - 4, 700); st.travel = null; if (tr.text) say(tr.text, 4200); }
        }
      }

      // Mata mengikuti kursor (atau target glance), menghindar kecil saat kursor menyambar cepat.
      const r = btn.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * .45;
      let lx = 0, ly = 0;
      const tgt = st.lookAt && ts < st.lookUntil ? st.lookAt : (ts - st.mouse.at < 5000 ? st.mouse : null);
      if (tgt) { const dx = tgt.x - cx, dy = tgt.y - cy, d = Math.hypot(dx, dy) || 1; const k = Math.min(1, d / 180); lx = dx / d * 2.2 * k; ly = dy / d * 1.6 * k; }
      look.setAttribute('transform', `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`);
      if (interactive() && st.mode !== 'held' && st.mode !== 'fall' && ts > st.hopAt && st.mouse.speed > 1800 && ts - st.mouse.at < 60 && Math.hypot(st.mouse.x - cx, st.mouse.y - cy) < 80) { st.hopAt = ts + 1500; pulse('mx-hop', 460); }

      const tilt = st.mode === 'held' ? clamp((grab?.samples?.length > 1 ? (grab.samples.at(-1).x - grab.samples[0].x) : 0) * .25, -24, 24) : st.mode === 'fall' ? clamp(st.vx * .012, -18, 18) : 0;
      btn.style.transform = `translate3d(${st.x.toFixed(1)}px,${st.y.toFixed(1)}px,0)`;
      actor.style.rotate = `${tilt.toFixed(1)}deg`;
      dir.style.transform = st.facing < 0 ? 'scaleX(-1)' : '';
      btn.classList.toggle('walking', walking);
      btn.classList.toggle('flying', st.mode === 'fall' || st.mode === 'travel');
    }

    document.addEventListener('visibilitychange', () => { st.t = 0; });
    moodFace(); btn.dataset.mood = st.mood;
    requestAnimationFrame(frame);
    // Pulihkan tempat hinggap terakhir setelah layout diterapkan.
    setTimeout(() => {
      try { const p = JSON.parse(localStorage.getItem(PERCH_KEY) || 'null'); if (p && interactive() && shown(elOf(p.key))) perchOn(p.key, Number(p.dx) || 0, { quiet: true }); } catch (_) {}
    }, 900);

    return {
      setMood(mood, text) {
        if (!MOODS[mood]) mood = 'ok';
        const changed = mood !== st.mood;
        st.mood = mood; st.text = text || '';
        btn.dataset.mood = mood;
        btn.setAttribute('aria-label', `Maskot Nexi. ${st.text}`);
        if (st.mode !== 'held' && st.mode !== 'travel') moodFace();
        if (changed && mood === 'panic') pulse('mx-shake', 900);
      },
      say,
      goTo(target, text) {
        const el = typeof target === 'string' ? app.querySelector(target) : target;
        if (!el || !interactive() || st.mode === 'held') { say(text); return; }
        const surf = el.closest(SURF) || el;
        travelTo(keyOf(surf), text);
      },
      glance(target, ms = 1400) {
        const el = typeof target === 'string' ? app.querySelector(target) : target;
        if (!shown(el)) return;
        const r = el.getBoundingClientRect(); st.lookAt = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; st.lookUntil = performance.now() + ms;
      },
      home() { if (interactive()) travelTo('home'); },
      setEnabled(on) { st.enabled = !!on; btn.hidden = !on; },
      get mood() { return st.mood; }
    };
  }
  window.NXMascot = { mount, MOODS: Object.keys(MOODS) };
})();
