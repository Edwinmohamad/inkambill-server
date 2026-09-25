const http = require('http');
const https = require('https');
const { URL } = require('url');
const { decrypt } = require('./cryptoService');

function request(router, method, path, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const base = router.base_url.replace(/\/$/, '');
    const url = new URL(base + path);
    const transport = url.protocol === 'https:' ? https : http;
    const password = decrypt(router.password_enc);
    const data = body == null ? null : JSON.stringify(body);
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${router.username}:${password}`).toString('base64'),
        'Accept': 'application/json',
        ...(data ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} : {})
      },
      rejectUnauthorized: router.verify_tls !== 0 && router.verify_tls !== false,
      timeout: timeoutMs
    }, res => {
      let raw='';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const msg = parsed?.detail || parsed?.message || raw || `HTTP ${res.statusCode}`;
        const err = new Error(`MikroTik ${res.statusCode}: ${msg}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('MikroTik timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function testConnection(router) {
  const result = await request(router, 'GET', '/system/resource?.proplist=board-name,version,uptime,cpu-load,free-memory,total-memory');
  return Array.isArray(result) ? result[0] : result;
}

async function findSecret(router, username) {
  const result = await request(router, 'GET', `/ppp/secret?name=${encodeURIComponent(username)}&.proplist=.id,name,disabled,profile,service,comment`);
  return Array.isArray(result) ? result[0] || null : result;
}

async function findActive(router, username) {
  const result = await request(router, 'GET', `/ppp/active?name=${encodeURIComponent(username)}&.proplist=.id,name,address,uptime,caller-id,service`);
  return Array.isArray(result) ? result[0] || null : result;
}

async function isolatePppoe(router, username) {
  const secret = await findSecret(router, username);
  if (!secret) throw new Error(`PPPoE secret '${username}' tidak ditemukan`);
  await request(router, 'PATCH', `/ppp/secret/${encodeURIComponent(secret['.id'])}`, { disabled: 'true' });
  const active = await findActive(router, username);
  if (active?.['.id']) await request(router, 'DELETE', `/ppp/active/${encodeURIComponent(active['.id'])}`);
  return { secret, disconnected: !!active };
}

async function unisolatePppoe(router, username) {
  const secret = await findSecret(router, username);
  if (!secret) throw new Error(`PPPoE secret '${username}' tidak ditemukan`);
  await request(router, 'PATCH', `/ppp/secret/${encodeURIComponent(secret['.id'])}`, { disabled: 'false' });
  return { secret };
}

async function listSecrets(router) {
  const fields = '.id,name,service,profile,local-address,remote-address,caller-id,disabled,comment,last-logged-out';
  const result = await request(router, 'GET', `/ppp/secret?.proplist=${fields}`);
  return Array.isArray(result) ? result : [];
}

async function listActive(router) {
  const fields = '.id,name,address,uptime,caller-id,service,encoding,session-id';
  const result = await request(router, 'GET', `/ppp/active?.proplist=${fields}`);
  return Array.isArray(result) ? result : [];
}

async function listProfiles(router) {
  const result = await request(router, 'GET', '/ppp/profile?.proplist=.id,name,local-address,remote-address-list,rate-limit,only-one');
  return Array.isArray(result) ? result : [];
}

async function listInterfaces(router) {
  const fields = '.id,name,type,running,disabled,dynamic,rx-byte,tx-byte,rx-packet,tx-packet,actual-mtu,comment';
  const result = await request(router, 'GET', `/interface?.proplist=${fields}`);
  return Array.isArray(result) ? result : [];
}

async function createSecret(router, payload) {
  return request(router, 'PUT', '/ppp/secret', payload);
}

async function updateSecret(router, id, payload) {
  return request(router, 'PATCH', `/ppp/secret/${encodeURIComponent(id)}`, payload);
}

async function getSecret(router, id) {
  const result = await request(router, 'GET', `/ppp/secret/${encodeURIComponent(id)}?.proplist=.id,name,profile,disabled,comment`);
  return Array.isArray(result) ? result[0] || null : result;
}

async function deleteSecret(router, id) {
  const secret = await getSecret(router,id);
  if (!secret?.name) throw new Error('PPPoE secret tidak ditemukan');
  const active = await findActive(router,secret.name);
  if (active?.['.id']) await request(router,'DELETE',`/ppp/active/${encodeURIComponent(active['.id'])}`);
  await request(router,'DELETE',`/ppp/secret/${encodeURIComponent(id)}`);
  return {secret,disconnected:!!active};
}

async function disconnectSecret(router,id){
  const secret=await getSecret(router,id);
  if(!secret?.name)throw new Error('PPPoE secret tidak ditemukan');
  const active=await findActive(router,secret.name);
  if(active?.['.id'])await request(router,'DELETE',`/ppp/active/${encodeURIComponent(active['.id'])}`);
  return {secret,disconnected:!!active};
}

// Triggers a RouterOS reboot via the REST API (equivalent to `/system reboot` in the CLI). RouterOS
// tears the connection down as it restarts, so a socket-level error right after the request was
// accepted does not necessarily mean the command failed -- callers should treat this as "best effort"
// and confirm the router is back online afterwards (e.g. via testConnection once it resurfaces).
async function reboot(router) {
  return request(router, 'POST', '/system/reboot', {});
}

// ---- Firewall address-list (isolir berbasis IP) -------------------------------------------------
// REST equivalent dari CLI: /ip firewall address-list remove [find address=X.X.X.X list=ISOLIR]
async function removeFromAddressList(router, address, list = 'ISOLIR') {
  if (!address) return { removed: 0 };
  const result = await request(router, 'GET', `/ip/firewall/address-list?list=${encodeURIComponent(list)}&address=${encodeURIComponent(address)}&.proplist=.id,address,list`);
  const rows = Array.isArray(result) ? result : [];
  for (const r of rows) await request(router, 'DELETE', `/ip/firewall/address-list/${encodeURIComponent(r['.id'])}`);
  return { removed: rows.length };
}
// REST equivalent: /ip firewall address-list add list=ISOLIR address=X.X.X.X comment=...
async function addToAddressList(router, address, list = 'ISOLIR', comment = '') {
  if (!address) return { added: false };
  const existing = await request(router, 'GET', `/ip/firewall/address-list?list=${encodeURIComponent(list)}&address=${encodeURIComponent(address)}&.proplist=.id`);
  if (Array.isArray(existing) && existing.length) return { added: false, exists: true };
  await request(router, 'PUT', '/ip/firewall/address-list', { list, address, comment: String(comment || '').slice(0, 120) });
  return { added: true };
}
async function secretRemoteAddress(router, username) {
  const result = await request(router, 'GET', `/ppp/secret?name=${encodeURIComponent(username)}&.proplist=.id,remote-address`);
  const row = Array.isArray(result) ? result[0] : result;
  return row?.['remote-address'] || null;
}

module.exports = {
  request, testConnection, findSecret, findActive, isolatePppoe, unisolatePppoe,
  listSecrets, listActive, listProfiles, listInterfaces, createSecret, updateSecret, getSecret, deleteSecret, disconnectSecret, reboot,
  removeFromAddressList, addToAddressList, secretRemoteAddress
};
