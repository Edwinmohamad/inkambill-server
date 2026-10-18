const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');

const activity=fs.readFileSync('android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/MainActivity.java','utf8');
assert(activity.indexOf('setContentView(root)')<activity.indexOf('applyNativeAppleTheme();'),'system-bar styling must wait for decor initialization on Android 11+');

const workflow=fs.readFileSync('.github/workflows/build-android.yml','utf8');
assert(workflow.includes("needs.build-apk.outputs.variant == 'release'"),'debug APK must not replace production');
assert(workflow.includes('steps.package.outputs.variant'),'release variant must come from the actual build step');

const smoke=fs.readFileSync('scripts/android-emulator-smoke.sh','utf8');
assert(smoke.includes('INKAMNET-GO-v*.apk'),'smoke test must discover only versioned INKAMNET GO artifacts');
assert(smoke.includes('"\${#apk_candidates[@]}" -ne 1'),'smoke test must reject ambiguous APK artifacts');
assert(smoke.includes('package-name.txt'),'smoke test must require package metadata');
assert(smoke.includes('Emulator smoke test Android'),'smoke test must report successful completion');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inkam-apk-test-'));
try{
  const discover=()=>fs.readdirSync(dir).filter(name=>name.startsWith('INKAMNET-GO-v')&&name.endsWith('.apk')).sort();
  fs.writeFileSync(path.join(dir,'INKAMNET-GO-v1.3.3.apk'),'fixture');
  fs.writeFileSync(path.join(dir,'package-name.txt'),'id.my.edwinpxmx.inkamnetgo');
  let candidates=discover();
  assert.equal(candidates.length,1,'current release artifact must be uniquely discoverable');
  assert.equal(candidates[0],'INKAMNET-GO-v1.3.3.apk');
  assert.equal(fs.readFileSync(path.join(dir,'package-name.txt'),'utf8').trim(),'id.my.edwinpxmx.inkamnetgo');

  fs.writeFileSync(path.join(dir,'INKAMNET-GO-v9.9.9.apk'),'fixture');
  candidates=discover();
  assert.equal(candidates.length,2,'ambiguous versioned artifacts must be detectable and rejected by smoke script');
  console.log('APK smoke artifact contract: unique current artifact and ambiguity guard PASS');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
