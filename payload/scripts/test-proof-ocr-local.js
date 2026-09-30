const assert = require('assert');
const {
  parseReceipt,
  parseDateTime,
  parseRupiahNumber,
  accountMatches,
  compareNames,
  evaluateLocalProof
} = require('../services/proofOcrService');

const banks = [{ bank_name: 'BCA', account_name: 'PT INKAMNET NEXERA TECHNOLOGY', account_number: '7115556002' }];

assert.strictEqual(parseRupiahNumber('Rp170.000'), 170000);
assert.strictEqual(parseRupiahNumber('Rp 170.000,00'), 170000);
assert.strictEqual(parseRupiahNumber('170,000.00'), 170000);
assert.strictEqual(parseDateTime('26/09/2026 20:14').at, '2026-09-26 20:14:00');
assert.strictEqual(parseDateTime('26 Sep 2026 13:15:21').at, '2026-09-26 13:15:21');
assert.strictEqual(accountMatches('7115556002', '7115556002'), true);
assert.strictEqual(accountMatches('****6002', '7115556002'), true);
assert.strictEqual(accountMatches('****8899', '7115556002'), false);
assert.strictEqual(compareNames('INKAMNET NEXERA TECHNOLOGY', 'PT INKAMNET NEXERA TECHNOLOGY'), 'match');

const parsed = parseReceipt(`Transfer Berhasil\nNominal Rp170.000\n26 Sep 2026 13:15:21\nPenerima\nPT INKAMNET NEXERA TECHNOLOGY\nRekening Tujuan ****6002\nNo. Referensi TRX123456789\nBCA mobile`, { expectedAmount: 170000, banks });
assert.strictEqual(parsed.amount, 170000);
assert.strictEqual(parsed.transferAt, '2026-09-26 13:15:21');
assert.strictEqual(parsed.recipientName, 'PT INKAMNET NEXERA TECHNOLOGY');
assert.strictEqual(accountMatches(parsed.recipientAccount, banks[0].account_number), true);
assert.strictEqual(parsed.referenceNumber, 'TRX123456789');

const good = evaluateLocalProof({ payment: { amount: 170000 }, parsed, banks, duplicates: [], confidence: 96, engineState: 'done' });
assert.strictEqual(good.canApprove, true);
assert.strictEqual(good.overall, 'ok');

const wrongAccount = { ...parsed, recipientAccount: '****8899' };
const warning = evaluateLocalProof({ payment: { amount: 170000 }, parsed: wrongAccount, banks, duplicates: [], confidence: 90, engineState: 'done' });
assert.strictEqual(warning.canApprove, true);
assert.strictEqual(warning.overall, 'warning');
assert.ok(warning.checks.some(c => c.key === 'account' && c.level === 'warn'));

const duplicate = evaluateLocalProof({ payment: { amount: 170000 }, parsed, banks, duplicates: [{ payment_id: 9, reference: 'PAY-9', strength: 'strong' }], confidence: 90, engineState: 'done' });
assert.strictEqual(duplicate.canApprove, true);
assert.strictEqual(duplicate.overall, 'warning');
assert.ok(duplicate.checks.some(c => c.key === 'duplicate' && c.level === 'warn'));

const unavailable = evaluateLocalProof({ payment: { amount: 170000 }, parsed: { ...parsed, amount: null, transferAt: null, recipientName: null, recipientAccount: null, referenceNumber: null, transactionStatus: 'unknown' }, banks, duplicates: [], confidence: null, engineState: 'unavailable', engineError: 'Tesseract tidak tersedia' });
assert.strictEqual(unavailable.canApprove, true);
assert.notStrictEqual(unavailable.overall, 'mismatch');

console.log('PASS: local OCR parser + advisory validation');
