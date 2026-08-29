const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Login', layout: false });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await db.execute(`SELECT id, name, username, password_hash, role, profile_photo, is_active FROM users WHERE username=? LIMIT 1`, [username]);
  const user = rows[0];
  if (!user || !user.is_active || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.status(401).render('auth/login', { title: 'Login', layout: false, error: 'Username atau password salah.' });
  }
  const [[appSettings]] = await db.query(`SELECT default_language,default_theme,ui_palette FROM settings WHERE id=1 LIMIT 1`);
  const sessionUser = { id: user.id, name: user.name, username: user.username, role: user.role, profile_photo: user.profile_photo || null };
  try {
    await db.execute(`INSERT INTO user_login_events(user_id,ip_address,user_agent) VALUES(?,?,?)`, [user.id,String(req.ip||'').slice(0,64),String(req.get('user-agent')||'').slice(0,255)]);
  } catch (logErr) { console.error('Gagal mencatat aktivitas login:', logErr.message); }
  // Regenerate session after login to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Gagal membuat session login. Coba lagi.');
    req.session.user = sessionUser;
    req.session.language = appSettings?.default_language === 'en' ? 'en' : 'id';
    req.session.uiTheme = ['dark','light','system'].includes(appSettings?.default_theme) ? appSettings.default_theme : 'dark';
    req.session.uiPalette = ['nebula','ocean','emerald','sunset','rose','ice'].includes(appSettings?.ui_palette) ? appSettings.ui_palette : 'nebula';
    req.session.save(() => res.redirect('/'));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
