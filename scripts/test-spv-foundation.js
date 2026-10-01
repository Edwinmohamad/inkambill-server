const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname,'..');
const schema = fs.readFileSync(path.join(root,'services','schemaService.js'),'utf8');
const route = fs.readFileSync(path.join(root,'routes','n8n.js'),'utf8');
const supervisor = fs.readFileSync(path.join(root,'services','ticketSupervisorService.js'),'utf8');
const ops = fs.readFileSync(path.join(root,'services','operationsActivityService.js'),'utf8');
const app = fs.readFileSync(path.join(root,'app.js'),'utf8');

for (const table of ['ticket_supervisor_state','ticket_supervisor_events','operations_activities','operations_activity_members','operations_activity_updates','team_kpi_events']) {
  assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Schema table missing: ${table}`);
}
for (const endpoint of ['/operations/activities','/operations/tickets/:id/stage','/operations/tickets/:id/note','/operations/supervisor-snapshot']) {
  assert(route.includes(endpoint), `Endpoint missing: ${endpoint}`);
}
for (const stage of ['OPEN','ASSIGNED','OTW','ON_SITE','WORKING','RESOLVED','VERIFIED','CLOSED']) {
  assert(supervisor.includes(`'${stage}'`), `Stage missing: ${stage}`);
}
for (const type of ['incident','psb','installation','maintenance','migration','survey','followup','other']) {
  assert(ops.includes(`'${type}'`), `Activity type missing: ${type}`);
}
assert(app.includes('await ensureV59Schema();'), 'ensureV59Schema is not called at startup');
assert(schema.includes('ensureV59Schema') && schema.includes('ensureV60Schema'), 'ensureV59/V60 schema export missing');
assert(route.includes("beginEvent('operations.activity.create'"), 'activity create is not idempotent');
assert(ops.includes('source_message_id'), 'source_message_id dedup is missing');
console.log('SPV Operations foundation checks: OK');
