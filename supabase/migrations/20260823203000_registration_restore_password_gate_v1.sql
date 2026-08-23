begin;

-- Restore the temporary-password gate while retaining the tenant lifecycle
-- checks added for email-verified trial workspaces.
create or replace function private_app.can_access_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
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
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and membership.tenant_id=p_tenant_id
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
set search_path=''
as $$
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
$$;

revoke all on function private_app.can_access_tenant(uuid)
from public,anon,authenticated;
revoke all on function private_app.has_tenant_permission(uuid,text)
from public,anon,authenticated;

commit;
