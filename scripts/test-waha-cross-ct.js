const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
function expect(file, pattern, label) {
  if (!pattern.test(read(file))) throw new Error(`${label} tidak ditemukan di ${file}`);
  checks.push(label);
}

expect('services/schemaService.js', /wa_waha_base_url/, 'migrasi konfigurasi WAHA');
expect('services/schemaService.js', /provider_message_id/, 'migrasi hasil provider');
expect('services/wahaClient.js', /getWahaConfig/, 'konfigurasi WAHA dinamis');
expect('services/wahaClient.js', /AbortController/, 'timeout koneksi WAHA');
expect('middleware/waha.js', /getWahaConfig/, 'token webhook terenkripsi');
expect('routes/whatsappGateway.js', /connection-settings/, 'route simpan dan tes koneksi');
expect('routes/whatsappGateway.js', /messages\.json/, 'endpoint log live');
expect('routes/whatsappGateway.js', /messages\/:id\/retry/, 'retry pesan gagal');
expect('views/whatsapp-gateway/index.ejs', /Koneksi Server WAHA/, 'UI koneksi lintas CT');
expect('views/whatsapp-gateway/index.ejs', /Kirim Pesan WhatsApp/, 'UI kirim pesan langsung');
expect('views/whatsapp-gateway/index.ejs', /renderMessages/, 'log sukses gagal live');
expect('app.js', /ensureV54Schema/, 'migrasi V54 dijalankan saat startup');

console.log(`WAHA cross-CT static test OK: ${checks.length} pemeriksaan.`);
