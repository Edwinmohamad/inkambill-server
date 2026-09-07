const express = require('express');
const db = require('../config/db');
const router = express.Router();

const MONTH_NAMES=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function bounded(v,min,max,fallback){const n=Number(v);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function pct(a,b,neutralWhenZero=false){if(!Number(b||0))return neutralWhenZero?100:0;return Math.max(0,Math.min(100,Math.round(Number(a||0)/Number(b)*100)));}
function weightedScore(items){const active=items.filter(x=>x.available);const weights=active.reduce((a,x)=>a+x.weight,0);if(!weights)return 0;return Math.round(active.reduce((a,x)=>a+x.value*x.weight,0)/weights);}
function scoreRow(row,teamMaxPsb){
  const userRole=String(row.user_role||'staff').toLowerCase(),positionCategory=String(row.position_category||'other');
  const category=userRole==='master_admin'?'management':(positionCategory!=='other'?positionCategory:(userRole==='admin'?'admin':'other'));
  const ticketClose=pct(row.closed_tickets,row.assigned_tickets,false);
  const updateDiscipline=pct(row.ticket_updates,row.assigned_tickets,false);
  const jobDone=pct(row.done_jobs,row.assigned_jobs,false);
  const dutyAttendance=pct(row.present_duties,row.assigned_duties,false);
  const psbActivity=teamMaxPsb>0?Math.min(100,Math.round(Number(row.psb_count||0)/teamMaxPsb*100)):0;
  const paymentActivity=Math.min(100,Math.round(Number(row.payments_recorded||0)/40*100));
  const approvalActivity=Math.min(100,Math.round(Number(row.payments_approved||0)/30*100));
  const cashActivity=Math.min(100,Math.round(Number(row.cash_entries||0)/25*100));
  let score=0,formula='';
  let focusMetrics=[];
  const hasTicket=Number(row.assigned_tickets||0)>0,hasJob=Number(row.assigned_jobs||0)>0,hasDuty=Number(row.assigned_duties||0)>0,hasPsb=teamMaxPsb>0;
  if(category==='technical'){
    score=weightedScore([{value:ticketClose,weight:.35,available:hasTicket},{value:updateDiscipline,weight:.15,available:hasTicket},{value:jobDone,weight:.35,available:hasJob},{value:dutyAttendance,weight:.15,available:hasDuty}]);
    formula='35% tiket selesai · 15% update · 35% job teknisi · 15% piket';focusMetrics=[['Tiket',`${row.closed_tickets}/${row.assigned_tickets}`],['Job',`${row.done_jobs}/${row.assigned_jobs}`],['Piket',`${row.present_duties}/${row.assigned_duties}`]];
  }else if(category==='sales'){
    score=weightedScore([{value:psbActivity,weight:.80,available:hasPsb},{value:ticketClose,weight:.20,available:hasTicket}]);
    formula='80% kontribusi PSB · 20% tindak lanjut tiket pelanggan';focusMetrics=[['PSB',row.psb_count],['Tiket',`${row.closed_tickets}/${row.assigned_tickets}`],['Kontribusi',`${psbActivity}%`]];
  }else if(category==='finance'){
    score=weightedScore([{value:paymentActivity,weight:.40,available:true},{value:approvalActivity,weight:.30,available:true},{value:cashActivity,weight:.20,available:true},{value:ticketClose,weight:.10,available:hasTicket}]);
    formula='40% input pembayaran · 30% approval · 20% jurnal kas · 10% tiket';focusMetrics=[['Pembayaran',row.payments_recorded],['Approval',row.payments_approved],['Kas',row.cash_entries]];
  }else if(category==='admin'){
    score=weightedScore([{value:ticketClose,weight:.30,available:hasTicket},{value:updateDiscipline,weight:.20,available:hasTicket},{value:paymentActivity,weight:.25,available:true},{value:cashActivity,weight:.10,available:true},{value:dutyAttendance,weight:.15,available:hasDuty}]);
    formula='30% tiket · 20% update · 25% input pembayaran · 10% kas · 15% piket';focusMetrics=[['Tiket',`${row.closed_tickets}/${row.assigned_tickets}`],['Pembayaran',row.payments_recorded],['Piket',`${row.present_duties}/${row.assigned_duties}`]];
  }else if(category==='management'){
    score=weightedScore([{value:approvalActivity,weight:.50,available:true},{value:ticketClose,weight:.20,available:hasTicket},{value:cashActivity,weight:.15,available:true},{value:dutyAttendance,weight:.15,available:hasDuty}]);
    formula='50% approval pembayaran · 20% tiket · 15% kontrol kas · 15% piket';focusMetrics=[['Approval',row.payments_approved],['Tiket',`${row.closed_tickets}/${row.assigned_tickets}`],['Kontrol Kas',row.cash_entries]];
  }else{
    score=weightedScore([{value:ticketClose,weight:.35,available:hasTicket},{value:jobDone,weight:.25,available:hasJob},{value:dutyAttendance,weight:.40,available:hasDuty}]);
    formula='35% tiket · 25% pekerjaan · 40% piket';focusMetrics=[['Tiket',`${row.closed_tickets}/${row.assigned_tickets}`],['Job',`${row.done_jobs}/${row.assigned_jobs}`],['Piket',`${row.present_duties}/${row.assigned_duties}`]];
  }
  return {...row,effective_category:category,ticket_close_rate:ticketClose,update_rate:updateDiscipline,job_done_rate:jobDone,duty_rate:dutyAttendance,psb_activity:psbActivity,payment_activity:paymentActivity,approval_activity:approvalActivity,cash_activity:cashActivity,score,formula,focusMetrics};
}

router.get('/', async(req,res)=>{
  const now=new Date();
  const month=bounded(req.query.month,1,12,now.getMonth()+1);
  const year=bounded(req.query.year,2020,2100,now.getFullYear());
  const start=`${year}-${String(month).padStart(2,'0')}-01`;
  const endDate=new Date(year,month,0); const end=`${year}-${String(month).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')}`;
  const [rows]=await db.execute(`
    SELECT e.id,e.employee_code,e.name,e.user_id,u.role user_role,
      COALESCE(p.name,'Belum diatur') position_name,COALESCE(p.category,'other') position_category,
      COALESCE(d.name,'Tanpa departemen') department_name,
      (SELECT COUNT(*) FROM tickets t WHERE t.assigned_employee_id=e.id AND DATE(t.opened_at) BETWEEN ? AND ?) assigned_tickets,
      (SELECT COUNT(*) FROM tickets t WHERE t.assigned_employee_id=e.id AND t.status='closed' AND DATE(COALESCE(t.closed_at,t.updated_at)) BETWEEN ? AND ?) closed_tickets,
      (SELECT COUNT(*) FROM ticket_updates tu JOIN tickets t ON t.id=tu.ticket_id WHERE t.assigned_employee_id=e.id AND tu.progress_date BETWEEN ? AND ?) ticket_updates,
      (SELECT COUNT(*) FROM technician_schedules ts WHERE (ts.technician_employee_id=e.id OR (ts.technician_employee_id IS NULL AND e.user_id IS NOT NULL AND ts.technician_id=e.user_id)) AND ts.schedule_date BETWEEN ? AND ?) assigned_jobs,
      (SELECT COUNT(*) FROM technician_schedules ts WHERE (ts.technician_employee_id=e.id OR (ts.technician_employee_id IS NULL AND e.user_id IS NOT NULL AND ts.technician_id=e.user_id)) AND ts.status='done' AND ts.schedule_date BETWEEN ? AND ?) done_jobs,
      (SELECT COUNT(*) FROM server_duty_schedules sd WHERE sd.duty_date BETWEEN ? AND ? AND ((e.user_id IS NOT NULL AND sd.user_id=e.user_id) OR LOWER(TRIM(sd.staff_name))=LOWER(TRIM(e.name)))) assigned_duties,
      (SELECT COUNT(*) FROM server_duty_schedules sd WHERE sd.duty_date BETWEEN ? AND ? AND sd.status='present' AND ((e.user_id IS NOT NULL AND sd.user_id=e.user_id) OR LOWER(TRIM(sd.staff_name))=LOWER(TRIM(e.name)))) present_duties,
      (SELECT COUNT(*) FROM customers c WHERE c.sales_id=e.id AND c.archived_at IS NULL AND c.customer_source='new_install' AND c.activation_date BETWEEN ? AND ?) psb_count
      ,(SELECT COUNT(*) FROM payments pay WHERE e.user_id IS NOT NULL AND pay.received_by=e.user_id AND DATE(pay.paid_at) BETWEEN ? AND ?) payments_recorded
      ,(SELECT COUNT(*) FROM payments pay WHERE e.user_id IS NOT NULL AND pay.verified_by=e.user_id AND DATE(pay.verified_at) BETWEEN ? AND ?) payments_approved
      ,(SELECT COUNT(*) FROM cash_transactions ct WHERE e.user_id IS NOT NULL AND ct.created_by=e.user_id AND ct.transaction_date BETWEEN ? AND ?) cash_entries
    FROM employees e
    LEFT JOIN users u ON u.id=e.user_id
    LEFT JOIN positions p ON p.id=e.position_id
    LEFT JOIN departments d ON d.id=e.department_id
    WHERE e.is_active=1
    ORDER BY FIELD(COALESCE(p.category,'other'),'technical','admin','finance','sales','management','other'),e.name
  `,[start,end,start,end,start,end,start,end,start,end,start,end,start,end,start,end,start,end,start,end,start,end]);
  const maxPsb=Math.max(0,...rows.map(r=>Number(r.psb_count||0)));
  const team=rows.map(r=>scoreRow(r,maxPsb)).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  const summary={
    people:team.length,
    avgScore:team.length?Math.round(team.reduce((a,x)=>a+x.score,0)/team.length):0,
    closed:team.reduce((a,x)=>a+Number(x.closed_tickets||0),0),
    dutyPresent:team.reduce((a,x)=>a+Number(x.present_duties||0),0),
    psb:team.reduce((a,x)=>a+Number(x.psb_count||0),0),
    jobsDone:team.reduce((a,x)=>a+Number(x.done_jobs||0),0)
  };
  res.render('team-kpi/index',{title:'KPI Tim',team,summary,month,year,monthNames:MONTH_NAMES,start,end});
});

module.exports=router;
