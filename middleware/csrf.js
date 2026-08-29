const crypto = require('crypto');

function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;

  const infrastructureProxy = !!req.session?.user && req.path.startsWith('/network/tools/proxy/');
  if (!infrastructureProxy && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = req.body?._csrf || req.headers['x-csrf-token'];
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).send('CSRF token tidak valid. Refresh halaman lalu coba lagi.');
    }
  }
  next();
}

module.exports = csrf;
