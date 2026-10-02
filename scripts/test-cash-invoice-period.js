const assert=require('assert');
const { invoicePeriodBookDate }=require('../services/paymentVerificationService');

assert.strictEqual(
  invoicePeriodBookDate({periodMonth:9,periodYear:2026,referenceDate:'2026-10-02'}),
  '2026-09-02',
  'pembayaran Oktober untuk tagihan September harus masuk saldo September'
);
assert.strictEqual(
  invoicePeriodBookDate({periodMonth:2,periodYear:2026,referenceDate:'2026-03-31'}),
  '2026-02-28',
  'hari harus dibatasi ke hari terakhir bulan tagihan'
);
assert.strictEqual(
  invoicePeriodBookDate({periodMonth:2,periodYear:2028,referenceDate:'2028-03-31'}),
  '2028-02-29',
  'tahun kabisat harus didukung'
);
assert.throws(()=>invoicePeriodBookDate({periodMonth:13,periodYear:2026,referenceDate:'2026-10-02'}),/Periode bulan\/tahun faktur/);

console.log('cash-invoice-period: PASS');
