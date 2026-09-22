import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {setup,call,login,count,id,T,OTHER,ADMIN,ADMIN_AUTH,INSTRUCTOR_AUTH,COURSE,FOREIGN_COURSE,RUN} from './fixtures/training-journey-database.mjs';
const read=p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');
let seq=40000;
const admin=(db,p_action,p_payload,p_command_id=id(seq++),p_slug='marktone')=>call(db,'public.v1_academy_commerce_action',{p_slug,p_action,p_command_id,p_payload});
const buyer=(db,p_action,p_payload,p_command_id=id(seq++),p_slug='marktone')=>call(db,'public.v1_academy_store_order',{p_slug,p_action,p_command_id,p_payload});
const token='a'.repeat(64);
const person=n=>({name:`Store learner ${n}`,phone:`050${String(n).padStart(7,'0')}`,email:`store${n}@example.test`});
const orderPayload=(offerId,n,extra={})=>({offerId,learner:person(n),payerIsLearner:true,tokenHash:token,acceptedPolicy:true,...extra});
const review=(db,o)=>buyer(db,'report_transfer',{orderId:o.id,tokenHash:token,reference:`TRANSFER-${o.id}`});
const verify=(db,o,extra={})=>admin(db,'verify_order',{orderId:o.id,receivedMinor:o.totalMinor,bankReference:`BANK-${o.id}`,receivedAt:new Date(Date.now()-60000).toISOString(),identityConfirmed:true,...extra});
async function prepared(){
 const db=await setup({learning:true});
 try{
  // External subscription seam only. Authenticated identity/ACL, canonical
  // finance, learner, handoff, enrollment and immutability functions are real.
  await db.exec(`create table academy.platform_settings(tenant_id uuid primary key,mode text,enabled boolean);
   insert into academy.platform_settings values('${T}','standalone',true);
   create function private_app.academy_platform_enabled_v1(t uuid,c text default 'lms') returns boolean language sql stable as $$ select exists(select 1 from academy.platform_settings where tenant_id=t and enabled) $$;
   create function private_app.academy_has_permission_v1(t uuid,p text) returns boolean language sql stable as $$ select t='${T}'::uuid and private_app.current_subject_id()='${ADMIN}'::uuid and p in ('manageStore','manageAdmissions','verifyPayments') and exists(select 1 from academy.platform_settings where tenant_id=t and enabled) $$;`);
  const identity=await read('supabase/migrations/20260806190000_customer_identity_integrity_v1.sql');
  await db.exec(identity.slice(identity.indexOf('create or replace function private_app.normalize_lead_phone'),identity.indexOf('revoke all on function private_app.normalize_lead_phone')));
  await db.exec("alter table academy.courses add column if not exists program_kind text check(program_kind in ('short_course','diploma'));");
  await db.exec(await read('supabase/migrations/20260922123859_academy_native_course_store.sql'));
  await admin(db,'save_settings',{currency:'SAR',taxRegistered:false,taxRateBps:1500,checkoutEnabled:true,bankName:'Fixture Bank',accountName:'Training Center',iban:'SA1234567890123456789012',refundPolicy:'Fixture terms require approved registration and reviewed payments.'});
  return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
async function offer(db,{mode='self_paced',capacity=2}={}){
 const saved=await admin(db,'save_offer',{title:'Native course',programKind:'short_course',courseCode:`STORE-${seq}`,description:'Native training course description.',learningMode:mode,netMinor:10000,capacity,startsAt:'2030-01-01T10:00:00Z',endsAt:'2030-02-01T10:00:00Z'});
 // Content publication is separately exercised by the full training suite.
 // Seed a reviewed immutable published version here to isolate commerce.
 await db.query("insert into academy.training_course_versions(tenant_id,course_id,version,title,learning_mode,status,policy,created_by_subject_id,reviewed_by_subject_id,published_at) values($1,$2,1,'Approved content',$3,'published',$4,$5,$5,now())",[T,saved.courseId,mode==='self_paced'?'self_paced':'live',JSON.stringify({minAssessmentPercent:70,minAttendancePercent:75,requireCompletedRun:false,certificateEnabled:true,termsVersion:'2026',supportEmail:'support@example.test'}),ADMIN]);
 await admin(db,'publish_offer',{offerId:saved.offerId,expectedVersion:1,published:true});
 return saved;
}

test('native store creates no canonical data before authorized verified admission; monetary truth is canonical once',async t=>{
 const db=await prepared();t.after(()=>db.close());const f=await offer(db);
 const counts={contacts:await count(db,'sales_core.contacts'),handoffs:await count(db,'academy.registration_handoffs'),payments:await count(db,'accounting_core.payments')};
 await login(db,null);
 const cmd=id(seq++),payload=orderPayload(f.offerId,201,{totalMinor:1,currency:'USD',payerIsLearner:false,payer:person(202)});
 const o=await buyer(db,'create_order',payload,cmd);
 assert.equal(o.totalMinor,10000);assert.equal(o.currency,'SAR');assert.equal(o.status,'pending_payment');
 assert.deepEqual(await buyer(db,'create_order',payload,cmd),o);
 assert.equal(await count(db,'sales_core.contacts'),counts.contacts);assert.equal(await count(db,'academy.registration_handoffs'),counts.handoffs);assert.equal(await count(db,'accounting_core.payments'),counts.payments);
 await assert.rejects(buyer(db,'view',{orderId:o.id,tokenHash:'b'.repeat(64)}),/academy_order_not_found/);
 await assert.rejects(buyer(db,'create_order',{...payload,learner:person(203)},cmd),/command_conflict/);
 await review(db,o);await login(db,INSTRUCTOR_AUTH);await assert.rejects(verify(db,o),/forbidden/);await login(db,ADMIN_AUTH);
 await assert.rejects(verify(db,o,{receivedMinor:9000}),/academy_received_amount_mismatch/);
 assert.equal(await count(db,'accounting_core.payments'),counts.payments);
 const result=await verify(db,o);assert.equal(result.status,'enrolled');
 assert.equal(await count(db,'accounting_core.payments'),counts.payments+1);
 const row=(await db.query('select e.id,e.student_id,e.course_id,h.contact_id,a.contact_id payer_contact,p.status,p.amount_minor,d.status invoice_status,d.total_minor from academy.enrollments e join academy.registration_handoffs h on h.id=e.handoff_id join academy.training_financial_links l on l.handoff_id=h.id join accounting_core.customer_accounts a on a.id=l.payer_account_id join accounting_core.sales_documents d on d.id=l.invoice_id join accounting_core.payment_allocations pa on pa.invoice_id=d.id join accounting_core.payments p on p.id=pa.payment_id where e.id=$1',[result.enrollmentId])).rows[0];
 assert.notEqual(row.contact_id,row.payer_contact);assert.equal(row.status,'verified');assert.equal(row.invoice_status,'issued');assert.equal(Number(row.total_minor),10000);assert.equal(Number(row.amount_minor),10000);
 assert.equal((await call(db,'private_app.training_journey_handoff_finance_v1',{p_handoff_id:(await db.query('select handoff_id from academy.store_orders where id=$1',[o.id])).rows[0].handoff_id})).trainingAllowed,true);
 const again=await verify(db,o);assert.equal(again.enrollmentId,result.enrollmentId);assert.equal(await count(db,'accounting_core.payments'),counts.payments+1);
 assert.equal((await db.query('select count(*)::int n from academy.training_enrollment_versions where enrollment_id=$1',[result.enrollmentId])).rows[0].n,1);
 await login(db,null);await assert.rejects(buyer(db,'report_transfer',{orderId:o.id,tokenHash:token,reference:'CHANGED'}),/academy_order_not_editable/);
});

test('native catalog hides internal IDs and scoped grants reject foreign tenant/course; public quotas are database enforced',async t=>{
 const db=await prepared();t.after(()=>db.close());const f=await offer(db);
 await assert.rejects(admin(db,'save_offer',{courseId:FOREIGN_COURSE,title:'Foreign',programKind:'short_course',learningMode:'self_paced',netMinor:10000}),/invalid_course/);
 await assert.rejects(call(db,'public.v1_academy_commerce_snapshot',{p_slug:'foreign'}),/academy_store_unavailable/);
 await login(db,null);
 await assert.rejects(call(db,'public.v1_academy_commerce_snapshot',{p_slug:'marktone'}),/forbidden/);
 const catalog=await call(db,'public.v1_academy_storefront',{p_slug:'marktone'});assert.equal(catalog.offers.length,1);assert.equal(catalog.offers[0].courseId,undefined);assert.equal(catalog.orders,undefined);assert.equal(catalog.bank,undefined);
 for(let n=0;n<3;n++)await buyer(db,'create_order',orderPayload(f.offerId,210));
 await assert.rejects(buyer(db,'create_order',orderPayload(f.offerId,210)),/academy_rate_limited/);
 await assert.rejects(buyer(db,'create_order',orderPayload(f.offerId,211,{acceptedPolicy:false})),/invalid_request/);
 await login(db);await db.query('update academy.platform_settings set enabled=false where tenant_id=$1',[T]);
 await assert.rejects(call(db,'public.v1_academy_storefront',{p_slug:'marktone'}),/academy_store_unavailable/);
});

test('full capacity rejects a second admission; unresolved identity and reused bank receipt roll back all canonical writes',async t=>{
 const db=await prepared();t.after(()=>db.close());const f=await offer(db,{mode:'cohort',capacity:1});
 await login(db,null);const a=await buyer(db,'create_order',orderPayload(f.offerId,220)),b=await buyer(db,'create_order',orderPayload(f.offerId,221));await review(db,a);await review(db,b);
 await login(db);const results=await Promise.allSettled([verify(db,a),verify(db,b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/course_run_full/);
 assert.equal((await db.query('select count(*)::int n from academy.enrollments where course_run_id=$1',[f.runId])).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from accounting_core.payments where source_type=$1',['academy_store'])).rows[0].n,1);
 const next=await offer(db);await login(db,null);const conflict=await buyer(db,'create_order',orderPayload(next.offerId,230,{learner:{name:'Claimed existing identity',phone:'0501112233',email:'wrong@example.test'}}));await review(db,conflict);await login(db);
 const before=await count(db,'sales_core.contacts');await assert.rejects(verify(db,conflict),/academy_identity_review_required/);assert.equal(await count(db,'sales_core.contacts'),before);
 const c=await buyer(db,'create_order',orderPayload(next.offerId,231));await review(db,c);
 const reference=(await db.query("select verified_reference from academy.store_orders where status='enrolled' limit 1")).rows[0].verified_reference;
 await assert.rejects(verify(db,c,{bankReference:reference}),/unique|duplicate/);
 assert.equal((await db.query('select count(*)::int n from accounting_core.payments where source_type=$1',['academy_store'])).rows[0].n,1);
});

test('real independent academy manager sells a course with legacy LMS disabled and no staff or journey membership; connected course manager cannot change bank destination',async t=>{
 const {academySetup,configure,platformAction,MANAGER,MANAGER_AUTH}=await import('./fixtures/academy-platform-database.mjs');
 const db=await academySetup();t.after(()=>db.close());
 const identity=await read('supabase/migrations/20260806190000_customer_identity_integrity_v1.sql');
 await db.exec(identity.slice(identity.indexOf('create or replace function private_app.normalize_lead_phone'),identity.indexOf('revoke all on function private_app.normalize_lead_phone')));
 await db.exec("alter table academy.courses add column if not exists program_kind text check(program_kind in ('short_course','diploma'));");
 await db.exec(await read('supabase/migrations/20260922123859_academy_native_course_store.sql'));
 await db.exec("select set_config('fixture.addon','no',false)");
 const accessUntil=(await db.query("select (now()+interval '1 day')::text v")).rows[0].v;
 await configure(db,{accessUntil,reason:'Explicit isolated standalone store trial'});
 await platformAction(db,'set_member',{email:'manager@example.test',role:'manager',status:'active'});
 await login(db,MANAGER_AUTH);
 const settings={currency:'SAR',taxRegistered:true,taxRateBps:1500,checkoutEnabled:true,bankName:'Fixture Bank',accountName:'Training Center',iban:'SA1234567890123456789012',refundPolicy:'Fixture published registration and refund policy.'};
 await admin(db,'save_settings',settings);
 const f=await offer(db);
 await login(db,null);const o=await buyer(db,'create_order',orderPayload(f.offerId,241));assert.equal(o.totalMinor,11500);await review(db,o);
 await login(db,MANAGER_AUTH);const enrolled=await verify(db,o);assert.ok(enrolled.enrollmentId);
 assert.equal((await db.query('select count(*)::int n from academy.training_journey_settings')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from access_control.memberships where subject_id=$1',[MANAGER])).rows[0].n,0);
 assert.equal((await call(db,'public.v1_academy_training_snapshot',{p_slug:'marktone',p_role:'manager'})).enrollments.length,1);
 await login(db,ADMIN_AUTH);await configure(db,{expectedVersion:1,mode:'connected',accessUntil,reason:'Explicit connected authority test'});
 await login(db,MANAGER_AUTH);
 const snapshot=await call(db,'public.v1_academy_commerce_snapshot',{p_slug:'marktone'});assert.equal(snapshot.canManageStore,true);assert.equal(snapshot.canConfigureStore,false);
 await assert.rejects(admin(db,'save_settings',{...settings,iban:'SA9994567890123456789012'}),/forbidden/);
 assert.equal((await db.query('select iban from academy.store_settings where tenant_id=$1',[T])).rows[0].iban,settings.iban);
});
