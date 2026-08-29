const multer = require('multer');

const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf'
]);

const paymentProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!allowedTypes.has(file.mimetype)) {
      return cb(new Error('Format bukti pembayaran harus JPG, PNG, WEBP, atau PDF.'));
    }
    cb(null, true);
  }
}).single('proof_file');

module.exports = paymentProofUpload;
