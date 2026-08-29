const multer = require('multer');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, '..', 'storage', 'profile-photos');
fs.mkdirSync(dir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, dir),
  filename: (req, file, cb) => {
    const ext = ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'})[file.mimetype] || '';
    cb(null, `user-${req.session?.user?.id || 'unknown'}-${Date.now()}${ext}`);
  }
});

module.exports = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Foto profil hanya JPG, PNG, atau WEBP.'), ok);
  }
}).single('profile_photo');
