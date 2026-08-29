const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/auditService');
const {
  getOverview, getActiveSessions, getSyncAudit, captureHourlySample, getTrend24h,
  pushCustomerToRouter, kickSession, deleteSecret
} = require('../services/mikrotikPppoeService');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [overview, sessions, syncAuditData, trend] = await Promise.all([
      getOverview(), getActiveSessions(), getSyncAudit(), getTrend24h()
    ]);
    captureHourlySample().catch(err => console.error('Gagal menyimpan sample PPPoE:', err.message));
    res.render('mikrotik/index', { title: 'MikroTik PPPoE', overview, sessions, syncAudit: syncAuditData, trend, isDummy: false });
  } catch (error) {
    console.error('MikroTik PPPoE overview gagal:', error.message);
    res.render('mikrotik/index', {
      title: 'MikroTik PPPoE',
      overview: { stats: { totalSecrets: 0, online: 0, offline: 0, isolated: 0 }, sync: { synced: 0, rogue: 0, exempt: 0, missing: 0 }, profileDistribution: [], routerErrors: [{ name: 'Semua router', siteCode: '-', error: error.message }], routersChecked: 0 },
      sessions: [],
      syncAudit: { synced: [], rogue: [], missing: [] },
      trend: { labels: [], values: [], isEstimated: true },
      isDummy: true
    });
  }
});

router.post('/sessions/:routerId/:secretId/kick', requireAdmin, async (req, res) => {
  try {
    const result = await kickSession(req.params.routerId, req.params.secretId);
    await audit({ userId: req.session.user.id, action: 'disconnect', entityType: 'pppoe_session', entityId: req.params.secretId, description: `Kick session PPPoE ${result.secret.name} dari ${result.router.name}`, ip: req.ip });
    res.json({ ok: true, message: result.disconnected ? `Sesi ${result.secret.name} berhasil diputus.` : `${result.secret.name} tidak memiliki sesi aktif saat ini.` });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.post('/secrets/:routerId/:secretId/delete', requireAdmin, async (req, res) => {
  try {
    const result = await deleteSecret(req.params.routerId, req.params.secretId);
    await audit({ userId: req.session.user.id, action: 'delete', entityType: 'pppoe_secret', entityId: req.params.secretId, description: `Hapus rogue secret PPPoE ${result.secret.name} dari ${result.router.name}`, ip: req.ip });
    res.json({ ok: true, message: `Secret ${result.secret.name} berhasil dihapus dari router.` });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

router.post('/customers/:customerId/push', requireAdmin, async (req, res) => {
  try {
    const result = await pushCustomerToRouter(req.params.customerId);
    await audit({ userId: req.session.user.id, action: 'create', entityType: 'pppoe_secret', entityId: null, description: `Push to Router: secret ${result.username} dibuat di ${result.router.name} untuk ${result.customer.name}`, ip: req.ip });
    res.json({ ok: true, message: `Secret ${result.username} berhasil dibuat di ${result.router.name}.`, username: result.username, password: result.password });
  } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

module.exports = router;
