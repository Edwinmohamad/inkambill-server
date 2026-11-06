const assert=require('assert');
const { invoicePeriodBookDate,resolveLedgerDate,postCashTransaction }=require('../services/paymentVerificationService');

assert.strictEqual(
  invoicePeriodBookDate({periodMonth:9,periodYear:2026,referenceDate:'2026-10-02'}),
  '2026-09-02',
  'helper lama tetap bisa membaca periode referensi invoice historis; bukan aturan jurnal baru'
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

assert.match(postCashTransaction.toString(),/resolveLedgerDate\(conn,\{periodMonth:meta\.period_month,periodYear:meta\.period_year,bookDate\}\)/,'posting harus memakai periode tagihan bila Closing belum dikunci');

// Closing dikunci per rentang tanggal; fake hanya menjawab query kunci periode.
const lockedConn=lockedRanges=>({async execute(sql,params){
  if(sql.includes('FROM closing_periods')&&sql.includes("status='LOCKED'")){
    const d=params[0];const hit=lockedRanges.find(([a,b])=>d>=a&&d<=b);
    return [hit?[{id:1,period_start:hit[0],period_end:hit[1]}]:[]];
  }
  throw new Error('query tak terduga: '+sql);
}});
(async()=>{
  // Tagihan Oktober dibayar 3 November, Oktober belum dikunci -> masuk saldo Oktober.
  assert.deepStrictEqual(await resolveLedgerDate(lockedConn([]),{periodMonth:10,periodYear:2026,bookDate:'2026-11-03'}),{ledgerDate:'2026-10-03',basis:'invoice_period'});
  // Hari dibatasi ke akhir bulan tagihan (31 Desember untuk tagihan November -> 30 November).
  assert.strictEqual((await resolveLedgerDate(lockedConn([]),{periodMonth:11,periodYear:2026,bookDate:'2026-12-31'})).ledgerDate,'2026-11-30');
  // Oktober sudah dikunci (closing tgl 5/6) -> dicatat pada tanggal diterima di periode terbuka.
  assert.deepStrictEqual(await resolveLedgerDate(lockedConn([['2026-10-01','2026-10-31']]),{periodMonth:10,periodYear:2026,bookDate:'2026-11-08'}),{ledgerDate:'2026-11-08',basis:'received_period_locked'});
  // Pembayaran di bulan tagihan sendiri tetap tanggal bayar.
  assert.deepStrictEqual(await resolveLedgerDate(lockedConn([]),{periodMonth:11,periodYear:2026,bookDate:'2026-11-07'}),{ledgerDate:'2026-11-07',basis:'received'});
  // Bulan tagihan dan tanggal terima sama-sama dikunci -> ditolak.
  await assert.rejects(()=>resolveLedgerDate(lockedConn([['2026-10-01','2026-11-30']]),{periodMonth:10,periodYear:2026,bookDate:'2026-11-03'}),/sudah dikunci/);
  await assert.rejects(()=>resolveLedgerDate(lockedConn([]),{periodMonth:10,periodYear:2026,bookDate:''}),/tidak valid/);
  console.log('cash-invoice-period: PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
