const express = require('express');
const { handleWahaWebhookEvent } = require('../services/whatsappGatewayService');
const router = express.Router();

// Inbound webhook FROM WAHA — session status changes (qr_pending/connected/disconnected) and
// incoming messages get pushed here so the WA Gateway page updates in real time instead of
// relying only on polling. Mounted in app.js behind requireWahaWebhookToken (server-to-server
// secret, not a browser session — see middleware/waha.js), and exempted from CSRF in
// middleware/csrf.js the same way /api/n8n/ already is.
router.post('/webhook', async (req, res) => {
  try {
    await handleWahaWebhookEvent(req.body || {});
  } catch (e) {
    console.error('WA Gateway: gagal memproses webhook WAHA:', e.message);
    // Still answer 200 — we don't want WAHA retrying forever over a body it sent correctly but we
    // failed to process; the periodic reconcileGatewayStatus() safety net will catch up.
  }
  res.json({ ok: true });
});

module.exports = router;
