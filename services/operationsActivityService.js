const db = require('../config/db');

const ACTIVITY_TYPES = new Set(['incident','psb','installation','maintenance','migration','survey','followup','other']);
const ACTIVITY_STATUS = new Set(['planned','in_progress','done','cancelled']);
const PRIORITIES = new Set(['low','medium','high','critical']);
const SOURCES = new Set(['web','whatsapp','n8n','system']);

function cleanEnum(value, allowed, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return allowed.has(v) ? v : fallback;
}

function activityCode() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `ACT-${ymd}-${String(Date.now()).slice(-6)}`;
}

async function createActivity(input = {}, actor = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Judul aktivitas wajib diisi.');
  const type = cleanEnum(input.activity_type, ACTIVITY_TYPES, 'other');
  const status = cleanEnum(input.status, ACTIVITY_STATUS, 'planned');
  const priority = cleanEnum(input.priority, PRIORITIES, 'medium');
  const source = cleanEnum(input.source || actor.source, SOURCES, 'n8n');
  const code = String(input.activity_code || activityCode()).slice(0, 40);
  const sourceMessageId = input.source_message_id ? String(input.source_message_id).slice(0, 190) : null;

  if (sourceMessageId) {
    const [[existing]] = await db.execute(`SELECT id,activity_code FROM operations_activities WHERE source_message_id=? LIMIT 1`, [sourceMessageId]);
    if (existing) return { id: existing.id, activity_code: existing.activity_code, duplicate: true };
  }

  const startedAt = input.started_at || (status === 'in_progress' ? new Date() : null);
  const completedAt = input.completed_at || (status === 'done' ? new Date() : null);
  const [r] = await db.execute(`INSERT INTO operations_activities(
      activity_code,activity_type,title,description,site_id,customer_id,ticket_id,status,priority,
      primary_employee_id,source,source_message_id,source_chat_id,source_sender_phone,started_at,completed_at,created_by_user_id,created_by_employee_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      code,type,title,String(input.description||'').trim()||null,Number(input.site_id)||null,Number(input.customer_id)||null,
      Number(input.ticket_id)||null,status,priority,Number(input.primary_employee_id)||null,source,sourceMessageId,input.source_chat_id?String(input.source_chat_id).slice(0,190):null,input.source_sender_phone?String(input.source_sender_phone).slice(0,32):null,
      startedAt,completedAt,Number(actor.user_id)||null,Number(actor.employee_id)||null
    ]);
  await addActivityUpdate(r.insertId, {
    event_type: 'created', status, note: input.note || `Aktivitas dibuat (${type}).`, source
  }, actor);
  if (input.primary_employee_id) await addMember(r.insertId, Number(input.primary_employee_id), 'pic');
  return { id: r.insertId, activity_code: code, duplicate: false };
}

async function addMember(activityId, employeeId, role = 'helper') {
  if (!Number(activityId) || !Number(employeeId)) return false;
  const memberRole = ['pic','helper','observer'].includes(String(role)) ? String(role) : 'helper';
  await db.execute(`INSERT INTO operations_activity_members(activity_id,employee_id,role,status)
    VALUES(?,?,?,'assigned') ON DUPLICATE KEY UPDATE role=VALUES(role)`, [activityId, employeeId, memberRole]);
  return true;
}

async function addActivityUpdate(activityId, input = {}, actor = {}) {
  const status = input.status ? cleanEnum(input.status, ACTIVITY_STATUS, null) : null;
  const source = cleanEnum(input.source || actor.source, SOURCES, 'n8n');
  const eventType = String(input.event_type || 'note').trim().slice(0, 50) || 'note';
  const note = String(input.note || '').trim() || null;
  const [r] = await db.execute(`INSERT INTO operations_activity_updates(activity_id,event_type,status,note,source,actor_user_id,actor_employee_id)
    VALUES(?,?,?,?,?,?,?)`, [activityId,eventType,status,note,source,Number(actor.user_id)||null,Number(actor.employee_id)||null]);
  if (status) {
    await db.execute(`UPDATE operations_activities SET status=?,started_at=IF(?='in_progress',COALESCE(started_at,NOW()),started_at),completed_at=IF(?='done',COALESCE(completed_at,NOW()),IF(?='cancelled',completed_at,NULL)) WHERE id=?`, [status,status,status,status,activityId]);
    const [[activity]] = await db.execute(`SELECT primary_employee_id,started_at,created_at FROM operations_activities WHERE id=? LIMIT 1`, [activityId]);
    const employeeId = Number(actor.employee_id || activity?.primary_employee_id) || null;
    if (employeeId) {
      const base = activity?.started_at || activity?.created_at;
      const durationSeconds = base ? Math.max(0, Math.round((Date.now()-new Date(base).getTime())/1000)) : null;
      await recordKpiEvent({ employeeId, eventType: `activity_${status}`, entityType: 'activity', entityId: Number(activityId), durationSeconds, metadata: { source, event_type: eventType } });
    }
  }
  return r.insertId;
}

async function recordKpiEvent({ employeeId, eventType, entityType = 'activity', entityId = null, metricValue = 1, durationSeconds = null, metadata = null, occurredAt = null }) {
  if (!Number(employeeId) || !String(eventType || '').trim()) return null;
  const [r] = await db.execute(`INSERT INTO team_kpi_events(employee_id,event_type,entity_type,entity_id,metric_value,duration_seconds,metadata_json,occurred_at)
    VALUES(?,?,?,?,?,?,?,COALESCE(?,NOW()))`, [Number(employeeId),String(eventType).slice(0,80),String(entityType).slice(0,40),Number(entityId)||null,Number(metricValue)||0,Number(durationSeconds)||null,metadata?JSON.stringify(metadata).slice(0,20000):null,occurredAt||null]);
  return r.insertId;
}

module.exports = { createActivity, addActivityUpdate, addMember, recordKpiEvent, ACTIVITY_TYPES, ACTIVITY_STATUS };
