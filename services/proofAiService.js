// v1.29 — Pembaca bukti transfer berbasis AI vision (Anthropic Messages API, tanpa SDK).
// AI HANYA membaca isi gambar. Semua keputusan cocok/tidak cocok dihitung di server
// (services/proofMatchService.js) dengan membandingkan ke data tagihan INKAMNET.
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 45000;

const TOOL = {
  name: 'record_transfer_proof',
  description: 'Catat data yang TERBACA pada gambar bukti transfer / pembayaran.',
  input_schema: {
    type: 'object',
    properties: {
      is_transfer_proof: { type: 'boolean', description: 'true jika gambar adalah bukti transfer bank, e-wallet, QRIS, atau struk ATM/teller.' },
      transaction_status: { type: 'string', enum: ['success', 'pending', 'failed', 'unknown'], description: 'Status transaksi yang tertulis di bukti.' },
      amount: { type: ['number', 'null'], description: 'Nominal yang ditransfer ke penerima dalam rupiah (angka bulat, tanpa biaya admin). null jika tidak terbaca.' },
      amount_confidence: { type: 'number', description: 'Keyakinan 0-1 bahwa nominal terbaca benar.' },
      total_charged: { type: ['number', 'null'], description: 'Total yang didebit termasuk biaya admin, jika berbeda dari amount. null jika tidak ada.' },
      transfer_datetime: { type: ['string', 'null'], description: 'Tanggal & jam transaksi format "YYYY-MM-DD HH:mm" (atau "YYYY-MM-DD" bila jam tidak ada). null jika tidak terbaca.' },
      sender_name: { type: ['string', 'null'], description: 'Nama pengirim / pemilik rekening sumber persis seperti tertulis.' },
      sender_bank: { type: ['string', 'null'] },
      sender_account: { type: ['string', 'null'], description: 'Nomor rekening/HP pengirim persis seperti tertulis (boleh tersamar ****).' },
      recipient_name: { type: ['string', 'null'], description: 'Nama penerima / merchant persis seperti tertulis.' },
      recipient_bank: { type: ['string', 'null'] },
      recipient_account: { type: ['string', 'null'], description: 'Nomor rekening/VA/HP penerima persis seperti tertulis (boleh tersamar ****).' },
      reference_number: { type: ['string', 'null'], description: 'Nomor referensi / ID transaksi / nomor struk.' },
      channel: { type: ['string', 'null'], description: 'Aplikasi atau kanal, mis. "BCA mobile", "BRImo", "DANA", "QRIS", "ATM".' },
      notes: { type: ['string', 'null'], description: 'Catatan singkat bila ada bagian buram, terpotong, atau janggal.' }
    },
    required: ['is_transfer_proof', 'transaction_status', 'amount', 'amount_confidence', 'transfer_datetime', 'sender_name', 'recipient_name', 'recipient_account', 'reference_number']
  }
};

const SYSTEM_PROMPT = [
  'Anda membaca bukti transfer/pembayaran dari Indonesia (m-banking, internet banking, e-wallet, QRIS, struk ATM).',
  'Tulis HANYA data yang benar-benar terlihat di gambar. Jangan menebak. Isi null bila tidak terbaca atau tidak ada.',
  'Format rupiah Indonesia memakai titik sebagai pemisah ribuan dan koma untuk desimal: "Rp150.000,00" = 150000.',
  'amount = nominal yang diterima penerima (tanpa biaya admin). Jika ada "Nominal" dan "Total", amount = Nominal.',
  'Nama dan nomor rekening ditulis persis seperti di gambar, termasuk tanda **** bila tersamar.',
  'Selalu panggil tool record_transfer_proof tepat satu kali.'
].join(' ');

class ProofAiError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

function cleanText(value, max = 150) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s || /^(null|none|-|n\/a|tidak ada)$/i.test(s)) return null;
  return s.slice(0, max);
}

function cleanAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  let n = value;
  if (typeof n === 'string') {
    const s = n.replace(/rp/ig, '').trim();
    // "150.000,00" -> 150000 ; "150,000.00" -> 150000 ; "150000" -> 150000
    const m = s.match(/^([\d.,\s]+)$/);
    if (!m) return null;
    const compact = s.replace(/\s/g, '');
    const decimalMatch = compact.match(/[.,](\d{1,2})$/);
    const intPart = decimalMatch ? compact.slice(0, -decimalMatch[0].length) : compact;
    n = Number(intPart.replace(/[.,]/g, ''));
  }
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  return Math.round(n);
}

function cleanDateTime(value) {
  const s = cleanText(value, 40);
  if (!s) return { at: null, hasTime: false };
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return { at: null, hasTime: false };
  const [, y, mo, d, hh, mi, ss] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 2015 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return { at: null, hasTime: false };
  const hasTime = hh !== undefined;
  const hour = hasTime ? Math.min(23, Number(hh)) : 12;
  const minute = hasTime ? Math.min(59, Number(mi)) : 0;
  const second = hasTime && ss ? Math.min(59, Number(ss)) : 0;
  const pad = n => String(n).padStart(2, '0');
  return { at: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`, hasTime };
}

function normalizeExtraction(input = {}) {
  const dt = cleanDateTime(input.transfer_datetime);
  const conf = Number(input.amount_confidence);
  const status = ['success', 'pending', 'failed', 'unknown'].includes(input.transaction_status) ? input.transaction_status : 'unknown';
  return {
    isTransferProof: input.is_transfer_proof === false ? false : input.is_transfer_proof === true ? true : null,
    transactionStatus: status,
    amount: cleanAmount(input.amount),
    amountConfidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    totalCharged: cleanAmount(input.total_charged),
    transferAt: dt.at,
    transferHasTime: dt.hasTime,
    senderName: cleanText(input.sender_name),
    senderBank: cleanText(input.sender_bank, 80),
    senderAccount: cleanText(input.sender_account, 60),
    recipientName: cleanText(input.recipient_name),
    recipientBank: cleanText(input.recipient_bank, 80),
    recipientAccount: cleanText(input.recipient_account, 60),
    referenceNumber: cleanText(input.reference_number, 100),
    channel: cleanText(input.channel, 80),
    notes: cleanText(input.notes, 500)
  };
}

async function extractTransferProof({ base64, mime, apiKey, model, url, timeoutMs = TIMEOUT_MS }) {
  if (!apiKey) throw new ProofAiError('API key AI belum dikonfigurasi.', { retryable: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url || process.env.PROOF_SCAN_API_URL || DEFAULT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: 'Baca bukti transfer ini dan catat datanya dengan tool record_transfer_proof.' }
          ]
        }]
      })
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw new ProofAiError(aborted ? 'Waktu habis saat menghubungi layanan AI.' : `Gagal menghubungi layanan AI: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!response.ok) {
    const apiMessage = json?.error?.message || text.slice(0, 200) || response.statusText;
    const retryable = response.status === 429 || response.status === 408 || response.status === 529 || response.status >= 500;
    const hint = response.status === 401 ? ' (API key tidak valid)' : response.status === 404 ? ' (nama model tidak dikenal)' : '';
    throw new ProofAiError(`Layanan AI menolak permintaan (HTTP ${response.status})${hint}: ${apiMessage}`.slice(0, 480), { retryable, status: response.status });
  }
  const block = Array.isArray(json?.content) ? json.content.find(c => c.type === 'tool_use' && c.name === TOOL.name) : null;
  if (!block || typeof block.input !== 'object') throw new ProofAiError('Respons AI tidak berisi data bukti.', { retryable: true });
  return { raw: block.input, data: normalizeExtraction(block.input), model: json.model || model || DEFAULT_MODEL };
}

module.exports = { extractTransferProof, normalizeExtraction, cleanAmount, cleanDateTime, ProofAiError, DEFAULT_MODEL, TOOL };
