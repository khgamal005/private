import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceEvidence,matchParticipant,hmac,verifyWebhook,reportCsv} from '../supabase/functions/_shared/zoom-evidence.mjs';
import {zoomSetup,connect,syncHost,service,seedEnrollment,call,id,T,OTHER,RUN,ENROLLMENT,ADMIN,STUDENT} from './fixtures/zoom-database.mjs';
test('ZM-07 T32–36: duration union, breaks, unknown exits and conflicting identities',()=>{
 const at=n=>n*60*1000;
 const spans=times=>times.map(([a,b])=>({joinedAt:at(a),leftAt:at(b)}));
 const first=attendanceEvidence(spans([[0,35],[50,105]]),[0,at(120)],[],{complete:true});assert.equal(first.attendedSeconds,5400);assert.equal(first.percent,75);
 const second=attendanceEvidence(spans([[0,50],[30,70]]),[0,at(120)],[],{complete:true});assert.equal(second.attendedSeconds,4200);
 assert.equal(attendanceEvidence(spans([[-20,130]]),[0,at(120)],[[at(50),at(60)]],{complete:true}).attendedSeconds,6600);
 assert.equal(attendanceEvidence([{joinedAt:100,leftAt:null}],[0,at(120)],[],{complete:true}).quality,'incomplete');
 assert.equal(attendanceEvidence([],['invalid','invalid']).percent,null);
 assert.equal(matchParticipant({user_email:'same@example.test'},[{email:'same@example.test',emailVerified:true},{email:'same@example.test',emailVerified:true}]).quality,'ambiguous');
 assert.equal(matchParticipant({name:'same'},[{name:'same'}]).quality,'unmatched');
});
test('ZM-13/14 T38/58: raw signed body, timestamp and formula-safe exports',async()=>{
 const body='{"event":"meeting.started"}',secret='synthetic-webhook',timestamp=Math.floor(Date.now()/1000).toString();
 const headers=new Headers({'x-zm-request-timestamp':timestamp,'x-zm-signature':`v0=${await hmac(secret,`v0:${timestamp}:${body}`)}`});
 assert.equal(await verifyWebhook(body,headers,secret),true);assert.equal(await verifyWebhook(body+' ',headers,secret),false);assert.equal(await verifyWebhook(body,headers,secret,Date.now()+400000),false);
 assert.ok(reportCsv([['=HYPERLINK("bad")',' @SUM(A1)','safe']]).includes("'=HYPERLINK"));
});
test('ZM-07/08/09/14: executable evidence schema, canonical review, duplicate events and cross-tenant denial',async()=>{
 const db=await zoomSetup({recordings:true});
 try{
  await seedEnrollment(db);const connection=(await connect(db)).connectionId;await syncHost(db,connection);await service(db);
  const host=(await db.query('select id from zoom_core.hosts')).rows[0].id;const sid=id(3001),lid=id(3002),iid=id(3003);
  await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,status) values($1,$2,$3,1,'Evidence session','2030-01-01T10:00:00Z','2030-01-01T12:00:00Z','online','completed')",[sid,T,RUN]);
  await db.query("insert into zoom_core.links(id,tenant_id,session_id,connection_id,host_id,meeting_id,state) values($1,$2,$3,$4,$5,'123','ended')",[lid,T,sid,connection,host]);
  await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid,started_at,ended_at,evidence_state) values($1,$2,$3,$4,'instance-1','2030-01-01T10:00:00Z','2030-01-01T12:00:00Z','complete')",[iid,T,connection,lid]);
  await db.query("insert into zoom_core.roster(tenant_id,link_id,enrollment_id,source) values($1,$2,$3,'synthetic')",[T,lid,ENROLLMENT]);
  await db.query('insert into academy.course_run_rules(tenant_id,course_run_id) values($1,$2) on conflict do nothing',[T,RUN]);
  await db.query("insert into zoom_core.intervals(tenant_id,instance_id,enrollment_id,participant_key,joined_at,left_at,source,source_key,quality) values($1,$2,$3,'p','2030-01-01T10:00:00Z','2030-01-01T10:35:00Z','report','a','matched'),($1,$2,$3,'p','2030-01-01T11:00:00Z','2030-01-01T11:55:00Z','report','b','matched')",[T,iid,ENROLLMENT]);
  await service(db,false);
  await call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'teaching_window',p_command_id:id(3004),p_payload:{linkId:lid,startsAt:'2030-01-01T10:00:00Z',endsAt:'2030-01-01T12:00:00Z',reason:'Reviewed synthetic teaching window'}});
  const computed=await call(db,'zoom_core.attendance',{t:T,lid,eid:ENROLLMENT});assert.equal(computed.percent,75);assert.equal(computed.quality,'complete');
  const approved=await call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'approve_attendance',p_command_id:id(3005),p_payload:{linkId:lid,enrollmentId:ENROLLMENT,reason:'Reviewed matching evidence'}});assert.equal(approved.status,'present');
  await call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'override_attendance',p_command_id:id(3006),p_payload:{linkId:lid,enrollmentId:ENROLLMENT,status:'excused',reason:'Approved absence exception'}});
  await assert.rejects(call(db,'public.v1_zoom_review',{p_slug:'marktone',p_action:'approve_attendance',p_command_id:id(3007),p_payload:{linkId:lid,enrollmentId:ENROLLMENT,reason:'Replayed automatic evidence'}}),/zoom_manual_override_preserved/);
  await assert.rejects(db.query("insert into zoom_core.registrations(tenant_id,link_id,enrollment_id,student_id) values($1,$2,$3,$4)",[OTHER,lid,ENROLLMENT,STUDENT]),/foreign key/);
  await service(db);const args={p_environment:'test',p_dedupe:'a'.repeat(64),p_event:{accountId:'account-A',event:'meeting.started',eventTs:Date.now(),meetingId:'123',uuid:'instance-1'}};
  assert.equal((await call(db,'public.v1_zoom_receive_event',args)).status,'stored');assert.equal((await call(db,'public.v1_zoom_receive_event',args)).status,'duplicate');
  await call(db,'public.v1_zoom_process_events',{});assert.equal((await db.query('select state from zoom_core.links where id=$1',[lid])).rows[0].state,'ended');
  assert.equal((await db.query('select count(*)::int n from academy.attendance_records')).rows[0].n,1);
  assert.equal((await db.query('select marked_by_subject_id from academy.attendance_records')).rows[0].marked_by_subject_id,ADMIN);
 }finally{await db.close();}
});
