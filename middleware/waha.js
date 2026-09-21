const crypto = require('crypto');

// Verifies inbound webhook calls FROM WAHA (session status changes, incoming messages). WAHA is
// a server-to-server caller with no browser session, so — same pattern as requireN8nToken in
// middleware/n8n.js — this checks a shared secret instead of req.session.user. Accepts the token
// either as a query string (?token=...) or a header, since not every WAHA version/config lets you
// attach custom headers to outgoing webhooks, but the callback URL query string always works
// because we build it ourselves when calling wahaClient.startSession().
function requireWahaWebhookToken(req, res, next) {
  const expected = String(process.env.WAHA_WEBHOOK_TOKEN || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'WAHA_WEBHOOK_TOKEN belum dikonfigurasi.' });
  const supplied = String(req.query.token || req.get('x-waha-webhook-token') || '').trim();
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Token webhook WAHA tidak valid.' });
  }
  next();
}

module.exports = { requireWahaWebhookToken };
