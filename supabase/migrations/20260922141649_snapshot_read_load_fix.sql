-- Read-path repair only: no tenant/customer/task records or policies are changed.
begin;
set local lock_timeout = '2s';

-- This invoker function contains only built-in operators over its arguments.
-- Removing its per-call SET lets PostgreSQL inline it into snapshot filters.
-- Privileged readers keep their empty search_path and existing permission gates.
alter function private_app.customer_followup_uses_day_policy_v1(uuid, text)
  reset search_path;

create or replace function public.v3_platform_control_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_tenants jsonb;
  v_timing jsonb := '{}'::jsonb;
  v_tenant record;
  v_timezone text;
  v_today_start timestamptz;
begin
  -- Retains the canonical permission checks, redaction and complete contract.
  v_snapshot := public.v2_platform_control_snapshot_v2();

  for v_tenant in
    select tenant.id, tenant.timezone
    from core.tenants tenant
    where tenant.id in (
      select nullif(item ->> 'id', '')::uuid
      from jsonb_array_elements(coalesce(v_snapshot -> 'tenants', '[]'::jsonb)) item
    )
  loop
    v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
    begin
      v_today_start := (now() at time zone v_timezone)::date::timestamp
        at time zone v_timezone;
    exception when invalid_parameter_value then
      -- A malformed historical timezone must not break platform administration.
      v_today_start := (now() at time zone 'UTC')::date::timestamp at time zone 'UTC';
    end;
    v_timing := v_timing || jsonb_build_object(v_tenant.id::text, v_today_start);
  end loop;

  with timing as materialized (
    select entry.key::uuid tenant_id, entry.value::timestamptz today_start
    from jsonb_each_text(v_timing) entry
  ), overdue as materialized (
    select task.tenant_id, count(*) task_count
    from work_core.tasks task
    join timing on timing.tenant_id = task.tenant_id
    where task.status not in ('completed', 'cancelled')
      and task.due_at < case
        when private_app.customer_followup_uses_day_policy_v1(
          task.contact_id, task.metadata ->> 'source'
        ) then timing.today_start
        else now()
      end
    group by task.tenant_id
  )
  select coalesce(jsonb_agg(
    member.item || jsonb_build_object('overdueTasks', coalesce(overdue.task_count, 0))
    order by member.position
  ), '[]'::jsonb)
  into v_tenants
  from jsonb_array_elements(coalesce(v_snapshot -> 'tenants', '[]'::jsonb))
    with ordinality member(item, position)
  left join overdue on overdue.tenant_id = nullif(member.item ->> 'id', '')::uuid;

  return jsonb_set(v_snapshot, '{tenants}', v_tenants, true);
end;
$$;

revoke all on function public.v3_platform_control_snapshot() from public, anon;
grant execute on function public.v3_platform_control_snapshot() to authenticated, service_role;

-- The tenants screen needs tenant administration fields and plan choices only.
-- It must not build task/CRM metrics, payment histories, addon stores or audit feeds.
create or replace function public.v1_platform_tenants_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_can_billing boolean;
  v_provisioning jsonb;
  v_tenants jsonb;
  v_plans jsonb;
begin
  if not private_app.has_platform_permission('platform.control.read')
     or not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_can_billing := private_app.has_platform_permission('platform.billing.manage');
  v_provisioning := public.v2_platform_provisioning_snapshot_v2();

  with details as materialized (
    select item from jsonb_array_elements(coalesce(v_provisioning -> 'tenants', '[]'::jsonb)) item
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', tenant.id, 'tenantKey', tenant.tenant_key,
      'slug', tenant.slug, 'name', tenant.name, 'legalName', tenant.legal_name,
      'status', tenant.status, 'timezone', tenant.timezone,
      'planKey', plan.plan_key, 'planName', plan.name_ar
    ) || coalesce(details.item, '{}'::jsonb) || jsonb_build_object(
      'employees', coalesce((details.item ->> 'memberCount')::bigint, 0)
    ) order by tenant.created_at desc
  ), '[]'::jsonb) into v_tenants
  from core.tenants tenant
  left join catalog.subscriptions subscription
    on subscription.tenant_id = tenant.id
    and subscription.status in ('trialing', 'active', 'past_due', 'paused')
  left join catalog.plans plan on plan.id = subscription.plan_id
  left join details on (details.item ->> 'tenantId')::uuid = tenant.id;

  -- Match the current commercial policy: published independent plans plus the
  -- internal Full plan for billing admins; canonical legacy list for other admins.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', plan.id, 'key', plan.plan_key, 'nameAr', plan.name_ar, 'nameEn', plan.name_en,
    'amountMinor', plan.amount_minor, 'currency', plan.currency,
    'interval', plan.interval, 'status', plan.status
  ) order by
    case when v_can_billing then coalesce(commercial.display_order, 2147483647) end,
    plan.amount_minor, plan.created_at
  ), '[]'::jsonb) into v_plans
  from catalog.plans plan
  left join catalog.independent_commercial_catalog_v1 commercial
    on commercial.kind = 'core' and commercial.plan_id = plan.id
  where not v_can_billing or commercial.published
    or (commercial.plan_id is null and plan.plan_key = 'full');

  return jsonb_build_object(
    'generatedAt', now(), 'tenants', v_tenants, 'plans', v_plans,
    'pendingInvitations', coalesce((v_provisioning ->> 'pendingInvitations')::bigint, 0)
  );
end;
$$;

revoke all on function public.v1_platform_tenants_snapshot() from public, anon;
grant execute on function public.v1_platform_tenants_snapshot() to authenticated, service_role;
commit;
