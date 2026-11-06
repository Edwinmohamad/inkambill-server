// APK INKAMBILL: halaman daftar besar (Tagihan, Pelanggan, Pembayaran, Kas) dimuat 30 baris per halaman
// di APK agar scroll tidak macet di HP RAM 4 GB. Web tetap memakai ukuran bawaan masing-masing.
const assert=require('node:assert/strict');
const {pageInfo,MOBILE_APP_PAGE_SIZE}=require('../utils/pagination');
const req=(ua,query={})=>({query,get:h=>String(h).toLowerCase()==='user-agent'?ua:''});
const app='Mozilla/5.0 (Linux; Android 13) Chrome/129 Mobile INKAMNET-GO/1.3.4',web='Mozilla/5.0 (Windows NT 10.0) Chrome/129';
assert.equal(MOBILE_APP_PAGE_SIZE,30);
assert.equal(pageInfo(req(app),500,500).perPage,30,'APK: Tagihan/Pelanggan 30 per halaman');
assert.equal(pageInfo(req(app),50).perPage,30,'APK: Pembayaran/Kas 30 per halaman');
assert.equal(pageInfo(req(web),500,500).perPage,500,'Web tetap 500');
assert.equal(pageInfo(req(web),50).perPage,50,'Web tetap 50');
assert.equal(pageInfo(req(app,{per_page:'100'}),500,500).perPage,100,'per_page eksplisit tetap dihormati');
assert.equal(pageInfo({query:{page:'2',per_page:'50'}},50,100).perPage,50,'req tanpa header tetap aman');
console.log('Mobile pagination: APK 30 per halaman, web tidak berubah.');
