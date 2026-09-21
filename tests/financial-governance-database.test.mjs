import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {setup as trainingSetup,seedEnrollment,call,login,id,T,OTHER,ADMIN,ADMIN_AUTH,INSTRUCTOR,INSTRUCTOR_AUTH,STAFF,CONTACT,COURSE,RUN,HANDOFF,ACCOUNT,INVOICE,PAYMENT,ENROLLMENT} from './fixtures/training-journey-database.mjs';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
let sequence=900;
const action=(db,kind,payload={})=>call(db,'public.v1_tenant_accounting_action',{p_slug:'marktone',p_action:kind,p_payload:{commandId:id(sequence++),...payload}});
const net=db=>call(db,'private_app.accounting_invoice_net_v1',{p_tenant_id:T,p_invoice_id:INVOICE});

async function setup(){
 const db=await trainingSetup();
 try{
  const incentives=await read('../supabase/migrations/20260729213000_goals_incentives_v2.sql');
  await db.exec(incentives.slice(0,incentives.indexOf('create or replace function private_app.incentive_role_keys')));
  await db.exec(await read('./fixtures/financial-governance-live-functions.sql'));
  // The campaign-origin implementation is exercised against its complete real
  // schema by opportunity-collections-database.test.mjs, outside this fixture.
  await db.exec("create function private_app.campaign_cash_origin_v1(uuid,uuid,uuid) returns text language sql as $$select null::text$$");
  // Exact production accounting RPC already exists in training live fixture.
  await db.exec(await read('../supabase/migrations/20260921125610_financial_governance_v1.sql'));
  for(const permission of ['tenant.accounting.customers.write','tenant.accounting.payments.record','tenant.accounting.refunds.request','tenant.accounting.settings.manage','tenant.accounting.incentives.approve']){
   await db.query('insert into access_control.permissions(permission_key,module_key,name_ar) values($1,\'accounting\',$1) on conflict do nothing',[permission]);
   await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing',[id(21),permission]);
  }
  return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
async function payment(db,amount=10000){
 return action(db,'record_payment',{customerAccountId:ACCOUNT,amountMinor:amount,currency:'SAR',method:'cash',receivedAt:'2026-09-01T12:00:00Z',externalReference:'fixture-payment',verifyNow:true});
}
async function reviewer(db){
 for(const permission of ['tenant.accounting.read','tenant.accounting.refunds.approve'])await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing',[id(22),permission]);
 await login(db,INSTRUCTOR_AUTH);
}
async function creditNote(db,amount=2000){
 await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,parent_document_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'credit_note','CN-FIXTURE','issued',$3,$4,'Fixture', $5,$5,'SAR')",[id(700),T,ACCOUNT,INVOICE,amount]);
 return id(700);
}

test('finance money history, idempotency and tenancy enforce real RPC boundaries',async t=>{
 const db=await setup();t.after(()=>db.close());
 const p=await payment(db);
 await t.test('confirmed source values and verification date are immutable',async()=>{
  for(const patch of ["amount_minor=20000","received_at=now()","verified_at=now()","currency='USD'","status='rejected'"])
   await assert.rejects(db.query(`update accounting_core.payments set ${patch} where id=$1`,[p.paymentId]),/verified_payment_immutable/);
  const before=(await db.query('select verified_at from accounting_core.payments where id=$1',[p.paymentId])).rows[0].verified_at;
  assert.equal((await action(db,'verify_payment',{paymentId:p.paymentId})).replayed,true);
  assert.deepEqual((await db.query('select verified_at from accounting_core.payments where id=$1',[p.paymentId])).rows[0].verified_at,before);
 });
 await t.test('one command produces exactly one payment on retries and rejects changed payload',async()=>{
  const payload={commandId:id(990),customerAccountId:ACCOUNT,amountMinor:100,currency:'SAR',method:'cash'};
  const a=await action(db,'record_payment',payload);const b=await action(db,'record_payment',payload);assert.equal(a.paymentId,b.paymentId);
  await assert.rejects(action(db,'record_payment',{...payload,amountMinor:101}),/command_id_reused_with_different_payload/);
  await login(db,INSTRUCTOR_AUTH);await assert.rejects(action(db,'record_payment',payload),/forbidden/);await login(db);
 });
 await t.test('evidence and source functions cannot be called directly by API roles',async()=>{
  await db.exec('set role authenticated');await assert.rejects(db.query('select * from accounting_core.payment_evidence_events'),/permission denied/);
  await assert.rejects(call(db,'private_app.import_verified_handoff_v1',{p_tenant:T,p_handoff:HANDOFF}),/permission denied/);await db.exec('reset role');
  assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_accounting_action(text,text,jsonb)','execute') ok")).rows[0].ok,false);
 });
 await t.test('new payments cannot introduce a second currency',async()=>{
  await assert.rejects(action(db,'record_payment',{customerAccountId:ACCOUNT,amountMinor:100,currency:'USD'}),/tenant_currency_mismatch/);
 });
 await t.test('activation requires explicit preview confirmation, including missing-value cases',async()=>{
  for(const payload of [{enabled:true},{confirmation:'ENABLE_FINANCIAL_GOVERNANCE'},{}])await assert.rejects(action(db,'set_governance',payload),/governance_confirmation_required/);
 });
});

test('verified admission imports original evidence once without historical data backfill',async t=>{
 const db=await setup();t.after(()=>db.close());
 assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,0);
 await db.query("update academy.registration_handoffs set payment_status='verified',paid_at='2026-08-01T10:00Z',payment_verified_at='2026-08-02T11:00Z',payment_verified_by_subject_id=$1,payment_reference='original-reference',metadata='{\"currency\":\"SAR\",\"paymentMethod\":\"cash\"}' where id=$2",[ADMIN,HANDOFF]);
 await action(db,'set_governance',{enabled:true,confirmation:'ENABLE_FINANCIAL_GOVERNANCE'});
 assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,0);
 const a=await action(db,'import_handoff_payment',{handoffId:HANDOFF});const b=await action(db,'import_handoff_payment',{handoffId:HANDOFF});assert.equal(a.paymentId,b.paymentId);
 const p=(await db.query('select * from accounting_core.payments where id=$1',[a.paymentId])).rows[0];
 assert.equal(p.method,'cash');assert.equal(p.external_reference,'original-reference');assert.equal(new Date(p.received_at).toISOString(),'2026-08-01T10:00:00.000Z');
 assert.equal(new Date(p.verified_at).toISOString(),'2026-08-02T11:00:00.000Z');
 assert.equal(Number((await db.query('select * from private_app.campaign_cash_v1($1)',[T])).rows[0].amount_minor),10000);
 await assert.rejects(call(db,'public.v2_tenant_update_admission',{p_tenant_slug:'marktone',p_handoff_id:HANDOFF,p_action:'reject_payment',p_reason:'fixture correction'}),/verified_payment_requires_adjustment/);
});

test('admissions-only staff receive payment status without financial details or approval ability',async t=>{
 const db=await setup();t.after(()=>db.close());
 for(const permission of ['tenant.admissions.read','tenant.admissions.write'])await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2)',[id(22),permission]);
 await login(db,INSTRUCTOR_AUTH);
 const snapshot=await call(db,'public.v2_tenant_admissions_snapshot',{p_slug:'marktone'});
 assert.equal(snapshot.viewer.canViewFinancialDetails,false);assert.equal(snapshot.viewer.canVerifyPayment,false);
 assert.equal(snapshot.cases[0].paymentStatus,'pending_verification');assert.equal('paymentAmountMinor' in snapshot.cases[0],false);assert.equal('paymentReference' in snapshot.cases[0],false);
 await assert.rejects(call(db,'public.v2_tenant_update_admission',{p_tenant_slug:'marktone',p_handoff_id:HANDOFF,p_action:'verify_payment'}),/payment_approval_permission_required/);
 await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2)',[id(22),'tenant.admissions.payment.verify']);
 const verifier=await call(db,'public.v2_tenant_admissions_snapshot',{p_slug:'marktone'});
 assert.equal(verifier.viewer.canVerifyPayment,true);assert.equal(verifier.viewer.canViewFinancialDetails,true);assert.equal(verifier.cases[0].paymentAmountMinor,10000);
});

test('partial refund reserves money, requires independent approval and reconciles all balances',async t=>{
 const db=await setup();t.after(()=>db.close());const p=await payment(db);
 await action(db,'allocate_payment',{paymentId:p.paymentId,invoiceId:INVOICE,amountMinor:10000});
 const cn=await creditNote(db);
 const refund=await action(db,'request_refund',{paymentId:p.paymentId,invoiceId:INVOICE,creditNoteId:cn,amountMinor:2000,effect:'price_adjustment',reason:'Fixture price reduction'});
 await assert.rejects(action(db,'approve_refund',{refundId:refund.refundId}),/refund_self_approval_forbidden/);
 await reviewer(db);await action(db,'approve_refund',{refundId:refund.refundId});
 await assert.rejects(action(db,'complete_refund',{refundId:refund.refundId}),/refund_execution_reference_required/);
 await action(db,'complete_refund',{refundId:refund.refundId,externalReference:'BANK-FIXTURE-REFUND'});await login(db);
 const f=await net(db);assert.equal(f.paidMinor,8000);assert.equal(f.totalMinor,8000);assert.equal(f.outstandingMinor,0);
 assert.equal(await call(db,'private_app.accounting_payment_available_v1',{p_tenant:T,p_payment:p.paymentId}),0);
 await assert.rejects(action(db,'allocate_payment',{paymentId:p.paymentId,invoiceId:INVOICE,amountMinor:1}),/payment_allocation_exceeds_available|payment_allocation_exceeds_invoice/);
 const snapshot=await call(db,'public.v1_tenant_accounting_snapshot',{p_slug:'marktone'});
 assert.equal(snapshot.summary.outstandingMinor,0);assert.equal(snapshot.accounts[0].balanceMinor,0);
 assert.equal(snapshot.summary.methodCollections.find(m=>m.method==='cash').amountMinor,8000);
});

test('credit transfer creates no cash outflow, applies once and cannot cross customer or currency',async t=>{
 const db=await setup();t.after(()=>db.close());const p=await payment(db);
 const r=await action(db,'request_refund',{paymentId:p.paymentId,amountMinor:2000,effect:'credit_transfer',reason:'Fixture future registration credit'});
 await reviewer(db);await action(db,'approve_refund',{refundId:r.refundId});await action(db,'complete_refund',{refundId:r.refundId});await login(db);
 const credit=(await db.query('select * from accounting_core.customer_credits')).rows[0];assert.equal(Number(credit.amount_minor),2000);
 const events=(await db.query('select * from private_app.campaign_cash_v1($1)',[T])).rows;assert.equal(events.filter(e=>e.kind==='refund').length,0);
 await action(db,'apply_customer_credit',{creditId:credit.id,invoiceId:INVOICE,amountMinor:2000});
 assert.equal((await net(db)).paidMinor,2000);
 await assert.rejects(action(db,'apply_customer_credit',{creditId:credit.id,invoiceId:INVOICE,amountMinor:1}),/credit_exceeds_available/);
 await assert.rejects(action(db,'apply_customer_credit',{creditId:credit.id,invoiceId:id(99999),amountMinor:1}),/credit_target_invalid/);
});

test('refund lifecycle preserves completion and paid incentives while closing the money loop',async t=>{
 const db=await setup();t.after(()=>db.close());await seedEnrollment(db);
 const p=await action(db,'import_handoff_payment',{handoffId:HANDOFF});
 await db.query("insert into incentives_core.plans(id,tenant_id,plan_key,title,period_start,period_end,metric_type,calculation_type) values($1,$2,'fixture-plan','Fixture plan','2026-01-01','2026-12-31','revenue','fixed')",[id(750),T]);
 await db.query('insert into incentives_core.assignments(id,tenant_id,plan_id,staff_id,target_value) values($1,$2,$3,$4,100)',[id(751),T,id(750),STAFF]);
 await db.query("insert into incentives_core.events(id,tenant_id,assignment_id,staff_id,source_type,source_id,incentive_amount,state,paid_at) values($1,$2,$3,$4,'registration_handoff',$5,10,'paid','2026-08-01T00:00Z')",[id(752),T,id(751),STAFF,HANDOFF]);
 await db.query("update academy.enrollments set status='completed' where id=$1",[ENROLLMENT]);
 const cancel=await action(db,'request_refund',{paymentId:p.paymentId,amountMinor:2000,effect:'cancel_registration',reason:'Fixture cancelled registration'});
 await reviewer(db);await action(db,'approve_refund',{refundId:cancel.refundId});
 await assert.rejects(action(db,'complete_refund',{refundId:cancel.refundId,externalReference:'BANK-CANCEL'}),/completed_training_requires_reversal_review/);
 await action(db,'classify_refund',{refundId:cancel.refundId,effect:'price_adjustment',reason:'Preserve completed training and refund price difference'});
 await assert.rejects(action(db,'approve_refund',{refundId:cancel.refundId}),/refund_self_approval_forbidden/);
 await login(db);await action(db,'approve_refund',{refundId:cancel.refundId});await action(db,'complete_refund',{refundId:cancel.refundId,externalReference:'BANK-ADJUSTMENT'});
 assert.equal((await db.query('select status from academy.enrollments where id=$1',[ENROLLMENT])).rows[0].status,'completed');
 const event=(await db.query('select state,incentive_amount,paid_at from incentives_core.events where id=$1',[id(752)])).rows[0];
 assert.equal(event.state,'paid');assert.equal(Number(event.incentive_amount),10);assert.equal(new Date(event.paid_at).toISOString(),'2026-08-01T00:00:00.000Z');
 const review=(await db.query('select * from accounting_core.incentive_adjustment_reviews')).rows[0];assert.equal(Number(review.proposed_reduction),2);
 await action(db,'review_incentive_adjustment',{reviewId:review.id,decision:'approved',reason:'Reviewed proportional adjustment without payroll mutation'});
 assert.equal((await db.query('select state from incentives_core.events where id=$1',[id(752)])).rows[0].state,'paid');
 await assert.rejects(db.query("update accounting_core.payments set metadata=metadata||'{\"attribution\":{\"source\":\"rewritten\"}}'::jsonb where id=$1",[p.paymentId]),/verified_payment_immutable/);
});

test('allocation, note limits and legacy uncertainty never overstate available money',async t=>{
 const db=await setup();t.after(()=>db.close());const p=await payment(db);
 await action(db,'allocate_payment',{paymentId:p.paymentId,invoiceId:INVOICE,amountMinor:1000});
 await assert.rejects(action(db,'request_refund',{paymentId:p.paymentId,invoiceId:INVOICE,amountMinor:1001,effect:'price_adjustment',reason:'Too much for invoice'}),/refund_exceeds_invoice_allocation/);
 await creditNote(db,9000);
 await assert.rejects(db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,parent_document_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'credit_note','CN-EXCESS','issued',$3,$4,'Fixture',2000,2000,'SAR')",[id(701),T,ACCOUNT,INVOICE]),/credit_note_exceeds_invoice/);
 // A deliberately ambiguous historic row must request review, never subtract
 // the whole refund independently from every invoice sharing the payment.
 await db.query("insert into accounting_core.refunds(id,tenant_id,customer_account_id,payment_id,amount_minor,reason,status,completed_at) values($1,$2,$3,$4,100,'Legacy fixture','completed',now())",[id(702),T,ACCOUNT,p.paymentId]);
 const f=await net(db);assert.equal(f.requiresReview,true);assert.equal(f.paidMinor,null);assert.equal(f.outstandingMinor,null);
 const snapshot=await call(db,'public.v1_tenant_accounting_snapshot',{p_slug:'marktone'});
 assert.equal(snapshot.summary.reviewRequiredInvoices,1);assert.equal(snapshot.summary.outstandingMinor,null);assert.equal(snapshot.aging.current,null);
 assert.equal(snapshot.documents.find(d=>d.id===INVOICE).paymentStatus,'review_required');
});

test('money hooks enqueue downstream reconciliation without acquiring academic locks',async t=>{
 const db=await setup();t.after(()=>db.close());
 await db.exec(`create table academy.diploma_contracts(id uuid primary key,tenant_id uuid,handoff_id uuid);
  create table academy.diploma_invoice_links(tenant_id uuid,contract_id uuid,invoice_id uuid);
  create table private_app.fixture_finance_queue(kind text,tenant_id uuid,target_id uuid);
  create function private_app.queue_admission_governance_v1(uuid,uuid) returns void language sql as $$insert into private_app.fixture_finance_queue values('admission',$1,$2)$$;
  create function private_app.queue_diploma_collection_v1(uuid,uuid) returns void language sql as $$insert into private_app.fixture_finance_queue values('diploma',$1,$2)$$;`);
 await db.query('insert into academy.diploma_contracts values($1,$2,$3)',[id(760),T,HANDOFF]);
 await db.query('insert into academy.diploma_invoice_links values($1,$2,$3)',[T,id(760),INVOICE]);
 const p=await payment(db);await action(db,'allocate_payment',{paymentId:p.paymentId,invoiceId:INVOICE,amountMinor:5000});
 const queue=(await db.query('select * from private_app.fixture_finance_queue')).rows;
 assert(queue.some(q=>q.kind==='diploma'&&q.target_id===id(760)));assert(queue.some(q=>q.kind==='admission'&&q.target_id===HANDOFF));
 const cash=(await db.query('select * from private_app.campaign_cash_v1($1)',[T])).rows;
 assert.equal(cash.reduce((sum,e)=>sum+Number(e.amount_minor),0),10000);assert.equal(cash.find(e=>e.handoff_id===HANDOFF).amount_minor,5000);
 // A shared payment may cover two registrations. A refund must follow the
 // selected invoice and cannot cancel another allocation's beneficiary.
 await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_amount_minor) values($1,$2,'HANDOFF-SECOND',$3,$4,10000)",[id(761),T,CONTACT,COURSE]);
 await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'invoice','INV-SECOND','issued',$3,'Fixture',10000,10000,'SAR')",[id(762),T,ACCOUNT]);
 await db.query('insert into academy.diploma_contracts values($1,$2,$3)',[id(763),T,id(761)]);
 await db.query('insert into academy.diploma_invoice_links values($1,$2,$3)',[T,id(763),id(762)]);
 await action(db,'allocate_payment',{paymentId:p.paymentId,invoiceId:id(762),amountMinor:5000});
 await assert.rejects(action(db,'request_refund',{paymentId:p.paymentId,invoiceId:INVOICE,handoffId:id(761),amountMinor:100,effect:'cancel_registration',reason:'Wrong registration for selected invoice'}),/refund_handoff_mismatch/);
 const r=await action(db,'request_refund',{paymentId:p.paymentId,invoiceId:INVOICE,amountMinor:100,effect:'price_adjustment',reason:'Implicit explicit-invoice beneficiary'});
 assert.equal((await db.query('select handoff_id from accounting_core.refunds where id=$1',[r.refundId])).rows[0].handoff_id,HANDOFF);
});
