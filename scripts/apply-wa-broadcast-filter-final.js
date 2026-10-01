#!/usr/bin/env node
'use strict';

/**
 * INKAMBILL - WA Broadcast Filter Enhancement
 * Target: current main structure (Oct 2026)
 *
 * Adds:
 * - Site as primary filter
 * - Billing: "Ada tagihan terbuka" and "Lunas / tidak ada tagihan terbuka"
 * - Due cycle 15 / 30
 * - Network status
 * - WhatsApp status
 * - Open invoice count
 * - Minimum outstanding
 * - Cooldown since last WA broadcast/reminder
 * - Site displayed in recipient location column
 *
 * Safety:
 * - Creates timestamped .bak files
 * - Refuses to patch if expected anchors are missing
 * - Idempotent: exits cleanly if already patched
 *
 * Run from repository root:
 *   node scripts/apply-wa-broadcast-filter-final.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const FILES = {
  route: path.join(ROOT, 'routes', 'waCrm.js'),
  service: path.join(ROOT, 'services', 'waBroadcastService.js'),
  view: path.join(ROOT, 'views', 'whatsapp-gateway', 'broadcast.ejs'),
  js: path.join(ROOT, 'public', 'js', 'wa-broadcast.js'),
  css: path.join(ROOT, 'public', 'css', 'wa-broadcast.css'),
};

function fail(message) {
  console.error(`\n[FAIL] ${message}`);
  process.exit(1);
}

for (const [name, file] of Object.entries(FILES)) {
  if (!fs.existsSync(file)) fail(`File ${name} tidak ditemukan: ${file}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const changed = [];

function load(file) {
  return fs.readFileSync(file, 'utf8');
}

function save(file, before, after) {
  if (before === after) return;
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
  fs.writeFileSync(file, after, 'utf8');
  changed.push(path.relative(ROOT, file));
}

function replaceOne(text, matcher, replacement, label) {
  if (!matcher.test(text)) fail(`Anchor tidak ditemukan: ${label}. Repo mungkin sudah berubah; tidak ada file yang ditimpa untuk bagian ini.`);
  return text.replace(matcher, replacement);
}

function patchRoute() {
  const file = FILES.route;
  const before = load(file);
  if (before.includes("cooldown_hours: src.cooldown_hours")) return;

  let out = before;

  out = replaceOne(
    out,
    /site_id:\s*src\.site_id,\s*cluster_id:\s*src\.cluster_id,\s*router_id:\s*src\.router_id,\s*olt_id:\s*src\.olt_id,\s*package_id:\s*src\.package_id,\s*\n\s*vlan:\s*src\.vlan\s*\|\|\s*'',\s*q:\s*src\.q\s*\|\|\s*'',\s*customer_ids:/,
    `site_id: src.site_id, cluster_id: src.cluster_id, router_id: src.router_id, olt_id: src.olt_id, package_id: src.package_id,
    due_cycle: src.due_cycle || '', network_status: src.network_status || '', wa_status: src.wa_status || '',
    open_invoice_count: src.open_invoice_count || '', min_outstanding: src.min_outstanding || '',
    cooldown_hours: src.cooldown_hours || '',
    vlan: src.vlan || '', q: src.q || '', customer_ids:`,
    'routes/waCrm.js filterFrom'
  );

  // When explicit customers are selected, geographic/display filters should not silently exclude them.
  out = replaceOne(
    out,
    /Object\.assign\(filter,\s*\{\s*billing:\s*'all',\s*site_id:\s*null,\s*cluster_id:\s*null,\s*router_id:\s*null,\s*\n\s*olt_id:\s*null,\s*package_id:\s*null,\s*vlan:\s*'',\s*q:\s*''\s*\}\);/,
    `Object.assign(filter, { billing: 'all', site_id: null, cluster_id: null, router_id: null,
      olt_id: null, package_id: null, vlan: '', q: '', due_cycle: '', network_status: '',
      wa_status: '', open_invoice_count: '', min_outstanding: '', cooldown_hours: '' });`,
    'routes/waCrm.js selected-filter reset'
  );

  save(file, before, out);
}

function patchService() {
  const file = FILES.service;
  const before = load(file);
  if (before.includes("case 'has_open':")) return;

  let out = before;

  out = replaceOne(
    out,
    /const BILLING_FILTERS = \{\s*\n\s*all:\s*'Semua pelanggan aktif',/,
    `const BILLING_FILTERS = {
  all: 'Semua pelanggan aktif',
  has_open: 'Belum bayar · ada tagihan terbuka',
  paid_clear: 'Lunas · tidak ada tagihan terbuka',`,
    'services/waBroadcastService.js billing filters'
  );

  out = replaceOne(
    out,
    /switch \(filter\.billing\) \{\s*\n\s*case 'active':/,
    `switch (filter.billing) {
  case 'has_open': where.push(\`EXISTS (\${OPEN_INV})\`); break;
  case 'paid_clear': where.push(\`NOT EXISTS (\${OPEN_INV})\`); break;
  case 'active':`,
    'services/waBroadcastService.js billing switch'
  );

  const insertionAnchor = /if \(filter\.vlan\) \{\s*where\.push\(`c\.vlan=\?`\);\s*params\.push\(String\(filter\.vlan\)\.trim\(\)\.slice\(0,\s*20\)\);\s*\}\s*\n/;
  out = replaceOne(
    out,
    insertionAnchor,
    match => match + `
  // Additional audience segmentation. All values are allow-listed / numeric-normalized.
  if (filter.due_cycle === '15') {
    where.push(\`EXISTS (\${OPEN_INV} AND DAY(ix.due_date)<=22)\`);
  } else if (filter.due_cycle === '30') {
    where.push(\`EXISTS (\${OPEN_INV} AND DAY(ix.due_date)>22)\`);
  }

  if (['online','offline','isolated','router_unreachable'].includes(filter.network_status)) {
    where.push('c.network_status=?');
    params.push(filter.network_status);
  }

  if (filter.wa_status === 'valid') {
    where.push(\`COALESCE(c.whatsapp_status,'')='valid'\`);
  } else if (filter.wa_status === 'invalid') {
    where.push(\`COALESCE(c.whatsapp_status,'')='invalid'\`);
  } else if (filter.wa_status === 'unknown') {
    where.push(\`COALESCE(c.whatsapp_status,'') NOT IN ('valid','invalid')\`);
  }

  if (['1','2','3plus'].includes(filter.open_invoice_count)) {
    const invoiceCountSql = \`(SELECT COUNT(*) FROM invoices ixc
      WHERE ixc.customer_id=c.id
      AND ixc.status IN ('unpaid','partial','overdue')
      AND ixc.outstanding>0 AND ixc.archived_at IS NULL)\`;
    if (filter.open_invoice_count === '1') where.push(\`\${invoiceCountSql}=1\`);
    else if (filter.open_invoice_count === '2') where.push(\`\${invoiceCountSql}=2\`);
    else where.push(\`\${invoiceCountSql}>=3\`);
  }

  const minOutstanding = Number(filter.min_outstanding);
  if (Number.isFinite(minOutstanding) && minOutstanding > 0 && minOutstanding <= 100000000) {
    where.push(\`(SELECT COALESCE(SUM(ixo.outstanding),0) FROM invoices ixo
      WHERE ixo.customer_id=c.id
      AND ixo.status IN ('unpaid','partial','overdue')
      AND ixo.outstanding>0 AND ixo.archived_at IS NULL) >= ?\`);
    params.push(Math.round(minOutstanding));
  }

  const cooldown = Number(filter.cooldown_hours);
  if ([6,12,24,48,72,168].includes(cooldown)) {
    // Only successful/in-flight customer communication counts toward cooldown.
    // Failed/cancelled messages do not block a new attempt.
    where.push(\`NOT EXISTS (
      SELECT 1 FROM wa_messages wm
      WHERE wm.customer_id=c.id
      AND wm.message_type IN ('broadcast','blast','auto_reminder')
      AND wm.status IN ('queued','pending_approval','processing','sent')
      AND wm.created_at >= DATE_SUB(NOW(), INTERVAL \${cooldown} HOUR)
    )\`);
  }
`,
    'services/waBroadcastService.js advanced filter insertion'
  );

  save(file, before, out);
}

function patchView() {
  const file = FILES.view;
  const before = load(file);
  if (before.includes('name="cooldown_hours"')) return;

  let out = before;

  // Promote Site to primary row.
  out = replaceOne(
    out,
    /(<label class="wab-search"[^>]*>[\s\S]*?<\/label>\s*\n\s*<select class="wab-select" name="billing"[\s\S]*?<\/select>)/,
    `$1
      <select class="wab-select" name="site_id" aria-label="Site">
        <option value="">Semua site</option>
        <% options.sites.forEach(o=>{ %><option value="<%= o.id %>"><%= o.code %> · <%= o.name %></option><% }) %>
      </select>`,
    'broadcast.ejs primary filter row'
  );

  // Remove old duplicated Site selector inside More Filters.
  out = replaceOne(
    out,
    /\s*<label><span>Site<\/span><select class="wab-select" name="site_id"><option value="">Semua<\/option><% options\.sites\.forEach\(o=>\{ %><option value="<%= o\.id %>"><%= o\.code %> · <%= o\.name %><\/option><% \}\) %><\/select><\/label>/,
    '',
    'broadcast.ejs old site selector'
  );

  out = out.replace(
    'Filter jaringan &amp; paket',
    'Filter lanjutan'
  );

  // Add operational filters before closing advanced grid.
  out = replaceOne(
    out,
    /(<label><span>Paket<\/span><select class="wab-select" name="package_id">[\s\S]*?<\/select><\/label>)\s*\n\s*<\/div>/,
    `$1
        <label><span>Siklus JT</span><select class="wab-select" name="due_cycle">
          <option value="">15 + 30</option><option value="15">JT 15</option><option value="30">JT 30</option>
        </select></label>
        <label><span>Status jaringan</span><select class="wab-select" name="network_status">
          <option value="">Semua</option><option value="online">Online</option><option value="offline">Offline</option>
          <option value="isolated">Terisolir</option><option value="router_unreachable">Router tidak terjangkau</option>
        </select></label>
        <label><span>Status WhatsApp</span><select class="wab-select" name="wa_status">
          <option value="">Semua</option><option value="valid">Valid</option><option value="invalid">Tidak valid</option>
          <option value="unknown">Belum diverifikasi</option>
        </select></label>
        <label><span>Jumlah invoice terbuka</span><select class="wab-select" name="open_invoice_count">
          <option value="">Semua</option><option value="1">1 invoice</option><option value="2">2 invoice</option><option value="3plus">3+ invoice</option>
        </select></label>
        <label><span>Cooldown pesan</span><select class="wab-select" name="cooldown_hours">
          <option value="">Tanpa cooldown</option><option value="6">Belum dikirimi 6 jam</option>
          <option value="12">Belum dikirimi 12 jam</option><option value="24">Belum dikirimi 24 jam</option>
          <option value="48">Belum dikirimi 2 hari</option><option value="72">Belum dikirimi 3 hari</option>
          <option value="168">Belum dikirimi 7 hari</option>
        </select></label>
        <label><span>Minimum outstanding</span><input class="wab-input" name="min_outstanding" inputmode="numeric" type="number" min="0" step="1000" placeholder="Contoh 150000"></label>
      </div>`,
    'broadcast.ejs advanced filters'
  );

  // Update helper copy.
  out = out.replace(
    'Saring pelanggan, lalu pilih manual bila perlu.',
    'Saring berdasarkan site, tagihan, jaringan, dan riwayat pesan; lalu pilih manual bila perlu.'
  );

  save(file, before, out);
}

function patchClientJs() {
  const file = FILES.js;
  const before = load(file);
  if (before.includes("r.site_code, r.cluster_name, r.router_name")) return;

  let out = before;

  out = replaceOne(
    out,
    /const c4 = el\('td', null, \[r\.cluster_name, r\.router_name\]\.filter\(Boolean\)\.join\(' · '\) \|\| '-'\);/,
    `const c4 = el('td', null, [r.site_code, r.cluster_name, r.router_name].filter(Boolean).join(' · ') || '-');`,
    'wa-broadcast.js location column'
  );

  out = replaceOne(
    out,
    /const n = \$\$\('\.wab-more select'\)\.filter\(s => s\.value\)\.length;/,
    `const n = $$('.wab-more select').filter(s => s.value).length
      + $$('.wab-more input').filter(i => String(i.value || '').trim()).length;`,
    'wa-broadcast.js active filter badge'
  );

  save(file, before, out);
}

function patchCss() {
  const file = FILES.css;
  const before = load(file);
  if (before.includes('grid-template-columns:minmax(0,1fr) 200px 220px')) return;

  let out = before;
  out = replaceOne(
    out,
    /\.wab-filter-top\{display:grid;grid-template-columns:minmax\(0,1fr\) 220px;gap:10px\}/,
    `.wab-filter-top{display:grid;grid-template-columns:minmax(0,1fr) 200px 220px;gap:10px}`,
    'wa-broadcast.css primary filter grid'
  );

  save(file, before, out);
}

patchRoute();
patchService();
patchView();
patchClientJs();
patchCss();

if (!changed.length) {
  console.log('[OK] Patch tampaknya sudah terpasang. Tidak ada perubahan.');
  process.exit(0);
}

console.log('\n[OK] Patch WA Broadcast selesai.');
console.log('File berubah:');
for (const f of changed) console.log(`  - ${f}`);
console.log(`\nBackup dibuat dengan suffix: .bak-${stamp}`);
console.log('\nValidasi yang disarankan:');
console.log('  node --check routes/waCrm.js');
console.log('  node --check services/waBroadcastService.js');
console.log('  node --check public/js/wa-broadcast.js');
console.log('  npm run validate:final');
console.log('\nRestart aplikasi setelah semua validasi PASS.');
