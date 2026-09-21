import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const T='10000000-0000-4000-8000-000000000001';
const U='10000000-0000-4000-8000-000000000002';
const S='10000000-0000-4000-8000-000000000003';
const D='10000000-0000-4000-8000-000000000004';
const A='10000000-0000-4000-8000-000000000005';
const M='10000000-0000-4000-8000-000000000006';
let db;
const q=async(sql,args=[])=>db.query(sql,args);
async function action(name,payload={}){
  return (await q('select public.v1_tenant_operating_action($1,$2,$3::jsonb) result',['sandbox',name,JSON.stringify(payload)])).rows[0].result;
}
before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon;create role authenticated;create role service_role;
    create schema core;create schema private_app;create schema people;create schema academy;create schema access_control;create schema accounting_core;create schema sales_core;
    create table core.tenants(id uuid primary key,slug text,name text,legal_name text,timezone text,updated_at timestamptz);
    create table access_control.subjects(id uuid primary key,status text);
    create table access_control.memberships(id uuid primary key,tenant_id uuid,subject_id uuid,status text);
    create table access_control.membership_roles(membership_id uuid);
    create table people.departments(id uuid primary key,tenant_id uuid,name_ar text,status text);
    create table people.staff_profiles(id uuid primary key,tenant_id uuid,membership_id uuid,department_id uuid,full_name text,employment_status text,account_status text);
    create table academy.course_runs(id uuid primary key,tenant_id uuid);
    create table academy.registration_handoffs(id uuid primary key,tenant_id uuid,course_run_id uuid,opportunity_id uuid,registration_status text default 'pending',created_at timestamptz default now());
    create table academy.admission_governance_settings(tenant_id uuid primary key,enabled boolean default false);
    create table academy.admission_governance_queue(tenant_id uuid,handoff_id uuid primary key);
    create function private_app.queue_admission_governance_v1(t uuid,h uuid) returns void language sql as $$insert into academy.admission_governance_queue values(t,h) on conflict do nothing$$;
    create table academy.enrollments(id uuid primary key,tenant_id uuid,course_run_id uuid);
    create schema work_core;
    create table work_core.tasks(id uuid primary key,tenant_id uuid,opportunity_id uuid,assigned_staff_id uuid);
    create table accounting_core.sales_documents(id uuid primary key,tenant_id uuid,source_type text,source_id text,status text);
    create table accounting_core.payments(id uuid primary key,tenant_id uuid,source_type text,source_id text,status text);
    create table sales_core.contacts(id uuid primary key,tenant_id uuid,owner_staff_id uuid,full_name text);
    create table sales_core.opportunities(id uuid primary key,tenant_id uuid,contact_id uuid,title text,status text,next_action_at timestamptz,created_at timestamptz default now());
    create table accounting_core.tenant_profiles(tenant_id uuid primary key,base_currency text,tax_registered boolean,timezone text,updated_at timestamptz,updated_by_subject_id uuid);
    create function private_app.current_subject_id() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
    create function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql as $$select t=nullif(current_setting('test.tenant',true),'')::uuid and current_setting('test.allowed',true)='yes'$$;
    create function private_app.has_accounting_permission(t uuid,p text) returns boolean language sql as $$select private_app.has_tenant_permission(t,p)$$;
    create function private_app.can_view_tenant_team(t uuid) returns boolean language sql as $$select coalesce(current_setting('test.team',true),'yes')<>'no'$$;
    create function private_app.admission_business_deadline_v1(t uuid,started timestamptz,days integer) returns timestamptz language sql as $$select started+days*interval '1 day'$$;
    create function private_app.commerce_order_pick_assignee(p_tenant_id uuid,p_mode text) returns uuid language sql as $$select staff.id from people.staff_profiles staff where staff.tenant_id=p_tenant_id and staff.employment_status = 'active' limit 1$$;
    create function public.v2_tenant_lead_intake_action_unhardened_20260806(t text,a text,p jsonb) returns jsonb language sql as $$select to_jsonb(staff.id) from people.staff_profiles staff where staff.employment_status = 'active' limit 1$$;
    create function public.v1_tenant_lead_reassignment_action(t text,p jsonb) returns jsonb language sql as $$select to_jsonb(staff.id) from people.staff_profiles staff where staff.employment_status = 'active' limit 1$$;
    insert into core.tenants values('${T}','sandbox','Sandbox','Sandbox Academy','Asia/Riyadh',now()),('${U}','other','Other','Other Academy','UTC',now());
    insert into access_control.subjects values('${A}','active');
    insert into access_control.memberships values('${M}','${T}','${A}','active');
    insert into access_control.membership_roles values('${M}');
    insert into people.departments values('${D}','${T}','المبيعات','active');
    insert into people.staff_profiles values('${S}','${T}','${M}','${D}','موظف اختبار','active','active');
    select set_config('test.actor','${A}',false),set_config('test.tenant','${T}',false),set_config('test.allowed','yes',false);
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20260921125653_tenant_operating_foundation_v1.sql',import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});

test('installation does not create configuration or rewrite legacy live rows',async()=>{
  assert.equal((await q('select count(*)::int n from core.branches')).rows[0].n,0);
  assert.equal((await q('select count(*)::int n from core.tenant_operating_setup')).rows[0].n,0);
  assert.equal((await q('select branch_id from people.staff_profiles where id=$1',[S])).rows[0].branch_id,null);
});

test('free readiness uses manual intake and canonical finance, with no paid addon or fake payment',async()=>{
  let snapshot=await action('save_setup',{expectedVersion:0,name:'Sandbox',legalName:'Sandbox Academy',timezone:'Asia/Riyadh',intakeSource:'manual',firstBranchName:'الفرع الأول'});
  assert.equal(snapshot.ready,false);
  assert.equal(snapshot.checks.intakeSource,true);
  assert.equal(snapshot.checks.firstBranch,true);
  assert.equal(snapshot.checks.taxConfiguration,false);
  await q('insert into accounting_core.tenant_profiles(tenant_id,base_currency,tax_registered,timezone) values($1,$2,false,$3)',[T,'SAR','Asia/Riyadh']);
  snapshot=(await q("select public.v1_tenant_operating_snapshot('sandbox') result")).rows[0].result;
  assert.equal(snapshot.ready,true);
  assert.equal(snapshot.legacyRowsWithoutBranch.staff,1);
  assert.equal(snapshot.setup.staffSchedulingEnabled,false);
});

test('setup retries require current version and new tenants get one automatic first branch',async()=>{
  await assert.rejects(action('save_setup',{expectedVersion:0,name:'Sandbox',legalName:'Sandbox Academy',timezone:'Asia/Riyadh',intakeSource:'excel'}),/version_conflict/);
  await q("insert into core.tenants(id,slug,name,timezone) values('10000000-0000-4000-8000-000000000009','new','New','UTC')");
  assert.equal((await q("select count(*)::int n from core.branches where tenant_id='10000000-0000-4000-8000-000000000009' and is_default")).rows[0].n,1);
});

test('tenant isolation and explicit RPC permissions protect setup and staff',async()=>{
  await assert.rejects(q("select public.v1_tenant_operating_snapshot('other')"),/forbidden/);
  await db.exec("set role authenticated");
  await assert.rejects(q('select * from core.branches'),/permission denied/);
  await db.exec('reset role');
  const branch=(await q('select id from core.branches where tenant_id=$1',[T])).rows[0].id;
  await assert.rejects(q("insert into academy.course_runs(id,tenant_id,branch_id) values(gen_random_uuid(),$1,$2)",[U,branch]),/foreign key/);
  await q("select set_config('test.allowed','no',false)");
  await assert.rejects(action('preview_scheduling'),/forbidden/);
  await q("select set_config('test.allowed','yes',false)");
});

test('department membership and overnight shifts control new assignment without rewriting owners',async()=>{
  const branch=(await q('select id from core.branches where tenant_id=$1',[T])).rows[0].id;
  await action('save_staff_operations',{staffId:S,primaryDepartmentId:D,branchId:branch,extraDepartmentIds:[],shifts:[{isoDay:1,startsAt:'22:00',endsAt:'06:00'}]});
  const preview=await action('preview_scheduling');
  assert.equal(preview.withoutShift,0);
  await action('set_scheduling',{enabled:true,confirmed:true,expectedVersion:preview.version});
  const available=async at=>(await q('select private_app.staff_operationally_available_v1($1,$2,$3) yes',[T,S,at])).rows[0].yes;
  assert.equal(await available('2026-09-21T19:00:00Z'),true); // Monday22 tenant
  assert.equal(await available('2026-09-22T02:59:59Z'),true);
  assert.equal(await available('2026-09-22T03:00:00Z'),false);
  assert.equal(await available('2026-09-21T18:59:59Z'),false);
  assert.equal(await available('2026-09-22T19:00:00Z'),false);
  await action('record_absence',{staffId:S,startsAt:'2026-09-21T20:00:00Z',endsAt:'2026-09-22T03:00:00Z',reason:'إجازة اختبار'});
  assert.equal(await available('2026-09-21T21:00:00Z'),false);
  const absence=(await q('select id from people.staff_absences')).rows[0].id;
  await action('cancel_absence',{absenceId:absence});
  assert.equal(await available('2026-09-21T21:00:00Z'),true);
  assert.equal((await q('select count(*)::int n from core.operating_audit')).rows[0].n,5);
});

test('explicit timezone change synchronizes canonical tenant and accounting settings',async()=>{
  const snapshot=(await q("select public.v1_tenant_operating_snapshot('sandbox') result")).rows[0].result;
  const change={expectedVersion:snapshot.setup.version,name:'Sandbox',legalName:'Sandbox Academy',timezone:'Africa/Cairo',intakeSource:'manual'};
  await assert.rejects(action('save_setup',change),/confirmation_required/);
  const result=await action('save_setup',{...change,confirmTimezoneChange:true});
  assert.equal(result.tenant.timezone,'Africa/Cairo');
  assert.equal(result.finance.timezone,'Africa/Cairo');
});

test('new operating records inherit branch without rewriting history or verified money',async()=>{
  const branch=(await q('select id from core.branches where tenant_id=$1',[T])).rows[0].id;
  const run='10000000-0000-4000-8000-000000000071';
  const handoff='10000000-0000-4000-8000-000000000072';
  await q('insert into academy.course_runs(id,tenant_id) values($1,$2)',[run,T]);
  await q('insert into academy.registration_handoffs(id,tenant_id,course_run_id) values($1,$2,$3)',[handoff,T,run]);
  await q('insert into academy.enrollments(id,tenant_id,course_run_id) values(gen_random_uuid(),$1,$2)',[T,run]);
  await q("insert into accounting_core.payments(id,tenant_id,source_type,source_id,status) values(gen_random_uuid(),$1,'registration_handoff',$2,'verified')",[T,handoff]);
  for(const table of ['academy.course_runs','academy.registration_handoffs','academy.enrollments','accounting_core.payments'])
    assert.equal((await q(`select branch_id from ${table} where tenant_id=$1 order by id limit 1`,[T])).rows[0].branch_id,branch,table);
  await assert.rejects(q('update accounting_core.payments set branch_id=null where tenant_id=$1',[T]),/financial_branch_history_immutable/);
  // A settings change queues governed handoffs without reconciling while locked.
  await q('insert into academy.admission_governance_settings values($1,true)',[T]);
  await action('record_absence',{staffId:S,startsAt:'2026-09-23T10:00:00Z',endsAt:'2026-09-23T11:00:00Z',reason:'اختبار إعادة تقييم المسؤول'});
  assert.equal((await q('select handoff_id from academy.admission_governance_queue')).rows[0].handoff_id,handoff);
});

test('an unscheduled opportunity stays visible for planning without a fabricated appointment',async()=>{
  const contact='10000000-0000-4000-8000-000000000081';
  const opportunity='10000000-0000-4000-8000-000000000082';
  await q("insert into sales_core.contacts(id,tenant_id,full_name) values($1,$2,'عميل تخطيط')",[contact,T]);
  await q("insert into sales_core.opportunities(id,tenant_id,contact_id,title,status,created_at) values($1,$2,$3,'فرصة تخطيط','open','2026-09-21T10:00:00Z')",[opportunity,T,contact]);
  const snapshot=(await q("select public.v1_tenant_operating_snapshot('sandbox') result")).rows[0].result;
  assert.equal(snapshot.planningQueue.total,1);
  assert.equal(snapshot.planningQueue.items[0].id,opportunity);
  assert.equal((await q('select next_action_at from sales_core.opportunities where id=$1',[opportunity])).rows[0].next_action_at,null);
  assert.equal((await q('select count(*)::int n from work_core.tasks')).rows[0].n,0);
  await q("select set_config('test.team','no',false)");
  const restricted=(await q("select public.v1_tenant_operating_snapshot('sandbox') result")).rows[0].result;
  assert.deepEqual(restricted.planningQueue,{total:0,items:[]});
  await q("select set_config('test.team','yes',false)");
});
