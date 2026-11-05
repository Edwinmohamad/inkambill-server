'use strict';

const db = require('../config/db');

// Additive migration only. Null preserves historical journals and their
// existing report fallback; no transaction amount/date/status is rewritten.
async function ensureAccountingPeriodSchema() {
  await db.query(`ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS accounting_period DATE NULL`);
  await db.query(`ALTER TABLE cash_transactions ADD INDEX IF NOT EXISTS idx_cash_accounting_period(accounting_period,approval_status)`);
}

module.exports = { ensureAccountingPeriodSchema };
