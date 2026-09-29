'use strict';
// Process-local delivery diagnostics. A restart resets these counters; no message content is stored.
const startedAt = new Date().toISOString();
let lastEventAt = null, lastMessageAt = null, lastErrorAt = null, lastError = null;
let events = 0, inbound = 0;
function record(event, result) {
  lastEventAt = new Date().toISOString(); events++;
  if ((event === 'message' || event === 'message.any') && result && !result.skipped) { lastMessageAt = lastEventAt; inbound++; }
}
function error(err) { lastErrorAt = new Date().toISOString(); lastError = String(err?.message || err).slice(0, 200); }
function snapshot() { return { startedAt, lastEventAt, lastMessageAt, lastErrorAt, lastError, events, inbound }; }
module.exports = { record, error, snapshot };
