begin;

set local lock_timeout='5s';

create or replace function public.v1_platform_registration_owner_invitation_reissue(
  p_request_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_tenant core.tenants%rowtype;
  v_invitation access_control.tenant_invitations%rowtype;
  v_new_invitation access_control.tenant_invitations%rowtype;
  v_actor uuid;
  v_owner_subject_id uuid;
  v_owner_name text;
  v_owner_email text;
  v_invitation_token text;
  v_invitation_id uuid;
  v_old_invitation_id uuid;
  v_invitation_expires_at timestamptz;
  v_confirmed_delivery_id uuid;
  v_queue_status text;
  v_updated integer;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();
  if v_actor is null then
    raise exception 'platform_subject_not_found';
  end if;

  -- Serialize invitation rotation with every other request decision.  The
  -- expected version makes a stale reviewer response fail instead of rotating
  -- a token that a newer screen has already replaced.
  select request.*
  into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;

  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.status<>'converted'
     or v_request.provisioned_tenant_id is null
     or v_request.activation_mode is null
     or v_request.activation_mode not in (
       'manual_review','email_verified_trial'
     ) then
    raise exception 'registration_owner_invitation_reissue_not_allowed';
  end if;

  v_queue_status:=case
    when v_request.activation_mode='email_verified_trial'
      and v_request.trust_status='pending_review' then 'trust_pending'
    when v_request.activation_mode='email_verified_trial'
      and v_request.trust_status='under_review' then 'trust_review'
    when v_request.activation_mode='email_verified_trial'
      and v_request.trust_status='restricted' then 'trust_restricted'
    else 'converted'
  end;

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.id=v_request.provisioned_tenant_id
  for update;

  if v_tenant.id is null then
    raise exception 'registration_activation_target_missing';
  end if;
  if v_tenant.status<>'active' then
    raise exception 'registration_owner_invitation_reissue_not_allowed';
  end if;

  if v_request.activation_mode='manual_review' then
    -- Preserve the established manual-activation provenance contract exactly.
    if v_tenant.settings->>'registrationRequestId' is distinct from
         v_request.id::text
       or v_tenant.settings->>'registrationActivationMode' is distinct from
         'manual_review'
       or v_tenant.settings->>'registrationResolution' is distinct from
         'create_new'
       or v_request.metadata->>'manualActivationResolution' is distinct from
         'create_new' then
      raise exception 'registration_owner_invitation_provenance_mismatch';
    end if;
  else
    -- Email-verified workspaces must prove the complete immutable chain:
    -- new request -> accepted delivery -> consumed alias -> exact active tenant.
    -- No existing-institution or external-account request can enter this path.
    if v_request.institution_state is distinct from 'new'
       or v_request.external_account_id is not null
       or v_request.email_confirmed_at is null
       or v_request.email_confirmation_token_hash is not null
       or v_request.email_confirmation_expires_at is not null
       or v_request.trust_status is null
       or v_request.trust_status not in (
         'pending_review','under_review','trusted'
       )
       or v_tenant.settings->>'registrationRequestId' is distinct from
         v_request.id::text
       or v_tenant.settings->>'registrationActivationMode' is distinct from
         'email_verified_trial'
       or v_tenant.settings->>'registrationTrustStatus' is distinct from
         v_request.trust_status
       or lower(trim(coalesce(
            v_request.metadata->>'ownerProvisioningEmail',''
          ))) is distinct from lower(trim(v_request.contact_email))
       or v_request.metadata->>'ownerProvisioningStatus' is null
       or v_request.metadata->>'ownerProvisioningStatus' not in (
         'invited','linked'
       ) then
      raise exception 'registration_owner_invitation_provenance_mismatch';
    end if;

    -- Validate before casting.  Keeping this in its own statement prevents an
    -- invalid metadata value from being cast if the planner reorders boolean
    -- predicates inside a larger expression.
    if coalesce(v_request.metadata->>'confirmedDeliveryId','') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'registration_owner_invitation_provenance_mismatch';
    end if;
    v_confirmed_delivery_id:=
      (v_request.metadata->>'confirmedDeliveryId')::uuid;

    if not exists(
      select 1
      from platform.registration_email_deliveries delivery
      join platform.registration_confirmation_token_aliases alias
        on alias.delivery_id=delivery.id
       and alias.request_id=delivery.request_id
       and alias.token_hash=delivery.confirmation_token_hash
      where delivery.id=v_confirmed_delivery_id
        and delivery.request_id=v_request.id
        and delivery.message_kind='confirmation'
        and delivery.state='accepted'
        and delivery.provider_message_id is not null
        and delivery.accepted_at is not null
        and delivery.confirmation_token_hash is not null
        and alias.consumed_at is not null
    ) then
      raise exception 'registration_owner_invitation_provenance_mismatch';
    end if;
  end if;

  v_owner_email:=lower(trim(coalesce(
    v_request.metadata->>'ownerProvisioningEmail',''
  )));
  if v_owner_email=''
     or v_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'registration_owner_invitation_unavailable';
  end if;

  -- Actual active membership remains authoritative for both activation modes.
  select subject.id,subject.full_name
  into v_owner_subject_id,v_owner_name
  from access_control.subjects subject
  join access_control.memberships membership
    on membership.subject_id=subject.id
  join access_control.membership_roles membership_role
    on membership_role.membership_id=membership.id
  join access_control.roles role
    on role.id=membership_role.role_id
  where membership.tenant_id=v_tenant.id
    and membership.scope='tenant'
    and membership.status='active'
    and subject.status='active'
    and lower(subject.email)=v_owner_email
    and role.scope='tenant'
    and role.role_key='tenant_owner'
    and (role.tenant_id is null or role.tenant_id=v_tenant.id)
  order by membership.created_at
  limit 1;

  if v_owner_subject_id is not null then
    return jsonb_build_object(
      'request',jsonb_build_object(
        'id',v_request.id,
        'reference',v_request.request_reference,
        'status','converted',
        'queueStatus',v_queue_status,
        'trustStatus',v_request.trust_status,
        'activationMode',v_request.activation_mode,
        'version',v_request.version,
        'provisionedTenantId',v_tenant.id,
        'provisionedTenantSlug',v_tenant.slug
      ),
      'provisioning',jsonb_build_object(
        'id',v_tenant.id,
        'slug',v_tenant.slug,
        'name',v_tenant.name,
        'status',v_tenant.status,
        'resolution','create_new',
        'activationMode',v_request.activation_mode,
        'owner',jsonb_build_object(
          'status','linked',
          'name',v_owner_name,
          'email',v_owner_email
        )
      )
    );
  end if;

  -- A different active tenant owner is never replaced by this recovery path.
  if exists(
    select 1
    from access_control.memberships membership
    join access_control.membership_roles membership_role
      on membership_role.membership_id=membership.id
    join access_control.roles role
      on role.id=membership_role.role_id
    join access_control.subjects subject
      on subject.id=membership.subject_id
    where membership.tenant_id=v_tenant.id
      and membership.scope='tenant'
      and membership.status='active'
      and subject.status='active'
      and role.scope='tenant'
      and role.role_key='tenant_owner'
      and (role.tenant_id is null or role.tenant_id=v_tenant.id)
  ) then
    raise exception 'registration_owner_identity_conflict';
  end if;

  if v_request.metadata->>'ownerProvisioningStatus'='linked' then
    raise exception 'registration_owner_access_inactive';
  end if;
  if coalesce(v_request.metadata->>'ownerInvitationId','') !~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'registration_owner_invitation_unavailable';
  end if;

  v_old_invitation_id:=(v_request.metadata->>'ownerInvitationId')::uuid;
  select invitation.*
  into v_invitation
  from access_control.tenant_invitations invitation
  where invitation.id=v_old_invitation_id
    and invitation.tenant_id=v_tenant.id
    and invitation.role_key='tenant_owner'
    and invitation.email=v_owner_email
  for update;

  if v_invitation.id is null then
    raise exception 'registration_owner_invitation_unavailable';
  end if;

  -- Acceptance may have committed while this transaction waited for the exact
  -- invitation lock, so verify live membership again before deciding.
  if v_invitation.status='accepted' then
    v_owner_subject_id:=null;
    v_owner_name:=null;
    select subject.id,subject.full_name
    into v_owner_subject_id,v_owner_name
    from access_control.subjects subject
    join access_control.memberships membership
      on membership.subject_id=subject.id
    join access_control.membership_roles membership_role
      on membership_role.membership_id=membership.id
    join access_control.roles role
      on role.id=membership_role.role_id
    where membership.tenant_id=v_tenant.id
      and membership.scope='tenant'
      and membership.status='active'
      and subject.status='active'
      and lower(subject.email)=v_owner_email
      and role.scope='tenant'
      and role.role_key='tenant_owner'
      and (role.tenant_id is null or role.tenant_id=v_tenant.id)
    order by membership.created_at
    limit 1;

    if v_owner_subject_id is null then
      raise exception 'registration_owner_access_inactive';
    end if;
    return jsonb_build_object(
      'request',jsonb_build_object(
        'id',v_request.id,
        'reference',v_request.request_reference,
        'status','converted',
        'queueStatus',v_queue_status,
        'trustStatus',v_request.trust_status,
        'activationMode',v_request.activation_mode,
        'version',v_request.version,
        'provisionedTenantId',v_tenant.id,
        'provisionedTenantSlug',v_tenant.slug
      ),
      'provisioning',jsonb_build_object(
        'id',v_tenant.id,
        'slug',v_tenant.slug,
        'name',v_tenant.name,
        'status',v_tenant.status,
        'resolution','create_new',
        'activationMode',v_request.activation_mode,
        'owner',jsonb_build_object(
          'status','linked',
          'name',v_owner_name,
          'email',v_owner_email
        )
      )
    );
  end if;

  if v_invitation.status='revoked' then
    raise exception 'registration_owner_invitation_revoked';
  end if;
  if v_invitation.status not in ('pending','expired') then
    raise exception 'registration_owner_invitation_unavailable';
  end if;

  v_invitation_token:=encode(extensions.gen_random_bytes(32),'hex');
  v_invitation_expires_at:=now()+interval '7 days';

  if v_invitation.status='pending' then
    update access_control.tenant_invitations invitation
    set token_hash=encode(
          extensions.digest(v_invitation_token,'sha256'),'hex'
        ),
        expires_at=v_invitation_expires_at,
        invited_by_subject_id=v_actor,
        accepted_by_subject_id=null,
        accepted_at=null
    where invitation.id=v_invitation.id
      and invitation.status='pending';
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'registration_owner_invitation_conflict';
    end if;
    v_invitation_id:=v_invitation.id;
  else
    -- Preserve the terminal expired row and create one new pending invitation.
    begin
      insert into access_control.tenant_invitations(
        tenant_id,email,full_name,role_key,token_hash,status,expires_at,
        invited_by_subject_id
      ) values (
        v_tenant.id,v_invitation.email,v_invitation.full_name,'tenant_owner',
        encode(extensions.digest(v_invitation_token,'sha256'),'hex'),
        'pending',v_invitation_expires_at,v_actor
      ) returning * into v_new_invitation;
    exception when unique_violation then
      raise exception 'registration_owner_invitation_conflict';
    end;
    v_invitation_id:=v_new_invitation.id;
  end if;

  update platform.registration_requests request
  set version=request.version+1,
      metadata=request.metadata||jsonb_build_object(
        'ownerProvisioningStatus','invited',
        'ownerInvitationId',v_invitation_id::text,
        'ownerInvitationReissuedAt',now(),
        'ownerInvitationReissuedBySubjectId',v_actor
      )
  where request.id=v_request.id
    and request.version=p_expected_version
  returning request.* into v_request;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'registration_request_conflict';
  end if;

  insert into platform.registration_request_events(
    request_id,actor_subject_id,action,from_status,to_status,metadata
  ) values (
    v_request.id,v_actor,'reissue_owner_invitation','converted','converted',
    jsonb_strip_nulls(jsonb_build_object(
      'tenantId',v_tenant.id,
      'oldInvitationId',v_old_invitation_id,
      'invitationId',v_invitation_id,
      'expiresAt',v_invitation_expires_at,
      'activationMode',v_request.activation_mode,
      'confirmedDeliveryId',case
        when v_request.activation_mode='email_verified_trial'
          then v_confirmed_delivery_id
        else null
      end
    ))
  );

  perform private_app.write_audit(
    'platform.registration_request.owner_invitation_reissued',
    'invitation',v_invitation_id::text,v_tenant.id,
    jsonb_strip_nulls(jsonb_build_object(
      'registrationRequestId',v_request.id,
      'registrationReference',v_request.request_reference,
      'oldInvitationId',v_old_invitation_id,
      'activationMode',v_request.activation_mode,
      'confirmedDeliveryId',case
        when v_request.activation_mode='email_verified_trial'
          then v_confirmed_delivery_id
        else null
      end,
      'reason','reviewer_requested_reissue'
    ))
  );

  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status','converted',
      'queueStatus',v_queue_status,
      'trustStatus',v_request.trust_status,
      'activationMode',v_request.activation_mode,
      'version',v_request.version,
      'provisionedTenantId',v_tenant.id,
      'provisionedTenantSlug',v_tenant.slug
    ),
    'provisioning',jsonb_build_object(
      'id',v_tenant.id,
      'slug',v_tenant.slug,
      'name',v_tenant.name,
      'status',v_tenant.status,
      'resolution','create_new',
      'activationMode',v_request.activation_mode,
      'owner',jsonb_build_object(
        'status','invited',
        'name',v_invitation.full_name,
        'email',v_owner_email,
        'invitationId',v_invitation_id,
        'invitationToken',v_invitation_token,
        'invitationExpiresAt',v_invitation_expires_at
      )
    )
  );
end;
$$;

revoke all on function public.v1_platform_registration_owner_invitation_reissue(
  uuid,integer
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_owner_invitation_reissue(
  uuid,integer
) to authenticated;

comment on function public.v1_platform_registration_owner_invitation_reissue(
  uuid,integer
) is
'Rotates only the exact current owner invitation for a provenance-verified manual or email-confirmed registration tenant; it never changes tenant ownership or returns a token for linked owners.';

-- Keep the already-reviewed provisioning implementation private and expose a
-- small serialization gate under the stable public RPC name.  This removes
-- the old ambiguous-success replay path without duplicating the provisioning
-- transaction or changing any tenant-selection logic.
alter function public.v1_registration_confirm_email_and_provision(text)
  set schema private_app;

alter function private_app.v1_registration_confirm_email_and_provision(text)
  rename to registration_confirm_email_and_provision_legacy;

revoke all on function
  private_app.registration_confirm_email_and_provision_legacy(text)
from public,anon,authenticated,service_role;

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
  v_request_id uuid;
  v_delivery_id uuid;
  v_consumed_at timestamptz;
  v_expires_at timestamptz;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_invalid';
  end if;

  v_hash:=encode(extensions.digest(p_token,'sha256'),'hex');

  -- Every confirmation for the same capability must pass this transaction
  -- lock.  A concurrent retry therefore observes the committed consumption
  -- from the first transaction and cannot rotate or reveal a fresh owner
  -- invitation token.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:registration-confirmation:'||v_hash,
      0
    )
  );

  -- The production outbox always binds sent tokens to aliases.  Tokens from
  -- the retired pre-ledger path are rejected instead of being admitted to a
  -- compatibility replay branch.
  select alias.id,alias.request_id,alias.delivery_id
  into v_alias_id,v_request_id,v_delivery_id
  from platform.registration_confirmation_token_aliases alias
  where alias.token_hash=v_hash
  limit 1;

  if v_alias_id is null or v_request_id is null or v_delivery_id is null then
    raise exception 'registration_confirmation_invalid';
  end if;

  -- Match every mutation touching confirmation aliases: request first, alias
  -- second.  Holding both locks while the private implementation runs closes
  -- the check/use race with cancellation, fallback, and concurrent clicks.
  perform 1
  from platform.registration_requests request
  where request.id=v_request_id
  for update;
  if not found then
    raise exception 'registration_confirmation_invalid';
  end if;

  select alias.consumed_at,alias.expires_at
  into v_consumed_at,v_expires_at
  from platform.registration_confirmation_token_aliases alias
  where alias.id=v_alias_id
    and alias.request_id=v_request_id
    and alias.delivery_id=v_delivery_id
    and alias.token_hash=v_hash
  for update;
  if not found then
    raise exception 'registration_confirmation_invalid';
  end if;

  if v_consumed_at is not null then
    raise exception 'registration_confirmation_already_used';
  end if;
  if v_expires_at<=clock_timestamp() then
    raise exception 'registration_confirmation_invalid';
  end if;

  return private_app.registration_confirm_email_and_provision_legacy(p_token);
end;
$$;

revoke all on function public.v1_registration_confirm_email_and_provision(text)
from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_confirm_email_and_provision(text)
to service_role;

comment on function public.v1_registration_confirm_email_and_provision(text) is
  'Strict one-time email confirmation gate; consumed capabilities cannot replay or rotate an owner invitation.';

commit;
