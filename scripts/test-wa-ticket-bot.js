// Tests for the WhatsApp ticket bot: parser unit tests + full command flow against an in-memory
// fake DB and fake WAHA (no MariaDB / WAHA needed). Run: node scripts/test-wa-ticket-bot.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');

// ---------- fake modules (installed into require.cache before the service loads) ----------
const state = {
  users: [{ id: 1, name: 'Edwin', role: 'master_admin', is_active: 1 }],
  employees: [
    { id: 10, employee_code: 'TK-001', name: 'Budi Teknisi', phone: '0812-3456-7890', user_id: null, is_active: 1 },
    { id: 11, employee_code: 'TK-002', name: 'Sari NOC', phone: '+62 813 1111 2222', user_id: 1, is_active: 1 }
  ],
  customers: [{ id: 5, customer_code: 'CDS-0012', name: 'Pak Joko', phone: '081299990000', address: 'Jl. Mawar 1', site_id: 1 }],
  tickets: [], updates: [], audits: [], sent: []
};
const fakeDb = {
  async query(sql, params) { return this.execute(sql, params); },
  async execute(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ');
    const ticketView = t => {
      const c = state.customers.find(x => x.id === t.customer_id) || {};
      const e = state.employees.find(x => x.id === t.assigned_employee_id) || {};
      const last = state.updates.filter(u => u.ticket_id === t.id).slice(-1)[0];
      return { ...t, customer_code: c.customer_code, customer_name: c.name, customer_phone: c.phone, customer_address: c.address, site_code: c.customer_code ? 'CDS' : null, cluster_name: null, assigned_name: e.name, assigned_phone: e.phone, progress_percent: last ? last.progress_percent : null };
    };
    if (s.includes('FROM employees e LEFT JOIN positions p')) return [state.employees.filter(e => e.is_active).map(e => ({ phone: e.phone }))];
    if (s.includes('FROM employees e LEFT JOIN users u')) return [state.employees.filter(e => e.is_active)];
    if (s.includes('FROM employees WHERE is_active=1 AND UPPER(employee_code)=?')) return [state.employees.filter(e => e.employee_code.toUpperCase() === params[0])];
    if (s.includes('FROM tickets t') && s.includes('WHERE t.ticket_code=? LIMIT 1')) return [state.tickets.filter(t => t.ticket_code === params[0]).map(ticketView)];
    if (s.includes('FROM tickets t') && s.includes('WHERE t.id=? LIMIT 1')) return [state.tickets.filter(t => t.id === Number(params[0])).map(ticketView)];
    if (s.includes('FROM tickets WHERE ticket_code LIKE ?')) { const suf = params[0].slice(1); return [state.tickets.filter(t => t.ticket_code.endsWith(suf)).reverse()]; }
    if (s.includes('SELECT id FROM users')) return [[{ id: 1 }]];
    if (s.includes('FROM customers WHERE UPPER(customer_code)=?')) return [state.customers.filter(c => c.customer_code.toUpperCase() === params[0])];
    if (s.startsWith('INSERT INTO tickets(')) {
      const id = state.tickets.length + 1;
      state.tickets.push({ id, ticket_code: params[0], customer_id: params[1], subject: params[2], type: params[3], priority: params[4], status: 'open', description: params[5], attachment_path: params[6], opened_by: params[10], opened_at: new Date(), source: 'whatsapp', assigned_employee_id: null });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (s.startsWith('INSERT INTO ticket_updates(')) { state.updates.push({ id: state.updates.length + 1, ticket_id: params[0], progress_percent: params[1], status: params[2], note: params[3], attachment_path: params[4], updated_by: params[8], actor_employee_id: params[9] }); return [{ insertId: state.updates.length }]; }
    if (s.startsWith('UPDATE tickets SET status=?')) { const t = state.tickets.find(x => x.id === params[2]); t.status = params[0]; t.closed_at = params[0] === 'closed' ? new Date() : null; return [{}]; }
    if (s.startsWith('UPDATE tickets SET assigned_employee_id=?')) { const t = state.tickets.find(x => x.id === Number(params[2])); if (!(s.includes('assigned_employee_id IS NULL') && t.assigned_employee_id)) { t.assigned_employee_id = params[0]; } return [{}]; }
    if (s.startsWith('UPDATE tickets SET priority=?')) { state.tickets.find(x => x.id === params[1]).priority = params[0]; return [{}]; }
    if (s.includes('INSERT INTO audit_logs')) { state.audits.push(params); return [{}]; }
    if (s.includes('FROM tickets t LEFT JOIN customers c') && s.includes('t.status')) {
      let rows = state.tickets.map(ticketView);
      rows = s.includes("t.status IN ('open','progress','pending')") ? rows.filter(t => t.status !== 'closed') : rows.filter(t => t.status === params[0]);
      if (s.includes('t.assigned_employee_id=?')) rows = rows.filter(t => t.assigned_employee_id === params[params.length - 1]);
      return [rows];
    }
    if (s.includes('FROM ticket_updates tu LEFT JOIN users')) return [state.updates.filter(u => u.ticket_id === params[0]).reverse().slice(0, 3).map(u => ({ ...u, actor_name: 'x' }))];
    throw new Error('Fake DB: query tidak dikenali: ' + s.slice(0, 120));
  }
};
const fakeWaha = {
  SESSION: 'default',
  async sendToChat(chatId, text) { state.sent.push({ chatId, text }); },
  async resolveLidToPhone(lid) { return lid === '999@lid' ? '6281234567890' : null; },
  async downloadMedia() { return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), mimetype: 'image/jpeg' }; }
};
function mock(rel, exports) { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; }
mock('config/db.js', fakeDb);
mock('services/wahaClient.js', fakeWaha);
// Keep attachments out of the real storage folder during the test.
const savedPhotos = [];
mock('services/photoAttachmentService.js', { async savePhoto(file, dir, prefix) { savedPhotos.push({ prefix, mime: file.mimetype }); return { filename: `${prefix}-test.jpg`, originalName: 'x', mime: file.mimetype, size: file.size }; }, async removePhoto() {}, sendPhoto() {} });
process.env.WA_TICKET_GROUP_IDS = '120363000000000001@g.us';

const { parseCommand } = require(path.join(root, 'services/waTicketParser'));
const { handleWaTicketMessage } = require(path.join(root, 'services/waTicketCommandService'));

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }
const flush = () => new Promise(r => setTimeout(r, 20));
const BUDI = '6281234567890@c.us';
const GROUP = '120363000000000001@g.us';
let seq = 0;
const msg = (body, extra = {}) => ({ id: `false_${BUDI}_${++seq}`, from: BUDI, fromMe: false, body, ...extra });
const text = r => r.replies[0]?.text || '';

(async () => {
  console.log('Parser');
  await test('buat dengan prioritas + deskripsi multi-baris', () => {
    assert.deepStrictEqual(parseCommand('#buat CDS-0012 kritis Internet mati\nODP merah'), { command: 'create', customerRef: 'CDS-0012', priority: 'critical', subject: 'Internet mati', description: 'ODP merah' });
  });
  await test('buat tanpa pelanggan & tanpa prioritas', () => { const c = parseCommand('#buat - wifi lemot'); assert.strictEqual(c.customerRef, null); assert.strictEqual(c.priority, 'medium'); });
  await test('update persen hanya jika ada %', () => { assert.strictEqual(parseCommand('#update 1 60% ok').percent, 60); assert.strictEqual(parseCommand('#update 1 2 rumah').percent, null); });
  await test('update >100% ditolak', () => assert.ok(parseCommand('#update 1 150% x').error));
  await test('bukan perintah = null', () => assert.strictEqual(parseCommand('halo pak'), null));
  await test('reply singkat diterjemahkan dengan kode tiket dari notifikasi', () => {
    const { parseReplyCommand } = require(path.join(root, 'services/waTicketParser'));
    assert.deepStrictEqual(parseReplyCommand('proses', 'TT-20260925-123456'), { command: 'update', ticketRef: 'TT-20260925-123456', percent: null, note: 'Mulai diproses via WhatsApp.', replied: true });
  });

  console.log('Alur perintah');
  await test('nomor tak terdaftar ditolak (chat pribadi)', async () => {
    const r = await handleWaTicketMessage(msg('#list', { from: '6289999999999@c.us' }));
    assert.match(text(r), /belum terdaftar/);
  });
  await test('buat tiket via WA + broadcast grup dan teknisi', async () => {
    const r = await handleWaTicketMessage(msg('#buat CDS-0012 tinggi Internet mati sejak pagi\nLampu LOS merah'));
    assert.match(text(r), /Tiket \*TT-\d{8}-\d{6}\* dibuat/);
    assert.strictEqual(state.tickets.length, 1);
    assert.strictEqual(state.tickets[0].priority, 'high');
    assert.strictEqual(state.tickets[0].customer_id, 5);
    assert.strictEqual(state.tickets[0].opened_by, 1, 'fallback ke admin karena teknisi tanpa user login');
    await flush();
    assert.ok(state.sent.some(m => m.chatId === GROUP && m.text.includes('Tiket baru')), 'grup dapat notifikasi');
    assert.ok(state.sent.some(m => m.chatId === BUDI && m.text.includes('Balas pesan ini')), `teknisi menerima broadcast pribadi: ${JSON.stringify(state.sent)}`);
  });
  await test('reply "proses" memperbarui tiket tanpa mengetik kode', async () => {
    const r = await handleWaTicketMessage(msg('proses', { quotedMsg: { body: state.tickets[0].ticket_code } }));
    assert.match(text(r), /Proses/);
    assert.strictEqual(state.tickets[0].status, 'progress');
  });
  await test('pelanggan tidak ditemukan', async () => assert.match(text(await handleWaTicketMessage(msg('#buat XX-1 mati'))), /tidak ditemukan/));
  await test('ambil tiket pakai 6 digit terakhir', async () => {
    const ref = state.tickets[0].ticket_code.split('-').pop();
    const r = await handleWaTicketMessage(msg(`#ambil ${ref}`));
    assert.match(text(r), /ditangani Budi Teknisi/);
    assert.strictEqual(state.tickets[0].assigned_employee_id, 10);
    assert.strictEqual(state.tickets[0].status, 'progress');
    assert.strictEqual(state.updates.slice(-1)[0].actor_employee_id, 10);
  });
  await test('update progress + foto', async () => {
    const r = await handleWaTicketMessage(msg(`#update ${state.tickets[0].ticket_code} 60% ganti konektor`, { hasMedia: true, media: { url: 'http://waha.example/api/files/x.jpg', mimetype: 'image/jpeg' } }));
    assert.match(text(r), /Proses 60%/);
    assert.match(text(r), /Foto tersimpan/);
    assert.strictEqual(state.updates.slice(-1)[0].attachment_path, 'wa-progress-test.jpg');
  });
  await test('#tiketku menampilkan tiket milik teknisi', async () => assert.match(text(await handleWaTicketMessage(msg('#tiketku'))), /Internet mati/));
  await test('close dari grup: balasan ke grup, grup tidak dapat notifikasi ganda', async () => {
    state.sent.length = 0;
    const r = await handleWaTicketMessage(msg(`#close ${state.tickets[0].ticket_code} redaman normal -19`, { from: GROUP, participant: BUDI }));
    assert.strictEqual(r.replies[0].chatId, GROUP);
    assert.match(text(r), /Closed 100%/);
    assert.strictEqual(state.tickets[0].status, 'closed');
    await flush();
    assert.ok(!state.sent.some(m => m.chatId === GROUP), 'tidak kirim notifikasi lagi ke grup asal');
  });
  await test('update tiket closed ditolak', async () => assert.match(text(await handleWaTicketMessage(msg(`#update ${state.tickets[0].ticket_code} x`))), /sudah CLOSED/));
  await test('buka kembali', async () => { await handleWaTicketMessage(msg(`#buka ${state.tickets[0].ticket_code} pelanggan komplain lagi`)); assert.strictEqual(state.tickets[0].status, 'open'); });
  await test('assign ke karyawan lain → notifikasi pribadi', async () => {
    state.sent.length = 0;
    const r = await handleWaTicketMessage(msg(`#assign ${state.tickets[0].ticket_code} tk-002`));
    assert.match(text(r), /ditugaskan ke Sari NOC/);
    await flush();
    assert.ok(state.sent.some(m => m.chatId === '6281311112222@c.us' && m.text.includes('Anda ditugaskan')));
  });
  await test('grup yang tidak diizinkan diabaikan', async () => {
    const r = await handleWaTicketMessage(msg('#list', { from: '1203999@g.us', participant: BUDI }));
    assert.strictEqual(r.handled, false); assert.strictEqual(r.replies.length, 0);
  });
  await test('#idgrup di grup lain memberi ID grup', async () => assert.match(text(await handleWaTicketMessage(msg('#idgrup', { from: '1203999@g.us', participant: BUDI }))), /1203999@g.us/));
  await test('hashtag biasa di grup tidak dibalas', async () => assert.strictEqual((await handleWaTicketMessage(msg('#semangat', { from: GROUP, participant: BUDI }))).replies.length, 0));
  await test('pengirim @lid di-resolve lewat WAHA', async () => assert.match(text(await handleWaTicketMessage(msg('#list', { from: GROUP, participant: '999@lid' }))), /Tiket aktif/));
  await test('pesan dari bot sendiri diabaikan', async () => assert.strictEqual((await handleWaTicketMessage(msg('#list', { fromMe: true }))).handled, false));

  console.log('Wiring statis');
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  await test('route, schema, app, workflow terpasang', () => {
    assert.ok(read('routes/n8n.js').includes("router.post('/wa/command'"));
    assert.ok(read('services/schemaService.js').includes('async function ensureV52Schema()'));
    assert.ok(read('app.js').includes('await ensureV52Schema();'));
    assert.ok(read('routes/tickets.js').includes('notifyTicketEventAsync'));
    const wf = JSON.parse(read('n8n/06-wa-ticket-bot.json'));
    const names = wf.nodes.map(n => n.name);
    ['WAHA Webhook', 'Config', 'Valid?', 'INKAMBILLING Command', 'Pisah Balasan', 'Balasan Gangguan', 'Kirim via WAHA'].forEach(n => assert.ok(names.includes(n), 'node ' + n));
    assert.ok(JSON.stringify(wf).includes('webhookToken'), 'workflow memvalidasi token webhook');
    assert.ok(!JSON.stringify(wf).includes('$env'), 'workflow tidak bergantung pada $env');
  });

  console.log(`\n${passed} test lolos${process.exitCode ? ', ADA YANG GAGAL' : ''}.`);
})();
