const fs=require('node:fs'),assert=require('node:assert/strict'),ejs=require('ejs');
const template=ejs.compile(fs.readFileSync('views/finance/cash.ejs','utf8'));
const base={isAdmin:true,isMasterAdmin:true,sites:[],categories:[],summary:{},collection:{},approvalSummary:{},cashCharts:{},mandatoryChecklist:[],createdId:0,createdTransaction:null,filters:{month:10,year:2026,site:'',q:'',category:'',type:'',method:''},csrfToken:'test',formatRupiah:String,formatDate:String,safeJson:JSON.stringify,isVendorCashCategory:()=>false};
const tx={id:1,transaction_date:'2026-10-18',source_type:'manual',approval_status:'APPROVED',amount:10,display_name:'Test',name:'Test',category_type:'expense'};
for(const [extra,editable] of [[{},true],[{source_type:'payment',source_invoice_id:8},false],[{internal_transfer_key:'PAIR'},false],[{warehouse_purchase_id:4},false],[{warehouse_transfer_id:5},false]]){
 const html=template({...base,transactions:[{...tx,...extra}]});
 assert(html.includes('Lihat Detail'));
 assert.equal(html.includes('data-bs-target="#cashEditModal"'),editable);
 assert.equal(html.includes('data-force-delete="/cash/1/force-delete'),editable);
 assert.equal(html.includes('data-row-check value="1"'),editable);
}
console.log('Cash view: manual/payment/warehouse/paired-transfer action policy PASS');
