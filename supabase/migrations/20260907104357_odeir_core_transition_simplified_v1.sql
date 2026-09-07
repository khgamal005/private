begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- Latest explicit user decision: FULL is an internal admin-only contract,
-- Reef is untouched, every other existing tenant moves to BASIC, new signups
-- start FREE. Deferred resource/report gates are intentionally NOT sold.
create function private_app.is_reef_commerce_protected_v1(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from platform.tenant_deletion_protections p
 where p.tenant_id=p_tenant_id and p.protection_key='reef_live_tenant')
 or exists(select 1 from core.tenants t where t.id=p_tenant_id and t.slug='reef-skills');
$$;
revoke all on function private_app.is_reef_commerce_protected_v1(uuid) from public,anon,authenticated,service_role;

-- Only authorization/listing changes hide FULL. Its actual row, features,
-- limits, name, price and every Reef contract row remain byte-for-byte intact.
create policy independent_full_plan_admin_only_v1 on catalog.plans
as restrictive for select to authenticated
using(plan_key<>'full' or private_app.has_platform_permission('platform.billing.manage'));

create table catalog.core_transition_v1(
 tenant_id uuid primary key references core.tenants(id) on delete restrict,
 subscription_id uuid references catalog.subscriptions(id) on delete restrict,
 previous_subscriptions jsonb not null,
 previous_feature_overrides jsonb not null,
 previous_addon_rights jsonb not null,
 staff_floor bigint not null check(staff_floor>=5),
 applied_at timestamptz,
 applied_subscription jsonb,
 created_at timestamptz not null default now()
);
create index core_transition_subscription_idx on catalog.core_transition_v1(subscription_id);
alter table catalog.core_transition_v1 enable row level security;
revoke all on catalog.core_transition_v1 from public,anon,authenticated,service_role;

-- Capture metadata only for the exact current cohort; no later signup can
-- accidentally be enrolled by rerunning a follow-up task.
insert into catalog.core_transition_v1(tenant_id,subscription_id,previous_subscriptions,previous_feature_overrides,previous_addon_rights,staff_floor)
select t.id,s.id,
 coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from catalog.subscriptions x where x.tenant_id=t.id),'[]'),
 coalesce((select jsonb_agg(to_jsonb(x) order by x.feature_id) from catalog.tenant_feature_overrides x where x.tenant_id=t.id),'[]'),
 coalesce((select jsonb_agg(jsonb_build_object('featureId',f.id,'featureKey',f.feature_key,'entitlement',private_app.addon_entitlement_v3(t.id,f.feature_key)) order by f.feature_key)
 from catalog.addon_products a join catalog.features f on f.id=a.feature_id),'[]'),
 greatest(5,private_app.tenant_plan_usage_count(t.id,'max_employees'))
from core.tenants t
left join lateral(select * from catalog.subscriptions s where s.tenant_id=t.id and s.status in ('trialing','active','past_due','paused') order by s.created_at desc,s.id limit 1) s on true
where not private_app.is_reef_commerce_protected_v1(t.id);

-- Preserve only previously plan-derived live capabilities independently.
-- Existing paid licences, deliberate off overrides and their periods are never
-- changed. New BASIC purchases do NOT receive any of these grandfathered rights.
insert into catalog.tenant_feature_overrides(tenant_id,feature_id,value,reason)
select tr.tenant_id,f.id,pf.value,'independent_core_transition_preserved_existing_right'
from catalog.core_transition_v1 tr join catalog.subscriptions s on s.id=tr.subscription_id
join catalog.plan_features pf on pf.plan_id=s.plan_id join catalog.features f on f.id=pf.feature_id
where f.value_type='boolean' and pf.value='true'::jsonb
and not exists(select 1 from catalog.independent_commercial_catalog_v1 c join catalog.plan_features nf on nf.plan_id=c.plan_id where c.product_key='core_basic' and nf.feature_id=f.id and nf.value='true'::jsonb)
and (not exists(select 1 from catalog.addon_products p where p.feature_id=f.id)
 or (coalesce((private_app.addon_entitlement_v3(tr.tenant_id,f.feature_key)->>'enabled')::boolean,false)
 and private_app.addon_entitlement_v3(tr.tenant_id,f.feature_key)->>'source'='plan'))
on conflict(tenant_id,feature_id) do nothing;

-- Existing staff capacity is preserved by current_plan_limit below, not a
-- global feature override that could incorrectly cap a later upgraded plan.
-- Same subscription id and exact existing period; no bill, payment attempt,
-- card debit or customer notification is created by this metadata transition.
update catalog.subscriptions s
set plan_id=(select plan_id from catalog.independent_commercial_catalog_v1 where kind='core' and product_key='core_basic'),
 status=case when s.status='trialing' then 'active' else s.status end,updated_at=now()
from catalog.core_transition_v1 tr where s.id=tr.subscription_id and s.tenant_id=tr.tenant_id
and not private_app.is_reef_commerce_protected_v1(s.tenant_id);

-- Tenants without a current subscription also receive BASIC, but closed/suspended
-- tenant lifecycle states are deliberately not activated by this migration.
insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end)
select tr.tenant_id,c.plan_id,'active',now(),null
from catalog.core_transition_v1 tr cross join catalog.independent_commercial_catalog_v1 c
where tr.subscription_id is null and c.kind='core' and c.product_key='core_basic';
update catalog.core_transition_v1 tr set subscription_id=s.id,applied_subscription=to_jsonb(s),applied_at=now()
from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id
where s.tenant_id=tr.tenant_id and p.plan_key='core_basic'
and s.status in ('active','trialing','paused','past_due');
-- A complimentary transition is not revenue. Record zero commercial charge;
-- no annual discount or bundle entitlement is derived from the original plan.
insert into catalog.independent_core_subscription_terms_v1(subscription_id,catalog_offer_id,billing_interval,quoted_amount_minor)
select tr.subscription_id,c.id,'month',0 from catalog.core_transition_v1 tr
join catalog.independent_commercial_catalog_v1 c on c.product_key='core_basic' and c.kind='core';

alter function private_app.current_plan_limit(uuid,text) rename to current_plan_limit_before_transition_v1;
revoke all on function private_app.current_plan_limit_before_transition_v1(uuid,text) from public,anon,authenticated,service_role;
create function private_app.current_plan_limit(p_tenant_id uuid,p_limit_key text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b jsonb; floor_value bigint;
begin
 b:=private_app.current_plan_limit_before_transition_v1(p_tenant_id,p_limit_key);
 if private_app.is_reef_commerce_protected_v1(p_tenant_id) then return b;end if;
 if p_limit_key='max_employees' and b->>'planKey'='core_basic' then
  select tr.staff_floor into floor_value from catalog.core_transition_v1 tr
  join catalog.subscriptions s on s.id=tr.subscription_id and s.tenant_id=tr.tenant_id
  where tr.tenant_id=p_tenant_id and s.status in ('trialing','active','past_due','paused');
  if floor_value>coalesce((b->>'limitValue')::bigint,5) then
   b:=b||jsonb_build_object('limitValue',floor_value,'preservedExistingStaff',true);
  end if;
 end if;
 return b;
end $$;
revoke all on function private_app.current_plan_limit(uuid,text) from public,anon,authenticated,service_role;

-- Defense in depth: old screens, old RPCs and ordinary direct operator writes
-- cannot change the protected Reef contract or the shared FULL definition.
create function private_app.protect_full_contract_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_data jsonb;new_data jsonb;full_id uuid;
begin
 if tg_op<>'INSERT' then old_data:=to_jsonb(old);end if;
 if tg_op<>'DELETE' then new_data:=to_jsonb(new);end if;
 if tg_table_name='subscriptions' then
  if private_app.is_reef_commerce_protected_v1((old_data->>'tenant_id')::uuid)
    or private_app.is_reef_commerce_protected_v1((new_data->>'tenant_id')::uuid) then
   raise exception 'reef_contract_protected';
  end if;
 else
  select id into full_id from catalog.plans where plan_key='full';
  if (case when tg_table_name='plans' then old_data->>'id' else old_data->>'plan_id' end)::uuid=full_id
   or (case when tg_table_name='plans' then new_data->>'id' else new_data->>'plan_id' end)::uuid=full_id then
   raise exception 'legacy_plan_contract_protected';
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
revoke all on function private_app.protect_full_contract_v1() from public,anon,authenticated,service_role;
create trigger a_protect_reef_contract_v1 before insert or update or delete on catalog.subscriptions for each row execute function private_app.protect_full_contract_v1();
create trigger a_protect_full_plan_v1 before update or delete on catalog.plans for each row execute function private_app.protect_full_contract_v1();
create trigger a_protect_full_features_v1 before insert or update or delete on catalog.plan_features for each row execute function private_app.protect_full_contract_v1();
create trigger a_protect_full_limits_v1 before insert or update or delete on catalog.plan_limits for each row execute function private_app.protect_full_contract_v1();

alter function public.v5_platform_commerce_action(text,jsonb) rename to v5_platform_commerce_action_before_transition_v1;
alter function public.v5_platform_commerce_action_before_transition_v1(text,jsonb) set schema private_app;
revoke all on function private_app.v5_platform_commerce_action_before_transition_v1(text,jsonb) from public,anon,authenticated,service_role;
create function public.v5_platform_commerce_action(p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare p catalog.plans%rowtype;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 if p_action='set_subscription' then
  if private_app.is_reef_commerce_protected_v1(nullif(p_payload->>'tenantId','')::uuid) then raise exception 'reef_contract_protected';end if;
  select * into p from catalog.plans where id=nullif(p_payload->>'planId','')::uuid and status='active';
  if p.plan_key='full' then
   return private_app.v4_platform_commerce_action_before_independent_v1(p_action,p_payload||jsonb_build_object('periodEnd',null))||jsonb_build_object('internalOnly',true);
  end if;
 end if;
 return private_app.v5_platform_commerce_action_before_transition_v1(p_action,p_payload);
end $$;
revoke all on function public.v5_platform_commerce_action(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v5_platform_commerce_action(text,jsonb) to authenticated;

-- The older tenant list uses this RPC. Keep its argument and result contract,
-- but never its former unbounded plan-changing implementation.
create or replace function public.v2_platform_set_subscription(p_tenant_id uuid,p_plan_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pid uuid;key text;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 if private_app.is_reef_commerce_protected_v1(p_tenant_id) then raise exception 'reef_contract_protected';end if;
 key:=case when p_plan_key='free' then 'core_free' else p_plan_key end;
 select id into pid from catalog.plans where plan_key=key and status='active';
 if pid is null then raise exception 'plan_not_found';end if;
 return public.v5_platform_commerce_action('set_subscription',jsonb_build_object('tenantId',p_tenant_id,'planId',pid,'status','active','billingInterval','month'))||jsonb_build_object('planKey',key);
end $$;
revoke all on function public.v2_platform_set_subscription(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.v2_platform_set_subscription(uuid,text) to authenticated;

-- FREE is unconditional for public/verified registrations, even if a stale
-- registration policy still carries another plan key. Administrative explicit
-- provisioning retains a permission-checked FULL choice.
create or replace function private_app.provision_tenant_core(p_display_name text,p_legal_name text,p_slug text,p_country_code text,p_timezone text,p_plan_key text,p_owner_name text,p_owner_email text,p_hostname text,p_link_policy text,p_invited_by_subject_id uuid,p_tenant_settings jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare selected_key text; result jsonb;
begin
 selected_key:=case when p_link_policy='verified_email' or coalesce(nullif(btrim(p_plan_key),''),'free')='free' then 'core_free' else p_plan_key end;
 if selected_key='full' and not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 result:=private_app.provision_tenant_core_before_independent_v1(p_display_name,p_legal_name,p_slug,p_country_code,p_timezone,selected_key,p_owner_name,p_owner_email,p_hostname,p_link_policy,p_invited_by_subject_id,p_tenant_settings);
 if selected_key='core_free' and nullif(result->>'id','') is not null then
  update catalog.subscriptions set status='active',period_end=null where tenant_id=(result->>'id')::uuid and plan_id=(select id from catalog.plans where plan_key='core_free') and status='trialing';
 end if;
 return result;
end $$;
revoke all on function private_app.provision_tenant_core(text,text,text,text,text,text,text,text,text,text,uuid,jsonb) from public,anon,authenticated,service_role;

alter function public.v5_platform_commerce_snapshot() rename to v5_platform_commerce_snapshot_before_transition_v1;
alter function public.v5_platform_commerce_snapshot_before_transition_v1() set schema private_app;
revoke all on function private_app.v5_platform_commerce_snapshot_before_transition_v1() from public,anon,authenticated,service_role;
create function public.v5_platform_commerce_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb;a jsonb;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 b:=private_app.v5_platform_commerce_snapshot_before_transition_v1();
 select coalesce(jsonb_agg(value||jsonb_build_object('internalOnly',true,'isPublic',false)),'[]') into a
 from jsonb_array_elements(coalesce(b->'legacyPlans','[]')) where value->>'key'='full';
 return b||jsonb_build_object('adminOnlyPlans',a,'legacyPlans',a,'capacityPolicy','staff_only_v1','transitionedTenants',(select count(*) from catalog.core_transition_v1 where applied_at is not null));
end $$;
revoke all on function public.v5_platform_commerce_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v5_platform_commerce_snapshot() to authenticated;

-- Stored fingerprints are verified by the release runner. These assertions
-- prevent an accidental broad tenant migration even if a later edit is wrong.
do $$
begin
 if exists(select 1 from catalog.core_transition_v1 where private_app.is_reef_commerce_protected_v1(tenant_id)) then raise exception 'reef_transition_forbidden';end if;
 if exists(select 1 from catalog.core_transition_v1 tr left join catalog.subscriptions s on s.id=tr.subscription_id left join catalog.plans p on p.id=s.plan_id where p.plan_key is distinct from 'core_basic' or tr.applied_at is null) then raise exception 'core_transition_incomplete';end if;
 if exists(select 1 from catalog.core_transition_v1 tr cross join lateral jsonb_array_elements(tr.previous_addon_rights) x where coalesce((x->'entitlement'->>'enabled')::boolean,false) and not coalesce((private_app.addon_entitlement_v3(tr.tenant_id,x->>'featureKey')->>'enabled')::boolean,false)) then raise exception 'existing_addon_right_lost';end if;
 if not exists(select 1 from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id where private_app.is_reef_commerce_protected_v1(s.tenant_id) and p.plan_key='full' and s.status='active' and s.period_end is null) then raise exception 'reef_contract_not_preserved';end if;
end $$;
notify pgrst,'reload schema';
commit;
