// Template pesan WhatsApp resmi (bahasa Indonesia formal, pembayaran transfer bank manual) +
// renderer variabel & Spintax. Dipakai oleh auto-reminder, pemberitahuan isolir, broadcast gangguan,
// kuitansi pembayaran, balasan cepat Web Inbox, dan WA Blast.
const db = require('../config/db');

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const OFFICIAL_TEMPLATES = [
  {
    key: 'reminder', title: 'Pengingat Tagihan (H-3 / H-1)',
    body: `{Yth.|Kepada Yth.} Bapak/Ibu {nama_pelanggan} (ID: {id_pelanggan}),

Bersama pesan ini, kami {menginformasikan|memberitahukan} bahwa tagihan layanan internet {paket_layanan} Anda untuk periode ini adalah sebesar {nominal_tagihan}, dengan batas waktu pembayaran pada tanggal {tanggal_jatuh_tempo}.

Pembayaran dapat dilakukan melalui transfer bank berikut:
- Bank: {nama_bank}
- No. Rekening: {nomor_rekening}
- Atas Nama: {nama_pemilik_rekening}

Mohon untuk membalas pesan ini dengan melampirkan foto/dokumen bukti transfer setelah melakukan pembayaran agar dapat kami verifikasi. {Terima kasih atas perhatian dan kerja sama Anda.|Atas perhatian dan kerja sama Anda, kami ucapkan terima kasih.}`
  },
  {
    key: 'isolation', title: 'Pemberitahuan Isolir Layanan',
    body: `{Yth.|Kepada Yth.} Bapak/Ibu {nama_pelanggan} (ID: {id_pelanggan}),

Kami {beritahukan|informasikan} bahwa akses layanan internet {paket_layanan} Anda saat ini di-isolir sementara dikarenakan telah melewati batas waktu pembayaran ({tanggal_jatuh_tempo}).

Rincian Tagihan:
- No. Invoice: {nomor_invoice}
- Total Tagihan: {nominal_tagihan}
- Bank Tujuan: {nama_bank}
- No. Rekening: {nomor_rekening}
- Atas Nama: {nama_pemilik_rekening}

Untuk mengaktifkan kembali layanan internet Anda secara otomatis, mohon segera melakukan pembayaran dan mengirimkan bukti transfer melalui balasan pesan ini.`
  },
  {
    key: 'outage', title: 'Pemberitahuan Gangguan Layanan',
    body: `{Yth.|Kepada Yth.} Bapak/Ibu {nama_pelanggan},

Kami sampaikan permohonan maaf atas ketidaknyamanan yang terjadi. Saat ini sedang terjadi kendala teknis pada jaringan kami dengan rincian sebagai berikut:
- Kendala: {detail_gangguan}
- Estimasi Penanganan: {estimasi_selesai}

Tim teknis kami sedang berupaya melakukan perbaikan secara maksimal agar layanan kembali normal. {Terima kasih atas kesabaran dan pengertian Anda.|Atas kesabaran dan pengertian Anda, kami ucapkan terima kasih.}`
  },
  {
    key: 'receipt', title: 'Konfirmasi Pembayaran & Kuitansi Digital',
    body: `{Yth.|Kepada Yth.} Bapak/Ibu {nama_pelanggan} (ID: {id_pelanggan}),

Pembayaran tagihan layanan internet {paket_layanan} sebesar {nominal_tagihan} telah kami terima dan diverifikasi.
No. Invoice: {nomor_invoice}

Status layanan Anda saat ini: AKTIF / LUNAS. Terima kasih telah melakukan pembayaran tepat waktu.`
  },
];

const DEFAULT_QUICK_REPLIES = [
  { shortcut: 'rekening', title: 'Rincian rekening resmi', body: `Berikut rincian rekening resmi pembayaran layanan kami:
- Bank: {nama_bank}
- No. Rekening: {nomor_rekening}
- Atas Nama: {nama_pemilik_rekening}

Setelah transfer, mohon kirimkan foto bukti transfer melalui chat ini. Terima kasih.` },
  { shortcut: 'proses', title: 'Sedang diproses', body: `Terima kasih Bapak/Ibu {nama_pelanggan}. Bukti pembayaran / laporan Anda telah kami terima dan sedang kami proses. Kami akan segera menginformasikan hasilnya.` },
  { shortcut: 'isolir', title: 'Rincian kewajiban isolir', body: `Bapak/Ibu {nama_pelanggan}, layanan internet Anda saat ini dalam status isolir karena tagihan {nomor_invoice} sebesar {nominal_tagihan} (jatuh tempo {tanggal_jatuh_tempo}) belum kami terima.

Silakan melakukan pembayaran ke {nama_bank} {nomor_rekening} a.n. {nama_pemilik_rekening}, lalu kirimkan bukti transfer melalui chat ini agar layanan dapat segera diaktifkan kembali.` },
  { shortcut: 'tagihan', title: 'Info tagihan berjalan', body: `Bapak/Ibu {nama_pelanggan}, tagihan layanan {paket_layanan} Anda saat ini sebesar {nominal_tagihan} dengan jatuh tempo {tanggal_jatuh_tempo} (No. Invoice {nomor_invoice}).` },
];

// Semua variabel resmi + alias lama (template lama {nama},{kode},{nominal},... tetap berjalan).
const VARIABLES = [
  ['nama_pelanggan', 'Nama lengkap pelanggan'], ['id_pelanggan', 'ID / kode pelanggan'], ['paket_layanan', 'Paket & kecepatan'],
  ['nominal_tagihan', 'Nominal tagihan (Rupiah)'], ['tanggal_jatuh_tempo', 'Tanggal jatuh tempo'], ['nama_bank', 'Bank tujuan transfer'],
  ['nomor_rekening', 'Nomor rekening'], ['nama_pemilik_rekening', 'Atas nama rekening'], ['detail_gangguan', 'Deskripsi gangguan'],
  ['estimasi_selesai', 'Perkiraan waktu pemulihan'], ['nomor_invoice', 'Nomor invoice'],
];
const ALIASES = { nama: 'nama_pelanggan', kode: 'id_pelanggan', nominal: 'nominal_tagihan', jatuh_tempo: 'tanggal_jatuh_tempo', no_faktur: 'nomor_invoice' };

function formatRupiah(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0)).replace(/ /g, ' ');
}
function formatDateIndo(value) {
  if (!value) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function packageLabel(name, speed) {
  const n = String(name || '').trim(); const s = String(speed || '').trim();
  if (!n) return s || '-';
  if (!s || n.toLowerCase().includes(s.toLowerCase())) return n;
  return `${n}-${s.replace(/\s+/g, '')}`;
}

// Spintax: {a|b|c} → satu pilihan acak, mendukung nested ({Halo|{Selamat pagi|Selamat siang}}).
// Kurung tanpa '|' (mis. {nama_pelanggan} yang tidak dikenal) dibiarkan apa adanya.
function spin(text, random = Math.random) {
  let out = String(text || '');
  const re = /\{([^{}]*\|[^{}]*)\}/;
  for (let guard = 0; guard < 500 && re.test(out); guard++) {
    out = out.replace(re, (_, inner) => { const opts = inner.split('|'); return opts[Math.floor(random() * opts.length)]; });
  }
  return out;
}

// Substitusi variabel dulu (dengan placeholder supaya nilai berisi '{', '|' tidak ikut di-spin),
// baru Spintax, lalu placeholder dikembalikan.
function renderTemplate(template, vars = {}, { spintax = true, random = Math.random } = {}) {
  const values = [];
  let text = String(template || '').replace(/\{([a-z_]+)\}/g, (m, key) => {
    const k = Object.prototype.hasOwnProperty.call(vars, key) ? key : ALIASES[key];
    if (!k || vars[k] === undefined || vars[k] === null) return m;
    values.push(String(vars[k]));
    return `\u0000${values.length - 1}\u0000`;
  });
  if (spintax) text = spin(text, random);
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => values[Number(i)]);
}

let bankCache = null; let bankCacheUntil = 0;
async function getDefaultBank({ fresh = false } = {}) {
  if (!fresh && bankCache && Date.now() < bankCacheUntil) return bankCache;
  let bank = null;
  try {
    const [[s]] = await db.query(`SELECT wa_default_bank_id FROM settings WHERE id=1 LIMIT 1`);
    if (s?.wa_default_bank_id) {
      const [rows] = await db.execute(`SELECT id,bank_name,account_number,account_name FROM banks WHERE id=? AND is_active=1 LIMIT 1`, [s.wa_default_bank_id]);
      bank = rows[0] || null;
    }
    if (!bank) {
      const [rows] = await db.query(`SELECT id,bank_name,account_number,account_name FROM banks WHERE is_active=1 AND type='bank_transfer' ORDER BY id ASC LIMIT 1`);
      bank = rows[0] || null;
    }
  } catch (e) { console.error('WA template: gagal membaca bank default:', e.message); }
  bankCache = bank; bankCacheUntil = Date.now() + 60000;
  return bank;
}
function invalidateBankCache() { bankCache = null; bankCacheUntil = 0; }

// row: gabungan kolom pelanggan/paket/invoice (nama kolom fleksibel, lihat fallback di bawah).
function buildVars(row = {}, bank = null, extra = {}) {
  const period = row.period_month ? `${MONTHS[Number(row.period_month) - 1] || ''} ${row.period_year || ''}`.trim() : '';
  const amount = row.amount ?? row.outstanding ?? row.total;
  return {
    nama_pelanggan: row.customer_name || row.name || '',
    id_pelanggan: row.customer_code || '',
    paket_layanan: packageLabel(row.package_name, row.speed_label),
    nominal_tagihan: amount === undefined || amount === null ? '-' : formatRupiah(amount),
    tanggal_jatuh_tempo: formatDateIndo(row.due_date),
    nomor_invoice: row.invoice_number || '-',
    nama_bank: bank?.bank_name ? (/^bank\b/i.test(bank.bank_name) ? bank.bank_name : `Bank ${bank.bank_name}`) : '-',
    nomor_rekening: bank?.account_number || '-',
    nama_pemilik_rekening: bank?.account_name || '-',
    detail_gangguan: extra.detail_gangguan || '-',
    estimasi_selesai: extra.estimasi_selesai || '-',
    // variabel tambahan lama (tanda terima)
    periode: period,
    metode: row.method_label || row.method || '',
    referensi: row.reference || (row.payment_id ? `#${row.payment_id}` : ''),
    sisa: row.remaining !== undefined ? formatRupiah(row.remaining) : '',
    ...extra,
  };
}

// Konteks lengkap satu pelanggan: paket + invoice terbuka paling relevan (atau invoice tertentu).
async function loadCustomerRow(customerId, { invoiceId = null } = {}) {
  const [rows] = await db.execute(`SELECT c.id customer_id,c.customer_code,c.name customer_name,c.phone,c.whatsapp_status,c.whatsapp_normalized,
      p.name package_name,p.speed_label
    FROM customers c LEFT JOIN packages p ON p.id=c.package_id WHERE c.id=? LIMIT 1`, [customerId]);
  const c = rows[0];
  if (!c) return null;
  const [inv] = invoiceId
    ? await db.execute(`SELECT id invoice_id,invoice_number,total,outstanding,due_date,period_month,period_year,status invoice_status FROM invoices WHERE id=? AND customer_id=? LIMIT 1`, [invoiceId, customerId])
    : await db.execute(`SELECT id invoice_id,invoice_number,total,outstanding,due_date,period_month,period_year,status invoice_status FROM invoices
        WHERE customer_id=? AND status IN ('unpaid','partial','overdue') AND outstanding>0 AND archived_at IS NULL ORDER BY due_date ASC,id ASC LIMIT 1`, [customerId]);
  return { ...c, ...(inv[0] || {}) };
}

async function getTemplate(key) {
  try {
    const [rows] = await db.execute(`SELECT body FROM wa_templates WHERE template_key=? LIMIT 1`, [key]);
    if (rows[0]?.body) return rows[0].body;
  } catch (_) { /* tabel belum ada saat test */ }
  return OFFICIAL_TEMPLATES.find(t => t.key === key)?.body || '';
}

async function renderForCustomer(templateOrKey, customerId, { invoiceId = null, extra = {}, isKey = false } = {}) {
  const template = isKey ? await getTemplate(templateOrKey) : templateOrKey;
  const row = await loadCustomerRow(customerId, { invoiceId });
  if (!row) throw new Error('Pelanggan tidak ditemukan.');
  const bank = await getDefaultBank();
  return { text: renderTemplate(template, buildVars(row, bank, extra)), row };
}

module.exports = {
  OFFICIAL_TEMPLATES, DEFAULT_QUICK_REPLIES, VARIABLES, ALIASES,
  spin, renderTemplate, buildVars, formatRupiah, formatDateIndo, packageLabel,
  getDefaultBank, invalidateBankCache, loadCustomerRow, getTemplate, renderForCustomer,
};
