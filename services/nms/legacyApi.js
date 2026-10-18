const net = require('net');
const { decrypt } = require('../cryptoService');

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) { len |= 0x8000; return Buffer.from([(len >> 8) & 0xff, len & 0xff]); }
  if (len < 0x200000) { len |= 0xc00000; return Buffer.from([(len >> 16)&0xff,(len>>8)&0xff,len&0xff]); }
  if (len < 0x10000000) { len |= 0xe0000000; return Buffer.from([(len>>24)&0xff,(len>>16)&0xff,(len>>8)&0xff,len&0xff]); }
  return Buffer.from([0xf0,(len>>24)&0xff,(len>>16)&0xff,(len>>8)&0xff,len&0xff]);
}
function encodeWord(word){ const b=Buffer.from(String(word),'utf8'); return Buffer.concat([encodeLength(b.length),b]); }
function encodeSentence(words){ return Buffer.concat([...words.map(encodeWord),Buffer.from([0])]); }
function decodeLength(buf,offset){
  if(offset>=buf.length)return null; let c=buf[offset];
  if((c&0x80)===0)return {len:c,bytes:1};
  if((c&0xc0)===0x80){if(offset+1>=buf.length)return null;return {len:((c&0x3f)<<8)+buf[offset+1],bytes:2};}
  if((c&0xe0)===0xc0){if(offset+2>=buf.length)return null;return {len:((c&0x1f)<<16)+(buf[offset+1]<<8)+buf[offset+2],bytes:3};}
  if((c&0xf0)===0xe0){if(offset+3>=buf.length)return null;return {len:((c&0x0f)*0x1000000)+(buf[offset+1]<<16)+(buf[offset+2]<<8)+buf[offset+3],bytes:4};}
  if(c===0xf0){if(offset+4>=buf.length)return null;return {len:(buf[offset+1]*0x1000000)+(buf[offset+2]<<16)+(buf[offset+3]<<8)+buf[offset+4],bytes:5};}
  throw new Error('RouterOS API frame length tidak valid');
}
function wordsToObject(words){
  const out={};
  for(const w of words){
    if(!w.startsWith('='))continue;
    const i=w.indexOf('=',1); if(i<0)continue;
    out[w.slice(1,i)]=w.slice(i+1);
  }
  return out;
}
function endpoint(router){
  const raw=String(router.legacy_host||'').trim();
  if(raw)return {host:raw,port:Number(router.legacy_port||8728)};
  try{
    const u=new URL(String(router.base_url||'').replace(/^legacy:/,'http:'));
    return {host:u.hostname,port:Number(u.port||8728)};
  }catch(_){return {host:'',port:Number(router.legacy_port||8728)};}
}
async function command(router,words,timeoutMs=8000){
  const {host,port}=endpoint(router); if(!host)throw new Error('Host Legacy API belum dikonfigurasi.');
  const password=decrypt(router.password_enc);
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host,port});
    let buffer=Buffer.alloc(0), sentence=[], logged=false, finished=false;
    const rows=[];
    const done=(err,val)=>{if(finished)return;finished=true;socket.destroy();err?reject(err):resolve(val);};
    const timer=setTimeout(()=>done(new Error('RouterOS API timeout')),timeoutMs);
    const cleanup=(err,val)=>{clearTimeout(timer);done(err,val);};
    function send(ws){socket.write(encodeSentence(ws));}
    function handle(wordsIn){
      const type=wordsIn[0]||'';
      if(type==='!trap'||type==='!fatal'){const o=wordsToObject(wordsIn);return cleanup(new Error(o.message||'RouterOS API error'));}
      if(!logged){
        if(type==='!done'){logged=true;send(words);return;}
        return;
      }
      if(type==='!re')rows.push(wordsToObject(wordsIn));
      if(type==='!done')cleanup(null,rows);
    }
    function parse(){
      let off=0;
      while(off<buffer.length){
        const d=decodeLength(buffer,off); if(!d)break;
        if(buffer.length<off+d.bytes+d.len)break;
        off+=d.bytes;
        if(d.len===0){handle(sentence);sentence=[];continue;}
        sentence.push(buffer.slice(off,off+d.len).toString('utf8')); off+=d.len;
      }
      buffer=buffer.slice(off);
    }
    socket.on('connect',()=>send(['/login',`=name=${router.username}`,`=password=${password}`]));
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);try{parse();}catch(e){cleanup(e);}});
    socket.on('error',e=>cleanup(e));
    socket.on('end',()=>{if(!finished)cleanup(new Error('RouterOS API connection closed'));});
  });
}
const proplist=(cmd,fields,queries=[])=>[cmd,`=.proplist=${fields}`,...queries];
module.exports={
  command,
  resource:r=>command(r,proplist('/system/resource/print','uptime,cpu-load,free-memory,total-memory,free-hdd-space,total-hdd-space,board-name,version,architecture-name')),
  health:r=>command(r,proplist('/system/health/print','name,value')),
  interfaces:r=>command(r,proplist('/interface/print','name,type,comment,running,disabled')),
  interfaceCounters:(r,name)=>command(r,proplist('/interface/print','name,rx-byte,tx-byte,running',[`?name=${name}`])),
  active:(r,username)=>command(r,proplist('/ppp/active/print','.id,name,address,uptime,caller-id,service,session-id',username?[`?name=${username}`]:[]),12000),
  secrets:r=>command(r,proplist('/ppp/secret/print','.id,name,password,service,profile,local-address,remote-address,caller-id,disabled,comment,last-logged-out'),20000),
  profiles:r=>command(r,proplist('/ppp/profile/print','.id,name,rate-limit')),
  logs:r=>command(r,proplist('/log/print','.id,time,topics,message'),15000),
  ping:(r,address,count=5)=>command(r,['/ping',`=address=${address}`,`=count=${count}`],15000)
};