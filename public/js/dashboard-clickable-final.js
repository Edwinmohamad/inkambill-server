(() => {
  'use strict';

  const root = document.querySelector('.command-dashboard');
  if (!root) return;

  const openHref = (href, event) => {
    if (!href) return;
    if (event && (event.ctrlKey || event.metaKey || event.button === 1)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    window.location.href = href;
  };

  // Generic dashboard cards that intentionally navigate.
  document.querySelectorAll('[data-dashboard-href]').forEach(card => {
    const href = card.dataset.dashboardHref;
    if (!href) return;
    card.classList.add('dashboard-clickable-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.addEventListener('click', e => {
      if (e.target.closest('a,button,input,select,textarea,label,form')) return;
      openHref(href, e);
    });
    card.addEventListener('auxclick', e => {
      if (e.button === 1) openHref(href, e);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter') openHref(href, e);
    });
  });

  // Billing summary cards can either drill down to another page or become an
  // instant filter for the existing Billing Control table.
  const billingRoot = document.getElementById('billingControlCenter');
  if (billingRoot) {
    const summaryCards = [...billingRoot.querySelectorAll('[data-bcc-summary-status]')];

    const markSummary = status => {
      summaryCards.forEach(card => {
        card.classList.toggle('is-selected', (card.dataset.bccSummaryStatus || '') === status);
      });
    };

    summaryCards.forEach(card => {
      const status = card.dataset.bccSummaryStatus || '';
      card.classList.add('dashboard-clickable-card');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-pressed', 'false');

      const run = () => {
        const target = billingRoot.querySelector(`[data-bcc-status="${CSS.escape(status)}"]`);
        if (!target) return;

        const already = card.classList.contains('is-selected');
        if (already) {
          billingRoot.querySelector('[data-bcc-status="all"]')?.click();
          markSummary('');
          summaryCards.forEach(x => x.setAttribute('aria-pressed','false'));
        } else {
          target.click();
          markSummary(status);
          summaryCards.forEach(x => x.setAttribute('aria-pressed', String(x === card)));
        }

        document.querySelector('.bcc-workspace')?.scrollIntoView({behavior:'smooth', block:'start'});
      };

      card.addEventListener('click', run);
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          run();
        }
      });
    });

    // Clicking regular quick-filter chips keeps summary selection synchronized.
    billingRoot.querySelectorAll('[data-bcc-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.bccStatus || 'all';
        if (status === 'all') {
          markSummary('');
          summaryCards.forEach(x => x.setAttribute('aria-pressed','false'));
        } else {
          markSummary(status);
          summaryCards.forEach(x => x.setAttribute('aria-pressed', String((x.dataset.bccSummaryStatus||'') === status)));
        }
      });
    });

    // Main "Wajib isolir" warning is also a quick-filter shortcut.
    const alert = billingRoot.querySelector('[data-bcc-alert-filter]');
    if (alert) {
      alert.classList.add('dashboard-clickable-card');
      alert.tabIndex = 0;
      alert.setAttribute('role','button');
      const runAlert = () => {
        billingRoot.querySelector('[data-bcc-status="must_isolate"]')?.click();
        markSummary('must_isolate');
        document.querySelector('.bcc-workspace')?.scrollIntoView({behavior:'smooth', block:'start'});
      };
      alert.addEventListener('click', runAlert);
      alert.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runAlert(); }
      });
    }
  }
})();
