// Nexi Rover — robot patroli dashboard NMS.
// Menggunakan maskot Nexi yang sudah ter-mount, lalu membuat representasi rover ringan
// yang berjalan/terbang ke widget yang sedang dipantau. Tidak mengubah data/API dashboard.
(() => {
  const app = document.getElementById('nmsDashboard');
  const home = document.getElementById('nxMascot');
  if (!app || !home) return;

  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const compact = () => window.matchMedia?.('(max-width: 820px)').matches;
  const source = () => home.querySelector('.mx');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const visible = el => {
    if (!el || el.hidden || el.classList.contains('tv-off')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 80 && r.height > 50;
  };

  let rover = null;
  let running = true;
  let currentTarget = null;
  let previousTarget = null;
  let observer = null;

  function ensureRover() {
    const src = source();
    if (!src || rover) return rover;
    rover = src.cloneNode(true);
    rover.removeAttribute('id');
    rover.classList.add('mx-rover');
    rover.classList.remove('walking', 'talk');
    rover.setAttribute('aria-label', 'Nexi sedang patroli dashboard');
    rover.querySelector('.mx-bubble')?.setAttribute('aria-live', 'polite');
    document.body.appendChild(rover);

    // Sinkron mood/wajah/LED dari maskot utama agar kondisi gangguan tetap tercermin.
    const syncFace = () => {
      ['mood', 'eyes', 'mouth', 'extras', 'led'].forEach(k => {
        const v = src.dataset[k];
        if (v != null) rover.dataset[k] = v;
      });
    };
    syncFace();
    observer = new MutationObserver(syncFace);
    observer.observe(src, { attributes: true, attributeFilter: ['data-mood', 'data-eyes', 'data-mouth', 'data-extras', 'data-led'] });

    rover.addEventListener('click', e => {
      e.stopPropagation();
      src.click();
      say('Patroli manual aktif. Aku lanjut cek dashboard.');
    });
    return rover;
  }

  function say(text, ms = 2400) {
    if (!rover) return;
    const bubble = rover.querySelector('.mx-bubble');
    if (!bubble) return;
    bubble.textContent = text;
    rover.classList.add('talk');
    clearTimeout(rover._talkTimer);
    rover._talkTimer = setTimeout(() => rover?.classList.remove('talk'), ms);
  }

  function sourceHidden() {
    return home.hidden || app.classList.contains('no-mascot') || compact() || reduce();
  }

  function setEnabled(on) {
    running = on;
    if (rover) rover.hidden = !on || sourceHidden();
  }

  function targets() {
    const widgets = [...app.querySelectorAll('#nxWidgets > .nx-w')].filter(visible);
    const stats = [...app.querySelectorAll('.nx-stats > .nx-stat')].filter(visible);
    const siteCards = [...app.querySelectorAll('#nxSiteOverview .nx-site-card')].filter(visible);
    return [...widgets, ...siteCards, ...stats];
  }

  function targetLabel(el) {
    if (!el) return 'dashboard';
    if (el.matches('.nx-site-card')) {
      return `site ${el.querySelector('.nx-site-head strong')?.textContent?.trim() || ''}`.trim();
    }
    if (el.matches('.nx-stat')) return el.querySelector('small')?.textContent?.trim() || 'indikator';
    return el.dataset.title || el.querySelector('h2,h3')?.textContent?.trim() || 'widget';
  }

  function targetWeight(el) {
    let w = 1;
    const key = el.dataset.w || '';
    if (['attention', 'flapping', 'outages'].includes(key)) w += 5;
    if (['routers', 'traffic', 'sites'].includes(key)) w += 3;
    if (el.querySelector('.isolated,.red,.nx-pill.red,[data-state="offline"]')) w += 5;
    if (el.matches('.nx-site-card.degraded,.nx-site-card.offline')) w += 7;
    if (el === previousTarget) w = 0.08;
    return w;
  }

  function pickTarget() {
    const list = targets();
    if (!list.length) return null;
    const weighted = list.map(el => ({ el, w: targetWeight(el) }));
    const total = weighted.reduce((s, x) => s + x.w, 0);
    let roll = Math.random() * total;
    for (const x of weighted) {
      roll -= x.w;
      if (roll <= 0) return x.el;
    }
    return weighted[0].el;
  }

  function posFor(el) {
    const r = el.getBoundingClientRect();
    const size = 82;
    const side = Math.random() > .5 ? 'right' : 'left';
    const desiredX = side === 'right' ? r.right - size - 14 : r.left + 14;
    const desiredY = r.top + clamp(r.height * .22, 20, Math.max(20, r.height - 130));
    return {
      x: clamp(desiredX, 10, innerWidth - size - 10),
      y: clamp(desiredY, 72, innerHeight - 124),
      side,
      rect: r
    };
  }

  function currentPos() {
    if (!rover) return { x: 20, y: 90 };
    const r = rover.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  async function moveTo(el) {
    if (!rover || !visible(el)) return false;
    const from = currentPos();
    const to = posFor(el);
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const fly = dist > 360 || Math.abs(dy) > 220;
    const duration = clamp(dist * (fly ? 2.6 : 4.2), fly ? 1050 : 900, fly ? 2100 : 1800);

    rover.classList.remove('mx-walking', 'mx-flying', 'mx-landed');
    rover.classList.add(fly ? 'mx-flying' : 'mx-walking');
    rover.querySelector('.mx-dir')?.style.setProperty('transform', dx < 0 ? 'scaleX(-1)' : '');
    rover.style.setProperty('--mx-travel-ms', `${Math.round(duration)}ms`);
    rover.style.left = `${to.x}px`;
    rover.style.top = `${to.y}px`;

    await sleep(duration + 80);
    rover.classList.remove('mx-walking', 'mx-flying');
    rover.classList.add('mx-landed');
    return true;
  }

  function inspect(el) {
    currentTarget?.classList.remove('nx-inspecting');
    currentTarget = el;
    el?.classList.add('nx-inspecting');
    const label = targetLabel(el);
    rover?.setAttribute('aria-label', `Nexi sedang memeriksa ${label}`);
    say(`Cek ${label}…`, 1800);
    return label;
  }

  async function patrol() {
    while (running) {
      const src = source();
      if (!src || sourceHidden() || document.hidden) {
        if (rover) rover.hidden = true;
        await sleep(1500);
        continue;
      }
      ensureRover();
      if (!rover) { await sleep(1000); continue; }
      rover.hidden = false;
      src.style.opacity = '0';
      src.style.pointerEvents = 'none';

      const target = pickTarget();
      if (!target) { await sleep(1800); continue; }
      previousTarget = currentTarget;
      const ok = await moveTo(target);
      if (!ok) continue;
      inspect(target);

      // "Bekerja": scan pulse + gerak tangan kecil saat berhenti.
      rover.classList.add('mx-working');
      await sleep(2600 + Math.random() * 2400);
      rover.classList.remove('mx-working');
      currentTarget?.classList.remove('nx-inspecting');
      currentTarget = null;
      rover.classList.remove('talk');
      await sleep(700 + Math.random() * 1500);
    }
  }

  function placeAtHome() {
    const src = source();
    if (!src || !rover) return;
    const r = src.getBoundingClientRect();
    rover.style.transition = 'none';
    rover.style.left = `${clamp(r.left, 10, innerWidth - 92)}px`;
    rover.style.top = `${clamp(r.top, 72, innerHeight - 124)}px`;
    requestAnimationFrame(() => { if (rover) rover.style.transition = ''; });
  }

  // Maskot baru bisa di-clone setelah nms-noc.js memanggil NXMascot.mount().
  const boot = () => {
    if (!source()) return setTimeout(boot, 120);
    ensureRover();
    placeAtHome();
    patrol();
  };
  boot();

  window.addEventListener('resize', () => {
    const src = source();
    if (sourceHidden()) {
      if (rover) rover.hidden = true;
      if (src) { src.style.opacity = ''; src.style.pointerEvents = ''; }
    } else if (rover) rover.hidden = false;
  }, { passive: true });

  document.addEventListener('fullscreenchange', () => setTimeout(() => {
    if (rover && currentTarget) {
      const p = posFor(currentTarget);
      rover.style.left = `${p.x}px`; rover.style.top = `${p.y}px`;
    }
  }, 180));

  // Ikuti toggle maskot dari menu "Atur dashboard" tanpa perlu mengubah API layout lama.
  const hiddenWatch = new MutationObserver(() => {
    const src = source();
    if (sourceHidden()) {
      if (rover) rover.hidden = true;
      if (src) { src.style.opacity = ''; src.style.pointerEvents = ''; }
    } else {
      if (rover) rover.hidden = false;
      if (src) { src.style.opacity = '0'; src.style.pointerEvents = 'none'; }
    }
  });
  hiddenWatch.observe(home, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });

  window.NXRover = { setEnabled };
})();
