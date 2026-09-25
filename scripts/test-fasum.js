// Uji logika Fasum tanpa MySQL/RouterOS: deteksi otomatis, prioritas tag, dan hitung durasi online.
const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = function (req, ...rest) {
  if (/config\/db$/.test(req)) return { query: async () => [[]], execute: async () => [{}] };
  if (/auditService$/.test(req)) return { audit: async () => {} };
  return load.call(this, req, ...rest);
};
const { exemptOf, buildSmartSyncPlan } = require('../services/nms/matching');
const { onlineSeconds } = require('../services/nms/fasum');

for (const u of ['masjid_alikhlas', 'MasjidAlIkhlas', 'pos-ronda-rt3', 'balai.desa', 'sekolah01']) assert.strictEqual(exemptOf({ username: u }), 'fasum', u);
for (const u of ['budi01', 'rumahbudi', 'andi-santoso']) assert.strictEqual(exemptOf({ username: u }), null, u);
assert.strictEqual(exemptOf({ username: 'x', comment: '[FASUM] gratis' }), 'fasum', 'tag FASUM menang atas kata free');
assert.strictEqual(exemptOf({ username: 'masjid', comment: '[ADMIN]' }), 'admin', 'tag ADMIN menang');
assert.strictEqual(exemptOf({ username: 'noc-monitor' }), 'admin');
assert.strictEqual(exemptOf({ username: 'kafe01' }, { fasumWords: ['kafe'] }), 'fasum', 'kata kunci dari pengaturan');
assert.strictEqual(exemptOf({ username: 'masjid01' }, { fasumWords: ['kafe'] }), null, 'kata kunci bawaan diganti pengaturan');

const plan = buildSmartSyncPlan([{ id: 1, site_id: 1, username: 'Masjid Raya', is_exempt: 1 }], [{ id: 5, site_id: 1, customer_code: 'C-1', name: 'Masjid Raya' }]);
assert.strictEqual(plan.pairs.length + plan.unmatched.length + plan.suggestions.length, 0, 'secret Fasum tidak ikut Smart Sync');

const s = new Date('2026-09-01T00:00:00Z'), e = new Date('2026-09-02T00:00:00Z');
assert.strictEqual(onlineSeconds([], { start: s, end: e, onlineNow: true }), 86400);
assert.strictEqual(onlineSeconds([], { start: s, end: e, onlineNow: false }), 0);
assert.strictEqual(onlineSeconds([{ type: 'login', at: '2026-09-01T02:00:00Z' }, { type: 'logout', at: '2026-09-01T05:00:00Z' }], { start: s, end: e, onlineNow: false }), 3 * 3600);
assert.strictEqual(onlineSeconds([{ type: 'logout', at: '2026-09-01T01:00:00Z' }, { type: 'login', at: '2026-09-01T23:00:00Z' }], { start: s, end: e, onlineNow: true }), 2 * 3600);
console.log('Fasum test OK: deteksi otomatis, prioritas tag, pengecualian Smart Sync, durasi online.');
