// Pure parser for WhatsApp ticket commands (no DB / network) so it can be unit-tested in isolation.
// Used by services/waTicketCommandService.js. Commands start with a prefix (default "#"), e.g.:
//   #buat PLG-0012 tinggi Internet mati sejak pagi
//   #update TT-20260923-123456 60% ganti konektor, tunggu redaman
//   #close 123456 kabel drop diganti, redaman normal -19 dBm
const PRIORITY_ALIASES = {
  low: 'low', rendah: 'low',
  medium: 'medium', sedang: 'medium', normal: 'medium',
  high: 'high', tinggi: 'high',
  critical: 'critical', kritis: 'critical', urgent: 'critical', darurat: 'critical'
};

const COMMAND_ALIASES = {
  help: 'help', bantuan: 'help', menu: 'help',
  buat: 'create', lapor: 'create', baru: 'create', create: 'create',
  cek: 'show', detail: 'show', info: 'show',
  list: 'list', daftar: 'list', tiket: 'list',
  tiketku: 'mine', saya: 'mine',
  ambil: 'take',
  assign: 'assign', tugaskan: 'assign',
  update: 'update', progress: 'update', proses: 'update',
  pending: 'pending', tunda: 'pending',
  close: 'close', selesai: 'close', tutup: 'close',
  buka: 'reopen', reopen: 'reopen',
  prioritas: 'priority', priority: 'priority',
  idgrup: 'groupid', groupid: 'groupid'
};

const LIST_FILTERS = { open: 'open', progress: 'progress', proses: 'progress', pending: 'pending', semua: 'active', aktif: 'active', all: 'active' };

function normalizePriority(value) {
  return PRIORITY_ALIASES[String(value || '').trim().toLowerCase()] || null;
}

// Splits "rest of first line" + "remaining lines" so multi-line WA messages keep their line breaks
// in notes/descriptions while the first line carries the positional arguments.
function splitFirstLine(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const first = (lines.shift() || '').trim();
  const restLines = lines.join('\n').trim();
  return { first, restLines };
}

function takeToken(str) {
  const s = String(str || '').trim();
  if (!s) return ['', ''];
  const m = s.match(/^(\S+)\s*([\s\S]*)$/);
  return [m[1], m[2].trim()];
}

function joinNote(inline, restLines) {
  return [inline, restLines].filter(Boolean).join('\n').trim();
}

function parseCommand(text, prefix = '#') {
  const raw = String(text || '').trim();
  if (!raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);
  const { first, restLines } = splitFirstLine(body);
  const [word, afterWord] = takeToken(first);
  const keyword = word.toLowerCase();
  const command = COMMAND_ALIASES[keyword];
  if (!keyword) return { command: 'help' };
  if (!command) return { command: 'unknown', keyword };

  switch (command) {
    case 'help':
    case 'mine':
    case 'groupid':
      return { command };

    case 'list': {
      const [f] = takeToken(afterWord);
      const filter = f ? LIST_FILTERS[f.toLowerCase()] : 'active';
      if (!filter) return { command, error: `Filter "${f}" tidak dikenal. Pakai: open, progress, pending, semua.` };
      return { command, filter };
    }

    case 'create': {
      const [customerRef, afterCustomer] = takeToken(afterWord);
      if (!customerRef) return { command, error: 'Format: #buat <kode_pelanggan atau -> [prioritas] <keluhan>' };
      let [maybePriority, afterPriority] = takeToken(afterCustomer);
      let priority = normalizePriority(maybePriority);
      let subject = priority ? afterPriority : afterCustomer;
      if (!priority) priority = 'medium';
      subject = subject.trim();
      if (!subject) return { command, error: 'Keluhan/subjek tiket wajib diisi.\nContoh: #buat PLG-0012 tinggi Internet mati sejak pagi' };
      return {
        command,
        customerRef: customerRef === '-' ? null : customerRef,
        priority,
        subject: subject.slice(0, 190),
        description: restLines || null
      };
    }

    case 'show':
    case 'take': {
      const [ticketRef] = takeToken(afterWord);
      if (!ticketRef) return { command, error: `Format: #${keyword} <kode_tiket>` };
      return { command, ticketRef };
    }

    case 'assign': {
      const [ticketRef, afterTicket] = takeToken(afterWord);
      const [employeeRef] = takeToken(afterTicket);
      if (!ticketRef || !employeeRef) return { command, error: 'Format: #assign <kode_tiket> <kode_karyawan>' };
      return { command, ticketRef, employeeRef };
    }

    case 'update':
    case 'pending':
    case 'close':
    case 'reopen': {
      const [ticketRef, afterTicket] = takeToken(afterWord);
      if (!ticketRef) return { command, error: `Format: #${keyword} <kode_tiket> ${command === 'update' ? '[persen%] ' : ''}<catatan>` };
      let percent = null;
      let noteInline = afterTicket;
      if (command === 'update') {
        const [maybePercent, afterPercent] = takeToken(afterTicket);
        const m = maybePercent.match(/^(\d{1,3})%$/);
        if (m) {
          percent = Number(m[1]);
          if (percent > 100) return { command, error: 'Persentase progress maksimal 100%.' };
          noteInline = afterPercent;
        }
      }
      const note = joinNote(noteInline, restLines);
      if (!note && command !== 'close') return { command, error: `Catatan wajib diisi.\nContoh: #${keyword} ${ticketRef} ${command === 'update' ? '50% ' : ''}keterangan pekerjaan` };
      return { command, ticketRef, percent, note: note || null };
    }

    case 'priority': {
      const [ticketRef, afterTicket] = takeToken(afterWord);
      const [level] = takeToken(afterTicket);
      const priority = normalizePriority(level);
      if (!ticketRef || !priority) return { command, error: 'Format: #prioritas <kode_tiket> <rendah|sedang|tinggi|kritis>' };
      return { command, ticketRef, priority };
    }
    default:
      return { command: 'unknown', keyword };
  }
}

// Short actions are accepted only when the message is a reply to a ticket notification. The caller
// supplies the ticket reference extracted from that quoted notification, so technicians never need
// to type a ticket code for normal field updates.
function parseReplyCommand(text, ticketRef) {
  const raw = String(text || '').trim();
  if (!ticketRef || !raw || raw.startsWith('#')) return null;
  const { first, restLines } = splitFirstLine(raw);
  const [word, afterWord] = takeToken(first);
  const command = COMMAND_ALIASES[word.toLowerCase()];
  if (!['update', 'pending', 'close'].includes(command)) return null;
  const note = joinNote(afterWord, restLines);
  if (command === 'update' && word.toLowerCase() === 'proses' && !note) {
    return { command, ticketRef, percent: null, note: 'Mulai diproses via WhatsApp.', replied: true };
  }
  if (command !== 'close' && !note) {
    return { command, ticketRef, error: `Tambahkan catatan, contoh: ${word.toLowerCase()} sedang menuju lokasi.` };
  }
  return { command, ticketRef, percent: null, note: note || null, replied: true };
}

const HELP_TEXT = [
  '*INKAMBILLING — Bot Tiket*',
  '',
  '#buat <kode_pelanggan|-> [prioritas] <keluhan>',
  '   baris berikutnya = deskripsi (opsional)',
  '#list [open|progress|pending|semua]',
  '#tiketku — tiket aktif yang ditugaskan ke saya',
  '#cek <tiket>',
  '#ambil <tiket> — ambil & mulai kerjakan',
  '#assign <tiket> <kode_karyawan>',
  '#update <tiket> [50%] <catatan>',
  '#pending <tiket> <alasan>',
  '#close <tiket> [catatan penyelesaian]',
  '#buka <tiket> <alasan> — buka kembali',
  '#prioritas <tiket> <rendah|sedang|tinggi|kritis>',
  '',
  'Cara cepat: balas notifikasi tiket dengan: proses, update <catatan>, pending <alasan>, atau selesai <catatan>.',
  '<tiket> boleh kode lengkap (TT-20260923-123456) atau 6 digit terakhir (123456).',
  'Kirim foto dengan caption #update / #pending / #close untuk melampirkan bukti.'
].join('\n');

module.exports = { parseCommand, parseReplyCommand, normalizePriority, HELP_TEXT, COMMAND_ALIASES, PRIORITY_ALIASES };
