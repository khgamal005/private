import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {academySetup,configure,platformAction,call,login,id,T,OTHER,RUN,FOREIGN_COURSE,MANAGER,MANAGER_AUTH,EDITOR_AUTH,seedEnrollment,ENROLLMENT,ADMIN_AUTH} from './fixtures/academy-platform-database.mjs';
let sequence=65000;
const snapshot=(db,runId=RUN)=>call(db,'public.v1_academy_schedule_snapshot',{p_slug:'marktone',p_run_id:runId});
const action=(db,p_action,p_payload,p_command_id=id(sequence++),p_slug='marktone')=>call(db,'public.v1_academy_schedule_action',{p_slug,p_action,p_command_id,p_payload});
async function setup({governance=false}={}){
 const db=await academySetup({governance});
 try{
  await db.exec(await readFile(new URL('../supabase/migrations/20260922125855_academy_training_schedule.sql',import.meta.url),'utf8'));
  await configure(db);await platformAction(db,'set_member',{email:'manager@example.test',role:'manager',status:'active'});await login(db,MANAGER_AUTH);
  return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
async function save(db,extra={},commandId=id(sequence++)){
 const data=await snapshot(db);return action(db,'save_session',{runId:RUN,expectedRunVersion:data.selectedRun.version,title:'Academy live lesson',startsAt:new Date(Date.now()-7200000).toISOString(),endsAt:new Date(Date.now()-3600000).toISOString(),deliveryMode:'online',meetingUrl:'https://meet.example.test/training',...extra},commandId);
}

test('independent academy manager schedules canonical sessions without Odeir membership; role/tenant/entitlement and direct grants stay closed',async t=>{
 const db=await setup();t.after(()=>db.close());
 assert.equal((await db.query('select count(*)::int n from access_control.memberships where subject_id=$1',[MANAGER])).rows[0].n,0);
 const result=await save(db);assert.ok(result.sessionId);const data=await snapshot(db);assert.equal(data.sessions.length,1);assert.equal(data.sessions[0].meetingUrl,'https://meet.example.test/training');
 assert.equal((await db.query('select count(*)::int n from academy.course_run_sessions where tenant_id=$1',[T])).rows[0].n,1);
 await login(db,EDITOR_AUTH);await assert.rejects(snapshot(db),/forbidden/);await assert.rejects(save(db),/forbidden/);
 await login(db,MANAGER_AUTH);const foreign=id(sequence++);await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,delivery_mode,status) values($1,$2,$3,'FOREIGN-SCHEDULE','online','open')",[foreign,OTHER,FOREIGN_COURSE]);
 await assert.rejects(snapshot(db,foreign),/course_run_not_found/);
 await assert.rejects(call(db,'public.v1_academy_schedule_snapshot',{p_slug:'foreign'}),/academy_not_available/);
 await db.exec('set role anon');await assert.rejects(snapshot(db),/permission denied/);await db.exec('reset role');
 await db.query('update academy.platform_settings set enabled=false where tenant_id=$1',[T]);await assert.rejects(snapshot(db),/academy_not_available/);
});

test('schedule commands are idempotent, versioned and reject unsafe links, overlaps, wrong dates, or recorded-session rescheduling',async t=>{
 const db=await setup({governance:true});t.after(()=>db.close());
 await login(db,ADMIN_AUTH);await seedEnrollment(db);await db.query("update academy.enrollments set enrolled_at=now()-interval '3 hours' where id=$1",[ENROLLMENT]);await login(db,MANAGER_AUTH);
 const initial=await snapshot(db),payload={runId:RUN,expectedRunVersion:initial.selectedRun.version,title:'First lesson',startsAt:new Date(Date.now()-7200000).toISOString(),endsAt:new Date(Date.now()-3600000).toISOString(),deliveryMode:'online',meetingUrl:'https://meet.example.test/room'};
 for(const meetingUrl of ['javascript:alert(1)','https://name:secret@example.test/room','http://example.test','https://example.test\\@evil.test'])await assert.rejects(action(db,'save_session',{...payload,meetingUrl}),/academy_schedule_https_required/);
 await assert.rejects(action(db,'save_session',{...payload,endsAt:payload.startsAt}),/invalid_course_run_session_dates/);
 const command=id(sequence++),saved=await action(db,'save_session',payload,command);assert.deepEqual(await action(db,'save_session',payload,command),saved);
 await assert.rejects(action(db,'save_session',{...payload,title:'Changed'},command),/academy_command_conflict/);
 await assert.rejects(action(db,'save_session',payload),/academy_schedule_conflict/);
 await assert.rejects(save(db,{startsAt:payload.startsAt,endsAt:payload.endsAt}),/course_run_sessions_overlap/);
 let data=await snapshot(db),session=data.sessions[0];
 await db.query("insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status,marked_by_subject_id) values($1,$2,$3,$4,'present',$5)",[T,RUN,session.id,ENROLLMENT,MANAGER]);
 const guarded={...payload,expectedRunVersion:data.selectedRun.version,sessionId:session.id,expectedSessionVersion:session.version};
 await assert.rejects(action(db,'save_session',{...guarded,startsAt:new Date(Date.now()-7300000).toISOString()}),/recorded_session_schedule_locked/);
 await assert.rejects(action(db,'cancel_session',{...guarded,reason:'Cancelled during review'}),/recorded_session_schedule_locked/);
 assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,1);
 data=await snapshot(db);await action(db,'save_session',{...guarded,expectedRunVersion:data.selectedRun.version,title:'Corrected lesson title'});
 assert.equal((await snapshot(db)).sessions[0].title,'Corrected lesson title');
});

test('run closure requires explicit review, ended and completed sessions and attendance; cancellation preserves history and certificate policies',async t=>{
 const db=await setup({governance:true});t.after(()=>db.close());
 await login(db,ADMIN_AUTH);await seedEnrollment(db);await db.query("update academy.enrollments set enrolled_at=now()-interval '3 hours' where id=$1",[ENROLLMENT]);await login(db,MANAGER_AUTH);
 await save(db);let data=await snapshot(db),session=data.sessions[0];
 const change=(name,more={})=>action(db,name,{runId:RUN,expectedRunVersion:data.selectedRun.version,sessionId:session.id,expectedSessionVersion:session.version,...more});
 await assert.rejects(change('complete_run'),/academy_schedule_review_required/);
 await assert.rejects(change('complete_run',{reviewed:true}),/course_run_sessions_not_completed/);
 await assert.rejects(change('complete_session',{reviewed:true}),/attendance_unrecorded_blocks_closure/);
 await db.query("insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status,marked_by_subject_id) values($1,$2,$3,$4,'present',$5)",[T,RUN,session.id,ENROLLMENT,MANAGER]);
 await change('complete_session',{reviewed:true});data=await snapshot(db);session=data.sessions[0];assert.equal(session.status,'completed');
 await assert.rejects(change('save_session',{title:'Rewrite history'}),/academy_schedule_session_locked/);
 const policies=(await db.query('select * from academy.course_run_rules')).rows;
 await change('complete_run',{reviewed:true});assert.equal((await snapshot(db)).selectedRun.status,'completed');
 assert.deepEqual((await db.query('select * from academy.course_run_rules')).rows,policies);assert.equal((await db.query('select count(*)::int n from academy.certificates')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,1);
 const second=id(sequence++);await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,delivery_mode,status) select $1,tenant_id,course_id,'CANCEL-SCHEDULE','online','open' from academy.course_runs where id=$2",[second,RUN]);
 const fresh=await snapshot(db,second),saved=await action(db,'save_session',{runId:second,expectedRunVersion:fresh.selectedRun.version,title:'Cancelled lesson',startsAt:'2030-01-01T10:00:00Z',endsAt:'2030-01-01T11:00:00Z',deliveryMode:'online',meetingUrl:'https://meet.example.test/second'});
 const next=await snapshot(db,second);await assert.rejects(action(db,'complete_session',{runId:second,expectedRunVersion:next.selectedRun.version,sessionId:saved.sessionId,expectedSessionVersion:next.sessions[0].version,reviewed:true}),/course_run_sessions_not_ended/);
 await action(db,'cancel_session',{runId:second,expectedRunVersion:next.selectedRun.version,sessionId:saved.sessionId,expectedSessionVersion:next.sessions[0].version,reason:'Schedule changed by center'});
 assert.equal((await snapshot(db,second)).sessions[0].status,'cancelled');
});
