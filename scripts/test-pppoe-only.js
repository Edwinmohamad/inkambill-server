'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

(async()=>{
  const calls=[],writes=[],snapshots=[];
  const routers=[{id:1,pppoe_enabled:1},{id:2,pppoe_enabled:1},{id:3,pppoe_enabled:0},{id:4,pppoe_enabled:1}];
  const store={
    activeRouters:async site=>{calls.push(['routers',site]);return routers;},
    syncRouterSecrets:async router=>{calls.push(['secrets',router.id]);if(router.id===2)throw Error('Router unreachable');return {routerId:router.id,secrets:2};},
    applyActive:async(router,active)=>snapshots.push({id:router.id,active})
  };
  const ros={active:async router=>{calls.push(['active',router.id]);if(router.id===4)throw Error('Active access denied');return [{name:'pelanggan-a'}];}};
  const db={execute:async(sql,args)=>{writes.push({sql,args});return [{}];},query:async()=>[[{id:7,code:'KBG',name:'Kubang'}]]};
  const context={module:{exports:{}},require:name=>{
    if(name==='../../config/db')return db;
    if(name==='./secretStore')return store;
    if(name==='./rosApi')return ros;
    throw Error('Unexpected dependency '+name);
  },setInterval:()=>{throw Error('Background polling is forbidden');},setTimeout:()=>{throw Error('Background polling is forbidden');}};
  vm.runInNewContext(read('services/nms/inventory.js'),context);
  assert.equal(calls.length,0,'loading the inventory must not contact routers');
  const results=await context.module.exports.refreshSecrets(7);
  assert.deepEqual(calls[0],['routers',7]);
  assert.equal(results.length,3);
  assert.equal(results[0].ok,true);
  assert.equal(results[1].ok,false);
  assert.equal(results[1].error,'Router unreachable');
  assert.equal(results[2].ok,true);
  assert.equal(results[2].activeWarning,'Active access denied');
  assert.deepEqual(snapshots.map(item=>item.id),[1],'failed router/session reads must not overwrite cached active sessions');
  assert(!calls.some(item=>item[1]===3),'non-PPPoE routers must be skipped');
  assert(writes.every(item=>/^UPDATE routers SET/.test(item.sql)),'inventory status failures must not delete customer mappings');

  const inventoryPath=require.resolve('../services/nms/inventory');
  let refreshCalls=0;
  require.cache[inventoryPath]={id:inventoryPath,filename:inventoryPath,loaded:true,exports:{sites:async()=>[],refreshSecrets:async site=>{refreshCalls++;assert.equal(site,7);return [{ok:true,routerId:1}];}}};
  const auditPath=require.resolve('../services/auditService');
  require.cache[auditPath]={id:auditPath,filename:auditPath,loaded:true,exports:{audit:async()=>{}}};
  const router=require('../routes/nms');
  const routes=router.stack.filter(layer=>layer.route).map(layer=>layer.route);
  for(const endpoint of ['/api/secrets/refresh','/api/sync/preview','/api/sync/commit','/api/secrets/:id/map','/api/reconcile','/api/excel/preview','/api/excel/apply','/api/sync/batches/:id/undo'])assert(routes.some(route=>route.path===endpoint),endpoint);
  for(const endpoint of ['/api/dashboard','/api/widgets','/api/stream','/api/health','/api/flapping','/api/secrets/:id/traffic','/api/schedules'])assert(!routes.some(route=>route.path===endpoint),endpoint+' must be removed');
  const refresh=routes.find(route=>route.path==='/api/secrets/refresh');
  let status=200,body;
  const response={set(){return this;},status(value){status=value;return this;},json(value){body=value;return this;}};
  refresh.stack[0].handle({session:{user:{role:'cashier'}},permissions:['network']},response,()=>{throw Error('Unauthorized refresh allowed');});
  assert.equal(status,403);assert.equal(refreshCalls,0);
  const apiHandler=refresh.stack.at(-1).handle;
  const admin={query:{site:'7'},body:{},session:{user:{id:1,role:'master_admin'}},ip:'test'};
  let allowed=false;refresh.stack[0].handle(admin,response,()=>allowed=true);assert(allowed);
  status=200;await apiHandler(admin,response);assert.equal(body.ok,true);assert.equal(status,200);
  // This handler also audits; bypassing the role gate is not used by the app.
  assert.equal(refreshCalls,1);
  assert(!Object.keys(require.cache).some(file=>file.endsWith('/nms/poller.js')));
  assert(!read('app.js').includes('nmsPoller.start()'));
  assert(!read('public/js/nms-common.js').includes('new EventSource'));
  assert(read('app.js').includes('await runAutoIsolation()'),'billing isolation must remain available');
  console.log('PASS PPPoE-only: no background polling, scoped refresh, failed-router safety, retained mapping/reconciliation routes and authorization.');
})().catch(error=>{console.error(error);process.exitCode=1;});
