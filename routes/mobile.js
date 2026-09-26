const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const router = express.Router();
const clean = (value, max) => String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const safeHttpsUrl = value => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
};

router.get('/api/mobile/version', (req, res) => {
  const productionDownload = req.hostname === 'inkambill.edwinpxmx.my.id'
    ? 'https://inkambill.edwinpxmx.my.id/api/mobile/download' : '';
  const releaseDirectory = path.dirname(path.resolve(process.env.MOBILE_ANDROID_APK_PATH || path.join(__dirname, '../storage/mobile-releases/INKAMNET-GO.apk')));
  let releaseMeta = {};
  try { releaseMeta = JSON.parse(fs.readFileSync(path.join(releaseDirectory, 'version.json'), 'utf8')); }
  catch { releaseMeta = {}; }
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    app: 'INKAMNET GO',
    packageName: 'id.my.edwinpxmx.inkamnetgo',
    versionCode: positiveInt(releaseMeta.versionCode, positiveInt(process.env.MOBILE_ANDROID_VERSION_CODE, 7)),
    versionName: clean(releaseMeta.versionName || process.env.MOBILE_ANDROID_VERSION_NAME || '1.3.2', 40),
    apkUrl: safeHttpsUrl(process.env.MOBILE_ANDROID_APK_URL) || productionDownload,
    forceUpdate: String(process.env.MOBILE_ANDROID_FORCE_UPDATE || '').toLowerCase() === 'true'
  });
});

router.get('/api/mobile/download', (req, res) => {
  const configured = String(process.env.MOBILE_ANDROID_APK_PATH || '').trim();
  const apkPath = configured
    ? path.resolve(configured)
    : path.join(__dirname, '../storage/mobile-releases/INKAMNET-GO.apk');
  try {
    if (!fs.statSync(apkPath).isFile()) throw new Error('not-file');
  } catch { return res.status(404).json({ok:false,error:'APK terbaru belum tersedia.'}); }
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  return res.download(apkPath, 'INKAMNET-GO.apk');
});

router.get('/.well-known/assetlinks.json', (req, res) => {
  const fingerprint = String(process.env.MOBILE_ANDROID_CERT_SHA256 || '')
    .replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  res.set('Cache-Control', 'public, max-age=3600');
  if (fingerprint.length !== 64) return res.json([]);
  const formatted = fingerprint.match(/.{2}/g).join(':');
  return res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'id.my.edwinpxmx.inkamnetgo',
      sha256_cert_fingerprints: [formatted]
    }
  }]);
});

router.get('/api/mobile/session', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    authenticated: !!req.session?.user,
    user: req.session?.user ? {
      id: Number(req.session.user.id),
      name: clean(req.session.user.name, 120),
      role: clean(req.session.user.role, 40)
    } : null
  });
});

router.post('/api/mobile/crash', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ok:false,error:'Sesi login tidak aktif.'});
  if (req.get('x-inkamnet-go') !== '1' || !req.is('application/json')) {
    return res.status(400).json({ok:false,error:'Permintaan aplikasi tidak valid.'});
  }
  const body = req.body || {};
  const occurred = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(body.occurredAt || ''))
    ? new Date(body.occurredAt) : null;
  await db.execute(`INSERT INTO mobile_crash_reports
    (user_id,app_version,android_version,device_model,exception_class,message,stack_trace,occurred_at)
    VALUES(?,?,?,?,?,?,?,?)`, [
      Number(req.session.user.id), clean(body.appVersion,40), clean(body.androidVersion,40),
      clean(body.deviceModel,160), clean(body.exceptionClass,240), clean(body.message,1000),
      clean(body.stackTrace,12000), occurred && !Number.isNaN(occurred.getTime()) ? occurred : null
    ]);
  res.status(201).json({ok:true});
});

router.post('/api/mobile/push-token', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ok:false,error:'Sesi login tidak aktif.'});
  if (req.get('x-inkamnet-go') !== '1' || !req.is('application/json')) {
    return res.status(400).json({ok:false,error:'Permintaan aplikasi tidak valid.'});
  }
  const token = clean(req.body?.token, 500);
  if (token.length < 40) return res.status(400).json({ok:false,error:'Push token tidak valid.'});
  await db.execute(`INSERT INTO mobile_push_tokens(user_id,token,device_model,app_version,is_active,last_seen_at)
    VALUES(?,?,?,?,1,NOW()) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),device_model=VALUES(device_model),
    app_version=VALUES(app_version),is_active=1,last_seen_at=NOW()`, [
      Number(req.session.user.id), token, clean(req.body?.deviceModel,160), clean(req.body?.appVersion,40)
    ]);
  // Remember which device token belongs to this login so logout can stop pushes to it.
  req.session.mobilePushToken = token;
  res.json({ok:true});
});

module.exports = router;
