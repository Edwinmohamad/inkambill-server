// Sidebar shortcuts are presentation only. Every route still enforces its own permissions.
const ITEMS = {
  dashboard: { href: '/', label: 'Dashboard', icon: 'bi-grid-1x2-fill', permission: 'dashboard', exact: true },
  customers: { href: '/customers', label: 'Pelanggan', icon: 'bi-people-fill', permission: 'customers' },
  invoices: { href: '/invoices', label: 'Tagihan', icon: 'bi-receipt-cutoff', permission: 'billing' },
  payments: { href: '/payments', label: 'Approval & Transaksi', icon: 'bi-shield-check', permissions: ['billing', 'finance'], exact: true },
  inbox: { href: '/wa-inbox', label: 'WA Inbox', icon: 'bi-chat-dots-fill', permissions: ['billing', 'support', 'customers', 'settings'] },
  messages: { href: '/wa-gateway/broadcast', label: 'Pusat Pesan WA', icon: 'bi-megaphone-fill', admin: true, permissions: ['billing', 'support', 'customers'] },
  tickets: { href: '/tickets', label: 'Ticketing', icon: 'bi-life-preserver', permission: 'support' },
  schedules: { href: '/schedules', label: 'Jadwal Teknisi', icon: 'bi-calendar2-check-fill', permission: 'support' },
  nms: { href: '/nms', label: 'NOC Dashboard', icon: 'bi-speedometer2', permission: 'network', exact: true },
  secrets: { href: '/nms/secrets', label: 'PPP Secrets', icon: 'bi-person-lines-fill', permission: 'network' },
  devices: { href: '/monitoring', label: 'Kelola Perangkat', icon: 'bi-grid-1x2-fill', permission: 'network' },
  cash: { href: '/cash', label: 'Arus Kas', icon: 'bi-cash-stack', permission: 'finance', exact: true },
  inventory: { href: '/inventory', label: 'Gudang', icon: 'bi-box-seam-fill', permission: 'warehouse', exact: true },
  procurement: { href: '/inventory/procurement', label: 'Belanja & Transfer', icon: 'bi-bag-check-fill', permission: 'warehouse' },
  reports: { href: '/reports', label: 'Laporan', icon: 'bi-bar-chart-line-fill', permission: 'reports' },
};

function sidebarMenu(role, permissions = [], isAdmin = false) {
  const allowed = new Set(permissions);
  const key = String(role || '').toLowerCase().replace(/[\s-]+/g, '_');
  let focus = 'Staf';
  let order = ['dashboard', 'customers', 'invoices', 'payments', 'tickets', 'inbox', 'reports'];
  if (key === 'master_admin' || key === 'admin') {
    focus = 'Admin';
    order = ['dashboard', 'customers', 'invoices', 'payments', 'messages', 'tickets', 'nms', 'cash'];
  } else if (/teknisi|technical|network|noc/.test(key) || (allowed.has('network') && allowed.has('support') && !allowed.has('billing'))) {
    focus = 'Teknisi';
    order = ['dashboard', 'nms', 'secrets', 'devices', 'tickets', 'schedules', 'inbox'];
  } else if (/gudang|warehouse|inventory/.test(key) || (allowed.has('warehouse') && !allowed.has('billing') && !allowed.has('network'))) {
    focus = 'Gudang';
    order = ['dashboard', 'inventory', 'procurement', 'tickets', 'reports'];
  } else if (/finance|keuangan|billing|penagihan|admin_keuangan/.test(key) || allowed.has('finance')) {
    focus = 'Penagihan & Keuangan';
    order = ['dashboard', 'invoices', 'payments', 'cash', 'customers', 'inbox', 'reports'];
  }
  const items = order.map(name => ITEMS[name]).filter(item => item &&
    (!item.admin || isAdmin) &&
    (!item.permission || allowed.has(item.permission)) &&
    (!item.permissions || item.permissions.some(p => allowed.has(p))));
  return { focus, items };
}

module.exports = { sidebarMenu };
