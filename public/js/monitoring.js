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

  function sparkBars(values, empty = 'Belum ada data historis.') {
    const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (!nums.length) return `<div class="spark empty">${esc(empty)}</div>`;
    const max = Math.max(...nums, 1);
    return `<div class="spark">${nums.map((v) => `<i style="height:${Math.max(4, Math.round((v / max) * 52))}px" title="${esc(Math.round(v * 100) / 100)}"></i>`).join('')}</div>`;
  }

  function ringHtml(pct, size = '') {
    if (pct === null || pct === undefined) return `<div class="m-ring ${size}" style="--p:0"><span>N/A</span></div>`;
    const cls = pct >= 90 ? '' : pct >= 70 ? 'warn' : 'bad';
    return `<div class="m-ring ${size} ${cls}" style="--p:${pct}"><span>${pct}%</span></div>`;
  }

  function barRow(label, value, total, tone = '') {
    const pct = total ? Math.round((value / total) * 100) : 0;
    return `<div class="bar-row"><span class="row-title" title="${esc(label)}">${esc(label)}</span><div class="bar-track ${tone}"><span style="width:${pct}%"></span></div><span class="bar-num">${value}</span></div>`;
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

  // ---------------- ONT board ----------------
  function renderOnt(d) {
    const s = d.summary;
    const normal = Math.max(0, s.total - s.warning - s.critical);
    const attentionHtml = d.attention.length
      ? d.attention.map((a) => `<a href="#" data-open-device="${a.id}"><span>${esc(a.customer_name || a.serial_number || 'ONT #' + a.id)}</span><span>${a.online_status === 'offline' ? 'Offline' : (a.rx_power !== null ? a.rx_power + ' dBm' : a.signal_status)}</span></a>`).join('')
      : '<div class="mini-empty">Semua ONT dalam kondisi normal.</div>';
    document.getElementById('bento-ont').innerHTML = `
      <div class="b-hero"><h4>Kesehatan ONT</h4><div><strong>${s.online}/${s.total}</strong><br><small>ONT online sekarang</small></div>${ringHtml(s.score, 'lg')}</div>
      <div class="b-wide"><h4>Distribusi Sinyal</h4>
        ${barRow('Normal', normal, s.total)}
        ${barRow('Waspada', s.warning, s.total, 'warn')}
        ${barRow('Kritis', s.critical, s.total, 'bad')}
      </div>
      <div><h4>ONT Offline</h4><strong>${s.offline}</strong><small>dari ${s.total} total ONT</small></div>
      <div><h4>Belum Ter-link</h4><strong>${s.unlinked}</strong><small>ONT tanpa data pelanggan</small></div>
      <div class="b-tall"><h4>Perlu Tindakan</h4><div class="mini-list">${attentionHtml}</div></div>
      <div class="b-wide b-tall"><h4>Tren Online (24 Jam)</h4>${sparkBars(d.trend.map((t) => t.pct))}<small>persentase ONT online, agregat per jam</small></div>
      <div><h4>Aksi Cepat</h4><div class="action-grid">
        <button type="button" id="ontActionOpen">Kelola ONT</button>
        <button type="button" id="ontSyncNow" ${d.acsConfigured ? '' : 'disabled title="GENIEACS_NBI_URL belum dikonfigurasi"'}>Sync ACS</button>
      </div></div>
      <div><h4>Sinkron Terakhir</h4><strong>${d.lastSync ? timeAgo(d.lastSync.finished_at) : 'belum pernah'}</strong><small>${d.lastSync ? esc(d.lastSync.status) : 'ACS belum sinkron'}</small></div>`;

    document.getElementById('ontActionOpen')?.addEventListener('click', () => openOntModal());
    document.getElementById('ontSyncNow')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await jsonFetch('/acs/sync', { method: 'POST' }); toast(r.message); loadOnt(); }
      catch (err) { toast(err.message, 'danger'); }
      finally { btn.disabled = false; }
    });
    document.querySelectorAll('#bento-ont [data-open-device]').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      const attn = d.attention.find((a) => String(a.id) === el.dataset.openDevice);
      openOntModal(attn ? { id: attn.id, serial_number: attn.serial_number, customer_name: attn.customer_name, online_status: attn.online_status, signal_status: attn.signal_status, rx_power: attn.rx_power } : null);
    }));
  }

  async function loadOnt() {
    try { renderOnt(await jsonFetch('/monitoring/api/ont')); }
    catch (err) { document.getElementById('bento-ont').innerHTML = `<div class="b-hero"><h4>Gagal memuat</h4><small>${esc(err.message)}</small></div>`; }
  }

  // ---------------- MikroTik board ----------------
  function renderMikrotik(d) {
    const s = d.summary;
    const topCpu = [...d.attention].filter((r) => r.cpu_load !== null).sort((a, b) => b.cpu_load - a.cpu_load).slice(0, 3);
    const cpuBars = topCpu.length
      ? topCpu.map((r) => barRow(r.name, r.cpu_load, 100, r.cpu_load >= 85 ? 'bad' : r.cpu_load >= 60 ? 'warn' : '')).join('')
      : '<small>Belum ada data CPU historis (menunggu siklus telemetry berikutnya).</small>';
    const attentionHtml = d.attention.length
      ? d.attention.map((r) => `<div><span>${esc(r.name)}</span><span>${r.last_status === 'offline' ? 'Offline' : (r.cpu_load !== null ? 'CPU ' + r.cpu_load + '%' : '-')}</span></div>`).join('')
      : '<div class="mini-empty">Semua router normal.</div>';
    const latestTraffic = d.trafficTrend.length ? d.trafficTrend[d.trafficTrend.length - 1] : null;
    const mbps = (bps) => bps ? Math.round((bps * 8) / 1000000 * 10) / 10 : 0;
    document.getElementById('bento-mikrotik').innerHTML = `
      <div class="b-hero"><h4>Kesehatan Router</h4><div><strong>${s.online}/${s.total}</strong><br><small>router online</small></div>${ringHtml(s.score, 'lg')}</div>
      <div class="b-wide"><h4>Beban CPU Tertinggi</h4>${cpuBars}</div>
      <div><h4>Sesi PPPoE Aktif</h4><strong>${s.activeSessions}</strong><small>koneksi berjalan</small></div>
      <div><h4>Pelanggan Isolir</h4><strong>${s.customersIsolated}</strong><small>dari ${s.customersTotal} pelanggan aktif</small></div>
      <div class="b-tall"><h4>Perlu Perhatian</h4><div class="mini-list">${attentionHtml}</div></div>
      <div class="b-wide b-tall"><h4>Traffic Gabungan (24 Jam)</h4>${sparkBars(d.trafficTrend.map((t) => t.rxBps + t.txBps))}<small>${latestTraffic ? `saat ini ↓${mbps(latestTraffic.rxBps)} Mbps / ↑${mbps(latestTraffic.txBps)} Mbps` : 'menunggu sample traffic'}, ${s.total} router</small></div>
      <div><h4>Aksi Cepat</h4><div class="action-grid">
        <button type="button" id="mtCaptureNow">Capture Now</button>
        <a class="btn-tech" href="/network/monitor" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center">NMS Monitor</a>
      </div></div>
      <div><h4>Beban CPU Rata-rata</h4><strong>${d.cpuTrend.length ? (d.cpuTrend[d.cpuTrend.length - 1].cpu ?? '-') + '%' : '-'}</strong><small>sample terakhir, seluruh router</small></div>`;

    document.getElementById('mtCaptureNow')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await jsonFetch('/network/api/telemetry/capture', { method: 'POST' }); toast(`Telemetry ${r.result.routers} router diperbarui.`); loadMikrotik(); }
      catch (err) { toast(err.message, 'danger'); }
      finally { btn.disabled = false; }
    });
  }

  async function loadMikrotik() {
    try { renderMikrotik(await jsonFetch('/monitoring/api/mikrotik')); }
    catch (err) { document.getElementById('bento-mikrotik').innerHTML = `<div class="b-hero"><h4>Gagal memuat</h4><small>${esc(err.message)}</small></div>`; }
  }

  // ---------------- OLT board ----------------
  function renderOlt(d) {
    const s = d.summary;
    const withUtil = d.olts.map((o) => ({ ...o, util: o.pon_ports_used ? Math.min(999, Math.round((o.onu_total / (o.pon_ports_used * o.pon_port_capacity)) * 100)) : 0 }));
    const topUtil = [...withUtil].sort((a, b) => b.util - a.util).slice(0, 3);
    const utilBars = topUtil.length
      ? topUtil.map((o) => barRow(o.name, Math.min(100, o.util), 100, o.util >= 90 ? 'bad' : o.util >= 70 ? 'warn' : '')).join('')
      : '<small>Belum ada OLT dengan data PON port.</small>';
    const attentionHtml = d.attention.length
      ? d.attention.map((o) => `<a href="/acs?q=${encodeURIComponent(o.name)}"><span>${esc(o.name)}</span><span>${o.onu_offline} offline · ${o.onu_critical} kritis</span></a>`).join('')
      : '<div class="mini-empty">Semua OLT dalam kondisi normal.</div>';
    document.getElementById('bento-olt').innerHTML = `
      <div class="b-hero"><h4>Utilisasi ONU</h4><div><strong>${s.online}/${s.totalOnu}</strong><br><small>ONU online, seluruh OLT</small></div>${ringHtml(s.score, 'lg')}</div>
      <div class="b-wide"><h4>Utilisasi PON per OLT</h4>${utilBars}</div>
      <div><h4>Total OLT</h4><strong>${s.total}</strong><small>chassis terdeteksi/terdaftar</small></div>
      <div><h4>Redaman Kritis</h4><strong>${s.critical}</strong><small>ONU RX di bawah ambang aman</small></div>
      <div class="b-tall"><h4>Perlu Perhatian</h4><div class="mini-list">${attentionHtml}</div></div>
      <div class="b-wide b-tall"><h4>Tren Redaman Kritis (24 Jam)</h4>${sparkBars(d.trend.map((t) => t.critical))}<small>jumlah ONU redaman kritis, agregat per jam</small></div>
      <div><h4>Aksi Cepat</h4><div class="action-grid">
        <a class="btn-tech" href="/olt" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center">Registry OLT</a>
        <a class="btn-tech" href="/acs?signal=critical" style="text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center">ONT Kritis</a>
      </div></div>
      <div><h4>Ø ONU / OLT</h4><strong>${s.total ? Math.round(s.totalOnu / s.total) : 0}</strong><small>rata-rata per chassis</small></div>`;
  }

  async function loadOlt() {
    try { renderOlt(await jsonFetch('/monitoring/api/olt')); }
    catch (err) { document.getElementById('bento-olt').innerHTML = `<div class="b-hero"><h4>Gagal memuat</h4><small>${esc(err.message)}</small></div>`; }
  }

  // ---------------- Segmented control ----------------
  const boards = { ont: loadOnt, mikrotik: loadMikrotik, olt: loadOlt };
  const loaded = new Set();
  document.querySelectorAll('#monSeg button').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('#monSeg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.keys(boards).forEach((key) => { document.getElementById('bento-' + key).style.display = key === btn.dataset.board ? '' : 'none'; });
    if (!loaded.has(btn.dataset.board)) { loaded.add(btn.dataset.board); boards[btn.dataset.board](); }
  }));
  loaded.add('ont'); loadOnt();

  // Auto-refresh the currently visible board every 30s so the dashboard stays live.
  setInterval(() => {
    const active = document.querySelector('#monSeg button.active')?.dataset.board || 'ont';
    boards[active]();
  }, 30000);

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
})();
