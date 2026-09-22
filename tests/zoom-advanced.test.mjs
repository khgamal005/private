import test from 'node:test';import assert from 'node:assert/strict';
import {zoomSetup,call,id,T,OTHER,ADMIN,ADMIN_AUTH,LEARNER_AUTH,login,service,CONTACT} from './fixtures/zoom-database.mjs';
import {seedZoomLesson} from './fixtures/zoom-lesson.mjs';
async function permissions(db){for(const p of ['tenant.crm.read','tenant.crm.write','tenant.zoom.webinars.manage','tenant.zoom.ai.generate','tenant.zoom.reports.export']){await db.query("insert into access_control.permissions(permission_key,module_key,name_ar) values($1,'zoom',$1) on conflict do nothing",[p]);await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing',[id(21),p]);}}
const command=(db,fn,payload,n)=>call(db,fn,{p_slug:'marktone',p_command_id:id(n),p_payload:payload});

test('ZM-18 T52/53: webinar uses canonical deduplication/assignment and leaves enrollments and finance untouched',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());await permissions(db);const {link,connection,instance}=await seedZoomLesson(db,{kind:'webinar'});
 await call(db,'public.v1_zoom_webinar_action',{p_slug:'marktone',p_action:'webinar_configure',p_command_id:id(60001),p_payload:{linkId:link,source:'Synthetic campaign',consentVersion:'consent-v1'}});
 const before=(await db.query('select (select count(*) from academy.enrollments) enrollments,(select count(*) from accounting_core.payments) payments,(select count(*) from accounting_core.sales_documents) documents')).rows[0];
 const payload={linkId:link,name:'Synthetic webinar contact',email:'webinar.person@example.test',phone:'0509988776',registrationConsent:true,marketingConsent:false,consentVersion:'consent-v1'};
 const prepare=n=>call(db,'public.v1_zoom_webinar_action',{p_slug:'marktone',p_action:'webinar_prepare',p_command_id:id(n),p_payload:payload});
 const first=await prepare(60002);assert.deepEqual(await prepare(60003),first);
 assert.equal((await db.query('select count(*)::int n from sales_core.contacts where email=$1',[payload.email])).rows[0].n,1);
 const lease=id(60004);const ctx=await call(db,'public.v1_zoom_webinar_registration',{p_slug:'marktone',p_registration_id:first.registrationId,p_lease_id:lease});assert.equal(ctx.status,'register');
 await service(db);await call(db,'public.v1_zoom_webinar_complete',{p_registration_id:first.registrationId,p_lease_id:lease,p_generation:1,p_result:{registrant_id:'web-person-A',join_url:'https://zoom.us/w/123?tk=synthetic'}});
 await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid) values($1,$2,$3,$4,'web-instance-a'),($5,$2,$3,$4,'web-instance-b')",[instance,T,connection,link,id(60005)]);
 const op=id(60006),worker=id(60007);await db.query("insert into zoom_core.operations(id,tenant_id,connection_id,link_id,revision,kind,state,lease_id,lease_until,fence) values($1,$2,$3,$4,0,'reconcile','processing',$5,now()+interval '1 minute',1)",[op,T,connection,link,worker]);
 for(const [uuid,start,end]of [['web-instance-a','2030-01-01T10:00:00Z','2030-01-01T10:50:00Z'],['web-instance-b','2030-01-01T10:30:00Z','2030-01-01T11:10:00Z']])await call(db,'public.v1_zoom_webinar_evidence',{p_operation_id:op,p_lease_id:worker,p_fence:1,p_uuid:uuid,p_participants:[{registrant_id:'web-person-A',join_time:start,leave_time:end}],p_complete:true});
 assert.equal((await db.query('select attended_seconds from zoom_core.webinar_registrations')).rows[0].attended_seconds,4200);
 assert.deepEqual((await db.query('select (select count(*) from academy.enrollments) enrollments,(select count(*) from accounting_core.payments) payments,(select count(*) from accounting_core.sales_documents) documents')).rows[0],before);
 await service(db,false);await login(db,LEARNER_AUTH);await assert.rejects(call(db,'public.v1_zoom_webinar_snapshot',{p_slug:'marktone',p_link_id:link}),/zoom_forbidden/);
 await login(db,ADMIN_AUTH);const snapshot=await call(db,'public.v1_zoom_webinar_snapshot',{p_slug:'marktone',p_link_id:link});assert.equal(snapshot.revenue,null);assert.ok(!JSON.stringify(snapshot).includes('join_url'));assert.equal(snapshot.registrations.length,1);
 await service(db);await db.query("update zoom_core.connections set status='deauthorized' where id=$1",[connection]);await call(db,'public.v1_zoom_purge',{});assert.equal((await db.query('select attended_seconds,secret_id from zoom_core.webinar_registrations')).rows[0].attended_seconds,null);assert.equal((await db.query('select count(*)::int n from sales_core.contacts')).rows[0].n,2);assert.equal((await db.query('select count(*)::int n from sales_core.contacts where id=$1',[CONTACT])).rows[0].n,1);
});

test('ZM-19/14 T56/57/62: source versions, real Odeiry run authority, draft-only output and derivative cleanup',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());await permissions(db);const {link,connection,instance}=await seedZoomLesson(db);
 await db.query("insert into zoom_core.instances(id,tenant_id,connection_id,link_id,uuid) values($1,$2,$3,$4,'ai-instance')",[instance,T,connection,link]);const rec=id(60100);
 await db.query("insert into zoom_core.recordings(id,tenant_id,instance_id,provider_file_id,file_type,transcript,transcript_revision) values($1,$2,$3,'transcript-a','TRANSCRIPT','WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nIsolated material',1)",[rec,T,instance]);
 await command(db,'public.v1_zoom_settings',{expectedVersion:1,retentionDays:30,retentionApproved:true,providerLimitAcknowledged:true},60101);
 await assert.rejects(command(db,'public.v1_zoom_ai_prepare',{recordingId:rec,sourceRevision:1,kind:'summary',consent:true},60102),/zoom_ai_approval_required/);
 await command(db,'public.v1_zoom_ai_policy',{approved:true,reason:'Approved synthetic educational processing'},60103);
 await assert.rejects(command(db,'public.v1_zoom_ai_prepare',{recordingId:rec,sourceRevision:2,kind:'summary',consent:true},60104),/zoom_source_revision_conflict/);
 const draft=await command(db,'public.v1_zoom_ai_prepare',{recordingId:rec,sourceRevision:1,kind:'summary',consent:true},60105);await assert.rejects(call(db,'public.v1_zoom_ai_context',{p_slug:'marktone',p_draft_id:draft.draftId,p_run_id:id(60106)}),/zoom_ai_budget_required/);
 const thread=id(60107),run=id(60108);await db.query("insert into core.odeiry_threads(id,tenant_id,created_by_subject_id,title) values($1,$2,$3,'Synthetic Zoom draft')",[thread,T,ADMIN]);await db.query("insert into core.odeiry_runs(id,tenant_id,thread_id,requested_by_subject_id,client_request_id,request_hash,estimated_business_units) values($1,$2,$3,$4,$5,$6,80)",[run,T,thread,ADMIN,`zoom:${draft.draftId}`,'a'.repeat(64)]);
 const ctx=await call(db,'public.v1_zoom_ai_context',{p_slug:'marktone',p_draft_id:draft.draftId,p_run_id:run});assert.equal(ctx.sourceRevision,1);
 await db.query("update core.odeiry_runs set status='completed',completed_at=now(),finalization_hash=$2,response_data=$3,actual_model='synthetic-contract',input_tokens=100,output_tokens=30,settled_business_units=2 where id=$1",[run,'b'.repeat(64),{title:'Synthetic draft',summary:'Test material',sources:['s1']}]);
 const finished=await call(db,'public.v1_zoom_ai_finish',{p_slug:'marktone',p_draft_id:draft.draftId});assert.equal(finished.state,'draft');assert.equal((await db.query('select count(*)::int n from academy.course_authoring')).rows[0].n,0);
 await login(db,LEARNER_AUTH);await assert.rejects(call(db,'public.v1_zoom_ai_snapshot',{p_slug:'marktone',p_recording_id:rec}),/zoom_forbidden/);await login(db,ADMIN_AUTH);await service(db);await db.query("update zoom_core.connections set status='deauthorized' where id=$1",[connection]);await call(db,'public.v1_zoom_purge',{});
 assert.equal((await db.query('select state,content from zoom_core.ai_drafts')).rows[0].state,'source_removed');assert.deepEqual((await db.query('select response_data,settled_business_units from core.odeiry_runs')).rows[0],{response_data:{},settled_business_units:2});
 await assert.rejects(db.query('insert into zoom_core.ai_drafts(tenant_id,recording_id,source_revision,source_hash,requested_by,kind) values($1,$2,1,\'x\',$3,\'summary\')',[OTHER,rec,ADMIN]),/foreign key/);
});

test('ZM-02/16: bounded host synchronization preserves all pages, scopes and poll command idempotency',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {connection,host,link}=await seedZoomLesson(db);
 await call(db,'public.v1_zoom_resources_request',{p_slug:'marktone',p_connection_id:connection});await service(db);const lease=id(60201);const job=await call(db,'public.v1_zoom_resources_claim',{p_lease_id:lease});assert.equal(job.connectionId,connection);
 const page={id:'host-A',account_id:'account-A',display_name:'Synthetic',status:'active',type:2,capacity:100,capabilities:{meeting:true,registration:true,polls:true}};
 await call(db,'public.v1_zoom_resources_page',{p_connection_id:connection,p_lease_id:lease,p_fence:job.fence,p_generation:1,p_hosts:[page],p_next:'next',p_coverage:'complete'});
 const next=await call(db,'public.v1_zoom_resources_claim',{p_lease_id:id(60202)});await call(db,'public.v1_zoom_resources_page',{p_connection_id:connection,p_lease_id:id(60202),p_fence:next.fence,p_generation:1,p_hosts:[{...page,id:'host-B'}],p_next:'',p_coverage:'complete'});
 assert.equal((await db.query('select count(*)::int n from zoom_core.hosts where provider_active')).rows[0].n,2);
 await service(db,false);const poll={linkId:link,expectedVersion:0,title:'Synthetic poll',questions:[{type:'single',name:'Choose',answers:['One','Two']}]};const result=await command(db,'public.v1_zoom_poll',poll,60203);assert.deepEqual(await command(db,'public.v1_zoom_poll',poll,60203),result);
 assert.equal((await db.query("select count(*)::int n from zoom_core.operations where kind='poll'")).rows[0].n,1);await db.query("update zoom_core.hosts set capabilities='{}' where id=$1",[host]);await assert.rejects(command(db,'public.v1_zoom_poll',poll,60204),/zoom_scope_or_license_required/);
});

test('ZM-04/20: replacing an unstarted meeting keeps old capacity until provider cancellation is confirmed',async t=>{
 const {connect,syncHost,INSTRUCTOR}=await import('./fixtures/zoom-database.mjs');const db=await zoomSetup({complete:true});t.after(()=>db.close());const {link,host,session,connection}=await seedZoomLesson(db);
 await db.query("update zoom_core.links set revision=1,desired=desired||jsonb_build_object('startsAt','2031-02-01T10:00:00Z','endsAt','2031-02-01T11:00:00Z') where id=$1",[link]);
 await db.query("update academy.course_run_sessions set starts_at='2031-02-01T10:00:00Z',ends_at='2031-02-01T11:00:00Z' where id=$1",[session]);await db.query("insert into zoom_core.reservations(tenant_id,link_id,host_id,instructor_subject_id,slot,occupied_range,revision,state) values($1,$2,$3,$4,1,tstzrange('2031-02-01T09:55:00Z','2031-02-01T11:10:00Z'),1,'confirmed')",[T,link,host,INSTRUCTOR]);
 const other=(await connect(db,{account:'account-B',user:'host-B',state:'b'.repeat(64)})).connectionId;await syncHost(db,other,'account-B','host-B');const otherHost=(await db.query('select id from zoom_core.hosts where connection_id=$1',[other])).rows[0].id;
 await db.query('update zoom_core.hosts set allowed=true,instructor_subject_id=$1 where id=$2',[INSTRUCTOR,otherHost]);await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,provider_email,authorization_kind,verified_at) values($1,$2,$3,'host-B','instructor@example.test','host',now())",[T,otherHost,INSTRUCTOR]);await service(db,false);
 await assert.rejects(command(db,'public.v1_zoom_replace',{linkId:link,hostId:otherHost,expectedVersion:1,reason:'Approved synthetic replacement'},60301),/zoom_replacement_approval_required/);
 const payload={linkId:link,hostId:otherHost,expectedVersion:1,reason:'Approved synthetic replacement',impactApproved:true};const replacement=await command(db,'public.v1_zoom_replace',payload,60302);assert.equal(replacement.revision,2);assert.equal((await db.query("select count(*)::int n from zoom_core.reservations where state<>'released'")).rows[0].n,2);
 await service(db);const worker=id(60303),[job]=await call(db,'public.v1_zoom_claim',{p_lease_id:worker,p_limit:1});await call(db,'public.v1_zoom_operation_complete',{p_operation_id:job.id,p_lease_id:worker,p_fence:job.fence,p_generation:1,p_outcome:'complete',p_result:{id:'98765432101',host_id:'host-B',join_url:'https://zoom.us/j/98765432101',start_time:'2031-02-01T10:00:00Z',duration:60}});
 assert.equal((await db.query("select count(*)::int n from zoom_core.reservations where state<>'released'")).rows[0].n,2);
 const lease=id(60304),retired=await call(db,'public.v1_zoom_replaced_claim',{p_lease_id:lease});assert.equal(retired.connectionId,connection);assert.equal(retired.meetingId,'12345678901');await call(db,'public.v1_zoom_replaced_complete',{p_id:retired.id,p_lease_id:lease,p_fence:retired.fence,p_generation:1,p_cancelled:true});
 assert.equal((await db.query("select count(*)::int n from zoom_core.reservations where state<>'released'")).rows[0].n,1);assert.equal((await db.query('select meeting_id from zoom_core.replaced_meetings')).rows[0].meeting_id,'12345678901');assert.equal((await db.query('select connection_id from zoom_core.links where id=$1',[link])).rows[0].connection_id,other);
});
