begin;

-- `platformAccess` remains the privileged cross-tenant bypass and is now
-- limited to the platform owner. Delegated platform employees use the new
-- `platformControlAccess` flag and their explicit platform permissions.
create or replace function public.v2_current_user_context()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_subject access_control.subjects%rowtype;
  v_memberships jsonb;
  v_platform_membership_id uuid;
  v_platform_permissions jsonb;
  v_platform_roles jsonb;
  v_platform_role_label text;
  v_platform_control_access boolean:=false;
  v_platform_full_access boolean:=false;
  v_platform_content_access boolean:=false;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  select *
  into v_subject
  from access_control.subjects
  where auth_user_id=auth.uid()
    and status='active'
  limit 1;

  if v_subject.id is null then
    raise exception 'account_not_linked';
  end if;

  select membership.id
  into v_platform_membership_id
  from access_control.memberships membership
  where membership.subject_id=v_subject.id
    and membership.scope='platform'
    and membership.status='active'
  limit 1;

  select coalesce(
    jsonb_agg(
      distinct role_permission.permission_key
      order by role_permission.permission_key
    ),
    '[]'::jsonb
  )
  into v_platform_permissions
  from access_control.membership_roles membership_role
  join access_control.roles role
    on role.id=membership_role.role_id
  join access_control.role_permissions role_permission
    on role_permission.role_id=role.id
  where membership_role.membership_id=v_platform_membership_id
    and role.scope='platform';

  select coalesce(
    jsonb_agg(distinct role.role_key order by role.role_key),
    '[]'::jsonb
  ),string_agg(distinct role.name_ar,'، ' order by role.name_ar)
  into v_platform_roles,v_platform_role_label
  from access_control.membership_roles membership_role
  join access_control.roles role
    on role.id=membership_role.role_id
  where membership_role.membership_id=v_platform_membership_id
    and role.scope='platform';

  select exists(
    select 1
    from access_control.membership_roles membership_role
    join access_control.roles role
      on role.id=membership_role.role_id
    where membership_role.membership_id=v_platform_membership_id
      and role.scope='platform'
      and role.role_key='platform_owner'
  )
  into v_platform_full_access;

  v_platform_control_access:=
    private_app.has_platform_permission('platform.control.read');

  -- Backwards-compatible snake_case flag is intentionally scoped to the
  -- legacy content API, which still asks for a single platform-admin flag.
  v_platform_content_access:=
    v_platform_full_access
    or private_app.has_platform_permission('platform.content.manage')
    or private_app.has_platform_permission('platform.control.write');

  select coalesce(
    jsonb_agg(item order by item->>'tenantName'),
    '[]'::jsonb
  )
  into v_memberships
  from (
    select jsonb_build_object(
      'membershipId',membership.id,
      'tenantId',tenant.id,
      'tenantSlug',tenant.slug,
      'tenantName',tenant.name,
      'status',membership.status,
      'roles',coalesce((
        select jsonb_agg(role.role_key order by role.role_key)
        from access_control.membership_roles membership_role
        join access_control.roles role
          on role.id=membership_role.role_id
        where membership_role.membership_id=membership.id
      ),'[]'::jsonb),
      'permissions',coalesce((
        select jsonb_agg(
          distinct role_permission.permission_key
          order by role_permission.permission_key
        )
        from access_control.membership_roles membership_role
        join access_control.role_permissions role_permission
          on role_permission.role_id=membership_role.role_id
        where membership_role.membership_id=membership.id
      ),'[]'::jsonb)
    ) item
    from access_control.memberships membership
    join core.tenants tenant
      on tenant.id=membership.tenant_id
    where membership.subject_id=v_subject.id
      and membership.scope='tenant'
      and membership.status='active'
  ) memberships;

  return jsonb_build_object(
    'subject',jsonb_build_object(
      'id',v_subject.id,
      'email',v_subject.email,
      'fullName',v_subject.full_name,
      'status',v_subject.status,
      'mustChangePassword',v_subject.must_change_password
    ),
    'platformAccess',v_platform_full_access,
    'platformControlAccess',v_platform_control_access,
    'platformContentAccess',v_platform_content_access,
    'platform_access',v_platform_content_access,
    'platformMembershipId',v_platform_membership_id,
    'platformPermissions',coalesce(v_platform_permissions,'[]'::jsonb),
    'platformRoles',coalesce(v_platform_roles,'[]'::jsonb),
    'platformRoleLabel',coalesce(v_platform_role_label,''),
    'memberships',v_memberships
  );
end;
$$;

revoke all on function public.v2_current_user_context()
from public,anon,authenticated;
grant execute on function public.v2_current_user_context()
to authenticated;

commit;
