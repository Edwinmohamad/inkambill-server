const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const activity=fs.readFileSync('android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/MainActivity.java','utf8');
assert(activity.indexOf('setContentView(root)')<activity.indexOf('applyNativeAppleTheme();'),'system-bar styling must wait for decor initialization on Android 11+');
const workflow=fs.readFileSync('.github/workflows/build-android.yml','utf8');
assert(workflow.includes("needs.build-apk.outputs.variant == 'release'"),'debug APK must not replace production');
assert(workflow.includes('steps.package.outputs.variant'),'release variant must come from the actual build step');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inkam-apk-test-')),bin=path.join(dir,'bin');fs.mkdirSync(bin);
try{
 fs.writeFileSync(path.join(dir,'INKAMNET-GO-v1.3.3.apk'),'fixture');fs.writeFileSync(path.join(dir,'package-name.txt'),'id.my.edwinpxmx.inkamnetgo');
 fs.writeFileSync(path.join(bin,'sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 fs.writeFileSync(path.join(bin,'adb'),`#!/bin/sh
case "$*" in
 'shell getprop sys.boot_completed') echo 1;;
 'shell dumpsys activity activities') echo 'id.my.edwinpxmx.inkamnetgo/id.my.edwinpxmx.inkamnetgo.MainActivity';;
 'shell pidof '*) echo 123;;
 'shell screencap '*) exit 1;;
 *) exit 0;;
esac
`,{mode:0o755});
 const script=path.resolve('scripts/android-emulator-smoke.sh');
 const run=()=>spawnSync('bash',[script,'29',dir],{cwd:dir,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8',timeout:5000});
 let r=run();assert.equal(r.status,0,r.stdout+r.stderr);assert(r.stdout.includes('berhasil'));
 fs.writeFileSync(path.join(dir,'INKAMNET-GO-v9.9.9.apk'),'fixture');r=run();assert.notEqual(r.status,0);assert(r.stderr.includes('tepat satu APK'));
 console.log('APK smoke harness: current-version artifact discovered and ambiguous artifacts rejected PASS');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
