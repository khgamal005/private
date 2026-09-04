begin;

-- ODEIR governance policy v1
-- One authorized operator may complete a governed action in one step.
-- Role permissions, explicit confirmations, evidence gates, money bindings,
-- tenant isolation, audit logging and fail-closed runtime checks remain intact.

do $preflight$
begin
  if to_regclass('marketplace.payment_tenant_rollouts') is null
     or to_regclass('marketplace.paymob_operational_evidence_requests') is null
     or to_regclass('marketplace.refunds') is null
     or to_regclass('marketplace.reconciliations') is null
     or to_regprocedure(
       'public.v1_platform_paymob_activation_gate(text,text)'
     ) is null
     or to_regprocedure(
       'public.v1_platform_paymob_tenant_rollout_action(uuid,text,boolean,text)'
     ) is null
     or to_regprocedure(
       'public.v1_platform_paymob_operational_evidence_action(text,text,uuid,text)'
     ) is null
     or to_regprocedure(
       'private_app.paymob_live_canary_eligible_v1(uuid,text)'
     ) is null
     or to_regprocedure(
       'private_app.paymob_readiness_evidence_write(text,text,boolean,text,text,text,uuid)'
     ) is null then
    raise exception 'single_operator_policy_prerequisite_missing';
  end if;
end
$preflight$;

-- Cancel stale waiting-for-another-person records. Nothing is auto-approved by
-- this cleanup; the authorized operator must run the canonical one-step action.
update marketplace.payment_provider_configs
set activation_requested_by_subject_id = null,
    activation_requested_at = null,
    activation_requested_mode = null,
    updated_at = now()
where provider_key = 'paymob'
  and activation_requested_by_subject_id is not null;

update marketplace.payment_tenant_rollouts
set status = 'disabled',
    approval_code = 'single_operator_action_required',
    requested_by_subject_id = null,
    requested_at = null,
    approved_by_subject_id = null,
    approved_at = null,
    updated_at = now()
where status = 'disabled'
  and requested_by_subject_id is not null
  and approved_by_subject_id is null
  and approval_code in (
    'awaiting_checker','awaiting_live_canary_checker'
  );

update marketplace.paymob_operational_evidence_requests
set status = 'expired',updated_at = now()
where status = 'pending';

-- Remove only actor-separation requirements. Metadata integrity remains.
alter table marketplace.payment_tenant_rollouts
  drop constraint if exists payment_tenant_rollouts_check1;

alter table marketplace.paymob_operational_evidence_requests
  drop constraint if exists paymob_operational_evidence_requests_check;

alter table marketplace.refunds
  drop constraint if exists refunds_check;

alter table marketplace.reconciliations
  drop constraint if exists reconciliations_check1;

alter table marketplace.refunds
  drop constraint if exists refunds_single_operator_approval_integrity_v1;
alter table marketplace.refunds
  add constraint refunds_single_operator_approval_integrity_v1
  check (
    approved_by_subject_id is null
    or (
      requested_by_subject_id is not null
      and approved_at is not null
    )
  ) not valid;
alter table marketplace.refunds
  validate constraint refunds_single_operator_approval_integrity_v1;

alter table marketplace.reconciliations
  drop constraint if exists reconciliations_single_operator_resolution_integrity_v1;
alter table marketplace.reconciliations
  add constraint reconciliations_single_operator_resolution_integrity_v1
  check (
    absence_resolution_approved_by_subject_id is null
    or (
      absence_resolution_requested_by_subject_id is not null
      and absence_resolution_approved_at is not null
      and absence_resolution_evidence_sha256 is not null
    )
  ) not valid;
alter table marketplace.reconciliations
  validate constraint reconciliations_single_operator_resolution_integrity_v1;

-- The evidence writer still validates the exact approved ledger row, digest,
-- credential version, environment and expiry; it no longer requires a second
-- human identity to differ from the authorized operator who attested it.
do $patch_evidence_writer$
declare
  v_definition text;
  v_pattern text :=
    'and[[:space:]]+request[.]approved_by_subject_id[[:space:]]+<>[[:space:]]+request[.]requested_by_subject_id';
  v_matches integer;
begin
  select pg_get_functiondef(
    'private_app.paymob_readiness_evidence_write(text,text,boolean,text,text,text,uuid)'::regprocedure
  ) into v_definition;
  v_matches := regexp_count(v_definition,v_pattern,1,'i');
  if v_matches = 1 then
    v_definition := regexp_replace(v_definition,v_pattern,'','gi');
    execute v_definition;
  elsif v_matches <> 0 then
    raise exception 'single_operator_evidence_writer_ambiguous_%',v_matches;
  end if;
  select pg_get_functiondef(
    'private_app.paymob_readiness_evidence_write(text,text,boolean,text,text,text,uuid)'::regprocedure
  ) into v_definition;
  if v_definition ~* v_pattern
     or v_definition not ilike '%operational_attestation%'
     or v_definition not ilike '%request.status = ''approved''%'
     or v_definition not ilike '%request.expires_at > now()%'
     or v_definition not ilike '%request.evidence_sha256 = p_evidence_sha256%' then
    raise exception 'single_operator_evidence_writer_postcondition_failed';
  end if;
end
$patch_evidence_writer$;

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

create or replace function public.v1_platform_paymob_activation_gate(
  p_target_mode text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_missing text[];
  v_canonical_confirmation text;
  v_legacy_request_confirmation text;
  v_legacy_approve_confirmation text;
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
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;

  if p_target_mode = 'observe_only' then
    if p_confirmation <> 'DISABLE PAYMOB CHECKOUT' then
      raise exception 'paymob_activation_confirmation_invalid';
    end if;
    update marketplace.payment_provider_configs
    set status = case when status = 'disabled' then 'disabled' else 'configured' end,
        rollout_mode = 'observe_only',
        last_verified_at = null,
        activated_by_subject_id = null,
        activated_at = null,
        activation_requested_by_subject_id = null,
        activation_requested_at = null,
        activation_requested_mode = null,
        updated_at = now()
    where provider_key = 'paymob'
    returning * into v_provider;
  else
    v_canonical_confirmation :=
      'ACTIVATE PAYMOB ' || upper(p_target_mode);
    v_legacy_request_confirmation :=
      'REQUEST PAYMOB ' || upper(p_target_mode);
    v_legacy_approve_confirmation :=
      'APPROVE PAYMOB ' || upper(p_target_mode);
    if p_confirmation is distinct from v_canonical_confirmation
       and p_confirmation is distinct from v_legacy_request_confirmation
       and p_confirmation is distinct from v_legacy_approve_confirmation then
      raise exception 'paymob_activation_confirmation_invalid';
    end if;

    v_missing := private_app.paymob_missing_checks(
      v_provider.readiness_evidence,p_target_mode
    );
    if cardinality(v_missing) <> 0
       or v_provider.environment <> p_target_mode
       or v_provider.credentials_environment <> p_target_mode
       or v_provider.checkout_mode <> 'redirect'
       or v_provider.supported_currencies <> array['SAR']::text[]
       or v_provider.public_config ->> 'region' <> 'ksa'
       or v_provider.public_config ->> 'integrationPath' <> 'quicklink'
       or not private_app.v3_payment_provider_bundle_complete(
         v_provider.provider_key,
         v_provider.environment,
         v_provider.credentials_environment,
         v_provider.required_secret_keys,
         v_provider.required_public_config_keys,
         v_provider.public_config
       ) then
      raise exception 'paymob_activation_evidence_incomplete';
    end if;

    update marketplace.payment_provider_configs
    set status = case when p_target_mode = 'live' then 'active' else 'configured' end,
        rollout_mode = p_target_mode,
        last_verified_at = now(),
        last_error_code = null,
        activated_by_subject_id = v_actor,
        activated_at = now(),
        activation_requested_by_subject_id = null,
        activation_requested_at = null,
        activation_requested_mode = null,
        sandbox_canary_version_id = case when p_target_mode = 'sandbox' then (
          select version.id
          from marketplace.paymob_credential_versions version
          where version.provider_key = 'paymob'
            and version.environment = 'sandbox'
            and version.status = 'active'
          order by version.created_at desc,version.id desc
          limit 1
        ) else sandbox_canary_version_id end,
        sandbox_canary_started_at = case when p_target_mode = 'sandbox'
          then now() else sandbox_canary_started_at end,
        updated_at = now()
    where provider_key = 'paymob'
    returning * into v_provider;
  end if;

  insert into audit_log.events(
    actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_actor,
    'marketplace.paymob.activation_gate_action',
    'payment_provider',
    'paymob',
    jsonb_build_object(
      'targetMode',p_target_mode,
      'status',v_provider.status,
      'rolloutMode',v_provider.rollout_mode,
      'approvalPolicy','single_authorized_operator',
      'authorizedOperatorId',v_actor,
      'explicitConfirmation',true,
      'secretReturned',false
    )
  );

  return jsonb_build_object(
    'schemaVersion',1,
    'providerKey','paymob',
    'status',v_provider.status,
    'rolloutMode',v_provider.rollout_mode,
    'pendingApproval',false,
    'active',v_provider.status = 'active'
      and v_provider.rollout_mode = 'live'
  );
end
$function$;

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
  v_canonical text;
  v_legacy_request text;
  v_legacy_approve text;
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

  if coalesce(p_enabled,false) and not (
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
      tenant_id,provider_key,environment,status,approval_code
    ) values (
      p_tenant_id,'paymob',p_environment,'disabled','platform_disabled'
    )
    on conflict (tenant_id,provider_key,environment) do update
    set status = 'disabled',
        approval_code = 'platform_disabled',
        requested_by_subject_id = null,
        requested_at = null,
        approved_by_subject_id = null,
        approved_at = null,
        updated_at = now()
    returning * into v_rollout;
  else
    v_canonical := 'ENABLE PAYMOB TENANT ' || p_tenant_id::text
      || ' ' || upper(p_environment);
    v_legacy_request := 'REQUEST PAYMOB TENANT ' || p_tenant_id::text
      || ' ' || upper(p_environment);
    v_legacy_approve := 'APPROVE PAYMOB TENANT ' || p_tenant_id::text
      || ' ' || upper(p_environment);
    if p_confirmation is distinct from v_canonical
       and p_confirmation is distinct from v_legacy_request
       and p_confirmation is distinct from v_legacy_approve then
      raise exception 'paymob_rollout_confirmation_invalid';
    end if;

    if v_live_validation and exists (
      select 1
      from marketplace.payment_tenant_rollouts other_rollout
      where other_rollout.provider_key = 'paymob'
        and other_rollout.environment = 'live'
        and other_rollout.status = 'enabled'
        and other_rollout.tenant_id <> p_tenant_id
    ) then
      raise exception 'paymob_live_canary_single_tenant_required';
    end if;

    insert into marketplace.payment_tenant_rollouts(
      tenant_id,provider_key,environment,status,approval_code,
      requested_by_subject_id,requested_at,
      approved_by_subject_id,approved_at
    ) values (
      p_tenant_id,'paymob',p_environment,'enabled',
      case when v_live_validation
        then 'live_canary_approved'
        else 'single_operator_approved' end,
      v_actor,now(),v_actor,now()
    )
    on conflict (tenant_id,provider_key,environment) do update
    set status = 'enabled',
        approval_code = excluded.approval_code,
        requested_by_subject_id = v_actor,
        requested_at = now(),
        approved_by_subject_id = v_actor,
        approved_at = now(),
        updated_at = now()
    returning * into v_rollout;
  end if;

  insert into audit_log.events(
    actor_subject_id,tenant_id,action,resource_type,resource_id,context
  ) values (
    v_actor,
    p_tenant_id,
    'marketplace.paymob.tenant_rollout_action',
    'payment_tenant_rollout',
    v_rollout.id::text,
    jsonb_build_object(
      'environment',p_environment,
      'status',v_rollout.status,
      'approvalCode',v_rollout.approval_code,
      'approvalPolicy','single_authorized_operator',
      'authorizedOperatorId',v_actor,
      'explicitConfirmation',true,
      'liveValidationCanary',v_rollout.approval_code =
        'live_canary_approved',
      'reefSkillsExcluded',true
    )
  );

  return jsonb_build_object(
    'schemaVersion',1,
    'tenantId',p_tenant_id,
    'environment',p_environment,
    'status',v_rollout.status,
    'pendingApproval',false
  );
end
$function$;

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
as $function$
declare
  v_actor uuid;
  v_version marketplace.paymob_credential_versions%rowtype;
  v_request marketplace.paymob_operational_evidence_requests%rowtype;
  v_canonical text;
  v_legacy_request text;
  v_legacy_approve text;
  v_expires_at timestamptz;
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
    and provider.public_config ->> 'integrationPath' = 'quicklink'
    and provider.checkout_mode = 'redirect'
    and provider.supported_currencies = array['SAR']::text[]
  for share of version;
  if v_version.id is null then
    raise exception 'paymob_live_credential_version_required';
  end if;

  v_canonical := 'ATTEST PAYMOB EVIDENCE ' || p_check_key;
  v_legacy_request := 'REQUEST PAYMOB EVIDENCE ' || p_check_key;
  v_legacy_approve := case when p_request_id is null then null
    else 'APPROVE PAYMOB EVIDENCE ' || p_request_id::text end;
  if p_confirmation is distinct from v_canonical
     and p_confirmation is distinct from v_legacy_request
     and p_confirmation is distinct from v_legacy_approve then
    raise exception 'paymob_operational_evidence_confirmation_invalid';
  end if;

  update marketplace.paymob_operational_evidence_requests
  set status = 'expired',updated_at = now()
  where credential_version_id = v_version.id
    and check_key = p_check_key
    and status in ('pending','approved')
    and expires_at <= now();

  v_expires_at := now() + case
    when p_check_key = 'live_credentials' then interval '24 hours'
    else interval '30 days'
  end;

  if p_request_id is not null then
    select request.* into v_request
    from marketplace.paymob_operational_evidence_requests request
    where request.id = p_request_id
      and request.credential_version_id = v_version.id
      and request.environment = 'live'
      and request.check_key = p_check_key
      and request.evidence_sha256 = p_evidence_sha256
    for update;
    if v_request.id is null then
      raise exception 'paymob_operational_evidence_request_not_found';
    end if;
    update marketplace.paymob_operational_evidence_requests
    set status = 'approved',
        requested_by_subject_id = coalesce(
          requested_by_subject_id,v_actor
        ),
        requested_at = coalesce(requested_at,now()),
        approved_by_subject_id = v_actor,
        approved_at = now(),
        expires_at = v_expires_at,
        updated_at = now()
    where id = v_request.id
    returning * into v_request;
  else
    insert into marketplace.paymob_operational_evidence_requests(
      credential_version_id,environment,check_key,evidence_sha256,status,
      requested_by_subject_id,requested_at,
      approved_by_subject_id,approved_at,expires_at
    ) values (
      v_version.id,'live',p_check_key,p_evidence_sha256,'approved',
      v_actor,now(),v_actor,now(),v_expires_at
    )
    on conflict (credential_version_id,check_key,evidence_sha256) do update
    set status = 'approved',
        requested_by_subject_id = v_actor,
        requested_at = now(),
        approved_by_subject_id = v_actor,
        approved_at = now(),
        expires_at = excluded.expires_at,
        updated_at = now()
    returning * into v_request;
  end if;

  perform private_app.paymob_readiness_evidence_write(
    'live',p_check_key,true,p_evidence_sha256,null,
    'operational_attestation',v_request.id
  );

  insert into audit_log.events(
    actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_actor,
    'marketplace.paymob.operational_evidence_action',
    'paymob_operational_evidence',
    v_request.id::text,
    jsonb_build_object(
      'checkKey',p_check_key,
      'environment','live',
      'status',v_request.status,
      'credentialVersionId',v_version.id,
      'approvalPolicy','single_authorized_operator',
      'authorizedOperatorId',v_actor,
      'explicitConfirmation',true,
      'artifactSha256',p_evidence_sha256,
      'secretStored',false,
      'piiStored',false
    )
  );

  return jsonb_build_object(
    'schemaVersion',1,
    'requestId',v_request.id,
    'checkKey',p_check_key,
    'environment','live',
    'status','approved',
    'pendingApproval',false,
    'expiresAt',v_request.expires_at
  );
end
$function$;

comment on function public.v1_platform_paymob_activation_gate(text,text)
is 'Single authorized operator: evidence-gated Paymob activation with explicit confirmation and audit; no second human approver.';
comment on function public.v1_platform_paymob_tenant_rollout_action(uuid,text,boolean,text)
is 'Single authorized operator: tenant Paymob enable/disable with explicit confirmation, isolation and audit.';
comment on function public.v1_platform_paymob_operational_evidence_action(text,text,uuid,text)
is 'Single authorized operator: digest-only operational evidence attestation with immutable audit.';

revoke all on function public.v1_platform_paymob_activation_gate(text,text)
  from public,anon;
grant execute on function public.v1_platform_paymob_activation_gate(text,text)
  to authenticated;
revoke all on function public.v1_platform_paymob_tenant_rollout_action(uuid,text,boolean,text)
  from public,anon;
grant execute on function public.v1_platform_paymob_tenant_rollout_action(uuid,text,boolean,text)
  to authenticated;
revoke all on function public.v1_platform_paymob_operational_evidence_action(text,text,uuid,text)
  from public,anon;
grant execute on function public.v1_platform_paymob_operational_evidence_action(text,text,uuid,text)
  to authenticated;

do $postflight$
declare
  v_definition text;
begin
  if exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid in (
      'marketplace.payment_tenant_rollouts'::regclass,
      'marketplace.paymob_operational_evidence_requests'::regclass,
      'marketplace.refunds'::regclass,
      'marketplace.reconciliations'::regclass
    )
      and pg_get_constraintdef(constraint_row.oid) ~*
        '(approved_by_subject_id|absence_resolution_approved_by_subject_id)[[:space:]]*(<>|!=|is distinct from)[[:space:]]*(requested_by_subject_id|absence_resolution_requested_by_subject_id)'
  ) then
    raise exception 'single_operator_actor_difference_constraint_remaining';
  end if;

  select string_agg(pg_get_functiondef(procedure_row.oid),E'\n')
  into v_definition
  from pg_proc procedure_row
  join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
  where procedure_row.prokind = 'f'
    and namespace_row.nspname in ('public','private_app')
    and procedure_row.proname in (
      'v1_platform_paymob_activation_gate',
      'v1_platform_paymob_tenant_rollout_action',
      'v1_platform_paymob_operational_evidence_action',
      'paymob_live_canary_eligible_v1',
      'paymob_readiness_evidence_write'
    );
  if v_definition ~* 'checker_required|awaiting_checker|two_person_approved'
     or v_definition ~*
       '(approved_by_subject_id|activation_requested_by_subject_id)[[:space:]]*(<>|!=|is distinct from)[[:space:]]*(requested_by_subject_id|activated_by_subject_id)' then
    raise exception 'single_operator_runtime_dual_control_remaining';
  end if;

  if exists (
    select 1
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'paymob'
      and provider.activation_requested_by_subject_id is not null
  )
  or exists (
    select 1
    from marketplace.payment_tenant_rollouts rollout
    where rollout.status = 'disabled'
      and rollout.requested_by_subject_id is not null
      and rollout.approved_by_subject_id is null
      and rollout.approval_code in (
        'awaiting_checker','awaiting_live_canary_checker'
      )
  )
  or exists (
    select 1
    from marketplace.paymob_operational_evidence_requests request
    where request.status = 'pending'
  ) then
    raise exception 'single_operator_stale_pending_approval_remaining';
  end if;
end
$postflight$;

commit;
