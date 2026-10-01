const db = require('../config/db');
const { normalizeWhatsapp } = require('./whatsappService');
const { setStage, addSupervisorNote, ensureSupervisorState } = require('./ticketSupervisorService');
const { createActivity, recordKpiEvent } = require('./operationsActivityService');

const CONFIRM_RE=/^(iya|ya|yes|y|oke|ok|gas|buat|lanjut|jadi|betul|benar|sip)(\b|$)/i;
const CANCEL_RE=/^(tidak|nggak|ga|gak|no|cancel|batal|jangan)(\b|$)/i;
const INCIDENT_RE=/\b(los|loss|internet\s*(mati|putus|down|ga jalan|gak jalan|tidak jalan)|wifi\s*(mati|putus|down)|offline|redaman|lemot|lambat|router\s*mati|ont\s*mati|modem\s*mati|ga ada internet|gak ada internet|tidak ada internet)\b/i;
const PSB_RE=/\b(psb|pasang baru|pelanggan baru|instalasi baru)\b/i;
const MAINT_RE=/\b(maintenance|maintenan|perbaikan jaringan|perawatan|cutover)\b/i;
const MIGRATION_RE=/\b(migrasi|pindah odp|pindah jalur|relokasi)\b/i;
const SURVEY_RE=/\b(survey|survei|cek lokasi)\b/i;
const FOLLOWUP_RE=/\b(follow\s*up|followup|tagih|kunjungan ulang)\b/i;
const STAGE_RULES=[
  ['CLOSED',/\b(close|closed|tutup tiket)\b/i],
  ['VERIFIED',/\b(verified|verifikasi|sudah dicek|normal dikonfirmasi)\b/i],
  ['RESOLVED',/\b(selesai|resolved|normal|sudah normal|beres)\b/i],
  ['WORKING',/\b(proses|working|dikerjakan|lagi kerjain|sedang dikerjakan|mulai kerja)\b/i],
  ['ON_SITE',/\b(onsite|on site|sampai lokasi|sudah sampai|di lokasi)\b/i],
  ['OTW',/\b(otw|menuju|jalan ke|berangkat ke)\b/i],
  ['ASSIGNED',/\b(assign|ditugaskan|ambil tiket|handle)\b/i]
];

function normalizeText(s){return String(s||'').replace(/\s+/g,' ').trim();}
function cleanWords(s){return normalizeText(s).toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(x=>x.length>=2);}
function issueLabel(text){
  const s=String(text||'').toLowerCase();
  if(/\blos\b|lampu\s*merah/.test(s)) return 'LOS / Fiber';
  if(/lemot|lambat/.test(s)) return 'Koneksi Lemot';
  if(/router\s*mati|ont\s*mati|modem\s*mati/.test(s)) return 'Perangkat Mati';
  if(/offline|internet\s*(mati|putus|down)|ga ada internet|gak ada internet|tidak ada internet/.test(s)) return 'Internet Tidak Terhubung';
  if(/redaman|loss/.test(s)) return 'Redaman / Loss';
  return 'Gangguan Internet';
}
function detectType(text){
  if(INCIDENT_RE.test(text)) return 'incident'; if(PSB_RE.test(text)) return 'psb'; if(MAINT_RE.test(text)) return 'maintenance';
  if(MIGRATION_RE.test(text)) return 'migration'; if(SURVEY_RE.test(text)) return 'survey'; if(FOLLOWUP_RE.test(text)) return 'followup'; return null;
}
function detectStage(text){for(const [stage,re] of STAGE_RULES) if(re.test(text)) return stage; return null;}
function priorityFromText(text){const s=String(text||'').toLowerCase(); if(/darurat|critical|kritis|urgent|massal|banyak pelanggan/.test(s))return'critical';if(/tinggi|segera|parah/.test(s))return'high';return'medium';}

async function loadContext(chatId){
  const [[row]]=await db.execute(`SELECT * FROM wa_ops_context WHERE chat_id=? AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1`,[chatId]); return row||null;
}
async function saveContext(chatId, patch={}){
  await db.execute(`INSERT INTO wa_ops_context(chat_id,last_ticket_id,last_customer_id,last_site_code,last_intent,last_message_id,context_json,expires_at)
    VALUES(?,?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 30 MINUTE)) ON DUPLICATE KEY UPDATE
    last_ticket_id=COALESCE(VALUES(last_ticket_id),last_ticket_id),last_customer_id=COALESCE(VALUES(last_customer_id),last_customer_id),last_site_code=COALESCE(VALUES(last_site_code),last_site_code),
    last_intent=COALESCE(VALUES(last_intent),last_intent),last_message_id=COALESCE(VALUES(last_message_id),last_message_id),context_json=COALESCE(VALUES(context_json),context_json),expires_at=VALUES(expires_at)`,
    [chatId,patch.last_ticket_id||null,patch.last_customer_id||null,patch.last_site_code||null,patch.last_intent||null,patch.last_message_id||null,patch.context?JSON.stringify(patch.context):null]);
}
async function getPending(chatId,senderPhone){
  const [[row]]=await db.execute(`SELECT * FROM wa_ops_pending_actions WHERE chat_id=? AND status='pending' AND expires_at>NOW() AND (sender_phone IS NULL OR sender_phone=?) ORDER BY id DESC LIMIT 1`,[chatId,senderPhone||'']); return row||null;
}
async function putPending(chatId,senderPhone,messageId,actionType,payload,minutes=10){
  await db.execute(`UPDATE wa_ops_pending_actions SET status='expired' WHERE chat_id=? AND status='pending'`,[chatId]);
  const [r]=await db.execute(`INSERT INTO wa_ops_pending_actions(chat_id,sender_phone,message_id,action_type,payload_json,expires_at) VALUES(?,?,?,?,?,DATE_ADD(NOW(),INTERVAL ? MINUTE))`,[chatId,senderPhone||null,messageId||null,actionType,JSON.stringify(payload),minutes]);return r.insertId;
}

async function siteFromText(text){
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY CHAR_LENGTH(code) DESC`); const s=String(text||'').toLowerCase();
  return sites.find(x=>new RegExp(`(?:^|\\b)${String(x.code).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\b|$)`,'i').test(s) || (x.name&&s.includes(String(x.name).toLowerCase())))||null;
}
async function matchCustomer(text,siteHint=null){
  const [rows]=await db.query(`SELECT c.id,c.customer_code,c.name,c.phone,c.site_id,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.customer_status<>'terminated' ORDER BY c.name`);
  const low=String(text||'').toLowerCase(); const words=new Set(cleanWords(text));
  const scored=[];
  for(const c of rows){
    if(siteHint && String(c.site_code).toUpperCase()!==String(siteHint).toUpperCase()) continue;
    let score=0; const code=String(c.customer_code||'').toLowerCase(); const name=String(c.name||'').toLowerCase(); const nw=cleanWords(name);
    if(code && low.includes(code)) score+=100;
    for(const w of nw){if(words.has(w))score+=18; else if(w.length>=4&&low.includes(w))score+=10;}
    if(nw.length&&nw.every(w=>words.has(w))) score+=45;
    if(score>0) scored.push({...c,_score:score});
  }
  scored.sort((a,b)=>b._score-a._score||a.name.localeCompare(b.name));
  const top=scored[0]||null; const second=scored[1]||null;
  return {customer:top,ambiguous:!!(top&&second&&top._score-second._score<15),candidates:scored.slice(0,4)};
}
async function matchEmployee(text){
  const [rows]=await db.query(`SELECT id,employee_code,name,phone,user_id FROM employees WHERE is_active=1 ORDER BY CHAR_LENGTH(name) DESC`);
  const low=String(text||'').toLowerCase();
  const tokens=new Set(cleanWords(low));
  const scored=rows.map(e=>{
    let score=0;
    const code=String(e.employee_code||'').toLowerCase().trim();
    const name=String(e.name||'').toLowerCase().trim();
    if(code && (tokens.has(code) || low.includes(code))) score+=80;
    const nameWords=cleanWords(name);
    for(const w of nameWords){ if(tokens.has(w)) score+=30; }
    if(name && low.includes(name)) score+=50;
    return {...e,_score:score};
  }).filter(e=>e._score>0).sort((a,b)=>b._score-a._score || String(a.name).localeCompare(String(b.name)));
  return scored[0]||null;
}


async function resolveSitePic(siteId, reporter){
  if(!Number(siteId)) return reporter;
  const [[row]]=await db.execute(`SELECT e.id,e.employee_code,e.name,e.phone,e.user_id FROM operations_site_pic_rules r JOIN employees e ON e.id=r.primary_employee_id AND e.is_active=1 WHERE r.site_id=? LIMIT 1`,[Number(siteId)]);
  return row||reporter;
}

async function findActiveTicket({customerId=null,siteCode=null,employeeId=null}){
  let sql=`SELECT t.id,t.ticket_code,t.subject,t.status,t.assigned_employee_id,c.name customer_name,c.customer_code,s.code site_code FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id WHERE t.status<>'closed'`;
  const p=[]; if(customerId){sql+=` AND t.customer_id=?`;p.push(customerId);} if(siteCode){sql+=` AND s.code=?`;p.push(siteCode);} if(employeeId){sql+=` AND t.assigned_employee_id=?`;p.push(employeeId);} sql+=` ORDER BY t.id DESC LIMIT 5`;
  const [r]=await db.execute(sql,p); return r;
}
async function createIncidentTicket({customer,site,employee,text,payload}){
  const picEmployee=await resolveSitePic(customer?.site_id||site?.id,employee);
  const code=(()=>{const d=new Date();const ymd=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;return `TT-${ymd}-${String(Date.now()).slice(-6)}`;})();
  const baseSubject=issueLabel(text); const subject=!customer&&site?`[${site.code}] ${baseSubject}`:baseSubject; const priority=priorityFromText(text);
  const userId=employee.user_id||((await db.query(`SELECT id FROM users WHERE is_active=1 ORDER BY CASE role WHEN 'master_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,id LIMIT 1`))[0][0]?.id||null);
  const [r]=await db.execute(`INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,assigned_employee_id,assigned_to,opened_by,opened_at,source) VALUES(?,?,?,?,?,'open',?,?,?,?,NOW(),'whatsapp')`,
    [code,customer?.id||null,subject,'Gangguan Internet',priority,text,picEmployee?.id||null,picEmployee?.user_id||null,userId]);
  await ensureSupervisorState(r.insertId); if(picEmployee?.id) await setStage(r.insertId,'ASSIGNED',{note:`Terdeteksi dari percakapan WhatsApp. PIC ${picEmployee.name}. Lapor oleh ${employee.name}.`,source:'whatsapp',employee_id:picEmployee.id,user_id:employee.user_id});
  await createActivity({activity_type:'incident',title:`${subject}${customer?` · ${customer.name}`:''}`,description:text,site_id:customer?.site_id||site?.id||null,customer_id:customer?.id||null,ticket_id:r.insertId,status:'in_progress',priority,primary_employee_id:picEmployee?.id||null,source:'whatsapp',source_message_id:payload?.id||null,source_chat_id:payload?.from||null,source_sender_phone:employee?.phone||null},{user_id:employee?.user_id,employee_id:employee?.id,source:'whatsapp'});
  if(picEmployee?.id) await recordKpiEvent({employeeId:picEmployee.id,eventType:'ticket_created_or_taken',entityType:'ticket',entityId:r.insertId,metadata:{ticket_code:code,source:'wa_natural'}});
  return {id:r.insertId,code,subject,priority,pic:picEmployee};
}
async function createOpsActivity({type,site,customer,employee,text,payload}){
  const picEmployee=await resolveSitePic(customer?.site_id||site?.id,employee);
  const titleMap={psb:'PSB / Pelanggan Baru',maintenance:'Maintenance',migration:'Migrasi',survey:'Survey',followup:'Follow Up'};
  return createActivity({activity_type:type,title:`${titleMap[type]||'Aktivitas'}${customer?` · ${customer.name}`:site?` · ${site.code}`:''}`,description:text,site_id:customer?.site_id||site?.id||null,customer_id:customer?.id||null,status:'in_progress',priority:priorityFromText(text),primary_employee_id:picEmployee?.id||null,source:'whatsapp',source_message_id:payload?.id||null,source_chat_id:payload?.from||null,source_sender_phone:employee?.phone||null},{user_id:employee?.user_id,employee_id:employee?.id,source:'whatsapp'});
}

async function executePending(pending,{employee,payload}){
  let data; try{data=typeof pending.payload_json==='string'?JSON.parse(pending.payload_json):pending.payload_json;}catch{data={};}
  await db.execute(`UPDATE wa_ops_pending_actions SET status='confirmed',confirmed_at=NOW() WHERE id=?`,[pending.id]);
  if(pending.action_type==='create_ticket'){
    const customer=data.customer_id?(await db.execute(`SELECT c.id,c.customer_code,c.name,c.site_id,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.id=? LIMIT 1`,[data.customer_id]))[0][0]:null;
    const site=data.site_id?(await db.execute(`SELECT id,code,name FROM sites WHERE id=? LIMIT 1`,[data.site_id]))[0][0]:null;
    const open=customer?await findActiveTicket({customerId:customer.id}):[]; if(open.length) return `⚠️ ${customer.name} sudah punya tiket aktif *${open[0].ticket_code}* (${open[0].subject}). Tiket baru tidak dibuat.`;
    const t=await createIncidentTicket({customer,site,employee,text:data.text||'',payload}); await saveContext(payload.from,{last_ticket_id:t.id,last_customer_id:customer?.id,last_site_code:customer?.site_code||site?.code,last_intent:'incident',last_message_id:payload.id});
    return `✅ Tiket *${t.code}* dibuat\n${customer?`${customer.name} · ${customer.site_code}\n`:site?`Site ${site.code}\n`:''}${t.subject}\nPIC: ${t.pic?.name||employee.name}`;
  }
  if(pending.action_type==='create_activity'){
    const site=data.site_id?(await db.execute(`SELECT id,code,name FROM sites WHERE id=? LIMIT 1`,[data.site_id]))[0][0]:null;
    const customer=data.customer_id?(await db.execute(`SELECT c.id,c.customer_code,c.name,c.site_id,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.id=? LIMIT 1`,[data.customer_id]))[0][0]:null;
    const a=await createOpsActivity({type:data.type,site,customer,employee,text:data.text||'',payload}); return `✅ Aktivitas *${a.activity_code}* dicatat sebagai ${String(data.type||'aktivitas').toUpperCase()}.`;
  }
  return 'Aksi sudah dikonfirmasi.';
}

async function handleNaturalMessage({text,payload,employee,chatId,senderPhone}){
  const raw=normalizeText(text); if(!raw||raw.length<2) return {handled:false};
  const pending=await getPending(chatId,senderPhone);
  if(pending&&CONFIRM_RE.test(raw)) return {handled:true,text:await executePending(pending,{employee,payload})};
  if(pending&&CANCEL_RE.test(raw)){await db.execute(`UPDATE wa_ops_pending_actions SET status='cancelled' WHERE id=?`,[pending.id]);return{handled:true,text:'👍 Oke, dibatalkan.'};}

  const context=await loadContext(chatId); const stage=detectStage(raw);
  const siteHint=await siteFromText(raw);
  const matchedNow=await matchCustomer(raw,siteHint?.code||null);
  const mentionedEmployee=await matchEmployee(raw);
  if(stage){
    let tickets=[];
    if(matchedNow.customer && !matchedNow.ambiguous) tickets=await findActiveTicket({customerId:matchedNow.customer.id});
    if(!tickets.length && context?.last_ticket_id){const [r]=await db.execute(`SELECT id,ticket_code,subject,status,assigned_employee_id FROM tickets WHERE id=? AND status<>'closed' LIMIT 1`,[context.last_ticket_id]);tickets=r;}
    const targetEmployee=mentionedEmployee||employee;
    if(!tickets.length) tickets=await findActiveTicket({employeeId:targetEmployee.id});
    if(tickets.length===1){
      const t=tickets[0];
      if(mentionedEmployee && Number(t.assigned_employee_id||0)!==Number(mentionedEmployee.id)) await db.execute(`UPDATE tickets SET assigned_employee_id=?,assigned_to=? WHERE id=?`,[mentionedEmployee.id,mentionedEmployee.user_id||null,t.id]);
      await setStage(t.id,stage,{note:`${employee.name}: ${raw}`,source:'whatsapp',employee_id:targetEmployee.id,user_id:employee.user_id});
      await saveContext(chatId,{last_ticket_id:t.id,last_customer_id:matchedNow.customer?.id||context?.last_customer_id,last_site_code:matchedNow.customer?.site_code||siteHint?.code||context?.last_site_code,last_intent:'ticket_update',last_message_id:payload.id});
      if(stage==='CLOSED') await recordKpiEvent({employeeId:targetEmployee.id,eventType:'ticket_closed',entityType:'ticket',entityId:t.id});
      return {handled:true,text:`✅ *${t.ticket_code}* → ${stage.replace('_',' ')}\nPIC: ${targetEmployee.name}\nUpdate: ${raw}`};
    }
    if(tickets.length>1) return {handled:true,text:`Saya menemukan ${tickets.length} tiket aktif yang mungkin dimaksud. Reply notifikasi tiket atau sebut nama pelanggan/kode tiket agar tidak salah update.`};
  }

  const type=detectType(raw); if(!type){
    if(context?.last_ticket_id && /\b(hujan|tunggu|kendala|material|kabel|odp|tiang|akses|izin|belum sempat|nanti)\b/i.test(raw)){
      await addSupervisorNote(context.last_ticket_id,`${employee.name}: ${raw}`,{source:'whatsapp',employee_id:employee.id,user_id:employee.user_id,hold_until:/hujan|tunggu/i.test(raw)?new Date(Date.now()+45*60000):null});
      return {handled:true,text:`📝 Catatan kendala ditambahkan ke tiket yang sedang dibahas.`};
    }
    if(matchedNow.customer && !matchedNow.ambiguous) await saveContext(chatId,{last_customer_id:matchedNow.customer.id,last_site_code:matchedNow.customer.site_code,last_intent:'context',last_message_id:payload.id});
    else if(siteHint) await saveContext(chatId,{last_site_code:siteHint.code,last_intent:'context',last_message_id:payload.id});
    return {handled:false};
  }

  const site=siteHint; let matched=matchedNow;
  if((!matched.customer || matched.ambiguous) && context?.last_customer_id){const [r]=await db.execute(`SELECT c.id,c.customer_code,c.name,c.phone,c.site_id,s.code site_code FROM customers c JOIN sites s ON s.id=c.site_id WHERE c.id=? LIMIT 1`,[context.last_customer_id]);if(r[0]) matched={customer:{...r[0],_score:70},ambiguous:false,candidates:r};}
  const customer=matched.customer;
  if(type==='incident'){
    if(matched.ambiguous){return {handled:true,text:`Saya menangkap laporan gangguan, tapi pelanggan masih ambigu:\n${matched.candidates.map((c,i)=>`${i+1}. ${c.name} · ${c.site_code} · ${c.customer_code}`).join('\n')}\n\nGunakan nama/Customer ID yang lebih lengkap.`};}
    if(customer && customer._score>=35){
      const open=await findActiveTicket({customerId:customer.id}); if(open.length){await saveContext(chatId,{last_ticket_id:open[0].id,last_customer_id:customer.id,last_site_code:customer.site_code,last_intent:'incident',last_message_id:payload.id});return{handled:true,text:`ℹ️ Gangguan terdeteksi untuk *${customer.name}*, tetapi sudah ada tiket aktif *${open[0].ticket_code}* — ${open[0].subject}. Saya kaitkan percakapan berikutnya ke tiket ini.`};}
      if(customer._score>=60){const t=await createIncidentTicket({customer,site,employee,text:raw,payload});await saveContext(chatId,{last_ticket_id:t.id,last_customer_id:customer.id,last_site_code:customer.site_code,last_intent:'incident',last_message_id:payload.id});return{handled:true,text:`🚨 Gangguan terdeteksi dan tiket dibuat\n*${t.code}*\n${customer.name} · ${customer.site_code}\n${t.subject}\nPIC: ${t.pic?.name||employee.name}`};}
      await putPending(chatId,senderPhone,payload.id,'create_ticket',{customer_id:customer.id,text:raw});return{handled:true,text:`Saya menangkap indikasi gangguan:\n*${customer.name}* · ${customer.site_code}\n${issueLabel(raw)}\n\nBuat tiket? Balas *iya* atau *batal*.`};
    }
    if(site){await putPending(chatId,senderPhone,payload.id,'create_ticket',{customer_id:null,site_id:site.id,text:raw});return{handled:true,text:`Saya menangkap gangguan di *${site.code}*, tapi pelanggan belum jelas. Jika ini gangguan site/internal, balas *iya* untuk buat tiket internal; atau kirim nama pelanggan.`};}
    return {handled:false};
  }

  const payloadData={type,site_id:site?.id||customer?.site_id||null,customer_id:customer?.id||null,text:raw};
  if(site||customer){await putPending(chatId,senderPhone,payload.id,'create_activity',payloadData);return{handled:true,text:`Terdeteksi aktivitas *${type.toUpperCase()}*${customer?` untuk ${customer.name}`:site?` di ${site.code}`:''}.\nCatat ke Operations Center? Balas *iya* atau *batal*.`};}
  return {handled:false};
}

module.exports={handleNaturalMessage,detectType,detectStage,matchCustomer,matchEmployee,siteFromText,issueLabel};
