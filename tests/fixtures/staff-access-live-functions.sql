CREATE OR REPLACE FUNCTION private_app.tenant_role_rank(p_role_key text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_role_key
    when 'tenant_owner' then 100
    when 'tenant_admin' then 90
    when 'executive_manager' then 80
    when 'sales_manager' then 70
    when 'sales_supervisor' then 60
    when 'training_manager' then 60
    when 'sales_user' then 40
    when 'customer_service' then 40
    when 'data_officer' then 40
    when 'data_analyst' then 40
    else 10
  end
$function$;

CREATE OR REPLACE FUNCTION private_app.has_platform_permission(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and exists (
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
    where s.auth_user_id = auth.uid()
      and s.status = 'active'
      and not s.must_change_password
      and rp.permission_key = p_permission
  )
$function$;

CREATE OR REPLACE FUNCTION private_app.write_audit(p_action text, p_resource_type text, p_resource_id text DEFAULT NULL::text, p_tenant_id uuid DEFAULT NULL::uuid, p_context jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    p_tenant_id,
    private_app.current_subject_id(),
    p_action,
    p_resource_type,
    p_resource_id,
    coalesce(p_context, '{}'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.current_subject_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.id
  from access_control.subjects s
  where auth.uid() is not null
    and s.auth_user_id = auth.uid()
    and s.status = 'active'
  limit 1
$function$;

CREATE OR REPLACE FUNCTION private_app.has_tenant_permission(p_tenant_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
      join core.tenants tenant
        on tenant.id=membership.tenant_id
       and tenant.status in ('trial','active')
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and membership.tenant_id=p_tenant_id
        and role_permission.permission_key=p_permission
    )
  )
$function$;

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
    false
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

CREATE OR REPLACE FUNCTION public.v2_accept_tenant_invitation(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invitation access_control.tenant_invitations%rowtype;
  v_email text;
  v_link jsonb;
  v_tenant_slug text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  select i.*
  into v_invitation
  from access_control.tenant_invitations i
  where i.token_hash = encode(
      extensions.digest(trim(coalesce(p_token, '')), 'sha256'),
      'hex'
    )
    and i.status = 'pending'
  for update
  limit 1;

  if v_invitation.id is null then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.expires_at <= now() then
    update access_control.tenant_invitations
    set status = 'expired'
    where id = v_invitation.id;
    raise exception 'invitation_expired';
  end if;

  if v_email = '' or v_email <> lower(v_invitation.email) then
    raise exception 'invitation_email_mismatch';
  end if;

  v_link := private_app.link_existing_tenant_user(
    v_invitation.tenant_id,
    v_invitation.full_name,
    v_invitation.email,
    v_invitation.role_key
  );

  if not coalesce((v_link ->> 'linked')::boolean, false) then
    raise exception 'account_not_available';
  end if;

  update access_control.tenant_invitations
  set status = 'accepted',
      accepted_by_subject_id = (v_link ->> 'subjectId')::uuid,
      accepted_at = now()
  where id = v_invitation.id;

  update people.staff_profiles
  set membership_id = (v_link ->> 'membershipId')::uuid,
      account_status = 'active'
  where tenant_id = v_invitation.tenant_id
    and lower(email) = lower(v_invitation.email);

  select t.slug
  into v_tenant_slug
  from core.tenants t
  where t.id = v_invitation.tenant_id;

  perform private_app.write_audit(
    'tenant.invitation_accepted',
    'invitation',
    v_invitation.id::text,
    v_invitation.tenant_id,
    jsonb_build_object(
      'email', v_invitation.email,
      'roleKey', v_invitation.role_key
    )
  );

  return jsonb_build_object(
    'status', 'accepted',
    'tenantSlug', v_tenant_slug,
    'membershipId', v_link ->> 'membershipId'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.v2_invitation_preview(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_invitation access_control.tenant_invitations%rowtype;
  v_tenant core.tenants%rowtype;
  v_role_name text;
begin
  if p_token is null or length(trim(p_token)) < 32 then
    raise exception 'invalid_invitation';
  end if;

  select i.*
  into v_invitation
  from access_control.tenant_invitations i
  where i.token_hash = encode(
      extensions.digest(trim(p_token), 'sha256'),
      'hex'
    )
    and i.status = 'pending'
  limit 1;

  if v_invitation.id is null then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.expires_at <= now() then
    raise exception 'invitation_expired';
  end if;

  select *
  into v_tenant
  from core.tenants
  where id = v_invitation.tenant_id;

  select r.name_ar
  into v_role_name
  from access_control.roles r
  where r.scope = 'tenant'
    and r.role_key = v_invitation.role_key
    and (r.tenant_id is null or r.tenant_id = v_invitation.tenant_id)
  order by (r.tenant_id = v_invitation.tenant_id) desc
  limit 1;

  return jsonb_build_object(
    'tenantName', v_tenant.name,
    'tenantSlug', v_tenant.slug,
    'fullName', v_invitation.full_name,
    'email', v_invitation.email,
    'roleKey', v_invitation.role_key,
    'roleName', v_role_name,
    'expiresAt', v_invitation.expires_at
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.sync_staff_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_email text;
  v_role_key text;
  v_auth_confirmed boolean;
begin
  select
    m.tenant_id,
    s.email,
    r.role_key,
    (u.email_confirmed_at is not null)
  into
    v_tenant_id,
    v_email,
    v_role_key,
    v_auth_confirmed
  from access_control.memberships m
  join access_control.subjects s on s.id = m.subject_id
  join auth.users u on u.id = s.auth_user_id
  join access_control.roles r on r.id = new.role_id
  where m.id = new.membership_id
    and m.scope = 'tenant'
  limit 1;

  if v_tenant_id is not null and v_email is not null then
    update people.staff_profiles
    set membership_id = new.membership_id,
        role_key = v_role_key,
        account_status = case
          when v_auth_confirmed then 'active'
          else 'invited'
        end
    where tenant_id = v_tenant_id
      and email = lower(v_email);
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.enforce_tenant_plan_limit(p_tenant_id uuid, p_limit_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit jsonb;
  v_limit_value bigint;
  v_used bigint;
begin
  if p_tenant_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_limit_key,0));
  v_limit:=private_app.current_plan_limit(p_tenant_id,p_limit_key);
  v_limit_value:=nullif(v_limit->>'limitValue','')::bigint;
  if v_limit_value is null
     or coalesce((v_limit->>'enforceable')::boolean,false)=false
     or coalesce(v_limit->>'enforcement','hard')='soft' then
    return;
  end if;
  v_used:=private_app.tenant_plan_usage_count(p_tenant_id,p_limit_key);
  if v_used>=v_limit_value then
    raise exception 'plan_limit_reached';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.enforce_membership_plan_limit_v4()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op='INSERT' and new.scope='tenant' and new.status in ('invited','active') then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_employees');
  elsif tg_op='UPDATE' and new.scope='tenant' and new.status in ('invited','active')
     and (old.scope<>'tenant' or old.status not in ('invited','active') or old.tenant_id is distinct from new.tenant_id) then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_employees');
  end if;
  return new;
end;
$function$;

