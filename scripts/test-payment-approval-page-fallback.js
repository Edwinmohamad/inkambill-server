const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { loadCashApprovals, isSchemaCompatibilityError, safePaymentPageLoad } = require('../services/paymentApprovalQueryService');

function failingDb(error) {
  return { async query() { throw error; } };
}

(async () => {
  const logger = { warnings: [], warn(...args) { this.warnings.push(args.join(' ')); } };
  const oldColumn = Object.assign(new Error("Unknown column 'ct.approval_status'"), { code: 'ER_BAD_FIELD_ERROR', errno: 1054 });
  const missingTable = Object.assign(new Error("Table 'cash_transactions' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });

  assert.equal(isSchemaCompatibilityError(oldColumn), true);
  assert.equal(isSchemaCompatibilityError(missingTable), true);

  const oldColumnResult = await loadCashApprovals(failingDb(oldColumn), logger);
  assert.deepEqual(oldColumnResult, { rows: [], unavailable: true });

  const missingTableResult = await loadCashApprovals(failingDb(missingTable), logger);
  assert.deepEqual(missingTableResult, { rows: [], unavailable: true });
  assert.equal(logger.warnings.length, 2);

  const rows = [{ id: 7, approval_status: 'PENDING_APPROVAL' }];
  assert.deepEqual(await loadCashApprovals({ async query() { return [rows]; } }, logger), { rows, unavailable: false });

  const connectionError = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
  await assert.rejects(() => loadCashApprovals(failingDb(connectionError), logger), /Connection lost/);

  const pageWarnings = [];
  const pageLogger = { errors: [], error(...args) { this.errors.push(args); } };
  assert.deepEqual(await safePaymentPageLoad('riwayat pembayaran', [], async () => { throw oldColumn; }, pageWarnings, pageLogger), []);
  assert.deepEqual(pageWarnings, ['riwayat pembayaran']);
  assert.equal(pageLogger.errors.length, 1);
  assert.deepEqual(await safePaymentPageLoad('filter site', [], async () => [{ code: 'CDS' }], pageWarnings, pageLogger), [{ code: 'CDS' }]);

  const root = path.resolve(__dirname, '..');
  const route = fs.readFileSync(path.join(root, 'routes/payments.js'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'views/payments/index.ejs'), 'utf8');
  for (const label of ['riwayat pembayaran', 'ringkasan metode pembayaran', 'daftar faktur terbuka', 'ringkasan transaksi', 'ringkasan bukti pembayaran', 'antrean approval kas']) {
    assert.match(route, new RegExp(`safe\\('${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${label} harus memiliki fallback terisolasi`);
  }
  assert.match(route, /paymentPageWarnings:pageWarnings/);
  assert.match(view, /paymentPageWarnings\.join/);

  console.log('Payment approval page fallback: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
