const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const service = read('services/nms/insights.js');
const routes = read('routes/nms.js');
const ui = read('public/js/nms-insights.js');
const common = read('public/js/nms-common.js');
const schema = read('services/nms/schema.js');
const mirror = read('services/nms/secretStore.js');
const automation = read('services/nms/automation.js');

for (const name of ['syncProfileToPackage', 'refreshActiveAnomaly', 'markActiveAsRadius', 'createReconcileTicket']) {
  assert.match(service, new RegExp(`async function ${name}\\b`), `${name} service missing`);
  assert.match(service, new RegExp(`module\\.exports[\\s\\S]*${name}`), `${name} export missing`);
}

for (const endpoint of ['/api/secrets/:id/sync-profile', '/api/anomalies/:id/refresh', '/api/anomalies/:id/radius', '/api/reconcile/ticket']) {
  assert.ok(routes.includes(endpoint), `${endpoint} endpoint missing`);
}
assert.ok((routes.match(/requireNetworkControl/g) || []).length >= 4, 'quick fixes must stay protected by network_control');

for (const label of ['Samakan profile', 'Tarik ulang', 'Tandai RADIUS', 'Buat ulang', 'Putuskan mapping', 'Tiket teknisi']) {
  assert.ok(ui.includes(label), `${label} action missing from reconciliation UI`);
}
assert.match(ui, /confirmBox\(\{ title: 'Samakan profile dengan paket\?'/, 'profile sync confirmation missing');
assert.match(ui, /confirmBox\(\{ title: 'Tandai sebagai sesi RADIUS\?'/, 'RADIUS confirmation missing');
assert.match(common, /c\.username \|\| c\.customer_code/, 'recreate form must preserve removed username');
assert.match(common, /Number\(r\.id\) === Number\(c\.router_id\)/, 'recreate form must preserve router');

for (const column of ['classification', 'resolution_note', 'resolved_by']) assert.ok(schema.includes(column), `${column} anomaly column missing`);
assert.match(mirror, /classification='radius'[\s\S]*COALESCE\(resolved_at,NOW\(\)\)/, 'RADIUS classification must survive polling');
assert.match(automation, /disabled=0, is_isolated=VALUES\(is_isolated\)/, 'recreated mirror state must match RouterOS secret');

console.log('NMS reconciliation quick-fix regression test OK.');
