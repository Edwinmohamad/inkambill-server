// INKAMBILL A+ (APK): menghasilkan public/css/mobile-legibility.css.
// Banyak modul lama menulis ukuran huruf mini secara langsung (mis. 8px, 9px, .54rem) yang tidak
// terbaca di layar HP. Skrip ini membaca semua stylesheet, menemukan setiap aturan dengan font-size
// di bawah 11px, lalu menulis aturan pengganti khusus APK (body.inkamnet-go-app) bernilai 11px.
// Statis: tanpa biaya saat aplikasi berjalan. Jalankan ulang bila ada CSS baru:
//   node scripts/generate-mobile-legibility.js
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'public','css');
const OUT='mobile-legibility.css',MIN=11,SKIP=new Set(['mobile-app.css','aplus-web.css',OUT]);
function rules(css){
  css=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const out=[];const stack=[];let buf='';
  for(let i=0;i<css.length;i++){const ch=css[i];
    if(ch==='{'){stack.push(buf.trim());buf='';}
    else if(ch==='}'){const sel=stack.pop();const ctx=stack.join(' ');if(sel!==undefined&&!sel.startsWith('@')&&!/@(keyframes|font-face)/.test(ctx))out.push({sel,body:buf});buf='';}
    else buf+=ch;}
  return out;}
function px(value){const m=String(value).trim().match(/^(\d*\.?\d+)(px|rem)(\s*!important)?$/);if(!m)return null;return {size:m[2]==='rem'?parseFloat(m[1])*16:parseFloat(m[1]),important:!!m[3]};}
function scope(sel){sel=sel.trim();
  if(!sel||sel.includes('inkamnet-go-app')||/^:root\b/.test(sel)||/^(from|to|\d+%)$/.test(sel))return null;
  if(/^html\b/.test(sel)){const m=sel.match(/^html(\S*)\s+body(\S*)(.*)$/);if(m)return `html${m[1]} body.inkamnet-go-app${m[2]}${m[3]}`;const n=sel.match(/^html(\S*)(\s+.*)?$/);return n&&n[2]?`html${n[1]} body.inkamnet-go-app${n[2]}`:null;}
  if(/^body\b/.test(sel))return sel.replace(/^body/,'body.inkamnet-go-app');
  return `body.inkamnet-go-app ${sel}`;}
const seen=new Map();let files=0;
for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.css')&&!SKIP.has(f)).sort()){files++;
  for(const {sel,body} of rules(fs.readFileSync(path.join(dir,file),'utf8'))){
    const decl=body.split(';').map(d=>d.split(':')).find(([k])=>k&&k.trim()==='font-size');if(!decl)continue;
    const v=px(decl.slice(1).join(':'));if(!v||v.size>=MIN||v.size<4)continue; // <4px = sengaja menyembunyikan teks (mis. tombol ikon)
    for(const part of sel.split(/,(?![^(]*\))/)){const s=scope(part);if(!s)continue;const key=s;const prev=seen.get(key);seen.set(key,{imp:(prev&&prev.imp)||v.important});}
  }}
const lines=[...seen.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([s,{imp}])=>`${s}{font-size:${MIN}px${imp?'!important':''}}`);
const header=`/* DIHASILKAN OTOMATIS oleh scripts/generate-mobile-legibility.js — jangan diedit manual.\n   APK: ${lines.length} aturan dari ${files} stylesheet dinaikkan ke minimal ${MIN}px agar terbaca di HP. */\n`;
fs.writeFileSync(path.join(dir,OUT),header+lines.join('\n')+'\n');
console.log(`mobile-legibility.css: ${lines.length} aturan dari ${files} stylesheet`);
