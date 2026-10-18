const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('routes/finance.js','utf8');
const start = source.indexOf("router.post('/cash/:id/force-delete'");
const end = source.indexOf('\n});',start)+4;
async function run({sourceType='manual',status='APPROVED',locked=false,auditFails=false}={}) {
  const events=[];let handler;
  const conn={beginTransaction:async()=>events.push('begin'),execute:async sql=>{
    if(sql.startsWith('SELECT'))return [[{id:1,name:'Test',transaction_date:'2026-10-18',source_type:sourceType,approval_status:status}]];
    events.push('delete');return [{affectedRows:1}];
  },commit:async()=>events.push('commit'),rollback:async()=>events.push('rollback'),release:()=>events.push('release')};
  vm.runInNewContext(source.slice(start,end),{router:{post:(_p,_guard,h)=>handler=h},requireMasterAdmin:()=>{},cashReturn:()=>'/cash',db:{getConnection:async()=>conn},assertDateOpen:async()=>{if(locked)throw Error('locked');},financialAudit:async data=>{assert.equal(data.before.approval_status,status);events.push('audit');if(auditFails)throw Error('audit failed');},audit:async()=>{},removeCashProof:async()=>{}});
  const req={params:{id:'1'},query:{},body:{},session:{user:{id:1}},ip:'127.0.0.1'};
  await handler(req,{redirect:()=>{}});return {events,flash:req.session.flash};
}
(async()=>{
  for(const status of ['APPROVED','PENDING_APPROVAL','REJECTED']){const r=await run({status});assert.equal(r.flash.type,'success');assert.deepEqual(r.events,['begin','audit','delete','commit','release']);}
  for(const opts of [{sourceType:'payment'},{locked:true},{auditFails:true}]){const r=await run(opts);assert.equal(r.flash.type,'danger');assert(!r.events.includes('delete'));assert(r.events.includes('rollback'));}
  assert(source.slice(start,end).includes('requireMasterAdmin'));
  console.log('Cash force delete: 7 regression cases passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
