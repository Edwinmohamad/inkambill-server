
(() => {
  'use strict';

  const txt = v => String(v ?? '').trim();
  const norm = v => txt(v).toLowerCase();
  const money = v => {
    const n = Number(String(v ?? '').replace(/[^\d-]/g,''));
    return Number.isFinite(n) ? n : 0;
  };

  function findDebtTable(){
    const tables = [...document.querySelectorAll('table')];
    const score = table => {
      const s = norm(table.innerText);
      let n = 0;
      if (s.includes('hutang') || s.includes('utang')) n += 10;
      if (s.includes('nominal') || s.includes('jumlah')) n += 4;
      if (s.includes('jatuh tempo')) n += 4;
      if (s.includes('status')) n += 2;
      if (s.includes('sisa')) n += 2;
      if (s.includes('aksi')) n += 2;
      return n;
    };
    return tables.map(t => [t, score(t)]).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
  }

  function headers(table){
    return [...table.querySelectorAll('thead th')].map((th,i)=>({
      i, th, text:norm(th.innerText)
    }));
  }

  function findCol(hs, words){
    const x = hs.find(h => words.some(w => h.text.includes(w)));
    return x ? x.i : -1;
  }

  function classifyStatus(text){
    const s = norm(text);
    if (/(terlambat|overdue|jatuh tempo lewat)/.test(s)) return 'overdue';
    if (/(sebagian|partial)/.test(s)) return 'partial';
    if (/(lunas|paid|selesai)/.test(s)) return 'paid';
    return 'open';
  }

  function mount(){
    const table = findDebtTable();
    if (!table || table.dataset.hutangCompactMounted === '1') return;
    table.dataset.hutangCompactMounted = '1';

    const root = table.closest('.card,.panel,.content-card,main,.content,.container,.container-fluid') || table.parentElement;
    root.classList.add('hutang-compact-mounted');

    const hs0 = headers(table);
    const siteCol = findCol(hs0,['site','lokasi','area']);
    const statusCol = findCol(hs0,['status']);
    const dueCol = findCol(hs0,['jatuh tempo','due date','tempo']);
    const nominalCol = findCol(hs0,['nominal','jumlah','total']);
    const paidCol = findCol(hs0,['terbayar','dibayar','paid']);
    const remainCol = findCol(hs0,['sisa','outstanding','saldo']);
    const actionCol = findCol(hs0,['aksi','action']);

    // Add No column if missing.
    const hasNo = hs0.some(h => /^(no|#|nomor)$/.test(h.text));
    if (!hasNo) {
      const th = document.createElement('th');
      th.textContent = 'No';
      th.className = 'ht-no';
      const hr = table.querySelector('thead tr');
      if (hr) hr.insertBefore(th, hr.firstChild);
      table.querySelectorAll('tbody tr').forEach(tr => {
        const td = document.createElement('td');
        td.className = 'ht-no';
        tr.insertBefore(td, tr.firstChild);
      });
    }

    const hs = headers(table);
    const offset = hasNo ? 0 : 1;
    const idx = x => x < 0 ? -1 : x + offset;

    const toolbar = document.createElement('div');
    toolbar.className = 'ht-toolbar';
    toolbar.innerHTML = `
      <div class="ht-search-wrap">
        <span class="ht-search-icon">⌕</span>
        <input class="ht-search" type="search" placeholder="Cari nama, keterangan, nominal, site…" aria-label="Cari hutang">
      </div>
      <select class="ht-filter ht-status-filter" aria-label="Filter status">
        <option value="">Semua status</option>
        <option value="open">Belum lunas</option>
        <option value="partial">Sebagian</option>
        <option value="overdue">Terlambat</option>
        <option value="paid">Lunas</option>
      </select>
      <select class="ht-filter ht-site-filter" aria-label="Filter site"><option value="">Semua site</option></select>
      <select class="ht-filter ht-due-filter" aria-label="Filter jatuh tempo">
        <option value="">Semua JT</option>
        <option value="overdue">Terlambat</option>
        <option value="today">Hari ini</option>
        <option value="7d">7 hari</option>
        <option value="month">Bulan ini</option>
      </select>
      <button class="ht-btn ht-reset" type="button">Reset</button>
    `;

    const chips = document.createElement('div');
    chips.className = 'ht-chips';
    chips.innerHTML = `
      <button class="ht-chip active" type="button" data-status="">Semua</button>
      <button class="ht-chip" type="button" data-status="open">Belum Lunas</button>
      <button class="ht-chip" type="button" data-status="overdue">Terlambat</button>
      <button class="ht-chip" type="button" data-status="partial">Sebagian</button>
      <button class="ht-chip" type="button" data-status="paid">Lunas</button>
    `;

    const summary = document.createElement('div');
    summary.className = 'ht-summary';

    const wrap = document.createElement('div');
    wrap.className = 'ht-table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);

    wrap.parentNode.insertBefore(toolbar, wrap);
    wrap.parentNode.insertBefore(chips, wrap);
    wrap.parentNode.insertBefore(summary, chips);

    const rows = [...table.querySelectorAll('tbody tr')];

    // Derive metadata and compact action area.
    const sites = new Set();
    rows.forEach(tr => {
      const cells = [...tr.children];
      const cellText = i => i >= 0 && cells[i] ? txt(cells[i].innerText) : '';
      const statusText = cellText(idx(statusCol));
      const status = classifyStatus(statusText);
      tr.dataset.htStatus = status;

      if (idx(siteCol) >= 0) {
        const s = cellText(idx(siteCol));
        if (s) sites.add(s);
        tr.dataset.htSite = norm(s);
      }

      if (idx(dueCol) >= 0) {
        tr.dataset.htDue = cellText(idx(dueCol));
      }

      // Normalize existing status badge subtly.
      if (idx(statusCol) >= 0 && cells[idx(statusCol)]) {
        const c = cells[idx(statusCol)];
        const badge = c.querySelector('.badge,.status,.label,span') || c;
        badge.classList.add('ht-status', status);
      }

      // Compact existing actions without inventing backend endpoints.
      if (idx(actionCol) >= 0 && cells[idx(actionCol)]) {
        const c = cells[idx(actionCol)];
        c.classList.add('ht-actions');
        [...c.querySelectorAll('a,button')].forEach(el => {
          const t = norm(el.innerText || el.getAttribute('aria-label') || el.title);
          if (t.includes('hapus') || t.includes('delete')) el.classList.add('danger');
        });
      }

      tr.style.cursor = 'pointer';
    });

    const siteSelect = toolbar.querySelector('.ht-site-filter');
    [...sites].sort().forEach(s => {
      const o = document.createElement('option'); o.value = norm(s); o.textContent = s;
      siteSelect.appendChild(o);
    });
    if (!sites.size) siteSelect.disabled = true;

    const q = toolbar.querySelector('.ht-search');
    const statusSel = toolbar.querySelector('.ht-status-filter');
    const dueSel = toolbar.querySelector('.ht-due-filter');

    function parseDateLoose(v){
      if (!v) return null;
      const iso = v.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
      if (iso) return new Date(+iso[1], +iso[2]-1, +iso[3]);
      const id = v.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
      if (id) return new Date(+id[3], +id[2]-1, +id[1]);
      return null;
    }

    function duePass(tr, mode){
      if (!mode) return true;
      const d = parseDateLoose(tr.dataset.htDue);
      if (!d) return false;
      const now = new Date(); now.setHours(0,0,0,0);
      const diff = Math.floor((d - now)/86400000);
      if (mode === 'overdue') return diff < 0 && tr.dataset.htStatus !== 'paid';
      if (mode === 'today') return diff === 0;
      if (mode === '7d') return diff >= 0 && diff <= 7;
      if (mode === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      return true;
    }

    function refresh(){
      const query = norm(q.value);
      const st = statusSel.value;
      const site = siteSelect.value;
      const due = dueSel.value;
      let visible = 0, open = 0, overdue = 0, partial = 0, paid = 0;
      let total = 0, remain = 0;

      rows.forEach(tr => {
        const hay = norm(tr.innerText);
        const pass = (!query || hay.includes(query))
          && (!st || tr.dataset.htStatus === st)
          && (!site || tr.dataset.htSite === site)
          && duePass(tr, due);

        tr.classList.toggle('ht-hidden', !pass);
        if (!pass) return;

        visible++;
        if (tr.dataset.htStatus === 'open') open++;
        if (tr.dataset.htStatus === 'overdue') overdue++;
        if (tr.dataset.htStatus === 'partial') partial++;
        if (tr.dataset.htStatus === 'paid') paid++;

        const cells = [...tr.children];
        if (idx(nominalCol) >= 0 && cells[idx(nominalCol)]) total += money(cells[idx(nominalCol)].innerText);
        if (idx(remainCol) >= 0 && cells[idx(remainCol)]) remain += money(cells[idx(remainCol)].innerText);
      });

      let no = 0;
      rows.forEach(tr => {
        if (!tr.classList.contains('ht-hidden')) {
          no++;
          const cell = tr.querySelector('.ht-no');
          if (cell) cell.textContent = no;
        }
      });

      const rp = n => new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(n);
      summary.innerHTML = `
        <span><strong>${visible}</strong> data</span>
        <span>Belum lunas <strong>${open}</strong></span>
        <span>Sebagian <strong>${partial}</strong></span>
        <span>Terlambat <strong>${overdue}</strong></span>
        <span>Lunas <strong>${paid}</strong></span>
        ${nominalCol >= 0 ? `<span>Total <strong>${rp(total)}</strong></span>` : ''}
        ${remainCol >= 0 ? `<span>Sisa <strong>${rp(remain)}</strong></span>` : ''}
      `;
    }

    [q,statusSel,siteSelect,dueSel].forEach(el => {
      el.addEventListener(el === q ? 'input' : 'change', refresh);
    });

    toolbar.querySelector('.ht-reset').addEventListener('click', () => {
      q.value=''; statusSel.value=''; siteSelect.value=''; dueSel.value='';
      chips.querySelectorAll('.ht-chip').forEach((x,i)=>x.classList.toggle('active',i===0));
      refresh();
    });

    chips.addEventListener('click', e => {
      const b = e.target.closest('.ht-chip');
      if (!b) return;
      statusSel.value = b.dataset.status || '';
      chips.querySelectorAll('.ht-chip').forEach(x=>x.classList.toggle('active',x===b));
      refresh();
    });

    // Sort by clicked header, excluding action/no.
    hs.forEach((h, i) => {
      const t = norm(h.th.innerText);
      if (/^(no|#|nomor)$/.test(t) || /aksi|action/.test(t)) return;
      h.th.classList.add('ht-sortable');
      let asc = true;
      h.th.addEventListener('click', () => {
        const body = table.querySelector('tbody');
        rows.sort((a,b) => {
          const av = txt(a.children[i]?.innerText);
          const bv = txt(b.children[i]?.innerText);
          const an = money(av), bn = money(bv);
          const cmp = (/\d/.test(av)&&/\d/.test(bv) && (an||bn))
            ? an-bn : av.localeCompare(bv,'id',{numeric:true,sensitivity:'base'});
          return asc ? cmp : -cmp;
        });
        asc = !asc;
        rows.forEach(r => body.appendChild(r));
        refresh();
      });
    });

    // Drawer detail: clicking a row, but not action/form/input links.
    const backdrop = document.createElement('div');
    backdrop.className = 'ht-drawer-backdrop';
    const drawer = document.createElement('aside');
    drawer.className = 'ht-drawer';
    drawer.innerHTML = `
      <div class="ht-drawer-head"><div class="ht-drawer-title">Detail Hutang</div><button class="ht-drawer-close" type="button" aria-label="Tutup">×</button></div>
      <div class="ht-drawer-body"></div>
    `;
    document.body.append(backdrop, drawer);

    function closeDrawer(){ drawer.classList.remove('open'); backdrop.classList.remove('open'); }
    function openDrawer(tr){
      const cells = [...tr.children];
      const headNow = headers(table);
      const detail = [];
      headNow.forEach((h,i) => {
        if (/aksi|action/.test(h.text)) return;
        const v = txt(cells[i]?.innerText);
        if (v) detail.push([txt(h.th.innerText), v]);
      });

      const actionCell = [...tr.children].find((_,i)=> /aksi|action/.test(headNow[i]?.text||''));
      const actionClones = actionCell ? [...actionCell.querySelectorAll('a,button')].map(el => {
        const clone = el.cloneNode(true);
        if (el.tagName === 'A') clone.href = el.href;
        return clone.outerHTML;
      }).join('') : '';

      drawer.querySelector('.ht-drawer-body').innerHTML = `
        <div class="ht-detail-grid">
          ${detail.map(([k,v])=>`<div class="ht-detail-key">${escapeHtml(k)}</div><div class="ht-detail-value">${escapeHtml(v)}</div>`).join('')}
        </div>
        ${actionClones ? `<div class="ht-drawer-actions">${actionClones}</div>` : ''}
      `;
      drawer.classList.add('open'); backdrop.classList.add('open');
    }

    function escapeHtml(v){
      return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    }

    rows.forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('a,button,input,select,textarea,label,form')) return;
      openDrawer(tr);
    }));
    backdrop.addEventListener('click', closeDrawer);
    drawer.querySelector('.ht-drawer-close').addEventListener('click', closeDrawer);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeDrawer();
      if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
        e.preventDefault(); q.focus();
      }
    });

    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
