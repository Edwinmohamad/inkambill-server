const assert = require('assert');
const db = require('../config/db');

const originalGetConnection = db.getConnection;
const originalExecute = db.execute;

async function run() {
  const queries = [];
  const connection = {
    beginTransaction: async () => queries.push('BEGIN'),
    execute: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT id,status,principal_amount')) return [[{ id: 7, status: 'ACTIVE', principal_amount: 500000 }]];
      if (sql.startsWith('SELECT COALESCE(SUM(amount),0) paid_amount')) return [[{ paid_amount: 100000 }]];
      return [{ affectedRows: 1, insertId: 11 }];
    },
    commit: async () => queries.push('COMMIT'),
    rollback: async () => queries.push('ROLLBACK'),
    release: () => queries.push('RELEASE')
  };
  db.getConnection = async () => connection;
  // auditService uses the pool after the financial transaction commits.
  db.execute = async () => [{ affectedRows: 1 }];

  const router = require('../routes/debts');
  const req = {
    params: {},
    body: { debt_id: '7', amount: '150000', payment_date: '2026-10-06', payment_method: 'transfer', notes: 'Tes' },
    session: { user: { id: 3 } },
    get: () => 'http://localhost/debts?scope=INTERNAL',
    ip: '127.0.0.1'
  };
  const res = { redirectUrl: '', redirect(url) { this.redirectUrl = url; } };

  await router.recordPayment(req, res);

  const insert = queries.find(item => item.sql?.startsWith('INSERT INTO finance_debt_payments'));
  assert(insert, 'insert pembayaran tidak dijalankan');
  assert.deepStrictEqual(insert.params.slice(0, 5), [7, '2026-10-06', 150000, 'transfer', 'Tes']);
  assert(queries.includes('COMMIT'), 'transaksi pembayaran tidak di-commit');
  assert(!queries.includes('ROLLBACK'), 'transaksi sukses tidak boleh di-rollback');
  assert.strictEqual(res.redirectUrl, '/debts?scope=INTERNAL');
  assert.strictEqual(req.session.flash.type, 'success');

  const failureStart = queries.length;
  const overpayReq = {
    ...req,
    body: { ...req.body, amount: '450000' },
    session: { user: { id: 3 } }
  };
  const overpayRes = { redirectUrl: '', redirect(url) { this.redirectUrl = url; } };
  await router.recordPayment(overpayReq, overpayRes);
  const failureQueries = queries.slice(failureStart);
  assert(failureQueries.includes('ROLLBACK'), 'pembayaran melebihi sisa harus di-rollback');
  assert(!failureQueries.some(item => item.sql?.startsWith('INSERT INTO finance_debt_payments')), 'pembayaran berlebih tidak boleh disimpan');
  assert.strictEqual(overpayRes.redirectUrl, '/debts?scope=INTERNAL');
  assert.strictEqual(overpayReq.session.flash.type, 'danger');
  assert.match(overpayReq.session.flash.message, /melebihi sisa/);
  console.log('Debt payment flow validation passed.');
}

run().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  db.getConnection = originalGetConnection;
  db.execute = originalExecute;
});
