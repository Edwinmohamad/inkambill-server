const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function element(){return {dataset:{},children:[],listeners:{},textContent:'',append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];},addEventListener(name,fn){this.listeners[name]=fn;}};}
async function run(overall,fail=false){
 const cell=element();cell.dataset.paymentOcr='42';let calls=0;
 const timers=[];
 vm.runInNewContext(fs.readFileSync('public/js/payment-proof-review.js','utf8'),{
  document:{querySelectorAll:selector=>selector==='[data-payment-ocr]'?[cell]:[],getElementById:()=>null,createElement:element},AbortSignal,setTimeout:fn=>timers.push(fn),
  fetch:async()=>{calls++;if(fail)throw Error('offline');return {ok:true,json:async()=>({ok:true,item:{overall,checks:[{key:'amount',level:overall==='warning'?'warn':'ok',label:'Nominal',detail:'Rp165.000'}],summary:'Hasil uji'}})};}
 });
 for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1);
 if(fail){assert.match(cell.textContent,/gagal/);assert(cell.children.some(c=>c.textContent==='Coba Lagi'));return;}
 assert.equal(cell.children[0].textContent,{ok:'Sesuai',warning:'Tidak sesuai',processing:'Memproses',unreadable:'Perlu diperiksa'}[overall]);
 if(overall==='processing'){assert.equal(timers.length,1);assert(!cell.children.some(c=>c.textContent==='Coba Lagi'));}
 else {assert(cell.children.some(c=>c.children.some(n=>n.textContent==='Detail pemeriksaan')));assert.equal(cell.children.some(c=>c.textContent==='Coba Lagi'),overall!=='ok');}
}
(async()=>{for(const state of ['ok','warning','unreadable','processing'])await run(state);await run('ok',true);console.log('PASS OCR column: matching, mismatch, unreadable, polling and retry after request failure.');})().catch(error=>{console.error(error);process.exitCode=1;});
