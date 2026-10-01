(() => {
  'use strict';

  // PPP Secrets KPI cards -> existing filter/tab controls. No duplicate API logic.
  const app = document.getElementById('nmsSecrets');
  if (app) {
    const cards = [...app.querySelectorAll('.nx-stats .nx-stat')];
    const normalize = s => String(s || '').trim().toLowerCase();
    const map = {
      'online': { view:'online' },
      'offline': { view:'offline' },
      'diisolir': { view:'isolated' },
      'ter-link': { tab:'synced' },
      'fasum': { view:'fasum' },
      'exempt': { tab:'unsynced', exempt:true }
    };
    const activate = card => {
      const label = normalize(card.querySelector('small')?.textContent);
      const cfg = map[label]; if (!cfg) return;
      if (cfg.view) {
        const btn = document.querySelector(`#fViews [data-view="${cfg.view}"]`);
        if (btn) btn.click();
      } else if (cfg.tab) {
        const tab = document.querySelector(`.nx-toolbar [data-tab="${cfg.tab}"]`);
        if (tab) tab.click();
        if (cfg.exempt) setTimeout(() => {
          const ck = document.getElementById('fExempt');
          if (ck && !ck.checked) { ck.checked = true; ck.dispatchEvent(new Event('change',{bubbles:true})); }
        }, 80);
      }
      cards.forEach(c => c.classList.remove('cc-selected'));
      card.classList.add('cc-selected');
    };
    cards.forEach(card => {
      const label = normalize(card.querySelector('small')?.textContent);
      if (!map[label]) return;
      card.classList.add('cc-clickable');
      card.tabIndex = 0; card.setAttribute('role','button');
      card.setAttribute('aria-label',`Filter ${card.querySelector('small')?.textContent.trim() || ''}`);
      card.addEventListener('click', () => activate(card));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(card); }
      });
    });
    const params = new URL(location.href).searchParams;
    const status = params.get('status') || '';
    const tab = params.get('tab') || app.dataset.tab || '';
    cards.forEach(card => {
      const label=normalize(card.querySelector('small')?.textContent), cfg=map[label];
      const selected = cfg && ((cfg.view && ((cfg.view==='isolated'?'isolated':cfg.view)===status)) || (cfg.tab && cfg.tab===tab && !status));
      card.classList.toggle('cc-selected', !!selected);
    });
  }
})();
