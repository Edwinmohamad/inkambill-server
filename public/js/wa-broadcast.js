/* Broadcast selektif & terjadwal (WA Gateway → Broadcast). */
(() => {
  const root = document.getElementById('waBroadcast');
  if (!root) return;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const templates = JSON.parse(root.dataset.templates || '[]');
  const AB = { min: Number(root.dataset.minDelay) || 0, max: Number(root.dataset.maxDelay) || 0, hourly: Number(root.dataset.hourly) || 0 };
  const MAX_CHARS = 4000;
  const selected = new Set();
  let rows = []; let total = 0;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const num = v => new Intl.NumberFormat('id-ID').format(Number(v || 0));
  const rupiah = v => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(v || 0));
  const fmtDate = v => v ? new Date(v).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }) : '-';
  const fmtDateTime = v => new Date(v).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
  const NET = { online: ['green', 'Online'], offline: ['gray', 'Offline'], isolated: ['red', 'Terisolir'], router_unreachable: ['orange', 'Router ?'] };
  const STATUS = { pending_approval: ['purple', 'Menunggu Persetujuan'], scheduled: ['purple', 'Terjadwal'], running: ['orange', 'Berjalan'], paused: ['gray', 'Dijeda'], completed: ['green', 'Selesai'], cancelled: ['red', 'Dibatalkan'] };
  const isSelectable = r => !r.blacklisted && r.whatsapp_status !== 'invalid';
  const emptyRow = (colspan, text) => { const tr = el('tr'); const td = el('td', 'wab-empty', text); td.colSpan = colspan; tr.appendChild(td); return tr; };

  async function api(url, { method = 'GET', body = null, form = null } = {}) {
    const opts = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (method !== 'GET') { opts.headers['X-CSRF-Token'] = csrf; if (form) opts.body = form; else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); } }
    const res = await fetch(url, opts); let data;
    try { data = await res.json(); } catch (_) { data = { ok: false, message: `HTTP ${res.status}` }; }
    if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }
  const filterParams = () => { const p = new URLSearchParams(); new FormData($('#wabFilter')).forEach((v, k) => { if (v) p.append(k, v); }); return p; };
  const filterObject = () => Object.fromEntries(filterParams());
  const PRESET_KEY = 'inkamnet.wa.broadcast.segments.v1';
  const readPresets = () => { try { const v = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } };
  function renderPresets() {
    const s = $('#wabPreset'); const current = s.value; s.replaceChildren(el('option', null, 'Segmen tersimpan…'));
    for (const name of Object.keys(readPresets()).sort((a, b) => a.localeCompare(b, 'id'))) { const o = el('option', null, name); o.value = name; s.appendChild(o); }
    if ([...s.options].some(o => o.value === current)) s.value = current;
  }
  $('#wabPresetSave').addEventListener('click', () => {
    const name = prompt('Nama segmen pelanggan:', $('#wabName').value || 'Segmen baru'); if (!name?.trim()) return;
    const p = readPresets(); p[name.trim().slice(0, 80)] = filterObject(); localStorage.setItem(PRESET_KEY, JSON.stringify(p)); renderPresets(); $('#wabPreset').value = name.trim().slice(0, 80);
  });
  $('#wabPresetDelete').addEventListener('click', () => { const name = $('#wabPreset').value; if (!name || !confirm(`Hapus segmen "${name}"?`)) return; const p = readPresets(); delete p[name]; localStorage.setItem(PRESET_KEY, JSON.stringify(p)); renderPresets(); });
  async function refreshFollowUp() {
    try {
      const data = await api('/wa-gateway/broadcast/api/follow-up');
      $$('[data-follow-up-count]').forEach(node => { node.textContent = num(data.counts[node.dataset.followUpCount] || 0); });
      $('#wabIsolationNote').textContent = `Isolir otomatis ${data.autoIsolate ? 'aktif' : 'nonaktif'}. Status "memenuhi syarat isolir" mengikuti jatuh tempo, masa toleransi, data PPPoE/router, dan penundaan isolir; ini bukan perintah isolir.`;
    } catch (_) { /* angka terakhir tetap tampil sampai halaman dimuat ulang */ }
  }
  $$('[data-follow-up]').forEach(card => card.addEventListener('click', () => {
    $('#wabFilter').reset();
    $('#wabFilter').elements.billing.value = card.dataset.followUp;
    selected.clear();
    $('input[name="target_mode"][value="filter"]').checked = true;
    $$('[data-follow-up]').forEach(item => item.classList.toggle('active', item === card));
    updateFilterBadge(); loadCandidates();
    $('#wabFilter').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  setInterval(refreshFollowUp, 60000);
  $('#wabPreset').addEventListener('change', e => {
    const data = readPresets()[e.target.value]; if (!data) return;
    for (const field of $('#wabFilter').elements) if (field.name) field.value = data[field.name] || '';
    selected.clear(); updateFilterBadge(); loadCandidates();
  });

  /* Penerima */
  async function loadCandidates() {
    $('#wabCount').textContent = 'Memuat…';
    try {
      const d = await api(`/wa-gateway/broadcast/api/candidates?${filterParams()}`);
      rows = d.rows; total = d.total; renderRows();
    } catch (e) { $('#wabCount').textContent = `Gagal memuat: ${e.message}`; }
  }
  function renderRows() {
    const tb = $('#wabRows'); tb.replaceChildren();
    if (!rows.length) tb.appendChild(emptyRow(7, 'Tidak ada pelanggan yang cocok dengan filter ini.'));
    for (const r of rows) {
      const tr = el('tr');
      tr.classList.toggle('is-muted', !isSelectable(r));
      tr.classList.toggle('is-selected', selected.has(r.id));
      const cb = el('input'); cb.type = 'checkbox'; cb.value = r.id; cb.checked = selected.has(r.id); cb.disabled = !isSelectable(r);
      cb.setAttribute('aria-label', `Pilih ${r.name}`);
      cb.addEventListener('change', () => { cb.checked ? selected.add(r.id) : selected.delete(r.id); tr.classList.toggle('is-selected', cb.checked); updateCounts(); });
      const c0 = el('td'); c0.appendChild(cb);
      const c1 = el('td'); c1.append(el('strong', null, r.name), el('span', 'wab-sub', r.customer_code));
      const c2 = el('td'); c2.appendChild(el('span', 'wab-mono', r.phone || '-'));
      if (r.blacklisted) c2.appendChild(el('span', 'wab-sub', 'Opt-out'));
      else if (r.whatsapp_status !== 'valid') c2.appendChild(el('span', 'wab-sub', `WA ${r.whatsapp_status || 'belum dicek'}`));
      const c3 = el('td', null, r.package || '-');
      const c4 = el('td', null, [r.cluster_name, r.router_name].filter(Boolean).join(' · ') || '-');
      const c5 = el('td');
      if (Number(r.outstanding) > 0) {
        c5.append(el('strong', null, rupiah(r.outstanding)), el('span', 'wab-sub', `Jatuh tempo ${fmtDate(r.next_due)}`));
        if (r.grace_until) c5.appendChild(el('span', 'wab-sub', `Batas toleransi ${fmtDate(r.grace_until)}`));
        if (r.isolate_hold_until) c5.appendChild(el('span', 'wab-sub', `Tunda isolir sampai ${fmtDate(r.isolate_hold_until)}`));
      }
      else c5.appendChild(el('span', 'wab-sub', 'Lunas'));
      const n = NET[r.network_status] || ['gray', r.network_status || '-'];
      const c6 = el('td'); c6.appendChild(el('span', `wab-pill ${n[0]}`, n[1]));
      tr.append(c0, c1, c2, c3, c4, c5, c6); tb.appendChild(tr);
    }
    updateCounts();
  }
  function updateCounts() {
    const cnt = $('#wabCount'); cnt.replaceChildren();
    cnt.append(el('b', null, num(total)), ` pelanggan cocok${total > rows.length ? ` · ${num(rows.length)} ditampilkan` : ''} · `, el('b', null, num(selected.size)), ' dipilih');
    $('#wabTotalLabel').textContent = num(total);
    $('#wabSelectedLabel').textContent = num(selected.size);
    const selectable = rows.filter(isSelectable);
    const all = $('#wabCheckAll');
    const picked = selectable.filter(r => selected.has(r.id)).length;
    all.checked = selectable.length > 0 && picked === selectable.length;
    all.indeterminate = picked > 0 && picked < selectable.length;
    if (selected.size) $('input[name="target_mode"][value="selected"]').checked = true;
    updateSummary();
  }
  const selectVisible = on => { rows.forEach(r => { if (!isSelectable(r)) return; on ? selected.add(r.id) : selected.delete(r.id); }); renderRows(); };
  $('#wabCheckAll').addEventListener('change', e => selectVisible(e.target.checked));
  $('#wabSelectAll').addEventListener('click', () => selectVisible(true));
  $('#wabDeselectAll').addEventListener('click', () => { selected.clear(); $('input[name="target_mode"][value="filter"]').checked = true; renderRows(); });
  $$('input[name="target_mode"]').forEach(r => r.addEventListener('change', updateSummary));

  function updateFilterBadge() {
    const n = $$('.wab-more select').filter(s => s.value).length;
    const b = $('#wabFilterCount'); b.hidden = !n; b.textContent = n;
  }
  let t = null;
  $('#wabFilter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadCandidates, 300); });
  $('#wabFilter').addEventListener('change', () => { updateFilterBadge(); clearTimeout(t); t = setTimeout(loadCandidates, 50); });
  $('#wabFilter').addEventListener('submit', e => { e.preventDefault(); loadCandidates(); });

  /* Pesan */
  const msg = $('#wabMessage');
  const outageRe = /\{(detail_gangguan|estimasi_selesai)\}/;
  function onMessageChange() {
    const len = msg.value.length; const c = $('#wabChars');
    c.textContent = `${num(len)} / ${num(MAX_CHARS)}`; c.classList.toggle('is-near', len > MAX_CHARS * 0.9);
    $('#wabOutage').hidden = !outageRe.test(msg.value);
    $('#wabMaintenance').hidden = !/\{jadwal_pemeliharaan\}/.test(msg.value);
    $('#wabAnnouncement').hidden = !/\{isi_pengumuman\}/.test(msg.value);
    updateSummary();
  }
  $('#wabTemplate').addEventListener('change', e => {
    const tpl = templates.find(x => x.key === e.target.value);
    if (tpl && (!msg.value.trim() || confirm('Ganti naskah dengan template terpilih?'))) msg.value = tpl.body;
    $('#wabOutage').hidden = e.target.value !== 'outage' && !outageRe.test(msg.value);
    $('#wabMaintenance').hidden = e.target.value !== 'maintenance' && !/\{jadwal_pemeliharaan\}/.test(msg.value);
    $('#wabAnnouncement').hidden = e.target.value !== 'announcement' && !/\{isi_pengumuman\}/.test(msg.value);
    if (!$('#wabName').value && tpl) $('#wabName').value = tpl.title;
    onMessageChange();
  });
  $$('[data-template-pick]').forEach(button => button.addEventListener('click', () => {
    const select = $('#wabTemplate');
    select.value = button.dataset.templatePick;
    select.dispatchEvent(new Event('change'));
    $$('[data-template-pick]').forEach(item => item.classList.toggle('active', item === button));
  }));
  msg.addEventListener('input', onMessageChange);
  $$('[data-insert]').forEach(b => b.addEventListener('click', () => {
    const s = msg.selectionStart ?? msg.value.length; const e = msg.selectionEnd ?? s;
    msg.value = msg.value.slice(0, s) + b.dataset.insert + msg.value.slice(e);
    const pos = s + b.dataset.insert.length; msg.focus(); msg.setSelectionRange(pos, pos);
    msg.dispatchEvent(new Event('input'));
  }));
  $('#wabPreviewBtn').addEventListener('click', async () => {
    const box = $('#wabPreviews'); box.replaceChildren();
    if (!msg.value.trim()) { box.appendChild(el('div', 'wab-preview-err', 'Tulis naskah dulu untuk melihat pratinjau.')); return; }
    const btn = $('#wabPreviewBtn'); btn.disabled = true;
    try {
      const firstId = [...selected][0] || rows[0]?.id || null;
      const d = await api('/wa-gateway/broadcast/api/preview', { method: 'POST', body: { message: msg.value, customer_id: firstId, detail_gangguan: $('#wabDetail').value, estimasi_selesai: $('#wabEta').value, jadwal_pemeliharaan: $('#wabMaintenanceAt').value, isi_pengumuman: $('#wabAnnouncementText').value } });
      d.samples.forEach((s, i) => { const w = el('div', 'wab-preview'); w.append(el('small', null, `Variasi ${i + 1}${firstId ? '' : ' · data contoh'}`), el('div', 'wab-bubble', s)); box.appendChild(w); });
    } catch (e) { box.appendChild(el('div', 'wab-preview-err', e.message)); }
    finally { btn.disabled = false; }
  });

  /* Kirim */
  const mode = () => $('input[name="wab_mode"]:checked').value;
  const targetMode = () => $('input[name="target_mode"]:checked').value;
  const recipientCount = () => targetMode() === 'selected' ? selected.size : total;
  function estimate(n) {
    if (!n) return '–';
    const byDelay = n * ((AB.min + AB.max) / 2);
    const byHourly = AB.hourly ? (n / AB.hourly) * 3600 : 0;
    const sec = Math.max(byDelay, byHourly);
    if (sec < 60) return '< 1 menit';
    const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60);
    return `± ${h ? `${h} j ` : ''}${m ? `${m} m` : ''}`.trim();
  }
  function updateSummary() {
    const n = recipientCount();
    $('#wabSumCount').textContent = num(n);
    const sched = $('#wabSchedule').value;
    $('#wabSumWhen').textContent = mode() === 'scheduled' ? (sched ? fmtDateTime(sched) : 'Pilih waktu') : 'Sekarang';
    $('#wabSumEta').textContent = estimate(n);
    $('#wabSumMsg').textContent = msg.value.trim() ? `${num(msg.value.length)} karakter` : 'Belum diisi';
    $('#wabSubmit').lastChild.textContent = mode() === 'scheduled' ? 'Jadwalkan broadcast' : 'Kirim broadcast';
  }
  $$('input[name="wab_mode"]').forEach(r => r.addEventListener('change', () => {
    const on = mode() === 'scheduled';
    $('#wabScheduleWrap').hidden = !on; $('#wabSchedule').disabled = !on;
    if (on) $('#wabSchedule').focus();
    updateSummary();
  }));
  $('#wabSchedule').addEventListener('input', updateSummary);

  function showResult(kind, text) { const out = $('#wabResult'); out.hidden = false; out.className = `wab-result${kind ? ` ${kind}` : ''}`; out.textContent = text; }
  $('#wabTestSend').addEventListener('click', async () => {
    const phone = $('#wabTestPhone').value.trim(); if (!phone) return showResult('err', 'Isi nomor WhatsApp Admin untuk pesan uji.');
    if (!msg.value.trim()) return showResult('err', 'Naskah pesan wajib diisi.');
    const btn = $('#wabTestSend'); btn.disabled = true;
    try {
      await api('/wa-gateway/broadcast/api/test-send', { method: 'POST', body: { phone, message: msg.value, customer_id: [...selected][0] || rows[0]?.id || null, detail_gangguan: $('#wabDetail').value, estimasi_selesai: $('#wabEta').value, jadwal_pemeliharaan: $('#wabMaintenanceAt').value, isi_pengumuman: $('#wabAnnouncementText').value } });
      showResult('ok', 'Pesan uji masuk antrean khusus ke nomor Admin.');
    } catch (e) { showResult('err', e.message); } finally { btn.disabled = false; }
  });
  $('#wabManualSend').addEventListener('click', async () => {
    if (selected.size !== 1) return showResult('err', 'Pilih tepat satu pelanggan untuk pengiriman manual.');
    if (!msg.value.trim()) return showResult('err', 'Naskah pesan wajib diisi.');
    if ($('#wabFile').files.length) return showResult('err', 'Lampiran tersedia melalui broadcast; kosongkan lampiran untuk pesan manual.');
    const customer = [...selected][0];
    if (!confirm('Kirim pesan manual ke satu pelanggan yang dipilih?')) return;
    const btn = $('#wabManualSend'); btn.disabled = true;
    try {
      const d = await api('/wa-gateway/broadcast/api/manual-send', { method: 'POST', body: {
        customer_id: customer, message: msg.value, detail_gangguan: $('#wabDetail').value,
        estimasi_selesai: $('#wabEta').value, jadwal_pemeliharaan: $('#wabMaintenanceAt').value,
        isi_pengumuman: $('#wabAnnouncementText').value,
      } });
      showResult('ok', `Pesan manual untuk ${d.customer} masuk antrean (#${d.id}). Pantau status di Log Pengiriman.`);
    } catch (e) { showResult('err', e.message); } finally { btn.disabled = false; }
  });
  $('#wabSubmit').addEventListener('click', async () => {
    const m = mode(); const tm = targetMode(); const count = recipientCount();
    if (!msg.value.trim()) { msg.focus(); return showResult('err', 'Naskah pesan wajib diisi.'); }
    if (!count) return showResult('err', 'Belum ada penerima.');
    if (m === 'scheduled' && !$('#wabSchedule').value) { $('#wabSchedule').focus(); return showResult('err', 'Pilih waktu kirim terlebih dahulu.'); }
    if (!confirm(`${m === 'scheduled' ? 'Jadwalkan' : 'Kirim'} broadcast ke ${num(count)} pelanggan? Pesan dikirim bertahap sesuai aturan anti-ban.`)) return;
    const btn = $('#wabSubmit'); btn.disabled = true; showResult('', 'Menyiapkan antrean…');
    try {
      const payload = { ...filterObject(), target_mode: tm, customer_ids: [...selected], name: $('#wabName').value || 'Broadcast', template_key: $('#wabTemplate').value || null, message: msg.value, detail_gangguan: $('#wabDetail').value, estimasi_selesai: $('#wabEta').value, jadwal_pemeliharaan: $('#wabMaintenanceAt').value, isi_pengumuman: $('#wabAnnouncementText').value, mode: m, scheduled_at: $('#wabSchedule').value };
      let request = { method: 'POST', body: payload };
      const file = $('#wabFile').files[0];
      if (file) { const form = new FormData(); Object.entries(payload).forEach(([k, v]) => Array.isArray(v) ? v.forEach(x => form.append(k, x)) : form.append(k, v ?? '')); form.append('file', file); request = { method: 'POST', form }; }
      const d = await api('/wa-gateway/broadcast', request);
      showResult('ok', `Broadcast #${d.id} dibuat. ${num(d.queued)} pesan ${d.pendingApproval ? 'menunggu persetujuan Admin di WA Gateway' : 'masuk antrean'}${d.scheduledAt ? `, terjadwal ${fmtDateTime(d.scheduledAt)}` : ''}. ${num(d.skippedBlacklist)} dilewati (opt-out), ${num(d.skippedInvalid)} nomor tidak valid.`);
      selected.clear(); renderRows(); loadList();
    } catch (e) { showResult('err', e.message); }
    finally { btn.disabled = false; }
  });

  /* Riwayat */
  const ACTION_LABEL = { pause: 'Jeda', resume: 'Lanjutkan', cancel: 'Batalkan', retry: 'Kirim ulang gagal' };
  function historyItem(b) {
    const li = el('li', 'wab-hist-item'); li.dataset.id = b.id;
    const st = STATUS[b.status] || ['gray', b.status];
    const totalN = Number(b.total_recipients) || 0; const sent = Number(b.sent) || 0; const failed = Number(b.failed) || 0;
    const main = el('div', 'wab-hist-main'); main.append(el('strong', null, b.name), el('span', null, `${b.created_by_name || '-'} · ${fmtDateTime(b.created_at)}`));
    const status = el('div', 'wab-hist-status'); status.append(el('span', `wab-pill ${st[0]}`, st[1]), el('span', null, b.scheduled_at ? fmtDateTime(b.scheduled_at) : 'Langsung'));
    const prog = el('div', 'wab-hist-progress'); const bar = el('div', 'wab-bar');
    const ok = el('i', 'ok'); ok.style.width = `${totalN ? Math.round(sent / totalN * 100) : 0}%`;
    const bad = el('i', 'fail'); bad.style.width = `${totalN ? Math.round(failed / totalN * 100) : 0}%`;
    bar.append(ok, bad);
    prog.append(bar, el('span', null, `${num(sent)}/${num(totalN)} terkirim${failed ? ` · ${num(failed)} gagal` : ''}${b.pending ? ` · ${num(b.pending)} antre` : ''}${b.cancelled ? ` · ${num(b.cancelled)} batal` : ''}`));
    const acts = el('div', 'wab-hist-actions');
    ({ running: ['pause', 'cancel'], scheduled: ['pause', 'cancel'], paused: ['resume', 'cancel'] }[b.status] || []).forEach(a => {
      const btn = el('button', a === 'cancel' ? 'danger' : null, ACTION_LABEL[a]); btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (a === 'cancel' && !confirm('Batalkan sisa pesan broadcast ini?')) return;
        btn.disabled = true;
        try { await api(`/wa-gateway/broadcast/${b.id}/${a}`, { method: 'POST' }); loadList(); } catch (e) { alert(e.message); btn.disabled = false; }
      });
      acts.appendChild(btn);
    });
    if (failed && b.status !== 'cancelled') {
      const btn = el('button', null, ACTION_LABEL.retry); btn.type = 'button';
      btn.addEventListener('click', async () => { if (!confirm(`Kirim ulang ${num(failed)} pesan yang gagal?`)) return; btn.disabled = true; try { await api(`/wa-gateway/broadcast/${b.id}/retry`, { method: 'POST' }); loadList(); } catch (e) { alert(e.message); btn.disabled = false; } });
      acts.appendChild(btn);
    }
    li.append(main, status, prog, acts);
    return li;
  }
  async function loadList() {
    try {
      const d = await api('/wa-gateway/broadcast/api/list'); const list = $('#wabList');
      list.replaceChildren(...(d.broadcasts.length ? d.broadcasts.map(historyItem) : [el('li', 'wab-empty', 'Belum ada broadcast.')]));
    } catch (_) { /* dicoba lagi pada interval berikutnya */ }
  }

  renderPresets(); updateFilterBadge(); onMessageChange();
  loadCandidates(); loadList();
  setInterval(() => { if (!document.hidden) loadList(); }, 15000);
})();
