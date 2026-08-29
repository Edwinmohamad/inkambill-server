const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const router = express.Router();

router.get('/', async(req,res)=>{
  const [rows]=await db.execute(`SELECT u.id,u.name,u.username,u.role,u.profile_photo,u.created_at,e.employee_code,e.email,e.phone,d.name department_name,p.name position_name
    FROM users u LEFT JOIN employees e ON e.user_id=u.id LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN positions p ON p.id=e.position_id WHERE u.id=? LIMIT 1`,[req.session.user.id]);
  if(!rows.length)return res.status(404).send('Profil tidak ditemukan.');
  res.render('profile/index',{title:'Profil Saya',profile:rows[0]});
});

router.get('/photo/:filename',(req,res)=>{
  const safe=path.basename(req.params.filename||'');
  const file=path.join(__dirname,'..','storage','profile-photos',safe);
  if(!safe || !fs.existsSync(file))return res.status(404).end();
  res.sendFile(file);
});

router.post('/', async(req,res)=>{
  const name=String(req.body.name||'').trim();
  if(!name){req.session.flash={type:'danger',message:'Nama profil wajib diisi.'};return res.redirect('/profile');}
  const [oldRows]=await db.execute(`SELECT profile_photo FROM users WHERE id=? LIMIT 1`,[req.session.user.id]);
  const oldPhoto=oldRows[0]?.profile_photo||null;
  const newPhoto=req.file?.filename||oldPhoto;
  await db.execute(`UPDATE users SET name=?,profile_photo=? WHERE id=?`,[name,newPhoto,req.session.user.id]);
  await db.execute(`UPDATE employees SET name=? WHERE user_id=?`,[name,req.session.user.id]);
  req.session.user.name=name;req.session.user.profile_photo=newPhoto;
  if(req.file && oldPhoto && oldPhoto!==newPhoto){const oldPath=path.join(__dirname,'..','storage','profile-photos',path.basename(oldPhoto));fs.unlink(oldPath,()=>{});}
  req.session.flash={type:'success',message:'Profil berhasil diperbarui.'};res.redirect('/profile');
});

router.post('/password', async(req,res)=>{
  const current=String(req.body.current_password||''), next=String(req.body.new_password||'');
  if(next.length<8){req.session.flash={type:'danger',message:'Password baru minimal 8 karakter.'};return res.redirect('/profile');}
  const [rows]=await db.execute(`SELECT password_hash FROM users WHERE id=? LIMIT 1`,[req.session.user.id]);
  if(!rows.length || !(await bcrypt.compare(current,rows[0].password_hash))){req.session.flash={type:'danger',message:'Password saat ini tidak sesuai.'};return res.redirect('/profile');}
  await db.execute(`UPDATE users SET password_hash=? WHERE id=?`,[await bcrypt.hash(next,12),req.session.user.id]);
  req.session.flash={type:'success',message:'Password berhasil diganti.'};res.redirect('/profile');
});

router.post('/language', async(req,res)=>{
  const language=req.body.language==='en'?'en':'id';
  req.session.language=language;
  res.redirect(req.body.return_to||'/');
});

module.exports=router;
