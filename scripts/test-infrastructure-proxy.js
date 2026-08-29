const http=require('http');
const assert=require('assert');
const {proxyInfrastructure,rewriteHtml,safeTarget}=require('../services/infrastructureProxy');

function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});}
function close(server){return new Promise(resolve=>server.close(()=>resolve()));}
function request(url,{method='GET',headers={},body=''}={}){return new Promise((resolve,reject)=>{const req=http.request(url,{method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);if(body)req.write(body);req.end();});}

(async()=>{
  const upstream=http.createServer((req,res)=>{
    if(req.url.startsWith('/post')){const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{res.setHeader('Content-Type','text/plain');res.end(Buffer.concat(chunks).toString('utf8'));});return;}
    res.statusCode=200;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'");
    res.setHeader('Content-Security-Policy-Report-Only',"frame-ancestors 'none'");
    res.end('<!doctype html><html><head><title>Upstream</title></head><body><a href="/ui">UI</a><img src="/logo.png"><form action="/login" method="post"></form></body></html>');
  });
  const upstreamPort=await listen(upstream);
  const front=http.createServer((req,res)=>{
    req.originalUrl=req.url;
    req.body=req.url.includes('/post')?{username:'operator',mode:'safe'}:{};
    res.status=function(code){this.statusCode=code;return this;};
    res.set=function(headers){for(const [key,value] of Object.entries(headers||{})){if(value!==undefined)this.setHeader(key,value);}return this;};
    res.send=function(body){if(!this.getHeader('Content-Type'))this.setHeader('Content-Type','text/html; charset=utf-8');this.end(body);return this;};
    proxyInfrastructure(req,res,{targetUrl:`http://127.0.0.1:${upstreamPort}`,prefix:'/network/tools/proxy/test'});
  });
  const frontPort=await listen(front);
  try{
    assert.ok(safeTarget(`http://127.0.0.1:${upstreamPort}`),'valid http target should pass');
    assert.equal(safeTarget('file:///etc/passwd'),null,'non-http target must be rejected');
    const unit=rewriteHtml('<html><head></head><body><a href="/x">x</a></body></html>',new URL(`http://127.0.0.1:${upstreamPort}`),'/network/tools/proxy/test');
    assert.ok(unit.includes('/network/tools/proxy/test/x'),'rewriteHtml must scope root links');

    const response=await request(`http://127.0.0.1:${frontPort}/network/tools/proxy/test/console?node=1`);
    assert.equal(response.status,200);
    assert.equal(response.headers['x-frame-options'],undefined,'X-Frame-Options from upstream must be removed');
    assert.equal(response.headers['content-security-policy'],undefined,'CSP from upstream must be removed');
    assert.equal(response.headers['content-security-policy-report-only'],undefined,'CSP report-only must be removed');
    assert.ok(response.body.includes('<base href="/network/tools/proxy/test/">'),'base path must be injected');
    assert.ok(response.body.includes('href="/network/tools/proxy/test/ui"'),'root href must be rewritten');
    assert.ok(response.body.includes('src="/network/tools/proxy/test/logo.png"'),'root src must be rewritten');
    assert.ok(response.body.includes('action="/network/tools/proxy/test/login"'),'root form action must be rewritten');
    const postBody='ignored=browser-parser';
    const post=await request(`http://127.0.0.1:${frontPort}/network/tools/proxy/test/post`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','content-length':String(Buffer.byteLength(postBody))},body:postBody});
    assert.equal(post.status,200);assert.equal(post.body,'username=operator&mode=safe','parsed form body must be reconstructed for upstream');
    console.log('Infrastructure proxy validation OK: framing headers stripped, same-origin paths rewritten, invalid protocols blocked.');
  } finally {
    await close(front);await close(upstream);
  }
})().catch(err=>{console.error('Infrastructure proxy validation FAILED:',err.stack||err);process.exit(1);});
