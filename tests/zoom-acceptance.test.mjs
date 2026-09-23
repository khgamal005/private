import test from 'node:test';import assert from 'node:assert/strict';
import {zoomSetup,connect,hostFixture,call,id,T,OTHER,RUN,ADMIN,ADMIN_AUTH,INSTRUCTOR,LEARNER_AUTH,login,service,ENROLLMENT,HANDOFF,INVOICE,STUDENT,CONTACT,ACCOUNT} from './fixtures/zoom-database.mjs';
import {seedZoomLesson,grant} from './fixtures/zoom-lesson.mjs';
import {resolveZoomTrainingMessage} from '../supabase/functions/_shared/zoom-message.mjs';
test('ZM-02/03/04 T02/15/16/21: three hosts, known external busy, incomplete coverage and independent batch results',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const connection=(await connect(db)).connectionId,third=id(76000);
 await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'teacher-three@example.test',now())",[id(76001)]);
 await db.query("insert into access_control.subjects(id,auth_user_id,email,full_name) values($1,$2,'teacher-three@example.test','Synthetic third teacher')",[third,id(76001)]);
 await db.query("insert into access_control.memberships(subject_id,tenant_id,scope) values($1,$2,'tenant')",[third,T]);
 const teachers=[ADMIN,INSTRUCTOR,third],users=['host-A','host-B','host-C'];await service(db);
 await call(db,'public.v1_zoom_sync_hosts',{p_connection_id:connection,p_generation:1,p_hosts:users.map(u=>hostFixture('account-A',u)),p_coverage:'complete'});
 const hosts=(await db.query('select id,user_id from zoom_core.hosts order by user_id')).rows;
 for(let n=0;n<3;n++){
  await db.query('update zoom_core.hosts set allowed=true,instructor_subject_id=$1 where id=$2',[teachers[n],hosts[n].id]);
  await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,authorization_kind,verified_at) values($1,$2,$3,$4,'host',now())",[T,hosts[n].id,teachers[n],users[n]]);
  await db.query('insert into academy.training_run_instructors(tenant_id,run_id,subject_id,assigned_by_subject_id) values($1,$2,$3,$4)',[T,RUN,teachers[n],ADMIN]);
 }
 for(let n=0;n<5;n++)await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,$4,'Synthetic capacity test',$5::timestamptz,$5::timestamptz+interval '1 hour','online')",[id(76010+n),T,RUN,n+1,n<3?'2030-01-01T10:00:00Z':n===3?'2030-01-02T10:00:00Z':'2030-01-02T13:00:00Z']);
 await service(db,false);
 for(let n=0;n<3;n++)assert.equal((await call(db,'public.v1_zoom_action',{p_slug:'marktone',p_action:'assign',p_command_id:id(76100+n),p_payload:{sessionId:id(76010+n),instructorId:teachers[n],expectedVersion:0}})).state,'queued');
 assert.deepEqual((await db.query('select host_id from zoom_core.reservations order by host_id')).rows.map(x=>x.host_id).sort(),hosts.map(x=>x.id).sort());
 await service(db);const busy={p_connection_id:connection,p_host_id:hosts[0].id,p_generation:1};
 await call(db,'public.v1_zoom_busy_store',{...busy,p_meetings:[{id:'external-private',start_time:'2030-01-02T10:00:00Z',duration:60,topic:'Private external title'}],p_complete:true});
 await call(db,'public.v1_zoom_busy_store',{...busy,p_meetings:[],p_complete:false});
 assert.equal((await db.query('select capabilities from zoom_core.hosts where id=$1',[hosts[0].id])).rows[0].capabilities.externalBusyCoverage,'partial');assert.equal((await db.query('select count(*)::int n from zoom_core.busy_windows')).rows[0].n,1);
 assert.ok(!JSON.stringify((await db.query('select * from zoom_core.busy_windows')).rows).includes('Private external title'));
 await service(db,false);const args={p_slug:'marktone',p_command_id:id(76200),p_sessions:[3,4].map(n=>({sessionId:id(76010+n),instructorId:ADMIN,hostId:hosts[0].id,expectedVersion:0}))};
 const batch=await call(db,'public.v1_zoom_batch',args);assert.deepEqual(batch.sessions.map(x=>x.ok),[false,true]);assert.equal(batch.sessions[0].code,'zoom_schedule_conflict');assert.deepEqual(await call(db,'public.v1_zoom_batch',args),batch);
 assert.equal((await db.query('select count(*)::int n from zoom_core.links')).rows[0].n,4);
 // T11: a verified two-slot resource admits two different eligible teachers,
 // but a third eligible teacher cannot create a third overlapping reservation.
 const {verifiedHost}=await import('../supabase/functions/_shared/zoom-client.mjs');await service(db);
 await call(db,'public.v1_zoom_sync_hosts',{p_connection_id:connection,p_generation:1,p_hosts:[verifiedHost({id:'host-A',account_id:'account-A',status:'active',type:2},{feature:{meeting_capacity:100,concurrent_meeting:'Basic'}},'account-A')],p_coverage:'partial'});
 const revision=(await db.query('select revision from zoom_core.hosts where id=$1',[hosts[0].id])).rows[0].revision;
 for(let n=1;n<3;n++)await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,authorization_kind,verified_at) values($1,$2,$3,$4,'alternative_host',now())",[T,hosts[0].id,teachers[n],users[n]]);
 await service(db,false);await call(db,'public.v1_zoom_action',{p_slug:'marktone',p_action:'configure_host',p_command_id:id(76201),p_payload:{hostId:hosts[0].id,expectedVersion:revision,concurrency:2}});
 for(let n=0;n<3;n++){
  await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,$4,'Third capacity test','2030-01-10T10:00:00Z','2030-01-10T11:00:00Z','online')",[id(76210+n),T,RUN,6+n]);
  const args={p_slug:'marktone',p_action:'assign',p_command_id:id(76220+n),p_payload:{sessionId:id(76210+n),instructorId:teachers[n],hostId:hosts[0].id,expectedVersion:0}};
  if(n<2)assert.equal((await call(db,'public.v1_zoom_action',args)).state,'queued');else await assert.rejects(call(db,'public.v1_zoom_action',args),/zoom_schedule_conflict/);
 }

});
test('ZM-06/13 T25/59: portal status follows current access and future sweep is bounded and deduplicated',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session,link}=await seedZoomLesson(db);await login(db,LEARNER_AUTH);
 const snapshot=()=>call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'learner',p_options:{sessionId:session}});
 assert.equal((await snapshot()).sessions[0].access.available,true);
 await db.query("update academy.course_run_sessions set starts_at=now()+interval '1 day',ends_at=now()+interval '25 hours' where id=$1",[session]);
 await db.query("update zoom_core.links set state='ready',desired=desired||jsonb_build_object('startsAt',now()+interval '1 day','endsAt',now()+interval '25 hours') where id=$1",[link]);
 assert.equal((await snapshot()).sessions[0].access.label,'لم يحن موعد الدخول');await service(db);
 assert.equal((await call(db,'public.v1_zoom_sweep',{})).futureChecksQueued,1);assert.equal((await call(db,'public.v1_zoom_sweep',{})).futureChecksQueued,0);
 await db.query("update zoom_core.links set state='cancelled' where id=$1",[link]);await service(db,false);assert.equal((await snapshot()).sessions[0].access.label,'المحاضرة ملغاة');
});
test('ZM-10: messages use only configured HTTPS origin and preserve personal webinar delivery',()=>{
 const path='/training/synthetic/sessions/'+id(1),job={messageText:'موعدك '+path,metadata:{venueOrLink:path}};
 const result=resolveZoomTrainingMessage(job,path,'https://training.example.test');assert.equal(result.metadata.venueOrLink,'https://training.example.test'+path);assert.ok(result.messageText.includes('https://training.example.test/'));
 assert.throws(()=>resolveZoomTrainingMessage(job,path,''),/zoom_public_origin_required/);assert.throws(()=>resolveZoomTrainingMessage(job,path,'https://user:password@example.test'),/zoom_public_origin_required/);
 assert.equal(resolveZoomTrainingMessage(job,'https://zoom.us/w/123',''),job);
});
test('ZM-07: overlapping complete student evidence creates one review task without changing attendance',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session,link,connection,instance,host}=await seedZoomLesson(db);const otherSession=id(76500),otherLink=id(76501),otherInstance=id(76502);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) select $1,tenant_id,course_run_id,2,'Synthetic overlap',starts_at,ends_at,delivery_mode from academy.course_run_sessions where id=$2",[otherSession,session]);
 await db.query("insert into zoom_core.links(id,tenant_id,session_id,connection_id,host_id,instructor_subject_id,state,desired,meeting_id) select $1,tenant_id,$2,connection_id,host_id,instructor_subject_id,'ended',desired,'second-meeting' from zoom_core.links where id=$3",[otherLink,otherSession,link]);
 for(const [lid,iid,uuid] of [[link,instance,'overlap-first'],[otherLink,otherInstance,'overlap-second']]){
  await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid,evidence_state) values($1,$2,$3,$4,$5,'complete')",[iid,T,connection,lid,uuid]);
  await db.query("insert into zoom_core.teaching_windows(tenant_id,link_id,approved_range,policy,approved_by,reason) values($1,$2,tstzrange(now()-interval '10 minutes',now()+interval '1 minute','[)'),'{\"threshold\":75}',$3,'Synthetic approved overlap window')",[T,lid,ADMIN]);
  await db.query("insert into zoom_core.intervals(tenant_id,instance_id,enrollment_id,participant_key,source_key,joined_at,left_at,source,quality,kind) values($1,$2,$3,$4,$4,now()-interval '8 minutes',now(),'report','matched','meeting')",[T,iid,ENROLLMENT,uuid]);
 }
 await service(db);assert.equal((await call(db,'public.v1_zoom_operational_tasks',{})).learnerOverlapTasks,1);assert.equal((await call(db,'public.v1_zoom_operational_tasks',{})).learnerOverlapTasks,0);
 assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,0);assert.ok(host);
});

test('ZM-02/03/12: existing branches scope hosts, reject foreign IDs, and report comparison uses canonical assessments',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {host,session}=await seedZoomLesson(db),branch=id(78001),foreignBranch=id(78002);
 await db.query("insert into core.branches(id,tenant_id,branch_key,name) values($1,$2,'synthetic_zoom','Synthetic training branch'),($3,$4,'synthetic_foreign','Other branch')",[branch,T,foreignBranch,OTHER]);
 const hostRow=(await db.query('select revision from zoom_core.hosts where id=$1',[host])).rows[0],args={p_slug:'marktone',p_action:'configure_host',p_command_id:id(78003),p_payload:{hostId:host,expectedVersion:hostRow.revision,branchId:branch}};
 await call(db,'public.v1_zoom_action',args);await call(db,'public.v1_zoom_action',args);
 const preview=()=>call(db,'public.v1_zoom_assignment_preview',{p_slug:'marktone',p_session_id:session,p_payload:{instructorId:INSTRUCTOR}});
 assert.equal((await preview()).candidates.length,0);await db.query('update academy.course_runs set branch_id=$1 where id=$2',[branch,RUN]);assert.equal((await preview()).candidates.length,1);
 await assert.rejects(call(db,'public.v1_zoom_action',{...args,p_command_id:id(78004),p_payload:{...args.p_payload,expectedVersion:hostRow.revision+1,branchId:foreignBranch}}),/zoom_invalid_branch/);
 assert.equal((await call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'accounts',p_options:{branchId:foreignBranch}})).hosts.length,0);
 await db.query("update academy.course_run_sessions set starts_at=now()+interval '1 day',ends_at=now()+interval '25 hours',delivery_mode='hybrid',venue_or_link='Synthetic room A' where id=$1",[session]);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,venue_or_link) select $1,tenant_id,course_run_id,2,'Conflicting physical room',starts_at,ends_at,'hybrid',venue_or_link from academy.course_run_sessions where id=$2",[id(78005),session]);
 await assert.rejects(call(db,'public.v1_zoom_action',{p_slug:'marktone',p_action:'assign',p_command_id:id(78006),p_payload:{sessionId:id(78005),instructorId:INSTRUCTOR,hostId:host,expectedVersion:0}}),/zoom_room_conflict/);

 await db.query("insert into academy.assessment_results(tenant_id,course_run_id,enrollment_id,score,max_score,assessed_by_subject_id) values($1,$2,$3,70,100,$4)",[T,RUN,ENROLLMENT,ADMIN]);
 const report=await call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'reports'});assert.equal(report.comparison.current.sessions,1);assert.equal(report.comparison.previous.sessions,0);assert.equal(report.comparison.current.onTimePercent,null);assert.equal(report.teacherOutcomes[0].assessmentCount,1);assert.equal(report.teacherOutcomes[0].assessmentPercent,70);assert.equal(report.teacherOutcomes[0].learnerRating,null);
});
test('ZM-06 T26/27/28: Zoom follows canonical first-payment and day 7/8 governance; sponsor amounts never leave access',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session}=await seedZoomLesson(db,{paymentAmount:4000});
 await db.query('insert into academy.admission_governance_settings(tenant_id,enabled) values($1,false) on conflict(tenant_id) do update set enabled=false',[T]);await login(db,LEARNER_AUTH);
 await assert.rejects(grant(db,session),/zoom_not_entitled/);
 await db.query("update academy.training_financial_links set policy='installments',sponsor=true where handoff_id=$1",[HANDOFF]);
 await db.query("insert into accounting_core.payment_schedules(tenant_id,invoice_id,installment_number,due_date,amount_minor) select $1::uuid,$2::uuid,1,(now() at time zone timezone)::date-30,4000 from core.tenants where id=$1 union all select $1::uuid,$2::uuid,2,(now() at time zone timezone)::date-7,6000 from core.tenants where id=$1",[T,INVOICE]);
 for(const days of [7,8]){
  await db.query("update accounting_core.payment_schedules set due_date=(select (now() at time zone timezone)::date from core.tenants where id=$1)-$2::int where tenant_id=$1 and installment_number=2",[T,days]);
  const finance=await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:ENROLLMENT});
  if(finance.trainingAllowed)assert.ok((await grant(db,session)).grantId);else await assert.rejects(grant(db,session),/zoom_not_entitled/);
 }
 await db.query('update academy.admission_governance_settings set enabled=true where tenant_id=$1',[T]);
 const allowed=await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:ENROLLMENT});assert.equal(allowed.trainingAllowed,true);const g=await grant(db,session);await service(db);
 const context=await call(db,'public.v1_zoom_access_context',{p_grant_id:g.grantId,p_lease:id(78101)});assert.ok(!JSON.stringify(context).includes(INVOICE));assert.ok(!JSON.stringify(context).includes('outstandingMinor'));assert.ok(!JSON.stringify(context).includes('6000'));
 await service(db,false);await assert.rejects(call(db,'public.v1_zoom_access',{p_slug:'marktone',p_session_id:session,p_enrollment_id:id(78199),p_action:'join'}),/zoom_forbidden/);
});
test('ZM-10 T24: stale reminders cannot send; a revision creates one change message despite repeated enqueue',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session,link}=await seedZoomLesson(db);
 await db.query("insert into academy.training_automation_settings(tenant_id,primary_channel,joining_enabled,reminder_24h_enabled,reminder_1h_enabled) values($1,'email',true,true,true) on conflict(tenant_id) do update set primary_channel='email',joining_enabled=true,reminder_24h_enabled=true,reminder_1h_enabled=true",[T]);
 await call(db,'zoom_core.enqueue_messages',{lid:link,event_key:'ready'});const old=(await db.query('select id from academy.training_automation_jobs where session_id=$1 limit 1',[session])).rows[0];assert.ok(old);
 await db.query("update academy.training_automation_jobs set status='processing' where id=$1",[old.id]);
 await db.query("update zoom_core.links set state='updating',revision=revision+1 where id=$1",[link]);await db.query("update zoom_core.links set state='ready' where id=$1",[link]);
 await call(db,'zoom_core.enqueue_messages',{lid:link,event_key:'changed'});await call(db,'zoom_core.enqueue_messages',{lid:link,event_key:'changed'});
 assert.equal((await db.query("select count(*)::int n from academy.training_automation_jobs where session_id=$1 and job_type='zoom_changed'",[session])).rows[0].n,1);
 await service(db);assert.equal((await call(db,'public.v1_zoom_message_check',{p_job_id:old.id})).allowed,false);
 const change=(await db.query("update academy.training_automation_jobs set status='processing' where session_id=$1 and job_type='zoom_changed' returning id",[session])).rows[0];const content=await call(db,'public.v1_zoom_message_check',{p_job_id:change.id});assert.equal(content.allowed,true);assert.ok(content.url.startsWith('/training/'));assert.ok(!JSON.stringify(content).includes('zoom.us'));
});
test('ZM-13 T47: bounded queue claim serves both tenants; cooling account does not block another tenant',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const connection=(await connect(db)).connectionId,otherConnection=id(79001);
 await db.query("insert into zoom_core.connections(id,tenant_id,environment,account_id,grant_user_id,label) values($1,$2,'test','other-claim-account','other-user','Synthetic queue account')",[otherConnection,OTHER]);
 // Deliberately exercise selection only, not provider execution: no secrets or
 // artificial live meetings are needed to measure the scheduling policy.
 for(let n=0;n<12;n++)await db.query("insert into zoom_core.operations(tenant_id,connection_id,kind,due_at) values($1,$2,'reconcile',now()-interval '1 hour')",[T,connection]);
 await db.query("insert into zoom_core.operations(tenant_id,connection_id,kind) values($1,$2,'reconcile')",[OTHER,otherConnection]);await service(db);
 const jobs=await call(db,'public.v1_zoom_claim',{p_lease_id:id(79002),p_limit:2});assert.deepEqual(new Set(jobs.map(x=>x.tenant_id)),new Set([T,OTHER]));
 await db.query("insert into zoom_core.account_budgets(tenant_id,connection_id,next_call_at) values($1,$2,now()+interval '1 hour')",[T,connection]);
 await db.query("insert into zoom_core.operations(tenant_id,connection_id,kind) values($1,$2,'reconcile')",[OTHER,otherConnection]);const next=await call(db,'public.v1_zoom_claim',{p_lease_id:id(79003),p_limit:5});assert.equal(next.length,1);assert.equal(next[0].tenant_id,OTHER);
});

test('ZM-06/07/09 T29: one student has independent course enrollments, participant grants and recording access',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const first=await seedZoomLesson(db),course=id(79201),run=id(79202),handoff=id(79203),enrollment=id(79204),session=id(79205),link=id(79206);
 await db.query("insert into academy.courses(id,tenant_id,course_code,title_ar,category) values($1,$2,'SECOND-SYNTHETIC','Second synthetic course','Training')",[course,T]);
 await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity) values($1,$2,$3,'SECOND-RUN','Second synthetic cohort','online','open',10)",[run,T,course]);
 await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_amount_minor,payment_status,payment_verified_at,payment_verified_by_subject_id) values($1,$2,'SECOND-HANDOFF',$3,$4,10000,'verified',now(),$5)",[handoff,T,CONTACT,course,ADMIN]);
 await db.query("insert into academy.enrollments(id,tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id) values($1,$2,'SECOND-ENROLLMENT',$3,$4,$5,$6)",[enrollment,T,handoff,STUDENT,course,run]);
 await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,created_by_subject_id) values($1,$2,$3,$4,'full',true,$5)",[T,handoff,INVOICE,ACCOUNT,ADMIN]);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) select $1,tenant_id,$2,1,'Other course lecture',starts_at,ends_at,delivery_mode from academy.course_run_sessions where id=$3",[session,run,first.session]);
 await db.query("insert into zoom_core.links(id,tenant_id,session_id,connection_id,host_id,instructor_subject_id,state,desired,observed,meeting_id) select $1,tenant_id,$2,connection_id,host_id,instructor_subject_id,'ready',desired,observed,'second-enrollment-meeting' from zoom_core.links where id=$3",[link,session,first.link]);
 await login(db,LEARNER_AUTH);await assert.rejects(call(db,'public.v1_zoom_access',{p_slug:'marktone',p_session_id:session,p_enrollment_id:enrollment,p_action:'join'}),/zoom_not_entitled/);await login(db,ADMIN_AUTH);await db.query("update academy.registration_handoffs set status='completed',completed_at=now(),completed_by_subject_id=$1 where id=$2",[ADMIN,handoff]);
 await login(db,LEARNER_AUTH);const firstGrant=await grant(db,first.session),secondGrant=await call(db,'public.v1_zoom_access',{p_slug:'marktone',p_session_id:session,p_enrollment_id:enrollment,p_action:'join'});assert.notEqual(firstGrant.grantId,secondGrant.grantId);
 await assert.rejects(call(db,'public.v1_zoom_access',{p_slug:'marktone',p_session_id:session,p_enrollment_id:ENROLLMENT,p_action:'join'}),/zoom_forbidden/);
 for(const [n,lid,eid] of [[0,first.link,ENROLLMENT],[1,link,enrollment]]){
  const instance=id(79210+n),recording=id(79220+n);await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid,evidence_state) values($1,$2,$3,$4,$5,'complete')",[instance,T,first.connection,lid,'enrollment-uuid-'+n]);
  const secret=(await db.query("select vault.create_secret($1,'synthetic-enrollment-recording','test',null) id",[JSON.stringify({play_url:'https://zoom.us/rec/play/synthetic-enrollment-'+n})])).rows[0].id;
  await db.query("insert into zoom_core.recordings(id,tenant_id,instance_id,provider_file_id,file_type,secret_id,state,expires_at) values($1,$2,$3,$4,'MP4',$5,'published',now()+interval '1 day')",[recording,T,instance,'enrollment-file-'+n,secret]);
  const result=await call(db,'public.v1_zoom_recording_access',{p_slug:'marktone',p_recording_id:recording,p_enrollment_id:eid});assert.ok(result.url.endsWith('-'+n));await assert.rejects(call(db,'public.v1_zoom_recording_access',{p_slug:'marktone',p_recording_id:recording,p_enrollment_id:n===0?enrollment:ENROLLMENT}),/zoom_forbidden/);
  await db.query("insert into zoom_core.teaching_windows(tenant_id,link_id,approved_range,policy,approved_by,reason) values($1,$2,tstzrange(now()-interval '10 minutes',now()+interval '50 minutes','[)'),'{\"threshold\":75}',$3,'Synthetic approved distinct course window')",[T,lid,ADMIN]);
  await db.query("insert into zoom_core.intervals(tenant_id,instance_id,enrollment_id,participant_key,source_key,joined_at,left_at,source,quality,kind) values($1,$2,$3,$4,$4,now()-interval '4 minutes',now()-make_interval(mins=>$5),'report','matched','meeting')",[T,instance,eid,'per-course-'+n,n===0?2:3]);
 }
 assert.equal((await call(db,'zoom_core.attendance',{t:T,lid:first.link,eid:ENROLLMENT})).attendedSeconds,120);assert.equal((await call(db,'zoom_core.attendance',{t:T,lid:link,eid:enrollment})).attendedSeconds,60);
});
