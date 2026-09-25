// NMS v2 regression: pure logic (Smart Sync matching, anomaly engine, RouterOS parsers) + wiring statis.
const assert = require('assert');
const fs = require('fs');
const read = f => fs.readFileSync(f, 'utf8');
const { buildSmartSyncPlan, exemptOf, normalizeKey, compactKey } = require('../services/nms/matching');
const A = require('../services/nms/analytics');
let checks = 0; const ok = (c, m) => { assert(c, m); checks++; };

// --- Smart Sync matching ---
const customers = [
  { id: 1, site_id: 10, customer_code: 'CLM-001', name: 'Budi Santoso' },
  { id: 2, site_id: 10, customer_code: 'CLM-002', name: 'Siti Aminah' },
  { id: 3, site_id: 20, customer_code: 'KBG-001', name: 'Budi Santoso' },
  { id: 4, site_id: 10, customer_code: 'CLM-004', name: 'Andi' },
  { id: 5, site_id: 10, customer_code: 'CLM-005', name: 'Andi' },
  { id: 6, site_id: 10, customer_code: 'CLM-006', name: 'Sudah Link', linked_secret_id: 99 }
];
const secrets = [
  { id: 100, site_id: 10, username: 'BUDI SANTOSO' },     // nama, case-insensitive
  { id: 101, site_id: 10, username: 'clm-002' },          // customer code
  { id: 102, site_id: 20, username: 'budi.santoso' },     // compact name → site 20 saja
  { id: 103, site_id: 10, username: 'andi' },             // ambigu 2 pelanggan
  { id: 104, site_id: 10, username: 'sudah link' },       // pelanggan sudah terikat
  { id: 105, site_id: 10, username: 'noc-monitor', is_exempt: 1 },
  { id: 106, site_id: 10, username: 'tidak-ada' }
];
const plan = buildSmartSyncPlan(secrets, customers);
const pair = id => plan.pairs.find(p => p.secretId === id);
ok(pair(100)?.customerId === 1 && pair(100).matchedOn === 'customer_name', 'match nama case-insensitive');
ok(pair(101)?.customerId === 2 && pair(101).matchedOn === 'customer_code', 'match customer_code');
ok(pair(102)?.customerId === 3, 'match per site (tidak lintas site)');
ok(!pair(103) && plan.conflicts.some(c => c.secretId === 103 && c.reason === 'multiple_customers'), 'ambigu → konflik');
ok(!pair(104) && !pair(105) && !pair(106), 'linked/exempt/unmatched tidak di-link');
ok(plan.summary.matched === 3 && plan.summary.conflicts === 1 && plan.summary.unmatched === 2, 'summary preview');
const dup = buildSmartSyncPlan([{ id: 1, site_id: 1, username: 'CLM-9' }, { id: 2, site_id: 1, username: 'clm 9' }], [{ id: 9, site_id: 1, customer_code: 'CLM-9', name: 'X' }]);
ok(dup.pairs.length === 0 && dup.conflicts.length === 2, '1 pelanggan diklaim 2 secret → konflik');
ok(exemptOf({ username: 'noc-monitor' }) === 'admin' && exemptOf({ username: 'x', comment: '[FREE] owner' }) === 'free' && exemptOf({ username: 'budi' }) === null, 'exempt rules');
ok(normalizeKey('  Budí   Santoso ') === 'budi santoso' && compactKey('Budi_Santoso') === 'budisantoso', 'normalisasi');

// --- RouterOS parsers ---
ok(A.uptimeSeconds('1w2d3h4m5s') === 604800 + 2 * 86400 + 3 * 3600 + 245, 'uptime parse');
ok(A.rttMs('1ms234us') === 1.23 && A.rttMs('850us') === 0.85 && A.rttMs('12ms') === 12, 'rtt parse');
const ping = A.summarizePing([{ seq: 0, time: '10ms' }, { seq: 1, status: 'timeout' }, { seq: 4, time: '12ms', sent: 5, received: 4, 'packet-loss': 20, 'avg-rtt': '11ms', 'min-rtt': '10ms', 'max-rtt': '12ms' }]);
ok(ping.avgMs === 11 && ping.lossPct === 20 && ping.sent === 5 && ping.received === 4, 'ping summary');
ok(A.normalizeHealth([{ name: 'temperature', value: '47', type: 'C' }, { name: 'voltage', value: '24.1' }]).temperature === 47, 'health v7');
ok(A.normalizeHealth({ temperature: '41', voltage: '12' }).voltage === 12, 'health v6');
ok(A.loadTone(59) === 'green' && A.loadTone(60) === 'yellow' && A.loadTone(81) === 'red', 'CPU tone thresholds');

// --- Anomaly engine ---
const d = A.diffActive([{ name: 'a', 'session-id': '1' }, { name: 'b', 'session-id': '2' }], [{ name: 'b', 'session-id': '2' }, { name: 'c', 'session-id': '3' }, { name: 'a', 'session-id': '9' }]);
ok(d.logins.length === 2 && d.logouts.length === 1 && d.logouts[0].name === 'a', 'diff /ppp/active');
const now = Date.now();
const logouts = Array.from({ length: 12 }, (_, i) => ({ siteId: 7, username: `u${i}`, at: now - 30000 }));
ok(A.detectMassDisconnect(logouts, new Set(), { now })[0]?.count === 12, 'FO cut >10 dalam 2 menit');
ok(A.detectMassDisconnect(logouts, new Set(['u0', 'u1', 'u2']), { now }).length === 0, 'user yang sudah login lagi tidak dihitung');
ok(A.detectMassDisconnect(logouts.map(e => ({ ...e, at: now - 300000 })), new Set(), { now }).length === 0, 'di luar window');
const logins = Array.from({ length: 6 }, () => ({ siteId: 1, username: 'flap', at: now - 1000 }));
ok(A.detectFlapping(logins, { now })[0]?.count === 6 && A.detectFlapping(logins.slice(0, 5), { now }).length === 0, 'flapping >5/jam');

// --- Wiring ---
const app = read('app.js'), layout = read('views/partials/layout.ejs'), acs = read('routes/acs.js'), routes = read('routes/nms.js'), schema = read('services/nms/schema.js'), control = read('services/nms/control.js');
ok(!app.includes("require('./routes/noc')") && !fs.existsSync('routes/noc.js') && !fs.existsSync('views/noc/index.ejs') && !fs.existsSync('public/js/noc.js'), 'NOC Terpadu dihapus');
ok(!acs.includes("router.get('/map'") && !acs.includes('/map/nodes') && !fs.existsSync('views/acs/map.ejs'), 'Network Map dihapus');
ok(!layout.includes('NOC Terpadu') && !layout.includes('Network Map') && !layout.includes('/acs/map') && !layout.includes("href=\"/noc\""), 'menu bersih');
ok(app.includes("app.use('/nms', requireAuth, requirePermission('network')") && app.includes('ensureNmsV2Schema') && app.includes('nmsPoller.start()'), 'mount & bootstrap');
for (const t of ['ppp_secrets', 'nms_ppp_events', 'nms_router_state', 'nms_alerts', 'audit_logs ADD COLUMN IF NOT EXISTS details', "sync_status ENUM('synced','unsynced')"]) ok(schema.includes(t), `schema ${t}`);
for (const r of ["'/api/sync/preview'", "'/api/sync/commit'", "'/api/secrets/:id/isolate'", "'/api/secrets/:id/unisolate'", "'/api/secrets/:id/kick'", "'/api/secrets/:id/ping'", "'/api/secrets/:id/lock-mac'", "'/api/secrets/:id/map'", "'/api/bulk'", "'/api/stream'", "'/api/dashboard'"]) ok(routes.includes(r), `route ${r}`);
ok(routes.includes('requireNetworkControl') && read('middleware/auth.js').includes("'network_control'"), 'RBAC kontrol jaringan');
ok(control.includes('dropActive') && control.includes('caller-id') && control.includes('audited('), 'aksi drop sesi / lock mac / audit');
ok(read('routes/n8n.js').includes("'/nms/ppp-event'"), 'webhook n8n PPP event');
ok(read('views/nms/_bar.ejs').includes('ROUTER UNREACHABLE / OFFLINE (SHOWING CACHED DATA)') && read('views/nms/_bar.ejs').includes('nmsSiteSelect'), 'offline badge + site filter');
ok(read('public/css/nms-noc.css').includes('#0B0F19') && read('public/css/nms-noc.css').includes('#10B981'), 'NOC palette');
console.log(`NMS v2 test OK: ${checks} checks.`);
