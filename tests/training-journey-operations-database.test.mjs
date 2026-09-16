import assert from 'node:assert/strict';
import test from 'node:test';
import {setup,call,login,count,id,seedPayment,seedEnrollment,T,ADMIN,INSTRUCTOR_AUTH,CONTACT,COURSE,RUN,HANDOFF,ACCOUNT,INVOICE,PAYMENT,ENROLLMENT,STAFF} from './fixtures/training-journey-database.mjs';

let sequence=4000;
const action=(db,p_action,p_payload={},command=id(sequence++))=>call(db,'public.v1_tenant_training_journey_action',{p_slug:'marktone',p_action,p_payload:{...p_payload,commandId:command}});
const enable=db=>action(db,'set_enabled',{enabled:true});
const configure=(db,overrides={})=>action(db,'configure_finance',{handoffId:HANDOFF,invoiceId:INVOICE,policy:'full',...overrides});
async function accountant(db){
  const authId=id(4500),subject=id(4501),role=id(4502),membership=id(4503);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'accountant@example.test',now())",[authId]);
  await db.query("insert into access_control.subjects(id,auth_user_id,email,full_name) values($1,$2,'accountant@example.test','Fixture accountant')",[subject,authId]);
  await db.query("insert into access_control.roles(id,tenant_id,role_key,name_ar,scope) values($1,$2,'accountant','Accountant','tenant')",[role,T]);
  await db.query("insert into access_control.memberships(id,subject_id,tenant_id,scope) values($1,$2,$3,'tenant')",[membership,subject,T]);
  await db.query('insert into access_control.membership_roles(membership_id,role_id) values($1,$2)',[membership,role]);
  await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.accounting.read'),($1,'tenant.accounting.payments.approve')",[role]);
  await db.query("insert into people.staff_profiles(tenant_id,membership_id,full_name,job_title,role_key) values($1,$2,'Fixture accountant','Accountant','accountant')",[T,membership]);
  await login(db,authId);return subject;
}
const pendingPayment=db=>db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,payment_number,amount_minor,status) values($1,$2,$3,'PENDING-1',10000,'pending_verification')",[PAYMENT,T,ACCOUNT]);

test('operations connects existing admissions and finance with idempotent verified payment and cohort admission',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);
  await t.test('general instructors cannot configure financial truth',async()=>{
    await login(db,INSTRUCTOR_AUTH);await assert.rejects(configure(db),/training_payment_verification_forbidden/);await login(db);
  });
  await configure(db);
  await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,payment_number,amount_minor,status) values($1,$2,$3,'PENDING-1',10000,'pending_verification')",[PAYMENT,T,ACCOUNT]);
  await t.test('verification creates no duplicate payment or allocation on command retries',async()=>{
    const command=id(sequence++),payload={handoffId:HANDOFF,paymentId:PAYMENT};
    const first=await action(db,'verify_payment',payload,command);assert.equal(first.financial.trainingAllowed,true);
    assert.deepEqual(await action(db,'verify_payment',payload,command),first);
    await action(db,'verify_payment',payload);
    assert.equal(await count(db,'accounting_core.payments'),1);assert.equal(await count(db,'accounting_core.payment_allocations'),1);
    assert.equal((await db.query('select amount_minor from accounting_core.payment_allocations')).rows[0].amount_minor,10000);
    assert.equal((await db.query('select payment_status from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0].payment_status,'verified');
    assert.equal(await count(db,'sales_core.activities'),1);
  });
  await t.test('confirmed admission reuses the same person and enrollment when retried',async()=>{
    const command=id(sequence++),payload={handoffId:HANDOFF,courseRunId:RUN};
    const first=await action(db,'confirm_admission',payload,command);assert.ok(first.enrollmentId);
    assert.deepEqual(await action(db,'confirm_admission',payload,command),first);
    const retry=await action(db,'confirm_admission',payload);assert.equal(retry.enrollmentId,first.enrollmentId);
    assert.equal(await count(db,'academy.students'),1);assert.equal(await count(db,'academy.enrollments'),1);
    assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,1);
  });
});

test('capacity protection rolls back the second full-cohort admission without affecting the first',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);await configure(db);await seedPayment(db);await seedEnrollment(db);
  await db.query('update academy.course_runs set capacity=1,enrolled_count=1 where id=$1',[RUN]);
  const handoff2=id(4100),contact2=id(4101);
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name) values($1,$2,'Second learner')",[contact2,T]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_status,payment_verified_at) values($1,$2,'SECOND-REG',$3,$4,'verified',now())",[handoff2,T,contact2,COURSE]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,created_by_subject_id) values($1,$2,$3,$4,'full',true,$5)",[T,handoff2,INVOICE,ACCOUNT,ADMIN]);
  await assert.rejects(action(db,'confirm_admission',{handoffId:handoff2,courseRunId:RUN}),/course_run_full/);
  assert.equal(await count(db,'academy.enrollments'),1);assert.equal(await count(db,'academy.students'),1);
  assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,1);
});

test('approved company credit unlocks its beneficiaries without creating fictitious cash or cert settlement',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);
  await db.query("update accounting_core.customer_accounts set organization_name='Fixture employer',credit_limit_minor=15000 where id=$1",[ACCOUNT]);
  await configure(db,{policy:'company_credit',sponsor:true});
  const expiresOn=(await db.query("select ((now() at time zone 'Asia/Riyadh')::date+30)::text expires_on")).rows[0].expires_on;
  await t.test('unapproved company credit cannot activate study',async()=>{
    const result=await action(db,'verify_payment',{handoffId:HANDOFF});
    assert.equal(result.financial.trainingAllowed,false);assert.equal(result.admissionReady,false);
    assert.equal((await db.query('select payment_status from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0].payment_status,'pending_verification');
  });
  await t.test('approval is tied to amount, expiry, actor and reason',async()=>{
    const approved=await action(db,'approve_credit',{handoffId:HANDOFF,limitMinor:10000,expiresOn,reason:'Approved company contract'});
    assert.equal(approved.financial.trainingAllowed,true);assert.equal(approved.financial.certificationAllowed,false);
    await action(db,'verify_payment',{handoffId:HANDOFF});
    assert.equal(await count(db,'accounting_core.payments'),0);assert.equal(await count(db,'accounting_core.payment_allocations'),0);
    assert.equal((await db.query('select payment_status from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0].payment_status,'pending_verification');
    assert.equal(await count(db,'sales_core.activities'),0);
    await assert.rejects(call(db,'public.v2_tenant_update_admission',{p_tenant_slug:'marktone',p_handoff_id:HANDOFF,p_action:'verify_payment'}),/training_payment_evidence_required/);
    const admitted=await action(db,'confirm_admission',{handoffId:HANDOFF,courseRunId:RUN});assert.ok(admitted.enrollmentId);
    const access=await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:admitted.enrollmentId});
    assert.equal(access.trainingAllowed,true);assert.equal(access.certificationAllowed,false);
    assert.equal(await count(db,'sales_core.activities'),0);
    const l=(await db.query('select * from academy.training_financial_links')).rows[0];assert.equal(l.credit_approved_by_subject_id,ADMIN);assert.equal(l.credit_reason,'Approved company contract');
  });
  await t.test('account-wide credit limit prevents exposure across two approved invoices',async()=>{
    await db.query("insert into accounting_core.sales_documents(tenant_id,document_type,document_number,status,customer_account_id,customer_name_snapshot,subtotal_minor,total_minor) values($1,'invoice','COMPANY-SECOND','issued',$2,'Fixture employer',10000,10000)",[T,ACCOUNT]);
    const f=await call(db,'private_app.training_journey_handoff_finance_v1',{p_handoff_id:HANDOFF});assert.equal(f.trainingAllowed,false);
  });
  await t.test('later cash repayment keeps a completed credit admission completed and does not enroll twice',async()=>{
    const before=(await db.query('select id,status,completed_at from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0];
    const enrollmentId=(await db.query('select id from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].id;
    await pendingPayment(db);await accountant(db);
    const result=await action(db,'verify_payment',{handoffId:HANDOFF,paymentId:PAYMENT});
    assert.equal(result.paymentStatus,'verified');assert.notEqual(result.autoAssigned,true);
    const after=(await db.query('select id,status,completed_at from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0];
    assert.deepEqual(after,before);assert.equal(after.status,'completed');
    assert.equal((await db.query('select id from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].id,enrollmentId);
    assert.equal(await count(db,'academy.enrollments'),1);assert.equal(await count(db,'accounting_core.payments'),1);assert.equal(await count(db,'accounting_core.payment_allocations'),1);
  });
});

test('learner operations create assigned dated work and preserve history on defer/withdraw',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await enable(db);await configure(db);await seedPayment(db);await seedEnrollment(db);
  await t.test('request creation is atomic with staff task, notification and audit',async()=>{
    const r=await action(db,'create_request',{enrollmentId:ENROLLMENT,kind:'defer',reason:'Fixture approved postponement',assignedStaffId:STAFF});
    const task=(await db.query('select * from work_core.tasks where id=$1',[r.taskId])).rows[0];assert.equal(task.assigned_staff_id,STAFF);assert.ok(task.due_at);
    assert.equal(await count(db,'work_core.notifications'),1);
    await action(db,'decide_request',{requestId:r.requestId,decision:'approve',reason:'Schedule confirmed by operations'});
    assert.equal((await db.query('select metadata from academy.enrollments where id=$1',[ENROLLMENT])).rows[0].metadata.trainingJourneyDeferred,true);
    assert.equal((await db.query('select status from work_core.tasks where id=$1',[r.taskId])).rows[0].status,'completed');
  });
  await t.test('resumption requires approval and restores the same enrollment',async()=>{
    const r=await action(db,'create_request',{enrollmentId:ENROLLMENT,kind:'resume',reason:'Ready to resume the same training',assignedStaffId:STAFF});
    await action(db,'decide_request',{requestId:r.requestId,decision:'approve',reason:'Resumption approved after financial review'});
    assert.notEqual((await db.query('select metadata from academy.enrollments where id=$1',[ENROLLMENT])).rows[0].metadata.trainingJourneyDeferred,true);
    assert.equal((await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:ENROLLMENT})).trainingAllowed,true);
    assert.equal(await count(db,'academy.enrollments'),1);
  });
  await t.test('withdrawal closes access, preserves enrollment and marks financial settlement as pending',async()=>{
    const r=await action(db,'create_request',{enrollmentId:ENROLLMENT,kind:'withdraw',reason:'Fixture learner withdrawal',assignedStaffId:STAFF});
    const d=await action(db,'decide_request',{requestId:r.requestId,decision:'approve',reason:'Withdrawal confirmed by operations'});
    assert.equal(d.financialSettlementRequired,true);assert.equal(d.refundProcessed,false);assert.equal(await count(db,'academy.enrollments'),1);
    assert.equal((await db.query('select status from academy.enrollments where id=$1',[ENROLLMENT])).rows[0].status,'withdrawn');
    assert.equal(await count(db,'accounting_core.refunds'),0);assert.equal(await count(db,'accounting_core.payments'),1);
    assert.equal((await db.query("select count(*)::int n from work_core.tasks where task_key=$1 and status='todo'",['training-settlement-'+r.requestId])).rows[0].n,1);
  });
});

test('academy-only staff receive operational status without admission or accounting records',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await enable(db);await configure(db);await seedPayment(db);await seedEnrollment(db);
  await db.query("delete from access_control.role_permissions where role_id=$1 and permission_key not in ('tenant.academy.read','tenant.academy.write','tenant.training.read','tenant.training.write')",[id(21)]);
  const operations=await call(db,'public.v1_tenant_training_journey_snapshot',{p_slug:'marktone'});
  assert.deepEqual(operations.handoffs,[]);assert.deepEqual(operations.invoices,[]);assert.deepEqual(operations.payments,[]);
  assert.equal(operations.enrollments.length,1);
  const learning=await call(db,'public.v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'manager'});
  for(const view of [operations,learning])for(const key of ['paidMinor','totalMinor','outstandingMinor','invoiceId'])assert.equal(JSON.stringify(view).includes(`"${key}"`),false,key);
});

test('accountant payment confirmation automatically admits only the preselected cohort and never grants general admissions rights',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await enable(db);await configure(db);
  await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
  await pendingPayment(db);const subject=await accountant(db);
  assert.equal(await call(db,'private_app.has_tenant_permission',{p_tenant_id:T,p_permission:'tenant.admissions.write'}),false);
  for(const args of [{p_course_run_id:RUN},{}])await assert.rejects(call(db,'public.v2_tenant_update_admission',{p_tenant_slug:'marktone',p_handoff_id:HANDOFF,p_action:'complete',...args}),/forbidden/);
  const command=id(sequence++),payload={handoffId:HANDOFF,paymentId:PAYMENT,courseRunId:id(9999)};
  const result=await action(db,'verify_payment',payload,command);
  assert.equal(result.autoAssigned,true);assert.ok(result.enrollmentId);assert.equal(result.learningReady,false);
  const enrollment=(await db.query('select course_run_id,confirmed_by_subject_id from academy.enrollments where id=$1',[result.enrollmentId])).rows[0];
  assert.equal(enrollment.course_run_id,RUN);assert.equal(enrollment.confirmed_by_subject_id,subject);
  assert.deepEqual(await action(db,'verify_payment',payload,command),result);assert.equal(await count(db,'academy.enrollments'),1);
  await assert.rejects(call(db,'public.v2_tenant_update_admission',{p_tenant_slug:'marktone',p_handoff_id:HANDOFF,p_action:'complete'}),/forbidden/);
  assert.equal((await db.query('select count(*)::int n from academy.training_journey_commands where auto_handoff_id is not null or auto_run_id is not null')).rows[0].n,0);
});

test('an automatic admission capacity failure preserves verified cash and returns a review reason',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);await configure(db);
  await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
  await db.query('update academy.course_runs set capacity=1 where id=$1',[RUN]);
  const otherHandoff=id(4550),otherContact=id(4551);
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name) values($1,$2,'Existing admitted learner')",[otherContact,T]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_status,payment_verified_at) values($1,$2,'EXISTING-FULL-COHORT',$3,$4,'verified',now())",[otherHandoff,T,otherContact,COURSE]);
  await call(db,'public.v2_tenant_update_admission',{p_tenant_slug:'marktone',p_handoff_id:otherHandoff,p_action:'complete',p_course_run_id:RUN});
  await pendingPayment(db);await accountant(db);
  const result=await action(db,'verify_payment',{handoffId:HANDOFF,paymentId:PAYMENT});
  assert.equal(result.autoAssigned,false);assert.equal(result.assignmentIssue,'course_run_full');assert.equal(result.paymentVerified,true);
  assert.equal((await db.query('select status from accounting_core.payments where id=$1',[PAYMENT])).rows[0].status,'verified');
  assert.equal((await db.query('select amount_minor from accounting_core.payment_allocations where payment_id=$1',[PAYMENT])).rows[0].amount_minor,10000);
  assert.equal((await db.query('select count(*)::int n from academy.enrollments where handoff_id=$1',[HANDOFF])).rows[0].n,0);
  assert.equal(await count(db,'academy.enrollments'),1);assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,1);
});

test('linked registration cannot import a second legacy cash receipt through UUID formatting or feature rollback',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);
  const linked='abcdef12-abcd-4abc-8abc-abcdef123456';
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id) values($1,$2,'LEGACY-DUPLICATE-GUARD',$3,$4)",[linked,T,CONTACT,COURSE]);
  await action(db,'configure_finance',{handoffId:linked,invoiceId:INVOICE,policy:'full'});
  const insert=(source,number)=>db.query("insert into accounting_core.payments(tenant_id,customer_account_id,payment_number,amount_minor,source_type,source_id) values($1,$2,$3,10000,'registration_handoff',$4)",[T,ACCOUNT,number,source]);
  for(const [index,source] of [linked,linked.toUpperCase(),linked.replaceAll('-','')].entries())await assert.rejects(insert(source,'DUPLICATE-'+index),/payment_source_already_imported/);
  await db.query('update academy.training_journey_settings set enabled=false where tenant_id=$1',[T]);
  await assert.rejects(insert(linked,'DISABLED-DUPLICATE'),/payment_source_already_imported/);
  await insert(HANDOFF,'UNLINKED-LEGACY-CONTROL');assert.equal(await count(db,'accounting_core.payments'),1);
});

test('native training navigation follows operational permissions, identity and the tenant addon',async t=>{
  const db=await setup();t.after(()=>db.close());const nav=slug=>call(db,'public.v1_training_journey_navigation',{p_slug:slug});
  assert.deepEqual(await nav('marktone'),{enabled:false});await enable(db);assert.deepEqual(await nav('marktone'),{enabled:true});
  assert.deepEqual(await nav('foreign'),{enabled:false});await accountant(db);assert.deepEqual(await nav('marktone'),{enabled:true});
  await login(db,INSTRUCTOR_AUTH);assert.deepEqual(await nav('marktone'),{enabled:false});
  await login(db);await db.query("select set_config('fixture.addon','no',false)");assert.deepEqual(await nav('marktone'),{enabled:false});
  await db.query("select set_config('fixture.addon','yes',false)");await login(db,null);assert.deepEqual(await nav('marktone'),{enabled:false});
});
