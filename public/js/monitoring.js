(() => {
  const app = document.getElementById('monApp');
  if (!app) return;
  const isAdmin = app.dataset.admin === '1';
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastEl = document.getElementById('monToast');
  const toast = (message, type = 'success') => {
    if (!toastEl) return;
    toastEl.className = `nms-toast ${type}`;
    toastEl.innerHTML = `<i class="bi ${type === 'danger' ? 'bi-x-octagon-fill' : 'bi-check-circle-fill'}"></i>${esc(message)}`;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 4500);
  };
  const confirmAction = (message) => window.iosConfirm ? window.iosConfirm(message) : Promise.resolve(window.confirm(message));

  // ---------------- Filter state ----------------
  let currentSite = '';
  const lastLoadAt = { ont: null, mikrotik: null, olt: null };
  const getActiveBoard = () => document.querySelector('#monSeg button.active')?.dataset.board || 'ont';
  const siteQuery = () => (currentSite ? `&site=${encodeURIComponent(currentSite)}` : '');
  const queryString = () => (currentSite ? `site=${encodeURIComponent(currentSite)}` : '');

  async function jsonFetch(url, opts = {}) {
    const response = await fetch(url, {
      ...opts,
      headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': csrfToken, ...(opts.headers || {}) }
    });
    let data = null;
    try { data = await response.json(); } catch (_) { /* noop */ }
    if (!response.ok || !data || data.ok === false) throw new Error(data?.error || `Permintaan gagal (${response.status})`);
    return data;
  }

  function ringHtml(pct, size = '') {
    if (pct === null || pct === undefined) return `<div class="m-ring ${size}" style="--p:0"><span>N/A</span></div>`;
    const cls = pct >= 90 ? '' : pct >= 70 ? 'warn' : 'bad';
    return `<div class="m-ring ${size} ${cls}" style="--p:${pct}"><span>${pct}%</span></div>`;
  }

  function barRow(label, value, total, tone = '', drill = null) {
    const pct = total ? Math.round((value / total) * 100) : 0;
    const cls = 'bar-row' + (drill ? ' bar-row-click' : '');
    const attrs = drill ? ` data-drill='${esc(JSON.stringify(drill))}' role="button" tabindex="0"` : '';
    return `<div class="${cls}"${attrs}><span class="row-title" title="${esc(label)}">${esc(label)}</span><div class="bar-track ${tone}"><span style="width:${pct}%"></span></div><span class="bar-num">${value}</span></div>`;
  }

  function timeAgo(iso) {
    if (!iso) return 'belum pernah';
    const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (diffMin < 1) return 'baru saja';
    if (diffMin < 60) return `${diffMin} menit lalu`;
    const hours = Math.round(diffMin / 60);
    if (hours < 24) return `${hours} jam lalu`;
    return `${Math.round(hours / 24)} hari lalu`;
  }

  // ---------------- Generic drill-down list modal ----------------
  let detailModalInstance = null;
  function getDetailModal() {
    if (!detailModalInstance && window.bootstrap) detailModalInstance = new window.bootstrap.Modal(document.getElementById('detailListModal'));
    return detailModalInstance;
  }
  async function openDetailList({ title, kicker, url }) {
    document.getElementById('detailListTitle').textContent = title;
    document.getElementById('detailListKicker').textContent = kicker;
    const body = document.getElementById('detailListBody');
    body.innerHTML = '<div class="mini-empty">Memuat...</div>';
    getDetailModal()?.show();
    try {
      const r = await jsonFetch(url);
      body.innerHTML = r.devices.length
        ? r.devices.map((dv) => `<button type="button" class="mon-detail-row" data-pick='${esc(JSON.stringify(dv))}'>
            <div><strong>${esc(dv.customer_name || dv.serial_number || dv.device_id || ('#' + dv.id))}</strong>
            <small>${esc(dv.serial_number || dv.device_id || '-')}${dv.site_code ? ' · ' + esc(dv.site_code) : ''}${dv.olt_name ? ' · ' + esc(dv.olt_name) + (dv.pon_port ? '/' + esc(dv.pon_port) : '') : ''}</small></div>
            <span class="status-badge ${dv.online_status === 'offline' ? 'red' : dv.signal_status === 'critical' ? 'red' : dv.signal_status === 'warning' ? 'orange' : 'green'}">${dv.online_status === 'offline' ? 'Offline' : (dv.rx_power !== null && dv.rx_power !== undefined ? dv.rx_power + ' dBm' : (dv.signal_status || 'Online'))}</span>
          </button>`).join('')
        : '<div class="mini-empty">Tidak ada perangkat yang cocok dengan kategori ini.</div>';
      body.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
        const picked = JSON.parse(btn.dataset.pick);
        getDetailModal()?.hide();
        setTimeout(() => openOntModal(picked), 300);
      }));
    } catch (err) { body.innerHTML = `<div class="mini-empty">${esc(err.message)}</div>`; }
  }
  function wireDrillTargets(container) {
    container.querySelectorAll('[data-drill]').forEach((el) => el.addEventListener('click', () => openDetailList(JSON.parse(el.dataset.drill))));
  }

  // ---------------- ONT board ----------------
  function renderOnt(d) {
    const s = d.summary;
    const normal = Math.max(0, s.total - s.warning - s.critical);
    const attentionHtml = d.attention.length
      ? d.attention.map((a) => `<a href="#" data-open-device="${a.id}"><span>${esc(a.customer_name || a.serial_number || 'ONT #' + a.id)}</span><span>${a.online_status === 'offline' ? 'Offline' : (a.rx_power !== null ? a.rx_power + ' dBm' : a.signal_status)}</span></a>`).join('')
      : '<div class="mini-empty">Semua ONT dalam kondisi normal.</div>';
    const container = document.getElementById('bento-ont');
    container.innerHTML = `
      <div class="b-hero"><h4>Kesehatan ONT</h4><div><strong>${s.online}/${s.total}</strong><br><small>ONT online sekarang</small></div>${ringHtml(s.score, 'lg')}</div>
      <div class="b-wide"><h4>Distribusi Sinyal</h4>
        ${barRow('Normal', normal, s.total, '', { title: 'ONT Sinyal Normal', kicker: 'DISTRIBUSI SINYAL', url: `/monitoring/api/ont/list?signal=normal_group${siteQuery()}` })}
        ${barRow('Waspada', s.warning, s.total, 'warn', { title: 'ONT Sinyal Waspada', kicker: 'DISTRIBUSI SINYAL', url: `/monitoring/api/ont/list?signal=warning${siteQuery()}` })}
        ${barRow('Kritis', s.critical, s.total, 'bad', { title: 'ONT Sinyal Kritis', kicker: 'DISTRIBUSI SINYAL', url: `/monitoring/api/ont/list?signal=critical${siteQuery()}` })}
      </div>
      <div class="mon-drill" data-drill='${esc(JSON.stringify({ title: 'ONT Offline', kicker: 'STATUS ONT', url: `/monitoring/api/ont/list?status=offline${siteQuery()}` }))}'><h4>ONT Offline</h4><strong>${s.offline}</strong><small>dari ${s.total} total ONT</small></div>
      <div><h4>Belum Ter-link</h4><strong>${s.unlinked}</strong><small>ONT tanpa data pelanggan</small></div>
      <div class="b-tall"><h4>Perlu Tindakan</h4><div class="mini-list">${attentionHtml}</div></div>
      <div><h4>Aksi Cepat</h4><div class="action-grid">
        <button type="button" id="ontActionOpen">Kelola ONT</button>
        <button type="button" id="ontSyncNow" ${d.acsConfigured ? '' : 'disabled title="GENIEACS_NBI_URL belum dikonfigurasi"'}>Sync ACS</button>
      </div></div>
      <div><h4>Sinkron Terakhir</h4><strong>${d.lastSync ? timeAgo(d.lastSync.finished_at) : 'belum pernah'}</strong><small>${d.lastSync ? esc(d.lastSync.status) : 'ACS belum sinkron'}</small></div>`;

    wireDrillTargets(container);
    document.getElementById('ontActionOpen')?.addEventListener('click', () => openOntModal());
    document.getElementById('ontSyncNow')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await jsonFetch('/acs/sync', { method: 'POST' }); toast(r.message); loadOnt(); }
      catch (err) { toast(err.message, 'danger'); }
      finally { btn.disabled = false; }
    });
    container.querySelectorAll('[data-open-device]').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      const attn = d.attention.find((a) => String(a.id) === el.dataset.openDevice);
      openOntModal(attn ? { id: attn.id, serial_number: attn.serial_number, customer_name: attn.customer_name, online_status: attn.online_status, signal_status: attn.signal_status, rx_power: attn.rx_power } : null);
    }));
  }

  async function loadOnt() {
    try { const d = await jsonFetch(`/monitoring/api/ont?${queryString()}`); renderOnt(d); lastLoadAt.ont = Date.now(); }
    catch (err) { document.getElementById('bento-ont').innerHTML = `<div class="b-hero"><h4>Gagal memuat</h4><small>${esc(err.message)}</small></div>`; }
  }

  // ---------------- MikroTik board ----------------
  function renderMikrotik(d) {
    const s = d.summary;
    const topCpu = [...d.attention].filter((r) => r.cpu_load !== null).sort((a, b) => b.cpu_load - a.cpu_load).slice(0, 3);
    const cpuBars = topCpu.length
      ? topCpu.map((r) => `<div class="bar-row bar-row-click" data-test-router="${r.id}" title="Klik untuk test koneksi sekarang"><span class="row-title" title="${esc(r.name)}">${esc(r.name)}</span><div class="bar-track ${r.cpu_load >= 85 ? 'bad' : r.cpu_load >= 60 ? 'warn' : ''}"><span style="width:${Math.min(100, r.cpu_load)}%"></span></div><span class="bar-num">${r.cpu_load}%</span></div>`).join('')
      : '<small>Belum ada data CPU historis (menunggu siklus telemetry berikutnya).</small>';
    const attentionHtml = d.attention.length
      ? d.attention.map((r) => `<a href="#" data-test-router="${r.id}"><span>${esc(r.name)}</span><span>${r.last_status === 'offline' ? 'Offline' : (r.cpu_load !== null ? 'CPU ' + r.cpu_load + '%' : '-')}</span></a>`).join('')
      : '<div class="mini-empty">Semua router normal.</div>';
    const container = document.getElementById('bento-mikrotik');
    container.innerHTML = `
      <div class="b-hero"><h4>Kesehatan Router</h4><div><strong>${s.online}/${s.total}</strong><br><small>router online</small></div>${ringHtml(s.score, 'lg')}</div>
      <div class="b-wide"><h4>Beban CPU &ndash; Perlu Perhatian</h4>${cpuBars}</div>
      <div><h4>Sesi PPPoE Aktif</h4><strong>${s.activeSessions}</strong><small>koneksi berjalan</small></div>
      <div><h4>Pelanggan Isolir</h4><strong>${s.customersIsolated}</strong><small>dari ${s.customersTotal} pelanggan aktif</small></div>
      <div class="b-tall"><h4>Perlu Perhatian</h4><div class="mini-list">${attentionHtml}</div></div>
      <div><h4>Aksi Cepat</h4><div class="action-grid">
        <button type="button" id="mtActionOpen">Kelola Router</button>
        <button type="button" id="mtCaptureNow">Capture Now</button>
        <a class="btn-tech" href="/network/monitor" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;grid-column:1/-1">NMS Monitor</a>
      </div></div>
      <div><h4>Belum Pernah Lapor</h4><strong>${s.never}</strong><small>router belum ada telemetry masuk</small></div>`;

    document.getElementById('mtActionOpen')?.addEventListener('click', () => openMikrotikModal());
    document.getElementById('mtCaptureNow')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await jsonFetch('/network/api/telemetry/capture', { method: 'POST' }); toast(`Telemetry ${r.result.routers} router diperbarui.`); loadMikrotik(); }
      catch (err) { toast(err.message, 'danger'); }
      finally { btn.disabled = false; }
    });
    container.querySelectorAll('[data-test-router]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = el.dataset.testRouter;
      try { const r = await jsonFetch(`/monitoring/api/mikrotik/test/${id}`, { method: 'POST' }); toast(r.message); loadMikrotik(); }
      catch (err) { toast(err.message, 'danger'); }
    }));
  }

  async function loadMikrotik() {
    try { const d = await jsonFetch(`/monitoring/api/mikrotik?${queryString()}`); renderMikrotik(d); lastLoadAt.mikrotik = Date.now(); }
    catch (err) { document.getElementById('bento-mikrotik').innerHTML = `<div class="b-hero"><h4>Gagal memuat</h4><small>${esc(err.message)}</small></div>`; }
  }

  // ---------------- OLT board ----------------
  function renderOlt(d) {
    const s = d.summary;
    const withUtil = d.olts.map((o) => ({ ...o, util: o.pon_ports_used ? Math.min(999, Math.round((o.onu_total / (o.pon_ports_used * o.pon_port_capacity)) * 100)) : 0 }));
    const topUtil = [...withUtil].sort((a, b) => b.util - a.util).slice(0, 3);
    const utilBars = topUtil.length
      ? topUtil.map((o) => barRow(o.name, Math.min(100, o.util), 100, o.util >= 90 ? 'bad' : o.util >= 70 ? 'warn' : '', { title: `ONT di ${o.name}`, kicker: 'UTILISASI OLT', url: `/monitoring/api/ont/list?olt=${encodeURIComponent(o.name)}${siteQuery()}` })).join('')
      : '<small>Belum ada OLT dengan data PON port.</small>';
    const attentionHtml = d.attention.length
      ? d.attention.map((o) => `<a href="#" data-drill='${esc(JSON.stringify({ title: `ONT di ${o.name}`, kicker: 'PERLU PERHATIAN', url: `/monitoring/api/ont/list?olt=${encodeURIComponent(o.name)}${siteQuery()}` }))}'><span>${esc(o.name)}</span><span>${o.onu_offline} offline · ${o.onu_critical} kritis</span></a>`).join('')
      : '<div class="mini-empty">Semua OLT dalam kondisi normal.</div>';
    const container = document.getElementById('bento-olt');
    container.innerHTML = `
      <div class="b-hero"><h4>Utilisasi ONU</h4><div><strong>${s.online}/${s.totalOnu}</strong><br><small>ONU online, seluruh OLT</small></div>${ringHtml(s.score, 'lg')}</div>
      <div class="b-wide"><h4>Utilisasi PON per OLT</h4>${utilBars}</div>
      <div><h4>Total OLT</h4><strong>${s.total}</strong><small>chassis terdeteksi/terdaftar</small></div>
      <div><h4>Redaman Kritis</h4><strong>${s.critical}</strong><small>ONU RX di bawah ambang aman</small></div>
      <div class="b-tall"><h4>Perlu Perhatian</h4><div class="mini-list">${attentionHtml}</div></div>
      <div><h4>Aksi Cepat</h4><div class="action-grid">
        <button type="button" id="oltActionOpen">Kelola OLT</button>
        <a class="btn-tech" href="/olt" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center">Registry OLT</a>
        <a class="btn-tech" href="/acs?signal=critical" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;grid-column:1/-1">ONT Kritis</a>
      </div></div>
      <div><h4>Ø ONU / OLT</h4><strong>${s.total ? Math.round(s.totalOnu / s.total) : 0}</strong><small>rata-rata per chassis</small></div>`;
    wireDrillTargets(container);
    document.getElementById('oltActionOpen')?.addEventListener('click', () => openOltModal());
  }

  async function loadOlt() {
    try { const d = await jsonFetch(`/monitoring/api/olt?${queryString()}`); renderOlt(d); lastLoadAt.olt = Date.now(); }
    catch (err) { document.getElementById('bento-olt').innerHTML = `<div class="b-hero"><h4>Gagal memuat</h4><small>${esc(err.message)}</small></div>`; }
  }

  // ---------------- Per-site summary table ----------------
  async function loadSiteTable() {
    const body = document.getElementById('monSiteTableBody');
    try {
      const r = await jsonFetch('/monitoring/api/sites');
      body.innerHTML = r.sites.length
        ? r.sites.map((s) => `<tr class="mon-site-row ${currentSite === s.code ? 'active' : ''}" data-site="${esc(s.code)}" role="button" tabindex="0">
            <td><span class="cell-main">${esc(s.code)}</span><span class="cell-sub">${esc(s.name)}</span></td>
            <td>${s.ontOnline}/${s.ontTotal}</td>
            <td>${s.ontCritical}</td>
            <td>${s.routerOnline}/${s.routerTotal}</td>
          </tr>`).join('')
        : '<tr><td colspan="4"><div class="empty-state"><small>Belum ada site aktif.</small></div></td></tr>';
      body.querySelectorAll('[data-site]').forEach((row) => row.addEventListener('click', () => {
        const code = row.dataset.site;
        currentSite = currentSite === code ? '' : code;
        document.getElementById('monSiteFilter').value = currentSite;
        loaded.clear();
        boards[getActiveBoard()]();
        loadSiteTable();
      }));
    } catch (err) { body.innerHTML = `<tr><td colspan="4">${esc(err.message)}</td></tr>`; }
  }

  // ---------------- Segmented board control + filters ----------------
  const boards = { ont: loadOnt, mikrotik: loadMikrotik, olt: loadOlt };
  const loaded = new Set();
  function switchBoard(board) {
    document.querySelectorAll('#monSeg button').forEach((b) => b.classList.toggle('active', b.dataset.board === board));
    Object.keys(boards).forEach((key) => { document.getElementById('bento-' + key).style.display = key === board ? '' : 'none'; });
    if (!loaded.has(board)) { loaded.add(board); boards[board](); }
    tickIndicator();
  }
  document.querySelectorAll('#monSeg button').forEach((btn) => btn.addEventListener('click', () => switchBoard(btn.dataset.board)));

  document.getElementById('monSiteFilter')?.addEventListener('change', (e) => {
    currentSite = e.target.value;
    loaded.clear();
    boards[getActiveBoard()]();
    loadSiteTable();
  });
  document.getElementById('monRefreshBtn')?.addEventListener('click', () => { boards[getActiveBoard()](); loadSiteTable(); });

  function tickIndicator() {
    const el = document.getElementById('monRefreshIndicator');
    if (!el) return;
    const t = lastLoadAt[getActiveBoard()];
    el.textContent = t ? `diperbarui ${Math.max(0, Math.round((Date.now() - t) / 1000))} detik lalu` : 'memuat...';
  }
  setInterval(tickIndicator, 1000);

  // Auto-refresh the currently visible board every 30s so the dashboard stays live.
  setInterval(() => { boards[getActiveBoard()](); }, 30000);

  // Keyboard shortcuts 1/2/3 to jump between boards, ignored while typing in a field.
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) return;
    const map = { '1': 'ont', '2': 'mikrotik', '3': 'olt' };
    if (map[e.key]) switchBoard(map[e.key]);
  });

  loaded.add('ont'); loadOnt(); loadSiteTable();

  // ---------------- ONT action modal ----------------
  let ontModalInstance = null;
  let pickedDevice = null;
  function getOntModal() {
    if (!ontModalInstance && window.bootstrap) ontModalInstance = new window.bootstrap.Modal(document.getElementById('ontActionModal'));
    return ontModalInstance;
  }
  function setPicked(device) {
    pickedDevice = device;
    const wrap = document.getElementById('ontPickedWrap');
    const resultBox = document.getElementById('ontActResult');
    resultBox.hidden = true;
    if (!device) { wrap.hidden = true; return; }
    wrap.hidden = false;
    document.getElementById('ontPickedName').textContent = device.customer_name || device.serial_number || `ONT #${device.id}`;
    document.getElementById('ontPickedMeta').textContent = `${device.serial_number || device.device_id || '-'} · ${device.online_status === 'offline' ? 'Offline' : 'Online'}${device.rx_power !== undefined && device.rx_power !== null ? ' · RX ' + device.rx_power + ' dBm' : ''}`;
    const disabled = !isAdmin;
    ['ontActPing', 'ontActRedaman', 'ontActSsid', 'ontActPassword', 'ontActReboot'].forEach((id) => { document.getElementById(id).disabled = disabled; });
    if (disabled) toast('Hanya Admin yang dapat menjalankan aksi ONT.', 'danger');
  }
  function openOntModal(device) {
    setPicked(device || null);
    document.getElementById('ontSearchInput').value = '';
    document.getElementById('ontSearchResults').hidden = true;
    getOntModal()?.show();
  }
  document.getElementById('ontPickedClear')?.addEventListener('click', () => setPicked(null));

  let searchTimer = null;
  document.getElementById('ontSearchInput')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const box = document.getElementById('ontSearchResults');
    if (q.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await jsonFetch(`/monitoring/api/ont/search?q=${encodeURIComponent(q)}`);
        box.innerHTML = r.devices.length
          ? r.devices.map((dv) => `<button type="button" data-pick='${esc(JSON.stringify(dv))}'>${esc(dv.customer_name || dv.serial_number || dv.device_id)}<small>${esc(dv.serial_number || dv.device_id)} · ${dv.online_status === 'offline' ? 'Offline' : 'Online'}</small></button>`).join('')
          : '<button type="button" disabled>Tidak ditemukan</button>';
        box.hidden = false;
        box.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
          setPicked(JSON.parse(btn.dataset.pick));
          box.hidden = true;
        }));
      } catch (err) { toast(err.message, 'danger'); }
    }, 300);
  });

  function showActResult(message, tone) {
    const box = document.getElementById('ontActResult');
    box.hidden = false;
    box.className = `mon-action-result ${tone}`;
    box.textContent = message;
  }

  document.getElementById('ontActPing')?.addEventListener('click', async () => {
    if (!pickedDevice) return;
    try { const r = await jsonFetch(`/acs/devices/${pickedDevice.id}/ping`, { method: 'POST' }); showActResult(`${r.result.reachable ? 'Reachable' : 'Timeout'} · loss ${r.result.lossPercent ?? '?'}%${r.result.avgMs !== null ? ' · avg ' + r.result.avgMs + 'ms' : ''}`, r.result.reachable ? 'success' : 'danger'); }
    catch (err) { showActResult(err.message, 'danger'); }
  });
  document.getElementById('ontActRedaman')?.addEventListener('click', async () => {
    if (!pickedDevice) return;
    try { const r = await jsonFetch(`/acs/devices/${pickedDevice.id}/redaman`, { method: 'POST' }); showActResult(`RX ${r.rxPower ?? 'N/A'} dBm · Suhu ${r.temperature ?? 'N/A'} · ${r.message}`, 'success'); }
    catch (err) { showActResult(err.message, 'danger'); }
  });
  document.getElementById('ontActSsid')?.addEventListener('click', async () => {
    if (!pickedDevice) return;
    const ssid = window.prompt('Nama WiFi (SSID) baru:');
    if (!ssid) return;
    try { const r = await jsonFetch(`/acs/devices/${pickedDevice.id}/wifi-ssid`, { method: 'POST', body: JSON.stringify({ ssid }) }); showActResult(r.message, 'success'); toast(r.message); }
    catch (err) { showActResult(err.message, 'danger'); }
  });
  document.getElementById('ontActPassword')?.addEventListener('click', async () => {
    if (!pickedDevice) return;
    const password = window.prompt('Password WiFi baru (8-63 karakter):');
    if (!password) return;
    const ok = await confirmAction('Ganti password WiFi perangkat ini? Semua perangkat pelanggan yang terhubung akan terputus sementara.');
    if (!ok) return;
    try { const r = await jsonFetch(`/acs/devices/${pickedDevice.id}/wifi-password`, { method: 'POST', body: JSON.stringify({ password }) }); showActResult(r.message, 'success'); toast(r.message); }
    catch (err) { showActResult(err.message, 'danger'); }
  });
  document.getElementById('ontActReboot')?.addEventListener('click', async () => {
    if (!pickedDevice) return;
    const confirmValue = window.prompt(`Ketik ulang serial number "${pickedDevice.serial_number || pickedDevice.device_id}" untuk konfirmasi reboot:`);
    if (!confirmValue) return;
    try { const r = await jsonFetch(`/acs/devices/${pickedDevice.id}/reboot`, { method: 'POST', body: JSON.stringify({ confirm: confirmValue }) }); showActResult(r.message, 'success'); toast(r.message); }
    catch (err) { showActResult(err.message, 'danger'); }
  });

  // ---------------- MikroTik action modal ----------------
  let mtModalInstance = null;
  let pickedRouter = null;
  function getMtModal() {
    if (!mtModalInstance && window.bootstrap) mtModalInstance = new window.bootstrap.Modal(document.getElementById('mikrotikActionModal'));
    return mtModalInstance;
  }
  function setPickedRouter(r) {
    pickedRouter = r;
    const wrap = document.getElementById('mtPickedWrap');
    const resultBox = document.getElementById('mtActResult');
    resultBox.hidden = true;
    if (!r) { wrap.hidden = true; return; }
    wrap.hidden = false;
    document.getElementById('mtPickedName').textContent = r.name;
    document.getElementById('mtPickedMeta').textContent = `${r.site_code ? r.site_code + ' \u00b7 ' : ''}${r.last_status === 'offline' ? 'Offline' : r.last_status === 'online' ? 'Online' : 'Belum pernah dites'}`;
    // Test Koneksi & Ping are read-only diagnostics open to any network user; only Reboot is admin-gated
    // server-side, so only that button needs to be disabled here.
    document.getElementById('mtActReboot').disabled = !isAdmin;
    if (!isAdmin) toast('Hanya Admin yang dapat me-reboot router.', 'danger');
  }
  function openMikrotikModal(routerPick) {
    setPickedRouter(routerPick || null);
    document.getElementById('mtSearchInput').value = '';
    document.getElementById('mtSearchResults').hidden = true;
    getMtModal()?.show();
  }
  document.getElementById('mtPickedClear')?.addEventListener('click', () => setPickedRouter(null));

  let mtSearchTimer = null;
  document.getElementById('mtSearchInput')?.addEventListener('input', (e) => {
    clearTimeout(mtSearchTimer);
    const q = e.target.value.trim();
    const box = document.getElementById('mtSearchResults');
    if (q.length < 2) { box.hidden = true; return; }
    mtSearchTimer = setTimeout(async () => {
      try {
        const r = await jsonFetch(`/monitoring/api/mikrotik/search?q=${encodeURIComponent(q)}`);
        box.innerHTML = r.routers.length
          ? r.routers.map((rt) => `<button type="button" data-pick='${esc(JSON.stringify(rt))}'>${esc(rt.name)}<small>${esc(rt.site_code || '-')} \u00b7 ${rt.last_status === 'offline' ? 'Offline' : rt.last_status === 'online' ? 'Online' : 'Belum dites'}</small></button>`).join('')
          : '<button type="button" disabled>Tidak ditemukan</button>';
        box.hidden = false;
        box.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
          setPickedRouter(JSON.parse(btn.dataset.pick));
          box.hidden = true;
        }));
      } catch (err) { toast(err.message, 'danger'); }
    }, 300);
  });

  function showMtResult(message, tone) {
    const box = document.getElementById('mtActResult');
    box.hidden = false;
    box.className = `mon-action-result ${tone}`;
    box.textContent = message;
  }

  document.getElementById('mtActTest')?.addEventListener('click', async () => {
    if (!pickedRouter) return;
    try { const r = await jsonFetch(`/monitoring/api/mikrotik/test/${pickedRouter.id}`, { method: 'POST' }); showMtResult(r.message, 'success'); toast(r.message); }
    catch (err) { showMtResult(err.message, 'danger'); }
  });
  document.getElementById('mtActPing')?.addEventListener('click', async () => {
    if (!pickedRouter) return;
    try {
      const r = await jsonFetch(`/monitoring/api/mikrotik/${pickedRouter.id}/ping`, { method: 'POST' });
      showMtResult(`${r.result.reachable ? 'Reachable' : 'Timeout'} \u00b7 loss ${r.result.lossPercent ?? '?'}%${r.result.avgMs !== null ? ' \u00b7 avg ' + r.result.avgMs + 'ms' : ''}`, r.result.reachable ? 'success' : 'danger');
    } catch (err) { showMtResult(err.message, 'danger'); }
  });
  document.getElementById('mtActReboot')?.addEventListener('click', async () => {
    if (!pickedRouter) return;
    const confirmValue = window.prompt(`Ketik ulang nama router "${pickedRouter.name}" untuk konfirmasi reboot. Semua sesi PPPoE pelanggan di router ini akan terputus sementara:`);
    if (!confirmValue) return;
    try { const r = await jsonFetch(`/monitoring/api/mikrotik/${pickedRouter.id}/reboot`, { method: 'POST', body: JSON.stringify({ confirm: confirmValue }) }); showMtResult(r.message, 'success'); toast(r.message); loadMikrotik(); }
    catch (err) { showMtResult(err.message, 'danger'); }
  });

  // ---------------- OLT action modal ----------------
  let oltModalInstance = null;
  let pickedOlt = null;
  function getOltModal() {
    if (!oltModalInstance && window.bootstrap) oltModalInstance = new window.bootstrap.Modal(document.getElementById('oltActionModal'));
    return oltModalInstance;
  }
  function setPickedOlt(o) {
    pickedOlt = o;
    const wrap = document.getElementById('oltPickedWrap');
    const resultBox = document.getElementById('oltActResult');
    resultBox.hidden = true;
    if (!o) { wrap.hidden = true; return; }
    wrap.hidden = false;
    document.getElementById('oltPickedName').textContent = o.name;
    document.getElementById('oltPickedMeta').textContent = `${o.management_ip || 'IP belum diatur'} \u00b7 ${o.last_status === 'offline' ? 'Offline' : o.last_status === 'online' ? 'Online' : 'Belum pernah dites'}`;
  }
  function openOltModal(oltPick) {
    setPickedOlt(oltPick || null);
    document.getElementById('oltSearchInput').value = '';
    document.getElementById('oltSearchResults').hidden = true;
    getOltModal()?.show();
  }
  document.getElementById('oltPickedClear')?.addEventListener('click', () => setPickedOlt(null));

  let oltSearchTimer = null;
  document.getElementById('oltSearchInput')?.addEventListener('input', (e) => {
    clearTimeout(oltSearchTimer);
    const q = e.target.value.trim();
    const box = document.getElementById('oltSearchResults');
    if (q.length < 2) { box.hidden = true; return; }
    oltSearchTimer = setTimeout(async () => {
      try {
        const r = await jsonFetch(`/monitoring/api/olt/search?q=${encodeURIComponent(q)}`);
        box.innerHTML = r.olts.length
          ? r.olts.map((o) => `<button type="button" data-pick='${esc(JSON.stringify(o))}'>${esc(o.name)}<small>${esc(o.management_ip || '-')} \u00b7 ${o.last_status === 'offline' ? 'Offline' : o.last_status === 'online' ? 'Online' : 'Belum dites'}</small></button>`).join('')
          : '<button type="button" disabled>Tidak ditemukan</button>';
        box.hidden = false;
        box.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
          setPickedOlt(JSON.parse(btn.dataset.pick));
          box.hidden = true;
        }));
      } catch (err) { toast(err.message, 'danger'); }
    }, 300);
  });

  document.getElementById('oltActPing')?.addEventListener('click', async () => {
    if (!pickedOlt) return;
    const box = document.getElementById('oltActResult');
    try {
      const r = await jsonFetch(`/monitoring/api/olt/${pickedOlt.id}/ping`, { method: 'POST' });
      box.hidden = false;
      box.className = `mon-action-result ${r.result.reachable ? 'success' : 'danger'}`;
      box.textContent = `${r.result.reachable ? 'Reachable' : 'Timeout'} \u00b7 loss ${r.result.lossPercent ?? '?'}%${r.result.avgMs !== null ? ' \u00b7 avg ' + r.result.avgMs + 'ms' : ''}`;
    } catch (err) {
      box.hidden = false;
      box.className = 'mon-action-result danger';
      box.textContent = err.message;
    }
  });
})();
