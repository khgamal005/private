begin;

-- Keep owner invitation renewal visible in the immutable registration timeline.
alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check_v2;
alter table platform.registration_request_events
  add constraint registration_request_events_action_check_v2 check (action in (
    'submitted','imported','email_confirmation_sent','email_confirmed',
    'start_review','approve','approve_and_activate','reject','reopen',
    'provision','auto_provision','trust_start','trust_approve','trust_restrict',
    'manual_trust_repair','email_fallback_manual','reissue_owner_invitation'
  )) not valid;
alter table platform.registration_request_events
  validate constraint registration_request_events_action_check_v2;
alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check;
alter table platform.registration_request_events
  rename constraint registration_request_events_action_check_v2
  to registration_request_events_action_check;

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
  v_updated integer;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();
  if v_actor is null then
    raise exception 'platform_subject_not_found';
  end if;

  -- This lock plus the version increment guarantees that two reviewers using
  -- the same screen cannot both rotate the token and invalidate the first copy.
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
     or v_request.activation_mode<>'manual_review' then
    raise exception 'registration_owner_invitation_reissue_not_allowed';
  end if;

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

  v_owner_email:=lower(trim(coalesce(
    v_request.metadata->>'ownerProvisioningEmail',''
  )));
  if v_owner_email='' or v_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'registration_owner_invitation_unavailable';
  end if;

  -- Actual active membership is authoritative. Invitation metadata alone must
  -- never claim that an owner is linked or silently restore a removed role.
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
        'queueStatus','converted',
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

  -- If another active tenant owner replaced the recorded owner, fail closed.
  -- Changing ownership is a separate, higher-risk workflow.
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
        'queueStatus','converted',
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
    -- Preserve a terminal expired row for history and point the request at one
    -- newly issued pending invitation. Revoked rows are deliberately not reset.
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
    jsonb_build_object(
      'tenantId',v_tenant.id,
      'oldInvitationId',v_old_invitation_id,
      'invitationId',v_invitation_id,
      'expiresAt',v_invitation_expires_at
    )
  );

  perform private_app.write_audit(
    'platform.registration_request.owner_invitation_reissued',
    'invitation',v_invitation_id::text,v_tenant.id,
    jsonb_build_object(
      'registrationRequestId',v_request.id,
      'registrationReference',v_request.request_reference,
      'oldInvitationId',v_old_invitation_id,
      'reason','reviewer_requested_reissue'
    )
  );

  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status','converted',
      'queueStatus','converted',
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
'Rotates only the exact current manual-registration owner invitation. It locks and versions the request, verifies live owner membership and tenant provenance, preserves expired history, and never changes tenant ownership or returns a token for linked owners.';

commit;
