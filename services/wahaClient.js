// Dynamic WAHA HTTP client. Configuration is loaded from Settings so WAHA can
// live in a different CasaOS/Proxmox CT; environment variables remain fallback.
const { getWahaConfig } = require('./wahaConfigService');

function headers(config) {
  const result = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (config.apiKey) result['X-Api-Key'] = config.apiKey;
  return result;
}

async function request(method, path, body, suppliedConfig = null) {
  const config = suppliedConfig || await getWahaConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, { method, headers: headers(config), body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`WAHA tidak merespons dalam 15 detik (${config.baseUrl}).`);
    throw new Error(`WAHA tidak dapat dijangkau di ${config.baseUrl}: ${error.message}`);
  } finally { clearTimeout(timeout); }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const detail = data?.message || data?.error || (typeof data === 'string' ? data : '') || `HTTP ${response.status}`;
    const error = new Error(`WAHA ${response.status}: ${detail}`);
    error.status = response.status; error.body = data;
    throw error;
  }
  return data;
}

async function testConnection() {
  const config = await getWahaConfig({ fresh: true });
  let server = null;
  try { server = await request('GET', '/api/server/status', undefined, config); }
  catch (error) {
    if (error.status !== 404) throw error;
    server = await request('GET', '/api/sessions', undefined, config);
  }
  return { ok: true, baseUrl: config.baseUrl, sessionName: config.sessionName, server };
}

async function getSession(config = null) {
  config = config || await getWahaConfig();
  try { return await request('GET', `/api/sessions/${encodeURIComponent(config.sessionName)}`, undefined, config); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

async function startSession(webhookCallbackUrl) {
  const config = await getWahaConfig({ fresh: true });
  const webhooks = [
    ...(webhookCallbackUrl ? [{ url: webhookCallbackUrl, events: ['session.status', 'message'] }] : []),
    ...config.extraWebhookUrls.map(url => ({ url, events: ['message'] }))
  ];
  const sessionConfig = webhooks.length ? { webhooks } : undefined;
  const existing = await getSession(config);
  if (existing) return request('POST', `/api/sessions/${encodeURIComponent(config.sessionName)}/start`, sessionConfig ? { config: sessionConfig } : undefined, config);
  return request('POST', '/api/sessions', { name: config.sessionName, start: true, config: sessionConfig }, config);
}

async function stopAndLogoutSession() {
  const config = await getWahaConfig();
  const name = encodeURIComponent(config.sessionName);
  try { await request('POST', `/api/sessions/${name}/logout`, undefined, config); }
  catch (_) { try { await request('POST', `/api/sessions/${name}/stop`, undefined, config); } catch (_) { /* already stopped */ } }
}

async function getQrDataUrl() {
  const config = await getWahaConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try { response = await fetch(`${config.baseUrl}/api/${encodeURIComponent(config.sessionName)}/auth/qr`, { headers: headers(config), signal: controller.signal }); }
  catch (error) { throw new Error(`QR WAHA tidak dapat diambil: ${error.name === 'AbortError' ? 'timeout' : error.message}`); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`WAHA QR fetch -> HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('image/')) return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  const data = await response.json();
  const raw = data?.value || data?.qr || data?.data || null;
  if (!raw) throw new Error('Format QR dari WAHA tidak dikenali.');
  return String(raw).startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
}

async function sendText(phone, text) {
  const config = await getWahaConfig();
  return request('POST', '/api/sendText', { session: config.sessionName, chatId: `${phone}@c.us`, text }, config);
}
async function sendToChat(chatId, text, replyTo = null) {
  const config = await getWahaConfig();
  const body = { session: config.sessionName, chatId, text };
  if (replyTo) body.reply_to = replyTo;
  return request('POST', '/api/sendText', body, config);
}
async function resolveLidToPhone(lid) {
  const config = await getWahaConfig();
  try {
    const data = await request('GET', `/api/${encodeURIComponent(config.sessionName)}/lids/${encodeURIComponent(lid)}`, undefined, config);
    const pn = data?.pn || data?.phoneNumber || null;
    return pn ? String(pn).split('@')[0].replace(/\D/g, '') || null : null;
  } catch (_) { return null; }
}

const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
async function downloadMedia(mediaUrl) {
  const config = await getWahaConfig();
  let target;
  try { const url = new URL(mediaUrl, config.baseUrl); target = `${config.baseUrl}${url.pathname}${url.search}`; }
  catch (_) { throw new Error('URL media WAHA tidak valid.'); }
  const response = await fetch(target, { headers: config.apiKey ? { 'X-Api-Key': config.apiKey } : {} });
  if (!response.ok) throw new Error(`Download media WAHA -> HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Foto lebih dari 6 MB.');
  return { buffer, mimetype: String(response.headers.get('content-type') || '').split(';')[0].trim() };
}

module.exports = { request, testConnection, getSession, startSession, stopAndLogoutSession, getQrDataUrl, sendText, sendToChat, resolveLidToPhone, downloadMedia };
