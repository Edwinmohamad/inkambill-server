require('dotenv').config();
const db=require('../config/db');
const {financialAudit}=require('../services/financialControlService');

(async()=>{
  const conn=await db.getConnection();
  let repaired=0;
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT ce.id,ce.closing_id,ce.cash_transaction_id,ce.entry_type,ce.amount,ce.entry_date,cp.period_start,cp.period_end
      FROM closing_entries ce
      JOIN closing_periods cp ON cp.id=ce.closing_id
      LEFT JOIN cash_transactions ct ON ct.id=ce.cash_transaction_id
      WHERE ce.source_type='cash_sync' AND ce.cash_transaction_id IS NOT NULL
        AND ce.excluded_at IS NULL AND cp.status='DRAFT' AND ct.id IS NULL
      ORDER BY ce.id FOR UPDATE`);
    for(const row of rows){
      const [result]=await conn.execute(`UPDATE closing_entries SET excluded_at=NOW(),excluded_by=NULL
        WHERE id=? AND source_type='cash_sync' AND excluded_at IS NULL`,[row.id]);
      if(!result.affectedRows)continue;
      await financialAudit({
        conn,userId:null,action:'repair_orphan_closing_entry',entityType:'closing_entry',entityId:row.id,
        before:{closing_id:Number(row.closing_id),cash_transaction_id:Number(row.cash_transaction_id),entry_type:row.entry_type,amount:Number(row.amount),entry_date:String(row.entry_date).slice(0,10)},
        after:{excluded:true},
        reason:'Rekonsiliasi otomatis: baris Closing DRAFT merujuk jurnal Data Kas yang sudah tidak ada.',
        ip:null
      });
      repaired++;
    }
    await conn.commit();
    console.log(JSON.stringify({repaired_orphan_draft_closing_entries:repaired}));
  }catch(error){
    await conn.rollback();
    console.error('Repair orphaned Closing entries failed:',error.message);
    process.exitCode=1;
  }finally{
    conn.release();
    await db.end();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
