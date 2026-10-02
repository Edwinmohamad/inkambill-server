const assert = require('assert/strict');
const { loadCashApprovals, isSchemaCompatibilityError } = require('../services/paymentApprovalQueryService');

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

  console.log('Payment approval page fallback: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
