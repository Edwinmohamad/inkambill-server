const fs=require('fs');
const route=fs.readFileSync('routes/finance.js','utf8');
const cash=fs.readFileSync('views/finance/cash.ejs','utf8');
const categories=fs.readFileSync('views/finance/cash-categories.ejs','utf8');
const schema=fs.readFileSync('services/schemaService.js','utf8');
const invoice=fs.readFileSync('services/invoiceService.js','utf8');
const checks=[
  [schema.includes("'KOMISI-TEK','Komisi Teknisi Pemasangan'")&&schema.includes("'KOMISI-SLS','Komisi Sales Pemasangan'"),'seed kategori komisi'],
  [invoice.includes("sourceType: 'install_commission_technician'")&&invoice.includes("sourceType: 'install_commission_sales'"),'jurnal komisi otomatis'],
  [route.includes('SELECT * FROM cash_categories WHERE is_active=1 ORDER BY type,COALESCE(is_system,0),name'),'kategori sistem tersedia untuk filter'],
  [cash.includes("categories.filter(c=>!Number(c.is_system||0)).forEach"),'kategori otomatis tidak dapat dipilih untuk input manual'],
  [cash.includes("Number(c.is_system||0)?'disabled':''"),'kategori otomatis terkunci saat edit'],
  [categories.includes('Otomatis Sistem')&&categories.includes('Read-only'),'kategori otomatis terlihat dan read-only'],
  [categories.includes("categories.filter(c=>Number(c.is_system||0)===0).forEach"),'modal edit hanya kategori manual']
];
for(const [ok,label] of checks)if(!ok)throw new Error(`System cash category validation failed: ${label}`);
console.log(`System cash category validation passed: ${checks.length} traceability and protection checks.`);
