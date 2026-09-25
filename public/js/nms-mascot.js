// Nexi — maskot NOC Dashboard. Karakter router kecil (SVG orisinal) yang berjalan di kartu status,
// ekspresinya mengikuti kesehatan jaringan, dan melakukan gerakan berbeda setiap kali diklik.
// API: window.NXMascot.mount(el) → { setMood(mood, text), react(kind) }. Tanpa dependency.
(() => {
  const MOODS = {
    happy:   { eyes: 'happy', mouth: 'smile', extras: ['blush'], led: 'green', speed: 36, idle: [2500, 6000] },
    ok:      { eyes: 'round', mouth: 'soft', extras: [], led: 'green', speed: 30, idle: [2500, 5000] },
    worried: { eyes: 'round', mouth: 'wavy', extras: ['brows', 'sweat'], led: 'orange', speed: 46, idle: [1500, 3000] },
    panic:   { eyes: 'wide', mouth: 'open', extras: ['brows', 'sweat'], led: 'red', speed: 118, idle: [600, 1200] },
    dizzy:   { eyes: 'x', mouth: 'wavy', extras: ['stars'], led: 'gray', speed: 16, idle: [2000, 4000] },
    sleepy:  { eyes: 'closed', mouth: 'o', extras: ['zzz'], led: 'blue', speed: 10, idle: [5000, 9000] }
  };
  const LINES = {
    happy: ['Semua router sehat. Aku patroli dulu ya!', 'Jaringan lancar jaya.', 'Tidak ada gangguan. Santai dulu.'],
    ok: ['Jaringan normal, ada sedikit catatan.', 'Masih aman, tapi aku tetap mengawasi.'],
    worried: ['Hmm, ada yang perlu dicek.', 'Beberapa hal butuh perhatian.'],
    panic: ['Ada gangguan! Cek kartu merah di atas.', 'Router tidak terjangkau!'],
    dizzy: ['Data router belum terbaru…', 'Aku pusing, datanya belum masuk.'],
    sleepy: ['Malam tenang. Aku jaga sambil merem.', 'Zzz… semua aman.']
  };
  // Gerakan klik: tiap klik memilih gerakan lain dari yang terakhir.
  const ACTIONS = [
    { name: 'jump', face: { eyes: 'wide', mouth: 'o' }, ms: 700, say: 'Hop!' },
    { name: 'spin', face: { eyes: 'star', mouth: 'open' }, ms: 900, say: 'Wiii!' },
    { name: 'wave', face: { eyes: 'happy', mouth: 'smile', extras: ['blush'] }, ms: 1300, say: 'Halo!' },
    { name: 'dance', face: { eyes: 'heart', mouth: 'smile', extras: ['blush'] }, ms: 1800, say: 'Joget dulu!' },
    { name: 'flip', face: { eyes: 'star', mouth: 'open' }, ms: 950, say: 'Salto!' },
    { name: 'squish', face: { eyes: 'closed', mouth: 'tongue' }, ms: 800, say: 'Hehe, geli.' },
    { name: 'wink', face: { eyes: 'wink', mouth: 'tongue' }, ms: 1100, say: 'Siap bos!' },
    { name: 'dash', face: { eyes: 'wide', mouth: 'open' }, ms: 1200, say: 'Ngebut!' },
    { name: 'nod', face: { eyes: 'round', mouth: 'soft' }, ms: 1100, say: 'Oke, dicatat.' }
  ];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const SVG = `<svg class="mx-svg" viewBox="0 0 120 132" aria-hidden="true">
    <defs>
      <linearGradient id="mxShell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--mx-shell-a)"/><stop offset="1" style="stop-color:var(--mx-shell-b)"/></linearGradient>
      <linearGradient id="mxScreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#15192b"/><stop offset="1" stop-color="#0a0d18"/></linearGradient>
    </defs>
    <g class="mx-antenna l"><path d="M42 36 L34 14" style="stroke:var(--mx-shell-b)" stroke-width="3.5" stroke-linecap="round"/><circle class="mx-led" cx="34" cy="12" r="5"/></g>
    <g class="mx-antenna r"><path d="M78 36 L86 14" style="stroke:var(--mx-shell-b)" stroke-width="3.5" stroke-linecap="round"/><circle class="mx-led d2" cx="86" cy="12" r="5"/></g>
    <g class="mx-leg l"><rect x="38" y="92" width="12" height="24" rx="6" style="fill:var(--mx-limb)"/><rect x="33" y="110" width="20" height="9" rx="4.5" style="fill:var(--mx-foot)"/></g>
    <g class="mx-leg r"><rect x="70" y="92" width="12" height="24" rx="6" style="fill:var(--mx-limb)"/><rect x="67" y="110" width="20" height="9" rx="4.5" style="fill:var(--mx-foot)"/></g>
    <g class="mx-arm l"><rect x="8" y="56" width="14" height="26" rx="7" style="fill:var(--mx-limb)"/></g>
    <g class="mx-arm r"><rect x="98" y="56" width="14" height="26" rx="7" style="fill:var(--mx-limb)"/></g>
    <rect x="18" y="32" width="84" height="66" rx="22" fill="url(#mxShell)"/>
    <rect x="18" y="32" width="84" height="66" rx="22" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.2"/>
    <rect x="27" y="41" width="66" height="40" rx="13" fill="url(#mxScreen)"/>
    <g class="mx-ports"><circle cx="46" cy="90" r="2.2"/><circle cx="54" cy="90" r="2.2"/><circle cx="62" cy="90" r="2.2"/><circle cx="70" cy="90" r="2.2"/></g>
    <g class="mx-face" fill="none" style="stroke:var(--mx-face)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
      <g data-eyes="round"><circle cx="48" cy="59" r="4.6" style="fill:var(--mx-face)" stroke="none"/><circle cx="72" cy="59" r="4.6" style="fill:var(--mx-face)" stroke="none"/></g>
      <g data-eyes="happy"><path d="M42 61 Q48 53 54 61"/><path d="M66 61 Q72 53 78 61"/></g>
      <g data-eyes="wide"><circle cx="48" cy="58" r="7" stroke-width="2.6"/><circle cx="72" cy="58" r="7" stroke-width="2.6"/><circle cx="48" cy="58" r="2.6" style="fill:var(--mx-face)" stroke="none"/><circle cx="72" cy="58" r="2.6" style="fill:var(--mx-face)" stroke="none"/></g>
      <g data-eyes="closed"><path d="M42 60 Q48 64 54 60"/><path d="M66 60 Q72 64 78 60"/></g>
      <g data-eyes="x"><path d="M43 54 L53 64 M53 54 L43 64"/><path d="M67 54 L77 64 M77 54 L67 64"/></g>
      <g data-eyes="heart" fill="#ff5a7a" stroke="none"><path d="M48 65 C40 59 42 51 48 55 C54 51 56 59 48 65Z"/><path d="M72 65 C64 59 66 51 72 55 C78 51 80 59 72 65Z"/></g>
      <g data-eyes="star" fill="#ffd54a" stroke="none"><path d="M48 51 L50.2 56.4 L56 57 L51.6 60.6 L53 66 L48 63 L43 66 L44.4 60.6 L40 57 L45.8 56.4Z"/><path d="M72 51 L74.2 56.4 L80 57 L75.6 60.6 L77 66 L72 63 L67 66 L68.4 60.6 L64 57 L69.8 56.4Z"/></g>
      <g data-eyes="wink"><circle cx="48" cy="59" r="4.6" style="fill:var(--mx-face)" stroke="none"/><path d="M66 60 Q72 55 78 60"/></g>
      <g data-mouth="smile"><path d="M51 70 Q60 78 69 70"/></g>
      <g data-mouth="soft"><path d="M53 71 Q60 74 67 71"/></g>
      <g data-mouth="wavy"><path d="M50 72 Q53.5 69 57 72 T64 72 T71 72" stroke-width="2.6"/></g>
      <g data-mouth="open"><path d="M52 69 Q60 69 68 69 Q66 78 60 78 Q54 78 52 69Z" style="fill:var(--mx-face)"/></g>
      <g data-mouth="o"><circle cx="60" cy="72" r="3.4" stroke-width="2.6"/></g>
      <g data-mouth="tongue"><path d="M51 70 Q60 77 69 70"/><path d="M57 73.5 Q60 80 63 73.5" fill="#ff7a93" stroke="none"/></g>
      <g data-extra="brows"><path d="M42 50 L53 47" stroke-width="2.6"/><path d="M78 50 L67 47" stroke-width="2.6"/></g>
      <g data-extra="blush" stroke="none" fill="rgba(255,122,147,.55)"><ellipse cx="38" cy="68" rx="4.5" ry="2.6"/><ellipse cx="82" cy="68" rx="4.5" ry="2.6"/></g>
    </g>
    <g data-extra="sweat" class="mx-sweat"><path d="M96 38 C92 45 92 49 96 49 C100 49 100 45 96 38Z" fill="#6cc8ff"/></g>
    <g data-extra="zzz" class="mx-zzz" style="fill:var(--mx-muted)" font-family="-apple-system,system-ui,sans-serif" font-weight="800"><text x="92" y="30" font-size="12">z</text><text x="100" y="20" font-size="9">z</text><text x="106" y="12" font-size="7">z</text></g>
    <g data-extra="stars" class="mx-stars" fill="#ffd54a"><circle cx="40" cy="26" r="3"/><circle cx="60" cy="20" r="2.4"/><circle cx="80" cy="26" r="3"/></g>
  </svg>`;

  function mount(host) {
    if (!host || host.dataset.mxMounted) return null;
    host.dataset.mxMounted = '1';
    host.innerHTML = `<div class="mx-lane"><button type="button" class="mx" aria-label="Maskot Nexi"><span class="mx-bubble" role="status"></span><span class="mx-actor"><span class="mx-dir">${SVG}</span></span><span class="mx-shadow"></span></button></div>`;
    const btn = host.querySelector('.mx'), actor = host.querySelector('.mx-actor'), dir = host.querySelector('.mx-dir'), bubble = host.querySelector('.mx-bubble'), lane = host.querySelector('.mx-lane');
    const st = { mood: 'ok', text: '', x: 0, vx: 1, idleUntil: 0, acting: false, last: null, face: null, raf: 0, t: 0, bubbleT: 0, visible: true };

    function applyFace(f) {
      btn.dataset.eyes = f.eyes; btn.dataset.mouth = f.mouth;
      btn.dataset.extras = (f.extras || []).join(' ');
    }
    function moodFace() { const m = MOODS[st.mood]; return { eyes: m.eyes, mouth: m.mouth, extras: m.extras }; }
    function say(text, ms = 3200) {
      bubble.textContent = text; btn.classList.add('talk');
      clearTimeout(st.bubbleT); st.bubbleT = setTimeout(() => btn.classList.remove('talk'), ms);
    }
    function setMood(mood, text) {
      if (!MOODS[mood]) mood = 'ok';
      const changed = mood !== st.mood;
      st.mood = mood; st.text = text || '';
      btn.dataset.mood = mood; btn.dataset.led = MOODS[mood].led;
      btn.setAttribute('aria-label', `Maskot Nexi. ${st.text}`);
      if (!st.acting) applyFace(moodFace());
      if (changed && st.started) { react(mood === 'panic' ? 'alarm' : mood === 'happy' ? 'cheer' : null); say(pick(LINES[mood]), 3600); }
    }
    function react(kind) {
      if (!kind || st.acting || reduce()) return;
      if (kind === 'alarm') run({ name: 'shake', face: { eyes: 'wide', mouth: 'open', extras: ['sweat', 'brows'] }, ms: 1200 });
      if (kind === 'cheer') run({ name: 'jump', face: { eyes: 'star', mouth: 'smile', extras: ['blush'] }, ms: 700 });
    }
    function run(a) {
      // Saat jaringan bermasalah, gerakan tetap berbeda tapi wajah tetap menunjukkan kondisi (tidak ceria).
      const serious = ['panic', 'worried', 'dizzy'].includes(st.mood) && !['shake'].includes(a.name);
      st.acting = true; applyFace(serious ? moodFace() : { extras: [], ...a.face });
      actor.classList.remove(...[...actor.classList].filter(c => c.startsWith('act-')));
      void actor.offsetWidth; actor.classList.add(`act-${a.name}`);
      if (a.name === 'dash') { st.vx = -st.vx; }
      setTimeout(() => { actor.classList.remove(`act-${a.name}`); st.acting = false; applyFace(moodFace()); st.idleUntil = performance.now() + 600; }, a.ms);
    }
    btn.addEventListener('click', () => {
      if (reduce()) { say(pick(LINES[st.mood])); return; }
      const pool = ACTIONS.filter(a => a.name !== st.last);
      const a = pick(pool); st.last = a.name;
      run(a);
      say(`${['panic', 'worried', 'dizzy'].includes(st.mood) ? '' : a.say + ' '}${pick(LINES[st.mood])}`.trim(), 3200);
    });
    btn.addEventListener('mouseenter', () => { if (!btn.classList.contains('talk')) say(pick(LINES[st.mood]), 2600); });

    // Kedipan mata acak (hanya untuk mata yang terbuka).
    const blink = () => {
      const eyes = btn.dataset.eyes;
      if (!st.acting && ['round', 'wide', 'happy'].includes(eyes)) { btn.dataset.eyes = 'closed'; setTimeout(() => { if (!st.acting && btn.dataset.eyes === 'closed') btn.dataset.eyes = moodFace().eyes; }, 130); }
      setTimeout(blink, rnd(2200, 5200));
    };
    setTimeout(blink, 1800);

    // Berjalan bolak-balik di jalur dengan jeda acak; kecepatan mengikuti mood.
    const W = 96;
    function frame(ts) {
      st.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (ts - (st.t || ts)) / 1000); st.t = ts;
      if (!st.visible) return;
      const max = Math.max(0, lane.clientWidth - W);
      const m = MOODS[st.mood];
      let moving = false;
      if (!reduce() && !st.acting && ts > st.idleUntil) {
        moving = true;
        st.x += st.vx * m.speed * dt * (st.mood === 'dizzy' ? (0.6 + Math.sin(ts / 300) * 0.4) : 1);
        if (st.x <= 0) { st.x = 0; st.vx = 1; }
        if (st.x >= max) { st.x = max; st.vx = -1; }
        if (Math.random() < dt / 5) { st.idleUntil = ts + rnd(...m.idle); if (Math.random() < 0.35) st.vx = -st.vx; }
      } else if (st.acting && actor.classList.contains('act-dash')) {
        st.x = Math.max(0, Math.min(max, st.x + st.vx * 260 * dt)); if (st.x <= 0 || st.x >= max) st.vx = -st.vx;
      }
      st.x = Math.min(st.x, max);
      btn.style.transform = `translateX(${st.x.toFixed(1)}px)`;
      dir.style.transform = st.vx < 0 ? 'scaleX(-1)' : '';
      btn.classList.toggle('walking', moving);
    }
    const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; }) : null;
    io?.observe(lane);
    document.addEventListener('visibilitychange', () => { st.t = 0; });
    st.x = Math.max(0, (lane.clientWidth - W) * 0.3);
    applyFace(moodFace()); btn.dataset.mood = st.mood; btn.dataset.led = MOODS[st.mood].led;
    st.raf = requestAnimationFrame(frame);
    setTimeout(() => { st.started = true; }, 800);
    return { setMood, react, say, get mood() { return st.mood; } };
  }
  window.NXMascot = { mount, MOODS: Object.keys(MOODS) };
})();
