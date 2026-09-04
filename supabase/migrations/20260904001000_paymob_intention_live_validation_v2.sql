begin;

-- Paymob KSA uses the same regional host for Test and Live. For Intention,
-- the Secret/Public prefixes are therefore the only local proof that a Live
-- provider row will not accidentally project Test credentials.
create or replace function private_app.paymob_live_credential_material_valid_v2(
  p_version_id uuid,
  p_checkout_flow text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from marketplace.paymob_credential_versions version
    join vault.decrypted_secrets api_key
      on api_key.id = version.api_key_vault_secret_id
    join vault.decrypted_secrets hmac_secret
      on hmac_secret.id = version.hmac_vault_secret_id
    left join vault.decrypted_secrets secret_key
      on secret_key.id = version.secret_key_vault_secret_id
    left join vault.decrypted_secrets public_key
      on public_key.id = version.public_key_vault_secret_id
    where version.id = p_version_id
      and version.provider_key = 'paymob'
      and version.environment = 'live'
      and version.status = 'active'
      and version.revoked_at is null
      and version.checkout_flow = p_checkout_flow
      and p_checkout_flow in ('intention','quicklink')
      and nullif(api_key.decrypted_secret,'') is not null
      and nullif(hmac_secret.decrypted_secret,'') is not null
      and (
        p_checkout_flow = 'quicklink'
        or (
          lower(coalesce(secret_key.decrypted_secret,'')) like 'sklive%'
          and lower(coalesce(public_key.decrypted_secret,'')) like 'pklive%'
        )
      )
  )
$function$;

revoke all on function private_app.paymob_live_credential_material_valid_v2(
  uuid,text
) from public,anon,authenticated,service_role;

create or replace function private_app.paymob_live_bundle_ready_v2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from marketplace.payment_provider_configs provider
    join marketplace.paymob_credential_versions version
      on version.provider_key = 'paymob'
     and version.environment = 'live'
     and version.status = 'active'
     and version.revoked_at is null
     and private_app.paymob_version_matches_provider_v2(
       version.id,'live',provider.public_config
     )
    where provider.provider_key = 'paymob'
      and provider.environment = 'live'
      and provider.credentials_environment = 'live'
      and provider.checkout_mode = 'redirect'
      and provider.supported_currencies = array['SAR']::text[]
      and provider.public_config ->> 'region' = 'ksa'
      and coalesce(provider.public_config ->> 'integrationPath','intention')
        in ('intention','quicklink')
      and (
        (
          coalesce(provider.public_config ->> 'integrationPath','intention')
            = 'intention'
          and provider.required_secret_keys =
            array['secretKey','publicKey','hmacSecret','apiKey']::text[]
          and provider.optional_secret_keys = '{}'::text[]
        )
        or (
          provider.public_config ->> 'integrationPath' = 'quicklink'
          and provider.required_secret_keys =
            array['apiKey','hmacSecret']::text[]
          and provider.optional_secret_keys =
            array['secretKey','publicKey']::text[]
        )
      )
      and private_app.v3_payment_provider_bundle_complete(
        provider.provider_key,
        provider.environment,
        provider.credentials_environment,
        provider.required_secret_keys,
        provider.required_public_config_keys,
        provider.public_config
      )
      and not exists (
        select 1
        from unnest(provider.required_secret_keys) required(secret_key)
        where not exists (
          select 1
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = 'paymob'
            and secret_ref.credentials_environment = 'live'
            and secret_ref.secret_key = required.secret_key
            and secret_ref.vault_secret_id = case required.secret_key
              when 'apiKey' then version.api_key_vault_secret_id
              when 'hmacSecret' then version.hmac_vault_secret_id
              when 'secretKey' then version.secret_key_vault_secret_id
              when 'publicKey' then version.public_key_vault_secret_id
            end
        )
      )
      and private_app.paymob_live_credential_material_valid_v2(
        version.id,
        coalesce(provider.public_config ->> 'integrationPath','intention')
      )
  )
$function$;

revoke all on function private_app.paymob_live_bundle_ready_v2()
from public,anon,authenticated,service_role;

-- This second trigger runs after the existing provider hardening trigger and
-- closes the only state transition that may expose Live credentials.
create or replace function private_app.paymob_live_material_guard_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_valid boolean := false;
begin
  if new.provider_key <> 'paymob'
     or new.environment <> 'live'
     or new.status not in ('configured','active') then
    return new;
  end if;

  select exists (
    select 1
    from marketplace.paymob_credential_versions version
    where version.provider_key = 'paymob'
      and version.environment = 'live'
      and version.status = 'active'
      and version.revoked_at is null
      and private_app.paymob_version_matches_provider_v2(
        version.id,'live',new.public_config
      )
      and not exists (
        select 1
        from unnest(new.required_secret_keys) required(secret_key)
        where not exists (
          select 1
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = 'paymob'
            and secret_ref.credentials_environment = 'live'
            and secret_ref.secret_key = required.secret_key
            and secret_ref.vault_secret_id = case required.secret_key
              when 'apiKey' then version.api_key_vault_secret_id
              when 'hmacSecret' then version.hmac_vault_secret_id
              when 'secretKey' then version.secret_key_vault_secret_id
              when 'publicKey' then version.public_key_vault_secret_id
            end
        )
      )
      and private_app.paymob_live_credential_material_valid_v2(
        version.id,
        coalesce(new.public_config ->> 'integrationPath','intention')
      )
  ) into v_valid;

  if not v_valid then
    raise exception 'paymob_live_credentials_invalid';
  end if;
  return new;
end
$function$;

revoke all on function private_app.paymob_live_material_guard_v2()
from public,anon,authenticated,service_role;

drop trigger if exists zz_paymob_live_material_guard_v2
on marketplace.payment_provider_configs;
create trigger zz_paymob_live_material_guard_v2
before insert or update on marketplace.payment_provider_configs
for each row execute function private_app.paymob_live_material_guard_v2();

-- Trusted ledger sources may produce automated evidence in a controlled Live
-- canary. The source/version/binding checks in the writer remain unchanged.
do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'private_app.paymob_readiness_evidence_write(text,text,boolean,text,text,text,uuid)'
  );
  v_definition text;
  v_old text := $needle$  if p_check_key not in (
       'refund_initiation','live_credentials','live_card_integration_callback',
       'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
     ) and p_environment <> 'sandbox' then
    raise exception 'paymob_readiness_evidence_invalid';
  end if;
$needle$;
begin
  if v_signature is null then
    raise exception 'paymob_readiness_evidence_writer_missing';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if pg_catalog.strpos(v_definition,v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition,v_old,'');
    execute v_definition;
  elsif pg_catalog.strpos(v_definition,
    'and p_environment <> ''sandbox'' then') > 0 then
    raise exception 'paymob_live_evidence_writer_patch_precondition_failed';
  end if;
end
$migration$;

-- Promote canonical webhook and inquiry outcomes into the active Live cohort.
-- Only the pre-existing source-validation function can write these checks.
do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'public.v1_service_paymob_ingest_verified_transaction(text,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,bigint,text,timestamptz,text,boolean)'
  );
  v_definition text;
  v_check text;
begin
  if v_signature is null then raise exception 'paymob_ingest_missing'; end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  v_definition := pg_catalog.replace(
    v_definition,
    'p_environment = ''sandbox''',
    'p_environment in (''sandbox'',''live'')'
  );
  foreach v_check in array array[
    'duplicate_delivery','webhook_hmac','credential_rotation_callback',
    'failed_transaction','paid_transaction'
  ] loop
    v_definition := pg_catalog.replace(
      v_definition,
      '''sandbox'',''' || v_check || '''',
      'p_environment,''' || v_check || ''''
    );
  end loop;
  if pg_catalog.strpos(v_definition,
       'p_environment in (''sandbox'',''live'')') = 0
     or pg_catalog.strpos(v_definition,
       'p_environment,''webhook_hmac''') = 0 then
    raise exception 'paymob_ingest_live_evidence_patch_failed';
  end if;
  execute v_definition;
end
$migration$;

do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'public.v1_service_paymob_reconciliation_apply(uuid,uuid,text,uuid,text,text,text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,bigint,text,bigint,bigint,text)'
  );
  v_definition text;
begin
  if v_signature is null then
    -- Keep the migration fail-closed if the financial worker contract moved.
    raise exception 'paymob_reconciliation_apply_missing';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  v_definition := pg_catalog.replace(
    v_definition,
    'v_attempt.environment = ''sandbox''',
    'v_attempt.environment in (''sandbox'',''live'')'
  );
  v_definition := pg_catalog.replace(
    v_definition,
    '''sandbox'',''refund_inquiry''',
    'v_attempt.environment,''refund_inquiry'''
  );
  v_definition := pg_catalog.replace(
    v_definition,
    '''sandbox'',''transaction_inquiry''',
    'v_attempt.environment,''transaction_inquiry'''
  );
  if pg_catalog.strpos(v_definition,
       'v_attempt.environment,''transaction_inquiry''') = 0
     or pg_catalog.strpos(v_definition,
       'v_attempt.environment,''refund_inquiry''') = 0 then
    raise exception 'paymob_reconciliation_live_evidence_patch_failed';
  end if;
  execute v_definition;
end
$migration$;

-- Repair the historical route metadata without enabling checkout. A previous
-- QuickLink canary row that lacks a maker is explicitly disabled and must be
-- requested/approved again through the public two-person RPC.
update marketplace.payment_provider_configs provider
set required_secret_keys = case
      when coalesce(provider.public_config ->> 'integrationPath','intention')
        = 'quicklink'
        then array['apiKey','hmacSecret']::text[]
      else array['secretKey','publicKey','hmacSecret','apiKey']::text[]
    end,
    optional_secret_keys = case
      when provider.public_config ->> 'integrationPath' = 'quicklink'
        then array['secretKey','publicKey']::text[]
      else '{}'::text[]
    end,
    status = case when provider.status = 'disabled'
      then 'disabled' else 'draft' end,
    rollout_mode = 'observe_only',
    last_verified_at = null,
    last_error_code = case
      when provider.environment = 'live'
        and not private_app.paymob_live_bundle_ready_v2()
        then 'credentials_invalid'
      else 'configuration_incomplete'
    end,
    activated_by_subject_id = null,
    activated_at = null,
    activation_requested_by_subject_id = null,
    activation_requested_at = null,
    activation_requested_mode = null,
    updated_at = now()
where provider.provider_key = 'paymob';

update marketplace.payment_tenant_rollouts rollout
set status = 'disabled',
    approval_code = 'live_canary_reapproval_required',
    requested_by_subject_id = null,
    requested_at = null,
    approved_by_subject_id = null,
    approved_at = null,
    updated_at = now()
where rollout.provider_key = 'paymob'
  and rollout.environment = 'live'
  and rollout.status = 'enabled'
  and (
    rollout.approval_code = 'live_canary_approved'
    and (
      rollout.requested_by_subject_id is null
      or rollout.requested_at is null
      or rollout.approved_by_subject_id is null
      or rollout.approved_at is null
      or rollout.approved_by_subject_id = rollout.requested_by_subject_id
      or rollout.approved_at < rollout.requested_at
      or rollout.approved_at > rollout.requested_at + interval '24 hours'
    )
  );

insert into audit_log.events(
  action,resource_type,resource_id,context
) values (
  'marketplace.paymob.intention_live_validation_v2_deployed',
  'payment_provider','paymob',
  jsonb_build_object(
    'globalLiveActivated',false,
    'liveCanaryRequiresTwoPeople',true,
    'liveCanaryTenant','modaar-training-center',
    'liveCanaryMaxAmountMinor',50000,
    'intentionRequiresFourSecrets',true,
    'liveKeyPrefixesEnforced',true,
    'reefSkillsExcluded',true
  )
);

create or replace function private_app.paymob_evidence_passed(
  p_evidence jsonb,
  p_check_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_active_id uuid;
  v_active_environment text;
  v_active_integration text;
  v_active_owner text;
  v_cohort_id uuid;
  v_sandbox_canary_version_id uuid;
  v_automated_checks constant text[] := array[
    'credentials','intention_create','webhook_hmac','paid_transaction',
    'duplicate_delivery','failed_transaction','transaction_inquiry',
    'credential_rotation_callback','refund_inquiry'
  ]::text[];
begin
  select version.id,version.environment,version.integration_id,version.owner_id,
    provider.sandbox_canary_version_id
  into v_active_id,v_active_environment,v_active_integration,v_active_owner,
    v_sandbox_canary_version_id
  from marketplace.paymob_credential_versions version
  join marketplace.payment_provider_configs provider
    on provider.provider_key = version.provider_key
  where version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = provider.environment
    and provider.credentials_environment = provider.environment
    and private_app.paymob_version_matches_provider_v2(
      version.id,provider.environment,provider.public_config
    )
    and provider.public_config ->> 'region' = 'ksa'
    and provider.checkout_mode = 'redirect'
    and provider.supported_currencies = array['SAR']::text[];
  if v_active_id is null then return false; end if;

  if p_check_key in (
    'refund_initiation','live_credentials','live_card_integration_callback',
    'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
  ) then
    if v_active_environment <> 'live' then return false; end if;
    return exists (
      select 1
      from marketplace.paymob_readiness_evidence_history evidence
      join marketplace.paymob_credential_versions version
        on version.id = evidence.credential_version_id
      where evidence.credential_version_id = v_active_id
        and evidence.environment = 'live'
        and evidence.check_key = p_check_key
        and evidence.passed
        and evidence.source_type = 'operational_attestation'
        and evidence.source_id is not null
        and evidence.evidence_sha256 ~ '^[a-f0-9]{64}$'
        and evidence.checked_at >= version.valid_from
        and evidence.checked_at >= now() - case
          when p_check_key = 'live_credentials' then interval '24 hours'
          else interval '30 days'
        end
        and version.status = 'active'
    );
  end if;

  -- A direct Live validation cohort is coherent because every automated
  -- source is bound to the same active credential version by the writer.
  if v_active_environment = 'live'
     and p_check_key = any(v_automated_checks)
     and exists (
       select 1
       from marketplace.paymob_readiness_evidence_history evidence
       join marketplace.paymob_credential_versions version
         on version.id = evidence.credential_version_id
       where evidence.credential_version_id = v_active_id
         and evidence.environment = 'live'
         and evidence.check_key = p_check_key
         and evidence.passed
         and evidence.source_type is not null
         and evidence.source_id is not null
         and evidence.evidence_sha256 ~ '^[a-f0-9]{64}$'
         and evidence.checked_at >= version.valid_from
         and evidence.checked_at >= now() - interval '30 days'
         and version.status = 'active'
     ) then
    return true;
  end if;

  if v_active_environment = 'sandbox' then
    v_cohort_id := v_active_id;
  else
    select candidate.id into v_cohort_id
    from marketplace.paymob_credential_versions candidate
    where candidate.provider_key = 'paymob'
      and candidate.environment = 'sandbox'
      and candidate.status <> 'revoked'
      and candidate.id = v_sandbox_canary_version_id
      and not exists (
        select 1
        from unnest(v_automated_checks) required(check_key)
        where not exists (
          select 1
          from marketplace.paymob_readiness_evidence_history evidence
          where evidence.credential_version_id = candidate.id
            and evidence.environment = 'sandbox'
            and evidence.check_key = required.check_key
            and evidence.passed
            and evidence.source_type is not null
            and evidence.source_id is not null
            and evidence.evidence_sha256 ~ '^[a-f0-9]{64}$'
            and evidence.checked_at >= candidate.valid_from
            and evidence.checked_at >= now() - interval '30 days'
        )
      )
    order by candidate.valid_from desc,candidate.id
    limit 1;
  end if;
  if v_cohort_id is null then return false; end if;

  return exists (
    select 1
    from marketplace.paymob_readiness_evidence_history evidence
    join marketplace.paymob_credential_versions version
      on version.id = evidence.credential_version_id
    where evidence.credential_version_id = v_cohort_id
      and evidence.environment = 'sandbox'
      and evidence.check_key = p_check_key
      and evidence.passed
      and evidence.source_type is not null
      and evidence.source_id is not null
      and evidence.evidence_sha256 ~ '^[a-f0-9]{64}$'
      and evidence.checked_at >= version.valid_from
      and evidence.checked_at >= now() - interval '30 days'
      and version.status <> 'revoked'
  );
end
$function$;

revoke all on function private_app.paymob_evidence_passed(jsonb,text)
from public,anon,authenticated,service_role;

-- Validation mode is not global Live. It is one two-person-approved model
-- tenant, an observe-only provider, and a hard SAR 500 order ceiling.
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
  select exists (
    select 1
    from core.tenants tenant
    join marketplace.payment_provider_configs provider
      on provider.provider_key = 'paymob'
    join marketplace.payment_tenant_rollouts rollout
      on rollout.tenant_id = tenant.id
     and rollout.provider_key = 'paymob'
     and rollout.environment = 'live'
     and rollout.status = 'enabled'
     and rollout.approval_code = 'live_canary_approved'
     and rollout.requested_by_subject_id is not null
     and rollout.requested_at is not null
     and rollout.approved_by_subject_id is not null
     and rollout.approved_at is not null
     and rollout.approved_by_subject_id <> rollout.requested_by_subject_id
     and rollout.approved_at between rollout.requested_at
       and rollout.requested_at + interval '24 hours'
    where tenant.id = p_tenant_id
      and tenant.slug = 'modaar-training-center'
      and tenant.slug is distinct from 'reef-skills'
      and tenant.tenant_key is distinct from 'tenant-reef-skills'
      and p_environment = 'live'
      and provider.environment = 'live'
      and provider.credentials_environment = 'live'
      and provider.status = 'configured'
      and provider.rollout_mode = 'observe_only'
      and provider.last_verified_at is not null
      and private_app.paymob_live_bundle_ready_v2()
      and (
        select count(*)
        from marketplace.payment_tenant_rollouts live_rollout
        where live_rollout.provider_key = 'paymob'
          and live_rollout.environment = 'live'
          and live_rollout.status = 'enabled'
          and live_rollout.approval_code = 'live_canary_approved'
      ) = 1
  )
$function$;

revoke all on function private_app.paymob_live_canary_eligible_v1(uuid,text)
from public,anon,authenticated,service_role;

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
  select private_app.paymob_live_canary_eligible_v1(
    p_tenant_id,p_environment
  ) or exists (
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
     and version.revoked_at is null
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
      and (
        p_environment <> 'live'
        or private_app.paymob_live_credential_material_valid_v2(
          version.id,
          coalesce(provider.public_config ->> 'integrationPath','intention')
        )
      )
      and cardinality(private_app.paymob_missing_checks(
        provider.readiness_evidence,p_environment
      )) = 0
  )
$function$;

revoke all on function private_app.paymob_tenant_checkout_eligible_v1(
  uuid,text
) from public,anon,authenticated,service_role;

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
as $function$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_merged_public_config jsonb;
  v_secret record;
  v_credential_version_id uuid;
  v_checkout_flow text;
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
    'odeir.payment_provider_actor_id',p_actor_subject_id::text,true
  );
  if p_provider_key = 'paymob' then
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob'
    for update;
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
      coalesce(p_public_config,'{}'::jsonb);
    if jsonb_typeof(p_public_config -> 'applePayIntegrationId') = 'null' then
      v_merged_public_config :=
        v_merged_public_config - 'applePayIntegrationId';
    end if;
    v_checkout_flow := coalesce(
      v_merged_public_config ->> 'integrationPath','intention'
    );
    if v_checkout_flow not in ('intention','quicklink') then
      raise exception 'paymob_public_config_invalid';
    end if;
    if jsonb_typeof(coalesce(p_secrets,'{}'::jsonb)) <> 'object' then
      raise exception 'invalid_payment_provider_secrets';
    end if;

    -- Secret requirements are a property of the selected Paymob API, not a
    -- mutable leftover from the previously selected route.
    update marketplace.payment_provider_configs
    set required_secret_keys = case v_checkout_flow
          when 'intention' then
            array['secretKey','publicKey','hmacSecret','apiKey']::text[]
          else array['apiKey','hmacSecret']::text[]
        end,
        optional_secret_keys = case v_checkout_flow
          when 'intention' then '{}'::text[]
          else array['secretKey','publicKey']::text[]
        end,
        updated_at = now()
    where provider_key = 'paymob'
    returning * into v_provider;

    for v_secret in
      select item.key,item.value
      from jsonb_each(coalesce(p_secrets,'{}'::jsonb)) item
    loop
      if jsonb_typeof(v_secret.value) <> 'string' then
        raise exception 'invalid_payment_provider_secret';
      end if;
      perform private_app.v3_payment_provider_store_secret_v2(
        'paymob',p_environment,v_secret.key,v_secret.value #>> '{}'
      );
    end loop;
    v_credential_version_id :=
      private_app.paymob_finalize_credential_version_v2(
        p_environment,
        v_merged_public_config ->> 'integrationId',
        v_merged_public_config ->> 'merchantAccountId',
        v_checkout_flow,
        nullif(v_merged_public_config ->> 'applePayIntegrationId',''),
        p_actor_subject_id
      );
  end if;

  v_result := private_app.v3_payment_provider_bundle_core(
    p_provider_key,p_environment,p_checkout_mode,p_supported_currencies,
    p_enabled,p_public_config,p_secrets,p_actor_subject_id
  );

  if p_provider_key = 'paymob'
     and v_credential_version_id is not null then
    if p_environment = 'live'
       and not private_app.paymob_live_credential_material_valid_v2(
         v_credential_version_id,v_checkout_flow
       ) then
      raise exception 'paymob_live_credentials_invalid';
    end if;

    perform private_app.paymob_readiness_evidence_write(
      p_environment,'credentials',true,null,null,
      'credential_version',v_credential_version_id
    );

    update marketplace.payment_provider_configs provider
    set status = case when p_enabled then 'configured' else 'disabled' end,
        rollout_mode = 'observe_only',
        last_verified_at = case when p_enabled then now() else null end,
        last_error_code = null,
        activated_by_subject_id = null,
        activated_at = null,
        activation_requested_by_subject_id = null,
        activation_requested_at = null,
        activation_requested_mode = null,
        updated_at = now()
    where provider.provider_key = 'paymob'
      and provider.environment = p_environment
      and provider.credentials_environment = p_environment
      and private_app.v3_payment_provider_bundle_complete(
        provider.provider_key,provider.environment,
        provider.credentials_environment,provider.required_secret_keys,
        provider.required_public_config_keys,provider.public_config
      )
      and exists (
        select 1
        from marketplace.paymob_credential_versions version
        where version.id = v_credential_version_id
          and version.status = 'active'
          and private_app.paymob_version_matches_provider_v2(
            version.id,provider.environment,provider.public_config
          )
      )
    returning * into v_provider;
    if v_provider.provider_key is null then
      raise exception 'payment_provider_configuration_incomplete';
    end if;
    v_result := v_result || jsonb_build_object(
      'status',v_provider.status,
      'configured',v_provider.status = 'configured',
      'liveReady',false
    );
  end if;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'credentialVersionId',v_credential_version_id
  ));
end
$function$;

revoke all on function public.v3_service_payment_provider_bundle_action(
  text,text,text,text[],boolean,jsonb,jsonb,uuid
) from public,anon,authenticated;
grant execute on function public.v3_service_payment_provider_bundle_action(
  text,text,text,text[],boolean,jsonb,jsonb,uuid
) to service_role;

create or replace function public.v1_platform_paymob_tenant_rollout_action(
  p_tenant_id uuid,
  p_environment text,
  p_enabled boolean,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_tenant core.tenants%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_rollout marketplace.payment_tenant_rollouts%rowtype;
  v_request text;
  v_approve text;
  v_live_validation boolean := false;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id = p_tenant_id
  for share;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills' then
    raise exception 'paymob_reef_skills_rollout_prohibited';
  end if;
  if p_environment not in ('sandbox','live') then
    raise exception 'paymob_environment_invalid';
  end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for share;
  v_live_validation := p_environment = 'live'
    and v_tenant.slug = 'modaar-training-center'
    and v_provider.environment = 'live'
    and v_provider.credentials_environment = 'live'
    and v_provider.status = 'configured'
    and v_provider.rollout_mode = 'observe_only'
    and v_provider.last_verified_at is not null
    and private_app.paymob_live_bundle_ready_v2();

  if p_enabled and not (
    (
      v_provider.environment = p_environment
      and v_provider.rollout_mode = p_environment
      and v_provider.last_verified_at is not null
      and (
        (p_environment = 'sandbox' and v_provider.status = 'configured')
        or (p_environment = 'live' and v_provider.status = 'active')
      )
    )
    or v_live_validation
  ) then
    raise exception 'paymob_global_rollout_not_ready';
  end if;

  select rollout.* into v_rollout
  from marketplace.payment_tenant_rollouts rollout
  where rollout.tenant_id = p_tenant_id
    and rollout.provider_key = 'paymob'
    and rollout.environment = p_environment
  for update;

  if not coalesce(p_enabled,false) then
    if p_confirmation <> 'DISABLE PAYMOB TENANT ' || p_tenant_id::text then
      raise exception 'paymob_rollout_confirmation_invalid';
    end if;
    insert into marketplace.payment_tenant_rollouts(
      tenant_id,environment,status,approval_code
    ) values (p_tenant_id,p_environment,'disabled','platform_disabled')
    on conflict (tenant_id,provider_key,environment) do update
    set status = 'disabled',approval_code = 'platform_disabled',
        requested_by_subject_id = null,requested_at = null,
        approved_by_subject_id = null,approved_at = null,updated_at = now()
    returning * into v_rollout;
  else
    v_request := 'REQUEST PAYMOB TENANT ' || p_tenant_id::text ||
      ' ' || upper(p_environment);
    v_approve := 'APPROVE PAYMOB TENANT ' || p_tenant_id::text ||
      ' ' || upper(p_environment);
    if p_confirmation = v_request then
      if v_live_validation and exists (
        select 1
        from marketplace.payment_tenant_rollouts other_rollout
        where other_rollout.provider_key = 'paymob'
          and other_rollout.environment = 'live'
          and other_rollout.tenant_id <> p_tenant_id
          and (
            other_rollout.status = 'enabled'
            or other_rollout.approval_code = 'awaiting_live_canary_checker'
          )
      ) then
        raise exception 'paymob_live_canary_single_tenant_required';
      end if;
      insert into marketplace.payment_tenant_rollouts(
        tenant_id,environment,status,approval_code,
        requested_by_subject_id,requested_at
      ) values (
        p_tenant_id,p_environment,'disabled',
        case when v_live_validation
          then 'awaiting_live_canary_checker' else 'awaiting_checker' end,
        v_actor,now()
      ) on conflict (tenant_id,provider_key,environment) do update
      set status = 'disabled',
          approval_code = excluded.approval_code,
          requested_by_subject_id = v_actor,requested_at = now(),
          approved_by_subject_id = null,approved_at = null,updated_at = now()
      returning * into v_rollout;
    elsif p_confirmation = v_approve then
      if v_rollout.id is null
         or v_rollout.requested_by_subject_id is null
         or v_rollout.requested_by_subject_id = v_actor
         or v_rollout.requested_at < now() - interval '24 hours'
         or v_rollout.approval_code not in (
           'awaiting_checker','awaiting_live_canary_checker'
         ) then
        raise exception 'paymob_rollout_checker_required';
      end if;
      if v_rollout.approval_code = 'awaiting_live_canary_checker' then
        if not v_live_validation then
          raise exception 'paymob_live_canary_gate_closed';
        end if;
        if exists (
          select 1
          from marketplace.payment_tenant_rollouts other_rollout
          where other_rollout.provider_key = 'paymob'
            and other_rollout.environment = 'live'
            and other_rollout.status = 'enabled'
            and other_rollout.tenant_id <> p_tenant_id
        ) then
          raise exception 'paymob_live_canary_single_tenant_required';
        end if;
      end if;
      update marketplace.payment_tenant_rollouts
      set status = 'enabled',
          approval_code = case
            when v_rollout.approval_code = 'awaiting_live_canary_checker'
              then 'live_canary_approved'
            else 'two_person_approved'
          end,
          approved_by_subject_id = v_actor,
          approved_at = now(),updated_at = now()
      where id = v_rollout.id
      returning * into v_rollout;
    else
      raise exception 'paymob_rollout_confirmation_invalid';
    end if;
  end if;

  insert into audit_log.events(
    actor_subject_id,tenant_id,action,resource_type,resource_id,context
  ) values (
    v_actor,p_tenant_id,'marketplace.paymob.tenant_rollout_action',
    'payment_tenant_rollout',v_rollout.id::text,
    jsonb_build_object(
      'environment',p_environment,
      'status',v_rollout.status,
      'approvalCode',v_rollout.approval_code,
      'twoPersonApproved',v_rollout.approved_by_subject_id is not null
        and v_rollout.requested_by_subject_id is not null
        and v_rollout.approved_by_subject_id <>
          v_rollout.requested_by_subject_id,
      'liveValidationCanary',v_rollout.approval_code =
        'live_canary_approved',
      'reefSkillsExcluded',true
    )
  );
  return jsonb_build_object(
    'schemaVersion',1,'tenantId',p_tenant_id,
    'environment',p_environment,'status',v_rollout.status,
    'pendingApproval',v_rollout.requested_by_subject_id is not null
      and v_rollout.approved_by_subject_id is null
  );
end
$function$;

revoke all on function public.v1_platform_paymob_tenant_rollout_action(
  uuid,text,boolean,text
) from public,anon,service_role;
grant execute on function public.v1_platform_paymob_tenant_rollout_action(
  uuid,text,boolean,text
) to authenticated;

-- Patch the V1 preparation authority in place so the existing commercial
-- snapshot, locks and idempotency logic remain the only order authority.
do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'
  );
  v_definition text;
  v_old text;
  v_new text;
begin
  if v_signature is null then raise exception 'paymob_prepare_missing'; end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);

  if pg_catalog.strpos(v_definition,'paymob_live_canary_eligible_v1') = 0 then
    v_old := $needle$  if not (
    (
      v_provider.rollout_mode = 'sandbox'
      and v_provider.environment = 'sandbox'
      and v_provider.status = 'configured'
      and v_provider.last_verified_at is not null
    )
    or (
      v_provider.rollout_mode = 'live'
      and v_provider.environment = 'live'
      and v_provider.status = 'active'
      and v_provider.last_verified_at is not null
    )
  ) then
    raise exception 'paymob_rollout_not_enabled';
  end if;
$needle$;
    v_new := $replacement$  if not (
    (
      v_provider.rollout_mode = 'sandbox'
      and v_provider.environment = 'sandbox'
      and v_provider.status = 'configured'
      and v_provider.last_verified_at is not null
    )
    or (
      v_provider.rollout_mode = 'live'
      and v_provider.environment = 'live'
      and v_provider.status = 'active'
      and v_provider.last_verified_at is not null
    )
    or private_app.paymob_live_canary_eligible_v1(
      v_tenant.id,v_provider.environment
    )
  ) then
    raise exception 'paymob_rollout_not_enabled';
  end if;
$replacement$;
    if pg_catalog.strpos(v_definition,v_old) = 0 then
      raise exception 'paymob_prepare_rollout_patch_target_missing';
    end if;
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);

    v_old := $needle$  if cardinality(private_app.paymob_missing_checks(
    v_provider.readiness_evidence,
    case when v_provider.environment = 'live' then 'live' else 'sandbox' end
  )) <> 0 then
    raise exception 'paymob_readiness_evidence_stale';
  end if;
$needle$;
    v_new := $replacement$  if not private_app.paymob_live_canary_eligible_v1(
       v_tenant.id,v_provider.environment
     )
     and cardinality(private_app.paymob_missing_checks(
       v_provider.readiness_evidence,
       case when v_provider.environment = 'live' then 'live' else 'sandbox' end
     )) <> 0 then
    raise exception 'paymob_readiness_evidence_stale';
  end if;
$replacement$;
    if pg_catalog.strpos(v_definition,v_old) = 0 then
      raise exception 'paymob_prepare_evidence_patch_target_missing';
    end if;
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  if pg_catalog.strpos(v_definition,'paymob_live_canary_amount_limit') = 0 then
    v_old := $needle$  if v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed')
     or v_order.total_minor <= 0
     or v_order.total_minor > 100000000000
     or v_order.currency <> any(v_provider.supported_currencies) then
    raise exception 'marketplace_order_not_payable';
  end if;
$needle$;
    v_new := v_old || $replacement$  if private_app.paymob_live_canary_eligible_v1(
       v_tenant.id,v_provider.environment
     )
     and v_order.total_minor > 50000 then
    raise exception 'paymob_live_canary_amount_limit';
  end if;
$replacement$;
    if pg_catalog.strpos(v_definition,v_old) = 0 then
      raise exception 'paymob_prepare_limit_patch_target_missing';
    end if;
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  if pg_catalog.strpos(v_definition,'paymob_live_canary_amount_limit') = 0 then
    raise exception 'paymob_prepare_canary_verification_failed';
  end if;
  execute v_definition;
end
$migration$;

-- Runtime and resume re-check the same mutable kill switches after the order
-- lock. Extend both with the identical canary predicate; no secret is read
-- before this predicate succeeds.
do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text;
  v_new text;
  v_name text;
begin
  foreach v_name in array array[
    'public.v1_service_paymob_runtime_config(uuid,text,text)',
    'public.v1_service_paymob_resume_checkout(uuid)'
  ] loop
    v_signature := pg_catalog.to_regprocedure(v_name);
    if v_signature is null then
      raise exception 'paymob_runtime_function_missing:%',v_name;
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_signature);

    v_old := $needle$     or v_provider.rollout_mode <> v_attempt.environment
$needle$;
    v_new := $replacement$     or (
       v_provider.rollout_mode <> v_attempt.environment
       and not private_app.paymob_live_canary_eligible_v1(
         v_attempt.tenant_id,v_attempt.environment
       )
     )
$replacement$;
    if pg_catalog.strpos(v_definition,v_new) = 0
       and pg_catalog.strpos(v_definition,v_old) > 0 then
      v_definition := pg_catalog.replace(v_definition,v_old,v_new);
    end if;

    v_old := $needle$     or not (
       (v_attempt.environment = 'sandbox' and v_provider.status = 'configured')
       or (v_attempt.environment = 'live' and v_provider.status = 'active')
     )
$needle$;
    v_new := $replacement$     or not (
       (v_attempt.environment = 'sandbox' and v_provider.status = 'configured')
       or (v_attempt.environment = 'live' and v_provider.status = 'active')
       or private_app.paymob_live_canary_eligible_v1(
         v_attempt.tenant_id,v_attempt.environment
       )
     )
$replacement$;
    if pg_catalog.strpos(v_definition,v_new) = 0
       and pg_catalog.strpos(v_definition,v_old) > 0 then
      v_definition := pg_catalog.replace(v_definition,v_old,v_new);
    end if;

    v_old := $needle$     or cardinality(private_app.paymob_missing_checks(
       v_provider.readiness_evidence,v_attempt.environment
     )) <> 0
$needle$;
    v_new := $replacement$     or (
       cardinality(private_app.paymob_missing_checks(
         v_provider.readiness_evidence,v_attempt.environment
       )) <> 0
       and not private_app.paymob_live_canary_eligible_v1(
         v_attempt.tenant_id,v_attempt.environment
       )
     )
$replacement$;
    if pg_catalog.strpos(v_definition,v_new) = 0
       and pg_catalog.strpos(v_definition,v_old) > 0 then
      v_definition := pg_catalog.replace(v_definition,v_old,v_new);
    end if;

    v_old := $needle$     or v_bound_secret_ref_count <> 4
$needle$;
    v_new := $replacement$     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$replacement$;
    if pg_catalog.strpos(v_definition,v_new) = 0
       and pg_catalog.strpos(v_definition,v_old) > 0 then
      v_definition := pg_catalog.replace(v_definition,v_old,v_new);
    end if;

    v_old := $needle$  select count(*) into v_decrypted_secret_count
  from vault.decrypted_secrets decrypted
  where decrypted.id = any(array[
    v_version.hmac_vault_secret_id,
    v_version.api_key_vault_secret_id,
    v_version.secret_key_vault_secret_id,
    v_version.public_key_vault_secret_id
  ])
    and nullif(decrypted.decrypted_secret,'') is not null;
  if v_decrypted_secret_count <> 4 then
$needle$;
    v_new := $replacement$  if v_attempt.checkout_flow = 'quicklink' then
    select count(*) into v_decrypted_secret_count
    from vault.decrypted_secrets decrypted
    where decrypted.id = any(array[
      v_version.hmac_vault_secret_id,
      v_version.api_key_vault_secret_id
    ])
      and nullif(decrypted.decrypted_secret,'') is not null;
  else
    select count(*) into v_decrypted_secret_count
    from vault.decrypted_secrets decrypted
    where decrypted.id = any(array[
      v_version.hmac_vault_secret_id,
      v_version.api_key_vault_secret_id,
      v_version.secret_key_vault_secret_id,
      v_version.public_key_vault_secret_id
    ])
      and nullif(decrypted.decrypted_secret,'') is not null;
  end if;
  if v_decrypted_secret_count <> (
    case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
  ) then
$replacement$;
    if pg_catalog.strpos(v_definition,
         'if v_decrypted_secret_count <> (' || chr(10) ||
         '    case when v_attempt.checkout_flow = ''quicklink'' then 2 else 4 end') = 0
       and pg_catalog.strpos(v_definition,v_old) > 0 then
      v_definition := pg_catalog.replace(v_definition,v_old,v_new);
    end if;

    if pg_catalog.strpos(v_definition,'paymob_live_canary_eligible_v1') = 0 then
      raise exception 'paymob_runtime_canary_patch_failed:%',v_name;
    end if;
    execute v_definition;
  end loop;
end
$migration$;

-- Persisting an already-created provider intention uses the same canary gate.
-- If the gate closes mid-flight, the existing unknown/reconciliation path is
-- retained and the client secret is never exposed.
do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'public.v1_service_paymob_record_intention(uuid,uuid,text,text,text,text,timestamptz,text,text,text)'
  );
  v_definition text;
  v_old text;
  v_new text;
begin
  if v_signature is null then raise exception 'paymob_record_missing'; end if;
  v_definition := pg_catalog.pg_get_functiondef(v_signature);

  v_old := $needle$       or v_provider.rollout_mode <> v_attempt.environment
$needle$;
  v_new := $replacement$       or (
         v_provider.rollout_mode <> v_attempt.environment
         and not private_app.paymob_live_canary_eligible_v1(
           v_attempt.tenant_id,v_attempt.environment
         )
       )
$replacement$;
  if pg_catalog.strpos(v_definition,v_new) = 0
     and pg_catalog.strpos(v_definition,v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  v_old := $needle$       or not (
         (v_attempt.environment = 'sandbox' and v_provider.status = 'configured')
         or (v_attempt.environment = 'live' and v_provider.status = 'active')
       )
$needle$;
  v_new := $replacement$       or not (
         (v_attempt.environment = 'sandbox' and v_provider.status = 'configured')
         or (v_attempt.environment = 'live' and v_provider.status = 'active')
         or private_app.paymob_live_canary_eligible_v1(
           v_attempt.tenant_id,v_attempt.environment
         )
       )
$replacement$;
  if pg_catalog.strpos(v_definition,v_new) = 0
     and pg_catalog.strpos(v_definition,v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  v_old := $needle$       or v_bound_secret_count <> 4 then
$needle$;
  v_new := $replacement$       or v_bound_secret_count <> (
         case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
       ) then
$replacement$;
  if pg_catalog.strpos(v_definition,v_new) = 0
     and pg_catalog.strpos(v_definition,v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  v_old := $needle$    elsif cardinality(private_app.paymob_missing_checks(
      v_provider.readiness_evidence,v_attempt.environment
    )) <> 0 then
$needle$;
  v_new := $replacement$    elsif cardinality(private_app.paymob_missing_checks(
      v_provider.readiness_evidence,v_attempt.environment
    )) <> 0
      and not private_app.paymob_live_canary_eligible_v1(
        v_attempt.tenant_id,v_attempt.environment
      ) then
$replacement$;
  if pg_catalog.strpos(v_definition,v_new) = 0
     and pg_catalog.strpos(v_definition,v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  -- Intention creation is automated evidence for the exact Live credential
  -- generation; source validation still happens inside the writer.
  v_old := $needle$    if v_attempt.environment = 'sandbox' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox',
        'intention_create',
$needle$;
  v_new := $replacement$    if v_attempt.environment in ('sandbox','live') then
      perform private_app.paymob_readiness_evidence_try_write(
        v_attempt.environment,
        'intention_create',
$replacement$;
  if pg_catalog.strpos(v_definition,v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition,v_old,v_new);
  end if;

  if pg_catalog.strpos(v_definition,'paymob_live_canary_eligible_v1') = 0
     or pg_catalog.strpos(v_definition,
       'v_attempt.environment in (''sandbox'',''live'')') = 0 then
    raise exception 'paymob_record_canary_patch_failed';
  end if;
  execute v_definition;
end
$migration$;

commit;
