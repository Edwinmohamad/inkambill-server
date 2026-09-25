// v1.29 — Tes scan bukti transfer: aturan pencocokan, normalisasi hasil AI, utilitas gambar,
// klien AI (dengan server tiruan lokal), dan kabel route/view. Tidak butuh database / internet.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '..');
const match = require('../services/proofMatchService');
const ai = require('../services/proofAiService');
const img = require('../services/proofImageService');

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; } };

const banks = [
  { bank_name: 'BCA', account_name: 'INKAMNET DIGITAL', account_number: '1234567890' },
  { bank_name: 'MANDIRI', account_name: 'INKAMNET DIGITAL', account_number: '9876543210123' }
];
const payment = { id: 10, method: 'transfer', amount: 150000, paid_at: '2026-09-20 12:00:00', bank_name: 'BCA · 1234567890 · INKAMNET DIGITAL', customer_id: 1, customer_name: 'Budi Santoso' };
const goodScan = { is_transfer_proof: 1, transaction_status: 'success', amount_detected: 150000, amount_confidence: 0.98, transfer_at: '2026-09-20 19:42:00', transfer_has_time: 1, sender_name: 'BUDI SANTOSO', recipient_name: 'INKAMNET DIGITAL', recipient_account: '1234567890', ref_no: '260920194200123' };
const evaluate = (scan, extra = {}) => match.evaluateProof({ scan, payment, expectedAmount: 150000, banks, now: new Date('2026-09-21T03:00:00Z'), ...extra });
const level = (res, key) => res.checks.find(c => c.key === key)?.level;

(async () => {
  await test('nama: gelar, terpotong, inisial, beda', () => {
    assert.strictEqual(match.compareNames('BPK BUDI SANTOSO', 'Budi Santoso'), 'match');
    assert.strictEqual(match.compareNames('BUDI SANTOS', 'Budi Santoso'), 'match');
    assert.strictEqual(match.compareNames('M FAJAR RIZKI', 'Muhammad Fajar Rizki'), 'match');
    assert.strictEqual(match.compareNames('BUDI HARTONO', 'Budi Santoso'), 'partial');
    assert.strictEqual(match.compareNames('SITI AMINAH', 'Budi Santoso'), 'mismatch');
    assert.strictEqual(match.compareNames('', 'Budi'), 'unknown');
  });
  await test('rekening: penuh, tersamar depan/belakang, beda', () => {
    assert.strictEqual(match.accountMatches('1234567890', '1234567890'), true);
    assert.strictEqual(match.accountMatches('****7890', '1234567890'), true);
    assert.strictEqual(match.accountMatches('123****890', '1234567890'), true);
    assert.strictEqual(match.accountMatches('xxxx1111', '1234567890'), false);
    assert.strictEqual(match.accountMatches('5550001111', '1234567890'), false);
    assert.strictEqual(match.accountMatches('**', '1234567890'), null);
  });
  await test('semua cocok → ok', () => {
    const r = evaluate(goodScan);
    assert.strictEqual(r.overall, 'ok', JSON.stringify(r.checks));
    assert.strictEqual(r.summary, 'Semua data bukti sesuai tagihan.');
  });
  await test('nominal kurang → mismatch + note selisih', () => {
    const r = evaluate({ ...goodScan, amount_detected: 100000 });
    assert.strictEqual(r.overall, 'mismatch');
    assert.ok(/KURANG Rp50\.000/.test(r.summary), r.summary);
  });
  await test('nominal lebih & toleransi kode unik', () => {
    assert.strictEqual(evaluate({ ...goodScan, amount_detected: 150500 }).overall, 'mismatch');
    assert.strictEqual(evaluate({ ...goodScan, amount_detected: 150123 }, { settings: { tolerance: 500 } }).overall, 'ok');
  });
  await test('1 bukti untuk beberapa faktur memakai total pengajuan', () => {
    const r = evaluate({ ...goodScan, amount_detected: 450000 }, { expectedAmount: 450000, groupCount: 3 });
    assert.strictEqual(level(r, 'amount'), 'ok');
  });
  await test('rekening tujuan bukan INKAMNET → mismatch', () => {
    const r = evaluate({ ...goodScan, recipient_name: 'ANDI', recipient_account: '5550001111' });
    assert.strictEqual(level(r, 'recipient'), 'bad');
    assert.strictEqual(r.overall, 'mismatch');
  });
  await test('rekening INKAMNET lain dari yang dipilih → warning', () => {
    const r = evaluate({ ...goodScan, recipient_account: '9876543210123' });
    assert.strictEqual(level(r, 'recipient'), 'warn');
  });
  await test('QRIS merchant dari daftar nama tambahan', () => {
    const r = match.evaluateProof({ scan: { ...goodScan, recipient_account: null, recipient_name: 'INKAM NET QRIS' }, payment: { ...payment, method: 'qris', bank_name: 'QRIS' }, expectedAmount: 150000, banks, recipientNames: ['INKAM NET QRIS'], now: new Date('2026-09-21T03:00:00Z') });
    assert.strictEqual(level(r, 'recipient'), 'ok');
  });
  await test('pengirim beda → warning, alias → ok', () => {
    const r = evaluate({ ...goodScan, sender_name: 'SITI AMINAH' });
    assert.strictEqual(level(r, 'sender'), 'warn');
    assert.strictEqual(r.overall, 'warning');
    assert.strictEqual(evaluate({ ...goodScan, sender_name: 'SITI AMINAH' }, { aliases: ['Siti Aminah'] }).overall, 'ok');
  });
  await test('tanggal jauh berbeda / masa depan', () => {
    assert.strictEqual(level(evaluate({ ...goodScan, transfer_at: '2026-08-01 10:00:00' }), 'date'), 'warn');
    assert.strictEqual(level(evaluate({ ...goodScan, transfer_at: '2026-12-01 10:00:00' }), 'date'), 'bad');
    const dateObj = new Date('2026-09-20T12:42:00Z'); // 19:42 WIB
    const r = evaluate({ ...goodScan, transfer_at: dateObj }, { payment: { ...payment, paid_at: new Date('2026-09-20T05:00:00Z') } });
    assert.strictEqual(level(r, 'date'), 'ok');
    assert.ok(r.checks.find(c => c.key === 'date').detail.includes('19:42'));
  });
  await test('duplikat: pelanggan lain → mismatch, pelanggan sama → warning, mirip → warning', () => {
    const other = { payment_id: 3, reference: 'PAY-1', customer_name: 'Rina', same_customer: false, reason: 'file identik', strength: 'strong' };
    assert.strictEqual(evaluate(goodScan, { duplicates: [other] }).overall, 'mismatch');
    assert.strictEqual(evaluate(goodScan, { duplicates: [{ ...other, same_customer: true }] }).overall, 'warning');
    assert.strictEqual(evaluate(goodScan, { duplicates: [{ ...other, strength: 'similar' }] }).overall, 'warning');
  });
  await test('AI nonaktif: unreadable, duplikat tetap terdeteksi', () => {
    assert.strictEqual(evaluate({}, { aiState: 'disabled' }).overall, 'unreadable');
    assert.strictEqual(evaluate({}, { aiState: 'disabled', duplicates: [{ payment_id: 3, customer_name: 'X', same_customer: false, reason: 'file identik', strength: 'strong' }] }).overall, 'mismatch');
  });
  await test('bukan bukti / transaksi gagal / nominal tak terbaca', () => {
    assert.strictEqual(evaluate({ ...goodScan, is_transfer_proof: 0 }).overall, 'mismatch');
    assert.strictEqual(evaluate({ ...goodScan, transaction_status: 'failed' }).overall, 'mismatch');
    assert.strictEqual(evaluate({ ...goodScan, amount_detected: null }).overall, 'warning');
  });
  await test('normalisasi AI: rupiah, tanggal, teks kosong', () => {
    assert.strictEqual(ai.cleanAmount('Rp150.000,00'), 150000);
    assert.strictEqual(ai.cleanAmount('150,000.00'), 150000);
    assert.strictEqual(ai.cleanAmount('Rp 1.250.000'), 1250000);
    assert.strictEqual(ai.cleanAmount(175000), 175000);
    assert.strictEqual(ai.cleanAmount('abc'), null);
    assert.deepStrictEqual(ai.cleanDateTime('2026-09-20 19:42'), { at: '2026-09-20 19:42:00', hasTime: true });
    assert.deepStrictEqual(ai.cleanDateTime('2026-09-20'), { at: '2026-09-20 12:00:00', hasTime: false });
    assert.deepStrictEqual(ai.cleanDateTime('kemarin'), { at: null, hasTime: false });
    const n = ai.normalizeExtraction({ is_transfer_proof: true, transaction_status: 'weird', amount: '50.000', sender_name: ' null ', reference_number: 'ABC 123 456' });
    assert.strictEqual(n.transactionStatus, 'unknown');
    assert.strictEqual(n.amount, 50000);
    assert.strictEqual(n.senderName, null);
    assert.strictEqual(match.normalizeRef(n.referenceNumber), 'ABC123456');
  });

  // Gambar uji: pola kotak acak (PNG) + versi JPEG kompres ulang + JPEG besar.
  const makeRgba = (w, h, seed) => {
    const data = Buffer.alloc(w * h * 4);
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const blocks = Array.from({ length: 40 }, () => [rnd() * w, rnd() * h, rnd() * w / 3, rnd() * h / 6, rnd() * 255]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 245;
      for (const [bx, by, bw, bh, c] of blocks) if (x >= bx && x < bx + bw && y >= by && y < by + bh) v = c;
      const o = (y * w + x) * 4; data[o] = v; data[o + 1] = v; data[o + 2] = (v + 40) % 256; data[o + 3] = 255;
    }
    return data;
  };
  const toPng = (w, h, data) => { const p = new PNG({ width: w, height: h }); data.copy(p.data); return PNG.sync.write(p); };
  const baseA = makeRgba(400, 800, 7), baseB = makeRgba(400, 800, 99);
  const pngA = toPng(400, 800, baseA), pngB = toPng(400, 800, baseB);
  const jpgA = Buffer.from(jpeg.encode({ data: baseA, width: 400, height: 800 }, 55).data);

  await test('gambar: deteksi mime, dHash stabil setelah kompres ulang, beda gambar jauh', () => {
    assert.strictEqual(img.detectMime(pngA), 'image/png');
    assert.strictEqual(img.detectMime(jpgA), 'image/jpeg');
    const hA = img.perceptualHash(pngA, 'image/png');
    const hJ = img.perceptualHash(jpgA, 'image/jpeg');
    const hB = img.perceptualHash(pngB, 'image/png');
    assert.strictEqual(hA.length, 64);
    assert.ok(img.hammingHex(hA, hJ) <= 4, `kompres ulang terlalu jauh: ${img.hammingHex(hA, hJ)}`);
    assert.ok(img.hammingHex(hA, hB) > 40, `gambar beda terlalu dekat: ${img.hammingHex(hA, hB)}`);
  });
  await test('gambar: perkecil gambar besar untuk AI', () => {
    const big = Buffer.from(jpeg.encode({ data: makeRgba(1800, 3200, 3), width: 1800, height: 3200 }, 90).data);
    const prepared = img.prepareForAi(big, 'image/jpeg');
    assert.strictEqual(prepared.resized, true);
    assert.strictEqual(Math.max(prepared.width, prepared.height), img.AI_MAX_EDGE);
    assert.strictEqual(prepared.mime, 'image/jpeg');
    const small = img.prepareForAi(pngA, 'image/png');
    assert.strictEqual(small.resized, false);
    assert.throws(() => img.prepareForAi(Buffer.from('%PDF-1.4 xxxxxxxx'), 'application/pdf'));
  });

  // Klien AI terhadap server tiruan.
  let lastBody = null; let mode = 'ok';
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      lastBody = JSON.parse(body);
      if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'rate limited' } })); }
      if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-model', content: [{ type: 'tool_use', name: 'record_transfer_proof', input: { is_transfer_proof: true, transaction_status: 'success', amount: 'Rp150.000', amount_confidence: 0.9, transfer_datetime: '2026-09-20 19:42', sender_name: 'BUDI SANTOSO', recipient_name: 'INKAMNET', recipient_account: '****7890', reference_number: 'REF123456' } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/messages`;
  try {
    await test('klien AI: request & parsing tool_use', async () => {
      const r = await ai.extractTransferProof({ base64: pngA.toString('base64'), mime: 'image/png', apiKey: 'k', model: 'm', url });
      assert.strictEqual(r.data.amount, 150000);
      assert.strictEqual(r.data.transferHasTime, true);
      assert.strictEqual(lastBody.tool_choice.name, 'record_transfer_proof');
      assert.strictEqual(lastBody.messages[0].content[0].source.media_type, 'image/png');
    });
    await test('klien AI: 429 bisa diulang, 401 tidak', async () => {
      mode = '429';
      await assert.rejects(ai.extractTransferProof({ base64: 'x', mime: 'image/png', apiKey: 'k', url }), e => e.retryable === true);
      mode = '401';
      await assert.rejects(ai.extractTransferProof({ base64: 'x', mime: 'image/png', apiKey: 'k', url }), e => e.retryable === false && /API key/.test(e.message));
      await assert.rejects(ai.extractTransferProof({ base64: 'x', mime: 'image/png', apiKey: '', url }), e => e.retryable === false);
    });
  } finally { server.close(); }

  await test('kabel route & view', () => {
    const route = fs.readFileSync(path.join(root, 'routes/payments.js'), 'utf8');
    const view = fs.readFileSync(path.join(root, 'views/payments/index.ejs'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const schema = fs.readFileSync(path.join(root, 'services/schemaService.js'), 'utf8');
    assert.ok(route.includes("if(method){sql+=` AND p.method=?`"), 'filter metode');
    const verifySvc = fs.readFileSync(path.join(root, 'services/paymentVerificationService.js'), 'utf8');
    assert.ok(verifySvc.includes('approvalGate(conn,p,') && route.includes('verifyPendingPayment('), 'gate approval (via paymentVerificationService)');
    assert.ok(route.includes("['warning','mismatch'].includes(scanRows[0]?.overall_status)"), 'bulk skip');
    assert.ok((route.match(/queueProofScan\(/g) || []).length >= 3, 'antre scan saat upload/buat/scan ulang');
    assert.ok(route.includes("router.post('/proof-scan/settings',requireMasterAdmin"), 'pengaturan khusus master');
    assert.ok(view.includes('name="method"') && view.includes('name="scan"'), 'filter UI');
    assert.ok(view.includes('name="scan_override_reason"') && view.includes('name="save_payer_alias"'), 'modal approve');
    assert.ok(view.includes('id="proofScanSettingsModal"') && view.includes('id="proofScanPanel"'), 'modal & panel');
    assert.ok(app.includes('ensureV54Schema()') && app.includes('runProofScanSweep'), 'boot & cron');
    assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS payment_proof_scans') && schema.includes('CREATE TABLE IF NOT EXISTS customer_payer_aliases'), 'skema');
  });

  console.log(`Proof scan tests passed: ${passed} checks.`);
})().catch(err => { console.error(err); process.exit(1); });
