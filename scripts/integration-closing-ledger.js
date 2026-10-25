// Read configured DB through one connection; all fixtures are connection-local TEMPORARY tables.
const assert=require('node:assert/strict');
const db=require('../config/db');
const {loadActualClosing}=require('../services/closingLedgerService');
(async()=>{const conn=await db.getConnection();try{
 for(const sql of [
 'CREATE TEMPORARY TABLE sites(id INT PRIMARY KEY,code VARCHAR(20))',
 'CREATE TEMPORARY TABLE cash_categories(id INT PRIMARY KEY,type VARCHAR(20),name VARCHAR(100),code VARCHAR(20))',
 'CREATE TEMPORARY TABLE payments(id INT PRIMARY KEY,status VARCHAR(20),method VARCHAR(20),settlement_status VARCHAR(30))',
 'CREATE TEMPORARY TABLE cash_transactions(id INT PRIMARY KEY,transaction_date DATE,name VARCHAR(100),amount DECIMAL(16,2),notes TEXT,category_id INT,site_id INT,source_type VARCHAR(30),source_id INT,approval_status VARCHAR(30),internal_transfer_key VARCHAR(50))'
 ])await conn.query(sql);
 await conn.query("INSERT INTO sites VALUES(1,'CDS'),(2,'KBG')");
 await conn.query("INSERT INTO cash_categories VALUES(1,'income','Billing','BILL'),(2,'expense','Operasional','OPS'),(3,'income','Pokok pinjaman','FINPRIN')");
 await conn.query("INSERT INTO payments VALUES(1,'confirmed','transfer','not_applicable'),(2,'failed','transfer','not_applicable'),(3,'confirmed','cash','held_by_staff'),(4,'confirmed','cash','settled')");
 const rows=[
 [1,'2026-10-01',100000,1,1,'payment',1,'APPROVED',null],
 [2,'2026-10-31',20000,2,2,'manual',null,'APPROVED',null],
 [3,'2026-11-01',900000,1,1,'manual',null,'APPROVED',null],
 [4,'2026-09-30',900000,1,1,'manual',null,'APPROVED',null],
 [5,'2026-10-10',700000,1,1,'payment',2,'APPROVED',null],
 [6,'2026-10-10',700000,1,1,'payment',3,'APPROVED',null],
 [7,'2026-10-10',50000,1,2,'payment',4,'APPROVED',null],
 [8,'2026-10-10',700000,1,1,'manual',null,'PENDING_APPROVAL',null],
 [9,'2026-10-10',700000,1,1,'manual',null,'APPROVED','internal'],
 [10,'2026-10-10',700000,3,1,'manual',null,'APPROVED',null],
 [11,'2026-10-10',10000,2,null,'manual',null,'APPROVED',null],
 [12,'2026-10-10',700000,1,1,'payment',999,'APPROVED',null]
 ];
 for(const row of rows)await conn.execute("INSERT INTO cash_transactions(id,transaction_date,amount,category_id,site_id,source_type,source_id,approval_status,internal_transfer_key,name) VALUES(?,?,?,?,?,?,?,?,?,'Synthetic test')",row);
 const load=()=>loadActualClosing({db:conn,start:'2026-10-01',end:'2026-10-31',closing:{manual_revenue:999999,manual_expense:999999,manual_carry:5000}});
 let result=await load();assert.deepEqual(result.ledgerSummary,{income:150000,expense:30000,net:120000,count:4,invalid:1});
 assert.equal(result.blocks.other.expense,10000);assert.equal(result.blocks.krwclm.expense,0);
 assert.equal(result.blocks.krwclm.revenue,100000);
 await conn.query('UPDATE cash_transactions SET amount=120000 WHERE id=1');result=await load();assert.equal(result.ledgerSummary.income,170000);
 await conn.query("UPDATE payments SET status='failed' WHERE id=1");result=await load();assert.equal(result.ledgerSummary.income,50000);
 await conn.query("UPDATE cash_transactions SET transaction_date='2026-11-01' WHERE id=7");result=await load();assert.equal(result.ledgerSummary.income,0);
 await conn.query('DELETE FROM cash_transactions');result=await load();assert.equal(result.ledgerSummary.net,0);assert.equal(result.blocks.krwclm.revenue,0);
 console.log('PASS MariaDB actual monthly ledger: month boundaries, pending/failed/orphan/held exclusions, internal/principal exclusions, unmapped locations, live corrections, cancellations and empty-month legacy totals.');
 }finally{conn.release();await db.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
