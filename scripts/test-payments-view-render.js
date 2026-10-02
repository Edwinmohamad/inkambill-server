// Regresi: halaman Approval & Transaksi harus bisa dirender saat ada baris pembayaran.
// Bug sebelumnya: views/payments/index.ejs memakai `monthNames` (tidak terdefinisi) -> ReferenceError -> halaman gagal dibuka.
const ejs=require('ejs'),path=require('path'),assert=require('assert/strict');
const common=require('../middleware/common');
const root=path.resolve(__dirname,'..');
const pay={id:1,status:'pending',method:'transfer',amount:100000,paid_at:new Date(),reference:null,invoice_number:'INV1',customer_code:'C1',customer_name:'Budi',site_code:'CDS',cluster_name:null,collector_name:null,verifier_name:null,proof_path:null,bank_name:null,settlement_status:null,invoice_id:1,period_month:1,period_year:2026,due_date:null,notes:null,created_at:new Date()};
const cash={id:7,transaction_code:'K1',transaction_date:new Date(),name:'n',amount:1000,notes:null,proof_path:null,proof_mime:null,approval_status:'PENDING_APPROVAL',category_name:'c',category_type:'expense',site_code:null,creator_name:null};
function render(role,over){
  const res={locals:{}};
  common({session:{user:{id:1,role,name:'T'}},query:{},originalUrl:'/payments',path:'/payments',get:()=>''},res,()=>{});
  const data={title:'t',payments:[],openInvoices:[],staff:[],banks:[],sites:[],clusters:[],cashApprovals:[],cashApprovalUnavailable:false,summary:{},missingProof:{total:0,amount:0},paymentPageWarnings:[],preselectedInvoiceId:null,filters:{q:'',site:'',cluster:'',month:'',year:'',approval:'',method:'',recipient:''},methodCounts:{cash:{total:0,pending:0},transfer:{total:0,pending:0},qris:{total:0,pending:0}},summaryMonth:1,summaryYear:2026,pagination:null,csrfToken:'x',flash:null,...res.locals,...over};
  return ejs.renderFile(path.join(root,'views/payments/index.ejs'),data,{views:[path.join(root,'views')]});
}
(async()=>{
  for(const role of ['master_admin','admin']){
    for(const status of ['pending','confirmed','failed'])for(const method of ['cash','transfer','qris'])
      assert.ok((await render(role,{payments:[{...pay,status,method}],cashApprovals:[cash]})).length>1000,`${role}/${status}/${method}`);
  }
  assert.ok((await render('master_admin',{cashApprovalUnavailable:true,paymentPageWarnings:['x']})).length>1000);
  console.log('payments view render OK');
})().catch(e=>{console.error(e);process.exit(1);});
