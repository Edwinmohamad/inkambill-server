// OCR lokal dipisahkan di payload agar parser/validator dapat dipelihara tanpa
// mengubah flow approval pembayaran. Re-export ini adalah entry point aplikasi.
module.exports = require('../payload/services/proofOcrService');
