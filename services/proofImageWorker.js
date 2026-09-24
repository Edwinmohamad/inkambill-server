// v1.29 — Worker thread untuk decode/resize gambar bukti supaya server tidak "macet"
// saat memproses foto besar (decode JPEG murni JS bisa beberapa detik).
const { parentPort, workerData } = require('worker_threads');
const { analyzeImage } = require('./proofImageService');

try {
  const result = analyzeImage(Buffer.from(workerData.buffer), workerData.mime, { forAi: workerData.forAi });
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
