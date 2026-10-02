const fs = require('fs');
const assert = require('assert/strict');

const layout = fs.readFileSync('views/partials/layout.ejs', 'utf8');
const css = fs.readFileSync('public/css/ui-coherence.css', 'utf8');
const smoke = fs.readFileSync('public/_smoketest/components.html', 'utf8');

const bodyIndex = layout.indexOf('<%- body %>');
const coherenceIndex = layout.indexOf('/css/ui-coherence.css');
assert(bodyIndex >= 0 && coherenceIndex > bodyIndex, 'coherence layer harus dimuat setelah CSS khusus halaman');

[
  '--fs-1:.6875rem',
  '--ui-control-h:40px',
  '.module-head h1',
  '.app-table th',
  '.modal-content',
  ':focus-visible',
  '@media(max-width:991.98px)',
  '@media(max-width:575.98px)',
  '@media(prefers-reduced-motion:reduce)',
  'opacity:1!important'
].forEach(token => assert(css.includes(token), `UI coherence token hilang: ${token}`));

assert.match(css, /font-family:"Geist",-apple-system,BlinkMacSystemFont/, 'font stack utama harus konsisten dan punya fallback native');
assert.match(css, /\.page-enter small\{font-size:max\(\.6875rem,\.75em\)!important\}/, 'teks kecil tidak boleh turun di bawah batas keterbacaan');
assert(smoke.includes('/css/ui-coherence.css'), 'halaman smoke test harus memuat coherence layer');
assert(smoke.includes('metric-grid') && smoke.includes('filter-grid') && smoke.includes('app-table'), 'smoke test harus mencakup widget utama');

console.log('UI coherence validation: PASS');
