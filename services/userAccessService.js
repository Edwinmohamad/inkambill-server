// Akses per pengguna (v1.35). Master Admin mencentang menu yang boleh dibuka tiap pengguna.
// Bila users.access_json kosong, pengguna mengikuti hak akses role seperti sebelumnya.
// Akses dijaga di server (middleware/enforceUserAccess.js), bukan hanya menu yang disembunyikan.
const MENU_ITEMS = [
  { key: 'dashboard', group: 'Utama', label: 'Dashboard', perm: 'dashboard', exact: ['/'], prefixes: ['/dashboard'] },
  { key: 'kpi', group: 'Utama', label: 'KPI Penagihan', perm: 'dashboard', prefixes: ['/kpi'] },
  { key: 'performa', group: 'Utama', label: 'Performa Bulanan', perm: 'finance', prefixes: ['/performa', '/analytics'] },
  { key: 'customers', group: 'Pelanggan', label: 'Pelanggan', perm: 'customers', prefixes: ['/customers'] },
  { key: 'packages', group: 'Pelanggan', label: 'Paket Internet', perm: 'customers', prefixes: ['/packages'] },
  { key: 'invoices', group: 'Tagihan', label: 'Tagihan', perm: 'billing', prefixes: ['/invoices'] },
  { key: 'payments', group: 'Tagihan', label: 'Approval & Input Pembayaran', perm: 'billing', prefixes: ['/payments'] },
  { key: 'billing_tools', group: 'Tagihan', label: 'Billing Tools (faktur kustom, diskon, biaya)', perm: 'billing', prefixes: ['/custom-invoices', '/discounts', '/charges'] },
  { key: 'wa_inbox', group: 'Tagihan', label: 'WA Inbox', perm: 'billing', prefixes: ['/wa-inbox'] },
  { key: 'cash', group: 'Keuangan', label: 'Data Kas & Kategori Kas', perm: 'finance', prefixes: ['/cash'] },
  { key: 'reports', group: 'Keuangan', label: 'Laporan', perm: 'reports', prefixes: ['/reports'] },
  { key: 'debts', group: 'Keuangan', label: 'Hutang & Piutang', perm: 'finance', prefixes: ['/debts'] },
  { key: 'pppoe', group: 'Network', label: 'Sinkronisasi PPPoE, Router, Site, Cluster', perm: 'network', prefixes: ['/nms', '/routers', '/network', '/sites', '/clusters', '/acs', '/olt', '/monitoring'] },
  { key: 'inventory', group: 'Operasional', label: 'Gudang & Material', perm: 'warehouse', prefixes: ['/inventory'] },
  { key: 'server_duty', group: 'Operasional', label: 'Piket Server', perm: 'support', prefixes: ['/server-duty', '/tickets', '/operations', '/schedules', '/team-kpi'] },
  { key: 'wa_gateway', group: 'Sistem', label: 'WA Gateway', perm: 'settings', prefixes: ['/wa-gateway'] },
  { key: 'settings', group: 'Sistem', label: 'Pengaturan', perm: 'settings', prefixes: ['/settings'] },
  { key: 'logs', group: 'Sistem', label: 'Log Aktivitas', perm: 'logs', prefixes: ['/logs'] }
];
const ACTIONS = [
  { key: 'delete', label: 'Boleh menghapus / mengarsipkan data' },
  { key: 'network_control', label: 'Boleh isolir, kick, dan ubah PPPoE' }
];
const TEMPLATES = {
  penagih: { label: 'Penagih & Admin Input', menus: ['kpi', 'customers', 'invoices', 'payments', 'wa_inbox'], actions: [], home: 'kpi' },
  keuangan: { label: 'Keuangan', menus: ['dashboard', 'performa', 'invoices', 'payments', 'cash', 'reports', 'debts'], actions: [], home: 'dashboard' },
  teknisi: { label: 'Teknisi / NOC', menus: ['customers', 'pppoe', 'inventory', 'server_duty'], actions: ['network_control'], home: 'pppoe' },
  admin: { label: 'Admin penuh', menus: MENU_ITEMS.map(m => m.key), actions: ACTIONS.map(a => a.key), home: 'dashboard' }
};
const HOME_PATH = { dashboard: '/', kpi: '/kpi', performa: '/performa', customers: '/customers', invoices: '/invoices', payments: '/payments', cash: '/cash', pppoe: '/nms/secrets', inventory: '/inventory', server_duty: '/server-duty', reports: '/reports' };
// Halaman yang selalu boleh dibuka siapa pun yang login.
const ALWAYS = ['/profile', '/logout', '/login', '/communication', '/api/', '/health', '/healthz', '/favicon', '/notifications', '/messages', '/manifest', '/sw.js'];

const MENU_KEYS = new Set(MENU_ITEMS.map(m => m.key));
const ACTION_KEYS = new Set(ACTIONS.map(a => a.key));

function parseAccess(value) {
  if (!value) return null;
  let raw = value;
  if (typeof value === 'string') { try { raw = JSON.parse(value); } catch { return null; } }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.menus)) return null;
  const menus = [...new Set(raw.menus.filter(k => MENU_KEYS.has(k)))];
  const actions = [...new Set((Array.isArray(raw.actions) ? raw.actions : []).filter(k => ACTION_KEYS.has(k)))];
  let home = HOME_PATH[raw.home] && menus.includes(raw.home) ? raw.home : null;
  if (!home) home = ['dashboard', 'kpi', 'invoices', 'payments', 'customers'].find(k => menus.includes(k)) || menus.find(k => HOME_PATH[k]) || null;
  return { menus, actions, home, template: TEMPLATES[raw.template] ? raw.template : null };
}

function cleanPath(path) { return String(path || '/').split('?')[0].split('#')[0] || '/'; }
function menuForPath(path) {
  const p = cleanPath(path);
  for (const m of MENU_ITEMS) {
    if ((m.exact || []).includes(p)) return m;
    if ((m.prefixes || []).some(pre => p === pre || p.startsWith(pre + '/'))) return m;
  }
  return null;
}
function isAlwaysAllowed(path) { const p = cleanPath(path); return ALWAYS.some(a => p === a || p.startsWith(a.endsWith('/') ? a : a + '/') || p.startsWith(a)); }

function permissionsForAccess(access) {
  const perms = new Set(['dashboard']);
  for (const m of MENU_ITEMS) if (access.menus.includes(m.key)) perms.add(m.perm);
  if (access.actions.includes('network_control')) perms.add('network_control');
  return [...perms];
}
function menuAllowed(access, path) {
  if (!access) return true;
  const m = menuForPath(path);
  return !m || access.menus.includes(m.key);
}
function homePath(access) { return access && access.home ? HOME_PATH[access.home] || '/' : '/'; }

async function ensureUserAccessSchema(db) {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_json LONGTEXT NULL`);
}

module.exports = { MENU_ITEMS, ACTIONS, TEMPLATES, HOME_PATH, parseAccess, menuForPath, isAlwaysAllowed, permissionsForAccess, menuAllowed, homePath, ensureUserAccessSchema };
