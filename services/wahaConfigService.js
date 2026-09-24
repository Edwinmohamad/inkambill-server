const crypto = require('crypto');
const db = require('../config/db');
const { encrypt, decrypt } = require('./cryptoService');

let cache = null;
let cacheUntil = 0;

function cleanUrl(value, label, { optional = false } = {}) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw && optional) return '';
  if (!raw) throw new Error(`${label} wajib diisi.`);
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error(`${label} harus berupa URL http:// atau https:// yang valid.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} hanya boleh memakai http:// atau https://.`);
  if (parsed.username || parsed.password) throw new Error(`${label} tidak boleh memuat username/password di URL.`);
  return raw;
}

function safeDecrypt(value) {
  if (!value) return '';
  try { return decrypt(value); } catch (error) { console.error('Gagal membuka kredensial WAHA:', error.message); return ''; }
}

function envConfig() {
  return {
    baseUrl: String(process.env.WAHA_BASE_URL || 'http://localhost:3000').trim().replace(/\/+$/, ''),
    apiKey: String(process.env.WAHA_API_KEY || ''),
    sessionName: String(process.env.WAHA_SESSION_NAME || 'default').trim() || 'default',
    webhookToken: String(process.env.WAHA_WEBHOOK_TOKEN || '').trim(),
    callbackUrl: String(process.env.WAHA_WEBHOOK_CALLBACK_URL || '').trim().replace(/\/+$/, ''),
    extraWebhookUrls: String(process.env.WAHA_EXTRA_WEBHOOK_URLS || '').split(',').map(x => x.trim()).filter(Boolean),
    source: 'environment', lastTestAt: null, lastTestStatus: null, lastTestError: null
  };
}

async function getWahaConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() < cacheUntil) return cache;
  const fallback = envConfig();
  try {
    const [[row]] = await db.query(`SELECT wa_waha_base_url,wa_waha_api_key_enc,wa_waha_session_name,
      wa_waha_webhook_token_enc,wa_waha_callback_url,wa_waha_extra_webhook_urls,
      wa_waha_last_test_at,wa_waha_last_test_status,wa_waha_last_test_error FROM settings WHERE id=1 LIMIT 1`);
    cache = {
      baseUrl: String(row?.wa_waha_base_url || fallback.baseUrl).replace(/\/+$/, ''),
      apiKey: row?.wa_waha_api_key_enc ? safeDecrypt(row.wa_waha_api_key_enc) : fallback.apiKey,
      sessionName: String(row?.wa_waha_session_name || fallback.sessionName || 'default').trim(),
      webhookToken: row?.wa_waha_webhook_token_enc ? safeDecrypt(row.wa_waha_webhook_token_enc) : fallback.webhookToken,
      callbackUrl: String(row?.wa_waha_callback_url || fallback.callbackUrl).trim().replace(/\/+$/, ''),
      extraWebhookUrls: String(row?.wa_waha_extra_webhook_urls || fallback.extraWebhookUrls.join(',')).split(',').map(x => x.trim()).filter(Boolean),
      source: row?.wa_waha_base_url ? 'database' : fallback.source,
      lastTestAt: row?.wa_waha_last_test_at || null,
      lastTestStatus: row?.wa_waha_last_test_status || null,
      lastTestError: row?.wa_waha_last_test_error || null
    };
  } catch (error) {
    cache = fallback;
  }
  cacheUntil = Date.now() + 30000;
  return cache;
}

function callbackUrl(config) {
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const base = config.callbackUrl || (appUrl ? `${appUrl}/api/waha/webhook` : '');
  if (!base || !config.webhookToken) return null;
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(config.webhookToken)}`;
}

async function saveWahaConfig(input = {}) {
  const current = await getWahaConfig({ fresh: true });
  const baseUrl = cleanUrl(input.base_url, 'URL WAHA');
  const callback = cleanUrl(input.callback_url, 'URL callback', { optional: true });
  const sessionName = String(input.session_name || 'default').trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 120);
  if (!sessionName) throw new Error('Nama sesi WAHA tidak valid.');
  const extra = String(input.extra_webhook_urls || '').split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean).map(url => cleanUrl(url, 'URL webhook tambahan')).join(',');
  const apiKey = String(input.api_key || '').trim() || current.apiKey;
  const webhookToken = String(input.webhook_token || '').trim() || current.webhookToken || crypto.randomBytes(24).toString('hex');
  await db.execute(`UPDATE settings SET wa_waha_base_url=?,wa_waha_api_key_enc=?,wa_waha_session_name=?,
    wa_waha_webhook_token_enc=?,wa_waha_callback_url=?,wa_waha_extra_webhook_urls=? WHERE id=1`,
  [baseUrl, apiKey ? encrypt(apiKey) : null, sessionName, encrypt(webhookToken), callback || null, extra || null]);
  cache = null; cacheUntil = 0;
  return getWahaConfig({ fresh: true });
}

async function recordConnectionTest(status, error = null) {
  await db.execute(`UPDATE settings SET wa_waha_last_test_at=NOW(),wa_waha_last_test_status=?,wa_waha_last_test_error=? WHERE id=1`, [status, error ? String(error).slice(0, 1000) : null]);
  cache = null; cacheUntil = 0;
}

function publicConfig(config) {
  return {
    baseUrl: config.baseUrl, sessionName: config.sessionName, callbackUrl: config.callbackUrl,
    resolvedCallbackUrl: callbackUrl(config), extraWebhookUrls: config.extraWebhookUrls,
    hasApiKey: !!config.apiKey, hasWebhookToken: !!config.webhookToken, source: config.source,
    lastTestAt: config.lastTestAt, lastTestStatus: config.lastTestStatus, lastTestError: config.lastTestError
  };
}

module.exports = { getWahaConfig, saveWahaConfig, recordConnectionTest, callbackUrl, publicConfig };
