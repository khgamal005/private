import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {mergePlatformTenantsSnapshot} from '../lib/platform-tenants-snapshot.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration=await read('../supabase/migrations/20260922141649_snapshot_read_load_fix.sql');
const before=await read('./fixtures/snapshot-read-load/v3_platform_control_snapshot-before.sql');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

async function fixture(){
  const db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private_app; create schema core; create schema work_core; create schema catalog;
    create table core.tenants(id uuid primary key,tenant_key text,slug text,name text,legal_name text,status text,timezone text,created_at timestamptz);
    create table work_core.tasks(id uuid primary key,tenant_id uuid,status text,due_at timestamptz,contact_id uuid,metadata jsonb);
    create table catalog.plans(id uuid primary key,plan_key text,name_ar text,name_en text,amount_minor bigint,currency text,interval text,status text,created_at timestamptz);
    create table catalog.subscriptions(tenant_id uuid,plan_id uuid,status text);
    create table catalog.independent_commercial_catalog_v1(kind text,plan_id uuid,published boolean,display_order integer);
    create function private_app.has_platform_permission(permission text) returns boolean language sql stable as $$
      select permission=any(string_to_array(coalesce(current_setting('test.permissions',true),''),','));
    $$;
    create function private_app.customer_followup_uses_day_policy_v1(p_contact_id uuid,p_source text)
    returns boolean language sql immutable set search_path='' as $$
      select p_contact_id is not null or coalesce(p_source,'') in
      ('lead_assignment','opportunity_next_action','activity_next_action','lead_next_action','sales_followup');
    $$;
    revoke all on function private_app.customer_followup_uses_day_policy_v1(uuid,text) from public,anon,authenticated;
    create function public.v2_platform_control_snapshot_v2() returns jsonb language plpgsql stable security definer set search_path='' as $$
    begin
      if not private_app.has_platform_permission('platform.control.read') then raise exception 'forbidden'; end if;
      return jsonb_build_object('summary',jsonb_build_object('untouched',42),'other','preserved','tenants',
        coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'overdueTasks',999) order by created_at desc)
        from core.tenants where slug<>'hidden' and private_app.has_platform_permission('platform.tenants.manage')),'[]'));
    end $$;
    create function public.v2_platform_provisioning_snapshot_v2() returns jsonb language plpgsql stable security definer set search_path='' as $$
    begin
      if not private_app.has_platform_permission('platform.tenants.manage') then raise exception 'forbidden'; end if;
      return jsonb_build_object('pendingInvitations',3,'tenants',
        (select jsonb_agg(jsonb_build_object('tenantId',id,'memberCount',7,'ownerName','Fixture Owner','ownerEmail','owner@example.test','ownerStatus','linked','domain','academy.example.test','domainStatus','active')) from core.tenants));
    end $$;
    select set_config('test.permissions','platform.control.read,platform.tenants.manage,platform.billing.manage',false);
  `);
  const zones=['Asia/Riyadh','Africa/Cairo','America/New_York','Invalid/Zone','','UTC'];
  for(let i=0;i<zones.length;i++){
    const tenant=id(i+1);
    await db.query(`insert into core.tenants values ($1,$2,$3,$4,$4,'active',$5,now()-($6::text||' days')::interval)`,
      [tenant,`T${i}`,i===5?'hidden':`fixture-${i}`,`Fixture ${i}`,zones[i],i]);
    const tz=zones[i]==='Invalid/Zone'||!zones[i]?'UTC':zones[i];
    // Customer followups use the local day; manual tasks use the exact due time.
    for(let j=0;j<6;j++)await db.query(`insert into work_core.tasks values ($1,$2,$3,
      case $4::int when 0 then ((now() at time zone $5)::date::timestamp at time zone $5)-interval '1 second'
      when 1 then ((now() at time zone $5)::date::timestamp at time zone $5)
      when 2 then now()-interval '1 hour' when 3 then now()-interval '2 days'
      when 4 then null else now()+interval '2 days' end,$6,$7)`,
      [id(100+i*10+j),tenant,j===3?'cancelled':'todo',j,tz,j<2?id(900):null,JSON.stringify({source:j<2?'sales_followup':'manual'})]);
  }
  for(const [n,key,amount] of [[201,'standard',100],[202,'full',200],[203,'legacy',300],[204,'draft',400]]){
    await db.query(`insert into catalog.plans values ($1,$2,$2,$2,$3,'SAR','month','active',now())`,[id(n),key,amount]);
  }
  await db.query(`insert into catalog.independent_commercial_catalog_v1 values ('core',$1,true,1),('core',$2,false,2)`,[id(201),id(204)]);
  await db.query(`insert into catalog.subscriptions values ($1,$2,'active')`,[id(1),id(201)]);
  return db;
}

async function fingerprint(db){
  return (await db.query(`select md5((select jsonb_agg(to_jsonb(t) order by id)::text from core.tenants t)||
    (select jsonb_agg(to_jsonb(t) order by id)::text from work_core.tasks t)) hash`)).rows[0].hash;
}

test('SQL migration preserves overdue counts, ordering, redaction and all records',async()=>{
  const db=await fixture();
  try{
    await db.exec(before);
    const old=(await db.query('select public.v3_platform_control_snapshot() data')).rows[0].data;
    const hash=await fingerprint(db);
    await db.exec(migration);
    const current=(await db.query('select public.v3_platform_control_snapshot() data')).rows[0].data;
    assert.deepEqual(current,old);
    assert.equal(current.tenants.length,5);
    assert.ok(current.tenants.every(t=>t.overdueTasks===2));
    assert.equal(await fingerprint(db),hash);
    await db.exec(`select set_config('test.permissions','platform.control.read',false)`);
    const limited=(await db.query('select public.v3_platform_control_snapshot() data')).rows[0].data;
    assert.deepEqual(limited.tenants,[]);
    assert.equal(limited.summary.untouched,42);
    // Forward migration is safely repeatable and does not rewrite records.
    await db.exec(migration);
    assert.equal(await fingerprint(db),hash);
  }finally{await db.close();}
});

test('tenant administration preserves owner/domain/member/plan choices and requires both permissions',async()=>{
  const db=await fixture();
  try{
    await db.exec(migration);
    const data=(await db.query('select public.v1_platform_tenants_snapshot() data')).rows[0].data;
    assert.equal(data.pendingInvitations,3);
    assert.deepEqual(data.plans.map(p=>p.key),['standard','full']);
    assert.equal(data.tenants[0].employees,7);
    assert.equal(data.tenants[0].ownerEmail,'owner@example.test');
    assert.equal(data.tenants[0].domain,'academy.example.test');
    assert.equal(data.tenants[0].planKey,'standard');
    assert.equal('tasks' in data,false);
    assert.equal('commerce' in data,false);
    await db.exec(`select set_config('test.permissions','platform.control.read,platform.tenants.manage',false)`);
    const limited=(await db.query('select public.v1_platform_tenants_snapshot() data')).rows[0].data;
    assert.deepEqual(limited.plans.map(p=>p.key),['standard','full','legacy','draft']);
    for(const permissions of ['', 'platform.control.read','platform.tenants.manage']){
      await db.query(`select set_config('test.permissions',$1,false)`,[permissions]);
      await assert.rejects(db.query('select public.v1_platform_tenants_snapshot()'),/forbidden/);
    }
    const grants=(await db.query(`select
      has_function_privilege('anon','public.v1_platform_tenants_snapshot()','execute') anonymous,
      has_function_privilege('authenticated','public.v1_platform_tenants_snapshot()','execute') authenticated,
      has_function_privilege('authenticated','private_app.customer_followup_uses_day_policy_v1(uuid,text)','execute') helper`)).rows[0];
    assert.deepEqual(grants,{anonymous:false,authenticated:true,helper:false});
  }finally{await db.close();}
});

test('argument-only followup policy inlines without changing classifications',async()=>{
  const db=await fixture();
  try{
    const sql=`select private_app.customer_followup_uses_day_policy_v1(contact_id,source) result
      from (values (null::uuid,null::text),(null,'manual'),(null,'sales_followup'),('${id(9)}'::uuid,'manual')) x(contact_id,source)`;
    const old=(await db.query(sql)).rows;
    await db.exec(migration);
    assert.deepEqual((await db.query(sql)).rows,old);
    const plan=(await db.query(`explain select * from work_core.tasks where private_app.customer_followup_uses_day_policy_v1(contact_id,metadata->>'source')`)).rows;
    assert.doesNotMatch(JSON.stringify(plan),/customer_followup_uses_day_policy_v1/);
  }finally{await db.close();}
});

test('optional manager outage never invents an off state or changes core tenant data',()=>{
  const base={pendingInvitations:3,tenants:[{id:'a',name:'A',employees:7},{id:'b',name:'B',employees:2}],plans:[{key:'free'}]};
  const result=mergePlatformTenantsSnapshot(base,null);
  assert.equal(result.odeiryManager.available,false);
  assert.equal(result.odeiryManager.canManage,false);
  assert.equal(result.odeiryManager.globalEnabled,null);
  assert.equal(result.tenants[0].odeiryManager.enabled,null);
  assert.equal(result.tenants[0].employees,7);
  assert.equal(base.tenants[0].odeiryManager,undefined);
  const available=mergePlatformTenantsSnapshot(base,{globalEnabled:true,canManage:true,tenants:[{tenantId:'b',enabled:true,effectiveEnabled:true,version:8}]});
  assert.equal(available.tenants[0].odeiryManager.available,false);
  assert.equal(available.tenants[1].odeiryManager.version,8);
});
