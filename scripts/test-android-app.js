const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const required = [
  'android/settings.gradle',
  'android/build.gradle',
  'android/app/build.gradle',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/res/xml/network_security_config.xml',
  'android/app/src/main/res/drawable-nodpi/inkamnet_mark.png',
  'android/app/src/main/res/drawable/inkamnet_tower_foreground.xml',
  'public/img/inkamnet-go-tower.svg',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/MainActivity.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/AlertWorker.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/NotificationHelper.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/UpdateChecker.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/CrashReporter.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/PushManager.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/GoFirebaseMessagingService.java',
  'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/InkamnetGoApplication.java',
  'android/generate-release-signing.sh',
  'scripts/android-emulator-smoke.sh',
  'routes/mobile.js',
  '.github/workflows/build-android.yml'
];

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Berkas Android wajib tidak ada: ${file}`);
}

const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const activity = fs.readFileSync(path.join(root, 'android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/MainActivity.java'), 'utf8');
const appGradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
const security = fs.readFileSync(path.join(root, 'android/app/src/main/res/xml/network_security_config.xml'), 'utf8');
const iconVector = fs.readFileSync(path.join(root, 'android/app/src/main/res/drawable/inkamnet_tower_foreground.xml'), 'utf8');
const launcherIcon = fs.readFileSync(path.join(root, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-android.yml'), 'utf8');
const mobileRoute = fs.readFileSync(path.join(root, 'routes/mobile.js'), 'utf8');
const csrf = fs.readFileSync(path.join(root, 'middleware/csrf.js'), 'utf8');
const emulatorSmoke = fs.readFileSync(path.join(root, 'scripts/android-emulator-smoke.sh'), 'utf8');

const checks = [
  [manifest.includes('android:label="INKAMNET GO"'), 'label aplikasi'],
  [manifest.includes('android:usesCleartextTraffic="false"'), 'blokir cleartext'],
  [manifest.includes('android.permission.INTERNET'), 'izin internet'],
  [manifest.includes('inkambill.edwinpxmx.my.id'), 'host deep link'],
  [appGradle.includes('applicationId "id.my.edwinpxmx.inkamnetgo"'), 'application ID'],
  [appGradle.includes('minSdk 26'), 'minimum Android'],
  [appGradle.includes('versionCode 5') && appGradle.includes('versionName "1.3.0"'), 'versi Android'],
  [appGradle.includes('androidx.biometric:biometric'), 'biometrik'],
  [appGradle.includes('androidx.work:work-runtime'), 'background worker'],
  [appGradle.includes('firebase-messaging'), 'Firebase push messaging'],
  [appGradle.includes('ANDROID_KEYSTORE_PATH'), 'release signing'],
  [activity.includes('https://inkambill.edwinpxmx.my.id/'), 'URL produksi HTTPS'],
  [activity.includes('setAcceptThirdPartyCookies(webView, false)'), 'cookie pihak ketiga'],
  [activity.includes('MIXED_CONTENT_NEVER_ALLOW'), 'mixed content'],
  [activity.includes('handler.cancel()'), 'SSL fail closed'],
  [activity.includes('DownloadManager'), 'download manager'],
  [activity.includes('onShowFileChooser'), 'upload file'],
  [activity.includes('MediaStore.ACTION_IMAGE_CAPTURE'), 'upload kamera'],
  [activity.includes('showBiometricUnlock'), 'app lock biometrik'],
  [activity.includes('UpdateChecker.check'), 'pemeriksaan update'],
  [activity.includes('CrashReporter.uploadPending'), 'pengiriman crash tertunda'],
  [manifest.includes('android.permission.POST_NOTIFICATIONS'), 'izin notifikasi'],
  [mobileRoute.includes("router.get('/api/mobile/version'"), 'API versi mobile'],
  [mobileRoute.includes("router.get('/.well-known/assetlinks.json'"), 'Android App Links'],
  [mobileRoute.includes("router.post('/api/mobile/crash'"), 'API crash report'],
  [mobileRoute.includes("router.post('/api/mobile/push-token'"), 'registrasi push token'],
  [csrf.includes('/api/mobile/crash')
    && csrf.includes('/api/mobile/push-token')
    && csrf.includes("req.get('x-inkamnet-go')")
    && csrf.includes('req.session?.user')
    && csrf.includes("req.is('application/json')"), 'CSRF mobile terbatas'],
  [workflow.includes('apksigner') && workflow.includes('android-emulator-runner'), 'signature dan emulator CI'],
  [(iconVector.match(/strokeLineCap="round"/g) || []).length === 3
    && launcherIcon.includes('@drawable/inkamnet_tower_foreground'), 'ikon menara dengan tiga sinyal dan safe area'],
  [workflow.includes('bash scripts/android-emulator-smoke.sh')
    && emulatorSmoke.includes('adb wait-for-device')
    && emulatorSmoke.includes('sys.boot_completed')
    && emulatorSmoke.includes('adb install -r -g')
    && emulatorSmoke.includes('dumpsys activity activities'), 'smoke test emulator persisten dan menunggu boot'],
  [security.includes('cleartextTrafficPermitted="false"'), 'network security HTTPS-only'],
  [!activity.includes('handler.proceed()'), 'tidak melewati error SSL'],
  [!activity.includes('addJavascriptInterface'), 'tidak ada JS bridge berisiko']
];

for (const [valid, name] of checks) {
  if (!valid) throw new Error(`Validasi Android gagal: ${name}`);
}

const png = fs.statSync(path.join(root, 'android/app/src/main/res/drawable-nodpi/inkamnet_mark.png'));
if (png.size < 10_000) throw new Error('Ikon INKAMNET tidak valid atau terlalu kecil.');

function stripJavaLiterals(source) {
  let out = '', mode = 'code';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (mode === 'code' && ch === '/' && next === '/') { mode = 'line'; out += '  '; i++; continue; }
    if (mode === 'code' && ch === '/' && next === '*') { mode = 'block'; out += '  '; i++; continue; }
    if (mode === 'code' && ch === '"') { mode = 'string'; out += ' '; continue; }
    if (mode === 'code' && ch === "'") { mode = 'char'; out += ' '; continue; }
    if (mode === 'line' && ch === '\n') { mode = 'code'; out += '\n'; continue; }
    if (mode === 'block' && ch === '*' && next === '/') { mode = 'code'; out += '  '; i++; continue; }
    if ((mode === 'string' || mode === 'char') && ch === '\\') { out += '  '; i++; continue; }
    if (mode === 'string' && ch === '"') { mode = 'code'; out += ' '; continue; }
    if (mode === 'char' && ch === "'") { mode = 'code'; out += ' '; continue; }
    out += mode === 'code' ? ch : (ch === '\n' ? '\n' : ' ');
  }
  if (!['code','line'].includes(mode)) throw new Error(`Literal/comment Java tidak selesai: ${mode}`);
  return out;
}

const javaFiles = required.filter(file => file.endsWith('.java'));
for (const file of javaFiles) {
  const source = stripJavaLiterals(fs.readFileSync(path.join(root, file), 'utf8'));
  const stack = [], pairs = {')':'(',']':'[','}':'{'};
  for (const ch of source) {
    if ('([{'.includes(ch)) stack.push(ch);
    else if (')]}'.includes(ch) && stack.pop() !== pairs[ch]) throw new Error(`Delimiter Java tidak seimbang: ${file}`);
  }
  if (stack.length) throw new Error(`Delimiter Java belum ditutup: ${file}`);
}

console.log(`Android source validation passed: ${checks.length} security/feature checks, ${javaFiles.length} Java files balanced.`);
