import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutSetup,checkoutOffer,checkoutOrder,verificationPayload,storeAction,login,T,call,id} from './fixtures/academy-concurrency-database.mjs';
import {applyDeliveryMigrations,deliveryAction,deliveryCommand} from './fixtures/academy-delivery-database.mjs';
import {applyZoomMigrations,connect,syncHost,service,ADMIN,ADMIN_AUTH,INSTRUCTOR} from './fixtures/zoom-database.mjs';

for(const zoomFirst of [true,false])test(`connected academy and complete Zoom migrations coexist with ${zoomFirst?'production Zoom installed first':'academy delivery installed first'}`,async t=>{
 const db=await checkoutSetup();t.after(()=>db.close());
 if(zoomFirst){await applyZoomMigrations(db,{complete:true});await applyDeliveryMigrations(db);}
 else{await applyDeliveryMigrations(db);await applyZoomMigrations(db,{complete:true});}
 await login(db,ADMIN_AUTH);
 await db.query("update academy.platform_settings set mode='connected' where tenant_id=$1",[T]);
 const offer=await checkoutOffer(db,{capacity:5});
 await deliveryAction(db,'assign_instructor',{courseId:offer.courseId,runId:offer.runId,subjectId:INSTRUCTOR,active:true});
 const connection=(await connect(db)).connectionId;await syncHost(db,connection);
 const host=(await db.query('select id from zoom_core.hosts where connection_id=$1',[connection])).rows[0].id;
 await db.query('update zoom_core.hosts set allowed=true,instructor_subject_id=$1 where id=$2',[INSTRUCTOR,host]);
 await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,provider_email,authorization_kind,verified_at) values($1,$2,$3,'host-A','instructor@example.test','host',now())",[T,host,INSTRUCTOR]);
 const session=id(169001),lease=id(169002);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,1,'Managed course session','2030-01-01T10:00Z','2030-01-01T11:00Z','online')",[session,T,offer.runId]);
 await service(db,false);await login(db,ADMIN_AUTH);
 const scheduled=await call(db,'public.v1_zoom_action',{p_slug:'marktone',p_action:'assign',p_command_id:deliveryCommand(),p_payload:{sessionId:session,instructorId:INSTRUCTOR,expectedVersion:0,attendees:5}});
 assert.equal(scheduled.state,'queued');
 await service(db);const jobs=await call(db,'public.v1_zoom_claim',{p_lease_id:lease,p_limit:5});const job=jobs.find(item=>item.link_id===scheduled.linkId)||jobs[0];assert.ok(job);
 await call(db,'public.v1_zoom_operation_complete',{p_operation_id:job.id,p_lease_id:lease,p_fence:job.fence,p_outcome:'complete',p_result:{id:'12345678901',host_id:'host-A',join_url:'https://zoom.us/j/12345678901',start_time:'2030-01-01T10:00:00Z',duration:60,settings:{approval_type:0}}});
 await service(db,false);await login(db,ADMIN_AUTH);
 const view=await call(db,'public.v1_academy_course_delivery_snapshot',{p_slug:'marktone',p_course_id:offer.courseId});
 assert.equal(view.runs.find(run=>run.id===offer.runId).sessions[0].joinUrl,`/training/marktone/sessions/${session}`);
 const order=await checkoutOrder(db,offer.offerId,zoomFirst?899001:899002);await login(db,ADMIN_AUTH);
 const command=deliveryCommand(),payload=verificationPayload(order);
 const enrolled=await storeAction(db,'verify_order',payload,command);assert.deepEqual(await storeAction(db,'verify_order',payload,command),enrolled);
 assert.equal((await db.query('select count(*)::int n from academy.training_enrollment_versions where enrollment_id=$1',[enrolled.enrollmentId])).rows[0].n,1);
 assert.equal((await db.query("select count(*)::int n from accounting_core.payments where source_type='academy_store' and source_id=$1",[order.id])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from zoom_core.links where tenant_id=$1 and session_id=$2',[T,session])).rows[0].n,1);
 assert.equal((await db.query('select assigned_by_subject_id from academy.training_run_instructors where tenant_id=$1 and run_id=$2 and subject_id=$3',[T,offer.runId,INSTRUCTOR])).rows[0].assigned_by_subject_id,ADMIN);
});
