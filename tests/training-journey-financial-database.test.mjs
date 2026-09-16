import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, call, login, count, id, seedPayment, seedEnrollment,
  T, OTHER, ADMIN, ADMIN_AUTH, INSTRUCTOR_AUTH, HANDOFF, ACCOUNT, INVOICE, PAYMENT, ENROLLMENT,
} from './fixtures/training-journey-database.mjs';

const finance = (db, at = '2026-09-16T12:00:00Z') => call(db,'private_app.training_journey_handoff_finance_v1',{p_handoff_id:HANDOFF,p_as_of:at});
const enable = db => db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[T]);
const link = (db, policy='full') => db.query('insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,$5,$6)',[T,HANDOFF,INVOICE,ACCOUNT,policy,ADMIN]);

test('training finance uses confirmed invoice allocations, not reported or unallocated money', async t => {
  const db=await setup();t.after(()=>db.close());await enable(db);
  await t.test('missing invoice is blocked',async()=>{
    const f=await finance(db);assert.equal(f.trainingAllowed,false);assert.deepEqual(f.reasonCodes,['invoice_link_required']);
  });
  await link(db);
  await t.test('a payment report cannot activate learning',async()=>{
    await seedPayment(db,10000,'pending_verification');assert.equal((await finance(db)).trainingAllowed,false);
    await assert.rejects(seedEnrollment(db),/training_financial_clearance_required/);
    assert.equal(await count(db,'academy.enrollments'),0);
  });
  await t.test('verified money not allocated to this invoice is excluded',async()=>{
    await db.query("update accounting_core.payments set status='verified' where id=$1",[PAYMENT]);
    await db.query('delete from accounting_core.payment_allocations where payment_id=$1',[PAYMENT]);
    assert.equal((await finance(db)).paidMinor,0);assert.equal((await finance(db)).trainingAllowed,false);
  });
  await t.test('verified allocation activates training and eligibility finance once',async()=>{
    await db.query('insert into accounting_core.payment_allocations(tenant_id,payment_id,invoice_id,amount_minor) values($1,$2,$3,10000)',[T,PAYMENT,INVOICE]);
    const f=await finance(db);assert.equal(f.trainingAllowed,true);assert.equal(f.certificationAllowed,true);assert.equal(f.outstandingMinor,0);
    await seedEnrollment(db);assert.equal(await count(db,'academy.enrollments'),1);
  });
  await t.test('a completed partial refund reduces eligible paid amount without deleting progress',async()=>{
    await db.query("insert into accounting_core.refunds(id,tenant_id,customer_account_id,payment_id,invoice_id,amount_minor,reason,status) values($1,$2,$3,$4,$5,1000,'Fixture refund','requested')",[id(50),T,ACCOUNT,PAYMENT,INVOICE]);
    assert.equal((await finance(db)).paidMinor,10000);
    await db.query("update accounting_core.refunds set status='completed',completed_at=now() where id=$1",[id(50)]);
    const f=await finance(db);assert.equal(f.paidMinor,9000);assert.equal(f.trainingAllowed,false);assert.equal(f.certificationAllowed,false);
    assert.equal(await count(db,'academy.enrollments'),1);
  });
  await t.test('refunded payment status blocks access even without a refund row',async()=>{
    await db.query("update accounting_core.payments set status='refunded' where id=$1",[PAYMENT]);assert.equal((await finance(db)).paidMinor,0);
  });
});

test('installment grace is calculated by the tenant calendar date, preserving certification settlement',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);await link(db,'installments');await seedPayment(db,4000);
  await t.test('missing installment schedule never unlocks learning',async()=>assert.equal((await finance(db)).trainingAllowed,false));
  await db.query("insert into accounting_core.payment_schedules(tenant_id,invoice_id,installment_number,due_date,amount_minor) values($1,$2,1,'2026-08-01',4000),($1,$2,2,'2026-09-09',6000)",[T,INVOICE]);
  await t.test('an incomplete schedule cannot hide an unpaid invoice remainder',async()=>{
    await db.query('update accounting_core.payment_schedules set amount_minor=5000 where invoice_id=$1 and installment_number=2',[INVOICE]);
    const f=await finance(db,'2026-09-01T12:00Z');assert.equal(f.trainingAllowed,false);
    await db.query('update accounting_core.payment_schedules set amount_minor=6000 where invoice_id=$1 and installment_number=2',[INVOICE]);
  });
  await t.test('first confirmed installment opens training; certificate remains blocked',async()=>{
    const f=await finance(db,'2026-09-09T12:00Z');assert.equal(f.trainingAllowed,true);assert.equal(f.certificationAllowed,false);
  });
  await t.test('the last second of day seven in Riyadh is inside grace',async()=>{
    const f=await finance(db,'2026-09-16T20:59:59Z');assert.equal(f.trainingAllowed,true);assert.equal(f.financialStatus,'grace_period');assert.equal(f.graceEndsOn,'2026-09-16');
  });
  await t.test('Riyadh midnight ending day seven suspends even when UTC date has not changed',async()=>{
    const f=await finance(db,'2026-09-16T21:00:00Z');assert.equal(f.trainingAllowed,false);assert.equal(f.financialStatus,'overdue');
    assert.ok(f.reasonCodes.includes('installment_grace_expired'));
  });
  await t.test('timezone affects grace through local dates, not machine timezone',async()=>{
    await db.query("update core.tenants set timezone='UTC' where id=$1",[T]);assert.equal((await finance(db,'2026-09-16T21:00:00Z')).trainingAllowed,true);
    await db.query("update core.tenants set timezone='Asia/Riyadh' where id=$1",[T]);
  });
  await t.test('a timed exception grants study only, expires exactly, and never clears tuition',async()=>{
    await db.query("update academy.training_financial_links set exception_until='2026-09-17T12:00Z',exception_by_subject_id=$1,exception_reason='Fixture approved exception' where handoff_id=$2",[ADMIN,HANDOFF]);
    const f=await finance(db,'2026-09-17T11:59:59Z');assert.equal(f.trainingAllowed,true);assert.equal(f.certificationAllowed,false);assert.equal(f.financialStatus,'temporary_exception');
    assert.equal((await finance(db,'2026-09-17T12:00:00Z')).trainingAllowed,false);
  });
});

test('pilot and command boundaries execute against real subject, membership and permission joins',async t=>{
  const db=await setup();t.after(()=>db.close());
  const tenant=slug=>call(db,'private_app.training_journey_tenant_v1',{p_slug:slug});
  await t.test('new migration is disabled until separately enabled',async()=>{
    assert.equal(await count(db,'academy.training_journey_settings'),0);await assert.rejects(tenant('marktone'),/training_journey_disabled/);
  });
  await enable(db);
  await t.test('another tenant and a disabled addon are denied',async()=>{
    assert.equal(await tenant('marktone'),T);await assert.rejects(tenant('foreign'),/training_journey_not_available/);
    await assert.rejects(db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[OTHER]),/violates check constraint/);
    await db.query("select set_config('fixture.addon','no',false)");await assert.rejects(tenant('marktone'),/training_addon_required/);
    await db.query("select set_config('fixture.addon','yes',false)");
  });
  await t.test('expired or suspended identity cannot use the pilot',async()=>{
    await login(db,null);await assert.rejects(tenant('marktone'),/authentication_required/);await login(db);
    await db.query("update access_control.subjects set status='suspended' where id=$1",[ADMIN]);await assert.rejects(tenant('marktone'),/authentication_required/);
    await db.query("update access_control.subjects set status='active',must_change_password=true where id=$1",[ADMIN]);await assert.rejects(tenant('marktone'),/authentication_required/);
    await db.query('update access_control.subjects set must_change_password=false where id=$1',[ADMIN]);
  });
  await t.test('duplicate request replays once; modified payload and another actor are denied',async()=>{
    const args={p_tenant_id:T,p_command_id:id(70),p_action:'fixture_action',p_payload:{note:'original'}};
    await db.exec('begin');assert.equal(await call(db,'private_app.training_journey_command_v1',args),null);
    await call(db,'private_app.training_journey_complete_command_v1',{p_tenant_id:T,p_command_id:id(70),p_response:{id:'saved'}});await db.exec('commit');
    assert.deepEqual(await call(db,'private_app.training_journey_command_v1',args),{id:'saved'});
    await assert.rejects(call(db,'private_app.training_journey_command_v1',{...args,p_payload:{note:'changed'}}),/command_id_reused_with_different_payload/);
    await login(db,INSTRUCTOR_AUTH);await assert.rejects(call(db,'private_app.training_journey_command_v1',args),/command_id_reused_with_different_payload/);await login(db,ADMIN_AUTH);
    assert.equal(await count(db,'academy.training_journey_commands'),1);
  });
  await t.test('financial verification is a separate permission from general admissions',async()=>{
    assert.equal(await call(db,'private_app.training_journey_payment_authorized_v1',{p_tenant_id:T}),true);
    await login(db,INSTRUCTOR_AUTH);assert.equal(await call(db,'private_app.training_journey_payment_authorized_v1',{p_tenant_id:T}),false);await login(db);
  });
});

test('inactive or deferred registration keeps financial history but blocks participation',async t=>{
  const db=await setup();t.after(()=>db.close());await enable(db);await link(db);await seedPayment(db);await seedEnrollment(db);
  const access=()=>call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:ENROLLMENT});
  await db.query("update academy.enrollments set metadata='{"+'"trainingJourneyDeferred":true'+"}' where id=$1",[ENROLLMENT]);
  assert.equal((await access()).trainingAllowed,false);assert.equal((await access()).paidMinor,10000);
  await db.query("update academy.enrollments set status='cancelled',metadata='{}' where id=$1",[ENROLLMENT]);
  assert.equal((await access()).certificationAllowed,false);assert.equal(await count(db,'academy.enrollments'),1);
});

test('enabling the pilot leaves unlinked historical enrollments and their canonical admission behavior intact',async t=>{
  const db=await setup();t.after(()=>db.close());await seedEnrollment(db);
  const before=(await db.query('select row_to_json(e) row from academy.enrollments e where id=$1',[ENROLLMENT])).rows[0].row;
  await enable(db);
  await db.query("update academy.enrollments set status='active' where id=$1",[ENROLLMENT]);
  const after=(await db.query('select row_to_json(e) row from academy.enrollments e where id=$1',[ENROLLMENT])).rows[0].row;
  assert.equal(after.handoff_id,before.handoff_id);assert.equal(after.student_id,before.student_id);assert.equal(after.status,'active');
  assert.equal(await count(db,'academy.training_financial_links'),0);assert.equal(await count(db,'academy.enrollments'),1);
});
