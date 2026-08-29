const crypto = require('crypto');

function key() {
  const secret = process.env.ROUTER_CREDENTIAL_KEY || process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error('ROUTER_CREDENTIAL_KEY belum diset dengan aman');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  const [ivB64, tagB64, encB64] = String(payload).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
