const SCHEMA_COMPATIBILITY_CODES = new Set([
  'ER_BAD_FIELD_ERROR',
  'ER_NO_SUCH_TABLE',
  'ER_BAD_TABLE_ERROR'
]);

function isSchemaCompatibilityError(error) {
  return SCHEMA_COMPATIBILITY_CODES.has(error?.code) || [1051, 1054, 1146].includes(Number(error?.errno));
}

async function loadCashApprovals(db, logger = console) {
  try {
    const [rows] = await db.query(`SELECT ct.id,ct.transaction_code,ct.transaction_date,ct.name,ct.amount,ct.notes,ct.proof_path,ct.proof_mime,COALESCE(ct.approval_status,'PENDING_APPROVAL') approval_status,cc.name category_name,cc.type category_type,s.code site_code,u.name creator_name FROM cash_transactions ct JOIN cash_categories cc ON cc.id=ct.category_id LEFT JOIN sites s ON s.id=ct.site_id LEFT JOIN users u ON u.id=ct.created_by WHERE ct.approval_status='PENDING_APPROVAL' OR (ct.approval_status IS NULL AND COALESCE(ct.source_type,'manual')='manual') ORDER BY ct.transaction_date DESC,ct.id DESC LIMIT 250`);
    return { rows, unavailable: false };
  } catch (error) {
    // Approval pembayaran adalah fungsi utama halaman. Antrean kas manual adalah
    // pelengkap dari migrasi yang lebih baru, sehingga skema lama tidak boleh
    // membuat seluruh menu /payments menjadi HTTP 500.
    if (!isSchemaCompatibilityError(error)) throw error;
    logger.warn('Antrean approval kas belum tersedia; migrasi skema kas perlu dijalankan:', error.message);
    return { rows: [], unavailable: true };
  }
}

module.exports = { loadCashApprovals, isSchemaCompatibilityError };
