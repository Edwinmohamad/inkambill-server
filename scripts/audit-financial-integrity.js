require('dotenv').config();
const db = require('../config/db');
const { auditFinancialIntegrity } = require('../services/financialIntegrityService');

(async () => {
  try {
    const result = await auditFinancialIntegrity();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.anomalyCount > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Audit integritas keuangan gagal: ${error.message}`);
    process.exitCode = 2;
  } finally {
    await db.end();
  }
})();
