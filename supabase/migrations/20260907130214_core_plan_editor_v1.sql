begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Only four core offers are editable. No edit or backfill touches FULL or Reef.
-- Core annual amounts become independent; add-on annual pricing is unchanged.
alter table catalog.independent_commercial_catalog_v1
 drop constraint independent_commercial_catalog_v1_check;
alter table catalog.independent_commercial_catalog_v1 add constraint independent_catalog_annual_policy_v2
 check(annual_amount_minor>=0 and (kind='core' or annual_amount_minor=monthly_amount_minor*10));

create table catalog.core_plan_revisions_v1 (
 id uuid primary key default gen_random_uuid(),
 plan_id uuid not null references catalog.plans(id) on delete restrict,
 actor_subject_id uuid,
 before_value jsonb not null,
 after_value jsonb not null,
 reason text not null check(length(reason) between 3 and 500),
 created_at timestamptz not null default now()
);
create index core_plan_revisions_plan_time_idx on catalog.core_plan_revisions_v1(plan_id,created_at desc);
alter table catalog.core_plan_revisions_v1 enable row level security;
revoke all on catalog.core_plan_revisions_v1 from public,anon,authenticated,service_role;

-- Capacity is contractual: editing a product never lowers existing seat rights.
-- This is private configuration metadata, not an invoice or a new payment.
create table catalog.core_contract_capacity_v1 (
 subscription_id uuid primary key references catalog.subscriptions(id) on delete cascade,
 plan_id uuid not null references catalog.plans(id) on delete restrict,
 staff_limit bigint not null check(staff_limit between 1 and 10000),
 catalog_snapshot jsonb not null,
 captured_at timestamptz not null default now()
);
create index core_contract_capacity_plan_idx on catalog.core_contract_capacity_v1(plan_id);
alter table catalog.core_contract_capacity_v1 enable row level security;
revoke all on catalog.core_contract_capacity_v1 from public,anon,authenticated,service_role;
insert into catalog.core_contract_capacity_v1(subscription_id,plan_id,staff_limit,catalog_snapshot)
 select s.id,s.plan_id,greatest((c.profile->'limits'->>'staff')::bigint,
 coalesce((private_app.current_plan_limit(s.tenant_id,'max_employees')->>'limitValue')::bigint,1)),to_jsonb(c)
 from catalog.subscriptions s join catalog.independent_commercial_catalog_v1 c on c.plan_id=s.plan_id and c.kind='core'
 where s.status in ('active','trialing','past_due','paused')
 and not private_app.is_reef_commerce_protected_v1(s.tenant_id);

create function private_app.capture_core_capacity_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare c catalog.independent_commercial_catalog_v1%rowtype;
begin
 if private_app.is_reef_commerce_protected_v1(new.tenant_id) then return new;end if;
 if tg_op='UPDATE' and new.plan_id is not distinct from old.plan_id then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('odeir:core-catalog:'||new.plan_id::text,0));
 select * into c from catalog.independent_commercial_catalog_v1 where kind='core' and plan_id=new.plan_id;
 if c.id is null then return new;end if;
 insert into catalog.core_contract_capacity_v1(subscription_id,plan_id,staff_limit,catalog_snapshot)
 values(new.id,new.plan_id,(c.profile->'limits'->>'staff')::bigint,to_jsonb(c))
 on conflict(subscription_id) do update set plan_id=excluded.plan_id,staff_limit=excluded.staff_limit,
 catalog_snapshot=excluded.catalog_snapshot,captured_at=now();
 return new;
end $$;
revoke all on function private_app.capture_core_capacity_v1() from public,anon,authenticated,service_role;
create trigger core_contract_capture_v1 after insert or update of plan_id on catalog.subscriptions
 for each row execute function private_app.capture_core_capacity_v1();

alter function private_app.current_plan_limit(uuid,text) rename to current_plan_limit_before_editor_v1;
revoke all on function private_app.current_plan_limit_before_editor_v1(uuid,text) from public,anon,authenticated,service_role;
create function private_app.current_plan_limit(p_tenant_id uuid,p_limit_key text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb;cap bigint;
begin
 b:=private_app.current_plan_limit_before_editor_v1(p_tenant_id,p_limit_key);
 if private_app.is_reef_commerce_protected_v1(p_tenant_id) then return b;end if;
 if p_limit_key='max_employees' then
  select x.staff_limit into cap from catalog.subscriptions s
  join catalog.core_contract_capacity_v1 x on x.subscription_id=s.id and x.plan_id=s.plan_id
  where s.tenant_id=p_tenant_id and s.status in ('active','trialing','past_due','paused')
  order by s.created_at desc,s.id limit 1;
  if cap is not null then b:=b||jsonb_build_object('limitValue',cap,'contractCapacity',true);end if;
 end if;
 return b;
end $$;
revoke all on function private_app.current_plan_limit(uuid,text) from public,anon,authenticated,service_role;

create function private_app.core_plan_editor_item_v1(p_plan_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'key',p.plan_key,'nameAr',c.name_ar,'description',c.description_ar,
 'monthlyAmountMinor',c.monthly_amount_minor,'annualAmountMinor',c.annual_amount_minor,
 'commercialProfile',c.profile,'published',c.published,'displayOrder',c.display_order,'status',p.status,
 'subscriberCount',(select count(*) from catalog.subscriptions s where s.plan_id=p.id and s.status in ('active','trialing','past_due','paused')),
 'version',encode(extensions.digest(to_jsonb(c)::text,'sha256'),'hex'),
 'history',coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id) from
 (select id,reason,created_at,before_value,after_value from catalog.core_plan_revisions_v1 r
 where r.plan_id=p.id order by created_at desc,id limit 8) h),'[]'::jsonb))
 from catalog.independent_commercial_catalog_v1 c join catalog.plans p on p.id=c.plan_id
 where c.kind='core' and p.id=p_plan_id;
$$;
revoke all on function private_app.core_plan_editor_item_v1(uuid) from public,anon,authenticated,service_role;
create function public.v1_platform_core_plans_editor_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 return jsonb_build_object('plans',coalesce((select jsonb_agg(private_app.core_plan_editor_item_v1(c.plan_id)
 order by c.display_order,c.product_key) from catalog.independent_commercial_catalog_v1 c where kind='core'),'[]'),
 'legacyPlans',coalesce((select jsonb_agg(jsonb_build_object('id',id,'key',plan_key,'nameAr',name_ar,
 'internalOnly',true,'readOnly',true,'subscriberCount',(select count(*) from catalog.subscriptions s where s.plan_id=p.id and s.status='active')))
 from catalog.plans p where plan_key='full'),'[]'),'editorVersion','core-plan-editor-v1');
end $$;
revoke all on function public.v1_platform_core_plans_editor_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_core_plans_editor_snapshot() to authenticated;

create function public.v1_platform_core_plan_update(p_plan_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c catalog.independent_commercial_catalog_v1%rowtype;b jsonb;a jsonb;
 m bigint;y bigint;seats bigint;position integer;label text;descr text;reason text;visible boolean;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 if exists(select 1 from catalog.plans where id=p_plan_id and plan_key='full') then raise exception 'legacy_plan_contract_protected';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or coalesce(p_payload->>'expectedVersion','') !~ '^[a-f0-9]{64}$'
 or p_payload->'confirmed' is distinct from 'true'::jsonb then raise exception 'plan_editor_payload_invalid';end if;
 perform pg_advisory_xact_lock(hashtextextended('odeir:core-catalog:'||p_plan_id::text,0));
 select * into c from catalog.independent_commercial_catalog_v1 where plan_id=p_plan_id and kind='core' for update;
 if c.id is null or c.product_key not in ('core_free','core_basic','core_professional','core_diamond') then raise exception 'plan_not_found';end if;
 b:=private_app.core_plan_editor_item_v1(p_plan_id);
 if b->>'version' is distinct from p_payload->>'expectedVersion' then raise exception 'plan_editor_version_conflict';end if;
 if coalesce(p_payload->>'monthlyAmountMinor','') !~ '^[0-9]{1,9}$'
 or coalesce(p_payload->>'annualAmountMinor','') !~ '^[0-9]{1,9}$'
 or coalesce(p_payload->>'staffLimit','') !~ '^[0-9]{1,5}$'
 or coalesce(p_payload->>'displayOrder','') !~ '^[0-9]{1,5}$'
 or jsonb_typeof(p_payload->'published') is distinct from 'boolean' then raise exception 'plan_editor_payload_invalid';end if;
 m:=(p_payload->>'monthlyAmountMinor')::bigint;y:=(p_payload->>'annualAmountMinor')::bigint;
 seats:=(p_payload->>'staffLimit')::bigint;position:=(p_payload->>'displayOrder')::integer;
 label:=btrim(p_payload->>'nameAr');descr:=btrim(p_payload->>'description');reason:=btrim(p_payload->>'reason');visible:=(p_payload->>'published')::boolean;
 if coalesce(length(label),0) not between 2 and 100 or coalesce(length(descr),0) not between 5 and 600
 or coalesce(length(reason),0) not between 3 and 500 or seats not between 1 and 10000 or position not between 0 and 10000
 or m>100000000 or y>100000000 then raise exception 'plan_editor_payload_invalid';end if;
 if c.product_key='core_free' and (m<>0 or y<>0 or not visible) then raise exception 'free_plan_must_remain_free';end if;
 if c.product_key<>'core_free' and (m<1 or y<1) then raise exception 'paid_plan_price_required';end if;
 update catalog.independent_commercial_catalog_v1 set name_ar=label,description_ar=descr,
 monthly_amount_minor=m,annual_amount_minor=y,published=visible,display_order=position,
 profile=profile||jsonb_build_object('name',label,'description',descr,'monthlyMinor',m,'annualMinor',y,
 'limits',jsonb_build_object('staff',seats),'addonsIncluded',false) where id=c.id;
 update catalog.plans set name_ar=label,description=descr,amount_minor=m,is_public=visible,
 display_order=position,updated_at=now() where id=p_plan_id;
 update catalog.plan_limits set limit_value=seats where plan_id=p_plan_id and limit_key='max_employees';
 update catalog.plan_features pf set value=to_jsonb(seats) from catalog.features f
 where pf.plan_id=p_plan_id and f.id=pf.feature_id and f.feature_key='limit.users';
 a:=private_app.core_plan_editor_item_v1(p_plan_id);
 insert into catalog.core_plan_revisions_v1(plan_id,actor_subject_id,before_value,after_value,reason)
 values(p_plan_id,private_app.current_subject_id(),b-'history',a-'history',reason);
 perform private_app.write_audit('core_plan.definition.updated','plan',p_plan_id::text,null,
 jsonb_build_object('before',b-'history','after',a-'history','reason',reason,'existingSubscriptionsChanged',false));
 return private_app.core_plan_editor_item_v1(p_plan_id);
end $$;
revoke all on function public.v1_platform_core_plan_update(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_core_plan_update(uuid,jsonb) to authenticated;

-- Assignment and editing share one lock; a quoted price and its seats cannot be
-- captured from different revisions. Existing RPC aliases still delegate here.
alter function public.v5_platform_commerce_action(text,jsonb) rename to v5_platform_commerce_action_before_editor_v1;
alter function public.v5_platform_commerce_action_before_editor_v1(text,jsonb) set schema private_app;
revoke all on function private_app.v5_platform_commerce_action_before_editor_v1(text,jsonb) from public,anon,authenticated,service_role;
create function public.v5_platform_commerce_action(p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 if p_action='set_subscription' then
 perform pg_advisory_xact_lock(hashtextextended('odeir:core-catalog:'||(p_payload->>'planId'),0));
 end if;
 return private_app.v5_platform_commerce_action_before_editor_v1(p_action,p_payload);
end $$;
revoke all on function public.v5_platform_commerce_action(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v5_platform_commerce_action(text,jsonb) to authenticated;

-- A plan edit must invalidate a previously opened tenant assignment review.
do $patch$
declare src text;needle text:='t.id,t.slug,t.name,t.status,t.updated_at,sub,members';
begin
 src:=pg_get_functiondef('public.v1_platform_tenant_controls_snapshot(uuid)'::regprocedure);
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'plan_editor_controls_source_drift';end if;
 execute replace(src,needle,needle||',plans');
end $patch$;
notify pgrst,'reload schema';
commit;
