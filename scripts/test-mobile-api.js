const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const route = read('routes/mobile.js');
const schema = read('services/schemaService.js');
const push = read('services/mobilePushService.js');
const app = read('app.js');
const env = read('.env.example');

assert(route.includes("router.get('/api/mobile/version'"));
assert(route.includes("router.get('/api/mobile/download'"));
assert(route.includes("router.get('/.well-known/assetlinks.json'"));
assert(route.includes("router.get('/api/mobile/session'"));
assert(route.includes("router.post('/api/mobile/crash'"));
assert(route.includes("router.post('/api/mobile/push-token'"));
assert(route.includes("url.protocol === 'https:'"));
assert(schema.includes('CREATE TABLE IF NOT EXISTS mobile_crash_reports'));
assert(schema.includes('CREATE TABLE IF NOT EXISTS mobile_push_tokens'));
assert(schema.includes('CREATE TABLE IF NOT EXISTS mobile_push_deliveries'));
assert(schema.includes('async function ensureV39Schema()'));
assert(app.includes('await ensureV39Schema()'));
assert(app.includes('deliverMobilePushes'));
assert(push.includes("scope: 'https://www.googleapis.com/auth/firebase.messaging'"));
assert(push.includes('fcm.googleapis.com/v1/projects/'));
assert(push.includes("if (!firebase) return { configured:false, sent:0, failed:0 }"));
assert(env.includes('MOBILE_ANDROID_VERSION_CODE=2'));
assert(env.includes('FIREBASE_SERVICE_ACCOUNT_JSON='));

console.log('Mobile API validation passed: update, App Links, crash, token registry, FCM delivery and safe fallback markers.');
