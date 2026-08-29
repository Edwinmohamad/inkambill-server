const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
function extFor(mime){return ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'})[mime]||'';}
function signatureOk(file){
  const b=file?.buffer;if(!b||b.length<12)return false;
  if(file.mimetype==='image/jpeg')return b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
  if(file.mimetype==='image/png')return b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(file.mimetype==='image/webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
  return false;
}
async function savePhoto(file,dir,prefix){
  if(!file)return null;
  const ext=extFor(file.mimetype);if(!ext||!signatureOk(file))throw new Error('Isi file foto tidak sesuai format JPG, PNG, atau WEBP.');
  await fs.promises.mkdir(dir,{recursive:true});
  const filename=`${prefix}-${Date.now()}-${crypto.randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(dir,filename),file.buffer,{flag:'wx'});
  return{filename,originalName:file.originalname,mime:file.mimetype,size:file.size};
}
async function removePhoto(dir,filename){if(!filename)return;try{await fs.promises.unlink(path.join(dir,path.basename(filename)));}catch(e){if(e.code!=='ENOENT')console.error('Gagal hapus foto lampiran:',e.message);}}
function sendPhoto(res,dir,row){
  if(!row?.attachment_path&&!row?.proof_path)return res.status(404).send('Lampiran tidak ditemukan.');
  const filename=row.attachment_path||row.proof_path;const full=path.join(dir,path.basename(filename));
  if(!fs.existsSync(full))return res.status(404).send('File lampiran tidak ditemukan di storage.');
  const mime=row.attachment_mime||row.proof_mime||'application/octet-stream';
  const original=row.attachment_original_name||row.proof_original_name||path.basename(filename);
  res.type(mime);res.setHeader('Content-Disposition',`inline; filename="${String(original).replace(/[\r\n"]/g,'_')}"`);res.setHeader('Cache-Control','private, max-age=300');res.setHeader('X-Content-Type-Options','nosniff');return res.sendFile(full);
}
module.exports={savePhoto,removePhoto,sendPhoto};
