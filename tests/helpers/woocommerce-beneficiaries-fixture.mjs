// Isolated PostgreSQL fixture. Uses the real legacy and forward functions; no
// service keys, production URLs, tenant records, or external notifications.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
export const id=n=>`31000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const T=id(1),OTHER=id(2),ACTOR=id(3),SALES=id(5),MANAGER=id(6),ADMISSION=id(7),CONTACT=id(8),C1=id(10),C2=id(11),
  CONNECTION=id(20),WORK=id(21),TASK=id(22),ENTITY=id(23),DEPT=id(24),RUN=id(25),RUN2=id(26);
let sequence=2000;
export const command=()=>id(sequence++);
const sqlTable=(source,name)=>{const start=source.indexOf(`create table ${name} (`);assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n);',start)+3);};
export const call=async(db,name,args)=>{
  const entries=Object.entries(args);
  return (await db.query(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) data`,
    entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].data;
};
export const context=db=>call(db,'v1_tenant_woocommerce_admission_context',{p_tenant_slug:'fixture',p_task_id:TASK});
export const count=async(db,table)=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n;
export const saveArgs=async(db,beneficiaries=[{contactId:CONTACT},{name:'مستفيد جديد',phone:'0502222222'}])=>({
  p_tenant_slug:'fixture',p_task_id:TASK,p_expected_revision:(await context(db)).revision,p_command_id:command(),
  p_lines:[{lineId:'101',beneficiaries}]
});
export const save=async(db,beneficiaries)=>call(db,'v1_tenant_woocommerce_save_beneficiaries',await saveArgs(db,beneficiaries));
export const submit=async(db,action='complete',handoffId=null)=>call(db,'v1_tenant_woocommerce_admission_action',{
  p_tenant_slug:'fixture',p_task_id:TASK,p_action:action,p_expected_revision:(await context(db)).revision,p_command_id:command(),
  p_lines:[{lineId:'101',courseId:C1,handoffId}],p_reason:action==='review'?'مراجعة المستفيدين وربط الدفع السابق دون تكرار':''
});
export const snapshot=db=>call(db,'v3_tenant_admissions_snapshot',{p_slug:'fixture'});
export const enrollArgs=async(db,choose)=>{
  const item=(await snapshot(db)).cases[0];
  return {p_tenant_slug:'fixture',p_handoff_id:item.id,p_expected_revision:item.beneficiaryRevision,p_command_id:command(),
    p_seats:choose||item.beneficiaries.filter(b=>!b.enrollmentId).map(b=>({id:b.id,courseRunId:RUN}))};
};
export const enroll=async(db,choose)=>call(db,'v1_tenant_woocommerce_enroll_beneficiaries',await enrollArgs(db,choose));

export async function setup({quantity=2,amount=139860}={}){
  const db=new PGlite();
  try{
    await db.exec(await read('../fixtures/sales-followup-legacy-schema.sql'));
    const routing=await read('../../supabase/migrations/20260812140000_woocommerce_order_task_routing_v1.sql');
    const admissions=await read('../../supabase/migrations/20260727223000_admissions_and_sales_guards_v2.sql');
    const notifications=await read('../../supabase/migrations/20260812210000_sales_request_notifications_v1.sql');
    await db.exec(`create schema commerce_sync;create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select private_app.current_subject_id()$$;
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
      ${sqlTable(notifications,'work_core.notifications')}`);
    const incentives=await read('../../supabase/migrations/20260729213000_goals_incentives_v2.sql');
    await db.exec(incentives.slice(0,incentives.indexOf('create or replace function public.v2_tenant_incentives_snapshot')));
    await db.exec(await read('../fixtures/woocommerce-admissions-legacy-functions.sql'));
    // Preserve the real batch policy and capacity trigger alongside group checks.
    const learnerOperations=await read('../../supabase/migrations/20260728003500_learner_operations_v2.sql');
    const validatorStart=learnerOperations.indexOf('create or replace function private_app.validate_enrollment_course_run()');
    const validatorEnd=learnerOperations.indexOf('\n$$;',validatorStart)+4;
    assert.ok(validatorStart>=0&&validatorEnd>validatorStart);
    await db.exec(learnerOperations.slice(validatorStart,validatorEnd));
    await db.exec(`create trigger enrollments_validate_course_run
      before insert or update of tenant_id,course_id,course_run_id,status on academy.enrollments
      for each row execute function private_app.validate_enrollment_course_run()`);
    await db.exec(routing.slice(routing.indexOf('create or replace function private_app.commerce_order_queue_owner('),routing.indexOf('create or replace function private_app.route_woocommerce_order_batch(')));
    await db.exec(`create function private_app.can_access_tenant(t uuid) returns boolean language sql as $$select private_app.has_tenant_permission(t,'tenant.work.read')$$;
      create function private_app.woocommerce_try_bigint(v text) returns bigint language sql as $$select v::bigint$$;
      create function private_app.woocommerce_try_numeric(v text) returns numeric language sql as $$select v::numeric$$;
      create function private_app.woocommerce_try_timestamptz(v text) returns timestamptz language sql as $$select v::timestamptz$$;
      create function public.v3_tenant_commerce_order_queue_snapshot(p_slug text) returns jsonb language sql as $$select '{}'::jsonb$$;
      create or replace function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql stable as $$
       select coalesce(t::text=current_setting('fixture.tenant',true),false) and private_app.current_subject_id() is not null
        and (coalesce(current_setting('fixture.team',true),'no')='yes' or p in ('tenant.work.read','tenant.work.write','tenant.crm.read'))$$;`);
    await db.exec(await read('../../supabase/migrations/20260910201255_woocommerce_admissions_v1.sql'));
    await db.exec(await read('../../supabase/migrations/20260912150000_woocommerce_beneficiaries_v1.sql'));
    await db.query("insert into core.tenants(id,slug,timezone) values($1,'fixture','Asia/Riyadh'),($2,'foreign','UTC')",[T,OTHER]);
    await db.query('insert into access_control.subjects(id) values($1)',[ACTOR]);
    await db.query("insert into people.departments(id,tenant_id,department_key,status) values($1,$2,'admissions','active')",[DEPT,T]);
    await db.query("insert into people.staff_profiles(id,tenant_id,full_name,role_key,department_id) values($1,$4,'المبيعات','sales_user',null),($2,$4,'الإدارة','sales_manager',null),($3,$4,'التسجيل','customer_service',$5)",[SALES,MANAGER,ADMISSION,T,DEPT]);
    await db.query("insert into access_control.memberships(id,tenant_id,subject_id,status,scope) values($1,$2,$3,'active','tenant')",[id(50),T,ACTOR]);
    await db.query("insert into access_control.roles(id,scope,role_key) values($1,'tenant','sales_manager')",[id(51)]);
    await db.query('insert into access_control.membership_roles values($1,$2)',[id(50),id(51)]);
    await db.query('update people.staff_profiles set membership_id=$1 where id=$2',[id(50),MANAGER]);
    await db.query("select set_config('fixture.subject',$1,false),set_config('fixture.tenant',$2,false),set_config('fixture.staff',$3,false),set_config('fixture.team','yes',false)",[ACTOR,T,MANAGER]);
    await db.query("insert into academy.courses(id,tenant_id,title_ar,status) values($1,$3,'CAPM','active'),($2,$3,'دورة أخرى','active')",[C1,C2,T]);
    await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values($1,$2,'صاحب الطلب','0501111111',$3)",[CONTACT,T,SALES]);
    await db.query("insert into sales_core.pipeline_stages(id,tenant_id,stage_key,is_won) values($1,$2,'won',true)",[id(27),T]);
    await db.query("insert into academy.course_runs(id,tenant_id,course_id,title,status,starts_at,capacity) values($1,$3,$4,'الدفعة الأولى','open','2026-10-03T09:00Z',10),($2,$3,$4,'الدفعة الثانية','open','2026-11-03T09:00Z',10)",[RUN,RUN2,T,C1]);
    await db.query('insert into commerce_sync.connections(id,tenant_id) values($1,$2)',[CONNECTION,T]);
    await db.query("insert into sales_core.commerce_order_routing_settings(tenant_id,enabled_at) values($1,now()-interval '30 days')",[T]);
    const raw={id:9001,status:'completed',total:(amount/100).toFixed(2),currency:'SAR',_marktone:{paidAt:'2026-09-01T21:30:00Z'},refunds:[],
      line_items:[{id:101,name:'CAPM',product_id:101,variation_id:0,quantity,total:(amount/100).toFixed(2),total_tax:'0.00'}]};
    await db.query("insert into commerce_sync.external_entities(id,tenant_id,connection_id,entity_type,external_id,raw_payload) values($1,$2,$3,'orders','9001',$4)",[ENTITY,T,CONNECTION,JSON.stringify(raw)]);
    await db.query("insert into work_core.tasks(id,tenant_id,task_key,title,status,assigned_staff_id,contact_id,due_at,metadata) values($1,$2,'woo-task','طلب اختبار','todo',$3,$4,now()+interval '1 day','{\"source\":\"woocommerce_order\"}')",[TASK,T,SALES,CONTACT]);
    await db.query("insert into sales_core.commerce_order_work_items(id,tenant_id,connection_id,external_entity_id,external_order_id,task_id,contact_id,assigned_staff_id,routing_state,order_number,order_status,payment_state,amount_minor,paid_at) values($1,$2,$3,$4,'9001',$5,$6,$7,'assigned','9001','completed','paid',$8,'2026-09-01T21:30Z')",[WORK,T,CONNECTION,ENTITY,TASK,CONTACT,SALES,amount]);
    await db.query("insert into sales_core.commerce_admission_rollouts(tenant_id,enabled,enabled_at) values($1,true,now()-interval '1 day')",[T]);
    return db;
  }catch(error){await db.close();delete error.query;throw error;}
}
