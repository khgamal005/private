begin;

-- Registration confirmation is a durable outbox.  A delivery generation owns
-- a public nonce and a key version, never the bearer token itself.  The Edge
-- worker derives the 256-bit token with a versioned HMAC secret, binds only its
-- SHA-256 hash, and can therefore reconstruct the exact message after a crash
-- without storing a recipient, body, URL, or plaintext/encrypted token here.
alter table platform.registration_settings
  add column if not exists email_token_key_version smallint not null default 1
    check (email_token_key_version between 1 and 32767);

create table if not exists platform.registration_request_identity_reservations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null
    references platform.registration_requests(id) on delete restrict,
  identity_type text not null check (identity_type in (
    'external_account','commercial','national','institution_name'
  )),
  identity_hash text not null check (identity_hash ~ '^[a-f0-9]{64}$'),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  constraint registration_request_identity_reservation_key
    unique (request_id,identity_type,identity_hash)
);

create unique index if not exists
platform_registration_identity_reservation_active_idx
on platform.registration_request_identity_reservations(
  identity_type,identity_hash
)
where released_at is null;

create index if not exists
platform_registration_identity_reservation_request_idx
on platform.registration_request_identity_reservations(request_id,created_at);

create table if not exists platform.registration_email_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null
    references platform.registration_requests(id) on delete restrict,
  message_kind text not null default 'confirmation'
    check (message_kind in ('confirmation')),
  generation integer not null check (generation>0),
  key_version smallint not null check (key_version between 0 and 32767),
  token_nonce text not null check (token_nonce ~ '^[a-f0-9]{64}$'),
  confirmation_token_hash text
    check (
      confirmation_token_hash is null
      or confirmation_token_hash ~ '^[a-f0-9]{64}$'
    ),
  token_expires_at timestamptz not null,
  template_version text not null
    check (template_version ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  content_fingerprint text
    check (
      content_fingerprint is null
      or content_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  idempotency_key text not null unique
    check (idempotency_key ~ '^[a-z0-9/_-]{1,200}$'),
  provider text not null default 'resend' check (provider in ('resend')),
  provider_message_id text
    check (
      provider_message_id is null
      or provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
    ),
  state text not null default 'queued' check (state in (
    'queued','leased','retryable','accepted','terminal_failed','cancelled'
  )),
  attempt_count integer not null default 0 check (attempt_count>=0),
  retry_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  accepted_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  last_http_status integer
    check (last_http_status is null or last_http_status between 100 and 599),
  last_error_code text
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9][a-z0-9_]{0,79}$'
    ),
  provider_delivery_state text not null default 'unknown' check (
    provider_delivery_state in (
      'unknown','sent','delayed','delivered','bounced','suppressed',
      'failed','complained'
    )
  ),
  delivered_at timestamptz,
  bounced_at timestamptz,
  suppressed_at timestamptz,
  complained_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_email_delivery_generation_key
    unique (request_id,message_kind,generation),
  constraint registration_email_delivery_lease_check check (
    (state='leased' and lease_id is not null and lease_expires_at is not null)
    or
    (state<>'leased' and lease_id is null and lease_expires_at is null)
  ),
  constraint registration_email_delivery_accepted_check check (
    state<>'accepted'
    or (
      confirmation_token_hash is not null
      and content_fingerprint is not null
      and provider_message_id is not null
      and accepted_at is not null
      and last_http_status between 200 and 299
      and last_error_code is null
    )
  ),
  constraint registration_email_delivery_retryable_check check (
    state<>'retryable'
    or (retry_at is not null and last_error_code is not null)
  ),
  constraint registration_email_delivery_terminal_check check (
    state<>'terminal_failed'
    or (failed_at is not null and last_error_code is not null)
  ),
  constraint registration_email_delivery_cancelled_check check (
    state<>'cancelled' or cancelled_at is not null
  )
);

create unique index if not exists
platform_registration_email_provider_message_idx
on platform.registration_email_deliveries(provider,provider_message_id)
where provider_message_id is not null;

create unique index if not exists
platform_registration_email_token_hash_idx
on platform.registration_email_deliveries(confirmation_token_hash)
where confirmation_token_hash is not null;

create index if not exists platform_registration_email_due_idx
on platform.registration_email_deliveries(state,retry_at,lease_expires_at)
where state in ('queued','leased','retryable');

create index if not exists platform_registration_email_request_idx
on platform.registration_email_deliveries(request_id,generation desc);

create table if not exists platform.registration_confirmation_token_aliases (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null
    references platform.registration_requests(id) on delete restrict,
  delivery_id uuid
    references platform.registration_email_deliveries(id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint registration_confirmation_alias_delivery_key
    unique (delivery_id,token_hash)
);

create index if not exists platform_registration_confirmation_alias_request_idx
on platform.registration_confirmation_token_aliases(request_id,expires_at desc);

create table if not exists platform.registration_email_delivery_attempts (
  delivery_id uuid not null
    references platform.registration_email_deliveries(id) on delete restrict,
  attempt integer not null check (attempt>0),
  lease_id uuid not null unique,
  outcome text check (
    outcome is null
    or outcome in ('accepted','retryable','terminal_failed')
  ),
  provider_message_id text
    check (
      provider_message_id is null
      or provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
    ),
  http_status integer
    check (http_status is null or http_status between 100 and 599),
  error_code text
    check (
      error_code is null or error_code ~ '^[a-z0-9][a-z0-9_]{0,79}$'
    ),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (delivery_id,attempt)
);

create table if not exists platform.registration_email_webhook_events (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null default 'resend' check (provider in ('resend')),
  provider_event_id text not null,
  provider_message_id text not null
    check (provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'),
  event_type text not null check (event_type in (
    'sent','delivery_delayed','delivered','bounced','suppressed','failed',
    'complained'
  )),
  occurred_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  delivery_id uuid
    references platform.registration_email_deliveries(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint registration_email_webhook_provider_event_key
    unique (provider,provider_event_id)
);

create index if not exists platform_registration_email_webhook_message_idx
on platform.registration_email_webhook_events(provider,provider_message_id);

create table if not exists platform.registration_email_worker_heartbeat (
  singleton boolean primary key default true check (singleton),
  last_heartbeat_at timestamptz,
  last_processed integer not null default 0 check (last_processed>=0),
  last_failed integer not null default 0 check (last_failed>=0),
  total_runs bigint not null default 0 check (total_runs>=0),
  total_processed bigint not null default 0 check (total_processed>=0),
  total_failed bigint not null default 0 check (total_failed>=0),
  updated_at timestamptz not null default now()
);

create table if not exists platform.registration_email_worker_config (
  singleton boolean primary key default true check (singleton),
  function_url text not null check (
    function_url ~
      '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/odeir-registration-intake$'
  ),
  worker_token_hash text not null
    check (worker_token_hash ~ '^[a-f0-9]{64}$'),
  worker_token_vault_id uuid not null,
  publishable_key_vault_id uuid not null,
  cron_job_id bigint,
  configured_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into platform.registration_email_worker_heartbeat(singleton)
values (true) on conflict (singleton) do nothing;

alter table platform.registration_request_identity_reservations
  enable row level security;
alter table platform.registration_email_deliveries enable row level security;
alter table platform.registration_confirmation_token_aliases
  enable row level security;
alter table platform.registration_email_delivery_attempts
  enable row level security;
alter table platform.registration_email_webhook_events enable row level security;
alter table platform.registration_email_worker_heartbeat enable row level security;
alter table platform.registration_email_worker_config enable row level security;

revoke all on table platform.registration_request_identity_reservations
from public,anon,authenticated,service_role;
revoke all on table platform.registration_email_deliveries
from public,anon,authenticated,service_role;
revoke all on table platform.registration_confirmation_token_aliases
from public,anon,authenticated,service_role;
revoke all on table platform.registration_email_delivery_attempts
from public,anon,authenticated,service_role;
revoke all on table platform.registration_email_webhook_events
from public,anon,authenticated,service_role;
revoke all on table platform.registration_email_worker_heartbeat
from public,anon,authenticated,service_role;
revoke all on table platform.registration_email_worker_config
from public,anon,authenticated,service_role;

comment on table platform.registration_request_identity_reservations is
'Hashed institution-identity reservations. Contact email is deliberately not an institution dedupe key.';
comment on table platform.registration_email_deliveries is
'Private HMAC outbox metadata. No recipient, body, URL, raw token, ciphertext, or provider credential is stored.';
comment on table platform.registration_confirmation_token_aliases is
'Hashed, expiring confirmation-link aliases. Every issued generation remains valid until its own expiry or first request confirmation.';
comment on table platform.registration_email_webhook_events is
'Signature-verified provider event hashes only; raw webhook payload and recipient data are excluded.';

-- Preserve identity-aware replay across the rollout for open *new-institution*
-- requests created by v1. Existing-account IDs originate in an unauthenticated
-- public form and are not ownership evidence; they become exclusive only after
-- the server attestation is consumed into registration_external_account_claims.
-- DISTINCT ON deterministically gives the oldest non-rejected request the
-- active reservation if historical duplicates already exist.
insert into platform.registration_request_identity_reservations(
  request_id,identity_type,identity_hash
)
select candidate.request_id,candidate.identity_type,candidate.identity_hash
from (
  select distinct on (identity.identity_type,identity.identity_hash)
    request.id as request_id,
    identity.identity_type,
    identity.identity_hash
  from platform.registration_requests request
  cross join lateral (
    select
      translate(trim(coalesce(request.commercial_registration,'')),
        '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'
      ) as commercial,
      translate(trim(coalesce(request.national_registration,'')),
        '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'
      ) as national
  ) normalized
  cross join lateral (
    values
      ('commercial'::text,case
        when request.institution_state='new'
          and normalized.commercial ~ '^[0-9]{10}$'
          and normalized.commercial<>
            repeat(substr(normalized.commercial,1,1),10)
        then encode(extensions.digest(
          'commercial:'||normalized.commercial,'sha256'
        ),'hex') else null end),
      ('national'::text,case
        when request.institution_state='new'
          and normalized.national ~ '^7[0-9]{9}$'
          and normalized.national<>
            repeat(substr(normalized.national,1,1),10)
        then encode(extensions.digest(
          'national:'||normalized.national,'sha256'
        ),'hex') else null end)
  ) as identity(identity_type,identity_hash)
  where request.status<>'rejected' and identity.identity_hash is not null
  order by identity.identity_type,identity.identity_hash,request.created_at,request.id
) candidate
on conflict (identity_type,identity_hash) where released_at is null do nothing;

-- Removing this trigger is intentional.  Confirmation-token consumption must
-- never be blocked by an in-flight provider request, and old generations remain
-- safe through the alias table rather than by preventing rotation.
drop trigger if exists registration_email_rotation_guard
on platform.registration_requests;
drop function if exists private_app.registration_email_rotation_guard();

create or replace function private_app.registration_email_delivery_contract(
  p_delivery_id uuid,
  p_presented_lease_id uuid default null
)
returns jsonb
language sql
security definer
set search_path=''
stable
as $$
  select jsonb_build_object(
    'deliveryId',delivery.id,
    'requestId',delivery.request_id,
    'generation',delivery.generation,
    'keyVersion',delivery.key_version,
    'tokenNonce',delivery.token_nonce,
    'tokenExpiresEpoch',extract(epoch from delivery.token_expires_at)::bigint,
    'templateVersion',delivery.template_version,
    'idempotencyKey',delivery.idempotency_key,
    'attempt',delivery.attempt_count,
    'leaseId',case
      when p_presented_lease_id is not null
        and delivery.lease_id=p_presented_lease_id
      then delivery.lease_id else null end,
    'state',delivery.state,
    'sendRequired',delivery.state='leased'
      and p_presented_lease_id is not null
      and delivery.lease_id=p_presented_lease_id,
    'inFlight',delivery.state='leased'
      and (
        p_presented_lease_id is null
        or delivery.lease_id is distinct from p_presented_lease_id
      ),
    'accepted',delivery.state='accepted',
    'retryAt',delivery.retry_at,
    'tokenHash',delivery.confirmation_token_hash,
    'contentFingerprint',delivery.content_fingerprint,
    'recipient',request.contact_email,
    'contactName',request.contact_name,
    'institutionName',request.institution_name,
    'reference',request.request_reference
  )
  from platform.registration_email_deliveries delivery
  join platform.registration_requests request on request.id=delivery.request_id
  where delivery.id=p_delivery_id
$$;

revoke all on function private_app.registration_email_delivery_contract(uuid,uuid)
from public,anon,authenticated,service_role;

create or replace function private_app.registration_email_enqueue(
  p_request_id uuid,
  p_ttl_minutes integer,
  p_key_version smallint
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_generation integer;
  v_delivery_id uuid;
begin
  if p_ttl_minutes not between 15 and 1440
     or p_key_version not between 1 and 32767 then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select coalesce(max(delivery.generation),0)+1
  into v_generation
  from platform.registration_email_deliveries delivery
  where delivery.request_id=p_request_id
    and delivery.message_kind='confirmation';

  insert into platform.registration_email_deliveries(
    request_id,message_kind,generation,key_version,token_nonce,
    token_expires_at,template_version,idempotency_key,state,retry_at
  ) values (
    p_request_id,'confirmation',v_generation,p_key_version,
    encode(extensions.gen_random_bytes(32),'hex'),
    now()+make_interval(mins=>p_ttl_minutes),
    -- Fixed template version is part of the deterministic message contract.
    -- It must match the deployed renderer before the worker may send.
    'registration-confirmation-ar-v1',
    'odeir-registration-confirmation/'||p_request_id::text||'/'||v_generation,
    'queued',now()
  ) returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;

create or replace function private_app.registration_email_cancel_siblings(
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  update platform.registration_confirmation_token_aliases alias
  set consumed_at=coalesce(alias.consumed_at,now())
  where alias.request_id=p_request_id;

  update platform.registration_email_deliveries delivery
  set state='cancelled',
      cancelled_at=coalesce(delivery.cancelled_at,now()),
      lease_id=null,
      lease_expires_at=null,
      updated_at=now()
  where delivery.request_id=p_request_id
    and delivery.state in (
      'queued','leased','retryable','terminal_failed'
    );
end;
$$;

revoke all on function private_app.registration_email_cancel_siblings(uuid)
from public,anon,authenticated,service_role;

-- A delivery failure or a live kill switch must have a first-class transition
-- back to the ordinary review queue.  This action is deliberately distinct
-- from email confirmation: no email is considered verified and no tenant can
-- be provisioned by the fallback itself.
alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check_v2;
alter table platform.registration_request_events
  add constraint registration_request_events_action_check_v2 check (action in (
    'submitted','imported','email_confirmation_sent','email_confirmed',
    'start_review','approve','approve_and_activate','reject','reopen',
    'provision','auto_provision','trust_start','trust_approve','trust_restrict',
    'manual_trust_repair','email_fallback_manual'
  )) not valid;
alter table platform.registration_request_events
  validate constraint registration_request_events_action_check_v2;
alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check;
alter table platform.registration_request_events
  rename constraint registration_request_events_action_check_v2
  to registration_request_events_action_check;

create or replace function private_app.registration_email_fallback_to_manual(
  p_request_id uuid,
  p_reason text,
  p_actor_subject_id uuid default null,
  p_notes text default null
)
returns platform.registration_requests
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_at timestamptz:=pg_catalog.clock_timestamp();
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  if p_reason not in (
       'automatic_activation_disabled','delivery_terminal_failed'
     )
     or (v_notes is not null and char_length(v_notes)>1200) then
    raise exception 'registration_email_fallback_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;
  if v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review'
     or v_request.email_confirmed_at is not null
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_email_fallback_not_allowed';
  end if;

  update platform.registration_requests request
  set activation_mode='manual_review',
      email_confirmation_token_hash=null,
      email_confirmation_expires_at=null,
      version=request.version+1,
      updated_at=v_at,
      metadata=request.metadata||jsonb_build_object(
        'manualHoldReason',p_reason,
        'emailFallbackAt',v_at,
        'emailFallbackSource',case when p_actor_subject_id is null
          then 'registration_email_worker' else 'platform_admin' end
      )
  where request.id=v_request.id
  returning * into v_request;

  perform private_app.registration_email_cancel_siblings(v_request.id);
  -- An accepted provider handoff is immutable evidence, but its confirmation
  -- generation is no longer actionable after the manual fallback.  Preserve
  -- the provider/attempt fields while marking that generation cancelled.
  update platform.registration_email_deliveries delivery
  set state='cancelled',
      cancelled_at=coalesce(delivery.cancelled_at,v_at),
      lease_id=null,
      lease_expires_at=null,
      updated_at=v_at
  where delivery.request_id=v_request.id
    and delivery.state='accepted';

  insert into platform.registration_request_events(
    request_id,action,actor_subject_id,from_status,to_status,notes,metadata
  ) values (
    v_request.id,'email_fallback_manual',p_actor_subject_id,
    'pending_review','pending_review',v_notes,
    jsonb_build_object(
      'reason',p_reason,
      'activationMode','manual_review',
      'automaticProvisioning',false
    )
  );
  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    null,p_actor_subject_id,
    'platform.registration_request.email_fallback_manual',
    'registration_request',v_request.id::text,
    jsonb_build_object(
      'registrationReference',v_request.request_reference,
      'reason',p_reason,
      'requestVersion',v_request.version,
      'automaticProvisioning',false
    )
  );

  return v_request;
end;
$$;

revoke all on function private_app.registration_email_fallback_to_manual(
  uuid,text,uuid,text
) from public,anon,authenticated,service_role;

-- Replace the legacy claim trigger with the same strict, version-one formal
-- identifier contract used by public eligibility. Claim rows consume only the
-- already-canonical raw values stored for a new institution. Existing-directory
-- display data and TVTC review evidence are never authoritative claims.
create or replace function private_app.registration_identity_claim_sync()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_type text;
  v_value text;
  v_hash text;
  v_commercial text;
  v_national text;
  v_claim platform.registration_identity_claims%rowtype;
begin
  if new.provisioned_tenant_id is null
     or new.institution_state is distinct from 'new' then
    return new;
  end if;
  v_commercial:=nullif(coalesce(new.commercial_registration,''),'');
  v_national:=nullif(coalesce(new.national_registration,''),'');

  for v_type,v_value in
    select identifier.identity_type,identifier.identity_value
    from (values
      ('commercial'::text,v_commercial),
      ('national'::text,v_national)
    ) identifier(identity_type,identity_value)
    where (
      identifier.identity_type='commercial'
      and identifier.identity_value ~ '^[0-9]{10}$'
      and identifier.identity_value<>
        repeat(substr(identifier.identity_value,1,1),10)
    ) or (
      identifier.identity_type='national'
      and identifier.identity_value ~ '^7[0-9]{9}$'
      and identifier.identity_value<>
        repeat(substr(identifier.identity_value,1,1),10)
    )
    order by identifier.identity_type
  loop
    v_hash:=encode(extensions.digest(v_type||':'||v_value,'sha256'),'hex');
    perform pg_advisory_xact_lock(hashtextextended(
      'registration-identity:'||v_type||':'||v_hash,0
    ));
    insert into platform.registration_identity_claims(
      identifier_type,identifier_hash,request_id,tenant_id
    ) values (
      v_type,v_hash,new.id,new.provisioned_tenant_id
    ) on conflict (identifier_type,identifier_hash) do nothing;
    select claim.* into v_claim
    from platform.registration_identity_claims claim
    where claim.identifier_type=v_type and claim.identifier_hash=v_hash
    for update;
    if v_claim.tenant_id is distinct from new.provisioned_tenant_id then
      raise exception 'registration_identifier_already_provisioned';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private_app.registration_identity_claim_sync()
from public,anon,authenticated,service_role;

drop trigger if exists platform_registration_identity_claim_sync
on platform.registration_requests;
create trigger platform_registration_identity_claim_sync
after insert or update of provisioned_tenant_id
on platform.registration_requests
for each row when (
  new.provisioned_tenant_id is not null
  and new.institution_state='new'
)
execute function private_app.registration_identity_claim_sync();

create or replace function public.v1_registration_confirm_email_and_provision(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_hash text;
  v_alias_id uuid;
  v_alias_consumed_at timestamptz;
  v_request_id uuid;
  v_confirmed_delivery_id uuid;
  v_request platform.registration_requests%rowtype;
  v_tenant core.tenants%rowtype;
  v_invitation access_control.tenant_invitations%rowtype;
  v_plan_key text;
  v_current_mode text;
  v_slug text;
  v_provisioning jsonb;
  v_tenant_updated integer;
  v_token_valid boolean;
  v_commercial text;
  v_national text;
  v_identifier_type text;
  v_identifier_value text;
  v_identifier_hash text;
  v_invitation_token text;
  v_owner_status text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_invalid';
  end if;
  v_hash:=encode(extensions.digest(p_token,'sha256'),'hex');

  select alias.id,alias.request_id,alias.delivery_id
  into v_alias_id,v_request_id,v_confirmed_delivery_id
  from platform.registration_confirmation_token_aliases alias
  where alias.token_hash=v_hash
    and alias.expires_at>now();

  if v_request_id is null then
    select request.id into v_request_id
    from platform.registration_requests request
    where request.email_confirmation_token_hash=v_hash
      and request.email_confirmation_expires_at>now();
  end if;
  if v_request_id is null then
    raise exception 'registration_confirmation_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  if v_request.id is null then
    raise exception 'registration_confirmation_invalid';
  end if;

  -- Refresh and lock the exact alias only after locking its request. This is the
  -- same request-first order used by bind/cancel and turns a concurrent retry
  -- that observed the alias before consumption into a safe committed replay.
  if v_alias_id is not null then
    select alias.delivery_id,alias.consumed_at
    into v_confirmed_delivery_id,v_alias_consumed_at
    from platform.registration_confirmation_token_aliases alias
    where alias.id=v_alias_id
      and alias.request_id=v_request.id
      and alias.token_hash=v_hash
      and alias.expires_at>now()
    for update;
    if not found then
      raise exception 'registration_confirmation_invalid';
    end if;
  end if;

  -- Ambiguous-success recovery: only the precise, still-unexpired alias that
  -- completed this request may recover the exact owner handoff. It can neither
  -- target another tenant nor reuse an older sibling confirmation generation.
  if v_alias_consumed_at is not null then
    if v_confirmed_delivery_id is null
       or v_request.activation_mode<>'email_verified_trial'
       or v_request.institution_state<>'new'
       or v_request.external_account_id is not null
       or v_request.status<>'converted'
       or v_request.email_confirmed_at is null
       or v_request.provisioned_tenant_id is null
       or v_request.metadata->>'confirmedDeliveryId' is distinct from
          v_confirmed_delivery_id::text then
      raise exception 'registration_confirmation_invalid';
    end if;

    select tenant.* into v_tenant
    from core.tenants tenant
    where tenant.id=v_request.provisioned_tenant_id
      and tenant.status='active'
    for update;
    if v_tenant.id is null
       or v_tenant.settings->>'registrationRequestId' is distinct from
          v_request.id::text
       or v_tenant.settings->>'registrationActivationMode' is distinct from
          'email_verified_trial' then
      raise exception 'registration_confirmation_invalid';
    end if;

    v_owner_status:=v_request.metadata->>'ownerProvisioningStatus';
    if v_owner_status='linked' then
      return jsonb_build_object(
        'reference',v_request.request_reference,
        'tenantId',v_tenant.id,
        'tenantSlug',v_tenant.slug,
        'trustStatus',v_request.trust_status,
        'ownerStatus','linked',
        'invitationToken',null,
        'replayed',true
      );
    end if;
    if v_owner_status is distinct from 'invited'
       or coalesce(v_request.metadata->>'ownerInvitationId','') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or lower(coalesce(
            v_request.metadata->>'ownerProvisioningEmail',''
          ))<>lower(v_request.contact_email) then
      raise exception 'registration_confirmation_invalid';
    end if;

    select invitation.* into v_invitation
    from access_control.tenant_invitations invitation
    where invitation.id=(v_request.metadata->>'ownerInvitationId')::uuid
      and invitation.tenant_id=v_tenant.id
      and invitation.role_key='tenant_owner'
      and invitation.email=lower(v_request.contact_email)
    for update;
    if v_invitation.id is null then
      raise exception 'registration_confirmation_invalid';
    end if;

    if v_invitation.status='pending' then
      v_invitation_token:=encode(extensions.gen_random_bytes(32),'hex');
      update access_control.tenant_invitations invitation
      set token_hash=encode(
            extensions.digest(v_invitation_token,'sha256'),'hex'
          ),
          expires_at=now()+interval '7 days'
      where invitation.id=v_invitation.id
        and invitation.status='pending';
      get diagnostics v_tenant_updated=row_count;
      if v_tenant_updated<>1 then
        raise exception 'registration_confirmation_invalid';
      end if;
      insert into audit_log.events(
        tenant_id,actor_subject_id,action,resource_type,resource_id,context
      ) values (
        v_tenant.id,null,
        'platform.registration_request.owner_invitation_rotated',
        'invitation',v_invitation.id::text,
        jsonb_build_object(
          'registrationRequestId',v_request.id,
          'registrationReference',v_request.request_reference,
          'confirmedDeliveryId',v_confirmed_delivery_id,
          'reason','confirmation_response_replay'
        )
      );
      v_owner_status:='invited';
    elsif v_invitation.status='accepted' then
      v_owner_status:='linked';
    else
      raise exception 'registration_confirmation_already_used';
    end if;

    return jsonb_build_object(
      'reference',v_request.request_reference,
      'tenantId',v_tenant.id,
      'tenantSlug',v_tenant.slug,
      'trustStatus',v_request.trust_status,
      'ownerStatus',v_owner_status,
      'invitationToken',v_invitation_token,
      'replayed',true
    );
  end if;

  select (
    (
      v_request.email_confirmation_token_hash=v_hash
      and v_request.email_confirmation_expires_at>now()
    ) or exists(
      select 1
      from platform.registration_confirmation_token_aliases alias
      where alias.request_id=v_request.id
        and alias.token_hash=v_hash
        and alias.consumed_at is null
        and alias.expires_at>now()
    )
  ) into v_token_valid;

  if not coalesce(v_token_valid,false)
     or v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review' then
    raise exception 'registration_confirmation_invalid';
  end if;
  if v_request.email_confirmed_at is not null
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_confirmation_already_used';
  end if;

  v_commercial:=nullif(translate(
    trim(coalesce(v_request.commercial_registration,'')),
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'
  ),'');
  v_national:=nullif(translate(
    trim(coalesce(v_request.national_registration,'')),
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'
  ),'');

  -- Serialize the valid formal identities before the final claim check and
  -- hold these locks through provisioning/claim-sync.  Invalid identifiers
  -- are never hashed or promoted into an ownership key.
  for v_identifier_type,v_identifier_value in
    select identifier.identity_type,identifier.identity_value
    from (values
      ('commercial'::text,v_commercial),
      ('national'::text,v_national)
    ) identifier(identity_type,identity_value)
    where (
      identifier.identity_type='commercial'
      and identifier.identity_value ~ '^[0-9]{10}$'
      and identifier.identity_value<>
        repeat(substr(identifier.identity_value,1,1),10)
    ) or (
      identifier.identity_type='national'
      and identifier.identity_value ~ '^7[0-9]{9}$'
      and identifier.identity_value<>
        repeat(substr(identifier.identity_value,1,1),10)
    )
    order by identifier.identity_type
  loop
    v_identifier_hash:=encode(extensions.digest(
      v_identifier_type||':'||v_identifier_value,'sha256'
    ),'hex');
    perform pg_advisory_xact_lock(hashtextextended(
      'registration-identity:'||v_identifier_type||':'||v_identifier_hash,0
    ));
  end loop;

  select setting.activation_mode,setting.trial_plan_key
  into v_current_mode,v_plan_key
  from platform.registration_settings setting
  where setting.singleton
  for share;
  if v_current_mode<>'email_verified_trial' then
    update platform.registration_requests request
    set activation_mode='manual_review',
        email_confirmed_at=now(),
        email_confirmation_token_hash=null,
        email_confirmation_expires_at=null,
        version=request.version+1,
        metadata=request.metadata||jsonb_build_object(
          'emailConfirmedAt',now(),
          'manualHoldReason','automatic_activation_disabled',
          'confirmedDeliveryId',v_confirmed_delivery_id
        )
    where request.id=v_request.id
    returning * into v_request;
    perform private_app.registration_email_cancel_siblings(v_request.id);
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmed','pending_review','pending_review',
      jsonb_build_object('manualReviewRequired',true,'killSwitchApplied',true)
    );
    return jsonb_build_object(
      'reference',v_request.request_reference,
      'manualReviewRequired',true,
      'trustStatus','pending_review'
    );
  end if;

  -- Re-evaluate formal identity ownership at the click.  Any missing or claimed
  -- identifier routes to manual review; email possession alone never overrides
  -- an institution identity already bound to a tenant.
  if (
    (v_commercial is null and v_national is null)
    or (v_commercial is not null and (
      v_commercial !~ '^[0-9]{10}$'
      or v_commercial=repeat(substr(v_commercial,1,1),10)
    ))
    or (v_national is not null and (
      v_national !~ '^7[0-9]{9}$'
      or v_national=repeat(substr(v_national,1,1),10)
    ))
    or exists(
      select 1
      from platform.registration_identity_claims claim
      where (
        v_commercial is not null
        and claim.identifier_type='commercial'
        and claim.identifier_hash=encode(extensions.digest(
          'commercial:'||v_commercial,'sha256'
        ),'hex')
      ) or (
        v_national is not null
        and claim.identifier_type='national'
        and claim.identifier_hash=encode(extensions.digest(
          'national:'||v_national,'sha256'
        ),'hex')
      )
    )
  ) then
    update platform.registration_requests request
    set activation_mode='manual_review',
        email_confirmed_at=now(),
        email_confirmation_token_hash=null,
        email_confirmation_expires_at=null,
        version=request.version+1,
        metadata=request.metadata||jsonb_build_object(
          'emailConfirmedAt',now(),
          'manualHoldReason','official_identifier_requires_review',
          'confirmedDeliveryId',v_confirmed_delivery_id
        )
    where request.id=v_request.id
    returning * into v_request;
    perform private_app.registration_email_cancel_siblings(v_request.id);
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmed','pending_review','pending_review',
      jsonb_build_object('manualReviewRequired',true,'identityGuardApplied',true)
    );
    return jsonb_build_object(
      'reference',v_request.request_reference,
      'manualReviewRequired',true,
      'trustStatus','pending_review'
    );
  end if;

  if exists(
    select 1
    from auth.users auth_user
    join access_control.subjects subject
      on subject.auth_user_id=auth_user.id
    where lower(auth_user.email)=lower(v_request.contact_email)
      and subject.status<>'active'
  ) then
    update platform.registration_requests request
    set activation_mode='manual_review',
        email_confirmed_at=now(),
        email_confirmation_token_hash=null,
        email_confirmation_expires_at=null,
        version=request.version+1,
        metadata=request.metadata||jsonb_build_object(
          'emailConfirmedAt',now(),
          'manualHoldReason','existing_account_restricted',
          'confirmedDeliveryId',v_confirmed_delivery_id
        )
    where request.id=v_request.id
    returning * into v_request;
    perform private_app.registration_email_cancel_siblings(v_request.id);
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmed','pending_review','pending_review',
      jsonb_build_object('manualReviewRequired',true)
    );
    return jsonb_build_object(
      'reference',v_request.request_reference,
      'manualReviewRequired',true,
      'trustStatus','pending_review'
    );
  end if;

  v_slug:='odeir-'||lower(substr(v_request.request_reference,4));
  v_provisioning:=private_app.provision_tenant_core(
    v_request.institution_name,v_request.institution_name,v_slug,
    'SA','Asia/Riyadh',coalesce(v_plan_key,'free'),
    v_request.contact_name,v_request.contact_email,null,
    'verified_email',null,
    jsonb_build_object(
      'registrationTrustStatus','pending_review',
      'registrationRequestId',v_request.id,
      'registrationReference',v_request.request_reference,
      'registrationActivationMode','email_verified_trial'
    )
  );
  update core.tenants tenant
  set status='active'
  where tenant.id=(v_provisioning->>'id')::uuid
    and tenant.settings->>'registrationRequestId'=v_request.id::text
    and tenant.settings->>'registrationActivationMode'='email_verified_trial'
    and tenant.status='trial';
  get diagnostics v_tenant_updated=row_count;
  if v_tenant_updated<>1 then
    raise exception 'registration_created_tenant_activation_failed';
  end if;

  update platform.registration_requests request
  set email_confirmed_at=now(),
      email_confirmation_token_hash=null,
      email_confirmation_expires_at=null,
      status='converted',
      trust_status='pending_review',
      provisioned_tenant_id=(v_provisioning->>'id')::uuid,
      version=request.version+1,
      metadata=request.metadata||jsonb_build_object(
        'emailConfirmedAt',now(),
        'provisionedAt',now(),
        'provisionedSlug',v_provisioning->>'slug',
        'confirmedDeliveryId',v_confirmed_delivery_id,
        'ownerProvisioningStatus',v_provisioning#>>'{owner,status}',
        'ownerProvisioningEmail',v_provisioning#>>'{owner,email}',
        'ownerInvitationId',v_provisioning#>>'{owner,invitationId}'
      )
  where request.id=v_request.id
  returning * into v_request;
  perform private_app.registration_email_cancel_siblings(v_request.id);

  insert into platform.registration_request_events(
    request_id,action,from_status,to_status,metadata
  ) values
    (v_request.id,'email_confirmed','pending_review','converted',
      jsonb_build_object(
        'emailVerified',true,
        'deliveryId',v_confirmed_delivery_id
      )),
    (v_request.id,'auto_provision','pending_review','converted',
      jsonb_build_object(
        'tenantId',v_request.provisioned_tenant_id,
        'tenantSlug',v_provisioning->>'slug',
        'trustStatus','pending_review'
      ));
  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_request.provisioned_tenant_id,null,'tenant.auto_provisioned',
    'tenant',v_request.provisioned_tenant_id::text,
    jsonb_build_object(
      'registrationRequestId',v_request.id,
      'registrationReference',v_request.request_reference,
      'trustStatus','pending_review'
    )
  );
  return jsonb_build_object(
    'reference',v_request.request_reference,
    'tenantId',v_request.provisioned_tenant_id,
    'tenantSlug',v_provisioning->>'slug',
    'trustStatus','pending_review',
    'ownerStatus',v_provisioning#>>'{owner,status}',
    'invitationToken',v_provisioning#>>'{owner,invitationToken}',
    'replayed',false
  );
end;
$$;

create or replace function public.v1_registration_email_webhook_event(
  p_event_id text,
  p_provider_message_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event platform.registration_email_webhook_events%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_inserted boolean:=false;
begin
  -- Contract: the caller MUST verify the provider's Svix signature against the
  -- exact raw request bytes before invoking this service-role-only RPC.
  if p_event_id is null
     or p_event_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
     or p_provider_message_id is null
     or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
     or p_event_type is null
     or p_event_type not in (
       'sent','delivery_delayed','delivered','bounced','suppressed','failed',
       'complained'
     )
     or p_occurred_at is null
     or p_occurred_at<'2000-01-01'::timestamptz
     or p_occurred_at>now()+interval '5 minutes'
     or p_payload_hash is null
     or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_email_webhook_invalid';
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.provider='resend'
    and delivery.provider_message_id=p_provider_message_id
  for update;

  insert into platform.registration_email_webhook_events(
    provider,provider_event_id,provider_message_id,event_type,occurred_at,
    payload_hash,delivery_id
  ) values (
    'resend',p_event_id,p_provider_message_id,p_event_type,p_occurred_at,
    p_payload_hash,v_delivery.id
  ) on conflict (provider,provider_event_id) do nothing
  returning * into v_event;
  v_inserted:=v_event.id is not null;

  if not v_inserted then
    select event.* into v_event
    from platform.registration_email_webhook_events event
    where event.provider='resend' and event.provider_event_id=p_event_id;
    if v_event.provider_message_id<>p_provider_message_id
       or v_event.event_type<>p_event_type
       or v_event.payload_hash<>p_payload_hash then
      raise exception 'registration_email_webhook_replay_mismatch';
    end if;
  end if;

  if v_delivery.id is null then
    select delivery.* into v_delivery
    from platform.registration_email_deliveries delivery
    where delivery.provider='resend'
      and delivery.provider_message_id=v_event.provider_message_id
    for update;
  end if;

  if v_delivery.id is not null then
    update platform.registration_email_webhook_events event
    set delivery_id=v_delivery.id
    where event.provider='resend'
      and event.provider_message_id=v_delivery.provider_message_id
      and event.delivery_id is null;
    perform private_app.registration_email_apply_webhooks(v_delivery.id);
    select delivery.* into v_delivery
    from platform.registration_email_deliveries delivery
    where delivery.id=v_delivery.id;
  end if;

  return jsonb_build_object(
    'duplicate',not v_inserted,
    'matched',v_delivery.id is not null,
    'deliveryId',v_delivery.id,
    'eventType',v_event.event_type,
    'providerDeliveryState',coalesce(
      v_delivery.provider_delivery_state,'unknown'
    )
  );
end;
$$;

-- Deployed-Edge compatibility alias.  The Edge verifies the Svix signature
-- over the exact raw body and forwards only non-PII event metadata.  The
-- generic RPC above may additionally receive a true raw-payload hash from a
-- future worker; this adapter derives a deterministic metadata hash because
-- the current Edge intentionally does not forward or persist the raw payload.
create or replace function public.v1_registration_email_delivery_record_event(
  p_provider_message_id text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event_type text;
  v_metadata_hash text;
begin
  v_event_type:=case lower(coalesce(p_event_type,''))
    when 'email.sent' then 'sent'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.delivered' then 'delivered'
    when 'email.bounced' then 'bounced'
    when 'email.suppressed' then 'suppressed'
    when 'email.failed' then 'failed'
    when 'email.complained' then 'complained'
    else null
  end;
  if v_event_type is null or p_occurred_at is null then
    raise exception 'registration_email_webhook_invalid';
  end if;
  v_metadata_hash:=encode(extensions.digest(
    concat_ws(E'\n','resend',p_event_id,p_provider_message_id,v_event_type,
      extract(epoch from p_occurred_at)::text),
    'sha256'
  ),'hex');
  return public.v1_registration_email_webhook_event(
    p_event_id,p_provider_message_id,v_event_type,p_occurred_at,
    v_metadata_hash
  );
end;
$$;

create or replace function public.v1_registration_email_delivery_worker_heartbeat(
  p_processed integer,
  p_failed integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_heartbeat platform.registration_email_worker_heartbeat%rowtype;
begin
  if p_processed is null or p_processed not between 0 and 10000
     or p_failed is null or p_failed not between 0 and 10000 then
    raise exception 'registration_email_worker_heartbeat_invalid';
  end if;

  insert into platform.registration_email_worker_heartbeat(
    singleton,last_heartbeat_at,last_processed,last_failed,total_runs,
    total_processed,total_failed,updated_at
  ) values (
    true,now(),p_processed,p_failed,1,p_processed,p_failed,now()
  ) on conflict (singleton) do update
    set last_heartbeat_at=excluded.last_heartbeat_at,
        last_processed=excluded.last_processed,
        last_failed=excluded.last_failed,
        total_runs=platform.registration_email_worker_heartbeat.total_runs+1,
        total_processed=
          platform.registration_email_worker_heartbeat.total_processed+
          excluded.last_processed,
        total_failed=platform.registration_email_worker_heartbeat.total_failed+
          excluded.last_failed,
        updated_at=excluded.updated_at
  returning * into v_heartbeat;

  return jsonb_build_object(
    'ok',true,
    'heartbeatAt',v_heartbeat.last_heartbeat_at,
    'processed',v_heartbeat.last_processed,
    'failed',v_heartbeat.last_failed,
    'totalRuns',v_heartbeat.total_runs,
    'totalProcessed',v_heartbeat.total_processed,
    'totalFailed',v_heartbeat.total_failed
  );
end;
$$;

create or replace function public.v1_registration_email_delivery_health()
returns jsonb
language plpgsql
security definer
set search_path=''
stable
as $$
declare
  v_heartbeat platform.registration_email_worker_heartbeat%rowtype;
  v_queued bigint;
  v_retryable bigint;
  v_leased_stale bigint;
  v_legacy_unrecoverable bigint;
  v_terminal_failed bigint;
  v_accepted_last_24h bigint;
  v_delivered_last_24h bigint;
  v_config platform.registration_email_worker_config%rowtype;
  v_active_key_version smallint;
  v_pending_key_versions jsonb;
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

  select
    count(*) filter (where delivery.state='queued'),
    count(*) filter (where delivery.state='retryable'),
    count(*) filter (
      where delivery.state='leased' and delivery.lease_expires_at<=now()
    ),
    count(*) filter (
      where delivery.key_version=0
        and delivery.state in ('queued','leased','retryable')
    ),
    count(*) filter (where delivery.state='terminal_failed'),
    count(*) filter (
      where delivery.state='accepted'
        and delivery.accepted_at>=now()-interval '24 hours'
    ),
    count(*) filter (
      where delivery.delivered_at>=now()-interval '24 hours'
    )
  into v_queued,v_retryable,v_leased_stale,v_legacy_unrecoverable,
       v_terminal_failed,
       v_accepted_last_24h,v_delivered_last_24h
  from platform.registration_email_deliveries delivery;

  return jsonb_build_object(
    'outboxReady',v_config.singleton is true
      and v_config.cron_job_id is not null
      and coalesce(v_legacy_unrecoverable,0)=0,
    'queued',coalesce(v_queued,0),
    'retryable',coalesce(v_retryable,0),
    'leasedStale',coalesce(v_leased_stale,0),
    'legacyUnrecoverable',coalesce(v_legacy_unrecoverable,0),
    'terminalFailed',coalesce(v_terminal_failed,0),
    'acceptedLast24h',coalesce(v_accepted_last_24h,0),
    'deliveredLast24h',coalesce(v_delivered_last_24h,0),
    'activeKeyVersion',v_active_key_version,
    'pendingKeyVersions',v_pending_key_versions,
    'configured',v_config.singleton is true,
    'configuredAt',v_config.configured_at,
    'workerHeartbeatAt',v_heartbeat.last_heartbeat_at,
    'workerHealthy',v_heartbeat.last_heartbeat_at is not null
      and v_heartbeat.last_heartbeat_at>now()-interval '5 minutes',
    'cronJobId',v_config.cron_job_id,
    'functionUrl',v_config.function_url
  );
end;
$$;

create or replace function public.v1_registration_email_worker_enable_extensions()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  -- Fixed DDL only: this RPC exists for deployment automation when the hosted
  -- project has not yet enabled the three documented Supabase integrations.
  execute 'create extension if not exists pg_cron';
  execute 'create extension if not exists pg_net';
  execute 'create extension if not exists supabase_vault cascade';
  return jsonb_build_object(
    'enabled',true,
    'pgCron',to_regnamespace('cron') is not null,
    'pgNet',to_regnamespace('net') is not null,
    'vault',to_regnamespace('vault') is not null
  );
end;
$$;

create or replace function public.v1_registration_email_worker_configure(
  p_function_url text,
  p_publishable_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_is_service_role boolean:=coalesce(auth.jwt()->>'role','')='service_role';
  v_worker_token text;
  v_worker_hash text;
  v_worker_secret_id uuid;
  v_publishable_secret_id uuid;
  v_job_id bigint;
  v_actor uuid;
  v_command text:=$cron$
    select net.http_post(
      url:=config.function_url,
      headers:=jsonb_build_object(
        'Content-type','application/json',
        'apikey',(
          select secret.decrypted_secret
          from vault.decrypted_secrets secret
          where secret.id=config.publishable_key_vault_id
        ),
        'x-odeir-worker-token',(
          select secret.decrypted_secret
          from vault.decrypted_secrets secret
          where secret.id=config.worker_token_vault_id
        )
      ),
      body:=jsonb_build_object('action','drain'),
      timeout_milliseconds:=50000
    ) as request_id
    from platform.registration_email_worker_config config
    where config.singleton
  $cron$;
begin
  if not v_is_service_role
     and not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  if p_function_url is null or p_function_url !~
      '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/odeir-registration-intake$'
     or p_publishable_key is null
     or char_length(p_publishable_key) not between 32 and 1024
     or p_publishable_key ~ '[[:space:][:cntrl:]]' then
    raise exception 'registration_email_worker_configuration_invalid';
  end if;
  if to_regnamespace('cron') is null
     or to_regnamespace('net') is null
     or to_regnamespace('vault') is null
     -- to_regprocedure resolves the function identity, including parameters
     -- that have defaults.  Supabase Vault exposes these as four/five-argument
     -- functions even though callers may omit the trailing key UUID.
     or to_regprocedure(
       'vault.create_secret(text,text,text,uuid)'
     ) is null
     or to_regprocedure(
       'vault.update_secret(uuid,text,text,text,uuid)'
     ) is null then
    raise exception 'registration_email_worker_extensions_unavailable';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'odeir-registration-email-worker-config',0
  ));

  v_actor:=private_app.current_subject_id();
  v_worker_token:=encode(extensions.gen_random_bytes(32),'hex');
  v_worker_hash:=encode(
    extensions.digest(v_worker_token,'sha256'),'hex'
  );

  select secret.id into v_worker_secret_id
  from vault.secrets secret
  where secret.name='odeir_registration_email_worker_token';
  if v_worker_secret_id is null then
    v_worker_secret_id:=vault.create_secret(
      v_worker_token,
      'odeir_registration_email_worker_token',
      'Rotating credential used only by the registration email drain cron.'
    );
  else
    perform vault.update_secret(
      v_worker_secret_id,v_worker_token,
      'odeir_registration_email_worker_token',
      'Rotating credential used only by the registration email drain cron.'
    );
  end if;

  select secret.id into v_publishable_secret_id
  from vault.secrets secret
  where secret.name='odeir_registration_email_publishable_key';
  if v_publishable_secret_id is null then
    v_publishable_secret_id:=vault.create_secret(
      p_publishable_key,
      'odeir_registration_email_publishable_key',
      'Publishable project key used by pg_net to invoke the drain Edge action.'
    );
  else
    perform vault.update_secret(
      v_publishable_secret_id,p_publishable_key,
      'odeir_registration_email_publishable_key',
      'Publishable project key used by pg_net to invoke the drain Edge action.'
    );
  end if;

  select job.jobid into v_job_id
  from cron.job job
  where job.jobname='odeir-registration-email-outbox-v1';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  insert into platform.registration_email_worker_config(
    singleton,function_url,worker_token_hash,worker_token_vault_id,
    publishable_key_vault_id,cron_job_id,configured_by_subject_id,
    configured_at,updated_at
  ) values (
    true,p_function_url,v_worker_hash,v_worker_secret_id,
    v_publishable_secret_id,null,v_actor,now(),now()
  ) on conflict (singleton) do update
    set function_url=excluded.function_url,
        worker_token_hash=excluded.worker_token_hash,
        worker_token_vault_id=excluded.worker_token_vault_id,
        publishable_key_vault_id=excluded.publishable_key_vault_id,
        cron_job_id=null,
        configured_by_subject_id=excluded.configured_by_subject_id,
        configured_at=excluded.configured_at,
        updated_at=excluded.updated_at;

  v_job_id:=cron.schedule(
    'odeir-registration-email-outbox-v1','* * * * *',v_command
  );
  update platform.registration_email_worker_config config
  set cron_job_id=v_job_id,updated_at=now()
  where config.singleton;

  return jsonb_build_object(
    'configured',true,
    'functionUrl',p_function_url,
    'schedule','* * * * *',
    'cronJobId',v_job_id,
    'configuredAt',now()
  );
end;
$function$;

create or replace function public.v1_registration_email_worker_authorize(
  p_token_hash text
)
returns boolean
language sql
security definer
set search_path=''
stable
as $$
  select p_token_hash is not null
    and p_token_hash ~ '^[a-f0-9]{64}$'
    and exists(
      select 1
      from platform.registration_email_worker_config config
      where config.singleton and config.worker_token_hash=p_token_hash
    )
$$;

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
    order by delivery.created_at,delivery.id
    limit v_limit
  ) candidate;

  -- A top-level array is intentional: the deployed Edge drain accepts a
  -- bounded array and then performs a separately locked claim-by-id.
  return v_ids;
end;
$$;

create or replace function public.v1_registration_email_delivery_claim(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request_id uuid;
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_current_mode text;
  v_lease_id uuid;
begin
  select delivery.request_id into v_request_id
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  -- Every mutator locks request then delivery.  Confirmation follows the same
  -- order, so a fast click cannot deadlock a worker finalizing acceptance.
  select request.* into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id and delivery.request_id=v_request.id
  for update;
  if v_delivery.id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  if v_delivery.state='accepted' then
    return private_app.registration_email_delivery_contract(v_delivery.id,null);
  end if;
  if v_delivery.state in ('terminal_failed','cancelled') then
    return private_app.registration_email_delivery_contract(v_delivery.id,null);
  end if;

  select setting.activation_mode into v_current_mode
  from platform.registration_settings setting
  where setting.singleton
  for share;

  -- The policy row is the global kill switch.  A worker that already owns a
  -- due generation must not merely cancel that one row and strand the request
  -- in the email-only queue.  Move the whole request back to manual review,
  -- consume every alias, cancel every generation, and record one atomic event.
  if coalesce(v_current_mode,'manual_review')<>'email_verified_trial'
     and v_request.activation_mode='email_verified_trial'
     and v_request.institution_state='new'
     and v_request.external_account_id is null
     and v_request.status='pending_review'
     and v_request.provisioned_tenant_id is null
     and v_request.email_confirmed_at is null then
    select moved.* into v_request
    from private_app.registration_email_fallback_to_manual(
      v_request.id,'automatic_activation_disabled',null,
      'Global registration activation policy disabled automatic email activation.'
    ) moved;
    return private_app.registration_email_delivery_contract(v_delivery.id,null);
  end if;

  if v_delivery.token_expires_at<=now()
     or v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review'
     or v_request.provisioned_tenant_id is not null
     or v_request.email_confirmed_at is not null then
    update platform.registration_email_deliveries delivery
    set state='cancelled',
        cancelled_at=coalesce(delivery.cancelled_at,now()),
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id;
    return private_app.registration_email_delivery_contract(v_delivery.id,null);
  end if;

  if v_delivery.state='leased' and v_delivery.lease_expires_at>now() then
    return private_app.registration_email_delivery_contract(v_delivery.id,null);
  end if;
  if v_delivery.state='retryable' and v_delivery.retry_at>now() then
    return private_app.registration_email_delivery_contract(v_delivery.id,null);
  end if;

  v_lease_id:=extensions.gen_random_uuid();
  update platform.registration_email_deliveries delivery
  set state='leased',
      attempt_count=delivery.attempt_count+1,
      lease_id=v_lease_id,
      lease_expires_at=now()+interval '60 seconds',
      first_attempt_at=coalesce(delivery.first_attempt_at,now()),
      last_attempt_at=now(),
      failed_at=null,
      cancelled_at=null,
      last_http_status=null,
      last_error_code=null,
      updated_at=now()
  where delivery.id=v_delivery.id
  returning * into v_delivery;

  insert into platform.registration_email_delivery_attempts(
    delivery_id,attempt,lease_id,started_at
  ) values (
    v_delivery.id,v_delivery.attempt_count,v_lease_id,now()
  );

  return private_app.registration_email_delivery_contract(
    v_delivery.id,v_lease_id
  );
end;
$$;

create or replace function public.v1_registration_email_delivery_bind(
  p_delivery_id uuid,
  p_lease_id uuid,
  p_token_hash text,
  p_content_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request_id uuid;
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_content_fingerprint is null
     or p_content_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select delivery.request_id into v_request_id
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id and delivery.request_id=v_request.id
  for update;

  if v_delivery.id is null or v_delivery.state<>'leased'
     or v_delivery.lease_id is distinct from p_lease_id
     or v_delivery.lease_expires_at<=now()
     or v_delivery.token_expires_at<=now()
     or v_delivery.key_version<1 then
    raise exception 'registration_confirmation_delivery_lease_invalid';
  end if;
  if v_delivery.confirmation_token_hash is not null
     and v_delivery.confirmation_token_hash<>p_token_hash then
    raise exception 'registration_confirmation_token_binding_mismatch';
  end if;
  if v_delivery.content_fingerprint is not null
     and v_delivery.content_fingerprint<>p_content_fingerprint then
    raise exception 'registration_confirmation_content_mismatch';
  end if;

  -- Capture a pre-v2 current token before advancing the compatibility pointer.
  -- The legacy alias has no delivery FK because that historical send predates
  -- the durable outbox, but it remains hashed and bounded by its original TTL.
  if v_request.email_confirmation_token_hash is not null
     and v_request.email_confirmation_token_hash<>p_token_hash
     and v_request.email_confirmation_expires_at>now() then
    insert into platform.registration_confirmation_token_aliases(
      request_id,delivery_id,token_hash,expires_at
    ) values (
      v_request.id,null,v_request.email_confirmation_token_hash,
      v_request.email_confirmation_expires_at
    ) on conflict (token_hash) do nothing;
  end if;

  update platform.registration_email_deliveries delivery
  set confirmation_token_hash=coalesce(
        delivery.confirmation_token_hash,p_token_hash
      ),
      content_fingerprint=coalesce(
        delivery.content_fingerprint,p_content_fingerprint
      ),
      updated_at=now()
  where delivery.id=v_delivery.id
  returning * into v_delivery;

  insert into platform.registration_confirmation_token_aliases(
    request_id,delivery_id,token_hash,expires_at
  ) values (
    v_request.id,v_delivery.id,p_token_hash,v_delivery.token_expires_at
  ) on conflict (token_hash) do update
    set expires_at=greatest(
      platform.registration_confirmation_token_aliases.expires_at,
      excluded.expires_at
    );

  update platform.registration_requests request
  set email_confirmation_token_hash=p_token_hash,
      email_confirmation_expires_at=v_delivery.token_expires_at,
      version=request.version+1
  where request.id=v_request.id;

  return private_app.registration_email_delivery_contract(
    v_delivery.id,p_lease_id
  );
end;
$$;


revoke all on function private_app.registration_email_enqueue(uuid,integer,smallint)
from public,anon,authenticated,service_role;

create or replace function private_app.registration_email_apply_webhooks(
  p_delivery_id uuid
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_delivered_at timestamptz;
  v_bounced_at timestamptz;
  v_suppressed_at timestamptz;
  v_complained_at timestamptz;
  v_has_sent boolean;
  v_has_delayed boolean;
  v_has_failed boolean;
  v_state text;
begin
  select
    min(event.occurred_at) filter (where event.event_type='delivered'),
    min(event.occurred_at) filter (where event.event_type='bounced'),
    min(event.occurred_at) filter (where event.event_type='suppressed'),
    min(event.occurred_at) filter (where event.event_type='complained'),
    count(*) filter (where event.event_type='sent')>0,
    count(*) filter (where event.event_type='delivery_delayed')>0,
    count(*) filter (where event.event_type='failed')>0
  into v_delivered_at,v_bounced_at,v_suppressed_at,v_complained_at,
       v_has_sent,v_has_delayed,v_has_failed
  from platform.registration_email_webhook_events event
  where event.delivery_id=p_delivery_id;

  v_state:=case
    when v_complained_at is not null then 'complained'
    when v_suppressed_at is not null then 'suppressed'
    when v_bounced_at is not null then 'bounced'
    when v_delivered_at is not null then 'delivered'
    when v_has_failed then 'failed'
    when v_has_delayed then 'delayed'
    when v_has_sent then 'sent'
    else 'unknown'
  end;

  update platform.registration_email_deliveries delivery
  set delivered_at=case when v_delivered_at is null then delivery.delivered_at
        when delivery.delivered_at is null then v_delivered_at
        else least(delivery.delivered_at,v_delivered_at) end,
      bounced_at=case when v_bounced_at is null then delivery.bounced_at
        when delivery.bounced_at is null then v_bounced_at
        else least(delivery.bounced_at,v_bounced_at) end,
      suppressed_at=case when v_suppressed_at is null then delivery.suppressed_at
        when delivery.suppressed_at is null then v_suppressed_at
        else least(delivery.suppressed_at,v_suppressed_at) end,
      complained_at=case when v_complained_at is null then delivery.complained_at
        when delivery.complained_at is null then v_complained_at
        else least(delivery.complained_at,v_complained_at) end,
      provider_delivery_state=case
        when delivery.provider_delivery_state='complained'
          or v_state='complained' then 'complained'
        when delivery.provider_delivery_state='suppressed'
          or v_state='suppressed' then 'suppressed'
        when delivery.provider_delivery_state='bounced'
          or v_state='bounced' then 'bounced'
        when delivery.provider_delivery_state='delivered'
          or v_state='delivered' then 'delivered'
        when delivery.provider_delivery_state='failed'
          or v_state='failed' then 'failed'
        when delivery.provider_delivery_state='delayed'
          or v_state='delayed' then 'delayed'
        when delivery.provider_delivery_state='sent'
          or v_state='sent' then 'sent'
        else 'unknown' end,
      updated_at=now()
  where delivery.id=p_delivery_id;
end;
$$;

revoke all on function private_app.registration_email_apply_webhooks(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v1_registration_email_delivery_finish(
  p_delivery_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_http_status integer,
  p_error_code text,
  p_retry_after_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request_id uuid;
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_attempt platform.registration_email_delivery_attempts%rowtype;
  v_is_current_lease boolean;
  v_retry_seconds integer;
  v_marked boolean;
begin
  if p_outcome is null
     or p_outcome not in ('accepted','retryable','terminal_failed')
     or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_retry_after_seconds is not null
       and p_retry_after_seconds not between 1 and 86400) then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  if p_outcome='accepted' and (
    p_http_status is null or p_http_status not between 200 and 299
    or p_provider_message_id is null
    or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
  ) then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  if p_outcome<>'accepted' and (
    p_error_code is null
    or p_error_code !~ '^[a-z0-9][a-z0-9_]{0,79}$'
  ) then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select delivery.request_id into v_request_id
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id and delivery.request_id=v_request.id
  for update;
  select attempt.* into v_attempt
  from platform.registration_email_delivery_attempts attempt
  where attempt.delivery_id=v_delivery.id and attempt.lease_id=p_lease_id
  for update;
  if v_delivery.id is null or v_attempt.lease_id is null then
    raise exception 'registration_confirmation_delivery_lease_invalid';
  end if;

  v_is_current_lease:=v_delivery.state='leased'
    and v_delivery.lease_id=p_lease_id
    and v_delivery.attempt_count=v_attempt.attempt;

  -- An accepted outcome is stronger than every stale lease or cancellation.
  -- A completed accepted attempt can likewise never be rewritten as failure.
  if v_attempt.outcome is null or p_outcome='accepted' then
    update platform.registration_email_delivery_attempts attempt
    set outcome=case when attempt.outcome='accepted' then attempt.outcome
          else p_outcome end,
        provider_message_id=case when p_outcome='accepted'
          then p_provider_message_id else attempt.provider_message_id end,
        http_status=coalesce(p_http_status,attempt.http_status),
        error_code=case when p_outcome='accepted' then null
          else p_error_code end,
        finished_at=coalesce(attempt.finished_at,now())
    where attempt.delivery_id=v_attempt.delivery_id
      and attempt.attempt=v_attempt.attempt
    returning * into v_attempt;
  end if;

  if v_delivery.state='accepted' then
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'state',v_delivery.state,
      'attempt',v_delivery.attempt_count,
      'accepted',true,
      'stale',not v_is_current_lease,
      'providerMessageId',v_delivery.provider_message_id,
      'retryAt',v_delivery.retry_at,
      'providerDeliveryState',v_delivery.provider_delivery_state,
      'markerApplied',false
    );
  end if;

  if p_outcome='accepted' then
    if v_delivery.confirmation_token_hash is null
       or v_delivery.content_fingerprint is null then
      raise exception 'registration_confirmation_delivery_unbound';
    end if;

    update platform.registration_email_deliveries delivery
    set state='accepted',
        provider_message_id=p_provider_message_id,
        accepted_at=coalesce(delivery.accepted_at,now()),
        failed_at=null,
        cancelled_at=null,
        last_http_status=p_http_status,
        last_error_code=null,
        retry_at=delivery.retry_at,
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id
    returning * into v_delivery;

    update platform.registration_email_webhook_events event
    set delivery_id=v_delivery.id
    where event.provider=v_delivery.provider
      and event.provider_message_id=v_delivery.provider_message_id
      and event.delivery_id is null;
    perform private_app.registration_email_apply_webhooks(v_delivery.id);
    select delivery.* into v_delivery
    from platform.registration_email_deliveries delivery
    where delivery.id=v_delivery.id;

    -- Compatibility marker is deliberately best-effort here.  Provider
    -- acceptance is evidence and must commit even if the request was confirmed,
    -- rejected, or moved to manual review while the HTTP response was in flight.
    begin
      v_marked:=public.v1_registration_mark_confirmation_sent(
        v_delivery.request_id,v_delivery.confirmation_token_hash
      );
    exception when others then
      -- The accepted provider evidence is authoritative and must not be rolled
      -- back by a transitional marker or event failure.
      v_marked:=false;
    end;
  elsif not v_is_current_lease then
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'state',v_delivery.state,
      'attempt',v_delivery.attempt_count,
      'accepted',false,
      'stale',true,
      'providerMessageId',v_delivery.provider_message_id,
      'retryAt',v_delivery.retry_at,
      'providerDeliveryState',v_delivery.provider_delivery_state,
      'markerApplied',false
    );
  elsif p_outcome='retryable' then
    v_retry_seconds:=coalesce(
      p_retry_after_seconds,
      least(3600,15*(2^least(v_delivery.attempt_count-1,7)))::integer
    );
    update platform.registration_email_deliveries delivery
    set state='retryable',
        retry_at=now()+make_interval(secs=>v_retry_seconds),
        failed_at=null,
        last_http_status=p_http_status,
        last_error_code=p_error_code,
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id
    returning * into v_delivery;
  else
    update platform.registration_email_deliveries delivery
    set state='terminal_failed',
        failed_at=coalesce(delivery.failed_at,now()),
        last_http_status=p_http_status,
        last_error_code=p_error_code,
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id
    returning * into v_delivery;
  end if;

  return jsonb_build_object(
    'deliveryId',v_delivery.id,
    'state',v_delivery.state,
    'attempt',v_delivery.attempt_count,
    'accepted',v_delivery.state='accepted',
    'stale',false,
    'providerMessageId',v_delivery.provider_message_id,
    'retryAt',v_delivery.retry_at,
    'providerDeliveryState',v_delivery.provider_delivery_state,
    'markerApplied',coalesce(v_marked,false)
  );
end;
$$;


create or replace function private_app.registration_identity_reservation_release()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status='rejected' and old.status is distinct from new.status then
    update platform.registration_request_identity_reservations reservation
    set released_at=coalesce(reservation.released_at,now())
    where reservation.request_id=new.id and reservation.released_at is null;
  end if;
  return new;
end;
$$;

revoke all on function private_app.registration_identity_reservation_release()
from public,anon,authenticated,service_role;

drop trigger if exists platform_registration_identity_reservation_release
on platform.registration_requests;
create trigger platform_registration_identity_reservation_release
after update of status on platform.registration_requests
for each row execute function
private_app.registration_identity_reservation_release();

create or replace function public.v2_public_submit_registration_request(
  p_payload jsonb,
  p_ip_hash text,
  p_user_agent_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_state text:=trim(coalesce(p_payload->>'institutionState',''));
  v_account_id uuid;
  v_name text:=trim(coalesce(p_payload->>'institutionName',''));
  v_contact_name text:=trim(coalesce(p_payload->>'contactName',''));
  v_contact_title text:=trim(coalesce(p_payload->>'contactJobTitle',''));
  v_contact_email text:=lower(trim(coalesce(p_payload->>'contactEmail','')));
  v_contact_phone text:=trim(coalesce(p_payload->>'contactPhone',''));
  v_commercial_raw text:=trim(coalesce(
    p_payload->>'commercialRegistration',''
  ));
  v_national_raw text:=trim(coalesce(
    p_payload->>'nationalRegistration',''
  ));
  v_tvtc_raw text:=trim(regexp_replace(
    coalesce(p_payload->>'tvtcLicenseNumber',''),'[[:cntrl:]]','','g'
  ));
  v_commercial text:=nullif(translate(
    v_commercial_raw,
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'
  ),'');
  v_national text:=nullif(translate(
    v_national_raw,
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'
  ),'');
  -- TVTC is retained as cleaned review evidence only.  There is no public,
  -- versioned canonical-number contract strong enough to use it for automatic
  -- identity ownership, so it is deliberately not normalized into a claim.
  v_tvtc text:=nullif(v_tvtc_raw,'');
  v_policy_mode text;
  v_mode text;
  v_ttl integer;
  v_key_version smallint;
  v_identity_types text[]:='{}'::text[];
  v_identity_hashes text[]:='{}'::text[];
  v_identity record;
  v_matching_request_count integer:=0;
  v_matching_request_id uuid;
  v_identity_conflict boolean:=false;
  v_manual_hold_reason text;
  v_duplicate platform.registration_requests%rowtype;
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_delivery_id uuid;
  v_reference text;
  v_attempt integer;
  v_index integer;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'registration_payload_invalid';
  end if;
  if v_state not in ('existing','new') then
    raise exception 'invalid_institution_state';
  end if;
  if coalesce((p_payload->>'tvtcAcknowledged')::boolean,false) is not true
     or coalesce((p_payload->>'privacyConsent')::boolean,false) is not true then
    raise exception 'consent_required';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
     or (p_user_agent_hash is not null
       and p_user_agent_hash !~ '^[a-f0-9]{64}$') then
    raise exception 'registration_fingerprint_invalid';
  end if;
  if char_length(v_name) not between 2 and 240 then
    raise exception 'institution_name_required';
  end if;
  if char_length(v_contact_name) not between 2 and 160 then
    raise exception 'contact_name_required';
  end if;
  if char_length(v_contact_title) not between 2 and 160 then
    raise exception 'job_title_required';
  end if;
  if v_contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(v_contact_email)>240 then
    raise exception 'invalid_email';
  end if;
  if char_length(v_contact_phone) not between 8 and 24 then
    raise exception 'invalid_phone';
  end if;
  -- CR and national identifiers are eligibility inputs, not display text. Translate
  -- Arabic/Persian decimal digits first, then reject every separator, mask,
  -- suffix, short value, and repeated-digit placeholder.  Auto-provisioning
  -- must never hash a lossy regexp-stripped identifier.
  if (v_commercial_raw<>'' and (
        v_commercial !~ '^[0-9]{10}$'
        or v_commercial=repeat(substr(v_commercial,1,1),10)
      ))
     or (v_national_raw<>'' and (
        v_national !~ '^7[0-9]{9}$'
        or v_national=repeat(substr(v_national,1,1),10)
      ))
     or char_length(v_tvtc_raw)>80 then
    raise exception 'registration_identifier_invalid';
  end if;

  if nullif(trim(coalesce(p_payload->>'accountId','')),'') is not null then
    if (p_payload->>'accountId') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      raise exception 'invalid_external_account';
    end if;
    v_account_id:=(p_payload->>'accountId')::uuid;
  end if;
  if v_state='existing' and v_account_id is null then
    raise exception 'institution_required';
  end if;
  if v_state='new' and v_account_id is not null then
    raise exception 'invalid_external_account';
  end if;

  select setting.activation_mode,setting.email_confirmation_ttl_minutes,
         setting.email_token_key_version
  into v_policy_mode,v_ttl,v_key_version
  from platform.registration_settings setting
  where setting.singleton
  for share;
  v_mode:=case when v_state='new' then coalesce(v_policy_mode,'manual_review')
    else 'manual_review' end;
  v_ttl:=coalesce(v_ttl,60);
  v_key_version:=coalesce(v_key_version,1);

  -- A public existing-account selection proves neither control nor authority.
  -- Do not let it reserve a directory account (or a name/formal identifier) and
  -- suppress a legitimate request. Manual activation later consumes a signed,
  -- one-time directory attestation into the immutable external-account claim.
  if v_state='new' and v_commercial is not null then
    v_identity_types:=array_append(v_identity_types,'commercial');
    v_identity_hashes:=array_append(v_identity_hashes,encode(
      extensions.digest('commercial:'||v_commercial,'sha256'),'hex'
    ));
  end if;
  if v_state='new' and v_national is not null then
    v_identity_types:=array_append(v_identity_types,'national');
    v_identity_hashes:=array_append(v_identity_hashes,encode(
      extensions.digest('national:'||v_national,'sha256'),'hex'
    ));
  end if;
  if v_mode='email_verified_trial'
     and coalesce(array_length(v_identity_hashes,1),0)=0 then
    v_mode:='manual_review';
    v_manual_hold_reason:=case when v_tvtc is not null
      then 'tvtc_identifier_not_auto_eligible'
      else 'official_identifier_required' end;
  end if;

  if v_state='new'
     and coalesce(array_length(v_identity_hashes,1),0)=0 then
    v_identity_types:=array_append(v_identity_types,'institution_name');
    v_identity_hashes:=array_append(v_identity_hashes,encode(
      extensions.digest(
        'institution_name:'||lower(regexp_replace(v_name,'[[:space:]]+',' ','g')),
        'sha256'
      ),'hex'
    ));
  end if;

  -- Serialize every supplied institution key in a stable order.  Email is not
  -- part of this lock or identity; one operator may legitimately own multiple
  -- institutions, while a changed contact for one identity is held for review.
  for v_identity in
    select supplied.identity_type,supplied.identity_hash
    from unnest(v_identity_types,v_identity_hashes)
      as supplied(identity_type,identity_hash)
    order by supplied.identity_type,supplied.identity_hash
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'registration-identity:'||v_identity.identity_type||':'||
        v_identity.identity_hash,
      0
    ));
  end loop;

  -- Recheck authoritative tenant claims only after taking the exact same lock
  -- namespace used by manual activation and the claim-sync trigger.  A tenant
  -- created concurrently can therefore never slip between eligibility and
  -- outbox creation.
  if v_mode='email_verified_trial' and exists(
    select 1
    from platform.registration_identity_claims claim
    join unnest(v_identity_types,v_identity_hashes)
      as supplied(identity_type,identity_hash)
      on supplied.identity_type=claim.identifier_type
     and supplied.identity_hash=claim.identifier_hash
    where supplied.identity_type in ('commercial','national')
  ) then
    v_mode:='manual_review';
    v_manual_hold_reason:='official_identifier_claimed';
  end if;

  select count(distinct reservation.request_id),
         (array_agg(distinct reservation.request_id))[1]
  into v_matching_request_count,v_matching_request_id
  from platform.registration_request_identity_reservations reservation
  join unnest(v_identity_types,v_identity_hashes)
    as supplied(identity_type,identity_hash)
    on supplied.identity_type=reservation.identity_type
   and supplied.identity_hash=reservation.identity_hash
  where reservation.released_at is null;

  if v_matching_request_count=1 then
    begin
      -- Manual activation and confirmation lock request before identity.  This
      -- NOWAIT edge prevents an identity-first public submit from forming the
      -- opposite half of a deadlock; the whole submit safely retries instead.
      select request.* into v_duplicate
      from platform.registration_requests request
      where request.id=v_matching_request_id
      for update nowait;
    exception when lock_not_available then
      raise exception 'registration_identity_busy' using errcode='55P03';
    end;
    if lower(v_duplicate.contact_email)<>v_contact_email then
      v_identity_conflict:=true;
      v_duplicate.id:=null;
    end if;
  elsif v_matching_request_count>1 then
    v_identity_conflict:=true;
  end if;

  if v_duplicate.id is not null then
    -- A retry can find a request that was created while email activation was
    -- enabled.  The current global policy wins: never create a fresh delivery
    -- generation behind the kill switch.  Move the original request into the
    -- ordinary manual queue in the same transaction instead.
    if coalesce(v_policy_mode,'manual_review')<>'email_verified_trial'
       and v_duplicate.activation_mode='email_verified_trial'
       and v_duplicate.institution_state='new'
       and v_duplicate.external_account_id is null
       and v_duplicate.status='pending_review'
       and v_duplicate.email_confirmed_at is null
       and v_duplicate.provisioned_tenant_id is null then
      select moved.* into v_duplicate
      from private_app.registration_email_fallback_to_manual(
        v_duplicate.id,'automatic_activation_disabled',null,
        'Duplicate submission observed after automatic email activation was disabled.'
      ) moved;
      return jsonb_build_object(
        'duplicate',true,
        'reference',v_duplicate.request_reference,
        'requestId',v_duplicate.id,
        'status',v_duplicate.status,
        'activationMode',v_duplicate.activation_mode,
        'confirmationRequired',false,
        'confirmationQueued',false,
        'confirmationAlreadySent',false,
        'deliveryId',null,
        'message','request_moved_to_manual_review',
        'expectedResponse','one_business_day'
      );
    end if;

    if v_duplicate.activation_mode='email_verified_trial'
       and v_duplicate.institution_state='new'
       and v_duplicate.external_account_id is null
       and v_duplicate.status='pending_review'
       and v_duplicate.email_confirmed_at is null
       and v_duplicate.provisioned_tenant_id is null then
      select delivery.* into v_delivery
      from platform.registration_email_deliveries delivery
      where delivery.request_id=v_duplicate.id
        and delivery.message_kind='confirmation'
      order by delivery.generation desc
      limit 1
      for update;

      if v_delivery.id is not null
         and v_delivery.state='accepted'
         and v_delivery.accepted_at>now()-interval '2 minutes'
         and v_delivery.token_expires_at>now() then
        return jsonb_build_object(
          'duplicate',true,
          'reference',v_duplicate.request_reference,
          'requestId',v_duplicate.id,
          'status',v_duplicate.status,
          'activationMode',v_duplicate.activation_mode,
          'confirmationRequired',true,
          'confirmationQueued',false,
          'confirmationAlreadySent',true,
          'deliveryId',v_delivery.id,
          'message',null,
          'expectedResponse','email_confirmation'
        );
      end if;

      if v_delivery.id is not null
         and v_delivery.state in ('queued','leased','retryable')
         and v_delivery.token_expires_at>now() then
        return jsonb_build_object(
          'duplicate',true,
          'reference',v_duplicate.request_reference,
          'requestId',v_duplicate.id,
          'status',v_duplicate.status,
          'activationMode',v_duplicate.activation_mode,
          'confirmationRequired',true,
          'confirmationQueued',true,
          'confirmationAlreadySent',false,
          'deliveryId',v_delivery.id,
          'message',null,
          'expectedResponse','email_confirmation'
        );
      end if;

      v_delivery_id:=private_app.registration_email_enqueue(
        v_duplicate.id,v_ttl,v_key_version
      );
      return jsonb_build_object(
        'duplicate',true,
        'reference',v_duplicate.request_reference,
        'requestId',v_duplicate.id,
        'status',v_duplicate.status,
        'activationMode',v_duplicate.activation_mode,
        'confirmationRequired',true,
        'confirmationQueued',true,
        'confirmationAlreadySent',false,
        'deliveryId',v_delivery_id,
        'message',null,
        'expectedResponse','email_confirmation'
      );
    end if;

    return jsonb_build_object(
      'duplicate',true,
      'reference',v_duplicate.request_reference,
      'requestId',v_duplicate.id,
      'status',v_duplicate.status,
      'activationMode',v_duplicate.activation_mode,
      'confirmationRequired',false,
      'confirmationQueued',false,
      'confirmationAlreadySent',false,
      'deliveryId',null,
      'message','request_already_received',
      'expectedResponse','one_business_day'
    );
  end if;

  if v_identity_conflict then
    v_mode:='manual_review';
    v_manual_hold_reason:='institution_identity_conflict';
  end if;

  for v_attempt in 1..8 loop
    v_reference:='MT-'||to_char(current_date,'YYYYMMDD')||'-'||upper(substr(
      replace(extensions.gen_random_uuid()::text,'-',''),1,6
    ));
    exit when not exists(
      select 1 from platform.registration_requests request
      where request.request_reference=v_reference
    );
  end loop;
  if exists(
    select 1 from platform.registration_requests request
    where request.request_reference=v_reference
  ) then
    raise exception 'registration_reference_unavailable';
  end if;

  insert into platform.registration_requests(
    request_reference,source,external_account_id,institution_state,
    institution_name,commercial_registration,national_registration,
    tvtc_license_number,contact_name,contact_job_title,contact_email,
    contact_phone,tvtc_notice_acknowledged,privacy_consent_at,
    request_ip_hash,user_agent_hash,activation_mode,trust_status,metadata
  ) values (
    v_reference,'odeir_public_registration',v_account_id,v_state,
    v_name,v_commercial,v_national,v_tvtc,v_contact_name,v_contact_title,
    v_contact_email,v_contact_phone,true,now(),p_ip_hash,p_user_agent_hash,
    v_mode,'pending_review',jsonb_build_object(
      'page','registration-modal',
      'locale','ar-SA',
      'submittedAt',now(),
      'identityConflict',v_identity_conflict,
      'manualHoldReason',v_manual_hold_reason,
      'emailOutboxVersion',2
    )
  ) returning * into v_request;

  if not v_identity_conflict then
    for v_index in 1..coalesce(array_length(v_identity_hashes,1),0) loop
      insert into platform.registration_request_identity_reservations(
        request_id,identity_type,identity_hash
      ) values (
        v_request.id,v_identity_types[v_index],v_identity_hashes[v_index]
      );
    end loop;
  end if;

  insert into platform.registration_request_events(
    request_id,action,to_status,metadata
  ) values (
    v_request.id,'submitted',v_request.status,jsonb_build_object(
      'source',v_request.source,
      'activationMode',v_request.activation_mode,
      'emailOutboxVersion',2,
      'identityConflict',v_identity_conflict,
      'manualHoldReason',v_manual_hold_reason
    )
  );

  if v_mode='email_verified_trial' then
    v_delivery_id:=private_app.registration_email_enqueue(
      v_request.id,v_ttl,v_key_version
    );
  end if;

  return jsonb_build_object(
    'duplicate',false,
    'reference',v_request.request_reference,
    'requestId',v_request.id,
    'status',v_request.status,
    'activationMode',v_request.activation_mode,
    'confirmationRequired',v_delivery_id is not null,
    'confirmationQueued',v_delivery_id is not null,
    'confirmationAlreadySent',false,
    'deliveryId',v_delivery_id,
    'message',null,
    'expectedResponse',case when v_delivery_id is null
      then 'one_business_day' else 'email_confirmation' end
  );
end;
$$;

-- Rollout compatibility contract: v1 callers may mark the current legacy hash
-- without an accepted outbox row until every Edge deployment uses v2 claim /
-- bind / finish.  After that rollout, remove the `v_legacy_current` branch and
-- require an accepted delivery alias for every sent marker.
create or replace function public.v1_registration_mark_confirmation_sent(
  p_request_id uuid,
  p_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_alias_exists boolean;
  v_accepted_alias boolean;
  v_legacy_current boolean;
  v_was_sent boolean;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then return false; end if;

  select
    exists(
      select 1
      from platform.registration_confirmation_token_aliases alias
      where alias.request_id=v_request.id and alias.token_hash=p_token_hash
    ),
    exists(
      select 1
      from platform.registration_confirmation_token_aliases alias
      join platform.registration_email_deliveries delivery
        on delivery.id=alias.delivery_id
      where alias.request_id=v_request.id
        and alias.token_hash=p_token_hash
        and delivery.state='accepted'
    )
  into v_alias_exists,v_accepted_alias;

  v_legacy_current:=v_request.activation_mode='email_verified_trial'
    and v_request.email_confirmation_token_hash=p_token_hash
    and v_request.email_confirmed_at is null;

  if v_request.email_confirmation_sent_at is not null
     and (v_alias_exists or v_legacy_current) then
    return true;
  end if;
  if not v_accepted_alias and not v_legacy_current then
    return false;
  end if;

  v_was_sent:=v_request.email_confirmation_sent_at is not null;
  update platform.registration_requests request
  set email_confirmation_sent_at=coalesce(
    request.email_confirmation_sent_at,now()
  )
  where request.id=v_request.id;

  if not v_was_sent then
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmation_sent',v_request.status,v_request.status,
      jsonb_build_object(
        'outboxAccepted',v_accepted_alias,
        'legacyCompatibility',not v_accepted_alias
      )
    );
  end if;
  return true;
end;
$$;

-- Legacy Edge adapter.  It binds the already-generated v1 hash to an alias and
-- leases an outbox row, preserving old request/response fields during DB-first
-- rollout.  New workers use v2 submit + claim + bind instead.
create or replace function public.v1_registration_email_delivery_begin(
  p_request_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_generation integer;
  v_claim jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null
     or v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review'
     or v_request.provisioned_tenant_id is not null
     or v_request.email_confirmed_at is not null
     or v_request.email_confirmation_token_hash is distinct from p_token_hash
     or v_request.email_confirmation_expires_at is null
     or v_request.email_confirmation_expires_at<=now() then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='confirmation'
    and delivery.confirmation_token_hash=p_token_hash
  for update;

  if v_delivery.id is null then
    select coalesce(max(delivery.generation),0)+1
    into v_generation
    from platform.registration_email_deliveries delivery
    where delivery.request_id=v_request.id
      and delivery.message_kind='confirmation';

    insert into platform.registration_email_deliveries(
      request_id,message_kind,generation,key_version,token_nonce,
      confirmation_token_hash,token_expires_at,template_version,
      content_fingerprint,idempotency_key,provider,state,retry_at
    ) values (
      v_request.id,'confirmation',v_generation,0,
      encode(extensions.gen_random_bytes(32),'hex'),p_token_hash,
      v_request.email_confirmation_expires_at,
      'registration-confirmation-legacy-v1',
      encode(extensions.digest(
        'legacy-content:'||v_request.id::text||':'||p_token_hash,'sha256'
      ),'hex'),
      'odeir-registration-confirmation/'||v_request.id::text||'/'||
        v_generation,
      'resend','queued',now()
    ) returning * into v_delivery;

    insert into platform.registration_confirmation_token_aliases(
      request_id,delivery_id,token_hash,expires_at
    ) values (
      v_request.id,v_delivery.id,p_token_hash,v_delivery.token_expires_at
    ) on conflict (token_hash) do nothing;
  end if;

  v_claim:=public.v1_registration_email_delivery_claim(v_delivery.id);
  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=v_delivery.id;

  return jsonb_build_object(
    'deliveryId',v_delivery.id,
    'generation',v_delivery.generation,
    'attempt',v_delivery.attempt_count,
    'idempotencyKey',v_delivery.idempotency_key,
    'status',case when v_delivery.state='leased'
      then 'sending' else v_delivery.state end,
    'sendRequired',coalesce((v_claim->>'sendRequired')::boolean,false),
    'accepted',v_delivery.state='accepted',
    'inFlight',coalesce((v_claim->>'inFlight')::boolean,false),
    'providerMessageId',v_delivery.provider_message_id
  );
end;
$$;

create or replace function public.v1_registration_email_delivery_finish(
  p_delivery_id uuid,
  p_attempt integer,
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
  v_lease_id uuid;
  v_result jsonb;
begin
  if p_attempt is null or p_attempt<1
     or p_outcome is null or p_outcome not in ('accepted','failed') then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  select attempt.lease_id into v_lease_id
  from platform.registration_email_delivery_attempts attempt
  where attempt.delivery_id=p_delivery_id and attempt.attempt=p_attempt;
  if v_lease_id is null then
    raise exception 'registration_confirmation_delivery_lease_invalid';
  end if;

  v_result:=public.v1_registration_email_delivery_finish(
    p_delivery_id,
    v_lease_id,
    case when p_outcome='accepted' then 'accepted' else 'retryable' end,
    p_provider_message_id,
    p_http_status,
    p_error_code,
    case when p_outcome='failed' then 30 else null end
  );
  return v_result||jsonb_build_object('status',v_result->>'state');
end;
$$;
create or replace function public.v1_platform_registration_email_delivery_status(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
stable
as $$
declare
  v_request_exists boolean;
  v_delivery platform.registration_email_deliveries%rowtype;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  select exists(
    select 1 from platform.registration_requests request
    where request.id=p_request_id
  ) into v_request_exists;
  if not v_request_exists then
    raise exception 'registration_request_not_found';
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.request_id=p_request_id
  order by delivery.generation desc
  limit 1;

  return jsonb_build_object(
    'requestId',p_request_id,
    'emailDelivery',case when v_delivery.id is null then null else
      jsonb_build_object(
        'state',v_delivery.state,
        'deliveryState',v_delivery.provider_delivery_state,
        'attemptCount',v_delivery.attempt_count,
        'nextAttemptAt',case
          when v_delivery.state in ('queued','retryable')
            then v_delivery.retry_at
          when v_delivery.state='leased' then v_delivery.lease_expires_at
          else null end,
        'lastErrorCode',v_delivery.last_error_code,
        'acceptedAt',v_delivery.accepted_at,
        'deliveredAt',v_delivery.delivered_at,
        'bouncedAt',v_delivery.bounced_at,
        'complainedAt',v_delivery.complained_at
      ) end
  );
end;
$$;

create or replace function public.v1_platform_registration_email_move_to_manual(
  p_request_id uuid,
  p_expected_version integer,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_actor uuid;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();
  if v_actor is null then
    raise exception 'platform_subject_not_found';
  end if;
  if v_notes is null or char_length(v_notes) not between 3 and 1200 then
    raise exception 'registration_email_fallback_reason_required';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review'
     or v_request.email_confirmed_at is not null
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_email_fallback_not_allowed';
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='confirmation'
  order by delivery.generation desc
  limit 1
  for update;
  if v_delivery.id is null or v_delivery.state<>'terminal_failed' then
    raise exception 'registration_email_fallback_not_allowed';
  end if;

  select moved.* into v_request
  from private_app.registration_email_fallback_to_manual(
    v_request.id,'delivery_terminal_failed',v_actor,v_notes
  ) moved;

  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status',v_request.status,
      'requestStatus',v_request.status,
      'queueStatus','pending_review',
      'activationMode',v_request.activation_mode,
      'trustStatus',v_request.trust_status,
      'version',v_request.version,
      'provisionedTenantId',v_request.provisioned_tenant_id
    ),
    'emailDelivery',jsonb_build_object(
      'id',v_delivery.id,
      'state','cancelled',
      'previousState','terminal_failed'
    ),
    'provisioning',null,
    'automaticProvisioning',false
  );
end;
$$;

revoke all on function public.v2_public_submit_registration_request(
  jsonb,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.v2_public_submit_registration_request(
  jsonb,text,text
) to service_role;

revoke all on function public.v1_registration_email_delivery_due_ids(integer)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_due_ids(integer)
to service_role;

revoke all on function public.v1_registration_email_delivery_claim(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_claim(uuid)
to service_role;

revoke all on function public.v1_registration_email_delivery_bind(
  uuid,uuid,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_bind(
  uuid,uuid,text,text
) to service_role;

revoke all on function public.v1_registration_email_delivery_finish(
  uuid,uuid,text,text,integer,text,integer
) from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_finish(
  uuid,uuid,text,text,integer,text,integer
) to service_role;

revoke all on function public.v1_registration_email_delivery_begin(uuid,text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_begin(uuid,text)
to service_role;

revoke all on function public.v1_registration_email_delivery_finish(
  uuid,integer,text,text,integer,text
) from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_finish(
  uuid,integer,text,text,integer,text
) to service_role;

revoke all on function public.v1_registration_mark_confirmation_sent(uuid,text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_mark_confirmation_sent(uuid,text)
to service_role;

revoke all on function public.v1_registration_confirm_email_and_provision(text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_confirm_email_and_provision(text)
to service_role;

revoke all on function public.v1_registration_email_webhook_event(
  text,text,text,timestamptz,text
) from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_webhook_event(
  text,text,text,timestamptz,text
) to service_role;

revoke all on function public.v1_registration_email_delivery_record_event(
  text,text,text,timestamptz
) from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_record_event(
  text,text,text,timestamptz
) to service_role;

revoke all on function public.v1_registration_email_delivery_worker_heartbeat(
  integer,integer
) from public,anon,authenticated,service_role;
grant execute on function
public.v1_registration_email_delivery_worker_heartbeat(integer,integer)
to service_role;

revoke all on function public.v1_registration_email_delivery_health()
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_delivery_health()
to service_role;

revoke all on function public.v1_registration_email_worker_enable_extensions()
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_worker_enable_extensions()
to service_role;

revoke all on function public.v1_registration_email_worker_configure(text,text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_worker_configure(text,text)
to authenticated,service_role;

revoke all on function public.v1_registration_email_worker_authorize(text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_email_worker_authorize(text)
to service_role;

revoke all on function
public.v1_platform_registration_email_delivery_status(uuid)
from public,anon,authenticated,service_role;
grant execute on function
public.v1_platform_registration_email_delivery_status(uuid)
to authenticated;

revoke all on function public.v1_platform_registration_email_move_to_manual(
  uuid,integer,text
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_email_move_to_manual(
  uuid,integer,text
) to authenticated;

comment on function public.v2_public_submit_registration_request(
  jsonb,text,text
) is
'SERVICE ROLE. Returns {duplicate,reference,requestId,status,activationMode,confirmationRequired,confirmationQueued,confirmationAlreadySent,deliveryId,message,expectedResponse}. It never returns a token, nonce, recipient, or provider credential.';
comment on function public.v1_registration_email_delivery_due_ids(integer) is
'SERVICE ROLE. Returns [uuid,...] for bounded due, stale-leased, or expired HMAC work; claiming remains a separate locked operation. Legacy key-version-zero rows are intentionally excluded.';
comment on function public.v1_registration_email_delivery_claim(uuid) is
'SERVICE ROLE. Returns {deliveryId,requestId,generation,keyVersion,tokenNonce,tokenExpiresEpoch,templateVersion,idempotencyKey,attempt,leaseId,state,sendRequired,inFlight,accepted,retryAt,tokenHash,contentFingerprint,recipient,contactName,institutionName,reference}. Message fields come only from the locked database request.';
comment on function public.v1_registration_email_delivery_bind(
  uuid,uuid,text,text
) is
'SERVICE ROLE. Binds SHA-256(token) and SHA-256(exact canonical provider payload) once for the active lease and returns the same claim contract. The HMAC token itself is never stored.';
comment on function public.v1_registration_email_delivery_finish(
  uuid,uuid,text,text,integer,text,integer
) is
'SERVICE ROLE. Returns {deliveryId,state,attempt,accepted,stale,providerMessageId,retryAt,providerDeliveryState,markerApplied}. Accepted evidence wins stale failures and cancellation; retryable failures use a bounded retry delay.';
comment on function public.v1_registration_email_webhook_event(
  text,text,text,timestamptz,text
) is
'SERVICE ROLE after mandatory Svix verification. Returns {duplicate,matched,deliveryId,eventType,providerDeliveryState}; stores only event/message IDs, event type/time, and payload hash.';
comment on function public.v1_registration_email_delivery_record_event(
  text,text,text,timestamptz
) is
'SERVICE ROLE deployed-Edge alias after mandatory Svix verification. Maps Resend email.* types and derives a non-PII metadata hash; returns the canonical webhook-event contract.';
comment on function public.v1_registration_email_delivery_worker_heartbeat(
  integer,integer
) is
'SERVICE ROLE. Returns {ok,heartbeatAt,processed,failed,totalRuns,totalProcessed,totalFailed}.';
comment on function public.v1_registration_email_delivery_health() is
'SERVICE ROLE. Returns {outboxReady,queued,retryable,leasedStale,terminalFailed,acceptedLast24h,deliveredLast24h,activeKeyVersion,pendingKeyVersions,configured,configuredAt,workerHeartbeatAt,workerHealthy,cronJobId,functionUrl}. pendingKeyVersions includes every unexpired queued/leased/retryable HMAC generation, so rotation retains all required secrets.';
comment on function public.v1_registration_email_worker_configure(text,text) is
'SERVICE ROLE or platform.settings.manage. Validates the exact Supabase Edge URL, rotates a private worker token into Vault, stores the publishable key in Vault, and schedules a one-minute pg_cron drain without returning or embedding either credential.';
comment on function public.v1_registration_email_worker_authorize(text) is
'SERVICE ROLE. Accepts only SHA-256(worker token) and returns a boolean; the raw Vault credential never crosses the Data API.';
comment on function public.v1_platform_registration_email_delivery_status(uuid)
is
'Authorized platform diagnostic for the latest generation. Returns no recipient, token hash, nonce, URL, body, or provider response payload.';
comment on function public.v1_platform_registration_email_move_to_manual(
  uuid,integer,text
) is
'Authorized, optimistic-lock transition for a terminally failed email request. It cancels every confirmation generation and alias, records event/audit evidence, and never provisions a tenant.';

commit;
