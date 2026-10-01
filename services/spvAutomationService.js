const db = require('../config/db');
const { supervisorSnapshot, ensureSupervisorState } = require('./ticketSupervisorService');
const notify = require('./ticketWaNotifyService');

const envMin=(name,fallback)=>{const n=Number(process.env[name]);return Number.isFinite(n)&&n>=1?n:fallback;};
const RULES={
  OPEN:{after:envMin('SPV_OPEN_REMINDER_MIN',15),label:'belum ditangani'},
  ASSIGNED:{after:envMin('SPV_ASSIGNED_REMINDER_MIN',30),label:'belum ada update PIC'},
  OTW:{after:envMin('SPV_OTW_REMINDER_MIN',60),label:'OTW cukup lama'},
  ON_SITE:{after:envMin('SPV_ONSITE_REMINDER_MIN',90),label:'onsite tanpa progres'},
  WORKING:{after:envMin('SPV_WORKING_REMINDER_MIN',120),label:'proses cukup lama'},
  RESOLVED:{after:envMin('SPV_RESOLVED_REMINDER_MIN',60),label:'resolved belum diverifikasi'},
  VERIFIED:{after:envMin('SPV_VERIFIED_REMINDER_MIN',60),label:'verified belum ditutup'}
};
const SLA_MINUTES={critical:240,high:480,medium:1440,low:2880};
function mins(a,b=new Date()){return Math.max(0,Math.floor((b-new Date(a))/60000));}
function ageText(m){const h=Math.floor(m/60),mm=m%60;return h?`${h}j ${mm}m`:`${mm}m`;}
function reminderCooldown(count){return count<=0?envMin('SPV_REMINDER_COOLDOWN_1_MIN',30):count===1?envMin('SPV_REMINDER_COOLDOWN_2_MIN',60):envMin('SPV_REMINDER_COOLDOWN_3_MIN',120);}
function groupIds(){return notify.ticketGroupIds();}

async function buildSupervisorCycle({force=false}={}){
  const rows=await supervisorSnapshot(); const now=new Date(); const messages=[];
  for(const t of rows){
    await ensureSupervisorState(t.id);
    if(t.hold_until&&new Date(t.hold_until)>now) continue;
    const stage=String(t.stage||'OPEN'); const rule=RULES[stage]; if(!rule) continue;
    const idle=mins(t.last_activity_at||t.stage_changed_at||t.opened_at,now); const age=mins(t.opened_at,now); const sla=SLA_MINUTES[String(t.priority)]||SLA_MINUTES.medium; const overSla=age>sla;
    if(!force&&!overSla&&idle<rule.after) continue;
    const sinceReminder=t.last_reminder_at?mins(t.last_reminder_at,now):99999; const cooldown=reminderCooldown(Number(t.reminder_count||0)); if(!force&&sinceReminder<cooldown) continue;
    let level=Number(t.reminder_count||0)+1; if(overSla) level=Math.max(level,3);
    const icon=overSla?'🚨':level>=3?'⚠️':'⏱️';
    const text=[`${icon} *SPV REMINDER*`,``,`*${t.ticket_code}* · ${t.site_code||'-'}`,`${t.customer_name||'Internal'} · ${t.subject}`,`PIC: ${t.assigned_name||'Belum ditugaskan'}`,`Status: ${stage.replace('_',' ')}`,`Tanpa update: ${ageText(idle)}`,overSla?`SLA: *LEWAT* (${ageText(age-sla)})`:`Umur tiket: ${ageText(age)}`,``,`Mohon update progres di grup atau web. Tiket tetap dipantau sampai *CLOSED*.`].filter(Boolean).join('\n');
    messages.push({ticket_id:t.id,ticket_code:t.ticket_code,chat_ids:groupIds(),text,level,over_sla:overSla});
    await db.execute(`UPDATE ticket_supervisor_state SET last_reminder_at=NOW(),reminder_count=reminder_count+1,escalation_level=GREATEST(escalation_level,?),last_escalated_at=IF(? >= 3,NOW(),last_escalated_at) WHERE ticket_id=?`,[level,level,t.id]);
    await db.execute(`INSERT INTO ticket_supervisor_events(ticket_id,event_type,stage,note,source) VALUES(?,'reminder',?,?,'system')`,[t.id,stage,overSla?'Supervisor reminder: SLA terlewati':`Supervisor reminder: ${rule.label}`]);
  }
  return {checked:rows.length,reminders:messages.length,messages};
}

async function dailySummary(period='morning'){
  const rows=await supervisorSnapshot(); const todayStart=new Date();todayStart.setHours(0,0,0,0);
  const [activityRows]=await db.query(`SELECT activity_type,status,COUNT(*) total FROM operations_activities WHERE DATE(created_at)=CURDATE() GROUP BY activity_type,status`);
  const [ticketStats]=await db.query(`SELECT COUNT(*) created_today,SUM(status='closed' AND DATE(closed_at)=CURDATE()) closed_today FROM tickets WHERE DATE(opened_at)=CURDATE() OR (status='closed' AND DATE(closed_at)=CURDATE())`);
  const over=rows.filter(t=>mins(t.opened_at)> (SLA_MINUTES[String(t.priority)]||1440));
  const silent=rows.filter(t=>mins(t.last_activity_at||t.opened_at)>=60);
  const label=period==='evening'?'DAILY OPS REPORT':period==='midday'?'MIDDAY CHECK':'MORNING CHECK';
  const lines=[`📋 *SPV ${label}*`,``,`Tiket belum CLOSED: *${rows.length}*`,`Lewat SLA: *${over.length}*`,`Tanpa update ≥1 jam: *${silent.length}*`,`Dibuat hari ini: *${Number(ticketStats[0]?.created_today||0)}*`,`Closed hari ini: *${Number(ticketStats[0]?.closed_today||0)}*`];
  const byType={}; for(const x of activityRows){byType[x.activity_type]=(byType[x.activity_type]||0)+Number(x.total||0);} if(Object.keys(byType).length){lines.push('',`Aktivitas hari ini:`,...Object.entries(byType).map(([k,v])=>`• ${k.toUpperCase()}: ${v}`));}
  if(rows.length){lines.push('',`Prioritas aktif:`,...rows.slice(0,5).map(t=>`• ${t.ticket_code} · ${t.site_code||'-'} · ${t.stage} · ${t.assigned_name||'Belum PIC'}`));}
  if(period==='morning') lines.push('',`Ada PSB, instalasi, maintenance, migrasi, survey, atau aktivitas lapangan hari ini?`,`Tulis saja dengan bahasa biasa di grup — bot akan menawarkan pencatatan otomatis.`);
  if(period==='evening' && rows.length) lines.push('',`⚠️ Tiket di atas tetap masuk reminder besok sampai benar-benar CLOSED.`);
  return {period,open_count:rows.length,over_sla:over.length,silent:silent.length,messages:groupIds().map(chatId=>({chatId,text:lines.join('\n')}))};
}

module.exports={buildSupervisorCycle,dailySummary,RULES,SLA_MINUTES};
