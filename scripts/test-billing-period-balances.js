'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { loadActualClosing } = require('../services/closingLedgerService');
const { resolveAccountingPeriod } = require('../services/financialControlService');
const sql = new DatabaseSync(':memory:');
for (const [name, offset, length] of [['YEAR', 0, 4], ['MONTH', 5, 2], ['DAY', 8, 2]]) {
  sql.function(name, value => value == null ? null : Number(String(value).slice(offset, offset + length)));
}
sql.exec(`
  CREATE TABLE sites(id INTEGER PRIMARY KEY,code TEXT);
  CREATE TABLE customers(id INTEGER PRIMARY KEY,site_id INTEGER);
  CREATE TABLE invoices(id INTEGER PRIMARY KEY,period_year INTEGER,period_month INTEGER,customer_id INTEGER);
  CREATE TABLE payments(id INTEGER PRIMARY KEY,invoice_id INTEGER,method TEXT,status TEXT,settlement_status TEXT,amount REAL);
  CREATE TABLE cash_categories(id INTEGER PRIMARY KEY,name TEXT,type TEXT,code TEXT);
  CREATE TABLE cash_transactions(id INTEGER PRIMARY KEY,transaction_date TEXT,name TEXT,amount REAL,notes TEXT,
    category_id INTEGER,site_id INTEGER,source_type TEXT,source_id INTEGER,approval_status TEXT,internal_transfer_key TEXT);
  CREATE TABLE closing_periods(id INTEGER PRIMARY KEY,period_start TEXT,period_end TEXT,status TEXT DEFAULT 'DRAFT',snapshot_json TEXT,
    manual_carry REAL,manual_carry_kbg REAL,manual_salary_agung REAL,manual_salary_padilah REAL,closing_date TEXT,created_by INTEGER,UNIQUE(period_start,period_end));
  CREATE TABLE closing_adjustments(id INTEGER PRIMARY KEY,closing_id INTEGER);
  INSERT INTO sites VALUES (1,'KBG'),(2,'CDS');
  INSERT INTO customers VALUES (1,1),(2,2);
  INSERT INTO invoices VALUES (1,2026,10,1),(2,2026,11,1),(3,2026,10,2);
  INSERT INTO payments VALUES
    (1,1,'cash','confirmed','settled',150),
    (2,2,'transfer','confirmed','not_applicable',200),
    (3,1,'cash','confirmed','held_by_staff',70),
    (4,1,'transfer','failed','not_applicable',100),
    (5,3,'transfer','confirmed','not_applicable',300),
    (6,2,'cash','confirmed','held_by_staff',80);
  INSERT INTO cash_categories VALUES (1,'Billing','income','BILL'),(2,'Biaya','expense','EXP'),(3,'Pokok','income','FINPRIN');
  INSERT INTO cash_transactions VALUES
    (1,'2026-11-05','Late October',150,NULL,1,1,'payment',1,'APPROVED',NULL),
    (2,'2026-10-20','Early November',200,NULL,1,1,'install_income',2,'APPROVED',NULL),
    (3,'2026-10-12','Manual income',30,NULL,1,1,NULL,NULL,'APPROVED',NULL),
    (4,'2026-10-14','October expense',40,NULL,2,1,'manual',NULL,'APPROVED',NULL),
    (5,'2026-11-14','November expense',60,NULL,2,1,'manual',NULL,'APPROVED',NULL),
    (6,'2026-10-14','Held cash: excluded',70,NULL,1,1,'payment',3,'APPROVED',NULL),
    (7,'2026-10-14','Failed: excluded',100,NULL,1,1,'payment',4,'APPROVED',NULL),
    (8,'2026-10-14','Pending: excluded',50,NULL,1,1,'manual',NULL,'PENDING_APPROVAL',NULL),
    (9,'2026-10-14','Internal: excluded',500,NULL,1,1,'manual',NULL,'APPROVED','PAIR'),
    (10,'2026-10-14','Principal: excluded',600,NULL,3,1,'manual',NULL,'APPROVED',NULL),
    (11,'2026-10-14','Other site',300,NULL,1,2,'payment',5,'APPROVED',NULL);
  INSERT INTO closing_periods(id,period_start,period_end,status,snapshot_json,manual_carry,manual_carry_kbg,manual_salary_agung,manual_salary_padilah) VALUES (1,'2026-10-01','2026-10-31','DRAFT',NULL,0,0,0,0);
  ALTER TABLE cash_transactions ADD COLUMN accounting_period TEXT;
  UPDATE cash_transactions SET accounting_period='2026-10-01' WHERE id=1;
  UPDATE cash_transactions SET accounting_period='2026-11-01' WHERE id=2;
`);
const db = { async execute(query, params = []) {
  assert.match(query.trim(), /^SELECT\b/i, 'reading balances must not write to the database');
  return [sql.prepare(query).all(...params)];
} };
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const finance = read('routes/finance.js');
const section = finance.slice(finance.indexOf('  const summarySql='), finance.indexOf('  // v1.24.8'));
assert(section.includes('const [[approvalSummary]]'));
const financeFor = vm.runInNewContext(`(async function(month,year,site='') { ${section}
  return {summary,collection,cashCharts,approvalSummary}; })`, { db });
const closing = read('routes/closing.js');
const loadSource = closing.slice(closing.indexOf('async function loadClosing('), closing.indexOf('async function ensureDraftPeriod('));
const closingFor = vm.runInNewContext(`${loadSource}\nloadClosing`, { db, loadActualClosing });

(async () => {
  try {
    const october = await financeFor(10, 2026);
    const november = await financeFor(11, 2026);
    assert.equal(october.summary.income, 480);
    assert.equal(october.summary.customer_income, 450);
    assert.equal(october.summary.other_income, 30);
    assert.equal(october.summary.customer_income + october.summary.other_income, october.summary.income);
    assert.equal(october.summary.expense, 40);
    assert.equal(october.summary.balance, 440);
    assert.equal(november.summary.income, 200);
    assert.equal(november.summary.customer_income, 200);
    assert.equal(november.summary.other_income, 0);
    assert.equal(november.summary.expense, 60);
    assert.equal(november.summary.balance, 140);
    assert.equal(october.collection.cash_held, 70);
    assert.equal(november.collection.cash_held, 80);
    assert.equal(october.approvalSummary.pending_total, 50);
    assert.equal(november.approvalSummary.pending_total, 0);
    assert.equal(october.cashCharts.daily.labels.length, 12);
    assert.equal(october.cashCharts.daily.income[9], 480);
    assert.equal(october.cashCharts.daily.income[10], 200);
    assert.equal(october.cashCharts.categories[0].amount, 40);
    assert.equal(november.cashCharts.categories[0].amount, 60);
    const kbg = await financeFor(10, 2026, 'KBG');
    assert.equal(kbg.summary.balance, 140);
    assert.equal(kbg.summary.customer_income, 150);
    assert.equal(kbg.summary.other_income, 30);
    assert.equal((await financeFor(10, 2026, 'CDS')).summary.balance, 300);
    assert.equal((await financeFor(10, 2027)).summary.balance, 0);
    assert.equal((await financeFor(10, 2027)).summary.customer_income, 0);
    assert.equal((await financeFor(10, 2027)).summary.other_income, 0);

    const draft = await closingFor('2026-10-01', '2026-10-31');
    assert.equal(draft.closing.status, 'DRAFT');
    assert.equal(draft.ledgerSummary.income, october.summary.income);
    assert.equal(draft.ledgerSummary.net, october.summary.balance);
    const allocationDb = { async execute(query, params = []) {
      const portable = query.replace(/INSERT IGNORE/g, 'INSERT OR IGNORE').replace(/CURDATE\(\)/g, "date('now')").replace(/ FOR UPDATE/g, '');
      const statement = sql.prepare(portable);
      if (/^SELECT/i.test(portable.trim())) return [statement.all(...params)];
      return [statement.run(...params)];
    } };
    const allocate = (periodYear, periodMonth, bookDate) => resolveAccountingPeriod(allocationDb, { periodYear, periodMonth, bookDate });
    await assert.rejects(() => allocate(2026,10,'2026-02-30'), /Tanggal pembayaran tidak valid/);
    assert.equal(await allocate(2026,10,'2026-11-05'),'2026-10-01', 'late payment stays in an open invoice month');
    assert.equal(await allocate(2026,11,'2026-10-20'),'2026-11-01', 'advance payment stays in its future invoice month');
    const snapshot = JSON.stringify(draft);
    sql.prepare("UPDATE closing_periods SET status='LOCKED',snapshot_json=? WHERE id=1").run(snapshot);
    assert.equal(await allocate(2026,10,'2026-11-07'),'2026-11-01', 'payment after October closes moves to November');
    assert.equal(await allocate(2026,11,'2026-10-20'),'2026-11-01', 'closed receipt month does not displace an open future invoice month');
    sql.exec("UPDATE closing_periods SET status='LOCKED' WHERE period_start='2026-11-01'");
    assert.equal(await allocate(2026,10,'2026-11-07'),'2026-12-01', 'skip a following month that is also closed');
    sql.exec("UPDATE closing_periods SET status='DRAFT' WHERE period_start='2026-11-01'");
    await allocate(2026,12,'2027-01-03');
    sql.exec("UPDATE closing_periods SET status='LOCKED' WHERE period_start='2026-12-01'");
    assert.equal(await allocate(2026,12,'2027-01-03'),'2027-01-01', 'closed December rolls over to January');
    sql.exec(`INSERT INTO payments VALUES (7,1,'transfer','confirmed','not_applicable',25);
      INSERT INTO cash_transactions VALUES (12,'2026-11-07','After October closed',25,NULL,1,1,'payment',7,'APPROVED',NULL,'2026-11-01');`);
    const closed = await closingFor('2026-10-01', '2026-10-31');
    assert.equal(closed.closing.status, 'LOCKED');
    assert.equal(closed.frozenSnapshot, true);
    assert.equal(closed.ledgerSummary.income, 480);
    assert.equal((await closingFor('2026-11-01', '2026-11-30')).ledgerSummary.income, 225);
    assert.equal((await financeFor(10, 2026)).summary.income, 480);
    assert.equal((await financeFor(11, 2026)).summary.income, 225);
    assert.equal((await financeFor(11, 2026)).summary.customer_income, 225);
    const reportsSource = read('routes/reports.js');
    const cashReportSource = reportsSource.slice(reportsSource.indexOf('async function cashReport('), reportsSource.indexOf("router.get('/',"));
    const cashReport = vm.runInNewContext(cashReportSource + '\ncashReport', {db});
    const filters = (from,to) => ({from,to,site:'',category:'',flow_type:'',method:''});
    const reportOct = await cashReport(filters('2026-10-01','2026-10-31'));
    const reportNov = await cashReport(filters('2026-11-01','2026-11-30'));
    assert.equal(reportOct.filter(r=>r.type==='income').reduce((n,r)=>n+r.amount,0),480);
    assert.equal(reportNov.filter(r=>r.type==='income').reduce((n,r)=>n+r.amount,0),225);
    assert.equal((await financeFor(11,2026)).summary.balance,165);
    assert.equal(sql.prepare('SELECT snapshot_json FROM closing_periods WHERE id=1').get().snapshot_json, snapshot);
    assert.equal(sql.prepare('SELECT transaction_date FROM cash_transactions WHERE id=2').get().transaction_date, '2026-10-20');
    console.log('PASS real SQL fixtures: early/late payments, isolated monthly net, expenses, charts, site/year filters, approval/settlement exclusions frozen closed Closing, open-month cutoff, skipped closed months and year rollover.');
  } finally { sql.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
