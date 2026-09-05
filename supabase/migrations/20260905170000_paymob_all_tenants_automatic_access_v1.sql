begin;

-- ODEIR Paymob access policy v1
--
-- The payment adapter remains globally fail-closed: provider readiness,
-- environment, credential version, Vault references, signed webhooks,
-- idempotency, amount binding, reconciliation and refund controls are not
-- weakened. This migration changes only tenant access from an allow-list to an
-- explicit all-tenants policy with a global kill switch and optional explicit
-- per-tenant disable override.

do $paymob_all_tenants_preflight$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_version marketplace.paymob_credential_versions%rowtype;
begin
  if to_regclass('core.tenants') is null
     or to_regclass('marketplace.payment_provider_configs') is null
     or to_regclass('marketplace.payment_tenant_rollouts') is null
     or to_regclass('marketplace.paymob_credential_versions') is null
     or to_regprocedure('private_app.paymob_required_secret_refs_valid_v2(uuid,text,text)') is null
     or to_regprocedure('private_app.paymob_tenant_checkout_eligible_v1(uuid,text)') is null
     or to_regprocedure('private_app.paymob_live_canary_eligible_v1(uuid,text)') is null then
    raise exception 'paymob_all_tenants_prerequisite_missing';
  end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for update;

  if v_provider.provider_key is null
     or v_provider.environment <> 'live'
     or v_provider.credentials_environment <> 'live'
     or v_provider.checkout_mode <> 'redirect'
     or coalesce(v_provider.public_config ->> 'integrationPath','') <> 'quicklink'
     or coalesce(v_provider.public_config ->> 'integrationId','') !~ '^[0-9]{1,20}$'
     or coalesce(v_provider.public_config ->> 'merchantAccountId','') !~ '^[0-9]{1,40}$' then
    raise exception 'paymob_all_tenants_provider_not_ready';
  end if;

  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.environment = 'live'
    and version.status = 'active'
    and version.revoked_at is null
    and version.checkout_flow = 'quicklink'
  order by version.valid_from desc,version.created_at desc,version.id desc
  limit 1
  for update;

  if v_version.id is null
     or v_version.integration_id <> v_provider.public_config ->> 'integrationId'
     or v_version.owner_id <> v_provider.public_config ->> 'merchantAccountId'
     or not private_app.paymob_required_secret_refs_valid_v2(
       v_version.id,v_version.environment,v_version.checkout_flow
     ) then
    raise exception 'paymob_all_tenants_credentials_not_ready';
  end if;

  if exists (
    select 1
    from marketplace.payment_attempts attempt
    where attempt.provider_key = 'paymob'
      and attempt.environment = 'live'
      and attempt.status in ('creating_intention','unknown','quarantined')
  ) then
    raise exception 'paymob_all_tenants_unresolved_attempts_present';
  end if;
end
$paymob_all_tenants_preflight$;

-- The policy is explicit and observable in provider configuration. Provider
-- status and rollout_mode remain the global emergency stop.
update marketplace.payment_provider_configs provider
set status = 'active',
    environment = 'live',
    credentials_environment = 'live',
    rollout_mode = 'live',
    checkout_mode = 'redirect',
    public_config = jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(provider.public_config,'{}'::jsonb),
          '{tenantAccessPolicy}',
          '"all_tenants"'::jsonb,
          true
        ),
        '{autoEnableNewTenants}',
        'true'::jsonb,
        true
      ),
      '{tenantAccessPolicyVersion}',
      '1'::jsonb,
      true
    ),
    updated_at = now()
where provider.provider_key = 'paymob';

-- Existing explicit rows are normalized to enabled. New tenants do not require
-- a row: the policy function below derives access from tenant existence. A
-- future deliberate `disabled` row remains an emergency per-tenant override.
update marketplace.payment_tenant_rollouts rollout
set status = 'enabled',
    updated_at = now()
where rollout.provider_key = 'paymob'
  and rollout.environment = 'live'
  and rollout.status <> 'enabled';

create or replace function private_app.paymob_global_tenant_access_enabled_v1(
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from marketplace.payment_provider_configs provider
    join lateral (
      select version.id,version.environment,version.checkout_flow
      from marketplace.paymob_credential_versions version
      where version.provider_key = provider.provider_key
        and version.environment = p_environment
        and version.status = 'active'
        and version.revoked_at is null
        and version.checkout_flow = 'quicklink'
        and version.integration_id = provider.public_config ->> 'integrationId'
        and version.owner_id = provider.public_config ->> 'merchantAccountId'
      order by version.valid_from desc,version.created_at desc,version.id desc
      limit 1
    ) active_version on true
    where provider.provider_key = 'paymob'
      and p_environment in ('sandbox','live')
      and provider.status = 'active'
      and provider.environment = p_environment
      and provider.credentials_environment = p_environment
      and provider.rollout_mode = p_environment
      and provider.checkout_mode = 'redirect'
      and provider.public_config ->> 'integrationPath' = 'quicklink'
      and provider.public_config ->> 'tenantAccessPolicy' = 'all_tenants'
      and coalesce((provider.public_config ->> 'autoEnableNewTenants')::boolean,false)
      and private_app.paymob_required_secret_refs_valid_v2(
        active_version.id,active_version.environment,active_version.checkout_flow
      )
  );
$function$;

create or replace function private_app.paymob_tenant_checkout_eligible_v1(
  p_tenant_id uuid,
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    p_tenant_id is not null
    and exists (
      select 1
      from core.tenants tenant
      where tenant.id = p_tenant_id
    )
    and private_app.paymob_global_tenant_access_enabled_v1(p_environment)
    and not exists (
      select 1
      from marketplace.payment_tenant_rollouts rollout
      where rollout.provider_key = 'paymob'
        and rollout.tenant_id = p_tenant_id
        and rollout.environment = p_environment
        and rollout.status = 'disabled'
    );
$function$;

-- Compatibility alias for older guarded code paths. The legacy name no longer
-- represents a one-tenant canary; it delegates to the governed global policy.
create or replace function private_app.paymob_live_canary_eligible_v1(
  p_tenant_id uuid,
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_environment = 'live'
    and private_app.paymob_tenant_checkout_eligible_v1(
      p_tenant_id,p_environment
    );
$function$;

revoke all on function private_app.paymob_global_tenant_access_enabled_v1(text)
  from public,anon,authenticated;
revoke all on function private_app.paymob_tenant_checkout_eligible_v1(uuid,text)
  from public,anon,authenticated;
revoke all on function private_app.paymob_live_canary_eligible_v1(uuid,text)
  from public,anon,authenticated;
grant execute on function private_app.paymob_global_tenant_access_enabled_v1(text)
  to service_role;
grant execute on function private_app.paymob_tenant_checkout_eligible_v1(uuid,text)
  to service_role;
grant execute on function private_app.paymob_live_canary_eligible_v1(uuid,text)
  to service_role;

insert into audit_log.events(
  actor_subject_id,action,resource_type,resource_id,context
)
values (
  null,
  'marketplace.paymob.tenant_access_policy_changed',
  'payment_provider',
  'paymob',
  jsonb_build_object(
    'environment','live',
    'policy','all_tenants',
    'autoEnableNewTenants',true,
    'existingTenantCount',(select count(*) from core.tenants),
    'globalKillSwitch','payment_provider_configs.status/rollout_mode',
    'explicitTenantDisableSupported',true,
    'changedBy','governed_production_migration'
  )
);

do $paymob_all_tenants_postflight$
declare
  v_total bigint;
  v_eligible bigint;
  v_disabled bigint;
begin
  select count(*) into v_total from core.tenants;
  select count(*) into v_eligible
  from core.tenants tenant
  where private_app.paymob_tenant_checkout_eligible_v1(tenant.id,'live');
  select count(*) into v_disabled
  from marketplace.payment_tenant_rollouts rollout
  where rollout.provider_key='paymob'
    and rollout.environment='live'
    and rollout.status='disabled';

  if not private_app.paymob_global_tenant_access_enabled_v1('live')
     or v_disabled <> 0
     or v_total <> v_eligible then
    raise exception 'paymob_all_tenants_postflight_failed_%_%_%',
      v_total,v_eligible,v_disabled;
  end if;
end
$paymob_all_tenants_postflight$;

comment on function private_app.paymob_global_tenant_access_enabled_v1(text) is
  'Global fail-closed Paymob access policy. All current and future tenants inherit access while provider readiness remains valid.';
comment on function private_app.paymob_tenant_checkout_eligible_v1(uuid,text) is
  'Paymob tenant eligibility under the global all-tenants policy, with an explicit disabled-row override.';

commit;
