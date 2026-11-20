// Perkecil foto bukti (JPG/PNG/WEBP, bukan PDF) sebelum disimpan ke storage. Foto kamera HP
// modern (12MP+, beberapa MB) yang didekode langsung oleh WebView Android RAM kecil adalah
// penyebab utama APK sering hang/macet saat membuka atau mengupload bukti pembayaran/kas/
// piutang/tiket. Dipakai bersama oleh services/paymentVerificationService.js,
// services/bankReconciliationService.js terkait, routes/finance.js, routes/debts.js, dan
// services/photoAttachmentService.js.
const sharp = require('sharp');
const MAX_SIDE = 1600;
const QUALITY = 80;
async function shrinkIfNeeded(buffer, mime) {
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') return { buffer, size: buffer.length };
  try {
    const img = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await img.metadata();
    if ((meta.width || 0) <= MAX_SIDE && (meta.height || 0) <= MAX_SIDE) return { buffer, size: buffer.length };
    const resized = img.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    const out = mime === 'image/png'
      ? await resized.png({ compressionLevel: 9 }).toBuffer()
      : mime === 'image/webp'
        ? await resized.webp({ quality: QUALITY }).toBuffer()
        : await resized.jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
    return { buffer: out, size: out.length };
  } catch (_e) {
    // Gagal proses gambar (file aneh/korup) -> simpan buffer asli apa adanya, jangan gagalkan upload.
    return { buffer, size: buffer.length };
  }
}
module.exports = { shrinkIfNeeded, MAX_SIDE, QUALITY };
