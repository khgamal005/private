import test from 'node:test';import assert from 'node:assert/strict';
import {zoomSetup,call,id,T,RUN,INSTRUCTOR,service} from './fixtures/zoom-database.mjs';
import {seedZoomLesson} from './fixtures/zoom-lesson.mjs';

test('ZM-05 T22/59: atomic recurring creation spans DST; one provider operation maps separate occurrences and reservations',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {host}=await seedZoomLesson(db);
 await db.query("update core.tenants set timezone='America/New_York' where id=$1",[T]);
 const sessions=[id(71001),id(71002)];const starts=['2027-03-07T14:00:00Z','2027-03-14T13:00:00Z'];
 for(let n=0;n<2;n++)await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,$4,'Synthetic DST lesson',$5::timestamptz,$5::timestamptz+interval '1 hour','online')",[sessions[n],T,RUN,n+2,starts[n]]);
 const args={p_slug:'marktone',p_command_id:id(71100),p_payload:{sessions,hostId:host,instructorId:INSTRUCTOR,pattern:'weekly',repeatInterval:1,attendees:10}};
 const created=await call(db,'public.v1_zoom_series',args);assert.equal(created.atomic,true);assert.equal(created.timezone,'America/New_York');assert.deepEqual(await call(db,'public.v1_zoom_series',args),created);
 await service(db);const lease=id(71101),jobs=await call(db,'public.v1_zoom_claim',{p_lease_id:lease,p_limit:10});assert.equal(jobs.length,1);const job=jobs[0],identity={p_operation_id:job.id,p_lease_id:lease,p_fence:job.fence};
 const context=await call(db,'public.v1_zoom_reconcile_context',identity);assert.equal(context.link.desired.series.recurrence.type,2);
 const provider={id:'22345678901',host_id:'host-A',join_url:'https://zoom.us/j/22345678901',settings:{approval_type:0,registration_type:2},occurrences:starts.map((start_time,n)=>({occurrence_id:'occ-'+n,start_time,duration:60,status:'available'}))};
 await assert.rejects(call(db,'public.v1_zoom_operation_complete',{...identity,p_outcome:'complete',p_generation:1,p_result:{...provider,occurrences:provider.occurrences.slice(0,1)}}),/zoom_invalid_provider_response/);
 assert.equal((await db.query('select count(*)::int n from zoom_core.links where session_id=any($1::uuid[]) and state=\'ready\'',[sessions])).rows[0].n,0);
 await call(db,'public.v1_zoom_operation_complete',{...identity,p_outcome:'uncertain',p_result:{code:'zoom_network_error'}});
 assert.equal((await db.query("select count(*)::int n from zoom_core.links where session_id=any($1::uuid[]) and state='uncertain'",[sessions])).rows[0].n,2);
 assert.deepEqual(await call(db,'public.v1_zoom_claim',{p_lease_id:id(71102),p_limit:10}),[]);
 await service(db,false);const recoveryLease=id(71103);const recovery=await call(db,'public.v1_zoom_recovery_begin',{p_slug:'marktone',p_session_id:sessions[0],p_revision:1,p_lease_id:recoveryLease,p_reason:'Verified synthetic recurring provider result'});
 await service(db);await call(db,'public.v1_zoom_operation_complete',{p_operation_id:recovery.operationId,p_lease_id:recoveryLease,p_fence:recovery.fence,p_outcome:'complete',p_generation:1,p_result:provider});
 const links=(await db.query('select occurrence_id,meeting_id,state,revision from zoom_core.links where session_id=any($1::uuid[]) order by occurrence_id',[sessions])).rows;assert.deepEqual(links.map(x=>x.occurrence_id),['occ-0','occ-1']);assert.ok(links.every(x=>x.state==='ready'&&x.meeting_id===provider.id));
 await service(db,false);await call(db,'public.v1_zoom_action',{p_slug:'marktone',p_action:'update',p_command_id:id(71104),p_payload:{sessionId:sessions[1],expectedVersion:1,instructorId:INSTRUCTOR,hostId:host,startsAt:'2027-03-14T14:00:00Z',endsAt:'2027-03-14T15:00:00Z',attendees:10}});
 assert.equal((await db.query('select desired->>\'occurrenceId\' occurrence from zoom_core.links where session_id=$1',[sessions[1]])).rows[0].occurrence,'occ-1');
});

test('ZM-05: irregular series rolls back every reservation; conflicts never yield a partially created series',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {host}=await seedZoomLesson(db);const sessions=[id(71201),id(71202)];
 for(let n=0;n<2;n++)await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,$4,'Synthetic irregular lesson','2028-01-01T10:00:00Z'::timestamptz+make_interval(days=>$5::int),'2028-01-01T11:00:00Z'::timestamptz+make_interval(days=>$5::int),'online')",[sessions[n],T,RUN,n+2,n*8]);
 await assert.rejects(call(db,'public.v1_zoom_series',{p_slug:'marktone',p_command_id:id(71300),p_payload:{sessions,hostId:host,instructorId:INSTRUCTOR,pattern:'weekly'}}),/zoom_irregular_series/);
 assert.equal((await db.query('select count(*)::int n from zoom_core.links where session_id=any($1::uuid[])',[sessions])).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from zoom_core.reservations')).rows[0].n,0);
});
