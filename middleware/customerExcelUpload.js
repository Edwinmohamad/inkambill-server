const multer = require('multer');

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowedMime = new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ]);
    const nameOk = /\.xlsx$/i.test(file.originalname || '');
    if (!nameOk || !allowedMime.has(file.mimetype)) {
      return cb(new Error('File pelanggan harus berformat .xlsx'));
    }
    cb(null, true);
  }
}).single('customer_file');
