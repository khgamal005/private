create schema platform;
create table platform.tenant_deletion_protections(tenant_id uuid primary key,protection_key text unique);
create table core.fixture_staff(tenant_id uuid, id uuid default gen_random_uuid());
alter table catalog.tenant_feature_overrides add column reason text;
create function private_app.tenant_plan_usage_count(uuid,text) returns bigint language sql stable as $$select count(*) from core.fixture_staff where tenant_id=$1$$;
create function private_app.current_plan_limit(p_tenant_id uuid,p_limit_key text) returns jsonb language sql stable as $$
 select coalesce((select jsonb_build_object('planKey',p.plan_key,'limitValue',l.limit_value,'enforceable',true,'enforcement','hard')
 from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id left join catalog.plan_limits l on l.plan_id=p.id and l.limit_key=p_limit_key
 where s.tenant_id=p_tenant_id and s.status in ('trialing','active','past_due','paused') order by s.created_at desc limit 1),'{}')
$$;
