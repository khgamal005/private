-- Add-on platform v3 follow-up: harden grants and Reef lifecycle guarantees.
-- This migration preserves every operational row and keeps the prior public
-- action implementation privately available for non-grant actions.

begin;

do $hardening_preflight$
begin
  if to_regprocedure(
    'public.v3_platform_addon_center_action(text,jsonb)'
  ) is null then
    raise exception 'v3_platform_addon_center_action_missing';
  end if;

  if to_regprocedure(
    'private_app.v3_platform_addon_center_action_v3_legacy(text,jsonb)'
  ) is not null then
    raise exception 'v3_platform_addon_center_action_legacy_exists';
  end if;

  if to_regprocedure(
    'private_app.protect_addon_subscription_lifecycle_v3()'
  ) is null then
    raise exception 'addon_subscription_lifecycle_guard_missing';
  end if;
end;
$hardening_preflight$;

-------------------------------------------------------------------------------
-- 1. Neutralize conflicting Reef false overrides without deleting the rows
-------------------------------------------------------------------------------

with reef as materialized (
  select tenant.id
  from core.tenants tenant
  where tenant.tenant_key = 'tenant-reef-skills'
    and tenant.slug = 'reef-skills'
  limit 1
), changed as (
  update catalog.tenant_feature_overrides feature_override
  set value = 'null'::jsonb,
      reason = concat_ws(
        ' | ',
        nullif(trim(feature_override.reason), ''),
        'Disabled conflicting false override for the protected Reef v3 grant.'
      ),
      updated_at = now()
  from reef,
       catalog.addon_products product
  where feature_override.tenant_id = reef.id
    and feature_override.feature_id = product.feature_id
    and product.status in ('beta', 'active')
    and lower(coalesce(feature_override.value #>> '{}', '')) = 'false'
  returning feature_override.tenant_id, feature_override.feature_id
)
insert into audit_log.events (
  tenant_id,
  actor_subject_id,
  action,
  resource_type,
  resource_id,
  context
)
select
  changed.tenant_id,
  null,
  'catalog.addon.reef_false_override_neutralized_v3',
  'tenant_feature_override',
  changed.feature_id::text,
  jsonb_build_object(
    'featureKey', feature.feature_key,
    'previousValue', false,
    'newValue', null,
    'overrideRowPreserved', true,
    'reasonPreserved', true,
    'operationalRowsDeleted', false
  )
from changed
join catalog.features feature on feature.id = changed.feature_id;

-- During the fixed launch-year window, subscription rows alone are not enough:
-- every published add-on must resolve through the actual production gate.
do $reef_effective_entitlement_check$
declare
  v_reef_tenant_id uuid;
  v_expected integer;
  v_effective integer;
begin
  select tenant.id into v_reef_tenant_id
  from core.tenants tenant
  where tenant.tenant_key = 'tenant-reef-skills'
    and tenant.slug = 'reef-skills'
  limit 1;

  if v_reef_tenant_id is null then
    raise exception 'reef_skills_tenant_not_found_v3';
  end if;

  if exists (
    select 1
    from catalog.tenant_feature_overrides feature_override
    join catalog.addon_products product
      on product.feature_id = feature_override.feature_id
     and product.status in ('beta', 'active')
    where feature_override.tenant_id = v_reef_tenant_id
      and lower(coalesce(feature_override.value #>> '{}', '')) = 'false'
  ) then
    raise exception 'reef_false_addon_override_still_active';
  end if;

  if now() >= timestamptz '2026-08-01 00:00:00+03'
     and now() < timestamptz '2027-08-01 00:00:00+03' then
    select count(*) into v_expected
    from catalog.addon_products product
    where product.status in ('beta', 'active');

    select count(*) into v_effective
    from catalog.addon_products product
    join catalog.features feature on feature.id = product.feature_id
    where product.status in ('beta', 'active')
      and private_app.tenant_addon_enabled(
        v_reef_tenant_id,
        feature.feature_key
      );

    if v_effective <> v_expected then
      raise exception
        'reef_effective_addon_entitlement_incomplete:%/%',
        v_effective,
        v_expected;
    end if;
  end if;
end;
$reef_effective_entitlement_check$;

-------------------------------------------------------------------------------
-- 2. Make the protected lifecycle guard cover both UPDATE and DELETE
-------------------------------------------------------------------------------

create or replace function private_app.protect_addon_subscription_lifecycle_v3()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A row that has ever been marked protected is never physically deleted,
  -- including after its access window ends. Expiry changes access, not data.
  if tg_op = 'DELETE'
     and old.lifecycle_protected_until is not null then
    raise exception 'protected_addon_subscription_lifecycle';
  end if;

  -- During the protection window, preserve the original lifecycle fields while
  -- still allowing unrelated metadata/payment-link maintenance on the row.
  if tg_op = 'UPDATE'
     and old.lifecycle_protected_until is not null
     and now() < old.lifecycle_protected_until
     and (
       new.status is distinct from old.status
       or new.source is distinct from old.source
       or new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end
       or new.trial_start is distinct from old.trial_start
       or new.trial_end is distinct from old.trial_end
       or new.activated_at is distinct from old.activated_at
       or new.ended_at is distinct from old.ended_at
       or new.cancel_at_period_end is distinct from old.cancel_at_period_end
       or new.auto_renew is distinct from old.auto_renew
       or new.period_is_authoritative is distinct from
          old.period_is_authoritative
       or new.lifecycle_protected_until is distinct from
          old.lifecycle_protected_until
     ) then
    raise exception 'protected_addon_subscription_lifecycle';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function
  private_app.protect_addon_subscription_lifecycle_v3()
from public, anon, authenticated, service_role;

-- Keep the existing UPDATE trigger. A separate trigger extends the same guard
-- to deletion without replacing an already-applied trigger definition.
create trigger tenant_addons_protect_delete_v3
before delete on catalog.tenant_addon_subscriptions
for each row execute function
  private_app.protect_addon_subscription_lifecycle_v3();

-------------------------------------------------------------------------------
-- 3. Privatize the original action and publish a strict compatibility wrapper
-------------------------------------------------------------------------------

alter function public.v3_platform_addon_center_action(text, jsonb)
  rename to v3_platform_addon_center_action_v3_legacy;

alter function public.v3_platform_addon_center_action_v3_legacy(text, jsonb)
  set schema private_app;

revoke all on function
  private_app.v3_platform_addon_center_action_v3_legacy(text, jsonb)
from public, anon, authenticated, service_role;

create or replace function public.v3_platform_addon_center_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_tenant_id uuid;
  v_tenant core.tenants%rowtype;
  v_product catalog.addon_products%rowtype;
  v_price catalog.addon_price_versions%rowtype;
  v_existing catalog.tenant_addon_subscriptions%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_currency text;
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'invalid_addon_action_payload';
  end if;

  -- No caller, including a platform operator, may bypass the database-enforced
  -- Reef protection window through an RPC flag.
  if v_payload ? 'forceProtected' then
    raise exception 'protected_override_not_supported';
  end if;

  if p_action is distinct from 'grant_subscription' then
    return private_app.v3_platform_addon_center_action_v3_legacy(
      p_action,
      v_payload
    );
  end if;

  -- Grants use the immutable tenant UUID only. Slugs are display identifiers
  -- and accepting both would make a mismatched pair select an arbitrary tenant.
  if v_payload ? 'tenantSlug' then
    raise exception 'tenant_slug_not_allowed_for_addon_grant';
  end if;
  if not (v_payload ? 'tenantId')
     or nullif(trim(v_payload ->> 'tenantId'), '') is null then
    raise exception 'tenant_id_required_for_addon_grant';
  end if;

  begin
    v_tenant_id := (v_payload ->> 'tenantId')::uuid;
    v_starts_at := coalesce(
      nullif(v_payload ->> 'startsAt', '')::timestamptz,
      now()
    );
    v_ends_at := nullif(v_payload ->> 'endsAt', '')::timestamptz;
  exception
    when invalid_text_representation
      or invalid_datetime_format
      or datetime_field_overflow then
      raise exception 'invalid_addon_grant';
  end;

  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id = v_tenant_id
  limit 1;

  select product.* into v_product
  from catalog.addon_products product
  where product.product_key = v_payload ->> 'productKey'
    and product.status in ('beta', 'active')
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if v_product.id is null then
    raise exception 'addon_product_not_found';
  end if;
  if v_ends_at is null or v_ends_at <= v_starts_at then
    raise exception 'invalid_addon_grant_period';
  end if;

  v_currency := upper(coalesce(
    nullif(trim(v_payload ->> 'currency'), ''),
    v_product.currency
  ));
  if v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid_addon_grant_currency';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_product.id::text || ':' || v_currency || ':year',
    0
  ));

  select price.* into v_price
  from catalog.addon_price_versions price
  where price.product_id = v_product.id
    and price.currency = v_currency
    and price.billing_interval = 'year'
    and price.valid_from <= v_starts_at::date
    and (price.valid_to is null or price.valid_to > v_starts_at::date)
  order by price.valid_from desc, price.id desc
  limit 1;

  if v_price.id is null then
    raise exception 'addon_price_not_found_for_currency';
  end if;

  select subscription.* into v_existing
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id = v_tenant.id
    and subscription.product_id = v_product.id
    and subscription.status in ('pending', 'trialing', 'active', 'paused')
  order by subscription.created_at desc
  limit 1
  for update;

  if v_existing.lifecycle_protected_until is not null
     and now() < v_existing.lifecycle_protected_until then
    raise exception 'protected_addon_subscription_lifecycle';
  end if;

  v_actor := private_app.current_subject_id();

  insert into catalog.tenant_addon_subscriptions as current_subscription (
    tenant_id,
    product_id,
    status,
    source,
    period_start,
    period_end,
    decision_note,
    cancel_at_period_end,
    price_version_id,
    auto_renew,
    activated_at,
    decided_by_subject_id
  ) values (
    v_tenant.id,
    v_product.id,
    'active',
    'platform',
    v_starts_at,
    v_ends_at,
    left(nullif(trim(v_payload ->> 'reason'), ''), 500),
    false,
    v_price.id,
    false,
    v_starts_at,
    v_actor
  ) on conflict (tenant_id, product_id)
    where status in ('pending', 'trialing', 'active', 'paused')
  do update set
    status = 'active',
    source = 'platform',
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    decision_note = excluded.decision_note,
    cancel_at_period_end = false,
    price_version_id = excluded.price_version_id,
    auto_renew = false,
    activated_at = coalesce(
      current_subscription.activated_at,
      excluded.activated_at
    ),
    ended_at = null,
    decided_by_subject_id = excluded.decided_by_subject_id,
    updated_at = now()
  returning * into v_subscription;

  insert into catalog.tenant_addon_subscription_events (
    subscription_id,
    tenant_id,
    product_id,
    event_key,
    event_type,
    from_status,
    to_status,
    effective_at,
    actor_subject_id,
    metadata
  ) values (
    v_subscription.id,
    v_subscription.tenant_id,
    v_subscription.product_id,
    'platform_grant:' || v_starts_at::text || ':' || v_ends_at::text,
    case when v_existing.id is null then 'activated' else 'renewed' end,
    v_existing.status,
    'active',
    v_starts_at,
    v_actor,
    jsonb_build_object(
      'endsAt', v_ends_at,
      'reason', left(nullif(trim(v_payload ->> 'reason'), ''), 500),
      'priceVersionId', v_price.id,
      'currency', v_price.currency,
      'preserveOperationalData', true
    )
  ) on conflict (tenant_id, product_id, event_key) do nothing;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    v_tenant.id,
    v_actor,
    'catalog.addon.platform_grant_hardened',
    'tenant_addon_subscription',
    v_subscription.id::text,
    jsonb_build_object(
      'tenantId', v_tenant.id,
      'productKey', v_product.product_key,
      'startsAt', v_starts_at,
      'endsAt', v_ends_at,
      'priceVersionId', v_price.id,
      'currency', v_price.currency,
      'tenantSlugAccepted', false,
      'protectedOverrideAccepted', false,
      'operationalRowsDeleted', false
    )
  );

  return jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'tenantId', v_tenant.id,
    'productKey', v_product.product_key,
    'status', v_subscription.status,
    'startsAt', v_subscription.period_start,
    'endsAt', v_subscription.period_end,
    'priceVersionId', v_price.id,
    'currency', v_price.currency
  );
end;
$$;

revoke all on function public.v3_platform_addon_center_action(text, jsonb)
from public, anon;
grant execute on function public.v3_platform_addon_center_action(text, jsonb)
to authenticated;

comment on function public.v3_platform_addon_center_action(text, jsonb) is
  'Hardened v3 action gateway. Grants require tenantId, deterministic annual currency pricing, and never accept protected lifecycle overrides.';

comment on function
  private_app.v3_platform_addon_center_action_v3_legacy(text, jsonb) is
  'Private v3 implementation retained for non-grant actions behind the hardened public wrapper.';

commit;
