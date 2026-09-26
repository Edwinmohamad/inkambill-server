const ExcelJS = require('exceljs');
const db = require('../../config/db');
const { normalizeKey } = require('./matching');

const MAX_ROWS = 5000;
const ACTIONS = new Set(['LINK', 'UNLINK']);

function plainCell(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, 'result')) return v.result ?? '';
    if (Array.isArray(v.richText)) return v.richText.map(x => x.text || '').join('');
    if (v.text != null) return v.text;
    if (v.hyperlink && v.text) return v.text;
  }
  return v;
}

function normalizeHeader(v) {
  return String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const HEADER_ALIAS = {
  AKSI: 'action', ACTION: 'action',
  SITE: 'site', SITE_CODE: 'site',
  ROUTER: 'router', ROUTER_NAME: 'router',
  PPPOE_USERNAME: 'username', USERNAME: 'username', PPP_USERNAME: 'username', SECRET: 'username', SECRET_NAME: 'username',
  CUSTOMER_CODE: 'customerCode', CUSTOMER_ID: 'customerCode', ID_PELANGGAN: 'customerCode', KODE_PELANGGAN: 'customerCode',
  CATATAN: 'note', NOTE: 'note', KETERANGAN: 'note'
};

function findHeader(ws) {
  const max = Math.min(10, ws.rowCount || 0);
  for (let r = 1; r <= max; r++) {
    const found = {};
    ws.getRow(r).eachCell((c, i) => {
      const k = HEADER_ALIAS[normalizeHeader(plainCell(c))];
      if (k && !found[k]) found[k] = i;
    });
    if (found.action && found.username) return { row: r, cols: found };
  }
  return null;
}

async function parseWorkbook(buffer) {
  if (!buffer || buffer.length < 4 || buffer.subarray(0, 2).toString() !== 'PK') {
    throw Object.assign(new Error('Isi file bukan workbook XLSX yang valid.'), { status: 400 });
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('MAPPING') || wb.getWorksheet('PPP_MAPPING') || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('Sheet MAPPING tidak ditemukan.'), { status: 400 });
  if (ws.rowCount > MAX_ROWS + 20) throw Object.assign(new Error(`Maksimal ${MAX_ROWS.toLocaleString('id-ID')} baris mapping per import.`), { status: 400 });
  const h = findHeader(ws);
  if (!h) throw Object.assign(new Error('Header tidak dikenali. Gunakan template Excel terbaru dari NMS.'), { status: 400 });
  const val = (row, key) => h.cols[key] ? plainCell(row.getCell(h.cols[key])) : '';
  const rows = [];
  for (let n = h.row + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const action = String(val(row, 'action') || '').trim().toUpperCase();
    const site = String(val(row, 'site') || '').trim().toUpperCase();
    const router = String(val(row, 'router') || '').trim();
    const username = String(val(row, 'username') || '').trim();
    const customerCode = String(val(row, 'customerCode') || '').trim();
    const note = String(val(row, 'note') || '').trim().slice(0, 255);
    // Baris export sengaja dibiarkan AKSI kosong. Hanya baris yang operator beri AKSI yang diproses.
    if (!action) continue;
    rows.push({ row: n, action, site, router, username, customerCode, note });
  }
  if (!rows.length) throw Object.assign(new Error('Tidak ada baris mapping yang bisa diproses.'), { status: 400 });
  return rows;
}

async function loadReference(siteId = null) {
  const sp = siteId ? [Number(siteId)] : [];
  const [sites] = await db.query(`SELECT id, code, name FROM sites WHERE is_active=1 ${siteId ? 'AND id=?' : ''} ORDER BY code`, sp);
  const [secrets] = await db.query(`SELECT p.id, p.site_id, p.router_id, p.username, p.customer_id, p.sync_status, p.match_method,
      r.name router_name, s.code site_code,
      c.customer_code current_customer_code, c.name current_customer_name
    FROM ppp_secrets p
    JOIN routers r ON r.id=p.router_id
    JOIN sites s ON s.id=p.site_id
    LEFT JOIN customers c ON c.id=p.customer_id
    WHERE p.removed_on_router_at IS NULL ${siteId ? 'AND p.site_id=?' : ''}
    ORDER BY s.code, r.name, p.username`, sp);
  const [customers] = await db.query(`SELECT c.id, c.site_id, c.customer_code, c.name, c.customer_status, c.pppoe_username, c.router_id,
      s.code site_code
    FROM customers c JOIN sites s ON s.id=c.site_id
    WHERE c.archived_at IS NULL ${siteId ? 'AND c.site_id=?' : ''}
    ORDER BY s.code, c.customer_code`, sp);
  return { sites, secrets, customers };
}

function decorateStatus(row, status, message, extra = {}) {
  return { ...row, status, message, ...extra };
}

async function previewImport(buffer, { siteId = null } = {}) {
  const input = await parseWorkbook(buffer);
  const ref = await loadReference(siteId);
  const siteByCode = new Map(ref.sites.map(s => [String(s.code).toUpperCase(), s]));
  const siteById = new Map(ref.sites.map(s => [Number(s.id), s]));
  const secretsBySiteUser = new Map();
  for (const s of ref.secrets) {
    const key = `${Number(s.site_id)}|${normalizeKey(s.username)}`;
    if (!secretsBySiteUser.has(key)) secretsBySiteUser.set(key, []);
    secretsBySiteUser.get(key).push(s);
  }
  const customerBySiteCode = new Map(ref.customers.map(c => [`${Number(c.site_id)}|${String(c.customer_code).trim().toUpperCase()}`, c]));
  const linkedByCustomer = new Map();
  for (const s of ref.secrets) if (s.customer_id && !linkedByCustomer.has(Number(s.customer_id))) linkedByCustomer.set(Number(s.customer_id), s);

  const defaultSite = siteId ? siteById.get(Number(siteId)) : null;
  const resolved = input.map(raw => {
    if (!ACTIONS.has(raw.action)) return decorateStatus(raw, 'error', 'AKSI harus LINK atau UNLINK.');
    if (!raw.username) return decorateStatus(raw, 'error', 'PPPOE_USERNAME wajib diisi.');
    const site = raw.site ? siteByCode.get(raw.site) : defaultSite;
    if (!site) return decorateStatus(raw, 'error', raw.site ? `Site ${raw.site} tidak ditemukan / tidak aktif.` : 'SITE wajib diisi jika filter site tidak dipilih.');
    if (siteId && Number(site.id) !== Number(siteId)) return decorateStatus(raw, 'error', `Baris berada di site ${site.code}, bukan site yang sedang dipilih.`);
    const candidates = secretsBySiteUser.get(`${Number(site.id)}|${normalizeKey(raw.username)}`) || [];
    let secret = null;
    if (raw.router) secret = candidates.find(s => normalizeKey(s.router_name) === normalizeKey(raw.router));
    else if (candidates.length === 1) secret = candidates[0];
    if (!secret) {
      if (candidates.length > 1 && !raw.router) return decorateStatus(raw, 'error', `Username ${raw.username} ada di lebih dari satu router. Isi kolom ROUTER.`, { siteCode: site.code });
      return decorateStatus(raw, 'error', `Secret ${raw.username}${raw.router ? ` pada router ${raw.router}` : ''} tidak ditemukan.`, { siteCode: site.code });
    }
    const base = { ...raw, siteId: Number(site.id), siteCode: site.code, secretId: Number(secret.id), routerId: Number(secret.router_id), routerName: secret.router_name,
      currentCustomerCode: secret.current_customer_code || '', currentCustomerName: secret.current_customer_name || '' };
    if (raw.action === 'UNLINK') {
      if (!secret.customer_id) return decorateStatus(base, 'noop', 'Secret memang sudah belum ter-link.');
      return decorateStatus(base, 'ready', `Akan melepas ${secret.username} dari ${secret.current_customer_code || secret.current_customer_name || 'pelanggan saat ini'}.`, { currentCustomerId: Number(secret.customer_id) });
    }
    if (!raw.customerCode) return decorateStatus(base, 'error', 'CUSTOMER_CODE wajib diisi untuk aksi LINK.');
    const customer = customerBySiteCode.get(`${Number(site.id)}|${raw.customerCode.toUpperCase()}`);
    if (!customer) return decorateStatus(base, 'error', `Pelanggan ${raw.customerCode} tidak ditemukan di site ${site.code}.`);
    if (!['active', 'suspended'].includes(String(customer.customer_status))) return decorateStatus(base, 'error', `Pelanggan ${customer.customer_code} berstatus ${customer.customer_status} dan tidak bisa di-link.`);
    const linked = linkedByCustomer.get(Number(customer.id));
    const same = Number(secret.customer_id) === Number(customer.id) && (!linked || Number(linked.id) === Number(secret.id));
    const extra = { customerId: Number(customer.id), customerCode: customer.customer_code, customerName: customer.name,
      customerLinkedUsername: linked && Number(linked.id) !== Number(secret.id) ? linked.username : '' };
    if (same) return decorateStatus(base, 'noop', 'Mapping ini sudah aktif.', extra);
    const conflicts = [];
    if (secret.customer_id && Number(secret.customer_id) !== Number(customer.id)) conflicts.push(`secret saat ini milik ${secret.current_customer_code || secret.current_customer_name}`);
    if (linked && Number(linked.id) !== Number(secret.id)) conflicts.push(`pelanggan masih terhubung ke ${linked.username}`);
    if (conflicts.length) return decorateStatus(base, 'warning', `Akan memindahkan mapping: ${conflicts.join('; ')}.`, extra);
    return decorateStatus(base, 'ready', `Siap menghubungkan ${secret.username} → ${customer.customer_code} ${customer.name}.`, extra);
  });

  // Tolak instruksi ambigu di file yang sama: secret yang sama >1x atau pelanggan LINK ke >1 secret.
  const secretGroups = new Map();
  const customerGroups = new Map();
  for (const r of resolved) {
    if (!r.secretId || r.status === 'error') continue;
    const sk = String(r.secretId);
    if (!secretGroups.has(sk)) secretGroups.set(sk, []);
    secretGroups.get(sk).push(r);
    if (r.action === 'LINK' && r.customerId) {
      const ck = String(r.customerId);
      if (!customerGroups.has(ck)) customerGroups.set(ck, []);
      customerGroups.get(ck).push(r);
    }
  }
  for (const group of secretGroups.values()) if (group.length > 1) group.forEach(r => { r.status = 'error'; r.message = `Secret ${r.username} muncul lebih dari sekali di file.`; });
  for (const group of customerGroups.values()) if (group.length > 1) group.forEach(r => { r.status = 'error'; r.message = `Pelanggan ${r.customerCode} diarahkan ke lebih dari satu secret di file.`; });

  const summary = { total: resolved.length, ready: 0, warning: 0, noop: 0, error: 0, link: 0, unlink: 0 };
  for (const r of resolved) {
    summary[r.status] = (summary[r.status] || 0) + 1;
    if (r.action === 'LINK') summary.link++;
    if (r.action === 'UNLINK') summary.unlink++;
  }
  return { rows: resolved, summary };
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.height = 25;
  row.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D1D1F' } };
    c.alignment = { vertical: 'middle' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `${ws.getColumn(ws.columnCount).letter}1` };
}

function addInstructions(wb) {
  const ws = wb.addWorksheet('PETUNJUK');
  ws.columns = [{ width: 24 }, { width: 90 }];
  ws.addRows([
    ['IMPORT MAPPING PPP', 'Gunakan sheet MAPPING. Jangan ubah nama header.'],
    ['AKSI', 'LINK = hubungkan secret ke pelanggan. UNLINK = lepaskan link pelanggan dari secret. Baris tanpa aksi tidak diproses.'],
    ['SITE', 'Kode site, contoh KRW / CLM / KBG. Jika import dilakukan saat filter site aktif, site harus sama.'],
    ['ROUTER', 'Opsional. Wajib bila username yang sama ada di lebih dari satu router dalam site.'],
    ['PPPOE_USERNAME', 'Username secret MikroTik persis seperti yang tampil di NMS.'],
    ['CUSTOMER_CODE', 'Wajib untuk LINK. Gunakan kode pelanggan, bukan nama, agar tidak ambigu.'],
    ['CATATAN', 'Opsional untuk catatan operator.'],
    ['ALUR AMAN', 'Upload → Preview → periksa warning/error → Apply. Konflik existing tidak ditimpa kecuali operator mengaktifkan izin overwrite.'],
    ['UNDO', 'Mapping LINK dari import dicatat sebagai batch Smart Sync dan dapat di-undo dari Riwayat Smart Sync selama window undo masih berlaku.']
  ]);
  ws.getRow(1).font = { bold: true, size: 16 };
  ws.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
}

async function templateWorkbook({ siteId = null } = {}) {
  const ref = await loadReference(siteId);
  const wb = new ExcelJS.Workbook(); wb.creator = 'INKAMNET Control Center'; wb.created = new Date();
  const ws = wb.addWorksheet('MAPPING');
  ws.columns = [
    { header: 'AKSI', key: 'action', width: 14 }, { header: 'SITE', key: 'site', width: 12 }, { header: 'ROUTER', key: 'router', width: 24 },
    { header: 'PPPOE_USERNAME', key: 'username', width: 28 }, { header: 'CUSTOMER_CODE', key: 'customer', width: 20 }, { header: 'CATATAN', key: 'note', width: 42 }
  ];
  styleHeader(ws);
  ws.getColumn(4).numFmt = '@'; ws.getColumn(5).numFmt = '@';
  for (let r = 2; r <= 501; r++) ws.getCell(`A${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"LINK,UNLINK"'] };
  const refWs = wb.addWorksheet('REFERENSI');
  refWs.columns = [
    { header: 'SITE', key: 'site', width: 12 }, { header: 'ROUTER', key: 'router', width: 24 }, { header: 'PPPOE_USERNAME', key: 'username', width: 28 },
    { header: 'STATUS_LINK', key: 'link', width: 16 }, { header: 'CUSTOMER_CODE_SAAT_INI', key: 'customer', width: 24 }, { header: 'CUSTOMER_NAME_SAAT_INI', key: 'name', width: 32 }
  ];
  ref.secrets.forEach(s => refWs.addRow({ site: s.site_code, router: s.router_name, username: s.username, link: s.customer_id ? 'TER-LINK' : 'BELUM', customer: s.current_customer_code || '', name: s.current_customer_name || '' }));
  styleHeader(refWs);
  const cws = wb.addWorksheet('PELANGGAN');
  cws.columns = [{ header: 'SITE', key: 'site', width: 12 }, { header: 'CUSTOMER_CODE', key: 'code', width: 20 }, { header: 'NAMA', key: 'name', width: 32 }, { header: 'STATUS', key: 'status', width: 16 }, { header: 'PPPOE_SAAT_INI', key: 'ppp', width: 28 }];
  ref.customers.forEach(c => cws.addRow({ site: c.site_code, code: c.customer_code, name: c.name, status: c.customer_status, ppp: c.pppoe_username || '' }));
  styleHeader(cws);
  addInstructions(wb);
  return wb;
}

async function exportWorkbook({ siteId = null, kind = 'all' } = {}) {
  const ref = await loadReference(siteId);
  const mode = ['synced', 'unsynced', 'all'].includes(kind) ? kind : 'all';
  const rows = ref.secrets.filter(s => mode === 'all' || (mode === 'synced' ? !!s.customer_id : !s.customer_id));
  const wb = new ExcelJS.Workbook(); wb.creator = 'INKAMNET Control Center'; wb.created = new Date();
  const ws = wb.addWorksheet('MAPPING');
  ws.columns = [
    { header: 'AKSI', key: 'action', width: 14 }, { header: 'SITE', key: 'site', width: 12 }, { header: 'ROUTER', key: 'router', width: 24 },
    { header: 'PPPOE_USERNAME', key: 'username', width: 28 }, { header: 'CUSTOMER_CODE', key: 'customer', width: 20 }, { header: 'CATATAN', key: 'note', width: 34 },
    { header: 'STATUS_SAAT_INI', key: 'link', width: 18 }, { header: 'CUSTOMER_NAME_SAAT_INI', key: 'name', width: 32 }, { header: 'MATCH_METHOD', key: 'method', width: 18 }
  ];
  rows.forEach(s => ws.addRow({ action: '', site: s.site_code, router: s.router_name, username: s.username, customer: s.current_customer_code || '', note: '', link: s.customer_id ? 'TER-LINK' : 'BELUM TER-LINK', name: s.current_customer_name || '', method: s.match_method || '' }));
  styleHeader(ws);
  ws.getColumn(4).numFmt = '@'; ws.getColumn(5).numFmt = '@';
  // Kolom yang boleh diedit diberi tint ringan agar operator cepat paham.
  for (let r = 2; r <= Math.max(2, ws.rowCount); r++) {
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => { ws.getCell(`${col}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F7' } }; });
    ws.getCell(`A${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"LINK,UNLINK"'] };
  }
  addInstructions(wb);
  return wb;
}

module.exports = { parseWorkbook, previewImport, templateWorkbook, exportWorkbook, MAX_ROWS };
