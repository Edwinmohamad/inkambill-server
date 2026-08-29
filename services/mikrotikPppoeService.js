const crypto = require('crypto');
const db = require('../config/db');
const { allSnapshots, saveSecret, syncSecret, removeSecret, disconnectSecret } = require('./nmsService');

const SAMPLE_MIN_GAP_MINUTES = 50;
const SAMPLE_RETENTION_ROWS = 800;
const TREND_HOURS = 24;

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

// Aggregates every router snapshot into the numbers the PPPoE Analytics tab needs:
// stat cards, profile distribution (doughnut), and sync classification counts.
async function getOverview() {
  const snapshots = await allSnapshots();
  const profileCounts = new Map();
  let online = 0, offline = 0, isolated = 0, synced = 0, rogue = 0, exempt = 0, missing = 0;
  for (const snap of snapshots) {
    for (const secret of snap.secrets || []) {
      online += secret.status === 'online' ? 1 : 0;
      offline += secret.status === 'offline' ? 1 : 0;
      isolated += secret.status === 'isolated' ? 1 : 0;
      const profileKey = secret.profile || 'default';
      profileCounts.set(profileKey, (profileCounts.get(profileKey) || 0) + 1);
      if (secret.customer) synced++;
      else if (secret.exempt) exempt++;
      else rogue++;
    }
    missing += (snap.unmatchedCustomers || []).length;
  }
  const totalSecrets = online + offline + isolated;
  const profileDistribution = [...profileCounts.entries()].sort((a, b) => b[1] - a[1]).map(([profile, count]) => ({ profile, count }));
  const routerErrors = snapshots.filter(s => !s.ok).map(s => ({ name: s.name, siteCode: s.siteCode, error: s.error }));
  return {
    stats: { totalSecrets, online, offline, isolated },
    sync: { synced, rogue, exempt, missing },
    profileDistribution,
    routerErrors,
    routersChecked: snapshots.length
  };
}

async function getActiveSessions() {
  const snapshots = await allSnapshots();
  const rows = [];
  for (const snap of snapshots) {
    for (const secret of snap.secrets || []) {
      if (!secret.active) continue;
      rows.push({
        routerId: snap.id,
        routerName: snap.name,
        siteCode: snap.siteCode,
        secretId: secret['.id'],
        username: secret.name,
        profile: secret.profile || 'default',
        address: secret.active.address || '-',
        uptime: secret.active.uptime || '-',
        callerId: secret.active['caller-id'] || secret.active.callerId || '-',
        customerName: secret.customer?.name || null,
        customerCode: secret.customer?.customer_code || null
      });
    }
  }
  return rows.sort((a, b) => a.username.localeCompare(b.username));
}

async function getSyncAudit() {
  const snapshots = await allSnapshots();
  const synced = [], rogue = [], missing = [];
  for (const snap of snapshots) {
    for (const secret of snap.secrets || []) {
      const base = { routerId: snap.id, routerName: snap.name, siteCode: snap.siteCode, secretId: secret['.id'], username: secret.name, profile: secret.profile || 'default', status: secret.status };
      if (secret.customer) synced.push({ ...base, customerId: secret.customer.id, customerName: secret.customer.name, customerCode: secret.customer.customer_code });
      else if (!secret.exempt) rogue.push({ ...base, suggestions: secret.suggestions || [] });
    }
    for (const customer of snap.unmatchedCustomers || []) {
      missing.push({ customerId: customer.id, customerCode: customer.customer_code, customerName: customer.name, siteCode: snap.siteCode, routerId: snap.id, routerName: snap.name, suggestions: customer.suggestions || [] });
    }
  }
  return { synced, rogue, missing };
}

// Records one aggregate sample per SAMPLE_MIN_GAP_MINUTES so the 24h trend chart has
// real history to draw from once the app has been running for a day.
async function captureHourlySample() {
  const [[last]] = await db.execute(`SELECT sampled_at FROM pppoe_hourly_samples ORDER BY sampled_at DESC LIMIT 1`);
  if (last?.sampled_at && (Date.now() - new Date(last.sampled_at).getTime()) < SAMPLE_MIN_GAP_MINUTES * 60000) return { skipped: true };
  const { stats } = await getOverview();
  await db.execute(`INSERT INTO pppoe_hourly_samples(sampled_at,online_count,offline_count,isolated_count,total_count) VALUES(NOW(),?,?,?,?)`,
    [stats.online, stats.offline, stats.isolated, stats.totalSecrets]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) total FROM pppoe_hourly_samples`);
  if (total > SAMPLE_RETENTION_ROWS) {
    await db.execute(`DELETE FROM pppoe_hourly_samples ORDER BY sampled_at ASC LIMIT ?`, [total - SAMPLE_RETENTION_ROWS]);
  }
  return { skipped: false };
}

function hourLabel(date) { return `${String(date.getHours()).padStart(2, '0')}:00`; }

// Returns 24 hourly points for the active-users trend line. When history is thin
// (fresh install) it backfills with a smooth, clearly-labelled estimate so the
// chart never crashes or renders empty on day one.
async function getTrend24h() {
  const since = new Date(Date.now() - TREND_HOURS * 3600000);
  const [rows] = await db.execute(`SELECT sampled_at,online_count FROM pppoe_hourly_samples WHERE sampled_at>=? ORDER BY sampled_at ASC`, [since]);
  const now = new Date();
  const buckets = Array.from({ length: TREND_HOURS }, (_, i) => new Date(now.getTime() - (TREND_HOURS - 1 - i) * 3600000));
  if (rows.length >= 6) {
    const byHour = new Map(rows.map(r => [hourLabel(new Date(r.sampled_at)), num(r.online_count)]));
    let lastKnown = rows[0] ? num(rows[0].online_count) : 0;
    const values = buckets.map(bucket => {
      const key = hourLabel(bucket);
      if (byHour.has(key)) { lastKnown = byHour.get(key); return lastKnown; }
      return lastKnown;
    });
    return { labels: buckets.map(hourLabel), values, isEstimated: false };
  }
  const { stats } = await getOverview();
  const base = stats.online || 0;
  const values = buckets.map((_, i) => Math.max(0, Math.round(base * (0.82 + 0.18 * Math.sin(i / 3)))));
  return { labels: buckets.map(hourLabel), values, isEstimated: true };
}

async function pickRouterForSite(siteCode) {
  const [rows] = await db.execute(`SELECT r.id,r.name,r.site_id,s.code site_code FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 AND s.code=? ORDER BY r.id LIMIT 1`, [siteCode]);
  if (!rows.length) throw new Error(`Tidak ada router aktif terdaftar untuk site ${siteCode}.`);
  return rows[0];
}

function generateSecretPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'Inkamnet123';
}

// "Push to Router": provisions a brand-new PPPoE secret on the router matching the
// customer's site, named after their billing customer code, and links it back.
async function pushCustomerToRouter(customerId) {
  const [rows] = await db.execute(`SELECT c.id,c.customer_code,c.name,c.pppoe_username,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.id=? AND c.customer_status='active'`, [customerId]);
  const customer = rows[0];
  if (!customer) throw new Error('Pelanggan billing tidak ditemukan atau tidak aktif.');
  const router = await pickRouterForSite(customer.site_code);
  const username = customer.pppoe_username || customer.customer_code;
  const password = generateSecretPassword();
  const result = await saveSecret(router.id, null, { name: username, password, service: 'pppoe', profile: 'default', comment: `[BILLING] ${customer.customer_code}` }, customer.id);
  return { router: result.router, username, password, customer };
}

module.exports = {
  getOverview, getActiveSessions, getSyncAudit, captureHourlySample, getTrend24h,
  pushCustomerToRouter, kickSession: disconnectSecret, deleteSecret: removeSecret, syncSecret
};
