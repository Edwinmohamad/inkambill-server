// Realtime hub untuk Web Inbox WhatsApp (WebSocket, paket `ws`). Autentikasi memakai sesi login yang
// sama dengan aplikasi (express-session di-parse saat HTTP upgrade), jadi hanya user yang login dan
// punya izin inbox yang bisa terhubung. Service lain cukup memanggil emit(); bila server WS belum
// dipasang (mis. saat test/CLI), emit() diam-diam tidak melakukan apa pun.
let wss = null;
const clients = new Set(); // { ws, user, viewing: conversationId|null, typing: bool, at }
const INBOX_PERMS = ['billing', 'support', 'customers', 'settings'];

function canUseInbox(req) {
  const perms = req.permissions || [];
  return !!req.session?.user && INBOX_PERMS.some(p => perms.includes(p));
}

function send(ws, type, data) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type, data })); } catch (_) { /* socket closing */ } }
}

function emit(type, data, { exceptUserId = null } = {}) {
  for (const c of clients) { if (exceptUserId && c.user.id === exceptUserId) continue; send(c.ws, type, data); }
}

// Collision detection: siapa saja (selain diri sendiri) yang sedang membuka / mengetik di percakapan.
function presenceFor(conversationId) {
  const list = [];
  for (const c of clients) if (c.viewing === conversationId) list.push({ userId: c.user.id, name: c.user.name, typing: !!c.typing && Date.now() - c.typingAt < 6000 });
  const uniq = new Map(); for (const p of list) { const prev = uniq.get(p.userId); uniq.set(p.userId, { ...p, typing: p.typing || !!prev?.typing }); }
  return [...uniq.values()];
}
function broadcastPresence(conversationId) {
  if (!conversationId) return;
  emit('presence', { conversationId, viewers: presenceFor(conversationId) });
}

function attach(server, sessionMiddleware, loadPermissions) {
  let WebSocketServer;
  try { ({ WebSocketServer } = require('ws')); }
  catch (e) { console.error('WA Inbox realtime nonaktif: paket "ws" belum terpasang (jalankan npm install).'); return null; }
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/wa-inbox')) return; // biarkan upgrade lain (bila ada)
    const res = { getHeader() {}, setHeader() {}, end() {}, locals: {} };
    sessionMiddleware(req, res, () => {
      const done = () => {
        if (!canUseInbox(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      };
      if (loadPermissions) loadPermissions(req, res, done); else done();
    });
  });
  wss.on('connection', (ws, req) => {
    const u = req.session.user;
    const client = { ws, user: { id: u.id, name: u.name || u.username || 'Admin' }, viewing: null, typing: false, typingAt: 0, alive: true };
    clients.add(client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(String(raw)); } catch (_) { return; }
      if (msg.type === 'view') {
        const prev = client.viewing; client.viewing = Number(msg.conversationId) || null; client.typing = false;
        if (prev && prev !== client.viewing) broadcastPresence(prev);
        broadcastPresence(client.viewing);
      } else if (msg.type === 'typing') {
        client.typing = !!msg.typing; client.typingAt = Date.now();
        broadcastPresence(client.viewing);
      }
    });
    ws.on('close', () => { clients.delete(client); broadcastPresence(client.viewing); });
    send(ws, 'hello', { userId: client.user.id });
  });
  const beat = setInterval(() => {
    for (const c of clients) { if (!c.alive) { try { c.ws.terminate(); } catch (_) {} clients.delete(c); continue; } c.alive = false; try { c.ws.ping(); } catch (_) {} }
  }, 30000);
  if (beat.unref) beat.unref();
  console.log('WA Inbox realtime (WebSocket) aktif di /ws/wa-inbox');
  return wss;
}

module.exports = { attach, emit, presenceFor, isActive: () => !!wss };
