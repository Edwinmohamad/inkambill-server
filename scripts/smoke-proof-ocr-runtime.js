// Synthetic receipt only; no customer data. Requires the deployment's Tesseract CLI.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {runLocalOcr,parseReceipt,evaluateLocalProof}=require('../services/proofOcrService');
(async()=>{
 const image=fs.readFileSync(path.join(__dirname,'fixtures/transfer-synthetic.png'));
 const banks=[{bank_name:'BCA',account_name:'INKAMNET',account_number:'1234567890'}];
 const result=await runLocalOcr(image,'image/png');
 assert.equal(result.state,'done',result.error);
 const parsed=parseReceipt(result.text,{expectedAmount:150000,banks});
 assert.equal(parsed.amount,150000);assert.equal(parsed.transferAt,'2026-10-24 12:00:00');assert.equal(parsed.recipientAccount,'1234567890');
 const evaluate=(payment,parsedOverride=parsed)=>evaluateLocalProof({payment,parsed:parsedOverride,banks,engineState:result.state});
 const payment={amount:150000,paid_at:'2026-10-24T05:00:00Z'};
 assert.equal(evaluate(payment).overall,'ok');
 assert.equal(evaluate({...payment,amount:175000}).overall,'warning');
 assert.equal(evaluate({...payment,paid_at:'2026-10-25T05:00:00Z'}).overall,'warning');
 assert.equal(evaluate(payment,{...parsed,recipientAccount:'9876543210'}).overall,'warning');
 assert.equal(evaluate(payment,{...parsed,amount:null,recipientAccount:null}).overall,'unreadable');
 assert.equal((await runLocalOcr(Buffer.from('invalid image'),'image/png')).state,'error');
 assert.equal((await runLocalOcr(Buffer.alloc(0),'application/pdf')).state,'skipped');
 console.log('PASS real Tesseract: synthetic PNG, amount/date/account extraction, matching, mismatches, unreadable, corrupt image and PDF fallback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
