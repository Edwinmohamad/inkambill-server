const db = require('../config/db');
const { recordKpiEvent } = require('./operationsActivityService');

const STAGES = new Set(['OPEN','ASSIGNED','OTW','ON_SITE','WORKING','RESOLVED','VERIFIED','CLOSED']);

function stageFromLegacy(ticket) {
  if (String(ticket.status) === 'closed') return 'CLOSED';
  if (String(ticket.status) === 'pending') return 'RESOLVED';
  if (String(ticket.status) === 'progress') return ticket.assigned_employee_id ? 'WORKING' : 'OPEN';
  if (ticket.assigned_employee_id) return 'ASSIGNED';
  return 'OPEN';
}

function legacyStatusForStage(stage) {
  if (stage === 'CLOSED') return 'closed';
  if (['RESOLVED','VERIFIED'].includes(stage)) return 'pending';
  if (['OTW','ON_SITE','WORKING'].includes(stage)) return 'progress';
  return 'open';
}

async function ensureSupervisorState(ticketId) {
  const [[ticket]] = await db.execute(`SELECT id,status,assigned_employee_id,opened_at,updated_at FROM tickets WHERE id=? LIMIT 1`, [ticketId]);
  if (!ticket) throw new Error('Tiket tidak ditemukan.');
  const [[state]] = await db.execute(`SELECT * FROM ticket_supervisor_state WHERE ticket_id=? LIMIT 1`, [ticketId]);
  if (state) return state;
  const stage = stageFromLegacy(ticket);
  await db.execute(`INSERT INTO ticket_supervisor_state(ticket_id,stage,stage_changed_at,last_activity_at)
    VALUES(?,?,COALESCE(?,NOW()),COALESCE(?,NOW()))`, [ticketId,stage,ticket.updated_at||ticket.opened_at,ticket.updated_at||ticket.opened_at]);
  const [[created]] = await db.execute(`SELECT * FROM ticket_supervisor_state WHERE ticket_id=? LIMIT 1`, [ticketId]);
  return created;
}

async function setStage(ticketId, stage, opts = {}) {
  const next = String(stage || '').trim().toUpperCase();
  if (!STAGES.has(next)) throw new Error('Stage tiket tidak valid.');
  const state = await ensureSupervisorState(ticketId);
  const now = new Date();
  const changed = String(state.stage) !== next;
  await db.execute(`UPDATE ticket_supervisor_state SET stage=?,stage_changed_at=IF(?=1,NOW(),stage_changed_at),last_activity_at=NOW(),
      hold_until=CASE WHEN ?='CLOSED' THEN NULL ELSE hold_until END,
      reminder_count=CASE WHEN ?=1 THEN 0 ELSE reminder_count END,
      last_reminder_at=CASE WHEN ?=1 THEN NULL ELSE last_reminder_at END
    WHERE ticket_id=?`, [next,changed?1:0,next,changed?1:0,changed?1:0,ticketId]);
  const legacy = legacyStatusForStage(next);
  await db.execute(`UPDATE tickets SET status=?,closed_at=IF(?='closed',COALESCE(closed_at,NOW()),NULL) WHERE id=?`, [legacy,legacy,ticketId]);
  await db.execute(`INSERT INTO ticket_supervisor_events(ticket_id,event_type,stage,note,source,actor_user_id,actor_employee_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, [ticketId,changed?'stage_changed':'activity',next,String(opts.note||'').trim()||null,String(opts.source||'system').slice(0,20),Number(opts.user_id)||null,Number(opts.employee_id)||null,now]);
  if (changed) {
    const [[owner]] = await db.execute(`SELECT assigned_employee_id FROM tickets WHERE id=? LIMIT 1`, [ticketId]);
    const employeeId = Number(opts.employee_id || owner?.assigned_employee_id) || null;
    if (employeeId) {
      const prevAt = state.stage_changed_at ? new Date(state.stage_changed_at).getTime() : Date.now();
      await recordKpiEvent({ employeeId, eventType: `ticket_stage_${next.toLowerCase()}`, entityType: 'ticket', entityId: Number(ticketId), durationSeconds: Math.max(0, Math.round((Date.now()-prevAt)/1000)), metadata: { previous_stage: state.stage, stage: next, source: opts.source || 'system' } });
    }
  }
  return { ticketId:Number(ticketId), previousStage:state.stage, stage:next, changed, legacyStatus:legacy };
}

async function addSupervisorNote(ticketId, note, opts = {}) {
  const state = await ensureSupervisorState(ticketId);
  await db.execute(`UPDATE ticket_supervisor_state SET last_activity_at=NOW(),hold_until=? WHERE ticket_id=?`, [opts.hold_until||null,ticketId]);
  await db.execute(`INSERT INTO ticket_supervisor_events(ticket_id,event_type,stage,note,source,actor_user_id,actor_employee_id)
    VALUES(?,'note',?,?,?,?,?,?)`, [ticketId,state.stage,String(note||'').trim()||null,String(opts.source||'system').slice(0,20),Number(opts.user_id)||null,Number(opts.employee_id)||null]);
  return { ticketId:Number(ticketId), stage:state.stage };
}

async function supervisorSnapshot() {
  const [rows] = await db.query(`SELECT t.id,t.ticket_code,t.subject,t.priority,t.opened_at,t.assigned_employee_id,
      c.name customer_name,s.code site_code,e.name assigned_name,
      COALESCE(ss.stage,CASE WHEN t.status='closed' THEN 'CLOSED' WHEN t.status='pending' THEN 'RESOLVED' WHEN t.status='progress' THEN 'WORKING' WHEN t.assigned_employee_id IS NOT NULL THEN 'ASSIGNED' ELSE 'OPEN' END) stage,
      COALESCE(ss.stage_changed_at,t.updated_at,t.opened_at) stage_changed_at,
      COALESCE(ss.last_activity_at,t.updated_at,t.opened_at) last_activity_at,
      ss.last_reminder_at,COALESCE(ss.reminder_count,0) reminder_count,ss.hold_until
    FROM tickets t
    LEFT JOIN ticket_supervisor_state ss ON ss.ticket_id=t.id
    LEFT JOIN customers c ON c.id=t.customer_id
    LEFT JOIN sites s ON s.id=c.site_id
    LEFT JOIN employees e ON e.id=t.assigned_employee_id
    WHERE t.status<>'closed'
    ORDER BY FIELD(t.priority,'critical','high','medium','low'),t.opened_at ASC`);
  return rows;
}

module.exports = { STAGES, stageFromLegacy, legacyStatusForStage, ensureSupervisorState, setStage, addSupervisorNote, supervisorSnapshot };
