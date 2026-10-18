const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function element(id){const classes=new Set();return {id,isConnected:true,classList:{contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)},setAttribute(){},removeAttribute(){},style:{removeProperty(){}},querySelector:()=>null,focus(){},addEventListener(type,fn){this[type]=fn;}};}
const menu=element('goMenu'),quick=element('goQuickSheet'),body=element('body'),openMenu=element('openMenu'),openQuick=element('openQuick');
const docListeners={},winListeners={},nodes={goMenu:menu,goQuickSheet:quick};let shown=[],disposed=0;
const document={body,activeElement:null,documentElement:{style:{setProperty(){}}},getElementById:id=>nodes[id],querySelector:s=>s==='[data-go-menu-open]'?openMenu:s==='[data-go-quick-open]'?openQuick:s==='.modal.show'?shown[0]||null:null,querySelectorAll:s=>s==='.modal.show'?shown:[],addEventListener:(t,f)=>docListeners[t]=f};
const stack=[{}];let index=0;
const history={get state(){return stack[index];},pushState(state){stack.splice(++index);stack[index]=state;},replaceState(state){stack[index]=state;},back(){if(index>0)index--;winListeners.popstate?.();}};
const Modal={getInstance:()=>({dispose:()=>disposed++}),getOrCreateInstance:()=>({hide(){shown=[];}})};
const window={addEventListener:(t,f)=>winListeners[t]=f,innerHeight:800,bootstrap:{Modal}};
vm.runInNewContext(fs.readFileSync('public/js/mobile-app.js','utf8'),{document,window,bootstrap:window.bootstrap,history,location:{pathname:'/',href:'https://test/'},sessionStorage:{getItem:()=>null,removeItem(){},setItem(){}},requestAnimationFrame:fn=>fn(),setTimeout:()=>{},Event});
openMenu.click();assert.equal(index,1);assert(menu.classList.contains('open'));
openQuick.click();assert.equal(index,1);assert(!menu.classList.contains('open'));assert(quick.classList.contains('open'));
const first=element('first');first.classList.add('modal');first.classList.add('show');shown=[first];docListeners['show.bs.modal']({target:first});assert.equal(index,1);assert.equal(history.state.inkamnetGoLayer.id,'first');assert(!quick.classList.contains('open'));
const second=element('second');second.classList.add('modal');second.classList.add('show');shown=[second];docListeners['show.bs.modal']({target:second});docListeners['hidden.bs.modal']({target:first});assert.equal(index,1);assert.equal(history.state.inkamnetGoLayer.id,'second');
docListeners['hidden.bs.modal']({target:second});assert.equal(index,0);
shown=[second];winListeners.pageshow({persisted:true});assert.equal(disposed,1);assert(!second.classList.contains('show'));assert(!body.classList.contains('modal-open'));
console.log('APK history: menu/quick replacement, modal switching, Back and bfcache instance disposal PASS');
