import test from 'node:test';import assert from 'node:assert/strict';
import {zoomSetup,call,id,T,OTHER,ENROLLMENT,STUDENT,INSTRUCTOR_AUTH,LEARNER_AUTH,ADMIN_AUTH,login,service} from './fixtures/zoom-database.mjs';
import {seedZoomLesson,grant} from './fixtures/zoom-lesson.mjs';

test('ZM-06/15 T25–31/50: learner and instructor paths use canonical identity, fresh entitlement and no LMS dependency',async t=>{
 const db=await zoomSetup({recovery:true});t.after(()=>db.close());const {session,link}=await seedZoomLesson(db);
 await db.exec(`create or replace function private_app.tenant_addon_enabled(t uuid,p text) returns boolean language sql stable as $$ select p='addon.integration.zoom' and t in ('${T}'::uuid,'${OTHER}'::uuid) $$`);
 await login(db,LEARNER_AUTH);assert.equal((await call(db,'public.v1_zoom_portal',{p_slug:'marktone',p_role:'learner'})).lmsEnabled,false);
 const page=await call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'learner',p_options:{sessionId:session}});assert.equal(page.sessions.length,1);assert.equal(page.sessions[0].enrollmentId,ENROLLMENT);assert.ok(!JSON.stringify(page).includes('start_url'));
 await assert.rejects(grant(db,session,'start'),/zoom_forbidden/);const access=await grant(db,session);await service(db);
 const lease=id(50050),ctx=await call(db,'public.v1_zoom_access_context',{p_grant_id:access.grantId,p_lease:lease});assert.equal(ctx.status,'register');assert.equal(ctx.email,'learner@example.test');
 assert.equal((await call(db,'public.v1_zoom_access_context',{p_grant_id:access.grantId,p_lease:id(50051)})).status,'busy');
 await call(db,'public.v1_zoom_registration_complete',{p_grant_id:access.grantId,p_lease:lease,p_result:{registrant_id:'person-A',join_url:'https://zoom.us/w/12345678901?tk=synthetic-personal'}});
 await service(db,false);await login(db,LEARNER_AUTH);const second=await grant(db,session);await service(db);assert.equal((await call(db,'public.v1_zoom_access_context',{p_grant_id:second.grantId,p_lease:id(50052)})).status,'ready');
 await db.query("update academy.training_learner_accounts set status='suspended' where tenant_id=$1 and student_id=$2",[T,STUDENT]);
 await assert.rejects(call(db,'public.v1_zoom_access_context',{p_grant_id:second.grantId,p_lease:id(50052)}),/zoom_forbidden/);
 await db.query("update academy.training_learner_accounts set status='active' where tenant_id=$1 and student_id=$2",[T,STUDENT]);
 await service(db,false);await login(db,INSTRUCTOR_AUTH);const host=await grant(db,session,'start');await service(db);const hostCtx=await call(db,'public.v1_zoom_access_context',{p_grant_id:host.grantId,p_lease:id(50053)});assert.equal(hostCtx.providerUserId,'host-A');assert.equal(hostCtx.authorizationKind,'host');
 await db.query("update zoom_core.links set state='cancelled' where id=$1",[link]);await assert.rejects(call(db,'public.v1_zoom_access_context',{p_grant_id:host.grantId,p_lease:id(50053)}),/zoom_session_unavailable/);
});

test('ZM-09/10/14 T41–46: publish/revoke, current message revision, retention and deauthorization preserve independent money',async t=>{
 const db=await zoomSetup({recovery:true});t.after(()=>db.close());const {session,link,connection,instance}=await seedZoomLesson(db);
 await db.query("insert into academy.training_automation_settings(tenant_id,primary_channel) values($1,'email') on conflict(tenant_id) do update set primary_channel='email'",[T]);
 await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid) values($1,$2,$3,$4,'uuid-1')",[instance,T,connection,link]);
 const secret=(await db.query("select vault.create_secret('{\"play_url\":\"https://zoom.us/rec/play/synthetic\"}','synthetic','test',null) id")).rows[0].id;
 const rec=id(50060);await db.query("insert into zoom_core.recordings(id,tenant_id,instance_id,provider_file_id,file_type,secret_id) values($1,$2,$3,'file-1','MP4',$4)",[rec,T,instance,secret]);
 await assert.rejects(call(db,'public.v1_zoom_recording_action',{p_slug:'marktone',p_action:'publish_recording',p_command_id:id(50061),p_payload:{recordingId:rec,reviewed:true}}),/zoom_recording_review_required/);
 await call(db,'public.v1_zoom_settings',{p_slug:'marktone',p_command_id:id(50062),p_payload:{expectedVersion:1,retentionDays:30,retentionApproved:true,providerLimitAcknowledged:true}});
 await call(db,'public.v1_zoom_recording_action',{p_slug:'marktone',p_action:'publish_recording',p_command_id:id(50063),p_payload:{recordingId:rec,reviewed:true}});
 assert.equal((await db.query("select count(*)::int n from academy.training_automation_jobs where job_type='zoom_recording'")).rows[0].n,1);
 await login(db,LEARNER_AUTH);const access=await call(db,'public.v1_zoom_recording_access',{p_slug:'marktone',p_recording_id:rec,p_enrollment_id:ENROLLMENT});assert.equal(access.measurement,'opened_only');
 const files=await call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'recordings',p_options:{linkId:link}});assert.equal(files.recordings.length,1);assert.ok(!JSON.stringify(files).includes('play_url'));
 await login(db,ADMIN_AUTH);await call(db,'public.v1_zoom_recording_action',{p_slug:'marktone',p_action:'withdraw_recording',p_command_id:id(50064),p_payload:{recordingId:rec,reason:'Human privacy withdrawal'}});
 await login(db,LEARNER_AUTH);await assert.rejects(call(db,'public.v1_zoom_recording_access',{p_slug:'marktone',p_recording_id:rec,p_enrollment_id:ENROLLMENT}),/zoom_recording_unavailable/);
 await login(db,ADMIN_AUTH);await service(db);await db.query("update academy.training_automation_jobs set status='processing' where session_id=$1",[session]);const job=(await db.query('select id from academy.training_automation_jobs limit 1')).rows[0];assert.equal((await call(db,'public.v1_zoom_message_check',{p_job_id:job.id})).allowed,false);
 await db.query("update zoom_core.connections set status='deauthorized' where id=$1",[connection]);const countsBefore=(await db.query('select (select count(*) from accounting_core.payments) payments,(select count(*) from academy.enrollments) enrollments')).rows[0];
 await call(db,'public.v1_zoom_purge',{});assert.equal((await db.query('select state from zoom_core.purge_requests')).rows[0].state,'policy_required');assert.equal((await db.query('select count(*)::int n from vault.secrets')).rows[0].n,0);assert.equal((await db.query('select state from zoom_core.recordings')).rows[0].state,'deleted');
 assert.deepEqual((await db.query('select (select count(*) from accounting_core.payments) payments,(select count(*) from academy.enrollments) enrollments')).rows[0],countsBefore);
});
