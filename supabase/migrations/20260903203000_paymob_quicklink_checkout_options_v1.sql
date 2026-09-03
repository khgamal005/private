begin;

-- Additive route metadata. Existing Intention attempts remain valid without a
-- data rewrite; QuickLink bindings are written only by the V2 prepare RPC.
alter table marketplace.paymob_credential_versions
  add column checkout_flow text not null default 'intention'
    check (checkout_flow in ('intention','quicklink')),
  add column apple_pay_integration_id text
    check (
      apple_pay_integration_id is null
      or apple_pay_integration_id ~ '^[1-9][0-9]{0,29}$'
    ),
  add constraint paymob_credential_distinct_integration_ids_v2
    check (
      apple_pay_integration_id is null
      or apple_pay_integration_id <> integration_id
    );

alter table marketplace.payment_attempts
  add column checkout_flow text not null default 'intention'
    check (checkout_flow in ('intention','quicklink')),
  add column payment_option text not null default 'hosted'
    check (payment_option in ('hosted','card','apple_pay')),
  add column selected_integration_id text
    check (
      selected_integration_id is null
      or selected_integration_id ~ '^[1-9][0-9]{0,29}$'
    ),
  add constraint payment_attempt_checkout_route_v2 check (
    (
      checkout_flow = 'intention'
      and payment_option = 'hosted'
      and selected_integration_id is null
    )
    or (
      checkout_flow = 'quicklink'
      and payment_option in ('card','apple_pay')
      and selected_integration_id is not null
    )
  );

comment on column marketplace.payment_attempts.selected_integration_id is
  'Immutable server-selected Paymob integration binding; never accepted from or returned to storefront clients.';

create or replace function private_app.paymob_version_matches_provider_v2(
  p_version_id uuid,
  p_environment text,
  p_public_config jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from marketplace.paymob_credential_versions version
    where version.id = p_version_id
      and version.provider_key = 'paymob'
      and version.environment = p_environment
      and version.integration_id = p_public_config ->> 'integrationId'
      and version.owner_id = p_public_config ->> 'merchantAccountId'
      and version.checkout_flow =
        coalesce(p_public_config ->> 'integrationPath','intention')
      and version.apple_pay_integration_id is not distinct from
        nullif(p_public_config ->> 'applePayIntegrationId','')
  )
$$;

revoke all on function private_app.paymob_version_matches_provider_v2(
  uuid,text,jsonb
) from public,anon,authenticated,service_role;

create or replace function private_app.paymob_quicklink_checkout_url_valid_v1(
  p_url text
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select length(coalesce(p_url,'')) between 80 and 8192
    and coalesce(p_url,'') ~
      '^https://ksa[.]paymob[.]com/api/ecommerce/payment-links/unrestricted[?]token=([A-Za-z0-9+/_=-]|%[0-9A-Fa-f]{2})+$'
$$;

revoke all on function private_app.paymob_quicklink_checkout_url_valid_v1(text)
from public,anon,authenticated,service_role;

-- The shared provider core historically treats required_public_config_keys as
-- both the allowlist and completeness list. Paymob now has two route metadata
-- keys that are intentionally optional for backward compatibility, so patch
-- the existing core narrowly: admit only those Paymob keys and interpret an
-- explicit JSON null as a governed deletion instead of retaining stale data.
do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'private_app.v3_payment_provider_bundle_core(text,text,text,text[],boolean,jsonb,jsonb,uuid)'
  );
  v_definition text;
  v_allow_needle constant text := $needle$    where not (
      submitted.config_key = any(
        coalesce(v_provider.required_public_config_keys, '{}'::text[])
      )
    )$needle$;
  v_allow_replacement constant text := $replacement$    where not (
      submitted.config_key = any(
        coalesce(v_provider.required_public_config_keys, '{}'::text[])
      )
      or (
        p_provider_key = 'paymob'
        and submitted.config_key in (
          'integrationPath','applePayIntegrationId'
        )
      )
    )$replacement$;
  v_merge_needle constant text := $needle$  v_public_config := v_provider.public_config ||
    coalesce(p_public_config, '{}'::jsonb);$needle$;
  v_merge_replacement constant text := $replacement$  v_public_config := v_provider.public_config ||
    coalesce(p_public_config, '{}'::jsonb);
  if p_provider_key = 'paymob'
     and coalesce(p_public_config, '{}'::jsonb) ? 'applePayIntegrationId'
     and jsonb_typeof(p_public_config -> 'applePayIntegrationId') = 'null' then
    v_public_config := v_public_config - 'applePayIntegrationId';
  end if;$replacement$;
  v_allow_occurrences integer;
  v_merge_occurrences integer;
begin
  if v_signature is null then
    raise exception 'payment_provider_bundle_core_missing';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  v_allow_occurrences := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition,v_allow_needle,''))
  ) / pg_catalog.length(v_allow_needle);
  v_merge_occurrences := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition,v_merge_needle,''))
  ) / pg_catalog.length(v_merge_needle);
  if v_allow_occurrences <> 1 or v_merge_occurrences <> 1 then
    raise exception 'payment_provider_optional_config_patch_precondition_failed';
  end if;
  v_definition := pg_catalog.replace(
    pg_catalog.replace(
      v_definition,v_allow_needle,v_allow_replacement
    ),
    v_merge_needle,v_merge_replacement
  );
  execute v_definition;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if pg_catalog.strpos(v_definition,v_allow_replacement) = 0
     or pg_catalog.strpos(v_definition,v_merge_replacement) = 0 then
    raise exception 'payment_provider_optional_config_patch_verification_failed';
  end if;
end;
$migration$;


create or replace function private_app.paymob_finalize_credential_version_v2(
  p_environment text,
  p_integration_id text,
  p_owner_id text,
  p_checkout_flow text,
  p_apple_pay_integration_id text,
  p_actor_subject_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current marketplace.paymob_credential_versions%rowtype;
  v_retiring marketplace.paymob_credential_versions%rowtype;
  v_new_hmac_id uuid;
  v_new_api_key_id uuid;
  v_new_secret_key_id uuid;
  v_new_public_key_id uuid;
  v_billing_digest_id uuid;
  v_new_hmac text;
  v_old_hmac text;
  v_version_id uuid;
  v_historical_integration_count integer;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  p_checkout_flow := lower(btrim(coalesce(p_checkout_flow,'intention')));
  p_apple_pay_integration_id := nullif(btrim(p_apple_pay_integration_id),'');
  if p_environment not in ('sandbox','live')
     or p_integration_id !~ '^[1-9][0-9]{0,29}$'
     or p_owner_id !~ '^[1-9][0-9]{0,29}$'
     or p_checkout_flow not in ('intention','quicklink')
     or (
       p_apple_pay_integration_id is not null
       and (
         p_checkout_flow <> 'quicklink'
         or p_apple_pay_integration_id !~ '^[1-9][0-9]{0,29}$'
         or p_apple_pay_integration_id = p_integration_id
       )
     )
     or p_actor_subject_id is null then
    raise exception 'paymob_credential_version_binding_invalid';
  end if;

  perform 1
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for update;
  if not found then raise exception 'payment_provider_not_found'; end if;

  select
    (max(secret_ref.vault_secret_id::text) filter (
      where secret_ref.secret_key = 'hmacSecret'
    ))::uuid,
    (max(secret_ref.vault_secret_id::text) filter (
      where secret_ref.secret_key = 'apiKey'
    ))::uuid,
    (max(secret_ref.vault_secret_id::text) filter (
      where secret_ref.secret_key = 'secretKey'
    ))::uuid,
    (max(secret_ref.vault_secret_id::text) filter (
      where secret_ref.secret_key = 'publicKey'
    ))::uuid
  into
    v_new_hmac_id,
    v_new_api_key_id,
    v_new_secret_key_id,
    v_new_public_key_id
  from marketplace.payment_provider_secret_refs secret_ref
  where secret_ref.provider_key = 'paymob'
    and secret_ref.credentials_environment = p_environment;
  if v_new_hmac_id is null
     or v_new_api_key_id is null
     or v_new_secret_key_id is null
     or v_new_public_key_id is null then
    raise exception 'paymob_complete_credential_bundle_required';
  end if;

  if (
    select count(*)
    from vault.decrypted_secrets decrypted
    where decrypted.id = any(array[
      v_new_hmac_id,
      v_new_api_key_id,
      v_new_secret_key_id,
      v_new_public_key_id
    ])
      and nullif(decrypted.decrypted_secret, '') is not null
  ) <> 4 then
    raise exception 'paymob_credential_vault_bundle_unavailable';
  end if;

  update marketplace.paymob_credential_versions
  set status = 'expired',
      updated_at = now()
  where provider_key = 'paymob'
    and status = 'retiring'
    and valid_until <= now();

  select version.* into v_current
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.status = 'active'
  for update;

  if v_current.id is not null
     and v_current.environment = p_environment
     and v_current.integration_id = p_integration_id
     and v_current.owner_id = p_owner_id
     and v_current.checkout_flow = p_checkout_flow
     and v_current.apple_pay_integration_id is not distinct from
       p_apple_pay_integration_id
     and v_current.hmac_vault_secret_id = v_new_hmac_id
     and v_current.api_key_vault_secret_id = v_new_api_key_id
     and v_current.secret_key_vault_secret_id = v_new_secret_key_id
     and v_current.public_key_vault_secret_id = v_new_public_key_id then
    return v_current.id;
  end if;

  -- Route metadata may only change in place when the credential bundle and
  -- account binding are unchanged and no non-terminal attempt references it.
  -- The provider-config trigger independently blocks the same transition.
  if v_current.id is not null
     and v_current.environment = p_environment
     and v_current.integration_id = p_integration_id
     and v_current.owner_id = p_owner_id
     and v_current.hmac_vault_secret_id = v_new_hmac_id
     and v_current.api_key_vault_secret_id = v_new_api_key_id
     and v_current.secret_key_vault_secret_id = v_new_secret_key_id
     and v_current.public_key_vault_secret_id = v_new_public_key_id then
    select count(distinct attempt.selected_integration_id)::integer
    into v_historical_integration_count
    from marketplace.payment_attempts attempt
    where attempt.credential_version_id = v_current.id
      and attempt.selected_integration_id is not null
      and attempt.selected_integration_id <> p_integration_id
      and attempt.selected_integration_id is distinct from
        p_apple_pay_integration_id;
    if v_historical_integration_count > 32 then
      raise exception 'paymob_integration_history_limit_reached';
    end if;
    if exists (
      select 1
      from marketplace.payment_attempts attempt
      where attempt.credential_version_id = v_current.id
        and attempt.status in (
          'prepared','creating_intention','intention_created','pending',
          'unknown','quarantined'
        )
    ) then
      raise exception 'paymob_open_attempts_must_drain_before_route_change';
    end if;
    update marketplace.paymob_credential_versions
    set checkout_flow = p_checkout_flow,
        apple_pay_integration_id = p_apple_pay_integration_id,
        updated_at = now()
    where id = v_current.id;
    insert into audit_log.events(
      actor_subject_id,action,resource_type,resource_id,context
    ) values (
      p_actor_subject_id,
      'marketplace.paymob.checkout_route_updated',
      'paymob_credential_version',
      v_current.id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'environment',p_environment,
        'checkoutFlow',p_checkout_flow,
        'applePayConfigured',p_apple_pay_integration_id is not null,
        'credentialMaterialChanged',false,
        'openAttemptCount',0,
        'secretReturned',false
      ))
    );
    return v_current.id;
  end if;

  select version.* into v_retiring
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.status = 'retiring'
    and version.valid_until > now()
  for update;
  if v_retiring.id is not null then
    raise exception 'paymob_credential_rotation_overlap_in_progress';
  end if;

  select decrypted.decrypted_secret into v_new_hmac
  from vault.decrypted_secrets decrypted
  where decrypted.id = v_new_hmac_id;
  if v_current.id is not null then
    select decrypted.decrypted_secret into v_old_hmac
    from vault.decrypted_secrets decrypted
    where decrypted.id = v_current.hmac_vault_secret_id;
    if v_old_hmac is null then
      raise exception 'paymob_hmac_vault_secret_unavailable';
    end if;
    if v_old_hmac = v_new_hmac
       and v_current.integration_id = p_integration_id
       and v_current.owner_id = p_owner_id then
      raise exception 'paymob_hmac_rotation_required_with_bundle_change';
    end if;
    update marketplace.paymob_credential_versions
    set status = 'retiring',
        retiring_at = now(),
        valid_until = now() + interval '7 days',
        retired_by_subject_id = p_actor_subject_id,
        updated_at = now()
    where id = v_current.id;
  end if;

  v_version_id := gen_random_uuid();
  v_billing_digest_id := vault.create_secret(
    encode(extensions.gen_random_bytes(32),'hex'),
    'paymob_billing_digest_' || replace(v_version_id::text,'-',''),
    'Internal per-version billing-contact HMAC key. Never sent to Paymob or returned by an RPC.'
  );
  insert into marketplace.paymob_credential_versions(
    id,
    environment,
    hmac_vault_secret_id,
    api_key_vault_secret_id,
    secret_key_vault_secret_id,
    public_key_vault_secret_id,
    billing_digest_vault_secret_id,
    integration_id,
    owner_id,
    checkout_flow,
    apple_pay_integration_id,
    status,
    created_by_subject_id
  ) values (
    v_version_id,
    p_environment,
    v_new_hmac_id,
    v_new_api_key_id,
    v_new_secret_key_id,
    v_new_public_key_id,
    v_billing_digest_id,
    p_integration_id,
    p_owner_id,
    p_checkout_flow,
    p_apple_pay_integration_id,
    'active',
    p_actor_subject_id
  );

  insert into audit_log.events(
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    p_actor_subject_id,
    'marketplace.paymob.credential_version_created',
    'paymob_credential_version',
    v_version_id::text,
    jsonb_build_object(
      'environment', p_environment,
      'integrationId', p_integration_id,
      'owner', p_owner_id,
      'checkoutFlow', p_checkout_flow,
      'applePayConfigured', p_apple_pay_integration_id is not null,
      'priorVersionRetiring', v_current.id is not null,
      'overlapDays', 7,
      'allSecretsStoredInVault', true,
      'secretReturned', false
    )
  );
  return v_version_id;
end;
$$;

revoke all on function private_app.paymob_finalize_credential_version_v2(
  text,text,text,text,text,uuid
) from public,anon,authenticated,service_role;

create or replace function private_app.v3_payment_provider_config_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_complete boolean;
  v_binding_changed boolean := false;
  v_paymob_version_complete boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_binding_changed :=
      new.environment is distinct from old.environment
      or new.credentials_environment is distinct from old.credentials_environment
      or new.checkout_mode is distinct from old.checkout_mode
      or new.supported_currencies is distinct from old.supported_currencies
      or new.required_secret_keys is distinct from old.required_secret_keys
      or new.required_public_config_keys is distinct from old.required_public_config_keys
      or new.public_config is distinct from old.public_config;
  end if;

  if new.provider_key = 'paymob'
     and v_binding_changed
     and exists (
       select 1
       from marketplace.payment_attempts attempt
       where attempt.provider_key = 'paymob'
         and attempt.environment = old.environment
         and attempt.status in (
           'prepared','creating_intention','intention_created','pending',
           'unknown','quarantined'
         )
     ) then
    raise exception 'paymob_open_attempts_must_drain_before_rotation';
  end if;

  if new.provider_key = 'paymob' and v_binding_changed then
    new.readiness_evidence := '{}'::jsonb;
    new.readiness_updated_at := now();
    new.rollout_mode := 'observe_only';
    new.status := case when new.status = 'disabled' then 'disabled' else 'draft' end;
    new.last_verified_at := null;
    new.last_error_code := case
      when new.status = 'disabled' then new.last_error_code
      else 'configuration_incomplete'
    end;
    new.activated_by_subject_id := null;
    new.activated_at := null;
    new.activation_requested_by_subject_id := null;
    new.activation_requested_at := null;
    new.activation_requested_mode := null;
    if not (
      tg_op = 'UPDATE'
      and old.environment = 'sandbox'
      and new.environment = 'live'
      and old.sandbox_canary_version_id is not null
    ) then
      new.sandbox_canary_version_id := null;
      new.sandbox_canary_started_at := null;
    end if;
  end if;

  if tg_op = 'UPDATE'
     and new.environment is distinct from old.environment then
    new.rollout_mode := 'observe_only';
    new.last_verified_at := null;
    new.activated_by_subject_id := null;
    new.activated_at := null;
    new.activation_requested_by_subject_id := null;
    new.activation_requested_at := null;
    new.activation_requested_mode := null;
    if new.credentials_environment is distinct from new.environment then
      new.status := case when new.status = 'disabled' then 'disabled' else 'draft' end;
      new.last_error_code := 'credentials_rotation_required';
    end if;
  end if;

  if new.status = 'disabled' then
    new.rollout_mode := 'observe_only';
    new.last_verified_at := null;
    new.activated_by_subject_id := null;
    new.activated_at := null;
    new.activation_requested_by_subject_id := null;
    new.activation_requested_at := null;
    new.activation_requested_mode := null;
  end if;

  if new.provider_key = 'paymob' then
    if jsonb_typeof(coalesce(new.public_config, '{}'::jsonb)) <> 'object'
       or coalesce(new.public_config ->> 'region', 'ksa') <> 'ksa'
       or (
         new.public_config ? 'merchantAccountId'
         and new.public_config ->> 'merchantAccountId'
           !~ '^[1-9][0-9]{0,29}$'
       )
       or (
         new.public_config ? 'integrationId'
         and new.public_config ->> 'integrationId'
           !~ '^[1-9][0-9]{0,29}$'
       )
       or coalesce(new.public_config ->> 'integrationPath','intention')
         not in ('intention','quicklink')
       or (
         new.public_config ? 'applePayIntegrationId'
         and (
           new.public_config ->> 'applePayIntegrationId'
             !~ '^[1-9][0-9]{0,29}$'
           or coalesce(new.public_config ->> 'integrationPath','intention')
             <> 'quicklink'
           or new.public_config ->> 'applePayIntegrationId'
             = new.public_config ->> 'integrationId'
         )
       ) then
      raise exception 'paymob_public_config_invalid';
    end if;
    if new.supported_currencies <> array['SAR']::text[] then
      raise exception 'paymob_supported_currencies_must_be_sar';
    end if;
  end if;

  v_complete := private_app.v3_payment_provider_bundle_complete(
    new.provider_key,
    new.environment,
    new.credentials_environment,
    new.required_secret_keys,
    new.required_public_config_keys,
    new.public_config
  );

  if new.provider_key = 'paymob' and v_complete then
    select exists (
      select 1
      from marketplace.paymob_credential_versions version
      where version.provider_key = 'paymob'
        and version.status = 'active'
        and version.environment = new.environment
        and private_app.paymob_version_matches_provider_v2(
          version.id,new.environment,new.public_config
        )
        and exists (
          select 1
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = 'paymob'
            and secret_ref.secret_key = 'hmacSecret'
            and secret_ref.credentials_environment = new.environment
            and secret_ref.vault_secret_id = version.hmac_vault_secret_id
        )
        and exists (
          select 1
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = 'paymob'
            and secret_ref.secret_key = 'apiKey'
            and secret_ref.credentials_environment = new.environment
            and secret_ref.vault_secret_id = version.api_key_vault_secret_id
        )
        and exists (
          select 1
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = 'paymob'
            and secret_ref.secret_key = 'secretKey'
            and secret_ref.credentials_environment = new.environment
            and secret_ref.vault_secret_id = version.secret_key_vault_secret_id
        )
        and exists (
          select 1
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = 'paymob'
            and secret_ref.secret_key = 'publicKey'
            and secret_ref.credentials_environment = new.environment
            and secret_ref.vault_secret_id = version.public_key_vault_secret_id
        )
    ) into v_paymob_version_complete;
    if not v_paymob_version_complete then
      if new.status = 'active' then
        raise exception 'paymob_active_credential_version_required';
      end if;
      new.status := case when new.status = 'disabled' then 'disabled' else 'draft' end;
      new.rollout_mode := 'observe_only';
      new.last_verified_at := null;
      new.last_error_code := 'configuration_incomplete';
      new.activated_by_subject_id := null;
      new.activated_at := null;
    end if;
  end if;

  if new.status = 'configured' and not v_complete then
    raise exception 'payment_provider_configuration_incomplete';
  end if;

  if new.provider_key <> 'paymob' and new.status = 'active' then
    raise exception 'payment_provider_native_adapter_not_deployed';
  end if;

  if new.provider_key = 'paymob' then
    if new.status <> 'active' and new.rollout_mode = 'live' then
      new.rollout_mode := 'observe_only';
      new.last_verified_at := null;
      new.activated_by_subject_id := null;
      new.activated_at := null;
    end if;

    if new.rollout_mode = 'sandbox' and (
      new.status <> 'configured'
      or new.environment <> 'sandbox'
      or not v_complete
      or cardinality(private_app.paymob_missing_checks(
        new.readiness_evidence,
        'sandbox'
      )) <> 0
    ) then
      raise exception 'paymob_sandbox_gate_blocked';
    end if;

    if new.status = 'active' or new.rollout_mode = 'live' then
      if new.status <> 'active'
         or new.rollout_mode <> 'live'
         or new.environment <> 'live'
         or new.credentials_environment <> 'live'
         or not v_complete
         or cardinality(private_app.paymob_missing_checks(
           new.readiness_evidence,
           'live'
         )) <> 0
         or new.activated_by_subject_id is null
         or new.activated_at is null then
        raise exception 'paymob_live_gate_blocked';
      end if;
    end if;
  end if;

  return new;
end;
$$;

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
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_merged_public_config jsonb;
  v_secret record;
  v_credential_version_id uuid;
  v_result jsonb;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_actor_subject_id is null or not exists (
    select 1 from access_control.subjects subject
    where subject.id = p_actor_subject_id
  ) then raise exception 'payment_provider_actor_required'; end if;

  perform set_config(
    'odeir.payment_provider_actor_id',
    p_actor_subject_id::text,
    true
  );
  if p_provider_key = 'paymob' then
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob';
    if v_provider.provider_key is null then
      raise exception 'payment_provider_not_found';
    end if;
    if jsonb_typeof(coalesce(p_public_config,'{}'::jsonb)) <> 'object'
       or not (coalesce(p_public_config,'{}'::jsonb) ? 'integrationPath')
       or not (
         coalesce(p_public_config,'{}'::jsonb) ? 'applePayIntegrationId'
       ) then
      raise exception 'paymob_checkout_route_metadata_required';
    end if;
    v_merged_public_config := v_provider.public_config ||
      coalesce(p_public_config, '{}'::jsonb);
    if jsonb_typeof(p_public_config -> 'applePayIntegrationId') = 'null' then
      v_merged_public_config :=
        v_merged_public_config - 'applePayIntegrationId';
    end if;
    if jsonb_typeof(coalesce(p_secrets, '{}'::jsonb)) <> 'object' then
      raise exception 'invalid_payment_provider_secrets';
    end if;
    -- Store submitted Paymob values first. The shared core sees identical
    -- values afterwards and therefore performs no second rotation.
    for v_secret in
      select item.key, item.value
      from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) item
    loop
      if jsonb_typeof(v_secret.value) <> 'string' then
        raise exception 'invalid_payment_provider_secret';
      end if;
      perform private_app.v3_payment_provider_store_secret_v2(
        'paymob',
        p_environment,
        v_secret.key,
        v_secret.value #>> '{}'
      );
    end loop;
    v_credential_version_id :=
      private_app.paymob_finalize_credential_version_v2(
        p_environment,
        v_merged_public_config ->> 'integrationId',
        v_merged_public_config ->> 'merchantAccountId',
        coalesce(v_merged_public_config ->> 'integrationPath','intention'),
        nullif(v_merged_public_config ->> 'applePayIntegrationId',''),
        p_actor_subject_id
      );
  end if;

  v_result := private_app.v3_payment_provider_bundle_core(
    p_provider_key,
    p_environment,
    p_checkout_mode,
    p_supported_currencies,
    p_enabled,
    p_public_config,
    p_secrets,
    p_actor_subject_id
  );
  if p_provider_key = 'paymob'
     and p_environment = 'sandbox'
     and v_credential_version_id is not null then
    perform private_app.paymob_readiness_evidence_write(
      'sandbox','credentials',true,null,null,
      'credential_version',v_credential_version_id
    );
  end if;
  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'credentialVersionId', v_credential_version_id
  ));
end;
$$;

create or replace function private_app.paymob_tenant_checkout_eligible_v1(
  p_tenant_id uuid,
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.tenants tenant
    join marketplace.payment_provider_configs provider
      on provider.provider_key = 'paymob'
    join marketplace.payment_tenant_rollouts rollout
      on rollout.tenant_id = tenant.id
     and rollout.provider_key = provider.provider_key
     and rollout.environment = provider.environment
     and rollout.status = 'enabled'
    join marketplace.paymob_credential_versions version
      on version.provider_key = provider.provider_key
     and version.environment = provider.environment
     and version.status = 'active'
     and private_app.paymob_version_matches_provider_v2(
       version.id,provider.environment,provider.public_config
     )
    where tenant.id = p_tenant_id
      and tenant.slug is distinct from 'reef-skills'
      and tenant.tenant_key is distinct from 'tenant-reef-skills'
      and p_environment in ('sandbox','live')
      and provider.environment = p_environment
      and provider.credentials_environment = p_environment
      and provider.rollout_mode = p_environment
      and (
        (p_environment = 'sandbox' and provider.status = 'configured')
        or (p_environment = 'live' and provider.status = 'active')
      )
      and provider.last_verified_at is not null
      and provider.checkout_mode = 'redirect'
      and provider.supported_currencies = array['SAR']::text[]
      and provider.public_config ->> 'region' = 'ksa'
      and private_app.v3_payment_provider_bundle_complete(
        provider.provider_key,provider.environment,
        provider.credentials_environment,provider.required_secret_keys,
        provider.required_public_config_keys,provider.public_config
      )
      and cardinality(private_app.paymob_missing_checks(
        provider.readiness_evidence,p_environment
      )) = 0
  )
$$;

create or replace function public.v2_tenant_paymob_prepare_checkout(
  p_slug text,
  p_order_id uuid,
  p_idempotency_key text,
  p_billing_contact jsonb default '{}'::jsonb,
  p_payment_option text default 'hosted'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_attempt marketplace.payment_attempts%rowtype;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_option text := lower(btrim(coalesce(p_payment_option,'')));
  v_selected_integration_id text;
  v_route_changed boolean := false;
begin
  if v_option not in ('hosted','card','apple_pay') then
    raise exception 'paymob_payment_option_invalid';
  end if;

  -- V1 remains the single commercial-snapshot authority. This wrapper runs in
  -- the same transaction and under V1's order/advisory locks, then binds the
  -- provider route before the outbound-call claim can exist.
  v_result := public.v1_tenant_paymob_prepare_checkout(
    p_slug,p_order_id,p_idempotency_key,p_billing_contact
  );

  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = nullif(v_result ->> 'attemptId','')::uuid
    and attempt.order_id = p_order_id
    and attempt.provider_key = 'paymob'
  for update;
  if v_attempt.id is null then
    raise exception 'paymob_attempt_not_found';
  end if;

  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.id = v_attempt.credential_version_id
    and version.provider_key = 'paymob'
  for share;
  if v_version.id is null then
    raise exception 'paymob_active_credential_version_required';
  end if;

  -- A non-creatable response represents an already claimed or created
  -- attempt. Its immutable stored route wins; the browser cannot switch it.
  if coalesce((v_result ->> 'createAllowed')::boolean,false) is not true then
    return v_result;
  end if;

  if v_version.checkout_flow = 'intention' then
    if v_option <> 'hosted' then
      raise exception 'paymob_payment_option_unavailable';
    end if;
    if v_attempt.checkout_flow <> 'intention'
       or v_attempt.payment_option <> 'hosted'
       or v_attempt.selected_integration_id is not null then
      raise exception 'paymob_idempotency_payment_option_conflict';
    end if;
  else
    if v_option = 'card' then
      v_selected_integration_id := v_version.integration_id;
    elsif v_option = 'apple_pay'
       and v_version.apple_pay_integration_id is not null then
      v_selected_integration_id := v_version.apple_pay_integration_id;
    else
      raise exception 'paymob_payment_option_unavailable';
    end if;

    if v_attempt.checkout_flow = 'quicklink' then
      if v_attempt.payment_option <> v_option
         or v_attempt.selected_integration_id <> v_selected_integration_id then
        raise exception 'paymob_idempotency_payment_option_conflict';
      end if;
    elsif v_attempt.checkout_flow = 'intention'
       and v_attempt.payment_option = 'hosted'
       and v_attempt.selected_integration_id is null
       and v_attempt.status = 'prepared'
       and v_attempt.claim_token is null then
      update marketplace.payment_attempts
      set checkout_flow = 'quicklink',
          payment_option = v_option,
          selected_integration_id = v_selected_integration_id,
          updated_at = now()
      where id = v_attempt.id
        and status = 'prepared'
        and claim_token is null
      returning * into v_attempt;
      if v_attempt.id is null then
        raise exception 'paymob_checkout_route_claim_conflict';
      end if;
      v_route_changed := true;
    else
      raise exception 'paymob_idempotency_payment_option_conflict';
    end if;
  end if;

  if v_route_changed then
    insert into audit_log.events(
      tenant_id,actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_attempt.tenant_id,
      v_attempt.requested_by_subject_id,
      'marketplace.paymob.checkout_route_bound',
      'payment_attempt',
      v_attempt.id::text,
      jsonb_build_object(
        'orderId',v_attempt.order_id,
        'environment',v_attempt.environment,
        'checkoutFlow',v_attempt.checkout_flow,
        'paymentOption',v_attempt.payment_option,
        'integrationIdReturned',false,
        'secretStored',false
      )
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.v2_tenant_paymob_prepare_checkout(
  text,uuid,text,jsonb,text
) from public,anon,authenticated,service_role;
grant execute on function public.v2_tenant_paymob_prepare_checkout(
  text,uuid,text,jsonb,text
) to authenticated;


create or replace function public.v1_service_paymob_runtime_config(
  p_attempt_id uuid default null,
  p_purpose text default 'create_intention',
  p_environment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt marketplace.payment_attempts%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_tenant core.tenants%rowtype;
  v_rollout marketplace.payment_tenant_rollouts%rowtype;
  v_secret_ref marketplace.payment_provider_secret_refs%rowtype;
  v_bound_secret_ref_count integer := 0;
  v_decrypted_secret_count integer := 0;
  v_claim_token uuid;
  v_order_lock_id uuid;
  v_secret_key text;
  v_public_key text;
  v_api_key text;
  v_selected_integration_id text;
  v_candidates jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_purpose not in ('create_intention','verify_webhook') then
    raise exception 'paymob_runtime_purpose_invalid';
  end if;
  if p_environment is not null then
    raise exception 'paymob_runtime_environment_selector_forbidden';
  end if;

  if p_purpose = 'verify_webhook' then
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'credentialVersionId', candidate.id,
      'environment', candidate.environment,
      'integrationId', candidate.integration_id,
      'applePayIntegrationId', candidate.apple_pay_integration_id,
      'historicalIntegrationIds',coalesce((
        select jsonb_agg(history.integration_id order by history.integration_id)
        from (
          select distinct attempt.selected_integration_id as integration_id
          from marketplace.payment_attempts attempt
          where attempt.credential_version_id = candidate.id
            and attempt.selected_integration_id is not null
            and attempt.selected_integration_id <> candidate.integration_id
            and attempt.selected_integration_id is distinct from
              candidate.apple_pay_integration_id
          order by attempt.selected_integration_id
          limit 32
        ) history
      ),'[]'::jsonb),
      'owner', candidate.owner_id,
      'hmacSecret', decrypted.decrypted_secret
    )) order by
      case candidate.status when 'active' then 0 else 1 end,
      candidate.created_at desc
    ), '[]'::jsonb)
    into v_candidates
    from marketplace.paymob_credential_versions candidate
    join vault.decrypted_secrets decrypted
      on decrypted.id = candidate.hmac_vault_secret_id
    where candidate.provider_key = 'paymob'
      and (
        candidate.status = 'active'
        or (
          candidate.status = 'retiring'
          and candidate.valid_until > now()
        )
      )
      and nullif(decrypted.decrypted_secret, '') is not null;
    if jsonb_array_length(v_candidates) not between 1 and 2 then
      raise exception 'paymob_webhook_credential_candidates_unavailable';
    end if;
    return jsonb_build_object(
      'schemaVersion', 1,
      'purpose', 'verify_webhook',
      'providerKey', 'paymob',
      'region', 'ksa',
      'apiBaseUrl', 'https://ksa.paymob.com',
      'hmacCandidates', v_candidates
    );
  end if;

  if p_attempt_id is null then raise exception 'paymob_attempt_required'; end if;
  select attempt.order_id into v_order_lock_id
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id and attempt.provider_key = 'paymob';
  if v_order_lock_id is null then raise exception 'paymob_attempt_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.provider_key = 'paymob'
  for update;
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;
  if private_app.paymob_order_review_hold_v1(v_attempt.order_id) then
    raise exception 'paymob_order_payment_review_hold';
  end if;

  -- Lock the mutable checkout gates now, but evaluate them only after the
  -- local expired/abandoned lifecycle branches below have had a chance to run.
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for share;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id = v_attempt.tenant_id
  for share;
  select rollout.* into v_rollout
  from marketplace.payment_tenant_rollouts rollout
  where rollout.tenant_id = v_attempt.tenant_id
    and rollout.provider_key = 'paymob'
    and rollout.environment = v_attempt.environment
  for share;
  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.id = v_attempt.credential_version_id
    and version.provider_key = 'paymob'
  for share;

  if v_attempt.status = 'prepared' and v_attempt.expires_at <= now() then
    update marketplace.payment_attempts
    set status = 'failed',
        last_error_code = 'checkout_expired',
        terminal_at = now(),
        claim_token = null,
        claim_expires_at = null,
        checkout_secret_expires_at = case
          when checkout_secret_id is null then null else now()
        end,
        updated_at = now()
    where id = v_attempt.id;
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'payment_failed',
      'payment_failed:attempt_expired:' || v_attempt.id::text,
      jsonb_build_object(
        'attemptId', v_attempt.id,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'errorCode', 'checkout_expired'
      )
    );
    return jsonb_build_object(
      'schemaVersion', 1,
      'providerKey', 'paymob',
      'environment', v_attempt.environment,
      'createAllowed', false,
      'attemptId', v_attempt.id,
      'attemptStatus', 'failed',
      'expiresAt', v_attempt.expires_at
    );
  end if;

  if v_attempt.status = 'creating_intention'
     and v_attempt.claim_expires_at <= now() then
    update marketplace.payment_attempts
    set status = 'unknown',
        last_error_code = 'intention_claim_expired',
        claim_token = null,
        claim_expires_at = null,
        updated_at = now()
    where id = v_attempt.id;
    insert into marketplace.reconciliations(
      tenant_id,order_id,attempt_id,provider_key,environment,
      reconciliation_type,status,provider_order_id,
      expected_amount_minor,expected_currency,error_code,due_at
    ) values (
      v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'paymob',
      v_attempt.environment,'intention_unknown','queued',
      v_attempt.provider_order_id,v_attempt.amount_minor,v_attempt.currency,
      'order_reference_inquiry_required',now()
    )
    on conflict (attempt_id,reconciliation_type) do update
    set status = 'queued',
        error_code = 'order_reference_inquiry_required',
        due_at = now(),
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = now();
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'reconciliation_review',
      'reconciliation:intention_unknown:' || v_attempt.id::text,
      jsonb_build_object(
        'attemptId', v_attempt.id,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'reasonCode', 'intention_claim_expired'
      )
    );
    return jsonb_build_object(
      'schemaVersion', 1,
      'providerKey', 'paymob',
      'environment', v_attempt.environment,
      'createAllowed', false,
      'attemptId', v_attempt.id,
      'attemptStatus', 'unknown',
      'expiresAt', v_attempt.expires_at
    );
  end if;

  if v_attempt.status <> 'prepared' then
    return jsonb_build_object(
      'schemaVersion', 1,
      'providerKey', 'paymob',
      'environment', v_attempt.environment,
      'createAllowed', false,
      'attemptId', v_attempt.id,
      'attemptStatus', v_attempt.status,
      'expiresAt', v_attempt.expires_at
    );
  end if;

  -- Edge derives Paymob's provider TTL from this immutable deadline using a
  -- 120-second safety margin and a 60-second provider minimum. Refuse the
  -- outbound claim unless the full 180-second horizon remains.
  if v_attempt.expires_at <= now() + interval '3 minutes' then
    update marketplace.payment_attempts
    set status = 'failed',
        last_error_code = 'checkout_ttl_insufficient',
        terminal_at = now(),
        claim_token = null,
        claim_expires_at = null,
        updated_at = now()
    where id = v_attempt.id and status = 'prepared'
    returning * into v_attempt;
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'payment_failed',
      'payment_failed:ttl_insufficient:' || v_attempt.id::text,
      jsonb_build_object(
        'attemptId',v_attempt.id,'provider','paymob',
        'environment',v_attempt.environment,
        'errorCode','checkout_ttl_insufficient','providerCallStarted',false
      )
    );
    return jsonb_build_object(
      'schemaVersion',1,'purpose','create_intention','providerKey','paymob',
      'environment',v_attempt.environment,'createAllowed',false,
      'attemptId',v_attempt.id,'attemptStatus','failed',
      'expiresAt',v_attempt.expires_at
    );
  end if;

  -- Lock and validate only the opaque Vault references before the global and
  -- tenant gates. A disabled checkout path must not touch decrypted secrets.
  v_bound_secret_ref_count := 0;
  if v_version.id is not null and v_version.status = 'active' then
    for v_secret_ref in
      select secret_ref.*
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = 'paymob'
        and secret_ref.credentials_environment = v_attempt.environment
        and (
          (secret_ref.secret_key = 'hmacSecret'
            and secret_ref.vault_secret_id = v_version.hmac_vault_secret_id)
          or (secret_ref.secret_key = 'apiKey'
            and secret_ref.vault_secret_id = v_version.api_key_vault_secret_id)
          or (secret_ref.secret_key = 'secretKey'
            and secret_ref.vault_secret_id = v_version.secret_key_vault_secret_id)
          or (secret_ref.secret_key = 'publicKey'
            and secret_ref.vault_secret_id = v_version.public_key_vault_secret_id)
        )
      order by secret_ref.secret_key
      for share of secret_ref
    loop
      v_bound_secret_ref_count := v_bound_secret_ref_count + 1;
    end loop;
  end if;

  -- Final pre-provider-call gate. No claim token is written and no vendor
  -- secret is projected unless every current global, tenant and credential
  -- binding still matches the immutable attempt.
  if v_provider.provider_key is null
     or v_provider.environment <> v_attempt.environment
     or v_provider.credentials_environment <> v_attempt.environment
     or v_provider.rollout_mode <> v_attempt.environment
     or not (
       (v_attempt.environment = 'sandbox' and v_provider.status = 'configured')
       or (v_attempt.environment = 'live' and v_provider.status = 'active')
     )
     or v_provider.last_verified_at is null
     or v_provider.checkout_mode <> 'redirect'
     or v_provider.supported_currencies <> array['SAR']::text[]
     or v_provider.public_config ->> 'region' <> 'ksa'
     or not private_app.v3_payment_provider_bundle_complete(
       v_provider.provider_key,v_provider.environment,
       v_provider.credentials_environment,v_provider.required_secret_keys,
       v_provider.required_public_config_keys,v_provider.public_config
     )
     or cardinality(private_app.paymob_missing_checks(
       v_provider.readiness_evidence,v_attempt.environment
     )) <> 0
     or v_tenant.id is null
     or v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills'
     or v_rollout.id is null
     or v_rollout.status <> 'enabled'
     or v_version.id is null
     or v_version.status <> 'active'
     or v_version.revoked_at is not null
     or v_version.environment <> v_attempt.environment
     or not private_app.paymob_version_matches_provider_v2(
       v_version.id,v_provider.environment,v_provider.public_config
     )
     or v_attempt.checkout_flow <> v_version.checkout_flow
     or (
       v_attempt.checkout_flow = 'intention'
       and (
         v_attempt.payment_option <> 'hosted'
         or v_attempt.selected_integration_id is not null
       )
     )
     or (
       v_attempt.checkout_flow = 'quicklink'
       and (
         v_attempt.payment_option not in ('card','apple_pay')
         or v_attempt.selected_integration_id is null
         or (
           v_attempt.payment_option = 'card'
           and v_attempt.selected_integration_id <> v_version.integration_id
         )
         or (
           v_attempt.payment_option = 'apple_pay'
           and v_attempt.selected_integration_id is distinct from
             v_version.apple_pay_integration_id
         )
       )
     )
     or v_bound_secret_ref_count <> 4
     or not private_app.paymob_tenant_checkout_eligible_v1(
       v_attempt.tenant_id,v_attempt.environment
     ) then
    raise exception 'paymob_runtime_configuration_unavailable';
  end if;

  -- Only after every current gate is closed over the immutable attempt may
  -- this service path validate the four vendor secret values in Vault.
  select count(*) into v_decrypted_secret_count
  from vault.decrypted_secrets decrypted
  where decrypted.id = any(array[
    v_version.hmac_vault_secret_id,
    v_version.api_key_vault_secret_id,
    v_version.secret_key_vault_secret_id,
    v_version.public_key_vault_secret_id
  ])
    and nullif(decrypted.decrypted_secret,'') is not null;
  if v_decrypted_secret_count <> 4 then
    raise exception 'paymob_runtime_configuration_unavailable';
  end if;

  if v_attempt.checkout_flow = 'quicklink' then
    select decrypted.decrypted_secret into v_api_key
    from vault.decrypted_secrets decrypted
    where decrypted.id = v_version.api_key_vault_secret_id;
    if nullif(v_api_key, '') is null then
      raise exception 'paymob_runtime_configuration_unavailable';
    end if;
  else
    select secret_value.decrypted_secret, public_value.decrypted_secret
    into v_secret_key, v_public_key
    from vault.decrypted_secrets secret_value
    cross join vault.decrypted_secrets public_value
    where secret_value.id = v_version.secret_key_vault_secret_id
      and public_value.id = v_version.public_key_vault_secret_id;
    if nullif(v_secret_key, '') is null
       or nullif(v_public_key, '') is null then
      raise exception 'paymob_runtime_configuration_unavailable';
    end if;
  end if;

  v_claim_token := gen_random_uuid();
  update marketplace.payment_attempts
  set status = 'creating_intention',
      claim_token = v_claim_token,
      claim_expires_at = least(expires_at, now() + interval '2 minutes'),
      updated_at = now()
  where id = v_attempt.id
    and status = 'prepared'
  returning * into v_attempt;
  if v_attempt.id is null then
    raise exception 'paymob_intention_claim_conflict';
  end if;

  v_selected_integration_id := case
    when v_attempt.checkout_flow = 'quicklink'
      then v_attempt.selected_integration_id
    else v_version.integration_id
  end;
  return jsonb_build_object(
    'schemaVersion', 1,
    'purpose', 'create_intention',
    'providerKey', 'paymob',
    'region', 'ksa',
    'environment', v_version.environment,
    'checkoutMode', 'redirect',
    'apiBaseUrl', 'https://ksa.paymob.com',
    'createAllowed', true,
    'claimToken', v_claim_token,
    'attemptId', v_attempt.id,
    'credentialVersionId', v_version.id,
    'expiresAt', v_attempt.expires_at,
    'integrationId', v_selected_integration_id,
    'owner', v_version.owner_id,
    'apiKeyConfigured', true
  ) || case when v_attempt.checkout_flow = 'quicklink' then
    jsonb_build_object(
      'checkoutFlow','quicklink',
      'paymentOption',v_attempt.payment_option,
      'apiKey',v_api_key
    )
  else jsonb_build_object(
    'checkoutFlow','intention',
    'paymentOption','hosted',
    'secretKey',v_secret_key,
    'publicKey',v_public_key
  ) end;
end;
$$;

create or replace function public.v1_service_paymob_resume_checkout(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt marketplace.payment_attempts%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_tenant core.tenants%rowtype;
  v_rollout marketplace.payment_tenant_rollouts%rowtype;
  v_secret_ref marketplace.payment_provider_secret_refs%rowtype;
  v_bound_secret_ref_count integer := 0;
  v_decrypted_secret_count integer := 0;
  v_client_secret text;
  v_public_key text;
  v_order_lock_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  select attempt.order_id into v_order_lock_id
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id and attempt.provider_key = 'paymob';
  if v_order_lock_id is null then raise exception 'paymob_attempt_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.provider_key = 'paymob'
  for share;
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;
  if private_app.paymob_order_review_hold_v1(v_attempt.order_id) then
    return jsonb_build_object(
      'schemaVersion',1,'attemptId',v_attempt.id,'resumeAllowed',false,
      'attemptStatus',v_attempt.status,'expiresAt',v_attempt.expires_at,
      'providerExpiresAt',v_attempt.provider_expires_at,
      'lastErrorCode','paymob_order_payment_review_hold'
    );
  end if;

  if v_attempt.status not in ('intention_created','pending')
     or v_attempt.checkout_secret_id is null
     or v_attempt.checkout_secret_expires_at is null
     or v_attempt.checkout_secret_expires_at <= now()
     or v_attempt.provider_expires_at is null
     or v_attempt.provider_expires_at <= now()
     or v_attempt.expires_at <= now() then
    return jsonb_build_object(
      'schemaVersion', 1,
      'attemptId', v_attempt.id,
      'resumeAllowed', false,
      'attemptStatus', v_attempt.status,
      'expiresAt', v_attempt.expires_at,
      'providerExpiresAt',v_attempt.provider_expires_at
    );
  end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for share;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id = v_attempt.tenant_id
  for share;
  select rollout.* into v_rollout
  from marketplace.payment_tenant_rollouts rollout
  where rollout.tenant_id = v_attempt.tenant_id
    and rollout.provider_key = 'paymob'
    and rollout.environment = v_attempt.environment
  for share;
  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.id = v_attempt.credential_version_id
    and version.provider_key = 'paymob'
  for share;

  -- Resolve and lock only opaque references before deciding whether resume is
  -- still allowed. Provider disablement must not cause a Vault value read.
  if v_version.id is not null and v_version.status = 'active' then
    for v_secret_ref in
      select secret_ref.*
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = 'paymob'
        and secret_ref.credentials_environment = v_attempt.environment
        and (
          (secret_ref.secret_key = 'hmacSecret'
            and secret_ref.vault_secret_id = v_version.hmac_vault_secret_id)
          or (secret_ref.secret_key = 'apiKey'
            and secret_ref.vault_secret_id = v_version.api_key_vault_secret_id)
          or (secret_ref.secret_key = 'secretKey'
            and secret_ref.vault_secret_id = v_version.secret_key_vault_secret_id)
          or (secret_ref.secret_key = 'publicKey'
            and secret_ref.vault_secret_id = v_version.public_key_vault_secret_id)
        )
      order by secret_ref.secret_key
      for share of secret_ref
    loop
      v_bound_secret_ref_count := v_bound_secret_ref_count + 1;
    end loop;
  end if;

  if v_provider.provider_key is null
     or v_provider.environment <> v_attempt.environment
     or v_provider.credentials_environment <> v_attempt.environment
     or v_provider.rollout_mode <> v_attempt.environment
     or not (
       (v_attempt.environment = 'sandbox' and v_provider.status = 'configured')
       or (v_attempt.environment = 'live' and v_provider.status = 'active')
     )
     or v_provider.last_verified_at is null
     or v_provider.checkout_mode <> 'redirect'
     or v_provider.supported_currencies <> array['SAR']::text[]
     or v_provider.public_config ->> 'region' <> 'ksa'
     or not private_app.v3_payment_provider_bundle_complete(
       v_provider.provider_key,v_provider.environment,
       v_provider.credentials_environment,v_provider.required_secret_keys,
       v_provider.required_public_config_keys,v_provider.public_config
     )
     or cardinality(private_app.paymob_missing_checks(
       v_provider.readiness_evidence,v_attempt.environment
     )) <> 0
     or v_tenant.id is null
     or v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills'
     or v_rollout.id is null
     or v_rollout.status <> 'enabled'
     or v_version.id is null
     or v_version.status <> 'active'
     or v_version.revoked_at is not null
     or v_version.environment <> v_attempt.environment
     or not private_app.paymob_version_matches_provider_v2(
       v_version.id,v_provider.environment,v_provider.public_config
     )
     or v_attempt.checkout_flow <> v_version.checkout_flow
     or (
       v_attempt.checkout_flow = 'intention'
       and (
         v_attempt.payment_option <> 'hosted'
         or v_attempt.selected_integration_id is not null
       )
     )
     or (
       v_attempt.checkout_flow = 'quicklink'
       and (
         v_attempt.payment_option not in ('card','apple_pay')
         or v_attempt.selected_integration_id is null
         or (
           v_attempt.payment_option = 'card'
           and v_attempt.selected_integration_id <> v_version.integration_id
         )
         or (
           v_attempt.payment_option = 'apple_pay'
           and v_attempt.selected_integration_id is distinct from
             v_version.apple_pay_integration_id
         )
       )
     )
     or v_bound_secret_ref_count <> 4
     or not private_app.paymob_tenant_checkout_eligible_v1(
       v_attempt.tenant_id,v_attempt.environment
     ) then
    return jsonb_build_object(
      'schemaVersion',1,'attemptId',v_attempt.id,'resumeAllowed',false,
      'attemptStatus',v_attempt.status,'expiresAt',v_attempt.expires_at,
      'providerExpiresAt',v_attempt.provider_expires_at,
      'lastErrorCode','paymob_checkout_gate_closed'
    );
  end if;

  select count(*) into v_decrypted_secret_count
  from vault.decrypted_secrets decrypted
  where decrypted.id = any(array[
    v_version.hmac_vault_secret_id,
    v_version.api_key_vault_secret_id,
    v_version.secret_key_vault_secret_id,
    v_version.public_key_vault_secret_id
  ])
    and nullif(decrypted.decrypted_secret,'') is not null;
  if v_decrypted_secret_count <> 4 then
    return jsonb_build_object(
      'schemaVersion',1,'attemptId',v_attempt.id,'resumeAllowed',false,
      'attemptStatus',v_attempt.status,'expiresAt',v_attempt.expires_at,
      'providerExpiresAt',v_attempt.provider_expires_at,
      'lastErrorCode','paymob_checkout_gate_closed'
    );
  end if;

  select decrypted_secret into v_client_secret
  from vault.decrypted_secrets
  where id = v_attempt.checkout_secret_id;
  if nullif(v_client_secret, '') is null then
    raise exception 'paymob_checkout_secret_unavailable';
  end if;
  if v_attempt.checkout_flow = 'quicklink' then
    if not private_app.paymob_quicklink_checkout_url_valid_v1(v_client_secret) then
      raise exception 'paymob_checkout_secret_unavailable';
    end if;
    return jsonb_build_object(
      'schemaVersion',1,
      'attemptId',v_attempt.id,
      'attemptStatus',v_attempt.status,
      'resumeAllowed',true,
      'environment',v_attempt.environment,
      'region','ksa',
      'checkoutMode','redirect',
      'checkoutFlow','quicklink',
      'paymentOption',v_attempt.payment_option,
      'checkoutUrl',v_client_secret,
      'expiresAt',v_attempt.expires_at,
      'providerExpiresAt',v_attempt.provider_expires_at
    );
  end if;

  select decrypted.decrypted_secret into v_public_key
  from vault.decrypted_secrets decrypted
  where decrypted.id = v_version.public_key_vault_secret_id;
  if nullif(v_public_key, '') is null then
    raise exception 'paymob_checkout_secret_unavailable';
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'attemptId', v_attempt.id,
    'attemptStatus', v_attempt.status,
    'resumeAllowed', true,
    'environment', v_attempt.environment,
    'region', 'ksa',
    'checkoutMode', 'redirect',
    'checkoutFlow','intention',
    'paymentOption','hosted',
    'publicKey', v_public_key,
    'clientSecret', v_client_secret,
    'expiresAt', v_attempt.expires_at,
    'providerExpiresAt',v_attempt.provider_expires_at
  );
end;
$$;

create or replace function public.v1_service_paymob_ingest_verified_transaction(
  p_environment text,
  p_credential_version_id uuid,
  p_provider_transaction_id text,
  p_provider_order_id text,
  p_special_reference text,
  p_integration_id text,
  p_owner text,
  p_success boolean,
  p_pending boolean,
  p_error_occured boolean,
  p_has_parent_transaction boolean,
  p_is_3d_secure boolean,
  p_is_auth boolean,
  p_is_capture boolean,
  p_is_standalone_payment boolean,
  p_is_voided boolean,
  p_is_refunded boolean,
  p_amount_minor bigint,
  p_currency text,
  p_provider_created_at timestamptz,
  p_payload_sha256 text,
  p_hmac_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version marketplace.paymob_credential_versions%rowtype;
  v_attempt_version marketplace.paymob_credential_versions%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_order marketplace.orders%rowtype;
  v_delivery marketplace.webhook_deliveries%rowtype;
  v_existing_delivery marketplace.webhook_deliveries%rowtype;
  v_refund marketplace.refunds%rowtype;
  v_result jsonb;
  v_transaction_id text;
  v_provider_order_id text;
  v_integration_id text;
  v_owner text;
  v_currency text;
  v_signed_state_sha256 text;
  v_binding_status text := 'matched';
  v_outcome text;
  v_quarantine_code text;
  v_duplicate boolean := false;
  v_special_reference_valid boolean := false;
  v_is_final_paid boolean;
  v_is_final_failed boolean;
  v_candidate_attempt_id uuid;
  v_locked_order_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if not coalesce(p_hmac_verified, false) then
    raise exception 'paymob_hmac_invalid';
  end if;
  if p_environment not in ('sandbox','live')
     or p_credential_version_id is null
     or coalesce(p_payload_sha256, '') !~ '^[a-f0-9]{64}$'
     or p_provider_created_at is null then
    raise exception 'paymob_receipt_envelope_invalid';
  end if;

  v_transaction_id := coalesce(
    nullif(left(btrim(p_provider_transaction_id), 80), ''),
    'missing'
  );
  v_provider_order_id := coalesce(
    nullif(left(btrim(p_provider_order_id), 80), ''),
    'missing'
  );
  v_integration_id := coalesce(
    nullif(left(btrim(p_integration_id), 80), ''),
    'missing'
  );
  v_owner := coalesce(nullif(left(btrim(p_owner), 80), ''), 'missing');
  v_currency := upper(coalesce(nullif(btrim(p_currency), ''), 'UNK'));

  v_signed_state_sha256 := encode(extensions.digest(convert_to(
    concat_ws('|',
      p_environment,
      v_transaction_id,
      v_provider_order_id,
      v_integration_id,
      v_owner,
      coalesce(p_success, false)::text,
      coalesce(p_pending, false)::text,
      coalesce(p_error_occured, false)::text,
      coalesce(p_has_parent_transaction, false)::text,
      coalesce(p_is_3d_secure, false)::text,
      coalesce(p_is_auth, false)::text,
      coalesce(p_is_capture, false)::text,
      coalesce(p_is_standalone_payment, false)::text,
      coalesce(p_is_voided, false)::text,
      coalesce(p_is_refunded, false)::text,
      coalesce(p_amount_minor, -1)::text,
      v_currency,
      coalesce(p_provider_created_at::text, 'missing')
    ),
    'utf8'
  ), 'sha256'), 'hex');

  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.id = p_credential_version_id
    and version.provider_key = 'paymob'
    and version.environment = p_environment
    and (
      version.status = 'active'
      or (version.status = 'retiring' and version.valid_until > now())
    )
  for share;
  if v_version.id is null then
    raise exception 'paymob_webhook_credential_version_invalid';
  end if;

  select attempt.id,attempt.order_id
  into v_candidate_attempt_id,v_locked_order_id
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = p_environment
    and attempt.provider_order_id = v_provider_order_id;

  if v_candidate_attempt_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'paymob:order:' || v_locked_order_id::text,0
    ));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:receipt:' || p_environment || ':' || v_transaction_id,
    0
  ));
  if v_candidate_attempt_id is not null then
    select attempt.* into v_attempt
    from marketplace.payment_attempts attempt
    where attempt.id = v_candidate_attempt_id
      and attempt.order_id = v_locked_order_id
      and attempt.provider_key = 'paymob'
      and attempt.environment = p_environment
      and attempt.provider_order_id = v_provider_order_id
    for update;
  end if;

  -- special_reference is not part of Paymob's transaction HMAC. It is checked
  -- only after the signed provider order has resolved the attempt; ambiguity
  -- without a stored provider order is handled by authenticated inquiry.

  if v_attempt.id is null then
    v_binding_status := 'mismatched';
    v_outcome := 'quarantined';
    v_quarantine_code := case
      when v_transaction_id !~ '^[1-9][0-9]{0,29}$'
        or v_provider_order_id !~ '^[1-9][0-9]{0,29}$'
        or v_integration_id !~ '^[1-9][0-9]{0,29}$'
        or v_owner !~ '^[1-9][0-9]{0,29}$'
        then 'provider_identifier_invalid'
      else 'attempt_not_found'
    end;

    insert into marketplace.webhook_deliveries(
      tenant_id,
      order_id,
      attempt_id,
      credential_version_id,
      provider_key,
      environment,
      provider_transaction_id,
      provider_order_id,
      provider_integration_id,
      provider_owner_id,
      signed_state_sha256,
      payload_sha256,
      hmac_verified,
      special_reference_valid,
      binding_status,
      outcome,
      success,
      pending,
      error_occured,
      has_parent_transaction,
      is_3d_secure,
      is_auth,
      is_capture,
      is_standalone_payment,
      is_voided,
      is_refunded,
      amount_minor,
      currency,
      quarantine_code,
      provider_created_at
    ) values (
      null,
      null,
      null,
      v_version.id,
      'paymob',
      p_environment,
      v_transaction_id,
      v_provider_order_id,
      v_integration_id,
      v_owner,
      v_signed_state_sha256,
      p_payload_sha256,
      true,
      false,
      v_binding_status,
      v_outcome,
      coalesce(p_success, false),
      coalesce(p_pending, false),
      coalesce(p_error_occured, false),
      coalesce(p_has_parent_transaction, false),
      coalesce(p_is_3d_secure, false),
      coalesce(p_is_auth, false),
      coalesce(p_is_capture, false),
      coalesce(p_is_standalone_payment, false),
      coalesce(p_is_voided, false),
      coalesce(p_is_refunded, false),
      greatest(coalesce(p_amount_minor, 0), 0),
      case when v_currency ~ '^[A-Z]{3}$' then v_currency else 'UNK' end,
      v_quarantine_code,
      coalesce(p_provider_created_at, now())
    )
    on conflict (
      provider_key,
      environment,
      provider_transaction_id,
      signed_state_sha256,
      special_reference_valid
    ) do nothing
    returning * into v_delivery;
    if v_delivery.id is null then
      select delivery.* into v_delivery
      from marketplace.webhook_deliveries delivery
      where delivery.provider_key = 'paymob'
        and delivery.environment = p_environment
        and delivery.provider_transaction_id = v_transaction_id
        and delivery.signed_state_sha256 = v_signed_state_sha256
        and not delivery.special_reference_valid;
      v_duplicate := true;
    end if;

    perform private_app.paymob_outbox_enqueue(
      null,
      null,
      null,
      'payment_quarantined',
      'payment_quarantined:' || p_environment || ':'
        || v_transaction_id || ':' || v_signed_state_sha256,
      jsonb_build_object(
        'deliveryId', v_delivery.id,
        'provider', 'paymob',
        'environment', p_environment,
        'reasonCode', v_quarantine_code,
        'bound', false
      )
    );
    insert into audit_log.events(
      action,
      resource_type,
      resource_id,
      context
    ) values (
      'marketplace.paymob.receipt_quarantined',
      'webhook_delivery',
      v_delivery.id::text,
      jsonb_build_object(
        'provider', 'paymob',
        'environment', p_environment,
        'reasonCode', v_quarantine_code,
        'bound', false,
        'hmacVerified', true,
        'rawStored', false
      )
    );
    return jsonb_build_object(
      'acknowledged', true,
      'deliveryId', v_delivery.id,
      'outcome', 'quarantined',
      'reasonCode', v_quarantine_code,
      'bound', false,
      'duplicate', v_duplicate
    );
  end if;

  select version.* into v_attempt_version
  from marketplace.paymob_credential_versions version
  where version.id = v_attempt.credential_version_id
    and version.environment = v_attempt.environment;

  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_attempt.order_id
    and orders.tenant_id = v_attempt.tenant_id
  for update;

  v_special_reference_valid :=
    p_special_reference is null
    or btrim(p_special_reference) = v_attempt.id::text;

  if v_transaction_id !~ '^[1-9][0-9]{0,29}$'
     or v_provider_order_id !~ '^[1-9][0-9]{0,29}$'
     or v_integration_id !~ '^[1-9][0-9]{0,29}$'
     or v_owner !~ '^[1-9][0-9]{0,29}$' then
    v_quarantine_code := 'provider_identifier_invalid';
  elsif not v_special_reference_valid then
    v_quarantine_code := 'special_reference_mismatch';
  elsif v_attempt_version.id is null then
    v_quarantine_code := 'attempt_credential_binding_missing';
  elsif v_version.id <> v_attempt_version.id then
    v_quarantine_code := 'credential_version_binding_mismatch';
  elsif v_integration_id <> coalesce(
    v_attempt.selected_integration_id,
    v_attempt_version.integration_id
  ) then
    v_quarantine_code := 'integration_binding_mismatch';
  elsif v_owner <> v_version.owner_id
     or v_owner <> v_attempt_version.owner_id then
    v_quarantine_code := 'owner_binding_mismatch';
  elsif v_order.id is null
     or v_order.id <> v_attempt.order_id
     or v_order.tenant_id <> v_attempt.tenant_id then
    v_quarantine_code := 'order_binding_mismatch';
  elsif coalesce(p_amount_minor, -1) <> v_attempt.amount_minor
     or v_currency <> v_attempt.currency then
    v_quarantine_code := 'amount_currency_mismatch';
  end if;

  if v_quarantine_code is not null then
    v_binding_status := 'mismatched';
    v_outcome := 'quarantined';
  elsif coalesce(p_is_refunded, false) or coalesce(p_is_voided, false) then
    v_outcome := 'refund_review';
  elsif coalesce(p_pending, false)
     or (
       coalesce(p_success, false)
       and coalesce(p_is_auth, false)
       and not coalesce(p_is_capture, false)
     ) then
    v_outcome := 'pending';
  else
    v_is_final_paid :=
      coalesce(p_success, false)
      and not coalesce(p_pending, false)
      and not coalesce(p_error_occured, false)
      and not coalesce(p_is_auth, false)
      and not coalesce(p_is_capture, false)
      and coalesce(p_is_standalone_payment, false)
      and not coalesce(p_has_parent_transaction, false)
      and not coalesce(p_is_voided, false)
      and not coalesce(p_is_refunded, false);
    v_is_final_failed :=
      not coalesce(p_pending, false)
      and not v_is_final_paid
      and (
        not coalesce(p_success, false)
        or coalesce(p_error_occured, false)
      );
    if v_is_final_paid then
      v_outcome := 'paid';
    elsif v_is_final_failed then
      v_outcome := 'failed';
    else
      v_outcome := 'quarantined';
      v_binding_status := 'mismatched';
      v_quarantine_code := 'transaction_state_ambiguous';
    end if;
  end if;

  if v_quarantine_code is null and (
    (v_attempt.status = 'paid' and v_outcome not in ('paid','refund_review'))
    or (v_attempt.status = 'refunded' and v_outcome <> 'refund_review')
    or (v_attempt.status = 'failed' and v_outcome <> 'failed')
    or v_attempt.status = 'cancelled'
  ) then
    v_outcome := 'quarantined';
    v_binding_status := 'mismatched';
    v_quarantine_code := 'terminal_state_conflict';
  end if;
  if v_quarantine_code is null
     and v_attempt.status = 'paid'
     and v_outcome = 'paid'
     and v_attempt.provider_transaction_id is distinct from v_transaction_id then
    v_outcome := 'quarantined';
    v_binding_status := 'mismatched';
    v_quarantine_code := 'second_paid_transaction_review_required';
  end if;
  if v_quarantine_code is null
     and v_outcome = 'paid'
     and private_app.paymob_order_review_hold_v1(v_attempt.order_id) then
    v_outcome := 'quarantined';
    v_binding_status := 'mismatched';
    v_quarantine_code := 'order_payment_review_hold';
  end if;

  -- Known add-on fulfillment defects are quarantined before any paid mutation,
  -- so the verified receipt remains durable and the provider can be reconciled.
  if v_outcome = 'paid' and v_attempt.order_kind_snapshot = 'addon' and (
    not exists (
      select 1
      from marketplace.payment_attempt_items snapshot
      where snapshot.attempt_id = v_attempt.id
        and snapshot.tenant_id = v_attempt.tenant_id
        and snapshot.order_id = v_attempt.order_id
        and snapshot.item_type = 'addon'
    )
    or exists (
      select 1
      from marketplace.payment_attempt_items snapshot
      left join catalog.addon_products product
        on product.id = snapshot.addon_product_id
       and product.product_key = snapshot.product_key
       and product.feature_id = snapshot.feature_id
       and product.activation_mode = snapshot.activation_mode_snapshot
      left join catalog.features feature
        on feature.id = snapshot.feature_id
       and feature.id = product.feature_id
      where snapshot.attempt_id = v_attempt.id
        and snapshot.item_type = 'addon'
        and (
          product.id is null
          or feature.id is null
          or snapshot.billing_interval_snapshot not in ('year','month','one_time')
          or (
            product.activation_mode = 'module'
            and not exists (
              select 1 from core.modules module
              where feature.feature_key = 'module.' || module.module_key
            )
          )
        )
    )
  ) then
    v_outcome := 'quarantined';
    v_binding_status := 'mismatched';
    v_quarantine_code := 'addon_fulfillment_not_ready';
  end if;

  select delivery.* into v_existing_delivery
  from marketplace.webhook_deliveries delivery
  where delivery.provider_key = 'paymob'
    and delivery.environment = p_environment
    and delivery.provider_transaction_id = v_transaction_id
    and delivery.signed_state_sha256 = v_signed_state_sha256
    and delivery.special_reference_valid = v_special_reference_valid;
  if v_existing_delivery.id is not null then
    if v_existing_delivery.attempt_id is distinct from v_attempt.id then
      raise exception 'paymob_receipt_reused';
    end if;
    v_duplicate := true;
    update marketplace.webhook_deliveries
    set duplicate_delivery_count = least(duplicate_delivery_count + 1,1000000)
    where id = v_existing_delivery.id
    returning * into v_delivery;
    if v_existing_delivery.outcome = 'refund_review' then
      update marketplace.reconciliations
      set status = 'queued',
          due_at = now(),
          error_code = 'refund_amount_requires_inquiry',
          lease_token = null,
          lease_owner = null,
          lease_expires_at = null,
          updated_at = now()
      where attempt_id = v_attempt.id
        and reconciliation_type = 'refund_inquiry'
        and status in ('queued','unknown','failed','review_required')
        and not exists (
          select 1 from marketplace.refunds refund
          where refund.attempt_id = v_attempt.id
            and refund.inquiry_reconciliation_id = marketplace.reconciliations.id
            and refund.status in ('applied','applied_with_review')
        );
    end if;
    if p_environment = 'sandbox'
       and v_existing_delivery.binding_status = 'matched'
       and v_existing_delivery.outcome = 'paid' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox','duplicate_delivery',true,p_payload_sha256,null,
        'webhook_delivery',v_delivery.id
      );
    end if;
    return jsonb_build_object(
      'acknowledged', true,
      'deliveryId', v_delivery.id,
      'attemptId', v_attempt.id,
      'orderId', v_attempt.order_id,
      'outcome', v_delivery.outcome,
      'bound', v_delivery.binding_status = 'matched',
      'duplicate', true
    );
  end if;

  insert into marketplace.webhook_deliveries(
    tenant_id,
    order_id,
    attempt_id,
    credential_version_id,
    provider_key,
    environment,
    provider_transaction_id,
    provider_order_id,
    provider_integration_id,
    provider_owner_id,
    signed_state_sha256,
    payload_sha256,
    hmac_verified,
    special_reference_valid,
    binding_status,
    outcome,
    success,
    pending,
    error_occured,
    has_parent_transaction,
    is_3d_secure,
    is_auth,
    is_capture,
    is_standalone_payment,
    is_voided,
    is_refunded,
    amount_minor,
    currency,
    quarantine_code,
    provider_created_at
  ) values (
    v_attempt.tenant_id,
    v_attempt.order_id,
    v_attempt.id,
    v_version.id,
    'paymob',
    p_environment,
    v_transaction_id,
    v_provider_order_id,
    v_integration_id,
    v_owner,
    v_signed_state_sha256,
    p_payload_sha256,
    true,
    v_special_reference_valid,
    v_binding_status,
    v_outcome,
    coalesce(p_success, false),
    coalesce(p_pending, false),
    coalesce(p_error_occured, false),
    coalesce(p_has_parent_transaction, false),
    coalesce(p_is_3d_secure, false),
    coalesce(p_is_auth, false),
    coalesce(p_is_capture, false),
    coalesce(p_is_standalone_payment, false),
    coalesce(p_is_voided, false),
    coalesce(p_is_refunded, false),
    greatest(coalesce(p_amount_minor, 0), 0),
    case when v_currency ~ '^[A-Z]{3}$' then v_currency else 'UNK' end,
    v_quarantine_code,
    coalesce(p_provider_created_at, now())
  ) returning * into v_delivery;

  if p_environment = 'sandbox' and v_binding_status = 'matched' then
    perform private_app.paymob_readiness_evidence_try_write(
      'sandbox','webhook_hmac',true,p_payload_sha256,null,
      'webhook_delivery',v_delivery.id
    );
    if v_delivery.credential_version_id = v_attempt.credential_version_id
       and exists (
         select 1
         from marketplace.paymob_credential_versions active_version
         join marketplace.paymob_credential_versions create_version
           on create_version.id = v_attempt.credential_version_id
         where active_version.provider_key = 'paymob'
           and active_version.status = 'active'
           and active_version.id <> create_version.id
           and active_version.environment = create_version.environment
           and active_version.integration_id = create_version.integration_id
           and active_version.owner_id = create_version.owner_id
           and active_version.valid_from <= v_delivery.created_at
       ) then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox','credential_rotation_callback',true,p_payload_sha256,null,
        'webhook_delivery',v_delivery.id
      );
    end if;
  end if;

  if v_outcome = 'quarantined' then
    update marketplace.payment_attempts
    set status = case
          when status in ('paid','refunded','failed','cancelled') then status
          else 'quarantined'
        end,
        last_error_code = v_quarantine_code,
        updated_at = now()
    where id = v_attempt.id;
    insert into marketplace.reconciliations(
      tenant_id,
      order_id,
      attempt_id,
      source_delivery_id,
      provider_key,
      environment,
      reconciliation_type,
      status,
      provider_transaction_id,
      provider_order_id,
      expected_amount_minor,
      expected_currency,
      error_code,
      due_at
    ) values (
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      v_delivery.id,
      'paymob',
      v_attempt.environment,
      'binding_mismatch',
      'queued',
      v_transaction_id,
      v_provider_order_id,
      v_attempt.amount_minor,
      v_attempt.currency,
      v_quarantine_code,
      now()
    )
    on conflict (attempt_id, reconciliation_type) do update
    set source_delivery_id = excluded.source_delivery_id,
        status = 'queued',
        provider_transaction_id = excluded.provider_transaction_id,
        provider_order_id = excluded.provider_order_id,
        error_code = excluded.error_code,
        due_at = now(),
        updated_at = now();
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'payment_quarantined',
      'payment_quarantined:' || p_environment || ':'
        || v_transaction_id || ':' || v_signed_state_sha256,
      jsonb_build_object(
        'deliveryId', v_delivery.id,
        'attemptId', v_attempt.id,
        'orderNumber', v_attempt.order_number_snapshot,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'reasonCode', v_quarantine_code,
        'bound', true
      )
    );
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'reconciliation_review',
      'reconciliation:binding:' || v_attempt.id::text,
      jsonb_build_object(
        'deliveryId', v_delivery.id,
        'attemptId', v_attempt.id,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'reasonCode', v_quarantine_code
      )
    );
  elsif v_outcome = 'refund_review' then
    if exists (
      select 1
      from marketplace.refunds applied_refund
      where applied_refund.attempt_id = v_attempt.id
        and applied_refund.tenant_id = v_attempt.tenant_id
        and applied_refund.order_id = v_attempt.order_id
        and applied_refund.provider_key = 'paymob'
        and applied_refund.provider_transaction_id = v_transaction_id
        and applied_refund.amount_minor = v_attempt.amount_minor
        and applied_refund.currency = v_attempt.currency
        and applied_refund.status in ('applied','applied_with_review')
    ) then
      return jsonb_build_object(
        'acknowledged',true,'deliveryId',v_delivery.id,
        'attemptId',v_attempt.id,'orderId',v_attempt.order_id,
        'outcome','refund_review','bound',true,
        'duplicate',true,'refundAlreadyApplied',true
      );
    end if;
    insert into marketplace.refunds(
      tenant_id,
      order_id,
      attempt_id,
      source_delivery_id,
      provider_key,
      environment,
      provider_transaction_id,
      refund_kind,
      status,
      amount_minor,
      currency,
      provider_created_at
    ) values (
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      v_delivery.id,
      'paymob',
      v_attempt.environment,
      v_transaction_id,
      case when coalesce(p_is_voided, false) then 'void' else 'refund' end,
      'review_required',
      v_attempt.amount_minor,
      v_attempt.currency,
      p_provider_created_at
    )
    on conflict (attempt_id,provider_transaction_id)
      where status in (
        'requested','review_required','processing','unknown','succeeded'
      )
    do update
    set source_delivery_id = excluded.source_delivery_id,
        refund_kind = excluded.refund_kind,
        status = 'review_required',
        provider_created_at = greatest(
          marketplace.refunds.provider_created_at,
          excluded.provider_created_at
        ),
        error_code = 'refund_amount_requires_inquiry',
        updated_at = now()
    returning * into v_refund;
    insert into marketplace.reconciliations(
      tenant_id,
      order_id,
      attempt_id,
      source_delivery_id,
      provider_key,
      environment,
      reconciliation_type,
      status,
      provider_transaction_id,
      provider_order_id,
      expected_amount_minor,
      expected_currency,
      error_code,
      due_at
    ) values (
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      v_delivery.id,
      'paymob',
      v_attempt.environment,
      'refund_inquiry',
      'queued',
      v_transaction_id,
      v_provider_order_id,
      v_attempt.amount_minor,
      v_attempt.currency,
      'refund_amount_requires_inquiry',
      now()
    )
    on conflict (attempt_id, reconciliation_type) do update
    set source_delivery_id = excluded.source_delivery_id,
        status = 'queued',
        provider_transaction_id = excluded.provider_transaction_id,
        provider_order_id = excluded.provider_order_id,
        error_code = excluded.error_code,
        due_at = now(),
        updated_at = now();
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'refund_review',
      'refund_review:' || p_environment || ':' || v_transaction_id
        || ':' || v_signed_state_sha256,
      jsonb_build_object(
        'refundId', v_refund.id,
        'deliveryId', v_delivery.id,
        'attemptId', v_attempt.id,
        'orderNumber', v_attempt.order_number_snapshot,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'reasonCode', 'refund_amount_requires_inquiry',
        'callbackAmountIsOriginalCharge', true
      )
    );
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'reconciliation_review',
      'reconciliation:refund:' || v_attempt.id::text,
      jsonb_build_object(
        'refundId', v_refund.id,
        'attemptId', v_attempt.id,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'reasonCode', 'refund_amount_requires_inquiry'
      )
    );
  elsif v_outcome = 'pending' then
    update marketplace.payment_attempts
    set status = case
          when status in ('paid','refunded') then status
          else 'pending'
        end,
        last_error_code = null,
        updated_at = now()
    where id = v_attempt.id;
  elsif v_outcome = 'failed' then
    insert into marketplace.payment_events(
      order_id,
      provider_key,
      provider_event_id,
      payment_reference,
      state,
      amount_minor,
      currency,
      signature_verified,
      payload_sha256
    ) values (
      v_attempt.order_id,
      'paymob',
      left(p_environment || ':' || v_transaction_id || ':failed', 200),
      v_transaction_id,
      'failed',
      v_attempt.amount_minor,
      v_attempt.currency,
      true,
      p_payload_sha256
    )
    on conflict (provider_key, provider_event_id) do nothing;
    update marketplace.payment_attempts
    set status = case
          when status in ('paid','refunded','cancelled') then status
          when expires_at > now() then 'pending'
          else 'unknown'
        end,
        last_error_code = case when expires_at > now()
          then 'payment_attempt_failed_retry_available'
          else 'payment_child_failed_inquiry_required'
        end,
        updated_at = now()
    where id = v_attempt.id;
    if v_attempt.expires_at <= now() then
      insert into marketplace.reconciliations(
        tenant_id,order_id,attempt_id,source_delivery_id,provider_key,
        environment,reconciliation_type,status,provider_order_id,
        expected_amount_minor,expected_currency,error_code,due_at
      ) values (
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,v_delivery.id,
        'paymob',v_attempt.environment,'intention_unknown','queued',
        v_attempt.provider_order_id,v_attempt.amount_minor,v_attempt.currency,
        'payment_child_failed_inquiry_required',now()
      )
      on conflict (attempt_id,reconciliation_type) do update
      set source_delivery_id = excluded.source_delivery_id,
          provider_order_id = excluded.provider_order_id,
          error_code = excluded.error_code,
          due_at = now(),updated_at = now()
      where marketplace.reconciliations.status in ('queued','unknown','failed');
      perform private_app.paymob_outbox_enqueue(
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,
        'reconciliation_review',
        'reconciliation:failed_child:' || v_attempt.id::text,
        jsonb_build_object(
          'deliveryId',v_delivery.id,'attemptId',v_attempt.id,
          'orderNumber',v_attempt.order_number_snapshot,'provider','paymob',
          'environment',v_attempt.environment,
          'reasonCode','payment_child_failed_inquiry_required'
        )
      );
    end if;
    if p_environment = 'sandbox' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox','failed_transaction',true,p_payload_sha256,null,
        'webhook_delivery',v_delivery.id
      );
    end if;
  else
    v_result := private_app.paymob_apply_paid_attempt_v1(
      v_attempt.id,
      v_transaction_id,
      p_payload_sha256,
      'webhook'
    );
    if p_environment = 'sandbox' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox','paid_transaction',true,p_payload_sha256,null,
        'webhook_delivery',v_delivery.id
      );
    end if;
  end if;

  insert into audit_log.events(
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    v_attempt.tenant_id,
    'marketplace.paymob.receipt_' || v_outcome,
    'webhook_delivery',
    v_delivery.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'attemptId', v_attempt.id,
      'orderId', v_attempt.order_id,
      'provider', 'paymob',
      'environment', v_attempt.environment,
      'outcome', v_outcome,
      'bindingStatus', v_binding_status,
      'reasonCode', v_quarantine_code,
      'hmacVerified', true,
      'specialReferenceValid', v_special_reference_valid,
      'rawStored', false,
      'piiStored', false
    ))
  );

  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'acknowledged', true,
    'deliveryId', v_delivery.id,
    'attemptId', v_attempt.id,
    'orderId', v_attempt.order_id,
    'outcome', v_outcome,
    'bound', v_binding_status = 'matched',
    'duplicate', false
  );
end;
$$;

create or replace function public.v1_platform_paymob_readiness_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_configured boolean;
  v_sandbox_missing text[];
  v_live_missing text[];
  v_required text[];
  v_missing text[];
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob';
  if v_provider.provider_key is null then raise exception 'payment_provider_not_found'; end if;
  v_configured := private_app.v3_payment_provider_bundle_complete(
    v_provider.provider_key,v_provider.environment,
    v_provider.credentials_environment,v_provider.required_secret_keys,
    v_provider.required_public_config_keys,v_provider.public_config
  ) and exists (
    select 1 from marketplace.paymob_credential_versions version
    where version.provider_key = 'paymob'
      and version.status = 'active'
      and version.environment = v_provider.environment
      and private_app.paymob_version_matches_provider_v2(
        version.id,v_provider.environment,v_provider.public_config
      )
  );
  v_sandbox_missing := private_app.paymob_missing_checks(
    v_provider.readiness_evidence,'sandbox'
  );
  v_live_missing := private_app.paymob_missing_checks(
    v_provider.readiness_evidence,'live'
  );
  v_required := private_app.paymob_required_checks(
    case when v_provider.environment = 'live' then 'live' else 'sandbox' end
  );
  v_missing := case when v_provider.environment = 'live'
    then v_live_missing else v_sandbox_missing end;
  return jsonb_build_object(
    'schemaVersion',1,'providerKey','paymob','status',v_provider.status,
    'environment',v_provider.environment,
    'credentialsEnvironment',v_provider.credentials_environment,
    'rolloutMode',v_provider.rollout_mode,'configured',v_configured,
    'active',v_provider.status = 'active' and v_provider.rollout_mode = 'live',
    'nativeAdapterDeployed',true,'verifiedAt',v_provider.last_verified_at,
    'requiredChecks',to_jsonb(v_required),
    'passedChecks',coalesce((
      select jsonb_agg(check_key order by ordinality)
      from unnest(v_required) with ordinality required(check_key,ordinality)
      where private_app.paymob_evidence_passed(
        v_provider.readiness_evidence,check_key
      )
    ),'[]'::jsonb),
    'missingChecks',to_jsonb(v_missing),
    'sandboxReady',v_configured and cardinality(v_sandbox_missing) = 0,
    'liveReady',v_configured and v_provider.environment = 'live'
      and cardinality(v_live_missing) = 0,
    'liveGateBlocked',not (
      v_configured and v_provider.environment = 'live'
      and cardinality(v_live_missing) = 0
    ),
    'webhookVerified',
      private_app.paymob_evidence_passed(v_provider.readiness_evidence,'webhook_hmac'),
    'reconciliationVerified',
      private_app.paymob_evidence_passed(v_provider.readiness_evidence,'transaction_inquiry'),
    'refundVerified',
      private_app.paymob_evidence_passed(v_provider.readiness_evidence,'refund_inquiry')
      and private_app.paymob_evidence_passed(v_provider.readiness_evidence,'refund_initiation'),
    'credentialRotationVerified',
      private_app.paymob_evidence_passed(
        v_provider.readiness_evidence,'credential_rotation_callback'
      ),
    'queryLogRedactionVerified',
      private_app.paymob_evidence_passed(
        v_provider.readiness_evidence,'edge_query_redaction_waf'
      ),
    'outboxDeliveryVerified',
      private_app.paymob_evidence_passed(
        v_provider.readiness_evidence,'outbox_delivery'
      ),
    'lastErrorCode',v_provider.last_error_code,
    'pendingActivation',v_provider.activation_requested_by_subject_id is not null,
    'pendingActivationMode',v_provider.activation_requested_mode,
    'requestedAt',v_provider.activation_requested_at,
    'tenantRollouts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId',visible.tenant_id,'tenantName',visible.tenant_name,
        'tenantSlug',visible.tenant_slug,'environment',visible.environment,
        'status',visible.status,'pendingApproval',visible.pending_approval,
        'requestedAt',visible.requested_at,'approvedAt',visible.approved_at,
        'protected',false
      ) order by visible.requested_at desc nulls last,visible.tenant_slug)
      from (
        select rollout.tenant_id,tenant.name as tenant_name,
          tenant.slug as tenant_slug,rollout.environment,rollout.status,
          rollout.requested_at,rollout.approved_at,
          rollout.requested_by_subject_id is not null
            and rollout.approved_by_subject_id is null as pending_approval
        from marketplace.payment_tenant_rollouts rollout
        join core.tenants tenant on tenant.id = rollout.tenant_id
        where rollout.provider_key = 'paymob'
          and tenant.slug is distinct from 'reef-skills'
          and tenant.tenant_key is distinct from 'tenant-reef-skills'
        order by rollout.requested_at desc nulls last,tenant.slug
        limit 100
      ) visible
    ),'[]'::jsonb),
    'operationalEvidenceRequests',coalesce((
      select jsonb_agg(jsonb_build_object(
        'requestId',request.id,'checkKey',request.check_key,
        'status',request.status,
        'pendingApproval',request.status = 'pending',
        'artifactSha256',request.evidence_sha256,
        'requestedAt',request.requested_at,'expiresAt',request.expires_at
      ) order by request.requested_at desc)
      from (
        select evidence.*
        from marketplace.paymob_operational_evidence_requests evidence
        join marketplace.paymob_credential_versions version
          on version.id = evidence.credential_version_id
        where version.provider_key = 'paymob'
          and version.status = 'active'
          and version.environment = 'live'
          and evidence.status in ('pending','approved')
          and evidence.expires_at > now()
        order by evidence.requested_at desc
        limit 50
      ) request
    ),'[]'::jsonb),
    'enabledSandboxTenantCount',(
      select count(*) from marketplace.payment_tenant_rollouts rollout
      where rollout.provider_key = 'paymob' and rollout.environment = 'sandbox'
        and rollout.status = 'enabled'
    ),
    'enabledLiveTenantCount',(
      select count(*) from marketplace.payment_tenant_rollouts rollout
      where rollout.provider_key = 'paymob' and rollout.environment = 'live'
        and rollout.status = 'enabled'
    )
  );
end;
$$;

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
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  return jsonb_build_object(
    'schemaVersion',3,'actorSubjectId',v_actor,'generatedAt',now(),
    'paymentProviders',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',provider.provider_key,'name',provider.name_ar,'nameEn',provider.name_en,
        'status',provider.status,'environment',provider.environment,
        'credentialsEnvironment',provider.credentials_environment,
        'checkoutMode',provider.checkout_mode,
        'supportedCurrencies',to_jsonb(provider.supported_currencies),
        'requiredSecretKeys',to_jsonb(provider.required_secret_keys),
        'optionalSecretKeys',to_jsonb(provider.optional_secret_keys),
        'configuredSecretKeys',coalesce((
          select jsonb_agg(secret_ref.secret_key order by secret_ref.secret_key)
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = provider.provider_key
            and secret_ref.credentials_environment = provider.credentials_environment
        ),'[]'::jsonb),
        'requiredPublicConfigKeys',to_jsonb(provider.required_public_config_keys),
        'configuredPublicConfig',case when provider.provider_key = 'paymob' then
          jsonb_strip_nulls(jsonb_build_object(
            'merchantAccountId',provider.public_config ->> 'merchantAccountId',
            'integrationId',provider.public_config ->> 'integrationId',
            'applePayIntegrationId',
              nullif(provider.public_config ->> 'applePayIntegrationId',''),
            'integrationPath',
              coalesce(provider.public_config ->> 'integrationPath','intention'),
            'region','ksa'
          ))
        else coalesce((
          select jsonb_object_agg(
            required.config_key,provider.public_config -> required.config_key
          )
          from unnest(provider.required_public_config_keys) required(config_key)
          where jsonb_typeof(provider.public_config -> required.config_key) = 'string'
        ),'{}'::jsonb) end,
        'configured',private_app.v3_payment_provider_bundle_complete(
          provider.provider_key,provider.environment,provider.credentials_environment,
          provider.required_secret_keys,provider.required_public_config_keys,
          provider.public_config
        ) and (
          provider.provider_key <> 'paymob' or exists (
            select 1 from marketplace.paymob_credential_versions version
            where version.provider_key = 'paymob' and version.status = 'active'
              and version.environment = provider.environment
              and private_app.paymob_version_matches_provider_v2(
                version.id,provider.environment,provider.public_config
              )
          )
        ),
        'requiresFullRotation',provider.credentials_environment is distinct from provider.environment,
        'verifiedAt',provider.last_verified_at,'lastErrorCode',provider.last_error_code,
        'nativeAdapterDeployed',provider.provider_key = 'paymob',
        'rolloutMode',case when provider.provider_key = 'paymob'
          then provider.rollout_mode else 'observe_only' end,
        'pendingActivationMode',case when provider.provider_key = 'paymob'
          then provider.activation_requested_mode else null end,
        'activationRequestedAt',case when provider.provider_key = 'paymob'
          then provider.activation_requested_at else null end,
        'requiredChecks',case when provider.provider_key = 'paymob' then to_jsonb(
          private_app.paymob_required_checks(
            case when provider.environment = 'live' then 'live' else 'sandbox' end
          )
        ) else '[]'::jsonb end,
        'missingChecks',case when provider.provider_key = 'paymob' then to_jsonb(
          private_app.paymob_missing_checks(
            provider.readiness_evidence,
            case when provider.environment = 'live' then 'live' else 'sandbox' end
          )
        ) else '[]'::jsonb end,
        'sandboxReady',provider.provider_key = 'paymob' and cardinality(
          private_app.paymob_missing_checks(provider.readiness_evidence,'sandbox')
        ) = 0,
        'liveReady',provider.provider_key = 'paymob'
          and provider.environment = 'live' and cardinality(
            private_app.paymob_missing_checks(provider.readiness_evidence,'live')
          ) = 0,
        'liveGateBlocked',provider.provider_key <> 'paymob'
          or provider.environment <> 'live' or cardinality(
            private_app.paymob_missing_checks(provider.readiness_evidence,'live')
          ) <> 0,
        'webhookVerified',provider.provider_key = 'paymob' and
          private_app.paymob_evidence_passed(provider.readiness_evidence,'webhook_hmac'),
        'reconciliationVerified',provider.provider_key = 'paymob' and
          private_app.paymob_evidence_passed(provider.readiness_evidence,'transaction_inquiry'),
        'refundVerified',provider.provider_key = 'paymob' and
          private_app.paymob_evidence_passed(provider.readiness_evidence,'refund_inquiry') and
          private_app.paymob_evidence_passed(provider.readiness_evidence,'refund_initiation'),
        'queryLogRedactionVerified',provider.provider_key = 'paymob' and
          private_app.paymob_evidence_passed(
            provider.readiness_evidence,'edge_query_redaction_waf'
          ),
        'outboxDeliveryVerified',provider.provider_key = 'paymob' and
          private_app.paymob_evidence_passed(
            provider.readiness_evidence,'outbox_delivery'
          ),
        'enabledSandboxTenantCount',case when provider.provider_key = 'paymob' then (
          select count(*) from marketplace.payment_tenant_rollouts rollout
          where rollout.provider_key = 'paymob' and rollout.environment = 'sandbox'
            and rollout.status = 'enabled'
        ) else 0 end,
        'enabledLiveTenantCount',case when provider.provider_key = 'paymob' then (
          select count(*) from marketplace.payment_tenant_rollouts rollout
          where rollout.provider_key = 'paymob' and rollout.environment = 'live'
            and rollout.status = 'enabled'
        ) else 0 end,
        'active',provider.provider_key = 'paymob'
          and provider.status = 'active' and provider.rollout_mode = 'live'
      ) order by provider.sort_order)
      from marketplace.payment_provider_configs provider
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_marketplace_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_base jsonb;
  v_payment_methods jsonb;
begin
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.workspace.read'
  ) then raise exception 'forbidden'; end if;

  v_base := private_app.v2_tenant_marketplace_snapshot_service_legacy(p_slug);
  select coalesce(jsonb_agg(method.payload order by method.sort_order),'[]'::jsonb)
  into v_payment_methods
  from (
    select entry.ordinality::bigint as sort_order,entry.value as payload
    from jsonb_array_elements(coalesce(v_base -> 'paymentMethods','[]'::jsonb))
      with ordinality entry(value,ordinality)
    where entry.value ->> 'key' <> 'paymob'
    union all
    select 9223372036854775807::bigint,
      jsonb_build_object(
        'key','paymob','name',provider.name_ar,'nameEn',provider.name_en,
        'checkoutMode','redirect','supportedCurrencies',jsonb_build_array('SAR'),
        -- Storefront receives only stable option keys and labels. Merchant and
        -- integration identifiers remain server-side bindings.
        'paymentOptions',case
          when coalesce(provider.public_config ->> 'integrationPath','intention')
            = 'quicklink' then
            jsonb_build_array(jsonb_build_object(
              'key','card','name','البطاقات ومدى','nameEn','Cards & Mada'
            )) || case
              when provider.public_config ->> 'applePayIntegrationId'
                ~ '^[1-9][0-9]{0,29}$'
              then jsonb_build_array(jsonb_build_object(
                'key','apple_pay','name','Apple Pay','nameEn','Apple Pay'
              ))
              else '[]'::jsonb
            end
          else jsonb_build_array(jsonb_build_object(
            'key','hosted','name','الدفع الإلكتروني الآمن',
            'nameEn','Secure online payment'
          ))
        end,
        'publicConfig','{}'::jsonb
      )
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob'
      and private_app.paymob_tenant_checkout_eligible_v1(
        v_tenant.id,provider.environment
      )
  ) method;

  return (v_base - 'services' - 'categories' - 'paymentMethods')
    || jsonb_build_object(
      'summary',coalesce(v_base -> 'summary','{}'::jsonb) - 'serviceProducts',
      'paymentMethods',v_payment_methods
    );
end;
$$;

-- QuickLink response callbacks are configured once per Paymob Integration,
-- so they cannot carry an ODEIR tenant slug. Resolve only the provider order
-- binding already persisted after creation, and only for an authenticated
-- caller who can manage that exact tenant. This function is read-only and
-- intentionally returns no financial status.
create or replace function public.v1_tenant_paymob_resolve_return(
  p_provider_order_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt_id uuid;
  v_tenant_slug text;
  v_match_count bigint;
begin
  p_provider_order_id := btrim(coalesce(p_provider_order_id,''));
  if p_provider_order_id !~ '^[1-9][0-9]{0,29}$' then
    raise exception 'invalid_paymob_provider_order_id';
  end if;

  -- Authorization is part of candidate selection, so direct RPC callers
  -- cannot enumerate whether an order ID belongs to another tenant.
  select candidate.attempt_id,candidate.tenant_slug,candidate.match_count
  into v_attempt_id,v_tenant_slug,v_match_count
  from (
    select attempt.id as attempt_id,tenant.slug as tenant_slug,
      count(*) over () as match_count
    from marketplace.payment_attempts attempt
    join core.tenants tenant on tenant.id = attempt.tenant_id
    where attempt.provider_key = 'paymob'
      and attempt.checkout_flow = 'quicklink'
      and attempt.provider_order_id = p_provider_order_id
      and tenant.slug is distinct from 'reef-skills'
      and tenant.tenant_key is distinct from 'tenant-reef-skills'
      and private_app.has_tenant_permission(
        tenant.id,'tenant.settings.manage'
      )
  ) candidate
  limit 1;
  if v_attempt_id is null or v_match_count <> 1 then
    raise exception 'paymob_return_not_found';
  end if;

  return jsonb_build_object(
    'schemaVersion',1,
    'slug',v_tenant_slug,
    'attemptId',v_attempt_id
  );
end;
$$;

-- The public signatures are unchanged except for the additive tenant V2 RPC.
-- Reassert least-privilege grants after CREATE OR REPLACE.
revoke all on function public.v3_service_payment_provider_bundle_action(
  text,text,text,text[],boolean,jsonb,jsonb,uuid
) from public,anon,authenticated,service_role;
grant execute on function public.v3_service_payment_provider_bundle_action(
  text,text,text,text[],boolean,jsonb,jsonb,uuid
) to service_role;

revoke all on function public.v1_service_paymob_runtime_config(uuid,text,text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_service_paymob_runtime_config(uuid,text,text)
to service_role;

revoke all on function public.v1_service_paymob_resume_checkout(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v1_service_paymob_resume_checkout(uuid)
to service_role;

revoke all on function public.v1_service_paymob_ingest_verified_transaction(
  text,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,boolean,
  boolean,boolean,boolean,boolean,boolean,bigint,text,timestamptz,text,boolean
) from public,anon,authenticated,service_role;
grant execute on function public.v1_service_paymob_ingest_verified_transaction(
  text,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,boolean,
  boolean,boolean,boolean,boolean,boolean,bigint,text,timestamptz,text,boolean
) to service_role;

revoke all on function public.v1_platform_paymob_readiness_snapshot()
from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_paymob_readiness_snapshot()
to authenticated;

revoke all on function public.v3_platform_payment_provider_admin_snapshot()
from public,anon,authenticated,service_role;
grant execute on function public.v3_platform_payment_provider_admin_snapshot()
to authenticated;

revoke all on function public.v2_tenant_marketplace_snapshot(text)
from public,anon,authenticated,service_role;
grant execute on function public.v2_tenant_marketplace_snapshot(text)
to authenticated;

revoke all on function public.v1_tenant_paymob_resolve_return(text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_paymob_resolve_return(text)
to authenticated;

commit;
