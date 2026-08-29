const dict={
  id:{dashboard:'Dashboard',customers:'Pelanggan',packages:'Paket Internet',network:'Jaringan',sites:'Site / POP',routers:'Router MikroTik',clusters:'Cluster & ODP',monitor:'MikroTik NMS',support:'Dukungan',tickets:'Ticketing',techSchedule:'Jadwal Teknisi',serverDuty:'Piket Server',warehouse:'Gudang',stock:'Stok Barang',movements:'Pergerakan Stok',material:'Pemakaian Material',supplier:'Supplier',billing:'Tagihan',invoices:'Tagihan',payments:'Pembayaran',customInvoices:'Faktur Kustom',discounts:'Diskon',charges:'Biaya Tambahan',finance:'Keuangan',reconciliation:'Rekonsiliasi',cash:'Arus Kas',cashCategories:'Kategori Kas',cashData:'Data Kas',reports:'Laporan',system:'Sistem',activityLog:'Log Aktivitas',settings:'Pengaturan',profile:'Profil Saya',logout:'Keluar',quickCommand:'Perintah Cepat',signedInAs:'MASUK SEBAGAI',systemLive:'SISTEM AKTIF',language:'Bahasa'},
  en:{dashboard:'Dashboard',customers:'Customers',packages:'Internet Packages',network:'Network',sites:'Sites / POP',routers:'MikroTik Routers',clusters:'Clusters & ODP',monitor:'MikroTik NMS',support:'Support',tickets:'Tickets',techSchedule:'Technician Schedule',serverDuty:'Server Duty',warehouse:'Warehouse',stock:'Inventory',movements:'Stock Movements',material:'Material Usage',supplier:'Suppliers',billing:'Billing',invoices:'Invoices',payments:'Payments',customInvoices:'Custom Invoices',discounts:'Discounts',charges:'Additional Charges',finance:'Finance',reconciliation:'Reconciliation',cash:'Cash Flow',cashCategories:'Cash Categories',cashData:'Cash Data',reports:'Reports',system:'System',activityLog:'Activity Log',settings:'Settings',profile:'My Profile',logout:'Logout',quickCommand:'Quick Command',signedInAs:'SIGNED IN AS',systemLive:'SYSTEM LIVE',language:'Language'}
};
const { isAdminRole, isMasterAdminRole }=require('./auth');
const { getGatewayStatus }=require('../services/whatsappGatewayService');
const statusLabels={
  id:{active:'Aktif',inactive:'Tidak Aktif',suspended:'Ditangguhkan',terminated:'Berhenti',online:'Online',offline:'Offline',isolated:'Terisolir',router_unreachable:'Router Tidak Terjangkau',paid:'Lunas',unpaid:'Belum Lunas',partial:'Bayar Sebagian',overdue:'Terlambat',pending:'Menunggu',confirmed:'Dikonfirmasi',cancelled:'Dibatalkan',refunded:'Dikembalikan',open:'Terbuka',progress:'Diproses',closed:'Selesai',present:'Hadir',absent:'Tidak Hadir',swapped:'Ditukar',scheduled:'Terjadwal',on_the_way:'Dalam Perjalanan',working:'Dikerjakan',done:'Selesai',testing:'Pengujian',maintenance:'Pemeliharaan',draft:'Draf',sent:'Terkirim',success:'Berhasil',failed:'Gagal',settled:'Sudah Disetor',held_by_staff:'Cash di Staf',not_applicable:'Tidak Berlaku',valid:'Valid',invalid:'Tidak Valid',unverified:'Belum Diverifikasi',cash:'Tunai',transfer:'Transfer',qris:'QRIS',gateway:'Gateway',other:'Lainnya',income:'Pemasukan',expense:'Pengeluaran',hour:'Jam',day:'Hari',low:'Rendah',medium:'Sedang',high:'Tinggi',critical:'Kritis',admin:'Admin',master_admin:'Master Admin',staff:'Staf'},
  en:{active:'Active',inactive:'Inactive',suspended:'Suspended',terminated:'Terminated',online:'Online',offline:'Offline',isolated:'Isolated',router_unreachable:'Router Unreachable',paid:'Paid',unpaid:'Unpaid',partial:'Partially Paid',overdue:'Overdue',pending:'Pending',confirmed:'Confirmed',cancelled:'Cancelled',refunded:'Refunded',open:'Open',progress:'In Progress',closed:'Closed',present:'Present',absent:'Absent',swapped:'Swapped',scheduled:'Scheduled',on_the_way:'On the Way',working:'Working',done:'Done',testing:'Testing',maintenance:'Maintenance',draft:'Draft',sent:'Sent',success:'Success',failed:'Failed',settled:'Settled',held_by_staff:'Held by Staff',not_applicable:'Not Applicable',valid:'Valid',invalid:'Invalid',unverified:'Unverified',cash:'Cash',transfer:'Transfer',qris:'QRIS',gateway:'Gateway',other:'Other',income:'Income',expense:'Expense',hour:'Hour',day:'Day',low:'Low',medium:'Medium',high:'High',critical:'Critical',admin:'Admin',master_admin:'Master Admin',staff:'Staff'}
};
function commonLocals(req,res,next){
  const language=req.session?.language==='en'?'en':'id';
  res.locals.appName=process.env.APP_NAME||'INKAMNET Billing';
  const sessionUser=req.session?.user||null;
  res.locals.isAdmin=isAdminRole(sessionUser?.role);
  res.locals.isMasterAdmin=isMasterAdminRole(sessionUser?.role);
  res.locals.actualRole=sessionUser?.role||null;
  res.locals.defaultTheme=req.session?.uiTheme||'dark';
  res.locals.defaultUiPalette=req.session?.uiPalette||'nebula';
  // v1.23 — global flag so any view can offer a real WA Gateway send instead of (or alongside) a
  // manual wa.me deep-link, without every route needing to query gateway state itself.
  res.locals.waGatewayConnected=getGatewayStatus().state==='connected';
  // View lama yang masih membandingkan role dengan "admin" tetap memberi kontrol penuh kepada Master Admin.
  res.locals.user=sessionUser&&res.locals.isMasterAdmin?{...sessionUser,role:'admin'}:sessionUser;
  res.locals.language=language;
  res.locals.t=(key)=>dict[language]?.[key]||dict.id[key]||key;
  res.locals.statusLabel=(value)=>{const key=String(value??'').trim().toLowerCase().replace(/[\s-]+/g,'_');if(!key)return '-';return statusLabels[language]?.[key]||key.split('_').map(word=>word.charAt(0).toUpperCase()+word.slice(1)).join(' ');};
  const titleMap={en:{'Pelanggan':'Customers','Tambah Pelanggan':'Add Customer','Edit Pelanggan':'Edit Customer','Paket Internet':'Internet Packages','Tagihan':'Billing','Pembayaran':'Payments','Laporan':'Reports','Pengaturan':'Settings','Jadwal Teknisi':'Technician Schedule','Jadwal Piket Server':'Server Duty Schedule','Ticketing':'Tickets','Arus Kas':'Cash Flow','Network Monitor':'Network Monitor','Profil Saya':'My Profile'}};
  res.locals.translateTitle=(value)=>language==='en'?(titleMap.en[value]||value):value;
  res.locals.currentPath=req.originalUrl?req.originalUrl.split('?')[0]:req.path||'/';
  res.locals.flash=req.session?.flash||null;
  if(req.session?.flash)delete req.session.flash;
  res.locals.formatRupiah=(value)=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(value||0));
  res.locals.formatDate=(value)=>{if(!value)return '-';return new Intl.DateTimeFormat(language==='en'?'en-GB':'id-ID',{dateStyle:'medium',timeZone:'Asia/Jakarta'}).format(new Date(value));};
  // v1.20.1: use for every `const x = <%- safeJson(data) %>;` inline <script> bootstrap payload.
  // JSON.stringify() never escapes "</script>", so embedding it raw lets any free-text DB field
  // (a cluster/category/customer name, etc.) that happens to contain "</script><script>..." break
  // out of the data literal and execute on every viewer's page. Escaping "<" as < neutralizes
  // that while remaining valid, byte-identical JSON once parsed by the browser.
  res.locals.safeJson=(value)=>JSON.stringify(value).replace(/</g,'\\u003c');
  next();
}
module.exports=commonLocals;
