const express=require('express');
const path=require('path');
const db=require('../config/db');
const { audit }=require('../services/auditService');
const { requireAdmin }=require('../middleware/auth');
const { savePhoto,removePhoto,sendPhoto }=require('../services/photoAttachmentService');
const router=express.Router();
const TICKET_DIR=path.join(__dirname,'..','storage','ticket-attachments');
function ticketCode(){const d=new Date();const p=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('');return `TT-${p}-${String(Date.now()).slice(-6)}`;}
async function technicalEmployees(){const [rows]=await db.query(`SELECT e.id,e.employee_code,e.name,e.user_id,p.name position_name,p.category FROM employees e LEFT JOIN positions p ON p.id=e.position_id WHERE e.is_active=1 AND (p.category IN ('technical','admin','management') OR p.category IS NULL) ORDER BY FIELD(p.category,'technical','admin','management'),e.name`);return rows;}

router.get('/',async(req,res)=>{
  const status=req.query.status||'',priority=req.query.priority||'',site=String(req.query.site||'').trim(),cluster=String(req.query.cluster||'').trim(),q=String(req.query.q||'').trim();
  let sql=`SELECT t.*,c.customer_code,c.name customer_name,s.code site_code,cl.name cluster_name,COALESCE(e.name,u.name) assigned_name,COALESCE(e.employee_code,'') assigned_code,(SELECT tu.progress_percent FROM ticket_updates tu WHERE tu.ticket_id=t.id ORDER BY tu.progress_date DESC,tu.id DESC LIMIT 1) progress_percent,(SELECT tu.progress_date FROM ticket_updates tu WHERE tu.ticket_id=t.id ORDER BY tu.progress_date DESC,tu.id DESC LIMIT 1) last_progress_date,(SELECT COUNT(*) FROM ticket_updates tu WHERE tu.ticket_id=t.id AND tu.attachment_path IS NOT NULL) update_attachment_count FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN employees e ON e.id=t.assigned_employee_id LEFT JOIN users u ON u.id=t.assigned_to WHERE 1=1`;
  const params=[];if(site){sql+=` AND s.code=?`;params.push(site);}if(cluster){sql+=` AND c.cluster_id=?`;params.push(Number(cluster));}if(status==='active'){sql+=` AND t.status IN ('open','progress','pending')`;}else if(status){sql+=` AND t.status=?`;params.push(status);}if(priority){sql+=` AND t.priority=?`;params.push(priority);}if(q){const like=`%${q}%`;sql+=` AND (t.ticket_code LIKE ? OR t.subject LIKE ? OR c.name LIKE ? OR c.customer_code LIKE ? OR s.code LIKE ? OR cl.name LIKE ? OR COALESCE(e.name,u.name) LIKE ?)`;params.push(like,like,like,like,like,like,like);}sql+=` ORDER BY FIELD(t.status,'open','progress','pending','closed'), FIELD(t.priority,'critical','high','medium','low'), t.id DESC`;
  const [tickets]=await db.execute(sql,params);const [sites]=await db.query(`SELECT code,name FROM sites WHERE is_active=1 ORDER BY code`);const [clusters]=await db.query(`SELECT cl.id,cl.name,s.code site_code FROM clusters cl JOIN sites s ON s.id=cl.site_id WHERE cl.status!='inactive' ORDER BY s.code,cl.name`);const [customers]=await db.query(`SELECT c.id,c.customer_code,c.name,s.code site_code,cl.name cluster_name FROM customers c JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id WHERE c.customer_status!='terminated' ORDER BY s.code,cl.name,c.name`);const employees=await technicalEmployees();let statsSql=`SELECT SUM(t.status='open') open_count,SUM(t.status='progress') progress_count,SUM(t.status='pending') pending_count,SUM(t.status='closed') closed_count FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id WHERE 1=1`;const statsParams=[];if(site){statsSql+=` AND s.code=?`;statsParams.push(site);}if(cluster){statsSql+=` AND c.cluster_id=?`;statsParams.push(Number(cluster));}const [[stats]]=await db.execute(statsSql,statsParams);
  res.render('tickets/index',{title:'Ticketing',tickets,customers,employees,sites,clusters,stats:stats||{},filters:{status,priority,site,cluster,q}});
});

router.post('/',async(req,res)=>{
  const b=req.body,code=ticketCode();let employee=null,saved=null;
  if(b.assigned_employee_id){const [x]=await db.execute(`SELECT id,user_id FROM employees WHERE id=? AND is_active=1 LIMIT 1`,[b.assigned_employee_id]);employee=x[0]||null;}
  try{
    if(req.file)saved=await savePhoto(req.file,TICKET_DIR,'ticket');
    const [r]=await db.execute(`INSERT INTO tickets(ticket_code,customer_id,subject,type,priority,status,description,attachment_path,attachment_original_name,attachment_mime,attachment_size,assigned_to,assigned_employee_id,opened_by,opened_at) VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?,?,NOW())`,[code,b.customer_id||null,b.subject,b.type||'Gangguan Internet',b.priority||'medium',b.description||null,saved?.filename||null,saved?.originalName||null,saved?.mime||null,saved?.size||null,employee?.user_id||null,employee?.id||null,req.session.user.id]);
    await audit({userId:req.session.user.id,action:'create',entityType:'ticket',entityId:r.insertId,description:`Buat tiket ${code}${saved?' dengan lampiran':''}`,ip:req.ip});req.session.flash={type:'success',message:`Tiket ${code} berhasil dibuat${saved?' dengan lampiran foto':''}.`};return res.redirect(`/tickets/${r.insertId}`);
  }catch(e){if(saved)await removePhoto(TICKET_DIR,saved.filename);throw e;}
});
// v1.25 audit: subject/type/priority/description entered at ticket creation had no way to be corrected
// afterward — only status, PIC assignment, and append-only progress updates were editable. Note: this is
// deliberately separate from /:id/updates (the progress log below), which stays append-only as the
// ticket's audit trail; this route only touches the ticket's own descriptive fields.
router.post('/:id/edit',async(req,res)=>{
  const b=req.body;
  const [[ticket]]=await db.execute(`SELECT id,ticket_code FROM tickets WHERE id=? LIMIT 1`,[req.params.id]);
  if(!ticket){req.session.flash={type:'warning',message:'Tiket tidak ditemukan.'};return res.redirect('/tickets');}
  const subject=String(b.subject||'').trim();
  if(!subject){req.session.flash={type:'danger',message:'Subjek tiket wajib diisi.'};return res.redirect(`/tickets/${req.params.id}`);}
  const allowedPriority=new Set(['low','medium','high','critical']);
  await db.execute(`UPDATE tickets SET subject=?,type=?,priority=?,description=? WHERE id=?`,
    [subject,b.type||'Gangguan Internet',allowedPriority.has(b.priority)?b.priority:'medium',b.description||null,req.params.id]);
  await audit({userId:req.session.user.id,action:'update',entityType:'ticket',entityId:req.params.id,description:`Edit detail tiket ${ticket.ticket_code}`,ip:req.ip});
  req.session.flash={type:'success',message:'Detail tiket berhasil diperbarui.'};
  res.redirect(`/tickets/${req.params.id}`);
});
router.post('/:id/status',async(req,res)=>{const status=req.body.status;await db.execute(`UPDATE tickets SET status=?,closed_at=IF(?='closed',NOW(),NULL) WHERE id=?`,[status,status,req.params.id]);req.session.flash={type:'success',message:'Status tiket diperbarui.'};res.redirect(req.body.return_to||'/tickets');});
router.post('/:id/assign',async(req,res)=>{let employee=null;if(req.body.assigned_employee_id){const [x]=await db.execute(`SELECT id,user_id FROM employees WHERE id=? AND is_active=1 LIMIT 1`,[req.body.assigned_employee_id]);employee=x[0]||null;}await db.execute(`UPDATE tickets SET assigned_employee_id=?,assigned_to=? WHERE id=?`,[employee?.id||null,employee?.user_id||null,req.params.id]);req.session.flash={type:'success',message:'PIC tiket diperbarui.'};res.redirect(`/tickets/${req.params.id}`);});
router.post('/:id/updates',async(req,res)=>{
  const percent=Math.max(0,Math.min(100,Number(req.body.progress_percent||0)));const allowed=new Set(['open','progress','pending','closed']);const status=allowed.has(req.body.status)?req.body.status:'progress';const note=String(req.body.note||'').trim();if(!note){req.session.flash={type:'danger',message:'Catatan progress wajib diisi.'};return res.redirect(`/tickets/${req.params.id}`);}let saved=null;
  try{
    if(req.file)saved=await savePhoto(req.file,TICKET_DIR,'progress');
    await db.execute(`INSERT INTO ticket_updates(ticket_id,progress_date,progress_percent,status,note,attachment_path,attachment_original_name,attachment_mime,attachment_size,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,[req.params.id,req.body.progress_date||new Date().toISOString().slice(0,10),percent,status,note,saved?.filename||null,saved?.originalName||null,saved?.mime||null,saved?.size||null,req.session.user.id]);
    await db.execute(`UPDATE tickets SET status=?,closed_at=IF(?='closed',COALESCE(closed_at,NOW()),NULL) WHERE id=?`,[status,status,req.params.id]);await audit({userId:req.session.user.id,action:'progress',entityType:'ticket',entityId:req.params.id,description:`Progress ${percent}% - ${status}${saved?' + foto':''}`,ip:req.ip});req.session.flash={type:'success',message:`Progress harian tiket tersimpan${saved?' dengan lampiran foto':''}.`};res.redirect(`/tickets/${req.params.id}`);
  }catch(e){if(saved)await removePhoto(TICKET_DIR,saved.filename);throw e;}
});
router.get('/:id/attachment',async(req,res)=>{const [rows]=await db.execute(`SELECT attachment_path,attachment_original_name,attachment_mime FROM tickets WHERE id=? LIMIT 1`,[req.params.id]);return sendPhoto(res,TICKET_DIR,rows[0]);});

// v1.21.0 — Section 4 (global delete-button audit): Tiket Gangguan previously had NO delete route at all.
// `ticket_updates` has an ON DELETE CASCADE FK to tickets.id (see services/schemaService.js), so the DB
// rows clean themselves up automatically — but the attachment FILES on disk do not, so every attachment
// (the ticket's own + every progress update's) must be removed via removePhoto() before/around the SQL
// delete, otherwise storage/ticket-attachments accumulates orphaned files forever.
async function deleteTicketWithAttachments(ticketId){
  const [[ticket]]=await db.execute(`SELECT id,ticket_code,attachment_path FROM tickets WHERE id=? LIMIT 1`,[ticketId]);
  if(!ticket)return null;
  const [updates]=await db.execute(`SELECT attachment_path FROM ticket_updates WHERE ticket_id=? AND attachment_path IS NOT NULL`,[ticketId]);
  if(ticket.attachment_path)await removePhoto(TICKET_DIR,ticket.attachment_path).catch(()=>{});
  for(const u of updates){if(u.attachment_path)await removePhoto(TICKET_DIR,u.attachment_path).catch(()=>{});}
  await db.execute(`DELETE FROM tickets WHERE id=?`,[ticket.id]);
  return ticket;
}
router.post('/:id/delete',requireAdmin,async(req,res)=>{
  const ticket=await deleteTicketWithAttachments(req.params.id);
  if(!ticket){req.session.flash={type:'warning',message:'Tiket tidak ditemukan.'};return res.redirect('/tickets');}
  await audit({userId:req.session.user.id,action:'delete',entityType:'ticket',entityId:ticket.id,description:`Hapus tiket ${ticket.ticket_code}`,ip:req.ip});
  req.session.flash={type:'success',message:`Tiket ${ticket.ticket_code} dihapus permanen beserta seluruh lampirannya.`};
  res.redirect('/tickets');
});
router.post('/bulk',requireAdmin,async(req,res)=>{
  const action=String(req.body.action||'').trim();
  const ids=[...new Set([].concat(req.body.ticket_ids||[]).map(x=>Number(x)).filter(Boolean))];
  if(!ids.length){req.session.flash={type:'warning',message:'Pilih minimal satu tiket terlebih dahulu.'};return res.redirect('/tickets');}
  if(ids.length>500){req.session.flash={type:'danger',message:'Maksimal 500 tiket per aksi massal.'};return res.redirect('/tickets');}
  if(action==='delete'){
    const deleted=[];
    for(const id of ids){const ticket=await deleteTicketWithAttachments(id);if(ticket)deleted.push(ticket);}
    if(!deleted.length){req.session.flash={type:'warning',message:'Tiket terpilih tidak ditemukan.'};return res.redirect('/tickets');}
    await audit({userId:req.session.user.id,action:'bulk_delete',entityType:'ticket',entityId:null,description:`Hapus massal ${deleted.length} tiket: ${deleted.map(r=>r.ticket_code).slice(0,20).join(', ')}${deleted.length>20?', ...':''}`,ip:req.ip});
    req.session.flash={type:'success',message:`${deleted.length} tiket dihapus permanen beserta seluruh lampirannya.`};
    return res.redirect('/tickets');
  }
  req.session.flash={type:'danger',message:'Aksi massal tidak dikenali.'};
  res.redirect('/tickets');
});
router.get('/:id/updates/:updateId/attachment',async(req,res)=>{const [rows]=await db.execute(`SELECT attachment_path,attachment_original_name,attachment_mime FROM ticket_updates WHERE id=? AND ticket_id=? LIMIT 1`,[req.params.updateId,req.params.id]);return sendPhoto(res,TICKET_DIR,rows[0]);});
router.get('/:id',async(req,res)=>{const [rows]=await db.execute(`SELECT t.*,c.customer_code,c.name customer_name,c.phone,c.address,s.code site_code,cl.name cluster_name,COALESCE(e.name,u.name) assigned_name,e.employee_code assigned_code,p.name assigned_position,op.name opened_by_name FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN sites s ON s.id=c.site_id LEFT JOIN clusters cl ON cl.id=c.cluster_id LEFT JOIN employees e ON e.id=t.assigned_employee_id LEFT JOIN positions p ON p.id=e.position_id LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN users op ON op.id=t.opened_by WHERE t.id=? LIMIT 1`,[req.params.id]);if(!rows.length)return res.status(404).send('Ticket tidak ditemukan.');const [updates]=await db.execute(`SELECT tu.*,u.name updated_by_name FROM ticket_updates tu LEFT JOIN users u ON u.id=tu.updated_by WHERE tu.ticket_id=? ORDER BY tu.progress_date DESC,tu.id DESC`,[req.params.id]);const employees=await technicalEmployees();res.render('tickets/detail',{title:rows[0].ticket_code,ticket:rows[0],updates,employees});});
module.exports=router;
