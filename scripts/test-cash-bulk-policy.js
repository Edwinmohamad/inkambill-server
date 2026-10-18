const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('routes/finance.js','utf8');
const policy=source.slice(source.indexOf('function assertManualCash('),source.indexOf('const MONTH_NAMES_ID'));
const base={id:1,name:'Manual',source_type:'manual',approval_status:'PENDING_APPROVAL',transaction_date:'2026-10-18'};
async function run({route='/cash/bulk',rows=[base],action='delete',role='master_admin',locked=false,auditFails=false,ids=['1']}={}){
 const events=[];let handler;
 const conn={beginTransaction:async()=>events.push('begin'),execute:async(sql,args)=>{if(sql.startsWith('SELECT')){assert(sql.includes('FOR UPDATE'));return [rows];}events.push(`delete:${args[0]}`);return [{affectedRows:1}];},commit:async()=>events.push('commit'),rollback:async()=>events.push('rollback'),release:()=>events.push('release')};
 const start=source.indexOf(`router.post('${route}'`),end=source.indexOf('\n});',start)+4;
 vm.runInNewContext(policy+source.slice(start,end),{router:{post:(_p,_guard,h)=>handler=h},requireAdmin:()=>{},db:{getConnection:async()=>conn},isMasterAdminRole:r=>r==='master_admin',cashReturn:()=>'/cash',intInRange:(v,_a,_b,f)=>Number(v)||f,assertDateOpen:async()=>{if(locked)throw Error('locked');},financialAudit:async()=>{events.push('audit');if(auditFails)throw Error('audit failed');},removeCashProof:async()=>events.push('proof')});
 const req={body:{cash_ids:ids,action},query:{},params:{id:'1'},session:{user:{id:1,role}},ip:'test'};
 await handler(req,{redirect:()=>{}});return {events,flash:req.session.flash};
}
(async()=>{
 let n=0;
 for(const route of ['/cash/bulk','/cash/:id/delete','/cash/delete-all']){
  for(const bad of [{source_type:'payment'},{internal_transfer_key:'PAIR'},{warehouse_purchase_id:8},{warehouse_transfer_id:9}]){const r=await run({route,rows:[{...base,...bad}]});assert.equal(r.flash.type,'danger');assert(!r.events.some(e=>e.startsWith('delete:')));n++;}
  for(const opts of [{locked:true},{auditFails:true}]){const r=await run({route,...opts});assert.equal(r.flash.type,'danger');assert(r.events.includes('rollback'));assert(!r.events.includes('commit'));n++;}
  const ok=await run({route});assert.equal(ok.flash.type,'success');assert.deepEqual(ok.events,['begin','audit','delete:1','commit','release']);n++;
 }
 let r=await run({action:'force_delete',rows:[{...base,approval_status:'APPROVED'}]});assert.equal(r.flash.type,'success');n++;
 r=await run({action:'force_delete',role:'admin'});assert.equal(r.flash.type,'danger');assert.equal(r.events.length,0);n++;
 r=await run({rows:[base,{...base,id:2,approval_status:'APPROVED'}],ids:['1','2']});assert.equal(r.flash.type,'success');assert(!r.events.includes('delete:2'));n++;
 r=await run({rows:[base,{...base,id:2,internal_transfer_key:'PAIR'}],ids:['1','2']});assert.equal(r.flash.type,'danger');assert(!r.events.includes('delete:1'));n++;
 console.log(`Cash bulk/single/period policy: ${n} scenarios PASS`);
})().catch(e=>{console.error(e);process.exitCode=1;});
