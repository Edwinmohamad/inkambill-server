const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const tests=fs.readdirSync(__dirname).filter(name=>/^test-.*\.js$/.test(name)).sort();
let failed=0;
for(const name of tests){
 const r=spawnSync(process.execPath,[path.join(__dirname,name)],{cwd:root,encoding:'utf8',timeout:30000});
 const ok=r.status===0&&!r.error;console.log(`${ok?'PASS':'FAIL'} ${name}`);
 if(!ok){failed++;console.error(r.error?.message||r.stdout+r.stderr);}
}
console.log(`${tests.length-failed}/${tests.length} audit test files passed.`);process.exitCode=failed?1:0;
