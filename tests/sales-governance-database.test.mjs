import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const id=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=id(1),OTHER=id(2),ACTOR=id(3),STAFF=id(4),CONTACT=id(5),OTHER_STAFF=id(6),C1=id(10),C2=id(11),C3=id(12);
const call=async(db,name,args)=>{
  const entries=Object.entries(args);
  return (await db.query(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) data`,entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].data;
};
async function fixture(){
  const db=new PGlite();
  await db.exec(await readFile(new URL('./fixtures/sales-followup-legacy-schema.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('./fixtures/sales-task-api-legacy.sql',import.meta.url),'utf8'));
  await db.query("insert into core.tenants(id,slug) values($1,'fixture'),($2,'other')",[T,OTHER]);
  await db.query('insert into access_control.subjects(id) values($1)',[ACTOR]);
  await db.query("insert into people.staff_profiles(id,tenant_id,full_name) values($1,$3,'Synthetic owner'),($2,$3,'Synthetic second owner')",[STAFF,OTHER_STAFF,T]);
  await db.query("select set_config('fixture.subject',$1,false),set_config('fixture.tenant',$2,false),set_config('fixture.staff',$3,false)",[ACTOR,T,STAFF]);
  await db.query("insert into academy.courses(id,tenant_id,title_ar) values($1,$4,'Course A'),($2,$4,'Course B'),($3,$5,'Foreign course')",[C1,C2,C3,T,OTHER]);
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id,lead_status,source,campaign_name) values($1,$2,'Synthetic customer','0501111111',$3,'paid','meta','Acquisition campaign')",[CONTACT,T,STAFF]);
  for(const key of ['new_lead','contacted','qualified','proposal','lost'])await db.query('insert into sales_core.pipeline_stages(tenant_id,stage_key) values($1,$2)',[T,key]);
  await db.exec(await readFile(new URL('../supabase/migrations/20260910143003_sales_followup_multiple_interests_v1.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260921125620_sales_identity_governance_v1.sql',import.meta.url),'utf8'));
  // Production's existing one-open-task index and terminal guards are exercised.
  await db.exec(`create unique index one_open_task_fixture on work_core.tasks(tenant_id,contact_id)
    where status in ('todo','in_progress') and metadata->>'source' in ('lead_assignment','opportunity_next_action','activity_next_action','lead_next_action','sales_followup');
    create trigger task_terminal_guard before insert on work_core.tasks for each row execute function private_app.guard_terminal_contact_sales_task_insert_v1();
    create trigger contact_terminal_guard after update of lead_status on sales_core.contacts for each row
      when(old.lead_status is distinct from new.lead_status and new.lead_status in ('paid','payment_submitted','not_interested','unqualified','wrong_number','duplicate','cancelled'))
      execute function private_app.complete_terminal_contact_sales_tasks_v1();`);
  return db;
}
const create=(db,overrides={})=>call(db,'v3_tenant_create_opportunity',{
  p_tenant_slug:'fixture',p_contact_id:CONTACT,p_title:'New training sale',p_course_id:C1,
  p_value_minor:900000,p_command_id:id(100),...overrides
});
const context=db=>call(db,'v1_tenant_sales_followup_context',{p_tenant_slug:'fixture',p_contact_id:CONTACT});
const followup=async(db,overrides={})=>call(db,'v2_tenant_record_sales_followup_v7',{
  p_tenant_slug:'fixture',p_contact_id:CONTACT,p_activity_type:'call',p_summary:'Synthetic followup',
  p_lead_status:'interested',p_lead_quality:'good',p_course_interests:[{courseId:C1},{courseId:C2}],
  p_additional_phones:[],p_expected_revision:(await context(db)).revision,p_command_id:id(200),
  p_next_action_type:'call',p_next_action_at:'2026-10-03T08:00:00Z',...overrides
});

test('sales identity: mandatory primary, global phone uniqueness and four extra numbers including WhatsApp',async t=>{
  const db=await fixture();t.after(()=>db.close());
  await assert.rejects(db.query("insert into sales_core.contacts(tenant_id,full_name,email) values($1,'Missing primary','a@b.test')",[T]),/primary_phone_required/);
  await assert.rejects(db.query("insert into sales_core.contacts(tenant_id,full_name,phone) values($1,'Duplicate','+966501111111')",[T]),/duplicate key/);
  await db.query("insert into sales_core.contacts(tenant_id,full_name,phone) values($1,'Other tenant','0501111111')",[OTHER]);
  const extra=['0551111111','0552222222','0553333333','0554444444'];
  await db.query('select private_app.validate_customer_phone_capacity_v1($1,$2,$3)',['0501111111','0501111111',JSON.stringify(extra)]);
  await assert.rejects(db.query('select private_app.validate_customer_phone_capacity_v1($1,$2,$3)',['0501111111','0559999999',JSON.stringify(extra)]),/additional_phone_limit/);
  await assert.rejects(db.query('select private_app.validate_customer_phone_capacity_v1($1,$2,$3)',['0501111111',null,JSON.stringify(['+966501111111'])]),/duplicate_additional_phone/);
  for(const phone of extra)await db.query("insert into sales_core.contact_identities(tenant_id,contact_id,identity_type,identity_value,source_slot,is_alias) values($1,$2,'phone',private_app.normalize_lead_phone($3),'additional_phone',true)",[T,CONTACT,phone]);
  await assert.rejects(db.query("insert into sales_core.contact_identities(tenant_id,contact_id,identity_type,identity_value,source_slot,is_alias) values($1,$2,'phone','966559999999','additional_phone',true)",[T,CONTACT]),/additional_phone_limit/);
  await db.query("update sales_core.contacts set phone='0507777777' where id=$1",[CONTACT]);
  await assert.rejects(db.query("insert into sales_core.contacts(tenant_id,full_name,phone) values($1,'Historical identity reuse','0501111111')",[T]),/duplicate key/);
});

test('opportunity creation is optional-next-action, permission scoped, idempotent and respects canonical owner',async t=>{
  const db=await fixture();t.after(()=>db.close());
  await assert.rejects(create(db,{p_course_id:null}),/training_course_required/);
  await assert.rejects(create(db,{p_course_id:C3}),/invalid_course/);
  await assert.rejects(create(db,{p_tenant_slug:'other'}),/forbidden/);
  await assert.rejects(create(db,{p_owner_staff_id:OTHER_STAFF}),/contact_owner_required/);
  await assert.rejects(create(db,{p_next_action_type:'call'}),/next_action_pair_required/);
  const first=await create(db);assert.equal(first.taskId,null);
  assert.equal((await create(db)).replayed,true);
  await assert.rejects(create(db,{p_title:'Changed retry'}),/opportunity_command_conflict/);
  await assert.rejects(create(db,{p_command_id:id(101)}),/open_opportunity_exists/);
  const row=(await db.query('select opportunity_kind,owner_staff_id,metadata from sales_core.opportunities where id=$1',[first.id])).rows[0];
  assert.equal(row.opportunity_kind,'training');assert.equal(row.owner_staff_id,STAFF);
  assert.equal(row.metadata.attribution.origin,'unattributed');assert.equal(row.metadata.attribution.campaignName,undefined);
  assert.equal((await db.query("select has_function_privilege('anon','public.v3_tenant_create_opportunity(text,uuid,text,uuid,bigint,uuid,uuid,date,text,timestamptz,text,uuid,text,text,text)','EXECUTE') ok")).rows[0].ok,false);
});

test('repeat sales preserve prior won contract and one earliest task across programs and followups',async t=>{
  const db=await fixture();t.after(()=>db.close());
  const original=await create(db);await db.query("update sales_core.opportunities set status='won' where id=$1",[original.id]);
  const saleA=await create(db,{p_command_id:id(101),p_next_action_type:'call',p_next_action_at:'2026-10-02T08:00:00Z',p_source:'google',p_campaign_name:'New sale campaign'});
  const saleB=await create(db,{p_command_id:id(102),p_course_id:C2,p_next_action_type:'whatsapp',p_next_action_at:'2026-10-01T08:00:00Z'});
  assert.equal(saleA.taskId,saleB.taskId);
  let task=(await db.query('select * from work_core.tasks where id=$1',[saleA.taskId])).rows[0];
  assert.equal(task.status,'todo');assert.equal(task.opportunity_id,saleB.id);
  await assert.rejects(followup(db),/followup_opportunity_required/);
  await followup(db,{p_opportunity_id:saleB.id});
  task=(await db.query('select * from work_core.tasks where id=$1',[saleA.taskId])).rows[0];
  assert.equal(task.opportunity_id,saleA.id);assert.equal(task.status,'todo');
  assert.equal((await db.query("select count(*)::int n from work_core.tasks where status in ('todo','in_progress') and contact_id=$1",[CONTACT])).rows[0].n,1);
  const prior=(await db.query('select status,value_minor from sales_core.opportunities where id=$1',[original.id])).rows[0];
  assert.equal(prior.status,'won');assert.equal(prior.value_minor,900000);
  await followup(db,{p_opportunity_id:saleB.id,p_command_id:id(201),p_payment_amount_minor:100,p_next_action_at:'2026-10-04T08:00:00Z'});
  assert.equal((await db.query('select value_minor from sales_core.opportunities where id=$1',[saleB.id])).rows[0].value_minor,900000);
  assert.equal((await context(db)).openOpportunities.length,2);
  const payment=await followup(db,{p_opportunity_id:saleB.id,p_command_id:id(202),p_lead_status:'payment_submitted',
    p_next_action_at:null,p_next_action_type:null,p_payment_course_id:C2,p_payment_amount_minor:10000});
  assert.ok(payment.handoffId);
  assert.equal((await db.query('select status,value_minor from sales_core.opportunities where id=$1',[saleB.id])).rows[0].status,'pending_verification');
  task=(await db.query('select * from work_core.tasks where id=$1',[saleA.taskId])).rows[0];
  assert.equal(task.status,'todo');assert.equal(task.opportunity_id,saleA.id);
  assert.equal((await db.query('select lead_status from sales_core.contacts where id=$1',[CONTACT])).rows[0].lead_status,'follow_up');
  assert.equal((await db.query('select value_minor from sales_core.opportunities where id=$1',[saleB.id])).rows[0].value_minor,900000);
});

test('general opportunity stays separate from stored training interests',async t=>{
  const db=await fixture();t.after(()=>db.close());
  const training=await create(db);
  const general=await create(db,{p_command_id:id(111),p_opportunity_kind:'general',p_course_id:null,p_title:'General inquiry'});
  await followup(db,{p_opportunity_id:general.id});
  const rows=(await db.query('select id,course_id,opportunity_kind,status from sales_core.opportunities where tenant_id=$1',[T])).rows;
  assert.equal(rows.find(row=>row.id===general.id).course_id,null);
  assert.equal(rows.find(row=>row.id===general.id).opportunity_kind,'general');
  assert.equal(rows.find(row=>row.id===training.id).course_id,C1);
  await assert.rejects(followup(db,{p_opportunity_id:general.id,p_command_id:id(222),p_lead_status:'payment_submitted',p_payment_course_id:C1}),/payment_opportunity_mismatch/);
});

test('generic work APIs cannot move, complete or reopen sales projection while genuine generic work remains editable',async t=>{
  const db=await fixture();t.after(()=>db.close());
  const sale=await create(db,{p_next_action_type:'call',p_next_action_at:'2026-10-02T08:00:00Z'});
  await db.query("select set_config('fixture.deny','tenant.crm.write',false)");
  const input={p_tenant_slug:'fixture',p_task_id:sale.taskId};
  for(const name of ['v2_tenant_update_task_status','v3_tenant_update_task_status']){
    await assert.rejects(call(db,name,{...input,p_status:'completed'}),/sales_task_requires_followup/);
  }
  for(const name of ['v3_tenant_transition_task','v4_tenant_transition_task']){
    await assert.rejects(call(db,name,{...input,p_due_at:'2026-10-09T08:00:00Z'}),/sales_task_requires_followup/);
    await assert.rejects(call(db,name,{...input,p_status:'cancelled'}),/sales_task_requires_followup/);
  }
  let task=(await db.query('select status,due_at from work_core.tasks where id=$1',[sale.taskId])).rows[0];
  assert.equal(task.status,'todo');assert.equal(task.due_at.toISOString(),'2026-10-02T08:00:00.000Z');
  const generic=await call(db,'v2_tenant_create_task',{p_tenant_slug:'fixture',p_title:'Prepare room',p_contact_id:CONTACT,p_due_at:'2026-10-04T08:00:00Z'});
  await call(db,'v4_tenant_transition_task',{p_tenant_slug:'fixture',p_task_id:generic.id,p_status:'completed'});
  assert.equal((await db.query('select status from work_core.tasks where id=$1',[generic.id])).rows[0].status,'completed');
  await db.query("select set_config('fixture.deny','',false)");
  await followup(db,{p_opportunity_id:sale.id,p_task_id:sale.taskId});
  task=(await db.query('select status,due_at from work_core.tasks where id=$1',[sale.taskId])).rows[0];
  assert.equal(task.status,'todo');assert.equal(task.due_at.toISOString(),'2026-10-03T08:00:00.000Z');
  assert.equal((await db.query("select count(*)::int n from work_core.tasks where contact_id=$1 and status in ('todo','in_progress') and metadata->>'source' in ('opportunity_next_action','sales_followup')",[CONTACT])).rows[0].n,1);
  await followup(db,{p_opportunity_id:sale.id,p_command_id:id(301),p_lead_status:'not_interested',p_closure_reason:'Not interested in this program',p_next_action_at:null,p_next_action_type:null});
  await assert.rejects(call(db,'v4_tenant_transition_task',{...input,p_status:'todo'}),/sales_task_requires_followup/);
  assert.equal((await db.query('select status from work_core.tasks where id=$1',[sale.taskId])).rows[0].status,'completed');
});
