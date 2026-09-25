(() => {
  const app = document.getElementById('monApp');
  if (!app) return;
  const isAdmin = app.dataset.admin === '1';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TONE = { ok: 'var(--success)', warn: 'var(--warning)', bad: 'var(--danger)', muted: 'var(--muted-2)' };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const toastEl = document.getElementById('monToast');
  let toastTimer = null;
  function toast(message, type = 'success') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `nms-toast ${type}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }
  function confirmAction(message) {
    return window.iosConfirm ? window.iosConfirm(message) : Promise.resolve(window.confirm(message));
  }

  async function jsonFetch(url, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) headers['X-CSRF-Token'] = meta.content;
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok || (data && data.ok === false)) throw new Error((data && data.message) || `Gagal memuat (${res.status})`);
    return data || {};
  }

  // ---------------- Filter / board state ----------------
  let currentSite = '';
  let currentBoard = 'ont';
  const cache = { ont: null, mikrotik: null, olt: null };
  let picked = { board: null, data: null };

  const queryString = () => (currentSite ? `site=${encodeURIComponent(currentSite)}` : '');

  function setNavBadge(board, text, tone) {
    const label = document.getElementById(`ccNav${cap(board)}`);
    const dot = document.getElementById(`ccDot${cap(board)}`);
    if (label) label.textContent = text;
    if (dot) dot.className = `cc-nav-dot ${tone}`;
  }

  function kpiHtml(items) {
    return items.map((k) => `<div class="cc-kpi"><span>${esc(k.label)}</span><strong class="${k.tone || ''}">${esc(k.value)}</strong>${k.sub ? `<span>${esc(k.sub)}</span>` : ''}</div>`).join('');
  }

  function attentionRowHtml(board, item, meta) {
    return `<div class="cc-row ${meta.picked ? 'picked' : ''}" data-pick-board="${board}" data-pick='${esc(JSON.stringify(item))}'>
      <span class="cc-row-dot" style="background:${meta.color}"></span>
      <div class="cc-row-main"><strong>${esc(meta.name)}</strong><small>${esc(meta.sub)}</small></div>
      <span class="cc-row-status" style="color:${meta.color}">${esc(meta.statusText)}</span>
    </div>`;
  }

  function wirePickTargets(container, board) {
    container.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', () => setPicked(board, JSON.parse(el.dataset.pick)));
    });
  }

  // ================= ONT board =================
  function ontTone(d) {
    if (d.online_status === 'offline') return 'bad';
    if (d.signal_status === 'critical') return 'bad';
    if (d.signal_status === 'warning') return 'warn';
    return 'ok';
  }
  function ontStatusText(d) {
    if (d.online_status === 'offline') return 'OFFLINE';
    if (d.signal_status === 'critical') return 'KRITIS';
    if (d.signal_status === 'warning') return 'LEMAH';
    return 'ONLINE';
  }
  function renderOntKpis(s) {
    document.getElementById('ccKpis').innerHTML = kpiHtml([
      { label: 'Total ONT', value: s.total },
      { label: 'Online', value: s.online, sub: s.total ? Math.round((s.online / s.total) * 100) + '%' : '', tone: 'ok' },
      { label: 'Offline', value: s.offline, tone: s.offline ? 'bad' : '' },
      { label: 'Skor Kesehatan', value: s.score == null ? 'N/A' : s.score, sub: s.score == null ? '' : '/100', tone: s.score >= 90 ? 'ok' : s.score >= 70 ? 'warn' : 'bad' }
    ]);
  }
  function renderOntAttention(list, pickedId) {
    document.getElementById('ccAttentionTitle').textContent = 'Perlu Tindakan';
    const box = document.getElementById('ccAttentionList');
    box.innerHTML = list && list.length
      ? list.map((a) => attentionRowHtml('ont', a, { name: a.customer_name || a.serial_number || ('ONT #' + a.id), sub: `${a.serial_number || a.device_id || '-'} · ${a.site_code || '-'}`, statusText: ontStatusText(a), color: TONE[ontTone(a)], picked: a.id === pickedId })).join('')
      : '<div class="mini-empty">Semua ONT dalam kondisi normal.</div>';
    wirePickTargets(box, 'ont');
  }
  function renderOntTable(devices, pickedId) {
    document.getElementById('ccTableHead').innerHTML = '<tr><th>Status</th><th>Pelanggan / ONT</th><th>Site</th><th>RX Power</th></tr>';
    const body = document.getElementById('ccTableBody');
    body.innerHTML = devices && devices.length
      ? devices.map((d) => `<tr class="${d.id === pickedId ? 'picked' : ''}" data-pick-board="ont" data-pick='${esc(JSON.stringify(d))}'>
          <td><span style="color:${TONE[ontTone(d)]};font-weight:700;font-size:.62rem;">${ontStatusText(d)}</span></td>
          <td><strong>${esc(d.customer_name || 'Belum dipetakan')}</strong><small>${esc(d.serial_number || d.device_id || '-')}</small></td>
          <td>${esc(d.site_code || '-')}</td>
          <td style="color:${TONE[ontTone(d)]}">${d.rx_power == null ? 'N/A' : Number(d.rx_power).toFixed(2) + ' dBm'}</td>
        </tr>`).join('')
      : '<tr><td colspan="4"><div class="empty-state"><small>Tidak ada data.</small></div></td></tr>';
    wirePickTargets(body, 'ont');
  }
  function renderOntBoardActions(acsConfigured) {
    document.getElementById('ccBoardActions').innerHTML = `<button type="button" class="btn-tech sm" id="ccOntSync"${acsConfigured ? '' : ' disabled title="GENIEACS_NBI_URL belum dikonfigurasi"'}><i class="bi bi-arrow-repeat"></i>Sync ACS</button>`;
    const btn = document.getElementById('ccOntSync');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { const r = await jsonFetch('/acs/sync', { method: 'POST' }); toast(r.message || 'Sinkronisasi dijalankan.'); loadOnt(); }
      catch (err) { toast(err.message, 'danger'); }
      finally { btn.disabled = false; }
    });
  }
  async function loadOnt() {
    try {
      const [summaryRes, listRes] = await Promise.all([
        jsonFetch(`/monitoring/api/ont?${queryString()}`),
        jsonFetch(`/monitoring/api/ont/list?${queryString()}`)
      ]);
      const s = summaryRes.summary;
      setNavBadge('ont', `${s.online}/${s.total} online`, s.offline ? 'bad' : ((summaryRes.attention || []).length ? 'warn' : 'ok'));
      cache.ont = { summary: s, attention: summaryRes.attention || [], devices: listRes.devices || [], acsConfigured: summaryRes.acsConfigured };
      if (currentBoard === 'ont') applyBoard('ont');
    } catch (err) {
      setNavBadge('ont', 'gagal memuat', 'bad');
      if (currentBoard === 'ont') toast(err.message, 'danger');
    }
  }

  // ================= MikroTik board =================
  function mtTone(d) {
    if (d.last_status === 'offline') return 'bad';
    if (d.cpu_load != null && d.cpu_load >= 85) return 'bad';
    if (d.cpu_load != null && d.cpu_load >= 60) return 'warn';
    return d.last_status === 'online' ? 'ok' : 'muted';
  }
  function mtStatusText(d) {
    if (d.last_status === 'offline') return 'OFFLINE';
    if (d.cpu_load != null && d.cpu_load >= 85) return 'PANAS';
    if (d.cpu_load != null && d.cpu_load >= 60) return 'WASPADA';
    if (d.last_status === 'online') return 'ONLINE';
    return 'BELUM DITES';
  }
  function mtHost(d) {
    try { return new URL(d.base_url).host; } catch (_) { return d.base_url || '-'; }
  }
  function renderMikrotikKpis(s) {
    document.getElementById('ccKpis').innerHTML = kpiHtml([
      { label: 'Total Router', value: s.total },
      { label: 'Online', value: s.online, sub: s.total ? Math.round((s.online / s.total) * 100) + '%' : '', tone: 'ok' },
      { label: 'Sesi PPPoE Aktif', value: s.activeSessions },
      { label: 'Pelanggan Isolir', value: s.customersIsolated, sub: '/ ' + s.customersTotal, tone: s.customersIsolated ? 'warn' : '' }
    ]);
  }
  function renderMikrotikAttention(list, pickedId) {
    document.getElementById('ccAttentionTitle').textContent = 'Perlu Tindakan';
    const box = document.getElementById('ccAttentionList');
    box.innerHTML = list && list.length
      ? list.map((d) => attentionRowHtml('mikrotik', d, { name: d.name, sub: mtHost(d), statusText: mtStatusText(d), color: TONE[mtTone(d)], picked: d.id === pickedId })).join('')
      : '<div class="mini-empty">Semua router dalam kondisi normal.</div>';
    wirePickTargets(box, 'mikrotik');
  }
  function renderMikrotikTable(devices, pickedId) {
    document.getElementById('ccTableHead').innerHTML = '<tr><th>Status</th><th>Router</th><th>CPU</th></tr>';
    const body = document.getElementById('ccTableBody');
    body.innerHTML = devices && devices.length
      ? devices.map((d) => `<tr class="${d.id === pickedId ? 'picked' : ''}" data-pick-board="mikrotik" data-pick='${esc(JSON.stringify(d))}'>
          <td><span style="color:${TONE[mtTone(d)]};font-weight:700;font-size:.62rem;">${mtStatusText(d)}</span></td>
          <td><strong>${esc(d.name)}</strong><small>${esc(mtHost(d))}</small></td>
          <td style="color:${TONE[mtTone(d)]}">${d.cpu_load != null ? d.cpu_load + '%' : '-'}</td>
        </tr>`).join('')
      : '<tr><td colspan="3"><div class="empty-state"><small>Tidak ada data.</small></div></td></tr>';
    wirePickTargets(body, 'mikrotik');
  }
  function renderMikrotikBoardActions() {
    document.getElementById('ccBoardActions').innerHTML = `<button type="button" class="btn-tech sm" id="ccMtCapture"><i class="bi bi-lightning-charge"></i>Capture Now</button><a class="btn-tech sm" href="/nms/secrets"><i class="bi bi-broadcast-pin"></i>NMS Monitor</a>`;
    const btn = document.getElementById('ccMtCapture');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { const r = await jsonFetch('/network/api/telemetry/capture', { method: 'POST' }); toast(`Telemetry ${r.result ? r.result.routers : ''} router diperbarui.`); loadMikrotik(); }
      catch (err) { toast(err.message, 'danger'); }
      finally { btn.disabled = false; }
    });
  }
  async function loadMikrotik() {
    try {
      const d = await jsonFetch(`/monitoring/api/mikrotik?${queryString()}`);
      const s = d.summary;
      setNavBadge('mikrotik', `${s.online}/${s.total} online`, s.offline ? 'bad' : ((d.attention || []).length ? 'warn' : 'ok'));
      cache.mikrotik = { summary: s, attention: d.attention || [], devices: d.devices || [] };
      if (currentBoard === 'mikrotik') applyBoard('mikrotik');
    } catch (err) {
      setNavBadge('mikrotik', 'gagal memuat', 'bad');
      if (currentBoard === 'mikrotik') toast(err.message, 'danger');
    }
  }

  // ================= OLT board =================
  function oltTone(o) {
    if (o.onu_critical > 0) return 'bad';
    if (o.last_status === 'offline') return 'bad';
    if (o.onu_offline > 0 || o.onu_warning > 0) return 'warn';
    return 'ok';
  }
  function oltStatusText(o) {
    if (o.onu_critical > 0) return 'KRITIS';
    if (o.last_status === 'offline') return 'TDK TERJANGKAU';
    if (o.onu_offline > 0) return 'ADA OFFLINE';
    if (o.onu_warning > 0) return 'WASPADA';
    return 'NORMAL';
  }
  function renderOltKpis(s) {
    document.getElementById('ccKpis').innerHTML = kpiHtml([
      { label: 'Total OLT', value: s.total },
      { label: 'ONU Online', value: `${s.online}/${s.totalOnu}`, tone: 'ok' },
      { label: 'Redaman Kritis', value: s.critical, tone: s.critical ? 'bad' : '' },
      { label: 'Skor Kesehatan', value: s.score == null ? 'N/A' : s.score, sub: s.score == null ? '' : '/100', tone: s.score >= 90 ? 'ok' : s.score >= 70 ? 'warn' : 'bad' }
    ]);
  }
  function renderOltAttention(list, pickedId) {
    document.getElementById('ccAttentionTitle').textContent = 'Perlu Tindakan';
    const box = document.getElementById('ccAttentionList');
    box.innerHTML = list && list.length
      ? list.map((o) => attentionRowHtml('olt', o, { name: o.name, sub: o.management_ip || 'IP belum diisi', statusText: oltStatusText(o), color: TONE[oltTone(o)], picked: o.id === pickedId })).join('')
      : '<div class="mini-empty">Semua OLT dalam kondisi normal.</div>';
    wirePickTargets(box, 'olt');
  }
  function renderOltTable(olts, pickedId) {
    document.getElementById('ccTableHead').innerHTML = '<tr><th>Status</th><th>OLT</th><th>ONU Online</th><th>Redaman Rata2</th></tr>';
    const body = document.getElementById('ccTableBody');
    body.innerHTML = olts && olts.length
      ? olts.map((o) => `<tr class="${o.id === pickedId ? 'picked' : ''}" data-pick-board="olt" data-pick='${esc(JSON.stringify(o))}'>
          <td><span style="color:${TONE[oltTone(o)]};font-weight:700;font-size:.62rem;">${oltStatusText(o)}</span></td>
          <td><strong>${esc(o.name)}</strong><small>${esc(o.management_ip || 'IP belum diisi')}</small></td>
          <td>${o.onu_online ?? 0}/${o.onu_total ?? 0}</td>
          <td style="color:${TONE[oltTone(o)]}">${o.avg_rx == null ? 'N/A' : o.avg_rx + ' dBm'}</td>
        </tr>`).join('')
      : '<tr><td colspan="4"><div class="empty-state"><small>Tidak ada data.</small></div></td></tr>';
    wirePickTargets(body, 'olt');
  }
  function renderOltBoardActions() {
    document.getElementById('ccBoardActions').innerHTML = `<a class="btn-tech sm" href="/network/olt"><i class="bi bi-hdd-network"></i>Registry OLT</a>`;
  }
  async function loadOlt() {
    try {
      const d = await jsonFetch(`/monitoring/api/olt?${queryString()}`);
      const s = d.summary;
      setNavBadge('olt', `${s.online}/${s.totalOnu} ONU online`, s.critical ? 'bad' : ((d.attention || []).length ? 'warn' : 'ok'));
      cache.olt = { summary: s, attention: d.attention || [], olts: d.olts || [] };
      if (currentBoard === 'olt') applyBoard('olt');
    } catch (err) {
      setNavBadge('olt', 'gagal memuat', 'bad');
      if (currentBoard === 'olt') toast(err.message, 'danger');
    }
  }

  // ================= Board switching / shared render =================
  const boards = { ont: loadOnt, mikrotik: loadMikrotik, olt: loadOlt };
  const titles = { ont: 'ONT Pelanggan', mikrotik: 'Router MikroTik', olt: 'OLT' };

  function applyBoard(board) {
    const c = cache[board];
    if (!c) {
      document.getElementById('ccKpis').innerHTML = '';
      document.getElementById('ccAttentionList').innerHTML = '<div class="mini-empty">Memuat...</div>';
      document.getElementById('ccTableHead').innerHTML = '';
      document.getElementById('ccTableBody').innerHTML = '';
      document.getElementById('ccBoardActions').innerHTML = '';
      return;
    }
    const pickedId = picked.board === board ? picked.data && picked.data.id : null;
    if (board === 'ont') {
      renderOntKpis(c.summary);
      renderOntAttention(c.attention, pickedId);
      renderOntTable(c.devices, pickedId);
      renderOntBoardActions(c.acsConfigured);
    } else if (board === 'mikrotik') {
      renderMikrotikKpis(c.summary);
      renderMikrotikAttention(c.attention, pickedId);
      renderMikrotikTable(c.devices, pickedId);
      renderMikrotikBoardActions();
    } else {
      renderOltKpis(c.summary);
      renderOltAttention(c.attention, pickedId);
      renderOltTable(c.olts, pickedId);
      renderOltBoardActions();
    }
  }

  function switchBoard(board) {
    currentBoard = board;
    document.querySelectorAll('.cc-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.board === board));
    document.getElementById('ccBoardTitle').textContent = titles[board];
    document.getElementById('ccSearchInput').value = '';
    document.getElementById('ccSearchResults').hidden = true;
    applyBoard(board);
    boards[board]();
  }
  document.querySelectorAll('.cc-nav-item').forEach((btn) => btn.addEventListener('click', () => switchBoard(btn.dataset.board)));
  document.addEventListener('keydown', (e) => {
    if (!(e.altKey || e.ctrlKey || e.metaKey)) return;
    if (e.key === '1') { e.preventDefault(); switchBoard('ont'); }
    else if (e.key === '2') { e.preventDefault(); switchBoard('mikrotik'); }
    else if (e.key === '3') { e.preventDefault(); switchBoard('olt'); }
  });

  // ================= Inspector panel (picked device) =================
  function clearPicked() {
    picked = { board: null, data: null };
    document.getElementById('ccPickedWrap').hidden = true;
    document.getElementById('ccEmptyPick').hidden = false;
    applyBoard(currentBoard);
  }
  document.getElementById('ccPickedClear')?.addEventListener('click', clearPicked);

  function remoteInfo(board, d) {
    if (board === 'ont') {
      return { ip: d.wan_ip || '', openUrl: null, note: 'IP WAN pelanggan, umumnya di balik CGNAT sehingga tidak bisa diakses langsung. Untuk kontrol jarak jauh gunakan aksi TR-069 di bawah (ping, cek redaman, ganti SSID/password, reboot).' };
    }
    if (board === 'mikrotik') {
      let ip = '', openUrl = null;
      try { const u = new URL(d.base_url); ip = u.host; openUrl = `${u.protocol}//${u.host}/`; } catch (_) { ip = d.base_url || ''; }
      return { ip, openUrl, note: 'Membuka halaman login WebFig router ini di tab baru.' };
    }
    const raw = d.management_ip || '';
    const openUrl = raw ? (/^https?:\/\//i.test(raw) ? raw : `http://${raw}/`) : null;
    return { ip: raw, openUrl, note: 'Membuka antarmuka web OLT (tergantung dukungan vendor).' };
  }
  function renderRemote(board, d) {
    const info = remoteInfo(board, d);
    const wrap = document.getElementById('ccRemote');
    if (!info.ip) { wrap.hidden = true; return; }
    wrap.hidden = false;
    document.getElementById('ccRemoteIp').textContent = info.ip;
    const openBtn = document.getElementById('ccRemoteOpen');
    openBtn.hidden = !info.openUrl;
    openBtn.onclick = () => window.open(info.openUrl, '_blank', 'noopener');
    document.getElementById('ccRemoteCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(info.ip); toast('IP disalin ke clipboard.'); }
      catch (_) { toast('Gagal menyalin IP.', 'danger'); }
    };
    document.getElementById('ccRemoteNote').textContent = info.note;
  }

  function showResult(message, tone) {
    const box = document.getElementById('ccActResult');
    box.hidden = false;
    box.className = `mon-action-result ${tone}`;
    box.textContent = message;
  }
  function pingLine(r) {
    return `${r.reachable ? 'Reachable' : 'Timeout'} · loss ${r.lossPercent ?? '?'}%${r.avgMs != null ? ' · avg ' + r.avgMs + 'ms' : ''}`;
  }

  function ontActionsHtml() {
    return `<button type="button" id="ccActPing"><i class="bi bi-broadcast"></i>Test Ping</button>
      <button type="button" id="ccActRedaman"><i class="bi bi-reception-4"></i>Cek Redaman</button>
      <button type="button" id="ccActSsid"><i class="bi bi-wifi"></i>Ganti SSID</button>
      <button type="button" id="ccActPassword"><i class="bi bi-key-fill"></i>Ganti Password</button>
      <button type="button" id="ccActReboot" style="grid-column:1/-1;color:var(--danger)"><i class="bi bi-power"></i>Reboot ONT</button>`;
  }
  function mtActionsHtml() {
    return `<button type="button" id="ccActTest"><i class="bi bi-plug-fill"></i>Test Koneksi</button>
      <button type="button" id="ccActPing"><i class="bi bi-broadcast"></i>Test Ping</button>
      <button type="button" id="ccActReboot" style="grid-column:1/-1;color:var(--danger)"><i class="bi bi-power"></i>Reboot Router</button>`;
  }
  function oltActionsHtml() {
    return `<button type="button" id="ccActPing" style="grid-column:1/-1"><i class="bi bi-broadcast"></i>Test Ping</button>`;
  }

  function wireOntActions(d) {
    const ids = ['ccActPing', 'ccActRedaman', 'ccActSsid', 'ccActPassword', 'ccActReboot'];
    if (!isAdmin) {
      ids.forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = true; });
      toast('Hanya Admin yang dapat menjalankan aksi ONT.', 'danger');
      return;
    }
    document.getElementById('ccActPing').onclick = async () => {
      try { const r = await jsonFetch(`/acs/devices/${d.id}/ping`, { method: 'POST' }); showResult(pingLine(r.result), r.result.reachable ? 'success' : 'danger'); }
      catch (err) { showResult(err.message, 'danger'); }
    };
    document.getElementById('ccActRedaman').onclick = async () => {
      try { const r = await jsonFetch(`/acs/devices/${d.id}/redaman`, { method: 'POST' }); showResult(`RX ${r.rxPower ?? 'N/A'} dBm · Suhu ${r.temperature ?? 'N/A'} · ${r.message || ''}`, 'success'); }
      catch (err) { showResult(err.message, 'danger'); }
    };
    document.getElementById('ccActSsid').onclick = async () => {
      const ssid = window.prompt('Nama WiFi (SSID) baru:');
      if (!ssid) return;
      try { const r = await jsonFetch(`/acs/devices/${d.id}/wifi-ssid`, { method: 'POST', body: JSON.stringify({ ssid }) }); showResult(r.message, 'success'); toast(r.message); }
      catch (err) { showResult(err.message, 'danger'); }
    };
    document.getElementById('ccActPassword').onclick = async () => {
      const password = window.prompt('Password WiFi baru (8-63 karakter):');
      if (!password) return;
      const ok = await confirmAction('Ganti password WiFi perangkat ini? Semua perangkat pelanggan yang terhubung akan terputus sementara.');
      if (!ok) return;
      try { const r = await jsonFetch(`/acs/devices/${d.id}/wifi-password`, { method: 'POST', body: JSON.stringify({ password }) }); showResult(r.message, 'success'); toast(r.message); }
      catch (err) { showResult(err.message, 'danger'); }
    };
    document.getElementById('ccActReboot').onclick = async () => {
      const confirmValue = window.prompt(`Ketik ulang serial number "${d.serial_number || d.device_id}" untuk konfirmasi reboot:`);
      if (!confirmValue) return;
      try { const r = await jsonFetch(`/acs/devices/${d.id}/reboot`, { method: 'POST', body: JSON.stringify({ confirm: confirmValue }) }); showResult(r.message, 'success'); toast(r.message); }
      catch (err) { showResult(err.message, 'danger'); }
    };
  }
  function wireMikrotikActions(d) {
    document.getElementById('ccActTest').onclick = async () => {
      try { const r = await jsonFetch(`/monitoring/api/mikrotik/test/${d.id}`, { method: 'POST' }); showResult(r.message, 'success'); toast(r.message); }
      catch (err) { showResult(err.message, 'danger'); }
    };
    document.getElementById('ccActPing').onclick = async () => {
      try { const r = await jsonFetch(`/monitoring/api/mikrotik/${d.id}/ping`, { method: 'POST' }); showResult(pingLine(r.result), r.result.reachable ? 'success' : 'danger'); }
      catch (err) { showResult(err.message, 'danger'); }
    };
    const rebootBtn = document.getElementById('ccActReboot');
    if (!isAdmin) { rebootBtn.disabled = true; toast('Hanya Admin yang dapat me-reboot router.', 'danger'); }
    rebootBtn.onclick = async () => {
      const confirmValue = window.prompt(`Ketik ulang nama router "${d.name}" untuk konfirmasi reboot. Semua sesi PPPoE pelanggan di router ini akan terputus sementara:`);
      if (!confirmValue) return;
      try { const r = await jsonFetch(`/monitoring/api/mikrotik/${d.id}/reboot`, { method: 'POST', body: JSON.stringify({ confirm: confirmValue }) }); showResult(r.message, 'success'); toast(r.message); loadMikrotik(); }
      catch (err) { showResult(err.message, 'danger'); }
    };
  }
  function wireOltActions(d) {
    document.getElementById('ccActPing').onclick = async () => {
      try { const r = await jsonFetch(`/monitoring/api/olt/${d.id}/ping`, { method: 'POST' }); showResult(pingLine(r.result), r.result.reachable ? 'success' : 'danger'); loadOlt(); }
      catch (err) { showResult(err.message, 'danger'); }
    };
  }

  function setPicked(board, data) {
    if (!data) { clearPicked(); return; }
    picked = { board, data };
    document.getElementById('ccEmptyPick').hidden = true;
    document.getElementById('ccPickedWrap').hidden = false;
    document.getElementById('ccActResult').hidden = true;

    let name, meta;
    if (board === 'ont') {
      name = data.customer_name || data.serial_number || ('ONT #' + data.id);
      meta = `${data.serial_number || data.device_id || '-'} · ${data.online_status === 'offline' ? 'Offline' : 'Online'}${data.rx_power != null ? ' · RX ' + data.rx_power + ' dBm' : ''}`;
    } else if (board === 'mikrotik') {
      name = data.name;
      meta = `${data.site_code ? data.site_code + ' · ' : ''}${data.last_status === 'offline' ? 'Offline' : data.last_status === 'online' ? 'Online' : 'Belum dites'}${data.cpu_load != null ? ' · CPU ' + data.cpu_load + '%' : ''}`;
    } else {
      name = data.name;
      meta = `${data.management_ip || 'IP belum diisi'} · ${data.onu_online ?? 0}/${data.onu_total ?? 0} ONU online`;
    }
    document.getElementById('ccPickedName').textContent = name;
    document.getElementById('ccPickedMeta').textContent = meta;

    renderRemote(board, data);

    const list = document.getElementById('ccActionList');
    list.innerHTML = board === 'ont' ? ontActionsHtml() : board === 'mikrotik' ? mtActionsHtml() : oltActionsHtml();
    if (board === 'ont') wireOntActions(data);
    else if (board === 'mikrotik') wireMikrotikActions(data);
    else wireOltActions(data);

    if (currentBoard === board) applyBoard(board);
  }

  // ================= Global search (per active board) =================
  let searchTimer = null;
  document.getElementById('ccSearchInput')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const box = document.getElementById('ccSearchResults');
    if (q.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const board = currentBoard;
        const url = board === 'ont' ? `/monitoring/api/ont/search?q=${encodeURIComponent(q)}`
          : board === 'mikrotik' ? `/monitoring/api/mikrotik/search?q=${encodeURIComponent(q)}`
          : `/monitoring/api/olt/search?q=${encodeURIComponent(q)}`;
        const key = board === 'ont' ? 'devices' : board === 'mikrotik' ? 'routers' : 'olts';
        const r = await jsonFetch(url);
        const items = r[key] || [];
        box.innerHTML = items.length
          ? items.map((it) => `<button type="button" data-pick='${esc(JSON.stringify(it))}'>${esc(it.customer_name || it.name || it.serial_number || it.device_id)}<small>${esc(it.serial_number || it.device_id || it.site_code || it.management_ip || '-')}</small></button>`).join('')
          : '<button type="button" disabled>Tidak ditemukan</button>';
        box.hidden = false;
        box.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
          setPicked(board, JSON.parse(btn.dataset.pick));
          box.hidden = true;
          e.target.value = '';
        }));
      } catch (err) { toast(err.message, 'danger'); }
    }, 300);
  });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('ccSearchInput')?.closest('.mon-search-wrap');
    if (wrap && !wrap.contains(e.target)) document.getElementById('ccSearchResults').hidden = true;
  });

  // ================= Site filter / nav site summary / bottom table =================
  async function loadNavSites() {
    try {
      const r = await jsonFetch('/monitoring/api/sites');
      const box = document.getElementById('ccNavSites');
      box.innerHTML = (r.sites || []).length
        ? r.sites.map((s) => `<div class="cc-nav-site-row ${currentSite === s.code ? 'active' : ''}" data-site="${esc(s.code)}"><span>${esc(s.code)}</span><span style="color:${s.ontCritical ? 'var(--danger)' : 'var(--muted-2)'}">${s.ontOnline}/${s.ontTotal}</span></div>`).join('')
        : '<div class="mini-empty">-</div>';
      box.querySelectorAll('[data-site]').forEach((row) => row.addEventListener('click', () => {
        currentSite = currentSite === row.dataset.site ? '' : row.dataset.site;
        applyFilterChange();
      }));
    } catch (_) { /* non-critical */ }
  }
  async function loadSiteTable() {
    const body = document.getElementById('monSiteTableBody');
    try {
      const r = await jsonFetch('/monitoring/api/sites');
      body.innerHTML = (r.sites || []).length
        ? r.sites.map((s) => `<tr class="mon-site-row" data-site="${esc(s.code)}" style="cursor:pointer">
            <td><strong>${esc(s.code)}</strong><small>${esc(s.name || '')}</small></td>
            <td style="color:${s.ontCritical ? 'var(--danger)' : ''}">${s.ontOnline}/${s.ontTotal}</td>
            <td style="color:${s.ontCritical ? 'var(--danger)' : ''}">${s.ontCritical}</td>
            <td>${s.routerOnline}/${s.routerTotal}</td>
          </tr>`).join('')
        : '<tr><td colspan="4"><div class="empty-state"><small>Tidak ada data site.</small></div></td></tr>';
      body.querySelectorAll('[data-site]').forEach((row) => row.addEventListener('click', () => {
        currentSite = currentSite === row.dataset.site ? '' : row.dataset.site;
        applyFilterChange();
      }));
    } catch (err) {
      body.innerHTML = `<tr><td colspan="4"><div class="empty-state"><small>${esc(err.message)}</small></div></td></tr>`;
    }
  }
  function applyFilterChange() {
    const sel = document.getElementById('monSiteFilter');
    if (sel) sel.value = currentSite;
    loadOnt(); loadMikrotik(); loadOlt(); loadSiteTable(); loadNavSites();
  }
  document.getElementById('monSiteFilter')?.addEventListener('change', (e) => { currentSite = e.target.value; applyFilterChange(); });

  const refreshBtn = document.getElementById('monRefreshBtn');
  const refreshIndicator = document.getElementById('monRefreshIndicator');
  function refreshAll() {
    loadOnt(); loadMikrotik(); loadOlt(); loadSiteTable(); loadNavSites();
    if (refreshIndicator) refreshIndicator.textContent = `diperbarui ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
  refreshBtn?.addEventListener('click', refreshAll);

  // ================= Init =================
  refreshAll();
  setInterval(refreshAll, 30000);
})();
