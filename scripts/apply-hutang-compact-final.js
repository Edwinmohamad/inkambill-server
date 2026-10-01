#!/usr/bin/env node
'use strict';

/**
 * INKAMBILL - Hutang Compact UX Patch
 *
 * Tujuan:
 * - UI padat / konsisten dengan menu operasional lain
 * - nomor urut otomatis
 * - search
 * - quick status filter
 * - filter site
 * - filter jatuh tempo
 * - sorting sederhana
 * - sticky header
 * - drawer detail
 * - merapikan action Edit / Hapus / Bayar yang SUDAH ADA di row
 * - keyboard shortcut "/" untuk search, Esc untuk tutup drawer
 *
 * Safety:
 * - tidak menebak endpoint CRUD baru
 * - hanya menghubungkan action Edit/Hapus/Bayar yang sudah tersedia di halaman
 * - membuat backup timestamp sebelum mengubah view
 * - berhenti bila tidak menemukan halaman Hutang yang cukup meyakinkan
 *
 * Jalankan dari root repository:
 *   node scripts/apply-hutang-compact-final.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function scoreView(file, text) {
  const s = text.toLowerCase();
  let score = 0;
  if (/hutang|utang/.test(s)) score += 12;
  if (/debt|payable/.test(s)) score += 8;
  if (/<table\b/i.test(text)) score += 6;
  if (/<thead\b/i.test(text)) score += 3;
  if (/<tbody\b/i.test(text)) score += 3;
  if (/edit|ubah/i.test(s)) score += 2;
  if (/hapus|delete/i.test(s)) score += 2;
  if (/bayar|payment/i.test(s)) score += 2;
  if (/keuangan|finance/i.test(s)) score += 1;
  if (/hutang/.test(path.basename(file).toLowerCase())) score += 10;
  if (/debt|payable/.test(path.basename(file).toLowerCase())) score += 8;
  return score;
}

const viewFiles = walk(path.join(ROOT, 'views'))
  .filter(f => /\.(ejs|html|hbs|handlebars)$/i.test(f));

const candidates = viewFiles.map(file => {
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, score: scoreView(file, text) };
}).filter(x => x.score >= 12)
  .sort((a,b) => b.score - a.score);

if (!candidates.length) {
  console.error('[FAIL] Tidak menemukan halaman Hutang yang aman untuk dipatch.');
  console.error('Cari manual dengan: grep -RniE "hutang|utang|debt|payable" views routes services');
  process.exit(1);
}

if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
  console.error('[FAIL] Ada beberapa kandidat halaman Hutang dengan skor sama.');
  for (const c of candidates.slice(0,5)) {
    console.error(`  ${c.score}  ${path.relative(ROOT,c.file)}`);
  }
  console.error('Patch dihentikan supaya tidak salah file.');
  process.exit(1);
}

const target = candidates[0];
const relView = path.relative(ROOT, target.file);

console.log(`[INFO] Halaman Hutang terdeteksi: ${relView} (score ${target.score})`);

const cssSource = path.join(__dirname, '..', 'public', 'css', 'hutang-compact.css');
const jsSource  = path.join(__dirname, '..', 'public', 'js', 'hutang-compact.js');
const cssDest   = path.join(ROOT, 'public', 'css', 'hutang-compact.css');
const jsDest    = path.join(ROOT, 'public', 'js', 'hutang-compact.js');

if (!fs.existsSync(cssSource) || !fs.existsSync(jsSource)) {
  console.error('[FAIL] Asset patch tidak lengkap.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(cssDest), { recursive: true });
fs.mkdirSync(path.dirname(jsDest), { recursive: true });
fs.copyFileSync(cssSource, cssDest);
fs.copyFileSync(jsSource, jsDest);

let view = target.text;

if (!view.includes('/css/hutang-compact.css')) {
  const cssTag = '\n<link rel="stylesheet" href="/css/hutang-compact.css">\n';
  if (/<\/head>/i.test(view)) view = view.replace(/<\/head>/i, cssTag + '</head>');
  else view = cssTag + view;
}

if (!view.includes('/js/hutang-compact.js')) {
  const jsTag = '\n<script src="/js/hutang-compact.js" defer></script>\n';
  if (/<\/body>/i.test(view)) view = view.replace(/<\/body>/i, jsTag + '</body>');
  else view += jsTag;
}

if (!view.includes('data-hutang-compact-root')) {
  // Marker non-invasif. JS tetap bisa auto-detect table jika wrapper ini tidak mengelilingi konten.
  view = '<!-- data-hutang-compact-root: enabled -->\n' + view;
}

const backup = `${target.file}.bak-${stamp}`;
fs.copyFileSync(target.file, backup);
fs.writeFileSync(target.file, view, 'utf8');

console.log('[OK] Hutang Compact UX patch terpasang.');
console.log(`  View   : ${relView}`);
console.log(`  CSS    : public/css/hutang-compact.css`);
console.log(`  JS     : public/js/hutang-compact.js`);
console.log(`  Backup : ${path.relative(ROOT, backup)}`);
console.log('');
console.log('Catatan:');
console.log('- Tombol Edit/Hapus/Bayar yang sudah ada di row akan dirapikan ke action area.');
console.log('- Patch ini sengaja TIDAK membuat endpoint delete/edit baru jika backend belum punya.');
console.log('- Search/filter/sort/nomor/drawer berjalan di frontend tanpa mengubah data.');
console.log('');
console.log('Validasi:');
console.log('  node --check public/js/hutang-compact.js');
console.log('  npm run validate:final   # bila tersedia');
