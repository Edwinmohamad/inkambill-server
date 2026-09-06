const crypto = require('crypto');

function requireN8nToken(req, res, next) {
  const expected = String(process.env.N8N_API_TOKEN || '').trim();
  if (!expected) return res.status(503).json({ ok: false, error: 'N8N_API_TOKEN belum dikonfigurasi.' });
  const header = String(req.get('x-n8n-token') || '').trim();
  const auth = String(req.get('authorization') || '');
  const supplied = header || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'Token n8n tidak valid.' });
  next();
}

module.exports = { requireN8nToken };
