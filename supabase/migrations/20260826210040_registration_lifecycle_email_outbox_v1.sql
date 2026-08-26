begin;

set local lock_timeout='5s';

-- Extend the already private, durable registration outbox instead of creating
-- a second sender.  Lifecycle messages keep the same leases, retries,
-- idempotency keys, signed Resend webhook evidence, and tenant isolation as
-- confirmation mail.  No recipient, message body, URL, or bearer token is
-- persisted in this table.
alter table platform.registration_email_deliveries
  add column if not exists invitation_id uuid
    references access_control.tenant_invitations(id) on delete restrict,
  add column if not exists source_version integer
    check (source_version is null or source_version>0);

alter table platform.registration_email_deliveries
  add constraint registration_email_deliveries_message_kind_check_v2
  check (message_kind in (
    'confirmation','review_receipt','owner_invitation'
  )) not valid;
alter table platform.registration_email_deliveries
  validate constraint registration_email_deliveries_message_kind_check_v2;
alter table platform.registration_email_deliveries
  drop constraint if exists registration_email_deliveries_message_kind_check;
alter table platform.registration_email_deliveries
  rename constraint registration_email_deliveries_message_kind_check_v2
  to registration_email_deliveries_message_kind_check;

alter table platform.registration_email_deliveries
  add constraint registration_email_delivery_invitation_scope_check
  check (
    (message_kind='owner_invitation' and invitation_id is not null)
    or (message_kind<>'owner_invitation' and invitation_id is null)
  ) not valid;
alter table platform.registration_email_deliveries
  validate constraint registration_email_delivery_invitation_scope_check;

create unique index if not exists
platform_registration_email_source_version_idx
on platform.registration_email_deliveries(
  request_id,message_kind,source_version
)
where source_version is not null;

create index if not exists
platform_registration_email_invitation_idx
on platform.registration_email_deliveries(invitation_id,generation desc)
where invitation_id is not null;

-- Lifecycle delivery milestones are immutable operational evidence.  They do
-- not change request state and never provision a tenant.
alter table platform.registration_request_events
  add constraint registration_request_events_action_check_v2 check (action in (
    'submitted','imported','email_confirmation_sent','email_confirmed',
    'start_review','approve','approve_and_activate','reject','reopen',
    'provision','auto_provision','trust_start','trust_approve','trust_restrict',
    'manual_trust_repair','email_fallback_manual','reissue_owner_invitation',
    'review_receipt_sent','owner_invitation_email_sent'
  )) not valid;
alter table platform.registration_request_events
  validate constraint registration_request_events_action_check_v2;
alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check;
alter table platform.registration_request_events
  rename constraint registration_request_events_action_check_v2
  to registration_request_events_action_check;

create or replace function private_app.registration_review_receipt_enqueue(
  p_request_id uuid,
  p_source_version integer
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_key_version smallint;
  v_generation integer;
  v_delivery_id uuid;
begin
  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id;

  if v_request.id is null
     or p_source_version is null
     or p_source_version<>v_request.version
     or v_request.institution_state<>'existing'
     or v_request.activation_mode<>'manual_review'
     or v_request.status not in ('pending_review','under_review','approved')
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_review_receipt_not_allowed';
  end if;

  select delivery.id into v_delivery_id
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='review_receipt'
    and delivery.source_version=p_source_version
  limit 1;
  if v_delivery_id is not null then
    return v_delivery_id;
  end if;

  select setting.email_token_key_version into v_key_version
  from platform.registration_settings setting
  where setting.singleton;
  if coalesce(v_key_version,0) not between 1 and 32767 then
    raise exception 'registration_review_receipt_configuration_invalid';
  end if;

  select coalesce(max(delivery.generation),0)+1 into v_generation
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='review_receipt';

  insert into platform.registration_email_deliveries(
    request_id,message_kind,generation,key_version,token_nonce,
    token_expires_at,template_version,idempotency_key,state,retry_at,
    source_version
  ) values (
    v_request.id,'review_receipt',v_generation,v_key_version,
    encode(extensions.gen_random_bytes(32),'hex'),
    now()+interval '30 days','registration-review-receipt-ar-v1',
    'odeir-registration-review-receipt/'||v_request.id::text||'/'||
      v_generation,
    'queued',now(),p_source_version
  )
  on conflict (request_id,message_kind,source_version)
    where source_version is not null
  do update set updated_at=platform.registration_email_deliveries.updated_at
  returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;

revoke all on function private_app.registration_review_receipt_enqueue(
  uuid,integer
) from public,anon,authenticated,service_role;

create or replace function private_app.registration_owner_invitation_email_enqueue(
  p_request_id uuid,
  p_invitation_id uuid,
  p_source_version integer
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_invitation access_control.tenant_invitations%rowtype;
  v_key_version smallint;
  v_generation integer;
  v_delivery_id uuid;
begin
  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id;

  if v_request.id is null
     or p_source_version is null
     or p_source_version<>v_request.version
     or v_request.status<>'converted'
     or v_request.provisioned_tenant_id is null
     or v_request.metadata->>'ownerProvisioningStatus'<>'invited'
     or v_request.metadata->>'ownerInvitationId' is distinct from
       p_invitation_id::text then
    raise exception 'registration_owner_invitation_email_not_allowed';
  end if;

  select invitation.* into v_invitation
  from access_control.tenant_invitations invitation
  where invitation.id=p_invitation_id
    and invitation.tenant_id=v_request.provisioned_tenant_id
    and invitation.role_key='tenant_owner'
    and invitation.status='pending';
  if v_invitation.id is null or v_invitation.expires_at<=now() then
    raise exception 'registration_owner_invitation_email_not_allowed';
  end if;

  select delivery.id into v_delivery_id
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='owner_invitation'
    and delivery.source_version=p_source_version
  limit 1;
  if v_delivery_id is not null then
    return v_delivery_id;
  end if;

  select setting.email_token_key_version into v_key_version
  from platform.registration_settings setting
  where setting.singleton;
  if coalesce(v_key_version,0) not between 1 and 32767 then
    raise exception 'registration_owner_invitation_email_configuration_invalid';
  end if;

  -- A reissue invalidates any unsent older generation. Accepted generations
  -- remain immutable provider evidence; their link is invalidated by rotating
  -- the exact invitation hash during binding of the new generation.
  update platform.registration_email_deliveries delivery
  set state='cancelled',
      cancelled_at=coalesce(delivery.cancelled_at,now()),
      lease_id=null,
      lease_expires_at=null,
      updated_at=now()
  where delivery.request_id=v_request.id
    and delivery.message_kind='owner_invitation'
    and delivery.state in ('queued','leased','retryable','terminal_failed');

  select coalesce(max(delivery.generation),0)+1 into v_generation
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='owner_invitation';

  insert into platform.registration_email_deliveries(
    request_id,message_kind,generation,key_version,token_nonce,
    token_expires_at,template_version,idempotency_key,state,retry_at,
    invitation_id,source_version
  ) values (
    v_request.id,'owner_invitation',v_generation,v_key_version,
    encode(extensions.gen_random_bytes(32),'hex'),v_invitation.expires_at,
    'registration-owner-invitation-ar-v1',
    'odeir-registration-owner-invitation/'||v_request.id::text||'/'||
      v_generation,
    'queued',now(),v_invitation.id,p_source_version
  )
  on conflict (request_id,message_kind,source_version)
    where source_version is not null
  do update set updated_at=platform.registration_email_deliveries.updated_at
  returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;

revoke all on function private_app.registration_owner_invitation_email_enqueue(
  uuid,uuid,integer
) from public,anon,authenticated,service_role;

create or replace function private_app.registration_lifecycle_email_on_insert()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.institution_state='existing'
     and new.activation_mode='manual_review'
     and new.status='pending_review'
     and new.provisioned_tenant_id is null then
    perform private_app.registration_review_receipt_enqueue(
      new.id,new.version
    );
  end if;
  return new;
end;
$$;

revoke all on function private_app.registration_lifecycle_email_on_insert()
from public,anon,authenticated,service_role;

drop trigger if exists registration_lifecycle_email_after_insert
on platform.registration_requests;
create trigger registration_lifecycle_email_after_insert
after insert on platform.registration_requests
for each row execute function
private_app.registration_lifecycle_email_on_insert();

create or replace function private_app.registration_owner_email_on_update()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_invitation_id uuid;
begin
  if new.status='converted'
     and new.provisioned_tenant_id is not null
     and new.metadata->>'ownerProvisioningStatus'='invited'
     and coalesce(new.metadata->>'ownerInvitationId','') ~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and (
       old.status is distinct from new.status
       or old.provisioned_tenant_id is distinct from new.provisioned_tenant_id
       or old.metadata->>'ownerInvitationId' is distinct from
          new.metadata->>'ownerInvitationId'
       or old.metadata->>'ownerInvitationReissuedAt' is distinct from
          new.metadata->>'ownerInvitationReissuedAt'
     ) then
    v_invitation_id:=(new.metadata->>'ownerInvitationId')::uuid;
    perform private_app.registration_owner_invitation_email_enqueue(
      new.id,v_invitation_id,new.version
    );
  end if;
  return new;
end;
$$;

revoke all on function private_app.registration_owner_email_on_update()
from public,anon,authenticated,service_role;

drop trigger if exists registration_owner_email_after_update
on platform.registration_requests;
create trigger registration_owner_email_after_update
after update of status,provisioned_tenant_id,metadata
on platform.registration_requests
for each row execute function private_app.registration_owner_email_on_update();

-- Service-only recovery/scheduling contract.  The insert trigger is the
-- atomic guarantee; this RPC returns the exact row so Edge can attempt it
-- immediately and safely repairs pre-rollout open existing requests.
create or replace function public.v1_registration_review_receipt_ensure(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_delivery_id uuid;
begin
  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.request_id=v_request.id
    and delivery.message_kind='review_receipt'
  order by delivery.generation desc
  limit 1;

  if v_delivery.id is null then
    v_delivery_id:=private_app.registration_review_receipt_enqueue(
      v_request.id,v_request.version
    );
    select delivery.* into v_delivery
    from platform.registration_email_deliveries delivery
    where delivery.id=v_delivery_id;
  end if;

  return jsonb_build_object(
    'deliveryId',v_delivery.id,
    'state',v_delivery.state,
    'queued',v_delivery.state in ('queued','leased','retryable'),
    'alreadySent',v_delivery.state='accepted'
  );
end;
$$;

revoke all on function public.v1_registration_review_receipt_ensure(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_review_receipt_ensure(uuid)
to service_role;

create or replace function private_app.registration_lifecycle_email_delivery_contract(
  p_delivery_id uuid,
  p_presented_lease_id uuid default null
)
returns jsonb
language sql
security definer
set search_path=''
stable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'deliveryId',delivery.id,
    'requestId',delivery.request_id,
    'messageKind',delivery.message_kind,
    'invitationId',delivery.invitation_id,
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
    'recipient',case when delivery.message_kind='owner_invitation'
      then invitation.email else request.contact_email end,
    'contactName',case when delivery.message_kind='owner_invitation'
      then invitation.full_name else request.contact_name end,
    'institutionName',case when delivery.message_kind='owner_invitation'
      then tenant.name else request.institution_name end,
    'tenantSlug',tenant.slug,
    'reference',request.request_reference
  ))
  from platform.registration_email_deliveries delivery
  join platform.registration_requests request on request.id=delivery.request_id
  left join access_control.tenant_invitations invitation
    on invitation.id=delivery.invitation_id
  left join core.tenants tenant on tenant.id=invitation.tenant_id
  where delivery.id=p_delivery_id
$$;

revoke all on function private_app.registration_lifecycle_email_delivery_contract(
  uuid,uuid
) from public,anon,authenticated,service_role;

-- Confirmation cancellation must remain scoped to confirmation capabilities.
-- Owner-invitation and review-receipt rows are independent lifecycle messages.
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
    and delivery.message_kind='confirmation'
    and delivery.state in (
      'queued','leased','retryable','terminal_failed'
    );
end;
$$;

revoke all on function private_app.registration_email_cancel_siblings(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v2_registration_email_delivery_claim(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request_id uuid;
  v_kind text;
  v_invitation_id uuid;
  v_request platform.registration_requests%rowtype;
  v_invitation access_control.tenant_invitations%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_lease_id uuid;
  v_valid boolean:=false;
begin
  select delivery.request_id,delivery.message_kind,delivery.invitation_id
  into v_request_id,v_kind,v_invitation_id
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;

  -- Keep the battle-tested confirmation state machine byte-for-byte active.
  if v_kind='confirmation' then
    return public.v1_registration_email_delivery_claim(p_delivery_id);
  end if;
  if v_kind not in ('review_receipt','owner_invitation') then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;

  -- Global lock order: request -> invitation (when present) -> delivery.
  select request.* into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  if v_request.id is null then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;

  if v_kind='owner_invitation' then
    select invitation.* into v_invitation
    from access_control.tenant_invitations invitation
    where invitation.id=v_invitation_id
    for update;
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id and delivery.request_id=v_request.id
  for update;
  if v_delivery.id is null then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;

  if v_delivery.state='accepted'
     or v_delivery.state in ('terminal_failed','cancelled') then
    return private_app.registration_lifecycle_email_delivery_contract(
      v_delivery.id,null
    );
  end if;

  if v_kind='review_receipt' then
    v_valid:=v_request.institution_state='existing'
      and v_request.activation_mode='manual_review'
      and v_request.status in ('pending_review','under_review','approved')
      and v_request.provisioned_tenant_id is null;
  else
    v_valid:=v_invitation.id is not null
      and v_request.status='converted'
      and v_request.provisioned_tenant_id=v_invitation.tenant_id
      and v_request.metadata->>'ownerProvisioningStatus'='invited'
      and v_request.metadata->>'ownerInvitationId'=v_invitation.id::text
      and v_invitation.role_key='tenant_owner'
      and v_invitation.status='pending'
      and lower(v_invitation.email)=lower(
        coalesce(v_request.metadata->>'ownerProvisioningEmail','')
      )
      and v_invitation.expires_at>now();
  end if;

  if not coalesce(v_valid,false) or v_delivery.token_expires_at<=now() then
    update platform.registration_email_deliveries delivery
    set state='cancelled',
        cancelled_at=coalesce(delivery.cancelled_at,now()),
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id;
    return private_app.registration_lifecycle_email_delivery_contract(
      v_delivery.id,null
    );
  end if;

  if v_delivery.state='leased' and v_delivery.lease_expires_at>now() then
    return private_app.registration_lifecycle_email_delivery_contract(
      v_delivery.id,null
    );
  end if;
  if v_delivery.state='retryable' and v_delivery.retry_at>now() then
    return private_app.registration_lifecycle_email_delivery_contract(
      v_delivery.id,null
    );
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

  return private_app.registration_lifecycle_email_delivery_contract(
    v_delivery.id,v_lease_id
  );
end;
$$;

create or replace function public.v2_registration_email_delivery_bind(
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
  v_kind text;
  v_invitation_id uuid;
  v_request platform.registration_requests%rowtype;
  v_invitation access_control.tenant_invitations%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_content_fingerprint is null
     or p_content_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;

  select delivery.request_id,delivery.message_kind,delivery.invitation_id
  into v_request_id,v_kind,v_invitation_id
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;
  if v_kind='confirmation' then
    return public.v1_registration_email_delivery_bind(
      p_delivery_id,p_lease_id,p_token_hash,p_content_fingerprint
    );
  end if;
  if v_kind not in ('review_receipt','owner_invitation') then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  if v_kind='owner_invitation' then
    select invitation.* into v_invitation
    from access_control.tenant_invitations invitation
    where invitation.id=v_invitation_id
    for update;
  end if;
  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id and delivery.request_id=v_request.id
  for update;

  if v_delivery.id is null or v_delivery.state<>'leased'
     or v_delivery.lease_id is distinct from p_lease_id
     or v_delivery.lease_expires_at<=now()
     or v_delivery.token_expires_at<=now()
     or v_delivery.key_version<1 then
    raise exception 'registration_lifecycle_delivery_lease_invalid';
  end if;
  if v_delivery.confirmation_token_hash is not null
     and v_delivery.confirmation_token_hash<>p_token_hash then
    raise exception 'registration_lifecycle_token_binding_mismatch';
  end if;
  if v_delivery.content_fingerprint is not null
     and v_delivery.content_fingerprint<>p_content_fingerprint then
    raise exception 'registration_lifecycle_content_mismatch';
  end if;

  if v_kind='review_receipt' then
    if v_request.institution_state<>'existing'
       or v_request.activation_mode<>'manual_review'
       or v_request.status not in ('pending_review','under_review','approved')
       or v_request.provisioned_tenant_id is not null then
      raise exception 'registration_review_receipt_not_allowed';
    end if;
  else
    if v_invitation.id is null
       or v_request.status<>'converted'
       or v_request.provisioned_tenant_id is distinct from
          v_invitation.tenant_id
       or v_request.metadata->>'ownerProvisioningStatus'<>'invited'
       or v_request.metadata->>'ownerInvitationId' is distinct from
          v_invitation.id::text
       or v_invitation.role_key<>'tenant_owner'
       or v_invitation.status<>'pending'
       or v_invitation.expires_at<=now() then
      raise exception 'registration_owner_invitation_email_not_allowed';
    end if;

    -- The raw capability exists only in Edge. Binding atomically rotates the
    -- precise pending invitation to its derived hash before any provider call.
    update access_control.tenant_invitations invitation
    set token_hash=p_token_hash,
        expires_at=v_delivery.token_expires_at
    where invitation.id=v_invitation.id
      and invitation.status='pending';
    if not found then
      raise exception 'registration_owner_invitation_email_conflict';
    end if;
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

  return private_app.registration_lifecycle_email_delivery_contract(
    v_delivery.id,p_lease_id
  );
end;
$$;

create or replace function public.v2_registration_email_delivery_finish(
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
  v_kind text;
  v_request platform.registration_requests%rowtype;
  v_delivery platform.registration_email_deliveries%rowtype;
  v_attempt platform.registration_email_delivery_attempts%rowtype;
  v_is_current_lease boolean;
  v_retry_seconds integer;
  v_marked boolean:=false;
  v_action text;
begin
  select delivery.request_id,delivery.message_kind
  into v_request_id,v_kind
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_request_id is null then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;
  if v_kind='confirmation' then
    return public.v1_registration_email_delivery_finish(
      p_delivery_id,p_lease_id,p_outcome,p_provider_message_id,
      p_http_status,p_error_code,p_retry_after_seconds
    );
  end if;
  if v_kind not in ('review_receipt','owner_invitation')
     or p_outcome is null
     or p_outcome not in ('accepted','retryable','terminal_failed')
     or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_retry_after_seconds is not null
       and p_retry_after_seconds not between 1 and 86400) then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;
  if p_outcome='accepted' and (
    p_http_status is null or p_http_status not between 200 and 299
    or p_provider_message_id is null
    or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
  ) then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;
  if p_outcome<>'accepted' and (
    p_error_code is null
    or p_error_code !~ '^[a-z0-9][a-z0-9_]{0,79}$'
  ) then
    raise exception 'registration_lifecycle_delivery_invalid';
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
    raise exception 'registration_lifecycle_delivery_lease_invalid';
  end if;

  v_is_current_lease:=v_delivery.state='leased'
    and v_delivery.lease_id=p_lease_id
    and v_delivery.attempt_count=v_attempt.attempt;

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
      'messageKind',v_delivery.message_kind,
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
      raise exception 'registration_lifecycle_delivery_unbound';
    end if;

    update platform.registration_email_deliveries delivery
    set state='accepted',
        provider_message_id=p_provider_message_id,
        accepted_at=coalesce(delivery.accepted_at,now()),
        failed_at=null,
        cancelled_at=null,
        last_http_status=p_http_status,
        last_error_code=null,
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

    -- Provider acceptance is authoritative even if the timeline insert is
    -- unavailable during a rolling deployment.
    begin
      v_action:=case v_delivery.message_kind
        when 'review_receipt' then 'review_receipt_sent'
        else 'owner_invitation_email_sent' end;
      if not exists(
        select 1
        from platform.registration_request_events event
        where event.request_id=v_request.id
          and event.action=v_action
          and event.metadata->>'deliveryId'=v_delivery.id::text
      ) then
        insert into platform.registration_request_events(
          request_id,action,from_status,to_status,metadata
        ) values (
          v_request.id,v_action,v_request.status,v_request.status,
          jsonb_build_object(
            'deliveryId',v_delivery.id,
            'messageKind',v_delivery.message_kind,
            'provider','resend'
          )
        );
      end if;
      v_marked:=true;
    exception when others then
      v_marked:=false;
    end;
  elsif not v_is_current_lease then
    return jsonb_build_object(
      'deliveryId',v_delivery.id,
      'messageKind',v_delivery.message_kind,
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
    'messageKind',v_delivery.message_kind,
    'state',v_delivery.state,
    'attempt',v_delivery.attempt_count,
    'accepted',v_delivery.state='accepted',
    'stale',false,
    'providerMessageId',v_delivery.provider_message_id,
    'retryAt',v_delivery.retry_at,
    'providerDeliveryState',v_delivery.provider_delivery_state,
    'markerApplied',v_marked
  );
end;
$$;

create or replace function public.v2_registration_email_delivery_fail_safe(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_kind text;
  v_delivery platform.registration_email_deliveries%rowtype;
begin
  select delivery.message_kind into v_kind
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id;
  if v_kind is null then
    raise exception 'registration_lifecycle_delivery_invalid';
  end if;
  if v_kind='confirmation' then
    return public.v1_registration_email_delivery_fail_safe(p_delivery_id);
  end if;

  select delivery.* into v_delivery
  from platform.registration_email_deliveries delivery
  where delivery.id=p_delivery_id
  for update;
  if v_delivery.state='terminal_failed' then
    return jsonb_build_object(
      'handled',true,'state','terminal_failed','requestChanged',false
    );
  end if;
  if v_delivery.token_expires_at<=now()
     and v_delivery.state in ('queued','leased','retryable') then
    update platform.registration_email_deliveries delivery
    set state='terminal_failed',
        failed_at=coalesce(delivery.failed_at,now()),
        last_error_code=case v_delivery.message_kind
          when 'review_receipt' then 'review_receipt_expired'
          else 'owner_invitation_expired' end,
        lease_id=null,
        lease_expires_at=null,
        updated_at=now()
    where delivery.id=v_delivery.id;
    return jsonb_build_object(
      'handled',true,'state','terminal_failed','requestChanged',false
    );
  end if;
  return jsonb_build_object(
    'handled',false,'state',v_delivery.state,'requestChanged',false
  );
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
  v_confirmation jsonb;
  v_deliveries jsonb;
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

  select jsonb_build_object(
    'messageKind',latest.message_kind,
    'state',latest.state,
    'deliveryState',latest.provider_delivery_state,
    'attemptCount',latest.attempt_count,
    'nextAttemptAt',case
      when latest.state in ('queued','retryable') then latest.retry_at
      when latest.state='leased' then latest.lease_expires_at
      else null end,
    'lastErrorCode',latest.last_error_code,
    'acceptedAt',latest.accepted_at,
    'deliveredAt',latest.delivered_at,
    'bouncedAt',latest.bounced_at,
    'complainedAt',latest.complained_at
  ) into v_confirmation
  from platform.registration_email_deliveries latest
  where latest.request_id=p_request_id
    and latest.message_kind='confirmation'
  order by latest.generation desc
  limit 1;

  select coalesce(jsonb_object_agg(
    case latest.message_kind
      when 'confirmation' then 'confirmation'
      when 'review_receipt' then 'reviewReceipt'
      else 'ownerInvitation' end,
    jsonb_build_object(
      'messageKind',latest.message_kind,
      'state',latest.state,
      'deliveryState',latest.provider_delivery_state,
      'attemptCount',latest.attempt_count,
      'nextAttemptAt',case
        when latest.state in ('queued','retryable') then latest.retry_at
        when latest.state='leased' then latest.lease_expires_at
        else null end,
      'lastErrorCode',latest.last_error_code,
      'acceptedAt',latest.accepted_at,
      'deliveredAt',latest.delivered_at,
      'bouncedAt',latest.bounced_at,
      'complainedAt',latest.complained_at
    )
  ),'{}'::jsonb) into v_deliveries
  from (
    select distinct on (delivery.message_kind) delivery.*
    from platform.registration_email_deliveries delivery
    where delivery.request_id=p_request_id
    order by delivery.message_kind,delivery.generation desc
  ) latest;

  return jsonb_build_object(
    'requestId',p_request_id,
    'emailDelivery',v_confirmation,
    'emailDeliveries',v_deliveries
  );
end;
$$;

revoke all on function public.v2_registration_email_delivery_claim(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v2_registration_email_delivery_claim(uuid)
to service_role;

revoke all on function public.v2_registration_email_delivery_bind(
  uuid,uuid,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.v2_registration_email_delivery_bind(
  uuid,uuid,text,text
) to service_role;

revoke all on function public.v2_registration_email_delivery_finish(
  uuid,uuid,text,text,integer,text,integer
) from public,anon,authenticated,service_role;
grant execute on function public.v2_registration_email_delivery_finish(
  uuid,uuid,text,text,integer,text,integer
) to service_role;

revoke all on function public.v2_registration_email_delivery_fail_safe(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v2_registration_email_delivery_fail_safe(uuid)
to service_role;

revoke all on function public.v1_platform_registration_email_delivery_status(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_email_delivery_status(uuid)
to authenticated;

comment on function public.v1_registration_review_receipt_ensure(uuid) is
  'Service-only idempotent recovery for the atomic existing-institution review receipt outbox row.';
comment on function public.v2_registration_email_delivery_claim(uuid) is
  'Claims confirmation, review-receipt, or exact owner-invitation lifecycle mail with request-first locking.';
comment on function public.v2_registration_email_delivery_bind(
  uuid,uuid,text,text
) is 'Binds deterministic lifecycle content and rotates only the exact pending owner invitation before provider I/O.';
comment on function public.v2_registration_email_delivery_finish(
  uuid,uuid,text,text,integer,text,integer
) is 'Persists idempotent Resend evidence without changing registration or tenant state for notification failures.';

commit;
