begin;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values (
  'tenant.users.reset_password',
  'access',
  'إعادة تعيين كلمات مرور الموظفين',
  'إنشاء كلمة مرور مؤقتة لموظف وإلزامه بتغييرها عند أول دخول'
)
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, 'tenant.users.reset_password'
from access_control.roles r
where r.scope = 'tenant'
  and r.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  )
on conflict do nothing;

create or replace function private_app.tenant_role_rank(p_role_key text)
returns integer
language sql
immutable
set search_path = ''
as $$
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
$$;

revoke all on function private_app.tenant_role_rank(text)
from public, anon, authenticated;

create or replace function private_app.has_platform_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

create or replace function private_app.can_access_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects s
      join access_control.memberships m
        on m.subject_id = s.id
       and m.scope = 'tenant'
       and m.status = 'active'
      where s.auth_user_id = auth.uid()
        and s.status = 'active'
        and not s.must_change_password
        and m.tenant_id = p_tenant_id
    )
  )
$$;

create or replace function private_app.has_tenant_permission(
  p_tenant_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
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
      where s.auth_user_id = auth.uid()
        and s.status = 'active'
        and not s.must_change_password
        and m.tenant_id = p_tenant_id
        and rp.permission_key = p_permission
    )
  )
$$;

create or replace function public.v2_tenant_prepare_staff_password_reset(
  p_tenant_slug text,
  p_staff_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.v2_tenant_complete_staff_password_reset(
  p_tenant_id uuid,
  p_staff_id uuid,
  p_target_auth_user_id uuid,
  p_actor_subject_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.v2_tenant_prepare_staff_password_reset(
  text,
  uuid
) from public, anon, authenticated;
grant execute on function public.v2_tenant_prepare_staff_password_reset(
  text,
  uuid
) to authenticated;

revoke all on function public.v2_tenant_complete_staff_password_reset(
  uuid,
  uuid,
  uuid,
  uuid
) from public, anon, authenticated;
grant execute on function public.v2_tenant_complete_staff_password_reset(
  uuid,
  uuid,
  uuid,
  uuid
) to service_role;

commit;
