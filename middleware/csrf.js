const crypto = require('crypto');

function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;

  const infrastructureProxy = !!req.session?.user && req.path.startsWith('/network/tools/proxy/');
  // n8n webhooks authenticate with their own rotating token. They are server-to-server
  // JSON calls and do not have a browser session from which a CSRF token could be read.
  const n8nWebhook = req.path.startsWith('/api/n8n/');
  // Same reasoning for the WAHA (WhatsApp HTTP API) webhook — WAHA calls this from its own
  // process with a shared token (see middleware/waha.js), not a logged-in browser session.
  const wahaWebhook = req.path.startsWith('/api/waha/');
  // Native crash reports carry the authenticated server session and a custom
  // non-simple header, which browsers cannot forge cross-origin without CORS.
  const mobileNativePost = !!req.session?.user
    && ['/api/mobile/crash','/api/mobile/push-token'].includes(req.path)
    && req.get('x-inkamnet-go') === '1'
    && req.is('application/json');
  if (!infrastructureProxy && !n8nWebhook && !wahaWebhook && !mobileNativePost && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = req.body?._csrf || req.headers['x-csrf-token'];
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).send('CSRF token tidak valid. Refresh halaman lalu coba lagi.');
    }
  }
  next();
}

module.exports = csrf;
