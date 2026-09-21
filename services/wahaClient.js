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
async function startSession(webhookCallbackUrl) {
  const config = webhookCallbackUrl ? {
    webhooks: [{ url: webhookCallbackUrl, events: ['session.status', 'message'] }],
  } : undefined;
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

module.exports = { SESSION, getSession, startSession, stopAndLogoutSession, getQrDataUrl, sendText };
