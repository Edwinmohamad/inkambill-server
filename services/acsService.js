const db=require('../config/db');

const valueAt=(source,path)=>{
  let current=source;
  for(const part of String(path||'').split('.')){if(current==null)return null;current=current[part];}
  return current&&typeof current==='object'&&Object.prototype.hasOwnProperty.call(current,'_value')?current._value:current;
};
const firstValue=(device,paths)=>{for(const path of paths){const value=valueAt(device,path);if(value!==null&&value!==undefined&&value!=='')return value;}return null;};
const numberOrNull=value=>{if(value===null||value===undefined||value==='')return null;const match=String(value).match(/-?\d+(?:\.\d+)?/);const n=match?Number(match[0]):NaN;return Number.isFinite(n)?n:null;};
const intOrNull=value=>{const n=numberOrNull(value);return n===null?null:Math.max(0,Math.round(n));};
const dateOrNull=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?null:d;};
function config(){
  const raw=String(process.env.GENIEACS_NBI_URL||'').trim().replace(/\/+$/,'').replace(/\/devices$/,'');
  return {baseUrl:raw,username:String(process.env.GENIEACS_NBI_USERNAME||''),password:String(process.env.GENIEACS_NBI_PASSWORD||''),onlineMinutes:Math.max(2,Number(process.env.ACS_ONLINE_MINUTES||10)),warning:Number(process.env.ACS_RX_WARNING||-25),critical:Number(process.env.ACS_RX_CRITICAL||-28)};
}
function headers(cfg){const result={Accept:'application/json'};if(cfg.username)result.Authorization=`Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;return result;}
async function acsFetch(path,params={}){
  const cfg=config();if(!/^https?:\/\//.test(cfg.baseUrl))throw new Error('GENIEACS_NBI_URL belum dikonfigurasi.');
  const url=new URL(`${cfg.baseUrl}${path}`);Object.entries(params).forEach(([key,val])=>{if(val!==undefined&&val!==null&&val!=='')url.searchParams.set(key,String(val));});
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(process.env.ACS_TIMEOUT_MS||12000));
  try{const response=await fetch(url,{headers:headers(cfg),signal:controller.signal});if(!response.ok)throw new Error(`GenieACS HTTP ${response.status}`);return await response.json();}
  catch(err){throw new Error(err.name==='AbortError'?'GenieACS timeout':err.message);}finally{clearTimeout(timeout);}
}
async function acsTask(deviceId,task){
  const allowed=new Set(['refreshObject','reboot']);if(!allowed.has(task.name))throw new Error('Aksi ACS tidak diizinkan.');
  const cfg=config();if(!/^https?:\/\//.test(cfg.baseUrl))throw new Error('GENIEACS_NBI_URL belum dikonfigurasi.');
  const url=new URL(`${cfg.baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`);url.searchParams.set('connection_request','');
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Number(process.env.ACS_TIMEOUT_MS||12000));
  try{const response=await fetch(url,{method:'POST',headers:{...headers(cfg),'Content-Type':'application/json'},body:JSON.stringify(task),signal:controller.signal});if(!response.ok)throw new Error(`GenieACS HTTP ${response.status}`);return await response.json();}
  catch(err){throw new Error(err.name==='AbortError'?'GenieACS timeout':err.message);}finally{clearTimeout(timeout);}
}
function normalizeDevice(device){
  const cfg=config();const lastInform=dateOrNull(device._lastInform);const online=lastInform&&(Date.now()-lastInform.getTime())<=cfg.onlineMinutes*60000?'online':lastInform?'offline':'unknown';
  const rx=numberOrNull(firstValue(device,[process.env.ACS_RX_PATH||'VirtualParameters.RXPower','VirtualParameters.rxPower','InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower']));
  const signal=rx===null?'unknown':rx<=cfg.critical?'critical':rx<=cfg.warning?'warning':'normal';
  return {deviceId:String(device._id||''),serial:firstValue(device,['_deviceId._SerialNumber','InternetGatewayDevice.DeviceInfo.SerialNumber']),oui:firstValue(device,['_deviceId._OUI']),manufacturer:firstValue(device,['_deviceId._Manufacturer','InternetGatewayDevice.DeviceInfo.Manufacturer']),productClass:firstValue(device,['_deviceId._ProductClass','InternetGatewayDevice.DeviceInfo.ProductClass']),software:firstValue(device,['InternetGatewayDevice.DeviceInfo.SoftwareVersion']),pppoe:firstValue(device,[process.env.ACS_PPPOE_PATH||'VirtualParameters.pppoeUsername','InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username']),wanIp:firstValue(device,['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress']),ssid:firstValue(device,['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID']),rx,temperature:numberOrNull(firstValue(device,[process.env.ACS_TEMPERATURE_PATH||'VirtualParameters.gettemp','InternetGatewayDevice.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value'])),clients:intOrNull(firstValue(device,[process.env.ACS_CLIENTS_PATH||'VirtualParameters.activedevices','InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries'])),lastInform,online,signal};
}
async function testConnection(){const started=Date.now();const rows=await acsFetch('/devices',{limit:1,projection:'_id,_lastInform'});return {ok:Array.isArray(rows),latencyMs:Date.now()-started};}
async function autoLink(conn){
  const [result]=await conn.execute(`INSERT IGNORE INTO customer_ont_links(customer_id,acs_device_id,match_method,is_locked)
    SELECT c.id,d.id,'pppoe',0 FROM customers c JOIN acs_devices d ON LOWER(TRIM(d.pppoe_username))=LOWER(TRIM(c.pppoe_username))
    LEFT JOIN customer_ont_links lc ON lc.customer_id=c.id LEFT JOIN customer_ont_links ld ON ld.acs_device_id=d.id
    WHERE c.archived_at IS NULL AND c.pppoe_username IS NOT NULL AND c.pppoe_username<>'' AND lc.id IS NULL AND ld.id IS NULL`);
  return Number(result.affectedRows||0);
}
async function syncDevices(){
  const conn=await db.getConnection();let logId=null;let locked=false;
  try{
    const [[lock]]=await conn.query(`SELECT GET_LOCK('inkambilling_acs_sync',1) acquired`);locked=Number(lock.acquired)===1;if(!locked)return {status:'skipped',devices:0,linked:0};
    const [log]=await conn.execute(`INSERT INTO acs_sync_logs(status) VALUES('running')`);logId=log.insertId;
    const projection=['_id','_deviceId','_lastInform','InternetGatewayDevice.DeviceInfo','InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID','InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries','InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username','InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',process.env.ACS_RX_PATH||'VirtualParameters.RXPower',process.env.ACS_TEMPERATURE_PATH||'VirtualParameters.gettemp',process.env.ACS_CLIENTS_PATH||'VirtualParameters.activedevices',process.env.ACS_PPPOE_PATH||'VirtualParameters.pppoeUsername'].join(',');
    const devices=await acsFetch('/devices',{projection});if(!Array.isArray(devices))throw new Error('Respons perangkat GenieACS tidak valid.');
    await conn.beginTransaction();
    for(const raw of devices){const d=normalizeDevice(raw);if(!d.deviceId)continue;await conn.execute(`INSERT INTO acs_devices(device_id,serial_number,oui,manufacturer,product_class,software_version,pppoe_username,wan_ip,ssid,rx_power,temperature,active_clients,last_inform,online_status,signal_status,last_synced_at,sync_error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NULL) ON DUPLICATE KEY UPDATE serial_number=VALUES(serial_number),oui=VALUES(oui),manufacturer=VALUES(manufacturer),product_class=VALUES(product_class),software_version=VALUES(software_version),pppoe_username=VALUES(pppoe_username),wan_ip=VALUES(wan_ip),ssid=VALUES(ssid),rx_power=VALUES(rx_power),temperature=VALUES(temperature),active_clients=VALUES(active_clients),last_inform=VALUES(last_inform),online_status=VALUES(online_status),signal_status=VALUES(signal_status),last_synced_at=NOW(),sync_error=NULL`,[d.deviceId,d.serial,d.oui,d.manufacturer,d.productClass,d.software,d.pppoe,d.wanIp,d.ssid,d.rx,d.temperature,d.clients,d.lastInform,d.online,d.signal]);}
    const linked=await autoLink(conn);await conn.execute(`INSERT INTO acs_device_samples(acs_device_id,online_status,rx_power,temperature,active_clients) SELECT id,online_status,rx_power,temperature,active_clients FROM acs_devices`);
    await conn.execute(`DELETE FROM acs_device_samples WHERE sampled_at<DATE_SUB(NOW(),INTERVAL 7 DAY)`);
    await conn.execute(`UPDATE acs_sync_logs SET status='success',device_count=?,linked_count=?,message=?,finished_at=NOW() WHERE id=?`,[devices.length,linked,'Sinkronisasi selesai',logId]);await conn.commit();return {status:'success',devices:devices.length,linked};
  }catch(err){try{await conn.rollback();}catch(_){}if(logId)await conn.execute(`UPDATE acs_sync_logs SET status='failed',message=?,finished_at=NOW() WHERE id=?`,[err.message.slice(0,700),logId]);throw err;}
  finally{if(locked)try{await conn.query(`DO RELEASE_LOCK('inkambilling_acs_sync')`);}catch(_){}conn.release();}
}
module.exports={config,testConnection,syncDevices,normalizeDevice,acsTask};
