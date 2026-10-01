/* Web Inbox WhatsApp 2-arah — 3 kolom, realtime via WebSocket (/ws/wa-inbox) dengan fallback polling. */
(() => {
  const root = document.getElementById('waInbox');
  if (!root) return;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const ME = Number(root.dataset.userId);
  const state = { filter: 'all', q: '', convs: new Map(), order: [], activeId: null, detail: null, quick: [], noteMode: false, file: null, ws: null, wsOk: false, slashIndex: 0 };
  const EMOJIS = '😀 😁 😊 🙏 👍 👌 🙂 😅 😢 😮 ❤️ ✅ ❌ ⚠️ 📌 📷 📄 💳 🏦 🧾 🔧 📡 🌐 ⏳ 🕐 📞 ✉️ 🎉'.split(' ');
  const STATUS_TONE = { LUNAS: 'green', 'BELUM BAYAR': 'orange', MENUNGGAK: 'red', TERISOLIR: 'red' };
  const NET_LABEL = { online: 'Online', offline: 'Offline', isolated: 'Terisolir', router_unreachable: 'Router tak terjangkau' };

  async function api(url, { method = 'GET', body = null, form = null } = {}) {
    const opts = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (method !== 'GET') opts.headers['X-CSRF-Token'] = csrf;
    if (form) opts.body = form; else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null; try { data = await res.json(); } catch (_) { data = { ok: false, message: `HTTP ${res.status}` }; }
    if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }
  function toast(msg, tone = 'danger') {
    let box = $('#waiToast'); if (!box) { box = document.createElement('div'); box.id = 'waiToast'; box.className = 'wai-toast'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = `wai-toast-item ${tone}`; t.textContent = msg; box.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const initials = name => String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '#';
  const rupiah = v => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(v || 0));
  const fmtTime = v => { if (!v) return ''; const d = new Date(v); const same = d.toDateString() === new Date().toDateString(); return same ? d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }); };
  const fmtFull = v => v ? new Date(v).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
  const fmtDate = v => v ? new Date(v).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '-';
  const setView = v => { $('#waiGrid').dataset.view = v; };

  /* ---------------- Kolom 1: daftar percakapan ---------------- */
  async function loadConversations() {
    try {
      const data = await api(`/wa-inbox/api/conversations?filter=${encodeURIComponent(state.filter)}&q=${encodeURIComponent(state.q)}`);
      state.convs = new Map(data.conversations.map(c => [c.id, c]));
      state.order = data.conversations.map(c => c.id);
      Object.entries(data.counts || {}).forEach(([k, v]) => { const e = $(`[data-count="${k}"]`); if (e) e.textContent = v ? v : ''; });
      renderList(); setGateway(data.gateway); setPause(data.pause);
    } catch (e) { $('#waiConvList').replaceChildren(el('li', 'wai-empty', `Gagal memuat: ${e.message}`)); }
  }
  function matchesFilter(c) {
    if (state.q) return true; // hasil pencarian dikelola server
    if (state.filter === 'unread') return c.unread > 0;
    if (state.filter === 'payment') return c.category === 'payment';
    if (state.filter === 'outage') return c.category === 'outage';
    if (state.filter === 'isolated') return c.networkStatus === 'isolated';
    if (state.filter === 'mine') return c.assignedUserId === ME;
    return true;
  }
  function renderList() {
    const list = $('#waiConvList'); list.replaceChildren();
    const ids = state.order.filter(id => state.convs.has(id));
    if (!ids.length) { list.appendChild(el('li', 'wai-empty', state.q ? 'Tidak ada percakapan yang cocok.' : 'Belum ada percakapan.')); return; }
    let unreadTotal = 0;
    for (const id of ids) {
      const c = state.convs.get(id); unreadTotal += c.unread;
      const li = el('li', `wai-conv${c.id === state.activeId ? ' active' : ''}${c.unread ? ' unread' : ''}`); li.dataset.id = c.id; li.tabIndex = 0;
      const av = el('div', 'wai-avatar', initials(c.displayName));
      if (c.networkStatus === 'isolated') av.classList.add('isolated');
      const body = el('div', 'wai-conv-body');
      const top = el('div', 'wai-conv-top'); top.append(el('strong', null, c.displayName), el('time', null, fmtTime(c.lastMessageAt)));
      const bottom = el('div', 'wai-conv-bottom');
      bottom.appendChild(el('span', 'wai-conv-preview', `${c.lastDirection === 'out' ? '↪ ' : c.lastDirection === 'note' ? '📝 ' : ''}${c.lastPreview || ''}`));
      if (c.unread) bottom.appendChild(el('em', 'wai-badge', c.unread > 99 ? '99+' : c.unread));
      const tags = el('div', 'wai-conv-tags');
      if (c.customerCode) tags.appendChild(el('span', 'tag', c.customerCode));
      if (c.category === 'payment') tags.appendChild(el('span', 'tag green', 'Pembayaran'));
      if (c.category === 'outage') tags.appendChild(el('span', 'tag orange', 'Gangguan'));
      if (c.networkStatus === 'isolated') tags.appendChild(el('span', 'tag red', 'Isolir'));
      if (c.mode === 'manual') tags.appendChild(el('span', 'tag gray', 'Manual'));
      if (c.assignedName || c.departmentLabel) tags.appendChild(el('span', 'tag purple', c.assignedName || c.departmentLabel));
      body.append(top, bottom, tags); li.append(av, body);
      li.addEventListener('click', () => openConversation(c.id));
      li.addEventListener('keydown', e => { if (e.key === 'Enter') openConversation(c.id); });
      list.appendChild(li);
    }
    document.title = `${unreadTotal ? `(${unreadTotal}) ` : ''}WA Inbox`;
  }
  function upsertConv(c) {
    if (matchesFilter(c) || c.id === state.activeId) state.convs.set(c.id, c); else state.convs.delete(c.id);
    state.order = [...state.convs.values()].sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0) || b.id - a.id).map(x => x.id);
    renderList();
    if (c.id === state.activeId && state.detail) { state.detail.conversation = c; renderHeader(); }
  }

  /* ---------------- Kolom 2: chat ---------------- */
  async function openConversation(id, { keepView = false } = {}) {
    state.activeId = id; renderList();
    $('#waiChatEmpty').classList.add('d-none'); $('#waiChatInner').classList.remove('d-none');
    if (!keepView) { $('#waiMessages').replaceChildren(el('div', 'wai-loading', 'Memuat pesan…')); setView('chat'); }
    try {
      const d = await api(`/wa-inbox/api/conversations/${id}`);
      if (state.activeId !== id) return;
      state.detail = d; renderHeader(); renderMessages(d.messages); renderInfo();
      history.replaceState(null, '', `/wa-inbox?c=${id}`);
      wsSend({ type: 'view', conversationId: id });
      if (d.conversation.unread) api(`/wa-inbox/api/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
      if (!keepView) $('#waiInput').focus({ preventScroll: true });
    } catch (e) { toast(e.message); }
  }
  function renderHeader() {
    const c = state.detail.conversation;
    $('#waiHeadAvatar').textContent = initials(c.displayName);
    $('#waiHeadName').textContent = c.displayName;
    $('#waiHeadSub').textContent = [c.phone ? `+${c.phone}` : c.chatId, c.customerCode, c.assignedName || c.departmentLabel].filter(Boolean).join(' · ');
    const mode = $('#waiHeadMode');
    mode.textContent = c.mode === 'bot' ? 'Bot Active' : (c.humanUntil ? `Manual s/d ${new Date(c.humanUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'Manual');
    mode.className = `wai-mode ${c.mode}`;
    $('#waiBotToggle').checked = !!c.botEnabled;
  }
  const ACK_ICON = { pending: 'bi-clock', sent: 'bi-check2', delivered: 'bi-check2-all', read: 'bi-check2-all read', failed: 'bi-exclamation-circle-fill failed' };
  const ACK_LABEL = { pending: 'Menunggu antrean', sent: 'Terkirim', delivered: 'Diterima', read: 'Dibaca', failed: 'Gagal' };
  function bubble(m) {
    const row = el('div', `wai-msg ${m.direction}${m.isBot ? ' bot' : ''}`); row.dataset.id = m.id;
    const b = el('div', 'wai-bubble');
    if (m.direction === 'note') b.appendChild(el('div', 'wai-note-label', m.senderName ? `Catatan internal · ${m.senderName}` : 'Catatan'));
    else if (m.direction === 'out') b.appendChild(el('div', 'wai-sender', m.isBot ? 'Bot' : (m.senderName || 'Admin')));
    if (m.media) {
      if (/^image\//.test(m.media.mime || '')) {
        const a = el('a', 'wai-media'); a.href = m.media.url; a.target = '_blank'; a.rel = 'noopener';
        const img = el('img'); img.src = m.media.url; img.alt = m.media.name || 'Foto'; img.loading = 'lazy'; a.appendChild(img); b.appendChild(a);
      } else {
        const a = el('a', 'wai-file'); a.href = m.media.url; a.target = '_blank'; a.rel = 'noopener';
        a.append(el('i', 'bi bi-file-earmark-text'), el('span', null, m.media.name || 'Lampiran')); b.appendChild(a);
      }
    }
    if (m.body) b.appendChild(el('div', 'wai-text', m.body));
    const meta = el('div', 'wai-meta'); meta.appendChild(el('time', null, fmtFull(m.createdAt)));
    if (m.direction === 'out') { const i = el('i', `bi ${ACK_ICON[m.ack] || 'bi-clock'} wai-ack`); i.title = m.ack === 'failed' ? (m.error || 'Gagal') : (ACK_LABEL[m.ack] || m.ack); meta.appendChild(i); }
    b.appendChild(meta); row.appendChild(b);
    return row;
  }
  function renderMessages(messages) {
    const box = $('#waiMessages'); box.replaceChildren();
    if (!messages.length) box.appendChild(el('div', 'wai-loading', 'Belum ada pesan.'));
    let lastDay = '';
    for (const m of messages) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { box.appendChild(el('div', 'wai-day', fmtDate(m.createdAt))); lastDay = day; }
      box.appendChild(bubble(m));
    }
    box.scrollTop = box.scrollHeight;
  }
  function appendMessage(m) {
    if (!state.detail || m.conversationId !== state.activeId) return;
    if ($(`.wai-msg[data-id="${m.id}"]`)) return;
    state.detail.messages.push(m);
    const box = $('#waiMessages'); const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    $('.wai-loading', box)?.remove();
    box.appendChild(bubble(m));
    if (near || m.direction !== 'in') box.scrollTop = box.scrollHeight;
    if (m.direction === 'in' && !document.hidden) api(`/wa-inbox/api/conversations/${m.conversationId}/read`, { method: 'POST' }).catch(() => {});
  }
  function updateAck({ id, ack, error }) {
    const i = $(`.wai-msg[data-id="${id}"] .wai-ack`); if (!i) return;
    i.className = `bi ${ACK_ICON[ack] || 'bi-clock'} wai-ack`; i.title = ack === 'failed' ? (error || 'Gagal') : (ACK_LABEL[ack] || ack);
    const m = state.detail?.messages.find(x => x.id === id); if (m) { m.ack = ack; m.error = error || null; }
  }

  /* Composer: kirim, catatan, lampiran, emoji, slash command, indikator mengetik */
  const input = $('#waiInput');
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; }
  let typingTimer = null; let lastTypingSent = 0;
  input.addEventListener('input', () => {
    autosize(); renderSlash();
    if (Date.now() - lastTypingSent > 2500) { wsSend({ type: 'typing', typing: true }); lastTypingSent = Date.now(); }
    clearTimeout(typingTimer); typingTimer = setTimeout(() => { wsSend({ type: 'typing', typing: false }); lastTypingSent = 0; }, 3500);
  });
  input.addEventListener('keydown', e => {
    const slash = $('#waiSlash');
    if (!slash.classList.contains('d-none')) {
      const items = $$('.wai-slash-item', slash);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) { e.preventDefault(); state.slashIndex = (state.slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((x, i) => x.classList.toggle('active', i === state.slashIndex)); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && items.length) { e.preventDefault(); items[state.slashIndex]?.click(); return; }
      if (e.key === 'Escape') { slash.classList.add('d-none'); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#waiComposer').requestSubmit(); }
  });
  function renderSlash() {
    const slash = $('#waiSlash');
    const m = input.value.match(/^\/([a-z0-9_-]*)$/i);
    if (!m) { slash.classList.add('d-none'); return; }
    const list = state.quick.filter(q => q.shortcut.startsWith(m[1].toLowerCase()));
    slash.replaceChildren();
    if (!list.length) slash.appendChild(el('div', 'wai-slash-empty', 'Tidak ada balasan cepat.'));
    list.forEach((q, i) => {
      const it = el('button', `wai-slash-item${i === 0 ? ' active' : ''}`); it.type = 'button';
      it.append(el('strong', null, `/${q.shortcut}`), el('span', null, q.title));
      it.addEventListener('click', async () => {
        slash.classList.add('d-none');
        try { const r = await api(`/wa-inbox/api/quick-replies/${encodeURIComponent(q.shortcut)}/render?c=${state.activeId}`); input.value = r.text; autosize(); input.focus(); }
        catch (e) { toast(e.message); }
      });
      slash.appendChild(it);
    });
    state.slashIndex = 0; slash.classList.remove('d-none');
  }
  $('#waiEmojiBtn').addEventListener('click', () => {
    const box = $('#waiEmoji');
    if (!box.childElementCount) EMOJIS.forEach(em => { const b = el('button', null, em); b.type = 'button'; b.addEventListener('click', () => { const p = input.selectionStart ?? input.value.length; input.value = input.value.slice(0, p) + em + input.value.slice(p); input.focus(); box.classList.add('d-none'); }); box.appendChild(b); });
    box.classList.toggle('d-none');
  });
  $('#waiFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 6 * 1024 * 1024) { toast('Lampiran maksimal 6 MB.'); e.target.value = ''; return; }
    state.file = f; const p = $('#waiAttachPreview'); $('span', p).textContent = `${f.name} (${Math.round(f.size / 1024)} KB)`; p.classList.remove('d-none');
  });
  $('#waiAttachPreview button').addEventListener('click', () => { state.file = null; $('#waiFile').value = ''; $('#waiAttachPreview').classList.add('d-none'); });
  $('#waiNoteBtn').addEventListener('click', () => {
    state.noteMode = !state.noteMode;
    $('#waiComposer').classList.toggle('note-mode', state.noteMode); $('#waiNoteBtn').classList.toggle('active', state.noteMode);
    input.placeholder = state.noteMode ? 'Catatan internal — hanya terlihat oleh tim admin…' : 'Ketik pesan… (ketik / untuk balasan cepat)';
    input.focus();
  });
  $('#waiComposer').addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.activeId) return;
    const text = input.value.trim();
    if (!text && !state.file) return;
    const btn = $('#waiSend'); btn.disabled = true;
    try {
      if (state.noteMode) {
        const r = await api(`/wa-inbox/api/conversations/${state.activeId}/notes`, { method: 'POST', body: { text } });
        appendMessage(r.message);
      } else {
        const fd = new FormData(); fd.append('text', text); if (state.file) fd.append('file', state.file);
        const r = await api(`/wa-inbox/api/conversations/${state.activeId}/messages`, { method: 'POST', form: fd });
        appendMessage({ ...r.message, conversationId: state.activeId });
        if (r.gateway && r.gateway !== 'connected') toast('WA Gateway sedang terputus — pesan tersimpan di antrean dan terkirim otomatis setelah tersambung.', 'warning');
      }
      input.value = ''; autosize(); state.file = null; $('#waiFile').value = ''; $('#waiAttachPreview').classList.add('d-none');
      wsSend({ type: 'typing', typing: false });
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; input.focus(); }
  });
  $('#waiBotToggle').addEventListener('change', async e => {
    try { const r = await api(`/wa-inbox/api/conversations/${state.activeId}/bot`, { method: 'POST', body: { enabled: e.target.checked } }); upsertConv(r.conversation); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  });

  /* ---------------- Kolom 3: info pelanggan ---------------- */
  function card(title, rows, extra) {
    const c = el('section', 'wai-card'); c.appendChild(el('h4', null, title));
    const dl = el('dl');
    rows.filter(Boolean).forEach(([k, v, cls]) => { dl.append(el('dt', null, k)); const dd = el('dd', cls || null); if (v instanceof Node) dd.appendChild(v); else dd.textContent = v ?? '-'; dl.appendChild(dd); });
    c.appendChild(dl); if (extra) c.appendChild(extra); return c;
  }
  function renderInfo() {
    const d = state.detail; const c = d.conversation; const cu = d.customer;
    $('#waiInfoEmpty').classList.add('d-none'); $('#waiInfoInner').classList.remove('d-none');
    $('#waiInfoAvatar').textContent = initials(cu?.name || c.displayName);
    $('#waiInfoName').textContent = cu?.name || c.displayName;
    $('#waiInfoCode').textContent = cu ? `ID ${cu.customer_code} · +${c.phone || ''}` : (c.phone ? `+${c.phone}` : c.chatId);
    const badges = $('#waiInfoBadges'); badges.replaceChildren();
    const cards = $('#waiInfoCards'); cards.replaceChildren();
    $('#waiLinkBox').classList.toggle('d-none', !!cu);
    ['waiActVerify', 'waiActNetwork'].forEach(id => { $(`#${id}`).disabled = !cu; });
    if (!cu) return;
    badges.append(el('span', `status-badge ${STATUS_TONE[cu.billingStatus] || 'gray'}`, cu.billingStatus), el('span', `status-badge ${cu.network_status === 'online' ? 'green' : cu.network_status === 'isolated' ? 'red' : 'gray'}`, NET_LABEL[cu.network_status] || cu.network_status || '-'));
    cards.appendChild(card('Pelanggan', [['Alamat', cu.address || '-'], ['Kontak', cu.phone || '-'], ['Status akun', cu.customer_status]]));
    cards.appendChild(card('Paket & Jaringan', [['Paket', cu.packageLabel], ['IP Address', cu.ipAddress || '-', 'mono'], ['PPPoE', cu.pppoe_username || '-', 'mono'], ['Router POP', cu.router_name || '-'], ['Cluster / Site', [cu.cluster_name, cu.site_code].filter(Boolean).join(' · ') || '-'], ['OLT / VLAN', [cu.olt_name, cu.vlan ? `VLAN ${cu.vlan}` : null].filter(Boolean).join(' · ') || '-'], ['Sesi terakhir', cu.sessionSeenAt ? `${cu.sessionStatus || ''} · ${fmtFull(cu.sessionSeenAt)}` : '-']]));
    const inv = cu.openInvoices[0] || cu.invoices[0];
    const invList = el('ul', 'wai-mini-list');
    cu.openInvoices.forEach(i => { const li = el('li'); li.append(el('span', null, i.invoice_number), el('b', null, rupiah(i.outstanding))); li.title = `Jatuh tempo ${fmtDate(i.due_date)}`; invList.appendChild(li); });
    cards.appendChild(card('Tagihan Berjalan', [['Status', el('span', `status-badge ${STATUS_TONE[cu.billingStatus] || 'gray'}`, cu.billingStatus)], ['Total', rupiah(cu.outstanding), 'strong'], ['Jatuh tempo', inv ? fmtDate(inv.due_date) : '-'], ['Tiket aktif', String(cu.openTickets)]], cu.openInvoices.length ? invList : null));
    const payList = el('ul', 'wai-mini-list');
    if (!cu.payments.length) payList.appendChild(el('li', 'wai-muted', 'Belum ada pembayaran.'));
    cu.payments.forEach(p => { const li = el('li'); li.append(el('span', null, `${fmtDate(p.paid_at)} · ${p.method}`), el('b', `pay-${p.status}`, rupiah(p.amount))); li.title = `${p.invoice_number} · ${p.status}`; payList.appendChild(li); });
    const pc = el('section', 'wai-card'); pc.append(el('h4', null, '3 Pembayaran Terakhir'), payList); cards.appendChild(pc);
    const link = el('a', 'ink-text-link', 'Buka profil pelanggan ↗'); link.href = `/customers/${cu.id}`; link.target = '_blank'; cards.appendChild(link);
  }
  let linkTimer = null;
  $('#waiLinkSearch').addEventListener('input', e => {
    clearTimeout(linkTimer); const q = e.target.value.trim(); const ul = $('#waiLinkResults');
    if (q.length < 2) { ul.replaceChildren(); return; }
    linkTimer = setTimeout(async () => {
      try {
        const r = await api(`/wa-inbox/api/customers/search?q=${encodeURIComponent(q)}`); ul.replaceChildren();
        r.customers.forEach(c => { const li = el('li'); const b = el('button', null, `${c.name} · ${c.customer_code}`); b.type = 'button'; b.addEventListener('click', async () => { try { await api(`/wa-inbox/api/conversations/${state.activeId}/link-customer`, { method: 'POST', body: { customer_id: c.id } }); openConversation(state.activeId, { keepView: true }); } catch (err) { toast(err.message); } }); li.appendChild(b); ul.appendChild(li); });
        if (!r.customers.length) ul.appendChild(el('li', 'wai-muted', 'Tidak ditemukan.'));
      } catch (err) { toast(err.message); }
    }, 300);
  });

  /* Power actions */
  const modal = id => bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
  $('#waiActVerify').addEventListener('click', () => {
    const cu = state.detail?.customer; if (!cu) return;
    const invBox = $('#waiVerifyInvoices'); invBox.replaceChildren();
    if (!cu.openInvoices.length) invBox.appendChild(el('div', 'wai-muted', 'Tidak ada tagihan terbuka.'));
    cu.openInvoices.forEach(i => { const l = el('label', 'wai-check'); const cb = el('input'); cb.type = 'checkbox'; cb.value = i.id; cb.checked = true; l.append(cb, el('span', null, `${i.invoice_number} · jatuh tempo ${fmtDate(i.due_date)}`), el('b', null, rupiah(i.outstanding))); invBox.appendChild(l); });
    const proofs = state.detail.messages.filter(m => m.direction === 'in' && m.media && /^(image\/|application\/pdf)/.test(m.media.mime || '')).slice(-8).reverse();
    const pBox = $('#waiVerifyProofs'); pBox.replaceChildren();
    if (!proofs.length) pBox.appendChild(el('div', 'wai-muted', 'Belum ada foto/dokumen dari pelanggan. Bila pengajuan pembayaran sudah ada di menu Pembayaran, bukti tidak diperlukan.'));
    proofs.forEach((m, idx) => {
      const l = el('label', 'wai-proof'); const r = el('input'); r.type = 'radio'; r.name = 'waiProof'; r.value = m.id; r.checked = idx === 0;
      l.appendChild(r);
      if (/^image\//.test(m.media.mime)) { const img = el('img'); img.src = m.media.url; img.alt = 'bukti'; l.appendChild(img); } else l.appendChild(el('span', 'wai-proof-pdf', '📄 PDF'));
      l.appendChild(el('small', null, fmtFull(m.createdAt))); pBox.appendChild(l);
    });
    $('#waiVerifyResult').classList.add('d-none'); $('#waiVerifySubmit').disabled = false;
    modal('waiVerifyModal').show();
  });
  $('#waiVerifySubmit').addEventListener('click', async () => {
    const ids = $$('#waiVerifyInvoices input:checked').map(i => Number(i.value));
    if (!ids.length) return toast('Pilih minimal satu tagihan.');
    const btn = $('#waiVerifySubmit'); btn.disabled = true;
    const out = $('#waiVerifyResult'); out.className = 'wai-verify-result mt-3'; out.textContent = 'Memproses…';
    try {
      const r = await api(`/wa-inbox/api/conversations/${state.activeId}/verify-payment`, { method: 'POST', body: { invoice_ids: ids, bank_id: $('#waiVerifyBank').value, proof_message_id: $('input[name="waiProof"]:checked')?.value || null } });
      out.replaceChildren(); out.classList.add('ok');
      (r.steps || []).forEach(s => out.appendChild(el('div', null, `✓ ${s}`)));
      (r.errors || []).forEach(s => out.appendChild(el('div', 'text-danger', `✗ ${s}`)));
      openConversation(state.activeId, { keepView: true });
    } catch (e) { out.className = 'wai-verify-result mt-3 err'; out.textContent = e.message; btn.disabled = false; }
  });
  $('#waiActTicket').addEventListener('click', () => {
    const last = [...(state.detail?.messages || [])].reverse().find(m => m.direction === 'in' && m.body);
    $('#waiTicketSubject').value = last ? `Keluhan: ${last.body.slice(0, 80)}` : 'Laporan gangguan pelanggan';
    $('#waiTicketDesc').value = ''; modal('waiTicketModal').show();
  });
  $('#waiTicketSubmit').addEventListener('click', async () => {
    try {
      const r = await api(`/wa-inbox/api/conversations/${state.activeId}/ticket`, { method: 'POST', body: { subject: $('#waiTicketSubject').value, type: $('#waiTicketType').value, priority: $('#waiTicketPriority').value, description: $('#waiTicketDesc').value } });
      modal('waiTicketModal').hide(); toast(`Tiket ${r.ticket.code} dibuat.`, 'success');
    } catch (e) { toast(e.message); }
  });
  $('#waiActAssign').addEventListener('click', () => {
    const c = state.detail?.conversation; if (!c) return;
    $('#waiAssignDept').value = c.assignedDepartment || ''; $('#waiAssignUser').value = c.assignedUserId || ''; modal('waiAssignModal').show();
  });
  $('#waiAssignSubmit').addEventListener('click', async () => {
    try { const r = await api(`/wa-inbox/api/conversations/${state.activeId}/assign`, { method: 'POST', body: { user_id: $('#waiAssignUser').value || null, department: $('#waiAssignDept').value || null } }); upsertConv(r.conversation); modal('waiAssignModal').hide(); }
    catch (e) { toast(e.message); }
  });
  $('#waiActNetwork').addEventListener('click', async () => {
    const btn = $('#waiActNetwork'); btn.disabled = true;
    try { const r = await api(`/wa-inbox/api/conversations/${state.activeId}/check-network`, { method: 'POST' }); toast(`Status: ${NET_LABEL[r.status] || r.status}${r.ip ? ` · IP ${r.ip}` : ''}${r.uptime ? ` · uptime ${r.uptime}` : ''}${r.profile ? ` · profil ${r.profile}` : ''}`, 'success'); openConversation(state.activeId, { keepView: true }); }
    catch (e) { toast(`Cek jaringan gagal: ${e.message}`); }
    finally { btn.disabled = false; }
  });

  /* Navigasi & filter */
  $$('[data-back]').forEach(b => b.addEventListener('click', () => setView(b.dataset.back)));
  $('#waiTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-filter]'); if (!b) return;
    $$('#waiTabs button').forEach(x => x.classList.toggle('active', x === b)); state.filter = b.dataset.filter; loadConversations();
  });
  let searchTimer = null;
  $('#waiSearch').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadConversations(); }, 250); });

  function setGateway(s) {
    if (!s) return; const g = $('#waiGateway');
    g.className = `wai-gw ${{ connected: 'green', qr_pending: 'orange', connecting: 'orange' }[s] || 'red'}`;
    $('#waiGatewayLabel').textContent = `WA ${{ connected: 'Terhubung', qr_pending: 'Menunggu Scan QR', connecting: 'Menghubungkan…', disconnected: 'Terputus' }[s] || s}`;
  }
  function setPause(p) {
    if (!p) return; const b = $('#waiPauseBanner');
    b.classList.toggle('d-none', !p.paused); $('#waiPauseText').textContent = p.paused ? `Antrean dijeda: ${p.label || p.kind}` : '';
  }

  /* Collision detection */
  function renderPresence({ conversationId, viewers }) {
    if (conversationId !== state.activeId) return;
    const others = (viewers || []).filter(v => v.userId !== ME);
    const bar = $('#waiCollision');
    if (!others.length) { bar.classList.add('d-none'); return; }
    const typing = others.filter(v => v.typing);
    $('span', bar).textContent = typing.length ? `${typing.map(v => v.name).join(', ')} sedang mengetik balasan di percakapan ini — hindari jawaban ganda.` : `${others.map(v => v.name).join(', ')} juga sedang membuka percakapan ini.`;
    bar.classList.toggle('typing', !!typing.length); bar.classList.remove('d-none');
  }

  /* WebSocket realtime + fallback polling */
  let wsRetry = 0; let pollTimer = null;
  function wsSend(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }
  function setRt(ok) { state.wsOk = ok; $('#waiRealtime').classList.toggle('on', ok); $('#waiRealtime').title = ok ? 'Realtime terhubung' : 'Realtime terputus — memakai polling'; }
  function connectWs() {
    try {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/wa-inbox`);
      state.ws = ws;
      ws.onopen = () => { wsRetry = 0; setRt(true); if (state.activeId) wsSend({ type: 'view', conversationId: state.activeId }); };
      ws.onclose = () => { setRt(false); setTimeout(connectWs, Math.min(30000, 1000 * 2 ** wsRetry++)); };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        const d = m.data;
        if (m.type === 'conversation.updated') upsertConv(d);
        else if (m.type === 'message.new') appendMessage(d);
        else if (m.type === 'message.ack') updateAck(d);
        else if (m.type === 'presence') renderPresence(d);
        else if (m.type === 'queue.paused') { setPause({ paused: true, ...d }); toast(`Antrean WhatsApp dijeda: ${d.label || d.kind}`, 'warning'); }
        else if (m.type === 'queue.resumed') setPause({ paused: false });
      };
    } catch (_) { setRt(false); }
  }
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (state.wsOk || document.hidden) return;
      await loadConversations();
      if (state.activeId) { try { const r = await api(`/wa-inbox/api/conversations/${state.activeId}/messages`); r.messages.forEach(m => { if ($(`.wai-msg[data-id="${m.id}"]`)) updateAck(m); else appendMessage(m); }); } catch (_) {} }
    }, 12000);
  }

  (async () => {
    try { state.quick = (await api('/wa-inbox/api/quick-replies')).quickReplies; } catch (_) {}
    await loadConversations();
    const initial = Number(root.dataset.initial);
    if (initial) openConversation(initial);
    connectWs(); startPolling();
  })();
})();
