// Thin HTTP client for WAHA (WhatsApp HTTP API) — https://waha.devlike.pro
//
// WAHA runs as its own process on this same server (confirmed: listening on localhost:3000).
// This client talks to it over that local address, NOT through the public Cloudflare tunnel —
// the tunnel is only meant for reaching WAHA's own dashboard/Swagger UI from outside when you
// need to poke at it manually. Routing every send/status call through the internet would be
// slower and would make billing reminders depend on Cloudflare + your internet link being up.
//
// If this app is itself deployed via docker-compose (see docker-compose.yml) and WAHA runs
// directly on the host (not inside that same compose project), "localhost" inside the app
// container does NOT reach the host — use host.docker.internal instead (the compose file below
// already adds the extra_hosts entry needed for that to resolve). See WAHA_BASE_URL in
// .env.example for the exact options.
//
// IMPORTANT: WAHA's exact REST paths have shifted a little across versions/editions (Core vs
// Plus). The paths below match the commonly documented WAHA API. Before relying on this in
// production, open your WAHA base URL in a browser (WAHA serves its own Swagger UI there) and
// confirm these paths match your installed version — adjust the constants/paths below if not.
const BASE_URL = String(process.env.WAHA_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const API_KEY = process.env.WAHA_API_KEY || '';
const SESSION = process.env.WAHA_SESSION_NAME || 'default';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return h;
}

async function request(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = (data && data.message) || (typeof data === 'string' && data) || `WAHA ${method} ${path} -> HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// --- Sessions -------------------------------------------------------------

// Returns the current session object from WAHA, or null if this session name has never been
// created there (WAHA answers 404 in that case).
async function getSession() {
  try {
    return await request('GET', `/api/sessions/${SESSION}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Creates (first time) or (re)starts the session, wiring up webhookCallbackUrl so WAHA pushes
// session.status / message events to this app instead of us having to poll it constantly. The
// callback URL is expected to already carry the shared verification token as a query string
// (see whatsappGatewayService.js) since not every WAHA version/config supports custom headers
// on outgoing webhooks, but query strings always work.
// WAHA_EXTRA_WEBHOOK_URLS (comma-separated) — e.g. the n8n webhook of the WA ticket bot
// (n8n/06-wa-ticket-bot.json). Session config here REPLACES the session's webhook list on WAHA, so
// any other consumer of incoming messages must be listed here or it silently stops receiving them
// every time this app restarts the session.
function extraWebhooks() {
  return String(process.env.WAHA_EXTRA_WEBHOOK_URLS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(url => ({ url, events: ['message'] }));
}

async function startSession(webhookCallbackUrl) {
  const webhooks = [
    ...(webhookCallbackUrl ? [{ url: webhookCallbackUrl, events: ['session.status', 'message'] }] : []),
    ...extraWebhooks(),
  ];
  const config = webhooks.length ? { webhooks } : undefined;
  const existing = await getSession();
  if (existing) {
    return request('POST', `/api/sessions/${SESSION}/start`, config ? { config } : undefined);
  }
  return request('POST', '/api/sessions', { name: SESSION, start: true, config });
}

// Logs the session out (clears WAHA's own saved auth for it) so the next Connect always shows a
// fresh QR. Falls back to a plain stop if this WAHA version rejects logout on an already-stopped
// session — either way we don't want a failure here to block the UI from showing "disconnected".
async function stopAndLogoutSession() {
  try {
    await request('POST', `/api/sessions/${SESSION}/logout`);
  } catch (e) {
    try { await request('POST', `/api/sessions/${SESSION}/stop`); } catch (e2) { /* ignore — already stopped */ }
  }
}

// Returns a ready-to-use `data:image/...;base64,...` string, regardless of whether this WAHA
// version answers the QR endpoint with a raw PNG or a JSON body carrying a base64 string.
async function getQrDataUrl() {
  const res = await fetch(`${BASE_URL}/api/${SESSION}/auth/qr`, { headers: headers() });
  if (!res.ok) throw new Error(`WAHA QR fetch -> HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buf.toString('base64')}`;
  }
  const data = await res.json();
  const raw = data?.value || data?.qr || data?.data || null;
  if (!raw) throw new Error('WAHA QR response tidak dikenali — cek Swagger UI WAHA untuk format QR versi Anda dan sesuaikan getQrDataUrl().');
  return String(raw).startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
}

// --- Messages ---------------------------------------------------------------

async function sendText(phone, text) {
  return request('POST', '/api/sendText', { session: SESSION, chatId: `${phone}@c.us`, text });
}

// Sends to any chat id as-is: personal "628xx@c.us" or group "1203xxxx@g.us". Optional replyTo quotes
// the original message (WAHA "reply_to" = message id from the incoming webhook payload).
async function sendToChat(chatId, text, replyTo = null) {
  const body = { session: SESSION, chatId, text };
  if (replyTo) body.reply_to = replyTo;
  return request('POST', '/api/sendText', body);
}

// WhatsApp increasingly reports senders (esp. group participants) as "<id>@lid" instead of a phone
// number. WAHA exposes GET /api/{session}/lids/{lid} -> { lid, pn: "628xx@c.us" } to map it back.
// Returns digits only, or null if WAHA can't resolve it (older WAHA versions lack this endpoint).
async function resolveLidToPhone(lid) {
  try {
    const data = await request('GET', `/api/${SESSION}/lids/${encodeURIComponent(lid)}`);
    const pn = data?.pn || data?.phoneNumber || null;
    return pn ? String(pn).split('@')[0].replace(/\D/g, '') || null : null;
  } catch (e) {
    return null;
  }
}

// Downloads media from an incoming message (payload.media.url). WAHA builds that URL from its own
// public base URL, which may not be reachable from this app (e.g. tunnel hostname) — so only the
// path is kept and re-pointed at WAHA_BASE_URL (local address), with the API key attached.
const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
async function downloadMedia(mediaUrl) {
  let target;
  try {
    const u = new URL(mediaUrl, BASE_URL);
    target = `${BASE_URL}${u.pathname}${u.search}`;
  } catch (e) {
    throw new Error('URL media WAHA tidak valid.');
  }
  const res = await fetch(target, { headers: API_KEY ? { 'X-Api-Key': API_KEY } : {} });
  if (!res.ok) throw new Error(`Download media WAHA -> HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Foto lebih dari 6 MB.');
  return { buffer, mimetype: String(res.headers.get('content-type') || '').split(';')[0].trim() };
}

module.exports = { SESSION, getSession, startSession, stopAndLogoutSession, getQrDataUrl, sendText, sendToChat, resolveLidToPhone, downloadMedia };
