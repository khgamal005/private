-- ODEIR Paymob Intention checkout v1.
--
-- Additive, fail-closed payment governance for the service and add-on stores.
-- The redirect/return path is deliberately read-only. Only a service-role call
-- carrying a previously verified Paymob HMAC receipt can settle an order.
--
-- Rollout contract
--   * Paymob is reset to observe_only and never activated by this migration.
--   * apiKey, secretKey, publicKey and hmacSecret are environment-bound Vault
--     requirements. No secret value is stored in marketplace tables.
--   * Region is fixed to `ksa`; merchantAccountId and integrationId must be
--     canonical positive decimal strings.
--   * No tenant is seeded into the canary allowlist. Existing tenants,
--     including Reef Skills, remain excluded until an explicit platform action.
--   * Live activation requires complete sandbox evidence, including an
--     official provider refund-initiation exercise that is outside this v1.
--
-- Reversal contract
--   * Full-refund application never initiates a provider refund and never
--     treats an operator request as payment proof.
--   * A callback flag only creates refund_review. Only an authoritative Paymob
--     inquiry result can establish cumulative refunded amount and currency.
--   * Add-on reversal is source-scoped. A newer or otherwise changed
--     entitlement is retained and escalated for review instead of being
--     disabled as collateral damage.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('core.modules') is null
     or to_regclass('core.tenant_modules') is null
     or to_regclass('access_control.subjects') is null
     or to_regclass('catalog.addon_products') is null
     or to_regclass('catalog.features') is null
     or to_regclass('catalog.tenant_addon_subscriptions') is null
     or to_regclass('catalog.tenant_addon_subscription_events') is null
     or to_regclass('marketplace.orders') is null
     or to_regclass('marketplace.order_items') is null
     or to_regclass('marketplace.order_events') is null
     or to_regclass('marketplace.payment_events') is null
     or to_regclass('marketplace.payment_provider_configs') is null
     or to_regclass('marketplace.payment_provider_secret_refs') is null
     or to_regclass('marketplace.bank_transfer_submissions') is null
     or to_regclass('marketplace.service_products') is null
     or to_regclass('marketplace.service_packages') is null
     or to_regclass('audit_log.events') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regclass('vault.secrets') is null then
    raise exception 'paymob_checkout_missing_required_schema';
  end if;

  if to_regprocedure('private_app.set_updated_at()') is null
     or to_regprocedure('private_app.has_platform_permission(text)') is null
     or to_regprocedure('private_app.has_tenant_permission(uuid,text)') is null
     or to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure('private_app.addon_entitlement(uuid,text)') is null
     or to_regprocedure('private_app.marketplace_order_payload(uuid)') is null
     or to_regprocedure(
       'private_app.v3_payment_provider_bundle_complete(text,text,text,text[],text[],jsonb)'
     ) is null
     or to_regprocedure(
       'private_app.v3_payment_provider_bundle_core(text,text,text,text[],boolean,jsonb,jsonb,uuid)'
     ) is null
     or to_regprocedure('private_app.v3_payment_provider_config_guard()') is null then
    raise exception 'paymob_checkout_missing_required_function';
  end if;
end;
$preflight$;

-------------------------------------------------------------------------------
-- 1. Provider metadata and readiness helpers
-------------------------------------------------------------------------------

alter table marketplace.payment_provider_configs
  add column if not exists rollout_mode text not null default 'observe_only',
  add column if not exists readiness_evidence jsonb not null default '{}'::jsonb,
  add column if not exists readiness_updated_at timestamptz,
  add column if not exists activated_by_subject_id uuid,
  add column if not exists activated_at timestamptz,
  add column if not exists activation_requested_by_subject_id uuid,
  add column if not exists activation_requested_at timestamptz,
  add column if not exists activation_requested_mode text,
  add column if not exists sandbox_canary_version_id uuid,
  add column if not exists sandbox_canary_started_at timestamptz;

alter table marketplace.payment_provider_configs
  add constraint payment_provider_rollout_mode_check_v1
    check (rollout_mode in ('observe_only', 'sandbox', 'live')) not valid,
  add constraint payment_provider_readiness_object_check_v1
    check (
      jsonb_typeof(readiness_evidence) = 'object'
      and not private_app.jsonb_has_sensitive_key(readiness_evidence)
    ) not valid,
  add constraint payment_provider_activated_subject_fk_v1
    foreign key (activated_by_subject_id)
    references access_control.subjects(id)
    on delete set null
    not valid,
  add constraint payment_provider_activation_request_subject_fk_v1
    foreign key (activation_requested_by_subject_id)
    references access_control.subjects(id)
    on delete set null
    not valid,
  add constraint payment_provider_activation_request_mode_check_v1
    check (
      activation_requested_mode is null
      or activation_requested_mode in ('sandbox','live')
    )
    not valid;

create or replace function private_app.paymob_required_checks(
  p_target text
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_target
    when 'sandbox' then array[
      'credentials'
    ]::text[]
    when 'live' then array[
      'credentials',
      'intention_create',
      'webhook_hmac',
      'paid_transaction',
      'duplicate_delivery',
      'failed_transaction',
      'transaction_inquiry',
      'credential_rotation_callback',
      'refund_inquiry',
      'refund_initiation',
      'live_credentials',
      'live_card_integration_callback',
      'edge_query_redaction_waf',
      'reconciler_schedule',
      'outbox_delivery'
    ]::text[]
    else '{}'::text[]
  end
$$;

create or replace function private_app.paymob_evidence_passed(
  p_evidence jsonb,
  p_check_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_active_id uuid;
  v_active_environment text;
  v_active_integration text;
  v_active_owner text;
  v_cohort_id uuid;
  v_sandbox_canary_version_id uuid;
  v_sandbox_cohort_checks constant text[] := array[
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
    and version.integration_id = provider.public_config ->> 'integrationId'
    and version.owner_id = provider.public_config ->> 'merchantAccountId'
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

  if v_active_environment = 'sandbox' then
    v_cohort_id := v_active_id;
  else
    -- Live promotion retains one complete, internally coherent sandbox drill
    -- cohort. Never patchwork checks from multiple credential generations.
    select candidate.id into v_cohort_id
    from marketplace.paymob_credential_versions candidate
    where candidate.provider_key = 'paymob'
      and candidate.environment = 'sandbox'
      and candidate.status <> 'revoked'
      and candidate.id = v_sandbox_canary_version_id
      and not exists (
        select 1
        from unnest(v_sandbox_cohort_checks) required(check_key)
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
end;
$$;

create or replace function private_app.paymob_missing_checks(
  p_evidence jsonb,
  p_target text
)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(required.check_key order by required.ordinality), '{}'::text[])
  from unnest(private_app.paymob_required_checks(p_target))
    with ordinality required(check_key, ordinality)
  where not private_app.paymob_evidence_passed(
    coalesce(p_evidence, '{}'::jsonb),
    required.check_key
  )
$$;

create or replace function private_app.paymob_readiness_evidence_write(
  p_environment text,
  p_check_key text,
  p_passed boolean,
  p_evidence_sha256 text,
  p_error_code text default null,
  p_source_type text default null,
  p_source_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_version_id uuid;
  v_expected_sha256 text;
  v_source_valid boolean := false;
begin
  if p_environment not in ('sandbox', 'live')
     or p_check_key not in (
       'credentials',
       'intention_create',
       'webhook_hmac',
       'paid_transaction',
       'duplicate_delivery',
       'failed_transaction',
       'transaction_inquiry',
       'credential_rotation_callback',
       'refund_inquiry',
       'refund_initiation',
       'live_credentials',
       'live_card_integration_callback',
       'edge_query_redaction_waf',
       'reconciler_schedule',
       'outbox_delivery'
     ) then
    raise exception 'paymob_readiness_evidence_invalid';
  end if;
  if p_check_key in (
       'refund_initiation','live_credentials','live_card_integration_callback',
       'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
     ) and p_environment <> 'live' then
    raise exception 'paymob_readiness_evidence_invalid';
  end if;
  if p_check_key not in (
       'refund_initiation','live_credentials','live_card_integration_callback',
       'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
     ) and p_environment <> 'sandbox' then
    raise exception 'paymob_readiness_evidence_invalid';
  end if;
  if p_evidence_sha256 is not null
     and p_evidence_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_readiness_evidence_invalid';
  end if;
  if coalesce(p_passed,false)
     and p_check_key <> 'credentials'
     and coalesce(p_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_readiness_evidence_digest_required';
  end if;
  v_version_id := case p_source_type
    when 'credential_version' then p_source_id
    when 'payment_attempt' then (
      select attempt.credential_version_id
      from marketplace.payment_attempts attempt
      where attempt.id = p_source_id
    )
    when 'webhook_delivery' then (
      select delivery.credential_version_id
      from marketplace.webhook_deliveries delivery
      where delivery.id = p_source_id
    )
    when 'reconciliation' then (
      select attempt.credential_version_id
      from marketplace.reconciliations reconciliation
      join marketplace.payment_attempts attempt
        on attempt.id = reconciliation.attempt_id
      where reconciliation.id = p_source_id
    )
    when 'operational_attestation' then (
      select request.credential_version_id
      from marketplace.paymob_operational_evidence_requests request
      where request.id = p_source_id
        and request.status = 'approved'
    )
    else null
  end;
  if p_check_key = 'credential_rotation_callback' then
    select version.id into v_version_id
    from marketplace.paymob_credential_versions version
    where version.provider_key = 'paymob'
      and version.environment = p_environment
      and version.status = 'active'
    limit 1;
  end if;
  if coalesce(p_passed,false) and v_version_id is null then
    raise exception 'paymob_readiness_evidence_source_required';
  end if;
  if v_version_id is not null and not exists (
    select 1 from marketplace.paymob_credential_versions version
    where version.id = v_version_id
      and version.provider_key = 'paymob'
      and version.environment = p_environment
      and version.status <> 'revoked'
  ) then raise exception 'paymob_readiness_evidence_version_invalid'; end if;
  if p_error_code is not null
     and p_error_code !~ '^[a-z][a-z0-9_]{1,80}$' then
    raise exception 'paymob_readiness_evidence_invalid';
  end if;

  if coalesce(p_passed,false) then
    if p_check_key = 'credentials' then
      select encode(extensions.digest(convert_to(jsonb_build_object(
        'credentialVersionId',version.id,'environment',version.environment,
        'integrationId',version.integration_id,'owner',version.owner_id,
        'hmacVaultSecretId',version.hmac_vault_secret_id,
        'apiKeyVaultSecretId',version.api_key_vault_secret_id,
        'secretKeyVaultSecretId',version.secret_key_vault_secret_id,
        'publicKeyVaultSecretId',version.public_key_vault_secret_id,
        'region','ksa','checkoutMode','redirect','currency','SAR'
      )::text,'utf8'),'sha256'),'hex')
      into v_expected_sha256
      from marketplace.paymob_credential_versions version
      where version.id = v_version_id;
      p_evidence_sha256 := v_expected_sha256;
      v_source_valid := p_source_type = 'credential_version';
    elsif p_check_key = 'intention_create' then
      select exists (
        select 1 from marketplace.payment_attempts attempt
        where attempt.id = p_source_id
          and attempt.credential_version_id = v_version_id
          and attempt.environment = p_environment
          and attempt.response_sha256 = p_evidence_sha256
          and attempt.provider_intention_id is not null
          and attempt.provider_order_id is not null
          and attempt.status in ('intention_created','pending','paid','refunded')
      ) into v_source_valid;
    elsif p_check_key in (
      'webhook_hmac','paid_transaction','duplicate_delivery',
      'failed_transaction','credential_rotation_callback'
    ) then
      select exists (
        select 1
        from marketplace.webhook_deliveries delivery
        join marketplace.payment_attempts attempt on attempt.id = delivery.attempt_id
        join marketplace.paymob_credential_versions create_version
          on create_version.id = attempt.credential_version_id
        join marketplace.paymob_credential_versions signer_version
          on signer_version.id = delivery.credential_version_id
        where delivery.id = p_source_id
          and delivery.environment = p_environment
          and delivery.payload_sha256 = p_evidence_sha256
          and delivery.hmac_verified
          and delivery.binding_status = 'matched'
          and (
            (p_check_key = 'webhook_hmac')
            or (p_check_key = 'paid_transaction' and delivery.outcome = 'paid')
            or (
              p_check_key = 'duplicate_delivery'
              and delivery.outcome = 'paid'
              and delivery.duplicate_delivery_count > 0
            )
            or (p_check_key = 'failed_transaction' and delivery.outcome = 'failed')
            or (
              p_check_key = 'credential_rotation_callback'
              and attempt.credential_version_id <> v_version_id
              and delivery.credential_version_id = attempt.credential_version_id
              and create_version.status <> 'revoked'
              and signer_version.status <> 'revoked'
              and create_version.environment = signer_version.environment
              and create_version.integration_id = signer_version.integration_id
              and create_version.owner_id = signer_version.owner_id
              and exists (
                select 1
                from marketplace.paymob_credential_versions active_version
                where active_version.id = v_version_id
                  and active_version.environment = create_version.environment
                  and active_version.integration_id = create_version.integration_id
                  and active_version.owner_id = create_version.owner_id
                  and active_version.valid_from <= delivery.created_at
              )
            )
          )
      ) into v_source_valid;
    elsif p_check_key in ('transaction_inquiry','refund_inquiry') then
      select exists (
        select 1
        from marketplace.reconciliations reconciliation
        where reconciliation.id = p_source_id
          and reconciliation.environment = p_environment
          and reconciliation.evidence_sha256 = p_evidence_sha256
          and reconciliation.status = 'matched'
          and (
            (p_check_key = 'transaction_inquiry'
              and reconciliation.reconciliation_type in (
                'transaction_inquiry','intention_unknown'
              ) and reconciliation.observed_state = 'paid')
            or (p_check_key = 'refund_inquiry'
              and reconciliation.reconciliation_type = 'refund_inquiry'
              and reconciliation.observed_state = 'full_refund')
          )
      ) into v_source_valid;
    else
      select exists (
        select 1
        from marketplace.paymob_operational_evidence_requests request
        where request.id = p_source_id
          and request.credential_version_id = v_version_id
          and request.environment = p_environment
          and request.check_key = p_check_key
          and request.evidence_sha256 = p_evidence_sha256
          and request.status = 'approved'
          and request.approved_by_subject_id is not null
          and request.approved_by_subject_id <> request.requested_by_subject_id
          and request.expires_at > now()
      ) into v_source_valid;
    end if;
    if not coalesce(v_source_valid,false) then
      raise exception 'paymob_readiness_evidence_source_invalid';
    end if;
  end if;

  v_entry := jsonb_strip_nulls(jsonb_build_object(
    'passed', coalesce(p_passed, false),
    'environment', p_environment,
    'checkedAt', now(),
    'credentialVersionId', v_version_id,
    'evidenceSha256', p_evidence_sha256,
    'sourceType',p_source_type,
    'sourceId',p_source_id,
    'errorCode', p_error_code
  ));

  if coalesce(p_evidence_sha256,'') ~ '^[a-f0-9]{64}$'
     and v_version_id is not null then
    insert into marketplace.paymob_readiness_evidence_history(
      credential_version_id,environment,check_key,passed,
      evidence_sha256,source_type,source_id,error_code,checked_at
    ) values (
      v_version_id,p_environment,p_check_key,coalesce(p_passed,false),
      p_evidence_sha256,p_source_type,p_source_id,p_error_code,now()
    );
  end if;

  update marketplace.payment_provider_configs
  set readiness_evidence = jsonb_set(
        coalesce(readiness_evidence, '{}'::jsonb),
        array[p_check_key],
        v_entry,
        true
      ),
      readiness_updated_at = now(),
      rollout_mode = case when not coalesce(p_passed,false)
        then 'observe_only' else rollout_mode end,
      status = case
        when not coalesce(p_passed,false) and status <> 'disabled' then 'draft'
        else status
      end,
      last_verified_at = case when not coalesce(p_passed,false)
        then null else last_verified_at end,
      last_error_code = case when not coalesce(p_passed,false)
        then coalesce(p_error_code,'readiness_check_failed') else last_error_code end,
      activated_by_subject_id = case when not coalesce(p_passed,false)
        then null else activated_by_subject_id end,
      activated_at = case when not coalesce(p_passed,false)
        then null else activated_at end,
      updated_at = now()
  where provider_key = 'paymob';
end;
$$;

revoke all on function private_app.paymob_required_checks(text)
from public, anon, authenticated, service_role;
revoke all on function private_app.paymob_evidence_passed(jsonb,text)
from public, anon, authenticated, service_role;
revoke all on function private_app.paymob_missing_checks(jsonb,text)
from public, anon, authenticated, service_role;
revoke all on function private_app.paymob_readiness_evidence_write(
  text,text,boolean,text,text,text,uuid
) from public, anon, authenticated, service_role;

create or replace function private_app.paymob_readiness_evidence_try_write(
  p_environment text,
  p_check_key text,
  p_passed boolean,
  p_evidence_sha256 text,
  p_error_code text,
  p_source_type text,
  p_source_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private_app.paymob_readiness_evidence_write(
    p_environment,p_check_key,p_passed,p_evidence_sha256,p_error_code,
    p_source_type,p_source_id
  );
  return true;
exception when others then
  insert into audit_log.events(
    action,resource_type,resource_id,context
  ) values (
    'marketplace.paymob.readiness_telemetry_failed',
    coalesce(p_source_type,'paymob_readiness_source'),
    coalesce(p_source_id::text,'unbound'),
    jsonb_build_object(
      'environment',p_environment,'checkKey',p_check_key,
      'sqlstate',sqlstate,'financialMutationRolledBack',false,
      'piiStored',false,'secretStored',false
    )
  );
  return false;
end;
$$;

revoke all on function private_app.paymob_readiness_evidence_try_write(
  text,text,boolean,text,text,text,uuid
) from public, anon, authenticated, service_role;

-- Remove invalid legacy public identifiers instead of blessing them. No secret
-- or tenant data is touched. A complete actor-attributed bundle save is required
-- before Paymob can return to configured status.
update marketplace.payment_provider_configs
set required_secret_keys =
      array['secretKey','publicKey','hmacSecret','apiKey']::text[],
    optional_secret_keys = '{}'::text[],
    required_public_config_keys =
      array['merchantAccountId','integrationId','region']::text[],
    public_config = jsonb_strip_nulls(jsonb_build_object(
      'merchantAccountId', case
        when public_config ->> 'merchantAccountId' ~ '^[1-9][0-9]{0,29}$'
          then public_config ->> 'merchantAccountId'
        else null
      end,
      'integrationId', case
        when public_config ->> 'integrationId' ~ '^[1-9][0-9]{0,29}$'
          then public_config ->> 'integrationId'
        else null
      end,
      'region', 'ksa'
    )),
    status = case when status = 'disabled' then 'disabled' else 'draft' end,
    rollout_mode = 'observe_only',
    last_verified_at = null,
    last_error_code = case
      when status = 'disabled' then last_error_code
      else 'configuration_incomplete'
    end,
    activated_by_subject_id = null,
    activated_at = null,
    activation_requested_by_subject_id = null,
    activation_requested_at = null,
    activation_requested_mode = null,
    sandbox_canary_version_id = null,
    sandbox_canary_started_at = null,
    updated_at = now()
where provider_key = 'paymob';

-- Replace the former adapter placeholder with a Paymob-only readiness gate.
-- Other providers retain the original fail-closed behavior.
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
        and version.integration_id = new.public_config ->> 'integrationId'
        and version.owner_id = new.public_config ->> 'merchantAccountId'
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

revoke all on function private_app.v3_payment_provider_config_guard()
from public, anon, authenticated, service_role;

create or replace function private_app.paymob_secret_rotation_invalidate_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_key text := coalesce(new.provider_key, old.provider_key);
begin
  if v_provider_key = 'paymob' then
    update marketplace.payment_provider_configs
    set readiness_evidence = '{}'::jsonb,
        readiness_updated_at = now(),
        rollout_mode = 'observe_only',
        status = case when status = 'disabled' then 'disabled' else 'draft' end,
        last_verified_at = null,
        last_error_code = case
          when status = 'disabled' then last_error_code
          else 'configuration_incomplete'
        end,
        activated_by_subject_id = null,
        activated_at = null,
        activation_requested_by_subject_id = null,
        activation_requested_at = null,
        activation_requested_mode = null,
        sandbox_canary_version_id = case
          when coalesce(new.credentials_environment,old.credentials_environment)
            = 'live' then sandbox_canary_version_id else null end,
        sandbox_canary_started_at = case
          when coalesce(new.credentials_environment,old.credentials_environment)
            = 'live' then sandbox_canary_started_at else null end,
        updated_at = now()
    where provider_key = 'paymob';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private_app.paymob_secret_rotation_invalidate_v1()
from public, anon, authenticated, service_role;

create or replace function private_app.paymob_secret_rotation_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_key text := coalesce(new.provider_key, old.provider_key);
  v_environment text := coalesce(
    old.credentials_environment,
    new.credentials_environment,
    (
      select provider.environment
      from marketplace.payment_provider_configs provider
      where provider.provider_key = v_provider_key
    )
  );
begin
  if v_provider_key = 'paymob'
     and tg_op in ('UPDATE','DELETE')
     and not (
       tg_op = 'UPDATE'
       and old.provider_key = 'paymob'
       and new.provider_key = 'paymob'
       and new.credentials_environment = old.credentials_environment
     )
     and exists (
       select 1
       from marketplace.payment_attempts attempt
       where attempt.provider_key = 'paymob'
         and attempt.environment = v_environment
         and attempt.status in (
           'prepared','creating_intention','intention_created','pending',
           'unknown','quarantined'
         )
     ) then
    raise exception 'paymob_open_attempts_must_drain_before_rotation';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private_app.paymob_secret_rotation_guard_v1()
from public, anon, authenticated, service_role;

create trigger payment_provider_paymob_secret_rotation_guard_v1
before update or delete on marketplace.payment_provider_secret_refs
for each row execute function private_app.paymob_secret_rotation_guard_v1();

create trigger payment_provider_paymob_secret_invalidate_v1
after insert or update or delete on marketplace.payment_provider_secret_refs
for each row execute function private_app.paymob_secret_rotation_invalidate_v1();

-------------------------------------------------------------------------------
-- 2. Tenant-scoped payment ledger, evidence, outbox and rollout tables
-------------------------------------------------------------------------------

-- Paymob signs asynchronous callbacks with the credential that was current
-- when checkout was created. Keep one current and, during a bounded rotation
-- window, one retiring HMAC credential. Only Vault identifiers and immutable
-- merchant bindings live here; secret values never do.
create table marketplace.paymob_credential_versions (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  hmac_vault_secret_id uuid not null,
  api_key_vault_secret_id uuid not null,
  secret_key_vault_secret_id uuid not null,
  public_key_vault_secret_id uuid not null,
  billing_digest_vault_secret_id uuid not null,
  integration_id text not null check (integration_id ~ '^[1-9][0-9]{0,29}$'),
  owner_id text not null check (owner_id ~ '^[1-9][0-9]{0,29}$'),
  status text not null default 'active' check (
    status in ('active','retiring','expired','revoked')
  ),
  valid_from timestamptz not null default now(),
  retiring_at timestamptz,
  valid_until timestamptz,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  retired_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  revoked_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  revocation_reason_code text check (
    revocation_reason_code is null
    or revocation_reason_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider_key = 'paymob'),
  check (
    (status = 'active' and retiring_at is null and valid_until is null)
    or (
      status = 'retiring'
      and retiring_at is not null
      and valid_until is not null
      and valid_until > retiring_at
    )
    or (status = 'expired' and valid_until is not null)
    or (
      status = 'revoked'
      and revoked_at is not null
      and revocation_reason_code is not null
    )
  )
);

create unique index paymob_hmac_one_active_version_idx_v1
on marketplace.paymob_credential_versions(provider_key)
where status = 'active';
create unique index paymob_hmac_one_retiring_version_idx_v1
on marketplace.paymob_credential_versions(provider_key)
where status = 'retiring';
create index paymob_hmac_candidate_window_idx_v1
on marketplace.paymob_credential_versions(status, valid_until, created_at desc);

alter table marketplace.payment_provider_configs
  add constraint payment_provider_sandbox_canary_version_fk_v1
  foreign key (sandbox_canary_version_id)
  references marketplace.paymob_credential_versions(id)
  on delete restrict
  not valid;

create table marketplace.paymob_readiness_evidence_history (
  id uuid primary key default gen_random_uuid(),
  credential_version_id uuid not null
    references marketplace.paymob_credential_versions(id) on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  check_key text not null check (check_key in (
    'credentials','intention_create','webhook_hmac','paid_transaction',
    'duplicate_delivery','failed_transaction','transaction_inquiry',
    'credential_rotation_callback','refund_inquiry','refund_initiation',
    'live_credentials','live_card_integration_callback',
    'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
  )),
  passed boolean not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  source_type text,
  source_id uuid,
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
  ,check ((source_type is null) = (source_id is null))
);
create index paymob_readiness_history_lookup_idx_v1
on marketplace.paymob_readiness_evidence_history(
  check_key,environment,checked_at desc,credential_version_id
);

create table marketplace.paymob_operational_evidence_requests (
  id uuid primary key default gen_random_uuid(),
  credential_version_id uuid not null
    references marketplace.paymob_credential_versions(id) on delete restrict,
  environment text not null check (environment = 'live'),
  check_key text not null check (check_key in (
    'refund_initiation','live_credentials','live_card_integration_callback',
    'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
  )),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired')),
  requested_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  requested_at timestamptz not null default now(),
  approved_by_subject_id uuid
    references access_control.subjects(id) on delete restrict,
  approved_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (credential_version_id,check_key,evidence_sha256),
  check (approved_by_subject_id is null
    or approved_by_subject_id <> requested_by_subject_id),
  check (
    (status = 'approved' and approved_by_subject_id is not null
      and approved_at is not null)
    or status <> 'approved'
  )
);
create index paymob_operational_evidence_pending_idx_v1
on marketplace.paymob_operational_evidence_requests(
  status,requested_at,check_key
) where status = 'pending';
create unique index paymob_operational_evidence_one_pending_idx_v1
on marketplace.paymob_operational_evidence_requests(
  credential_version_id,check_key
) where status = 'pending';

-- Paymob bundle values are versioned by creating fresh Vault rows. The
-- current refs remain the admin bundle pointer; prior Vault rows are retained
-- through immutable credential-version snapshots for webhook and inquiry drain.
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
  v_current_secret text;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_environment not in ('sandbox','live') then
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

  if v_ref.vault_secret_id is not null then
    select decrypted.decrypted_secret into v_current_secret
    from vault.decrypted_secrets decrypted
    where decrypted.id = v_ref.vault_secret_id;
    if v_current_secret is null then
      raise exception 'payment_provider_vault_secret_unavailable';
    end if;
    if v_current_secret = p_secret_value
       and v_ref.credentials_environment = p_environment then
      return v_ref.vault_secret_id;
    end if;
  end if;

  if p_provider_key = 'paymob' then
    v_vault_id := gen_random_uuid();
    v_vault_name := 'marketplace_paymob_' || p_environment || '_' ||
      lower(regexp_replace(p_secret_key, '[^A-Za-z0-9]+', '_', 'g')) ||
      '_' || replace(v_vault_id::text, '-', '');
    v_vault_id := vault.create_secret(
      p_secret_value,
      v_vault_name,
      'Versioned Paymob credential. Never return outside its purpose-scoped service RPC.'
    );
    if v_ref.vault_secret_id is null then
      insert into marketplace.payment_provider_secret_refs(
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
      update marketplace.payment_provider_secret_refs
      set vault_secret_id = v_vault_id,
          credentials_environment = p_environment,
          last_rotated_at = now(),
          updated_at = now()
      where provider_key = p_provider_key
        and secret_key = p_secret_key;
    end if;
    return v_vault_id;
  end if;

  v_vault_name := 'marketplace_' || p_provider_key || '_' ||
    p_environment || '_' ||
    lower(regexp_replace(p_secret_key, '[^A-Za-z0-9]+', '_', 'g'));
  if v_ref.vault_secret_id is null then
    v_vault_id := vault.create_secret(
      p_secret_value,
      v_vault_name,
      'Environment-bound payment credential. Never return to clients.'
    );
    insert into marketplace.payment_provider_secret_refs(
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
  text,text,text,text
) from public, anon, authenticated, service_role;

create or replace function private_app.paymob_finalize_credential_version_v1(
  p_environment text,
  p_integration_id text,
  p_owner_id text,
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
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_environment not in ('sandbox','live')
     or p_integration_id !~ '^[1-9][0-9]{0,29}$'
     or p_owner_id !~ '^[1-9][0-9]{0,29}$'
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
     and v_current.hmac_vault_secret_id = v_new_hmac_id
     and v_current.api_key_vault_secret_id = v_new_api_key_id
     and v_current.secret_key_vault_secret_id = v_new_secret_key_id
     and v_current.public_key_vault_secret_id = v_new_public_key_id then
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
      'priorVersionRetiring', v_current.id is not null,
      'overlapDays', 7,
      'allSecretsStoredInVault', true,
      'secretReturned', false
    )
  );
  return v_version_id;
end;
$$;

revoke all on function private_app.paymob_finalize_credential_version_v1(
  text,text,text,uuid
) from public, anon, authenticated, service_role;


-- Propagate only the actor and non-secret target bindings transaction-locally
-- so the Vault writer can snapshot the exact account being saved.
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
    v_merged_public_config := v_provider.public_config ||
      coalesce(p_public_config, '{}'::jsonb);
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
      private_app.paymob_finalize_credential_version_v1(
        p_environment,
        v_merged_public_config ->> 'integrationId',
        v_merged_public_config ->> 'merchantAccountId',
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

revoke all on function public.v3_service_payment_provider_bundle_action(
  text,text,text,text[],boolean,jsonb,jsonb,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.v3_service_payment_provider_bundle_action(
  text,text,text,text[],boolean,jsonb,jsonb,uuid
) to service_role;

create table marketplace.payment_attempts (
  id uuid primary key,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  credential_version_id uuid not null
    references marketplace.paymob_credential_versions(id)
    on delete restrict,
  idempotency_key text not null
    check (length(idempotency_key) between 8 and 120),
  special_reference text not null,
  status text not null default 'prepared' check (status in (
    'prepared',
    'creating_intention',
    'intention_created',
    'pending',
    'paid',
    'failed',
    'unknown',
    'quarantined',
    'refunded',
    'cancelled'
  )),
  order_number_snapshot text not null,
  order_kind_snapshot text not null check (order_kind_snapshot in ('service','addon')),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_minor bigint not null check (tax_minor >= 0),
  tax_rate_bps integer not null check (tax_rate_bps between 0 and 10000),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  billing_contact_sha256 text not null check (
    billing_contact_sha256 ~ '^[a-f0-9]{64}$'
  ),
  items_snapshot_sha256 text not null check (
    items_snapshot_sha256 ~ '^[a-f0-9]{64}$'
  ),
  provider_intention_id text,
  provider_order_id text,
  provider_transaction_id text,
  provider_request_id text,
  checkout_secret_id uuid,
  checkout_secret_expires_at timestamptz,
  claim_token uuid,
  claim_expires_at timestamptz,
  last_error_code text check (
    last_error_code is null
    or last_error_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  response_sha256 text check (
    response_sha256 is null or response_sha256 ~ '^[a-f0-9]{64}$'
  ),
  provider_expires_at timestamptz,
  prepared_at timestamptz not null default now(),
  expires_at timestamptz not null,
  intention_recorded_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key, environment, tenant_id, idempotency_key),
  check (provider_key = 'paymob'),
  check (special_reference = id::text),
  check (amount_minor = subtotal_minor + tax_minor),
  check (
    expires_at > prepared_at
    and expires_at <= prepared_at + interval '1 hour'
  ),
  check (
    provider_expires_at is null
    or (
      provider_expires_at > prepared_at
      and provider_expires_at <= expires_at - interval '30 seconds'
    )
  ),
  check (
    (status = 'creating_intention' and claim_token is not null and claim_expires_at is not null)
    or status <> 'creating_intention'
  ),
  check (
    (checkout_secret_id is null and checkout_secret_expires_at is null)
    or (
      checkout_secret_id is not null
      and checkout_secret_expires_at is not null
      and provider_expires_at is not null
      and checkout_secret_expires_at = provider_expires_at
      and checkout_secret_expires_at <= expires_at
    )
  )
);

create unique index payment_attempts_active_order_idx
on marketplace.payment_attempts(provider_key, environment, order_id)
where status in (
  'prepared',
  'creating_intention',
  'intention_created',
  'pending',
  'unknown',
  'quarantined'
);

create unique index payment_attempts_provider_intention_idx
on marketplace.payment_attempts(provider_key, environment, provider_intention_id)
where provider_intention_id is not null;

create unique index payment_attempts_provider_order_idx
on marketplace.payment_attempts(provider_key, environment, provider_order_id)
where provider_order_id is not null;

create unique index payment_attempts_provider_transaction_idx
on marketplace.payment_attempts(provider_key, environment, provider_transaction_id)
where provider_transaction_id is not null;

create index payment_attempts_tenant_created_idx
on marketplace.payment_attempts(tenant_id, created_at desc);

create index payment_attempts_status_updated_idx
on marketplace.payment_attempts(status, updated_at)
where status in ('creating_intention','intention_created','pending','unknown','quarantined');

create table marketplace.payment_attempt_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  attempt_id uuid not null references marketplace.payment_attempts(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  order_item_id uuid not null references marketplace.order_items(id) on delete restrict,
  item_type text not null check (item_type in ('service','addon')),
  product_key text not null,
  addon_product_id uuid references catalog.addon_products(id) on delete restrict,
  feature_id uuid references catalog.features(id) on delete restrict,
  activation_mode_snapshot text,
  service_product_id uuid references marketplace.service_products(id) on delete restrict,
  service_package_id uuid references marketplace.service_packages(id) on delete restrict,
  pricing_mode_snapshot text,
  billing_interval_snapshot text,
  quantity integer not null check (quantity between 1 and 1000),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  unique (attempt_id, order_item_id),
  check (line_total_minor = unit_amount_minor * quantity),
  check (
    (
      item_type = 'addon'
      and addon_product_id is not null
      and feature_id is not null
      and activation_mode_snapshot in ('entitlement','module')
      and service_product_id is null
    )
    or
    (
      item_type = 'service'
      and service_product_id is not null
      and addon_product_id is null
      and feature_id is null
      and activation_mode_snapshot is null
    )
  )
);

create index payment_attempt_items_tenant_attempt_idx
on marketplace.payment_attempt_items(tenant_id, attempt_id, created_at);
create index payment_attempt_items_order_idx
on marketplace.payment_attempt_items(order_id, order_item_id);

create table marketplace.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete restrict,
  order_id uuid references marketplace.orders(id) on delete restrict,
  attempt_id uuid references marketplace.payment_attempts(id) on delete restrict,
  credential_version_id uuid not null
    references marketplace.paymob_credential_versions(id)
    on delete restrict,
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  provider_transaction_id text not null,
  provider_order_id text not null,
  provider_integration_id text not null,
  provider_owner_id text not null,
  signed_state_sha256 text not null check (
    signed_state_sha256 ~ '^[a-f0-9]{64}$'
  ),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  hmac_verified boolean not null check (hmac_verified),
  special_reference_valid boolean not null default false,
  binding_status text not null check (binding_status in ('matched','mismatched')),
  outcome text not null check (outcome in (
    'pending','paid','failed','quarantined','refund_review'
  )),
  duplicate_delivery_count integer not null default 0
    check (duplicate_delivery_count between 0 and 1000000),
  success boolean not null,
  pending boolean not null,
  error_occured boolean not null,
  has_parent_transaction boolean not null,
  is_3d_secure boolean not null,
  is_auth boolean not null,
  is_capture boolean not null,
  is_standalone_payment boolean not null,
  is_voided boolean not null,
  is_refunded boolean not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  quarantine_code text check (
    quarantine_code is null
    or quarantine_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  provider_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (
    provider_key,
    environment,
    provider_transaction_id,
    signed_state_sha256,
    special_reference_valid
  ),
  check (provider_key = 'paymob'),
  check (
    (
      binding_status = 'matched'
      and tenant_id is not null
      and order_id is not null
      and attempt_id is not null
    )
    or binding_status = 'mismatched'
  )
);

create index webhook_deliveries_attempt_created_idx
on marketplace.webhook_deliveries(attempt_id, created_at desc);
create index webhook_deliveries_tenant_created_idx
on marketplace.webhook_deliveries(tenant_id, created_at desc);
create index webhook_deliveries_quarantine_idx
on marketplace.webhook_deliveries(tenant_id, created_at desc)
where binding_status = 'mismatched' or outcome in ('quarantined','refund_review');

create table marketplace.entitlement_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  order_item_id uuid not null references marketplace.order_items(id) on delete restrict,
  attempt_id uuid not null references marketplace.payment_attempts(id) on delete restrict,
  addon_product_id uuid not null
    references catalog.addon_products(id) on delete restrict,
  subscription_id uuid
    references catalog.tenant_addon_subscriptions(id) on delete restrict,
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  provider_transaction_id text not null,
  source_kind text not null default 'paid_order'
    check (source_kind = 'paid_order'),
  state text not null default 'active'
    check (state in ('active','reversed','review_required')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  previous_subscription_id uuid,
  previous_status text,
  previous_period_start timestamptz,
  previous_period_end timestamptz,
  previous_source text,
  previous_payment_provider_key text,
  previous_marketplace_order_id uuid,
  previous_auto_renew boolean,
  previous_cancel_at_period_end boolean,
  previous_requested_note text,
  previous_requested_by_subject_id uuid,
  previous_decided_by_subject_id uuid,
  previous_decision_note text,
  previous_activated_at timestamptz,
  previous_ended_at timestamptz,
  granted_status text,
  granted_source text,
  granted_period_start timestamptz,
  granted_period_end timestamptz,
  granted_payment_provider_key text,
  granted_marketplace_order_id uuid,
  granted_auto_renew boolean,
  granted_cancel_at_period_end boolean,
  granted_requested_note text,
  granted_requested_by_subject_id uuid,
  granted_decided_by_subject_id uuid,
  granted_decision_note text,
  granted_activated_at timestamptz,
  granted_ended_at timestamptz,
  module_id uuid references core.modules(id) on delete restrict,
  previous_module_present boolean,
  previous_module_enabled boolean,
  previous_module_configuration jsonb,
  previous_module_enabled_at timestamptz,
  granted_module_enabled boolean,
  granted_module_configuration jsonb,
  granted_module_enabled_at timestamptz,
  applied_at timestamptz,
  reversed_at timestamptz,
  reversal_refund_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_item_id),
  unique (provider_key, environment, provider_transaction_id, order_item_id),
  check (provider_key = 'paymob')
);

create index entitlement_sources_tenant_product_idx
on marketplace.entitlement_sources(tenant_id, addon_product_id, created_at desc);
create index entitlement_sources_subscription_idx
on marketplace.entitlement_sources(subscription_id, created_at desc)
where subscription_id is not null;

create table marketplace.refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  attempt_id uuid not null references marketplace.payment_attempts(id) on delete restrict,
  source_delivery_id uuid
    references marketplace.webhook_deliveries(id) on delete restrict,
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  provider_transaction_id text not null,
  provider_refund_id text,
  refund_kind text not null check (refund_kind in ('refund','void')),
  status text not null default 'review_required' check (status in (
    'requested','review_required','processing','succeeded','failed','unknown',
    'applied','applied_with_review','rejected'
  )),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  verified_refunded_minor bigint check (
    verified_refunded_minor is null or verified_refunded_minor >= 0
  ),
  verified_currency text check (
    verified_currency is null or verified_currency ~ '^[A-Z]{3}$'
  ),
  inquiry_reconciliation_id uuid,
  idempotency_key text,
  requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  approved_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  approved_at timestamptz,
  dispatch_claim_token uuid,
  dispatch_claim_expires_at timestamptz,
  dispatched_at timestamptz,
  provider_http_status integer check (
    provider_http_status is null or provider_http_status between 100 and 599
  ),
  resolved_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  resolution_code text check (
    resolution_code is null or resolution_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  provider_created_at timestamptz,
  requested_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_delivery_id),
  check (provider_key = 'paymob'),
  check (
    approved_by_subject_id is null
    or requested_by_subject_id is null
    or approved_by_subject_id <> requested_by_subject_id
  ),
  check (
    (dispatch_claim_token is null and dispatch_claim_expires_at is null)
    or (dispatch_claim_token is not null and dispatch_claim_expires_at is not null)
  )
);

create unique index refunds_provider_reference_idx
on marketplace.refunds(provider_key, environment, provider_refund_id)
where provider_refund_id is not null;
create unique index refunds_idempotency_idx
on marketplace.refunds(provider_key, environment, tenant_id, idempotency_key)
where idempotency_key is not null;
create index refunds_review_queue_idx
on marketplace.refunds(status, created_at)
where status in ('requested','review_required','unknown');
create index refunds_tenant_created_idx
on marketplace.refunds(tenant_id, created_at desc);
create unique index refunds_one_open_charge_idx_v1
on marketplace.refunds(attempt_id,provider_transaction_id)
where status in (
  'requested','review_required','processing','unknown','succeeded'
);

alter table marketplace.entitlement_sources
  add constraint entitlement_sources_reversal_refund_fk_v1
  foreign key (reversal_refund_id)
  references marketplace.refunds(id)
  on delete restrict
  not valid;

create table marketplace.reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  attempt_id uuid not null references marketplace.payment_attempts(id) on delete restrict,
  source_delivery_id uuid
    references marketplace.webhook_deliveries(id) on delete restrict,
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  inquiry_credential_version_id uuid
    references marketplace.paymob_credential_versions(id) on delete restrict,
  reconciliation_type text not null check (reconciliation_type in (
    'intention_unknown','transaction_inquiry','binding_mismatch','refund_inquiry'
  )),
  status text not null default 'queued' check (status in (
    'queued','running','matched','mismatch','unknown','failed',
    'review_required','resolved'
  )),
  provider_transaction_id text,
  last_observed_transaction_id text,
  provider_order_id text,
  expected_amount_minor bigint not null check (expected_amount_minor > 0),
  expected_currency text not null check (expected_currency ~ '^[A-Z]{3}$'),
  observed_amount_minor bigint check (
    observed_amount_minor is null or observed_amount_minor >= 0
  ),
  observed_currency text check (
    observed_currency is null or observed_currency ~ '^[A-Z]{3}$'
  ),
  observed_order_paid_minor bigint check (
    observed_order_paid_minor is null or observed_order_paid_minor >= 0
  ),
  observed_cumulative_refunded_minor bigint check (
    observed_cumulative_refunded_minor is null
    or observed_cumulative_refunded_minor >= 0
  ),
  observed_state text check (
    observed_state is null or observed_state ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  evidence_sha256 text check (
    evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  due_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  checked_at timestamptz,
  absence_resolution_requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  absence_resolution_requested_at timestamptz,
  absence_resolution_evidence_sha256 text check (
    absence_resolution_evidence_sha256 is null
    or absence_resolution_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  absence_resolution_approved_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  absence_resolution_approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, reconciliation_type),
  check (
    (lease_token is null and lease_owner is null and lease_expires_at is null)
    or (
      lease_token is not null
      and lease_owner is not null
      and lease_expires_at is not null
    )
  ),
  check (
    absence_resolution_approved_by_subject_id is null
    or (
      absence_resolution_requested_by_subject_id is not null
      and absence_resolution_approved_by_subject_id
        <> absence_resolution_requested_by_subject_id
      and absence_resolution_approved_at is not null
      and absence_resolution_evidence_sha256 is not null
    )
  ),
  check (provider_key = 'paymob')
);

alter table marketplace.refunds
  add constraint refunds_inquiry_reconciliation_fk_v1
  foreign key (inquiry_reconciliation_id)
  references marketplace.reconciliations(id)
  on delete restrict
  not valid;

create index reconciliations_queue_idx
on marketplace.reconciliations(status, due_at)
where status in ('queued','unknown','failed');
create index reconciliations_tenant_created_idx
on marketplace.reconciliations(tenant_id, created_at desc);

create table marketplace.payment_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete restrict,
  order_id uuid references marketplace.orders(id) on delete restrict,
  attempt_id uuid references marketplace.payment_attempts(id) on delete restrict,
  dedupe_key text not null check (length(dedupe_key) between 8 and 240),
  event_type text not null check (event_type in (
    'checkout_created',
    'payment_paid',
    'payment_failed',
    'payment_quarantined',
    'refund_review',
    'refund_applied',
    'reconciliation_review'
  )),
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object'
    and not private_app.jsonb_has_sensitive_key(payload)
  ),
  delivery_status text not null default 'pending' check (
    delivery_status in ('pending','processing','delivered','failed')
  ),
  available_at timestamptz not null default now(),
  delivered_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dedupe_key),
  check (
    event_type in ('payment_quarantined','reconciliation_review')
    or (tenant_id is not null and order_id is not null)
  )
);

create index payment_outbox_delivery_idx
on marketplace.payment_outbox(delivery_status, available_at, created_at)
where delivery_status in ('pending','failed');
create index payment_outbox_tenant_created_idx
on marketplace.payment_outbox(tenant_id, created_at desc);

create table marketplace.payment_tenant_rollouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  provider_key text not null default 'paymob'
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  environment text not null check (environment in ('sandbox','live')),
  status text not null default 'disabled' check (status in ('disabled','enabled')),
  approval_code text check (
    approval_code is null or approval_code ~ '^[a-z][a-z0-9_]{1,80}$'
  ),
  requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  requested_at timestamptz,
  approved_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider_key, environment),
  check (provider_key = 'paymob'),
  check (
    (status = 'enabled' and approved_by_subject_id is not null and approved_at is not null)
    or status = 'disabled'
  ),
  check (
    approved_by_subject_id is null
    or requested_by_subject_id is null
    or approved_by_subject_id <> requested_by_subject_id
  )
);

create index payment_tenant_rollouts_provider_status_idx
on marketplace.payment_tenant_rollouts(provider_key, environment, status, tenant_id);

create trigger payment_attempts_set_updated_at_v1
before update on marketplace.payment_attempts
for each row execute function private_app.set_updated_at();
create trigger paymob_credential_versions_set_updated_at_v1
before update on marketplace.paymob_credential_versions
for each row execute function private_app.set_updated_at();
create trigger entitlement_sources_set_updated_at_v1
before update on marketplace.entitlement_sources
for each row execute function private_app.set_updated_at();
create trigger refunds_set_updated_at_v1
before update on marketplace.refunds
for each row execute function private_app.set_updated_at();
create trigger reconciliations_set_updated_at_v1
before update on marketplace.reconciliations
for each row execute function private_app.set_updated_at();
create trigger payment_outbox_set_updated_at_v1
before update on marketplace.payment_outbox
for each row execute function private_app.set_updated_at();
create trigger payment_tenant_rollouts_set_updated_at_v1
before update on marketplace.payment_tenant_rollouts
for each row execute function private_app.set_updated_at();
create trigger paymob_operational_evidence_set_updated_at_v1
before update on marketplace.paymob_operational_evidence_requests
for each row execute function private_app.set_updated_at();

alter table marketplace.payment_attempts enable row level security;
alter table marketplace.payment_attempts force row level security;
alter table marketplace.paymob_credential_versions enable row level security;
alter table marketplace.paymob_credential_versions force row level security;
alter table marketplace.paymob_readiness_evidence_history enable row level security;
alter table marketplace.paymob_readiness_evidence_history force row level security;
alter table marketplace.paymob_operational_evidence_requests enable row level security;
alter table marketplace.paymob_operational_evidence_requests force row level security;
alter table marketplace.payment_attempt_items enable row level security;
alter table marketplace.payment_attempt_items force row level security;
alter table marketplace.webhook_deliveries enable row level security;
alter table marketplace.webhook_deliveries force row level security;
alter table marketplace.entitlement_sources enable row level security;
alter table marketplace.entitlement_sources force row level security;
alter table marketplace.refunds enable row level security;
alter table marketplace.refunds force row level security;
alter table marketplace.reconciliations enable row level security;
alter table marketplace.reconciliations force row level security;
alter table marketplace.payment_outbox enable row level security;
alter table marketplace.payment_outbox force row level security;
alter table marketplace.payment_tenant_rollouts enable row level security;
alter table marketplace.payment_tenant_rollouts force row level security;

revoke all on table marketplace.payment_attempts
from public, anon, authenticated, service_role;
revoke all on table marketplace.paymob_credential_versions
from public, anon, authenticated, service_role;
revoke all on table marketplace.paymob_readiness_evidence_history
from public, anon, authenticated, service_role;
revoke all on table marketplace.paymob_operational_evidence_requests
from public, anon, authenticated, service_role;
revoke all on table marketplace.payment_attempt_items
from public, anon, authenticated, service_role;
revoke all on table marketplace.webhook_deliveries
from public, anon, authenticated, service_role;
revoke all on table marketplace.entitlement_sources
from public, anon, authenticated, service_role;
revoke all on table marketplace.refunds
from public, anon, authenticated, service_role;
revoke all on table marketplace.reconciliations
from public, anon, authenticated, service_role;
revoke all on table marketplace.payment_outbox
from public, anon, authenticated, service_role;
revoke all on table marketplace.payment_tenant_rollouts
from public, anon, authenticated, service_role;

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
     and version.integration_id = provider.public_config ->> 'integrationId'
     and version.owner_id = provider.public_config ->> 'merchantAccountId'
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

revoke all on function private_app.paymob_tenant_checkout_eligible_v1(
  uuid,text
) from public, anon, authenticated, service_role;

create or replace function private_app.paymob_order_review_hold_v1(
  p_order_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from marketplace.reconciliations reconciliation
    where reconciliation.order_id = p_order_id
      and reconciliation.provider_key = 'paymob'
      and reconciliation.status in ('review_required','mismatch')
  )
$$;

revoke all on function private_app.paymob_order_review_hold_v1(uuid)
from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 3. Internal outbox and verified-payment guard
-------------------------------------------------------------------------------

create or replace function private_app.paymob_outbox_enqueue(
  p_tenant_id uuid,
  p_order_id uuid,
  p_attempt_id uuid,
  p_event_type text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_event_type not in (
    'checkout_created',
    'payment_paid',
    'payment_failed',
    'payment_quarantined',
    'refund_review',
    'refund_applied',
    'reconciliation_review'
  )
     or nullif(btrim(p_dedupe_key), '') is null
     or length(p_dedupe_key) not between 8 and 240
     or (
       p_event_type not in ('payment_quarantined','reconciliation_review')
       and (p_tenant_id is null or p_order_id is null)
     )
     or jsonb_typeof(v_payload) <> 'object'
     or private_app.jsonb_has_sensitive_key(v_payload) then
    raise exception 'paymob_outbox_event_invalid';
  end if;

  insert into marketplace.payment_outbox(
    tenant_id,
    order_id,
    attempt_id,
    event_type,
    dedupe_key,
    payload
  ) values (
    p_tenant_id,
    p_order_id,
    p_attempt_id,
    p_event_type,
    p_dedupe_key,
    v_payload
  )
  on conflict (dedupe_key) do update
  set attempt_id = coalesce(
        marketplace.payment_outbox.attempt_id,
        excluded.attempt_id
      ),
      payload = marketplace.payment_outbox.payload || excluded.payload,
      available_at = least(
        marketplace.payment_outbox.available_at,
        excluded.available_at
      ),
      updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function private_app.paymob_outbox_enqueue(
  uuid,uuid,uuid,text,text,jsonb
) from public, anon, authenticated, service_role;

-- The legacy platform confirmation path can still settle bank transfers and
-- other non-Paymob methods. It cannot mark an order paid/refunded as Paymob.
-- The transaction-local value below is set only inside the verified receipt or
-- verified-refund application functions in this migration.
create or replace function private_app.paymob_order_payment_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected_order text;
  v_sensitive_transition boolean;
  v_has_paymob_attempt boolean := false;
begin
  if tg_op = 'UPDATE' then
    select exists (
      select 1
      from marketplace.payment_attempts attempt
      where attempt.order_id = old.id
        and attempt.tenant_id = old.tenant_id
        and attempt.provider_key = 'paymob'
    ) into v_has_paymob_attempt;
  end if;
  if tg_op = 'UPDATE'
     and new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and exists (
       select 1
       from marketplace.payment_attempts attempt
       where attempt.order_id = old.id
         and attempt.tenant_id = old.tenant_id
         and attempt.provider_key = 'paymob'
         and attempt.status in (
           'prepared','creating_intention','intention_created','pending',
           'unknown','quarantined','paid'
         )
     ) then
    raise exception 'paymob_order_cancel_requires_payment_resolution';
  end if;

  if tg_op = 'UPDATE'
     and v_has_paymob_attempt
     and old.payment_provider = 'paymob'
     and new.payment_provider is distinct from 'paymob'
     and current_setting('odeir.paymob_verified_order_id', true)
       is distinct from new.id::text then
    raise exception 'paymob_payment_provider_change_requires_governed_path';
  end if;

  v_sensitive_transition :=
    (
      new.payment_provider = 'paymob'
      or (tg_op = 'UPDATE' and old.payment_provider = 'paymob')
      or v_has_paymob_attempt
    )
    and new.payment_status in ('paid','refunded')
    and (
      tg_op = 'INSERT'
      or old.payment_provider is distinct from new.payment_provider
      or old.payment_status is distinct from new.payment_status
    );

  if v_sensitive_transition then
    v_expected_order := current_setting(
      'odeir.paymob_verified_order_id',
      true
    );
    if v_expected_order is distinct from new.id::text then
      raise exception 'paymob_verified_receipt_required';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private_app.paymob_order_payment_guard_v1()
from public, anon, authenticated, service_role;

create trigger marketplace_orders_paymob_payment_guard_v1
before insert or update on marketplace.orders
for each row execute function private_app.paymob_order_payment_guard_v1();

-------------------------------------------------------------------------------
-- 4. Tenant checkout authorization and immutable commercial snapshot
-------------------------------------------------------------------------------

create or replace function private_app.paymob_billing_contact_digest_v1(
  p_billing_contact jsonb,
  p_credential_version_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted.decrypted_secret into v_secret
  from marketplace.paymob_credential_versions version
  join vault.decrypted_secrets decrypted
    on decrypted.id = version.billing_digest_vault_secret_id
  where version.id = p_credential_version_id
    and version.provider_key = 'paymob'
    and version.status <> 'revoked';
  if nullif(v_secret,'') is null then
    raise exception 'paymob_billing_digest_key_unavailable';
  end if;
  return encode(extensions.hmac(
    convert_to(p_billing_contact::text,'utf8'),
    convert_to(v_secret,'utf8'),
    'sha256'
  ),'hex');
end;
$$;

revoke all on function private_app.paymob_billing_contact_digest_v1(jsonb,uuid)
from public, anon, authenticated, service_role;

create or replace function public.v1_tenant_paymob_prepare_checkout(
  p_slug text,
  p_order_id uuid,
  p_idempotency_key text,
  p_billing_contact jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_order marketplace.orders%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_credential_version marketplace.paymob_credential_versions%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_active_attempt marketplace.payment_attempts%rowtype;
  v_actor uuid;
  v_billing jsonb;
  v_items jsonb;
  v_settlement_snapshot jsonb;
  v_billing_hash text;
  v_items_hash text;
  v_idempotency_key text;
  v_now timestamptz := now();
  v_create_allowed boolean := false;
begin
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills' then
    raise exception 'paymob_reef_skills_rollout_prohibited';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'tenant_subject_not_found'; end if;

  v_idempotency_key := nullif(btrim(p_idempotency_key), '');
  if v_idempotency_key is null
     or v_idempotency_key !~ '^[A-Za-z0-9_-]{16,120}$' then
    raise exception 'paymob_idempotency_required';
  end if;

  if jsonb_typeof(coalesce(p_billing_contact, '{}'::jsonb)) <> 'object'
     or jsonb_object_length(coalesce(p_billing_contact, '{}'::jsonb)) > 4
     or exists (
       select 1
       from jsonb_object_keys(coalesce(p_billing_contact, '{}'::jsonb)) key_name
       where key_name not in ('firstName','lastName','email','phoneNumber')
     ) then
    raise exception 'paymob_billing_contact_invalid';
  end if;

  v_billing := jsonb_build_object(
    'firstName', btrim(coalesce(p_billing_contact ->> 'firstName', '')),
    'lastName', btrim(coalesce(p_billing_contact ->> 'lastName', '')),
    'email', lower(btrim(coalesce(p_billing_contact ->> 'email', ''))),
    'phoneNumber', btrim(coalesce(p_billing_contact ->> 'phoneNumber', ''))
  );
  if length(v_billing ->> 'firstName') not between 1 and 100
     or length(v_billing ->> 'lastName') not between 1 and 100
     or length(v_billing ->> 'email') not between 3 and 254
     or v_billing ->> 'email' !~
       '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or length(v_billing ->> 'phoneNumber') not between 7 and 30
     or v_billing ->> 'phoneNumber' !~ '^[+0-9][0-9 +()_-]{6,29}$' then
    raise exception 'paymob_billing_contact_invalid';
  end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for share;
  if v_provider.provider_key is null
     or v_provider.checkout_mode <> 'redirect'
     or v_provider.public_config ->> 'region' <> 'ksa'
     or v_provider.public_config ->> 'merchantAccountId'
       !~ '^[1-9][0-9]{0,29}$'
     or v_provider.public_config ->> 'integrationId'
       !~ '^[1-9][0-9]{0,29}$'
     or not private_app.v3_payment_provider_bundle_complete(
       v_provider.provider_key,
       v_provider.environment,
       v_provider.credentials_environment,
       v_provider.required_secret_keys,
       v_provider.required_public_config_keys,
       v_provider.public_config
     ) then
    raise exception 'paymob_provider_unavailable';
  end if;
  if not (
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
  if cardinality(private_app.paymob_missing_checks(
    v_provider.readiness_evidence,
    case when v_provider.environment = 'live' then 'live' else 'sandbox' end
  )) <> 0 then
    raise exception 'paymob_readiness_evidence_stale';
  end if;
  select version.* into v_credential_version
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = v_provider.environment
    and version.integration_id = v_provider.public_config ->> 'integrationId'
    and version.owner_id = v_provider.public_config ->> 'merchantAccountId'
  for share;
  if v_credential_version.id is null then
    raise exception 'paymob_active_credential_version_required';
  end if;
  v_billing_hash := private_app.paymob_billing_contact_digest_v1(
    v_billing,v_credential_version.id
  );
  if not exists (
    select 1
    from marketplace.payment_tenant_rollouts rollout
    where rollout.tenant_id = v_tenant.id
      and rollout.provider_key = 'paymob'
      and rollout.environment = v_provider.environment
      and rollout.status = 'enabled'
  ) then
    raise exception 'paymob_tenant_not_enabled';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || p_order_id::text,0
  ));
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = p_order_id
    and orders.tenant_id = v_tenant.id
  for update;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
  if private_app.paymob_order_review_hold_v1(v_order.id) then
    raise exception 'paymob_order_payment_review_hold';
  end if;
  if v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed')
     or v_order.total_minor <= 0
     or v_order.total_minor > 100000000000
     or v_order.currency <> any(v_provider.supported_currencies) then
    raise exception 'marketplace_order_not_payable';
  end if;
  if v_order.payment_provider is not null
     and v_order.payment_provider not in ('paymob','bank_transfer') then
    raise exception 'marketplace_payment_provider_mismatch';
  end if;
  if v_order.payment_provider = 'bank_transfer' and exists (
    select 1
    from marketplace.bank_transfer_submissions transfer
    where transfer.order_id = v_order.id
      and transfer.tenant_id = v_tenant.id
      and transfer.status in ('pending','reviewing','approved')
  ) then
    raise exception 'marketplace_payment_provider_mismatch';
  end if;

  -- Lock every commercial row that feeds the provider items and the eventual
  -- fulfillment snapshot.  Both representations are then materialized from
  -- the same locked values, so a same-total catalog/order edit cannot swap
  -- the product, package, feature, interval, or activation mode mid-checkout.
  perform item.id
  from marketplace.order_items item
  where item.order_id = v_order.id
  order by item.id
  for share;
  perform product.id
  from catalog.addon_products product
  where product.id in (
    select item.addon_product_id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.addon_product_id is not null
  )
  order by product.id
  for share;
  perform feature.id
  from catalog.features feature
  where feature.id in (
    select product.feature_id
    from catalog.addon_products product
    join marketplace.order_items item
      on item.addon_product_id = product.id
    where item.order_id = v_order.id
  )
  order by feature.id
  for share;
  perform product.id
  from marketplace.service_products product
  where product.id in (
    select item.service_product_id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.service_product_id is not null
  )
  order by product.id
  for share;
  perform package.id
  from marketplace.service_packages package
  where package.id in (
    select item.service_package_id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.service_package_id is not null
  )
  order by package.id
  for share;

  if not exists (
    select 1 from marketplace.order_items item
    where item.order_id = v_order.id
  )
     or exists (
       select 1 from marketplace.order_items item
       where item.order_id = v_order.id
         and item.item_type <> v_order.order_kind
     ) then
    raise exception 'marketplace_order_items_invalid';
  end if;
  if v_order.order_kind = 'addon' and exists (
    select 1 from marketplace.order_items item
    where item.order_id = v_order.id
      and item.quantity <> 1
  ) then
    raise exception 'paymob_addon_quantity_must_equal_one';
  end if;

  -- A `from` or `quote` service is never charged at its teaser/catalog amount.
  -- It needs an explicit, currently active package whose fixed commercial
  -- amount and currency exactly match the immutable order item snapshot.
  if v_order.order_kind = 'service' and exists (
    select 1
    from marketplace.order_items item
    join marketplace.service_products product
      on product.id = item.service_product_id
    left join marketplace.service_packages package
      on package.id = item.service_package_id
    where item.order_id = v_order.id
      and product.pricing_mode in ('from','quote')
      and (
        package.id is null
        or package.status <> 'active'
        or package.service_product_id <> product.id
        or package.amount_minor <> item.unit_amount_minor
        or package.currency <> v_order.currency
      )
  ) then
    raise exception 'paymob_service_fixed_package_required';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'orderItemId',item.id,
    'itemType',item.item_type,
    'productKey',item.product_key,
    'productName',left(item.product_name_ar,160),
    'addonProductId',item.addon_product_id,
    'featureId',addon.feature_id,
    'activationMode',addon.activation_mode,
    'serviceProductId',item.service_product_id,
    'servicePackageId',item.service_package_id,
    'pricingMode',case when item.item_type = 'addon'
      then addon.pricing_mode else service.pricing_mode end,
    'billingInterval',case when item.item_type = 'addon'
      then addon.interval else null end,
    'quantity',item.quantity,
    'unitAmountMinor',item.unit_amount_minor,
    'lineTotalMinor',item.line_total_minor,
    'currency',v_order.currency
  )) order by item.created_at,item.id), '[]'::jsonb)
  into v_settlement_snapshot
  from marketplace.order_items item
  left join catalog.addon_products addon
    on addon.id = item.addon_product_id
  left join marketplace.service_products service
    on service.id = item.service_product_id
  where item.order_id = v_order.id;

  select coalesce(jsonb_agg(line.provider_item order by line.sort_order),'[]'::jsonb)
  into v_items
  from (
    select entry.ordinality::bigint as sort_order,
      jsonb_build_object(
        'name',entry.value ->> 'productName',
        -- Paymob Intention items use a line total. Quantity is descriptive
        -- metadata and must not be multiplied again by the provider.
        'amount',(entry.value ->> 'lineTotalMinor')::bigint,
        'description',left(entry.value ->> 'productKey',160),
        'quantity',(entry.value ->> 'quantity')::integer
      ) as provider_item
    from jsonb_array_elements(v_settlement_snapshot)
      with ordinality entry(value,ordinality)
    union all
    select 9223372036854775807::bigint,
      jsonb_build_object(
        'name','ضريبة القيمة المضافة',
        'amount',v_order.tax_minor,
        'description','VAT',
        'quantity',1
      )
    where v_order.tax_minor > 0
  ) line;
  if jsonb_array_length(v_items) = 0
     or (
       select coalesce(sum((entry ->> 'amount')::bigint), 0)
       from jsonb_array_elements(v_items) entry
     ) <> v_order.total_minor then
    raise exception 'paymob_item_amount_mismatch';
  end if;
  v_items_hash := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'orderItems',v_settlement_snapshot,
      'subtotalMinor',v_order.subtotal_minor,
      'taxMinor',v_order.tax_minor,
      'taxRateBps',v_order.tax_rate_bps,
      'totalMinor',v_order.total_minor,
      'currency',v_order.currency
    )::text, 'utf8'),
    'sha256'
  ), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:prepare:' || v_provider.environment || ':' || v_order.id::text,
    0
  ));

  select attempt.* into v_active_attempt
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = v_provider.environment
    and attempt.order_id = v_order.id
    and attempt.status = 'prepared'
    and attempt.expires_at <= v_now
    and attempt.claim_token is null
    and attempt.provider_intention_id is null
    and attempt.provider_order_id is null
    and attempt.provider_transaction_id is null
  order by attempt.created_at desc
  limit 1
  for update;
  if v_active_attempt.id is not null then
    update marketplace.payment_attempts
    set status = 'failed',
        last_error_code = 'checkout_expired_before_provider_call',
        terminal_at = v_now,
        updated_at = v_now
    where id = v_active_attempt.id;
    perform private_app.paymob_outbox_enqueue(
      v_active_attempt.tenant_id,
      v_active_attempt.order_id,
      v_active_attempt.id,
      'payment_failed',
      'payment_failed:prepared_expired:' || v_active_attempt.id::text,
      jsonb_build_object(
        'attemptId', v_active_attempt.id,
        'provider', 'paymob',
        'environment', v_active_attempt.environment,
        'errorCode', 'checkout_expired_before_provider_call',
        'providerCallStarted', false
      )
    );
  end if;

  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = v_provider.environment
    and attempt.tenant_id = v_tenant.id
    and attempt.idempotency_key = v_idempotency_key
  for update;
  if v_attempt.id is not null then
    v_billing_hash := private_app.paymob_billing_contact_digest_v1(
      v_billing,v_attempt.credential_version_id
    );
    if v_attempt.order_id <> v_order.id
       or v_attempt.amount_minor <> v_order.total_minor
       or v_attempt.currency <> v_order.currency
       or v_attempt.items_snapshot_sha256 <> v_items_hash then
      raise exception 'paymob_idempotency_conflict';
    end if;
    if v_attempt.status = 'prepared'
       and v_attempt.billing_contact_sha256 <> v_billing_hash then
      raise exception 'paymob_billing_contact_changed';
    end if;
    v_create_allowed :=
      v_attempt.status = 'prepared' and v_attempt.expires_at > v_now;
    return jsonb_build_object(
      'schemaVersion', 1,
      'createAllowed', v_create_allowed,
      'attemptId', v_attempt.id,
      'attemptStatus', v_attempt.status,
      'expiresAt', v_attempt.expires_at,
      'billingDataValidated', v_create_allowed,
      'order', jsonb_build_object(
        'id', v_order.id,
        'number', v_order.order_number,
        'kind', v_order.order_kind,
        'status', v_order.status,
        'paymentStatus', v_order.payment_status,
        'amountMinor', v_order.total_minor,
        'currency', v_order.currency
      ),
      'provider', jsonb_build_object(
        'key', 'paymob',
        'region', 'ksa',
        'environment', v_provider.environment,
        'checkoutMode', v_provider.checkout_mode
      ),
      'items', v_items
    );
  end if;

  select attempt.* into v_active_attempt
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = v_provider.environment
    and attempt.order_id = v_order.id
    and attempt.status in (
      'prepared','creating_intention','intention_created',
      'pending','unknown','quarantined'
    )
  order by attempt.created_at desc
  limit 1
  for update;
  if v_active_attempt.id is not null then
    return jsonb_build_object(
      'schemaVersion', 1,
      'createAllowed', false,
      'attemptId', v_active_attempt.id,
      'attemptStatus', v_active_attempt.status,
      'expiresAt', v_active_attempt.expires_at,
      'billingDataValidated', false,
      'order', jsonb_build_object(
        'id', v_order.id,
        'number', v_order.order_number,
        'kind', v_order.order_kind,
        'status', v_order.status,
        'paymentStatus', v_order.payment_status,
        'amountMinor', v_order.total_minor,
        'currency', v_order.currency
      ),
      'provider', jsonb_build_object(
        'key', 'paymob',
        'region', 'ksa',
        'environment', v_provider.environment,
        'checkoutMode', v_provider.checkout_mode
      ),
      'items', v_items
    );
  end if;

  v_attempt.id := gen_random_uuid();
  insert into marketplace.payment_attempts(
    id,
    tenant_id,
    order_id,
    requested_by_subject_id,
    provider_key,
    environment,
    credential_version_id,
    idempotency_key,
    special_reference,
    status,
    order_number_snapshot,
    order_kind_snapshot,
    subtotal_minor,
    tax_minor,
    tax_rate_bps,
    amount_minor,
    currency,
    billing_contact_sha256,
    items_snapshot_sha256,
    prepared_at,
    expires_at,
    created_at,
    updated_at
  ) values (
    v_attempt.id,
    v_tenant.id,
    v_order.id,
    v_actor,
    'paymob',
    v_provider.environment,
    v_credential_version.id,
    v_idempotency_key,
    v_attempt.id::text,
    'prepared',
    v_order.order_number,
    v_order.order_kind,
    v_order.subtotal_minor,
    v_order.tax_minor,
    v_order.tax_rate_bps,
    v_order.total_minor,
    v_order.currency,
    v_billing_hash,
    v_items_hash,
    v_now,
    v_now + interval '1 hour',
    v_now,
    v_now
  ) returning * into v_attempt;

  insert into marketplace.payment_attempt_items(
    tenant_id,
    attempt_id,
    order_id,
    order_item_id,
    item_type,
    product_key,
    addon_product_id,
    feature_id,
    activation_mode_snapshot,
    service_product_id,
    service_package_id,
    pricing_mode_snapshot,
    billing_interval_snapshot,
    quantity,
    unit_amount_minor,
    line_total_minor,
    currency
  )
  select
    v_tenant.id,
    v_attempt.id,
    v_order.id,
    (entry.value ->> 'orderItemId')::uuid,
    entry.value ->> 'itemType',
    entry.value ->> 'productKey',
    nullif(entry.value ->> 'addonProductId','')::uuid,
    nullif(entry.value ->> 'featureId','')::uuid,
    entry.value ->> 'activationMode',
    nullif(entry.value ->> 'serviceProductId','')::uuid,
    nullif(entry.value ->> 'servicePackageId','')::uuid,
    entry.value ->> 'pricingMode',
    entry.value ->> 'billingInterval',
    (entry.value ->> 'quantity')::integer,
    (entry.value ->> 'unitAmountMinor')::bigint,
    (entry.value ->> 'lineTotalMinor')::bigint,
    v_order.currency
  from jsonb_array_elements(v_settlement_snapshot) entry(value);

  if (
    select coalesce(sum(snapshot.line_total_minor), 0)
    from marketplace.payment_attempt_items snapshot
    where snapshot.attempt_id = v_attempt.id
      and snapshot.tenant_id = v_tenant.id
      and snapshot.order_id = v_order.id
  ) <> v_attempt.subtotal_minor then
    raise exception 'paymob_attempt_snapshot_mismatch';
  end if;

  update marketplace.orders
  set payment_provider = 'paymob',
      payment_status = 'pending',
      payment_reference = null,
      updated_at = now()
  where id = v_order.id;

  insert into marketplace.order_events(
    order_id,
    tenant_id,
    actor_subject_id,
    event_type,
    from_status,
    to_status,
    metadata
  ) values (
    v_order.id,
    v_tenant.id,
    v_actor,
    'paymob_checkout_prepared',
    v_order.status,
    v_order.status,
    jsonb_build_object(
      'attemptId', v_attempt.id,
      'environment', v_attempt.environment,
      'expiresAt', v_attempt.expires_at
    )
  );

  perform private_app.paymob_outbox_enqueue(
    v_tenant.id,
    v_order.id,
    v_attempt.id,
    'checkout_created',
    'checkout:' || v_attempt.id::text,
    jsonb_build_object(
      'attemptId', v_attempt.id,
      'orderNumber', v_order.order_number,
      'provider', 'paymob',
      'environment', v_attempt.environment,
      'amountMinor', v_attempt.amount_minor,
      'currency', v_attempt.currency,
      'expiresAt', v_attempt.expires_at
    )
  );

  insert into audit_log.events(
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    v_tenant.id,
    v_actor,
    'marketplace.paymob.checkout_prepared',
    'payment_attempt',
    v_attempt.id::text,
    jsonb_build_object(
      'orderId', v_order.id,
      'orderNumber', v_order.order_number,
      'environment', v_attempt.environment,
      'amountMinor', v_attempt.amount_minor,
      'currency', v_attempt.currency,
      'rawBillingStored', false,
      'pseudonymousBillingDigestStored', true,
      'billingDigestProtection', 'credential_keyed_hmac_sha256',
      'secretStored', false
    )
  );

  return jsonb_build_object(
    'schemaVersion', 1,
    'createAllowed', true,
    'attemptId', v_attempt.id,
    'attemptStatus', v_attempt.status,
    'expiresAt', v_attempt.expires_at,
    'billingDataValidated', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'number', v_order.order_number,
      'kind', v_order.order_kind,
      'status', v_order.status,
      'paymentStatus', 'pending',
      'amountMinor', v_order.total_minor,
      'currency', v_order.currency
    ),
    'provider', jsonb_build_object(
      'key', 'paymob',
      'region', 'ksa',
      'environment', v_provider.environment,
      'checkoutMode', v_provider.checkout_mode
    ),
    'items', v_items
  );
end;
$$;

revoke all on function public.v1_tenant_paymob_prepare_checkout(
  text,uuid,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.v1_tenant_paymob_prepare_checkout(
  text,uuid,text,jsonb
) to authenticated;

-------------------------------------------------------------------------------
-- 5. Least-privilege runtime configuration and intention lifecycle
-------------------------------------------------------------------------------

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
    select coalesce(jsonb_agg(jsonb_build_object(
      'credentialVersionId', candidate.id,
      'environment', candidate.environment,
      'integrationId', candidate.integration_id,
      'owner', candidate.owner_id,
      'hmacSecret', decrypted.decrypted_secret
    ) order by
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
     or v_version.integration_id
       <> v_provider.public_config ->> 'integrationId'
     or v_version.owner_id
       <> v_provider.public_config ->> 'merchantAccountId'
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
    'integrationId', v_version.integration_id,
    'owner', v_version.owner_id,
    'apiKeyConfigured', true,
    'secretKey', v_secret_key,
    'publicKey', v_public_key
  );
end;
$$;

revoke all on function public.v1_service_paymob_runtime_config(uuid,text,text)
from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_runtime_config(uuid,text,text)
to service_role;

create or replace function public.v1_service_paymob_record_intention(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_intention_id text default null,
  p_provider_order_id text default null,
  p_client_secret text default null,
  p_provider_expires_at timestamptz default null,
  p_provider_request_id text default null,
  p_error_code text default null,
  p_response_sha256 text default null
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
  v_rollout marketplace.payment_tenant_rollouts%rowtype;
  v_tenant core.tenants%rowtype;
  v_secret_ref marketplace.payment_provider_secret_refs%rowtype;
  v_secret_id uuid;
  v_error_code text;
  v_gate_error_code text;
  v_bound_secret_count integer := 0;
  v_order_lock_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_outcome not in ('created','failed','unknown')
     or p_claim_token is null
     or (
       p_response_sha256 is not null
       and p_response_sha256 !~ '^[a-f0-9]{64}$'
     ) then raise exception 'paymob_intention_outcome_invalid'; end if;

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
    and attempt.order_id = v_order_lock_id
  for update;
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;
  if v_attempt.status <> 'creating_intention'
     or v_attempt.claim_token <> p_claim_token
     or v_attempt.claim_expires_at <= now() then
    raise exception 'paymob_intention_claim_invalid';
  end if;
  if private_app.paymob_order_review_hold_v1(v_attempt.order_id) then
    update marketplace.payment_attempts
    set status = 'unknown',
        provider_intention_id = left(nullif(btrim(p_provider_intention_id),''),200),
        provider_order_id = case when p_provider_order_id ~ '^[1-9][0-9]{0,29}$'
          then p_provider_order_id else null end,
        provider_request_id = left(nullif(btrim(p_provider_request_id),''),200),
        response_sha256 = p_response_sha256,
        last_error_code = 'order_payment_review_hold',
        claim_token = null,claim_expires_at = null,updated_at = now()
    where id = v_attempt.id
    returning * into v_attempt;
    insert into marketplace.reconciliations(
      tenant_id,order_id,attempt_id,provider_key,environment,
      reconciliation_type,status,provider_order_id,expected_amount_minor,
      expected_currency,error_code,due_at
    ) values (
      v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'paymob',
      v_attempt.environment,'intention_unknown','review_required',
      v_attempt.provider_order_id,v_attempt.amount_minor,v_attempt.currency,
      'order_payment_review_hold',now()
    )
    on conflict (attempt_id,reconciliation_type) do update
    set status = 'review_required',error_code = 'order_payment_review_hold',
        lease_token = null,lease_owner = null,lease_expires_at = null,
        checked_at = now(),updated_at = now();
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,
      'reconciliation_review',
      'reconciliation:record_intention_hold:' || v_attempt.id::text,
      jsonb_build_object(
        'attemptId',v_attempt.id,'provider','paymob',
        'environment',v_attempt.environment,
        'reasonCode','order_payment_review_hold'
      )
    );
    return jsonb_build_object(
      'schemaVersion',1,'attemptId',v_attempt.id,'orderId',v_attempt.order_id,
      'attemptStatus','unknown','resumeAllowed',false,
      'lastErrorCode','order_payment_review_hold'
    );
  end if;

  if p_outcome = 'created' then
    if nullif(btrim(p_provider_intention_id), '') is null
       or length(p_provider_intention_id) > 200
       or coalesce(p_provider_order_id, '') !~ '^[1-9][0-9]{0,29}$'
       or p_client_secret is null
       or length(p_client_secret) not between 16 and 4096
       or p_provider_expires_at is null
       or p_provider_expires_at <= now() + interval '30 seconds'
       or p_provider_expires_at > v_attempt.expires_at - interval '30 seconds'
       or v_attempt.expires_at <= now() then
      raise exception 'paymob_intention_response_invalid';
    end if;

    -- The provider call happened outside this transaction. Revalidate every
    -- mutable kill switch under shared row locks before persisting a resumable
    -- client secret. A closed gate cannot erase the provider-side ambiguity:
    -- retain only sanitized bindings and force authenticated reference inquiry.
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob'
    for share;
    select version.* into v_version
    from marketplace.paymob_credential_versions version
    where version.id = v_attempt.credential_version_id
      and version.provider_key = 'paymob'
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

    v_bound_secret_count := 0;
    if v_version.id is not null and v_version.status = 'active' then
      for v_secret_ref in
        select secret_ref.*
        from marketplace.payment_provider_secret_refs secret_ref
        join vault.decrypted_secrets decrypted
          on decrypted.id = secret_ref.vault_secret_id
        where secret_ref.provider_key = 'paymob'
          and secret_ref.credentials_environment = v_attempt.environment
          and nullif(decrypted.decrypted_secret,'') is not null
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
        v_bound_secret_count := v_bound_secret_count + 1;
      end loop;
    end if;

    if v_tenant.id is null
       or v_tenant.slug = 'reef-skills'
       or v_tenant.tenant_key = 'tenant-reef-skills' then
      v_gate_error_code := 'reef_skills_gate_closed_after_claim';
    elsif v_provider.provider_key is null
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
       ) then
      v_gate_error_code := 'provider_gate_closed_after_claim';
    elsif v_version.id is null
       or v_version.status <> 'active'
       or v_version.revoked_at is not null
       or v_version.environment <> v_attempt.environment
       or v_version.integration_id
         <> v_provider.public_config ->> 'integrationId'
       or v_version.owner_id
         <> v_provider.public_config ->> 'merchantAccountId'
       or v_bound_secret_count <> 4 then
      v_gate_error_code := 'credential_gate_closed_after_claim';
    elsif cardinality(private_app.paymob_missing_checks(
      v_provider.readiness_evidence,v_attempt.environment
    )) <> 0 then
      v_gate_error_code := 'readiness_gate_closed_after_claim';
    elsif v_rollout.id is null or v_rollout.status <> 'enabled' then
      v_gate_error_code := 'tenant_rollout_closed_after_claim';
    elsif not private_app.paymob_tenant_checkout_eligible_v1(
      v_attempt.tenant_id,v_attempt.environment
    ) then
      v_gate_error_code := 'checkout_gate_closed_after_claim';
    end if;

    if v_gate_error_code is not null then
      update marketplace.payment_attempts
      set status = 'unknown',
          provider_intention_id = left(btrim(p_provider_intention_id),200),
          provider_order_id = p_provider_order_id,
          provider_request_id = left(nullif(btrim(p_provider_request_id),''),200),
          provider_expires_at = p_provider_expires_at,
          response_sha256 = p_response_sha256,
          intention_recorded_at = now(),
          checkout_secret_id = null,
          checkout_secret_expires_at = null,
          last_error_code = v_gate_error_code,
          claim_token = null,
          claim_expires_at = null,
          updated_at = now()
      where id = v_attempt.id
      returning * into v_attempt;
      insert into marketplace.reconciliations(
        tenant_id,order_id,attempt_id,provider_key,environment,
        reconciliation_type,status,provider_order_id,expected_amount_minor,
        expected_currency,error_code,due_at
      ) values (
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'paymob',
        v_attempt.environment,'intention_unknown','queued',
        v_attempt.provider_order_id,v_attempt.amount_minor,v_attempt.currency,
        v_gate_error_code,now()
      )
      on conflict (attempt_id,reconciliation_type) do update
      set status = 'queued',provider_order_id = excluded.provider_order_id,
          error_code = excluded.error_code,due_at = now(),updated_at = now()
      where marketplace.reconciliations.status in ('queued','unknown','failed');
      perform private_app.paymob_outbox_enqueue(
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,
        'reconciliation_review',
        'reconciliation:intention_gate_closed:' || v_attempt.id::text,
        jsonb_build_object(
          'attemptId',v_attempt.id,'provider','paymob',
          'environment',v_attempt.environment,
          'inquiryMode','merchant_order_id',
          'merchantOrderId',v_attempt.id::text,
          'reasonCode',v_gate_error_code
        )
      );
      insert into audit_log.events(
        tenant_id,action,resource_type,resource_id,context
      ) values (
        v_attempt.tenant_id,
        'marketplace.paymob.intention_created_gate_closed',
        'payment_attempt',v_attempt.id::text,
        jsonb_build_object(
          'orderId',v_attempt.order_id,'environment',v_attempt.environment,
          'reasonCode',v_gate_error_code,'clientSecretStoredInVault',false,
          'resumeAllowed',false
        )
      );
      return jsonb_build_object(
        'schemaVersion',1,'attemptId',v_attempt.id,'orderId',v_attempt.order_id,
        'attemptStatus','unknown','resumeAllowed',false,
        'lastErrorCode',v_gate_error_code
      );
    end if;

    select vault.create_secret(
      p_client_secret,
      'paymob_checkout_client_' || replace(v_attempt.id::text, '-', '_'),
      'Paymob per-attempt checkout client secret. Service-only; expires in one hour.'
    ) into v_secret_id;

    update marketplace.payment_attempts
    set status = 'intention_created',
        provider_intention_id = left(btrim(p_provider_intention_id), 200),
        provider_order_id = p_provider_order_id,
        provider_request_id = left(nullif(btrim(p_provider_request_id), ''), 200),
        checkout_secret_id = v_secret_id,
        provider_expires_at = p_provider_expires_at,
        checkout_secret_expires_at = p_provider_expires_at,
        response_sha256 = p_response_sha256,
        intention_recorded_at = now(),
        last_error_code = null,
        claim_token = null,
        claim_expires_at = null,
        updated_at = now()
    where id = v_attempt.id
    returning * into v_attempt;

    if v_attempt.environment = 'sandbox' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox',
        'intention_create',
        true,
        p_response_sha256,
        null,
        'payment_attempt',
        v_attempt.id
      );
    end if;

  elsif p_outcome = 'failed' then
    v_error_code := coalesce(
      nullif(btrim(p_error_code), ''),
      'intention_create_failed'
    );
    if v_error_code !~ '^[a-z][a-z0-9_]{1,80}$' then
      raise exception 'paymob_intention_error_invalid';
    end if;
    update marketplace.payment_attempts
    set status = 'failed',
        provider_request_id = left(nullif(btrim(p_provider_request_id), ''), 200),
        response_sha256 = p_response_sha256,
        last_error_code = v_error_code,
        terminal_at = now(),
        claim_token = null,
        claim_expires_at = null,
        updated_at = now()
    where id = v_attempt.id
    returning * into v_attempt;
    update marketplace.orders
    set payment_status = 'failed',
        updated_at = now()
    where id = v_attempt.order_id
      and tenant_id = v_attempt.tenant_id
      and status = 'pending_payment'
      and payment_status = 'pending'
      and payment_provider = 'paymob';
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'payment_failed',
      'payment_failed:intention:' || v_attempt.id::text,
      jsonb_build_object(
        'attemptId', v_attempt.id,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'errorCode', v_error_code
      )
    );
  else
    v_error_code := coalesce(
      nullif(btrim(p_error_code), ''),
      'intention_result_unknown'
    );
    if v_error_code !~ '^[a-z][a-z0-9_]{1,80}$' then
      raise exception 'paymob_intention_error_invalid';
    end if;
    update marketplace.payment_attempts
    set status = 'unknown',
        provider_intention_id = left(nullif(btrim(p_provider_intention_id), ''), 200),
        provider_order_id = case
          when p_provider_order_id ~ '^[1-9][0-9]{0,29}$'
            then p_provider_order_id
          else null
        end,
        provider_request_id = left(nullif(btrim(p_provider_request_id), ''), 200),
        response_sha256 = p_response_sha256,
        last_error_code = v_error_code,
        claim_token = null,
        claim_expires_at = null,
        updated_at = now()
    where id = v_attempt.id
    returning * into v_attempt;
    insert into marketplace.reconciliations(
      tenant_id,
      order_id,
      attempt_id,
      provider_key,
      environment,
      reconciliation_type,
      status,
      provider_order_id,
      expected_amount_minor,
      expected_currency,
      error_code,
      due_at
    ) values (
      v_attempt.tenant_id,
      v_attempt.order_id,
      v_attempt.id,
      'paymob',
      v_attempt.environment,
      'intention_unknown',
      'queued',
      v_attempt.provider_order_id,
      v_attempt.amount_minor,
      v_attempt.currency,
      case when v_attempt.provider_transaction_id is null
        then 'order_reference_inquiry_required'
        else v_error_code
      end,
      now()
    )
    on conflict (attempt_id, reconciliation_type) do update
    set status = excluded.status,
        provider_order_id = excluded.provider_order_id,
        error_code = excluded.error_code,
        due_at = now(),
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
        'reasonCode', v_error_code
      )
    );
  end if;

  insert into audit_log.events(
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    v_attempt.tenant_id,
    'marketplace.paymob.intention_' || p_outcome,
    'payment_attempt',
    v_attempt.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'orderId', v_attempt.order_id,
      'environment', v_attempt.environment,
      'status', v_attempt.status,
      'errorCode', v_attempt.last_error_code,
      'clientSecretStoredInVault', p_outcome = 'created',
      'clientSecretReturned', false
    ))
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 1,
    'attemptId', v_attempt.id,
    'attemptStatus', v_attempt.status,
    'orderId', v_attempt.order_id,
    'environment', v_attempt.environment,
    'expiresAt', v_attempt.expires_at,
    'providerExpiresAt',v_attempt.provider_expires_at,
    'resumeAllowed',
      v_attempt.status = 'intention_created'
      and v_attempt.checkout_secret_id is not null
      and v_attempt.checkout_secret_expires_at > now(),
    'lastErrorCode', v_attempt.last_error_code
  ));
end;
$$;

revoke all on function public.v1_service_paymob_record_intention(
  uuid,uuid,text,text,text,text,timestamptz,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_record_intention(
  uuid,uuid,text,text,text,text,timestamptz,text,text,text
) to service_role;

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
     or v_version.integration_id
       <> v_provider.public_config ->> 'integrationId'
     or v_version.owner_id
       <> v_provider.public_config ->> 'merchantAccountId'
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
  select decrypted.decrypted_secret into v_public_key
  from vault.decrypted_secrets decrypted
  where decrypted.id = v_version.public_key_vault_secret_id;
  if nullif(v_client_secret, '') is null or nullif(v_public_key, '') is null then
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
    'publicKey', v_public_key,
    'clientSecret', v_client_secret,
    'expiresAt', v_attempt.expires_at,
    'providerExpiresAt',v_attempt.provider_expires_at
  );
end;
$$;

revoke all on function public.v1_service_paymob_resume_checkout(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_resume_checkout(uuid)
to service_role;

-------------------------------------------------------------------------------
-- 6. Exact-once paid settlement from the immutable attempt snapshot
-------------------------------------------------------------------------------

create or replace function private_app.paymob_apply_paid_attempt_v1(
  p_attempt_id uuid,
  p_provider_transaction_id text,
  p_evidence_sha256 text,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt marketplace.payment_attempts%rowtype;
  v_order marketplace.orders%rowtype;
  v_existing_event marketplace.payment_events%rowtype;
  v_snapshot marketplace.payment_attempt_items%rowtype;
  v_product catalog.addon_products%rowtype;
  v_feature catalog.features%rowtype;
  v_previous_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_previous_module core.tenant_modules%rowtype;
  v_granted_module core.tenant_modules%rowtype;
  v_source marketplace.entitlement_sources%rowtype;
  v_module_id uuid;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_previous_order_status text;
  v_event_type text;
  v_provider_event_id text;
  v_locked_order_id uuid;
  v_entitlement_lock_product_id uuid;
  v_fulfillment_review_required boolean := false;
  v_suppress_fulfillment boolean := p_source = 'inquiry_fully_refunded';
begin
  if coalesce(p_source, '') not in (
    'webhook','inquiry','inquiry_fully_refunded'
  )
     or coalesce(p_provider_transaction_id, '') !~ '^[1-9][0-9]{0,29}$'
     or coalesce(p_evidence_sha256, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_settlement_evidence_invalid';
  end if;

  select attempt.order_id into v_locked_order_id
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.provider_key = 'paymob';
  if v_locked_order_id is null then raise exception 'paymob_attempt_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_locked_order_id::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:settle:' || p_attempt_id::text,
    0
  ));
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.provider_key = 'paymob'
    and attempt.order_id = v_locked_order_id
  for update;
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_attempt.order_id
    and orders.tenant_id = v_attempt.tenant_id
  for update;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;

  -- Serialize entitlement mutations across different orders for the same
  -- tenant/product. Every caller takes the complete immutable snapshot lock
  -- set in UUID order, so multi-item checkouts cannot deadlock each other.
  for v_entitlement_lock_product_id in
    select distinct snapshot.addon_product_id
    from marketplace.payment_attempt_items snapshot
    where snapshot.attempt_id = v_attempt.id
      and snapshot.tenant_id = v_attempt.tenant_id
      and snapshot.order_id = v_attempt.order_id
      and snapshot.addon_product_id is not null
    order by snapshot.addon_product_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'paymob:entitlement:' || v_attempt.tenant_id::text || ':'
        || v_entitlement_lock_product_id::text,
      0
    ));
  end loop;

  if v_attempt.status = 'paid' then
    if v_attempt.provider_transaction_id <> p_provider_transaction_id then
      raise exception 'paymob_transaction_reused';
    end if;
    return jsonb_build_object(
      'attemptId', v_attempt.id,
      'orderId', v_order.id,
      'attemptStatus', v_attempt.status,
      'orderStatus', v_order.status,
      'paymentStatus', v_order.payment_status,
      'duplicate', true
    );
  end if;
  if (
       (
         v_attempt.status in ('refunded','cancelled')
         or (
           v_attempt.status = 'failed'
           and p_source not in ('inquiry','inquiry_fully_refunded')
         )
       )
       and not (
         p_source = 'inquiry_fully_refunded'
         and v_attempt.status = 'failed'
       )
     )
     or v_order.status in ('cancelled','refunded')
     or v_order.payment_status in ('paid','refunded','waived')
     or v_order.payment_provider <> 'paymob'
     or v_order.order_number <> v_attempt.order_number_snapshot
     or v_order.order_kind <> v_attempt.order_kind_snapshot
     or v_order.subtotal_minor <> v_attempt.subtotal_minor
     or v_order.tax_minor <> v_attempt.tax_minor
     or v_order.tax_rate_bps <> v_attempt.tax_rate_bps
     or v_order.total_minor <> v_attempt.amount_minor
     or v_order.currency <> v_attempt.currency then
    raise exception 'paymob_settlement_binding_invalid';
  end if;
  if (
    select coalesce(sum(snapshot.line_total_minor), 0)
    from marketplace.payment_attempt_items snapshot
    where snapshot.attempt_id = v_attempt.id
      and snapshot.tenant_id = v_attempt.tenant_id
      and snapshot.order_id = v_attempt.order_id
  ) <> v_attempt.subtotal_minor then
    raise exception 'paymob_attempt_snapshot_mismatch';
  end if;

  v_provider_event_id := left(
    v_attempt.environment || ':' || p_provider_transaction_id || ':paid',
    200
  );
  select event.* into v_existing_event
  from marketplace.payment_events event
  where event.provider_key = 'paymob'
    and event.provider_event_id = v_provider_event_id;
  if v_existing_event.id is not null
     and v_existing_event.order_id <> v_order.id then
    raise exception 'paymob_transaction_reused';
  end if;

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
    v_order.id,
    'paymob',
    v_provider_event_id,
    p_provider_transaction_id,
    'paid',
    v_attempt.amount_minor,
    v_attempt.currency,
    p_source = 'webhook',
    p_evidence_sha256
  )
  on conflict (provider_key, provider_event_id) do nothing;

  v_previous_order_status := v_order.status;
  perform set_config(
    'odeir.paymob_verified_order_id',
    v_order.id::text,
    true
  );
  update marketplace.orders
  set payment_status = 'paid',
      status = case when order_kind = 'addon' then 'completed' else 'paid' end,
      activation_state = case
        when order_kind = 'addon' then 'pending'
        else 'not_applicable'
      end,
      payment_provider = 'paymob',
      payment_reference = p_provider_transaction_id,
      paid_at = coalesce(paid_at, now()),
      updated_at = now()
  where id = v_order.id
  returning * into v_order;

  -- Service payment stops here: it does not assign a provider, mark delivery,
  -- complete the service, or grant any add-on entitlement.
  if v_order.order_kind = 'addon' and not v_suppress_fulfillment then
    for v_snapshot in
      select snapshot.*
      from marketplace.payment_attempt_items snapshot
      where snapshot.attempt_id = v_attempt.id
        and snapshot.tenant_id = v_attempt.tenant_id
        and snapshot.order_id = v_attempt.order_id
        and snapshot.item_type = 'addon'
      order by snapshot.created_at, snapshot.id
    loop
      select product.* into v_product
      from catalog.addon_products product
      where product.id = v_snapshot.addon_product_id
        and product.product_key = v_snapshot.product_key
        and product.feature_id = v_snapshot.feature_id
        and product.activation_mode = v_snapshot.activation_mode_snapshot
      for share;
      if v_product.id is null then raise exception 'addon_product_not_found'; end if;
      select feature.* into v_feature
      from catalog.features feature
      where feature.id = v_snapshot.feature_id
        and feature.id = v_product.feature_id
      for share;
      if v_feature.id is null then raise exception 'addon_feature_not_found'; end if;

      select subscription.* into v_previous_subscription
      from catalog.tenant_addon_subscriptions subscription
      where subscription.tenant_id = v_attempt.tenant_id
        and subscription.product_id = v_snapshot.addon_product_id
        and subscription.status in ('pending','trialing','active','paused')
      order by subscription.updated_at desc
      limit 1
      for update;

      v_period_start := now();
      v_period_end := case v_snapshot.billing_interval_snapshot
        when 'year' then
          greatest(coalesce(v_previous_subscription.period_end, now()), now())
            + interval '1 year'
        when 'month' then
          greatest(coalesce(v_previous_subscription.period_end, now()), now())
            + interval '1 month'
        when 'one_time' then null
        else null
      end;
      if v_snapshot.billing_interval_snapshot not in ('year','month','one_time') then
        raise exception 'addon_billing_interval_invalid';
      end if;

      insert into marketplace.entitlement_sources(
        tenant_id,
        order_id,
        order_item_id,
        attempt_id,
        addon_product_id,
        provider_key,
        environment,
        provider_transaction_id,
        source_kind,
        state,
        amount_minor,
        currency,
        previous_subscription_id,
        previous_status,
        previous_period_start,
        previous_period_end,
        previous_source,
        previous_payment_provider_key,
        previous_marketplace_order_id,
        previous_auto_renew,
        previous_cancel_at_period_end,
        previous_requested_note,
        previous_requested_by_subject_id,
        previous_decided_by_subject_id,
        previous_decision_note,
        previous_activated_at,
        previous_ended_at
      ) values (
        v_attempt.tenant_id,
        v_attempt.order_id,
        v_snapshot.order_item_id,
        v_attempt.id,
        v_snapshot.addon_product_id,
        'paymob',
        v_attempt.environment,
        p_provider_transaction_id,
        'paid_order',
        'active',
        v_snapshot.line_total_minor,
        v_snapshot.currency,
        v_previous_subscription.id,
        v_previous_subscription.status,
        v_previous_subscription.period_start,
        v_previous_subscription.period_end,
        v_previous_subscription.source,
        v_previous_subscription.payment_provider_key,
        v_previous_subscription.marketplace_order_id,
        v_previous_subscription.auto_renew,
        v_previous_subscription.cancel_at_period_end,
        v_previous_subscription.requested_note,
        v_previous_subscription.requested_by_subject_id,
        v_previous_subscription.decided_by_subject_id,
        v_previous_subscription.decision_note,
        v_previous_subscription.activated_at,
        v_previous_subscription.ended_at
      )
      on conflict (order_item_id) do nothing
      returning * into v_source;
      if v_source.id is null then
        select source.* into v_source
        from marketplace.entitlement_sources source
        where source.order_item_id = v_snapshot.order_item_id
        for update;
        if v_source.attempt_id <> v_attempt.id
           or v_source.order_id <> v_attempt.order_id
           or v_source.tenant_id <> v_attempt.tenant_id
           or v_source.provider_transaction_id <> p_provider_transaction_id
           or v_source.addon_product_id <> v_snapshot.addon_product_id
           or v_source.state <> 'active'
           or v_source.applied_at is null then
          raise exception 'paymob_entitlement_source_conflict';
        end if;
        continue;
      end if;

      insert into catalog.tenant_addon_subscriptions as current_subscription(
        tenant_id,
        product_id,
        status,
        source,
        period_start,
        period_end,
        requested_note,
        requested_by_subject_id,
        decided_by_subject_id,
        decision_note,
        payment_provider_key,
        marketplace_order_id,
        auto_renew,
        activated_at,
        ended_at
      ) values (
        v_attempt.tenant_id,
        v_snapshot.addon_product_id,
        'active',
        'billing',
        v_period_start,
        v_period_end,
        'paymob_order:' || v_attempt.order_number_snapshot,
        v_attempt.requested_by_subject_id,
        null,
        'activated_after_verified_paymob_payment',
        'paymob',
        v_attempt.order_id,
        false,
        now(),
        null
      )
      on conflict (tenant_id, product_id)
        where status in ('pending','trialing','active','paused')
      do update
      set status = 'active',
          source = 'billing',
          period_start = case
            when v_snapshot.billing_interval_snapshot = 'one_time'
              then coalesce(current_subscription.period_start, excluded.period_start)
            else excluded.period_start
          end,
          period_end = v_period_end,
          cancel_at_period_end = false,
          requested_note = excluded.requested_note,
          requested_by_subject_id = coalesce(
            excluded.requested_by_subject_id,
            current_subscription.requested_by_subject_id
          ),
          decision_note = excluded.decision_note,
          payment_provider_key = 'paymob',
          marketplace_order_id = v_attempt.order_id,
          auto_renew = false,
          activated_at = coalesce(current_subscription.activated_at, now()),
          ended_at = null,
          updated_at = now()
      where v_previous_subscription.id is not null
        and current_subscription.id = v_previous_subscription.id
        and to_jsonb(current_subscription)
          is not distinct from to_jsonb(v_previous_subscription)
      returning * into v_subscription;

      if v_subscription.id is null then
        update marketplace.entitlement_sources
        set state = 'review_required',updated_at = now()
        where id = v_source.id;
        v_fulfillment_review_required := true;
        perform private_app.paymob_outbox_enqueue(
          v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,
          'payment_quarantined',
          'payment_quarantined:subscription_cas:' || v_source.id::text,
          jsonb_build_object(
            'attemptId',v_attempt.id,'orderId',v_attempt.order_id,
            'sourceId',v_source.id,'productId',v_snapshot.addon_product_id,
            'reasonCode','entitlement_subscription_state_changed'
          )
        );
        continue;
      end if;

      update marketplace.entitlement_sources
      set subscription_id = v_subscription.id,
          granted_status = v_subscription.status,
          granted_source = v_subscription.source,
          granted_period_start = v_subscription.period_start,
          granted_period_end = v_subscription.period_end,
          granted_payment_provider_key = v_subscription.payment_provider_key,
          granted_marketplace_order_id = v_subscription.marketplace_order_id,
          granted_auto_renew = v_subscription.auto_renew,
          granted_cancel_at_period_end = v_subscription.cancel_at_period_end,
          granted_requested_note = v_subscription.requested_note,
          granted_requested_by_subject_id = v_subscription.requested_by_subject_id,
          granted_decided_by_subject_id = v_subscription.decided_by_subject_id,
          granted_decision_note = v_subscription.decision_note,
          granted_activated_at = v_subscription.activated_at,
          granted_ended_at = v_subscription.ended_at,
          applied_at = clock_timestamp(),
          updated_at = now()
      where id = v_source.id;

      v_event_type := case
        when v_previous_subscription.id is null then 'activated'
        else 'renewed'
      end;
      insert into catalog.tenant_addon_subscription_events(
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
        v_attempt.tenant_id,
        v_snapshot.addon_product_id,
        'paymob_paid_order:' || v_snapshot.order_item_id::text,
        v_event_type,
        v_previous_subscription.status,
        'active',
        now(),
        null,
        jsonb_build_object(
          'orderId', v_attempt.order_id,
          'attemptId', v_attempt.id,
          'sourceId', v_source.id,
          'productKey', v_snapshot.product_key,
          'provider', 'paymob',
          'environment', v_attempt.environment
        )
      )
      on conflict (tenant_id, product_id, event_key) do nothing;

      if v_product.activation_mode = 'module' then
        select module.id into v_module_id
        from core.modules module
        where v_feature.feature_key = 'module.' || module.module_key
        limit 1;
        if v_module_id is null then raise exception 'addon_module_not_found'; end if;
        select tenant_module.* into v_previous_module
        from core.tenant_modules tenant_module
        where tenant_module.tenant_id = v_attempt.tenant_id
          and tenant_module.module_id = v_module_id
        for update;
        update marketplace.entitlement_sources
        set module_id = v_module_id,
            previous_module_present = v_previous_module.module_id is not null,
            previous_module_enabled = v_previous_module.enabled,
            previous_module_configuration = v_previous_module.configuration,
            previous_module_enabled_at = v_previous_module.enabled_at,
            updated_at = now()
        where id = v_source.id;
        v_granted_module.module_id := null;
        if v_previous_module.module_id is null then
          insert into core.tenant_modules(
            tenant_id,module_id,enabled,configuration,enabled_at,updated_at
          ) values (
            v_attempt.tenant_id,v_module_id,true,
            jsonb_build_object(
              'source','paymob_paid_order',
              'orderId',v_attempt.order_id,
              'productKey',v_snapshot.product_key
            ),
            now(),now()
          )
          on conflict (tenant_id,module_id) do nothing
          returning * into v_granted_module;
        else
          update core.tenant_modules as current_module
          set enabled = true,
              configuration = current_module.configuration
                || jsonb_build_object(
                  'source','paymob_paid_order',
                  'orderId',v_attempt.order_id,
                  'productKey',v_snapshot.product_key
                ),
              enabled_at = coalesce(current_module.enabled_at,now()),
              updated_at = now()
          where current_module.tenant_id = v_attempt.tenant_id
            and current_module.module_id = v_module_id
            and to_jsonb(current_module)
              is not distinct from to_jsonb(v_previous_module)
          returning * into v_granted_module;
        end if;
        if v_granted_module.module_id is null then
          update marketplace.entitlement_sources
          set state = 'review_required',updated_at = now()
          where id = v_source.id;
          v_fulfillment_review_required := true;
          perform private_app.paymob_outbox_enqueue(
            v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,
            'payment_quarantined',
            'payment_quarantined:module_cas:' || v_source.id::text,
            jsonb_build_object(
              'attemptId',v_attempt.id,'orderId',v_attempt.order_id,
              'sourceId',v_source.id,'moduleId',v_module_id,
              'reasonCode','entitlement_module_state_changed'
            )
          );
          continue;
        end if;
        update marketplace.entitlement_sources
        set granted_module_enabled = v_granted_module.enabled,
            granted_module_configuration = v_granted_module.configuration,
            granted_module_enabled_at = v_granted_module.enabled_at,
            updated_at = now()
        where id = v_source.id;
      end if;
    end loop;

    update marketplace.orders
    set activation_state = case when v_fulfillment_review_required
          then 'failed' else 'active' end,
        updated_at = now()
    where id = v_order.id
    returning * into v_order;
  end if;

  update marketplace.payment_attempts
  set status = 'paid',
      provider_transaction_id = p_provider_transaction_id,
      last_error_code = null,
      terminal_at = now(),
      checkout_secret_expires_at = case
        when checkout_secret_id is null then null
        else least(coalesce(checkout_secret_expires_at, now()), now())
      end,
      claim_token = null,
      claim_expires_at = null,
      updated_at = now()
  where id = v_attempt.id
  returning * into v_attempt;

  insert into marketplace.order_events(
    order_id,
    tenant_id,
    actor_subject_id,
    event_type,
    from_status,
    to_status,
    metadata
  ) values (
    v_order.id,
    v_order.tenant_id,
    null,
    'paymob_payment_confirmed',
    v_previous_order_status,
    v_order.status,
    jsonb_build_object(
      'attemptId', v_attempt.id,
      'provider', 'paymob',
      'environment', v_attempt.environment,
      'settlementSource', p_source,
      'activationState', v_order.activation_state
    )
  );

  if not v_suppress_fulfillment then
    perform private_app.paymob_outbox_enqueue(
      v_order.tenant_id,
      v_order.id,
      v_attempt.id,
      'payment_paid',
      'payment_paid:' || v_attempt.environment || ':' || p_provider_transaction_id,
      jsonb_build_object(
        'attemptId', v_attempt.id,
        'orderNumber', v_order.order_number,
        'kind', v_order.order_kind,
        'provider', 'paymob',
        'environment', v_attempt.environment,
        'amountMinor', v_attempt.amount_minor,
        'currency', v_attempt.currency,
        'activationState', v_order.activation_state,
        'settlementSource', p_source
      )
    );
  end if;

  insert into audit_log.events(
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    v_order.tenant_id,
    'marketplace.paymob.payment_confirmed',
    'marketplace_order',
    v_order.id::text,
    jsonb_build_object(
      'attemptId', v_attempt.id,
      'orderNumber', v_order.order_number,
      'kind', v_order.order_kind,
      'provider', 'paymob',
      'environment', v_attempt.environment,
      'amountMinor', v_attempt.amount_minor,
      'currency', v_attempt.currency,
      'activationState', v_order.activation_state,
      'settlementSource', p_source,
      'fulfillmentSuppressed',v_suppress_fulfillment
    )
  );

  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'orderId', v_order.id,
    'attemptStatus', v_attempt.status,
    'orderStatus', v_order.status,
    'paymentStatus', v_order.payment_status,
    'activationState', v_order.activation_state,
    'duplicate', false
  );
end;
$$;

revoke all on function private_app.paymob_apply_paid_attempt_v1(
  uuid,text,text,text
) from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 7. Verified Paymob transaction receipt ingestion
-------------------------------------------------------------------------------

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
  elsif v_integration_id <> v_version.integration_id
     or v_integration_id <> v_attempt_version.integration_id then
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

revoke all on function public.v1_service_paymob_ingest_verified_transaction(
  text,uuid,text,text,text,text,text,
  boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,
  bigint,text,timestamptz,text,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_ingest_verified_transaction(
  text,uuid,text,text,text,text,text,
  boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,
  bigint,text,timestamptz,text,boolean
) to service_role;

-------------------------------------------------------------------------------
-- 8. Leased, account-version-bound reconciliation
-------------------------------------------------------------------------------

create or replace function public.v1_service_paymob_reconciliation_claim(
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job marketplace.reconciliations%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_expired_attempt marketplace.payment_attempts%rowtype;
  v_lifecycle_candidate record;
  v_candidate_job_id uuid;
  v_order_lock_id uuid;
  v_lifecycle_lock_taken boolean := false;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if coalesce(p_worker_id, '') !~ '^[A-Za-z0-9_-]{3,80}$'
     or p_lease_seconds is null
     or p_lease_seconds not between 30 and 300 then
    raise exception 'paymob_reconciliation_worker_invalid';
  end if;

  -- Scheduled, bounded attempt lifecycle maintenance. Candidate discovery is
  -- deliberately non-locking; each mutation is revalidated only after taking
  -- the same canonical per-order advisory lock used by checkout and receipts.
  -- A prepared attempt has provably made no provider call and can release the
  -- active-order slot. An abandoned create claim remains financially ambiguous
  -- and therefore becomes unknown plus merchant-reference reconciliation.
  for v_lifecycle_candidate in
    select attempt.id,attempt.order_id,attempt.expires_at
    from marketplace.payment_attempts attempt
    where attempt.provider_key = 'paymob'
      and (
        (
          attempt.status = 'prepared'
          and attempt.expires_at <= now()
          and attempt.claim_token is null
          and attempt.provider_intention_id is null
          and attempt.provider_order_id is null
          and attempt.provider_transaction_id is null
          and attempt.checkout_secret_id is null
        )
        or (
          attempt.status = 'creating_intention'
          and (
            attempt.claim_expires_at <= now()
            or attempt.expires_at <= now()
          )
          and attempt.provider_intention_id is null
          and attempt.provider_order_id is null
          and attempt.provider_transaction_id is null
          and attempt.checkout_secret_id is null
        )
        or (
          attempt.status in ('intention_created','pending')
          and attempt.expires_at <= now()
        )
      )
    order by attempt.order_id,attempt.expires_at,attempt.id
    limit 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'paymob:order:' || v_lifecycle_candidate.order_id::text,0
    ));
    v_lifecycle_lock_taken := true;
    select attempt.* into v_expired_attempt
    from marketplace.payment_attempts attempt
    where attempt.id = v_lifecycle_candidate.id
      and attempt.order_id = v_lifecycle_candidate.order_id
      and attempt.provider_key = 'paymob'
      and (
        (
          attempt.status = 'prepared'
          and attempt.expires_at <= now()
          and attempt.claim_token is null
          and attempt.provider_intention_id is null
          and attempt.provider_order_id is null
          and attempt.provider_transaction_id is null
          and attempt.checkout_secret_id is null
        )
        or (
          attempt.status = 'creating_intention'
          and (
            attempt.claim_expires_at <= now()
            or attempt.expires_at <= now()
          )
          and attempt.provider_intention_id is null
          and attempt.provider_order_id is null
          and attempt.provider_transaction_id is null
          and attempt.checkout_secret_id is null
        )
        or (
          attempt.status in ('intention_created','pending')
          and attempt.expires_at <= now()
        )
      )
    for update;
    if v_expired_attempt.id is null then
      continue;
    end if;

    if v_expired_attempt.status = 'prepared' then
      update marketplace.payment_attempts
      set status = 'failed',
          last_error_code = 'checkout_expired_before_provider_call',
          terminal_at = now(),
          claim_token = null,
          claim_expires_at = null,
          updated_at = now()
      where id = v_expired_attempt.id
      returning * into v_expired_attempt;
      perform private_app.paymob_outbox_enqueue(
        v_expired_attempt.tenant_id,
        v_expired_attempt.order_id,
        v_expired_attempt.id,
        'payment_failed',
        'payment_failed:prepared_expired:' || v_expired_attempt.id::text,
        jsonb_build_object(
          'attemptId',v_expired_attempt.id,
          'provider','paymob',
          'environment',v_expired_attempt.environment,
          'errorCode','checkout_expired_before_provider_call',
          'providerCallStarted',false
        )
      );
      continue;
    end if;

    if v_expired_attempt.status = 'creating_intention' then
      update marketplace.payment_attempts
      set status = 'unknown',
          last_error_code = 'intention_claim_expired',
          claim_token = null,
          claim_expires_at = null,
          updated_at = now()
      where id = v_expired_attempt.id
      returning * into v_expired_attempt;
      insert into marketplace.reconciliations(
        tenant_id,order_id,attempt_id,provider_key,environment,
        reconciliation_type,status,provider_order_id,
        expected_amount_minor,expected_currency,error_code,due_at
      ) values (
        v_expired_attempt.tenant_id,v_expired_attempt.order_id,
        v_expired_attempt.id,'paymob',v_expired_attempt.environment,
        'intention_unknown','queued',null,v_expired_attempt.amount_minor,
        v_expired_attempt.currency,'order_reference_inquiry_required',now()
      )
      on conflict (attempt_id,reconciliation_type) do update
      set status = 'queued',
          due_at = now(),
          error_code = 'order_reference_inquiry_required',
          updated_at = now()
      where marketplace.reconciliations.status in ('queued','unknown','failed')
      returning id into v_candidate_job_id;
      v_order_lock_id := v_expired_attempt.order_id;
      perform private_app.paymob_outbox_enqueue(
        v_expired_attempt.tenant_id,
        v_expired_attempt.order_id,
        v_expired_attempt.id,
        'reconciliation_review',
        'reconciliation:intention_unknown:' || v_expired_attempt.id::text,
        jsonb_build_object(
          'attemptId',v_expired_attempt.id,
          'provider','paymob',
          'environment',v_expired_attempt.environment,
          'inquiryMode','merchant_order_id',
          'merchantOrderId',v_expired_attempt.id::text,
          'reasonCode','intention_claim_expired'
        )
      );
      continue;
    end if;

    insert into marketplace.reconciliations(
      tenant_id,order_id,attempt_id,provider_key,environment,
      reconciliation_type,status,provider_order_id,
      expected_amount_minor,expected_currency,error_code,due_at
    ) values (
      v_expired_attempt.tenant_id,v_expired_attempt.order_id,
      v_expired_attempt.id,'paymob',v_expired_attempt.environment,
      'intention_unknown','queued',v_expired_attempt.provider_order_id,
      v_expired_attempt.amount_minor,v_expired_attempt.currency,
      'checkout_expired_requires_inquiry',now()
    )
    on conflict (attempt_id,reconciliation_type) do update
    set status = 'queued',
        due_at = now(),
        error_code = 'checkout_expired_requires_inquiry',
        updated_at = now()
    where marketplace.reconciliations.status in ('queued','unknown','failed')
    returning id into v_candidate_job_id;
    v_order_lock_id := v_expired_attempt.order_id;
  end loop;

  -- Do not acquire a second order lock in a lifecycle-maintenance transaction.
  -- The newly seeded job (if any) is the only job this call may lease.
  if v_lifecycle_lock_taken and v_candidate_job_id is null then
    return jsonb_build_object(
      'schemaVersion',1,'claimed',false,'maintenanceProcessed',true
    );
  end if;

  if not v_lifecycle_lock_taken then
    for v_job in
      with exhausted as (
        select reconciliation.id
        from marketplace.reconciliations reconciliation
        where reconciliation.provider_key = 'paymob'
          and reconciliation.status = 'running'
          and reconciliation.lease_expires_at <= now()
          and reconciliation.attempt_count >= reconciliation.max_attempts
        order by reconciliation.lease_expires_at,reconciliation.id
        limit 25
        for update skip locked
      )
      update marketplace.reconciliations reconciliation
      set status = 'review_required',
          error_code = 'reconciliation_attempts_exhausted',
          lease_token = null,
          lease_owner = null,
          lease_expires_at = null,
          checked_at = now(),
          updated_at = now()
      from exhausted
      where reconciliation.id = exhausted.id
      returning reconciliation.*
    loop
      perform private_app.paymob_outbox_enqueue(
        v_job.tenant_id,v_job.order_id,v_job.attempt_id,
        'reconciliation_review',
        'reconciliation:exhausted:' || v_job.id::text,
        jsonb_build_object(
          'jobId',v_job.id,'attemptId',v_job.attempt_id,
          'reasonCode','reconciliation_attempts_exhausted'
        )
      );
    end loop;

    select reconciliation.id,reconciliation.order_id
    into v_candidate_job_id,v_order_lock_id
    from marketplace.reconciliations reconciliation
    where reconciliation.provider_key = 'paymob'
      and (
        reconciliation.status in ('queued','unknown','failed')
        or (
          reconciliation.status = 'running'
          and reconciliation.lease_expires_at <= now()
        )
      )
      and reconciliation.due_at <= now()
      and reconciliation.attempt_count < reconciliation.max_attempts
      and (
        reconciliation.lease_token is null
        or reconciliation.lease_expires_at <= now()
      )
    order by reconciliation.due_at, reconciliation.created_at, reconciliation.id
    limit 1;
  end if;
  if v_candidate_job_id is null then
    return jsonb_build_object('schemaVersion',1,'claimed',false);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  select reconciliation.* into v_job
  from marketplace.reconciliations reconciliation
  where reconciliation.id = v_candidate_job_id
    and reconciliation.order_id = v_order_lock_id
    and reconciliation.provider_key = 'paymob'
    and (
      reconciliation.status in ('queued','unknown','failed')
      or (
        reconciliation.status = 'running'
        and reconciliation.lease_expires_at <= now()
      )
    )
    and reconciliation.due_at <= now()
    and reconciliation.attempt_count < reconciliation.max_attempts
    and (
      reconciliation.lease_token is null
      or reconciliation.lease_expires_at <= now()
    )
  for update skip locked;
  if v_job.id is null then
    return jsonb_build_object('schemaVersion',1,'claimed',false);
  end if;

  update marketplace.reconciliations
  set status = 'running',
      attempt_count = attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = v_job.id
  returning * into v_job;
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = v_job.attempt_id
  for update;
  if v_attempt.status in ('intention_created','pending')
     and v_attempt.expires_at <= now() then
    update marketplace.payment_attempts
    set status = 'unknown',last_error_code = 'checkout_expired_requires_inquiry',
        checkout_secret_expires_at = case
          when checkout_secret_id is null then null else now() end,
        updated_at = now()
    where id = v_attempt.id
    returning * into v_attempt;
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'claimed', true,
    'jobId', v_job.id,
    'leaseToken', v_job.lease_token,
    'leaseExpiresAt', v_job.lease_expires_at,
    'workerId', p_worker_id,
    'attemptNumber', v_job.attempt_count,
    'maxAttempts', v_job.max_attempts,
    'reconciliationType', v_job.reconciliation_type,
    'attemptId', v_attempt.id,
    'specialReference', v_attempt.id::text,
    'providerTransactionId', coalesce(
      v_job.provider_transaction_id,
      v_attempt.provider_transaction_id
    ),
    'providerOrderId', v_job.provider_order_id,
    'environment', v_attempt.environment
  );
end;
$$;

revoke all on function public.v1_service_paymob_reconciliation_claim(text,integer)
from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_reconciliation_claim(text,integer)
to service_role;

create or replace function public.v1_service_paymob_reconciliation_runtime(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job marketplace.reconciliations%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_attempt_version marketplace.paymob_credential_versions%rowtype;
  v_inquiry_version marketplace.paymob_credential_versions%rowtype;
  v_api_key text;
  v_transaction_id text;
  v_mode text;
  v_order_lock_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  select reconciliation.order_id into v_order_lock_id
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.provider_key = 'paymob';
  if v_order_lock_id is null then raise exception 'paymob_reconciliation_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  select reconciliation.* into v_job
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.provider_key = 'paymob'
    and reconciliation.order_id = v_order_lock_id
  for update;
  if v_job.id is null
     or v_job.status <> 'running'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    raise exception 'paymob_reconciliation_lease_invalid';
  end if;
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = v_job.attempt_id
    and attempt.tenant_id = v_job.tenant_id
    and attempt.order_id = v_job.order_id;
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;
  select version.* into v_attempt_version
  from marketplace.paymob_credential_versions version
  where version.id = v_attempt.credential_version_id
    and version.environment = v_attempt.environment
    and version.status in ('active','retiring','expired');
  if v_attempt_version.id is null then
    raise exception 'paymob_attempt_credential_version_unavailable';
  end if;
  select version.* into v_inquiry_version
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = v_attempt_version.environment
    and version.integration_id = v_attempt_version.integration_id
    and version.owner_id = v_attempt_version.owner_id
  limit 1;
  if v_inquiry_version.id is null then
    raise exception 'paymob_reconciliation_active_account_credential_unavailable';
  end if;
  update marketplace.reconciliations
  set inquiry_credential_version_id = v_inquiry_version.id,updated_at = now()
  where id = v_job.id;
  select decrypted.decrypted_secret into v_api_key
  from vault.decrypted_secrets decrypted
  where decrypted.id = v_inquiry_version.api_key_vault_secret_id;
  if nullif(v_api_key, '') is null then
    raise exception 'paymob_reconciliation_api_key_unavailable';
  end if;
  v_transaction_id := coalesce(
    v_job.provider_transaction_id,
    v_attempt.provider_transaction_id
  );
  if v_transaction_id is not null
     and v_transaction_id !~ '^[1-9][0-9]{0,29}$' then
    raise exception 'paymob_reconciliation_transaction_id_invalid';
  end if;
  v_mode := case when v_transaction_id is null
    then 'merchant_order_id' else 'transaction_id' end;

  return jsonb_build_object(
    'schemaVersion', 1,
    'purpose', 'reconciliation_inquiry',
    'jobId', v_job.id,
    'providerKey', 'paymob',
    'apiBaseUrl', 'https://ksa.paymob.com',
    'apiKey', v_api_key,
    'environment', v_attempt_version.environment,
    'credentialVersionId', v_inquiry_version.id,
    'attemptCredentialVersionId',v_attempt_version.id,
    'inquiryCredentialVersionId',v_inquiry_version.id,
    'integrationId', v_attempt_version.integration_id,
    'owner', v_attempt_version.owner_id,
    'attemptId', v_attempt.id,
    'specialReference', v_attempt.id::text,
    'providerTransactionId', v_transaction_id,
    'inquiryMode', v_mode,
    'merchantOrderId', v_attempt.id::text,
    'inquiryMethod', case when v_mode = 'merchant_order_id' then 'POST' else 'GET' end,
    'inquiryPath', case when v_mode = 'merchant_order_id'
      then '/api/ecommerce/orders/transaction_inquiry'
      else '/api/acceptance/transactions/' || v_transaction_id
    end
  );
end;
$$;

revoke all on function public.v1_service_paymob_reconciliation_runtime(uuid,uuid,text)
from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_reconciliation_runtime(uuid,uuid,text)
to service_role;

create or replace function public.v1_service_paymob_reconciliation_reschedule(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job marketplace.reconciliations%rowtype;
  v_status text;
  v_due_at timestamptz;
  v_error_code text;
  v_order_lock_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if coalesce(p_outcome,'') not in ('retry','ambiguous','failed','review_required') then
    raise exception 'paymob_reconciliation_outcome_invalid';
  end if;
  v_error_code := coalesce(nullif(btrim(p_error_code),''),'provider_inquiry_failed');
  if v_error_code !~ '^[a-z][a-z0-9_]{1,80}$' then
    raise exception 'paymob_reconciliation_error_invalid';
  end if;
  select reconciliation.order_id into v_order_lock_id
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.provider_key = 'paymob';
  if v_order_lock_id is null then raise exception 'paymob_reconciliation_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  select reconciliation.* into v_job
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.order_id = v_order_lock_id
  for update;
  if v_job.id is null
     or v_job.status <> 'running'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    raise exception 'paymob_reconciliation_lease_invalid';
  end if;

  if p_outcome = 'review_required'
     or v_job.attempt_count >= v_job.max_attempts then
    v_status := 'review_required';
    v_due_at := v_job.due_at;
  else
    v_status := case when p_outcome = 'failed' then 'failed' else 'queued' end;
    v_due_at := now() + least(
      interval '6 hours',
      interval '30 seconds' * power(2::numeric, greatest(v_job.attempt_count - 1, 0))
    );
  end if;
  update marketplace.reconciliations
  set status = v_status,
      error_code = v_error_code,
      due_at = v_due_at,
      lease_token = null,
      lease_owner = null,
      lease_expires_at = null,
      checked_at = now(),
      updated_at = now()
  where id = v_job.id
  returning * into v_job;
  if v_status = 'review_required' then
    perform private_app.paymob_outbox_enqueue(
      v_job.tenant_id,v_job.order_id,v_job.attempt_id,
      'reconciliation_review',
      'reconciliation:review:' || v_job.id::text || ':' || v_job.attempt_count::text,
      jsonb_build_object(
        'jobId',v_job.id,'attemptId',v_job.attempt_id,
        'environment',v_job.environment,'reasonCode',v_error_code
      )
    );
  end if;
  return jsonb_build_object(
    'schemaVersion',1,'jobId',v_job.id,'status',v_job.status,
    'dueAt',case when v_job.status in ('queued','failed') then v_job.due_at else null end,
    'attemptCount',v_job.attempt_count,'lastErrorCode',v_job.error_code
  );
end;
$$;

revoke all on function public.v1_service_paymob_reconciliation_reschedule(
  uuid,uuid,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_reconciliation_reschedule(
  uuid,uuid,text,text,text
) to service_role;

create or replace function private_app.paymob_apply_verified_full_refund_v1(
  p_refund_id uuid,
  p_reconciliation_id uuid,
  p_evidence_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund marketplace.refunds%rowtype;
  v_job marketplace.reconciliations%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_order marketplace.orders%rowtype;
  v_source marketplace.entitlement_sources%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_snapshot marketplace.payment_attempt_items%rowtype;
  v_feature catalog.features%rowtype;
  v_current_module core.tenant_modules%rowtype;
  v_module_id uuid;
  v_effective_entitlement jsonb;
  v_review_required boolean := false;
  v_order_lock_id uuid;
  v_order_previous_status text;
  v_keep_module_enabled boolean;
  v_module_grant_applied boolean;
  v_feature_key text;
  v_entitlement_lock_product_id uuid;
begin
  if coalesce(p_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_refund_evidence_invalid';
  end if;
  select refund.order_id into v_order_lock_id
  from marketplace.refunds refund
  where refund.id = p_refund_id;
  if v_order_lock_id is null then raise exception 'paymob_refund_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  select refund.* into v_refund
  from marketplace.refunds refund
  where refund.id = p_refund_id and refund.order_id = v_order_lock_id
  for update;
  if v_refund.id is null then raise exception 'paymob_refund_not_found'; end if;
  if v_refund.status in ('applied','applied_with_review') then
    return jsonb_build_object(
      'refundId',v_refund.id,'attemptId',v_refund.attempt_id,
      'orderId',v_refund.order_id,'status',v_refund.status,
      'reviewRequired',v_refund.status = 'applied_with_review','duplicate',true
    );
  end if;
  select reconciliation.* into v_job
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_reconciliation_id
    and reconciliation.attempt_id = v_refund.attempt_id
    and reconciliation.reconciliation_type = 'refund_inquiry'
    and reconciliation.status = 'matched'
    and reconciliation.evidence_sha256 = p_evidence_sha256
    and reconciliation.observed_cumulative_refunded_minor = v_refund.amount_minor
    and reconciliation.observed_currency = v_refund.currency
  for share;
  if v_job.id is null
     or v_refund.verified_refunded_minor is distinct from v_refund.amount_minor
     or v_refund.verified_currency is distinct from v_refund.currency
     or v_refund.inquiry_reconciliation_id is distinct from v_job.id then
    raise exception 'paymob_authoritative_full_refund_required';
  end if;
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = v_refund.attempt_id
    and attempt.tenant_id = v_refund.tenant_id
    and attempt.order_id = v_refund.order_id
  for update;
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_attempt.order_id
    and orders.tenant_id = v_attempt.tenant_id
  for update;

  -- Mirror settlement's complete, deterministic entitlement lock set before
  -- reading an entitlement source or subscription. This closes cross-order
  -- paid/refund races without introducing product-order lock inversions.
  for v_entitlement_lock_product_id in
    select distinct snapshot.addon_product_id
    from marketplace.payment_attempt_items snapshot
    where snapshot.attempt_id = v_attempt.id
      and snapshot.tenant_id = v_attempt.tenant_id
      and snapshot.order_id = v_attempt.order_id
      and snapshot.addon_product_id is not null
    order by snapshot.addon_product_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'paymob:entitlement:' || v_attempt.tenant_id::text || ':'
        || v_entitlement_lock_product_id::text,
      0
    ));
  end loop;

  if v_attempt.status = 'refunded' and exists (
    select 1
    from marketplace.refunds applied_refund
    where applied_refund.attempt_id = v_attempt.id
      and applied_refund.tenant_id = v_attempt.tenant_id
      and applied_refund.order_id = v_attempt.order_id
      and applied_refund.provider_key = 'paymob'
      and applied_refund.provider_transaction_id = v_attempt.provider_transaction_id
      and applied_refund.amount_minor = v_attempt.amount_minor
      and applied_refund.currency = v_attempt.currency
      and applied_refund.status in ('applied','applied_with_review')
  ) then
    return jsonb_build_object(
      'refundId',v_refund.id,'attemptId',v_attempt.id,
      'orderId',v_attempt.order_id,'status','already_applied',
      'reviewRequired',false,'duplicate',true
    );
  end if;
  if v_attempt.id is null
     or v_order.id is null
     or v_attempt.status not in ('paid','refunded')
     or v_order.payment_provider <> 'paymob'
     or v_refund.provider_key is distinct from 'paymob'
     or v_refund.environment is distinct from v_attempt.environment
     or v_refund.tenant_id is distinct from v_attempt.tenant_id
     or v_refund.order_id is distinct from v_attempt.order_id
     or v_attempt.provider_transaction_id is distinct from v_refund.provider_transaction_id
     or v_refund.amount_minor is distinct from v_attempt.amount_minor
     or v_refund.currency is distinct from v_attempt.currency then
    raise exception 'paymob_refund_binding_invalid';
  end if;

  if v_attempt.order_kind_snapshot = 'addon' then
    for v_source in
      select source.*
      from marketplace.entitlement_sources source
      where source.attempt_id = v_attempt.id
        and source.tenant_id = v_attempt.tenant_id
        and source.order_id = v_attempt.order_id
        and source.state in ('active','review_required')
      order by source.created_at, source.id
      for update
    loop
      select subscription.* into v_subscription
      from catalog.tenant_addon_subscriptions subscription
      where subscription.id = v_source.subscription_id
        and subscription.tenant_id = v_source.tenant_id
        and subscription.product_id = v_source.addon_product_id
      for update;
      select snapshot.* into v_snapshot
      from marketplace.payment_attempt_items snapshot
      where snapshot.attempt_id = v_attempt.id
        and snapshot.order_item_id = v_source.order_item_id;
      v_module_grant_applied := coalesce(
        v_snapshot.activation_mode_snapshot = 'module'
        and v_source.module_id is not null
        and v_source.granted_module_enabled is not null
        and v_source.granted_module_configuration is not null
        and v_source.granted_module_enabled_at is not null,
        false
      );
      v_current_module.module_id := null;
      if v_module_grant_applied then
        select tenant_module.* into v_current_module
        from core.tenant_modules tenant_module
        where tenant_module.tenant_id = v_source.tenant_id
          and tenant_module.module_id = v_source.module_id
        for update;
      end if;

      -- A subscription-CAS failure records no applied grant. Preserve its
      -- review marker, attach the authoritative refund, and do not mutate a
      -- subscription or module that Paymob never granted.
      if v_source.applied_at is null then
        update marketplace.entitlement_sources
        set state = 'review_required',
            reversal_refund_id = v_refund.id,
            updated_at = now()
        where id = v_source.id;
        v_review_required := true;
        continue;
      end if;

      -- A module CAS may lose after the subscription grant was applied. In
      -- that case reverse the exact subscription below, skip all module
      -- preconditions/mutations, and keep the refund visibly review-required.
      if v_snapshot.activation_mode_snapshot = 'module'
         and not v_module_grant_applied then
        v_review_required := true;
      end if;

      if v_subscription.id is null
         or v_snapshot.id is null
         or v_subscription.status is distinct from v_source.granted_status
         or v_subscription.source is distinct from v_source.granted_source
         or v_subscription.period_start is distinct from v_source.granted_period_start
         or v_subscription.period_end is distinct from v_source.granted_period_end
         or v_subscription.payment_provider_key
           is distinct from v_source.granted_payment_provider_key
         or v_subscription.marketplace_order_id
           is distinct from v_source.granted_marketplace_order_id
         or v_subscription.auto_renew is distinct from v_source.granted_auto_renew
         or v_subscription.cancel_at_period_end
           is distinct from v_source.granted_cancel_at_period_end
         or v_subscription.requested_note
           is distinct from v_source.granted_requested_note
         or v_subscription.requested_by_subject_id
           is distinct from v_source.granted_requested_by_subject_id
         or v_subscription.decided_by_subject_id
           is distinct from v_source.granted_decided_by_subject_id
         or v_subscription.decision_note
           is distinct from v_source.granted_decision_note
         or v_subscription.activated_at
           is distinct from v_source.granted_activated_at
         or v_subscription.ended_at is distinct from v_source.granted_ended_at
         or (
           v_module_grant_applied
           and (
             v_source.module_id is null
             or v_current_module.module_id is null
             or v_current_module.enabled
               is distinct from v_source.granted_module_enabled
             or v_current_module.configuration
               is distinct from v_source.granted_module_configuration
             or v_current_module.enabled_at
               is distinct from v_source.granted_module_enabled_at
           )
         )
         or exists (
           select 1
           from marketplace.entitlement_sources newer
           where newer.tenant_id = v_source.tenant_id
             and newer.addon_product_id = v_source.addon_product_id
             and newer.state in ('active','review_required')
             and newer.id <> v_source.id
             and newer.applied_at is not null
             and v_source.applied_at is not null
             and (newer.applied_at,newer.id) > (v_source.applied_at,v_source.id)
         ) then
        update marketplace.entitlement_sources
        set state = 'review_required',
            reversal_refund_id = v_refund.id,
            updated_at = now()
        where id = v_source.id;
        v_review_required := true;
        continue;
      end if;

      update catalog.tenant_addon_subscriptions
      set status = case
            when v_source.previous_subscription_id = v_subscription.id
             and v_source.previous_status in ('pending','trialing','active','paused')
              then v_source.previous_status
            else 'expired'
          end,
          source = case
            when v_source.previous_subscription_id = v_subscription.id
              then coalesce(v_source.previous_source, source)
            else source
          end,
          period_start = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_period_start
            else period_start
          end,
          period_end = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_period_end
            else now()
          end,
          payment_provider_key = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_payment_provider_key
            else null
          end,
          marketplace_order_id = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_marketplace_order_id
            else null
          end,
          auto_renew = case
            when v_source.previous_subscription_id = v_subscription.id
              then coalesce(v_source.previous_auto_renew,false)
            else false
          end,
          cancel_at_period_end = case
            when v_source.previous_subscription_id = v_subscription.id
              then coalesce(v_source.previous_cancel_at_period_end,false)
            else false
          end,
          requested_note = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_requested_note
            else requested_note
          end,
          requested_by_subject_id = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_requested_by_subject_id
            else requested_by_subject_id
          end,
          decided_by_subject_id = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_decided_by_subject_id
            else decided_by_subject_id
          end,
          decision_note = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_decision_note
            else decision_note
          end,
          activated_at = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_activated_at
            else activated_at
          end,
          ended_at = case
            when v_source.previous_subscription_id = v_subscription.id
              then v_source.previous_ended_at else now() end,
          updated_at = now()
      where id = v_subscription.id
      returning * into v_subscription;

      update marketplace.entitlement_sources
      set state = 'reversed',
          reversed_at = now(),
          reversal_refund_id = v_refund.id,
          updated_at = now()
      where id = v_source.id;

      insert into catalog.tenant_addon_subscription_events(
        subscription_id,tenant_id,product_id,event_key,event_type,
        from_status,to_status,effective_at,actor_subject_id,metadata
      ) values (
        v_subscription.id,v_source.tenant_id,v_source.addon_product_id,
        'paymob_refund:' || v_refund.id::text || ':' || v_source.id::text,
        case when v_subscription.status = 'expired' then 'expired' else 'resumed' end,
        'active',v_subscription.status,now(),null,
        jsonb_build_object(
          'refundId',v_refund.id,'attemptId',v_attempt.id,
          'sourceId',v_source.id,'authoritativeInquiry',true
        )
      ) on conflict (tenant_id,product_id,event_key) do nothing;

      if v_snapshot.activation_mode_snapshot = 'module'
         and v_module_grant_applied then
        v_module_id := v_source.module_id;
        select feature.feature_key into v_feature_key
        from catalog.features feature
        where feature.id = v_snapshot.feature_id;
        if v_module_id is null or v_feature_key is null then
          update marketplace.entitlement_sources
          set state = 'review_required',updated_at = now()
          where id = v_source.id;
          v_review_required := true;
          continue;
        end if;

        -- The module row is restored only after the full granted-state CAS
        -- above succeeded. This removes Paymob provenance without clobbering a
        -- concurrent administrator change.
        if coalesce(v_source.previous_module_present,false) then
          update core.tenant_modules
          set enabled = v_source.previous_module_enabled,
              configuration = v_source.previous_module_configuration,
              enabled_at = v_source.previous_module_enabled_at,
              updated_at = now()
          where tenant_id = v_source.tenant_id
            and module_id = v_module_id;
        else
          -- Keep the migration/runtime additive: when Paymob created the row,
          -- clear its provenance and disable it instead of deleting a core row.
          update core.tenant_modules
          set enabled = false,configuration = '{}'::jsonb,
              enabled_at = null,updated_at = now()
          where tenant_id = v_source.tenant_id
            and module_id = v_module_id;
        end if;

        select private_app.addon_entitlement(
          v_source.tenant_id,v_feature_key
        ) into v_effective_entitlement;
        v_keep_module_enabled := coalesce(
          (v_effective_entitlement ->> 'enabled')::boolean,false
        ) or exists (
          select 1
          from marketplace.entitlement_sources other_source
          join marketplace.payment_attempt_items other_snapshot
            on other_snapshot.order_item_id = other_source.order_item_id
          join catalog.features other_feature
            on other_feature.id = other_snapshot.feature_id
          join core.modules other_module
            on other_feature.feature_key = 'module.' || other_module.module_key
          where other_source.tenant_id = v_source.tenant_id
            and other_source.state = 'active'
            and other_source.id <> v_source.id
            and other_module.id = v_module_id
        );
        if v_keep_module_enabled then
          insert into core.tenant_modules(
            tenant_id,module_id,enabled,configuration,enabled_at,updated_at
          ) values (
            v_source.tenant_id,v_module_id,true,
            coalesce(v_source.previous_module_configuration,'{}'::jsonb)
              || jsonb_build_object(
                'source','effective_entitlement_recomputed',
                'featureKey',v_feature_key
              ),
            coalesce(v_source.previous_module_enabled_at,now()),now()
          )
          on conflict (tenant_id,module_id) do update
          set enabled = true,
              configuration = core.tenant_modules.configuration
                - 'orderId' - 'productKey'
                || excluded.configuration,
              enabled_at = coalesce(core.tenant_modules.enabled_at,now()),
              updated_at = now();
        end if;
      end if;
    end loop;
  end if;

  v_order_previous_status := v_order.status;
  perform set_config('odeir.paymob_verified_order_id',v_order.id::text,true);
  update marketplace.orders
  set payment_status = 'refunded',
      status = 'refunded',
      activation_state = case
        when order_kind = 'addon' and v_review_required then 'failed'
        when order_kind = 'addon' then 'not_applicable'
        else activation_state
      end,
      updated_at = now()
  where id = v_order.id
  returning * into v_order;
  update marketplace.payment_attempts
  set status = 'refunded',
      terminal_at = coalesce(terminal_at,now()),
      last_error_code = case when v_review_required
        then 'entitlement_reversal_review_required' else null end,
      updated_at = now()
  where id = v_attempt.id
  returning * into v_attempt;
  update marketplace.refunds
  set status = case when v_review_required then 'applied_with_review' else 'applied' end,
      resolution_code = case when v_review_required
        then 'source_changed_review_required' else 'verified_full_refund_applied' end,
      resolved_at = now(),
      updated_at = now()
  where id = v_refund.id
  returning * into v_refund;
  update marketplace.refunds sibling_refund
  set status = 'rejected',
      resolution_code = 'superseded_by_authoritative_full_refund',
      resolved_at = now(),
      dispatch_claim_token = null,dispatch_claim_expires_at = null,
      updated_at = now()
  where sibling_refund.attempt_id = v_attempt.id
    and sibling_refund.id <> v_refund.id
    and sibling_refund.status in (
      'requested','review_required','processing','unknown','succeeded'
    );

  insert into marketplace.payment_events(
    order_id,provider_key,provider_event_id,payment_reference,state,
    amount_minor,currency,signature_verified,payload_sha256
  ) values (
    v_order.id,'paymob',
    left(v_attempt.environment || ':' || v_attempt.provider_transaction_id || ':refunded',200),
    v_attempt.provider_transaction_id,'refunded',v_attempt.amount_minor,
    v_attempt.currency,false,p_evidence_sha256
  ) on conflict (provider_key,provider_event_id) do nothing;

  perform private_app.paymob_outbox_enqueue(
    v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'refund_applied',
    'refund_applied:' || v_refund.id::text,
    jsonb_build_object(
      'refundId',v_refund.id,'attemptId',v_attempt.id,
      'orderNumber',v_attempt.order_number_snapshot,
      'status',v_refund.status,'sourceScoped',true,
      'reviewRequired',v_review_required
    )
  );
  insert into marketplace.order_events(
    order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata
  ) values (
    v_order.id,v_order.tenant_id,null,'paymob_refund_applied',
    v_order_previous_status,'refunded',
    jsonb_build_object(
      'refundId',v_refund.id,'attemptId',v_attempt.id,
      'reconciliationId',v_job.id,'evidenceSha256',p_evidence_sha256,
      'sourceScoped',true,'reviewRequired',v_review_required
    )
  );
  insert into audit_log.events(
    tenant_id,action,resource_type,resource_id,context
  ) values (
    v_attempt.tenant_id,'marketplace.paymob.refund_applied',
    'marketplace_refund',v_refund.id::text,
    jsonb_build_object(
      'attemptId',v_attempt.id,'orderId',v_order.id,
      'reconciliationId',v_job.id,'evidenceSha256',p_evidence_sha256,
      'authoritativeInquiry',true,'sourceScoped',true,
      'reviewRequired',v_review_required,'piiStored',false
    )
  );
  return jsonb_build_object(
    'refundId',v_refund.id,'attemptId',v_attempt.id,
    'orderId',v_order.id,'status',v_refund.status,
    'reviewRequired',v_review_required
  );
end;
$$;

revoke all on function private_app.paymob_apply_verified_full_refund_v1(
  uuid,uuid,text
) from public, anon, authenticated, service_role;

create or replace function public.v1_service_paymob_reconciliation_apply(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_inquiry_credential_version_id uuid,
  p_inquiry_mode text,
  p_provider_transaction_id text,
  p_provider_order_id text,
  p_merchant_order_id text,
  p_integration_id text,
  p_owner text,
  p_success boolean,
  p_pending boolean,
  p_error_occured boolean,
  p_has_parent_transaction boolean,
  p_is_auth boolean,
  p_is_capture boolean,
  p_is_standalone_payment boolean,
  p_is_voided boolean,
  p_is_refunded boolean,
  p_amount_minor bigint,
  p_currency text,
  p_order_paid_amount_minor bigint,
  p_cumulative_refunded_minor bigint,
  p_response_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job marketplace.reconciliations%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_inquiry_version marketplace.paymob_credential_versions%rowtype;
  v_refund marketplace.refunds%rowtype;
  v_result jsonb;
  v_transaction_id text := nullif(btrim(p_provider_transaction_id),'');
  v_order_id text := nullif(btrim(p_provider_order_id),'');
  v_currency text := upper(nullif(btrim(p_currency),''));
  v_final_paid boolean;
  v_final_failed boolean;
  v_outcome text;
  v_error_code text;
  v_order_lock_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_inquiry_mode not in ('transaction_id','merchant_order_id')
     or coalesce(p_response_sha256,'') !~ '^[a-f0-9]{64}$'
     or coalesce(v_transaction_id,'') !~ '^[1-9][0-9]{0,29}$'
     or coalesce(v_order_id,'') !~ '^[1-9][0-9]{0,29}$'
     or coalesce(p_integration_id,'') !~ '^[1-9][0-9]{0,29}$'
     or coalesce(p_owner,'') !~ '^[1-9][0-9]{0,29}$' then
    raise exception 'paymob_reconciliation_response_invalid';
  end if;
  select reconciliation.order_id into v_order_lock_id
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.provider_key = 'paymob';
  if v_order_lock_id is null then raise exception 'paymob_reconciliation_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_lock_id::text,0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:inquiry_transaction:' || v_transaction_id,
    0
  ));
  select reconciliation.* into v_job
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.order_id = v_order_lock_id
  for update;
  if v_job.id is null
     or v_job.status <> 'running'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at <= now() then
    raise exception 'paymob_reconciliation_lease_invalid';
  end if;
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = v_job.attempt_id
    and attempt.tenant_id = v_job.tenant_id
    and attempt.order_id = v_job.order_id
  for update;
  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.id = v_attempt.credential_version_id
    and version.environment = v_attempt.environment
    and version.status in ('active','retiring','expired');
  if v_attempt.id is null or v_version.id is null then
    raise exception 'paymob_reconciliation_binding_invalid';
  end if;
  select version.* into v_inquiry_version
  from marketplace.paymob_credential_versions version
  where version.id = p_inquiry_credential_version_id
    and version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = v_version.environment
    and version.integration_id = v_version.integration_id
    and version.owner_id = v_version.owner_id;

  v_final_paid :=
    coalesce(p_success,false)
    and not coalesce(p_pending,false)
    and not coalesce(p_error_occured,false)
    and not coalesce(p_has_parent_transaction,false)
    and not coalesce(p_is_auth,false)
    and not coalesce(p_is_capture,false)
    and coalesce(p_is_standalone_payment,false)
    and not coalesce(p_is_voided,false)
    and not coalesce(p_is_refunded,false);

  v_error_code := case
    when p_inquiry_credential_version_id is null
      or v_inquiry_version.id is null
      or v_job.inquiry_credential_version_id
        is distinct from p_inquiry_credential_version_id
      then 'inquiry_credential_binding_mismatch'
    when v_final_paid and exists (
      select 1
      from marketplace.reconciliations review_job
      where review_job.order_id = v_attempt.order_id
        and review_job.provider_key = 'paymob'
        and review_job.id <> v_job.id
        and review_job.status in ('review_required','mismatch')
    ) then 'order_payment_review_hold'
    when (
      v_final_paid
      or p_cumulative_refunded_minor = v_attempt.amount_minor
    ) and exists (
      select 1
      from marketplace.payment_attempts active_sibling
      where active_sibling.provider_key = 'paymob'
        and active_sibling.environment = v_attempt.environment
        and active_sibling.order_id = v_attempt.order_id
        and active_sibling.id <> v_attempt.id
        and active_sibling.status in (
          'prepared','creating_intention','intention_created','pending',
          'unknown','quarantined'
        )
    ) then 'active_sibling_payment_conflict'
    when p_inquiry_mode is distinct from case
      when coalesce(v_job.provider_transaction_id,v_attempt.provider_transaction_id) is null
        then 'merchant_order_id'
      else 'transaction_id'
    end then 'inquiry_mode_binding_mismatch'
    when p_merchant_order_id is distinct from v_attempt.id::text
      then 'merchant_order_binding_mismatch'
    when p_integration_id <> v_version.integration_id
      then 'integration_binding_mismatch'
    when p_owner <> v_version.owner_id then 'owner_binding_mismatch'
    when p_amount_minor is distinct from v_attempt.amount_minor
      or v_currency is distinct from v_attempt.currency
      then 'amount_currency_mismatch'
    when p_order_paid_amount_minor is null
      or p_order_paid_amount_minor < 0
      or p_order_paid_amount_minor > v_attempt.amount_minor
      then 'order_paid_amount_invalid'
    when v_final_paid
      and p_order_paid_amount_minor is distinct from v_attempt.amount_minor
      then 'order_paid_amount_mismatch'
    when p_order_paid_amount_minor > 0
      and not v_final_paid
      and not coalesce(p_is_refunded,false)
      and not coalesce(p_is_voided,false)
      and coalesce(p_cumulative_refunded_minor,0) = 0
      then 'order_paid_aggregate_requires_review'
    when p_cumulative_refunded_minor is null
      or p_cumulative_refunded_minor < 0
      or p_cumulative_refunded_minor > v_attempt.amount_minor
      then 'cumulative_refund_amount_invalid'
    when exists (
      select 1
      from marketplace.payment_attempts other_attempt
      where other_attempt.provider_key = 'paymob'
        and other_attempt.environment = v_attempt.environment
        and other_attempt.provider_transaction_id = v_transaction_id
        and other_attempt.id <> v_attempt.id
    ) then 'transaction_reused_by_other_attempt'
    when v_attempt.provider_transaction_id is not null
      and v_attempt.provider_transaction_id <> v_transaction_id
      then 'transaction_binding_mismatch'
    when coalesce(v_job.provider_transaction_id,v_attempt.provider_transaction_id) is not null
      and coalesce(v_job.provider_transaction_id,v_attempt.provider_transaction_id)
        <> v_transaction_id
      then 'transaction_inquiry_binding_mismatch'
    when v_attempt.provider_order_id is not null
      and v_attempt.provider_order_id <> v_order_id
      then 'provider_order_binding_mismatch'
    else null
  end;
  if v_error_code is not null then
    if coalesce(p_order_paid_amount_minor,0) > 0 or v_final_paid then
      update marketplace.payment_attempts
      set status = 'quarantined',terminal_at = null,
          last_error_code = v_error_code,updated_at = now()
      where id = v_attempt.id
        and status not in ('paid','refunded','cancelled')
        and not exists (
          select 1
          from marketplace.payment_attempts active_sibling
          where active_sibling.provider_key = 'paymob'
            and active_sibling.environment = v_attempt.environment
            and active_sibling.order_id = v_attempt.order_id
            and active_sibling.id <> v_attempt.id
            and active_sibling.status in (
              'prepared','creating_intention','intention_created','pending',
              'unknown','quarantined'
            )
        );
    end if;
    update marketplace.reconciliations
    set status = 'review_required',
        observed_amount_minor = greatest(coalesce(p_amount_minor,0),0),
        observed_currency = v_currency,
        observed_order_paid_minor = greatest(
          coalesce(p_order_paid_amount_minor,0),0
        ),
        observed_cumulative_refunded_minor = greatest(
          coalesce(p_cumulative_refunded_minor,0),0
        ),
        observed_state = 'mismatch',
        evidence_sha256 = p_response_sha256,
        error_code = v_error_code,
        checked_at = now(),
        lease_token = null,lease_owner = null,lease_expires_at = null,
        updated_at = now()
    where id = v_job.id;
    perform private_app.paymob_outbox_enqueue(
      v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,
      'reconciliation_review','reconciliation:mismatch:' || v_job.id::text,
      jsonb_build_object(
        'jobId',v_job.id,'attemptId',v_attempt.id,'reasonCode',v_error_code
      )
    );
    return jsonb_build_object(
      'schemaVersion',1,'jobId',v_job.id,'outcome','review_required',
      'reasonCode',v_error_code
    );
  end if;

  update marketplace.payment_attempts
  set provider_order_id = coalesce(provider_order_id,v_order_id),
      updated_at = now()
  where id = v_attempt.id
  returning * into v_attempt;
  v_final_failed :=
    not coalesce(p_pending,false)
    and not v_final_paid
    and (not coalesce(p_success,false) or coalesce(p_error_occured,false));

  if coalesce(p_is_refunded,false) or coalesce(p_is_voided,false)
     or p_cumulative_refunded_minor > 0 then
    select refund.* into v_refund
    from marketplace.refunds refund
    where refund.attempt_id = v_attempt.id
      and refund.status in (
        'requested','review_required','processing','unknown','succeeded'
      )
    order by refund.created_at,refund.id
    limit 1
    for update;
    if v_refund.id is not null and (
      v_refund.tenant_id is distinct from v_attempt.tenant_id
      or v_refund.order_id is distinct from v_attempt.order_id
      or v_refund.provider_key is distinct from 'paymob'
      or v_refund.environment is distinct from v_attempt.environment
      or v_refund.provider_transaction_id is distinct from v_transaction_id
      or v_refund.amount_minor is distinct from v_attempt.amount_minor
      or v_refund.currency is distinct from v_attempt.currency
    ) then
      update marketplace.refunds
      set status = 'review_required',error_code = 'refund_binding_drift',
          updated_at = now()
      where id = v_refund.id;
      update marketplace.reconciliations
      set status = 'review_required',observed_amount_minor = p_amount_minor,
          observed_currency = v_currency,
          observed_order_paid_minor = p_order_paid_amount_minor,
          observed_cumulative_refunded_minor = p_cumulative_refunded_minor,
          observed_state = 'mismatch',evidence_sha256 = p_response_sha256,
          error_code = 'refund_binding_drift',checked_at = now(),
          lease_token = null,lease_owner = null,lease_expires_at = null,
          updated_at = now()
      where id = v_job.id;
      perform private_app.paymob_outbox_enqueue(
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'refund_review',
        'refund_binding_drift:' || v_refund.id::text,
        jsonb_build_object(
          'refundId',v_refund.id,'attemptId',v_attempt.id,
          'reasonCode','refund_binding_drift'
        )
      );
      return jsonb_build_object(
        'schemaVersion',1,'jobId',v_job.id,'attemptId',v_attempt.id,
        'outcome','review_required','reasonCode','refund_binding_drift'
      );
    end if;
    if v_refund.id is null then
      insert into marketplace.refunds(
        tenant_id,order_id,attempt_id,source_delivery_id,provider_key,
        environment,provider_transaction_id,refund_kind,status,
        amount_minor,currency,provider_created_at
      ) values (
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,null,'paymob',
        v_attempt.environment,v_transaction_id,
        case when coalesce(p_is_voided,false) then 'void' else 'refund' end,
        'review_required',v_attempt.amount_minor,v_attempt.currency,now()
      )
      on conflict (attempt_id,provider_transaction_id)
        where status in (
          'requested','review_required','processing','unknown','succeeded'
        )
      do update
      set updated_at = now()
      returning * into v_refund;
    end if;
    update marketplace.reconciliations
    set status = case when p_cumulative_refunded_minor = v_attempt.amount_minor
          then 'matched' else 'review_required' end,
        provider_transaction_id = v_transaction_id,
        provider_order_id = v_order_id,
        observed_amount_minor = p_amount_minor,
        observed_currency = v_currency,
        observed_order_paid_minor = p_order_paid_amount_minor,
        observed_cumulative_refunded_minor = p_cumulative_refunded_minor,
        observed_state = case when p_cumulative_refunded_minor = v_attempt.amount_minor
          then 'full_refund' else 'partial_refund' end,
        evidence_sha256 = p_response_sha256,
        error_code = case when p_cumulative_refunded_minor = v_attempt.amount_minor
          then null else 'partial_refund_review_required' end,
        checked_at = now(),
        lease_token = null,lease_owner = null,lease_expires_at = null,
        updated_at = now()
    where id = v_job.id
    returning * into v_job;
    update marketplace.refunds
    set status = case when p_cumulative_refunded_minor = v_attempt.amount_minor
          then 'succeeded' else 'review_required' end,
        verified_refunded_minor = p_cumulative_refunded_minor,
        verified_currency = v_currency,
        inquiry_reconciliation_id = v_job.id,
        error_code = case when p_cumulative_refunded_minor = v_attempt.amount_minor
          then null else 'partial_refund_review_required' end,
        updated_at = now()
    where id = v_refund.id
    returning * into v_refund;
    if v_attempt.environment = 'sandbox' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox','refund_inquiry',true,p_response_sha256,null,
        'reconciliation',v_job.id
      );
    end if;
    if p_cumulative_refunded_minor = v_attempt.amount_minor then
      if v_attempt.status not in ('paid','refunded') then
        -- An authenticated inquiry may be the first authoritative observation
        -- of both the captured payment and its full refund. Record the paid
        -- financial leg and canonical transaction in this same transaction,
        -- but suppress add-on/service fulfillment and payment-paid delivery.
        v_result := private_app.paymob_apply_paid_attempt_v1(
          v_attempt.id,v_transaction_id,p_response_sha256,
          'inquiry_fully_refunded'
        );
      end if;
      v_result := private_app.paymob_apply_verified_full_refund_v1(
        v_refund.id,v_job.id,p_response_sha256
      );
      v_outcome := 'matched';
    else
      perform private_app.paymob_outbox_enqueue(
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'refund_review',
        'refund_partial:' || v_refund.id::text || ':' || p_response_sha256,
        jsonb_build_object(
          'refundId',v_refund.id,'attemptId',v_attempt.id,
          'reasonCode','partial_refund_review_required'
        )
      );
      v_outcome := 'review_required';
    end if;
  elsif v_final_paid then
    if v_attempt.status in ('cancelled','refunded') then
      return public.v1_service_paymob_reconciliation_reschedule(
        p_job_id,p_lease_token,p_worker_id,
        'review_required','terminal_state_conflict'
      );
    end if;
    v_result := private_app.paymob_apply_paid_attempt_v1(
      v_attempt.id,v_transaction_id,p_response_sha256,'inquiry'
    );
    update marketplace.reconciliations
    set status = 'matched',provider_transaction_id = v_transaction_id,
        provider_order_id = v_order_id,observed_amount_minor = p_amount_minor,
        observed_currency = v_currency,
        observed_order_paid_minor = p_order_paid_amount_minor,
        observed_cumulative_refunded_minor = 0,
        observed_state = 'paid',evidence_sha256 = p_response_sha256,
        error_code = null,checked_at = now(),
        lease_token = null,lease_owner = null,lease_expires_at = null,
        updated_at = now()
    where id = v_job.id;
    if v_attempt.environment = 'sandbox' then
      perform private_app.paymob_readiness_evidence_try_write(
        'sandbox','transaction_inquiry',true,p_response_sha256,null,
        'reconciliation',v_job.id
      );
    end if;
    v_outcome := 'matched';
  elsif coalesce(p_pending,false) or (
    coalesce(p_success,false) and coalesce(p_is_auth,false)
  ) then
    update marketplace.payment_attempts
    set status = case when status in ('paid','refunded','failed','cancelled')
          then status else 'pending' end,
        updated_at = now()
    where id = v_attempt.id;
    update marketplace.reconciliations
    set status = 'queued',due_at = now() + interval '5 minutes',
        last_observed_transaction_id = v_transaction_id,
        observed_amount_minor = p_amount_minor,observed_currency = v_currency,
        observed_order_paid_minor = p_order_paid_amount_minor,
        observed_cumulative_refunded_minor = p_cumulative_refunded_minor,
        observed_state = 'pending',evidence_sha256 = p_response_sha256,
        error_code = null,checked_at = now(),
        lease_token = null,lease_owner = null,lease_expires_at = null,
        updated_at = now()
    where id = v_job.id;
    v_outcome := 'pending';
  elsif v_final_failed then
    if now() < v_attempt.expires_at + interval '10 minutes'
       or v_job.attempt_count < 2 then
      -- A failed Paymob transaction is one child payment under the Intention,
      -- not proof that a later retry cannot settle. Keep merchant-reference
      -- inquiry authoritative until provider expiry plus a safety grace.
      update marketplace.payment_attempts
      set status = case when expires_at > now() then 'pending' else 'unknown' end,
          last_error_code = 'payment_child_failed_inquiry_required',
          updated_at = now()
      where id = v_attempt.id
        and status not in ('paid','refunded','cancelled');
      update marketplace.reconciliations
      set status = 'queued',
          due_at = greatest(
            now() + interval '5 minutes',
            v_attempt.expires_at + interval '10 minutes'
          ),
          last_observed_transaction_id = v_transaction_id,
          observed_amount_minor = p_amount_minor,
          observed_currency = v_currency,
          observed_order_paid_minor = p_order_paid_amount_minor,
          observed_cumulative_refunded_minor = p_cumulative_refunded_minor,
          observed_state = 'failed_child',
          evidence_sha256 = p_response_sha256,
          error_code = 'payment_child_failed_inquiry_required',
          checked_at = now(),lease_token = null,lease_owner = null,
          lease_expires_at = null,updated_at = now()
      where id = v_job.id;
      v_outcome := 'pending';
    else
      update marketplace.payment_attempts
      set status = case when status in ('paid','refunded','cancelled')
            then status else 'failed' end,
          last_error_code = case when status in ('paid','refunded','cancelled')
            then last_error_code else 'provider_intention_expired_no_payment' end,
          terminal_at = case when status in ('paid','refunded','cancelled')
            then terminal_at else now() end,
          checkout_secret_expires_at = case when checkout_secret_id is null
            then null else now() end,
          updated_at = now()
      where id = v_attempt.id;
      update marketplace.orders
      set payment_status = 'failed',updated_at = now()
      where id = v_attempt.order_id
        and tenant_id = v_attempt.tenant_id
        and status = 'pending_payment'
        and payment_status in ('pending','failed')
        and payment_provider = 'paymob';
      update marketplace.reconciliations
      set status = 'matched',last_observed_transaction_id = v_transaction_id,
          observed_amount_minor = p_amount_minor,
          observed_currency = v_currency,
          observed_order_paid_minor = p_order_paid_amount_minor,
          observed_cumulative_refunded_minor = p_cumulative_refunded_minor,
          observed_state = 'intention_expired_no_payment',
          evidence_sha256 = p_response_sha256,error_code = null,
          checked_at = now(),lease_token = null,lease_owner = null,
          lease_expires_at = null,updated_at = now()
      where id = v_job.id;
      perform private_app.paymob_outbox_enqueue(
        v_attempt.tenant_id,v_attempt.order_id,v_attempt.id,'payment_failed',
        'payment_failed:inquiry:' || v_job.id::text,
        jsonb_build_object(
          'jobId',v_job.id,'attemptId',v_attempt.id,
          'orderNumber',v_attempt.order_number_snapshot,'provider','paymob',
          'environment',v_attempt.environment,
          'errorCode','provider_intention_expired_no_payment'
        )
      );
      v_outcome := 'matched';
    end if;
  else
    return public.v1_service_paymob_reconciliation_reschedule(
      p_job_id,p_lease_token,p_worker_id,
      'ambiguous','provider_state_ambiguous'
    );
  end if;

  return coalesce(v_result,'{}'::jsonb) || jsonb_build_object(
    'schemaVersion',1,'jobId',v_job.id,'attemptId',v_attempt.id,
    'outcome',v_outcome,'providerTransactionId',v_transaction_id
  );
end;
$$;

revoke all on function public.v1_service_paymob_reconciliation_apply(
  uuid,uuid,text,uuid,text,text,text,text,text,text,
  boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,
  bigint,text,bigint,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_reconciliation_apply(
  uuid,uuid,text,uuid,text,text,text,text,text,text,
  boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,
  bigint,text,bigint,bigint,text
) to service_role;

-------------------------------------------------------------------------------
-- 9. Customer status and platform readiness/rollout governance
-------------------------------------------------------------------------------

create or replace function public.v1_tenant_paymob_checkout_status(
  p_slug text,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_order marketplace.orders%rowtype;
  v_terminal boolean;
begin
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.tenant_id = v_tenant.id
    and attempt.provider_key = 'paymob';
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_attempt.order_id
    and orders.tenant_id = v_tenant.id;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
  v_terminal := v_attempt.status in ('paid','failed','refunded','cancelled');
  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion',1,
    'attemptId',v_attempt.id,
    'orderId',v_order.id,
    'orderNumber',v_order.order_number,
    'orderKind',v_order.order_kind,
    'attemptStatus',v_attempt.status,
    'orderStatus',v_order.status,
    'paymentStatus',v_order.payment_status,
    'terminal',v_terminal,
    'refreshAfterMs',case
      when v_terminal then 0
      when v_attempt.status in ('unknown','quarantined') then 5000
      else 1500
    end
  ));
end;
$$;

revoke all on function public.v1_tenant_paymob_checkout_status(text,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.v1_tenant_paymob_checkout_status(text,uuid)
to authenticated;

create or replace function public.v1_service_paymob_readiness_evidence(
  p_environment text,
  p_check_key text,
  p_passed boolean,
  p_evidence_sha256 text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_environment <> 'sandbox'
     or p_check_key <> 'credentials'
     or not coalesce(p_passed,false) then
    raise exception 'paymob_event_readiness_must_be_derived_from_ledger';
  end if;
  select version.id into v_version_id
  from marketplace.paymob_credential_versions version
  join marketplace.payment_provider_configs provider
    on provider.provider_key = version.provider_key
  where version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = 'sandbox'
    and provider.environment = 'sandbox'
    and provider.credentials_environment = 'sandbox'
    and version.integration_id = provider.public_config ->> 'integrationId'
    and version.owner_id = provider.public_config ->> 'merchantAccountId'
    and provider.public_config ->> 'region' = 'ksa'
    and provider.checkout_mode = 'redirect'
    and provider.supported_currencies = array['SAR']::text[]
    and private_app.v3_payment_provider_bundle_complete(
      provider.provider_key,provider.environment,
      provider.credentials_environment,provider.required_secret_keys,
      provider.required_public_config_keys,provider.public_config
    );
  if v_version_id is null then
    raise exception 'paymob_credential_evidence_bundle_incomplete';
  end if;
  perform private_app.paymob_readiness_evidence_write(
    p_environment,p_check_key,true,p_evidence_sha256,p_error_code,
    'credential_version',v_version_id
  );
  return jsonb_build_object(
    'schemaVersion',1,'environment',p_environment,'checkKey',p_check_key,
    'passed',coalesce(p_passed,false),'recorded',true
  );
end;
$$;

revoke all on function public.v1_service_paymob_readiness_evidence(
  text,text,boolean,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_readiness_evidence(
  text,text,boolean,text,text
) to service_role;

create or replace function public.v1_platform_paymob_operational_evidence_action(
  p_check_key text,
  p_evidence_sha256 text,
  p_request_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_request marketplace.paymob_operational_evidence_requests%rowtype;
  v_request_confirmation text;
  v_approve_confirmation text;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  if p_check_key not in (
       'refund_initiation','live_credentials','live_card_integration_callback',
       'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
     )
     or coalesce(p_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_operational_evidence_invalid';
  end if;
  select version.* into v_version
  from marketplace.paymob_credential_versions version
  join marketplace.payment_provider_configs provider
    on provider.provider_key = version.provider_key
  where version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = 'live'
    and provider.environment = 'live'
    and provider.credentials_environment = 'live'
    and version.integration_id = provider.public_config ->> 'integrationId'
    and version.owner_id = provider.public_config ->> 'merchantAccountId'
    and provider.public_config ->> 'region' = 'ksa'
    and provider.checkout_mode = 'redirect'
    and provider.supported_currencies = array['SAR']::text[]
  for share of version;
  if v_version.id is null then
    raise exception 'paymob_live_credential_version_required';
  end if;

  v_request_confirmation := 'REQUEST PAYMOB EVIDENCE ' || p_check_key;
  if p_request_id is null then
    if p_confirmation is distinct from v_request_confirmation then
      raise exception 'paymob_operational_evidence_confirmation_invalid';
    end if;
    update marketplace.paymob_operational_evidence_requests
    set status = 'expired',updated_at = now()
    where credential_version_id = v_version.id
      and check_key = p_check_key
      and status in ('pending','approved')
      and expires_at <= now();
    if exists (
      select 1
      from marketplace.paymob_operational_evidence_requests request
      where request.credential_version_id = v_version.id
        and request.check_key = p_check_key
        and request.status = 'pending'
        and request.expires_at > now()
        and request.evidence_sha256 is distinct from p_evidence_sha256
    ) then
      raise exception 'paymob_operational_evidence_pending_exists';
    end if;
    insert into marketplace.paymob_operational_evidence_requests(
      credential_version_id,environment,check_key,evidence_sha256,status,
      requested_by_subject_id,requested_at,expires_at
    ) values (
      v_version.id,'live',p_check_key,p_evidence_sha256,'pending',
      v_actor,now(),now() + interval '24 hours'
    )
    on conflict (credential_version_id,check_key,evidence_sha256) do update
    set status = 'pending',requested_by_subject_id = v_actor,
        requested_at = now(),approved_by_subject_id = null,approved_at = null,
        expires_at = now() + interval '24 hours',
        updated_at = now()
    where marketplace.paymob_operational_evidence_requests.status in (
      'rejected','expired'
    )
    returning * into v_request;
    if v_request.id is null then
      select request.* into v_request
      from marketplace.paymob_operational_evidence_requests request
      where request.credential_version_id = v_version.id
        and request.check_key = p_check_key
        and request.evidence_sha256 = p_evidence_sha256
      for update;
      if v_request.status = 'approved' then
        raise exception 'paymob_operational_evidence_already_approved';
      end if;
    end if;
  else
    v_approve_confirmation := 'APPROVE PAYMOB EVIDENCE ' || p_request_id::text;
    if p_confirmation is distinct from v_approve_confirmation then
      raise exception 'paymob_operational_evidence_confirmation_invalid';
    end if;
    select request.* into v_request
    from marketplace.paymob_operational_evidence_requests request
    where request.id = p_request_id
      and request.credential_version_id = v_version.id
      and request.environment = 'live'
      and request.check_key = p_check_key
      and request.evidence_sha256 = p_evidence_sha256
    for update;
    if v_request.id is null
       or v_request.status <> 'pending'
       or v_request.requested_by_subject_id = v_actor
       or v_request.expires_at <= now() then
      raise exception 'paymob_operational_evidence_checker_required';
    end if;
    update marketplace.paymob_operational_evidence_requests
    set status = 'approved',approved_by_subject_id = v_actor,
        approved_at = now(),expires_at = now() + case
          when check_key = 'live_credentials' then interval '24 hours'
          else interval '30 days' end,updated_at = now()
    where id = v_request.id
    returning * into v_request;
    perform private_app.paymob_readiness_evidence_write(
      'live',p_check_key,true,p_evidence_sha256,null,
      'operational_attestation',v_request.id
    );
  end if;

  insert into audit_log.events(
    actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_actor,'marketplace.paymob.operational_evidence_action',
    'paymob_operational_evidence',v_request.id::text,
    jsonb_build_object(
      'checkKey',p_check_key,'environment','live','status',v_request.status,
      'credentialVersionId',v_version.id,
      'twoPersonApproved',v_request.status = 'approved',
      'artifactSha256',p_evidence_sha256,'secretStored',false,'piiStored',false
    )
  );
  return jsonb_build_object(
    'schemaVersion',1,'requestId',v_request.id,'checkKey',p_check_key,
    'environment','live','status',v_request.status,
    'pendingApproval',v_request.status = 'pending',
    'expiresAt',v_request.expires_at
  );
end;
$$;

revoke all on function public.v1_platform_paymob_operational_evidence_action(
  text,text,uuid,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_paymob_operational_evidence_action(
  text,text,uuid,text
) to authenticated;

create or replace function public.v1_platform_paymob_activation_gate(
  p_target_mode text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_missing text[];
  v_request_confirmation text;
  v_approve_confirmation text;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  if p_target_mode not in ('observe_only','sandbox','live') then
    raise exception 'paymob_activation_target_invalid';
  end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for update;
  if v_provider.provider_key is null then raise exception 'payment_provider_not_found'; end if;

  if p_target_mode = 'observe_only' then
    if p_confirmation <> 'DISABLE PAYMOB CHECKOUT' then
      raise exception 'paymob_activation_confirmation_invalid';
    end if;
    update marketplace.payment_provider_configs
    set status = case when status = 'disabled' then 'disabled' else 'configured' end,
        rollout_mode = 'observe_only',last_verified_at = null,
        activated_by_subject_id = null,activated_at = null,
        activation_requested_by_subject_id = null,
        activation_requested_at = null,activation_requested_mode = null,
        updated_at = now()
    where provider_key = 'paymob'
    returning * into v_provider;
  else
    v_request_confirmation := 'REQUEST PAYMOB ' || upper(p_target_mode);
    v_approve_confirmation := 'APPROVE PAYMOB ' || upper(p_target_mode);
    if p_confirmation = v_request_confirmation then
      update marketplace.payment_provider_configs
      set activation_requested_by_subject_id = v_actor,
          activation_requested_at = now(),
          activation_requested_mode = p_target_mode,
          updated_at = now()
      where provider_key = 'paymob'
      returning * into v_provider;
    elsif p_confirmation = v_approve_confirmation then
      if v_provider.activation_requested_by_subject_id is null
         or v_provider.activation_requested_by_subject_id = v_actor
         or v_provider.activation_requested_mode <> p_target_mode
         or v_provider.activation_requested_at < now() - interval '24 hours' then
        raise exception 'paymob_activation_checker_required';
      end if;
      v_missing := private_app.paymob_missing_checks(
        v_provider.readiness_evidence,p_target_mode
      );
      if cardinality(v_missing) <> 0
         or v_provider.environment <> p_target_mode
         or v_provider.credentials_environment <> p_target_mode
         or v_provider.checkout_mode <> 'redirect'
         or v_provider.supported_currencies <> array['SAR']::text[]
         or not private_app.v3_payment_provider_bundle_complete(
           v_provider.provider_key,v_provider.environment,
           v_provider.credentials_environment,v_provider.required_secret_keys,
           v_provider.required_public_config_keys,v_provider.public_config
         ) then
        raise exception 'paymob_activation_evidence_incomplete';
      end if;
      update marketplace.payment_provider_configs
      set status = case when p_target_mode = 'live' then 'active' else 'configured' end,
          rollout_mode = p_target_mode,last_verified_at = now(),
          last_error_code = null,activated_by_subject_id = v_actor,
          activated_at = now(),activation_requested_by_subject_id = null,
          activation_requested_at = null,activation_requested_mode = null,
          sandbox_canary_version_id = case when p_target_mode = 'sandbox' then (
            select version.id
            from marketplace.paymob_credential_versions version
            where version.provider_key = 'paymob'
              and version.environment = 'sandbox'
              and version.status = 'active'
            limit 1
          ) else sandbox_canary_version_id end,
          sandbox_canary_started_at = case when p_target_mode = 'sandbox'
            then now() else sandbox_canary_started_at end,
          updated_at = now()
      where provider_key = 'paymob'
      returning * into v_provider;
    else
      raise exception 'paymob_activation_confirmation_invalid';
    end if;
  end if;

  insert into audit_log.events(
    actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_actor,'marketplace.paymob.activation_gate_action','payment_provider','paymob',
    jsonb_build_object(
      'targetMode',p_target_mode,'status',v_provider.status,
      'rolloutMode',v_provider.rollout_mode,
      'twoPersonApproved',v_provider.activated_by_subject_id = v_actor,
      'secretReturned',false
    )
  );
  return jsonb_build_object(
    'schemaVersion',1,'providerKey','paymob','status',v_provider.status,
    'rolloutMode',v_provider.rollout_mode,
    'pendingApproval',v_provider.activation_requested_by_subject_id is not null,
    'active',v_provider.status = 'active' and v_provider.rollout_mode = 'live'
  );
end;
$$;

revoke all on function public.v1_platform_paymob_activation_gate(text,text)
from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_paymob_activation_gate(text,text)
to authenticated;

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
as $$
declare
  v_actor uuid;
  v_tenant core.tenants%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_rollout marketplace.payment_tenant_rollouts%rowtype;
  v_request text;
  v_approve text;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  select tenant.* into v_tenant from core.tenants tenant
  where tenant.id = p_tenant_id for share;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.slug = 'reef-skills' or v_tenant.tenant_key = 'tenant-reef-skills' then
    raise exception 'paymob_reef_skills_rollout_prohibited';
  end if;
  if p_environment not in ('sandbox','live') then
    raise exception 'paymob_environment_invalid';
  end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob' for share;
  if p_enabled and (
    v_provider.environment <> p_environment
    or v_provider.rollout_mode <> p_environment
    or v_provider.last_verified_at is null
    or (p_environment = 'sandbox' and v_provider.status <> 'configured')
    or (p_environment = 'live' and v_provider.status <> 'active')
  ) then raise exception 'paymob_global_rollout_not_ready'; end if;

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
    v_request := 'REQUEST PAYMOB TENANT ' || p_tenant_id::text || ' ' || upper(p_environment);
    v_approve := 'APPROVE PAYMOB TENANT ' || p_tenant_id::text || ' ' || upper(p_environment);
    if p_confirmation = v_request then
      insert into marketplace.payment_tenant_rollouts(
        tenant_id,environment,status,approval_code,
        requested_by_subject_id,requested_at
      ) values (
        p_tenant_id,p_environment,'disabled','awaiting_checker',v_actor,now()
      ) on conflict (tenant_id,provider_key,environment) do update
      set status = 'disabled',approval_code = 'awaiting_checker',
          requested_by_subject_id = v_actor,requested_at = now(),
          approved_by_subject_id = null,approved_at = null,updated_at = now()
      returning * into v_rollout;
    elsif p_confirmation = v_approve then
      if v_rollout.id is null
         or v_rollout.requested_by_subject_id is null
         or v_rollout.requested_by_subject_id = v_actor
         or v_rollout.requested_at < now() - interval '24 hours' then
        raise exception 'paymob_rollout_checker_required';
      end if;
      update marketplace.payment_tenant_rollouts
      set status = 'enabled',approval_code = 'two_person_approved',
          approved_by_subject_id = v_actor,approved_at = now(),updated_at = now()
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
      'environment',p_environment,'status',v_rollout.status,
      'twoPersonApproved',v_rollout.approved_by_subject_id is not null
    )
  );
  return jsonb_build_object(
    'schemaVersion',1,'tenantId',p_tenant_id,'environment',p_environment,
    'status',v_rollout.status,
    'pendingApproval',v_rollout.requested_by_subject_id is not null
      and v_rollout.approved_by_subject_id is null
  );
end;
$$;

revoke all on function public.v1_platform_paymob_tenant_rollout_action(
  uuid,text,boolean,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_paymob_tenant_rollout_action(
  uuid,text,boolean,text
) to authenticated;

create or replace function public.v1_service_paymob_cleanup_checkout_secrets(
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt marketplace.payment_attempts%rowtype;
  v_secret_id uuid;
  v_scanned integer := 0;
  v_deleted integer := 0;
  v_failed integer := 0;
  v_expired_queued integer := 0;
  v_attempt_ids text := '';
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'paymob_cleanup_limit_invalid';
  end if;
  for v_attempt in
    select attempt.*
    from marketplace.payment_attempts attempt
    where attempt.provider_key = 'paymob'
      and attempt.checkout_secret_id is not null
      and (
        attempt.checkout_secret_expires_at <= now()
        or attempt.status in ('paid','failed','refunded','cancelled')
      )
    order by attempt.checkout_secret_expires_at,attempt.id
    limit p_limit
    for update skip locked
  loop
    v_scanned := v_scanned + 1;
    v_attempt_ids := v_attempt_ids || v_attempt.id::text || ',';
    v_secret_id := v_attempt.checkout_secret_id;
    begin
      if exists (
        select 1
        from marketplace.payment_provider_secret_refs secret_ref
        where secret_ref.vault_secret_id = v_secret_id
      ) or exists (
        select 1
        from marketplace.paymob_credential_versions version
        where v_secret_id = any(array[
          version.hmac_vault_secret_id,version.api_key_vault_secret_id,
          version.secret_key_vault_secret_id,version.public_key_vault_secret_id,
          version.billing_digest_vault_secret_id
        ])
      ) then
        raise exception 'paymob_cleanup_provider_secret_rejected';
      end if;
      update marketplace.payment_attempts
      set checkout_secret_id = null,
          checkout_secret_expires_at = null,
          updated_at = now()
      where id = v_attempt.id
        and checkout_secret_id = v_secret_id;
      delete from vault.secrets secret
      where secret.id = v_secret_id;
      v_deleted := v_deleted + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  -- Checkout expiry reconciliation is seeded by the reconciliation claimer,
  -- which locks job then attempt in the same canonical order as the applicator.

  insert into audit_log.events(action,resource_type,resource_id,context)
  values (
    'marketplace.paymob.checkout_secret_cleanup','payment_attempt_batch',
    encode(extensions.digest(convert_to(v_attempt_ids,'utf8'),'sha256'),'hex'),
    jsonb_build_object(
      'scanned',v_scanned,'deleted',v_deleted,'failed',v_failed,
      'expiredQueued',v_expired_queued,'secretReturned',false
    )
  );
  return jsonb_build_object(
    'schemaVersion',1,'scanned',v_scanned,'deleted',v_deleted,
    'failed',v_failed,'expiredQueued',v_expired_queued
  );
end;
$$;

revoke all on function public.v1_service_paymob_cleanup_checkout_secrets(integer)
from public, anon, authenticated, service_role;
grant execute on function public.v1_service_paymob_cleanup_checkout_secrets(integer)
to service_role;

create or replace function public.v1_platform_paymob_emergency_revoke_credential(
  p_credential_version_id uuid,
  p_reason_code text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_reason text := nullif(btrim(p_reason_code),'');
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  if v_reason is null or v_reason !~ '^[a-z][a-z0-9_]{1,80}$'
     or p_confirmation <> 'EMERGENCY REVOKE PAYMOB ' || p_credential_version_id::text then
    raise exception 'paymob_emergency_revoke_confirmation_invalid';
  end if;
  -- Keep credential mutation ordering aligned with checkout record/config
  -- rotation: provider row first, credential version second.
  perform 1
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for update;
  if not found then raise exception 'payment_provider_not_found'; end if;
  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.id = p_credential_version_id
  for update;
  if v_version.id is null then raise exception 'paymob_credential_version_not_found'; end if;
  if v_version.status <> 'revoked' then
    update marketplace.paymob_credential_versions
    set status = 'revoked',revoked_by_subject_id = v_actor,
        revoked_at = now(),revocation_reason_code = v_reason,
        valid_until = coalesce(valid_until,now()),updated_at = now()
    where id = v_version.id
    returning * into v_version;
  else
    v_reason := v_version.revocation_reason_code;
  end if;
  update marketplace.payment_provider_configs
  set status = case when status = 'disabled' then 'disabled' else 'draft' end,
      rollout_mode = 'observe_only',last_verified_at = null,
      last_error_code = 'credentials_invalid',activated_by_subject_id = null,
      activated_at = null,activation_requested_by_subject_id = null,
      activation_requested_at = null,activation_requested_mode = null,
      readiness_evidence = '{}'::jsonb,readiness_updated_at = now(),updated_at = now()
  where provider_key = 'paymob';
  update marketplace.reconciliations reconciliation
  set status = 'review_required',error_code = 'credential_emergency_revoked',
      lease_token = null,lease_owner = null,lease_expires_at = null,updated_at = now()
  from marketplace.payment_attempts attempt
  where reconciliation.attempt_id = attempt.id
    and attempt.credential_version_id = v_version.id
    and reconciliation.status in ('queued','running','unknown','failed');
  insert into audit_log.events(
    actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_actor,'marketplace.paymob.credential_emergency_revoked',
    'paymob_credential_version',v_version.id::text,
    jsonb_build_object(
      'environment',v_version.environment,'reasonCode',v_reason,
      'checkoutDisabled',true,'reconciliationMovedToReview',true,
      'vaultSecretDeleted',false,'secretReturned',false
    )
  );
  return jsonb_build_object(
    'schemaVersion',1,'credentialVersionId',v_version.id,
    'status',v_version.status,'checkoutDisabled',true,
    'reconciliationRequiresIncidentReview',true
  );
end;
$$;

revoke all on function public.v1_platform_paymob_emergency_revoke_credential(
  uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_paymob_emergency_revoke_credential(
  uuid,text,text
) to authenticated;

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
      and version.integration_id = v_provider.public_config ->> 'integrationId'
      and version.owner_id = v_provider.public_config ->> 'merchantAccountId'
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

revoke all on function public.v1_platform_paymob_readiness_snapshot()
from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_paymob_readiness_snapshot()
to authenticated;

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
        'configuredPublicConfig',coalesce((
          select jsonb_object_agg(required.config_key,provider.public_config -> required.config_key)
          from unnest(provider.required_public_config_keys) required(config_key)
          where jsonb_typeof(provider.public_config -> required.config_key) = 'string'
        ),'{}'::jsonb),
        'configured',private_app.v3_payment_provider_bundle_complete(
          provider.provider_key,provider.environment,provider.credentials_environment,
          provider.required_secret_keys,provider.required_public_config_keys,
          provider.public_config
        ) and (
          provider.provider_key <> 'paymob' or exists (
            select 1 from marketplace.paymob_credential_versions version
            where version.provider_key = 'paymob' and version.status = 'active'
              and version.environment = provider.environment
              and version.integration_id = provider.public_config ->> 'integrationId'
              and version.owner_id = provider.public_config ->> 'merchantAccountId'
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

revoke all on function public.v3_platform_payment_provider_admin_snapshot()
from public, anon, authenticated, service_role;
grant execute on function public.v3_platform_payment_provider_admin_snapshot()
to authenticated;

-------------------------------------------------------------------------------
-- 10. Canonical storefront discovery/action rollout enforcement
-------------------------------------------------------------------------------

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
        -- Merchant/integration identifiers are server-side bindings, not
        -- storefront configuration.
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

revoke all on function public.v2_tenant_marketplace_snapshot(text)
from public, anon, authenticated, service_role;
grant execute on function public.v2_tenant_marketplace_snapshot(text)
to authenticated;

-- Preserve the hardened V1 catalogue validator, then add the same Paymob
-- rollout and provider-idempotency rules for compatibility callers. The
-- preserved function already enforces marketplace visibility and fixed-price
-- add-on eligibility; the wrapper only supplies the payment binding.
alter function public.v1_tenant_marketplace_action(text,text,jsonb)
  rename to v1_tenant_marketplace_action_paymob_legacy_v1;
alter function public.v1_tenant_marketplace_action_paymob_legacy_v1(
  text,text,jsonb
) set schema private_app;
revoke all on function private_app.v1_tenant_marketplace_action_paymob_legacy_v1(
  text,text,jsonb
) from public, anon, authenticated, service_role;

create or replace function public.v1_tenant_marketplace_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_order marketplace.orders%rowtype;
  v_result jsonb;
  v_order_id uuid;
begin
  if p_action = 'create_order'
     and lower(pg_catalog.btrim(coalesce(p_payload ->> 'itemType','')))
       = 'service' then
    return public.v2_tenant_service_marketplace_action(
      p_slug,'create_service_order',coalesce(p_payload,'{}'::jsonb) - 'itemType'
    );
  end if;
  if p_action <> 'create_order'
     or lower(pg_catalog.btrim(coalesce(
       p_payload ->> 'paymentProvider','bank_transfer'
     ))) <> 'paymob' then
    return private_app.v1_tenant_marketplace_action_paymob_legacy_v1(
      p_slug,p_action,p_payload
    );
  end if;

  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob';
  if v_provider.provider_key is null
     or not private_app.paymob_tenant_checkout_eligible_v1(
       v_tenant.id,v_provider.environment
     ) then
    raise exception 'paymob_tenant_rollout_required';
  end if;

  v_result := private_app.v1_tenant_marketplace_action_paymob_legacy_v1(
    p_slug,p_action,coalesce(p_payload,'{}'::jsonb) - 'paymentProvider'
  );
  begin
    v_order_id := coalesce(
      nullif(v_result ->> 'id',''),nullif(v_result ->> 'orderId','')
    )::uuid;
  exception when others then
    raise exception 'marketplace_order_result_invalid';
  end;
  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_id::text,0
  ));
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_order_id and orders.tenant_id = v_tenant.id
  for update;
  if v_order.id is null
     or v_order.order_kind <> 'addon'
     or v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed') then
    raise exception 'marketplace_order_not_payable';
  end if;
  if coalesce((v_result ->> 'duplicate')::boolean,false) then
    if v_order.payment_provider is distinct from 'paymob' then
      raise exception 'marketplace_idempotency_payment_provider_conflict';
    end if;
  else
    if v_order.payment_provider not in ('paymob')
       and v_order.payment_provider is not null then
      raise exception 'marketplace_payment_provider_conflict';
    end if;
    if exists (
      select 1 from marketplace.bank_transfer_submissions submission
      where submission.order_id = v_order.id
        and submission.status in ('pending','reviewing','approved')
    ) then
      raise exception 'marketplace_payment_provider_conflict';
    end if;
    update marketplace.orders
    set payment_provider = 'paymob',updated_at = now()
    where id = v_order.id;
  end if;
  return (v_result - 'paymentProvider' - 'paymentInstructions')
    || jsonb_build_object(
      'paymentProvider','paymob','paymentInstructions','{}'::jsonb
    );
end;
$$;

revoke all on function public.v1_tenant_marketplace_action(text,text,jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.v1_tenant_marketplace_action(text,text,jsonb)
to authenticated;

-- Capture the direct service mutation gateway so crafted RPC calls cannot
-- bypass the same tenant/environment rollout gate used by discovery.
alter function public.v2_tenant_service_marketplace_action(text,text,jsonb)
  rename to v2_tenant_service_marketplace_action_paymob_legacy_v1;
alter function public.v2_tenant_service_marketplace_action_paymob_legacy_v1(
  text,text,jsonb
) set schema private_app;
revoke all on function private_app.v2_tenant_service_marketplace_action_paymob_legacy_v1(
  text,text,jsonb
) from public, anon, authenticated, service_role;

create or replace function public.v2_tenant_service_marketplace_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_product marketplace.service_products%rowtype;
  v_package marketplace.service_packages%rowtype;
  v_order marketplace.orders%rowtype;
  v_result jsonb;
  v_idempotency_key text;
  v_quantity integer;
  v_amount bigint;
  v_subtotal bigint;
  v_tax bigint;
  v_brief jsonb;
begin
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  if p_action = 'create_service_order'
     and lower(btrim(coalesce(p_payload ->> 'paymentProvider','bank_transfer')))
       = 'paymob' then
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob';
    if v_provider.provider_key is null
       or not private_app.paymob_tenant_checkout_eligible_v1(
         v_tenant.id,v_provider.environment
       ) then
      raise exception 'paymob_tenant_rollout_required';
    end if;
    -- Create a Paymob-bound service order directly. Calling the legacy gateway
    -- with bank_transfer and rewriting its result would make Paymob depend on
    -- another provider's activation state and could rewrite an idempotent bank
    -- transfer order after evidence had already been submitted.
    v_idempotency_key := left(nullif(
      pg_catalog.btrim(p_payload ->> 'idempotencyKey'),''
    ),120);
    if v_idempotency_key is null then
      raise exception 'marketplace_idempotency_required';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      v_tenant.id::text || ':service:idempotency:' || v_idempotency_key,0
    ));
    select orders.* into v_order
    from marketplace.orders orders
    where orders.tenant_id = v_tenant.id
      and orders.idempotency_key = v_idempotency_key
    for update;
    if v_order.id is not null then
      if v_order.order_kind <> 'service'
         or v_order.payment_provider is distinct from 'paymob' then
        raise exception 'marketplace_idempotency_payment_provider_conflict';
      end if;
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object(
          'duplicate',true,'paymentProvider','paymob',
          'paymentInstructions','{}'::jsonb
        );
    end if;

    begin
      v_quantity := coalesce((p_payload ->> 'quantity')::integer,1);
    exception when others then
      raise exception 'marketplace_quantity_invalid';
    end;
    if v_quantity not between 1 and 100 then
      raise exception 'marketplace_quantity_invalid';
    end if;
    select product.* into v_product
    from marketplace.service_products product
    join marketplace.service_categories category
      on category.id = product.category_id and category.status = 'active'
    where product.product_key = lower(nullif(
        pg_catalog.btrim(p_payload ->> 'productKey'),''
      ))
      and product.marketplace_visible
      and product.status in ('beta','active')
      and (
        product.provider_id is null
        or exists (
          select 1 from marketplace.service_providers service_provider
          where service_provider.id = product.provider_id
            and service_provider.status = 'active'
        )
      );
    if v_product.id is null then
      raise exception 'marketplace_product_not_found';
    end if;
    begin
      v_package.id := nullif(p_payload ->> 'packageId','')::uuid;
    exception when others then
      raise exception 'service_package_invalid';
    end;
    if v_package.id is not null then
      select package.* into v_package
      from marketplace.service_packages package
      where package.id = v_package.id
        and package.service_product_id = v_product.id
        and package.status = 'active'
      for share;
      if v_package.id is null then raise exception 'service_package_not_found'; end if;
      v_amount := v_package.amount_minor;
    else
      if v_product.pricing_mode = 'quote' or v_product.amount_minor <= 0 then
        raise exception 'service_quote_required';
      end if;
      v_amount := v_product.amount_minor;
    end if;
    if coalesce(v_package.currency,v_product.currency) <> 'SAR' then
      raise exception 'marketplace_currency_unsupported';
    end if;
    v_brief := coalesce(p_payload -> 'brief','{}'::jsonb);
    if jsonb_typeof(v_brief) <> 'object'
       or pg_catalog.octet_length(v_brief::text) > 20000 then
      raise exception 'service_brief_invalid';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      v_tenant.id::text || ':service:product:' || v_product.product_key,0
    ));
    select orders.* into v_order
    from marketplace.orders orders
    join marketplace.order_items item on item.order_id = orders.id
    where orders.tenant_id = v_tenant.id
      and orders.status = 'pending_payment'
      and orders.payment_status = 'pending'
      and item.item_type = 'service'
      and item.product_key = v_product.product_key
    order by orders.created_at desc
    limit 1
    for update of orders;
    if v_order.id is not null then
      if v_order.payment_provider is distinct from 'paymob' then
        raise exception 'marketplace_payment_provider_conflict';
      end if;
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object(
          'duplicate',true,'duplicateReason','pending_product_order',
          'paymentProvider','paymob','paymentInstructions','{}'::jsonb
        );
    end if;

    v_subtotal := v_amount * v_quantity;
    v_tax := round(v_subtotal * 0.15)::bigint;
    insert into marketplace.orders(
      tenant_id,requested_by_subject_id,order_kind,status,payment_status,
      activation_state,currency,subtotal_minor,tax_minor,total_minor,tax_rate_bps,
      payment_provider,notes,idempotency_key
    ) values (
      v_tenant.id,v_actor,'service','pending_payment','pending','not_applicable',
      'SAR',v_subtotal,v_tax,v_subtotal + v_tax,1500,'paymob',
      left(nullif(pg_catalog.btrim(p_payload ->> 'notes'),''),1000),
      v_idempotency_key
    ) returning * into v_order;
    insert into marketplace.order_items(
      order_id,item_type,service_product_id,service_package_id,product_key,
      product_name_ar,quantity,unit_amount_minor,line_total_minor,metadata
    ) values (
      v_order.id,'service',v_product.id,v_package.id,v_product.product_key,
      v_product.name_ar,v_quantity,v_amount,v_subtotal,
      jsonb_strip_nulls(jsonb_build_object(
        'pricingMode',case when v_package.id is null
          then 'catalog_price' else 'service_package' end,
        'providerId',v_product.provider_id,'packageId',v_package.id,
        'packageName',v_package.name_ar,
        'packageDescription',v_package.description_ar,
        'packageIncludedItems',v_package.included_items_ar,
        'packageRevisionsIncluded',v_package.revisions_included,
        'packageTurnaroundDays',v_package.turnaround_days,
        'courseId',v_product.course_id
      ))
    );
    insert into marketplace.service_order_briefs(
      order_id,tenant_id,provider_id,package_id,preferred_start_date,
      delivery_mode,brief
    ) values (
      v_order.id,v_tenant.id,v_product.provider_id,v_package.id,
      nullif(p_payload ->> 'preferredStartDate','')::date,
      nullif(p_payload ->> 'deliveryMode',''),v_brief
    );
    if v_product.provider_id is not null then
      insert into marketplace.service_order_assignments(
        order_id,tenant_id,provider_id,package_id,status
      ) values (
        v_order.id,v_tenant.id,v_product.provider_id,v_package.id,'pending'
      );
    end if;
    insert into marketplace.order_events(
      order_id,tenant_id,actor_subject_id,event_type,to_status,metadata
    ) values (
      v_order.id,v_tenant.id,v_actor,'service_order_created','pending_payment',
      jsonb_build_object(
        'productKey',v_product.product_key,'providerId',v_product.provider_id,
        'packageId',v_package.id,'paymentProvider','paymob'
      )
    );
    insert into audit_log.events(
      tenant_id,actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_tenant.id,v_actor,'marketplace.service_order.created',
      'marketplace_order',v_order.id::text,
      jsonb_build_object(
        'orderNumber',v_order.order_number,'totalMinor',v_order.total_minor,
        'providerId',v_product.provider_id,'packageId',v_package.id,
        'paymentProvider','paymob'
      )
    );
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object(
        'duplicate',false,'providerId',v_product.provider_id,
        'packageId',v_package.id,'paymentProvider','paymob',
        'paymentInstructions','{}'::jsonb
      );
  end if;
  return private_app.v2_tenant_service_marketplace_action_paymob_legacy_v1(
    p_slug,p_action,p_payload
  );
end;
$$;

revoke all on function public.v2_tenant_service_marketplace_action(
  text,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.v2_tenant_service_marketplace_action(
  text,text,jsonb
) to authenticated;

create or replace function public.v2_tenant_marketplace_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_result jsonb;
  v_order_id uuid;
begin
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  if p_action = 'create_order'
     and lower(btrim(coalesce(p_payload ->> 'itemType',''))) = 'service' then
    return public.v2_tenant_service_marketplace_action(
      p_slug,'create_service_order',coalesce(p_payload,'{}'::jsonb) - 'itemType'
    );
  end if;

  if p_action = 'create_order'
     and lower(btrim(coalesce(p_payload ->> 'paymentProvider','bank_transfer')))
       = 'paymob' then
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob';
    if v_provider.provider_key is null
       or not private_app.paymob_tenant_checkout_eligible_v1(
         v_tenant.id,v_provider.environment
       ) then
      raise exception 'paymob_tenant_rollout_required';
    end if;
    v_result := public.v1_tenant_marketplace_action(
      p_slug,p_action,coalesce(p_payload,'{}'::jsonb)
    );
    return v_result;
  end if;
  return private_app.v2_tenant_marketplace_action_service_legacy(
    p_slug,p_action,p_payload
  );
end;
$$;

revoke all on function public.v2_tenant_marketplace_action(text,text,jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.v2_tenant_marketplace_action(text,text,jsonb)
to authenticated;

commit;
