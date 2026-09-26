const multer = require('multer');

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const nameOk = /\.xlsx$/i.test(file.originalname || '');
    const mimeOk = new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ]).has(file.mimetype);
    if (!nameOk || !mimeOk) return cb(new Error('File mapping NMS harus berformat .xlsx'));
    cb(null, true);
  }
}).single('nms_file');
