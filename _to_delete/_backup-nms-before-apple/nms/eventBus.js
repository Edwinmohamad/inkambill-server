// Bus internal: poller/webhook/aksi → SSE stream (routes/nms.js).
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(200);
module.exports = bus;
