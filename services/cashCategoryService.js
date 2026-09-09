function isVendorCashCategory(category){
  const code=String(category?.code||'').trim().toUpperCase();
  const name=String(category?.name||'').trim();
  return /(?:^|\W)vendor(?:\W|$)/i.test(name)||/^VENDOR[A-Z0-9]*$/.test(code)||/^VDR[A-Z0-9]*$/.test(code);
}
module.exports={isVendorCashCategory};
