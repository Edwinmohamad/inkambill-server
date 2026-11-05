const assert=require('assert');
const fs=require('fs');
const service=fs.readFileSync('services/acsService.js','utf8');
const route=fs.readFileSync('routes/acs.js','utf8');
const schema=fs.readFileSync('services/schemaService.js','utf8');
const app=fs.readFileSync('app.js','utf8');
const layout=fs.readFileSync('views/partials/layout.ejs','utf8');
const secrets=fs.readFileSync('views/nms/secrets.ejs','utf8');
[
  [schema.includes('async function ensureV42Schema()'),'schema V42'],
  [schema.includes('UNIQUE KEY uq_acs_device_id'),'unique device'],
  [schema.includes('UNIQUE KEY uq_customer_ont'),'unique customer mapping'],
  [service.includes("GET_LOCK('inkambilling_acs_sync'"),'sync lock'],
  [service.includes("err.name==='AbortError'"),'timeout handling'],
  [service.includes("rx===null?'unknown'"),'null RX handling'],
  [service.includes('INSERT IGNORE INTO customer_ont_links'),'safe auto mapping'],
  [!route.includes("router.get('/map'"),'network map removed (v2 NMS)'],
  [route.includes("router.get('/reconcile'"),'reconcile route'],
  [app.includes("app.use('/acs'"),'route mount'],
  [app.includes('await ensureV42Schema()'),'schema bootstrap'],
  [!app.includes('syncAcsDevices()'),'no background ACS monitoring'],
  [layout.includes('href="/nms/secrets"')&&secrets.includes('nmsSecrets'),'PPPoE workspace access']
].forEach(([ok,label])=>assert(ok,`ACS check gagal: ${label}`));
console.log('ACS management compatibility validation passed: 13 checks, including consolidated subscriber workspace access.');
