const assert=require('node:assert/strict');
const {wantsJson,notFound,errorHandler}=require('../middleware/httpErrors');
const {requireAuth,requireAdmin,requireMasterAdmin,requirePermission}=require('../middleware/auth');
const csrf=require('../middleware/csrf');
const request=extra=>({headers:{accept:'application/json'},session:{},path:'/cash',originalUrl:'/cash',get:()=>'',...extra});
function response(){return {locals:{},status(n){this.code=n;return this;},json(data){this.data=data;return this;},redirect(url){this.url=url;},render(view,data){this.view=view;this.data=data;return this;},send(data){this.data=data;return this;}};}
for(const guard of [requireAuth,requireAdmin,requireMasterAdmin,requirePermission('finance')]){const res=response();guard(request(),res,()=>assert.fail('unauthenticated request passed'));assert.equal(res.code,401);assert.equal(res.data.ok,false);}
for(const guard of [requireAdmin,requireMasterAdmin,requirePermission('finance')]){const res=response();guard(request({session:{user:{role:'staff'}}}),res,()=>assert.fail('unauthorized request passed'));assert.equal(res.code,403);assert.equal(res.data.ok,false);}
let res=response();requireAuth(request({headers:{accept:'text/html'}}),res,()=>{});assert.equal(res.url,'/login');
res=response();notFound(request(),res);assert.equal(res.code,404);assert.equal(res.data.ok,false);
res=response();notFound(request({headers:{accept:'text/html'}}),res);assert.equal(res.view,'errors/status');assert.equal(res.data.home,'/login');
res=response();csrf(request({method:'POST',body:{},session:{csrfToken:'a'}}),res,()=>assert.fail('CSRF bypass'));assert.equal(res.code,403);assert.equal(res.data.ok,false);
const originalError=console.error;console.error=()=>{};
try{res=response();errorHandler(new Error('sensitive database detail'),request(),res,()=>{});assert.equal(res.code,500);assert(!res.data.error.includes('sensitive'));
let forwarded=false;errorHandler(new Error('x'),request(),{headersSent:true},()=>forwarded=true);assert(forwarded);}finally{console.error=originalError;}
assert(wantsJson(request({originalUrl:'/api/mobile/version',headers:{}})));
console.log('HTTP contracts: session expiry, role denial, CSRF, JSON/HTML 404/500 and no double response PASS');
