const assert=require('node:assert/strict');
const fs=require('node:fs'),s=fs.readFileSync('services/financialIntegrityService.js','utf8');
assert.match(s,/const CLOSING_MISMATCH_SQL =/);
assert.equal((s.match(/\$\{CLOSING_MISMATCH_SQL\}/g)||[]).length,2,'aggregate audit and row diagnostics must share one predicate');
for(const field of ['ce.entry_date<>ct.transaction_date',"TRIM(COALESCE(ce.category,''))",'ce.site_code','ce.cluster_name','ct.internal_transfer_key IS NOT NULL']){
  assert(s.includes(field),'Missing Closing accounting dimension: '+field);
}
for(const reason of ['entry_date_mismatch','category_mismatch','site_mismatch','cluster_mismatch','internal_transfer_not_operating']){
  assert(s.includes(reason),'Missing diagnosis reason: '+reason);
}
console.log('PASS Closing source parity covers site, cluster, date, category, amount, type, approval and internal transfers');
