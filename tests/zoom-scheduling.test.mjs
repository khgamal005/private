import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {zoomSetup,connect,syncHost,service,call,id,T,OTHER,RUN,INSTRUCTOR,ADMIN,login,ADMIN_AUTH} from './fixtures/zoom-database.mjs';
let db,host,connection,session=id(2201),sequence=2300;
const action=(kind,payload,commandId=id(sequence++))=>call(db,'public.v1_zoom_action',{p_slug:'marktone',p_action:kind,p_command_id:commandId,p_payload:payload});
before(async()=>{
 db=await zoomSetup({scheduling:true});connection=(await connect(db)).connectionId;await syncHost(db,connection);
 host=(await db.query('select id from zoom_core.hosts')).rows[0].id;
 await db.query('update zoom_core.hosts set allowed=true,instructor_subject_id=$1 where id=$2',[INSTRUCTOR,host]);
 await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,authorization_kind,verified_at) values($1,$2,$3,'host-A','host',now()),($1,$2,$4,'teacher-B','alternative_host',now())",[T,host,INSTRUCTOR,ADMIN]);
 await db.query('insert into academy.training_run_instructors(tenant_id,run_id,subject_id,assigned_by_subject_id) values($1,$2,$3,$4),($1,$2,$4,$4)',[T,RUN,INSTRUCTOR,ADMIN]);
 for(let n=0;n<4;n++)await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,$4,'Synthetic session','2030-01-01T10:00:00Z','2030-01-01T11:00:00Z','online')",[id(2201+n),T,RUN,n+1]);
 await service(db,false);await login(db,ADMIN_AUTH);
});
after(async()=>{await db?.close();});
test('ZM-03 T10/13: deterministic preview, atomic reservation and manual override cannot bypass overlap',async()=>{
 const payload={sessionId:session,instructorId:INSTRUCTOR,expectedVersion:0,attendees:50};
 const preview=await call(db,'public.v1_zoom_assignment_preview',{p_slug:'marktone',p_session_id:session,p_payload:payload});assert.equal(preview.candidates[0].host_id,host);
 const command=id(2299);const first=await action('assign',payload,command);assert.equal(first.state,'queued');
 assert.deepEqual(await action('assign',payload,command),first);
 await assert.rejects(action('assign',{...payload,attendees:40},command),/zoom_command_reused/);
 await assert.rejects(action('assign',{...payload,sessionId:id(2202),hostId:host}),/zoom_schedule_conflict/);
 await assert.rejects(action('assign',{...payload,sessionId:id(2202),hostId:id(8888)}),/zoom_schedule_conflict/);
});
test('ZM-03 T11/12: proven second slot works for a different teacher; human overlap still rejected',async()=>{
 await db.query('update zoom_core.hosts set provider_concurrency=2,concurrency_limit=2 where id=$1',[host]);
 await assert.rejects(action('assign',{sessionId:id(2202),instructorId:INSTRUCTOR,expectedVersion:0,attendees:20}),/zoom_schedule_conflict/);
 const second=await action('assign',{sessionId:id(2202),instructorId:ADMIN,expectedVersion:0,attendees:20});assert.equal(second.state,'queued');
 const slots=(await db.query('select slot from zoom_core.reservations order by slot')).rows.map(r=>r.slot);assert.deepEqual(slots,[1,2]);
});
test('ZM-13 T17/18/19: worker fence rejects stale completion, uncertain creation retains reservation',async()=>{
 await service(db);const lease=id(2500);const jobs=await call(db,'public.v1_zoom_claim',{p_lease_id:lease,p_limit:5});assert.equal(jobs.length,2);
 const job=jobs.find(x=>x.link_id);const ctx=await call(db,'public.v1_zoom_operation_context',{p_operation_id:job.id,p_lease_id:lease,p_fence:job.fence});assert.equal(ctx.host.userId,'host-A');
 await assert.rejects(call(db,'public.v1_zoom_operation_complete',{p_operation_id:job.id,p_lease_id:lease,p_fence:job.fence-1,p_outcome:'complete'}),/zoom_stale_lease/);
 await call(db,'public.v1_zoom_operation_complete',{p_operation_id:job.id,p_lease_id:lease,p_fence:job.fence,p_outcome:'uncertain',p_result:{code:'zoom_network_error'}});
 assert.equal((await db.query('select state from zoom_core.links where id=$1',[job.link_id])).rows[0].state,'uncertain');
 assert.equal((await db.query('select state from zoom_core.reservations where link_id=$1',[job.link_id])).rows[0].state,'held');
 assert.deepEqual(await call(db,'public.v1_zoom_claim',{p_lease_id:id(2501),p_limit:5}),[]);
 const remaining=jobs.find(x=>x.id!==job.id);
 await call(db,'public.v1_zoom_operation_complete',{p_operation_id:remaining.id,p_lease_id:lease,p_fence:remaining.fence,p_outcome:'complete',p_result:{id:'opaque-meeting-1',host_id:'host-A',join_url:'https://us06web.zoom.us/j/123',start_url:'MUST-NOT-BE-STORED',start_time:'2030-01-01T10:00:00Z',duration:60,settings:{approval_type:0}}});
 assert.equal((await db.query('select state from zoom_core.links where id=$1',[remaining.link_id])).rows[0].state,'ready');
 assert.ok(!JSON.stringify((await db.query('select observed from zoom_core.links')).rows).includes('MUST-NOT'));
});
test('ZM-14 T13/49: tenant composite references and addon revocation deny operations',async()=>{
 await assert.rejects(db.query("insert into zoom_core.links(tenant_id,session_id) values($1,$2)",[OTHER,session]),/foreign key/);
 await service(db,false);await db.query("select set_config('fixture.zoom_addon','no',false)");
 await assert.rejects(action('assign',{sessionId:id(2203),instructorId:ADMIN,expectedVersion:0}),/zoom_not_enabled/);
 await db.query("select set_config('fixture.zoom_addon','yes',false)");
});
