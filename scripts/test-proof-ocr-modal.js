const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function element(){return {textContent:'',children:[],listeners:{},style:{},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){this.children=[];},append(child){this.children.push(child);}};}
async function scenario(fail=false){
 const ids=Object.fromEntries(['proofViewerModal','proofOcrFields','proofOcrStatus'].map(id=>[id,element()]));
 const urls=[];
 vm.runInNewContext(fs.readFileSync('public/js/payment-proof-review.js','utf8'),{
  document:{getElementById:id=>ids[id],querySelectorAll:()=>[],createElement:element},AbortSignal,
  fetch:async(url,options)=>{urls.push(url);assert.equal(options.cache,'no-store');if(fail)throw Error('Network failure');return {ok:true,json:async()=>({ok:true,item:{overall:'ok',checks:[{level:'ok',label:'Nominal sesuai',detail:'Rp165.000'}],summary:'Bukti sesuai'}})};}
 });
 // No buttons existed at initialization: opening a modal with a newly added trigger must still read OCR.
 await ids.proofViewerModal.listeners['show.bs.modal']({relatedTarget:{dataset:{proofUrl:'/payments/541/proof'}}});
 assert.deepEqual(urls,['/payments/541/proof-ocr']);
 assert.equal(ids.proofOcrStatus.textContent,fail?'Gagal dimuat':'Cocok');
 if(fail)assert.equal(ids.proofOcrFields.textContent,'Network failure');
 else assert(ids.proofOcrFields.children.some(child=>child.textContent.includes('Nominal sesuai')));
}
(async()=>{await scenario();await scenario(true);console.log('PASS OCR modal: dynamic trigger, rendered result, visible request failure, uncached request.');})().catch(error=>{console.error(error);process.exitCode=1;});
