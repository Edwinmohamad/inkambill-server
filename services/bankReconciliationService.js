const db = require('../config/db');

async function ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS bank_reconciliation_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bank_id BIGINT UNSIGNED NOT NULL,
    period_from DATE NOT NULL,
    period_to DATE NOT NULL,
    opening_balance DECIMAL(16,2) NOT NULL,
    closing_balance DECIMAL(16,2) NOT NULL,
    other_credits DECIMAL(16,2) NOT NULL DEFAULT 0,
    other_debits DECIMAL(16,2) NOT NULL DEFAULT 0,
    note VARCHAR(500) NULL,
    recorded_by BIGINT UNSIGNED NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bank_reconciliation_period (bank_id,period_from,period_to),
    CONSTRAINT fk_bank_reconciliation_bank FOREIGN KEY (bank_id) REFERENCES banks(id)
  )`);
}

function bankLabel(bank) {
  return `${bank.bank_name} · ${bank.account_number} · ${bank.account_name}`;
}

async function transferTotal(bank, from, to) {
  const [[row]] = await db.execute(`SELECT COALESCE(SUM(p.amount),0) total,COUNT(*) count
    FROM payments p WHERE p.status='confirmed' AND p.method IN ('transfer','qris')
    AND p.bank_name=? AND p.paid_at>=? AND p.paid_at<DATE_ADD(?, INTERVAL 1 DAY)`,
    [bankLabel(bank),from,to]);
  return {total:Number(row.total),count:Number(row.count)};
}

function reconcile(snapshot, transferAmount) {
  if(!snapshot)return null;
  const expected=Number(snapshot.opening_balance)+Number(transferAmount)+Number(snapshot.other_credits)-Number(snapshot.other_debits);
  return {expected,difference:Number(snapshot.closing_balance)-expected};
}

module.exports = {ensureSchema,bankLabel,transferTotal,reconcile};
