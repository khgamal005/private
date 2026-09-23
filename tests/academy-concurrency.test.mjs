import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {checkoutSetup,checkoutOffer,checkoutOrder,verificationPayload,storeAction,requestAction,nextCommand,login,id,T,MANAGER,MANAGER_AUTH,call} from './fixtures/academy-concurrency-database.mjs';

import {applyDeliveryMigrations,mediaAction,deliveryCommand} from './fixtures/academy-delivery-database.mjs';
import {ADMIN_AUTH,STAFF} from './fixtures/academy-platform-database.mjs';

const databaseUrl=process.env.ACADEMY_TEST_DATABASE_URL;
function localTestUrl(value){
  const parsed=new URL(value);
  assert.ok(['postgres:','postgresql:'].includes(parsed.protocol),'PostgreSQL URL required');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'Only loopback test databases are permitted');
  assert.equal(parsed.pathname,'/academy_concurrency','Dedicated academy_concurrency database required');
  assert.equal(parsed.search,'','Connection URL overrides are not permitted');
  assert.equal(parsed.hash,'','Connection URL fragments are not permitted');
  return parsed.toString();
}
async function blockedBarrier(controller,workerPids,controllerPid){
  const deadline=performance.now()+4000;
  while(performance.now()<deadline){
    await controller.query('select pg_stat_clear_snapshot()');
    const {rows}=await controller.query('select pid,wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=any($1::int[])',[workerPids]);
    const byPid=new Map(rows.map(row=>[row.pid,row]));
    const reachesController=(pid,seen=new Set())=>{
      if(pid===controllerPid)return true;if(seen.has(pid))return false;seen.add(pid);
      return (byPid.get(pid)?.blockers??[]).some(blocker=>reachesController(blocker,seen));
    };
    if(workerPids.every(pid=>byPid.get(pid)?.wait_event_type==='Lock'&&reachesController(pid)))return;
    await yieldTurn();
  }
  throw new Error('Both concurrent transactions did not reach the controlled lock barrier');
}
async function transaction(client,operation){
  try{await client.query('begin');const value=await operation(client);await client.query('commit');return {ok:true,value};}
  catch(error){await client.query('rollback');return {ok:false,error:{code:error.code,message:error.message}};}
}
async function race(controller,workers,lock,operations){
  await controller.query('begin');let pending;
  try{
    await lock(controller);
    const controllerPid=(await controller.query('select pg_backend_pid() pid')).rows[0].pid;
    const pids=await Promise.all(workers.map(async client=>(await client.query('select pg_backend_pid() pid')).rows[0].pid));
    pending=workers.map((client,index)=>transaction(client,operations[index]));
    await blockedBarrier(controller,pids,controllerPid);
    await controller.query('commit');
    return await Promise.all(pending);
  }finally{await controller.query('rollback');if(pending)await Promise.all(pending);}
}
const counters=async db=>(await db.query("select (select count(*)::int from accounting_core.payments) payments,(select count(*)::int from accounting_core.sales_documents) invoices,(select count(*)::int from accounting_core.payment_allocations) allocations")).rows[0];

test('academy concurrency refuses shared or remote database URLs before connecting',()=>{
  assert.equal(localTestUrl('postgres://fixture:fixture@127.0.0.1:5432/academy_concurrency'),'postgres://fixture:fixture@127.0.0.1:5432/academy_concurrency');
  for(const value of ['postgres://fixture:fixture@database.example/academy_concurrency','postgres://fixture:fixture@localhost/postgres','postgres://fixture:fixture@localhost/academy_concurrency?host=remote.example','postgres://fixture:fixture@localhost/academy_concurrency#production','https://localhost/academy_concurrency'])assert.throws(()=>localTestUrl(value));
});

test('real PostgreSQL serializes academy checkout and request transfers',{
  skip:!databaseUrl&&'Requires explicit disposable local ACADEMY_TEST_DATABASE_URL',timeout:90000
},async t=>{
  const connectionString=localTestUrl(databaseUrl);
  const {Client}=await import('pg'); // Pinned CI-only driver; never app credentials.
  const clients=[];t.after(async()=>{await Promise.allSettled(clients.map(client=>client.end()));});
  for(const label of ['controller','worker-a','worker-b']){
    const client=new Client({connectionString,application_name:`academy-concurrency-${label}`,connectionTimeoutMillis:5000,statement_timeout:12000,lock_timeout:8000});
    clients.push(client);await client.connect();
  }
  const [controller,...workers]=clients;
  assert.equal((await controller.query('select current_database() name')).rows[0].name,'academy_concurrency');
  assert.equal((await controller.query("select count(*)::int n from pg_namespace where nspname in ('academy','core','access_control','accounting_core')")).rows[0].n,0,'Refusing to overwrite existing schemas; start a fresh disposable service');
  const db={query:(sql,params)=>controller.query(sql,params),exec:sql=>controller.query(sql),close:async()=>{}};
  await checkoutSetup({database:db});
  for(const worker of workers){await login(worker,MANAGER_AUTH);await worker.query("select set_config('fixture.addon','no',false)");}
  assert.equal((await db.query('select count(*)::int n from access_control.memberships where subject_id=$1',[MANAGER])).rows[0].n,0);
  const sourceOffer=await checkoutOffer(db,{capacity:2});
  let firstEnrollment;

  await t.test('identical verification command returns one enrollment, payment, allocation and command result',async()=>{
    const order=await checkoutOrder(db,sourceOffer.offerId,901),commandId=nextCommand(),payload=verificationPayload(order);
    const results=await race(controller,workers,
      client=>client.query('select pg_advisory_xact_lock(hashtextextended($1,220926))',[`${T}:academy-store-command:${commandId}`]),
      workers.map(()=>client=>storeAction(client,'verify_order',payload,commandId)));
    assert.equal(results.filter(result=>result.ok).length,2,JSON.stringify(results));
    assert.deepEqual(results[0].value,results[1].value);firstEnrollment=results[0].value.enrollmentId;
    assert.ok(firstEnrollment);
    assert.equal((await db.query('select count(*)::int n from academy.store_commands where tenant_id=$1 and command_id=$2 and result is not null',[T,commandId])).rows[0].n,1);
    assert.deepEqual((await db.query("select count(*)::int n,sum(amount_minor)::int amount from accounting_core.payments where tenant_id=$1 and source_type='academy_store' and source_id=$2",[T,order.id])).rows[0],{n:1,amount:order.totalMinor});
    assert.equal((await db.query('select count(*)::int n from academy.enrollments where tenant_id=$1 and id=$2',[T,firstEnrollment])).rows[0].n,1);
    assert.deepEqual((await db.query('select count(*)::int n,sum(a.amount_minor)::int amount from accounting_core.payment_allocations a join academy.store_orders o on o.payment_id=a.payment_id and o.invoice_id=a.invoice_id where o.tenant_id=$1 and o.id=$2',[T,order.id])).rows[0],{n:1,amount:order.totalMinor});
  });

  await t.test('two separately paid orders racing for the final seat commit one canonical financial chain',async()=>{
    const offer=await checkoutOffer(db,{capacity:1});
    const orders=[await checkoutOrder(db,offer.offerId,902),await checkoutOrder(db,offer.offerId,903)];
    const commandIds=orders.map(()=>nextCommand());
    const results=await race(controller,workers,
      client=>client.query('select id from academy.course_runs where tenant_id=$1 and id=$2 for update',[T,offer.runId]),
      orders.map((order,index)=>client=>storeAction(client,'verify_order',verificationPayload(order),commandIds[index])));
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.message==='course_run_full').length,1,JSON.stringify(results));
    assert.equal((await db.query('select count(*)::int n from academy.enrollments where tenant_id=$1 and course_run_id=$2',[T,offer.runId])).rows[0].n,1);
    assert.equal((await db.query('select enrolled_count from academy.course_runs where tenant_id=$1 and id=$2',[T,offer.runId])).rows[0].enrolled_count,1);
    assert.equal((await db.query("select count(*)::int n from accounting_core.payments where tenant_id=$1 and source_type='academy_store' and source_id=any($2::text[])",[T,orders.map(order=>order.id)])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from accounting_core.sales_documents where tenant_id=$1 and source_type='academy_store' and source_id=any($2::text[])",[T,orders.map(order=>order.id)])).rows[0].n,1);
    assert.deepEqual((await db.query("select status,count(*)::int n from academy.store_orders where tenant_id=$1 and id=any($2::uuid[]) group by status order by status",[T,orders.map(order=>order.id)])).rows,[{status:'enrolled',n:1},{status:'payment_review',n:1}]);
    assert.equal((await db.query('select count(*)::int n from academy.store_commands where tenant_id=$1 and command_id=any($2::uuid[])',[T,commandIds])).rows[0].n,1);
  });

  await t.test('competing approved transfers preserve one remaining seat and reuse each original invoice',async()=>{
    const order=await checkoutOrder(db,sourceOffer.offerId,904);
    const second=await storeAction(db,'verify_order',verificationPayload(order));
    const sourceEnrollments=[firstEnrollment,second.enrollmentId],targetRun=id(50900);
    await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity) values($1,$2,$3,'RACE-TRANSFER','Final transfer seat','hybrid','open',1)",[targetRun,T,sourceOffer.courseId]);
    const requests=[];
    for(const enrollmentId of sourceEnrollments)requests.push(await requestAction(db,'create_request',{enrollmentId,kind:'transfer',targetRunId:targetRun,reason:'Fixture requested another cohort'}));
    const before=await counters(db);
    const results=await race(controller,workers,
      client=>client.query('select id from academy.course_runs where tenant_id=$1 and id=$2 for update',[T,targetRun]),
      requests.map(request=>client=>requestAction(client,'decide_request',{requestId:request.requestId,decision:'approve',reason:'Reviewed same-course seat transfer'})));
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.message==='training_run_full').length,1,JSON.stringify(results));
    assert.deepEqual(await counters(db),before,'Transfers must not create additional invoices, payments or allocations');
    assert.equal((await db.query("select count(*)::int n from academy.enrollments where tenant_id=$1 and course_run_id=$2 and status in ('confirmed','active','completed')",[T,targetRun])).rows[0].n,1);
    assert.deepEqual((await db.query('select id,enrolled_count from academy.course_runs where tenant_id=$1 and id=any($2::uuid[]) order by id',[T,[sourceOffer.runId,targetRun]])).rows.map(row=>row.enrolled_count),[1,1]);
    const winner=results.findIndex(result=>result.ok),newEnrollmentId=results[winner].value.newEnrollmentId;
    assert.ok(newEnrollmentId);
    const links=(await db.query('select e.id,l.invoice_id,v.version_id from academy.enrollments e join academy.training_financial_links l on l.tenant_id=e.tenant_id and l.handoff_id=e.handoff_id join academy.training_enrollment_versions v on v.tenant_id=e.tenant_id and v.enrollment_id=e.id where e.tenant_id=$1 and e.id=any($2::uuid[])',[T,[sourceEnrollments[winner],newEnrollmentId]])).rows;
    assert.equal(links.length,2);assert.equal(links[0].invoice_id,links[1].invoice_id);assert.equal(links[0].version_id,links[1].version_id);
    assert.equal((await db.query('select status from academy.platform_requests where id=$1',[requests[1-winner].requestId])).rows[0].status,'pending');
    assert.equal((await db.query('select status from academy.enrollments where id=$1',[sourceEnrollments[1-winner]])).rows[0].status,'confirmed');
  });

  await db.exec(await readFile(new URL('../supabase/migrations/20260922192706_academy_course_authoring_v1.sql',import.meta.url),'utf8'));
  await db.query('insert into academy.authoring_settings(tenant_id,enabled) values($1,true)',[T]);
  const author=(client,p_action,p_payload,p_command_id=nextCommand())=>call(client,'public.v1_academy_authoring_action',{p_slug:'marktone',p_action,p_payload,p_command_id});
  const courseLock=courseId=>client=>client.query('select id from academy.courses where tenant_id=$1 and id=$2 for update',[T,courseId]);
  const doc=title=>({title,description:'Synthetic concurrent authoring',category:'Training',level:'all',language:'ar',learningMode:'self_paced',policy:{minAttendancePercent:0,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:false,termsVersion:'2026',supportEmail:'support@example.test'},topics:[{id:'assessment',title:'Assessment',summary:'',units:[{id:'quiz',title:'Final quiz',kind:'quiz',required:true,questions:[{id:'q1',prompt:'Choose the valid answer',options:['Correct','Wrong'],correctOptionIndex:0}]}]}]});
  let authored;

  await t.test('simultaneous identical authoring commands create one canonical course and one audit event',async()=>{
    const commandId=nextCommand(),payload={title:'Concurrent authoring course'};
    const before=(await db.query("select count(*)::int n from academy.training_learning_events where event_type='authoring_create_course'")).rows[0].n;
    const results=await race(controller,workers,
      client=>client.query('select pg_advisory_xact_lock(hashtextextended($1,91216))',[`${T}:${commandId}`]),
      workers.map(()=>client=>author(client,'create_course',payload,commandId)));
    assert.equal(results.filter(result=>result.ok).length,2,JSON.stringify(results));
    assert.deepEqual(results[0].value,results[1].value);authored=results[0].value;
    assert.equal((await db.query('select count(*)::int n from academy.courses where tenant_id=$1 and id=$2',[T,authored.courseId])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from academy.training_learning_events where event_type='authoring_create_course'")).rows[0].n,before+1);
  });

  await t.test('two editors saving the same revision preserve one winner and reject the stale writer',async()=>{
    const commandIds=workers.map(()=>nextCommand());
    const results=await race(controller,workers,courseLock(authored.courseId),workers.map((_,index)=>client=>author(client,'save_course',{courseId:authored.courseId,expectedRevision:1,document:doc(`Concurrent draft ${index}`)},commandIds[index])));
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.message==='academy_authoring_revision_conflict').length,1,JSON.stringify(results));
    const winner=results.findIndex(result=>result.ok);
    assert.deepEqual((await db.query("select revision,document->>'title' title from academy.course_authoring where tenant_id=$1 and course_id=$2",[T,authored.courseId])).rows[0],{revision:2,title:`Concurrent draft ${winner}`});
    assert.equal((await db.query('select count(*)::int n from academy.training_journey_commands where tenant_id=$1 and command_id=any($2::uuid[])',[T,commandIds])).rows[0].n,1);
  });

  await t.test('distinct concurrent publish commands create one immutable version and no financial changes',async()=>{
    const before=await counters(db),payload={courseId:authored.courseId,expectedRevision:2,humanReviewed:true};
    const results=await race(controller,workers,courseLock(authored.courseId),workers.map(()=>client=>author(client,'publish_course',payload)));
    assert.equal(results.filter(result=>result.ok).length,2,JSON.stringify(results));
    assert.deepEqual(results[0].value,results[1].value);
    assert.equal((await db.query('select count(*)::int n from academy.training_course_versions where tenant_id=$1 and course_id=$2',[T,authored.courseId])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from academy.course_authoring_releases where tenant_id=$1 and course_id=$2',[T,authored.courseId])).rows[0].n,1);
    assert.deepEqual(await counters(db),before);
  });

  await t.test('concurrent path edits and publication preserve revision and one immutable release',async()=>{
    const path=await author(db,'save_path',{expectedRevision:0,document:{title:'Concurrent path',courseIds:[authored.courseId]}});
    const pathLock=client=>client.query('select id from academy.learning_paths where tenant_id=$1 and id=$2 for update',[T,path.pathId]);
    const edits=await race(controller,workers,pathLock,workers.map((_,index)=>client=>author(client,'save_path',{pathId:path.pathId,expectedRevision:1,document:{title:`Concurrent path edit ${index}`,courseIds:[authored.courseId]}})));
    assert.equal(edits.filter(result=>result.ok).length,1,JSON.stringify(edits));
    assert.equal(edits.filter(result=>!result.ok&&result.error.message==='academy_authoring_revision_conflict').length,1,JSON.stringify(edits));
    const results=await race(controller,workers,pathLock,workers.map(()=>client=>author(client,'publish_path',{pathId:path.pathId,expectedRevision:2,humanReviewed:true})));
    assert.equal(results.filter(result=>result.ok).length,2,JSON.stringify(results));assert.deepEqual(results[0].value,results[1].value);
    assert.equal((await db.query('select count(*)::int n from academy.learning_path_releases where tenant_id=$1 and path_id=$2',[T,path.pathId])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from academy.learning_path_release_courses where tenant_id=$1 and path_id=$2',[T,path.pathId])).rows[0].n,1);
  });

  await applyDeliveryMigrations(db);
  await t.test('parallel upload tickets with one command share one immutable storage object',async()=>{
    const command=deliveryCommand(),payload={courseId:authored.courseId,fileName:'parallel.mp4',mimeType:'video/mp4',sizeBytes:100};
    const results=await race(controller,workers,courseLock(authored.courseId),workers.map(()=>client=>mediaAction(client,'create_upload',payload,command)));
    assert.equal(results.filter(row=>row.ok).length,2,JSON.stringify(results));assert.deepEqual(results[0].value,results[1].value);
    assert.equal((await db.query('select count(*)::int n from academy.course_media where tenant_id=$1 and command_id=$2',[T,command])).rows[0].n,1);
    const asset=results[0].value;
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('academy-course-media',$1,$2)",[asset.objectPath,JSON.stringify({size:100,mimetype:'video/mp4'})]);
    await mediaAction(db,'complete_upload',{assetId:asset.assetId});
    const policies=await race(controller,workers,client=>client.query('select id from academy.course_media where id=$1 for update',[asset.assetId]),workers.map(()=>client=>mediaAction(client,'set_download',{assetId:asset.assetId,allowDownload:true,expectedVersion:1})));
    assert.equal(policies.filter(row=>row.ok).length,1,JSON.stringify(policies));assert.equal(policies.filter(row=>row.error?.message==='academy_media_policy_conflict').length,1);
  });

  await db.query("update academy.platform_settings set mode='connected' where tenant_id=$1",[T]);
  for(const client of clients)await login(client,ADMIN_AUTH);
  await t.test('parallel manual additions converge to one canonical student and contact',async()=>{
    const payload={name:'Parallel canonical student',phone:'966509998811',email:'parallel@example.test'};
    const results=await race(controller,workers,client=>client.query('select pg_advisory_xact_lock(hashtextextended($1,220926))',[`${T}:academy-person:${payload.phone}`]),workers.map(()=>client=>call(client,'public.v1_academy_people_action',{p_slug:'marktone',p_action:'add_student',p_command_id:deliveryCommand(),p_payload:payload})));
    assert.equal(results.filter(row=>row.ok).length,2,JSON.stringify(results));assert.deepEqual(results[0].value,results[1].value);
    assert.equal((await db.query('select count(*)::int n from academy.students where contact_id=$1',[results[0].value.contactId])).rows[0].n,1);
  });
  await t.test('two different course purchases share the existing daily capacity without losing either enrollment',async()=>{
    await db.query("update people.staff_profiles set role_key='sales_manager' where id=$1",[STAFF]);
    await db.query('insert into sales_core.sales_assignment_profiles(tenant_id,staff_id,daily_capacity) values($1,$2,1)',[T,STAFF]);
    await db.query("insert into sales_core.commerce_order_routing_settings values($1,'auto_fair',$2,60)",[T,STAFF]);
    await db.query('insert into academy.training_journey_settings(tenant_id,automation_admissions_staff_id) values($1,$2)',[T,STAFF]);
    const offers=[await checkoutOffer(db),await checkoutOffer(db)],orders=[];
    for(let i=0;i<offers.length;i++){orders.push(await checkoutOrder(db,offers[i].offerId,950+i));await login(db,ADMIN_AUTH);}
    const results=await race(controller,workers,client=>client.query('select id from academy.course_runs where tenant_id=$1 and id=any($2::uuid[]) order by id for update',[T,offers.map(row=>row.runId)]),orders.map(order=>client=>storeAction(client,'verify_order',verificationPayload(order))));
    assert.equal(results.filter(row=>row.ok).length,2,JSON.stringify(results));
    const operations=(await db.query('select routing_state,count(*)::int n from academy.order_operations where order_id=any($1::uuid[]) group by routing_state order by routing_state',[orders.map(row=>row.id)])).rows;
    assert.deepEqual(operations,[{routing_state:'assigned',n:1},{routing_state:'queue',n:1}]);
    assert.equal((await db.query('select count(*)::int n from academy.enrollments where id=any($1::uuid[])',[results.map(row=>row.value.enrollmentId)])).rows[0].n,2);
    assert.equal((await db.query("select count(*)::int n from accounting_core.payments where source_type='academy_store' and source_id=any($1::text[])",[orders.map(row=>row.id)])).rows[0].n,2);
  });

});
