// TTL cache in-process. Aplikasi berjalan single-process (node app.js), jadi memori lokal sudah
// cukup dan tidak menambah dependency. Bila kelak di-scale ke beberapa instance, ganti
// implementasi get/set di file ini ke Redis (interface sengaja dibuat async-compatible).
const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { store.delete(key); return undefined; }
  return hit.value;
}
function set(key, value, ttlMs) { store.set(key, { value, expires: Date.now() + ttlMs }); return value; }
function del(prefix) { for (const k of store.keys()) if (k === prefix || k.startsWith(prefix)) store.delete(k); }
async function wrap(key, ttlMs, loader) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  return set(key, await loader(), ttlMs);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of store) if (v.expires < now) store.delete(k); }, 60000).unref();

module.exports = { get, set, del, wrap };
