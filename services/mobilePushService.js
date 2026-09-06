const crypto = require('crypto');
const https = require('https');
const db = require('../config/db');

let cachedToken = null;
let cachedTokenUntil = 0;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function config() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  let account;
  try { account = JSON.parse(raw); }
  catch {
    try { account = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { return null; }
  }
  const projectId = String(process.env.FIREBASE_PROJECT_ID || account.project_id || '').trim();
  if (!projectId || !account.client_email || !account.private_key) return null;
  return { projectId, clientEmail: account.client_email, privateKey: account.private_key };
}

function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') return reject(new Error('Mobile push hanya mengizinkan HTTPS.'));
    const req = https.request(target, { method, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (data.length < 128000) data += chunk; });
      res.on('end', () => resolve({ status: Number(res.statusCode || 0), body: data }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Firebase request timeout.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function accessToken(firebase) {
  if (cachedToken && Date.now() < cachedTokenUntil) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: firebase.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), firebase.privateKey).toString('base64url');
  const assertion = `${unsigned}.${signature}`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion
  }).toString();
  const response = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)},
    body
  });
  if (response.status !== 200) throw new Error(`Firebase OAuth gagal (${response.status}).`);
  const payload = JSON.parse(response.body);
  if (!payload.access_token) throw new Error('Firebase OAuth tidak mengembalikan access token.');
  cachedToken = payload.access_token;
  cachedTokenUntil = Date.now() + Math.max(60, Number(payload.expires_in || 3600) - 180) * 1000;
  return cachedToken;
}

async function send(firebase, access, row) {
  const href = String(row.href || '/').startsWith('/') ? String(row.href || '/') : '/';
  const payload = JSON.stringify({message:{
    token: row.token,
    data: {
      title:String(row.title || 'INKAMNET GO').slice(0,120),
      detail:String(row.detail || 'Ada pembaruan operasional.').slice(0,500),
      href,
      notificationId:String(row.notification_id)
    },
    android: {priority:'high'}
  }});
  return request(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(firebase.projectId)}/messages:send`, {
    method: 'POST',
    headers: {Authorization:`Bearer ${access}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},
    body: payload
  });
}

async function deliverMobilePushes() {
  const firebase = config();
  if (!firebase) return { configured:false, sent:0, failed:0 };
  const access = await accessToken(firebase);
  const [rows] = await db.query(`SELECT n.id notification_id,n.title,n.detail,n.href,t.id token_id,t.token,
    COALESCE(d.attempt_count,0) attempt_count
    FROM system_notifications n
    JOIN mobile_push_tokens t ON t.user_id=n.recipient_id AND t.is_active=1
    LEFT JOIN mobile_push_deliveries d ON d.notification_id=n.id AND d.token_id=t.id
    WHERE n.read_at IS NULL AND n.created_at>=DATE_SUB(NOW(),INTERVAL 7 DAY)
      AND (d.id IS NULL OR (d.status='failed' AND d.attempt_count<3 AND d.updated_at<DATE_SUB(NOW(),INTERVAL 10 MINUTE)))
    ORDER BY n.created_at,n.id LIMIT 50`);
  let sent = 0, failed = 0;
  for (const row of rows) {
    try {
      const response = await send(firebase, access, row);
      const ok = response.status >= 200 && response.status < 300;
      await db.execute(`INSERT INTO mobile_push_deliveries(notification_id,token_id,status,attempt_count,response_code,error_message,sent_at)
        VALUES(?,?,?,1,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),attempt_count=attempt_count+1,
        response_code=VALUES(response_code),error_message=VALUES(error_message),sent_at=VALUES(sent_at),updated_at=NOW()`, [
          row.notification_id,row.token_id,ok?'sent':'failed',response.status,ok?null:String(response.body||'').slice(0,1000),ok?new Date():null
        ]);
      if (ok) sent++;
      else {
        failed++;
        if (/UNREGISTERED|registration-token-not-registered/i.test(response.body || '')) {
          await db.execute(`UPDATE mobile_push_tokens SET is_active=0 WHERE id=?`, [row.token_id]);
        }
      }
    } catch (err) {
      failed++;
      await db.execute(`INSERT INTO mobile_push_deliveries(notification_id,token_id,status,attempt_count,error_message)
        VALUES(?,?,'failed',1,?) ON DUPLICATE KEY UPDATE status='failed',attempt_count=attempt_count+1,
        error_message=VALUES(error_message),updated_at=NOW()`, [row.notification_id,row.token_id,String(err.message||err).slice(0,1000)]);
    }
  }
  return { configured:true, sent, failed };
}

module.exports = { deliverMobilePushes };
