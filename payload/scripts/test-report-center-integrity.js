const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm');
const {numbered,groupReportRows,integrityWarnings}=require('../services/reportDataService');
const groups=groupReportRows('cash',[
 {site_code:'KRW',category:'Pelanggan',type:'income',amount:100},
 {site_code:'KRW',category:'Peralihan Barang',type:'income',amount:50},
 {site_code:'CLM',category:'Pelanggan',type:'income',amount:75},
 {site_code:'KRW',category:'Material',type:'expense',amount:20}
]);
assert.equal(groups.reduce((s,g)=>s+g.income,0),225);
assert.equal(groups.reduce((s,g)=>s+g.expense,0),20);
assert.equal(groups.length,4);
assert.deepEqual(numbered([{id:1},{id:2}]).map(r=>r.row_no),[1,2]);
assert.equal(integrityWarnings('billing',[{total:100,paid_amount:30,outstanding:70}]).length,0);
assert.equal(integrityWarnings('billing',[{total:100,paid_amount:30,outstanding:80}]).length,1);
const routes={},queries=[];
const cashRows=[{id:1,transaction_date:'2026-09-05',name:'Fadilah [C1]',category:'Pendapatan Billing',type:'income',site_code:'KRW',amount:100}];
const invoiceRows=[{id:1,invoice_number:'INV-1',customer_code:'C1',customer_name:'Fadilah',site_code:'KRW',total:100,paid_amount:30,outstanding:70,status:'partial'}];
const db={execute:async(sql,params)=>{
 queries.push({sql,params});
 if(sql.includes('FROM cash_transactions')){assert(sql.includes("p.status='confirmed'"));assert(sql.includes("p.settlement_status='settled'"));assert(!sql.includes('is_system'));return [cashRows];}
 if(sql.includes('FROM invoices')){assert(sql.includes('i.archived_at IS NULL'));assert(sql.includes('c.archived_at IS NULL'));return [invoiceRows];}
 return [[]];
}};
const context={require:n=>n==='express'?{Router:()=>({get:(path,fn)=>{routes[path]=fn;}})}:n==='../config/db'?db:require(n.startsWith('../')?require.resolve(n):n),module:{exports:{}},URLSearchParams,Intl,Date,Number,console};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../routes/reports'),'utf8')+'\nthis.api={common,buildReportPayload};',context);
(async()=>{
 const req={query:{type:'billing',month:9,year:2026,dueFrom:'2026-09-15',dueTo:'2026-09-30'}};
 const f=context.api.common(req);assert.equal(f.dueFrom,'2026-09-15');
 const payload=await context.api.buildReportPayload(req);
 assert.equal(payload.rows[0].row_no,1);assert.equal(payload.columns[0].key,'row_no');
 assert(payload.columns.some(c=>c.label==='Terbayar'));
 assert(queries.at(-1).params.includes('2026-09-15'));
 const cash=await context.api.buildReportPayload({query:{type:'cash',from:'2026-09-01',to:'2026-09-30'}});
 assert.equal(cash.reportGroups[0].income,100);
 assert(!cash.columns.some(c=>c.total),'cash receipts and expenses must not be added into an unlabeled combined total');
 let txt='';const response={setHeader:()=>{},send:b=>{txt=b;}};
 await routes['/txt']({query:{type:'billing',month:9,year:2026}},response);
 assert(txt.includes('RINCIAN LENGKAP'));assert(txt.includes('No. 1'));assert(txt.includes('Terbayar'));
 console.log('Report center tests passed: numbering, category/site totals, archive scope, payment eligibility, due-filter export, full TXT details and amount reconciliation warnings.');
})().catch(e=>{console.error(e);process.exitCode=1;});
