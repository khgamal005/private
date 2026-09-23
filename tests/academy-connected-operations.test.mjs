import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverySetup,deliveryAction,mediaAction,deliveryCommand,checkoutOffer,checkoutOrder,verificationPayload,storeAction,call,login,T,MANAGER_AUTH,id} from './fixtures/academy-delivery-database.mjs';
import {ADMIN,ADMIN_AUTH,STAFF,CONTACT,STUDENT,COURSE,RUN,HANDOFF,INVOICE,ACCOUNT,LEARNER_AUTH,ACADEMY_INSTRUCTOR,ACADEMY_INSTRUCTOR_AUTH,platformAction} from './fixtures/academy-platform-database.mjs';
const people=(db,p_action,p_payload,p_command_id=deliveryCommand())=>call(db,'public.v1_academy_people_action',{p_slug:'marktone',p_action,p_payload,p_command_id});
const directory=(db,p_kind='students',p_query='',p_offset=0)=>call(db,'public.v1_academy_people_snapshot',{p_slug:'marktone',p_kind,p_query,p_offset});
const training=(db,p_action,p_payload)=>call(db,'public.v1_academy_training_action',{p_slug:'marktone',p_action,p_payload,p_command_id:deliveryCommand()});
const reconcile=(db,orderId)=>call(db,'public.v1_academy_order_reconcile',{p_slug:'marktone',p_order_id:orderId});
const readyAsset=async(db,courseId)=>{
 const asset=await mediaAction(db,'create_upload',{courseId,fileName:'lesson.mp4',mimeType:'video/mp4',sizeBytes:100});
 await db.query("insert into storage.objects(bucket_id,name,metadata) values('academy-course-media',$1,$2)",[asset.objectPath,JSON.stringify({size:100,mimetype:'video/mp4'})]);
 return mediaAction(db,'complete_upload',{assetId:asset.assetId});
};

test('people reuse ODEIR identities and require verified invitation acceptance',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());
 await t.test('existing student is reused without enrollment or cash; conflicting identity is rejected',async()=>{
  const before=(await db.query('select count(*)::int n from academy.students')).rows[0].n;
  const command=deliveryCommand(),payload={name:'Fixture learner',phone:'0501112233',email:'learner@example.test'};
  const result=await people(db,'add_student',payload,command);assert.equal(result.studentId,STUDENT);assert.equal(result.contactId,CONTACT);
  assert.deepEqual(await people(db,'add_student',payload,command),result);
  await assert.rejects(people(db,'add_student',{...payload,name:'Changed'},command),/academy_command_conflict/);
  await assert.rejects(people(db,'add_student',{...payload,email:'other@example.test'}),/academy_identity_review_required/);
  assert.equal((await db.query('select count(*)::int n from academy.students')).rows[0].n,before);
  assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,0);
  assert.equal((await directory(db,'students','Fixture')).rows[0].id,STUDENT);
 });
 let staffId;
 await t.test('new instructor creates a canonical profile, then binds only after confirmed-email acceptance',async()=>{
  const invitation=await people(db,'invite_instructor',{name:'Academy instructor',email:'academy.instructor@example.test',phone:'',tokenHash:'9'.repeat(64)});staffId=invitation.staffId;
  assert.equal((await db.query('select membership_id,account_status from people.staff_profiles where id=$1',[staffId])).rows[0].membership_id,null);
  assert.equal((await directory(db,'instructors')).rows.find(row=>row.id===staffId).invitationPending,true);
  await login(db,ACADEMY_INSTRUCTOR_AUTH);await db.query('update auth.users set email_confirmed_at=null where id=$1',[ACADEMY_INSTRUCTOR_AUTH]);
  await assert.rejects(call(db,'public.v1_academy_membership_accept',{p_slug:'marktone',p_token_hash:'9'.repeat(64)}),/academy_invitation_invalid/);
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[ACADEMY_INSTRUCTOR_AUTH]);
  assert.equal((await call(db,'public.v1_academy_membership_accept',{p_slug:'marktone',p_token_hash:'9'.repeat(64)})).role,'instructor');
  assert.equal((await db.query('select subject_id from academy.instructor_directory where staff_id=$1',[staffId])).rows[0].subject_id,ACADEMY_INSTRUCTOR);
  assert.equal((await db.query('select count(*)::int n from access_control.memberships where subject_id=$1',[ACADEMY_INSTRUCTOR])).rows[0].n,0);
  await assert.rejects(directory(db),/forbidden/);await login(db,MANAGER_AUTH);
 });
 await t.test('directory includes existing platform instructors with no new profile',async()=>{
  await login(db,ADMIN_AUTH);await platformAction(db,'set_member',{email:'instructor@example.test',role:'instructor',status:'active'});await login(db,MANAGER_AUTH);
  const rows=(await directory(db,'instructors')).rows;
  assert.ok(rows.some(row=>row.email==='instructor@example.test'&&row.staffId===null&&row.accountStatus==='active'));
  assert.equal(rows.filter(row=>row.email==='academy.instructor@example.test').length,1);
  const again=await people(db,'invite_instructor',{staffId,name:'Academy instructor',email:'academy.instructor@example.test',phone:'',tokenHash:'8'.repeat(64)});
  assert.equal(again.staffId,staffId);
  await assert.rejects(people(db,'invite_instructor',{name:'Manager',email:'manager@example.test',phone:'',tokenHash:'7'.repeat(64)}),/academy_member_role_conflict/);
 });
 await t.test('course assignment uses the existing scoped instructor contract and canonical Zoom sessions',async()=>{
  const offer=await checkoutOffer(db);
  await deliveryAction(db,'assign_instructor',{courseId:offer.courseId,runId:offer.runId,subjectId:ACADEMY_INSTRUCTOR,active:true});
  await db.query("insert into academy.course_run_sessions(tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,meeting_join_url) values($1,$2,1,'Canonical meeting','2030-01-01T10:00Z','2030-01-01T11:00Z','online','https://zoom.us/j/123456789')",[T,offer.runId]);
  const view=await call(db,'public.v1_academy_course_delivery_snapshot',{p_slug:'marktone',p_course_id:offer.courseId});
  assert.equal(view.runs[0].instructors[0].subjectId,ACADEMY_INSTRUCTOR);assert.equal(view.runs[0].sessions[0].joinUrl,'https://zoom.us/j/123456789');
  await assert.rejects(deliveryAction(db,'assign_instructor',{courseId:COURSE,runId:offer.runId,subjectId:ACADEMY_INSTRUCTOR,active:true}),/invalid_course_run/);
 });
 await t.test('cohort creation is idempotent and writes one canonical run without a second course or offer',async()=>{
  const offer=await checkoutOffer(db),command=deliveryCommand(),payload={courseId:offer.courseId,title:'Evening second cohort',deliveryMode:'online',capacity:25,startsAt:'2030-10-01T16:00:00Z',endsAt:'2030-10-30T18:00:00Z'};
  const result=await deliveryAction(db,'create_run',payload,command);assert.deepEqual(await deliveryAction(db,'create_run',payload,command),result);
  assert.equal((await db.query('select count(*)::int n from academy.course_runs where tenant_id=$1 and course_id=$2',[T,offer.courseId])).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int n from academy.store_offers where tenant_id=$1 and course_id=$2',[T,offer.courseId])).rows[0].n,1);
  await assert.rejects(deliveryAction(db,'create_run',{...payload,endsAt:payload.startsAt}),/academy_cohort_schedule_required/);
 });
 await t.test('disabled rollout, foreign tenants and direct table access fail closed',async()=>{
  await assert.rejects(call(db,'public.v1_academy_people_snapshot',{p_slug:'foreign'}),/academy_not_available/);
  await db.exec('set role authenticated');await assert.rejects(db.query('select * from academy.instructor_directory'),/permission denied/);await db.exec('reset role');
  await db.query('update academy.delivery_settings set enabled=false where tenant_id=$1',[T]);assert.equal((await directory(db)).available,false);
  await assert.rejects(people(db,'add_student',{name:'Denied',phone:'0501231231',email:'denied@example.test'}),/academy_delivery_disabled/);
 });
});

test('connected purchases preserve ownership and converge to one operational follow-up',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());
 await db.query("update academy.platform_settings set mode='connected' where tenant_id=$1",[T]);await login(db,ADMIN_AUTH);
 await db.query("update people.staff_profiles set role_key='sales_manager' where id=$1",[STAFF]);
 await db.query('insert into sales_core.sales_assignment_profiles(tenant_id,staff_id,daily_capacity) values($1,$2,1)',[T,STAFF]);
 await db.query("insert into sales_core.commerce_order_routing_settings values($1,'auto_fair',$2,60)",[T,STAFF]);
 await db.query('insert into academy.training_journey_settings(tenant_id,automation_admissions_staff_id) values($1,$2)',[T,STAFF]);
 const offer=await checkoutOffer(db,{capacity:10});let first;
 const purchase=async number=>{const order=await checkoutOrder(db,offer.offerId,number);await login(db,ADMIN_AUTH);return {order,result:await storeAction(db,'verify_order',verificationPayload(order))};};
 await t.test('new buyer is assigned by the canonical selector and enrollment content is ready',async()=>{
  first=await purchase(888001);
  const row=(await db.query('select * from academy.order_operations where order_id=$1',[first.order.id])).rows[0];assert.equal(row.assigned_staff_id,STAFF);assert.equal(row.routing_state,'assigned');
  assert.equal((await db.query('select owner_staff_id from sales_core.contacts where id=$1',[row.contact_id])).rows[0].owner_staff_id,STAFF);
  assert.equal((await db.query('select count(*)::int n from academy.training_enrollment_versions where enrollment_id=$1',[first.result.enrollmentId])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from work_core.tasks where task_key=$1',['academy-learner-access-'+first.result.enrollmentId])).rows[0].n,1);
 });
 await t.test('daily capacity sends the next buyer to the manager queue and repeated reconciliation duplicates nothing',async()=>{
  const second=await purchase(888002);
  let row=(await db.query('select * from academy.order_operations where order_id=$1',[second.order.id])).rows[0];assert.equal(row.assigned_staff_id,null);assert.equal(row.routing_state,'queue');assert.ok(row.task_id);
  const payments=(await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n;
  await reconcile(db,second.order.id);await reconcile(db,second.order.id);
  assert.equal((await db.query('select count(*)::int n from work_core.tasks where task_key=$1',['academy-order-owner-'+second.order.id])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,payments);
  await db.query('update sales_core.contacts set owner_staff_id=$1 where id=$2',[STAFF,row.contact_id]);await reconcile(db,second.order.id);
  row=(await db.query('select * from academy.order_operations where order_id=$1',[second.order.id])).rows[0];assert.equal(row.assigned_staff_id,STAFF);assert.equal(row.assignment_strategy,'existing_owner');
  assert.equal((await db.query('select status from work_core.tasks where task_key=$1',['academy-order-owner-'+second.order.id])).rows[0].status,'completed');
 });
 await t.test('verified learner binding closes its onboarding task and never changes the pinned version',async()=>{
  const person=(await db.query('select email from academy.students where id=$1',[first.result.studentId])).rows[0];
  const authId=id(148001),subjectId=id(148002);
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[authId,person.email]);
  await db.query('insert into access_control.subjects(id,auth_user_id,email,full_name) values($1,$2,$3,$4)',[subjectId,authId,person.email,'Verified buyer']);
  await people(db,'invite_student',{studentId:first.result.studentId,email:person.email,tokenHash:'6'.repeat(64)});
  await login(db,authId);await training(db,'accept_invitation',{tokenHash:'6'.repeat(64)});await login(db,ADMIN_AUTH);
  assert.equal((await db.query('select status from work_core.tasks where task_key=$1',['academy-learner-access-'+first.result.enrollmentId])).rows[0].status,'completed');
  const before=(await db.query('select version_id from academy.training_enrollment_versions where enrollment_id=$1',[first.result.enrollmentId])).rows[0].version_id;
  await reconcile(db,first.order.id);assert.equal((await db.query('select version_id from academy.training_enrollment_versions where enrollment_id=$1',[first.result.enrollmentId])).rows[0].version_id,before);
 });
 await t.test('an absence blocks new auto-assignment while an existing owner is preserved',async()=>{
  await db.query('update sales_core.sales_assignment_profiles set daily_capacity=50 where staff_id=$1',[STAFF]);
  await db.query('insert into core.tenant_operating_setup(tenant_id,staff_scheduling_enabled) values($1,true)',[T]);
  // No current shift: the real operating availability helper must reject assignment.
  const third=await purchase(888003);assert.equal((await db.query('select routing_state from academy.order_operations where order_id=$1',[third.order.id])).rows[0].routing_state,'queue');
  await reconcile(db,first.order.id);assert.equal((await db.query('select assigned_staff_id from academy.order_operations where order_id=$1',[first.order.id])).rows[0].assigned_staff_id,STAFF);
 });
 await t.test('an operational payment creates a learner enrollment and pins content without a store order',async()=>{
  await db.query('update core.tenant_operating_setup set staff_scheduling_enabled=false where tenant_id=$1',[T]);
  await db.query("update academy.courses set program_kind='short_course' where id=$1",[COURSE]);
  const version=id(148003);
  await db.query("insert into academy.training_course_versions(id,tenant_id,course_id,version,title,learning_mode,status,policy,created_by_subject_id,reviewed_by_subject_id,published_at) values($1,$2,$3,1,'Operational content','live','published','{}',$4,$4,now())",[version,T,COURSE,ADMIN]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
  await db.query('update academy.registration_handoffs set course_run_id=$1 where id=$2',[RUN,HANDOFF]);
  const financial=(p_action,p_payload)=>call(db,'public.v1_tenant_accounting_action',{p_slug:'marktone',p_action,p_payload:{commandId:deliveryCommand(),...p_payload}});
  const payment=await financial('record_payment',{customerAccountId:ACCOUNT,amountMinor:10000,currency:'SAR',method:'cash',verifyNow:true,externalReference:'OPERATIONS-TEST'});
  await financial('allocate_payment',{paymentId:payment.paymentId,invoiceId:INVOICE,amountMinor:10000});
  // The canonical financial allocation queues admission. System processing has no user actor.
  await login(db,null);await call(db,'private_app.process_admission_governance_queue_v1',{p_limit:100});
  const rows=(await db.query('select e.id,p.version_id,p.assignment_source,p.assigned_by_subject_id from academy.enrollments e join academy.training_enrollment_versions p on p.tenant_id=e.tenant_id and p.enrollment_id=e.id where e.handoff_id=$1',[HANDOFF])).rows;
  assert.equal(rows.length,1,JSON.stringify({readiness:await call(db,'private_app.admission_readiness_v1',{p_tenant_id:T,p_handoff_id:HANDOFF}),enrollments:(await db.query('select id,status from academy.enrollments where handoff_id=$1',[HANDOFF])).rows}));assert.equal(rows[0].version_id,version);assert.equal(rows[0].assignment_source,'academy_bridge');assert.equal(rows[0].assigned_by_subject_id,null);
  assert.equal((await db.query('select count(*)::int n from academy.students where contact_id=$1',[CONTACT])).rows[0].n,1);
  await login(db,ADMIN_AUTH);
 });
 await t.test('connected academy managers cannot confirm operational money or assign ownership',async()=>{
  await login(db,MANAGER_AUTH);await assert.rejects(reconcile(db,first.order.id),/forbidden/);
  await login(db,ADMIN_AUTH);await db.query("update academy.platform_settings set mode='standalone' where tenant_id=$1",[T]);
  assert.equal((await reconcile(db,first.order.id)).reason,'standalone');
 });
});

test('private video access follows the exact pinned curriculum, finance and active instructor assignment',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());const offer=await checkoutOffer(db),asset=await readyAsset(db,offer.courseId);
 const view=()=>call(db,'public.v1_academy_media_access',{p_slug:'marktone',p_asset_id:asset.assetId});
 const content=await training(db,'save_draft',{courseId:offer.courseId,title:'Private content',learningMode:'live',policy:{minAttendancePercent:0,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:false,termsVersion:'2026',supportEmail:'support@example.test'},units:[{title:'Private video',kind:'video',url:asset.playbackUrl},{title:'Assessment',kind:'assignment',body:'Summarize the lesson'}]});
 await training(db,'publish_version',{versionId:content.versionId,humanReviewed:true});
 await t.test('storage guards deny arbitrary paths and overwrites even under a broad future policy',async()=>{
  await db.exec("create policy fixture_broad_storage on storage.objects for all to authenticated using(true) with check(true);grant update,delete on storage.objects to authenticated;");
  await db.exec('set role authenticated');
  await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('academy-course-media','arbitrary/path.mp4')"),/row-level security/);
  assert.equal((await db.query("update storage.objects set metadata='{}' where name=$1 returning id",[asset.objectPath])).rows.length,0);
  assert.equal((await db.query('delete from storage.objects where name=$1 returning id',[asset.objectPath])).rows.length,0);await db.exec('reset role');
 });
 await t.test('unassigned and suspended instructors cannot play the video',async()=>{
  await login(db,ADMIN_AUTH);await platformAction(db,'set_member',{email:'academy.instructor@example.test',role:'instructor',status:'active'});await login(db,ACADEMY_INSTRUCTOR_AUTH);
  await assert.rejects(view(),/academy_media_not_found/);await login(db,MANAGER_AUTH);
  await deliveryAction(db,'assign_instructor',{courseId:offer.courseId,runId:offer.runId,subjectId:ACADEMY_INSTRUCTOR,active:true});await login(db,ACADEMY_INSTRUCTOR_AUTH);assert.equal((await view()).allowDownload,false);
  await db.query("update academy.platform_memberships set status='suspended' where tenant_id=$1 and subject_id=$2",[T,ACADEMY_INSTRUCTOR]);await assert.rejects(view(),/academy_media_not_found/);await login(db,MANAGER_AUTH);
 });
 await t.test('eligible learner can play only its course assets; suspended and withdrawn access is denied',async()=>{
  const order=await checkoutOrder(db,offer.offerId,777001);const result=await storeAction(db,'verify_order',verificationPayload(order));
  await people(db,'invite_student',{studentId:result.studentId,email:'race777001@example.test',tokenHash:'5'.repeat(64)});
  await db.query("update auth.users set email='race777001@example.test' where id=$1",[LEARNER_AUTH]);await login(db,LEARNER_AUTH);await training(db,'accept_invitation',{tokenHash:'5'.repeat(64)});
  assert.equal((await view()).allowDownload,false);
  await login(db,MANAGER_AUTH);const otherAsset=await readyAsset(db,offer.courseId);await login(db,LEARNER_AUTH);
  await assert.rejects(call(db,'public.v1_academy_media_access',{p_slug:'marktone',p_asset_id:otherAsset.assetId}),/academy_media_not_found/);
  await db.query("update academy.training_learner_accounts set status='suspended' where student_id=$1",[result.studentId]);await assert.rejects(view(),/academy_media_not_found/);
  await db.query("update academy.training_learner_accounts set status='active' where student_id=$1",[result.studentId]);
  await db.query("update academy.enrollments set status='withdrawn' where id=$1",[result.enrollmentId]);await assert.rejects(view(),/academy_media_not_found/);
 });
});
