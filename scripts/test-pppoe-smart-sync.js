const assert = require('assert');
const { smartSyncPlanFromInventory } = require('../services/pppoeSyncPlanner');

const routerA={id:10,name:'Router A',site_id:1,site_code:'CDS'};
const routerB={id:20,name:'Router B',site_id:2,site_code:'KBG'};
const secret=(id,name,comment='')=>({'.id':id,name,comment,profile:'default',disabled:'false'});
const customer=(id,code,name,extra={})=>({id,customer_code:code,name,site_id:1,site_code:'CDS',router_id:null,pppoe_username:null,...extra});

const inventory={
  customers:[
    customer(1,'CUST001','Budi',{router_id:99,pppoe_username:'mapping-lama'}),
    customer(2,'CUST002','Siti',{router_id:10,pppoe_username:'CUST002'}),
    customer(3,'CUST003','Nama Tidak Cocok'),
    {...customer(4,'KBG001','Pelanggan KBG'),site_id:2,site_code:'KBG'}
  ],
  routerResults:[
    {ok:true,router:routerA,secrets:[secret('*1','CUST001'),secret('*2','CUST002'),secret('*3','acak-secret')]},
    {ok:true,router:routerB,secrets:[secret('*4','KBG001')]}
  ]
};

const all=smartSyncPlanFromInventory(inventory);
assert(!all.rows.some(row=>row.id===2),'Mapping valid tidak boleh masuk antrean Smart Sync');
const repaired=all.rows.find(row=>row.id===1);
assert(repaired?.safe,'Mapping lama dengan kandidat exact harus dapat diperbaiki');
assert.strictEqual(repaired.reason,'stale_mapping_repair');
assert.strictEqual(repaired.top.secretName,'CUST001');
assert(all.safe.some(row=>row.id===4),'Kandidat exact pada site lain harus tetap dikenali pada scope ALL');
assert(!all.rows.find(row=>row.id===3)?.safe,'Kecocokan lemah tidak boleh dieksekusi otomatis');

const cds=smartSyncPlanFromInventory(inventory,'CDS');
assert(cds.rows.every(row=>row.site_code==='CDS'),'Filter site harus membatasi pelanggan');

const unavailable=smartSyncPlanFromInventory({
  customers:[customer(5,'CUST005','Rina')],
  routerResults:[{ok:false,router:routerA,secrets:[],error:'timeout'}]
});
assert.strictEqual(unavailable.safe.length,0,'Router gagal tidak boleh menghasilkan Smart Sync aman');
assert.strictEqual(unavailable.routerFailures.length,1,'Kegagalan router harus dilaporkan');

const conflict=smartSyncPlanFromInventory({
  customers:[customer(6,'SAMA','Sama'),customer(7,'SAMA','Sama')],
  routerResults:[{ok:true,router:routerA,secrets:[secret('*9','SAMA')]}]
});
assert.strictEqual(conflict.safe.length,0,'Satu secret tidak boleh otomatis dipasang ke dua pelanggan');
assert(conflict.rows.every(row=>row.reason==='secret_conflict'));

console.log('PPPoE Smart Sync regression test OK: stale repair, valid mapping, scope, router failure, and conflict safety.');
