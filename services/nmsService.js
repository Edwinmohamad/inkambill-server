const db = require('../config/db');
const mt = require('./mikrotikRest');
const { normalize, exemptOf, matchScore, smartSyncPlanFromInventory } = require('./pppoeSyncPlanner');

const EDITABLE_FIELDS = ['name','password','service','profile','local-address','remote-address','caller-id','comment','disabled'];
function bool(value) { return value === true || ['true','yes','on','1'].includes(String(value)); }
function cleanPayload(input = {}) {
  const payload = {};
  for (const key of EDITABLE_FIELDS) {
    if (input[key] === undefined || input[key] === null) continue;
    const value = String(input[key]).trim();
    if (key === 'password' && !value) continue;
    payload[key] = key === 'disabled' ? (bool(input[key]) ? 'true' : 'false') : value;
  }
  payload.service = payload.service || 'pppoe';
  return payload;
}

function statusOf(secret,active) {
  if (bool(secret.disabled) || /isolir|isolate/i.test(secret.profile||'')) return 'isolated';
  return active ? 'online' : 'offline';
}
async function customersForSite(router) {
  const [rows]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.billing_status,c.network_status,c.pppoe_username,c.router_id,c.site_id,p.name package_name,p.speed_label,
    (SELECT COALESCE(SUM(i.outstanding),0) FROM invoices i WHERE i.customer_id=c.id AND i.status IN ('unpaid','partial','overdue')) outstanding
    FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.customer_status='active' AND c.site_id=? ORDER BY c.name`,[router.site_id]);
  return rows;
}

async function syncCustomerStatuses(secretRows) {
  const linked=secretRows.filter(x=>x.customer?.id);
  for(let offset=0;offset<linked.length;offset+=200){
    const chunk=linked.slice(offset,offset+200),cases=chunk.map(()=>`WHEN ? THEN ?`).join(' '),ids=chunk.map(x=>x.customer.id),statusParams=chunk.flatMap(x=>[x.customer.id,x.status]);
    await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>CASE id ${cases} ELSE network_status END,NOW(),status_changed_at),network_status=CASE id ${cases} ELSE network_status END WHERE id IN (${ids.map(()=>'?').join(',')})`,[...statusParams,...statusParams,...ids]);
  }
}

async function routerSnapshot(router) {
  const started=Date.now();
  try {
    // v1.20: dropped mt.listInterfaces() — it only fed the removed "Live Traffic Interface"
    // widget and added an extra RouterOS API round-trip per router on every 15s poll.
    const [resource,secrets,active,profiles,customers]=await Promise.all([mt.testConnection(router),mt.listSecrets(router),mt.listActive(router),mt.listProfiles(router),customersForSite(router)]);
    // Include every active customer from this site in the candidate pool. A stale
    // router_id is exactly one of the conditions Smart Sync must be able to repair.
    // allSnapshots() removes customers that are validly linked on another router.
    const eligibleCustomers=customers;
    const activeMap=new Map(active.map(x=>[normalize(x.name),x])),linkedMap=new Map(eligibleCustomers.filter(x=>x.pppoe_username&&Number(x.router_id)===Number(router.id)).map(x=>[normalize(x.pppoe_username),x]));
    const baseSecretRows=secrets.map(secret=>{
      const session=activeMap.get(normalize(secret.name))||null,customer=linkedMap.get(normalize(secret.name))||null,exempt=customer?null:exemptOf(secret);
      return {...secret,status:statusOf(secret,session),active:session,customer,exempt,suggestions:[]};
    });
    // Pelanggan yang sudah mempunyai pasangan secret valid tidak boleh disarankan ke secret lain.
    const linkedCustomerIds=new Set(baseSecretRows.filter(row=>row.customer).map(row=>String(row.customer.id)));
    const suggestionCustomers=eligibleCustomers.filter(customer=>!linkedCustomerIds.has(String(customer.id)));
    const secretRows=baseSecretRows.map(secret=>secret.customer||secret.exempt?secret:{...secret,suggestions:suggestionCustomers.map(customer=>({customer,score:matchScore(secret,customer)})).filter(item=>item.score>=45).sort((a,b)=>b.score-a.score).slice(0,3)}).sort((a,b)=>a.name.localeCompare(b.name));
    await syncCustomerStatuses(secretRows);
    const secretNames=new Set(secrets.map(x=>normalize(x.name)));
    const unmatchedCustomers=eligibleCustomers.filter(c=>!c.pppoe_username||!secretNames.has(normalize(c.pppoe_username))).map(customer=>{
      const candidates=secretRows.filter(x=>!x.customer&&!x.exempt).map(secret=>({secretId:secret['.id'],secretName:secret.name,score:matchScore(secret,customer)})).filter(x=>x.score>=45).sort((a,b)=>b.score-a.score).slice(0,3);
      return {...customer,suggestions:candidates};
    });
    const counts=secretRows.reduce((a,x)=>{a.total++;a[x.status]++;if(x.customer)a.linked++;else if(x.exempt)a.exempt++;else if(x.suggestions.length)a.suggested++;else a.unlinked++;return a;},{total:0,online:0,offline:0,isolated:0,linked:0,exempt:0,suggested:0,unlinked:0});
    await db.execute(`UPDATE routers SET last_status='online',last_error=NULL,last_seen_at=NOW() WHERE id=?`,[router.id]);
    return {ok:true,id:router.id,name:router.name,siteCode:router.site_code,siteName:router.site_name,latencyMs:Date.now()-started,resource,counts,secrets:secretRows,profiles,unmatchedCustomers};
  } catch(error) {
    await db.execute(`UPDATE routers SET last_status='offline',last_error=? WHERE id=?`,[error.message.slice(0,500),router.id]);
    return {ok:false,id:router.id,name:router.name,siteCode:router.site_code,siteName:router.site_name,error:error.message,latencyMs:Date.now()-started,counts:{total:0,online:0,offline:0,isolated:0,linked:0,exempt:0,suggested:0,unlinked:0},secrets:[],profiles:[],unmatchedCustomers:[]};
  }
}

async function allSnapshots(){
  const [routers]=await db.query(`SELECT r.*,s.code site_code,s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1 ORDER BY s.code,r.name`);
  const snapshots=await Promise.all(routers.map(routerSnapshot));
  const linkedCustomerIds=new Set(snapshots.flatMap(snapshot=>(snapshot.secrets||[]).filter(secret=>secret.customer?.id).map(secret=>String(secret.customer.id))));
  return snapshots.map(snapshot=>{
    if(!snapshot.ok)return snapshot;
    const secrets=(snapshot.secrets||[]).map(secret=>secret.customer||secret.exempt?secret:{...secret,suggestions:(secret.suggestions||[]).filter(item=>!linkedCustomerIds.has(String(item.customer?.id)))});
    const unmatchedCustomers=(snapshot.unmatchedCustomers||[]).filter(customer=>!linkedCustomerIds.has(String(customer.id)));
    const counts=secrets.reduce((a,x)=>{a.total++;a[x.status]++;if(x.customer)a.linked++;else if(x.exempt)a.exempt++;else if(x.suggestions.length)a.suggested++;else a.unlinked++;return a;},{total:0,online:0,offline:0,isolated:0,linked:0,exempt:0,suggested:0,unlinked:0});
    return {...snapshot,secrets,unmatchedCustomers,counts};
  });
}
async function routerById(id){const [rows]=await db.execute(`SELECT r.*,s.code site_code,s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.id=? AND r.is_active=1`,[id]);if(!rows.length)throw new Error('Router tidak ditemukan atau tidak aktif');return rows[0];}
async function customerForRouter(router,customerId){const [rows]=await db.execute(`SELECT id,site_id,router_id,name,customer_code,pppoe_username,network_status FROM customers WHERE id=? AND customer_status='active'`,[customerId]);if(!rows.length)throw new Error('Pelanggan billing tidak ditemukan');if(Number(rows[0].site_id)!==Number(router.site_id))throw new Error('Site pelanggan dan router harus sama');return rows[0];}

async function saveSecret(routerId,secretId,input,customerId,options={}){const router=await routerById(routerId),payload=cleanPayload(input);if(!payload.name)throw new Error('Username PPPoE wajib diisi');const customer=customerId?await customerForRouter(router,customerId):null;if(secretId)await mt.updateSecret(router,secretId,payload);else{if(!payload.password)throw new Error('Password wajib diisi untuk secret baru');await mt.createSecret(router,payload);}if(customer){const status=bool(payload.disabled)?'isolated':'offline',conn=await db.getConnection();try{await conn.beginTransaction();const [duplicate]=await conn.execute(`SELECT id,name FROM customers WHERE router_id=? AND LOWER(TRIM(pppoe_username))=LOWER(TRIM(?)) AND id<>? AND customer_status='active' LIMIT 1 FOR UPDATE`,[router.id,payload.name,customer.id]);if(duplicate.length)throw new Error(`Username PPPoE sudah terhubung ke ${duplicate[0].name} pada router ini.`);await conn.execute(`UPDATE customers SET status_changed_at=IF(network_status<>?,NOW(),status_changed_at),router_id=?,pppoe_username=?,pppoe_synced_at=NOW(),pppoe_sync_source='secret_form',network_status=? WHERE id=?`,[status,router.id,payload.name,status,customer.id]);await conn.execute(`INSERT INTO pppoe_sync_logs(customer_id,router_id,secret_id,secret_name,previous_router_id,previous_username,sync_source,status,created_by) VALUES(?,?,?,?,?,?, 'secret_form','success',?)`,[customer.id,router.id,secretId||null,payload.name,customer.router_id||null,customer.pppoe_username||null,options.userId||null]);await conn.commit();}catch(error){await conn.rollback();throw new Error(`Secret MikroTik sudah diperbarui, tetapi link pelanggan gagal disimpan: ${error.message}`);}finally{conn.release();}}return {router,payload,customer};}
async function syncSecret(routerId,secretId,customerId,options={}){
  const source=['manual','smart','secret_form','status_refresh'].includes(options.source)?options.source:'manual';
  const router=await routerById(routerId),customer=await customerForRouter(router,customerId),secret=await mt.getSecret(router,secretId);
  if(!secret?.name)throw new Error('PPPoE secret tidak ditemukan');
  const active=await mt.findActive(router,secret.name);
  const lockName=`inkam_pppoe_site_${router.site_id}`;
  const conn=await db.getConnection();let locked=false;
  try{
    const [[lock]]=await conn.execute(`SELECT GET_LOCK(?,8) locked`,[lockName]);locked=Number(lock?.locked)===1;if(!locked)throw new Error('Sinkronisasi secret sedang diproses pengguna lain. Coba lagi.');
    await conn.beginTransaction();
    const [freshRows]=await conn.execute(`SELECT id,name,customer_code,site_id,router_id,pppoe_username FROM customers WHERE id=? AND customer_status='active' FOR UPDATE`,[customer.id]);
    const fresh=freshRows[0];if(!fresh)throw new Error('Pelanggan sudah tidak aktif.');if(Number(fresh.site_id)!==Number(router.site_id))throw new Error('Site pelanggan dan router tidak sama.');
    const [existing]=await conn.execute(`SELECT id,name FROM customers WHERE router_id=? AND LOWER(TRIM(pppoe_username))=LOWER(TRIM(?)) AND id<>? AND customer_status='active' LIMIT 1 FOR UPDATE`,[router.id,secret.name,fresh.id]);
    if(existing.length)throw new Error(`Username PPPoE sudah terhubung ke ${existing[0].name} pada router yang sama.`);
    const status=statusOf(secret,active);
    await conn.execute(`UPDATE customers SET status_changed_at=IF(network_status<>?,NOW(),status_changed_at),router_id=?,pppoe_username=?,pppoe_synced_at=NOW(),pppoe_sync_source=?,network_status=? WHERE id=?`,[status,router.id,secret.name,source,status,fresh.id]);
    const [verified]=await conn.execute(`SELECT router_id,pppoe_username,pppoe_synced_at,pppoe_sync_source,network_status FROM customers WHERE id=? FOR UPDATE`,[fresh.id]);
    if(!verified.length||Number(verified[0].router_id)!==Number(router.id)||normalize(verified[0].pppoe_username)!==normalize(secret.name))throw new Error('Verifikasi penyimpanan link PPPoE gagal.');
    await conn.execute(`INSERT INTO pppoe_sync_logs(customer_id,router_id,secret_id,secret_name,previous_router_id,previous_username,sync_source,match_score,status,created_by) VALUES(?,?,?,?,?,?,?,?, 'success',?)`,[fresh.id,router.id,String(secretId),secret.name,fresh.router_id||null,fresh.pppoe_username||null,source,options.score==null?null:Math.max(0,Math.min(100,Number(options.score))),options.userId||null]);
    await conn.commit();return {router,secret,customer:{...customer,...fresh},persisted:verified[0],active:!!active};
  }catch(error){try{await conn.rollback();}catch(_){}try{await conn.execute(`INSERT INTO pppoe_sync_logs(customer_id,router_id,secret_id,secret_name,previous_router_id,previous_username,sync_source,match_score,status,error_message,created_by) VALUES(?,?,?,?,?,?,?,?, 'failed',?,?)`,[customer.id,router.id,String(secretId),secret.name,customer.router_id||null,customer.pppoe_username||null,source,options.score==null?null:Math.max(0,Math.min(100,Number(options.score))),String(error.message||error).slice(0,1000),options.userId||null]);}catch(_){}throw error;}finally{if(locked){try{await conn.execute(`SELECT RELEASE_LOCK(?)`,[lockName]);}catch(_){}}conn.release();}
}

async function removeSecret(routerId,secretId){const router=await routerById(routerId),result=await mt.deleteSecret(router,secretId);const [linked]=await db.execute(`SELECT id,customer_code,name FROM customers WHERE router_id=? AND pppoe_username=?`,[router.id,result.secret.name]);await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'offline',NOW(),status_changed_at),pppoe_username=NULL,network_status='offline' WHERE router_id=? AND pppoe_username=?`,[router.id,result.secret.name]);return {router,...result,linkedCustomers:linked};}
async function disconnectSecret(routerId,secretId){const router=await routerById(routerId),result=await mt.disconnectSecret(router,secretId);if(result.disconnected)await db.execute(`UPDATE customers SET status_changed_at=IF(network_status<>'offline',NOW(),status_changed_at),network_status='offline' WHERE router_id=? AND pppoe_username=?`,[router.id,result.secret.name]);return {router,...result};}
async function customersForRouter(routerId){const router=await routerById(routerId);return customersForSite(router);}
async function customersForSync(){
  const [rows]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.site_id,c.router_id,c.pppoe_username,c.network_status,s.code site_code,s.name site_name,r.name router_name,p.name package_name
    FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN routers r ON r.id=c.router_id LEFT JOIN packages p ON p.id=c.package_id
    WHERE c.customer_status='active' ORDER BY s.code,c.name`);
  return rows;
}

async function syncActiveCustomers(siteCode=''){
  const scopedSite=String(siteCode||'').trim().toUpperCase();
  let routerSql=`SELECT r.*,s.code site_code,s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1`;
  const routerParams=[];
  if(scopedSite){routerSql+=` AND s.code=?`;routerParams.push(scopedSite);}
  routerSql+=` ORDER BY s.code,r.name`;
  const [routers]=await db.execute(routerSql,routerParams);
  if(scopedSite&&!routers.length)throw new Error(`Router aktif untuk site ${scopedSite} tidak ditemukan.`);

  const routerData=await Promise.all(routers.map(async router=>{
    try{
      const [secrets,active]=await Promise.all([mt.listSecrets(router),mt.listActive(router)]);
      const activeNames=new Set(active.map(row=>normalize(row.name)));
      return {ok:true,router,secrets,activeNames};
    }catch(error){
      return {ok:false,router,error:error.message};
    }
  }));

  const secretIndex=new Map();
  for(const item of routerData.filter(row=>row.ok)){
    for(const secret of item.secrets){
      const name=normalize(secret.name);if(!name)continue;
      const key=`${item.router.site_id}:${name}`;
      const entries=secretIndex.get(key)||[];
      entries.push({router:item.router,secret,status:statusOf(secret,item.activeNames.has(name))});
      secretIndex.set(key,entries);
    }
  }

  let customerSql=`SELECT c.id,c.customer_code,c.name,c.site_id,c.pppoe_username,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.customer_status='active'`;
  const customerParams=[];
  if(scopedSite){customerSql+=` AND s.code=?`;customerParams.push(scopedSite);}
  customerSql+=` ORDER BY s.code,c.name`;
  const [customers]=await db.execute(customerSql,customerParams);
  const summary={scope:scopedSite||'Semua Site',routers:routers.length,routerFailures:routerData.filter(row=>!row.ok).length,customers:customers.length,matched:0,online:0,offline:0,isolated:0,unconfigured:0,unmatched:0,duplicate:0};
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    for(const customer of customers){
      const username=normalize(customer.pppoe_username);
      if(!username){summary.unconfigured++;continue;}
      const matches=secretIndex.get(`${customer.site_id}:${username}`)||[];
      if(matches.length===0){summary.unmatched++;continue;}
      if(matches.length>1){summary.duplicate++;continue;}
      const match=matches[0];
      await conn.execute(`UPDATE customers SET status_changed_at=IF(network_status<>?,NOW(),status_changed_at),router_id=?,network_status=? WHERE id=?`,[match.status,match.router.id,match.status,customer.id]);
      summary.matched++;summary[match.status]=(summary[match.status]||0)+1;
    }
    await conn.commit();
  }catch(error){await conn.rollback();throw error;}finally{conn.release();}
  summary.failures=routerData.filter(row=>!row.ok).map(row=>`${row.router.site_code} / ${row.router.name}: ${row.error}`);
  return summary;
}

function smartSyncPlanFromSnapshots(snapshots,siteCode=''){
  const scope=String(siteCode||'').trim().toUpperCase(),customers=new Map();
  for(const snapshot of snapshots||[]){
    if(scope&&String(snapshot.siteCode||'').trim().toUpperCase()!==scope)continue;
    for(const customer of snapshot.unmatchedCustomers||[]){
      const key=String(customer.id),row=customers.get(key)||{...customer,siteCode:snapshot.siteCode,suggestions:[]};
      for(const suggestion of customer.suggestions||[]){
        const candidate={...suggestion,routerId:snapshot.id,routerName:snapshot.name,siteCode:snapshot.siteCode};
        if(!row.suggestions.some(item=>String(item.routerId)===String(candidate.routerId)&&String(item.secretId)===String(candidate.secretId)))row.suggestions.push(candidate);
      }
      customers.set(key,row);
    }
  }
  const rows=[...customers.values()].map(customer=>{
    const suggestions=[...(customer.suggestions||[])].sort((a,b)=>Number(b.score||0)-Number(a.score||0)||String(a.secretName||'').localeCompare(String(b.secretName||''))),top=suggestions[0]||null,second=suggestions[1]||null;
    const registered=normalize(customer.pppoe_username),topName=normalize(top?.secretName),registeredOk=!registered||registered===topName;
    const safe=!!top&&Number(top.score||0)>=90&&registeredOk&&(!second||Number(top.score||0)-Number(second.score||0)>=8);
    return {...customer,suggestions,top,second,safe,review:!!top&&!safe,reason:!top?'no_candidate':!registeredOk?'registered_username_differs':Number(top.score||0)<90?'score_below_90':second&&Number(top.score||0)-Number(second.score||0)<8?'ambiguous':'safe'};
  });
  const secretOwners=new Map();
  for(const row of rows.filter(item=>item.safe)){const key=`${row.top.routerId}:${row.top.secretId}`,owners=secretOwners.get(key)||[];owners.push(row.id);secretOwners.set(key,owners);}
  for(const row of rows){if(!row.safe)continue;const key=`${row.top.routerId}:${row.top.secretId}`;if((secretOwners.get(key)||[]).length>1){row.safe=false;row.review=true;row.reason='secret_conflict';}}
  const safe=rows.filter(row=>row.safe),review=rows.filter(row=>row.review),unmatched=rows.filter(row=>!row.top);
  return {scope:scope||'ALL',rows,safe,review,unmatched,counts:{total:rows.length,safe:safe.length,review:review.length,unmatched:unmatched.length}};
}
async function loadSmartSyncInventory(siteCode=''){
  const scope=String(siteCode||'').trim().toUpperCase();
  let routerSql=`SELECT r.*,s.code site_code,s.name site_name FROM routers r JOIN sites s ON s.id=r.site_id WHERE r.is_active=1`,customerSql=`SELECT c.id,c.customer_code,c.name,c.site_id,c.router_id,c.pppoe_username,c.network_status,p.name package_name,s.code site_code,s.name site_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN packages p ON p.id=c.package_id WHERE c.customer_status='active'`,params=[];
  if(scope){routerSql+=` AND s.code=?`;customerSql+=` AND s.code=?`;params=[scope];}
  routerSql+=` ORDER BY s.code,r.name`;customerSql+=` ORDER BY s.code,c.name`;
  const [[routers],[customers]]=await Promise.all([db.execute(routerSql,params),db.execute(customerSql,params)]);
  if(scope&&!routers.length)throw new Error(`Router aktif untuk site ${scope} tidak ditemukan.`);
  const routerResults=await Promise.all(routers.map(async router=>{try{return {ok:true,router,secrets:await mt.listSecrets(router)};}catch(error){return {ok:false,router,secrets:[],error:error.message};}}));
  return {routers,customers,routerResults};
}
async function smartSyncPlan(siteCode=''){return smartSyncPlanFromInventory(await loadSmartSyncInventory(siteCode),siteCode);}
async function applySmartSync(siteCode='',options={}){
  const plan=await smartSyncPlan(siteCode),results=[];
  for(const row of plan.safe.slice(0,100)){
    try{const result=await syncSecret(row.top.routerId,row.top.secretId,row.id,{source:'smart',score:Number(row.top.score||0),userId:options.userId||null});results.push({ok:true,customerId:row.id,customerCode:row.customer_code,customerName:row.name,secretName:result.secret.name,routerName:result.router.name,score:Number(row.top.score||0),reason:row.reason,persisted:true});}
    catch(error){results.push({ok:false,customerId:row.id,customerCode:row.customer_code,customerName:row.name,secretName:row.top.secretName,routerName:row.top.routerName,score:Number(row.top.score||0),error:error.message});}
  }
  return {scope:plan.scope,planned:plan.safe.length,processed:results.length,succeeded:results.filter(row=>row.ok).length,failed:results.filter(row=>!row.ok).length,routerFailures:plan.routerFailures,results};
}

module.exports={allSnapshots,routerById,saveSecret,syncSecret,removeSecret,disconnectSecret,customersForRouter,customersForSync,syncActiveCustomers,smartSyncPlan,applySmartSync,smartSyncPlanFromSnapshots,smartSyncPlanFromInventory,cleanPayload,matchScore,exemptOf};
