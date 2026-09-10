import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const id=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=id(1),OTHER=id(2),ACTOR=id(3),OLD=id(4),SALES=id(5),MANAGER=id(6),ADMISSION=id(7),CONTACT=id(8),
  C1=id(10),C2=id(11),FOREIGN=id(12),CONNECTION=id(20),WORK=id(21),TASK=id(22),ENTITY=id(23),DEPT=id(24),RUN=id(25);
let sequence=1000;
const sqlTable=(source,name)=>{
  const start=source.indexOf(`create table ${name} (`);
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n);',start)+3);
};
const call=async(db,name,args)=>{
  const entries=Object.entries(args);
  return (await db.query(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) data`,
    entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].data;
};
const context=db=>call(db,'v1_tenant_woocommerce_admission_context',{p_tenant_slug:'fixture',p_task_id:TASK});
const count=async(db,table)=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n;
const action=async(db,kind='complete',overrides={})=>call(db,'v1_tenant_woocommerce_admission_action',{
  p_tenant_slug:'fixture',p_task_id:TASK,p_action:kind,p_expected_revision:(await context(db)).revision,
  p_command_id:id(sequence++),p_lines:[{lineId:'101',courseId:C1,handoffId:null},{lineId:'102',courseId:C2,handoffId:null}],
  p_reason:kind==='review'?'مراجعة تجريبية: عملية شراء جديدة مستقلة':'',...overrides
});

async function setup(){
  const db=new PGlite();
  try{
  await db.exec(await read('./fixtures/sales-followup-legacy-schema.sql'));
  const routing=await read('../supabase/migrations/20260812140000_woocommerce_order_task_routing_v1.sql');
  const admissions=await read('../supabase/migrations/20260727223000_admissions_and_sales_guards_v2.sql');
  const notifications=await read('../supabase/migrations/20260812210000_sales_request_notifications_v1.sql');
  await db.exec(`create schema commerce_sync;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select private_app.current_subject_id() $$;
    create table commerce_sync.connections(id uuid primary key,tenant_id uuid,status text default 'active');
    create table commerce_sync.external_entities(id uuid primary key,tenant_id uuid,connection_id uuid,entity_type text,
      external_id text,local_course_id uuid,raw_payload jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
    create table access_control.memberships(id uuid primary key,tenant_id uuid,subject_id uuid,status text,scope text);
    create table access_control.roles(id uuid primary key,scope text,role_key text);
    create table access_control.membership_roles(membership_id uuid,role_id uuid);
    create table sales_core.sales_assignment_profiles(tenant_id uuid,staff_id uuid,last_assigned_at timestamptz,
      eligible_for_leads boolean default true,sales_channel text default 'online',daily_capacity int default 50,weight int default 1);
    alter table academy.courses add unique(tenant_id,id);
    alter table sales_core.opportunities add unique(tenant_id,opportunity_key);
    alter table academy.registration_handoffs add check(payment_status<>'verified' or payment_verified_at is not null);
    ${sqlTable(routing,'sales_core.commerce_order_routing_settings')}
    ${sqlTable(routing,'sales_core.commerce_order_work_items')}
    ${sqlTable(admissions,'academy.students')}
    ${sqlTable(admissions,'academy.enrollments')}
    ${sqlTable(notifications,'work_core.notifications')}
  `);
  const incentives=await read('../supabase/migrations/20260729213000_goals_incentives_v2.sql');
  await db.exec(incentives.slice(0,incentives.indexOf('create or replace function public.v2_tenant_incentives_snapshot')));
  await db.exec(await read('./fixtures/woocommerce-admissions-legacy-functions.sql'));
  // Real legacy routing helper functions used by the public assign action.
  const helpers=routing.slice(routing.indexOf('create or replace function private_app.commerce_order_queue_owner('),
    routing.indexOf('create or replace function private_app.route_woocommerce_order_batch('));
  await db.exec(helpers);
  await db.exec(`create function private_app.can_access_tenant(t uuid) returns boolean language sql as $$
      select private_app.has_tenant_permission(t,'tenant.work.read') $$;
    create function private_app.woocommerce_try_bigint(v text) returns bigint language sql as $$select v::bigint$$;
    create function private_app.woocommerce_try_numeric(v text) returns numeric language sql as $$select v::numeric$$;
    create function private_app.woocommerce_try_timestamptz(v text) returns timestamptz language sql as $$select v::timestamptz$$;
    create function public.v3_tenant_commerce_order_queue_snapshot(p_slug text) returns jsonb language sql as $$select '{}'::jsonb$$;`);
  await db.exec(`create or replace function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql stable as $$
    select coalesce(t::text=current_setting('fixture.tenant',true),false)
     and coalesce(current_setting('fixture.deny',true),'')<>p and private_app.current_subject_id() is not null
     and (coalesce(current_setting('fixture.team',true),'no')='yes' or p in ('tenant.work.read','tenant.work.write','tenant.crm.read')) $$;`);
  await db.exec(await read('../supabase/migrations/20260910201255_woocommerce_admissions_v1.sql'));
  await db.query("insert into core.tenants(id,slug,timezone) values($1,'fixture','Asia/Riyadh'),($2,'foreign','UTC')",[T,OTHER]);
  await db.query("insert into access_control.subjects(id) values($1)",[ACTOR]);
  await db.query("insert into people.departments(id,tenant_id,department_key,status) values($1,$2,'admissions','active')",[DEPT,T]);
  await db.query("insert into people.staff_profiles(id,tenant_id,full_name,role_key,department_id) values($1,$5,'السابق','sales_user',null),($2,$5,'الجديد','sales_user',null),($3,$5,'الإدارة','sales_manager',null),($4,$5,'التسجيل','customer_service',$6)",[OLD,SALES,MANAGER,ADMISSION,T,DEPT]);
  await db.query("insert into access_control.memberships(id,tenant_id,subject_id,status,scope) values($1,$2,$3,'active','tenant')",[id(50),T,ACTOR]);
  await db.query("insert into access_control.roles(id,scope,role_key) values($1,'tenant','sales_manager')",[id(51)]);
  await db.query('insert into access_control.membership_roles values($1,$2)',[id(50),id(51)]);
  await db.query('update people.staff_profiles set membership_id=$1 where id=$2',[id(50),MANAGER]);
  await db.query("select set_config('fixture.subject',$1,false),set_config('fixture.tenant',$2,false),set_config('fixture.staff',$3,false),set_config('fixture.team','yes',false)",[ACTOR,T,MANAGER]);
  await db.query("insert into academy.courses(id,tenant_id,title_ar,status) values($1,$4,'دورة أولى','active'),($2,$4,'دورة ثانية','active'),($3,$5,'خارج المنشأة','active')",[C1,C2,FOREIGN,T,OTHER]);
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values($1,$2,'عميل تجريبي','0504444444',$3)",[CONTACT,T,SALES]);
  await db.query("insert into sales_core.pipeline_stages(id,tenant_id,stage_key,is_won) values($1,$2,'won',true)",[id(26),T]);
  await db.query("insert into academy.course_runs(id,tenant_id,course_id,title,status,starts_at,capacity) values($1,$2,$3,'دفعة اختبار','open','2026-10-03T09:00Z',10)",[RUN,T,C1]);
  await db.query('insert into commerce_sync.connections(id,tenant_id) values($1,$2)',[CONNECTION,T]);
  await db.query("insert into sales_core.commerce_order_routing_settings(tenant_id,enabled_at) values($1,now()-interval '30 days')",[T]);
  const raw={id:9001,status:'completed',total:'150.01',currency:'SAR',_marktone:{paidAt:'2026-09-01T21:30:00Z'},refunds:[],
    line_items:[{id:101,name:'منتج أول',product_id:101,variation_id:0,quantity:1,total:'100.00',total_tax:'0.00'},
      {id:102,name:'منتج ثان',product_id:102,variation_id:0,quantity:1,total:'50.00',total_tax:'0.00'}]};
  await db.query("insert into commerce_sync.external_entities(id,tenant_id,connection_id,entity_type,external_id,raw_payload) values($1,$2,$3,'orders','9001',$4)",[ENTITY,T,CONNECTION,JSON.stringify(raw)]);
  await db.query("insert into work_core.tasks(id,tenant_id,task_key,title,status,assigned_staff_id,contact_id,due_at,metadata) values($1,$2,'woo-task','طلب اختبار','todo',$3,$4,now()+interval '1 day','{\"source\":\"woocommerce_order\"}')",[TASK,T,SALES,CONTACT]);
  await db.query("insert into sales_core.commerce_order_work_items(id,tenant_id,connection_id,external_entity_id,external_order_id,task_id,contact_id,assigned_staff_id,routing_state,order_number,order_status,payment_state,amount_minor,paid_at) values($1,$2,$3,$4,'9001',$5,$6,$7,'assigned','9001','completed','paid',15001,'2026-09-01T21:30Z')",[WORK,T,CONNECTION,ENTITY,TASK,CONTACT,SALES]);
  await db.query("insert into sales_core.commerce_admission_rollouts(tenant_id,enabled,enabled_at) values($1,true,now()-interval '1 day')",[T]);
  return db;
  }catch(error){await db.close();delete error.query;throw error;}
}

test('WooCommerce admissions executes the payment → admission → enrollment flow in Postgres',async t=>{
  const db=await setup();t.after(()=>db.close());
  await t.test('integer allocation includes the order remainder exactly',async()=>{
    const c=await context(db);assert.equal(c.items.reduce((sum,x)=>sum+x.amountMinor,0),15001);
    assert.deepEqual(c.items.map(x=>x.amountMinor),[10001,5000]);assert.deepEqual(c.blockers,[]);
  });
  await t.test('disabled rollout preserves data and denies writes',async()=>{
    await db.query('update sales_core.commerce_admission_rollouts set enabled=false');
    assert.deepEqual(await context(db),{enabled:false});
    await assert.rejects(action(db,'complete',{p_expected_revision:'x'}),/woocommerce_admissions_disabled/);
    assert.equal(await count(db,'academy.registration_handoffs'),0);
    await db.query('update sales_core.commerce_admission_rollouts set enabled=true');
  });
  await t.test('RPC and direct table boundaries reject unauthorized and cross-tenant access',async()=>{
    await assert.rejects(call(db,'v1_tenant_woocommerce_admission_context',{p_tenant_slug:'foreign',p_task_id:TASK}),/forbidden/);
    await db.query("select set_config('fixture.subject','',false)");await assert.rejects(context(db),/forbidden/);
    await db.query("select set_config('fixture.subject',$1,false)",[ACTOR]);
    await db.exec('set role authenticated');await assert.rejects(db.query('select * from sales_core.commerce_admission_orders'),/permission denied/);await db.exec('reset role');
    assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text)','EXECUTE') ok")).rows[0].ok,false);
  });
  await t.test('generic completion cannot bypass course selection',async()=>{
    await assert.rejects(call(db,'v3_tenant_transition_task',{p_tenant_slug:'fixture',p_task_id:TASK,p_status:'completed'}),/woocommerce_choose_all_courses/);
    assert.equal((await db.query('select status from work_core.tasks where id=$1',[TASK])).rows[0].status,'todo');
  });
  await t.test('missing/duplicate/foreign courses roll back the entire command',async()=>{
    for(const lines of [[],[{lineId:'101',courseId:C1}],[{lineId:'101',courseId:FOREIGN},{lineId:'102',courseId:C2}],
      [{lineId:'101',courseId:C1},{lineId:'101',courseId:C2}]]){
      await assert.rejects(action(db,'complete',{p_lines:lines}),/woocommerce_choose_all_courses|invalid_course/);
      assert.equal(await count(db,'academy.registration_handoffs'),0);
    }
  });
  await t.test('stale preview is rejected; sync heartbeat does not invalidate it',async()=>{
    const c=await context(db);await db.query("update sales_core.commerce_order_work_items set last_seen_at=now(),updated_at=now()");
    assert.equal((await context(db)).revision,c.revision);
    await assert.rejects(action(db,'complete',{p_expected_revision:'stale'}),/woocommerce_order_changed/);
  });
  await t.test('one command creates two verified handoffs, two won sales, two admissions tasks',async()=>{
    const args={p_tenant_slug:'fixture',p_task_id:TASK,p_action:'complete',p_expected_revision:(await context(db)).revision,
      p_command_id:id(sequence++),p_lines:[{lineId:'101',courseId:C1,handoffId:null},{lineId:'102',courseId:C2,handoffId:null}],p_reason:''};
    const r=await call(db,'v1_tenant_woocommerce_admission_action',args);assert.equal(r.handoffs.length,2);
    assert.equal((await call(db,'v1_tenant_woocommerce_admission_action',args)).replayed,true);
    assert.equal(await count(db,'academy.registration_handoffs'),2);assert.equal(await count(db,'sales_core.opportunities'),2);
    assert.equal((await db.query("select count(*)::int n from work_core.tasks where status='todo'")).rows[0].n,2);
    const h=(await db.query('select * from academy.registration_handoffs order by course_id')).rows;
    assert.ok(h.every(x=>x.payment_status==='verified'&&x.payment_verified_at&&x.course_run_id===null));
    assert.equal(h.reduce((sum,x)=>sum+Number(x.payment_amount_minor),0),15001);
    assert.equal(new Date(h[0].paid_at).toISOString(),'2026-09-01T21:30:00.000Z');
    const snapshot=await call(db,'v3_tenant_admissions_snapshot',{p_slug:'fixture'});
    assert.equal(snapshot.cases[0].paymentSource,'woocommerce');assert.equal(snapshot.cases[0].salesOwnerName,'الجديد');
    await assert.rejects(call(db,'v2_tenant_update_admission',{p_tenant_slug:'fixture',p_handoff_id:h[0].id,p_action:'complete'}),/course_run_required/);
    const completed=await call(db,'v2_tenant_update_admission',{p_tenant_slug:'fixture',p_handoff_id:h[0].id,p_action:'complete',p_course_run_id:RUN});
    assert.ok(completed.enrollmentId);assert.equal(await count(db,'academy.enrollments'),1);
    assert.equal((await db.query('select enrolled_count from academy.course_runs where id=$1',[RUN])).rows[0].enrolled_count,1);
  });
  await t.test('refund after submission holds admissions and cannot be manually re-verified',async()=>{
    await db.query("update commerce_sync.external_entities set raw_payload=jsonb_set(raw_payload,'{refunds}','[{\"id\":1,\"total\":\"-10.00\"}]') where id=$1",[ENTITY]);
    await db.query('update sales_core.commerce_order_work_items set last_seen_at=now() where id=$1',[WORK]);
    const h=(await db.query('select * from academy.registration_handoffs order by course_id')).rows;
    assert.ok(h.every(x=>x.payment_status==='pending_verification'));
    await assert.rejects(call(db,'v2_tenant_update_admission',{p_tenant_slug:'fixture',p_handoff_id:h[1].id,p_action:'verify_payment'}),/woocommerce_payment_changed/);
    const n=await count(db,'work_core.notifications');await db.query('update sales_core.commerce_order_work_items set last_seen_at=now() where id=$1',[WORK]);
    assert.equal(await count(db,'work_core.notifications'),n);assert.equal(await count(db,'academy.enrollments'),1);
  });
});

test('legacy review transfers ownership, preserves history and reuses matching admissions',async t=>{
  const db=await setup();t.after(()=>db.close());
  await db.query('update sales_core.contacts set owner_staff_id=$1',[OLD]);
  await db.query("update sales_core.commerce_order_work_items set first_seen_at=now()-interval '10 days'");
  assert.ok((await context(db)).blockers.includes('woocommerce_owner_transfer_required'));
  await t.test('review is atomic and produces old/new/management notifications once',async()=>{
    const args={p_tenant_slug:'fixture',p_task_id:TASK,p_action:'review',p_expected_revision:(await context(db)).revision,
      p_command_id:id(sequence++),p_lines:[{lineId:'101',courseId:C1,handoffId:null},{lineId:'102',courseId:C2,handoffId:null}],p_reason:'تمت مراجعة الطلب القديم: شراء مستقل'};
    await call(db,'v1_tenant_woocommerce_admission_action',args);
    assert.equal((await db.query('select owner_staff_id from sales_core.contacts where id=$1',[CONTACT])).rows[0].owner_staff_id,SALES);
    assert.equal(await count(db,'work_core.notifications'),3);assert.equal(await count(db,'sales_core.activities'),1);
    assert.equal((await call(db,'v1_tenant_woocommerce_admission_action',args)).replayed,true);
    assert.equal(await count(db,'work_core.notifications'),3);assert.equal((await context(db)).reviewValid,true);
    await assert.rejects(action(db,'complete',{p_lines:[{lineId:'101',courseId:C2},{lineId:'102',courseId:C1}]}),/woocommerce_review_changed/);
    await action(db);assert.equal(await count(db,'academy.registration_handoffs'),2);
  });
});

test('legacy assignment endpoint transfers ownership too; active follow-up is reused',async t=>{
  const db=await setup();t.after(()=>db.close());
  const followup=id(401),assignment=id(402);
  await db.query('update sales_core.contacts set owner_staff_id=$1',[OLD]);
  await db.query("insert into work_core.tasks(id,tenant_id,task_key,title,status,assigned_staff_id,contact_id,due_at,metadata) values($1,$2,'followup','متابعة','todo',$3,$4,now()+interval '2 days','{\"source\":\"lead_assignment\"}')",[followup,T,OLD,CONTACT]);
  await db.query("insert into sales_core.lead_assignments(id,tenant_id,contact_id,task_id,assigned_staff_id,assignment_strategy,status,deadline_at) values($1,$2,$3,$4,$5,'selected','active',now()+interval '2 days')",[assignment,T,CONTACT,followup,OLD]);
  await call(db,'v3_tenant_commerce_order_action',{p_tenant_slug:'fixture',p_action:'assign',p_payload:{itemIds:[WORK],staffId:SALES}});
  assert.equal((await db.query('select owner_staff_id from sales_core.contacts where id=$1',[CONTACT])).rows[0].owner_staff_id,SALES);
  assert.equal((await db.query('select assigned_staff_id from work_core.tasks where id=$1',[followup])).rows[0].assigned_staff_id,SALES);
  assert.equal(await count(db,'work_core.tasks'),2);
  const rows=(await db.query('select * from sales_core.lead_assignments order by created_at,id')).rows;
  assert.equal(rows.find(x=>x.id===assignment).status,'reassigned');
  assert.equal(rows.find(x=>x.id!==assignment).metadata.source,'manual_reassignment');
  const n=await count(db,'work_core.notifications');
  await call(db,'v3_tenant_commerce_order_action',{p_tenant_slug:'fixture',p_action:'assign',p_payload:{itemIds:[WORK],staffId:SALES}});
  assert.equal(await count(db,'work_core.notifications'),n);assert.equal(await count(db,'sales_core.lead_assignments'),2);
});

test('reusing a manual payment preserves its identity and moves only this sale incentive',async t=>{
  const db=await setup();t.after(()=>db.close());
  const opp=id(501),handoff=id(502),plan=id(503),aOld=id(504),aNew=id(505);
  await db.query("insert into incentives_core.plans(id,tenant_id,plan_key,title,period_start,period_end,metric_type,calculation_type,incentive_value) values($1,$2,'fixture','حوافز الاختبار',current_date-10,current_date+10,'revenue','percentage',10)",[plan,T]);
  await db.query('insert into incentives_core.assignments(id,tenant_id,plan_id,staff_id,target_value) values($1,$3,$4,$5,1000),($2,$3,$4,$6,1000)',[aOld,aNew,T,plan,OLD,SALES]);
  await db.query('update sales_core.contacts set owner_staff_id=$1',[OLD]);
  await db.query("insert into sales_core.opportunities(id,tenant_id,opportunity_key,contact_id,course_id,owner_staff_id,title,status,value_minor) values($1,$2,'old-payment',$3,$4,$5,'بيع سابق','won',10001)",[opp,T,CONTACT,C1,OLD]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,opportunity_id,payment_status,payment_verified_at,payment_amount_minor,payment_reference,status) values($1,$2,'old-report',$3,$4,$5,'verified',now(),10001,'9001','accepted')",[handoff,T,CONTACT,C1,opp]);
  const original=(await db.query('select paid_at,payment_reported_at from academy.registration_handoffs where id=$1',[handoff])).rows[0];
  const choices=[{lineId:'101',courseId:C1,handoffId:handoff},{lineId:'102',courseId:C2,handoffId:null}];
  await assert.rejects(action(db,'review'),/woocommerce_existing_payment_unlinked/);
  assert.equal((await db.query('select owner_staff_id from sales_core.contacts where id=$1',[CONTACT])).rows[0].owner_staff_id,OLD);
  for(const state of ['approved','paid']){
    await db.query('update incentives_core.events set state=$1 where source_id=$2',[state,handoff]);
    await assert.rejects(action(db,'review',{p_lines:choices}),/woocommerce_settled_incentive_review/);
    assert.equal((await db.query('select owner_staff_id from sales_core.contacts where id=$1',[CONTACT])).rows[0].owner_staff_id,OLD);
  }
  await db.query("update incentives_core.events set state='due' where source_id=$1",[handoff]);
  await action(db,'review',{p_lines:choices});
  await db.query("select set_config('fixture.staff',$1,false),set_config('fixture.team','no',false)",[OLD]);
  await assert.rejects(context(db),/forbidden/);
  await db.query("select set_config('fixture.staff',$1,false)",[SALES]);
  await assert.rejects(action(db,'review',{p_lines:choices}),/forbidden/);
  await action(db,'complete',{p_lines:choices});
  assert.equal(await count(db,'academy.registration_handoffs'),2);assert.equal(await count(db,'sales_core.opportunities'),2);
  const existing=(await db.query('select * from academy.registration_handoffs where id=$1',[handoff])).rows[0];
  assert.equal(existing.status,'accepted');assert.equal(existing.handoff_key,'old-report');
  assert.deepEqual({paid_at:existing.paid_at,payment_reported_at:existing.payment_reported_at},original);
  const events=(await db.query('select * from incentives_core.events order by staff_id')).rows;
  assert.ok(events.filter(e=>e.staff_id===OLD).every(e=>e.state==='cancelled'));
  assert.equal(events.filter(e=>e.staff_id===SALES&&e.state==='due').length,2);
  // A later owner change must not move or recreate the completed Woo sale incentive.
  await db.query('update sales_core.contacts set owner_staff_id=$1',[MANAGER]);
  await db.query('select private_app.sync_incentive_source($1)',[handoff]);
  assert.equal(await count(db,'incentives_core.events'),events.length);
});

test('group purchases, currency, missing dates and mismatched amounts are held',async t=>{
  const db=await setup();t.after(()=>db.close());
  const original=(await db.query('select raw_payload from commerce_sync.external_entities where id=$1',[ENTITY])).rows[0].raw_payload;
  for(const [path,value,error] of [['{line_items,0,quantity}','5','woocommerce_beneficiaries_required'],
    ['{_marktone,paidAt}','null','woocommerce_payment_date_missing'],['{currency}','"USD"','woocommerce_currency_or_amount'],
    ['{total}','"200.00"','woocommerce_currency_or_amount'],['{status}','"cancelled"','woocommerce_payment_unconfirmed']]){
    await db.query('update commerce_sync.external_entities set raw_payload=jsonb_set($1::jsonb,$2::text[],$3::jsonb) where id=$4',[JSON.stringify(original),path,value,ENTITY]);
    await assert.rejects(action(db),new RegExp(error));assert.equal(await count(db,'academy.registration_handoffs'),0);
  }
  await db.query('update commerce_sync.external_entities set raw_payload=$1 where id=$2',[JSON.stringify(original),ENTITY]);
  const h=id(601);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_status,payment_verified_at,payment_amount_minor,payment_reference,status) values($1,$2,'mismatch',$3,$4,'verified',now(),10000,'9001','accepted')",[h,T,CONTACT,C1]);
  await assert.rejects(action(db,'review',{p_lines:[{lineId:'101',courseId:C1,handoffId:h},{lineId:'102',courseId:C2,handoffId:null}]}),/woocommerce_existing_payment_mismatch/);
  assert.equal((await db.query('select payment_amount_minor from academy.registration_handoffs where id=$1',[h])).rows[0].payment_amount_minor,10000);
});
