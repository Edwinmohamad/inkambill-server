'use strict';

function keyOf(role) {
  return String(role || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function buildWorkspace({ user = {}, permissions = [] } = {}) {
  const allowed = new Set(permissions || []);
  const role = keyOf(user.role);
  const isOwner = /owner|founder|master_admin/.test(role);
  const isNoc = /noc|network|core|technical/.test(role) ||
    (allowed.has('network') && !allowed.has('billing') && !allowed.has('finance'));
  const isTechnician = /teknisi|technician|field/.test(role) ||
    (allowed.has('support') && !allowed.has('billing') && !allowed.has('finance') && !isNoc);
  const isBilling = /billing|penagihan|finance|keuangan|admin_keuangan/.test(role) ||
    ((allowed.has('billing') || allowed.has('finance')) && !isOwner);

  let id = 'staff', label = 'Workspace Staf', icon = 'bi-person-workspace';
  let subtitle = 'Akses cepat berdasarkan tanggung jawab akun Anda.';
  let actions = [];

  if (isOwner) {
    id = 'owner'; label = 'Owner Workspace'; icon = 'bi-graph-up-arrow';
    subtitle = 'Revenue, collection, site performance, risiko, dan kontrol operasional.';
    actions = [
      ['Analitik Bisnis', '/analytics', 'bi-pie-chart-fill', 'Kinerja usaha'],
      ['Rekonsiliasi', '/payments/reconciliation', 'bi-arrow-repeat', 'Cash & selisih'],
      ['Laporan', '/reports', 'bi-bar-chart-line-fill', 'Ringkasan bisnis'],
      ['NOC', '/nms', 'bi-speedometer2', 'Kesehatan jaringan'],
    ];
  } else if (isNoc) {
    id = 'noc'; label = 'NOC Workspace'; icon = 'bi-activity';
    subtitle = 'PPPoE, router, OLT, incident, dan kualitas sinkronisasi jaringan.';
    actions = [
      ['NOC Dashboard', '/nms', 'bi-speedometer2', 'Status jaringan'],
      ['PPP Secrets', '/nms/secrets', 'bi-person-lines-fill', 'Online / offline / isolir'],
      ['Perangkat', '/monitoring', 'bi-grid-1x2-fill', 'Router & perangkat'],
      ['OLT', '/olt', 'bi-hdd-network-fill', 'Registry OLT'],
    ];
  } else if (isTechnician) {
    id = 'technician'; label = 'Teknisi Workspace'; icon = 'bi-tools';
    subtitle = 'Tiket, jadwal, tugas lapangan, dan status pelanggan yang perlu ditangani.';
    actions = [
      ['Ticketing', '/tickets', 'bi-life-preserver', 'Gangguan aktif'],
      ['Jadwal Teknisi', '/schedules', 'bi-calendar2-check-fill', 'Agenda lapangan'],
      ['Pelanggan', '/customers', 'bi-people-fill', 'Detail pelanggan'],
      ['NOC', '/nms', 'bi-activity', 'Cek jaringan'],
    ];
  } else if (isBilling) {
    id = 'billing'; label = 'Admin Billing Workspace'; icon = 'bi-receipt-cutoff';
    subtitle = 'Tagihan, pembayaran, WhatsApp, follow-up, dan pelanggan overdue.';
    actions = [
      ['Tagihan', '/invoices?status=open', 'bi-receipt-cutoff', 'Belum lunas'],
      ['Broadcast WA', '/wa-gateway/broadcast', 'bi-megaphone-fill', 'Reminder pelanggan'],
      ['Approval', '/payments', 'bi-shield-check', 'Pembayaran masuk'],
      ['Pelanggan', '/customers', 'bi-people-fill', 'Data & follow-up'],
    ];
  } else {
    actions = [
      ['Pelanggan', '/customers', 'bi-people-fill', 'Database pelanggan'],
      ['Ticketing', '/tickets', 'bi-life-preserver', 'Pekerjaan aktif'],
    ];
  }

  actions = actions.filter(([title, href]) => {
    if (href.startsWith('/analytics') || href.startsWith('/payments/reconciliation')) return isOwner || allowed.has('finance') || allowed.has('billing');
    if (href.startsWith('/wa-gateway')) return isOwner || allowed.has('billing') || allowed.has('support') || allowed.has('customers');
    if (href.startsWith('/invoices') || href === '/payments') return isOwner || allowed.has('billing') || allowed.has('finance');
    if (href.startsWith('/nms') || href.startsWith('/monitoring') || href.startsWith('/olt')) return isOwner || allowed.has('network');
    if (href.startsWith('/tickets') || href.startsWith('/schedules')) return isOwner || allowed.has('support');
    if (href.startsWith('/customers')) return isOwner || allowed.has('customers') || allowed.has('billing') || allowed.has('support');
    if (href.startsWith('/reports')) return isOwner || allowed.has('reports');
    return true;
  }).map(([title, href, iconName, detail]) => ({ title, href, icon: iconName, detail }));

  return { id, label, icon, subtitle, actions };
}

module.exports = { buildWorkspace };
