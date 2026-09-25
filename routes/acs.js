const express=require('express');
const db=require('../config/db');
const {paginate}=require('../utils/pagination');
const {requireAdmin}=require('../middleware/auth');
const {syncDevices,testConnection,config,acsTask,setWifiSsid,setWifiPassword,pingHost}=require('../services/acsService');
const {audit}=require('../services/auditService');
const router=express.Router();
const localReturn=value=>String(value||'').startsWith('/acs')?String(value):'/acs';

async function options(){const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status<>'inactive' ORDER BY s.code,cl.name`);return {sites,clusters};}
router.get('/',async(req,res,next)=>{try{
  const q=String(req.query.q||'').trim(),status=['online','offline','unknown'].includes(req.query.status)?req.query.status:'',signal=['normal','warning','critical','unknown'].includes(req.query.signal)?req.query.signal:'',site=String(req.query.site||'').trim(),mapping=['linked','unlinked'].includes(req.query.mapping)?req.query.mapping:'';
  let where=['1=1'];const params=[];if(q){where.push(`(d.serial_number LIKE ? OR d.device_id LIKE ? OR d.pppoe_username LIKE ? OR d.ssid LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ?)`);const like=`%${q}%`;params.push(like,like,like,like,like,like);}if(status){where.push('d.online_status=?');params.push(status);}if(signal){where.push('d.signal_status=?');params.push(signal);}if(site){where.push('s.code=?');params.push(site);}if(mapping==='linked')where.push('l.id IS NOT NULL');if(mapping==='unlinked')where.push('l.id IS NULL');
  const pageResult=await paginate(db,`SELECT d.*,l.id link_id,l.match_method,l.is_locked,c.id customer_id,c.customer_code,c.name customer_name,c.customer_status,c.network_status,s.code site_code,cl.name cluster_name,p.name package_name FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN packages p ON p.id=c.package_id WHERE ${where.join(' AND ')} ORDER BY FIELD(d.online_status,'offline','unknown','online'),FIELD(d.signal_status,'critical','warning','unknown','normal'),c.name,d.serial_number`,params,req,50);const devices=pageResult.rows;res.locals.pagination=pageResult.pagination;
  const [[summary]]=await db.query(`SELECT COUNT(*) total,SUM(online_status='online') online,SUM(online_status='offline') offline,SUM(signal_status='warning') warning,SUM(signal_status='critical') critical,SUM(NOT EXISTS(SELECT 1 FROM customer_ont_links l WHERE l.acs_device_id=acs_devices.id)) unlinked FROM acs_devices`);
  const [[lastSync]]=await db.query(`SELECT * FROM acs_sync_logs ORDER BY id DESC LIMIT 1`);res.render('acs/index',{title:'Monitoring ONT',devices,summary:summary||{},lastSync,filters:{q,status,signal,site,mapping},...(await options()),acsConfigured:!!config().baseUrl});
}catch(err){next(err);}});

// v2 NMS rebuild: modul "Network Map" (/acs/map + CRUD titik/jalur) dihapus total.
// Tabel network_map_nodes/network_map_links dibiarkan (data tidak dihapus).

router.get('/reconcile',async(req,res,next)=>{try{
  const [devices]=await db.query(`SELECT d.* FROM acs_devices d LEFT JOIN customer_ont_links l ON l.acs_device_id=d.id WHERE l.id IS NULL ORDER BY d.last_inform DESC LIMIT 500`);
  const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,c.pppoe_username,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN customer_ont_links l ON l.customer_id=c.id WHERE c.archived_at IS NULL AND c.customer_status='active' AND l.id IS NULL ORDER BY s.code,cl.name,c.name LIMIT 1000`);
  res.render('acs/reconcile',{title:'Rekonsiliasi ONT',devices,customers});
}catch(err){next(err);}});

router.post('/sync',requireAdmin,async(req,res)=>{
  const wantsJson=req.xhr||String(req.headers.accept||'').includes('application/json');
  try{
    const result=await syncDevices();
    const message=result.status==='success'?`Sinkronisasi selesai: ${result.devices} ONT, ${result.linked} mapping otomatis baru.`:'Sinkronisasi lain sedang berjalan.';
    if(wantsJson)return res.json({ok:true,result,message});
    req.session.flash={type:result.status==='success'?'success':'warning',message};
  }catch(err){
    if(wantsJson)return res.status(400).json({ok:false,error:err.message});
    req.session.flash={type:'danger',message:`Sinkronisasi ACS gagal: ${err.message}`};
  }
  res.redirect(localReturn(req.body.return_to));
});
router.post('/test',requireAdmin,async(req,res)=>{try{const result=await testConnection();req.session.flash={type:'success',message:`GenieACS terhubung (${result.latencyMs} ms).`};}catch(err){req.session.flash={type:'danger',message:`Koneksi gagal: ${err.message}`};}res.redirect('/acs');});
router.post('/link',requireAdmin,async(req,res)=>{const customerId=Number(req.body.customer_id),deviceId=Number(req.body.acs_device_id);try{if(!customerId||!deviceId)throw new Error('Pelanggan dan ONT wajib dipilih.');await db.execute(`INSERT INTO customer_ont_links(customer_id,acs_device_id,match_method,is_locked,linked_by) VALUES(?,?,'manual',1,?)`,[customerId,deviceId,req.session.user.id]);await audit({userId:req.session.user.id,action:'link_ont',entityType:'acs_device',entityId:deviceId,description:`Mapping manual ONT ke pelanggan #${customerId}`,ip:req.ip});req.session.flash={type:'success',message:'ONT berhasil dihubungkan ke pelanggan dan mapping dikunci.'};}catch(err){req.session.flash={type:'danger',message:`Mapping gagal: ${err.code==='ER_DUP_ENTRY'?'Pelanggan atau ONT sudah memiliki mapping.':err.message}`};}res.redirect('/acs/reconcile');});
router.post('/devices/:id/path',requireAdmin,async(req,res)=>{const allowed=value=>String(value||'').trim().slice(0,120)||null;await db.execute(`UPDATE acs_devices SET olt_name=?,pon_port=?,splitter_name=?,odp_name=? WHERE id=?`,[allowed(req.body.olt_name),allowed(req.body.pon_port),allowed(req.body.splitter_name),allowed(req.body.odp_name),req.params.id]);await audit({userId:req.session.user.id,action:'update_ont_path',entityType:'acs_device',entityId:req.params.id,description:'Memperbarui metadata jalur OLT/PON/Splitter/ODP',ip:req.ip});req.session.flash={type:'success',message:'Metadata jalur ONT diperbarui.'};res.redirect('/acs');});
router.post('/devices/:id/refresh',requireAdmin,async(req,res)=>{let device;try{[[device]]=await db.execute(`SELECT id,device_id,serial_number FROM acs_devices WHERE id=? LIMIT 1`,[req.params.id]);if(!device)throw new Error('ONT tidak ditemukan.');await acsTask(device.device_id,{name:'refreshObject',objectName:'InternetGatewayDevice.',depth:2});await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'refresh',?,'success',?,?)`,[req.session.user.id,device.id,`Refresh ${device.serial_number||device.device_id}`,req.ip]);req.session.flash={type:'success',message:'Permintaan refresh parameter ONT dikirim.'};}catch(err){if(device)await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'refresh',?,'failed',?,?)`,[req.session.user.id,device.id,err.message.slice(0,700),req.ip]).catch(()=>{});req.session.flash={type:'danger',message:`Refresh ONT gagal: ${err.message}`};}res.redirect('/acs');});
router.post('/devices/:id/reboot',requireAdmin,async(req,res)=>{
  const wantsJson=req.xhr||String(req.headers.accept||'').includes('application/json');
  let device;try{[[device]]=await db.execute(`SELECT id,device_id,serial_number FROM acs_devices WHERE id=? LIMIT 1`,[req.params.id]);if(!device)throw new Error('ONT tidak ditemukan.');if(String(req.body.confirm||'')!==String(device.serial_number||device.device_id))throw new Error('Konfirmasi serial ONT tidak cocok.');await acsTask(device.device_id,{name:'reboot'});await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'reboot',?,'success',?,?)`,[req.session.user.id,device.id,`Reboot ${device.serial_number||device.device_id}`,req.ip]);await audit({userId:req.session.user.id,action:'reboot_ont',entityType:'acs_device',entityId:device.id,description:`Reboot ONT ${device.serial_number||device.device_id}`,ip:req.ip});
    if(wantsJson)return res.json({ok:true,message:'Perintah reboot ONT dikirim dan dicatat pada audit log.'});
    req.session.flash={type:'success',message:'Perintah reboot ONT dikirim dan dicatat pada audit log.'};
  }catch(err){
    if(device)await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'reboot',?,'failed',?,?)`,[req.session.user.id,device.id,err.message.slice(0,700),req.ip]).catch(()=>{});
    if(wantsJson)return res.status(400).json({ok:false,error:err.message});
    req.session.flash={type:'danger',message:`Reboot ONT ditolak: ${err.message}`};
  }
  res.redirect('/acs');
});

router.post('/devices/:id/ping',requireAdmin,async(req,res)=>{
  let device;try{
    [[device]]=await db.execute(`SELECT id,device_id,serial_number,wan_ip FROM acs_devices WHERE id=? LIMIT 1`,[req.params.id]);
    if(!device)throw new Error('ONT tidak ditemukan.');
    const result=await pingHost(device.wan_ip);
    await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'ping',?,?,?,?)`,[req.session.user.id,device.id,result.reachable?'success':'failed',`Ping ${device.wan_ip}: ${result.reachable?'reachable':'timeout'}${result.avgMs!==null?`, avg ${result.avgMs}ms`:''}, loss ${result.lossPercent??'?'}%`,req.ip]);
    res.json({ok:true,result});
  }catch(err){
    if(device)await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'ping',?,'failed',?,?)`,[req.session.user.id,device.id,err.message.slice(0,700),req.ip]).catch(()=>{});
    res.status(400).json({ok:false,error:err.message});
  }
});

router.post('/devices/:id/wifi-ssid',requireAdmin,async(req,res)=>{
  let device;try{
    [[device]]=await db.execute(`SELECT id,device_id,serial_number,ssid FROM acs_devices WHERE id=? LIMIT 1`,[req.params.id]);
    if(!device)throw new Error('ONT tidak ditemukan.');
    const newSsid=String(req.body.ssid||'').trim();
    await setWifiSsid(device.device_id,newSsid);
    await db.execute(`UPDATE acs_devices SET ssid=? WHERE id=?`,[newSsid,device.id]);
    await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'wifi_ssid',?,'success',?,?)`,[req.session.user.id,device.id,`Ganti SSID ${device.ssid||'-'} -> ${newSsid}`,req.ip]);
    await audit({userId:req.session.user.id,action:'update_ont_ssid',entityType:'acs_device',entityId:device.id,description:`Ganti SSID ONT ${device.serial_number||device.device_id} menjadi "${newSsid}"`,ip:req.ip});
    res.json({ok:true,message:`SSID berhasil diubah menjadi "${newSsid}". Perangkat akan menerapkan dalam beberapa saat.`,ssid:newSsid});
  }catch(err){
    if(device)await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'wifi_ssid',?,'failed',?,?)`,[req.session.user.id,device.id,err.message.slice(0,700),req.ip]).catch(()=>{});
    res.status(400).json({ok:false,error:err.message});
  }
});

router.post('/devices/:id/wifi-password',requireAdmin,async(req,res)=>{
  let device;try{
    [[device]]=await db.execute(`SELECT id,device_id,serial_number FROM acs_devices WHERE id=? LIMIT 1`,[req.params.id]);
    if(!device)throw new Error('ONT tidak ditemukan.');
    const newPassword=String(req.body.password||'');
    await setWifiPassword(device.device_id,newPassword);
    await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'wifi_password',?,'success',?,?)`,[req.session.user.id,device.id,`Ganti password WiFi ${device.serial_number||device.device_id}`,req.ip]);
    await audit({userId:req.session.user.id,action:'update_ont_password',entityType:'acs_device',entityId:device.id,description:`Ganti password WiFi ONT ${device.serial_number||device.device_id}`,ip:req.ip});
    res.json({ok:true,message:'Password WiFi berhasil diubah. Perangkat akan menerapkan dalam beberapa saat.'});
  }catch(err){
    if(device)await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'wifi_password',?,'failed',?,?)`,[req.session.user.id,device.id,err.message.slice(0,700),req.ip]).catch(()=>{});
    res.status(400).json({ok:false,error:err.message});
  }
});

router.post('/devices/:id/redaman',requireAdmin,async(req,res)=>{
  let device;try{
    [[device]]=await db.execute(`SELECT id,device_id,serial_number,rx_power,temperature,signal_status,last_inform FROM acs_devices WHERE id=? LIMIT 1`,[req.params.id]);
    if(!device)throw new Error('ONT tidak ditemukan.');
    acsTask(device.device_id,{name:'refreshObject',objectName:'InternetGatewayDevice.WANDevice.',depth:3}).catch(()=>{});
    await db.execute(`INSERT INTO acs_action_logs(user_id,action,acs_device_id,status,details,ip_address) VALUES(?,'redaman_check',?,'success',?,?)`,[req.session.user.id,device.id,`Cek redaman ${device.serial_number||device.device_id}: RX ${device.rx_power??'N/A'} dBm`,req.ip]);
    res.json({ok:true,rxPower:device.rx_power,temperature:device.temperature,signalStatus:device.signal_status,lastInform:device.last_inform,message:'Permintaan refresh redaman dikirim. Nilai terbaru berikut adalah hasil sinkronisasi terakhir; nilai real-time akan masuk pada sinkronisasi ACS berikutnya (±5 menit).'});
  }catch(err){
    res.status(400).json({ok:false,error:err.message});
  }
});
module.exports=router;
