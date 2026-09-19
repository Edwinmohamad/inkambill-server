const fs=require('fs');
const assert=require('assert');

const view=fs.readFileSync('views/finance/cash.ejs','utf8');
const app=fs.readFileSync('public/js/app.js','utf8');

assert(view.includes('data-instant-prefix-form'), 'Form Data Kas belum mengaktifkan pencarian instan');
assert(view.includes('data-instant-prefix-input'), 'Input pencarian instan tidak ditemukan');
assert(view.includes('data-instant-filter-row'), 'Baris transaksi belum bisa difilter lokal');
assert(view.includes('data-instant-search-value='), 'Indeks pencarian lokal tidak ditemukan');
assert(!view.includes('class="btn-tech cash-search-submit"'), 'Tombol Cari lama masih tampil');
assert(app.includes("input.addEventListener('input',apply)"), 'Pencarian belum bereaksi langsung saat mengetik');
assert(app.includes("input.removeAttribute('name')"), 'Pencarian lokal masih terkirim ke server saat filter lain berubah');
assert(app.includes("word.startsWith(query)"), 'Pencarian harus mencocokkan awalan kata');
assert(app.includes("if(event.key==='Enter')event.preventDefault()"), 'Enter masih dapat memicu reload');
assert(app.includes("row.hidden=!match"), 'Baris tidak disaring tanpa request server');

console.log('Instant Data Kas search regression test OK.');
