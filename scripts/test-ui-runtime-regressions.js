const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const common=require('../middleware/common');
const {pageInfo,paginate}=require('../utils/pagination');
(async()=>{
 const res={locals:{}};common({session:{},query:{},originalUrl:'/',get:()=>''},res,()=>{});
 res.locals.pagination={from:51};assert.equal(res.locals.rowNumber(0),51);assert.equal(res.locals.rowNumber(9),60);
 res.locals.pagination=null;assert.equal(res.locals.rowNumber(0),1);
 assert.equal(res.locals.formatDate('bad-date'),'-');assert.equal(res.locals.formatDateTime(null),'-');assert.equal(res.locals.formatTime('invalid'),'');
 assert.equal(pageInfo({query:{page:'9'.repeat(400),per_page:'9'.repeat(400)}}).page,1);
 const queries=[];const paged=await paginate({execute:async(sql,p)=>{queries.push(p);return sql.startsWith('SELECT COUNT')?[[{total:75}]]:[[]];}},'SELECT id FROM test',[],{query:{page:'999',per_page:'50'}});
 assert.equal(paged.pagination.page,2);assert.deepEqual(queries[1],[50,50]);
 const source=fs.readFileSync('public/js/app.js','utf8');
 const start=source.indexOf('const submitFilter='),end=source.indexOf("  document.querySelectorAll('form[method=",start);
 let submits=0;const page={value:'8'},form={dataset:{},reportValidity:()=>true,querySelector:()=>page,setAttribute:()=>{},classList:{add:()=>{}}};
 const submitFilter=vm.runInNewContext(source.slice(start,end)+';submitFilter',{sessionStorage:{setItem:()=>{}},startProgress:()=>{},HTMLFormElement:{prototype:{submit:{call:()=>submits++}}}});
 submitFilter(form);submitFilter(form);assert.equal(submits,1);assert.equal(page.value,'1');
 submitFilter({...form,dataset:{},reportValidity:()=>false});assert.equal(submits,1);
 const cstart=source.indexOf('    function bindConfirmIntercept('),cend=source.indexOf("    document.querySelectorAll('[onsubmit",cstart);
 let fn,received;const button={name:'action',value:'approve'};
 const el={dataset:{},getAttribute:()=>"return confirm('Lanjutkan?')",removeAttribute:()=>{},addEventListener:(_t,f)=>fn=f,requestSubmit:b=>received=b};
 const bind=vm.runInNewContext(source.slice(cstart,cend)+';bindConfirmIntercept',{window:{iosConfirm:async()=>true}});
 bind(el,'onsubmit');fn({submitter:button,preventDefault:()=>{},stopImmediatePropagation:()=>{}});await Promise.resolve();assert.equal(received,button);
 // Execute the production search binding against two tables: only the owning table may change.
 function node(){return {children:[],dataset:{},hidden:false,setAttribute(){},appendChild(n){this.children.push(n);},querySelector:()=>null,querySelectorAll:()=>[]};}
 let unchecked=0;const box={checked:true,dispatchEvent:()=>unchecked++};
 const row=text=>({...node(),textContent:text,cells:[{},{}],hasAttribute:()=>false,querySelectorAll:selector=>selector==='td'?[{},{}]:selector==='[data-row-check]:checked'&&box.checked?[box]:[]});
 const rows=[row('Ali'),row('Budi')],other=row('Tetap terlihat'),tbody=node();
 const table={querySelectorAll:s=>s==='tbody>tr'?rows:[{},{}],querySelector:()=>tbody};
 const formScope={querySelector:()=>table};const searchForm={closest:()=>formScope};const events={};
 const input={value:'',dataset:{},hasAttribute:()=>false,setAttribute(){},closest:s=>s==='form'?searchForm:null,addEventListener:(t,f)=>events[t]=f};
 const doc={querySelectorAll:()=>[input],createElement:()=>node()};
 const searchStart=source.indexOf("  document.querySelectorAll('form[method=\"get\"] input[name=\"q\"]");
 const searchEnd=source.indexOf("  document.addEventListener('click'",searchStart);
 assert(searchStart>0&&searchEnd>searchStart);
 vm.runInNewContext(source.slice(searchStart,searchEnd),{document:doc,normalizeInstantSearch:v=>String(v).toLowerCase().trim(),submitFilter:()=>{},Event});
 input.value='TidakAda';events.input();assert(rows.every(r=>r.hidden));assert.equal(other.hidden,false);assert.equal(tbody.children[0].hidden,false);assert.equal(box.checked,false);assert(unchecked>0);
 input.value='';events.input();assert(rows.every(r=>!r.hidden));assert.equal(tbody.children[0].hidden,true);
 console.log('UI runtime: paginated numbering, invalid dates, bounded pagination, filter reset/deduplication and confirm submitter PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
