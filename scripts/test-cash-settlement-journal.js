const assert=require('assert');
const { postCashTransaction }=require('../services/paymentVerificationService');

function fakeConnection({meta=true,category=true,existing=false}={}){
  const calls=[];
  return {
    calls,
    async execute(sql,params){
      calls.push({sql,params});
      if(sql.includes('FROM invoices i JOIN customers c'))return [meta?[{site_id:7,customer_name:'Pelanggan Uji',invoice_number:'INV-1',is_psb:0}]:[]];
      if(sql.includes('FROM cash_categories')&&sql.includes("type='income'"))return [category?[{id:11}]:[]];
      if(sql.includes("source_type IN ('payment','install_income')"))return [existing?[{id:99}]:[]];
      if(sql.startsWith('INSERT INTO cash_transactions'))return [{insertId:123}];
      if(sql.includes('SELECT code,name,type FROM cash_categories'))return [[{code:'SETOR',name:'Setoran Cash Pelanggan',type:'income'}]];
      if(sql.startsWith('UPDATE cash_transactions SET transaction_code='))return [{affectedRows:1}];
      if(sql.includes('FROM cash_transactions ct')&&sql.includes("cp.status='DRAFT'"))return [[{
        closing_id:44,id:existing?99:123,transaction_date:'2026-10-02',name:'Setoran Cash Pelanggan Uji',amount:150000,notes:'INV-1',
        category_type:'income',category_name:'Setoran Cash Pelanggan',site_code:'CDS'
      }]];
      if(sql.startsWith('INSERT INTO closing_entries'))return [{insertId:456}];
      if(sql.startsWith('UPDATE closing_periods SET last_synced_at='))return [{affectedRows:1}];
      if(sql.startsWith('INSERT INTO financial_audit_logs'))return [{insertId:789}];
      throw new Error(`Query tidak dikenal dalam test: ${sql}`);
    }
  };
}

(async()=>{
  const args={paymentId:5,invoiceId:9,amount:150000,reference:'PAY-5',bookDate:'2026-10-02',categoryName:'Setoran Cash Pelanggan',prefix:'Setoran Cash',actorUserId:1};

  await assert.rejects(()=>postCashTransaction(fakeConnection({meta:false}),args),/faktur\/pelanggan/);
  await assert.rejects(()=>postCashTransaction(fakeConnection({category:false}),args),/Kategori jurnal kas/);

  const conn=fakeConnection();
  const result=await postCashTransaction(conn,args);
  assert.deepStrictEqual(result,{id:123,created:true,closingInserted:1});
  const insert=conn.calls.find(call=>call.sql.startsWith('INSERT INTO cash_transactions'));
  assert(insert,'jurnal cash_transactions wajib dibuat');
  assert(insert.sql.includes("'APPROVED'"),'jurnal setoran wajib langsung APPROVED');
  assert(insert.sql.includes('reviewed_by')&&insert.sql.includes('reviewed_at'),'reviewer jurnal otomatis wajib tercatat');
  assert.strictEqual(insert.params[4],150000,'nominal jurnal harus sama dengan setoran');
  const closingInsert=conn.calls.find(call=>call.sql.startsWith('INSERT INTO closing_entries'));
  assert(closingInsert,'jurnal setoran wajib langsung disinkronkan ke Closing AUTO yang masih DRAFT');
  assert.strictEqual(closingInsert.params[1],'INCOME');
  assert.strictEqual(closingInsert.params[2],'cash_sync');
  assert.strictEqual(closingInsert.params[3],123);
  assert.strictEqual(closingInsert.params[7],150000);
  assert(conn.calls.some(call=>call.sql.startsWith('INSERT INTO financial_audit_logs')),'sinkron Closing wajib masuk audit keuangan');

  const duplicateConn=fakeConnection({existing:true});
  assert.deepStrictEqual(await postCashTransaction(duplicateConn,args),{id:99,created:false,closingInserted:1});
  assert(!duplicateConn.calls.some(call=>call.sql.startsWith('INSERT INTO cash_transactions')),'retry tidak boleh menggandakan saldo');

  console.log('cash-settlement-journal: PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
