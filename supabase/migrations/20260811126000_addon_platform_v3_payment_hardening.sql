-- Add-on platform v3 payment hardening.
--
-- This migration deliberately keeps every provider non-active until a future,
-- provider-native adapter migration replaces the guarded health promotion.
-- Existing RPC signatures remain present, but environment changes require the
-- new actor-attributed bundle contract and a complete credential rotation.

begin;

-------------------------------------------------------------------------------
-- 1. Bind configuration and Vault references to one explicit environment
-------------------------------------------------------------------------------

alter table marketplace.payment_provider_configs
  add column if not exists credentials_environment text,
  add column if not exists required_public_config_keys text[]
    not null default '{}'::text[];

alter table marketplace.payment_provider_secret_refs
  add column if not exists credentials_environment text;

alter table marketplace.payment_provider_configs
  add constraint payment_provider_credentials_environment_check_v3
    check (
      credentials_environment is null
      or credentials_environment in ('sandbox', 'live')
    ),
  add constraint payment_provider_required_public_keys_limit_v3
    check (cardinality(required_public_config_keys) between 0 and 20);

alter table marketplace.payment_provider_secret_refs
  add constraint payment_provider_secret_environment_check_v3
    check (
      credentials_environment is null
      or credentials_environment in ('sandbox', 'live')
    );

create index payment_provider_secret_environment_idx_v3
on marketplace.payment_provider_secret_refs (
  provider_key,
  credentials_environment,
  secret_key
);

-- Webhook verification material is required, not optional. Public merchant and
-- webhook identifiers are non-secret binding inputs and stay outside Vault.
update marketplace.payment_provider_configs
set required_secret_keys = array['apiToken', 'notificationToken']::text[],
    optional_secret_keys = '{}'::text[],
    required_public_config_keys = array['merchantId', 'webhookId']::text[],
    updated_at = now()
where provider_key = 'tamara';

update marketplace.payment_provider_configs
set required_secret_keys =
      array['secretKey', 'publicKey', 'hmacSecret']::text[],
    optional_secret_keys = array['apiKey']::text[],
    required_public_config_keys =
      array['merchantAccountId', 'integrationId']::text[],
    updated_at = now()
where provider_key = 'paymob';

update marketplace.payment_provider_configs
set required_secret_keys = array['clientId', 'clientSecret']::text[],
    optional_secret_keys = '{}'::text[],
    required_public_config_keys = array['merchantId', 'webhookId']::text[],
    updated_at = now()
where provider_key = 'paypal';

-- Legacy secret rows do not prove which environment supplied them. Fail closed
-- and require the next bundle save to rotate every required secret.
update marketplace.payment_provider_configs provider
set credentials_environment = null,
    status = case when provider.status = 'disabled' then 'disabled' else 'draft' end,
    last_verified_at = null,
    last_error_code = case
      when exists (
        select 1
        from marketplace.payment_provider_secret_refs secret_ref
        where secret_ref.provider_key = provider.provider_key
      ) then 'credentials_rotation_required'
      else null
    end,
    updated_at = now()
where provider.provider_key in ('tamara', 'paymob', 'paypal');

update marketplace.payment_provider_secret_refs
set credentials_environment = null,
    updated_at = now()
where provider_key in ('tamara', 'paymob', 'paypal');

-- Persist only stable, non-sensitive reason codes. Provider messages belong in
-- redacted observability, never in a configuration snapshot or audit context.
update marketplace.payment_provider_configs
set last_error_code = 'health_check_failed'
where last_error_code is not null
  and last_error_code not in (
    'adapter_not_deployed',
    'adapter_runtime_error',
    'configuration_incomplete',
    'credentials_invalid',
    'credentials_rotation_required',
    'environment_mismatch',
    'health_check_failed',
    'merchant_binding_failed',
    'provider_unavailable',
    'webhook_verification_failed'
  );

alter table marketplace.payment_provider_configs
  add constraint payment_provider_error_code_allowlist_v3
    check (
      last_error_code is null
      or last_error_code in (
        'adapter_not_deployed',
        'adapter_runtime_error',
        'configuration_incomplete',
        'credentials_invalid',
        'credentials_rotation_required',
        'environment_mismatch',
        'health_check_failed',
        'merchant_binding_failed',
        'provider_unavailable',
        'webhook_verification_failed'
      )
    );

-------------------------------------------------------------------------------
-- 2. Shared completeness and environment-bound Vault storage
-------------------------------------------------------------------------------

create or replace function private_app.v3_payment_provider_bundle_complete(
  p_provider_key text,
  p_environment text,
  p_credentials_environment text,
  p_required_secret_keys text[],
  p_required_public_config_keys text[],
  p_public_config jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_environment in ('sandbox', 'live')
    and p_credentials_environment = p_environment
    and jsonb_typeof(coalesce(p_public_config, '{}'::jsonb)) = 'object'
    and not exists (
      select 1
      from unnest(coalesce(p_required_secret_keys, '{}'::text[]))
        required(secret_key)
      where not exists (
        select 1
        from marketplace.payment_provider_secret_refs secret_ref
        where secret_ref.provider_key = p_provider_key
          and secret_ref.secret_key = required.secret_key
          and secret_ref.credentials_environment = p_environment
      )
    )
    and not exists (
      select 1
      from unnest(coalesce(p_required_public_config_keys, '{}'::text[]))
        required(config_key)
      where jsonb_typeof(p_public_config -> required.config_key) <> 'string'
         or nullif(trim(p_public_config ->> required.config_key), '') is null
         or length(p_public_config ->> required.config_key) > 240
    )
$$;

revoke all on function private_app.v3_payment_provider_bundle_complete(
  text,
  text,
  text,
  text[],
  text[],
  jsonb
) from public, anon, authenticated, service_role;

create or replace function private_app.v3_payment_provider_store_secret_v2(
  p_provider_key text,
  p_environment text,
  p_secret_key text,
  p_secret_value text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_ref marketplace.payment_provider_secret_refs%rowtype;
  v_vault_id uuid;
  v_vault_name text;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  if p_environment not in ('sandbox', 'live') then
    raise exception 'invalid_payment_provider_environment';
  end if;
  if p_secret_value is null
     or length(p_secret_value) not between 1 and 8192 then
    raise exception 'invalid_payment_provider_secret';
  end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = p_provider_key
  for update;
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;
  if not (
    p_secret_key = any(v_provider.required_secret_keys)
    or p_secret_key = any(v_provider.optional_secret_keys)
  ) then raise exception 'payment_provider_secret_key_not_allowed'; end if;

  select secret_ref.* into v_ref
  from marketplace.payment_provider_secret_refs secret_ref
  where secret_ref.provider_key = p_provider_key
    and secret_ref.secret_key = p_secret_key
  for update;

  v_vault_name := 'marketplace_' || p_provider_key || '_' ||
    p_environment || '_' ||
    lower(regexp_replace(p_secret_key, '[^A-Za-z0-9]+', '_', 'g'));

  if v_ref.vault_secret_id is null then
    v_vault_id := vault.create_secret(
      p_secret_value,
      v_vault_name,
      'Environment-bound payment credential. Never return to clients.'
    );
    insert into marketplace.payment_provider_secret_refs (
      provider_key,
      secret_key,
      vault_secret_id,
      credentials_environment,
      last_rotated_at
    ) values (
      p_provider_key,
      p_secret_key,
      v_vault_id,
      p_environment,
      now()
    );
  else
    perform vault.update_secret(
      v_ref.vault_secret_id,
      p_secret_value,
      v_vault_name,
      'Environment-bound payment credential. Never return to clients.'
    );
    v_vault_id := v_ref.vault_secret_id;
    update marketplace.payment_provider_secret_refs
    set credentials_environment = p_environment,
        last_rotated_at = now(),
        updated_at = now()
    where provider_key = p_provider_key
      and secret_key = p_secret_key;
  end if;

  return v_vault_id;
end;
$$;

revoke all on function private_app.v3_payment_provider_store_secret_v2(
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 3. Database guard: configured is not active, and active is fail-closed
-------------------------------------------------------------------------------

create or replace function private_app.v3_payment_provider_config_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.environment is distinct from old.environment
     and new.credentials_environment is distinct from new.environment then
    new.status := case when new.status = 'disabled' then 'disabled' else 'draft' end;
    new.last_verified_at := null;
    new.last_error_code := 'credentials_rotation_required';
  end if;

  if new.status = 'active' then
    raise exception 'payment_provider_native_adapter_not_deployed';
  end if;

  if new.status = 'configured'
     and not private_app.v3_payment_provider_bundle_complete(
       new.provider_key,
       new.environment,
       new.credentials_environment,
       new.required_secret_keys,
       new.required_public_config_keys,
       new.public_config
     ) then
    raise exception 'payment_provider_configuration_incomplete';
  end if;

  return new;
end;
$$;

revoke all on function private_app.v3_payment_provider_config_guard()
from public, anon, authenticated, service_role;

create trigger payment_provider_configs_hardening_guard_v3
before insert or update on marketplace.payment_provider_configs
for each row execute function private_app.v3_payment_provider_config_guard();

-------------------------------------------------------------------------------
-- 4. Atomic core and actor-attributed service overload
-------------------------------------------------------------------------------

create or replace function private_app.v3_payment_provider_bundle_core(
  p_provider_key text,
  p_environment text,
  p_checkout_mode text,
  p_supported_currencies text[],
  p_enabled boolean,
  p_public_config jsonb,
  p_secrets jsonb,
  p_actor_subject_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_secret record;
  v_currencies text[];
  v_public_config jsonb;
  v_environment_changed boolean;
  v_secret_complete boolean;
  v_public_complete boolean;
  v_complete boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = p_provider_key
  for update;
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;
  if p_environment not in ('sandbox', 'live') then
    raise exception 'invalid_payment_provider_environment';
  end if;
  if p_checkout_mode not in ('redirect', 'embedded', 'api') then
    raise exception 'invalid_payment_provider_checkout_mode';
  end if;
  if jsonb_typeof(coalesce(p_secrets, '{}'::jsonb)) <> 'object'
     or jsonb_object_length(coalesce(p_secrets, '{}'::jsonb)) > 20 then
    raise exception 'invalid_payment_provider_secrets';
  end if;
  if jsonb_typeof(coalesce(p_public_config, '{}'::jsonb)) <> 'object'
     or jsonb_object_length(coalesce(p_public_config, '{}'::jsonb)) > 30
     or private_app.jsonb_has_sensitive_key(
       coalesce(p_public_config, '{}'::jsonb)
     ) then
    raise exception 'sensitive_payment_provider_config_rejected';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(coalesce(p_public_config, '{}'::jsonb))
      submitted(config_key)
    where not (
      submitted.config_key = any(
        coalesce(v_provider.required_public_config_keys, '{}'::text[])
      )
    )
  ) then
    raise exception 'payment_provider_public_config_key_not_allowed';
  end if;

  select array_agg(currency order by currency)
  into v_currencies
  from (
    select distinct upper(trim(value)) as currency
    from unnest(coalesce(p_supported_currencies, '{}'::text[])) item(value)
    where nullif(trim(value), '') is not null
  ) normalized;
  if v_currencies is null
     or cardinality(v_currencies) not between 1 and 20
     or exists (
       select 1 from unnest(v_currencies) currency
       where currency !~ '^[A-Z]{3}$'
     ) then raise exception 'invalid_payment_provider_currencies'; end if;

  for v_secret in
    select item.key, item.value
    from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) item
  loop
    if not (
      v_secret.key = any(v_provider.required_secret_keys)
      or v_secret.key = any(v_provider.optional_secret_keys)
    )
       or jsonb_typeof(v_secret.value) <> 'string'
       or length(v_secret.value #>> '{}') not between 1 and 8192 then
      raise exception 'invalid_payment_provider_secret';
    end if;
  end loop;

  v_environment_changed :=
    v_provider.environment is distinct from p_environment
    or v_provider.credentials_environment is distinct from p_environment;

  if v_environment_changed and exists (
    select 1
    from unnest(v_provider.required_secret_keys) required(secret_key)
    where not (coalesce(p_secrets, '{}'::jsonb) ? required.secret_key)
       or jsonb_typeof(p_secrets -> required.secret_key) <> 'string'
       or nullif(trim(p_secrets ->> required.secret_key), '') is null
  ) then
    raise exception 'payment_provider_full_secret_rotation_required';
  end if;

  -- An optional secret that has ever been configured participates in an
  -- environment change too. This prevents an old sandbox value becoming
  -- usable again merely because the operator later switches back to sandbox.
  if v_environment_changed and exists (
    select 1
    from unnest(coalesce(v_provider.optional_secret_keys, '{}'::text[]))
      optional(secret_key)
    where exists (
      select 1
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = p_provider_key
        and secret_ref.secret_key = optional.secret_key
    )
      and not (
        coalesce(p_secrets, '{}'::jsonb) ? optional.secret_key
      )
  ) then
    raise exception 'payment_provider_full_secret_rotation_required';
  end if;

  if v_environment_changed and exists (
    select 1
    from unnest(v_provider.required_public_config_keys) required(config_key)
    where not (coalesce(p_public_config, '{}'::jsonb) ? required.config_key)
       or jsonb_typeof(p_public_config -> required.config_key) <> 'string'
       or nullif(trim(p_public_config ->> required.config_key), '') is null
  ) then
    raise exception 'payment_provider_full_public_config_required';
  end if;

  v_public_config := v_provider.public_config ||
    coalesce(p_public_config, '{}'::jsonb);
  if exists (
    select 1
    from unnest(v_provider.required_public_config_keys) required(config_key)
    where jsonb_typeof(v_public_config -> required.config_key) <> 'string'
       or nullif(trim(v_public_config ->> required.config_key), '') is null
       or length(v_public_config ->> required.config_key) > 240
  ) then
    raise exception 'payment_provider_public_config_incomplete';
  end if;

  for v_secret in
    select item.key, item.value
    from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) item
  loop
    perform private_app.v3_payment_provider_store_secret_v2(
      p_provider_key,
      p_environment,
      v_secret.key,
      v_secret.value #>> '{}'
    );
  end loop;

  select not exists (
    select 1
    from unnest(v_provider.required_secret_keys) required(secret_key)
    where not exists (
      select 1
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = p_provider_key
        and secret_ref.secret_key = required.secret_key
        and secret_ref.credentials_environment = p_environment
    )
  ) into v_secret_complete;

  select not exists (
    select 1
    from unnest(v_provider.required_public_config_keys) required(config_key)
    where jsonb_typeof(v_public_config -> required.config_key) <> 'string'
       or nullif(trim(v_public_config ->> required.config_key), '') is null
       or length(v_public_config ->> required.config_key) > 240
  ) into v_public_complete;
  v_complete := v_secret_complete and v_public_complete;

  update marketplace.payment_provider_configs
  set environment = p_environment,
      credentials_environment = case
        when v_secret_complete then p_environment
        else null
      end,
      checkout_mode = p_checkout_mode,
      supported_currencies = v_currencies,
      public_config = v_public_config,
      status = case
        when not coalesce(p_enabled, true) then 'disabled'
        when v_complete then 'configured'
        else 'draft'
      end,
      last_verified_at = null,
      last_error_code = case
        when v_complete then null
        else 'configuration_incomplete'
      end,
      updated_at = now()
  where provider_key = p_provider_key
  returning * into v_provider;

  insert into audit_log.events (
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    p_actor_subject_id,
    'marketplace.payment_provider.bundle_saved_v2',
    'payment_provider',
    p_provider_key,
    jsonb_build_object(
      'environment', v_provider.environment,
      'credentialsEnvironment', v_provider.credentials_environment,
      'environmentChanged', v_environment_changed,
      'checkoutMode', v_provider.checkout_mode,
      'status', v_provider.status,
      'configured', v_complete,
      'actorAttributed', p_actor_subject_id is not null,
      'secretKeysSubmitted', coalesce((
        select jsonb_agg(item.key order by item.key)
        from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) item
      ), '[]'::jsonb),
      'publicConfigKeysSubmitted', coalesce((
        select jsonb_agg(item.key order by item.key)
        from jsonb_each(coalesce(p_public_config, '{}'::jsonb)) item
      ), '[]'::jsonb),
      'secretReturned', false
    )
  );

  return jsonb_build_object(
    'providerKey', v_provider.provider_key,
    'status', v_provider.status,
    'environment', v_provider.environment,
    'credentialsEnvironment', v_provider.credentials_environment,
    'configured', v_complete,
    'requiredPublicConfigKeys',
      to_jsonb(v_provider.required_public_config_keys),
    'configuredPublicConfig', coalesce((
      select jsonb_object_agg(
        required.config_key,
        v_provider.public_config -> required.config_key
      )
      from unnest(v_provider.required_public_config_keys)
        required(config_key)
      where jsonb_typeof(
        v_provider.public_config -> required.config_key
      ) = 'string'
    ), '{}'::jsonb),
    'secretReturned', false
  );
end;
$$;

revoke all on function private_app.v3_payment_provider_bundle_core(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb,
  jsonb,
  uuid
) from public, anon, authenticated, service_role;

-- New, actor-attributed contract. The actor is resolved with the caller JWT by
-- v3_platform_payment_provider_admin_snapshot before this service-role call.
create or replace function public.v3_service_payment_provider_bundle_action(
  p_provider_key text,
  p_environment text,
  p_checkout_mode text,
  p_supported_currencies text[],
  p_enabled boolean,
  p_public_config jsonb,
  p_secrets jsonb,
  p_actor_subject_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  if p_actor_subject_id is null or not exists (
    select 1
    from access_control.subjects subject
    where subject.id = p_actor_subject_id
  ) then raise exception 'payment_provider_actor_required'; end if;

  return private_app.v3_payment_provider_bundle_core(
    p_provider_key,
    p_environment,
    p_checkout_mode,
    p_supported_currencies,
    p_enabled,
    p_public_config,
    p_secrets,
    p_actor_subject_id
  );
end;
$$;

revoke all on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb,
  jsonb,
  uuid
) from public, anon, authenticated, service_role;
grant execute on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb,
  jsonb,
  uuid
) to service_role;

-- Keep the original six-argument signature so stale deployments fail with a
-- stable upgrade error instead of a missing-function error. It is deliberately
-- not executable by service_role because it cannot attribute an operator.
create or replace function public.v3_service_payment_provider_bundle_action(
  p_provider_key text,
  p_environment text,
  p_checkout_mode text,
  p_supported_currencies text[],
  p_enabled boolean,
  p_secrets jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  raise exception 'payment_provider_admin_contract_upgrade_required';
end;
$$;

revoke all on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb
) from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 5. Retain but close the unattributed legacy one-secret service RPC
-------------------------------------------------------------------------------

create or replace function public.v3_service_payment_provider_secret_action(
  p_action text,
  p_provider_key text,
  p_secret_key text,
  p_secret_value text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  raise exception 'payment_provider_actor_attribution_required';
end;
$$;

revoke all on function public.v3_service_payment_provider_secret_action(
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 6. Native adapter activation remains explicitly closed
-------------------------------------------------------------------------------

create or replace function public.v3_service_payment_provider_health_action(
  p_provider_key text,
  p_ok boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_error_code text;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = p_provider_key
  for update;
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;

  if coalesce(p_ok, false) then
    raise exception 'payment_provider_native_adapter_not_deployed';
  end if;

  v_error_code := coalesce(
    nullif(trim(p_error_code), ''),
    'health_check_failed'
  );
  if v_error_code not in (
    'adapter_not_deployed',
    'adapter_runtime_error',
    'configuration_incomplete',
    'credentials_invalid',
    'credentials_rotation_required',
    'environment_mismatch',
    'health_check_failed',
    'merchant_binding_failed',
    'provider_unavailable',
    'webhook_verification_failed'
  ) then raise exception 'invalid_payment_provider_error_code'; end if;

  update marketplace.payment_provider_configs
  set status = case when status = 'disabled' then 'disabled' else 'error' end,
      last_verified_at = null,
      last_error_code = v_error_code,
      updated_at = now()
  where provider_key = p_provider_key
  returning * into v_provider;

  insert into audit_log.events (
    action,
    resource_type,
    resource_id,
    context
  ) values (
    'marketplace.payment_provider.health_check_blocked',
    'payment_provider',
    p_provider_key,
    jsonb_build_object(
      'ok', false,
      'status', v_provider.status,
      'environment', v_provider.environment,
      'errorCode', v_provider.last_error_code,
      'nativeAdapterDeployed', false
    )
  );

  return jsonb_build_object(
    'providerKey', p_provider_key,
    'status', v_provider.status,
    'verifiedAt', null,
    'errorCode', v_provider.last_error_code,
    'active', false
  );
end;
$$;

revoke all on function public.v3_service_payment_provider_health_action(
  text,
  boolean,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.v3_service_payment_provider_health_action(
  text,
  boolean,
  text
) to service_role;

-------------------------------------------------------------------------------
-- 7. Narrow authenticated snapshot for Edge authorization and admin UI
-------------------------------------------------------------------------------

create or replace function public.v3_platform_payment_provider_admin_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;

  return jsonb_build_object(
    'schemaVersion', 3,
    'actorSubjectId', v_actor,
    'generatedAt', now(),
    'paymentProviders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', provider.provider_key,
        'name', provider.name_ar,
        'nameEn', provider.name_en,
        'status', provider.status,
        'environment', provider.environment,
        'credentialsEnvironment', provider.credentials_environment,
        'checkoutMode', provider.checkout_mode,
        'supportedCurrencies', to_jsonb(provider.supported_currencies),
        'requiredSecretKeys', to_jsonb(provider.required_secret_keys),
        'optionalSecretKeys', to_jsonb(provider.optional_secret_keys),
        'configuredSecretKeys', coalesce((
          select jsonb_agg(secret_ref.secret_key order by secret_ref.secret_key)
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = provider.provider_key
            and secret_ref.credentials_environment =
              provider.credentials_environment
        ), '[]'::jsonb),
        'requiredPublicConfigKeys',
          to_jsonb(provider.required_public_config_keys),
        'configuredPublicConfig', coalesce((
          select jsonb_object_agg(
            required.config_key,
            provider.public_config -> required.config_key
          )
          from unnest(provider.required_public_config_keys)
            required(config_key)
          where jsonb_typeof(
            provider.public_config -> required.config_key
          ) = 'string'
        ), '{}'::jsonb),
        'configured', private_app.v3_payment_provider_bundle_complete(
          provider.provider_key,
          provider.environment,
          provider.credentials_environment,
          provider.required_secret_keys,
          provider.required_public_config_keys,
          provider.public_config
        ),
        'requiresFullRotation',
          provider.credentials_environment is distinct from provider.environment,
        'verifiedAt', provider.last_verified_at,
        'lastErrorCode', provider.last_error_code,
        'nativeAdapterDeployed', false,
        'active', false
      ) order by provider.sort_order)
      from marketplace.payment_provider_configs provider
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.v3_platform_payment_provider_admin_snapshot()
from public, anon, authenticated, service_role;
grant execute on function public.v3_platform_payment_provider_admin_snapshot()
to authenticated;

comment on column marketplace.payment_provider_configs.credentials_environment
is 'The one environment to which the complete current credential bundle is bound.';
comment on column marketplace.payment_provider_configs.required_public_config_keys
is 'Required non-secret merchant and webhook identifiers used for provider binding.';
comment on column marketplace.payment_provider_secret_refs.credentials_environment
is 'Environment proven by a full bundle rotation; null legacy rows are unusable.';
comment on function public.v3_platform_payment_provider_admin_snapshot()
is 'Permission-gated provider admin contract. Returns actor and non-secret configuration only.';
comment on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb,
  jsonb,
  uuid
)
is 'Actor-attributed atomic provider bundle save. Secret values go directly to environment-bound Vault entries and are never returned.';
comment on function public.v3_service_payment_provider_health_action(
  text,
  boolean,
  text
)
is 'Fail-closed until a provider-native adapter migration supplies cryptographic activation evidence.';

commit;
