begin;

-- Provider transport state is intentionally separate from the registration row.
-- It stores no recipient, message body, confirmation URL, or raw token.  The
-- token hash is enough to bind one immutable delivery generation to the token
-- that the registration flow already owns.
create table if not exists platform.registration_email_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null
    references platform.registration_requests(id) on delete restrict,
  message_kind text not null
    check (message_kind in ('confirmation')),
  confirmation_token_hash text not null
    check (confirmation_token_hash ~ '^[a-f0-9]{64}$'),
  generation integer not null check (generation>0),
  idempotency_key text not null unique
    check (idempotency_key ~ '^[a-z0-9/_-]{1,200}$'),
  provider text not null default 'resend'
    check (provider in ('resend')),
  provider_message_id text
    check (
      provider_message_id is null
      or provider_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
    ),
  status text not null
    check (status in ('sending','accepted','failed')),
  attempt_count integer not null default 1 check (attempt_count>0),
  last_attempt_at timestamptz not null default now(),
  accepted_at timestamptz,
  failed_at timestamptz,
  last_http_status integer
    check (last_http_status is null or last_http_status between 100 and 599),
  last_error_code text
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9][a-z0-9_]{0,79}$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_email_delivery_generation_key
    unique (request_id,message_kind,generation),
  constraint registration_email_delivery_token_key
    unique (request_id,message_kind,confirmation_token_hash),
  constraint registration_email_delivery_accepted_check check (
    status<>'accepted'
    or (
      provider_message_id is not null
      and accepted_at is not null
      and last_http_status is not null
      and last_http_status between 200 and 299
      and last_error_code is null
    )
  ),
  constraint registration_email_delivery_failed_check check (
    status<>'failed'
    or (failed_at is not null and last_error_code is not null)
  )
);

create unique index platform_registration_email_provider_message_idx
on platform.registration_email_deliveries(provider,provider_message_id)
where provider_message_id is not null;

create index platform_registration_email_request_idx
on platform.registration_email_deliveries(request_id,created_at desc);

alter table platform.registration_email_deliveries enable row level security;
revoke all on table platform.registration_email_deliveries
from public,anon,authenticated,service_role;

comment on table platform.registration_email_deliveries is
'Private transport ledger for ODEIR registration email. It deliberately excludes recipients, bodies, URLs, and raw confirmation tokens.';

-- A duplicate public submission may try to rotate the confirmation token while
-- its first provider request is still unresolved.  Keep the old link valid for
-- the same 30-second lease used by begin(); the caller can safely retry after
-- the worker either finishes or its lease expires.
create or replace function private_app.registration_email_rotation_guard()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if old.email_confirmation_token_hash is not null
     and new.email_confirmation_token_hash is distinct from
       old.email_confirmation_token_hash
     and exists(
       select 1
       from platform.registration_email_deliveries delivery
       where delivery.request_id=old.id
         and delivery.message_kind='confirmation'
         and delivery.confirmation_token_hash=
           old.email_confirmation_token_hash
         and delivery.status='sending'
         and delivery.last_attempt_at>now()-interval '30 seconds'
     ) then
    raise exception 'confirmation_email_in_progress';
  end if;
  return new;
end;
$$;

revoke all on function private_app.registration_email_rotation_guard()
from public,anon,authenticated,service_role;

drop trigger if exists registration_email_rotation_guard
on platform.registration_requests;
create trigger registration_email_rotation_guard
before update of email_confirmation_token_hash
on platform.registration_requests
for each row execute function
private_app.registration_email_rotation_guard();

-- Make the existing marker idempotent.  An accepted provider response and a
-- retried Edge request may both reach this function; only the first transition
-- appends the event, while every valid replay returns true.
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
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;

  if v_request.id is null then
    return false;
  end if;

  if v_request.email_confirmation_sent_at is not null and (
    v_request.email_confirmation_token_hash=p_token_hash
    or exists(
      select 1
      from platform.registration_email_deliveries delivery
      where delivery.request_id=v_request.id
        and delivery.message_kind='confirmation'
        and delivery.confirmation_token_hash=p_token_hash
        and delivery.status='accepted'
    )
  ) then
    return true;
  end if;

  if v_request.activation_mode<>'email_verified_trial'
     or v_request.email_confirmation_token_hash is distinct from p_token_hash
     or v_request.email_confirmed_at is not null then
    return false;
  end if;

  update platform.registration_requests request
  set email_confirmation_sent_at=now()
  where request.id=v_request.id;

  insert into platform.registration_request_events(
    request_id,action,from_status,to_status
  ) values (
    v_request.id,'email_confirmation_sent',v_request.status,v_request.status
  );
  return true;
end;
$$;

-- Reserve or resume one transport attempt.  Lock ordering is always
-- registration request first, delivery second; finish() uses the same order.
-- A short in-flight lease prevents concurrent workers from issuing the same
-- provider request while Resend's deterministic key covers retry ambiguity.
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

  if v_delivery.id is not null and v_delivery.status='accepted' then
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'generation',v_delivery.generation,
      'attempt',v_delivery.attempt_count,
      'idempotencyKey',v_delivery.idempotency_key,
      'status',v_delivery.status,
      'sendRequired',false,
      'accepted',true,
      'inFlight',false,
      'providerMessageId',v_delivery.provider_message_id
    );
  end if;

  if v_delivery.id is not null
     and v_delivery.status='sending'
     and v_delivery.last_attempt_at>now()-interval '30 seconds' then
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'generation',v_delivery.generation,
      'attempt',v_delivery.attempt_count,
      'idempotencyKey',v_delivery.idempotency_key,
      'status',v_delivery.status,
      'sendRequired',false,
      'accepted',false,
      'inFlight',true
    );
  end if;

  if v_delivery.id is not null then
    update platform.registration_email_deliveries delivery
    set status='sending',
        attempt_count=delivery.attempt_count+1,
        last_attempt_at=now(),
        failed_at=null,
        last_http_status=null,
        last_error_code=null,
        updated_at=now()
    where delivery.id=v_delivery.id
    returning * into v_delivery;
  else
    select coalesce(max(delivery.generation),0)+1
    into v_generation
    from platform.registration_email_deliveries delivery
    where delivery.request_id=v_request.id
      and delivery.message_kind='confirmation';

    insert into platform.registration_email_deliveries(
      request_id,message_kind,confirmation_token_hash,generation,
      idempotency_key,provider,status,attempt_count,last_attempt_at
    ) values (
      v_request.id,'confirmation',p_token_hash,v_generation,
      'odeir-registration-confirmation/'||v_request.id::text||'/'||v_generation,
      'resend','sending',1,now()
    ) returning * into v_delivery;
  end if;

  return jsonb_build_object(
    'deliveryId',v_delivery.id,
    'generation',v_delivery.generation,
    'attempt',v_delivery.attempt_count,
    'idempotencyKey',v_delivery.idempotency_key,
    'status',v_delivery.status,
    'sendRequired',true,
    'accepted',false,
    'inFlight',false
  );
end;
$$;

-- Complete exactly the attempt returned by begin().  Accepted is monotonic:
-- neither a stale failure nor a provider retry can downgrade it.  Provider
-- acceptance and email_confirmation_sent_at are committed atomically, closing
-- the crash window that previously rotated an already-mailed token.
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
  v_request_id uuid;
  v_locked_request_id uuid;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_marked boolean;
begin
  if p_attempt is null or p_attempt<1 or p_outcome is null
     or p_outcome not in ('accepted','failed') then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;
  if p_http_status is not null
     and p_http_status not between 100 and 599 then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select delivery.request_id into v_request_id
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  -- Match begin() lock order to avoid request/delivery deadlocks.
  select request.id into v_locked_request_id
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  if v_locked_request_id is null then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id
  for update;
  if v_delivery.id is null or v_delivery.request_id<>v_request_id then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  if v_delivery.status='accepted' then
    v_marked:=public.v1_registration_mark_confirmation_sent(
      v_delivery.request_id,v_delivery.confirmation_token_hash
    );
    if v_marked is not true then
      raise exception 'registration_confirmation_delivery_invalid';
    end if;
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'status',v_delivery.status,
      'attempt',v_delivery.attempt_count,
      'accepted',true,
      'stale',p_attempt<>v_delivery.attempt_count,
      'providerMessageId',v_delivery.provider_message_id
    );
  end if;

  if p_attempt>v_delivery.attempt_count then
    raise exception 'registration_confirmation_delivery_invalid';
  end if;

  if p_outcome='failed' and v_delivery.attempt_count<>p_attempt then
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'status',v_delivery.status,
      'attempt',v_delivery.attempt_count,
      'accepted',false,
      'stale',true
    );
  end if;

  if p_outcome='accepted' then
    if p_http_status is null or p_http_status not between 200 and 299
       or p_provider_message_id is null
       or p_provider_message_id !~
         '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$' then
      raise exception 'registration_confirmation_delivery_invalid';
    end if;

    update platform.registration_email_deliveries delivery
    set status='accepted',
        provider_message_id=p_provider_message_id,
        accepted_at=coalesce(delivery.accepted_at,now()),
        failed_at=null,
        last_http_status=p_http_status,
        last_error_code=null,
        updated_at=now()
    where delivery.id=v_delivery.id
    returning * into v_delivery;

    v_marked:=public.v1_registration_mark_confirmation_sent(
      v_delivery.request_id,v_delivery.confirmation_token_hash
    );
    if v_marked is not true then
      raise exception 'registration_confirmation_delivery_invalid';
    end if;
  else
    if p_error_code is null
       or p_error_code !~ '^[a-z0-9][a-z0-9_]{0,79}$' then
      raise exception 'registration_confirmation_delivery_invalid';
    end if;
    update platform.registration_email_deliveries delivery
    set status='failed',
        failed_at=now(),
        last_http_status=p_http_status,
        last_error_code=p_error_code,
        updated_at=now()
    where delivery.id=v_delivery.id
    returning * into v_delivery;
  end if;

  return jsonb_build_object(
    'deliveryId',v_delivery.id,
    'status',v_delivery.status,
    'attempt',v_delivery.attempt_count,
    'accepted',v_delivery.status='accepted',
    'stale',false,
    'providerMessageId',v_delivery.provider_message_id
  );
end;
$$;

revoke all on function public.v1_registration_mark_confirmation_sent(uuid,text)
from public,anon,authenticated;
grant execute on function public.v1_registration_mark_confirmation_sent(uuid,text)
to service_role;

revoke all on function public.v1_registration_email_delivery_begin(uuid,text)
from public,anon,authenticated;
revoke all on function public.v1_registration_email_delivery_begin(uuid,text)
from service_role;
grant execute on function public.v1_registration_email_delivery_begin(uuid,text)
to service_role;

revoke all on function public.v1_registration_email_delivery_finish(
  uuid,integer,text,text,integer,text
)
from public,anon,authenticated;
revoke all on function public.v1_registration_email_delivery_finish(
  uuid,integer,text,text,integer,text
)
from service_role;
grant execute on function public.v1_registration_email_delivery_finish(
  uuid,integer,text,text,integer,text
)
to service_role;

comment on function public.v1_registration_email_delivery_begin(uuid,text) is
'Service-role transport reservation for one hashed ODEIR confirmation token. Returns a stable provider idempotency key and attempt number.';
comment on function public.v1_registration_email_delivery_finish(
  uuid,integer,text,text,integer,text
) is
'Service-role transport completion. Accepted is monotonic and atomically marks the confirmation email as sent.';

commit;
