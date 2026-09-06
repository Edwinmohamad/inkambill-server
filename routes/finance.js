const express=require('express');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const db=require('../config/db');
const { requireAdmin, requireMasterAdmin, requirePermission, isMasterAdminRole }=require('../middleware/auth');
const { assignCashTransactionCode,normalizeCategoryCode,approveCashTransaction,rejectCashTransaction }=require('../services/cashService');
const { formatCashExpenseName }=require('../services/cashNamingService');
const { audit }=require('../services/auditService');
const router=express.Router();
const MONTH_NAMES_ID=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
// v1.25.5 (susulan) — "Nominal Tetap" & "Tanggal Jatuh Tempo" only ever mean something when a category is
// flagged Wajib Bulanan; if the checkbox is off both are forced back to NULL regardless of what the
// (hidden) inputs held, so a category that was never mandatory never silently gains a due-date target.
function mandatoryTargetFields(b){
  if(!b.is_recurring_mandatory) return {expectedAmount:null,dueDay:null};
  const amountRaw=Number(b.expected_amount);
  const expectedAmount=Number.isFinite(amountRaw)&&amountRaw>0?amountRaw:null;
  const dueRaw=Number(b.due_day);
  const dueDay=Number.isInteger(dueRaw)&&dueRaw>=1&&dueRaw<=28?dueRaw:null;
  return {expectedAmount,dueDay};
}
router.use(['/discounts','/charges'],requirePermission('billing'));
router.use('/cash',requirePermission('finance'));

const CASH_PROOF_DIR=path.join(__dirname,'..','storage','cash-proofs');
fs.mkdirSync(CASH_PROOF_DIR,{recursive:true});
function intInRange(value,min,max,fallback){const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function proofExtension(mime){return ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','application/pdf':'.pdf'})[mime]||'';}
function proofSignatureMatches(file){const b=file?.buffer;if(!b||b.length<12)return false;if(file.mimetype==='image/jpeg')return b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;if(file.mimetype==='image/png')return b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));if(file.mimetype==='image/webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';if(file.mimetype==='application/pdf')return b.subarray(0,5).toString()==='%PDF-';return false;}
async function saveCashProof(file){if(!file)return null;const ext=proofExtension(file.mimetype);if(!ext||!proofSignatureMatches(file))throw new Error('Isi file bukti pengeluaran tidak sesuai format yang diizinkan.');const filename=`cash-${Date.now()}-${crypto.randomUUID()}${ext}`;await fs.promises.writeFile(path.join(CASH_PROOF_DIR,filename),file.buffer,{flag:'wx'});return{filename,originalName:file.originalname,mime:file.mimetype,size:file.size};}
async function removeCashProof(filename){if(!filename)return;try{await fs.promises.unlink(path.join(CASH_PROOF_DIR,path.basename(filename)));}catch(e){if(e.code!=='ENOENT')console.error('Gagal hapus bukti kas:',e.message);}}
function cashReturn(body){const month=body.return_month||'',year=body.return_year||'',site=body.return_site||'',q=body.return_q||'',category=body.return_category||'',type=body.return_type||'';const p=new URLSearchParams();if(month)p.set('month',month);if(year)p.set('year',year);if(site)p.set('site',site);if(q)p.set('q',q);if(category)p.set('category',category);if(type)p.set('type',type);return `/cash${p.toString()?`?${p.toString()}`:''}`;}
function localReturn(value,fallback='/cash'){const v=String(value||'');return v.startsWith('/')&&!v.startsWith('//')?v:fallback;}
function vendorMeta(category,body){
  const isVendor=String(category?.code||'').toUpperCase()==='VENDOR'||String(category?.name||'').trim().toLowerCase()==='vendor';
  if(!isVendor)return {isVendor:false,name:null,duration:null,unit:null};
  const name=String(body.vendor_name||'').trim(),duration=Number(body.vendor_duration),unit=['hour','day'].includes(body.vendor_duration_unit)?body.vendor_duration_unit:null;
  if(!name)throw new Error('Nama vendor wajib diisi untuk kategori Vendor.');
  if(!Number.isFinite(duration)||duration<=0||!unit)throw new Error('Durasi kerja vendor dan satuannya wajib diisi dengan benar.');
  if(!String(body.notes||'').trim())throw new Error('Keterangan pekerjaan vendor wajib diisi.');
  return {isVendor:true,name,duration,unit};
}

router.get('/discounts',async(req,res)=>{const [discounts]=await db.query(`SELECT * FROM discounts ORDER BY is_active DESC,id DESC`);res.render('finance/discounts',{title:'Diskon',discounts});});
router.post('/discounts',async(req,res)=>{const b=req.body;await db.execute(`INSERT INTO discounts(name,type,amount,description,is_active) VALUES(?,?,?,?,1)`,[b.name,b.type||'flat',b.amount||0,b.description||null]);req.session.flash={type:'success',message:'Diskon ditambahkan.'};res.redirect('/discounts');});
router.post('/discounts/:id/edit',async(req,res)=>{const b=req.body;const name=String(b.name||'').trim();if(!name){req.session.flash={type:'danger',message:'Nama diskon wajib diisi.'};return res.redirect('/discounts');}const type=['flat','percent'].includes(b.type)?b.type:'flat';await db.execute(`UPDATE discounts SET name=?,type=?,amount=?,description=? WHERE id=?`,[name,type,b.amount||0,b.description||null,req.params.id]);req.session.flash={type:'success',message:'Diskon berhasil diperbarui.'};res.redirect('/discounts');});
router.post('/discounts/:id/toggle',async(req,res)=>{await db.execute(`UPDATE discounts SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/discounts');});
// v1.25.1 — requested delete action for Diskon. Mirrors the same "block hard delete while still in use"
// safety pattern used for Paket Internet (routes/packages.js /:id/delete): a discount still attached to
// any non-archived customer (customers.discount_id) is blocked from permanent deletion — use Aktif/Nonaktif
// instead so it stops being offered without breaking the customers already using it.
router.post('/discounts/:id/delete',requireAdmin,async(req,res)=>{
  const id=Number(req.params.id);
  const [[discount]]=await db.execute(`SELECT id,name FROM discounts WHERE id=? LIMIT 1`,[id]);
  if(!discount){req.session.flash={type:'warning',message:'Diskon tidak ditemukan.'};return res.redirect('/discounts');}
  const [[usage]]=await db.execute(`SELECT COUNT(*) n FROM customers WHERE discount_id=? AND archived_at IS NULL`,[id]);
  if(Number(usage?.n||0)>0){
    req.session.flash={type:'danger',message:`Diskon ${discount.name} masih dipakai ${usage.n} pelanggan aktif dan tidak dapat dihapus permanen. Gunakan tombol Aktif/Nonaktif agar diskon berhenti ditawarkan tanpa memutus data pelanggan yang sudah memakainya.`};
    return res.redirect('/discounts');
  }
  await db.execute(`DELETE FROM discounts WHERE id=?`,[id]);
  await audit({userId:req.session.user.id,action:'delete',entityType:'discount',entityId:id,description:`Hapus diskon ${discount.name}`,ip:req.ip});
  req.session.flash={type:'success',message:`Diskon ${discount.name} dihapus permanen.`};
  res.redirect('/discounts');
});

router.get('/charges',async(req,res)=>{const [charges]=await db.query(`SELECT * FROM additional_charges ORDER BY is_active DESC,id DESC`);res.render('finance/charges',{title:'Biaya Tambahan',charges});});
router.post('/charges',async(req,res)=>{const b=req.body;await db.execute(`INSERT INTO additional_charges(name,amount,description,is_active) VALUES(?,?,?,1)`,[b.name,b.amount||0,b.description||null]);req.session.flash={type:'success',message:'Biaya tambahan ditambahkan.'};res.redirect('/charges');});
router.post('/charges/:id/edit',async(req,res)=>{const b=req.body;const name=String(b.name||'').trim();if(!name){req.session.flash={type:'danger',message:'Nama biaya tambahan wajib diisi.'};return res.redirect('/charges');}await db.execute(`UPDATE additional_charges SET name=?,amount=?,description=? WHERE id=?`,[name,b.amount||0,b.description||null,req.params.id]);req.session.flash={type:'success',message:'Biaya tambahan berhasil diperbarui.'};res.redirect('/charges');});
router.post('/charges/:id/toggle',async(req,res)=>{await db.execute(`UPDATE additional_charges SET is_active=IF(is_active=1,0,1) WHERE id=?`,[req.params.id]);res.redirect('/charges');});

router.get('/cash/categories',async(req,res)=>{
  const [categories]=await db.query(`SELECT cc.*,s.code site_code,COUNT(ct.id) usage_count
    FROM cash_categories cc LEFT JOIN sites s ON s.id=cc.site_id LEFT JOIN cash_transactions ct ON ct.category_id=cc.id
    WHERE COALESCE(cc.is_system,0)=0
    GROUP BY cc.id,s.code ORDER BY cc.type,cc.name`);
  const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  res.render('finance/cash-categories',{title:'Kategori Kas',categories,sites});
});
router.post('/cash/categories',async(req,res)=>{
  const b=req.body;const name=String(b.name||'').trim();const type=['income','expense'].includes(b.type)?b.type:'expense';
  if(!name){req.session.flash={type:'danger',message:'Nama kategori wajib diisi.'};return res.redirect('/cash/categories');}
  let code=normalizeCategoryCode(b.code||name,type==='income'?'INC':'EXP');
  const [dup]=await db.execute(`SELECT id FROM cash_categories WHERE code=? LIMIT 1`,[code]);
  if(dup.length)code=`${code.slice(0,7)}${String(Date.now()).slice(-3)}`;
  const isMandatory=b.is_recurring_mandatory?1:0;
  const {expectedAmount,dueDay}=mandatoryTargetFields(b);
  await db.execute(`INSERT INTO cash_categories(code,name,type,site_id,description,is_active,is_system,is_recurring_mandatory,expected_amount,due_day) VALUES(?,?,?,?,?,1,0,?,?,?)`,[code,name,type,b.site_id||null,b.description||null,isMandatory,expectedAmount,dueDay]);
  req.session.flash={type:'success',message:`Kategori kas ${name} ditambahkan dengan kode ${code}.`};
  res.redirect('/cash/categories');
});
router.post('/cash/categories/:id/edit',requireAdmin,async(req,res)=>{
  const b=req.body;const name=String(b.name||'').trim();const type=['income','expense'].includes(b.type)?b.type:'expense';
  const [rows]=await db.execute(`SELECT cc.id,COALESCE(cc.is_system,0) is_system,cc.type current_type,COUNT(ct.id) usage_count FROM cash_categories cc LEFT JOIN cash_transactions ct ON ct.category_id=cc.id WHERE cc.id=? GROUP BY cc.id LIMIT 1`,[req.params.id]);
  if(!rows.length){req.session.flash={type:'warning',message:'Kategori kas tidak ditemukan.'};return res.redirect('/cash/categories');}
  if(Number(rows[0].is_system)===1){req.session.flash={type:'warning',message:'Kategori internal sistem tidak dapat diedit dari menu manual.'};return res.redirect('/cash/categories');}
  if(!name){req.session.flash={type:'danger',message:'Nama kategori wajib diisi.'};return res.redirect('/cash/categories');}
  // v1.25 audit: cash_transactions/reports/analytics all derive income-vs-expense LIVE from
  // cash_categories.type (no snapshot on the transaction row), so changing type on a category that
  // already has transactions would silently reclassify every historical row's sign in Data Kas, the
  // charts, and Laporan. Block it — same "usage_count>0 blocks a structural change" rule already used
  // for delete — and point the admin to make a new category instead.
  if(type!==rows[0].current_type && Number(rows[0].usage_count)>0){
    req.session.flash={type:'danger',message:`Kategori ${name} sudah dipakai pada ${rows[0].usage_count} transaksi. Jenis (income/expense) tidak dapat diubah lagi karena akan mengubah histori laporan. Buat kategori baru bila memang perlu jenis berbeda.`};
    return res.redirect('/cash/categories');
  }
  const isMandatory=b.is_recurring_mandatory?1:0;
  const {expectedAmount,dueDay}=mandatoryTargetFields(b);
  await db.execute(`UPDATE cash_categories SET name=?,type=?,site_id=?,description=?,is_recurring_mandatory=?,expected_amount=?,due_day=? WHERE id=?`,[name,type,b.site_id||null,b.description||null,isMandatory,expectedAmount,dueDay,req.params.id]);
  req.session.flash={type:'success',message:`Kategori ${name} diperbarui.`};
  res.redirect('/cash/categories');
});
router.post('/cash/categories/:id/delete',requireAdmin,async(req,res)=>{
  const [rows]=await db.execute(`SELECT id,name,COALESCE(is_system,0) is_system FROM cash_categories WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length){req.session.flash={type:'warning',message:'Kategori kas tidak ditemukan.'};return res.redirect('/cash/categories');}
  const category=rows[0];
  if(Number(category.is_system)===1){
    req.session.flash={type:'warning',message:'Kategori internal sistem tidak dapat dihapus dari menu manual.'};
    return res.redirect('/cash/categories');
  }
  const [[usage]]=await db.execute(`SELECT COUNT(*) total FROM cash_transactions WHERE category_id=?`,[category.id]);
  if(Number(usage.total)>0){
    req.session.flash={type:'warning',message:`Kategori ${category.name} sudah dipakai pada ${usage.total} transaksi. Hapus/pindahkan transaksi terkait terlebih dahulu.`};
    return res.redirect('/cash/categories');
  }
  await db.execute(`DELETE FROM cash_categories WHERE id=?`,[category.id]);
  req.session.flash={type:'success',message:`Kategori ${category.name} berhasil dihapus.`};
  res.redirect('/cash/categories');
});

router.get('/cash',async(req,res)=>{
  const now=new Date();const month=intInRange(req.query.month,1,12,now.getMonth()+1);const year=intInRange(req.query.year,2020,2100,now.getFullYear());const site=String(req.query.site||'').trim();const q=String(req.query.q||'').trim();
  // v1.25.5 (susulan #13) — Kategori & Tipe (Pemasukan/Pengeluaran) filter, requested alongside the
  // existing Site filter for faster lookup in a busy Data Kas ledger. Scoped only to the transaction
  // list below (same as `q`) — the summary cards, charts, and mandatory-expense checklist intentionally
  // keep showing the whole month/site regardless, so they always reflect the real totals.
  const category=String(req.query.category||'').trim();const type=['income','expense'].includes(req.query.type)?req.query.type:'';
  // v1.24.2 — auto (source_type='payment') rows join through to their originating invoice so the
  // "Aksi" column can offer a real, safe way to reverse them (via /invoices/:id/reset-unpaid, which
  // cancels the payment, reopens the invoice as unpaid, AND removes this exact cash_transactions row)
  // instead of a dead-end padlock. Deleting the cash row directly would orphan it from the payment/
  // invoice records, so that path stays blocked in the delete/force-delete routes below.
  // Bukti transfer disimpan pada payments, bukan diduplikasi ke cash_transactions. Data Kas mengambil
  // metadata bukti sumber secara langsung agar lampiran yang dilihat selalu versi pembayaran terbaru.
  let sql=`SELECT ct.*,cc.code category_code,cc.name category_name,cc.type category_type,s.code site_code,pu.name proof_uploader_name,src_pmt.id source_payment_id,src_pmt.proof_path source_payment_proof_path,src_pmt.proof_original_name source_payment_proof_name,src_pmt.proof_mime source_payment_proof_mime,src_inv.id source_invoice_id,src_inv.invoice_number source_invoice_number,src_inv.period_month source_invoice_month,src_inv.period_year source_invoice_year FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id LEFT JOIN users pu ON pu.id=ct.proof_uploaded_by LEFT JOIN payments src_pmt ON ct.source_type='payment' AND src_pmt.id=ct.source_id LEFT JOIN invoices src_inv ON src_inv.id=src_pmt.invoice_id WHERE MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=?`;
  const params=[month,year];if(site){sql+=` AND s.code=?`;params.push(site);}if(category){sql+=` AND ct.category_id=?`;params.push(category);}if(type){sql+=` AND cc.type=?`;params.push(type);}if(q){sql+=` AND (ct.transaction_code LIKE ? OR ct.name LIKE ? OR ct.notes LIKE ? OR cc.name LIKE ? OR cc.code LIKE ? OR ct.purchase_shop_name LIKE ? OR ct.purchase_channel LIKE ? OR ct.vendor_name LIKE ?)`;const like=`%${q}%`;params.push(like,like,like,like,like,like,like,like);}sql+=` ORDER BY ct.transaction_date DESC,ct.id DESC`;
  const [transactions]=await db.execute(sql,params);const [categories]=await db.query(`SELECT * FROM cash_categories WHERE is_active=1 AND COALESCE(is_system,0)=0 ORDER BY type,name`);const [sites]=await db.query(`SELECT id,code,name FROM sites WHERE is_active=1 ORDER BY code`);
  const summarySql=`SELECT COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN cc.type='expense' THEN ct.amount ELSE 0 END),0) expense FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=?${site?` AND s.code=?`:''}`;
  const [[summary]]=await db.execute(summarySql,[month,year,...(site?[site]:[])]);summary.balance=Number(summary.income)-Number(summary.expense);
  const [[collection]]=await db.execute(`SELECT COALESCE(SUM(CASE WHEN p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' THEN p.amount ELSE 0 END),0) cash_held,COUNT(CASE WHEN p.method='cash' AND p.status='confirmed' AND p.settlement_status='held_by_staff' THEN 1 END) held_count FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN customers c ON c.id=i.customer_id LEFT JOIN sites s ON s.id=c.site_id WHERE MONTH(p.paid_at)=? AND YEAR(p.paid_at)=?${site?` AND s.code=?`:''}`,[month,year,...(site?[site]:[])]);
  const [categoryChartRows]=await db.execute(`SELECT cc.name label,COALESCE(SUM(ct.amount),0) amount FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND cc.type='expense' AND MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=?${site?` AND s.code=?`:''} GROUP BY cc.id,cc.name HAVING amount>0 ORDER BY amount DESC`,[month,year,...(site?[site]:[])]);
  const [dailyChartRows]=await db.execute(`SELECT DAY(ct.transaction_date) day_no,COALESCE(SUM(CASE WHEN cc.type='income' THEN ct.amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN cc.type='expense' THEN ct.amount ELSE 0 END),0) expense FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id WHERE COALESCE(ct.approval_status,'APPROVED')='APPROVED' AND MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=?${site?` AND s.code=?`:''} GROUP BY DAY(ct.transaction_date) ORDER BY day_no`,[month,year,...(site?[site]:[])]);
  const daysInMonth=new Date(year,month,0).getDate(),daily={labels:Array.from({length:daysInMonth},(_,i)=>String(i+1)),income:Array(daysInMonth).fill(0),expense:Array(daysInMonth).fill(0)};
  dailyChartRows.forEach(row=>{const i=Number(row.day_no)-1;daily.income[i]=Number(row.income||0);daily.expense[i]=Number(row.expense||0);});
  const cashCharts={categories:categoryChartRows.map(row=>({label:row.label,amount:Number(row.amount||0)})),daily};
  const [[approvalSummary]]=await db.execute(`SELECT SUM(COALESCE(ct.approval_status,'APPROVED')='PENDING_APPROVAL') pending_count,COALESCE(SUM(CASE WHEN ct.approval_status='PENDING_APPROVAL' THEN ct.amount ELSE 0 END),0) pending_total FROM cash_transactions ct LEFT JOIN sites s ON s.id=ct.site_id WHERE MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=?${site?` AND s.code=?`:''}`,[month,year,...(site?[site]:[])]);

  // v1.24.8 — "Checklist Pengeluaran Wajib Bulan Ini": cross-reference every active site against every
  // category flagged is_recurring_mandatory (Sewa/Listrik/Bandwidth-type recurring bills), so staff can
  // see at a glance which mandatory bills still haven't been logged for the selected month/site filter,
  // instead of relying on memory. A category counts as "recorded" if any non-REJECTED transaction exists
  // for that exact category+site+month — PENDING_APPROVAL still counts (it means someone already logged
  // it, even if Master Admin hasn't approved yet).
  const mandatorySites=site?sites.filter(s=>s.code===site):sites;
  // v1.25 audit fix: a mandatory category can itself be scoped to one specific site (site_id set via the
  // Kategori Kas Tambah/Edit form). The checklist below used to ignore that and cross-join every
  // mandatory category against every active site regardless, so a category scoped to Site A would still
  // nag as "belum dicatat" for every other site. Now select site_id and, when set, only cross-reference
  // that one site.
  const [mandatoryCategories]=await db.query(`SELECT id,code,name,site_id,expected_amount,due_day FROM cash_categories WHERE is_active=1 AND COALESCE(is_system,0)=0 AND COALESCE(is_recurring_mandatory,0)=1 ORDER BY name`);
  let mandatoryChecklist=[];
  if(mandatoryCategories.length&&mandatorySites.length){
    const catPlaceholders=mandatoryCategories.map(()=>'?').join(',');
    const [recorded]=await db.query(`SELECT ct.category_id,ct.site_id,SUM(ct.amount) total
      FROM cash_transactions ct
      WHERE MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=? AND COALESCE(ct.approval_status,'APPROVED')<>'REJECTED'
        AND ct.category_id IN (${catPlaceholders}) AND ct.site_id IS NOT NULL
      GROUP BY ct.category_id,ct.site_id`,[month,year,...mandatoryCategories.map(c=>c.id)]);
    const recordedMap=new Map(recorded.map(r=>[`${r.category_id}:${r.site_id}`,Number(r.total||0)]));
    // v1.25.5 (susulan) — "belum dicatat" is now split into "pending" (due date this month hasn't passed
    // yet) vs "overdue" (due_day has passed and it's still not recorded), using cash_categories.due_day.
    // A category with no due_day configured (existing categories from before this update) keeps the old
    // simple recorded/pending behavior — never silently reclassified as overdue.
    const isCurrentPeriod=year===now.getFullYear()&&month===now.getMonth()+1;
    const todayDate=now.getDate();
    for(const cat of mandatoryCategories){
      const targetSites=cat.site_id?mandatorySites.filter(s=>Number(s.id)===Number(cat.site_id)):mandatorySites;
      for(const s of targetSites){
        const total=recordedMap.get(`${cat.id}:${s.id}`);
        const recorded=total!==undefined;
        let status=recorded?'paid':'pending';
        if(!recorded&&cat.due_day&&isCurrentPeriod&&todayDate>Number(cat.due_day))status='overdue';
        mandatoryChecklist.push({category_id:cat.id,category_name:cat.name,site_id:s.id,site_code:s.code,recorded,total:total||0,expected_amount:cat.expected_amount?Number(cat.expected_amount):null,due_day:cat.due_day||null,status});
      }
    }
  }

  // v1.25.5 (susulan) — one in-app notification (badge, Menu Billing) per overdue mandatory expense per
  // month, broadcast to Admin/Master Admin — NOT re-sent on every page view. Only computed when viewing
  // the current, unfiltered period so the notification always reflects the complete picture (a site
  // filter would otherwise under-report what's overdue system-wide). Dedup key: entity_type +
  // entity_id=(category_id*10000+site_id) + a period marker embedded in `type` itself, so re-visiting
  // Data Kas all month never spams a second notification for the same overdue bill.
  if(!site && year===now.getFullYear()&&month===now.getMonth()+1){
    const overdue=mandatoryChecklist.filter(it=>it.status==='overdue');
    if(overdue.length){
      const periodType=`mandatory_expense_overdue_${year}${String(month).padStart(2,'0')}`;
      for(const item of overdue){
        const entityId=Number(item.category_id)*10000+Number(item.site_id);
        const [[already]]=await db.execute(`SELECT id FROM system_notifications WHERE type=? AND entity_type='cash_category_site' AND entity_id=? LIMIT 1`,[periodType,entityId]);
        if(already)continue;
        const title=`Pengeluaran wajib terlambat: ${item.category_name} (${item.site_code})`;
        const detail=`Belum dicatat sampai tanggal ${now.getDate()}, jatuh tempo tanggal ${item.due_day}${item.expected_amount?` · nominal biasanya Rp${Number(item.expected_amount).toLocaleString('id-ID')}`:''} — ${MONTH_NAMES_ID[month-1]} ${year}.`;
        await db.execute(`INSERT INTO system_notifications(recipient_id,type,tone,icon,title,detail,href,entity_type,entity_id)
          SELECT u.id,?,'danger','bi-calendar2-x-fill',?,?,?,'cash_category_site',? FROM users u WHERE u.is_active=1 AND LOWER(TRIM(u.role)) IN ('admin','master_admin')`,[periodType,title,detail,`/cash?site=${encodeURIComponent(item.site_code)}`,entityId]);
      }
    }
  }

  res.render('finance/cash',{title:'Data Kas',transactions,categories,sites,summary,collection:collection||{},approvalSummary:approvalSummary||{},cashCharts,mandatoryChecklist,filters:{month,year,site,q,category,type}});
});

router.get('/cash/:id/proof',async(req,res)=>{const [rows]=await db.execute(`SELECT proof_path,proof_original_name,proof_mime FROM cash_transactions WHERE id=? LIMIT 1`,[req.params.id]);const t=rows[0];if(!t?.proof_path)return res.status(404).send('Bukti pengeluaran tidak ditemukan.');const full=path.join(CASH_PROOF_DIR,path.basename(t.proof_path));if(!fs.existsSync(full))return res.status(404).send('File bukti pengeluaran tidak ditemukan di storage.');res.type(t.proof_mime||'application/octet-stream');res.setHeader('Content-Disposition',`inline; filename="${String(t.proof_original_name||path.basename(t.proof_path)).replace(/[\r\n"]/g,'_')}"`);res.setHeader('Cache-Control','private, max-age=300');res.setHeader('X-Content-Type-Options','nosniff');res.sendFile(full);});

router.post('/cash',async(req,res)=>{
  const b=req.body;const name=String(b.name||'').trim();const amount=Number(b.amount);if(!name)throw new Error('Nama transaksi wajib diisi.');if(!Number.isFinite(amount)||amount<=0)throw new Error('Nominal transaksi harus lebih dari 0.');
  const conn=await db.getConnection();let saved=null;
  try{await conn.beginTransaction();const [categoryRows]=await conn.execute(`SELECT id,name,type,code FROM cash_categories WHERE id=? AND is_active=1 LIMIT 1`,[b.category_id]);const category=categoryRows[0];if(!category)throw new Error('Kategori kas tidak ditemukan atau sudah tidak aktif.');const vendor=vendorMeta(category,b),isExpense=category.type==='expense';const purchaseChannel=isExpense&&!vendor.isVendor&&['online','offline'].includes(b.purchase_channel)?b.purchase_channel:null;const formattedName=isExpense?formatCashExpenseName({categoryCode:category.code,categoryName:category.name,rawName:name,shopName:b.purchase_shop_name,vendorName:vendor.name}):name;if(req.file)saved=await saveCashProof(req.file);const [r]=await conn.execute(`INSERT INTO cash_transactions(transaction_date,name,category_id,site_id,amount,notes,purchase_channel,purchase_shop_name,vendor_name,vendor_duration,vendor_duration_unit,proof_path,proof_original_name,proof_mime,proof_size,proof_uploaded_by,proof_uploaded_at,source_type,approval_status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual','PENDING_APPROVAL',?)`,[b.transaction_date,formattedName,category.id,b.site_id||null,amount,b.notes||null,purchaseChannel,purchaseChannel?String(b.purchase_shop_name||'').trim()||null:null,vendor.name,vendor.duration,vendor.unit,saved?.filename||null,saved?.originalName||null,saved?.mime||null,saved?.size||null,saved?req.session.user.id:null,saved?new Date():null,req.session.user.id]);const code=await assignCashTransactionCode(conn,r.insertId,category.id,b.transaction_date);await conn.commit();req.session.flash={type:'success',message:`${isExpense?'Pengeluaran':'Pemasukan'} ${code} berhasil diajukan${vendor.isVendor?` untuk vendor ${vendor.name}`:''}${saved?' dengan bukti':''}. Menunggu approval Master Admin dan belum memengaruhi saldo real.`};}catch(e){await conn.rollback();if(saved)await removeCashProof(saved.filename);throw e;}finally{conn.release();}
  res.redirect(`/cash?month=${Number(String(b.transaction_date).slice(5,7))||new Date().getMonth()+1}&year=${Number(String(b.transaction_date).slice(0,4))||new Date().getFullYear()}`);
});

router.post('/cash/:id/update',requireAdmin,async(req,res)=>{
  // v1.24.5 — baris "AUTO BILLING" (source_type='payment') kini boleh diedit sama seperti transaksi
  // manual (belum terhubung payment gateway, jadi bookkeeping kas masih perlu bisa dikoreksi manual).
  // Edit tetap mengembalikan baris ke PENDING_APPROVAL supaya Master Admin meninjau ulang nilainya.
  const b=req.body;const amount=Number(b.amount);if(!Number.isFinite(amount)||amount<=0)throw new Error('Nominal transaksi harus lebih dari 0.');const conn=await db.getConnection();let saved=null,oldProof=null;
  try{await conn.beginTransaction();const [rows]=await conn.execute(`SELECT * FROM cash_transactions WHERE id=? FOR UPDATE`,[req.params.id]);if(!rows.length){req.session.flash={type:'warning',message:'Transaksi kas tidak ditemukan.'};await conn.rollback();return res.redirect(cashReturn(b));}
  // v1.25 audit: "AUTO BILLING" (source_type='payment') rows mirror a real confirmed payment/invoice.
  // The v1.24.5 unlock let these be edited like manual rows, but nothing stopped category/amount from
  // silently drifting away from the payment they represent (e.g. reassigning an income row to an expense
  // category while payments.amount/invoices stay untouched). Cosmetic fields (date/notes/proof/vendor
  // info) stay editable; category and amount are locked to the source payment — use
  // /invoices/:id/reset-unpaid to actually correct those.
  if(rows[0].source_type==='payment'){
    if(Number(b.category_id)!==Number(rows[0].category_id)||Math.abs(amount-Number(rows[0].amount))>0.01){
      await conn.rollback();
      req.session.flash={type:'danger',message:'Baris AUTO BILLING terhubung ke pembayaran & invoice asli — kategori dan nominal tidak boleh diubah dari sini. Gunakan "Reset ke Belum Lunas" di menu Tagihan bila nominal/kategorinya memang salah.'};
      return res.redirect(cashReturn(b));
    }
  }
  const [categoryRows]=await conn.execute(`SELECT id,name,type,code FROM cash_categories WHERE id=? AND is_active=1 LIMIT 1`,[b.category_id]);const category=categoryRows[0];if(!category)throw new Error('Kategori kas tidak ditemukan atau sudah tidak aktif.');const vendor=vendorMeta(category,b),purchaseChannel=category.type==='expense'&&!vendor.isVendor&&['online','offline'].includes(b.purchase_channel)?b.purchase_channel:null;const formattedName=category.type==='expense'?formatCashExpenseName({categoryCode:category.code,categoryName:category.name,rawName:b.name,shopName:b.purchase_shop_name,vendorName:vendor.name}):String(b.name||'').trim();oldProof=rows[0].proof_path;if(req.file)saved=await saveCashProof(req.file);await conn.execute(`UPDATE cash_transactions SET transaction_date=?,name=?,category_id=?,site_id=?,amount=?,notes=?,purchase_channel=?,purchase_shop_name=?,vendor_name=?,vendor_duration=?,vendor_duration_unit=?,proof_path=COALESCE(?,proof_path),proof_original_name=COALESCE(?,proof_original_name),proof_mime=COALESCE(?,proof_mime),proof_size=COALESCE(?,proof_size),proof_uploaded_by=CASE WHEN ? IS NULL THEN proof_uploaded_by ELSE ? END,proof_uploaded_at=CASE WHEN ? IS NULL THEN proof_uploaded_at ELSE NOW() END,approval_status='PENDING_APPROVAL',approval_reason=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?`,[b.transaction_date,formattedName,b.category_id,b.site_id||null,amount,b.notes||null,purchaseChannel,purchaseChannel?String(b.purchase_shop_name||'').trim()||null:null,vendor.name,vendor.duration,vendor.unit,saved?.filename||null,saved?.originalName||null,saved?.mime||null,saved?.size||null,saved?.filename||null,req.session.user.id,saved?.filename||null,req.params.id]);await assignCashTransactionCode(conn,req.params.id,b.category_id,b.transaction_date);await conn.commit();if(saved&&oldProof)await removeCashProof(oldProof);req.session.flash={type:'success',message:'Data kas diperbarui dan dikembalikan ke PENDING_APPROVAL. Saldo real belum berubah sampai disetujui Master Admin.'};}catch(e){await conn.rollback();if(saved)await removeCashProof(saved.filename);throw e;}finally{conn.release();}
  res.redirect(cashReturn(b));
});

router.post('/cash/:id/approve',requireMasterAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  try{await conn.beginTransaction();const tx=await approveCashTransaction(conn,req.params.id,req.session.user.id);await conn.commit();await audit({userId:req.session.user.id,action:'approve',entityType:'cash_transaction',entityId:req.params.id,description:`Approval kas ${tx.transaction_code||tx.id} · ${tx.name}`,ip:req.ip});req.session.flash={type:'success',message:`${tx.transaction_code||'Transaksi kas'} disetujui. Nilainya sekarang masuk saldo dan laporan keuangan real.`};}
  catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Approval kas gagal: ${e.message}`};}finally{conn.release();}
  res.redirect(localReturn(req.body.return_to,cashReturn(req.body)));
});

router.post('/cash/:id/reject',requireMasterAdmin,async(req,res)=>{
  const conn=await db.getConnection();
  try{await conn.beginTransaction();const tx=await rejectCashTransaction(conn,req.params.id,req.session.user.id,req.body.reason);await conn.commit();await audit({userId:req.session.user.id,action:'reject',entityType:'cash_transaction',entityId:req.params.id,description:`Reject kas ${tx.transaction_code||tx.id}: ${tx.approval_reason}`,ip:req.ip});req.session.flash={type:'warning',message:`${tx.transaction_code||'Transaksi kas'} ditolak. Transaksi tidak masuk saldo maupun laporan real.`};}
  catch(e){await conn.rollback();req.session.flash={type:'danger',message:`Reject kas gagal: ${e.message}`};}finally{conn.release();}
  res.redirect(localReturn(req.body.return_to,cashReturn(req.body)));
});

// v1.20: guarded against hard-deleting a transaction that already reached APPROVED — that state is
// "official journal" per the Arsip vs Hapus Permanen rule and has already affected the real cash
// balance elsewhere in the app, so wiping the row would silently desync reports. PENDING_APPROVAL and
// REJECTED rows (never touched real balance) may still be hard-deleted freely.
// v1.24.5 — the source_type='payment' ("AUTO BILLING") exclusion was removed: these rows now follow the
// exact same rule as manual entries (blocked only while APPROVED; Master Admin can still Hapus Paksa).
router.post('/cash/:id/delete',requireAdmin,async(req,res)=>{
  const [rows]=await db.execute(`SELECT proof_path,COALESCE(approval_status,'APPROVED') approval_status FROM cash_transactions WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length){req.session.flash={type:'warning',message:'Transaksi kas tidak ditemukan.'};return res.redirect(cashReturn(req.body));}
  if(rows[0].approval_status==='APPROVED'){req.session.flash={type:'danger',message:'Transaksi ini sudah APPROVED dan menjadi bagian dari jurnal kas resmi, sehingga tidak dapat dihapus permanen. Gunakan Hapus Paksa (Master Admin) bila memang perlu.'};return res.redirect(cashReturn(req.body));}
  const [result]=await db.execute(`DELETE FROM cash_transactions WHERE id=? AND COALESCE(approval_status,'APPROVED')<>'APPROVED'`,[req.params.id]);
  if(result.affectedRows&&rows[0]?.proof_path)await removeCashProof(rows[0].proof_path);
  req.session.flash={type:result.affectedRows?'success':'warning',message:result.affectedRows?'Data kas berhasil dihapus.':'Transaksi tidak dapat dihapus.'};
  res.redirect(cashReturn(req.body));
});

// v1.21.1 — "Hapus Paksa" (Force Delete), Master Admin only. Bypasses ONLY the APPROVED-status guard
// above.
// v1.24.5 — the source_type='payment' ("AUTO BILLING") exclusion was removed: belum terhubung payment
// gateway, jadi baris kas dari pembayaran perlu tetap bisa dikoreksi/dihapus manual oleh Master Admin.
router.post('/cash/:id/force-delete',requireMasterAdmin,async(req,res)=>{
  // Triggered from the generic #forceDeleteModal, whose hidden form only carries the CSRF token — so
  // the return-filter context is passed via the action URL's query string, not body fields.
  const returnCtx=cashReturn({...req.query,...req.body});
  const [rows]=await db.execute(`SELECT proof_path,name,COALESCE(approval_status,'APPROVED') approval_status FROM cash_transactions WHERE id=? LIMIT 1`,[req.params.id]);
  if(!rows.length){req.session.flash={type:'warning',message:'Transaksi kas tidak ditemukan.'};return res.redirect(returnCtx);}
  const tx=rows[0];
  const [result]=await db.execute(`DELETE FROM cash_transactions WHERE id=?`,[req.params.id]);
  if(result.affectedRows&&tx.proof_path)await removeCashProof(tx.proof_path);
  if(result.affectedRows)await audit({userId:req.session.user.id,action:'force_delete',entityType:'cash_transaction',entityId:req.params.id,description:`HAPUS PAKSA transaksi kas ${tx.name} (status sebelumnya: ${tx.approval_status}, Master Admin override).`,ip:req.ip});
  req.session.flash={type:result.affectedRows?'success':'warning',message:result.affectedRows?`Transaksi kas ${tx.name} dihapus paksa permanen.`:'Transaksi tidak dapat dihapus.'};
  res.redirect(returnCtx);
});

// v1.22 — checkbox-based bulk delete for Data Kas, mirroring the same per-row guards used by the
// single-row routes above (never a bulk UPDATE/DELETE, always a per-row loop so the exact same rules
// apply): 'delete' skips APPROVED rows; 'force_delete' (Master Admin only) bypasses the APPROVED guard.
// v1.24.5 — the source_type='payment' ("AUTO BILLING") exclusion was removed from both actions below,
// same reasoning as the single-row routes above.
router.post('/cash/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.cash_ids||[]).map(x=>Number(x)).filter(Boolean))];
  // return context (month/year/site/q) arrives via the bulk button's action URL query string, since
  // the generic bulk-delete JS helper only posts action + id fields.
  const returnCtx=cashReturn({...req.query,...req.body});
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu transaksi kas terlebih dahulu.'};return res.redirect(returnCtx);}
  if(ids.length>500){req.session.flash={type:'danger',message:'Maksimal 500 transaksi per aksi massal.'};return res.redirect(returnCtx);}
  const placeholders=ids.map(()=>'?').join(',');
  if(action==='delete'){
    const [rows]=await db.execute(`SELECT id,name,proof_path,COALESCE(approval_status,'APPROVED') approval_status FROM cash_transactions WHERE id IN (${placeholders})`,ids);
    const eligible=rows.filter(r=>r.approval_status!=='APPROVED');
    const skipped=ids.length-eligible.length;
    if(!eligible.length){req.session.flash={type:'danger',message:'Semua transaksi terpilih sudah APPROVED, sehingga tidak dapat dihapus massal. Gunakan Hapus Paksa Massal (Master Admin).'};return res.redirect(returnCtx);}
    const eligibleIds=eligible.map(r=>r.id);const eligiblePlaceholders=eligibleIds.map(()=>'?').join(',');
    await db.execute(`DELETE FROM cash_transactions WHERE id IN (${eligiblePlaceholders})`,eligibleIds);
    for(const r of eligible)if(r.proof_path)await removeCashProof(r.proof_path);
    await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'cash_transaction',entityId:null,description:`Hapus massal ${eligible.length} transaksi kas: ${eligible.map(r=>r.name).slice(0,20).join(', ')}${eligible.length>20?', ...':''}${skipped?` (${skipped} dilewati karena APPROVED)`:''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${eligible.length} transaksi kas dihapus permanen.${skipped?` ${skipped} transaksi dilewati karena sudah APPROVED.`:''}`};
    return res.redirect(returnCtx);
  }
  if(action==='force_delete'){
    if(!isMasterAdminRole(req.session.user.role)){
      req.session.flash={type:'danger',message:'Hapus Paksa hanya dapat dilakukan oleh Master Admin.'};
      return res.redirect(returnCtx);
    }
    const [rows]=await db.execute(`SELECT id,name,proof_path FROM cash_transactions WHERE id IN (${placeholders})`,ids);
    if(!rows.length){req.session.flash={type:'warning',message:'Transaksi kas tidak ditemukan.'};return res.redirect(returnCtx);}
    const rowIds=rows.map(r=>r.id);const rowPlaceholders=rowIds.map(()=>'?').join(',');
    await db.execute(`DELETE FROM cash_transactions WHERE id IN (${rowPlaceholders})`,rowIds);
    for(const r of rows)if(r.proof_path)await removeCashProof(r.proof_path);
    await audit({userId:req.session.user.id,action:'bulk_force_delete',entityType:'cash_transaction',entityId:null,description:`HAPUS PAKSA massal ${rows.length} transaksi kas (Master Admin override): ${rows.map(r=>r.name).slice(0,20).join(', ')}${rows.length>20?', ...':''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${rows.length} transaksi kas dihapus paksa permanen.`};
    return res.redirect(returnCtx);
  }
  req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};
  res.redirect(returnCtx);
});

router.post('/cash/delete-all',requireAdmin,async(req,res)=>{const now=new Date();const month=intInRange(req.body.month,1,12,now.getMonth()+1),year=intInRange(req.body.year,2020,2100,now.getFullYear()),site=String(req.body.site||'').trim();let where=`MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=? AND (ct.source_type IS NULL OR ct.source_type='manual') AND COALESCE(ct.approval_status,'APPROVED')<>'APPROVED'`;const params=[month,year];if(site){where+=` AND s.code=?`;params.push(site);}const [[skippedRow]]=await db.execute(`SELECT COUNT(*) n FROM cash_transactions ct LEFT JOIN sites s ON s.id=ct.site_id WHERE MONTH(ct.transaction_date)=? AND YEAR(ct.transaction_date)=? AND (ct.source_type IS NULL OR ct.source_type='manual') AND COALESCE(ct.approval_status,'APPROVED')='APPROVED'${site?` AND s.code=?`:''}`,[month,year,...(site?[site]:[])]);const [proofs]=await db.execute(`SELECT ct.proof_path FROM cash_transactions ct LEFT JOIN sites s ON s.id=ct.site_id WHERE ${where}`,params);const [result]=await db.execute(`DELETE ct FROM cash_transactions ct LEFT JOIN sites s ON s.id=ct.site_id WHERE ${where}`,params);for(const p of proofs)if(p.proof_path)await removeCashProof(p.proof_path);const skipped=Number(skippedRow?.n||0);req.session.flash={type:'success',message:`${result.affectedRows} transaksi kas manual periode terpilih dihapus.${skipped?` ${skipped} transaksi APPROVED dilewati karena sudah menjadi jurnal resmi.`:''} Transaksi otomatis pembayaran tetap aman.`};
  // v1.25.5 (susulan #13) — "Hapus Semua" tetap menghapus seluruh transaksi manual non-APPROVED pada
  // periode+site terpilih (TIDAK dipersempit oleh filter Kategori/Tipe, supaya cakupan aksi destruktif
  // ini tidak berubah diam-diam). category/type di sini HANYA dibawa balik ke URL redirect supaya
  // tampilan filter yang sedang dipakai user tetap sama setelah aksi selesai.
  const returnCategory=String(req.body.category||'').trim(),returnType=['income','expense'].includes(req.body.type)?req.body.type:'';
  const returnParams=new URLSearchParams();returnParams.set('month',month);returnParams.set('year',year);if(site)returnParams.set('site',site);if(returnCategory)returnParams.set('category',returnCategory);if(returnType)returnParams.set('type',returnType);
  res.redirect(`/cash?${returnParams.toString()}`);});

module.exports=router;
