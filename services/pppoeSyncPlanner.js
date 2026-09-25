const EXEMPT_RULES = [
  {type:'admin',label:'Admin / Infrastruktur',pattern:/\b(admin|administrator|noc|monitor(?:ing)?|router|server|uptime|teknisi|technical|support|staff)\b/i},
  {type:'free',label:'Free / Internal',pattern:/\b(free|gratis|complimentary|sponsor|internal|owner)\b/i}
];

function normalize(value) { return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function tokens(value) { return new Set(normalize(value).split(' ').filter(x=>x.length>=3)); }
function exemptOf(secret) {
  const text=[secret.name,secret.profile,secret.comment].join(' ');
  return EXEMPT_RULES.find(rule=>rule.pattern.test(text)) || null;
}
function matchScore(secret,customer) {
  const username=normalize(secret.name),comment=normalize(secret.comment),name=normalize(customer.name),code=normalize(customer.customer_code),registered=normalize(customer.pppoe_username);
  if (registered && username===registered) return 100;
  if (username && username===name) return 99;
  if (username && name && username.replace(/ /g,'')===name.replace(/ /g,'')) return 98;
  if (username && (username===code || comment.includes(code))) return 96;
  let score=0;
  if (username.length>=4 && name.replace(/ /g,'').includes(username.replace(/ /g,''))) score=82;
  if (name.length>=4 && username.replace(/ /g,'').includes(name.replace(/ /g,''))) score=Math.max(score,82);
  if ((comment.includes(name) || name.includes(comment)) && comment.length>=5) score=Math.max(score,88);
  const a=tokens(`${secret.name} ${secret.comment}`),b=tokens(`${customer.name} ${customer.customer_code}`),common=[...a].filter(x=>b.has(x)).length;
  if (common) score=Math.max(score,Math.round(common/Math.max(a.size,b.size)*75)+20);
  const digits=value=>(normalize(value).match(/\d+/g)||[]).join('');
  if (digits(secret.name) && digits(secret.name)===digits(customer.customer_code)) score=Math.max(score,90);
  return Math.min(score,100);
}

function smartSyncPlanFromInventory(inventory,siteCode=''){
  const scope=String(siteCode||'').trim().toUpperCase();
  const routerResults=(inventory.routerResults||[]).filter(item=>!scope||String(item.router?.site_code||'').trim().toUpperCase()===scope);
  const successful=routerResults.filter(item=>item.ok),failed=routerResults.filter(item=>!item.ok);
  const secretRows=successful.flatMap(item=>(item.secrets||[]).map(secret=>({secret,router:item.router,key:`${item.router.id}:${normalize(secret.name)}`})));
  const customers=(inventory.customers||[]).filter(customer=>!scope||String(customer.site_code||'').trim().toUpperCase()===scope);
  const validOwners=new Map();
  for(const customer of customers){
    if(!customer.router_id||!normalize(customer.pppoe_username))continue;
    const key=`${customer.router_id}:${normalize(customer.pppoe_username)}`;
    if(secretRows.some(row=>row.key===key))validOwners.set(key,String(customer.id));
  }
  const rows=[];
  for(const customer of customers){
    const currentKey=customer.router_id&&normalize(customer.pppoe_username)?`${customer.router_id}:${normalize(customer.pppoe_username)}`:'';
    if(currentKey&&validOwners.get(currentKey)===String(customer.id))continue;
    const unavailableSite=failed.some(item=>Number(item.router?.site_id)===Number(customer.site_id));
    const suggestions=secretRows
      .filter(row=>Number(row.router.site_id)===Number(customer.site_id)&&!exemptOf(row.secret)&&(!validOwners.has(row.key)||validOwners.get(row.key)===String(customer.id)))
      .map(row=>({secretId:row.secret['.id'],secretName:row.secret.name,profile:row.secret.profile||'default',comment:row.secret.comment||'',score:matchScore(row.secret,customer),routerId:row.router.id,routerName:row.router.name,siteCode:row.router.site_code}))
      .filter(item=>item.score>=45)
      .sort((a,b)=>Number(b.score||0)-Number(a.score||0)||String(a.secretName||'').localeCompare(String(b.secretName||'')));
    const top=suggestions[0]||null,second=suggestions[1]||null,registered=normalize(customer.pppoe_username),topName=normalize(top?.secretName),gap=top&&second?Number(top.score||0)-Number(second.score||0):100;
    const exactRegistered=!registered||registered===topName;
    const staleRepair=!!registered&&registered!==topName&&Number(top?.score||0)>=96&&gap>=10;
    const safe=!unavailableSite&&!!top&&Number(top.score||0)>=90&&(exactRegistered||staleRepair)&&gap>=8;
    rows.push({...customer,siteCode:customer.site_code,suggestions,top,second,safe,review:!!top&&!safe,reason:unavailableSite?'router_unreachable':!top?'no_candidate':!exactRegistered&&!staleRepair?'registered_username_differs':Number(top.score||0)<90?'score_below_90':gap<8?'ambiguous':staleRepair?'stale_mapping_repair':'safe'});
  }
  const secretOwners=new Map();
  for(const row of rows.filter(item=>item.safe)){const key=`${row.top.routerId}:${row.top.secretId}`,owners=secretOwners.get(key)||[];owners.push(row.id);secretOwners.set(key,owners);}
  for(const row of rows){if(!row.safe)continue;const key=`${row.top.routerId}:${row.top.secretId}`;if((secretOwners.get(key)||[]).length>1){row.safe=false;row.review=true;row.reason='secret_conflict';}}
  const safe=rows.filter(row=>row.safe),review=rows.filter(row=>row.review),unmatched=rows.filter(row=>!row.top);
  return {scope:scope||'ALL',rows,safe,review,unmatched,routerFailures:failed.map(item=>({routerId:item.router.id,routerName:item.router.name,siteCode:item.router.site_code,error:item.error})),counts:{total:rows.length,safe:safe.length,review:review.length,unmatched:unmatched.length}};
}

module.exports={normalize,exemptOf,matchScore,smartSyncPlanFromInventory};
