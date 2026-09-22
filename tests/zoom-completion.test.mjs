import test from 'node:test';import assert from 'node:assert/strict';
import{zoomSetup,connect,syncHost,service,seedEnrollment,call,id,T,RUN,ENROLLMENT}from'./fixtures/zoom-database.mjs';
test('ZM-05/07/08 T35/37/40: old end cannot end restart, manual identity cannot fill unknown duration, course eligibility weights seconds',async()=>{
 const db=await zoomSetup({complete:true});try{
 await seedEnrollment(db);const connection=(await connect(db)).connectionId;await syncHost(db,connection);await service(db);
 const host=(await db.query('select id from zoom_core.hosts')).rows[0].id;const sid=id(73001),lid=id(73002);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,status) values($1,$2,$3,1,'Short synthetic session','2030-01-01T10:00Z','2030-01-01T11:00Z','online','completed')",[sid,T,RUN]);
 await db.query("insert into zoom_core.links(id,tenant_id,session_id,connection_id,host_id,meeting_id,state) values($1,$2,$3,$4,$5,'73001','live')",[lid,T,sid,connection,host]);
 await db.query("insert into zoom_core.instances(tenant_id,connection_id,link_id,uuid,started_at) values($1,$2,$3,'old','2030-01-01T10:00Z'),($1,$2,$3,'restart','2030-01-01T10:30Z')",[T,connection,lid]);
 await call(db,'public.v1_zoom_receive_event',{p_environment:'test',p_dedupe:'73001'.padEnd(64,'0'),p_event:{accountId:'account-A',event:'meeting.ended',eventTs:Date.parse('2030-01-01T10:20Z'),meetingId:'73001',uuid:'old',endTime:'2030-01-01T10:20Z'}});
 await call(db,'public.v1_zoom_process_events',{});assert.equal((await db.query('select state from zoom_core.links where id=$1',[lid])).rows[0].state,'live');
 await db.query("update zoom_core.instances set ended_at='2030-01-01T11:00Z',evidence_state='complete' where link_id=$1",[lid]);
 await db.query("update zoom_core.links set state='ended' where id=$1",[lid]);
 await db.query("insert into zoom_core.roster(tenant_id,link_id,enrollment_id,source) values($1,$2,$3,'synthetic')",[T,lid,ENROLLMENT]);
 await db.query("insert into academy.course_run_rules(tenant_id,course_run_id) values($1,$2) on conflict do nothing",[T,RUN]);
 await service(db,false);await call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'teaching_window',p_command_id:id(73003),p_payload:{linkId:lid,startsAt:'2030-01-01T10:00Z',endsAt:'2030-01-01T11:00Z',reason:'Synthetic approved full teaching window'}});
 await db.query("insert into zoom_core.intervals(tenant_id,instance_id,enrollment_id,participant_key,joined_at,source,source_key,quality) select $1,id,$2,'p','2030-01-01T10:00Z','report','unknown-exit','manual' from zoom_core.instances where link_id=$3 and uuid='old'",[T,ENROLLMENT,lid]);
 assert.equal((await call(db,'zoom_core.attendance',{t:T,lid,eid:ENROLLMENT})).quality,'incomplete');
 await assert.rejects(call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'approve_attendance',p_command_id:id(73004),p_payload:{linkId:lid,enrollmentId:ENROLLMENT,reason:'No fabricated final attendance'}}),/zoom_evidence_incomplete/);
 await db.query("update zoom_core.intervals set left_at='2030-01-01T10:01Z' where source_key='unknown-exit'");
 await call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'approve_attendance',p_command_id:id(73005),p_payload:{linkId:lid,enrollmentId:ENROLLMENT,reason:'Complete short session evidence'}});
 const sid2=id(73006);await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,status) values($1,$2,$3,2,'Three-hour classroom','2030-01-02T10:00Z','2030-01-02T13:00Z','onsite','completed')",[sid2,T,RUN]);
 await db.query("insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status) values($1,$2,$3,$4,'present')",[T,RUN,sid2,ENROLLMENT]);
 const result=await call(db,'private_app.training_eligibility',{p_enrollment_id:ENROLLMENT});assert.equal(result.attendancePercent,75.42);assert.equal(result.zoomWeightedAttendance.requiredSeconds,14400);assert.equal(result.zoomWeightedAttendance.attendedSeconds,10860);assert.equal(result.reasons.includes('attendance_below_threshold'),false);
 // The same weighted authority is visible to canonical eligibility; other
 // certificate/content/finance reasons are preserved, never bypassed here.
 assert.equal(result.reasons.includes('assessment_missing'),true);
 }finally{await db.close();}
});
