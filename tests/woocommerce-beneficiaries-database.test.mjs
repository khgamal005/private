import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,call,context,count,save,saveArgs,submit,snapshot,enroll,enrollArgs,id,command,
  T,OTHER,CONTACT,SALES,MANAGER,C1,RUN,RUN2,WORK,TASK} from './helpers/woocommerce-beneficiaries-fixture.mjs';
const using=async t=>{const db=await setup();t.after(()=>db.close());return db;};

test('group beneficiary validation is atomic, bounded and cannot bypass quantity/payment guards',async t=>{
  const db=await using(t);
  assert.ok((await context(db)).blockers.includes('woocommerce_beneficiaries_required'));
  await assert.rejects(submit(db),/woocommerce_beneficiaries_required/);
  for(const beneficiaries of [[],[{contactId:CONTACT}],[{contactId:CONTACT},{contactId:CONTACT}],
    [{contactId:CONTACT},{name:'مستفيد',phone:'123'}]]){
    await assert.rejects(save(db,beneficiaries),/woocommerce_beneficiar/);
    assert.equal(await count(db,'sales_core.commerce_order_beneficiaries'),0);
    assert.equal(await count(db,'sales_core.contacts'),1);
  }
  for(const quantity of [0,-1,1.5,101]){
    await db.query("update commerce_sync.external_entities set raw_payload=jsonb_set(raw_payload,'{line_items,0,quantity}',$1::jsonb)",[String(quantity)]);
    await assert.rejects(save(db),/woocommerce_beneficiaries_limit/);
  }
});

test('saved seats invalidate stale contexts and repeated save requests do not duplicate contacts',async t=>{
  const db=await using(t),before=await context(db),args=await saveArgs(db);
  const first=await call(db,'v1_tenant_woocommerce_save_beneficiaries',args);
  assert.equal(first.count,2);
  assert.equal((await call(db,'v1_tenant_woocommerce_save_beneficiaries',args)).replayed,true);
  assert.equal(await count(db,'sales_core.contacts'),2);
  const after=await context(db);assert.equal(after.beneficiariesValid,true);assert.notEqual(after.revision,before.revision);assert.deepEqual(after.blockers,[]);
  await assert.rejects(call(db,'v1_tenant_woocommerce_admission_action',{p_tenant_slug:'fixture',p_task_id:TASK,p_action:'complete',p_expected_revision:before.revision,p_command_id:command(),p_lines:[{lineId:'101',courseId:C1,handoffId:null}]}),/woocommerce_order_changed/);
  await assert.rejects(call(db,'v1_tenant_woocommerce_save_beneficiaries',{...args,p_lines:[{lineId:'101',beneficiaries:[]}]}),/woocommerce_command_conflict/);
  await assert.rejects(save(db,[{contactId:CONTACT},{name:'اسم آخر',phone:'+966501111111'}]),/woocommerce_beneficiary_exists/);
  await db.query("update commerce_sync.external_entities set raw_payload=jsonb_set(raw_payload,'{line_items,0,quantity}','3')");
  assert.ok((await context(db)).blockers.includes('woocommerce_beneficiaries_required'));
  await assert.rejects(submit(db),/woocommerce_beneficiaries_required/);
});

test('one payment funds two independently scheduled learners without duplicate sales or amounts',async t=>{
  const db=await using(t);await save(db);const result=await submit(db);
  assert.equal(result.handoffs.length,1);assert.equal(await count(db,'academy.registration_handoffs'),1);assert.equal(await count(db,'sales_core.opportunities'),1);
  const seats=(await snapshot(db)).cases[0].beneficiaries;
  assert.deepEqual(seats.map(b=>b.allocatedMinor),[69930,69930]);
  const firstArgs=await enrollArgs(db,[{id:seats[0].id,courseRunId:RUN}]);
  assert.equal((await call(db,'v1_tenant_woocommerce_enroll_beneficiaries',firstArgs)).remaining,1);
  assert.equal((await call(db,'v1_tenant_woocommerce_enroll_beneficiaries',firstArgs)).replayed,true);
  assert.equal(await count(db,'academy.enrollments'),1);
  const second=await enroll(db,[{id:seats[1].id,courseRunId:RUN2}]);assert.equal(second.remaining,0);
  assert.equal(await count(db,'academy.enrollments'),2);assert.equal(await count(db,'academy.students'),2);
  assert.deepEqual((await db.query('select enrolled_count from academy.course_runs order by id')).rows.map(r=>r.enrolled_count),[1,1]);
  const final=await snapshot(db);assert.equal(final.cases.length,1);assert.equal(final.cases[0].status,'completed');assert.equal(final.summary.completed,1);
  assert.equal(Number((await db.query('select sum(payment_amount_minor) n from academy.registration_handoffs')).rows[0].n),139860);
  assert.equal((await db.query("select count(*)::int n from sales_core.contacts where lead_status='paid'")).rows[0].n,1);
  await assert.rejects(save(db),/woocommerce_beneficiaries_locked/);
});

test('capacity, foreign batches, duplicate requests and old enrollment endpoints fail safely',async t=>{
  const db=await using(t);await save(db);const r=await submit(db);const hid=r.handoffs[0].id;
  await assert.rejects(call(db,'v2_tenant_update_admission',{p_tenant_slug:'fixture',p_handoff_id:hid,p_action:'complete',p_course_run_id:RUN}),/woocommerce_use_beneficiary_registration/);
  await db.query("update academy.course_runs set status='planning' where id=$1",[RUN]);
  await assert.rejects(enroll(db),/invalid_course_run/);
  await db.query("update academy.course_runs set status='open',capacity=1 where id=$1",[RUN]);
  await assert.rejects(enroll(db),/course_run_full/);
  assert.equal(await count(db,'academy.students'),0);assert.equal(await count(db,'academy.enrollments'),0);
  await db.query('update academy.course_runs set capacity=2 where id=$1',[RUN]);
  const args=await enrollArgs(db);await assert.rejects(call(db,'v1_tenant_woocommerce_enroll_beneficiaries',{...args,p_seats:[args.p_seats[0],args.p_seats[0]]}),/woocommerce_beneficiaries_invalid/);
  await assert.rejects(call(db,'v1_tenant_woocommerce_enroll_beneficiaries',{...args,p_seats:[{...args.p_seats[0],courseRunId:id(999)}]}),/invalid_course_run/);
  const result=await call(db,'v1_tenant_woocommerce_enroll_beneficiaries',args);assert.equal(result.enrolled,2);
  assert.equal((await call(db,'v1_tenant_woocommerce_enroll_beneficiaries',args)).replayed,true);
  assert.equal(await count(db,'academy.enrollments'),2);
});

test('legacy full-amount payment and enrollment are reused without financial or learner-history rewrites',async t=>{
  const db=await using(t),hid=id(301),oid=id(302);
  await db.query("insert into sales_core.opportunities(id,tenant_id,opportunity_key,contact_id,course_id,owner_staff_id,title,value_minor,status) values($1,$2,'legacy',$3,$4,$5,'قديم',139860,'won')",[oid,T,CONTACT,C1,SALES]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,opportunity_id,course_id,payment_status,payment_verified_at,payment_amount_minor,payment_reference,status,payment_reported_at) values($1,$2,'legacy',$3,$4,$5,'verified','2026-08-30',139860,'9001','in_review','2026-08-29')",[hid,T,CONTACT,oid,C1]);
  await call(db,'v2_tenant_update_admission',{p_tenant_slug:'fixture',p_handoff_id:hid,p_action:'complete',p_course_run_id:RUN});
  const priorEnrollment=(await db.query('select * from academy.enrollments')).rows[0];
  const priorHandoff=(await db.query('select * from academy.registration_handoffs')).rows[0];
  await save(db);
  await db.query("update academy.enrollments set status='withdrawn' where id=$1",[priorEnrollment.id]);
  await assert.rejects(submit(db,'review',hid),/woocommerce_existing_enrollment_review/);
  await db.query("update academy.enrollments set status='confirmed' where id=$1",[priorEnrollment.id]);
  await submit(db,'review',hid);assert.equal((await context(db)).reviewValid,true);await submit(db,'complete',hid);
  assert.equal(await count(db,'academy.registration_handoffs'),1);assert.equal(await count(db,'sales_core.opportunities'),1);
  const item=(await snapshot(db)).cases[0];assert.equal(item.originalStatus,'completed');assert.equal(item.status,'in_review');
  assert.equal(item.beneficiaries[0].enrollmentId,priorEnrollment.id);assert.equal(item.beneficiaries[1].enrollmentId,null);
  await enroll(db,[{id:item.beneficiaries[1].id,courseRunId:RUN2}]);
  assert.deepEqual((await db.query('select * from academy.enrollments where id=$1',[priorEnrollment.id])).rows[0],priorEnrollment);
  const after=(await db.query('select * from academy.registration_handoffs')).rows[0];
  for(const key of ['payment_amount_minor','payment_reported_at','completed_at','course_run_id'])assert.deepEqual(after[key],priorHandoff[key],key);
  assert.equal(after.status,'completed');assert.equal(await count(db,'academy.enrollments'),2);
});

test('tenant/assignee isolation, private tables and anonymous RPC restrictions are enforced',async t=>{
  const db=await using(t);await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values($1,$2,'خارج المنشأة','0503333333',$5),($3,$4,'مسؤول آخر','0504444444',$6)",[id(410),OTHER,id(411),T,SALES,MANAGER]);
  await assert.rejects(save(db,[{contactId:CONTACT},{contactId:id(410)}]),/woocommerce_beneficiary_contact_unavailable/);
  await db.query("select set_config('fixture.staff',$1,false),set_config('fixture.team','no',false)",[SALES]);
  await assert.rejects(save(db,[{contactId:CONTACT},{contactId:id(411)}]),/woocommerce_beneficiary_contact_unavailable/);
  const found=await call(db,'v1_tenant_woocommerce_beneficiary_search',{p_tenant_slug:'fixture',p_task_id:TASK,p_query:'050'});assert.equal(found.length,1);assert.equal(found[0].id,CONTACT);
  await assert.rejects(call(db,'v1_tenant_woocommerce_beneficiary_search',{p_tenant_slug:'foreign',p_task_id:TASK,p_query:'050'}),/forbidden/);
  assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_woocommerce_save_beneficiaries(text,uuid,text,uuid,jsonb)','EXECUTE') ok")).rows[0].ok,false);
  await db.exec('set role authenticated');await assert.rejects(db.query('select * from sales_core.commerce_order_beneficiaries'),/permission denied/);await db.exec('reset role');
  await db.query("select set_config('fixture.team','yes',false)");await save(db,[{contactId:CONTACT},{contactId:id(411)}]);
  assert.equal((await db.query('select owner_staff_id from sales_core.contacts where id=$1',[id(411)])).rows[0].owner_staff_id,MANAGER);
});

test('ordinary one-seat registration still uses its legacy contract after the forward migration',async t=>{
  const db=await setup({quantity:1});t.after(()=>db.close());
  const result=await submit(db);assert.equal(result.handoffs.length,1);
  const completed=await call(db,'v2_tenant_update_admission',{p_tenant_slug:'fixture',p_handoff_id:result.handoffs[0].id,p_action:'complete',p_course_run_id:RUN});
  assert.ok(completed.enrollmentId);assert.equal(await count(db,'academy.enrollments'),1);
  assert.equal((await db.query('select commerce_seat_id from academy.enrollments')).rows[0].commerce_seat_id,null);
});

test('payment changes after handoff block all beneficiary enrollment and preserve the payment total',async t=>{
  const db=await using(t);await save(db);await submit(db);
  await db.query("update commerce_sync.external_entities set raw_payload=jsonb_set(raw_payload,'{refunds}','[{\"id\":1}]')");
  await assert.rejects(enroll(db),/woocommerce_payment_changed/);
  assert.equal(await count(db,'academy.enrollments'),0);assert.equal(await count(db,'academy.students'),0);
  assert.equal(Number((await db.query('select amount_minor from sales_core.commerce_admission_orders where work_item_id=$1',[WORK])).rows[0].amount_minor),139860);
});
