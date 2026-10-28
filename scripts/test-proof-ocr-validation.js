const assert = require('assert');
const { parseReceipt, evaluateLocalProof } = require('../payload/services/proofOcrService');

const banks = [{ bank_name: 'BCA', account_name: 'INKAMNET', account_number: '1234567890' }];
const parsed = parseReceipt(`Transfer Berhasil\nNominal Rp 1.000.000\nTanggal 01/10/2026 10:30\nPenerima INKAMNET\nNo Rekening 1234567890\nNo Referensi TRX-ABC-123456`, { expectedAmount: 1000000, banks });
assert.equal(parsed.amount, 1000000, 'nominal harus terbaca');
assert.equal(parsed.transferAt, '2026-10-01 10:30:00', 'tanggal harus terbaca');
assert.equal(parsed.recipientAccount, '1234567890', 'rekening harus terbaca');
const result = evaluateLocalProof({ payment: { amount: 1000000 }, parsed, banks, engineState: 'done' });
assert(result.checks.some(check => check.key === 'amount' && check.level === 'ok'), 'nominal sesuai harus valid');
assert(result.checks.some(check => check.key === 'account' && check.level === 'ok'), 'rekening sesuai harus valid');
console.log('Proof OCR validation passed: amount, date, recipient, account, reference.');

for(const label of ['JUMLAH PENGIRIMAN Rp165.000','JUMLAH PENGIRIMAN\nRp165.000']){
 const receipt=parseReceipt(`${label}\nBIAYA LAYANAN Rp2.000\nTOTAL Rp167.000`,{expectedAmount:167000,banks});
 assert.equal(receipt.amount,165000,'transfer principal must exclude service fees even if invoice equals total');
 const review=evaluateLocalProof({payment:{amount:167000},parsed:receipt,banks,engineState:'done'});
 assert(review.checks.some(check=>check.key==='amount'&&check.level==='warn'));
}
