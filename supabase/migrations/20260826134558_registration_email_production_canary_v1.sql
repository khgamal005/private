begin;

-- Production guard: fail quickly instead of waiting behind an unexpected
-- concurrent registration writer while the two additive partial indexes are
-- installed.  The migration stays fully transactional on timeout.
set local lock_timeout='5s';

-- A production canary proves the Odeir-owned sender and signed Resend webhook
-- without creating a registration request or touching a tenant.  Recipient
-- addresses are never persisted; only a salted hash is retained.
create table if not exists platform.registration_email_canaries (
  id uuid primary key default extensions.gen_random_uuid(),
  recipient_hash text not null check (recipient_hash ~ '^[a-f0-9]{64}$'),
  configuration_fingerprint text not null check (
    configuration_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  idempotency_key text not null unique check (
    idempotency_key ~ '^[a-z0-9/_-]{1,200}$'
  ),
  provider text not null default 'resend' check (provider='resend'),
  provider_message_id text check (
    provider_message_id is null
    or provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
  ),
  state text not null default 'requested' check (state in (
    'requested','accepted','sent','delayed','delivered','failed','bounced',
    'suppressed','complained'
  )),
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_event_at timestamptz,
  last_http_status integer check (
    last_http_status is null or last_http_status between 100 and 599
  ),
  last_error_code text check (
    last_error_code is null
    or last_error_code ~ '^[a-z0-9][a-z0-9_]{0,79}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_registration_email_canary_message_idx
on platform.registration_email_canaries(provider,provider_message_id)
where provider_message_id is not null;

create index if not exists platform_registration_email_canary_created_idx
on platform.registration_email_canaries(created_at desc);

create index if not exists platform_registration_email_canary_recipient_idx
on platform.registration_email_canaries(recipient_hash,created_at desc);

create index if not exists platform_registration_email_canary_config_idx
on platform.registration_email_canaries(
  configuration_fingerprint,created_at desc,id desc
);

alter table platform.registration_email_canaries enable row level security;
revoke all on table platform.registration_email_canaries
from public,anon,authenticated,service_role;

-- A short-lived, single-use grant closes the database-side bypass: the
-- authenticated policy RPC cannot enable automatic activation merely because
-- an older canary once succeeded.  Only the Edge service can attest that the
-- currently loaded configuration matches the latest delivered canary.
create table if not exists platform.registration_email_activation_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  canary_id uuid not null
    references platform.registration_email_canaries(id) on delete restrict,
  configuration_fingerprint text not null check (
    configuration_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expected_policy_version bigint not null check (expected_policy_version>=1),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  used_payload_hash text check (
    used_payload_hash is null or used_payload_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null default now(),
  check (expires_at>created_at),
  check (used_at is null or used_at>=created_at)
);

create index if not exists platform_registration_email_grant_expiry_idx
on platform.registration_email_activation_grants(expires_at)
where used_at is null;

create index if not exists platform_registration_email_grant_canary_idx
on platform.registration_email_activation_grants(canary_id);

create index if not exists platform_registration_email_grant_subject_idx
on platform.registration_email_activation_grants(used_by_subject_id)
where used_by_subject_id is not null;

alter table platform.registration_email_activation_grants enable row level security;
revoke all on table platform.registration_email_activation_grants
from public,anon,authenticated,service_role;

alter table platform.registration_settings
  add column if not exists policy_version bigint not null default 1
    check (policy_version>=1);

create index if not exists platform_registration_email_runtime_key_idx
on platform.registration_email_deliveries(key_version,token_expires_at)
where state in ('queued','leased','retryable');

-- Hot-path readiness excludes historical delivery metrics.  Its only
-- delivery lookup is bounded to the active queue by the partial index above.
create or replace function public.v1_registration_email_runtime_readiness()
returns jsonb
language plpgsql
security definer
set search_path=''
stable
as $$
declare
  v_heartbeat platform.registration_email_worker_heartbeat%rowtype;
  v_config platform.registration_email_worker_config%rowtype;
  v_active_key_version smallint;
  v_pending_key_versions jsonb;
  v_legacy_unrecoverable boolean;
begin
  select heartbeat.* into v_heartbeat
  from platform.registration_email_worker_heartbeat heartbeat
  where heartbeat.singleton;
  select config.* into v_config
  from platform.registration_email_worker_config config
  where config.singleton;
  select setting.email_token_key_version into v_active_key_version
  from platform.registration_settings setting
  where setting.singleton;
  select coalesce(
    jsonb_agg(distinct delivery.key_version order by delivery.key_version),
    '[]'::jsonb
  ) into v_pending_key_versions
  from platform.registration_email_deliveries delivery
  where delivery.key_version>=1
    and delivery.state in ('queued','leased','retryable')
    and delivery.token_expires_at>now();
  select exists(
    select 1 from platform.registration_email_deliveries delivery
    where delivery.key_version=0
      and delivery.state in ('queued','leased','retryable')
    limit 1
  ) into v_legacy_unrecoverable;
  return jsonb_build_object(
    'outboxReady',v_config.singleton is true
      and v_config.cron_job_id is not null
      and not coalesce(v_legacy_unrecoverable,false),
    'legacyUnrecoverable',case
      when coalesce(v_legacy_unrecoverable,false) then 1 else 0 end,
    'activeKeyVersion',v_active_key_version,
    'pendingKeyVersions',v_pending_key_versions,
    'workerHeartbeatAt',v_heartbeat.last_heartbeat_at,
    'workerHealthy',v_heartbeat.last_heartbeat_at is not null
      and v_heartbeat.last_heartbeat_at>now()-interval '5 minutes'
  );
end;
$$;

create or replace function public.v1_platform_registration_policy_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  return (
    select jsonb_build_object(
      'activationMode',setting.activation_mode,
      'emailConfirmationTtlMinutes',setting.email_confirmation_ttl_minutes,
      'trialPlanKey',setting.trial_plan_key,
      'policyVersion',setting.policy_version,
      'updatedAt',setting.updated_at,
      'updatedBy',subject.full_name
    )
    from platform.registration_settings setting
    left join access_control.subjects subject
      on subject.id=setting.updated_by_subject_id
    where setting.singleton
  );
end;
$$;

create or replace function private_app.registration_email_canary_apply_webhooks(
  p_canary_id uuid
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_canary platform.registration_email_canaries%rowtype;
  v_delivered_at timestamptz;
  v_bounced_at timestamptz;
  v_suppressed_at timestamptz;
  v_complained_at timestamptz;
  v_failed_at timestamptz;
  v_sent_at timestamptz;
  v_delayed_at timestamptz;
  v_state text;
  v_last_event_at timestamptz;
begin
  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.id=p_canary_id
  for update;
  if v_canary.id is null or v_canary.provider_message_id is null then
    return;
  end if;

  select
    min(event.occurred_at) filter (where event.event_type='delivered'),
    min(event.occurred_at) filter (where event.event_type='bounced'),
    min(event.occurred_at) filter (where event.event_type='suppressed'),
    min(event.occurred_at) filter (where event.event_type='complained'),
    min(event.occurred_at) filter (where event.event_type='failed'),
    min(event.occurred_at) filter (where event.event_type='sent'),
    min(event.occurred_at) filter (where event.event_type='delivery_delayed'),
    max(event.occurred_at)
  into v_delivered_at,v_bounced_at,v_suppressed_at,v_complained_at,
       v_failed_at,v_sent_at,v_delayed_at,v_last_event_at
  from platform.registration_email_webhook_events event
  where event.provider=v_canary.provider
    and event.provider_message_id=v_canary.provider_message_id;

  v_state:=case
    when v_complained_at is not null then 'complained'
    when v_suppressed_at is not null then 'suppressed'
    when v_bounced_at is not null then 'bounced'
    when v_delivered_at is not null then 'delivered'
    when v_failed_at is not null then 'failed'
    when v_delayed_at is not null then 'delayed'
    when v_sent_at is not null then 'sent'
    else v_canary.state
  end;

  update platform.registration_email_canaries canary
  set state=v_state,
      delivered_at=case when v_delivered_at is null then canary.delivered_at
        when canary.delivered_at is null then v_delivered_at
        else least(canary.delivered_at,v_delivered_at) end,
      failed_at=case
        when v_state in ('failed','bounced','suppressed','complained')
          then coalesce(canary.failed_at,v_last_event_at,now())
        else canary.failed_at end,
      last_event_at=coalesce(v_last_event_at,canary.last_event_at),
      updated_at=now()
  where canary.id=v_canary.id;
end;
$$;

revoke all on function private_app.registration_email_canary_apply_webhooks(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v1_registration_email_canary_start(
  p_recipient_hash text,
  p_configuration_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid:=extensions.gen_random_uuid();
  v_key text;
begin
  if p_recipient_hash is null
     or p_recipient_hash !~ '^[a-f0-9]{64}$'
     or p_configuration_fingerprint is null
     or p_configuration_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_email_canary_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  if (
    select count(*) from platform.registration_email_canaries canary
    where canary.created_at>now()-interval '1 hour'
  )>=10 or (
    select count(*) from platform.registration_email_canaries canary
    where canary.recipient_hash=p_recipient_hash
      and canary.created_at>now()-interval '1 hour'
  )>=3 then
    raise exception 'registration_email_canary_rate_limited';
  end if;
  v_key:='odeir-registration-canary/'||v_id::text;
  insert into platform.registration_email_canaries(
    id,recipient_hash,configuration_fingerprint,idempotency_key,state
  ) values (
    v_id,p_recipient_hash,p_configuration_fingerprint,v_key,'requested'
  );
  return jsonb_build_object('canaryId',v_id,'idempotencyKey',v_key);
end;
$$;

create or replace function public.v1_registration_email_canary_finish(
  p_canary_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_http_status integer,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_canary platform.registration_email_canaries%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  if p_outcome is null
     or p_outcome not in ('accepted','failed')
     or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_outcome='accepted' and (
       p_http_status not between 200 and 299
       or p_provider_message_id is null
       or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
     ))
     or (p_outcome='failed' and (
       p_error_code is null
       or p_error_code !~ '^[a-z0-9][a-z0-9_]{0,79}$'
     )) then
    raise exception 'registration_email_canary_invalid';
  end if;

  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.id=p_canary_id
  for update;
  if v_canary.id is null then
    raise exception 'registration_email_canary_invalid';
  end if;
  if v_canary.state<>'requested' then
    if p_outcome='accepted'
       and v_canary.provider_message_id=p_provider_message_id then
      return jsonb_build_object(
        'canaryId',v_canary.id,'state',v_canary.state,
        'providerMessageId',v_canary.provider_message_id,'replayed',true
      );
    end if;
    raise exception 'registration_email_canary_conflict';
  end if;

  if p_outcome='accepted' then
    update platform.registration_email_canaries canary
    set state='accepted',
        provider_message_id=p_provider_message_id,
        accepted_at=now(),
        last_http_status=p_http_status,
        last_error_code=null,
        updated_at=now()
    where canary.id=v_canary.id
    returning * into v_canary;
    perform private_app.registration_email_canary_apply_webhooks(v_canary.id);
  else
    update platform.registration_email_canaries canary
    set state='failed',
        failed_at=now(),
        last_http_status=p_http_status,
        last_error_code=p_error_code,
        updated_at=now()
    where canary.id=v_canary.id
    returning * into v_canary;
  end if;

  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.id=p_canary_id;
  return jsonb_build_object(
    'canaryId',v_canary.id,'state',v_canary.state,
    'providerMessageId',v_canary.provider_message_id,'replayed',false
  );
end;
$$;

create or replace function public.v1_registration_email_canary_record_event(
  p_provider_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_canary platform.registration_email_canaries%rowtype;
begin
  if p_provider_message_id is null
     or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$' then
    raise exception 'registration_email_canary_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.provider='resend'
    and canary.provider_message_id=p_provider_message_id
  for update;
  if v_canary.id is null then
    return jsonb_build_object('matched',false,'state','unmatched');
  end if;
  perform private_app.registration_email_canary_apply_webhooks(v_canary.id);
  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.id=v_canary.id;
  return jsonb_build_object(
    'matched',true,'canaryId',v_canary.id,'state',v_canary.state
  );
end;
$$;

create or replace function public.v1_registration_email_canary_health(
  p_configuration_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path=''
stable
as $$
declare
  v_canary platform.registration_email_canaries%rowtype;
begin
  if p_configuration_fingerprint is null
     or p_configuration_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_email_canary_invalid';
  end if;
  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.configuration_fingerprint=p_configuration_fingerprint
  order by canary.created_at desc,canary.id desc
  limit 1;
  if v_canary.id is null then
    return jsonb_build_object(
      'canaryReady',false,'canaryState','not_run',
      'canaryDeliveredAt',null,'canaryExpiresAt',null
    );
  end if;
  return jsonb_build_object(
    'canaryReady',v_canary.state='delivered'
      and v_canary.delivered_at>now()-interval '30 days'
      and v_canary.configuration_fingerprint=p_configuration_fingerprint,
    'canaryState',v_canary.state,
    'canaryConfigurationMatches',
      v_canary.configuration_fingerprint=p_configuration_fingerprint,
    'canaryDeliveredAt',v_canary.delivered_at,
    'canaryExpiresAt',case when v_canary.delivered_at is null then null
      else v_canary.delivered_at+interval '30 days' end
  );
end;
$$;

create or replace function public.v1_registration_email_activation_grant_issue(
  p_configuration_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_canary platform.registration_email_canaries%rowtype;
  v_policy_version bigint;
  v_grant text;
begin
  if p_configuration_fingerprint is null
     or p_configuration_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_email_activation_not_ready';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.configuration_fingerprint=p_configuration_fingerprint
  order by canary.created_at desc,canary.id desc
  limit 1
  for update;
  if v_canary.id is null
     or v_canary.state<>'delivered'
     or v_canary.delivered_at<=now()-interval '30 days'
     or v_canary.configuration_fingerprint<>p_configuration_fingerprint then
    raise exception 'registration_email_activation_not_ready';
  end if;
  select setting.policy_version into v_policy_version
  from platform.registration_settings setting
  where setting.singleton
  for share;

  delete from platform.registration_email_activation_grants activation_grant
  where activation_grant.expires_at<now()-interval '1 day';
  v_grant:=encode(extensions.gen_random_bytes(32),'hex');
  insert into platform.registration_email_activation_grants(
    canary_id,configuration_fingerprint,token_hash,
    expected_policy_version,expires_at
  ) values (
    v_canary.id,p_configuration_fingerprint,
    encode(extensions.digest(v_grant,'sha256'),'hex'),
    v_policy_version,
    now()+interval '90 seconds'
  );
  return jsonb_build_object(
    'activationGrant',v_grant,
    'expiresAt',now()+interval '90 seconds'
  );
end;
$$;

-- The legacy three-argument RPC remains available for the instant kill switch
-- but can no longer enable automatic activation directly.
create or replace function public.v1_platform_registration_policy_save(
  p_activation_mode text,
  p_email_confirmation_ttl_minutes integer,
  p_trial_plan_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_ttl integer:=coalesce(p_email_confirmation_ttl_minutes,60);
  v_plan_key text:=lower(trim(coalesce(p_trial_plan_key,'free')));
  v_subject uuid;
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  if trim(coalesce(p_activation_mode,''))<>'manual_review' then
    raise exception 'registration_email_activation_grant_required';
  end if;
  if v_ttl not between 15 and 1440 then
    raise exception 'registration_confirmation_ttl_invalid';
  end if;
  if not exists(
    select 1 from catalog.plans plan
    where plan.plan_key=v_plan_key and plan.status='active'
  ) then raise exception 'plan_not_found'; end if;
  v_subject:=private_app.current_subject_id();
  update platform.registration_settings
  set activation_mode='manual_review',
      email_confirmation_ttl_minutes=v_ttl,
      trial_plan_key=v_plan_key,
      updated_by_subject_id=v_subject,
      policy_version=policy_version+1,
      updated_at=now()
  where singleton;
  perform private_app.write_audit(
    'platform.registration_policy.saved','registration_policy','default',null,
    jsonb_build_object(
      'activationMode','manual_review',
      'emailConfirmationTtlMinutes',v_ttl,
      'trialPlanKey',v_plan_key
    )
  );
  return public.v1_platform_registration_policy_snapshot();
end;
$$;

create or replace function public.v1_platform_registration_policy_save_email(
  p_email_confirmation_ttl_minutes integer,
  p_trial_plan_key text,
  p_activation_grant text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_ttl integer:=coalesce(p_email_confirmation_ttl_minutes,60);
  v_plan_key text:=lower(trim(coalesce(p_trial_plan_key,'free')));
  v_subject uuid;
  v_grant platform.registration_email_activation_grants%rowtype;
  v_canary platform.registration_email_canaries%rowtype;
  v_setting platform.registration_settings%rowtype;
  v_policy_version bigint;
  v_payload_hash text;
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  if p_activation_grant is null
     or p_activation_grant !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_email_activation_grant_required';
  end if;
  if v_ttl not between 15 and 1440 then
    raise exception 'registration_confirmation_ttl_invalid';
  end if;
  if not exists(
    select 1 from catalog.plans plan
    where plan.plan_key=v_plan_key and plan.status='active'
  ) then raise exception 'plan_not_found'; end if;

  v_subject:=private_app.current_subject_id();
  v_payload_hash:=encode(extensions.digest(
    'email_verified_trial:'||v_ttl::text||':'||v_plan_key,'sha256'
  ),'hex');

  select activation_grant.* into v_grant
  from platform.registration_email_activation_grants activation_grant
  where activation_grant.token_hash=encode(
      extensions.digest(p_activation_grant,'sha256'),'hex'
    )
  for update;
  if v_grant.id is null then
    raise exception 'registration_email_activation_grant_invalid';
  end if;
  if v_grant.used_at is not null then
    select setting.* into v_setting
    from platform.registration_settings setting
    where setting.singleton;
    if v_grant.used_by_subject_id=v_subject
       and v_grant.used_payload_hash=v_payload_hash
       and v_setting.activation_mode='email_verified_trial'
       and v_setting.email_confirmation_ttl_minutes=v_ttl
       and v_setting.trial_plan_key=v_plan_key
       and v_setting.policy_version=v_grant.expected_policy_version+1
       and v_setting.updated_by_subject_id=v_subject then
      return public.v1_platform_registration_policy_snapshot();
    end if;
    raise exception 'registration_email_activation_grant_stale';
  end if;
  if v_grant.expires_at<=now() then
    raise exception 'registration_email_activation_grant_invalid';
  end if;
  select canary.* into v_canary
  from platform.registration_email_canaries canary
  where canary.configuration_fingerprint=v_grant.configuration_fingerprint
  order by canary.created_at desc,canary.id desc
  limit 1
  for share;
  if v_canary.id is null
     or v_canary.id<>v_grant.canary_id
     or v_canary.state<>'delivered'
     or v_canary.delivered_at<=now()-interval '30 days' then
    raise exception 'registration_email_activation_not_ready';
  end if;

  select setting.policy_version into v_policy_version
  from platform.registration_settings setting
  where setting.singleton
  for update;
  if v_policy_version<>v_grant.expected_policy_version then
    raise exception 'registration_email_activation_grant_stale';
  end if;

  update platform.registration_email_activation_grants activation_grant
  set used_at=now(),
      used_by_subject_id=v_subject,
      used_payload_hash=v_payload_hash
  where activation_grant.id=v_grant.id
    and activation_grant.used_at is null;
  if not found then
    raise exception 'registration_email_activation_grant_invalid';
  end if;

  update platform.registration_settings
  set activation_mode='email_verified_trial',
      email_confirmation_ttl_minutes=v_ttl,
      trial_plan_key=v_plan_key,
      updated_by_subject_id=v_subject,
      policy_version=policy_version+1,
      updated_at=now()
  where singleton;
  perform private_app.write_audit(
    'platform.registration_policy.saved','registration_policy','default',null,
    jsonb_build_object(
      'activationMode','email_verified_trial',
      'emailConfirmationTtlMinutes',v_ttl,
      'trialPlanKey',v_plan_key,
      'emailCanaryId',v_canary.id,
      'emailConfigurationFingerprint',v_grant.configuration_fingerprint
    )
  );
  return public.v1_platform_registration_policy_snapshot();
end;
$$;

-- Called on every anonymous submit.  If any live transport, telemetry, worker,
-- key, attestation, or current-canary check degrades, the global policy is
-- atomically moved to manual review before the request is created.
create or replace function public.v1_registration_email_runtime_guard(
  p_configuration_fingerprint text,
  p_live_ready boolean
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_setting platform.registration_settings%rowtype;
  v_canary platform.registration_email_canaries%rowtype;
  v_ready boolean:=false;
begin
  if p_configuration_fingerprint is null
     or p_configuration_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_email_runtime_guard_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('odeir-registration-email-canary',0)
  );
  select setting.* into v_setting
  from platform.registration_settings setting
  where setting.singleton
  ;
  if v_setting.activation_mode<>'email_verified_trial' then
    return jsonb_build_object(
      'activationMode',v_setting.activation_mode,'activationReady',false
    );
  end if;

  if p_live_ready is true then
    select canary.* into v_canary
    from platform.registration_email_canaries canary
    where canary.configuration_fingerprint=p_configuration_fingerprint
    order by canary.created_at desc,canary.id desc
    limit 1;
    v_ready:=v_canary.id is not null
      and v_canary.state='delivered'
      and v_canary.delivered_at>now()-interval '30 days';
  end if;
  if v_ready then
    return jsonb_build_object(
      'activationMode','email_verified_trial','activationReady',true
    );
  end if;

  update platform.registration_settings
  set activation_mode='manual_review',
      updated_by_subject_id=null,
      policy_version=policy_version+1,
      updated_at=now()
  where singleton and activation_mode='email_verified_trial';
  if found then
    perform private_app.write_audit(
      'platform.registration_policy.fail_closed',
      'registration_policy','default',null,
      jsonb_build_object(
        'previousActivationMode','email_verified_trial',
        'activationMode','manual_review',
        'reason','registration_email_runtime_not_ready'
      )
    );
  end if;
  return jsonb_build_object(
    'activationMode','manual_review','activationReady',false,
    'failClosed',true
  );
end;
$$;

-- One transactional ingress call eliminates the guard/insert race and one
-- Edge-to-PostgREST round trip.  The existing v2 implementation remains the
-- single source of validation and outbox creation semantics.
create or replace function public.v3_public_submit_registration_request(
  p_payload jsonb,
  p_ip_hash text,
  p_user_agent_hash text,
  p_configuration_fingerprint text,
  p_email_activation_ready boolean
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_guard jsonb;
begin
  v_guard:=public.v1_registration_email_runtime_guard(
    p_configuration_fingerprint,p_email_activation_ready
  );
  if coalesce((v_guard->>'failClosed')::boolean,false) then
    -- Commit the emergency policy transition before touching request identity
    -- locks. Edge retries the same validated payload through v2, which now
    -- observes manual_review and cannot provision automatically.
    return jsonb_build_object('_retryManual',true);
  end if;
  return public.v2_public_submit_registration_request(
    p_payload,p_ip_hash,p_user_agent_hash
  );
end;
$$;

-- Resolve terminal or expired confirmation generations into the normal manual
-- review queue.  This never provisions a tenant and is idempotent.
create or replace function public.v1_registration_email_delivery_fail_safe(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
begin
  select request.* into v_request
  from platform.registration_requests request
  where request.id=(
    select delivery.request_id
    from platform.registration_email_deliveries delivery
    where delivery.id=p_delivery_id
  )
  for update;
  if v_request.id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id and delivery.request_id=v_request.id
  for update;
  if v_delivery.id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  if v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review'
     or v_request.email_confirmed_at is not null
     or v_request.provisioned_tenant_id is not null then
    return jsonb_build_object('handled',false,'state',v_delivery.state);
  end if;
  if v_delivery.state='terminal_failed' then
    perform private_app.registration_email_fallback_to_manual(
      v_request.id,'delivery_terminal_failed',null,
      'Email delivery failed terminally and was moved to manual review.'
    );
    return jsonb_build_object('handled',true,'reason','terminal_failed');
  end if;
  if v_delivery.token_expires_at<=now()
     and v_delivery.state in ('queued','leased','retryable','accepted') then
    update platform.registration_email_deliveries delivery
    set state='terminal_failed',
        failed_at=coalesce(delivery.failed_at,now()),
        last_error_code='confirmation_expired',
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id;
    perform private_app.registration_email_fallback_to_manual(
      v_request.id,'delivery_terminal_failed',null,
      'Email confirmation expired and was moved to manual review.'
    );
    return jsonb_build_object('handled',true,'reason','confirmation_expired');
  end if;
  return jsonb_build_object('handled',false,'state',v_delivery.state);
end;
$$;

-- Include accepted-but-unconfirmed generations once their token expires so
-- the worker can execute the fail-safe transition.
create or replace function public.v1_registration_email_delivery_due_ids(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_limit integer:=coalesce(p_limit,25);
  v_ids jsonb;
begin
  if v_limit not between 1 and 100 then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  select coalesce(jsonb_agg(candidate.id order by candidate.created_at),
    '[]'::jsonb)
  into v_ids
  from (
    select delivery.id,delivery.created_at
    from platform.registration_email_deliveries delivery
    where delivery.key_version>=1
      and (
        delivery.state='queued'
        or (delivery.state='retryable' and delivery.retry_at<=now())
        or (delivery.state='leased' and delivery.lease_expires_at<=now())
        or (
          delivery.state in ('queued','leased','retryable')
          and delivery.token_expires_at<=now()
        )
      )
    union all
    select delivery.id,delivery.created_at
    from platform.registration_requests request
    join platform.registration_email_deliveries delivery
      on delivery.request_id=request.id
    where request.activation_mode='email_verified_trial'
      and request.institution_state='new'
      and request.external_account_id is null
      and request.status='pending_review'
      and request.email_confirmed_at is null
      and request.provisioned_tenant_id is null
      and delivery.key_version>=1
      and (
        delivery.state='terminal_failed'
        or (
          delivery.state='accepted'
          and delivery.token_expires_at<=now()
        )
      )
    order by created_at,id
    limit v_limit
  ) candidate;
  return v_ids;
end;
$$;

create index if not exists platform_registration_email_request_failsafe_idx
on platform.registration_requests(created_at,id)
where activation_mode='email_verified_trial'
  and institution_state='new'
  and external_account_id is null
  and status='pending_review'
  and email_confirmed_at is null
  and provisioned_tenant_id is null;

revoke all on function public.v1_registration_email_canary_start(text,text)
from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_canary_finish(
  uuid,text,text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_canary_record_event(text)
from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_canary_health(text)
from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_activation_grant_issue(text)
from public,anon,authenticated,service_role;
revoke all on function public.v1_platform_registration_policy_save_email(
  integer,text,text
) from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_runtime_guard(text,boolean)
from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_runtime_readiness()
from public,anon,authenticated,service_role;
revoke all on function public.v3_public_submit_registration_request(
  jsonb,text,text,text,boolean
) from public,anon,authenticated,service_role;
revoke all on function public.v1_platform_registration_policy_save(
  text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_delivery_fail_safe(uuid)
from public,anon,authenticated,service_role;
revoke all on function public.v1_registration_email_delivery_due_ids(integer)
from public,anon,authenticated,service_role;

grant execute on function public.v1_registration_email_canary_start(text,text)
to service_role;
grant execute on function public.v1_registration_email_canary_finish(
  uuid,text,text,integer,text
) to service_role;
grant execute on function public.v1_registration_email_canary_record_event(text)
to service_role;
grant execute on function public.v1_registration_email_canary_health(text)
to service_role;
grant execute on function public.v1_registration_email_activation_grant_issue(text)
to service_role;
grant execute on function public.v1_registration_email_runtime_guard(text,boolean)
to service_role;
grant execute on function public.v1_registration_email_runtime_readiness()
to service_role;
grant execute on function public.v3_public_submit_registration_request(
  jsonb,text,text,text,boolean
) to service_role;
grant execute on function public.v1_platform_registration_policy_save_email(
  integer,text,text
) to authenticated;
grant execute on function public.v1_platform_registration_policy_save(
  text,integer,text
) to authenticated;
grant execute on function public.v1_registration_email_delivery_fail_safe(uuid)
to service_role;
grant execute on function public.v1_registration_email_delivery_due_ids(integer)
to service_role;

comment on table platform.registration_email_canaries is
  'PII-minimized production proof for the isolated Odeir registration sender.';
comment on table platform.registration_email_activation_grants is
  'Hashed, expiring, single-use database gate for automatic email activation.';
comment on function public.v1_registration_email_canary_health(text) is
  'Service-only 30-day delivery proof used by the activation readiness gate.';
comment on function public.v1_registration_email_activation_grant_issue(text) is
  'Issues a short-lived activation grant only for the current delivered canary.';
comment on function public.v1_registration_email_runtime_guard(text,boolean) is
  'Fails the registration policy closed to manual review before public submit.';
comment on function public.v1_registration_email_runtime_readiness() is
  'O(active queue) readiness contract without historical delivery metrics.';
comment on function public.v3_public_submit_registration_request(
  jsonb,text,text,text,boolean
) is 'Atomic runtime email guard plus durable public registration submit.';
comment on function public.v1_registration_email_delivery_fail_safe(uuid) is
  'Moves expired or terminal email activation requests to manual review only.';

commit;
