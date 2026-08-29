const multer=require('multer');
const allowedTypes=new Set(['image/jpeg','image/png','image/webp']);
module.exports=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:6*1024*1024,files:1},
  fileFilter:(_req,file,cb)=>{
    if(!allowedTypes.has(file.mimetype)) return cb(new Error('Lampiran ticket harus JPG, PNG, atau WEBP.'));
    cb(null,true);
  }
}).single('attachment_file');
