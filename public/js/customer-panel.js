// Panel detail pelanggan di sisi kanan (web) / lembar bawah (APK) saat nama pelanggan diklik.
// Klik dengan Ctrl/Cmd/tombol tengah tetap membuka halaman detail seperti biasa.
(() => {
  if (!document.querySelector('[data-customer-panel]')) return;
  const wrap = document.createElement('div');
  wrap.className = 'cpanel';
  wrap.hidden = true;
  wrap.innerHTML = '<button type="button" class="cpanel-scrim" data-cpanel-close aria-label="Tutup"></button><aside class="cpanel-sheet" role="dialog" aria-modal="true" aria-labelledby="customerPanelTitle"><div class="cpanel-content"></div></aside>';
  document.body.appendChild(wrap);
  const content = wrap.querySelector('.cpanel-content');
  let seq = 0, lastFocus = null;
  const close = () => {
    wrap.hidden = true; document.documentElement.classList.remove('cpanel-open'); seq++;
    document.querySelectorAll('tr.cpanel-current').forEach(tr => tr.classList.remove('cpanel-current'));
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  };
  async function open(link) {
    const id = link.dataset.customerPanel, my = ++seq;
    lastFocus = link;
    document.querySelectorAll('tr.cpanel-current').forEach(tr => tr.classList.remove('cpanel-current'));
    link.closest('tr')?.classList.add('cpanel-current');
    content.innerHTML = '<div class="cpanel-loading">Memuat data pelanggan…</div>';
    wrap.hidden = false; document.documentElement.classList.add('cpanel-open');
    try {
      const res = await fetch(`/customers/${encodeURIComponent(id)}/panel`, { headers: { Accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 404 ? 'Pelanggan tidak ditemukan.' : 'Data gagal dimuat.');
      const html = await res.text();
      if (my !== seq) return;
      content.innerHTML = html;
      content.querySelector('[data-cpanel-close]')?.focus();
    } catch (err) {
      if (my !== seq) return;
      content.innerHTML = `<div class="cpanel-loading">${err.message} <a href="/customers/${encodeURIComponent(id)}">Buka halaman detail</a></div>`;
    }
  }
  document.addEventListener('click', e => {
    const link = e.target.closest('a[data-customer-panel]');
    if (link) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault(); open(link); return;
    }
    if (e.target.closest('[data-cpanel-close]') && wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !wrap.hidden) close(); });
})();
