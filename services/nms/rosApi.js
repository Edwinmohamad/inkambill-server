// RouterOS REST gateway untuk NMS v2.
// - Circuit breaker per router: router yang timeout tidak dibombardir request (backoff 15s→5m).
// - Maks 2 request paralel per router supaya CPU MikroTik tetap rendah.
// - Semua pemanggilan RouterOS dari modul NMS WAJIB lewat file ini.
const mt = require('../mikrotikRest');
const legacy = require('./legacyApi');
const { summarizePing, normalizeHealth } = require('./analytics');

const MAX_INFLIGHT = Number(process.env.NMS_ROUTER_MAX_INFLIGHT || 2);
const breakers = new Map();
const queues = new Map();

class RouterUnreachableError extends Error {
  constructor(router, cause) {
    super(`Router ${router.name || router.id} tidak terjangkau${cause ? `: ${cause}` : ''}`);
    this.code = 'ROUTER_UNREACHABLE';
    this.routerId = router.id;
  }
}

function breaker(id) { if (!breakers.has(id)) breakers.set(id, { failures: 0, openUntil: 0, lastError: null }); return breakers.get(id); }
function isNetworkError(err) { return !err.statusCode || err.statusCode >= 500; }

function schedule(routerId, task) {
  const q = queues.get(routerId) || { active: 0, waiting: [] };
  queues.set(routerId, q);
  return new Promise((resolve, reject) => {
    const run = async () => {
      q.active++;
      try { resolve(await task()); } catch (e) { reject(e); }
      finally { q.active--; const next = q.waiting.shift(); if (next) next(); }
    };
    if (q.active < MAX_INFLIGHT) run(); else q.waiting.push(run);
  });
}

function isLegacy(router){ return String(router.connector_type||'rest').toLowerCase()==='legacy_api'; }
async function call(router, method, path, body = null, timeoutMs = 8000, { bypassBreaker = false } = {}) {
  const b = breaker(router.id);
  if (!bypassBreaker && b.openUntil > Date.now()) throw new RouterUnreachableError(router, b.lastError);
  try {
    const result = await schedule(router.id, () => mt.request(router, method, path, body, timeoutMs));
    b.failures = 0; b.openUntil = 0; b.lastError = null;
    return result;
  } catch (err) {
    if (isNetworkError(err)) {
      b.failures++;
      b.lastError = err.message;
      b.openUntil = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(b.failures - 1, 5));
      throw new RouterUnreachableError(router, err.message);
    }
    throw err; // 4xx = error logika (mis. profile tidak ada) — bukan indikasi router down
  }
}

const list = r => Array.isArray(r) ? r : (r ? [r] : []);
const enc = encodeURIComponent;

module.exports = {
  RouterUnreachableError,
  breakerState: id => ({ ...breaker(id) }),
  resetBreaker: id => breakers.delete(id),
  async resource(router) {
    if(isLegacy(router)) return list(await schedule(router.id,()=>legacy.resource(router)))[0] || {};
    const r = await call(router, 'GET', '/system/resource?.proplist=uptime,cpu-load,free-memory,total-memory,free-hdd-space,total-hdd-space,board-name,version,architecture-name');
    return list(r)[0] || {};
  },
  async health(router) {
    try {
      if(isLegacy(router)) {
        const rows=await schedule(router.id,()=>legacy.health(router));
        const shaped={}; for(const row of rows){ if(row.name) shaped[row.name]=row.value; }
        return normalizeHealth(shaped);
      }
      return normalizeHealth(await call(router, 'GET', '/system/health'));
    }
    catch (err) { if (err.code === 'ROUTER_UNREACHABLE') throw err; return { temperature: null, voltage: null, unsupported: true }; }
  },
  async interfaces(router) { return isLegacy(router) ? list(await schedule(router.id,()=>legacy.interfaces(router))) : list(await call(router, 'GET', '/interface?.proplist=name,type,comment,running,disabled,rx-byte,tx-byte,rx-packet,tx-packet,rx-drop,tx-drop,rx-error,tx-error,mtu,actual-mtu,mac-address,last-link-up-time,last-link-down-time,link-downs')); },
  async interfaceCounters(router, name) {
    const rows = isLegacy(router) ? list(await schedule(router.id,()=>legacy.interfaceCounters(router,name))) : list(await call(router, 'GET', `/interface?name=${enc(name)}&.proplist=name,rx-byte,tx-byte,running`));
    return rows[0] || null;
  },
  async active(router, username) {
    if(isLegacy(router)) return list(await schedule(router.id,()=>legacy.active(router,username)));
    const q = username ? `name=${enc(username)}&` : '';
    return list(await call(router, 'GET', `/ppp/active?${q}.proplist=.id,name,address,uptime,caller-id,service,session-id`, null, 12000));
  },
  async secrets(router) {
    if(isLegacy(router)) return list(await schedule(router.id,()=>legacy.secrets(router)));
    return list(await call(router, 'GET', '/ppp/secret?.proplist=.id,name,password,service,profile,local-address,remote-address,caller-id,disabled,comment,last-logged-out', null, 20000));
  },
  async secretByName(router, username) {
    return list(await call(router, 'GET', `/ppp/secret?name=${enc(username)}&.proplist=.id,name,profile,disabled,comment,caller-id,remote-address`))[0] || null;
  },
  async profiles(router) { return isLegacy(router) ? list(await schedule(router.id,()=>legacy.profiles(router))) : list(await call(router, 'GET', '/ppp/profile?.proplist=.id,name,rate-limit')); },
  async patchSecret(router, rosId, patch) { return call(router, 'PATCH', `/ppp/secret/${enc(rosId)}`, patch); },
  async createSecret(router, body) { return call(router, 'PUT', '/ppp/secret', body, 12000); },
  /** 1 sampel rx/tx bps untuk interface dinamis PPPoE (<pppoe-username>). */
  async monitorTraffic(router, iface) {
    const rows = list(await call(router, 'POST', '/interface/monitor-traffic', { interface: iface, once: '' }, 8000));
    const r = rows[0] || {};
    return { rxBps: Number(r['rx-bits-per-second']) || 0, txBps: Number(r['tx-bits-per-second']) || 0, rxPps: Number(r['rx-packets-per-second']) || 0, txPps: Number(r['tx-packets-per-second']) || 0 };
  },
  async dropActive(router, username) {
    const sessions = await module.exports.active(router, username);
    for (const s of sessions) await call(router, 'DELETE', `/ppp/active/${enc(s['.id'])}`);
    return sessions.length;
  },
  async ping(router, address, count = 5) {
    const rows = await call(router, 'POST', '/ping', { address, count: String(count), interval: '0.2' }, 15000);
    return summarizePing(list(rows));
  },
  async removeAddressList(router, address, listName) {
    const rows = list(await call(router, 'GET', `/ip/firewall/address-list?list=${enc(listName)}&address=${enc(address)}&.proplist=.id`));
    for (const r of rows) await call(router, 'DELETE', `/ip/firewall/address-list/${enc(r['.id'])}`);
    return rows.length;
  },
  async logs(router) { return isLegacy(router) ? list(await schedule(router.id,()=>legacy.logs(router))) : list(await call(router, 'GET', '/log?.proplist=.id,time,topics,message', null, 15000)); }
};
