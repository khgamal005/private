begin;

-- Feature values can be booleans or numeric quotas. In particular, -1 means
-- unlimited and must be treated as enabled instead of being cast to boolean.
create or replace function private_app.entitlement_value_enabled(
  p_value jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then false
    when jsonb_typeof(p_value) = 'boolean'
      then (p_value #>> '{}')::boolean
    when jsonb_typeof(p_value) = 'number'
      then (p_value #>> '{}')::numeric <> 0
    when jsonb_typeof(p_value) = 'string' then
      case
        when lower(btrim(p_value #>> '{}')) in (
          'true', 't', 'yes', 'y', 'on', 'enabled', 'unlimited'
        ) then true
        when lower(btrim(p_value #>> '{}')) in (
          'false', 'f', 'no', 'n', 'off', 'disabled', ''
        ) then false
        when btrim(p_value #>> '{}')
          ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
          then (p_value #>> '{}')::numeric <> 0
        else false
      end
    else false
  end;
$$;

revoke all on function
  private_app.entitlement_value_enabled(jsonb)
from public, anon, authenticated;

create or replace function private_app.addon_entitlement_v2_base(
  p_tenant_id uuid,
  p_feature_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_feature catalog.features%rowtype;
  v_product catalog.addon_products%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_override boolean;
  v_plan_enabled boolean;
  v_default_enabled boolean;
  v_enabled boolean := false;
  v_source text := 'none';
  v_status text := 'disabled';
  v_limit bigint;
  v_period_start date := date_trunc('month', now())::date;
  v_period_end date :=
    (date_trunc('month', now()) + interval '1 month')::date;
  v_used bigint := 0;
  v_reserved bigint := 0;
begin
  select * into v_feature
  from catalog.features feature
  where feature.feature_key = p_feature_key
  limit 1;

  if v_feature.id is null then
    return jsonb_build_object(
      'enabled', false,
      'source', 'missing',
      'status', 'disabled'
    );
  end if;

  select * into v_product
  from catalog.addon_products product
  where product.feature_id = v_feature.id
  limit 1;

  select private_app.entitlement_value_enabled(override.value)
  into v_override
  from catalog.tenant_feature_overrides override
  where override.tenant_id = p_tenant_id
    and override.feature_id = v_feature.id
  limit 1;

  select * into v_subscription
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id = p_tenant_id
    and subscription.product_id = v_product.id
    and subscription.status in (
      'pending', 'trialing', 'active', 'paused'
    )
  order by subscription.created_at desc
  limit 1;

  select private_app.entitlement_value_enabled(plan_feature.value)
  into v_plan_enabled
  from catalog.subscriptions subscription
  join catalog.plan_features plan_feature
    on plan_feature.plan_id = subscription.plan_id
  where subscription.tenant_id = p_tenant_id
    and subscription.status in ('trialing', 'active')
    and plan_feature.feature_id = v_feature.id
  order by subscription.created_at desc
  limit 1;

  v_default_enabled := private_app.entitlement_value_enabled(
    v_feature.default_value
  );

  if v_override is not null then
    v_enabled := v_override;
    v_source := 'override';
    v_status := case when v_override then 'active' else 'disabled' end;
  elsif coalesce(v_plan_enabled, false) then
    v_enabled := true;
    v_source := 'plan';
    v_status := 'included';
  elsif v_subscription.status = 'active' then
    v_enabled := true;
    v_source := 'subscription';
    v_status := 'active';
  elsif v_subscription.status = 'trialing'
        and coalesce(v_subscription.trial_end, now()) >= now() then
    v_enabled := true;
    v_source := 'subscription';
    v_status := 'trialing';
  elsif v_subscription.status is not null then
    v_source := 'subscription';
    v_status := v_subscription.status;
  elsif coalesce(v_default_enabled, false) then
    v_enabled := true;
    v_source := 'default';
    v_status := 'active';
  end if;

  v_limit := coalesce(
    v_subscription.custom_limit,
    v_product.default_limit
  );

  if v_product.usage_metric = 'automation_runs' then
    select count(*) into v_used
    from automation_engine.runs run
    where run.tenant_id = p_tenant_id
      and run.created_at >= v_period_start;
  elsif v_product.usage_metric = 'active_templates' then
    select count(*) into v_used
    from communication_hub.message_templates template
    where template.tenant_id = p_tenant_id
      and template.status = 'active';
  elsif v_product.usage_metric = 'delivery_events' then
    select count(*) into v_used
    from communication_hub.delivery_events event
    where event.tenant_id = p_tenant_id
      and event.occurred_at >= v_period_start;
  elsif v_product.id is not null then
    select
      coalesce(counter.used_quantity, 0),
      coalesce(counter.reserved_quantity, 0)
    into v_used, v_reserved
    from catalog.addon_usage_counters counter
    where counter.tenant_id = p_tenant_id
      and counter.product_id = v_product.id
      and counter.metric_key = v_product.usage_metric
      and counter.period_start = v_period_start;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'enabled', v_enabled,
    'source', v_source,
    'status', v_status,
    'featureKey', v_feature.feature_key,
    'productId', v_product.id,
    'productKey', v_product.product_key,
    'metricKey', v_product.usage_metric,
    'limit', v_limit,
    'used', coalesce(v_used, 0),
    'reserved', coalesce(v_reserved, 0),
    'remaining', case
      when v_limit is null then null
      else greatest(
        v_limit - coalesce(v_used, 0) - coalesce(v_reserved, 0),
        0
      )
    end,
    'periodStart', v_period_start,
    'periodEnd', v_period_end,
    'trialEnd', v_subscription.trial_end,
    'subscriptionId', v_subscription.id
  ));
end;
$$;

create or replace function private_app.addon_entitlement_v3(
  p_tenant_id uuid,
  p_feature_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_source text;
  v_enabled boolean;
  v_effective_status text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_days_remaining integer;
begin
  v_result := private_app.addon_entitlement_v2_base(
    p_tenant_id,
    p_feature_key
  );
  v_source := coalesce(v_result ->> 'source', 'none');
  v_enabled := private_app.entitlement_value_enabled(v_result -> 'enabled');
  v_effective_status := coalesce(v_result ->> 'status', 'disabled');

  begin
    select subscription.*
    into v_subscription
    from catalog.tenant_addon_subscriptions subscription
    where subscription.id = (v_result ->> 'subscriptionId')::uuid
      and subscription.tenant_id = p_tenant_id
    limit 1;
  exception
    when invalid_text_representation then
      v_subscription.id := null;
  end;

  if v_subscription.id is not null then
    v_starts_at := coalesce(
      case
        when v_subscription.status = 'trialing'
          then v_subscription.trial_start
        else null
      end,
      v_subscription.period_start,
      v_subscription.activated_at,
      v_subscription.created_at
    );
    v_ends_at := coalesce(
      case
        when v_subscription.status = 'trialing'
          then v_subscription.trial_end
        else null
      end,
      v_subscription.period_end
    );

    -- Normal entitlements remain additive. A deliberately authoritative period
    -- overrides legacy bundled-plan access, but never an explicit tenant override.
    if v_source = 'subscription'
       or (
         v_subscription.period_is_authoritative
         and v_source <> 'override'
       ) then
      if v_subscription.status = 'active'
         and (v_starts_at is null or v_starts_at <= now())
         and (v_ends_at is null or v_ends_at > now()) then
        v_enabled := true;
        v_effective_status := 'active';
      elsif v_subscription.status = 'trialing'
            and (v_starts_at is null or v_starts_at <= now())
            and v_ends_at is not null
            and v_ends_at > now() then
        v_enabled := true;
        v_effective_status := 'trialing';
      elsif v_starts_at > now() then
        v_enabled := false;
        v_effective_status := 'scheduled';
      elsif v_ends_at is not null and v_ends_at <= now() then
        v_enabled := false;
        v_effective_status := 'expired';
      else
        v_enabled := false;
        v_effective_status := v_subscription.status;
      end if;

      v_source := coalesce(v_subscription.source, 'subscription');
    end if;

    if v_ends_at is not null then
      v_days_remaining := greatest(
        ceil(extract(epoch from (v_ends_at - now())) / 86400)::integer,
        0
      );
    end if;
  end if;

  return jsonb_strip_nulls(
    coalesce(v_result, '{}'::jsonb)
    || jsonb_build_object(
      'enabled', v_enabled,
      'source', v_source,
      'status', v_effective_status,
      'startsAt', v_starts_at,
      'endsAt', v_ends_at,
      'expiresAt', v_ends_at,
      'daysRemaining', v_days_remaining,
      'expiryAware', true,
      'periodIsAuthoritative', coalesce(
        v_subscription.period_is_authoritative,
        false
      ),
      'lifecycleProtectedUntil',
        v_subscription.lifecycle_protected_until
    )
  );
end;
$$;

create or replace function private_app.tenant_addon_enabled(
  p_tenant_id uuid,
  p_feature_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private_app.entitlement_value_enabled(
    private_app.addon_entitlement_v3(
      p_tenant_id,
      p_feature_key
    ) -> 'enabled'
  );
$$;

do $entitlement_boolean_contract$
begin
  if not private_app.entitlement_value_enabled('-1'::jsonb)
     or not private_app.entitlement_value_enabled('3'::jsonb)
     or private_app.entitlement_value_enabled('0'::jsonb)
     or private_app.entitlement_value_enabled('false'::jsonb)
     or not private_app.entitlement_value_enabled('"true"'::jsonb)
     or private_app.entitlement_value_enabled('"not-a-boolean"'::jsonb) then
    raise exception 'addon_entitlement_boolean_normalization_failed';
  end if;
end;
$entitlement_boolean_contract$;

commit;
