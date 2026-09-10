import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=id(1),OTHER=id(2),ACTOR=id(3),STAFF=id(4),CONTACT=id(5),SECOND=id(6),FOREIGN=id(7);
const C1=id(10),C2=id(11),C3=id(12),R1=id(20),R2=id(21),R3=id(22),S1=id(30),S2=id(31);
let sequence=100;
const call=async(db,name,args)=>{
  const entries=Object.entries(args);
  return (await db.query(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) data`,
    entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].data;
};
const context=db=>call(db,'v1_tenant_sales_followup_context',{p_tenant_slug:'fixture',p_contact_id:CONTACT});
const interests=[{courseId:C1,courseRunId:R1,attendanceSessionId:S1},{courseId:C2,courseRunId:R2,attendanceSessionId:S2}];
const input=async(db,overrides={})=>({
  p_tenant_slug:'fixture',p_contact_id:CONTACT,p_activity_type:'call',p_summary:'متابعة عميل تجريبي',
  p_lead_status:'interested',p_course_interests:interests,p_additional_phones:['٠٥٥١١١١١١١','+966 56 222 2222'],
  p_expected_revision:(await context(db)).revision,p_command_id:id(sequence++),p_lead_quality:'good',
  p_next_action_type:'follow_up',p_next_action_at:'2026-09-15T10:00:00Z',...overrides
});
const save=(db,args)=>call(db,'v2_tenant_record_sales_followup_v6',args);
const count=async(db,table)=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n;

async function setup(){
  const db=new PGlite();
  await db.exec(await readFile(new URL('./fixtures/sales-followup-legacy-schema.sql',import.meta.url),'utf8'));
  await db.query("insert into core.tenants(id,slug,timezone) values($1,'fixture','Asia/Riyadh'),($2,'other','UTC')",[T,OTHER]);
  await db.query('insert into access_control.subjects(id) values($1)',[ACTOR]);
  await db.query("insert into people.staff_profiles(id,tenant_id,full_name) values($1,$2,'Synthetic sales')",[STAFF,T]);
  await db.query("select set_config('fixture.subject',$1,false),set_config('fixture.tenant',$2,false),set_config('fixture.staff',$3,false)",[ACTOR,T,STAFF]);
  await db.query("insert into academy.courses(id,tenant_id,title_ar,status) values($1,$4,'دورة أولى','active'),($2,$4,'دورة ثانية','active'),($3,$5,'دورة منشأة أخرى','active')",[C1,C2,C3,T,OTHER]);
  await db.query("insert into academy.course_runs(id,tenant_id,course_id,title,status,starts_at) values($1,$4,$6,'دفعة أولى','open','2026-10-01T09:00Z'),($2,$4,$7,'دفعة ثانية','open','2026-10-02T09:00Z'),($3,$5,$8,'دفعة أخرى','open','2026-10-03T09:00Z')",[R1,R2,R3,T,OTHER,C1,C2,C3]);
  await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,title,status,starts_at,ends_at) values($1,$3,$4,'محاضرة أولى','scheduled','2026-10-01T09:00Z','2026-10-01T12:00Z'),($2,$3,$5,'محاضرة ثانية','scheduled','2026-10-02T21:30Z','2026-10-02T23:00Z')",[S1,S2,T,R1,R2]);
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id,interest_course_id) values($1,$4,'عميل تجريبي','0501111111',$6,$7),($2,$4,'عميل آخر','0502222222',$6,null),($3,$5,'عميل منشأة أخرى','0503333333',null,null)",[CONTACT,SECOND,FOREIGN,T,OTHER,STAFF,C1]);
  for(const key of ['new_lead','contacted','qualified','proposal','lost'])await db.query('insert into sales_core.pipeline_stages(tenant_id,stage_key) values($1,$2)',[T,key]);
  await db.exec(await readFile(new URL('../supabase/migrations/20260910143003_sales_followup_multiple_interests_v1.sql',import.meta.url),'utf8'));
  return db;
}

test('multiple interests use the real V2–V5 pipeline with synthetic data',async t=>{
  const db=await setup();t.after(()=>db.close());
  await t.test('additive migration and legacy scalar fallback',async()=>{
    assert.equal(await count(db,'sales_core.contacts'),3);
    assert.equal(await count(db,'sales_core.contact_course_interests'),0);
    assert.equal((await context(db)).courseInterests[0].courseId,C1);
    assert.equal(await count(db,'sales_core.activities'),0);
  });
  await t.test('permissions, tenant isolation and row ownership are enforced',async()=>{
    await assert.rejects(call(db,'v1_tenant_sales_followup_context',{p_tenant_slug:'other',p_contact_id:FOREIGN}),/forbidden/);
    await assert.rejects(call(db,'v1_tenant_sales_followup_context',{p_tenant_slug:'fixture',p_contact_id:FOREIGN}),/invalid_contact/);
    await db.query("select set_config('fixture.staff',$1,false)",[id(999)]);
    await assert.rejects(context(db),/forbidden/);
    await db.query("select set_config('fixture.staff',$1,false)",[STAFF]);
    const args=await input(db);
    await db.query("select set_config('fixture.deny','tenant.crm.write',false)");
    await assert.rejects(save(db,args),/forbidden/);
    await db.query("select set_config('fixture.deny','',false),set_config('fixture.subject','',false)");
    await assert.rejects(context(db),/forbidden/);
    await db.query("select set_config('fixture.subject',$1,false)",[ACTOR]);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from sales_core.contact_course_interests'),/permission denied/);
    await assert.rejects(db.query('select * from sales_core.followup_commands'),/permission denied/);
    await db.exec('reset role');
    assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_sales_followup_context(text,uuid)','EXECUTE') allowed")).rows[0].allowed,false);
  });
  await t.test('course, batch, attendance and identity mismatches roll back',async()=>{
    const badRows=[[{courseId:C3}],[{courseId:C1,courseRunId:R2}],[{courseId:C1,courseRunId:R1,attendanceSessionId:S2}],[{courseId:C1,attendanceSessionId:S1}],[{courseId:C1},{courseId:C1}]];
    for(const rows of badRows)await assert.rejects(save(db,await input(db,{p_course_interests:rows})),/invalid_course|invalid_attendance_session|duplicate_or_missing_course/);
    for(const phones of [['0501111111'],['0551111111','+966551111111'],['0502222222'],['abc']]){
      await assert.rejects(save(db,await input(db,{p_additional_phones:phones})),/duplicate_additional_phone|duplicate_contact_identity|invalid_phone/);
    }
    await assert.rejects(save(db,await input(db,{p_summary:''})),/summary_required/);
    assert.equal(await count(db,'sales_core.activities'),0);
    assert.equal(await count(db,'sales_core.followup_commands'),0);
    assert.equal(await count(db,'sales_core.contact_course_interests'),0);
  });
  let first,firstArgs;
  await t.test('save, reload and attendance in the tenant timezone',async()=>{
    firstArgs=await input(db);first=await save(db,firstArgs);
    const loaded=await context(db);
    assert.equal(loaded.courseInterests.length,2);
    assert.deepEqual([...loaded.additionalPhones].sort(),['966551111111','966562222222']);
    assert.equal(loaded.courseInterests[1].attendanceSessionId,S2);
    assert.equal(new Date(loaded.courseInterests[1].attendanceAt).toISOString(),'2026-10-02T21:30:00.000Z');
    assert.equal(await count(db,'sales_core.contacts'),3);
    assert.equal(await count(db,'work_core.tasks'),1);
    assert.equal(await count(db,'sales_core.opportunities'),1);
    const options=await call(db,'v1_tenant_sales_followup_options',{p_tenant_slug:'fixture',p_contact_id:CONTACT,p_course_id:C1});
    assert.deepEqual(options.runs.map(run=>run.id),[R1]);
    assert.deepEqual(options.runs[0].sessions.map(session=>session.id),[S1]);
  });
  await t.test('retry is idempotent and cannot overwrite a later version',async()=>{
    const replay=await save(db,firstArgs);
    assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);
    assert.equal(await count(db,'sales_core.activities'),1);
    await assert.rejects(save(db,{...firstArgs,p_summary:'changed request'}),/followup_command_conflict/);
    await assert.rejects(save(db,{...firstArgs,p_command_id:id(sequence++)}),/followup_changed_reload/);
    const second=await save(db,await input(db,{p_next_action_at:'2026-09-18T10:00:00Z',p_task_id:first.taskId}));
    assert.equal(second.taskId,first.taskId);assert.equal(await count(db,'work_core.tasks'),1);
    assert.equal(await count(db,'sales_core.opportunities'),1);
  });
  await t.test('sales reads search additional phones and preserve pagination and totals',async()=>{
    const args={p_slug:'fixture',p_limit:1,p_include_auxiliary:true,p_query:'+966551111111'};
    const snapshot=await call(db,'v2_tenant_sales_workspace_snapshot',args);
    assert.equal(snapshot.contacts.length,1);assert.equal(snapshot.contacts[0].id,CONTACT);
    assert.equal(snapshot.contacts[0].followupDetails.courseInterests.length,2);
    assert.equal(snapshot.pagination.returned,1);
    const foreign=await call(db,'v2_tenant_sales_workspace_snapshot',{...args,p_query:'0503333333'});
    assert.equal(foreign.contacts.length,0);
    assert.deepEqual(foreign.summary,snapshot.summary);
    const all=await call(db,'v2_tenant_sales_workspace_snapshot',{p_slug:'fixture',p_limit:80,p_include_auxiliary:false});
    assert.equal(all.contacts.length,2);
    assert.equal(all.contacts.filter(contact=>contact.id===CONTACT).length,1);
  });
  await t.test('new phones remain canonical after primary-phone edits and removal preserves identity history',async()=>{
    await db.query("update sales_core.contacts set phone='0504444444' where id=$1",[CONTACT]);
    assert.equal((await context(db)).additionalPhones.length,2);
    await save(db,await input(db,{p_additional_phones:['0551111111']}));
    const old=(await db.query("select source_slot from sales_core.contact_identities where tenant_id=$1 and identity_value='966562222222'",[T])).rows[0];
    assert.equal(old.source_slot,'historical_alias');
    assert.equal((await context(db)).additionalPhones.length,1);
    await assert.rejects(db.query("insert into sales_core.contacts(tenant_id,phone,full_name) values($1,'0562222222','مكرر')",[T]),/unique/);
  });
  await t.test('foreign tenant FKs reject direct cross-tenant references',async()=>{
    await assert.rejects(db.query('insert into sales_core.contact_course_interests(tenant_id,contact_id,course_id,position) values($1,$2,$3,2)',[T,CONTACT,C3]),/foreign key/);
    await assert.rejects(db.query('update sales_core.contact_course_interests set attendance_session_id=$1 where tenant_id=$2 and course_id=$3',[S2,T,C1]),/foreign key/);
  });
  await t.test('history exposes both interests and phones after the existing permission check',async()=>{
    const history=await call(db,'v5_tenant_customer_history_snapshot',{p_slug:'fixture',p_contact_id:CONTACT,p_limit:100});
    assert.equal(history.contact.courseInterests.length,2);assert.equal(history.contact.additionalPhones.length,1);
    assert.equal(history.timezone,'Asia/Riyadh');
    assert.ok((await db.query("select payload from private_app.audit_fixture where event='tenant.sales_followup_details_updated' limit 1")).rows[0].payload.old);
  });
  await t.test('a payment report applies only to its selected course and carries attendance to admissions',async()=>{
    await assert.rejects(save(db,await input(db,{p_lead_status:'payment_submitted'})),/payment_course_required/);
    const result=await save(db,await input(db,{p_lead_status:'payment_submitted',p_payment_course_id:C2,p_payment_amount_minor:49000,p_payment_reference:'SYNTHETIC'}));
    const handoff=(await db.query('select * from academy.registration_handoffs where id=$1',[result.handoffId])).rows[0];
    assert.equal(handoff.course_id,C2);assert.equal(handoff.course_run_id,R2);
    assert.equal(handoff.preferred_start_date.toISOString().slice(0,10),'2026-10-03');
    assert.equal(handoff.metadata.attendanceSessionId,S2);
    assert.equal(handoff.payment_status,'pending_verification');
    assert.equal(await count(db,'academy.registration_handoffs'),1);
    assert.equal((await context(db)).courseInterests.length,2);
    assert.equal((await db.query('select interest_course_id from sales_core.contacts where id=$1',[CONTACT])).rows[0].interest_course_id,C1);
  });
});
