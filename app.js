require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const expressLayouts = require('express-ejs-layouts');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const db = require('./config/db');
const csrf = require('./middleware/csrf');
const commonLocals = require('./middleware/common');
const paymentProofUpload = require('./middleware/paymentProofUpload');
const customerExcelUpload = require('./middleware/customerExcelUpload');
const clusterExcelUpload = require('./middleware/clusterExcelUpload');
const invoiceExcelUpload = require('./middleware/invoiceExcelUpload');
const profilePhotoUpload = require('./middleware/profilePhotoUpload');
const cashProofUpload = require('./middleware/cashProofUpload');
const ticketPhotoUpload = require('./middleware/ticketPhotoUpload');
const dutyProofUpload = require('./middleware/dutyProofUpload');
const invoiceLogoUpload = require('./middleware/invoiceLogoUpload');
const { requireAuth, loadPermissions, requirePermission, requireMasterAdmin } = require('./middleware/auth');
const { generateMonthlyInvoices } = require('./services/invoiceService');
const { runAutoIsolation } = require('./services/networkService');
const { captureAllNmsTelemetry, backupAllRouters } = require('./services/nmsTelemetryService');
const { scanLowStock } = require('./services/inventoryService');
const { deliverMobilePushes } = require('./services/mobilePushService');
const { purgeOldLogs } = require('./services/logRetentionService');
const { ensureV14Schema, ensureV15Schema, ensureV16Schema, ensureV17Schema, ensureV18Schema, ensureV19Schema, ensureV20Schema, ensureV21Schema, ensureV22Schema, ensureV23Schema, ensureV24Schema, ensureV25Schema, ensureV26Schema, ensureV27Schema, ensureV29Schema, ensureV30Schema, ensureV31Schema, ensureV32Schema, ensureV33Schema, ensureV34Schema, ensureV35Schema, ensureV36Schema, ensureV37Schema, ensureV38Schema, ensureV39Schema } = require('./services/schemaService');
const { requireN8nToken } = require('./middleware/n8n');
const { startGateway, hasSavedSession, processQueue, runAutoReminderSweep } = require('./services/whatsappGatewayService');

const app = express();
const assetVersion = ['public/css/app.css','public/js/app.js','public/js/nms.js']
  .map(file => Math.floor(fs.statSync(path.join(__dirname,file)).mtimeMs).toString(36))
  .join('-');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'partials/layout');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);
app.use((req,res,next)=>{res.locals.assetVersion=assetVersion;next();});

// Baseline security headers for an internal admin application behind Cloudflare.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'inkamnet',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inkamnet',
  createDatabaseTable: true
});

app.use(session({
  name: 'inkamnet.sid',
  secret: process.env.SESSION_SECRET || 'change-this-secret-now',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000*60*60*12 }
}));
app.use(loadPermissions);
app.use(commonLocals);
// Parse multipart payment-proof forms before CSRF validation so the hidden token is available.
app.use('/customers/import', (req, res, next) => {
  if (req.method === 'POST' && req.is('multipart/form-data')) {
    return customerExcelUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'File Excel maksimal 8 MB.' : err.message };
        return res.redirect('/customers');
      }
      next();
    });
  }
  next();
});
app.use('/clusters/import', (req, res, next) => {
  if (req.method === 'POST' && req.is('multipart/form-data')) {
    return clusterExcelUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'File Excel maksimal 8 MB.' : err.message };
        return res.redirect('/clusters');
      }
      next();
    });
  }
  next();
});
app.use('/invoices/import', (req, res, next) => {
  if (req.method === 'POST' && req.is('multipart/form-data')) {
    return invoiceExcelUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'File Excel maksimal 8 MB.' : err.message };
        return res.redirect('/invoices');
      }
      next();
    });
  }
  next();
});
app.use('/profile', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/' && req.is('multipart/form-data')) {
    return profilePhotoUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'Foto profil maksimal 4 MB.' : err.message };
        return res.redirect('/profile');
      }
      next();
    });
  }
  next();
});
app.use('/payments', (req, res, next) => {
  if (['POST','PUT','PATCH'].includes(req.method) && req.is('multipart/form-data')) {
    return paymentProofUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'Bukti pembayaran maksimal 6 MB.' : err.message };
        return res.redirect('/payments');
      }
      next();
    });
  }
  next();
});
app.use('/cash', (req, res, next) => {
  if (['POST','PUT','PATCH'].includes(req.method) && req.is('multipart/form-data')) {
    return cashProofUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'Bukti pengeluaran maksimal 6 MB.' : err.message };
        return res.redirect('/cash');
      }
      next();
    });
  }
  next();
});
app.use('/tickets', (req, res, next) => {
  if (['POST','PUT','PATCH'].includes(req.method) && req.is('multipart/form-data')) {
    return ticketPhotoUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'Lampiran ticket maksimal 6 MB.' : err.message };
        const match=req.path.match(/^\/(\d+)/);
        return res.redirect(match?`/tickets/${match[1]}`:'/tickets');
      }
      next();
    });
  }
  next();
});
app.use('/server-duty', (req, res, next) => {
  if (['POST','PUT','PATCH'].includes(req.method) && req.is('multipart/form-data')) {
    return dutyProofUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'Bukti piket maksimal 6 MB.' : err.message };
        return res.redirect('/server-duty');
      }
      next();
    });
  }
  next();
});
app.use('/settings/invoice-branding', requireAuth, (req, res, next) => {
  if (!(req.permissions || []).includes('settings')) return res.status(403).send('Akses pengaturan dibatasi.');
  next();
}, (req, res, next) => {
  if (req.method === 'POST' && req.is('multipart/form-data')) {
    return invoiceLogoUpload(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'danger', message: err.code === 'LIMIT_FILE_SIZE' ? 'Logo invoice maksimal 3 MB.' : err.message };
        return res.redirect('/settings?tab=invoice');
      }
      next();
    });
  }
  next();
});
app.use(csrf);
app.use(require('./routes/mobile'));

// Token-protected server-to-server entrypoint for the versioned n8n workflows.
// It is intentionally mounted after the JSON parser and before browser routes.
app.use('/api/n8n', requireN8nToken, require('./routes/n8n'));

// Lightweight health endpoint used by Docker/operations monitoring.
app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ status: 'ok', service: 'inkamnet-control-center' });
  } catch (err) {
    res.status(503).json({ status: 'error' });
  }
});

app.use(require('./routes/auth'));
app.use('/', requireAuth, requirePermission('dashboard'), require('./routes/dashboard'));
app.use('/analytics', requireAuth, requirePermission('finance'), require('./routes/analytics'));
app.use('/customers', requireAuth, requirePermission('customers'), require('./routes/customers'));
app.use('/packages', requireAuth, requirePermission('customers'), require('./routes/packages'));
app.use('/invoices', requireAuth, requirePermission('billing'), require('./routes/invoices'));
app.use('/payments', requireAuth, requirePermission('billing'), require('./routes/payments'));
app.use('/reports', requireAuth, requirePermission('reports'), require('./routes/reports'));
app.use('/closing', requireAuth, requireMasterAdmin, require('./routes/closing'));
app.use('/routers', requireAuth, requirePermission('network'), require('./routes/routers'));
app.use('/network', requireAuth, requirePermission('network'), require('./routes/network'));
app.use('/settings', requireAuth, requirePermission('settings'), require('./routes/settings'));
app.use('/profile', requireAuth, require('./routes/profile'));
app.use('/communication', requireAuth, require('./routes/communication'));
app.use('/clusters', requireAuth, requirePermission('network'), require('./routes/clusters'));
app.use('/tickets', requireAuth, requirePermission('support'), require('./routes/tickets'));
app.use('/team-kpi', requireAuth, requirePermission('support'), require('./routes/teamKpi'));
app.use('/schedules', requireAuth, requirePermission('support'), require('./routes/schedules'));
app.use('/server-duty', requireAuth, requirePermission('support'), require('./routes/serverDuty'));
app.use('/inventory', requireAuth, requirePermission('warehouse'), require('./routes/inventory'));
app.use('/sites', requireAuth, requirePermission('network'), require('./routes/sites'));
app.use('/custom-invoices', requireAuth, requirePermission('billing'), require('./routes/customInvoices'));
app.use('/logs', requireAuth, requirePermission('logs'), require('./routes/logs'));
app.use('/', requireAuth, require('./routes/finance'));
app.use('/wa-gateway', requireAuth, require('./routes/whatsappGateway'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`Terjadi error: ${process.env.NODE_ENV === 'production' ? 'cek log server' : err.message}`);
});

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    const secret = String(process.env.SESSION_SECRET || '');
    const routerKey = String(process.env.ROUTER_CREDENTIAL_KEY || '');
    const adminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '');
    if (secret.length < 32 || secret.includes('GANTI_') || secret === 'change-this-secret-now') throw new Error('SESSION_SECRET wajib random minimal 32 karakter.');
    if (routerKey.length < 32 || routerKey.includes('GANTI_')) throw new Error('ROUTER_CREDENTIAL_KEY wajib random minimal 32 karakter.');
    if (!process.env.DB_PASSWORD || String(process.env.DB_PASSWORD).includes('GANTI_')) throw new Error('DB_PASSWORD belum dikonfigurasi.');
    if (!process.env.DB_ROOT_PASSWORD || String(process.env.DB_ROOT_PASSWORD).includes('GANTI_')) throw new Error('DB_ROOT_PASSWORD belum dikonfigurasi.');
    if (!adminPassword || adminPassword.includes('GantiPassword')) throw new Error('DEFAULT_ADMIN_PASSWORD wajib diganti sebelum startup production.');
  }
  await db.query('SELECT 1');
  await ensureV14Schema();
  await ensureV15Schema();
  await ensureV16Schema();
  await ensureV17Schema();
  await ensureV18Schema();
  await ensureV19Schema();
  await ensureV20Schema();
  await ensureV21Schema();
  await ensureV22Schema();
  await ensureV23Schema();
  await ensureV24Schema();
  await ensureV25Schema();
  await ensureV26Schema();
  await ensureV27Schema();
  await ensureV29Schema();
  await ensureV30Schema();
  await ensureV31Schema();
  await ensureV32Schema();
  await ensureV33Schema();
  await ensureV34Schema();
  await ensureV35Schema();
  await ensureV36Schema();
  await ensureV37Schema();
  await ensureV38Schema();
  await ensureV39Schema();
  const [rows] = await db.query('SELECT COUNT(*) total FROM users');
  if (Number(rows[0].total) === 0) {
    const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'Admin123!';
    const name = process.env.DEFAULT_ADMIN_NAME || 'Administrator';
    const hash = await bcrypt.hash(password, 12);
    await db.execute(`INSERT INTO users (name,username,password_hash,role,is_active) VALUES (?,?,?,'admin',1)`, [name, username, hash]);
    console.log(`Admin awal dibuat: ${username}`);
  }

  cron.schedule('10 0 * * *', async () => {
    try {
      console.log('Cron invoice:', await generateMonthlyInvoices(new Date(), false, null));
      console.log('Cron isolasi:', await runAutoIsolation());
    } catch (err) { console.error('Cron billing/network gagal:', err.message); }
  }, { timezone: 'Asia/Jakarta' });

  cron.schedule('30 2 * * 0', async () => {
    try { console.log('Cron retensi log:',await purgeOldLogs(7)); }
    catch (err) { console.error('Cron retensi log gagal:',err.message); }
  }, { timezone: 'Asia/Jakarta' });

  // WA Gateway watchdog — every 5 minutes: (1) resume the send queue in case it stalled while the
  // gateway was briefly disconnected, and (2) check whether it's time to run the once-daily
  // auto-reminder sweep (runAutoReminderSweep itself no-ops unless enabled, past the configured hour,
  // and not already run today, so this can safely fire every 5 minutes without double-sending).
  cron.schedule('*/5 * * * *', async () => {
    try { await processQueue(); } catch (err) { console.error('WA Gateway queue watchdog gagal:', err.message); }
    try {
      const result = await runAutoReminderSweep();
      if (result.ran) console.log('WA Gateway auto-reminder sweep:', result);
    } catch (err) { console.error('WA Gateway auto-reminder sweep gagal:', err.message); }
  }, { timezone: 'Asia/Jakarta' });

  cron.schedule('* * * * *', async () => {
    try {
      const result = await deliverMobilePushes();
      if (result.configured && (result.sent || result.failed)) console.log('INKAMNET GO push:', result);
    } catch (err) { console.error('INKAMNET GO push gagal:', err.message); }
  }, { timezone: 'Asia/Jakarta' });

  cron.schedule('30 3 * * 0', async () => {
    try { const result = await backupAllRouters(['rsc', 'backup']); console.log('NMS backup mingguan:', result.filter(row => row.status === 'success').length, 'berhasil'); }
    catch (err) { console.error('NMS backup gagal:', err.message); }
  }, { timezone: 'Asia/Jakarta' });

  // NMS telemetry and stock alerts are deliberately low-frequency. The public
  // monitor page remains responsive because it reads the persisted samples,
  // while router polling happens in one bounded Promise.all batch.
  cron.schedule('*/5 * * * *', async () => {
    try { const result = await captureAllNmsTelemetry(); console.log('NMS telemetry:', result.routers, 'router(s)'); }
    catch (err) { console.error('NMS telemetry gagal:', err.message); }
    try { await scanLowStock(); } catch (err) { console.error('Stock alert gagal:', err.message); }
  }, { timezone: 'Asia/Jakarta' });

  // If a WA Gateway session was already linked before this restart, reconnect silently (no QR needed —
  // Baileys reuses the saved credentials). If nothing was ever linked, stay disconnected until an admin
  // explicitly clicks Connect from the /wa-gateway page.
  if (hasSavedSession()) {
    startGateway().catch(err => console.error('WA Gateway: gagal reconnect otomatis saat startup:', err.message));
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`INKAMNET Billing berjalan di port ${port}`));
}

bootstrap().catch(err => { console.error('Startup gagal:', err); process.exit(1); });
