'use strict';

const db=require('../../config/db');
const store=require('./secretStore');
const ros=require('./rosApi');

async function sites(){
  const [rows]=await db.query('SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code');
  return rows;
}

// Deliberately request-driven. No timers, traffic collection, event feed, or
// background router checks. Active sessions are a point-in-time reconciliation snapshot.
async function refreshSecrets(siteId=null){
  const targets=(await store.activeRouters(siteId)).filter(router=>Number(router.pppoe_enabled??1)===1);
  const results=[];
  for(const router of targets){
    try {
      const inventory=await store.syncRouterSecrets(router);
      let activeWarning=null;
      try {await store.applyActive(router,await ros.active(router));}
      catch(error){activeWarning=String(error.message).slice(0,500);}
      await db.execute("UPDATE routers SET last_status='online',last_error=?,last_seen_at=NOW() WHERE id=?",[activeWarning,router.id]);
      results.push({ok:true,...inventory,activeWarning});
    } catch(error){
      await db.execute("UPDATE routers SET last_status='offline',last_error=? WHERE id=?",[String(error.message).slice(0,500),router.id]).catch(()=>{});
      results.push({ok:false,routerId:router.id,error:error.message});
    }
  }
  return results;
}

module.exports={sites,refreshSecrets};
