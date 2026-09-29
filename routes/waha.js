const express = require('express');
const { handleWahaWebhookEvent } = require('../services/whatsappGatewayService');
const router = express.Router();
const health = require('../services/waWebhookHealth');

// Inbound webhook FROM WAHA — session status changes (qr_pending/connected/disconnected) and
// incoming messages get pushed here so the WA Gateway page updates in real time instead of
// relying only on polling. Mounted in app.js behind requireWahaWebhookToken (server-to-server
// secret, not a browser session — see middleware/waha.js), and exempted from CSRF in
// middleware/csrf.js the same way /api/n8n/ already is.
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    const result = await handleWahaWebhookEvent(event);
    await health.record(event.event, result);
  } catch (e) {
    await health.error(e);
    console.error('WA Gateway: gagal memproses webhook WAHA:', e.message);
    // Session reconciliation cannot recover a missed chat message. A non-2xx response
    // lets WAHA retry; duplicate message IDs are ignored by the inbox insert.
    return res.status(503).json({ ok: false, error: 'Webhook belum berhasil diproses.' });
  }
  res.json({ ok: true });
});

module.exports = router;
