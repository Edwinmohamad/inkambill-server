const db=require('../config/db');
(async()=>{const conn=await db.getConnection();try{await conn.beginTransaction();
 const [dups]=await conn.query(`SELECT source_id payment_id,GROUP_CONCAT(id ORDER BY id) ids FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE ct.source_id IS NOT NULL AND ct.source_type IN ('payment','install_income') AND cc.type='income' GROUP BY source_id HAVING COUNT(*)>1`);
 let removed=0,converted=0;
 for(const d of dups){const [rows]=await conn.execute(`SELECT ct.id,ct.source_type,cc.code FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id WHERE ct.source_id=? AND ct.source_type IN ('payment','install_income') ORDER BY (cc.code='PSB-IN') DESC,ct.id`,[d.payment_id]);const keep=rows[0];for(const r of rows.slice(1)){await conn.execute(`DELETE FROM cash_transactions WHERE id=?`,[r.id]);removed++;}if(keep.source_type==='install_income'){await conn.execute(`UPDATE cash_transactions SET source_type='payment' WHERE id=?`,[keep.id]);converted++;}}
 await conn.execute(`UPDATE cash_transactions SET source_type='payment_commission_technician' WHERE source_type='install_commission_technician'`);
 await conn.execute(`UPDATE cash_transactions SET source_type='payment_commission_sales' WHERE source_type='install_commission_sales'`);
 await conn.commit();console.log({duplicateGroups:dups.length,removed,converted});
 }catch(e){await conn.rollback();throw e;}finally{conn.release();await db.end();}})().catch(e=>{console.error(e);process.exit(1)});
