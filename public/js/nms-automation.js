// Otomasi: persetujuan dua orang, aksi terjadwal, riwayat Smart Sync + undo, diff konfigurasi PPP, pengaturan.
(() => {
  const N = window.NX;
  const app = document.getElementById('nmsAutomation');
  if (!N || !app) return;
  const { esc, api, toast, qs, dateTime } = N;
  const $ = id => document.getElementById(id);
  const me = Number(app.dataset.me) || null;
  const ACTION = { isolate: 'Isolir', unisolate: 'Buka isolir', kick: 'Kick sesi', profile: 'Ganti profile', package: 'Ganti paket' };
  const STATUS = { pending: ['blue', 'Menunggu'], running: ['orange', 'Berjalan'], done: ['green', 'Selesai'], failed: ['red', 'Gagal'], cancelled: ['', 'Dibatalkan'], approved: ['green', 'Disetujui'], rejected: ['', 'Ditolak'], expired: ['', 'Kedaluwarsa'] };
  const pill = s => { const [c, l] = STATUS[s] || ['', s]; return `<span class="nx-pill ${c}">${l}</span>`; };

  // ---------------------------------------------------------------- Persetujuan
  async function loadApprovals() {
    try {
      const { rows } = await api('/nms/api/approvals');
      const list = rows.slice(0, 15);
      $('nxApprovals').innerHTML = list.length ? list.map(a => `<li><span class="li-icon ${a.status === 'pending' ? 'orange' : 'gray'}"><i class="bi bi-person-check"></i></span><div class="li-main"><b>${esc(a.summary)}</b><small>Diminta ${esc(a.requested_by_name || 'sistem')} · ${esc(dateTime(a.created_at))}${a.decided_by_name ? ` · diputuskan ${esc(a.decided_by_name)}` : ''}${a.result?.succeeded != null ? ` · ${a.result.succeeded}/${a.result.total} berhasil` : ''}${a.result?.error ? ` · ${esc(a.result.error)}` : ''}</small></div>
        ${a.status === 'pending' && N.isAdmin ? (Number(a.requested_by) === me ? '<small class="dim">menunggu admin lain</small>' : `<button type="button" class="nx-btn sm" data-reject="${a.id}">Tolak</button><button type="button" class="nx-btn sm primary" data-approve="${a.id}">Setujui</button>`) : pill(a.status)}</li>`).join('')
        : '<li><span class="li-icon green"><i class="bi bi-check-lg"></i></span><div class="li-main"><b>Tidak ada yang menunggu</b><small>Aksi masal di atas ambang otomatis masuk ke sini.</small></div></li>';
    } catch (err) { $('nxApprovals').innerHTML = `<li><div class="li-main"><small>${esc(err.message)}</small></div></li>`; }
  }
  $('nxApprovals').addEventListener('click', async e => {
    const ap = e.target.closest('[data-approve]'), rj = e.target.closest('[data-reject]');
    const btn = ap || rj; if (!btn) return;
    const id = ap ? ap.dataset.approve : rj.dataset.reject;
    if (ap && !(await N.confirmBox({ title: 'Setujui aksi masal?', okText: 'Setujui & jalankan', danger: true, message: 'Perintah langsung dikirim ke router untuk semua target di permintaan ini.' }))) return;
    btn.classList.add('busy');
    try {
      const out = await api(`/nms/api/approvals/${id}/${ap ? 'approve' : 'reject'}`, { method: 'POST', body: {} });
      toast(ap ? `Disetujui: ${out.summary?.succeeded ?? 0}/${out.summary?.total ?? 0} berhasil.` : 'Permintaan ditolak.', 'ok');
      loadApprovals(); N.loadBadges();
    } catch (err) { toast(err.message, 'err'); btn.classList.remove('busy'); }
  });

  // ---------------------------------------------------------------- Jadwal
  let schedTab = 'pending';
  async function loadSchedules() {
    try {
      const { rows } = await api(`/nms/api/schedules${qs({ status: schedTab || undefined })}`);
      const list = schedTab ? rows : rows.filter(r => r.status !== 'pending');
      $('nxSchedules').innerHTML = list.length ? list.map(s => `<li><span class="li-icon ${s.status === 'pending' ? 'blue' : s.status === 'failed' ? 'red' : 'gray'}"><i class="bi bi-calendar-event"></i></span><div class="li-main"><b>${esc(ACTION[s.action] || s.action)}${s.package_name ? ` → ${esc(s.package_name)}` : s.profile ? ` → ${esc(s.profile)}` : ''} · ${s.count} secret</b><small>${esc(dateTime(s.run_at))} · ${esc(s.targets.join(', '))}${s.count > s.targets.length ? ` +${s.count - s.targets.length}` : ''}${s.note ? ` · ${esc(s.note)}` : ''}${s.result ? ` · ${s.result.total - s.result.failed}/${s.result.total} berhasil` : ''}</small></div>${s.status === 'pending' && N.canControl ? `<button type="button" class="nx-btn sm ghost" data-cancel="${s.id}">Batalkan</button>` : pill(s.status)}</li>`).join('')
        : `<li><span class="li-icon gray"><i class="bi bi-calendar"></i></span><div class="li-main"><b>${schedTab ? 'Belum ada jadwal' : 'Belum ada riwayat'}</b><small>Jadwalkan isolir, buka isolir, kick, ganti profile, atau ganti paket di waktu tertentu.</small></div></li>`;
    } catch (err) { $('nxSchedules').innerHTML = `<li><div class="li-main"><small>${esc(err.message)}</small></div></li>`; }
  }
  $('nxSchedTabs').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; schedTab = b.dataset.k; document.querySelectorAll('#nxSchedTabs button').forEach(x => x.classList.toggle('active', x === b)); loadSchedules(); });
  $('nxSchedules').addEventListener('click', async e => {
    const b = e.target.closest('[data-cancel]'); if (!b) return;
    try { await api(`/nms/api/schedules/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }); toast('Jadwal dibatalkan.', 'ok'); loadSchedules(); } catch (err) { toast(err.message, 'err'); }
  });
  // Jadwal baru: pilih target lewat pencarian, lalu lanjut ke sheet jadwal standar.
  $('nxNewSchedule')?.addEventListener('click', () => {
    const picked = new Map();
    const s = N.sheet({ title: 'Jadwal baru', subtitle: 'Pilih pelanggan / secret yang akan diproses.', size: 'sm',
      body: `<div class="nx-field nx-ac"><label>Cari</label><input type="search" data-q placeholder="Nama, username, IP" autofocus autocomplete="off"><div class="nx-ac-list" data-list hidden></div></div><div class="nx-chips" data-picked></div>`,
      foot: '<button type="button" class="nx-btn" data-close>Batal</button><button type="button" class="nx-btn primary" data-next disabled>Lanjut</button>' });
    let rows = [], timer = null;
    const list = s.$('[data-list]');
    const paint = () => { s.$('[data-picked]').innerHTML = [...picked.values()].map(r => `<span class="nx-chip on">${esc(r.customer_name || r.username)}<span class="x" data-rm="${r.id}">×</span></span>`).join(''); s.$('[data-next]').disabled = !picked.size; s.$('[data-next]').textContent = picked.size ? `Lanjut (${picked.size})` : 'Lanjut'; };
    s.$('[data-q]').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => {
      const q = s.$('[data-q]').value.trim(); if (q.length < 2) { list.hidden = true; return; }
      try { ({ rows } = await api(`/nms/api/palette${qs({ q, site: N.site || undefined })}`)); list.innerHTML = rows.length ? rows.map((r, i) => `<button type="button" data-i="${i}"><span class="nx-state ${r.state}"></span><span class="grow">${esc(r.customer_name || r.username)}</span><small class="dim mono">${esc(r.username)}</small></button>`).join('') : '<div class="nx-empty">Tidak ditemukan.</div>'; list.hidden = false; } catch (_) {}
    }, 180); });
    list.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; const r = rows[Number(b.dataset.i)]; picked.set(r.id, r); list.hidden = true; s.$('[data-q]').value = ''; s.$('[data-q]').focus(); paint(); });
    s.$('[data-picked]').addEventListener('click', e => { const x = e.target.closest('[data-rm]'); if (x) { picked.delete(Number(x.dataset.rm)); paint(); } });
    s.$('[data-next]').addEventListener('click', () => { const ids = [...picked.keys()]; const label = picked.size === 1 ? [...picked.values()][0].customer_name || [...picked.values()][0].username : ''; s.close(); N.openSchedule(ids, label); });
  });

  // ---------------------------------------------------------------- Riwayat Smart Sync
  async function loadBatches() {
    try {
      const { rows } = await api('/nms/api/sync/batches');
      $('nxBatches').innerHTML = rows.length ? rows.map(b => `<li><span class="li-icon ${b.undone_at ? 'gray' : b.source === 'auto' ? 'purple' : 'green'}"><i class="bi ${b.source === 'auto' ? 'bi-robot' : 'bi-magic'}"></i></span><div class="li-main"><b>${b.linked_count} secret terhubung${b.site_code ? ` · ${esc(b.site_code)}` : ''}</b><small>${esc(dateTime(b.created_at))} · ${b.source === 'auto' ? 'otomatis' : esc(b.created_by_name || '—')}${b.undone_at ? ` · di-undo ${esc(b.undone_by_name || '')} ${esc(dateTime(b.undone_at))}` : ''} · ${esc(b.pairs.slice(0, 3).map(p => `${p.username} → ${p.customerName}`).join(', '))}${b.pairs.length > 3 ? '…' : ''}</small></div>
        <a class="nx-btn sm ghost" href="/nms/api/sync/batches/${b.id}/export" title="Ekspor CSV batch">CSV</a><button type="button" class="nx-btn sm ghost" data-view="${b.id}">Lihat</button>${b.can_undo && N.canControl ? `<button type="button" class="nx-btn sm orange" data-undo="${b.id}"><i class="bi bi-arrow-counterclockwise"></i>Undo</button>` : ''}</li>`).join('')
        : '<li><span class="li-icon gray"><i class="bi bi-magic"></i></span><div class="li-main"><b>Belum ada Smart Sync</b><small>Setiap commit Smart Sync tercatat di sini dan bisa dibatalkan dalam 24 jam.</small></div></li>';
      $('nxBatches').onclick = async e => {
        const v = e.target.closest('[data-view]'), u = e.target.closest('[data-undo]');
        if (v) { const b = rows.find(x => String(x.id) === v.dataset.view); N.sheet({ title: `Smart Sync #${b.id}`, subtitle: `${b.linked_count} pasangan · ${esc(dateTime(b.created_at))}`, body: `<ul class="nx-list nx-group">${b.pairs.map(p => `<li><div class="li-main"><b class="mono">${esc(p.username)}</b><small>${esc(p.customerName)} · ${esc(p.method || '')}</small></div></li>`).join('')}</ul>` }); }
        if (u) {
          if (!(await N.confirmBox({ title: 'Undo Smart Sync?', okText: 'Undo', danger: true, message: 'Semua pasangan di batch ini yang masih terhubung ke pelanggan yang sama akan dilepas lagi. Pasangan yang sudah diubah manual sejak sync tidak disentuh.' }))) return;
          u.classList.add('busy');
          try { const out = await api(`/nms/api/sync/batches/${u.dataset.undo}/undo`, { method: 'POST', body: {} }); toast(`${out.released} link dilepas${out.kept ? `, ${out.kept} sudah berubah dan dibiarkan` : ''}.`, 'ok'); loadBatches(); N.loadBadges(); }
          catch (err) { toast(err.message, 'err'); u.classList.remove('busy'); }
        }
      };
    } catch (err) { $('nxBatches').innerHTML = `<li><div class="li-main"><small>${esc(err.message)}</small></div></li>`; }
  }

  // ---------------------------------------------------------------- Diff konfigurasi
  const FIELD = { profile: 'Profile', disabled: 'Disabled', caller_id: 'MAC lock', remote_address: 'Remote IP', local_address: 'Local IP', service: 'Service', comment: 'Comment' };
  async function loadDiff() {
    const rid = $('nxDiffRouter')?.value;
    if (!rid) { $('nxDiff').innerHTML = '<div class="nx-empty">Tidak ada router di scope ini.</div>'; return; }
    try {
      const { diff: d } = await api(`/nms/api/routers/${rid}/diff`);
      if (!d.from) { $('nxDiff').innerHTML = `<div class="nx-note">${esc(d.note)}</div>`; return; }
      const total = d.added.length + d.removed.length + d.changed.length;
      $('nxDiff').innerHTML = `<div class="nx-mini-stats"><div><small>Ditambah</small><b style="color:var(--x-green)">${d.added.length}</b></div><div><small>Dihapus</small><b style="color:var(--x-red)">${d.removed.length}</b></div><div><small>Diubah</small><b style="color:var(--x-orange)">${d.changed.length}</b></div><div><small>Dibanding</small><b style="font-size:14px">${esc(N.dateOnly(d.from))}</b></div></div>
        ${total ? `<div class="nx-diff nx-group" style="padding:10px 14px;max-height:360px;overflow:auto">${d.added.map(s => `<div class="add">+ ${esc(s.username)} <span class="dim">${esc(s.profile || '')}</span></div>`).join('')}${d.removed.map(s => `<div class="del">− ${esc(s.username)} <span class="dim">${esc(s.profile || '')}</span></div>`).join('')}${d.changed.map(c => `<div class="chg">~ ${esc(c.username)} <span class="dim">${c.fields.map(f => `${FIELD[f.field] || f.field}: ${esc(f.from ?? '∅')} → ${esc(f.to ?? '∅')}`).join(' · ')}</span></div>`).join('')}</div>
          <p class="dim" style="font-size:12px;margin:8px 2px 0">Termasuk perubahan lewat Winbox di luar aplikasi. Kondisi "sekarang" berasal dari mirror secret terakhir (tiap 5 menit).</p>` : '<div class="nx-empty"><i class="bi bi-check-circle"></i>Tidak ada perubahan sejak snapshot terakhir.</div>'}`;
    } catch (err) { $('nxDiff').innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; }
  }
  $('nxDiffRouter')?.addEventListener('change', loadDiff);
  $('nxSnap')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.classList.add('busy');
    try { const out = await api('/nms/api/snapshots/take', { method: 'POST', body: {} }); toast(`Snapshot ${out.taken} router disimpan.`, 'ok'); loadDiff(); } catch (err) { toast(err.message, 'err'); }
    btn.classList.remove('busy');
  });

  // ---------------------------------------------------------------- Pengaturan
  const form = $('nxSettings');
  if (!N.isAdmin) form.querySelectorAll('input').forEach(i => { i.disabled = true; });
  form.addEventListener('input', () => { const s = $('nxSettingsState'); if (s) s.textContent = 'Belum disimpan'; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {};
    form.querySelectorAll('input[name]').forEach(i => { body[i.name] = i.type === 'checkbox' ? (i.checked ? '1' : '0') : i.value; });
    const btn = form.querySelector('[type=submit]'); btn.classList.add('busy');
    try { await api('/nms/api/settings', { method: 'POST', body }); toast('Pengaturan disimpan.', 'ok'); $('nxSettingsState').textContent = 'Tersimpan'; }
    catch (err) { toast(err.message, 'err'); }
    btn.classList.remove('busy');
  });
  $('nxPreviewSummary').addEventListener('click', async () => {
    const s = N.sheet({ title: 'Contoh ringkasan pagi', size: 'sm', body: '<div class="nx-empty">Menyusun…</div>' });
    try { const { text } = await api('/nms/api/summary/preview'); s.body.innerHTML = `<pre class="nx-pre">${esc(text)}</pre>`; } catch (err) { s.body.innerHTML = `<div class="nx-empty">${esc(err.message)}</div>`; }
  });
  $('nxSendSummary')?.addEventListener('click', async e => {
    const btn = e.currentTarget; btn.classList.add('busy');
    try { const out = await api('/nms/api/summary/send', { method: 'POST', body: {} }); toast(`Ringkasan masuk antrean WA ke ${out.sent} nomor.`, 'ok'); } catch (err) { toast(err.message, 'err'); }
    btn.classList.remove('busy');
  });

  const all = () => Promise.all([loadApprovals(), loadSchedules(), loadBatches(), loadDiff()]).then(() => N.markUpdated());
  document.addEventListener('nx:changed', () => setTimeout(all, 500));
  N.stream({ approval: () => loadApprovals(), sync: () => { loadSchedules(); loadBatches(); } }, { fallback: all, fallbackMs: 60000 });
  all();
  if (location.hash === '#sync') setTimeout(() => document.getElementById('sync')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
})();
