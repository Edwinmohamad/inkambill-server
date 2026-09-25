// Uji auto-reconnect WA Gateway dengan WAHA & DB palsu: node scripts/test-wa-gateway-reconnect.js
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
function mock(rel, exports) { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; }

let session = { status: 'WORKING', me: { id: '6281111111111@c.us' } };
let reachable = true;
const calls = [];
const queue = [];
const fakeWaha = {
  async getSession() { calls.push('get'); if (!reachable) { const e = new Error('ECONNREFUSED'); e.transient = true; throw e; } return session; },
  async startSession() { calls.push('start'); if (session && session.status !== 'WORKING') session = { status: 'WORKING', me: { id: '6281111111111@c.us' } }; return session; },
  async stopAndLogoutSession() { calls.push('logout'); session = null; },
  async getQrDataUrl() { return 'data:image/png;base64,AA'; },
  async request(m, p) { calls.push(`${m} ${p}`); },
  async sendText() { const e = new Error('WAHA 422: session STARTING'); e.status = 422; e.transient = true; throw e; },
};
const fakeDb = {
  async query(sql) { if (/wa_blast_enabled/.test(sql)) return [[{ wa_blast_enabled: 0 }]]; return [[]]; },
  async execute(sql, params) {
    if (/SELECT \* FROM wa_messages/.test(sql)) return [[queue.find(r => r.status === 'queued' && !r.hold)]];
    if (/UPDATE wa_messages SET status='queued',attempts=/.test(sql)) { const id = params[params.length - 1]; const r = queue.find(x => x.id === id); Object.assign(r, { status: 'queued', attempts: params[0], hold: true, error: params[params.length - 2] }); }
    if (/UPDATE wa_messages SET status='failed'/.test(sql)) { const r = queue.find(x => x.id === params[2]); Object.assign(r, { status: 'failed' }); }
    return [{ affectedRows: 1 }];
  },
};
mock('config/db.js', fakeDb);
mock('services/wahaClient.js', fakeWaha);
mock('services/wahaConfigService.js', { async getWahaConfig() { return { sessionName: 'default', extraWebhookUrls: [] }; }, callbackUrl() { return 'http://app/api/waha/webhook?token=x'; } });
mock('services/whatsappService.js', { validateWhatsapp: () => ({ valid: true, normalized: '6281' }) });
const gw = require(path.join(root, 'services/whatsappGatewayService'));

(async () => {
  // 1. Boot saat WORKING: tidak boleh memanggil start (bug lama: /start ke sesi hidup → disconnected).
  await gw.initGatewayOnBoot();
  assert.equal(gw.getGatewayStatus().state, 'connected');
  assert(!calls.includes('start'), 'sesi WORKING tidak boleh di-start ulang');

  // 2. WAHA restart → sesi STOPPED: watchdog menyalakan ulang otomatis.
  session = { status: 'STOPPED' };
  await gw.ensureGatewayAlive();
  assert(calls.includes('start'), 'watchdog harus auto-start sesi STOPPED');
  assert.equal(gw.getGatewayStatus().state, 'connected');

  // 3. Webhook dari sesi LAIN tidak boleh memutus status gateway.
  await gw.handleWahaWebhookEvent({ event: 'session.status', session: 'lain', payload: { status: 'STOPPED' } });
  assert.equal(gw.getGatewayStatus().state, 'connected');

  // 4. WAHA tidak terjangkau 3x → status jujur 'disconnected', lalu pulih sendiri.
  reachable = false;
  for (let i = 0; i < 3; i++) await gw.reconcileGatewayStatus();
  assert.equal(gw.getGatewayStatus().state, 'disconnected');
  reachable = true;
  await gw.ensureGatewayAlive();
  assert.equal(gw.getGatewayStatus().state, 'connected');

  // 5. Sesi belum siap saat kirim → pesan kembali ke antrean (bukan 'failed' permanen) dan antrean
  //    auto-pause 'disconnected' (lanjut otomatis saat gateway terhubung lagi).
  queue.push({ id: 1, phone: '6281', message: 'x', status: 'queued', attempts: 0 });
  await gw.processQueue();
  for (let i = 0; i < 100 && queue[0].attempts !== 1; i++) await new Promise(r => setTimeout(r, 20)); // worker lain mungkin sedang berjalan
  assert.equal(queue[0].status, 'queued'); assert.equal(queue[0].attempts, 1);
  const antiBan = require(path.join(root, 'services/waAntiBanService'));
  assert.equal(antiBan.getPauseState().kind, 'disconnected');
  await antiBan.resumeQueue('test');

  // 6. Logout sengaja → watchdog TIDAK auto-reconnect.
  await gw.logoutGateway();
  const before = calls.filter(c => c === 'start').length;
  session = { status: 'STOPPED' };
  await gw.ensureGatewayAlive();
  assert.equal(calls.filter(c => c === 'start').length, before, 'tidak boleh reconnect setelah logout manual');

  // 7. Connect manual oleh Admin membuka kembali auto-reconnect.
  await gw.startGateway({ manual: true });
  assert.equal(gw.getGatewayStatus().state, 'connected');
  console.log('OK — semua skenario auto-reconnect WA Gateway lolos.');
  process.exit(0);
})().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
