// Run with: node scripts/test-financial-guards-20261019.js
// Static regression contract; does not access live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root,name),'utf8');
const finance=read('routes/finance.js');
const closing=read('routes/closing.js');
const payments=read('routes/payments.js');
assert.match(finance,/approveCashTransaction\(conn,req\.params\.id,req\.session\.user\.id\);await syncCashTransactionsIntoDraftAutoClosing/);
assert.match(finance,/action:'approve_cash'/);
const lock=closing.slice(closing.indexOf("router.post('/period-lock'"), closing.indexOf("router.post('/period-reopen'"));
assert.match(lock,/pending\.pendingApproval > 0 \|\| pending\.needsSync > 0/);
assert.doesNotMatch(lock,/force_lock/);
const correction=payments.slice(payments.indexOf("router.post('/:id/method-to-cash'"),payments.indexOf("router.post('/:id/proof'"));
assert.match(correction,/await assertDateOpen\(conn,journal.transaction_date\)/);
assert.match(correction,/DELETE ce FROM closing_entries/);
console.log('PASS financial guard contracts (static). Integration tests and production reconciliation still required.');
