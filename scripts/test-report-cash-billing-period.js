const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const text = fs.readFileSync(require('node:path').join(__dirname,'../routes/reports.js'),'utf8');
const fn = text.slice(text.indexOf('async function cashReport('),text.indexOf("router.get('/',"));
const rows = [
 {id:1, year:2026, month:10, date:'2026-11-05', approved:true, confirmed:true, settled:true},
 {id:2, year:2026, month:11, date:'2026-11-05', approved:true, confirmed:true, settled:true},
 {id:3, date:'2026-10-15', approved:true},
 {id:4, year:2026, month:10, date:'2026-11-04', approved:true, confirmed:true, settled:false},
 {id:5, year:2026, month:10, date:'2026-11-04', approved:false, confirmed:true, settled:true}
];
const db = {async execute(sql, params) {
 assert.match(sql,/source_invoice\.period_year\*100\+source_invoice\.period_month/);
 assert.match(sql,/source_invoice\.id IS NULL AND ct\.transaction_date BETWEEN/);
 assert.match(sql,/p\.settlement_status='settled'/);
 const [first,last,from,to] = params;
 return [rows.filter(r => r.approved && (!r.year || r.confirmed && r.settled) &&
   (r.year ? r.year*100+r.month >= first && r.year*100+r.month <= last : r.date >= from && r.date <= to))];
}};
const ctx = {db}; vm.createContext(ctx); vm.runInContext(fn+'\nthis.cashReport = cashReport;',ctx);
const filters = (from,to) => ({from,to,site:'',category:'',flow_type:'',method:''});
(async()=>{
 const oct=await ctx.cashReport(filters('2026-10-01','2026-10-31'));
 const nov=await ctx.cashReport(filters('2026-11-01','2026-11-30'));
 assert.deepEqual(Array.from(oct,r=>r.id),[1,3]);
 assert.deepEqual(Array.from(nov,r=>r.id),[2]);
 console.log('PASS cash report uses invoice period and transaction date');
})().catch(e=>{console.error(e);process.exitCode=1;});
