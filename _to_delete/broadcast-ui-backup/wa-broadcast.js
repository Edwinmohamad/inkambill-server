/* Broadcast selektif & terjadwal (WA Gateway → Broadcast). */
(() => {
  const root = document.getElementById('waBroadcast');
  if (!root) return;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const templates = JSON.parse(root.dataset.templates || '[]');
  const selected = new Set();
  let rows = []; let total = 0;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const rupiah = v => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(v || 0));
  const fmtDate = v => v ? new Date(v).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
  const NET = { online: ['green', 'Online'], offline: ['gray', 'Offline'], isolated: ['red', 'Terisolir'], router_unreachable: ['orange', 'Router ?'] };
  const STATUS = { scheduled: ['purple', 'Terjadwal'], running: ['orange', 'Berjalan'], paused: ['gray', 'Dijeda'], completed: ['green', 'Selesai'], cancelled: ['red', 'Dibatalkan'] };

  async function api(url, { method = 'GET', body = null } = {}) {
    const opts = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (method !== 'GET') { opts.headers['X-CSRF-Token'] = csrf; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    const res = await fetch(url, opts); let data;
    try { data = await res.json(); } catch (_) { data = { ok: false, message: `HTTP ${res.status}` }; }
    if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }
  const filterParams = () => { const p = new URLSearchParams(); new FormData($('#wabFilter')).forEach((v, k) => { if (v) p.append(k, v); }); return p; };
  const filterObject = () => Object.fromEntries(filterParams());

  async function loadCandidates() {
    $('#wabCount').textContent = 'Memuat…';
    try {
      const d = await api(`/wa-gateway/broadcast/api/candidates?${filterParams()}`);
      rows = d.rows; total = d.total; renderRows();
    } catch (e) { $('#wabCount').textContent = `Gagal: ${e.message}`; }
  }
  function renderRows() {
    const tb = $('#wabRows'); tb.replaceChildren();
    if (!rows.length) { const tr = el('tr'); const td = el('td', 'cell-sub', 'Tidak ada pelanggan yang cocok.'); td.colSpan = 7; tr.appendChild(td); tb.appendChild(tr); }
    for (const r of rows) {
      const tr = el('tr', r.blacklisted ? 'blacklisted' : '');
      const cb = el('input'); cb.type = 'checkbox'; cb.value = r.id; cb.checked = selected.has(r.id); cb.disabled = !!r.blacklisted || r.whatsapp_status === 'invalid';
      cb.addEventListener('change', () => { cb.checked ? selected.add(r.id) : selected.delete(r.id); updateCounts(); });
      const c0 = el('td'); c0.appendChild(cb);
      const c1 = el('td'); c1.append(el('strong', null, r.name), el('span', 'cell-sub', r.customer_code));
      const c2 = el('td', 'mono', r.phone || '-'); if (r.blacklisted) c2.appendChild(el('span', 'cell-sub', 'Opt-out (blacklist)')); else if (r.whatsapp_status !== 'valid') c2.appendChild(el('span', 'cell-sub', `WA ${r.whatsapp_status}`));
      const c3 = el('td', null, r.package || '-');
      const c4 = el('td', null, [r.cluster_name, r.router_name].filter(Boolean).join(' · ') || '-');
      const c5 = el('td'); if (Number(r.outstanding) > 0) { c5.append(el('strong', null, rupiah(r.outstanding)), el('span', 'cell-sub', `JT ${fmtDate(r.next_due)}`)); } else c5.textContent = 'Lunas';
      const n = NET[r.network_status] || ['gray', r.network_status || '-']; const c6 = el('td'); c6.appendChild(el('span', `status-badge ${n[0]}`, n[1]));
      tr.append(c0, c1, c2, c3, c4, c5, c6); tb.appendChild(tr);
    }
    updateCounts();
  }
  function updateCounts() {
    $('#wabCount').textContent = `${total} pelanggan cocok${total > rows.length ? ` (menampilkan ${rows.length})` : ''} · ${selected.size} dipilih`;
    $('#wabTotalLabel').textContent = total; $('#wabSelectedLabel').textContent = selected.size;
    const selectable = rows.filter(r => !r.blacklisted && r.whatsapp_status !== 'invalid');
    $('#wabCheckAll').checked = selectable.length > 0 && selectable.every(r => selected.has(r.id));
    if (selected.size) $('input[name="target_mode"][value="selected"]').checked = true;
  }
  const selectVisible = on => { rows.forEach(r => { if (r.blacklisted || r.whatsapp_status === 'invalid') return; on ? selected.add(r.id) : selected.delete(r.id); }); renderRows(); };
  $('#wabCheckAll').addEventListener('change', e => selectVisible(e.target.checked));
  $('#wabSelectAll').addEventListener('click', () => selectVisible(true));
  $('#wabDeselectAll').addEventListener('click', () => { selected.clear(); $('input[name="target_mode"][value="filter"]').checked = true; renderRows(); });
  let t = null;
  $('#wabFilter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadCandidates, 300); });
  $('#wabFilter').addEventListener('change', () => { clearTimeout(t); t = setTimeout(loadCandidates, 50); });
  $('#wabFilter').addEventListener('submit', e => { e.preventDefault(); loadCandidates(); });

  /* Naskah */
  const msg = $('#wabMessage');
  $('#wabTemplate').addEventListener('change', e => {
    const tpl = templates.find(x => x.key === e.target.value);
    if (tpl && (!msg.value.trim() || confirm('Ganti naskah dengan template terpilih?'))) msg.value = tpl.body;
    $('#wabOutage').classList.toggle('d-none', e.target.value !== 'outage' && !/\{(detail_gangguan|estimasi_selesai)\}/.test(msg.value));
    if (!$('#wabName').value && tpl) $('#wabName').value = tpl.title;
  });
  msg.addEventListener('input', () => { if (/\{(detail_gangguan|estimasi_selesai)\}/.test(msg.value)) $('#wabOutage').classList.remove('d-none'); });
  $$('[data-insert]').forEach(b => b.addEventListener('click', () => { const p = msg.selectionStart ?? msg.value.length; msg.value = msg.value.slice(0, p) + b.dataset.insert + msg.value.slice(p); msg.focus(); msg.dispatchEvent(new Event('input')); }));
  $('#wabPreviewBtn').addEventListener('click', async () => {
    const box = $('#wabPreviews'); box.replaceChildren();
    try {
      const firstId = [...selected][0] || rows[0]?.id || null;
      const d = await api('/wa-gateway/broadcast/api/preview', { method: 'POST', body: { message: msg.value, customer_id: firstId, detail_gangguan: $('#wabDetail').value, estimasi_selesai: $('#wabEta').value } });
      d.samples.forEach((s, i) => { const w = el('div'); w.append(el('small', 'wa-muted', `Variasi ${i + 1}${firstId ? '' : ' (data contoh)'}`), el('div', 'wa-bubble', s)); box.appendChild(w); });
    } catch (e) { box.appendChild(el('div', 'text-danger', e.message)); }
  });

  /* Mode & submit */
  $$('input[name="wab_mode"]').forEach(r => r.addEventListener('change', () => { $('#wabSchedule').disabled = $('input[name="wab_mode"]:checked').value !== 'scheduled'; }));
  $('#wabSubmit').addEventListener('click', async () => {
    const mode = $('input[name="wab_mode"]:checked').value;
    const targetMode = $('input[name="target_mode"]:checked').value;
    const count = targetMode === 'selected' ? selected.size : total;
    if (!msg.value.trim()) return alert('Naskah pesan wajib diisi.');
    if (!count) return alert('Belum ada penerima.');
    if (!confirm(`${mode === 'scheduled' ? 'Jadwalkan' : 'Kirim'} broadcast ke ${count} pelanggan? Pesan dikirim bertahap sesuai aturan anti-ban.`)) return;
    const btn = $('#wabSubmit'); btn.disabled = true; const out = $('#wabResult'); out.className = 'wai-verify-result'; out.textContent = 'Menyiapkan antrean…';
    try {
      const d = await api('/wa-gateway/broadcast', { method: 'POST', body: { ...filterObject(), target_mode: targetMode, customer_ids: [...selected], name: $('#wabName').value || 'Broadcast', template_key: $('#wabTemplate').value || null, message: msg.value, detail_gangguan: $('#wabDetail').value, estimasi_selesai: $('#wabEta').value, mode, scheduled_at: $('#wabSchedule').value } });
      out.classList.add('ok');
      out.textContent = `Broadcast #${d.id} dibuat: ${d.queued} pesan masuk antrean${d.scheduledAt ? ` (terjadwal ${new Date(d.scheduledAt).toLocaleString('id-ID')})` : ''}. ${d.skippedBlacklist} dilewati (opt-out), ${d.skippedInvalid} nomor tidak valid.`;
      selected.clear(); renderRows(); loadList();
    } catch (e) { out.classList.add('err'); out.textContent = e.message; }
    finally { btn.disabled = false; }
  });

  /* Riwayat */
  async function loadList() {
    try {
      const d = await api('/wa-gateway/broadcast/api/list'); const tb = $('#wabList'); tb.replaceChildren();
      if (!d.broadcasts.length) { const tr = el('tr'); const td = el('td', 'cell-sub', 'Belum ada broadcast.'); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); return; }
      d.broadcasts.forEach(b => {
        const tr = el('tr'); const st = STATUS[b.status] || ['gray', b.status];
        const c1 = el('td'); c1.append(el('strong', null, b.name), el('span', 'cell-sub', `${b.created_by_name || '-'} · ${new Date(b.created_at).toLocaleString('id-ID')}`));
        const c2 = el('td', null, b.scheduled_at ? new Date(b.scheduled_at).toLocaleString('id-ID') : 'Langsung');
        const c3 = el('td'); c3.appendChild(el('span', `status-badge ${st[0]}`, st[1]));
        const c4 = el('td', null, `${b.sent}/${b.total_recipients} terkirim${b.failed ? ` · ${b.failed} gagal` : ''}${b.pending ? ` · ${b.pending} antre` : ''}${b.cancelled ? ` · ${b.cancelled} batal` : ''}`);
        const c5 = el('td'); const acts = { running: ['pause', 'cancel'], scheduled: ['pause', 'cancel'], paused: ['resume', 'cancel'] }[b.status] || [];
        acts.forEach(a => { const btn = el('button', 'btn-tech', { pause: 'Jeda', resume: 'Lanjutkan', cancel: 'Batalkan' }[a]); btn.type = 'button'; btn.addEventListener('click', async () => { if (a === 'cancel' && !confirm('Batalkan sisa pesan broadcast ini?')) return; try { await api(`/wa-gateway/broadcast/${b.id}/${a}`, { method: 'POST' }); loadList(); } catch (e) { alert(e.message); } }); c5.appendChild(btn); });
        tr.append(c1, c2, c3, c4, c5); tb.appendChild(tr);
      });
    } catch (_) { /* dicoba lagi */ }
  }
  loadCandidates(); loadList(); setInterval(() => { if (!document.hidden) loadList(); }, 15000);
})();
