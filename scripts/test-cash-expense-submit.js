const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const finance=fs.readFileSync(path.join(root,'routes/finance.js'),'utf8');
const payments=fs.readFileSync(path.join(root,'routes/payments.js'),'utf8');
const cashService=fs.readFileSync(path.join(root,'services/cashService.js'),'utf8');
const cashView=fs.readFileSync(path.join(root,'views/finance/cash.ejs'),'utf8');

assert.match(finance,/const transactionDate=await assertDateOpen\(db,b\.transaction_date\)/,'tanggal transaksi dinormalisasi sebelum INSERT');
assert.match(finance,/VALUES\(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/,'INSERT kas memakai 20 placeholder eksplisit');
assert.match(finance,/saved\?actorId:null,saved\?new Date\(\):null,'manual','PENDING_APPROVAL',actorId/,'INSERT kas selalu menyimpan sumber manual dan status pending');
assert.match(finance,/approval_status!=='PENDING_APPROVAL'/,'hasil INSERT diverifikasi sebelum commit');
assert.match(payments,/ct\.approval_status='PENDING_APPROVAL' OR \(ct\.approval_status IS NULL AND COALESCE\(ct\.source_type,'manual'\)='manual'\)/,'antrean Approval menangkap pending manual secara konsisten');
assert.equal((cashService.match(/COALESCE\(ct\.approval_status,'PENDING_APPROVAL'\) approval_status/g)||[]).length,2,'aksi approve/reject dapat menangani pending legacy berstatus NULL');
assert.match(cashView,/name="amount" min="1" required/,'nominal tetap wajib diisi');
assert.match(cashView,/Nominal pengeluaran wajib diisi dan harus lebih dari 0/,'form menampilkan alasan submit ditolak');
assert.match(cashView,/addForm\.querySelector\('\.modal-footer \.btn-tech\.primary'\)/,'validasi tombol simpan aktif di modal');

console.log('Cash expense submit validation: PASS');
