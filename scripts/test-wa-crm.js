// Uji WA CRM (template/Spintax, engine anti-ban, auto-pause, blacklist/opt-out, inbox) dengan DB & WAHA palsu.
// Jalankan: node scripts/test-wa-crm.js
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
function mock(rel, exports) { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; }

// ---------- DB palsu (hanya pola SQL yang dipakai modul yang diuji) ----------
const S = { settings: { wa_antiban_json: null, wa_queue_paused: 0 }, messages: [], blacklist: new Set(), notifications: [], convs: [], chats: [], customers: [{ id: 7, name: 'Budi', customer_code: 'C007', whatsapp_normalized: '6281234567890', phone: '081234567890', whatsapp_status: 'valid' }] };
let nextId = 1;
const fakeDb = {
  async query(sql, p = []) { return fakeDb.execute(sql, p); },
  async execute(sql, p = []) {
    const q = sql.replace(/\s+/g, ' ');
    if (/FROM settings/.test(q) && /wa_antiban_json/.test(q)) return [[S.settings]];
    if (/UPDATE settings SET wa_queue_paused=1/.test(q)) { Object.assign(S.settings, { wa_queue_paused: 1, wa_queue_paused_kind: p[0], wa_queue_paused_reason: p[1] }); return [{}]; }
    if (/UPDATE settings SET wa_queue_paused=0/.test(q)) { Object.assign(S.settings, { wa_queue_paused: 0, wa_queue_paused_kind: null }); return [{}]; }
    if (/FROM settings/.test(q)) return [[{ wa_blast_enabled: 1, wa_default_bank_id: null }]];
    if (/FROM banks/.test(q)) return [[{ id: 1, bank_name: 'BCA', account_number: '1234567890', account_name: 'PT INKAM' }]];
    if (/SELECT id FROM users/.test(q)) return [[{ id: 1 }]];
    if (/INSERT INTO system_notifications/.test(q)) { S.notifications.push(p); return [{}]; }
    if (/FROM wa_blacklist WHERE phone=/.test(q)) return [S.blacklist.has(p[0]) ? [{ phone: p[0] }] : []];
    if (/INSERT INTO wa_blacklist/.test(q)) { S.blacklist.add(p[0]); return [{}]; }
    if (/DELETE FROM wa_blacklist/.test(q)) { S.blacklist.delete(p[0]); return [{}]; }
    if (/SELECT COUNT\(\*\) n FROM wa_messages WHERE status='sent' AND sent_at/.test(q)) return [[{ n: S.messages.filter(m => m.status === 'sent' && m.bulk).length }]];
    if (/UPDATE wa_messages SET status='cancelled',error_message='Dibatalkan: nomor opt-out/.test(q) && /WHERE phone=/.test(q)) { S.messages.filter(m => m.phone === p[0] && m.status === 'queued' && m.bulk).forEach(m => { m.status = 'cancelled'; }); return [{}]; }
    if (/INSERT INTO wa_messages/.test(q)) {
      const cols = q.match(/wa_messages\(([^)]+)\)/)[1].split(',').map(s => s.trim());
      const vals = q.match(/VALUES\((.+)\)$/)[1].split(',').map(s => s.trim());
      const row = { id: nextId++, attempts: 0, next_attempt_at: null }; let pi = 0;
      cols.forEach((c, i) => { const v = vals[i]; row[c] = v === '?' ? p[pi++] : v.replace(/^'|'$/g, ''); });
      row.bulk = ['broadcast', 'blast', 'auto_reminder', 'isolation_notice', 'outage_notice'].includes(row.message_type);
      S.messages.push(row); return [{ insertId: row.id }];
    }
    if (/SELECT \* FROM wa_messages WHERE status='queued'/.test(q)) {
      const allowBulk = !/message_type NOT IN/.test(q);
      const rows = S.messages.filter(m => m.status === 'queued' && (allowBulk || !m.bulk)).sort((a, b) => (a.bulk - b.bulk) || a.id - b.id);
      return [[rows[0]]];
    }
    if (/UPDATE wa_messages SET status='processing' WHERE id=\? AND status='queued'/.test(q)) { const m = S.messages.find(x => x.id === p[0] && x.status === 'queued'); if (m) m.status = 'processing'; return [{ affectedRows: m ? 1 : 0 }]; }
    if (/UPDATE wa_messages SET status='sent'/.test(q)) { const m = S.messages.find(x => x.id === p[1]); m.status = 'sent'; return [{}]; }
    if (/UPDATE wa_messages SET status='queued',attempts=\?,error_message=/.test(q)) { const m = S.messages.find(x => x.id === p[2]); Object.assign(m, { status: 'queued', attempts: p[0], error_message: p[1] }); return [{}]; }
    if (/UPDATE wa_messages SET status='cancelled'/.test(q)) { const m = S.messages.find(x => x.id === p[0]); m.status = 'cancelled'; return [{}]; }
    if (/UPDATE wa_messages SET status='failed'/.test(q)) { const m = S.messages.find(x => x.id === p[2]); if (m) m.status = 'failed'; return [{ affectedRows: 0 }]; }
    // ---- inbox ----
    if (/FROM customers WHERE archived_at IS NULL AND whatsapp_normalized=/.test(q)) return [S.customers.filter(c => c.whatsapp_normalized === p[0])];
    if (/INSERT INTO wa_conversations/.test(q)) { if (!S.convs.find(c => c.chat_id === p[0])) S.convs.push({ id: S.convs.length + 1, chat_id: p[0], phone: p[1], customer_id: p[2], display_name: p[3], bot_enabled: 1, unread_count: 0, category: 'general' }); return [{}]; }
    if (/SELECT \* FROM wa_conversations WHERE chat_id=/.test(q)) return [[S.convs.find(c => c.chat_id === p[0])]];
    if (/FROM wa_conversations cv LEFT JOIN customers c ON c.id=cv.customer_id LEFT JOIN users u ON u.id=cv.assigned_user_id WHERE cv.id=/.test(q)) return [[S.convs.find(c => c.id === p[0])].filter(Boolean)];
    if (/INSERT IGNORE INTO wa_chat_messages/.test(q)) { if (p[2] && S.chats.find(c => c.wa_message_id === p[2])) return [{ insertId: 0 }]; const row = { id: S.chats.length + 1, conversation_id: p[0], direction: p[1], wa_message_id: p[2], body: p[3], ack: p[7], is_bot: p[9], created_at: new Date() }; S.chats.push(row); return [{ insertId: row.id }]; }
    if (/FROM wa_chat_messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.id=/.test(q)) return [[S.chats.find(c => c.id === p[0])]];
    if (/UPDATE wa_conversations SET last_message_at/.test(q)) { const c = S.convs.find(x => x.id === p[p.length - 1]); if (c) { c.last_message_preview = p[0]; if (/unread_count\+1/.test(q)) c.unread_count++; if (p.length === 4) c.category = c.category === 'general' ? p[2] : c.category; } return [{}]; }
    return [[]]; // default: query lain tidak relevan untuk uji ini
  },
};
mock('config/db.js', fakeDb);
const sent = [];
let failNext = null;
const fakeWaha = {
  async getSession() { return { status: 'WORKING', me: { id: '6280000@c.us' } }; },
  async startSession() { return {}; }, async getQrDataUrl() { return null; },
  async startTyping() { throw new Error('not supported'); }, async stopTyping() {}, async sendSeen() {},
  async sendText(phone, text) { if (failNext) { const e = failNext; failNext = null; throw e; } sent.push({ phone, text }); return { id: { _serialized: `true_${phone}@c.us_ABC${sent.length}` } }; },
  async resolveLidToPhone() { return null; }, async downloadMedia() { throw new Error('no media'); }, request: async () => ({}),
};
mock('services/wahaClient.js', fakeWaha);
mock('services/wahaConfigService.js', { async getWahaConfig() { return { sessionName: 'default', extraWebhookUrls: [] }; }, callbackUrl() { return null; } });

const tpl = require(path.join(root, 'services/waTemplateService'));
const antiBan = require(path.join(root, 'services/waAntiBanService'));
antiBan.randomMs = () => 1; // percepat jeda di uji (logika jeda tetap dijalankan)
const gw = require(path.join(root, 'services/whatsappGatewayService'));
const inbox = require(path.join(root, 'services/waInboxService'));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`✓ ${name}`); }
const waitIdle = async () => { for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 10)); if (!S.messages.some(m => m.status === 'processing')) { await new Promise(r => setTimeout(r, 30)); return; } } };

(async () => {
  await test('template resmi + variabel + alias lama + Spintax', () => {
    const v = tpl.buildVars({ customer_name: 'Budi', customer_code: 'C007', package_name: 'Home', speed_label: '10 Mbps', outstanding: 150000, due_date: '2026-10-20', invoice_number: 'INV-1' }, { bank_name: 'BCA', account_number: '123', account_name: 'PT X' });
    const out = tpl.renderTemplate(tpl.OFFICIAL_TEMPLATES[0].body, v);
    assert(out.includes('Rp 150.000') && out.includes('20 Oktober 2026') && out.includes('Bank BCA') && out.includes('Home-10Mbps'));
    assert(!/\{[^}]*\|/.test(out), 'Spintax harus habis diproses');
    assert.equal(tpl.renderTemplate('{nama} {kode} {no_faktur}', v), 'Budi C007 INV-1');
    const variants = new Set(Array.from({ length: 40 }, () => tpl.spin('{A|B|{C|D}}')));
    assert(variants.size >= 3, 'Spintax harus bervariasi (nested)');
    assert.equal(tpl.renderTemplate('{x_tak_dikenal}', v), '{x_tak_dikenal}');
  });

  await test('jam kerja & klasifikasi error auto-pause', () => {
    const c = antiBan.normalizeConfig({});
    assert.equal(c.minDelaySec, 5); assert.equal(c.maxDelaySec, 15); assert.equal(c.longPauseEvery, 20);
    assert(!antiBan.isWorkingHours(c, new Date('2026-09-25T07:59:00+07:00')));
    assert(antiBan.isWorkingHours(c, new Date('2026-09-25T08:00:00+07:00')));
    assert(!antiBan.isWorkingHours(c, new Date('2026-09-25T17:00:00+07:00')));
    const err = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
    assert.equal(antiBan.classifyPauseError(err(429, 'Too Many Requests')), 'rate_limit');
    assert.equal(antiBan.classifyPauseError(err(401, 'Unauthorized')), 'unauthorized');
    assert.equal(antiBan.classifyPauseError(err(422, 'Session status is not as expected: STARTING')), 'disconnected');
    assert.equal(antiBan.classifyPauseError(err(0, 'ECONNREFUSED', { transient: true })), 'disconnected');
    assert.equal(antiBan.classifyPauseError(err(500, 'internal')), null);
    assert(antiBan.isOptOutText(' stop. ', c) && antiBan.isOptOutText('BERHENTI', c) && !antiBan.isOptOutText('stop dulu ya', c));
  });

  await gw.initGatewayOnBoot();
  assert.equal(gw.getGatewayStatus().state, 'connected');

  await test('di luar jam kerja: pesan massal ditahan, balasan inbox tetap terkirim', async () => {
    const h = antiBan.jakartaHour();
    const start = (h + 2) % 24; S.settings.wa_antiban_json = JSON.stringify({ workStartHour: start, workEndHour: start + 1 });
    await antiBan.getConfig({ fresh: true });
    assert(!antiBan.isWorkingHours(await antiBan.getConfig()));
    await gw.enqueueWaMessage({ phone: '081298760001', message: 'promo', type: 'broadcast' });
    await gw.enqueueWaMessage({ phone: '081298760002', message: 'balasan admin', type: 'inbox' });
    await waitIdle();
    assert.deepEqual(sent.map(s => s.text), ['balasan admin']);
    assert.equal(S.messages.find(m => m.message === 'promo').status, 'queued');
    assert(gw.getQueueNote() && /jam operasional/.test(gw.getQueueNote()));
  });

  await test('dalam jam kerja: pesan massal jalan, nomor blacklist dibatalkan', async () => {
    S.settings.wa_antiban_json = JSON.stringify({ workStartHour: 0, workEndHour: 24 });
    await antiBan.getConfig({ fresh: true });
    S.blacklist.add('6281298760003');
    await gw.enqueueWaMessage({ phone: '081298760003', message: 'untuk opt-out', type: 'broadcast' });
    assert.equal(S.messages.find(m => m.message === 'untuk opt-out').status, 'cancelled');
    gw.processQueue(); await waitIdle();
    assert(sent.some(s => s.text === 'promo'));
  });

  await test('rate limit dari WAHA → antrean DIJEDA, pesan kembali ke antrean, admin dapat alert', async () => {
    failNext = Object.assign(new Error('WAHA 429: Too Many Requests'), { status: 429, transient: true });
    await gw.enqueueWaMessage({ phone: '081298760004', message: 'kena limit', type: 'broadcast' });
    await waitIdle();
    const m = S.messages.find(x => x.message === 'kena limit');
    assert.equal(m.status, 'queued'); assert.equal(antiBan.getPauseState().paused, true); assert.equal(antiBan.getPauseState().kind, 'rate_limit');
    assert(S.notifications.length >= 1, 'notifikasi admin harus dibuat');
    await gw.enqueueWaMessage({ phone: '081298760005', message: 'tertahan saat pause', type: 'inbox' });
    await waitIdle();
    assert(!sent.some(s => s.text === 'tertahan saat pause'), 'saat pause tidak ada yang terkirim');
    await antiBan.resumeQueue('test'); gw.processQueue(); await waitIdle();
    assert(sent.some(s => s.text === 'kena limit') && sent.some(s => s.text === 'tertahan saat pause'));
  });

  await test('inbox: pesan masuk tercatat, balasan STOP → blacklist + konfirmasi', async () => {
    const before = sent.length;
    await inbox.ingestInbound({ id: 'false_6281234567890@c.us_M1', from: '6281234567890@c.us', body: 'Min, ini bukti transfernya', fromMe: false });
    const conv = S.convs[0];
    assert.equal(conv.customer_id, 7); assert.equal(conv.unread_count, 1); assert.equal(conv.category, 'payment');
    await inbox.ingestInbound({ id: 'false_6281234567890@c.us_M1', from: '6281234567890@c.us', body: 'duplikat', fromMe: false });
    assert.equal(S.chats.filter(c => c.direction === 'in').length, 1, 'webhook duplikat diabaikan');
    await inbox.ingestInbound({ id: 'false_6281234567890@c.us_M2', from: '6281234567890@c.us', body: 'STOP', fromMe: false });
    assert(S.blacklist.has('6281234567890'));
    await waitIdle();
    assert(sent.slice(before).some(s => /tidak akan lagi menerima pesan informasi massal/.test(s.text)), 'konfirmasi opt-out terkirim');
    await inbox.ingestInbound({ id: 'x', from: '120363@g.us', body: 'grup', fromMe: false });
    assert.equal(S.convs.length, 1, 'pesan grup tidak masuk inbox');
  });

  console.log(`\n${passed} test WA CRM lolos.`);
  process.exit(0);
})().catch(e => { console.error('GAGAL:', e.stack || e.message); process.exit(1); });
