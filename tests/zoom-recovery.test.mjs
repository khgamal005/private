import test from 'node:test';import assert from 'node:assert/strict';
import {zoomSetup,call,id,ENROLLMENT,LEARNER_AUTH,login,service} from './fixtures/zoom-database.mjs';
import {seedZoomLesson,grant} from './fixtures/zoom-lesson.mjs';
test('ZM-04/13 T20: UUID-less update verifies provider state; own echo is not drift and external schedule is not silently adopted',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session,link}=await seedZoomLesson(db);await service(db);
 const schedule=(await db.query('select starts_at from academy.course_run_sessions where id=$1',[session])).rows[0];
 await call(db,'public.v1_zoom_receive_event',{p_environment:'test',p_dedupe:'b'.repeat(64),p_event:{accountId:'account-A',event:'meeting.updated',eventTs:Date.now(),meetingId:'12345678901'}});await call(db,'public.v1_zoom_process_events',{});
 assert.equal((await db.query('select count(*)::int n from zoom_core.instances')).rows[0].n,0);await db.query("update zoom_core.operations set due_at=now() where payload->>'checkSchedule'='true'");
 const lease=id(75200),[job]=await call(db,'public.v1_zoom_claim',{p_lease_id:lease,p_limit:1});const args={p_operation_id:job.id,p_lease_id:lease,p_fence:job.fence};
 const current={id:'12345678901',host_id:'host-A',start_time:schedule.starts_at.toISOString(),duration:60};
 assert.equal((await call(db,'public.v1_zoom_schedule_observe',{...args,p_result:current})).different,false);
 assert.equal((await call(db,'public.v1_zoom_schedule_observe',{...args,p_result:{...current,start_time:new Date(schedule.starts_at.getTime()+3600000).toISOString()}})).state,'drift');
 assert.equal((await db.query('select starts_at from academy.course_run_sessions where id=$1',[session])).rows[0].starts_at.toISOString(),schedule.starts_at.toISOString());assert.equal((await db.query('select state from zoom_core.links where id=$1',[link])).rows[0].state,'drift');
});
test('ZM-06/13 T18/25: lost individual registration is recovered with a fresh scoped grant, no duplicate registration',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session}=await seedZoomLesson(db);await login(db,LEARNER_AUTH);
 const original=await grant(db,session);await service(db);await call(db,'public.v1_zoom_access_context',{p_grant_id:original.grantId,p_lease:id(75100)});
 await db.query("update zoom_core.registrations set state='uncertain',lease=null,lease_until=null where enrollment_id=$1",[ENROLLMENT]);
 await service(db,false);const fresh=await grant(db,session);await service(db);const lease=id(75101),ctx=await call(db,'public.v1_zoom_registration_recover',{p_grant_id:fresh.grantId,p_lease:lease});assert.equal(ctx.status,'recover');assert.equal(ctx.email,'learner@example.test');
 await assert.rejects(call(db,'public.v1_zoom_registration_recover',{p_grant_id:fresh.grantId,p_lease:id(75102)}),/zoom_registration_pending/);
 await call(db,'public.v1_zoom_registration_complete',{p_grant_id:fresh.grantId,p_lease:lease,p_result:{registrant_id:'recovered-individual',join_url:'https://zoom.us/j/123?tk=synthetic-recovered'}});
 assert.equal((await db.query('select count(*)::int n from zoom_core.registrations')).rows[0].n,1);
 await db.query("update academy.training_learner_accounts set status='suspended'");await assert.rejects(call(db,'public.v1_zoom_access_context',{p_grant_id:fresh.grantId,p_lease:lease}),/zoom_forbidden/);
});

test('ZM-14 T62: advanced purge drains beyond a full batch and completed entries cannot starve newer cleanup',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const tenant=(await db.query("select id from core.tenants where slug='marktone'")).rows[0].id;
 for(let n=0;n<27;n++){
  const connection=id(79900+n);await db.query("insert into zoom_core.connections(id,tenant_id,environment,account_id,grant_user_id,label,status) values($1,$2,'test',$3,'purged','Synthetic deleted account','deauthorized')",[connection,tenant,'batch-purge-'+n]);
  await db.query("insert into zoom_core.purge_requests(tenant_id,connection_id,reason,state) values($1,$2,'deauthorization','complete')",[tenant,connection]);
 }
 await service(db);await call(db,'public.v1_zoom_purge',{p_limit:20});assert.equal((await db.query('select count(*)::int n from zoom_core.purge_requests where advanced_purged_at is not null')).rows[0].n,20);
 await call(db,'public.v1_zoom_purge',{p_limit:20});assert.equal((await db.query('select count(*)::int n from zoom_core.purge_requests where advanced_purged_at is not null')).rows[0].n,27);
});
