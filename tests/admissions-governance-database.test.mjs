import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {setup as trainingSetup,call,id,login,seedPayment,seedEnrollment,T,OTHER,ADMIN,STAFF,COURSE,RUN,HANDOFF,CONTACT,INSTRUCTOR_AUTH,INVOICE,ACCOUNT,ENROLLMENT} from './fixtures/training-journey-database.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration='../supabase/migrations/20260921125631_admissions_lifecycle_governance_v1.sql';
const action=(db,kind,payload={})=>call(db,'public.v1_tenant_admission_governance_action',{p_tenant_slug:'marktone',p_action:kind,p_payload:payload});
const readiness=db=>call(db,'private_app.admission_readiness_v1',{p_tenant_id:T,p_handoff_id:HANDOFF});
const reconcile=db=>call(db,'private_app.reconcile_admission_governance_v1',{p_tenant_id:T,p_handoff_id:HANDOFF});

async function setup(){
 const db=await trainingSetup();
 try{
  const runs=await read('../supabase/migrations/20260727230548_course_runs_and_schedules_v2.sql');
  const start=runs.indexOf('create or replace function public.v2_tenant_save_course_run(');
  await db.exec(runs.slice(start,runs.indexOf('\n$$;',start)+4));
  const admission=await read('../supabase/migrations/20260727223000_admissions_and_sales_guards_v2.sql');
  const documentStart=admission.indexOf('create or replace function public.v2_tenant_update_admission_document(');
  await db.exec(admission.slice(documentStart,admission.indexOf('\n$$;',documentStart)+4));
  await db.exec(`alter table academy.courses add column program_kind text;
   alter table academy.enrollments add column commerce_seat_id uuid;
   create table sales_core.commerce_order_beneficiaries(id uuid primary key default gen_random_uuid(),tenant_id uuid,handoff_id uuid,contact_id uuid,enrollment_id uuid);
   create function public.v3_tenant_admissions_snapshot(p_slug text) returns jsonb language sql as $$select '{"viewer":{"canViewFinancialDetails":false},"cases":[]}'::jsonb$$;
   create function public.v2_tenant_course_runs_snapshot(p_slug text) returns jsonb language sql as $$select '{"viewer":{},"courseRuns":[]}'::jsonb$$;
   -- Cross-module seams are independently tested by the finance/diploma suites.
   create function private_app.admission_verified_cash_v1(t uuid,h uuid) returns bigint language sql stable as $$
    select case when payment_status='verified' then payment_amount_minor else 0 end from academy.registration_handoffs where tenant_id=t and id=h$$;
   create function private_app.admission_cash_currency_v1(t uuid,h uuid) returns text language sql stable as $$select coalesce(nullif(current_setting('fixture.cash_currency',true),''),'SAR')$$;
   create function private_app.accounting_invoice_net_v1(t uuid,i uuid) returns jsonb language sql stable as $$select jsonb_build_object('totalMinor',total_minor,'currency',currency) from accounting_core.sales_documents where tenant_id=t and id=i and status='issued'$$;
   create function private_app.diploma_admission_eligibility_v1(t uuid,h uuid) returns jsonb language sql stable as $$
    select jsonb_build_object('eligible',current_setting('fixture.diploma_ready',true)='yes','reason','first_installment_required')$$;
   create function private_app.force_registration_document_optional() returns trigger language plpgsql as $$begin new.is_required:=false;return new;end$$;
   create trigger registration_documents_force_optional before insert or update of is_required on academy.registration_documents for each row execute function private_app.force_registration_document_optional();
  `);
  await db.exec(await read(migration));
  await db.query("update academy.courses set program_kind='short_course',price_minor=10000 where id=$1",[COURSE]);
  return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
async function enable(db){
 await db.query('insert into academy.admission_governance_settings(tenant_id,enabled,finance_owner_staff_id,placement_owner_staff_id) values($1,true,$2,$2)',[T,STAFF]);
 await db.query("insert into academy.admission_commercial_terms(tenant_id,handoff_id,course_id,amount_minor,currency,reason,approved_by_subject_id) values($1,$2,$4,10000,'SAR','Fixture documented agreed price',$3)",[T,HANDOFF,ADMIN,COURSE]);
}
async function pay(db,amount=10000){
 await db.query("update academy.registration_handoffs set payment_status='verified',payment_verified_at=now(),payment_amount_minor=$1 where id=$2",[amount,HANDOFF]);
}

test('governance activates only through a current tenant-scoped preview and explicit confirmation',async t=>{
 const db=await setup();t.after(()=>db.close());
 assert.equal((await db.query('select count(*)::int n from academy.admission_governance_settings')).rows[0].n,0);
 const payload={enabled:true,financeOwnerStaffId:STAFF,placementOwnerStaffId:STAFF,financeBusinessDays:1,placementBusinessDays:1,weekendIsoDays:[5,6]};
 await assert.rejects(action(db,'save_policy',payload),/policy_preview_required/);
 const preview=await action(db,'preview_policy',payload);assert.equal(preview.impact.openAdmissions,1);
 await assert.rejects(action(db,'save_policy',{...payload,previewToken:preview.previewToken,confirmed:true,financeBusinessDays:2}),/policy_preview_required/);
 const saved=await action(db,'save_policy',{...payload,previewToken:preview.previewToken,confirmed:true});assert.equal(saved.enabled,true);
 assert.equal(saved.queueCount,1);assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
 await assert.rejects(call(db,'public.v1_tenant_admission_governance_snapshot',{p_tenant_slug:'foreign'}),/forbidden/);
 await login(db,INSTRUCTOR_AUTH);await assert.rejects(action(db,'reevaluate',{handoffId:HANDOFF}),/forbidden/);
 await assert.rejects(action(db,'approve_payment_waiver',{handoffId:HANDOFF,reason:'fixture approval'}),/forbidden/);
 await login(db);await db.exec('set role authenticated');
 await assert.rejects(db.query('select * from academy.admission_governance_settings'),/permission denied/);await db.exec('reset role');
 assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_admission_governance_action(text,text,jsonb)','execute') allowed")).rows[0].allowed,false);
});

test('full payment, required documents and an open run converge atomically without duplicate learners or tasks',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
 assert.equal((await readiness(db)).waitingReason,'full_payment_required');
 await pay(db,5000);assert.equal((await readiness(db)).waitingReason,'full_payment_required');
 await db.query("insert into academy.registration_documents(tenant_id,handoff_id,document_type,is_required,status) values($1,$2,'national_id',true,'pending')",[T,HANDOFF]);
 await pay(db);assert.equal((await readiness(db)).waitingReason,'required_documents_incomplete');
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
 const task=(await db.query('select id,due_at from work_core.tasks where task_key=$1',['registration-'+HANDOFF])).rows[0];
 await reconcile(db);assert.equal((await db.query('select id from work_core.tasks where task_key=$1',['registration-'+HANDOFF])).rows[0].id,task.id);
 assert.equal(new Date((await db.query('select due_at from work_core.tasks where id=$1',[task.id])).rows[0].due_at).getTime(),new Date(task.due_at).getTime());
 await db.query("update academy.registration_documents set status='approved' where handoff_id=$1",[HANDOFF]);
 assert.equal((await readiness(db)).state,'enrolled');
 const enrollment=(await db.query('select * from academy.enrollments')).rows[0];
 assert.equal(enrollment.course_run_id,RUN);assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,1);
 await reconcile(db);await reconcile(db);
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,1);
 assert.equal((await db.query('select status from work_core.tasks where id=$1',[task.id])).rows[0].status,'completed');
 assert.equal((await db.query('select count(*)::int n from academy.students where contact_id=$1',[CONTACT])).rows[0].n,1);
});

test('planning is reservation; opening a run queues and places eligible learners; payment changes do not rewrite academic enrollment',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query("update academy.course_runs set status='planning' where id=$1",[RUN]);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 assert.equal((await readiness(db)).state,'reserved');assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
 await db.query("update academy.course_runs set status='open' where id=$1",[RUN]);
 const processed=await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:100});assert.equal(processed.processed,1);
 assert.equal((await readiness(db)).state,'enrolled');
 await db.query("update academy.registration_handoffs set payment_status='refunded' where id=$1",[HANDOFF]);
 assert.equal((await readiness(db)).state,'enrolled');
 assert.equal((await db.query('select status from academy.enrollments')).rows[0].status,'confirmed');
});

test('late placement requires a permissioned reason, while finished and canceled runs cannot accept new placement',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query("update academy.course_runs set status='in_progress' where id=$1",[RUN]);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 assert.equal((await readiness(db)).waitingReason,'late_enrollment_approval_required');
 await assert.rejects(action(db,'approve_late_enrollment',{handoffId:HANDOFF,courseRunId:RUN,reason:''}),/reason_required/);
 await login(db,INSTRUCTOR_AUTH);await assert.rejects(action(db,'approve_late_enrollment',{handoffId:HANDOFF,courseRunId:RUN,reason:'approved late enrollment'}),/forbidden/);await login(db);
 await action(db,'approve_late_enrollment',{handoffId:HANDOFF,courseRunId:RUN,reason:'approved late enrollment'});
 assert.equal((await readiness(db)).state,'enrolled');
 const otherRun=id(888);await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,delivery_mode,status) values($1,$2,$3,'CLOSED','hybrid','completed')",[otherRun,T,COURSE]);
 await assert.rejects(db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[otherRun,HANDOFF]),/course_run_unavailable/);
});

test('waivers do not invent cash; unknown programs and missing beneficiary phones remain explicit waiting states',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
 await db.query('update academy.courses set program_kind=null where id=$1',[COURSE]);assert.equal((await readiness(db)).waitingReason,'program_classification_required');
 await db.query("update academy.courses set program_kind='short_course' where id=$1",[COURSE]);
 await db.query('update sales_core.contacts set phone=null where id=$1',[CONTACT]);assert.equal((await readiness(db)).waitingReason,'beneficiary_phone_required');
 await db.query("update sales_core.contacts set phone='0501112233' where id=$1",[CONTACT]);
 await action(db,'approve_payment_waiver',{handoffId:HANDOFF,reason:'approved scholarship'});
 assert.equal((await readiness(db)).state,'enrolled');
 assert.equal((await db.query('select payment_status from academy.registration_handoffs where id=$1',[HANDOFF])).rows[0].payment_status,'pending_verification');
 assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,0);
});

test('tenant business deadlines skip configured weekend and use tenant wall-clock time',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 const deadline=await call(db,'private_app.admission_business_deadline_v1',{p_tenant_id:T,p_start:'2026-09-17T18:00:00Z',p_days:1});
 assert.equal(new Date(deadline).toISOString(),'2026-09-20T18:00:00.000Z');
 await db.query("update core.tenants set timezone='America/New_York' where id=$1",[T]);
 await db.query('update academy.admission_governance_settings set weekend_iso_days=array[6,7] where tenant_id=$1',[T]);
 const dst=await call(db,'private_app.admission_business_deadline_v1',{p_tenant_id:T,p_start:'2026-10-30T13:00:00Z',p_days:1});
 assert.equal(new Date(dst).toISOString(),'2026-11-02T14:00:00.000Z');
});

test('missing attendance stays unrecorded, blocks close after 48 hours and requires an audited exception',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 await db.query("update academy.enrollments set enrolled_at=now()-interval '10 days'");
 await db.query("update academy.course_runs set status='in_progress',starts_at=now()-interval '9 days',ends_at=now()-interval '3 days' where id=$1",[RUN]);
 const session=id(901);await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,1,'Session',now()-interval '5 days',now()-interval '4 days','hybrid')",[session,T,RUN]);
 await db.query("update academy.course_run_sessions set status='completed' where id=$1",[session]);
 const evidence=await call(db,'private_app.course_run_closure_evidence_v1',{p_tenant_id:T,p_run_id:RUN});
 assert.equal(evidence.dueForClosure,true);assert.equal(evidence.missingAttendance,1);
 await assert.rejects(db.query("update academy.course_runs set status='completed' where id=$1",[RUN]),/attendance_unrecorded_blocks_closure/);
 assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,0);
 await action(db,'close_run',{courseRunId:RUN,reason:'approved documented missing attendance exception'});
 assert.equal((await db.query('select status from academy.course_runs where id=$1',[RUN])).rows[0].status,'completed');
 assert.equal((await db.query('select count(*)::int n from academy.admission_governance_exceptions')).rows[0].n,1);
});

test('session save preserves attendance identity and cannot remove or move a recorded session',async t=>{
 const db=await setup();t.after(()=>db.close());
 const session=id(902);await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,1,'Session','2026-09-01T09:00Z','2026-09-01T10:00Z','hybrid')",[session,T,RUN]);
 // Attendance FK/link validation uses the canonical enrollment/run relation.
 await pay(db);await db.query("insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id) select $1,'RECORDED',$2,id,$3,$4 from academy.students where tenant_id=$1 and contact_id=$5",[T,HANDOFF,COURSE,RUN,CONTACT]);
 await db.query("insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status) select $1,$2,$3,id,'present' from academy.enrollments where handoff_id=$4",[T,RUN,session,HANDOFF]);
 await assert.rejects(db.query('delete from academy.course_run_sessions where id=$1',[session]),/recorded_session_cannot_be_removed/);
 await assert.rejects(db.query("update academy.course_run_sessions set starts_at=starts_at+interval '1 minute' where id=$1",[session]),/recorded_session_schedule_locked/);
 await call(db,'public.v2_tenant_save_course_run',{p_tenant_slug:'marktone',p_course_id:COURSE,p_title:'Updated cohort',p_delivery_mode:'hybrid',p_starts_local:'2026-09-01 12:00',p_ends_local:'2026-09-01 13:00',p_capacity:2,p_sessions:[{title:'Updated session',startsAt:'2026-09-01 12:00',endsAt:'2026-09-01 13:00',deliveryMode:'hybrid'}],p_course_run_id:RUN,p_status:'in_progress'});
 assert.equal((await db.query('select id from academy.course_run_sessions where course_run_id=$1',[RUN])).rows[0].id,session);
 assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,1);
});

test('core works without beneficiary addon schema and refuses legacy guessed prices or foreign currency',async t=>{
 const db=await setup();t.after(()=>db.close());
 await db.exec('drop table sales_core.commerce_order_beneficiaries;alter table academy.enrollments drop column commerce_seat_id;');
 await db.query('insert into academy.admission_governance_settings(tenant_id,enabled) values($1,true)',[T]);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 assert.equal((await readiness(db)).waitingReason,'agreed_price_required');
 await db.query("insert into academy.admission_commercial_terms(tenant_id,handoff_id,course_id,amount_minor,currency,reason,approved_by_subject_id) values($1,$2,$3,10000,'USD','Foreign currency agreement',$4)",[T,HANDOFF,COURSE,ADMIN]);
 assert.equal((await readiness(db)).waitingReason,'payment_currency_mismatch');
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
});

test('worker uses recorded policy without an interactive identity and tenant references cannot cross boundaries',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query("update academy.course_runs set status='planning' where id=$1",[RUN]);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 await assert.rejects(db.query('insert into academy.admission_governance_queue(tenant_id,handoff_id) values($1,$2)',[OTHER,HANDOFF]),/foreign key constraint/);
 await db.query("update academy.course_runs set status='open' where id=$1",[RUN]);
 await login(db,null);
 const result=await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:1});assert.equal(result.failed,0,JSON.stringify((await db.query('select last_error from academy.admission_governance_queue')).rows));assert.equal(result.processed,1);
 assert.equal((await readiness(db)).state,'enrolled');
});

test('canceled/withdrawn registrations cannot be reported enrolled or reactivate through academic progression',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 await db.query("update academy.enrollments set status='cancelled'");
 await db.query("update academy.registration_handoffs set status='cancelled' where id=$1",[HANDOFF]);
 assert.equal((await readiness(db)).state,'cancelled');
 await assert.rejects(db.query("update academy.enrollments set status='active'"),/invalid_enrollment_handoff/);
 assert.equal((await db.query('select status from work_core.tasks where task_key=$1',['registration-'+HANDOFF])).rows[0].status,'completed');
 // Closed historical tasks retain their audit history; the projection is never falsely enrolled.
});

test('existing pilot keeps its disabled-policy behavior; enabled governance separates overdue collection from academic access',async t=>{
 const db=await setup();t.after(()=>db.close());
 await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[T]);
 await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'installments',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
 await db.query("insert into accounting_core.payment_schedules(tenant_id,invoice_id,installment_number,due_date,amount_minor) values($1,$2,1,'2026-08-01',4000),($1,$2,2,'2099-09-09',6000)",[T,INVOICE]);
 await seedPayment(db,4000);await seedEnrollment(db);
 await db.query("update accounting_core.payment_schedules set due_date='2026-08-09' where installment_number=2");
 const access=()=>call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:ENROLLMENT,p_as_of:'2026-09-20T12:00Z'});
 assert.equal((await access()).trainingAllowed,false);
 await enable(db);const governed=await access();assert.equal(governed.trainingAllowed,true);assert.equal(governed.financialStatus,'overdue');
 assert.equal(governed.certificationAllowed,false);assert.equal(governed.outstandingMinor,6000);
 await db.query("update academy.enrollments set status='active' where id=$1",[ENROLLMENT]);
 await db.query("update academy.enrollments set metadata='{"+'"trainingJourneyDeferred":true'+"}' where id=$1",[ENROLLMENT]);
 assert.equal((await access()).trainingAllowed,false);
});

test('48-hour closure waits for attendance, then closes once; manager reopening stays under manual review',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);await pay(db);
 await db.query("update academy.enrollments set enrolled_at=now()-interval '10 days'");
 await db.query("update academy.course_runs set status='in_progress',starts_at=now()-interval '9 days',ends_at=now()-interval '3 days' where id=$1",[RUN]);
 const session=id(903);await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,status) values($1,$2,$3,1,'Session',now()-interval '5 days',now()-interval '4 days','hybrid','completed')",[session,T,RUN]);
 const close=()=>call(db,'private_app.process_course_run_closure_v1',{p_limit:100});
 assert.equal((await close()).waiting,1);assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,0);
 assert.equal((await db.query('select status from academy.course_runs where id=$1',[RUN])).rows[0].status,'in_progress');
 await db.query("insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status) select $1,$2,$3,id,'present' from academy.enrollments where handoff_id=$4",[T,RUN,session,HANDOFF]);
 assert.equal((await close()).closed,1);assert.equal((await close()).closed,0);
 assert.equal((await db.query('select status from work_core.tasks where task_key=$1',['course-run-close-'+RUN])).rows[0].status,'completed');
 await action(db,'reopen_run',{courseRunId:RUN,reason:'Review a documented academic issue'});
 assert.equal((await close()).closed,0);assert.equal((await db.query('select status from academy.course_runs where id=$1',[RUN])).rows[0].status,'in_progress');
 await action(db,'close_run',{courseRunId:RUN,reason:'Review completed and closure approved'});
 assert.equal((await db.query('select status from academy.course_runs where id=$1',[RUN])).rows[0].status,'completed');
});

test('linked invoice total cannot be silently reduced by a price agreement',async t=>{
 const db=await setup();t.after(()=>db.close());await enable(db);
 await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
 await db.query("insert into academy.admission_commercial_terms(tenant_id,handoff_id,course_id,amount_minor,currency,reason,approved_by_subject_id) values($1,$2,$3,5000,'SAR','Discount agreement without accounting credit',$4)",[T,HANDOFF,COURSE,ADMIN]);
 await pay(db,5000);
 assert.equal((await readiness(db)).waitingReason,'commercial_terms_invoice_mismatch');
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
});
