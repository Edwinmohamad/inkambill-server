const fs=require('fs');
const assert=require('assert');

const route=fs.readFileSync('routes/finance.js','utf8');
const view=fs.readFileSync('views/finance/cash.ejs','utf8');

assert(route.includes("['manual','cash','transfer','qris','gateway','other']"),'daftar metode yang diizinkan belum lengkap');
assert(route.includes("method==='manual'")&&route.includes("COALESCE(ct.source_type,'manual')='manual'"),'filter transaksi manual belum tersedia');
assert(route.includes("src_pmt.method=?")&&route.includes("ct.source_type='payment'"),'filter metode pembayaran belum terhubung ke payment sumber');
assert(route.includes('filters:{month,year,site,q,category,type,method}'),'nilai filter metode belum diteruskan ke view');
assert((view.match(/name="method"/g)||[]).length>=2,'filter metode harus tersedia pada panel periode dan toolbar Data Kas');
for(const value of ['manual','cash','transfer','qris','gateway','other'])assert(view.includes(`value="${value}"`),`opsi metode ${value} tidak ada`);
assert(view.includes('filters.method'),'pilihan metode aktif tidak dipertahankan di UI');

console.log('cash-payment-method-filter: PASS');
