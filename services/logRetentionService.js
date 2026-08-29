const db=require('../config/db');

async function purgeOldLogs(retentionDays=7){
  const days=Math.max(1,Math.min(365,Number(retentionDays)||7));
  const [auditResult]=await db.query(`DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ${days} DAY)`);
  const [automationResult]=await db.query(`DELETE FROM automation_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ${days} DAY)`);
  const result={retentionDays:days,auditDeleted:Number(auditResult.affectedRows||0),automationDeleted:Number(automationResult.affectedRows||0)};
  await db.execute(`INSERT INTO automation_logs(job_name,status,message) VALUES('log_retention','success',?)`,[`retention=${days}d, audit=${result.auditDeleted}, automation=${result.automationDeleted}`]);
  return result;
}

module.exports={purgeOldLogs};
