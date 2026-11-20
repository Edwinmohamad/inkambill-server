// v1.35 — "Akses Pengguna" (menu centang per user). Dijalankan setelah loadPermissions dan sebelum
// commonLocals: mempersempit req.permissions/res.locals.permissions sesuai access_json user (jika
// diatur Master Admin), lalu memblokir route yang menunya tidak dicentang. Master Admin SELALU
// bypass (tidak pernah terkunci dari fitur apapun, termasuk layar pengaturan akses ini sendiri).
// Akun tanpa access_json (NULL, default) berperilaku identik dengan sebelum fitur ini ada.
const db = require('../config/db');
const { wantsJson } = require('./httpErrors');
const { isMasterAdminRole } = require('./auth');
const { MENU_ITEMS, parseAccess, permissionsForAccess, menuAllowed, isAlwaysAllowed, homePath } = require('../services/userAccessService');

// Flattened [path, ...prefixes] for every menu the user's access_json does NOT include, so the
// sidebar (views/partials/layout.ejs) can hide links the server would block anyway — purely
// cosmetic, the real guard is menuAllowed() below. Empty array when access is unrestricted.
function hiddenPrefixesFor(access) {
  if (!access) return [];
  const out = [];
  for (const m of MENU_ITEMS) {
    if (access.menus.includes(m.key)) continue;
    out.push(...(m.exact || []), ...(m.prefixes || []));
  }
  return out;
}

async function enforceUserAccess(req, res, next) {
  res.locals.userAccess = null;
  res.locals.userAccessHiddenPrefixes = [];
  if (!req.session?.user) return next();
  if (isMasterAdminRole(req.session.user.role)) {
    req.userAccess = null;
    return next();
  }
  try {
    const [[row]] = await db.query(`SELECT access_json FROM users WHERE id=? LIMIT 1`, [req.session.user.id]);
    const access = parseAccess(row?.access_json);
    req.userAccess = access;
    res.locals.userAccess = access;
    res.locals.userAccessHiddenPrefixes = hiddenPrefixesFor(access);
    if (access) {
      const allowedPerms = new Set(permissionsForAccess(access));
      req.permissions = (req.permissions || []).filter(p => allowedPerms.has(p));
      res.locals.permissions = req.permissions;
      if (!isAlwaysAllowed(req.path) && !menuAllowed(access, req.path)) {
        if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Menu ini tidak diizinkan untuk akun Anda.' });
        req.session.flash = { type: 'danger', message: 'Menu ini tidak diizinkan untuk akun Anda. Hubungi Master Admin jika ini keliru.' };
        return res.redirect(homePath(access));
      }
    }
  } catch (err) {
    console.error('Gagal memuat akses pengguna:', err.message);
  }
  next();
}

module.exports = enforceUserAccess;
