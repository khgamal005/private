import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {sameOrigin,boundedText,controlPayload,validControlSnapshot,publicControlError} from '../lib/tenant-controls-http.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const sql=await read('supabase/migrations/20260907121051_tenant_manual_controls_v1.sql');
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002',R='10000000-0000-4000-8000-000000000003',U='20000000-0000-4000-8000-000000000001';
const all='platform.tenants.manage,platform.billing.manage,platform.tenants.delete';
async function setup(){
 const db=new PGlite();
 await db.exec(`create schema core;create schema catalog;create schema private_app;create schema platform;create schema extensions;create schema auth;
 create role anon;create role authenticated;create role service_role;
 create function extensions.digest(text,text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('fixture.user',true),'')::uuid$$;
 create function private_app.has_platform_permission(text) returns boolean language sql stable as $$select auth.uid() is not null and $1=any(string_to_array(current_setting('fixture.permissions',true),','))$$;
 create table core.tenants(id uuid primary key,slug text,name text,status text default 'active',updated_at timestamptz default now(),members int default 2,financial boolean default false);
 create table core.contacts(id uuid primary key default gen_random_uuid(),tenant_id uuid references core.tenants(id) on delete cascade,note text);
 create table catalog.plans(id uuid primary key default gen_random_uuid(),plan_key text,name_ar text,status text default 'active');
 create table catalog.independent_commercial_catalog_v1(id uuid primary key default gen_random_uuid(),kind text,plan_id uuid references catalog.plans(id),profile jsonb,published boolean default true,display_order int,monthly_amount_minor bigint,annual_amount_minor bigint);
 create table catalog.subscriptions(id uuid primary key default gen_random_uuid(),tenant_id uuid references core.tenants(id) on delete cascade,plan_id uuid references catalog.plans(id),status text,period_start timestamptz default now(),period_end timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
 create table catalog.independent_core_subscription_terms_v1(subscription_id uuid primary key references catalog.subscriptions(id),billing_interval text,quoted_amount_minor bigint default 0);
 create table catalog.core_transition_v1(tenant_id uuid primary key references core.tenants(id) on delete restrict,subscription_id uuid references catalog.subscriptions(id) on delete restrict);
 create table catalog.addons(tenant_id uuid references core.tenants(id) on delete cascade,state text);
 create table platform.tenant_deletion_protections(tenant_id uuid primary key references core.tenants(id) on delete restrict);
 create table platform.audit(tenant_id uuid,action text,context jsonb);
 create function private_app.is_reef_commerce_protected_v1(uuid) returns boolean language sql stable as $$select exists(select 1 from core.tenants where id=$1 and slug='reef-skills')$$;
 create function private_app.tenant_plan_usage_count(uuid,text) returns bigint language sql stable as $$select members from core.tenants where id=$1$$;
 create function private_app.current_plan_limit(uuid,text) returns jsonb language sql stable as $$select jsonb_build_object('limitValue',5)$$;
 create function private_app.write_audit(text,text,text,uuid,jsonb) returns void language sql as $$insert into platform.audit values($4,$1,$5)$$;
 create function public.v2_platform_set_tenant_status(uuid,text) returns boolean language plpgsql as $$begin update core.tenants set status=$2,updated_at=clock_timestamp() where id=$1;return true;end$$;
 -- The existing assignment implementation is covered by independent-commerce tests.
 -- This fixture models its contract to execute the NEW wrapper with real PostgreSQL.
 create function public.v5_platform_commerce_action(text,jsonb) returns jsonb language plpgsql as $$declare sid uuid;begin
 update catalog.subscriptions set status='cancelled' where tenant_id=($2->>'tenantId')::uuid and status in ('active','trialing','paused','past_due');
 insert into catalog.subscriptions(tenant_id,plan_id,status,period_end) values(($2->>'tenantId')::uuid,($2->>'planId')::uuid,'active',case when exists(select 1 from catalog.plans where id=($2->>'planId')::uuid and plan_key in ('full','core_free')) then null else now()+case $2->>'billingInterval' when 'year' then interval '1 year' else interval '1 month' end end) returning id into sid;
 insert into catalog.independent_core_subscription_terms_v1 values(sid,$2->>'billingInterval',0);return jsonb_build_object('id',sid);end$$;
 create function private_app.v1_tenant_deletion_preview_document_legacy_internal(p_tenant_id uuid) returns jsonb language plpgsql stable as $$declare t core.tenants%rowtype;blocks jsonb:='[]';begin
 select * into t from core.tenants where id=p_tenant_id;
 if private_app.is_reef_commerce_protected_v1(t.id) then blocks:=blocks||'[{"code":"protected_tenant"}]'::jsonb;end if;
 if t.financial then blocks:=blocks||'[{"code":"financial_records"}]'::jsonb;end if;
 if exists(select 1 from pg_constraint fk join pg_class c on c.oid=fk.conrelid join pg_namespace n on n.oid=c.relnamespace where fk.contype='f' and fk.confrelid='core.tenants'::regclass and fk.confdeltype in ('a','r') and n.nspname||'.'||c.relname not in ('platform.tenant_deletion_protections')) then blocks:=blocks||'[{"code":"unknown_database_dependency"}]'::jsonb;end if;
 return jsonb_build_object('counts','{}'::jsonb,'blockers',blocks,'canDelete',jsonb_array_length(blocks)=0,'previewDigest',encode(extensions.digest(to_jsonb(t)::text||blocks::text,'sha256'),'hex'),'confirmationPhrase','حذف '||t.slug);end$$;
 create function private_app.v1_tenant_deletion_preview_document(uuid) returns jsonb language sql stable as $$select private_app.v1_tenant_deletion_preview_document_legacy_internal($1)$$;
 create function public.v1_platform_tenant_delete(p_tenant_id uuid,p_preview_digest text,p_confirmation text,p_reason text,p_idempotency_key uuid) returns jsonb language plpgsql as $$declare v_tenant core.tenants%rowtype;v_preview jsonb;begin
 if not private_app.has_platform_permission('platform.tenants.delete') then raise exception 'forbidden';end if;
 select * into v_tenant from core.tenants where id=p_tenant_id for update;
 v_preview:=private_app.v1_tenant_deletion_preview_document(p_tenant_id);
 if v_preview->>'previewDigest'<>p_preview_digest then raise exception 'tenant_deletion_preview_stale';end if;
 if not (v_preview->>'canDelete')::boolean then raise exception 'tenant_deletion_blocked';end if;
 if p_confirmation is distinct from v_preview->>'confirmationPhrase' then raise exception 'tenant_deletion_confirmation_mismatch';end if;
 delete from core.tenants tenant where tenant.id=v_tenant.id;
 return jsonb_build_object('deleted',true);end$$;
 insert into core.tenants(id,slug,name) values('${A}','demo-a','منشأة اختبار أ'),('${B}','demo-b','منشأة اختبار ب'),('${R}','reef-skills','ريف الوهمية');
 insert into core.contacts(tenant_id,note) values('${A}','keep A'),('${B}','keep B'),('${R}','keep R');
 insert into catalog.addons values('${A}','active'),('${B}','active'),('${R}','active');
 insert into platform.tenant_deletion_protections values('${R}');
 insert into catalog.plans(plan_key,name_ar) values('core_free','المجانية'),('core_basic','الأساسية'),('core_professional','الاحترافية'),('core_diamond','الماسية'),('full','النسخة الكاملة');
 insert into catalog.independent_commercial_catalog_v1(kind,plan_id,profile,display_order,monthly_amount_minor,annual_amount_minor) select 'core',id,'{"limits":{"staff":5}}',row_number() over(order by plan_key),7900,79000 from catalog.plans where plan_key<>'full';
 insert into catalog.subscriptions(tenant_id,plan_id,status) select t.id,p.id,'active' from core.tenants t join catalog.plans p on p.plan_key=case when t.id='${R}' then 'full' else 'core_basic' end;
 insert into catalog.core_transition_v1 select tenant_id,id from catalog.subscriptions where tenant_id<>'${R}';
 insert into catalog.independent_core_subscription_terms_v1 select id,'month',0 from catalog.subscriptions where tenant_id<>'${R}';
 select set_config('fixture.user','${U}',false);select set_config('fixture.permissions','${all}',false);`);
 return db;
}
const snapshot=async(db,id=A)=>(await db.query('select public.v1_platform_tenant_controls_snapshot($1) r',[id])).rows[0].r;
const action=async(db,id,kind,payload)=>(await db.query('select public.v1_platform_tenant_controls_action($1,$2,$3) r',[id,kind,payload])).rows[0].r;
const preview=async(db,id)=>(await db.query('select private_app.v1_tenant_deletion_preview_document($1) r',[id])).rows[0].r;

test('real PostgreSQL manual-controls authorization, isolation, concurrency and reviewed purge cleanup',async t=>{
 const db=await setup();t.after(()=>db.close());
 const fingerprint=()=>db.query(`select jsonb_build_object('tenants',(select jsonb_agg(t order by id) from core.tenants t),'subscriptions',(select jsonb_agg(s order by id) from catalog.subscriptions s),'contacts',(select jsonb_agg(c order by id) from core.contacts c),'terms',(select jsonb_agg(x order by subscription_id) from catalog.independent_core_subscription_terms_v1 x),'transition',(select jsonb_agg(x order by tenant_id) from catalog.core_transition_v1 x)) x`);
 const before=(await fingerprint()).rows;await db.exec(sql);
 await t.test('installing the migration changes no tenant, subscription or business row',async()=>assert.deepEqual((await fingerprint()).rows,before));
 await t.test('privileged view contains four editions plus administrative FULL',async()=>{const s=await snapshot(db);assert.equal(s.plans.length,5);assert.equal(s.plans.filter(p=>p.internalOnly).length,1);assert.equal(validControlSnapshot(s,A),true);});
 await t.test('anonymous and tenant-only identities cannot read or write management data',async()=>{
  await db.exec("select set_config('fixture.user','',false)");await assert.rejects(snapshot(db),/authentication_required/);
  await db.exec(`select set_config('fixture.user','${U}',false);select set_config('fixture.permissions','',false)`);
  await assert.rejects(snapshot(db,B),/forbidden/);await assert.rejects(action(db,A,'set_status',{}),/forbidden/);
  await db.exec(`select set_config('fixture.permissions','${all}',false)`);
 });
 await t.test('tenant-management and billing grants are enforced separately',async()=>{
  await db.exec("select set_config('fixture.permissions','platform.tenants.manage',false)");
  const s=await snapshot(db);assert.equal(s.actions.canSetPlan,false);assert.equal(s.actions.canDelete,false);assert.equal(s.plans.length,0);
  await assert.rejects(action(db,A,'set_plan',{}),/forbidden/);
  await db.exec("select set_config('fixture.permissions','platform.billing.manage',false)");await assert.rejects(action(db,A,'set_status',{}),/forbidden/);
  await db.exec(`select set_config('fixture.permissions','${all}',false)`);
 });
 await t.test('stale, invalid and unconfirmed changes fail without mutation',async()=>{
  const s=await snapshot(db);await assert.rejects(action(db,A,'set_status',{expectedVersion:'0'.repeat(64),status:'suspended',confirmation:'إيقاف demo-a'}),/version_conflict/);
  await assert.rejects(action(db,A,'set_status',{expectedVersion:s.version,status:'suspended',confirmation:'wrong'}),/confirmation_required/);
  await assert.rejects(action(db,A,'set_status',{expectedVersion:s.version,status:null}),/invalid_status/);
  assert.equal((await snapshot(db)).tenant.status,'active');
 });
 await t.test('suspension and reactivation preserve the subscription and other tenants',async()=>{
  const s=await snapshot(db),other=await snapshot(db,B),sub=s.subscription;
  const stopped=await action(db,A,'set_status',{expectedVersion:s.version,status:'suspended',confirmation:'إيقاف demo-a'});
  assert.equal(stopped.tenant.status,'suspended');assert.deepEqual(stopped.subscription,sub);assert.deepEqual(await snapshot(db,B),other);
  await assert.rejects(action(db,A,'set_status',{expectedVersion:s.version,status:'active',confirmation:'تفعيل demo-a'}),/version_conflict/);
  const restored=await action(db,A,'set_status',{expectedVersion:stopped.version,status:'active',confirmation:'تفعيل demo-a'});assert.equal(restored.tenant.status,'active');
 });
 await t.test('plan assignment leaves suspended state, all contacts and add-ons untouched',async()=>{
  let s=await snapshot(db);s=await action(db,A,'set_status',{expectedVersion:s.version,status:'suspended',confirmation:'إيقاف demo-a'});
  const content=await db.query('select jsonb_agg(c order by id) x from core.contacts c');const addons=await db.query('select jsonb_agg(a order by tenant_id) x from catalog.addons a');
  const target=s.plans.find(p=>p.key==='core_professional');
  const changed=await action(db,A,'set_plan',{expectedVersion:s.version,planId:target.id,billingInterval:'year',confirmation:'تغيير باقة demo-a'});
  assert.equal(changed.subscription.planKey,'core_professional');assert.equal(changed.subscription.billingInterval,'year');assert.equal(changed.tenant.status,'suspended');assert.equal(changed.paymentCollected,false);
  assert.deepEqual((await db.query('select jsonb_agg(c order by id) x from core.contacts c')).rows,content.rows);assert.deepEqual((await db.query('select jsonb_agg(a order by tenant_id) x from catalog.addons a')).rows,addons.rows);
 });
 await t.test('FULL remains assignable to non-Reef with no end date',async()=>{
  const s=await snapshot(db);const result=await action(db,A,'set_plan',{expectedVersion:s.version,planId:s.plans.find(p=>p.key==='full').id,billingInterval:'month',confirmation:'تغيير باقة demo-a'});
  assert.equal(result.subscription.planKey,'full');assert.equal(result.subscription.periodEnd,null);
 });
 await t.test('Reef cannot be changed even by an otherwise authorized platform owner',async()=>{
  const s=await snapshot(db,R);assert.deepEqual(s.actions,{canSetPlan:false,canSetStatus:false,canDelete:false});
  for(const a of ['set_status','set_plan'])await assert.rejects(action(db,R,a,{expectedVersion:s.version}),/reef_contract_protected/);
  assert.deepEqual(await snapshot(db,R),s);assert.equal((await preview(db,R)).canDelete,false);
 });
 await t.test('unknown dependencies and real financial blockers still fail closed',async()=>{
  await db.exec(`update core.tenants set financial=true where id='${B}'`);let p=await preview(db,B);assert.equal(p.canDelete,false);assert(p.blockers.some(x=>x.code==='financial_records'));
  await db.exec(`update core.tenants set financial=false where id='${B}';create table core.unknown(id uuid references core.tenants(id) on delete restrict)`);
  p=await preview(db,B);assert(p.blockers.some(x=>x.code==='unknown_database_dependency'));await db.exec('drop table core.unknown');
 });
 await t.test('pricing terms participate in deletion-preview freshness',async()=>{
  const p=await preview(db,B);assert.equal(p.canDelete,true);assert.equal(p.counts.coreSubscriptionTerms,1);
  await db.exec(`update catalog.independent_core_subscription_terms_v1 set quoted_amount_minor=100 where subscription_id in(select id from catalog.subscriptions where tenant_id='${B}')`);
  await assert.rejects(db.query('select public.v1_platform_tenant_delete($1,$2,$3,$4,$5)',[B,p.previewDigest,'حذف demo-b','fixture reason',U]),/preview_stale/);
 });
 await t.test('unconfirmed delete retains transition and terms; confirmed synthetic purge cleans only its tenant',async()=>{
  const p=await preview(db,B);await assert.rejects(db.query('select public.v1_platform_tenant_delete($1,$2,$3,$4,$5)',[B,p.previewDigest,'wrong','fixture reason',U]),/confirmation_mismatch/);
  assert.equal((await preview(db,B)).counts.coreTransitionRecords,1);
  const reef=await snapshot(db,R);const other=await snapshot(db,A);
  await db.query('select public.v1_platform_tenant_delete($1,$2,$3,$4,$5)',[B,p.previewDigest,'حذف demo-b','fixture reason',U]);
  assert.equal((await db.query('select count(*)::int n from core.tenants where id=$1',[B])).rows[0].n,0);
  assert.deepEqual(await snapshot(db,R),reef);assert.deepEqual(await snapshot(db,A),other);
 });
 await t.test('new public endpoints are inaccessible to anon and expose no private helper',async()=>{
  const r=await db.query("select has_function_privilege('anon','public.v1_platform_tenant_controls_snapshot(uuid)','execute') read,has_function_privilege('anon','public.v1_platform_tenant_controls_action(uuid,text,jsonb)','execute') write,has_function_privilege('authenticated','private_app.v1_tenant_deletion_preview_document(uuid)','execute') private");
  assert.deepEqual(r.rows[0],{read:false,write:false,private:false});
 });
});

test('HTTP control boundary rejects foreign origins, bad JSON types and excessive streamed bytes',async()=>{
 const req=(origin,site='same-origin')=>new Request('https://odeir.com/api/platform/tenant-controls',{method:'POST',headers:{origin,'sec-fetch-site':site}});
 assert.equal(sameOrigin(req('https://odeir.com')),true);assert.equal(sameOrigin(req('https://evil.invalid')),false);assert.equal(sameOrigin(req('https://odeir.com','cross-site')),false);assert.equal(sameOrigin(req('http://odeir.com')),false);
 const body={tenantId:A,action:'set_plan',payload:{expectedVersion:'a'.repeat(64),confirmation:'تغيير باقة demo-a',planId:B,billingInterval:'month',admin:true}};
 assert.equal(controlPayload(body).p_payload.admin,undefined);
 for(const invalid of [{...body,tenantId:[A]},{...body,action:'delete'},{...body,payload:{...body.payload,planId:[B]}},{...body,payload:{...body.payload,expectedVersion:['a'.repeat(64)]}},{...body,payload:{...body.payload,billingInterval:'lifetime'}}])assert.equal(controlPayload(invalid),null);
 await assert.rejects(boundedText(new Response('x'.repeat(8193)),8192),/request_too_large/);
 assert.equal(await boundedText(new Response('مرحبا'),100),'مرحبا');
 assert.equal(validControlSnapshot({tenant:{id:1}},A),false);assert.equal(publicControlError('secret_database_error')[0],503);assert(!publicControlError('secret_database_error')[1].includes('secret'));
});

test('management UI no longer saves selects immediately and retains preview-first deletion',async()=>{
 const source=await read('components/platform-tenants.js');assert(source.includes('PlatformTenantControls'));assert(source.includes('إدارة المنشأة'));
 assert.doesNotMatch(source,/onChange=\{event=>updateStatus|onChange=\{event=>updatePlan/);
 const panel=await read('components/platform-tenant-controls.js');assert(panel.includes('expectedVersion:data.version'));assert(panel.includes('فتح معاينة الحذف'));assert(panel.includes('inFlight.current=true'));
 const purge=sql.slice(sql.indexOf('-- Pricing transition metadata'));assert(!purge.includes('disable trigger'));assert(!purge.includes('drop constraint'));assert(purge.includes('subscription.tenant_id=v_tenant.id'));
});
