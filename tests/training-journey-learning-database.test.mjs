import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { setup, call, login, count, id, seedPayment, seedEnrollment,
  T, ADMIN, ADMIN_AUTH, INSTRUCTOR, INSTRUCTOR_AUTH, LEARNER_AUTH, HANDOFF, ACCOUNT, INVOICE,
  COURSE, FOREIGN_COURSE, RUN, STUDENT, ENROLLMENT, PAYMENT,
} from './fixtures/training-journey-database.mjs';

let sequence=2000;
const action=(db,p_action,p_payload,p_command_id=id(sequence++))=>call(db,'public.v1_training_learning_action',{p_tenant_slug:'marktone',p_action,p_command_id,p_payload});
const snapshot=(db,p_role='learner',p_enrollment_id=ENROLLMENT)=>call(db,'public.v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role,p_enrollment_id});
const policy={minAttendancePercent:75,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:true,termsVersion:'2026-09',supportEmail:'support@example.test'};
const draft={courseId:COURSE,title:'Fixture version',learningMode:'self_paced',policy,units:[
  {title:'First lesson',kind:'text',body:'Read and acknowledge the first lesson.',minimumSeconds:30},
  {title:'Knowledge quiz',kind:'quiz',maxAttempts:2,questions:[{id:'q1',prompt:'Which option is correct?',options:['Wrong option','Correct option'],correctOptionIndex:1}]},
  {title:'Practical assignment',kind:'assignment',body:'Write your practical response.'},
]};
const tokenHash=createHash('sha256').update('fixture-token-never-a-real-invitation').digest('hex');

async function prepared(db){
  await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[T]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
  await seedPayment(db);await seedEnrollment(db);
  return (await action(db,'save_draft',draft)).versionId;
}
async function publishBindInvite(db,versionId){
  await action(db,'publish_version',{versionId,humanReviewed:true});
  await action(db,'assign_version',{versionId,enrollmentId:ENROLLMENT});
  const expiresAt=(await db.query("select (now()+interval '1 day')::text expiry")).rows[0].expiry;
  await action(db,'issue_invitation',{studentId:STUDENT,email:'learner@example.test',tokenHash,expiresAt});
  await action(db,'assign_instructor',{runId:RUN,subjectId:INSTRUCTOR});
  await login(db,LEARNER_AUTH);await action(db,'accept_invitation',{tokenHash});
  return (await db.query('select * from academy.training_units where version_id=$1 order by position',[versionId])).rows;
}

test('published course → invited learner → scored work → authorized grade → certificate uses canonical records',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());
  const versionId=await prepared(db);
  await t.test('publishing requires explicit human review',async()=>{
    await assert.rejects(action(db,'publish_version',{versionId,humanReviewed:false}),/training_human_review_required/);
    assert.equal((await db.query('select status from academy.training_course_versions where id=$1',[versionId])).rows[0].status,'draft');
  });
  const units=await publishBindInvite(db,versionId),[lesson,quiz,assignment]=units;
  await t.test('learner bootstrap creates no staff membership and cannot enter management',async()=>{
    const studentSubject=(await db.query('select id from access_control.subjects where auth_user_id=$1',[LEARNER_AUTH])).rows[0].id;
    assert.equal((await db.query('select count(*)::int n from access_control.memberships where subject_id=$1',[studentSubject])).rows[0].n,0);
    await assert.rejects(action(db,'save_draft',draft),/training_permission_denied/);
    await assert.rejects(snapshot(db,'manager'),/training_permission_denied/);
    const own=await snapshot(db);
    assert.equal(own.enrollments.length,1);assert.equal(own.enrollments[0].id,ENROLLMENT);
    assert.equal(JSON.stringify(own).includes('correctOptionIndex'),false);
  });
  await t.test('invitation is single use even with a different command',async()=>{
    await assert.rejects(action(db,'accept_invitation',{tokenHash}),/training_invitation_already_used/);
    assert.equal(await count(db,'academy.training_learner_accounts'),1);
  });
  await t.test('sequence and minimum study interval cannot be bypassed by the client',async()=>{
    await assert.rejects(action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:quiz.id}),/training_previous_units_required/);
    await action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:lesson.id});
    await assert.rejects(action(db,'complete_unit',{enrollmentId:ENROLLMENT,unitId:lesson.id}),/training_unit_review_required/);
    await db.query("update academy.training_unit_progress set opened_at=now()-interval '31 seconds' where unit_id=$1",[lesson.id]);
    await action(db,'complete_unit',{enrollmentId:ENROLLMENT,unitId:lesson.id});
  });
  await t.test('financial suspension preserves reviewed content while blocking new learning and meeting links',async()=>{
    await db.query("update accounting_core.payments set status='refunded' where id=$1",[PAYMENT]);
    assert.equal((await action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:lesson.id})).unit.id,lesson.id);
    await assert.rejects(action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:quiz.id}),/training_financial_access_suspended/);
    await db.query("insert into academy.course_run_sessions(tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,venue_or_link) values($1,$2,1,'Future session',now()+interval '1 day',now()+interval '2 days','online','https://example.test/private-session')",[T,RUN]);
    const view=await snapshot(db);assert.equal(view.enrollments[0].sessions[0].joinUrl,null);
    assert.equal(view.enrollments[0].progress.completedUnits,1);
    await db.query("update accounting_core.payments set status='verified' where id=$1",[PAYMENT]);
  });
  await t.test('quiz never exposes answer key and ignores forged score',async()=>{
    const opened=await action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:quiz.id});
    assert.equal(JSON.stringify(opened).includes('correctOptionIndex'),false);
    const wrong=await action(db,'submit_quiz',{enrollmentId:ENROLLMENT,unitId:quiz.id,answers:{q1:0},score:100,passed:true});
    assert.equal(wrong.score,0);assert.equal(wrong.passed,false);
    await assert.rejects(action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:assignment.id}),/training_previous_units_required/);
    const command=id(sequence++),payload={enrollmentId:ENROLLMENT,unitId:quiz.id,answers:{q1:1}};
    assert.equal((await action(db,'submit_quiz',payload,command)).score,100);
    assert.equal((await action(db,'submit_quiz',payload,command)).score,100);
    assert.equal(await count(db,'academy.training_quiz_attempts'),2);
    await assert.rejects(action(db,'submit_quiz',payload),/training_attempts_exhausted/);
  });
  let submissionId;
  await t.test('submitted assignment stays incomplete until assigned instructor passes it',async()=>{
    await action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:assignment.id});
    submissionId=(await action(db,'submit_assignment',{enrollmentId:ENROLLMENT,unitId:assignment.id,body:'My practical response.'})).submissionId;
    await assert.rejects(action(db,'grade_assignment',{submissionId,score:100,feedback:'Forged grade'}),/training_instructor_assignment_required/);
    await login(db,ADMIN_AUTH);await assert.rejects(action(db,'grade_assignment',{submissionId,score:100,feedback:'Manager without assignment'}),/training_instructor_assignment_required/);
    await assert.rejects(action(db,'issue_certificate',{enrollmentId:ENROLLMENT}),/training_certificate_not_eligible/);
    await login(db,INSTRUCTOR_AUTH);await action(db,'grade_assignment',{submissionId,score:69,feedback:'Needs improvement'});
    const eligibility=await call(db,'private_app.training_eligibility',{p_enrollment_id:ENROLLMENT});assert.equal(eligibility.eligible,false);
    await action(db,'grade_assignment',{submissionId,score:85,feedback:'Passed after review'});
    assert.equal((await call(db,'private_app.training_eligibility',{p_enrollment_id:ENROLLMENT})).eligible,true);
  });
  await t.test('staff membership revocation invalidates an existing instructor assignment',async()=>{
    await db.query("update access_control.memberships set status='suspended' where subject_id=$1",[INSTRUCTOR]);
    await assert.rejects(action(db,'grade_assignment',{submissionId,score:100,feedback:'Revoked instructor'}),/training_instructor_assignment_required/);
    await db.query("update access_control.memberships set status='active' where subject_id=$1",[INSTRUCTOR]);
  });
  await t.test('instructor and sponsored learner views never disclose shared invoice totals',async()=>{
    const view=await snapshot(db,'instructor');
    for(const key of ['paidMinor','totalMinor','outstandingMinor','invoiceId']) assert.equal(JSON.stringify(view).includes(`"${key}"`),false,key);
    await db.query('update academy.training_financial_links set sponsor=true where handoff_id=$1',[HANDOFF]);
    await login(db,LEARNER_AUTH);
    const own=await snapshot(db,'learner');
    for(const key of ['paidMinor','totalMinor','outstandingMinor','invoiceId']) assert.equal(JSON.stringify(own).includes(`"${key}"`),false,key);
    await login(db,ADMIN_AUTH);await db.query('update academy.training_financial_links set sponsor=false where handoff_id=$1',[HANDOFF]);
  });
  await t.test('certificate persists canonical evidence and does not create another enrollment',async()=>{
    await login(db,ADMIN_AUTH);const command=id(sequence++),payload={enrollmentId:ENROLLMENT};
    const issued=await action(db,'issue_certificate',payload,command);
    assert.deepEqual(await action(db,'issue_certificate',payload,command),issued);
    assert.equal(await count(db,'academy.certificates'),1);assert.equal(await count(db,'academy.enrollments'),1);
    const c=(await db.query('select * from academy.certificates')).rows[0];
    assert.equal(c.id,issued.certificateId);assert.equal(c.metadata.trainingJourneyEvidence.versionId,versionId);
    assert.equal((await db.query('select status from academy.enrollments')).rows[0].status,'completed');
  });
  await t.test('published versions and enrolled version pins are immutable',async()=>{
    await assert.rejects(db.query("update academy.training_units set body='Changed after publication' where id=$1",[lesson.id]),/training_published_version_immutable/);
    await assert.rejects(action(db,'save_draft',{...draft,versionId}),/training_draft_required/);
    const next=(await action(db,'save_draft',{...draft,title:'Next version'})).versionId;await action(db,'publish_version',{versionId:next,humanReviewed:true});
    await assert.rejects(action(db,'assign_version',{enrollmentId:ENROLLMENT,versionId:next}),/training_enrollment_version_immutable/);
    assert.equal((await db.query('select version_id from academy.training_enrollment_versions')).rows[0].version_id,versionId);
  });
  await t.test('default management snapshot is metadata-only; explicit editor fetch includes content',async()=>{
    const compact=await snapshot(db,'manager');assert.equal(JSON.stringify(compact).includes('Read and acknowledge the first lesson.'),false);
    const editor=await call(db,'public.v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'manager',p_course_id:COURSE});
    assert.equal(JSON.stringify(editor).includes('Read and acknowledge the first lesson.'),true);
  });
});

test('learner and legacy issuance boundaries block cross-tenant content and certificates without completed learning',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());const versionId=await prepared(db);const [lesson]=await publishBindInvite(db,versionId);
  await t.test('learner cannot read a different enrollment or obtain privileged tables',async()=>{
    await assert.rejects(action(db,'open_unit',{enrollmentId:id(999),unitId:lesson.id}),/training_permission_denied/);
    await db.exec('set role authenticated');
    try{await assert.rejects(db.query('select * from academy.training_units'),/permission denied/);}finally{await db.exec('reset role');}
  });
  await t.test('manager cannot import a foreign tenant course into the pilot',async()=>{
    await login(db,ADMIN_AUTH);await assert.rejects(action(db,'save_draft',{...draft,courseId:FOREIGN_COURSE}),/training_course_not_found/);
  });
  await t.test('old public issuance RPC consumes the same learning gate',async()=>{
    await assert.rejects(call(db,'public.v2_tenant_update_training_operation',{p_tenant_slug:'marktone',p_action:'issue_certificate',p_enrollment_id:ENROLLMENT}),/certificate_not_eligible/);
    assert.equal(await count(db,'academy.certificates'),0);
  });
  await t.test('even direct canonical certificate insertion cannot bypass the gate',async()=>{
    await assert.rejects(db.query("insert into academy.certificates(tenant_id,course_run_id,enrollment_id,certificate_number,verification_code) values($1,$2,$3,'FORGED','forged-fixture')",[T,RUN,ENROLLMENT]),/training_certificate_not_eligible/);
  });
});

test('invitation requires confirmed matching auth email and never binds from user metadata',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());const versionId=await prepared(db);
  await action(db,'publish_version',{versionId,humanReviewed:true});await action(db,'assign_version',{versionId,enrollmentId:ENROLLMENT});
  const expiresAt=(await db.query("select (now()+interval '1 day')::text expiry")).rows[0].expiry;
  await action(db,'issue_invitation',{studentId:STUDENT,email:'learner@example.test',tokenHash,expiresAt});
  await login(db,LEARNER_AUTH);
  await db.query("update auth.users set email_confirmed_at=null,raw_user_meta_data='{"+'"email":"learner@example.test","email_verified":true'+"}' where id=$1",[LEARNER_AUTH]);
  await assert.rejects(action(db,'accept_invitation',{tokenHash}),/training_invitation_invalid/);
  await db.query("update auth.users set email='attacker@example.test',email_confirmed_at=now() where id=$1",[LEARNER_AUTH]);
  await assert.rejects(action(db,'accept_invitation',{tokenHash}),/training_invitation_invalid/);
  await db.query("update auth.users set email='learner@example.test' where id=$1",[LEARNER_AUTH]);
  await db.query("update academy.students set email='replacement@example.test' where id=$1",[STUDENT]);
  await assert.rejects(action(db,'accept_invitation',{tokenHash}),/training_invitation_invalid/);
  assert.equal(await count(db,'academy.training_learner_accounts'),0);
  assert.equal((await db.query('select count(*)::int n from access_control.subjects where auth_user_id=$1',[LEARNER_AUTH])).rows[0].n,0);
});

test('invitation activation serializes service claims and grants no client execution',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await prepared(db);
  const expiresAt=(await db.query("select (now()+interval '1 day')::text expiry")).rows[0].expiry;
  await action(db,'issue_invitation',{studentId:STUDENT,email:'learner@example.test',tokenHash,expiresAt});
  const claimId=id(6010),claim=(id=claimId,p_action='claim')=>call(db,'public.v1_training_invitation_activation',{p_token_hash:tokenHash,p_claim_id:id,p_action});
  for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_function_privilege($1,'public.v1_training_invitation_activation(text,uuid,text)','EXECUTE') ok",[role])).rows[0].ok,false);
  await assert.rejects(claim(),/training_service_role_required/);
  await db.query("select set_config('fixture.jwt_role','service_role',false)");
  assert.equal((await claim()).email,'learner@example.test');
  await assert.rejects(claim(),/training_activation_in_progress/);
  await assert.rejects(claim(id(6011)),/training_activation_in_progress/);
  await assert.rejects(claim(id(6011),'release'),/training_activation_claim_invalid/);
  assert.equal((await claim(claimId,'release')).released,true);
  assert.equal((await claim(id(6011))).tenantSlug,'marktone');
});

test('omitted invitation expiry defaults once and replay preserves the issued expiration',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await prepared(db);
  const command=id(sequence++),payload={studentId:STUDENT,email:'learner@example.test',tokenHash};
  const first=await action(db,'issue_invitation',payload,command),again=await action(db,'issue_invitation',payload,command);
  assert.ok(first.expiresAt);assert.deepEqual(again,first);assert.equal(await count(db,'academy.training_invitations'),1);
  const duration=(await db.query('select extract(epoch from expires_at-created_at)::int seconds from academy.training_invitations')).rows[0].seconds;
  assert.equal(duration,7*24*60*60);
});

test('publication rejects missing numeric policy and malformed answer keys atomically',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await prepared(db);
  for(const [label,value] of [
    ['null assessment threshold',{...draft,policy:{...policy,minAssessmentPercent:null}}],
    ['string attendance threshold',{...draft,policy:{...policy,minAttendancePercent:'75'}}],
    ['null correct answer',{...draft,units:[{...draft.units[1],questions:[{...draft.units[1].questions[0],correctOptionIndex:null}]}]}],
    ['decimal correct answer',{...draft,units:[{...draft.units[1],questions:[{...draft.units[1].questions[0],correctOptionIndex:0.5}]}]}],
  ]) await t.test(label,async()=>{
    const versionId=(await action(db,'save_draft',value)).versionId;
    const before=await count(db,'academy.training_journey_commands');
    await assert.rejects(action(db,'publish_version',{versionId,humanReviewed:true}),/training_policy_review_required|training_quiz_options_invalid/);
    assert.equal((await db.query('select status from academy.training_course_versions where id=$1',[versionId])).rows[0].status,'draft');
    assert.equal(await count(db,'academy.training_journey_commands'),before);
  });
});

test('learner cohort transfer preserves exact-version evidence and one financial source without rewriting history',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());const versionId=await prepared(db);const [lesson]=await publishBindInvite(db,versionId);
  await action(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:lesson.id});
  await db.query("update academy.training_unit_progress set opened_at=now()-interval '31 seconds' where unit_id=$1",[lesson.id]);
  await action(db,'complete_unit',{enrollmentId:ENROLLMENT,unitId:lesson.id});
  const originalProgress=(await db.query('select opened_at,completed_at,completed_by_subject_id from academy.training_unit_progress')).rows[0];
  const targetRun=id(7000);
  await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity) values($1,$2,$3,'TRANSFER-RUN','Target cohort','hybrid','open',10)",[targetRun,T,COURSE]);
  const request=await call(db,'public.v1_tenant_training_journey_action',{p_slug:'marktone',p_action:'create_request',p_payload:{commandId:id(sequence++),enrollmentId:ENROLLMENT,kind:'transfer',targetRunId:targetRun,reason:'I need the next cohort'}});
  assert.ok(request.requestId);
  await assert.rejects(call(db,'public.v1_tenant_training_journey_action',{p_slug:'marktone',p_action:'decide_request',p_payload:{commandId:id(sequence++),requestId:request.requestId,decision:'approve',reason:'Learner forged approval'}}),/forbidden/);
  await login(db,ADMIN_AUTH);
  const approved=await call(db,'public.v1_tenant_training_journey_action',{p_slug:'marktone',p_action:'decide_request',p_payload:{commandId:id(sequence++),requestId:request.requestId,decision:'approve',reason:'Operations approve same course transfer'}});
  assert.ok(approved.newEnrollmentId);assert.notEqual(approved.newEnrollmentId,ENROLLMENT);
  assert.equal((await db.query('select status from academy.enrollments where id=$1',[ENROLLMENT])).rows[0].status,'withdrawn');
  const newVersion=(await db.query('select version_id from academy.training_enrollment_versions where enrollment_id=$1',[approved.newEnrollmentId])).rows[0].version_id;assert.equal(newVersion,versionId);
  const copied=(await db.query('select opened_at,completed_at,completed_by_subject_id from academy.training_unit_progress where enrollment_id=$1',[approved.newEnrollmentId])).rows[0];assert.deepEqual(copied,originalProgress);
  assert.equal(await count(db,'accounting_core.payments'),1);assert.equal(await count(db,'accounting_core.payment_allocations'),1);assert.equal(await count(db,'accounting_core.sales_documents'),1);
  const sourceTotal=(await db.query('select sum(payment_amount_minor)::int total from academy.registration_handoffs')).rows[0].total;assert.equal(sourceTotal,10000);
  assert.equal(await count(db,'academy.students'),1);assert.equal(await count(db,'academy.enrollments'),2);
});

test('hidden self-paced delivery cannot be pinned to a live or blended content version',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());await prepared(db);
  await db.query("update academy.course_runs set metadata='{"+'"trainingJourneySelfpaced":true,"hiddenDeliveryRun":true'+"}' where id=$1",[RUN]);
  const versionId=(await action(db,'save_draft',{...draft,learningMode:'live'})).versionId;
  await action(db,'publish_version',{versionId,humanReviewed:true});
  await assert.rejects(action(db,'assign_version',{enrollmentId:ENROLLMENT,versionId}),/training_.*mode|training_.*self.*paced/);
  assert.equal(await count(db,'academy.training_enrollment_versions'),0);
});

test('all newly stored learning and journey evidence denies direct anonymous and authenticated table access',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());
  const tables=(await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='academy' and c.relkind='r' and (c.relname like 'training_journey_%' or c.relname in ('training_financial_links','training_course_versions','training_units','training_enrollment_versions','training_learner_accounts','training_invitations','training_run_instructors','training_unit_progress','training_quiz_attempts','training_submissions','training_grades','training_learning_events'))")).rows;
  assert.ok(tables.length>=16);
  for(const table of tables){
    assert.equal(table.relrowsecurity,true,table.relname);
    for(const role of ['anon','authenticated']){
      const privileges=(await db.query("select has_table_privilege($1,$2,'SELECT, INSERT, UPDATE, DELETE') allowed",[role,'academy.'+table.relname])).rows[0].allowed;
      assert.equal(privileges,false,`${role} ${table.relname}`);
    }
  }
  for(const name of ['public.v1_training_learning_action(text,text,uuid,jsonb)','public.v1_training_learning_snapshot(text,text,uuid,uuid,integer)','public.v1_tenant_training_journey_action(text,text,jsonb)','public.v1_tenant_training_journey_snapshot(text,integer)'])assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') allowed",[name])).rows[0].allowed,false,name);
});
