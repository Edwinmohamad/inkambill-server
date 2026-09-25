// Dynamic WAHA HTTP client. Configuration is loaded from Settings so WAHA can
// live in a different CasaOS/Proxmox CT; environment variables remain fallback.
const { getWahaConfig } = require('./wahaConfigService');

function headers(config) {
  const result = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (config.apiKey) result['X-Api-Key'] = config.apiKey;
  return result;
}

async function request(method, path, body, suppliedConfig = null, { timeoutMs = 15000 } = {}) {
  const config = suppliedConfig || await getWahaConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, { method, headers: headers(config), body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
  } catch (error) {
    // Network-level failure: the request never got a response. `transient` tells callers it is safe
    // to retry later; `timeout` means WAHA MAY have processed it (important for sendText duplicates).
    const wrapped = error.name === 'AbortError'
      ? new Error(`WAHA tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik (${config.baseUrl}).`)
      : new Error(`WAHA tidak dapat dijangkau di ${config.baseUrl}: ${error.message}`);
    wrapped.transient = true;
    wrapped.timeout = error.name === 'AbortError';
    throw wrapped;
  } finally { clearTimeout(timeout); }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const detail = data?.message || data?.error || (typeof data === 'string' ? data : '') || `HTTP ${response.status}`;
    const error = new Error(`WAHA ${response.status}: ${detail}`);
    error.status = response.status; error.body = data;
    // 5xx / 502-504 from a reverse proxy, 409/422 "session not ready/STARTING" → retryable later.
    error.transient = response.status >= 500 || response.status === 409 || response.status === 422 || response.status === 429;
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

function buildSessionConfig(config, webhookCallbackUrl) {
  const webhooks = [
    ...(webhookCallbackUrl ? [{ url: webhookCallbackUrl, events: ['session.status', 'message', 'message.ack'] }] : []),
    ...config.extraWebhookUrls.map(url => ({ url, events: ['message'] }))
  ];
  return webhooks.length ? { webhooks } : undefined;
}

// Starts (or resumes) the WAHA session WITHOUT ever restarting a session that is already alive.
// Bug lama: `/start` selalu dipanggil walau sesi sudah WORKING — WAHA menolak (422) sehingga app
// menandai gateway "disconnected", dan pada versi WAHA tertentu sesi justru di-restart (putus sesaat).
async function startSession(webhookCallbackUrl) {
  const config = await getWahaConfig({ fresh: true });
  const name = encodeURIComponent(config.sessionName);
  const sessionConfig = buildSessionConfig(config, webhookCallbackUrl);
  const existing = await getSession(config);
  if (!existing) return request('POST', '/api/sessions', { name: config.sessionName, start: true, config: sessionConfig }, config, { timeoutMs: 30000 });

  const status = String(existing.status || '').toUpperCase();
  if (['WORKING', 'STARTING', 'SCAN_QR_CODE'].includes(status)) return existing; // sudah hidup — jangan diganggu

  // STOPPED / FAILED: perbarui daftar webhook selagi sesi mati (PUT pada sesi yang berjalan akan
  // me-restart sesi, makanya hanya dilakukan di sini), lalu nyalakan lagi.
  if (sessionConfig) {
    try { await request('PUT', `/api/sessions/${name}`, { name: config.sessionName, config: sessionConfig }, config); }
    catch (error) { if (error.transient) throw error; /* versi WAHA lama tanpa PUT — lanjut start saja */ }
  }
  if (status === 'FAILED') {
    try { return await request('POST', `/api/sessions/${name}/restart`, undefined, config, { timeoutMs: 30000 }); }
    catch (error) {
      if (error.transient && !error.status) throw error;
      try { await request('POST', `/api/sessions/${name}/stop`, undefined, config); } catch (_) { /* sudah berhenti */ }
    }
  }
  try { return await request('POST', `/api/sessions/${name}/start`, undefined, config, { timeoutMs: 30000 }); }
  catch (error) {
    // "already started" race: sesi keburu dinyalakan oleh WAHA sendiri — anggap sukses.
    if (error.status === 422 || error.status === 409) return getSession(config);
    throw error;
  }
}

async function stopAndLogoutSession() {
  const config = await getWahaConfig();
  const name = encodeURIComponent(config.sessionName);
  try { await request('POST', `/api/sessions/${name}/logout`, undefined, config); }
  catch (_) { try { await request('POST', `/api/sessions/${name}/stop`, undefined, config); } catch (_) { /* already stopped */ } }
  // Hapus sesi dari WAHA agar watchdog auto-reconnect tidak menyalakannya lagi setelah logout sengaja.
  try { await request('DELETE', `/api/sessions/${name}`, undefined, config); } catch (_) { /* versi lama / sudah terhapus */ }
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
  return request('POST', '/api/sendText', { session: config.sessionName, chatId: `${phone}@c.us`, text }, config, { timeoutMs: 30000 });
}
async function sendToChat(chatId, text, replyTo = null) {
  const config = await getWahaConfig();
  const body = { session: config.sessionName, chatId, text };
  if (replyTo) body.reply_to = replyTo;
  return request('POST', '/api/sendText', body, config, { timeoutMs: 30000 });
}
async function resolveLidToPhone(lid) {
  const config = await getWahaConfig();
  try {
    const data = await request('GET', `/api/${encodeURIComponent(config.sessionName)}/lids/${encodeURIComponent(lid)}`, undefined, config);
    const pn = data?.pn || data?.phoneNumber || null;
    return pn ? String(pn).split('@')[0].replace(/\D/g, '') || null : null;
  } catch (_) { return null; }
}

// ---- Simulasi perilaku manusia & media (dipakai engine anti-ban dan Web Inbox) ------------------
async function startTyping(chatId) {
  const config = await getWahaConfig();
  return request('POST', '/api/startTyping', { session: config.sessionName, chatId }, config, { timeoutMs: 8000 });
}
async function stopTyping(chatId) {
  const config = await getWahaConfig();
  return request('POST', '/api/stopTyping', { session: config.sessionName, chatId }, config, { timeoutMs: 8000 });
}
// Tandai chat sudah dibaca (centang biru) sebelum membalas.
async function sendSeen(chatId, messageIds = null) {
  const config = await getWahaConfig();
  const body = { session: config.sessionName, chatId };
  if (messageIds && messageIds.length) body.messageIds = messageIds;
  return request('POST', '/api/sendSeen', body, config, { timeoutMs: 8000 });
}
// Kirim gambar/dokumen (base64). Catatan: di WAHA Core sebagian engine hanya mendukung sendText;
// sendImage/sendFile tersedia di WAHA Plus — error dari WAHA diteruskan apa adanya ke log.
async function sendMedia(chatId, { buffer, mimetype, filename, caption = '' }) {
  const config = await getWahaConfig();
  const isImage = /^image\/(jpeg|png|webp)$/.test(String(mimetype || ''));
  const body = { session: config.sessionName, chatId, caption, file: { mimetype, filename: filename || 'lampiran', data: Buffer.from(buffer).toString('base64') } };
  return request('POST', isImage ? '/api/sendImage' : '/api/sendFile', body, config, { timeoutMs: 60000 });
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

module.exports = { request, testConnection, getSession, startSession, stopAndLogoutSession, getQrDataUrl, sendText, sendToChat, resolveLidToPhone, downloadMedia, startTyping, stopTyping, sendSeen, sendMedia };
