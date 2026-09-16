import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const migration=await readFile(new URL('../supabase/migrations/20260916192049_google_kit_entitlement_activation_v1.sql',import.meta.url),'utf8');
const T='10000000-0000-4000-8000-000000000001',R='10000000-0000-4000-8000-000000000002',D='10000000-0000-4000-8000-000000000003',N='10000000-0000-4000-8000-000000000004';
const G='20000000-0000-4000-8000-000000000001',M='20000000-0000-4000-8000-000000000002';
test('Google activation follows entitlement, is idempotent, and preserves protected/disabled tenants',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema core;create schema catalog;create schema google_ads;create schema private_app;create schema audit_log;
 create table core.tenants(id uuid primary key,slug text unique,status text default 'active');
 create table catalog.addon_products(id uuid primary key,product_key text);
 create table catalog.tenant_addon_subscriptions(tenant_id uuid,product_id uuid,status text,period_start timestamptz,period_end timestamptz,trial_start timestamptz,trial_end timestamptz);
 create table google_ads.rollouts(tenant_id uuid primary key,enabled boolean default false,protected_tenant_approved boolean default false,reporting_only boolean default false);
 create table audit_log.events(tenant_id uuid,actor_subject_id uuid,action text,resource_type text,resource_id text,context jsonb);
 create function private_app.current_subject_id() returns uuid language sql as $$select null::uuid$$;
 create function private_app.tenant_addon_enabled(t uuid,f text) returns boolean language sql stable as $$select exists(select 1 from catalog.tenant_addon_subscriptions s join catalog.addon_products p on p.id=s.product_id where tenant_id=t and p.product_key='google_ads_connect' and f='addon.integrations.google_ads_connect' and s.status='active' and (period_end is null or period_end>now()))$$;
 create function public.v2_tenant_marketplace_action(p_slug text,p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$begin if current_setting('fixture.authorized',true) is distinct from 'yes' then raise exception 'forbidden';end if;return jsonb_build_object('already_active',true);end$$;
 insert into core.tenants(id,slug) values('${T}','marktone'),('${R}','reef-skills'),('${D}','disabled'),('${N}','new-tenant');
 insert into catalog.addon_products values('${G}','google_ads_connect'),('${M}','social_connect');
 insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status) values('${T}','${G}','active'),('${R}','${G}','active'),('${D}','${G}','active');
 insert into google_ads.rollouts(tenant_id,enabled) values('${D}',false);`);
 await db.exec(migration);
 assert.deepEqual((await db.query('select tenant_id,enabled from google_ads.rollouts order by tenant_id')).rows,[{tenant_id:T,enabled:true},{tenant_id:D,enabled:false}]);
 assert.equal((await db.query('select count(*)::int n from audit_log.events')).rows[0].n,1);
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'google_ads.enable_entitled_tenant_v1(uuid,text)','EXECUTE') v",[role])).rows[0].v,false);
 await assert.rejects(db.query("select public.v2_tenant_marketplace_action('new-tenant','create_order','{\"itemType\":\"addon\",\"productKey\":\"google_ads_connect\"}')"),/forbidden/);
 await db.exec(`insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status) values('${N}','${M}','active'),('${N}','${G}','pending');`);
 assert.equal((await db.query('select count(*)::int n from google_ads.rollouts')).rows[0].n,2);
 await db.exec(`update catalog.tenant_addon_subscriptions set status='active' where tenant_id='${N}' and product_id='${G}';`);
 assert.equal((await db.query('select enabled from google_ads.rollouts where tenant_id=$1',[N])).rows[0].enabled,true);
 await db.exec(`update catalog.tenant_addon_subscriptions set status='active';select set_config('fixture.authorized','yes',false);`);
 await db.query("select public.v2_tenant_marketplace_action('marktone','create_order','{\"itemType\":\"addon\",\"productKey\":\"google_ads_connect\"}')");
 assert.equal((await db.query('select count(*)::int n from audit_log.events')).rows[0].n,2);
 assert.equal((await db.query('select enabled from google_ads.rollouts where tenant_id=$1',[D])).rows[0].enabled,false);
 assert.equal((await db.query('select count(*)::int n from google_ads.rollouts where tenant_id=$1',[R])).rows[0].n,0);
 // Removing entitlement continues to close runtime access through the existing guard.
 await db.exec(`update catalog.tenant_addon_subscriptions set status='cancelled' where tenant_id='${N}' and product_id='${G}';`);
 assert.equal((await db.query("select private_app.tenant_addon_enabled($1,'addon.integrations.google_ads_connect') allowed",[N])).rows[0].allowed,false);
 // Explicit reactivation in the store can repair an older missing runtime row.
 await db.exec(`delete from google_ads.rollouts where tenant_id='${T}';`);
 await db.query("select public.v2_tenant_marketplace_action('marktone','create_order','{\"itemType\":\"addon\",\"productKey\":\"google_ads_connect\"}')");
 assert.equal((await db.query('select enabled from google_ads.rollouts where tenant_id=$1',[T])).rows[0].enabled,true);
 }finally{await db.close();}
});
