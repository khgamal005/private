import assert from 'node:assert/strict';
import test from 'node:test';
import {call,id,login,T,OTHER,ADMIN,STAFF,CONTACT,COURSE,RUN,HANDOFF,ACCOUNT,INVOICE,INSTRUCTOR_AUTH} from './fixtures/training-journey-database.mjs';
import {setup} from './fixtures/operational-governance-database.mjs';
let command=5000;
const finance=(db,action,payload={})=>call(db,'public.v1_tenant_accounting_action',{p_slug:'marktone',p_action:action,p_payload:{commandId:id(command++),...payload}});
const admission=(db,action,payload={})=>call(db,'public.v1_tenant_admission_governance_action',{p_tenant_slug:'marktone',p_action:action,p_payload:payload});
const readiness=(db,handoff=HANDOFF)=>call(db,'private_app.admission_readiness_v1',{p_tenant_id:T,p_handoff_id:handoff});

test('dedicated admission verifier works without admissions editing or general accounting access',async t=>{
  const db=await setup();t.after(()=>db.close());
  await finance(db,'set_governance',{enabled:true,confirmation:'ENABLE_FINANCIAL_GOVERNANCE'});
  await db.query("insert into sales_core.pipeline_stages(tenant_id,stage_key,name_ar) values($1,'proposal','Synthetic payment follow-up')",[T]);
  const second=id(780);
  await db.query("update academy.registration_handoffs set metadata=metadata||'{\"currency\":\"SAR\",\"paymentMethod\":\"cash\"}'::jsonb where id=$1",[HANDOFF]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_amount_minor) values($1,$2,'HANDOFF-VERIFY-2',$3,$4,10000)",[second,T,CONTACT,COURSE]);
  for(const permission of ['tenant.admissions.read','tenant.admissions.payment.verify'])
    await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2)',[id(22),permission]);
  await login(db,INSTRUCTOR_AUTH);
  const update=async(action,handoff=HANDOFF,slug='marktone')=>{
    await db.exec('set role authenticated');
    try{return await call(db,'public.v2_tenant_update_admission',{
      p_tenant_slug:slug,p_handoff_id:handoff,p_action:action,p_reason:'Synthetic verifier decision'
    });}finally{await db.exec('reset role');}
  };
  for(const permission of ['tenant.admissions.write','tenant.accounting.read','tenant.accounting.payments.approve'])
    assert.equal((await db.query('select private_app.has_tenant_permission($1,$2) allowed',[T,permission])).rows[0].allowed,false);
  const snapshot=await call(db,'public.v3_tenant_admissions_snapshot',{p_slug:'marktone'});
  assert.equal(snapshot.viewer.canVerifyPayment,true);assert.equal(snapshot.viewer.canViewFinancialDetails,true);
  assert.equal(snapshot.cases.find(row=>row.id===HANDOFF).paymentAmountMinor,10000);
  for(const extra of [{p_course_id:COURSE},{p_course_run_id:RUN},{p_notes:'Unrelated admissions edit'}])
    await assert.rejects(call(db,'public.v2_tenant_update_admission',{
      p_tenant_slug:'marktone',p_handoff_id:HANDOFF,p_action:'verify_payment',...extra
    }),/forbidden/);
  await update('verify_payment');
  await update('verify_payment');
  assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,1);
  assert.equal((await db.query('select payment_status from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0].payment_status,'verified');
  await assert.rejects(update('reject_payment'),/verified_payment_requires_adjustment/);
  await update('reject_payment',second);
  assert.equal((await db.query('select payment_status from academy.registration_handoffs where id=$1',[second])).rows[0].payment_status,'rejected');
  for(const action of ['start_review','save_details','accept','complete','cancel'])await assert.rejects(update(action),/forbidden/);
  await assert.rejects(update('verify_payment',HANDOFF,'foreign'),/forbidden/);
  await db.query("delete from access_control.role_permissions where role_id=$1 and permission_key='tenant.admissions.payment.verify'",[id(22)]);
  for(const permission of ['tenant.accounting.read','tenant.accounting.payments.approve'])
    await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2)',[id(22),permission]);
  await update('verify_payment');
  await assert.rejects(update('save_details'),/forbidden/);
});

test('all governance migrations apply together to the actual production contracts, without activating or rewriting tenants',async t=>{
  const db=await setup();t.after(()=>db.close());
  for(const table of ['core.branches','core.tenant_operating_setup','accounting_core.governance_settings','academy.admission_governance_settings','academy.diploma_settings'])
    assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n,0,table);
  assert.equal((await db.query("select to_regclass('sales_core.commerce_order_beneficiaries') missing")).rows[0].missing,null);
  assert.equal((await db.query('select count(*)::int n from sales_core.contacts')).rows[0].n,1);
  assert.equal((await db.query('select program_kind from academy.courses where id=$1',[COURSE])).rows[0].program_kind,null);
  await assert.rejects(call(db,'public.v1_tenant_operating_snapshot',{p_tenant_slug:'foreign'}),/forbidden/);
});

test('free direct enrollment reconciles canonical money and documents, and refund closes only its registration',async t=>{
  const db=await setup();t.after(()=>db.close());
  await db.query("update academy.courses set program_kind='short_course',price_minor=10000 where id=$1",[COURSE]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
  const policy={enabled:true,financeOwnerStaffId:STAFF,placementOwnerStaffId:STAFF,financeBusinessDays:1,placementBusinessDays:1,weekendIsoDays:[5,6]};
  const preview=await admission(db,'preview_policy',policy);
  await admission(db,'save_policy',{...policy,previewToken:preview.previewToken,confirmed:true});
  await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
  await db.query("insert into academy.registration_documents(tenant_id,handoff_id,document_type,is_required,status) values($1,$2,'national_id',true,'pending')",[T,HANDOFF]);
  assert.equal((await readiness(db)).waitingReason,'required_documents_incomplete');
  const payment=await finance(db,'record_payment',{customerAccountId:ACCOUNT,amountMinor:10000,currency:'SAR',method:'cash',verifyNow:true,externalReference:'SYNTHETIC-INTEGRATION'});
  await finance(db,'allocate_payment',{paymentId:payment.paymentId,invoiceId:INVOICE,amountMinor:10000});
  await db.query("update academy.registration_documents set status='approved' where tenant_id=$1 and handoff_id=$2",[T,HANDOFF]);
  await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:100});
  assert.equal((await readiness(db)).state,'enrolled');
  assert.equal((await db.query('select count(*)::int n from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].n,1);
  await call(db,'private_app.reconcile_admission_governance_v1',{p_tenant_id:T,p_handoff_id:HANDOFF});
  assert.equal((await db.query('select count(*)::int n from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].n,1);
  const creditNote=id(700);
  await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,parent_document_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'credit_note','CN-INTEGRATION','issued',$3,$4,'Synthetic',10000,10000,'SAR')",[creditNote,T,ACCOUNT,INVOICE]);
  const refund=await finance(db,'request_refund',{paymentId:payment.paymentId,invoiceId:INVOICE,creditNoteId:creditNote,handoffId:HANDOFF,amountMinor:10000,effect:'cancel_registration',reason:'Synthetic cancellation'});
  await assert.rejects(finance(db,'approve_refund',{refundId:refund.refundId}),/self_approval/);
  await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.accounting.read'),($1,'tenant.accounting.refunds.approve') on conflict do nothing",[id(22)]);
  await login(db,INSTRUCTOR_AUTH);
  await finance(db,'approve_refund',{refundId:refund.refundId});
  await finance(db,'complete_refund',{refundId:refund.refundId,externalReference:'SYNTHETIC-REFUND'});
  await login(db);
  assert.equal((await db.query('select status from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].status,'cancelled');
  assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,0);
  assert.equal((await db.query('select count(*)::int n from sales_core.contacts')).rows[0].n,1);
});

test('diploma first installment allocation queues admission and cancellation refund opens contract settlement review',async t=>{
  const db=await setup();t.after(()=>db.close());
  const diploma=(action,payload)=>call(db,'public.v1_tenant_diploma_action',{
    p_slug:'marktone',p_action:action,p_command_id:id(command++),p_payload:payload
  });
  // Explicit synthetic tenant activation; the migration still defaults off.
  await db.query('insert into academy.diploma_settings(tenant_id,enabled) values($1,true)',[T]);
  await call(db,'public.v1_tenant_classify_program',{
    p_slug:'marktone',p_course_id:COURSE,p_kind:'diploma',p_expected_kind:null,p_command_id:id(command++)
  });
  const policy={enabled:true,financeOwnerStaffId:STAFF,placementOwnerStaffId:STAFF,financeBusinessDays:1,placementBusinessDays:1,weekendIsoDays:[5,6]};
  const preview=await admission(db,'preview_policy',policy);
  await admission(db,'save_policy',{...policy,previewToken:preview.previewToken,confirmed:true});
  await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
  const installments=[{id:id(720),dueOn:'2026-01-01',amountMinor:10000},{id:id(721),dueOn:'2027-01-01',amountMinor:10000}];
  const created=await diploma('create',{
    handoffId:HANDOFF,payerAccountId:ACCOUNT,collectionOwnerId:STAFF,startsOn:'2026-01-01',
    totalMinor:20000,currency:'SAR',installments
  });
  const contractId=created.contractId;
  await diploma('approve',{contractId,expectedVersion:1});
  await diploma('link_invoice',{contractId,expectedVersion:1,installmentId:installments[0].id,invoiceId:INVOICE});
  assert.equal((await readiness(db)).waitingReason,'first_installment_required');
  assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from academy.training_financial_links')).rows[0].n,0,
    'diploma invoice stays outside the separate training-pilot invoice path');

  const payment=await finance(db,'record_payment',{
    customerAccountId:ACCOUNT,amountMinor:10000,currency:'SAR',method:'cash',verifyNow:true,externalReference:'SYNTHETIC-DIPLOMA-FIRST'
  });
  await finance(db,'allocate_payment',{paymentId:payment.paymentId,invoiceId:INVOICE,amountMinor:10000});
  assert.equal((await db.query('select count(*)::int n from academy.admission_governance_queue where tenant_id=$1 and handoff_id=$2',[T,HANDOFF])).rows[0].n,1,
    'canonical allocation must invoke the real diploma-to-admission hook');
  assert.equal((await db.query('select count(*)::int n from academy.diploma_reconciliation_queue where tenant_id=$1 and contract_id=$2',[T,contractId])).rows[0].n,1,
    'money mutation enqueues collection without taking the reversed contract lock');
  await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:100});
  assert.equal((await readiness(db)).state,'enrolled');
  assert.equal((await db.query('select count(*)::int n from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].n,1);
  await call(db,'private_app.accounting_reconcile_invoice_v1',{p_tenant:T,p_invoice:INVOICE});
  await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:100});
  assert.equal((await db.query('select count(*)::int n from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].n,1,
    'replayed financial reconciliation does not create a second enrollment');
  await db.query('update academy.diploma_settings set collection_automation_enabled=true where tenant_id=$1',[T]);
  assert.equal((await call(db,'private_app.diploma_collections_tick_v1',{p_limit:100})).processed,1);
  assert.equal((await db.query('select count(*)::int n from academy.diploma_reconciliation_queue')).rows[0].n,0);
  const beforeRefund=await call(db,'private_app.diploma_installment_state_v1',{p_tenant_id:T,p_contract_id:contractId});
  assert.equal(beforeRefund[0].state,'settled');
  assert.equal(beforeRefund[1].outstandingMinor,10000,'first installment admits without pretending the contract is fully paid');

  const creditNote=id(722);
  await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,parent_document_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'credit_note','CN-DIPLOMA-INTEGRATION','issued',$3,$4,'Synthetic',10000,10000,'SAR')",[creditNote,T,ACCOUNT,INVOICE]);
  const refund=await finance(db,'request_refund',{
    paymentId:payment.paymentId,invoiceId:INVOICE,creditNoteId:creditNote,handoffId:HANDOFF,
    amountMinor:10000,effect:'cancel_registration',reason:'Synthetic diploma cancellation'
  });
  await assert.rejects(finance(db,'approve_refund',{refundId:refund.refundId}),/self_approval/);
  await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.accounting.read'),($1,'tenant.accounting.refunds.approve') on conflict do nothing",[id(22)]);
  await login(db,INSTRUCTOR_AUTH);
  await finance(db,'approve_refund',{refundId:refund.refundId});
  await finance(db,'complete_refund',{refundId:refund.refundId,externalReference:'SYNTHETIC-DIPLOMA-REFUND'});
  await login(db);
  await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:100});
  assert.equal((await readiness(db)).state,'cancelled');
  assert.equal((await db.query('select status from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].status,'cancelled');
  assert.equal((await db.query('select status from academy.diploma_contracts where id=$1',[contractId])).rows[0].status,'settlement_review');
  const afterRefund=await call(db,'private_app.diploma_installment_state_v1',{p_tenant_id:T,p_contract_id:contractId});
  assert.equal(afterRefund[0].outstandingMinor,0,'issued credit note and refund settle the original invoice exactly');
  assert.equal(afterRefund[1].state,'paused','cancellation preserves and pauses unbilled obligations for review');
  assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from academy.diploma_schedule_versions where contract_id=$1',[contractId])).rows[0].n,1);
  assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,0);
});
