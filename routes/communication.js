const express = require('express');
const db = require('../config/db');
const { isMasterAdminRole } = require('../middleware/auth');
const { audit } = require('../services/auditService');

const router = express.Router();
const clean = (value, max) => String(value || '').trim().slice(0, max);

router.get('/header', async (req, res) => {
  const userId = Number(req.session.user.id);
  const permissions = new Set(req.permissions || []);
  const [messagesResult, unreadResult, usersResult, systemResult, systemUnreadResult] = await Promise.all([
    db.execute(`SELECT m.id,m.sender_id,m.subject,m.body,m.read_at,m.created_at,u.name sender_name,u.profile_photo sender_photo
      FROM internal_messages m JOIN users u ON u.id=m.sender_id
      WHERE m.recipient_id=? ORDER BY m.created_at DESC LIMIT 8`, [userId]),
    db.execute(`SELECT COUNT(*) total FROM internal_messages WHERE recipient_id=? AND read_at IS NULL`, [userId]),
    db.execute(`SELECT id,name,username,role,profile_photo FROM users WHERE is_active=1 AND id<>? ORDER BY name`, [userId]),
    db.execute(`SELECT id,type,tone,icon,title,detail,href,entity_type,entity_id,read_at,created_at
      FROM system_notifications WHERE recipient_id=? ORDER BY created_at DESC,id DESC LIMIT 8`, [userId]),
    db.execute(`SELECT COUNT(*) total FROM system_notifications WHERE recipient_id=? AND read_at IS NULL`, [userId])
  ]);

  const persistentNotifications = systemResult[0].map(item => ({...item, persistent: true}));
  const dynamicNotifications = [];
  if (isMasterAdminRole(req.session.user.role)) {
    const [[pending]] = await db.query(`SELECT COUNT(*) total,COALESCE(SUM(amount),0) amount FROM payments WHERE status='pending'`);
    if (Number(pending.total)) dynamicNotifications.push({
      type: 'approval', icon: 'bi-shield-exclamation', tone: 'warning',
      title: `${Number(pending.total)} pembayaran menunggu approval`,
      detail: `Total Rp${Number(pending.amount || 0).toLocaleString('id-ID')}`,
      href: '/payments?approval=pending'
    });
  }
  if (permissions.has('support')) {
    const [[tickets]] = await db.execute(`SELECT COUNT(*) total FROM tickets WHERE assigned_to=? AND status IN ('open','progress')`, [userId]);
    if (Number(tickets.total)) dynamicNotifications.push({type:'ticket',icon:'bi-life-preserver',tone:'purple',title:`${Number(tickets.total)} tiket aktif ditugaskan kepada Anda`,detail:'Buka daftar tiket dan perbarui progres.',href:'/tickets?status=active'});
  }
  if (permissions.has('billing')) {
    const [[overdue]] = await db.query(`SELECT COUNT(*) total FROM invoices WHERE status IN ('unpaid','partial','overdue') AND outstanding>0 AND due_date<DATE_SUB(CURDATE(),INTERVAL 2 DAY)`);
    if (Number(overdue.total)) dynamicNotifications.push({type:'billing',icon:'bi-exclamation-diamond-fill',tone:'danger',title:`${Number(overdue.total)} tagihan lewat tempo lebih dari 2 hari`,detail:'Prioritaskan pengingat dan penagihan pelanggan.',href:'/invoices?status=overdue'});
  }
  if (permissions.has('network')) {
    const [[isolated]] = await db.query(`SELECT COUNT(*) total FROM customers WHERE customer_status='active' AND network_status='isolated'`);
    if (Number(isolated.total)) dynamicNotifications.push({type:'network',icon:'bi-wifi-off',tone:'danger',title:`${Number(isolated.total)} pelanggan sedang terisolir`,detail:'Periksa status billing dan jaringan pelanggan.',href:'/customers?status=active&network=isolated'});
  }

  res.set('Cache-Control', 'no-store').json({
    ok: true,
    notifications: [...persistentNotifications, ...dynamicNotifications].slice(0, 12),
    notificationCount: Number(systemUnreadResult[0][0]?.total || 0) + dynamicNotifications.length,
    unreadMessages: Number(unreadResult[0][0]?.total || 0),
    messages: messagesResult[0],
    users: usersResult[0]
  });
});

router.post('/notifications/:id/read', async (req, res) => {
  await db.execute(`UPDATE system_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=? AND recipient_id=?`, [req.params.id, req.session.user.id]);
  res.json({ok:true});
});

router.post('/notifications/read-all', async (req, res) => {
  await db.execute(`UPDATE system_notifications SET read_at=NOW() WHERE recipient_id=? AND read_at IS NULL`, [req.session.user.id]);
  res.json({ok:true});
});

router.post('/messages', async (req, res) => {
  const senderId = Number(req.session.user.id);
  const recipientId = Number(req.body.recipient_id);
  const subject = clean(req.body.subject, 140);
  const body = clean(req.body.body, 2000);
  if (!Number.isInteger(recipientId) || recipientId <= 0 || !body) return res.status(400).json({ok:false,error:'Penerima dan isi pesan wajib diisi.'});
  if (recipientId === senderId) return res.status(400).json({ok:false,error:'Pilih user lain sebagai penerima pesan.'});
  const [users] = await db.execute(`SELECT id,name FROM users WHERE id=? AND is_active=1 LIMIT 1`, [recipientId]);
  if (!users.length) return res.status(404).json({ok:false,error:'User penerima tidak ditemukan atau tidak aktif.'});
  const [result] = await db.execute(`INSERT INTO internal_messages(sender_id,recipient_id,subject,body) VALUES(?,?,?,?)`, [senderId, recipientId, subject || `Pesan dari ${req.session.user.name}`, body]);
  await audit({userId:senderId,action:'create',entityType:'internal_message',entityId:result.insertId,description:`Pesan internal dikirim kepada ${users[0].name}`,ip:req.ip});
  res.json({ok:true,message:`Pesan berhasil dikirim kepada ${users[0].name}.`});
});

router.post('/messages/:id/read', async (req, res) => {
  await db.execute(`UPDATE internal_messages SET read_at=COALESCE(read_at,NOW()) WHERE id=? AND recipient_id=?`, [req.params.id, req.session.user.id]);
  res.json({ok:true});
});

router.post('/messages/read-all', async (req, res) => {
  await db.execute(`UPDATE internal_messages SET read_at=NOW() WHERE recipient_id=? AND read_at IS NULL`, [req.session.user.id]);
  res.json({ok:true});
});

module.exports = router;
