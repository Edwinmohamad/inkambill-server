const http=require('http');
const https=require('https');

const STRIP_RESPONSE_HEADERS=new Set(['x-frame-options','content-security-policy','content-security-policy-report-only','frame-options']);
function safeTarget(raw){
  try{const u=new URL(String(raw||''));return ['http:','https:'].includes(u.protocol)?u:null;}catch{return null;}
}
function encodeForm(body){const p=new URLSearchParams();for(const [k,v] of Object.entries(body||{})){if(Array.isArray(v))v.forEach(x=>p.append(k,String(x)));else if(v!=null)p.append(k,String(v));}return p.toString();}
function requestBody(req){
  if(['GET','HEAD'].includes(req.method))return null;
  const type=String(req.headers['content-type']||'').toLowerCase();
  if(type.includes('application/json'))return Buffer.from(JSON.stringify(req.body||{}));
  if(type.includes('application/x-www-form-urlencoded'))return Buffer.from(encodeForm(req.body));
  return null;
}
function rewriteCookie(cookie,prefix){return String(cookie).replace(/;\s*Domain=[^;]+/ig,'').replace(/;\s*Path=\/([^;]*)/ig,(_m,rest)=>`; Path=${prefix}/${rest||''}`);}
function rewriteHtml(html,target,prefix){
  const escaped=prefix.replace(/\/$/,'');
  let out=String(html||'');
  out=out.replace(/(href|src|action)=(['"])\/(?!\/)/gi,`$1=$2${escaped}/`);
  out=out.replace(/url\((['"]?)\/(?!\/)/gi,`url($1${escaped}/`);
  const targetOrigin=target.origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  out=out.replace(new RegExp(targetOrigin,'g'),escaped);
  const base=`<base href="${escaped}/">`;
  if(/<head[^>]*>/i.test(out))out=out.replace(/<head([^>]*)>/i,`<head$1>${base}`);else out=base+out;
  return out;
}
function proxyInfrastructure(req,res,{targetUrl,prefix}){
  const target=safeTarget(targetUrl);if(!target)return res.status(503).send('Infrastructure target belum dikonfigurasi.');
  const original=new URL(req.originalUrl,'http://inkamnet.local');
  const marker=prefix.replace(/\/$/,'');
  let rest=original.pathname.startsWith(marker)?original.pathname.slice(marker.length):'/';if(!rest.startsWith('/'))rest=`/${rest}`;
  const upstream=new URL(rest+original.search,target.origin);
  if(target.pathname&&target.pathname!=='/')upstream.pathname=`${target.pathname.replace(/\/$/,'')}${rest}`;
  const body=requestBody(req);
  const canStreamBody=!['GET','HEAD'].includes(req.method)&&body===null&&req.readable&&!req.readableEnded;
  const headers={...req.headers,host:upstream.host,'accept-encoding':'identity'};
  delete headers.connection;
  if(body){delete headers['content-length'];headers['content-length']=String(body.length);}
  else if(!canStreamBody)delete headers['content-length'];
  const transport=upstream.protocol==='https:'?https:http;
  const proxyReq=transport.request(upstream,{method:req.method,headers,rejectUnauthorized:process.env.INFRA_PROXY_TLS_VERIFY!=='false'},proxyRes=>{
    const responseHeaders={...proxyRes.headers};
    for(const key of Object.keys(responseHeaders))if(STRIP_RESPONSE_HEADERS.has(key.toLowerCase()))delete responseHeaders[key];
    const location=responseHeaders.location;
    if(location){try{const loc=new URL(location,target.origin);if(loc.origin===target.origin)responseHeaders.location=`${marker}${loc.pathname}${loc.search}${loc.hash}`;}catch{} }
    if(responseHeaders['set-cookie'])responseHeaders['set-cookie']=responseHeaders['set-cookie'].map(c=>rewriteCookie(c,marker));
    const contentType=String(responseHeaders['content-type']||'');
    if(contentType.includes('text/html')){
      const chunks=[];proxyRes.on('data',c=>chunks.push(c));proxyRes.on('end',()=>{const html=rewriteHtml(Buffer.concat(chunks).toString('utf8'),target,marker);delete responseHeaders['content-length'];delete responseHeaders['transfer-encoding'];res.status(proxyRes.statusCode||200).set(responseHeaders).send(html);});
    }else{
      res.status(proxyRes.statusCode||200);for(const [k,v] of Object.entries(responseHeaders))if(v!==undefined)res.setHeader(k,v);proxyRes.pipe(res);
    }
  });
  proxyReq.setTimeout(20000,()=>proxyReq.destroy(new Error('Infrastructure upstream timeout')));
  proxyReq.on('error',err=>{if(!res.headersSent)res.status(502).send(`Infrastructure Hub: ${err.message}`);else res.end();});
  if(body)proxyReq.end(body);else if(canStreamBody)req.pipe(proxyReq);else proxyReq.end();
}
module.exports={proxyInfrastructure,rewriteHtml,safeTarget,requestBody};
