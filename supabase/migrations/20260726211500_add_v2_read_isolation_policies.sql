begin;

create or replace function private_app.is_linked_subject()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from access_control.subjects s
    where s.auth_user_id = auth.uid()
      and s.status = 'active'
  )
$$;

create or replace function private_app.can_access_organization(p_organization_id uuid)
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
      from core.tenants t
      where t.organization_id = p_organization_id
        and private_app.can_access_tenant(t.id)
    )
  )
$$;

create or replace function private_app.can_read_subject(p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    p_subject_id = private_app.current_subject_id()
    or private_app.has_platform_permission('platform.access.manage')
    or exists (
      select 1
      from access_control.memberships target_membership
      where target_membership.subject_id = p_subject_id
        and target_membership.tenant_id is not null
        and private_app.has_tenant_permission(
          target_membership.tenant_id,
          'tenant.users.manage'
        )
    )
  )
$$;

create or replace function private_app.can_read_membership(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from access_control.memberships m
    where m.id = p_membership_id
      and (
        m.subject_id = private_app.current_subject_id()
        or private_app.has_platform_permission('platform.access.manage')
        or (
          m.tenant_id is not null
          and private_app.has_tenant_permission(m.tenant_id, 'tenant.users.manage')
        )
      )
  )
$$;

create or replace function private_app.can_read_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from access_control.roles r
    where r.id = p_role_id
      and (
        (r.tenant_id is null and private_app.is_linked_subject())
        or
        (r.tenant_id is not null and private_app.can_access_tenant(r.tenant_id))
      )
  )
$$;

revoke all on function private_app.is_linked_subject() from public, anon, authenticated;
revoke all on function private_app.can_access_organization(uuid) from public, anon, authenticated;
revoke all on function private_app.can_read_subject(uuid) from public, anon, authenticated;
revoke all on function private_app.can_read_membership(uuid) from public, anon, authenticated;
revoke all on function private_app.can_read_role(uuid) from public, anon, authenticated;

create policy organizations_isolated_read
on core.organizations
for select
to authenticated
using (private_app.can_access_organization(id));

create policy tenants_isolated_read
on core.tenants
for select
to authenticated
using (private_app.can_access_tenant(id));

create policy domains_isolated_read
on core.domains
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy modules_authenticated_read
on core.modules
for select
to authenticated
using (private_app.is_linked_subject());

create policy tenant_modules_isolated_read
on core.tenant_modules
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy integrations_isolated_read
on core.integrations
for select
to authenticated
using (
  (tenant_id is null and private_app.has_platform_permission('platform.control.read'))
  or
  (tenant_id is not null and private_app.can_access_tenant(tenant_id))
);

create policy support_requests_isolated_read
on core.support_requests
for select
to authenticated
using (
  (tenant_id is null and private_app.has_platform_permission('platform.control.read'))
  or
  (tenant_id is not null and private_app.can_access_tenant(tenant_id))
);

create policy subjects_isolated_read
on access_control.subjects
for select
to authenticated
using (private_app.can_read_subject(id));

create policy memberships_isolated_read
on access_control.memberships
for select
to authenticated
using (private_app.can_read_membership(id));

create policy roles_isolated_read
on access_control.roles
for select
to authenticated
using (private_app.can_read_role(id));

create policy permissions_authenticated_read
on access_control.permissions
for select
to authenticated
using (private_app.is_linked_subject());

create policy role_permissions_isolated_read
on access_control.role_permissions
for select
to authenticated
using (private_app.can_read_role(role_id));

create policy membership_roles_isolated_read
on access_control.membership_roles
for select
to authenticated
using (
  private_app.can_read_membership(membership_id)
  and private_app.can_read_role(role_id)
);

create policy plans_authenticated_read
on catalog.plans
for select
to authenticated
using (private_app.is_linked_subject());

create policy features_authenticated_read
on catalog.features
for select
to authenticated
using (private_app.is_linked_subject());

create policy plan_features_authenticated_read
on catalog.plan_features
for select
to authenticated
using (private_app.is_linked_subject());

create policy subscriptions_isolated_read
on catalog.subscriptions
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy tenant_feature_overrides_isolated_read
on catalog.tenant_feature_overrides
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy audit_events_isolated_read
on audit_log.events
for select
to authenticated
using (
  private_app.has_platform_permission('platform.audit.read')
  or
  (tenant_id is not null and private_app.can_access_tenant(tenant_id))
);

commit;
