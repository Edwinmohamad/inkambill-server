// v1.29 — Utilitas gambar bukti transfer (murni JavaScript, tanpa dependency native).
// - decodeImage     : JPEG/PNG -> RGBA
// - perceptualHash  : dHash 256-bit (hex 64 karakter) untuk mendeteksi bukti yang sama walau
//                     sudah dikompres ulang WhatsApp / di-resize / di-screenshot ulang.
// - prepareForAi    : perkecil gambar besar (sisi terpanjang maks 1568 px) lalu encode JPEG
//                     supaya pengiriman ke AI vision hemat biaya & di bawah batas ukuran API.
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const AI_MAX_EDGE = 1568;
const AI_MAX_BYTES = 3.5 * 1024 * 1024; // aman di bawah batas 5 MB per gambar (base64 +33%)
const DECODE_MEMORY_MB = 512;

function detectMime(buffer, fallback = '') {
  const b = buffer;
  if (!b || b.length < 12) return fallback;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return fallback;
}

// Mengembalikan {width,height,data:Uint8Array RGBA} atau null bila format tidak didukung (WEBP/PDF).
function decodeImage(buffer, mime) {
  const type = detectMime(buffer, mime);
  if (type === 'image/jpeg') {
    const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: DECODE_MEMORY_MB, maxResolutionInMP: 120 });
    return { width: img.width, height: img.height, data: img.data };
  }
  if (type === 'image/png') {
    const img = PNG.sync.read(buffer);
    return { width: img.width, height: img.height, data: img.data };
  }
  return null;
}

// Rata-rata area (box filter) ke ukuran target; alpha dikomposisikan di atas putih.
function resizeRgba(img, targetW, targetH) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(targetW * targetH * 4);
  const xRatio = w / targetW;
  const yRatio = h / targetH;
  for (let ty = 0; ty < targetH; ty++) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((ty + 1) * yRatio)));
    for (let tx = 0; tx < targetW; tx++) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((tx + 1) * xRatio)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          const a = data[idx + 3] / 255;
          r += data[idx] * a + 255 * (1 - a);
          g += data[idx + 1] * a + 255 * (1 - a);
          b += data[idx + 2] * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (ty * targetW + tx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: targetW, height: targetH, data: out };
}

// dHash 16x16: grid 17x16 grayscale, bandingkan piksel bersebelahan -> 256 bit.
function dHashFromImage(img) {
  const small = resizeRgba(img, 17, 16);
  const gray = new Float64Array(17 * 16);
  for (let i = 0; i < 17 * 16; i++) {
    const o = i * 4;
    gray[i] = small.data[o] * 0.299 + small.data[o + 1] * 0.587 + small.data[o + 2] * 0.114;
  }
  let hex = '';
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x += 4) {
      let nibble = 0;
      for (let k = 0; k < 4; k++) {
        const left = gray[y * 17 + x + k];
        const right = gray[y * 17 + x + k + 1];
        nibble = (nibble << 1) | (left > right ? 1 : 0);
      }
      hex += nibble.toString(16);
    }
  }
  return hex;
}

function perceptualHash(buffer, mime) {
  const img = decodeImage(buffer, mime);
  if (!img || !img.width || !img.height) return null;
  return dHashFromImage(img);
}

const POPCOUNT = Array.from({ length: 16 }, (_, n) => n.toString(2).replace(/0/g, '').length);
function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

// Menyiapkan gambar untuk AI vision. Mengembalikan {mime, base64, width, height, resized}.
function prepareForAi(buffer, mime, decoded = null) {
  const type = detectMime(buffer, mime);
  if (type === 'application/pdf') throw new Error('Bukti PDF tidak dibaca otomatis. Upload bukti dalam format gambar (JPG/PNG).');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error('Format bukti tidak dikenali.');
  if (type === 'image/webp') {
    if (buffer.length > AI_MAX_BYTES) throw new Error('Bukti WEBP terlalu besar untuk dibaca otomatis. Upload ulang sebagai JPG/PNG.');
    return { mime: type, base64: buffer.toString('base64'), resized: false };
  }
  const img = decoded || decodeImage(buffer, type);
  const longest = Math.max(img.width, img.height);
  if (longest <= AI_MAX_EDGE && buffer.length <= AI_MAX_BYTES) {
    return { mime: type, base64: buffer.toString('base64'), width: img.width, height: img.height, resized: false };
  }
  const scale = Math.min(1, AI_MAX_EDGE / longest);
  const targetW = Math.max(1, Math.round(img.width * scale));
  const targetH = Math.max(1, Math.round(img.height * scale));
  const resized = scale < 1 ? resizeRgba(img, targetW, targetH) : resizeRgba(img, img.width, img.height);
  let quality = 85;
  let encoded = jpeg.encode({ data: Buffer.from(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength), width: resized.width, height: resized.height }, quality).data;
  while (encoded.length > AI_MAX_BYTES && quality > 45) {
    quality -= 15;
    encoded = jpeg.encode({ data: Buffer.from(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength), width: resized.width, height: resized.height }, quality).data;
  }
  return { mime: 'image/jpeg', base64: Buffer.from(encoded).toString('base64'), width: resized.width, height: resized.height, resized: true };
}

// Satu kali decode untuk perceptual hash + persiapan AI. Error persiapan AI dikembalikan sebagai
// teks (bukan dilempar) supaya hash tetap bisa dipakai untuk cek duplikat.
function analyzeImage(buffer, mime, { forAi = true } = {}) {
  const type = detectMime(buffer, mime);
  let decoded = null;
  let phash = null;
  try { decoded = decodeImage(buffer, type); if (decoded) phash = dHashFromImage(decoded); } catch (_) { decoded = null; }
  let prepared = null, prepareError = null;
  if (forAi) {
    try { prepared = prepareForAi(buffer, type, ['image/jpeg', 'image/png'].includes(type) ? decoded : null); }
    catch (err) { prepareError = err.message; }
  }
  return { mime: type, phash, prepared, prepareError };
}

function analyzeImageAsync(buffer, mime, { forAi = true, timeoutMs = 60000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    let worker;
    try {
      const { Worker } = require('worker_threads');
      worker = new Worker(require('path').join(__dirname, 'proofImageWorker.js'), { workerData: { buffer, mime, forAi }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    } catch (_) {
      return done(analyzeImage(buffer, mime, { forAi }));
    }
    const timer = setTimeout(() => { worker.terminate(); done({ mime: detectMime(buffer, mime), phash: null, prepared: null, prepareError: 'Waktu habis saat memproses gambar bukti.' }); }, timeoutMs);
    worker.once('message', msg => { clearTimeout(timer); done(msg.ok ? msg.result : { mime: detectMime(buffer, mime), phash: null, prepared: null, prepareError: msg.error }); });
    worker.once('error', err => { clearTimeout(timer); done({ mime: detectMime(buffer, mime), phash: null, prepared: null, prepareError: `Gagal memproses gambar: ${err.message}` }); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) done({ mime: detectMime(buffer, mime), phash: null, prepared: null, prepareError: 'Gagal memproses gambar bukti.' }); });
  });
}

module.exports = { detectMime, decodeImage, resizeRgba, dHashFromImage, perceptualHash, hammingHex, prepareForAi, analyzeImage, analyzeImageAsync, AI_MAX_EDGE };
