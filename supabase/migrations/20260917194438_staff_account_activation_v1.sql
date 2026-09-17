begin;

-- A durable operation contains identity only. Passwords never enter an RPC,
-- staff metadata, the operation row, or the audit log.
create table access_control.staff_account_activations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  staff_id uuid not null unique references people.staff_profiles(id) on delete cascade,
  actor_subject_id uuid not null references access_control.subjects(id),
  email text not null,
  role_key text not null,
  status text not null default 'pending' check (status in ('pending','completed')),
  auth_user_id uuid references auth.users(id),
  credential_fingerprint text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index staff_account_activations_tenant_idx on access_control.staff_account_activations(tenant_id);
create index staff_account_activations_actor_idx on access_control.staff_account_activations(actor_subject_id);
create index staff_account_activations_auth_idx on access_control.staff_account_activations(auth_user_id);
alter table access_control.staff_account_activations enable row level security;
revoke all on access_control.staff_account_activations from public, anon, authenticated;

create function private_app.authorize_staff_activation(p_tenant_slug text,p_staff_id uuid)
returns people.staff_profiles language plpgsql security definer set search_path='' as $$
declare
  t uuid; sp people.staff_profiles%rowtype; actor_rank integer;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select id into t from core.tenants where slug=p_tenant_slug;
  if t is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(t,'tenant.people.manage')
    or not private_app.has_tenant_permission(t,'tenant.users.manage')
    or not private_app.has_tenant_permission(t,'tenant.users.reset_password') then
    raise exception 'forbidden';
  end if;
  select * into sp from people.staff_profiles where id=p_staff_id and tenant_id=t for update;
  if sp.id is null then raise exception 'staff_not_found'; end if;
  if sp.employment_status='inactive' or sp.account_status='suspended' then
    raise exception 'staff_account_suspended';
  end if;
  if sp.email is null or sp.email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;
  if exists(select 1 from people.staff_profiles where tenant_id=t and email=sp.email and id<>sp.id) then
    raise exception 'staff_email_exists';
  end if;
  if not private_app.has_platform_permission('platform.control.read') then
    select coalesce(max(private_app.tenant_role_rank(r.role_key)),0) into actor_rank
    from access_control.memberships m
    join access_control.membership_roles mr on mr.membership_id=m.id
    join access_control.roles r on r.id=mr.role_id and r.scope='tenant'
    where m.tenant_id=t and m.subject_id=private_app.current_subject_id()
      and m.scope='tenant' and m.status='active';
    if actor_rank<=private_app.tenant_role_rank(sp.role_key) then raise exception 'protected_staff_account'; end if;
  end if;
  return sp;
end $$;
revoke all on function private_app.authorize_staff_activation(text,uuid) from public,anon,authenticated;

create function public.v1_tenant_prepare_staff_account(p_tenant_slug text,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  sp people.staff_profiles%rowtype; op access_control.staff_account_activations%rowtype;
  u auth.users%rowtype;
begin
  sp:=private_app.authorize_staff_activation(p_tenant_slug,p_staff_id);
  select * into op from access_control.staff_account_activations where staff_id=sp.id for update;
  if op.id is not null and (op.email<>sp.email or op.role_key<>sp.role_key) then
    raise exception 'activation_staff_changed';
  end if;
  if op.status='completed' and sp.account_status='active' then
    return jsonb_build_object('completed',true,'staffId',sp.id);
  end if;
  -- Serialize same-email creation across tenants; never take over an Auth user.
  perform pg_advisory_xact_lock(hashtextextended('staff-account:'||sp.email,0));
  select * into u from auth.users where lower(email)=sp.email limit 1;
  if u.id is not null and (op.id is null or
    coalesce(u.raw_app_meta_data->>'staff_activation_id','')<>op.id::text) then
    raise exception 'account_already_exists';
  end if;
  if sp.membership_id is not null or sp.account_status='active' then
    if u.id is null or op.id is null or not exists(
      select 1 from access_control.memberships m join access_control.subjects s on s.id=m.subject_id
      where m.id=sp.membership_id and m.tenant_id=sp.tenant_id and s.auth_user_id=u.id
        and m.scope='tenant' and m.status='active'
    ) then raise exception 'staff_account_already_active'; end if;
  else
    perform private_app.enforce_tenant_plan_limit(sp.tenant_id,'max_employees');
  end if;
  if op.id is null then
    insert into access_control.staff_account_activations(tenant_id,staff_id,actor_subject_id,email,role_key)
    values(sp.tenant_id,sp.id,private_app.current_subject_id(),sp.email,sp.role_key) returning * into op;
  end if;
  return jsonb_build_object('operationId',op.id,'email',sp.email,'fullName',sp.full_name,
    'authUserExists',u.id is not null,'staffId',sp.id);
end $$;
revoke all on function public.v1_tenant_prepare_staff_account(text,uuid) from public,anon,authenticated;
grant execute on function public.v1_tenant_prepare_staff_account(text,uuid) to authenticated;

create function public.v1_tenant_complete_staff_account(p_tenant_slug text,p_staff_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  sp people.staff_profiles%rowtype; op access_control.staff_account_activations%rowtype;
  u auth.users%rowtype; linked jsonb;
begin
  sp:=private_app.authorize_staff_activation(p_tenant_slug,p_staff_id);
  select * into op from access_control.staff_account_activations
    where id=p_operation_id and staff_id=sp.id and tenant_id=sp.tenant_id for update;
  if op.id is null then raise exception 'invalid_activation'; end if;
  if op.email<>sp.email or op.role_key<>sp.role_key then raise exception 'activation_staff_changed'; end if;
  if op.status='completed' then
    return jsonb_build_object('staffId',sp.id,'completed',true);
  end if;
  select * into u from auth.users where lower(email)=sp.email and email_confirmed_at is not null
    and raw_app_meta_data->>'staff_activation_id'=op.id::text limit 1;
  if u.id is null then raise exception 'activation_incomplete'; end if;
  if exists(select 1 from access_control.subjects s join access_control.memberships m on m.subject_id=s.id
    where s.auth_user_id=u.id and (m.scope='platform' or m.tenant_id<>sp.tenant_id)) then
    raise exception 'shared_staff_account';
  end if;
  -- The canonical linker and membership trigger enforce capacity again under
  -- a transaction lock, including requests which compete for the final seat.
  linked:=private_app.link_existing_tenant_user(sp.tenant_id,sp.full_name,sp.email,sp.role_key);
  if not coalesce((linked->>'linked')::boolean,false) then raise exception 'account_not_available'; end if;
  update access_control.subjects set must_change_password=true where id=(linked->>'subjectId')::uuid;
  update people.staff_profiles set membership_id=(linked->>'membershipId')::uuid,account_status='active'
    where id=sp.id and tenant_id=sp.tenant_id;
  update access_control.tenant_invitations set status='revoked'
    where tenant_id=sp.tenant_id and lower(email)=sp.email and status='pending';
  update access_control.staff_account_activations set status='completed',auth_user_id=u.id,
    credential_fingerprint=encode(extensions.digest(u.encrypted_password,'sha256'),'hex'),completed_at=now()
    where id=op.id;
  perform private_app.write_audit('tenant.staff_account_created','staff_profile',sp.id::text,sp.tenant_id,
    jsonb_build_object('operationId',op.id,'mustChangePassword',true));
  return jsonb_build_object('staffId',sp.id,'completed',true,'mustChangePassword',true);
end $$;
revoke all on function public.v1_tenant_complete_staff_account(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.v1_tenant_complete_staff_account(text,uuid,uuid) to authenticated;

-- Preview remains readable when full; activation checks capacity before Auth.
create function public.v1_invitation_activation_preflight(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare preview jsonb; i access_control.tenant_invitations%rowtype;
begin
  preview:=public.v2_invitation_preview(p_token);
  select * into i from access_control.tenant_invitations
    where token_hash=encode(extensions.digest(trim(p_token),'sha256'),'hex') and status='pending';
  if i.id is null then raise exception 'invalid_invitation'; end if;
  if not exists(select 1 from access_control.memberships m
    join access_control.subjects s on s.id=m.subject_id
    join auth.users u on u.id=s.auth_user_id
    where m.tenant_id=i.tenant_id and m.scope='tenant' and m.status in ('active','invited')
      and lower(u.email)=lower(i.email)) then
    perform private_app.enforce_tenant_plan_limit(i.tenant_id,'max_employees');
  end if;
  return preview;
end $$;
revoke all on function public.v1_invitation_activation_preflight(text) from public,anon,authenticated;
grant execute on function public.v1_invitation_activation_preflight(text) to anon,authenticated;

-- Calling the completion RPC directly cannot bypass a temporary password.
create or replace function public.v2_mark_password_changed()
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if exists(select 1 from access_control.staff_account_activations op
    join auth.users u on u.id=op.auth_user_id
    where u.id=auth.uid() and op.credential_fingerprint=
      encode(extensions.digest(u.encrypted_password,'sha256'),'hex')) then
    raise exception 'password_change_required';
  end if;
  -- A pending direct activation must finish before its password gate can clear.
  if exists(select 1 from auth.users u join access_control.staff_account_activations op
    on op.id::text=u.raw_app_meta_data->>'staff_activation_id'
    where u.id=auth.uid() and op.status='pending') then raise exception 'activation_incomplete'; end if;
  update access_control.subjects set must_change_password=false where auth_user_id=auth.uid();
  return found;
end $$;
revoke all on function public.v2_mark_password_changed() from public,anon,authenticated;
grant execute on function public.v2_mark_password_changed() to authenticated;

CREATE OR REPLACE FUNCTION private_app.link_existing_tenant_user(p_tenant_id uuid, p_full_name text, p_email text, p_role_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_auth_user_id uuid;
  v_subject_id uuid;
  v_membership_id uuid;
  v_role_id uuid;
begin
  select u.id
  into v_auth_user_id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
    and u.email_confirmed_at is not null
  limit 1;

  if v_auth_user_id is null then
    return jsonb_build_object('linked', false);
  end if;

  insert into access_control.subjects (
    auth_user_id,
    email,
    full_name,
    status,
    must_change_password
  )
  values (
    v_auth_user_id,
    lower(trim(p_email)),
    trim(p_full_name),
    'active',
    exists(select 1 from auth.users u join access_control.staff_account_activations op
      on op.id::text=u.raw_app_meta_data->>'staff_activation_id'
      where u.id=v_auth_user_id and op.status='pending')
  )
  on conflict (auth_user_id) do update
  set email = excluded.email,
      full_name = excluded.full_name,
      status = 'active'
  returning id into v_subject_id;

  select r.id
  into v_role_id
  from access_control.roles r
  where r.scope = 'tenant'
    and r.role_key = p_role_key
    and (r.tenant_id is null or r.tenant_id = p_tenant_id)
  order by (r.tenant_id = p_tenant_id) desc
  limit 1;

  if v_role_id is null then
    raise exception 'invalid_role';
  end if;

  select m.id
  into v_membership_id
  from access_control.memberships m
  where m.subject_id = v_subject_id
    and m.tenant_id = p_tenant_id
    and m.scope = 'tenant'
  limit 1;

  if v_membership_id is null then
    insert into access_control.memberships (
      subject_id,
      tenant_id,
      scope,
      status
    )
    values (
      v_subject_id,
      p_tenant_id,
      'tenant',
      'active'
    )
    returning id into v_membership_id;
  else
    update access_control.memberships
    set status = 'active'
    where id = v_membership_id;
  end if;

  insert into access_control.membership_roles (membership_id, role_id)
  values (v_membership_id, v_role_id)
  on conflict do nothing;

  return jsonb_build_object(
    'linked', true,
    'subjectId', v_subject_id,
    'membershipId', v_membership_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.v2_tenant_complete_staff_password_reset(p_tenant_id uuid, p_staff_id uuid, p_target_auth_user_id uuid, p_actor_subject_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_staff people.staff_profiles%rowtype;
  v_target_subject access_control.subjects%rowtype;
  v_actor_rank integer := 0;
  v_target_rank integer := 0;
  v_actor_is_platform boolean := false;
  v_actor_can_reset boolean := false;
  v_reset_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  select sp.*
  into v_staff
  from people.staff_profiles sp
  join access_control.memberships m
    on m.id = sp.membership_id
   and m.tenant_id = sp.tenant_id
   and m.scope = 'tenant'
   and m.status = 'active'
  join access_control.subjects s
    on s.id = m.subject_id
   and s.status = 'active'
  where sp.id = p_staff_id
    and sp.tenant_id = p_tenant_id
    and sp.account_status = 'active'
    and s.auth_user_id = p_target_auth_user_id
  limit 1;

  if v_staff.id is null then
    raise exception 'staff_account_not_active';
  end if;

  select s.*
  into v_target_subject
  from access_control.memberships m
  join access_control.subjects s
    on s.id = m.subject_id
   and s.status = 'active'
  where m.id = v_staff.membership_id
    and m.tenant_id = p_tenant_id
    and m.scope = 'tenant'
    and m.status = 'active'
    and s.auth_user_id = p_target_auth_user_id
  limit 1;

  if v_target_subject.id is null then
    raise exception 'staff_account_not_active';
  end if;

  if exists(select 1 from access_control.memberships other_membership
    where other_membership.subject_id=v_target_subject.id
      and (other_membership.scope='platform' or other_membership.tenant_id<>p_tenant_id)) then
    raise exception 'shared_staff_account';
  end if;

  if v_target_subject.id = p_actor_subject_id then
    raise exception 'cannot_reset_own_password';
  end if;

  select exists (
    select 1
    from access_control.subjects s
    join access_control.memberships m
      on m.subject_id = s.id
     and m.scope = 'platform'
     and m.status = 'active'
    join access_control.membership_roles mr on mr.membership_id = m.id
    join access_control.roles r
      on r.id = mr.role_id
     and r.scope = 'platform'
    join access_control.role_permissions rp on rp.role_id = r.id
    where s.id = p_actor_subject_id
      and s.status = 'active'
      and rp.permission_key = 'platform.control.read'
  )
  into v_actor_is_platform;

  select exists (
    select 1
    from access_control.subjects s
    join access_control.memberships m
      on m.subject_id = s.id
     and m.scope = 'tenant'
     and m.status = 'active'
    join access_control.membership_roles mr on mr.membership_id = m.id
    join access_control.roles r
      on r.id = mr.role_id
     and r.scope = 'tenant'
    join access_control.role_permissions rp on rp.role_id = r.id
    where s.id = p_actor_subject_id
      and s.status = 'active'
      and m.tenant_id = p_tenant_id
      and rp.permission_key = 'tenant.users.reset_password'
  )
  into v_actor_can_reset;

  if not v_actor_is_platform and not v_actor_can_reset then
    raise exception 'forbidden';
  end if;

  if not v_actor_is_platform then
    select coalesce(max(private_app.tenant_role_rank(r.role_key)), 0)
    into v_actor_rank
    from access_control.memberships m
    join access_control.membership_roles mr on mr.membership_id = m.id
    join access_control.roles r
      on r.id = mr.role_id
     and r.scope = 'tenant'
    where m.tenant_id = p_tenant_id
      and m.subject_id = p_actor_subject_id
      and m.scope = 'tenant'
      and m.status = 'active';

    v_target_rank := private_app.tenant_role_rank(v_staff.role_key);

    if v_actor_rank <= v_target_rank then
      raise exception 'protected_staff_account';
    end if;
  end if;

  update access_control.subjects
  set must_change_password = true
  where id = v_target_subject.id;

  update people.staff_profiles
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'lastPasswordResetAt', v_reset_at,
    'lastPasswordResetBySubjectId', p_actor_subject_id
  )
  where id = v_staff.id;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context,
    occurred_at
  )
  values (
    p_tenant_id,
    p_actor_subject_id,
    'tenant.staff_password_reset',
    'staff_profile',
    v_staff.id::text,
    jsonb_build_object(
      'staffName', v_staff.full_name,
      'email', v_target_subject.email,
      'mustChangePassword', true
    ),
    v_reset_at
  );

  return jsonb_build_object(
    'staffId', v_staff.id,
    'staffName', v_staff.full_name,
    'email', v_target_subject.email,
    'mustChangePassword', true,
    'resetAt', v_reset_at
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.v2_tenant_prepare_staff_password_reset(p_tenant_slug text, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_staff people.staff_profiles%rowtype;
  v_target_subject access_control.subjects%rowtype;
  v_actor_subject_id uuid;
  v_actor_rank integer := 0;
  v_target_rank integer := 0;
  v_platform_access boolean := false;
begin
  select t.id
  into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.users.reset_password'
  ) then
    raise exception 'forbidden';
  end if;

  v_actor_subject_id := private_app.current_subject_id();
  v_platform_access := private_app.has_platform_permission(
    'platform.control.read'
  );

  select sp.*
  into v_staff
  from people.staff_profiles sp
  join access_control.memberships m
    on m.id = sp.membership_id
   and m.tenant_id = sp.tenant_id
   and m.scope = 'tenant'
   and m.status = 'active'
  join access_control.subjects s
    on s.id = m.subject_id
   and s.status = 'active'
  where sp.id = p_staff_id
    and sp.tenant_id = v_tenant_id
    and sp.account_status = 'active'
    and sp.employment_status <> 'inactive'
  limit 1;

  if v_staff.id is null then
    raise exception 'staff_account_not_active';
  end if;

  select s.*
  into v_target_subject
  from access_control.memberships m
  join access_control.subjects s
    on s.id = m.subject_id
   and s.status = 'active'
  where m.id = v_staff.membership_id
    and m.tenant_id = v_tenant_id
    and m.scope = 'tenant'
    and m.status = 'active'
  limit 1;

  if v_target_subject.id is null
     or v_target_subject.auth_user_id is null then
    raise exception 'staff_account_not_active';
  end if;

  if exists(select 1 from access_control.memberships other_membership
    where other_membership.subject_id=v_target_subject.id
      and (other_membership.scope='platform' or other_membership.tenant_id<>v_tenant_id)) then
    raise exception 'shared_staff_account';
  end if;

  if v_target_subject.id = v_actor_subject_id then
    raise exception 'cannot_reset_own_password';
  end if;

  if not v_platform_access then
    select coalesce(max(private_app.tenant_role_rank(r.role_key)), 0)
    into v_actor_rank
    from access_control.memberships m
    join access_control.membership_roles mr on mr.membership_id = m.id
    join access_control.roles r
      on r.id = mr.role_id
     and r.scope = 'tenant'
    where m.tenant_id = v_tenant_id
      and m.subject_id = v_actor_subject_id
      and m.scope = 'tenant'
      and m.status = 'active';

    v_target_rank := private_app.tenant_role_rank(v_staff.role_key);

    if v_actor_rank <= v_target_rank then
      raise exception 'protected_staff_account';
    end if;
  end if;

  return jsonb_build_object(
    'tenantId', v_tenant_id,
    'staffId', v_staff.id,
    'staffName', v_staff.full_name,
    'email', v_target_subject.email,
    'targetAuthUserId', v_target_subject.auth_user_id,
    'actorSubjectId', v_actor_subject_id
  );
end;
$function$;



-- Exact indexed lookup; avoids scanning the Auth directory for every invitation.
create function public.v1_invitation_auth_user(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare preview jsonb; result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required'; end if;
  preview:=public.v2_invitation_preview(p_token);
  select jsonb_build_object('id',u.id,'email',u.email,'email_confirmed_at',u.email_confirmed_at)
  into result from auth.users u where u.email=preview->>'email' limit 1;
  return coalesce(result,'{}'::jsonb);
end $$;
revoke all on function public.v1_invitation_auth_user(text) from public,anon,authenticated;
grant execute on function public.v1_invitation_auth_user(text) to service_role;

revoke all on function private_app.link_existing_tenant_user(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.v2_tenant_prepare_staff_password_reset(text,uuid) from public,anon,authenticated;
grant execute on function public.v2_tenant_prepare_staff_password_reset(text,uuid) to authenticated;
revoke all on function public.v2_tenant_complete_staff_password_reset(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.v2_tenant_complete_staff_password_reset(uuid,uuid,uuid,uuid) to service_role;
commit;
