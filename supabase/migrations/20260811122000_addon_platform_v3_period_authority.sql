-- Add-on platform v3 follow-up: make explicitly selected periods authoritative
-- without changing the additive plan/subscription semantics for other tenants.

begin;

alter table catalog.tenant_addon_subscriptions
  add column if not exists period_is_authoritative boolean
    not null default false,
  add column if not exists lifecycle_protected_until timestamptz;

alter table catalog.tenant_addon_subscriptions
  add constraint tenant_addons_protection_window_check_v3
    check (
      lifecycle_protected_until is null
      or (
        period_end is not null
        and lifecycle_protected_until <= period_end
      )
    ) not valid;

-- Only the launch-year Reef grant overrides bundled-plan access. Other plans,
-- subscriptions and explicit tenant overrides retain their existing precedence.
update catalog.tenant_addon_subscriptions subscription
set period_is_authoritative = true,
    lifecycle_protected_until = subscription.period_end,
    updated_at = now()
from core.tenants tenant
where tenant.id = subscription.tenant_id
  and tenant.tenant_key = 'tenant-reef-skills'
  and tenant.slug = 'reef-skills'
  and subscription.status = 'active'
  and subscription.period_start =
    timestamptz '2026-08-01 00:00:00+03'
  and subscription.period_end =
    timestamptz '2027-08-01 00:00:00+03';

do $reef_authority_check$
declare
  v_expected integer;
  v_authoritative integer;
begin
  select count(*) into v_expected
  from catalog.addon_products product
  where product.status in ('beta', 'active');

  select count(*) into v_authoritative
  from catalog.tenant_addon_subscriptions subscription
  join core.tenants tenant on tenant.id = subscription.tenant_id
  where tenant.tenant_key = 'tenant-reef-skills'
    and tenant.slug = 'reef-skills'
    and subscription.period_is_authoritative
    and subscription.lifecycle_protected_until =
      timestamptz '2027-08-01 00:00:00+03';

  if v_authoritative <> v_expected then
    raise exception 'reef_authoritative_period_incomplete';
  end if;
end;
$reef_authority_check$;

create or replace function private_app.protect_addon_subscription_lifecycle_v3()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.lifecycle_protected_until is not null
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
  return new;
end;
$$;

revoke all on function
  private_app.protect_addon_subscription_lifecycle_v3()
from public, anon, authenticated, service_role;

create trigger tenant_addons_protect_lifecycle_v3
before update on catalog.tenant_addon_subscriptions
for each row execute function
  private_app.protect_addon_subscription_lifecycle_v3();

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
  v_enabled := coalesce((v_result ->> 'enabled')::boolean, false);
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

revoke all on function private_app.addon_entitlement_v3(uuid, text)
from public, anon, authenticated, service_role;

comment on column
  catalog.tenant_addon_subscriptions.period_is_authoritative is
  'When true, the dated add-on license controls access ahead of a bundled plan; explicit tenant overrides remain authoritative.';

comment on column
  catalog.tenant_addon_subscriptions.lifecycle_protected_until is
  'Before this instant, lifecycle fields cannot be changed by ordinary actions. Operational add-on data is never deleted.';

commit;
