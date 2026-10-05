const money=value=>{const n=Number(value);return Number.isFinite(n)?Math.round(n):0;};
const location=row=>[row.site_code||'GLOBAL',row.cluster_name].filter(Boolean).join(' / ');
const numbered=rows=>rows.map((row,index)=>({...row,row_no:index+1}));
function groupReportRows(type,rows){
  const groups=new Map();
  for(const row of rows){
    const site=location(row),category=type==='cash'?(row.category||'Lain-lain'):type==='customers'?(row.customer_status||'-'):(row.status||'-');
    const flow=type==='cash'?row.type:'';
    const key=JSON.stringify([site,flow,category]);
    if(!groups.has(key))groups.set(key,{site,category,flow,count:0,income:0,expense:0,billed:0,paid:0,outstanding:0});
    const g=groups.get(key);g.count++;
    if(type==='cash'){if(flow==='income')g.income+=money(row.amount);if(flow==='expense')g.expense+=money(row.amount);}
    else if(type!=='customers'){g.billed+=money(row.total);g.paid+=money(row.paid_amount);g.outstanding+=money(row.outstanding);}
  }
  return [...groups.values()].sort((a,b)=>a.site.localeCompare(b.site,'id')||a.flow.localeCompare(b.flow)||a.category.localeCompare(b.category,'id'));
}
function integrityWarnings(type,rows){
  if(type==='customers')return [];
  const bad=rows.filter(r=>type==='cash'? !Number.isFinite(Number(r.amount))||Number(r.amount)<0 : ![r.total,r.paid_amount,r.outstanding].every(v=>Number.isFinite(Number(v)))||money(r.outstanding)!==Math.max(0,money(r.total)-money(r.paid_amount))||[r.total,r.paid_amount,r.outstanding].some(v=>Number(v)<0)||(r.confirmed_payment_amount!==undefined&&money(r.paid_amount)!==money(r.confirmed_payment_amount))||(r.status==='paid'&&money(r.outstanding)>0));
  return bad.length?[`${bad.length} baris memiliki nominal yang perlu direkonsiliasi. Periksa sumber transaksi sebelum memakai laporan untuk closing.`]:[];
}
module.exports={money,location,numbered,groupReportRows,integrityWarnings};
