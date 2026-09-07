import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {amountMinor,planEditorPayload,validPlanEditorItem} from '../lib/core-plan-editor.mjs';
const sql=await readFile(new URL('../supabase/migrations/20260907130214_core_plan_editor_v1.sql',import.meta.url),'utf8');
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002',R='10000000-0000-4000-8000-000000000003';
async function setup(){
 const db=new PGlite({extensions:{pgcrypto}});
 await db.exec(`create schema catalog;create schema private_app;create schema core;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create role anon;create role authenticated;create role service_role;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('fixture.user',true),'')::uuid$$;
 create function private_app.current_subject_id() returns uuid language sql as $$select auth.uid()$$;
 create function private_app.has_platform_permission(text) returns boolean language sql as $$select coalesce(current_setting('fixture.admin',true),'')='true'$$;
 create function private_app.is_reef_commerce_protected_v1(uuid) returns boolean language sql as $$select $1='${R}'::uuid$$;
 create table core.tenants(id uuid primary key,status text default 'active');insert into core.tenants(id) values('${A}'),('${B}'),('${R}');
 create table core.contacts(tenant_id uuid,note text);insert into core.contacts values('${A}','KEEP'),('${R}','KEEP REEF');
 create table catalog.plans(id uuid primary key default gen_random_uuid(),plan_key text unique,name_ar text,description text,amount_minor bigint default 0,status text default 'active',is_public boolean default true,display_order int default 10,updated_at timestamptz default now());
 create table catalog.features(id uuid primary key default gen_random_uuid(),feature_key text);
 create table catalog.plan_features(plan_id uuid,feature_id uuid,value jsonb);
 create table catalog.plan_limits(plan_id uuid,limit_key text,limit_value bigint);
 create table catalog.subscriptions(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_id uuid references catalog.plans(id),status text default 'active',period_end timestamptz,created_at timestamptz default now());
 create table catalog.terms(subscription_id uuid,quoted_amount_minor bigint);create table catalog.addons(tenant_id uuid,status text);
 create table catalog.independent_commercial_catalog_v1(id uuid primary key default gen_random_uuid(),kind text,product_key text unique,plan_id uuid references catalog.plans(id),name_ar text,description_ar text,monthly_amount_minor bigint,annual_amount_minor bigint,profile jsonb,published boolean default true,display_order int default 10, constraint independent_commercial_catalog_v1_check check(annual_amount_minor=monthly_amount_minor*10));
 create table core.events(action text,context jsonb);
 create function private_app.write_audit(text,text,text,uuid,jsonb) returns void language sql as $$insert into core.events values($1,$5)$$;
 create function private_app.current_plan_limit(uuid,text) returns jsonb language sql as $$select jsonb_build_object('limitValue',case when $1='${R}'::uuid then null else greatest(coalesce(l.limit_value,5),case when $1='${A}'::uuid then 7 else 0 end) end,'enforceable',true,'planKey',p.plan_key) from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id left join catalog.plan_limits l on l.plan_id=p.id and l.limit_key=$2 where s.tenant_id=$1 and s.status='active' order by s.created_at desc,s.id limit 1$$;
 create function public.v5_platform_commerce_action(p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql as $$declare sid uuid;begin
 update catalog.subscriptions set status='cancelled' where tenant_id=(p_payload->>'tenantId')::uuid;
 insert into catalog.subscriptions(tenant_id,plan_id) values((p_payload->>'tenantId')::uuid,(p_payload->>'planId')::uuid) returning id into sid;return jsonb_build_object('id',sid);end$$;
 create function public.v1_platform_tenant_controls_snapshot(uuid) returns jsonb language plpgsql as $$declare t record;sub jsonb;members int;plans jsonb;begin
 select 1 id,'x' slug,'x' name,'active' status,now() updated_at into t;return jsonb_build_array(t.id,t.slug,t.name,t.status,t.updated_at,sub,members);end$$;
 insert into catalog.plans(plan_key,name_ar) values('core_free','المجانية'),('core_basic','الأساسية'),('core_professional','الاحترافية'),('core_diamond','الماسية'),('full','النسخة الكاملة');
 insert into catalog.features(feature_key) values('limit.users');
 insert into catalog.plan_features select p.id,f.id,'5'::jsonb from catalog.plans p cross join catalog.features f;
 insert into catalog.plan_limits select id,'max_employees',5 from catalog.plans;
 insert into catalog.independent_commercial_catalog_v1(kind,product_key,plan_id,name_ar,description_ar,monthly_amount_minor,annual_amount_minor,profile)
 select 'core',plan_key,id,name_ar,'وصف الباقة التجريبية',case when plan_key='core_free' then 0 else 7900 end,case when plan_key='core_free' then 0 else 79000 end,'{"limits":{"staff":5},"addonsIncluded":false}' from catalog.plans where plan_key<>'full';
 insert into catalog.independent_commercial_catalog_v1(kind,product_key,name_ar,monthly_amount_minor,annual_amount_minor,profile) values('addon','whatsapp','واتساب',3900,39000,'{}');
 insert into catalog.subscriptions(tenant_id,plan_id) select t.id,p.id from core.tenants t join catalog.plans p on p.plan_key=case when t.id='${R}' then 'full' else 'core_basic' end;
 insert into catalog.terms select id,7900 from catalog.subscriptions;
 insert into catalog.addons select id,'active' from core.tenants;
 select set_config('fixture.user','${A}',false),set_config('fixture.admin','true',false);`);
 return db;
}
const snapshot=async db=>(await db.query('select public.v1_platform_core_plans_editor_snapshot() r')).rows[0].r;
const update=async(db,p,extra={})=>(await db.query('select public.v1_platform_core_plan_update($1,$2) r',[p.id,{expectedVersion:p.version,confirmed:true,nameAr:p.nameAr,description:p.description,monthlyAmountMinor:9950,annualAmountMinor:84575,staffLimit:8,displayOrder:10,published:true,reason:'اختبار التعديل الآمن',...extra}])).rows[0].r;
const cap=async(db,id)=>(await db.query("select private_app.current_plan_limit($1,'max_employees') r",[id])).rows[0].r.limitValue;
const stamp=async db=>(await db.query(`select jsonb_build_object('tenants',(select jsonb_agg(t order by id) from core.tenants t),'subs',(select jsonb_agg(s order by id) from catalog.subscriptions s),'contacts',(select jsonb_agg(c order by tenant_id) from core.contacts c),'terms',(select jsonb_agg(t order by subscription_id) from catalog.terms t),'addons',(select jsonb_agg(a order by tenant_id) from catalog.addons a),'full',(select to_jsonb(p) from catalog.plans p where plan_key='full')) r`)).rows[0].r;
test('minor currency parser and strict editable payload',()=>{
 assert.equal(amountMinor('99.50'),9950);assert.equal(amountMinor('٩٩٫٥٠'),9950);assert.equal(amountMinor('1.001'),null);
 assert.equal(amountMinor('-1'),null);assert.equal(amountMinor('1e2'),null);assert.equal(planEditorPayload({planId:R,payload:{}}),null);
 assert.equal(planEditorPayload({planId:R,payload:{expectedVersion:'f'.repeat(64),confirmed:true,published:true,nameAr:'باقة',description:'وصف تجريبي',reason:'اختبار',monthlyAmountMinor:1.1,annualAmountMinor:10,staffLimit:1,displayOrder:1}}),null);
});
test('Postgres plan editor preserves contract prices, seat rights and Reef while editing future offers',async t=>{
 const db=await setup();t.after(()=>db.close());const original=await stamp(db);await db.exec(sql);
 await t.test('install creates only separate metadata; no tenant or existing contract mutation',async()=>assert.deepEqual(await stamp(db),original));
 let plans=(await snapshot(db)).plans,basic=plans.find(p=>p.key==='core_basic');
 await t.test('four plans including hidden offers plus read-only full; authoritative data validates',async()=>{assert.equal(plans.length,4);assert.equal(validPlanEditorItem(basic,basic.id),true);assert.equal((await snapshot(db)).legacyPlans[0].readOnly,true);});
 await t.test('unconfirmed and stale edits rejected',async()=>{await assert.rejects(update(db,basic,{confirmed:false}),/payload_invalid/);await assert.rejects(update(db,basic,{expectedVersion:'0'.repeat(64)}),/version_conflict/);});
 await t.test('anonymous, tenant users and protected FULL cannot edit',async()=>{
  await db.exec("select set_config('fixture.user','',false)");await assert.rejects(snapshot(db),/authentication_required/);
  await db.exec(`select set_config('fixture.user','${A}',false),set_config('fixture.admin','false',false)`);await assert.rejects(update(db,basic),/forbidden/);
  await db.exec("select set_config('fixture.admin','true',false)");await assert.rejects(update(db,(await snapshot(db)).legacyPlans[0]),/legacy_plan_contract_protected/);
 });
 await t.test('annual independently editable to halalas, old prices/seats remain unchanged',async()=>{
  const saved=await update(db,basic);assert.equal(saved.monthlyAmountMinor,9950);assert.equal(saved.annualAmountMinor,84575);assert.equal(saved.commercialProfile.limits.staff,8);assert.equal(saved.history.length,1);
  assert.deepEqual(await stamp(db),original);assert.equal(await cap(db,A),7);assert.equal(await cap(db,B),5);assert.equal(await cap(db,R),null);
  assert.equal((await db.query('select count(*)::int n from catalog.core_contract_capacity_v1')).rows[0].n,2);
  await assert.rejects(update(db,basic),/version_conflict/);basic=saved;
 });
 await t.test('new explicit assignment gets edited seats; decreasing the offer does not remove existing rights',async()=>{
  await db.query("select public.v5_platform_commerce_action('set_subscription',$1)",[{tenantId:B,planId:basic.id}]);assert.equal(await cap(db,B),8);
  basic=await update(db,basic,{staffLimit:2});assert.equal(await cap(db,B),8);assert.equal(await cap(db,A),7);
 });
 await t.test('hiding a plan affects its catalog offer only and remains editable',async()=>{basic=await update(db,basic,{published:false});assert.equal(basic.published,false);assert.equal((await snapshot(db)).plans.length,4);assert.equal(await cap(db,B),8);});
 await t.test('free cannot be made paid or unavailable',async()=>{const free=(await snapshot(db)).plans.find(p=>p.key==='core_free');await assert.rejects(update(db,free),/free_plan_must_remain_free/);await assert.rejects(update(db,free,{monthlyAmountMinor:0,annualAmountMinor:0,published:false}),/free_plan_must_remain_free/);});
 await t.test('add-on annual policy unchanged and not editable through core interface',async()=>{const a=(await db.query("select * from catalog.independent_commercial_catalog_v1 where kind='addon'")).rows[0];assert.equal(a.annual_amount_minor,39000);await assert.rejects(db.exec("update catalog.independent_commercial_catalog_v1 set annual_amount_minor=5 where kind='addon'"),/check constraint/);});
 await t.test('private journals and capacity snapshots unavailable to authenticated direct access',async()=>{await db.exec('set role authenticated');await assert.rejects(db.query('select * from catalog.core_contract_capacity_v1'),/permission denied/);await assert.rejects(db.query('select * from catalog.core_plan_revisions_v1'),/permission denied/);await db.exec('reset role');});
});
