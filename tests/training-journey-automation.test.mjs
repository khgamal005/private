import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, read, call, login, count, id, seedPayment, seedEnrollment,
  T, OTHER, ADMIN, STAFF, INSTRUCTOR, INSTRUCTOR_AUTH, HANDOFF, ACCOUNT, INVOICE, PAYMENT,
  CONTACT, COURSE, RUN, ENROLLMENT } from './fixtures/training-journey-database.mjs';

let sequence=5000;
const migration='../../supabase/migrations/20260916170707_training_journey_automation_v1.sql';
const sweep=(db,dry=false,limit=50)=>call(db,'public.v1_training_journey_sweep',{p_limit:limit,p_dry_run:dry});
const settings=(db,action='snapshot',payload={})=>call(db,'public.v3_training_automation_settings_action',{p_slug:'marktone',p_action:action,p_payload:payload});
const configuredPayload=(extra={})=>({commandId:id(sequence++),enabled:true,admissionsStaffId:STAFF,financeStaffId:STAFF,escalationStaffId:STAFF,...extra});
async function automationDb(t){
 const db=await setup({learning:true});t.after(()=>db.close());
 try{await db.exec(await read(migration));}catch(error){delete error.query;throw error;}
 return db;
}
async function prepared(db){
 await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[T]);
 await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
 await seedPayment(db);
}

test('automation is inert by default, scoped to Marktone and configured only by authorized management',async t=>{
 const db=await automationDb(t);
 assert.equal((await sweep(db)).reason,'disabled');
 await prepared(db);
 assert.equal((await settings(db)).enabled,false);
 assert.equal((await sweep(db)).checkedCount,0);
 assert.equal(await count(db,'work_core.tasks'),0);
 const before=await count(db,'academy.training_journey_events');
 const preview=await settings(db,'preview');
 assert.equal(preview.dryRun,true);assert.equal(preview.actionableCount,1);
 assert.equal(await count(db,'work_core.tasks'),0);assert.equal(await count(db,'academy.training_journey_events'),before);
 await login(db,INSTRUCTOR_AUTH);await assert.rejects(settings(db,'update',configuredPayload()),/forbidden/);
 await login(db);await assert.rejects(settings(db,'update',configuredPayload({financeStaffId:id(999)})),/training_responsible_staff_required/);
 const foreign=await call(db,'private_app.training_automation_staff_active_v1',{p_tenant_id:OTHER,p_staff_id:STAFF});assert.equal(foreign,false);
 const payload=configuredPayload();assert.equal((await settings(db,'update',payload)).enabled,true);
 assert.deepEqual(await settings(db,'update',payload),await settings(db));
 await db.query("select set_config('fixture.addon','no',false)");assert.equal((await sweep(db)).reason,'disabled');
 assert.equal(await count(db,'work_core.tasks'),0);
 const grants=(await db.query("select has_function_privilege('authenticated','public.v1_training_journey_sweep(integer,boolean)','EXECUTE') auth,has_function_privilege('anon','public.v1_training_journey_sweep(integer,boolean)','EXECUTE') anon,has_function_privilege('service_role','public.v1_training_journey_sweep(integer,boolean)','EXECUTE') service")).rows[0];
 assert.deepEqual(grants,{auth:false,anon:false,service:true});
});

test('paid handoff produces one canonical task; retry dedupes; admission closes it without touching sales task or other tenants',async t=>{
 const db=await automationDb(t);await prepared(db);await settings(db,'update',configuredPayload());
 await db.query("insert into work_core.tasks(tenant_id,task_key,title,assigned_staff_id,contact_id,due_at,metadata) values($1,'sales-existing','Sales follow-up',$2,$3,now()+interval '1 day','{\"source\":\"sales_followup\"}')",[T,STAFF,CONTACT]);
 await db.query("insert into work_core.tasks(tenant_id,task_key,title,due_at) values($1,'foreign-existing','Foreign preserved',now()+interval '1 day')",[OTHER]);
 const foreignBefore=(await db.query('select to_jsonb(t) row from work_core.tasks t where tenant_id=$1',[OTHER])).rows;
 const result=await sweep(db);assert.equal(result.changedCount,1);assert.equal(result.notificationCount,1);
 const task=(await db.query("select * from work_core.tasks where task_key=$1",['training-clearance-'+HANDOFF])).rows[0];
 assert.equal(task.metadata.source,'training_journey');assert.equal(task.metadata.actionType,'custom');assert.equal(task.created_by_subject_id,null);
 const due=(await db.query("select (($1::timestamptz at time zone 'Asia/Riyadh')::time)::text local_time",[task.due_at])).rows[0].local_time;assert.equal(due,'17:00:00');
 assert.equal((await sweep(db)).changedCount,0);assert.equal((await sweep(db)).notificationCount,0);assert.equal(await count(db,'work_core.notifications'),1);
 const systemEvent=(await db.query("select actor_subject_id,payload->>'actorType' actor_type from academy.training_journey_events where event_type='automation.sweep'")).rows[0];assert.deepEqual(systemEvent,{actor_subject_id:null,actor_type:'system'});
 await seedEnrollment(db);assert.equal((await sweep(db)).changedCount,1);
 assert.equal((await db.query('select status from work_core.tasks where id=$1',[task.id])).rows[0].status,'completed');
 assert.equal((await db.query("select status from work_core.tasks where task_key='sales-existing'")).rows[0].status,'todo');
 assert.deepEqual((await db.query('select to_jsonb(t) row from work_core.tasks t where tenant_id=$1',[OTHER])).rows,foreignBefore);
});

test('installment grace reminders advance once to overdue and settle, and inactive assignees are never used',async t=>{
 const db=await automationDb(t);await prepared(db);await seedEnrollment(db);await settings(db,'update',configuredPayload());
 await db.query("update academy.training_financial_links set policy='installments' where tenant_id=$1",[T]);
 await db.query('update accounting_core.payment_allocations set amount_minor=5000 where tenant_id=$1',[T]);
 await db.query('update accounting_core.payments set amount_minor=5000 where id=$1',[PAYMENT]);
 await db.query("insert into accounting_core.payment_schedules(tenant_id,invoice_id,installment_number,due_date,amount_minor) values($1,$2,1,(now() at time zone 'Asia/Riyadh')::date-10,5000),($1,$2,2,(now() at time zone 'Asia/Riyadh')::date-1,5000)",[T,INVOICE]);
 assert.equal((await sweep(db)).actionableCount,1);
 let task=(await db.query("select * from work_core.tasks where task_key=$1",['training-clearance-'+HANDOFF])).rows[0];assert.match(task.metadata.automationMilestone,/^grace_period:/);
 await db.query("update accounting_core.payment_schedules set due_date=(now() at time zone 'Asia/Riyadh')::date-8 where installment_number=2 and tenant_id=$1",[T]);
 assert.equal((await sweep(db)).notificationCount,1);assert.equal((await sweep(db)).notificationCount,0);
 task=(await db.query('select * from work_core.tasks where id=$1',[task.id])).rows[0];assert.match(task.metadata.automationMilestone,/^overdue:/);
 await db.query("update people.staff_profiles set employment_status='inactive' where id=$1",[STAFF]);
 assert.equal((await sweep(db)).missingAssigneeCount,1);assert.equal(await count(db,'work_core.notifications'),2);
 await db.query("update people.staff_profiles set employment_status='active' where id=$1",[STAFF]);
 await db.query('update accounting_core.payments set amount_minor=10000 where id=$1',[PAYMENT]);await db.query('update accounting_core.payment_allocations set amount_minor=10000 where tenant_id=$1',[T]);
 assert.equal((await sweep(db)).changedCount,1);
 assert.equal((await db.query('select status from work_core.tasks where id=$1',[task.id])).rows[0].status,'completed');
});

test('grading follows assigned instructor, escalates stale work once and closes after a grade',async t=>{
 const db=await automationDb(t);await prepared(db);await seedEnrollment(db);
 const lecturerStaff=id(9000);
 await db.query("insert into people.staff_profiles(id,tenant_id,membership_id,full_name,job_title,role_key) values($1,$2,$3,'Lecturer fixture','Lecturer','instructor')",[lecturerStaff,T,id(24)]);
 await settings(db,'update',configuredPayload());
 const version=(await call(db,'public.v1_training_learning_action',{p_tenant_slug:'marktone',p_action:'save_draft',p_command_id:id(sequence++),p_payload:{courseId:COURSE,title:'Automation version',learningMode:'self_paced',policy:{minAttendancePercent:75,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:true,termsVersion:'2026-09',supportEmail:'support@example.test'},units:[{title:'Assignment fixture',kind:'assignment',body:'Write your answer'}]}})).versionId;
 await call(db,'public.v1_training_learning_action',{p_tenant_slug:'marktone',p_action:'publish_version',p_command_id:id(sequence++),p_payload:{versionId:version,humanReviewed:true}});
 await call(db,'public.v1_training_learning_action',{p_tenant_slug:'marktone',p_action:'assign_version',p_command_id:id(sequence++),p_payload:{versionId:version,enrollmentId:ENROLLMENT}});
 await db.query('insert into academy.training_run_instructors(tenant_id,run_id,subject_id,assigned_by_subject_id) values($1,$2,$3,$4)',[T,RUN,INSTRUCTOR,ADMIN]);
 const unit=(await db.query('select id from academy.training_units where version_id=$1',[version])).rows[0].id,submission=id(9001);
 await db.query("insert into academy.training_submissions(id,tenant_id,enrollment_id,version_id,unit_id,attempt,body,submitted_by_subject_id,submitted_at) values($1,$2,$3,$4,$5,1,'Fixture answer',$6,now()-interval '5 days')",[submission,T,ENROLLMENT,version,unit,ADMIN]);
 let result=await sweep(db);assert.equal(result.actionableCount,1);assert.equal(result.notificationCount,2);
 const task=(await db.query('select * from work_core.tasks where task_key=$1',['training-grading-'+submission])).rows[0];assert.equal(task.assigned_staff_id,lecturerStaff);
 assert.equal((await sweep(db)).notificationCount,0);
 await db.query("insert into academy.training_grades(tenant_id,submission_id,score,feedback,graded_by_subject_id) values($1,$2,85,'Reviewed fixture',$3)",[T,submission,INSTRUCTOR]);
 result=await sweep(db);assert.equal(result.changedCount,1);assert.equal((await db.query('select status from work_core.tasks where id=$1',[task.id])).rows[0].status,'completed');
});

test('a cursor bounds each scheduled transaction at fifty and visits the next source page',async t=>{
 const db=await automationDb(t);await prepared(db);await settings(db,'update',configuredPayload());
 for(let n=0;n<52;n++){
  const handoff=id(10000+n);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id) values($1::uuid,$2,$1::uuid::text,$3,$4)",[handoff,T,CONTACT,COURSE]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,handoff,INVOICE,ACCOUNT,ADMIN]);
 }
 const first=await sweep(db,false,500);assert.equal(first.checkedCount,50);assert.equal(first.changedCount,50);
 const second=await sweep(db);assert.equal(second.checkedCount,3);assert.equal(second.changedCount,3);
 assert.equal(await count(db,'work_core.tasks'),53);
 assert.equal((await sweep(db)).changedCount,0);
});

test('existing learner-request tasks are reused and their original notification is not sent twice',async t=>{
 const db=await automationDb(t);await prepared(db);await seedEnrollment(db);await settings(db,'update',configuredPayload());
 const request=await call(db,'private_app.training_journey_request_v1',{p_tenant_id:T,p_enrollment_id:ENROLLMENT,p_kind:'defer',p_reason:'Fixture schedule conflict',p_staff_id:STAFF});
 assert.equal(await count(db,'work_core.tasks'),1);assert.equal(await count(db,'work_core.notifications'),1);
 assert.equal((await sweep(db)).actionableCount,1);
 assert.equal(await count(db,'work_core.tasks'),1);assert.equal(await count(db,'work_core.notifications'),1);
 await db.query("update academy.training_journey_requests set status='rejected',decided_by_subject_id=$2,decided_at=now(),decision_reason='Fixture decline' where id=$1",[request.requestId,ADMIN]);
 assert.equal((await sweep(db)).changedCount,1);
 assert.equal((await db.query('select status from work_core.tasks where id=$1',[request.taskId])).rows[0].status,'completed');
});
