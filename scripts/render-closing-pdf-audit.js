const fs = require('fs');
const path = require('path');
const { createClosingReportPdf, rupiah } = require('../services/reportPdf');

const output = path.resolve(process.argv[2] || path.join(__dirname, '../output/pdf/closing-audit-preview.pdf'));
fs.mkdirSync(path.dirname(output), { recursive: true });
const stream = fs.createWriteStream(output);
stream.setHeader = () => {};

const incomeCategoryRows = [
  { category: 'Pendapatan Billing', count: 18, amount: 4500000 },
  { category: 'Pendapatan Pemasangan Baru', count: 3, amount: 1500000 },
  { category: 'Pendapatan Perangkat dan Layanan Tambahan Pelanggan', count: 2, amount: 750000 },
  { category: 'Pendapatan Lain-lain', count: 1, amount: 250000 }
];
const incomeByCategory = Object.fromEntries(incomeCategoryRows.map((row) => [row.category, row.amount]));
const transactionRows = [];
incomeCategoryRows.forEach((category, categoryIndex) => {
  transactionRows.push({ kind: 'group', jenis: 'Pendapatan', category: category.category, count: category.count });
  const visibleRows = Math.min(category.count, 3);
  for (let index = 0; index < visibleRows; index += 1) {
    transactionRows.push({
      kind: 'entry', tanggal: `${String(index + 1).padStart(2, '0')} Sep 2026`, lokasi: categoryIndex % 2 ? 'CDS / CLM' : 'CDS / KRW', jenis: 'Pendapatan',
      keterangan: `${index === 0 && categoryIndex === 0 ? 'Naman' : `Pelanggan ${categoryIndex + 1}.${index + 1}`} - Faktur September 2026 - Data Kas (sinkron otomatis)`,
      nominal: Math.round(category.amount / visibleRows)
    });
  }
  transactionRows.push({ kind: 'subtotal', jenis: 'Pendapatan', category: category.category, nominal: category.amount });
});
transactionRows.push({ kind: 'group', jenis: 'Pengeluaran', category: 'Operasional dan Pemeliharaan Jaringan', count: 2 });
transactionRows.push({ kind: 'entry', tanggal: '15 Sep 2026', lokasi: 'CDS / KRW', jenis: 'Pengeluaran', keterangan: 'Penggantian perangkat jaringan dengan keterangan panjang untuk memastikan teks melipat rapi dan tidak terpotong pada batas kolom.', nominal: 850000 });
transactionRows.push({ kind: 'entry', tanggal: '18 Sep 2026', lokasi: 'CDS / CLM', jenis: 'Pengeluaran', keterangan: 'Perawatan perangkat distribusi', nominal: 350000 });
transactionRows.push({ kind: 'subtotal', jenis: 'Pengeluaran', category: 'Operasional dan Pemeliharaan Jaringan', nominal: 1200000 });

createClosingReportPdf(stream, {
  title: 'Closing Edwin - Audit Layout',
  subtitle: 'Periode transaksi 2026-09-01 s/d 2026-09-30 - data ilustrasi untuk audit tata letak',
  filename: path.basename(output), recipientName: 'Edwin', watermark: 'AUDIT PREVIEW',
  summaryItems: [
    { label: 'Total Bruto', value: rupiah(2400000), color: '#3478F6' },
    { label: 'Penyesuaian Bersih', value: `- ${rupiah(750000)}`, color: '#FF433E' },
    { label: 'TOTAL DITERIMA', value: rupiah(1650000), color: '#18A979' }
  ],
  incomeCategoryRows,
  blocks: [{ label: 'Total CDS (KRW + CLM)', revenue: 7000000, expense: 1200000, profit: 5800000, incomeByCategory, expenseByCategory: { 'Operasional dan Pemeliharaan Jaringan': 1200000 }, share: { percent: 50, gross: 2900000, amount: 2150000 } }],
  adjustmentRows: [{ jenis: 'Potongan gaji', lokasi: 'CDS', keterangan: '50% dari total gaji Agung dan Padilah. Keterangan panjang ini menguji pembungkusan teks tanpa tulisan yang terpotong.', nominal: -750000 }],
  transactionRows,
  customerActivityRows: [{ lokasi: 'CDS', psb: 3, off: 1, bayar: 24, belumBayar: 2 }],
  unpaidCustomerRows: [{ name: 'Pelanggan Belum Bayar', customerCode: 'C-099', location: 'CDS / KRW', invoiceCount: 1, outstanding: 250000 }],
  unpaidCustomerSummary: { count: 1, invoiceCount: 1, outstanding: 250000 },
  newCustomerRows: [{ activationDate: '03 Sep 2026', name: 'Pelanggan Baru dengan Nama Sangat Panjang untuk Uji Layout', customerCode: 'C-101', location: 'CDS / CLM' }],
  internalDebtRows: [], internalDebtSummary: null
});

stream.on('finish', () => console.log(output));
