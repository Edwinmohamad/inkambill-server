const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const {emptyBillingMonitor}=require('../services/dashboardBillingMonitorService');
(async()=>{
 const route=fs.readFileSync('routes/dashboard.js','utf8');
 const start=route.indexOf('const billingOptions='),end=route.indexOf('\n\n  const [[customerStats]]',start);
 const result=await vm.runInNewContext(`(async()=>{${route.slice(start,end)};return await billingMonitorPromise;})()`,{selectedMonth:10,selectedYear:2026,siteId:null,selectedCycle:'all',trendMonths:6,selectedIncomeDate:'2026-10-18',now:new Date('2026-10-18T10:00:00Z'),loadDashboardBillingMonitor:async()=>{throw Error('DB unavailable');},emptyBillingMonitor,console:{error:()=>{}}});
 assert.equal(result.unavailable,true);assert.equal(result.trend.labels.length,6);assert(result.progress.labels.length>0);assert.equal(result.cycles['15'].paidCount,0);
 for(const tz of ['UTC','Asia/Jakarta','America/Los_Angeles']){
  const out=execFileSync(process.execPath,['-e',"const s=require('./services/waTemplateService');console.log(s.formatDateIndo('2026-10-20'));console.log(s.formatDateIndo('2026-10-19T18:00:00Z'));console.log(s.formatDateIndo('2026-10-32'));"],{env:{...process.env,TZ:tz},encoding:'utf8'}).trim().split('\n');
  assert.deepEqual(out,['20 Oktober 2026','20 Oktober 2026','2026-10-32']);
 }
 const fin=fs.readFileSync('routes/finance.js','utf8'),reports=fs.readFileSync('routes/reports.js','utf8');
 assert(fin.includes("WHERE ct.internal_transfer_key IS NULL"));
 assert(reports.includes("where.push('ct.internal_transfer_key IS NULL')"));
 const view=fs.readFileSync('views/finance/cash.ejs','utf8');assert(view.includes('if(!editable)'));assert(!view.includes('Boleh diedit/dihapus manual seperti transaksi kas biasa'));
 console.log('Audit regressions: billing failure fallback, dates in 3 timezones, consolidated transfers and cash UI PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
