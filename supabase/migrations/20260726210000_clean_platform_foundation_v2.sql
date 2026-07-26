begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists core;
create schema if not exists access_control;
create schema if not exists catalog;
create schema if not exists audit_log;
create schema if not exists private_app;

revoke all on schema core from public, anon, authenticated;
revoke all on schema access_control from public, anon, authenticated;
revoke all on schema catalog from public, anon, authenticated;
revoke all on schema audit_log from public, anon, authenticated;
revoke all on schema private_app from public, anon, authenticated;

create table core.organizations (
  id uuid primary key default gen_random_uuid(),
  organization_key text not null unique,
  legal_name text not null,
  display_name text not null,
  country_code text not null default 'SA' check (country_code ~ '^[A-Z]{2}$'),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.tenants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete restrict,
  tenant_key text not null unique,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  legal_name text,
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended', 'migrating', 'closed')),
  country_code text not null default 'SA' check (country_code ~ '^[A-Z]{2}$'),
  timezone text not null default 'Asia/Riyadh',
  default_locale text not null default 'ar-SA',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index core_tenants_organization_idx on core.tenants(organization_id);
create index core_tenants_status_idx on core.tenants(status);

create table core.domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  hostname text not null unique,
  domain_type text not null default 'custom' check (domain_type in ('platform', 'subdomain', 'custom')),
  status text not null default 'pending' check (status in ('pending', 'verifying', 'active', 'failed', 'disabled')),
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index core_domains_one_primary_per_tenant_idx
  on core.domains(tenant_id)
  where is_primary;

create table core.modules (
  id uuid primary key default gen_random_uuid(),
  module_key text not null unique,
  name_ar text not null,
  name_en text,
  description text,
  enabled_by_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'beta', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.tenant_modules (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  module_id uuid not null references core.modules(id) on delete cascade,
  enabled boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, module_id)
);

create table access_control.subjects (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null,
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'disabled')),
  must_change_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index access_subjects_email_lower_idx on access_control.subjects(lower(email));

create table access_control.memberships (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references access_control.subjects(id) on delete cascade,
  tenant_id uuid references core.tenants(id) on delete cascade,
  scope text not null check (scope in ('platform', 'tenant')),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'revoked')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'platform' and tenant_id is null)
    or
    (scope = 'tenant' and tenant_id is not null)
  )
);

create unique index access_memberships_platform_unique_idx
  on access_control.memberships(subject_id)
  where scope = 'platform';

create unique index access_memberships_tenant_unique_idx
  on access_control.memberships(subject_id, tenant_id)
  where scope = 'tenant';

create index access_memberships_tenant_idx on access_control.memberships(tenant_id);

create table access_control.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete cascade,
  role_key text not null,
  name_ar text not null,
  name_en text,
  scope text not null check (scope in ('platform', 'tenant')),
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'platform' and tenant_id is null)
    or
    (scope = 'tenant')
  )
);

create unique index access_roles_platform_key_idx
  on access_control.roles(role_key)
  where tenant_id is null;

create unique index access_roles_tenant_key_idx
  on access_control.roles(tenant_id, role_key)
  where tenant_id is not null;

create table access_control.permissions (
  permission_key text primary key,
  module_key text not null,
  name_ar text not null,
  description text,
  created_at timestamptz not null default now()
);

create table access_control.role_permissions (
  role_id uuid not null references access_control.roles(id) on delete cascade,
  permission_key text not null references access_control.permissions(permission_key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table access_control.membership_roles (
  membership_id uuid not null references access_control.memberships(id) on delete cascade,
  role_id uuid not null references access_control.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (membership_id, role_id)
);

create index access_membership_roles_role_idx on access_control.membership_roles(role_id);

create table catalog.plans (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null unique,
  name_ar text not null,
  name_en text,
  description text,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'SAR',
  interval text not null default 'month' check (interval in ('month', 'year', 'one_time')),
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table catalog.features (
  id uuid primary key default gen_random_uuid(),
  feature_key text not null unique,
  name_ar text not null,
  name_en text,
  category text not null default 'module',
  value_type text not null default 'boolean' check (value_type in ('boolean', 'number', 'text', 'json')),
  default_value jsonb not null default 'false'::jsonb,
  status text not null default 'active' check (status in ('active', 'beta', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table catalog.plan_features (
  plan_id uuid not null references catalog.plans(id) on delete cascade,
  feature_id uuid not null references catalog.features(id) on delete cascade,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plan_id, feature_id)
);

create table catalog.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  plan_id uuid not null references catalog.plans(id) on delete restrict,
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled')),
  period_start timestamptz not null default now(),
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index catalog_subscriptions_one_current_idx
  on catalog.subscriptions(tenant_id)
  where status in ('trialing', 'active', 'past_due', 'paused');

create index catalog_subscriptions_plan_idx on catalog.subscriptions(plan_id);

create table catalog.tenant_feature_overrides (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  feature_id uuid not null references catalog.features(id) on delete cascade,
  value jsonb not null,
  reason text,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feature_id)
);

create table core.integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete cascade,
  system_type text not null,
  display_name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'degraded', 'disabled', 'error')),
  configuration jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, system_type, display_name)
);

create index core_integrations_tenant_idx on core.integrations(tenant_id);

create table core.support_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete set null,
  requested_by_subject_id uuid references access_control.subjects(id) on delete set null,
  category text not null check (category in ('change_request', 'support', 'incident', 'integration', 'billing')),
  title text not null,
  description text,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  status text not null default 'new' check (status in ('new', 'reviewing', 'approved', 'in_progress', 'done', 'rejected')),
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index core_support_requests_tenant_idx on core.support_requests(tenant_id);
create index core_support_requests_status_idx on core.support_requests(status);

create table audit_log.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references core.tenants(id) on delete set null,
  actor_subject_id uuid references access_control.subjects(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index audit_events_tenant_time_idx on audit_log.events(tenant_id, occurred_at desc);
create index audit_events_actor_time_idx on audit_log.events(actor_subject_id, occurred_at desc);

create or replace function private_app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private_app.set_updated_at() from public, anon, authenticated;

create trigger organizations_set_updated_at before update on core.organizations
for each row execute function private_app.set_updated_at();
create trigger tenants_set_updated_at before update on core.tenants
for each row execute function private_app.set_updated_at();
create trigger domains_set_updated_at before update on core.domains
for each row execute function private_app.set_updated_at();
create trigger modules_set_updated_at before update on core.modules
for each row execute function private_app.set_updated_at();
create trigger tenant_modules_set_updated_at before update on core.tenant_modules
for each row execute function private_app.set_updated_at();
create trigger subjects_set_updated_at before update on access_control.subjects
for each row execute function private_app.set_updated_at();
create trigger memberships_set_updated_at before update on access_control.memberships
for each row execute function private_app.set_updated_at();
create trigger roles_set_updated_at before update on access_control.roles
for each row execute function private_app.set_updated_at();
create trigger plans_set_updated_at before update on catalog.plans
for each row execute function private_app.set_updated_at();
create trigger features_set_updated_at before update on catalog.features
for each row execute function private_app.set_updated_at();
create trigger plan_features_set_updated_at before update on catalog.plan_features
for each row execute function private_app.set_updated_at();
create trigger subscriptions_set_updated_at before update on catalog.subscriptions
for each row execute function private_app.set_updated_at();
create trigger integrations_set_updated_at before update on core.integrations
for each row execute function private_app.set_updated_at();
create trigger support_requests_set_updated_at before update on core.support_requests
for each row execute function private_app.set_updated_at();

create or replace function private_app.current_subject_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from access_control.subjects s
  where auth.uid() is not null
    and s.auth_user_id = auth.uid()
    and s.status = 'active'
  limit 1
$$;

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
        and m.tenant_id = p_tenant_id
    )
  )
$$;

create or replace function private_app.has_tenant_permission(p_tenant_id uuid, p_permission text)
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
        and m.tenant_id = p_tenant_id
        and rp.permission_key = p_permission
    )
  )
$$;

create or replace function private_app.write_audit(
  p_action text,
  p_resource_type text,
  p_resource_id text default null,
  p_tenant_id uuid default null,
  p_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private_app.current_subject_id() from public, anon, authenticated;
revoke all on function private_app.has_platform_permission(text) from public, anon, authenticated;
revoke all on function private_app.can_access_tenant(uuid) from public, anon, authenticated;
revoke all on function private_app.has_tenant_permission(uuid, text) from public, anon, authenticated;
revoke all on function private_app.write_audit(text, text, text, uuid, jsonb) from public, anon, authenticated;

insert into access_control.permissions (permission_key, module_key, name_ar, description)
values
  ('platform.control.read', 'platform', 'عرض لوحة المنصة', 'دخول لوحة ماركتون المركزية'),
  ('platform.control.write', 'platform', 'إدارة لوحة المنصة', 'تنفيذ العمليات المركزية'),
  ('platform.tenants.manage', 'platform', 'إدارة المنشآت', 'إنشاء المنشآت وحالاتها ودوميناتها'),
  ('platform.billing.manage', 'billing', 'إدارة الباقات', 'إدارة الباقات والمزايا والاشتراكات'),
  ('platform.access.manage', 'access', 'إدارة صلاحيات المنصة', 'إدارة مسؤولي وأدوار المنصة'),
  ('platform.audit.read', 'audit', 'عرض سجل التدقيق', 'مراجعة العمليات والأمان'),
  ('tenant.workspace.read', 'tenant', 'دخول منصة المنشأة', 'عرض مساحة المنشأة'),
  ('tenant.settings.manage', 'tenant', 'إدارة إعدادات المنشأة', 'الهوية والموديلات والتكاملات'),
  ('tenant.users.manage', 'access', 'إدارة المستخدمين', 'الدعوات والعضويات والأدوار'),
  ('tenant.crm.read', 'crm', 'عرض CRM', 'عرض العملاء والفرص والأنشطة'),
  ('tenant.crm.write', 'crm', 'إدارة CRM', 'إنشاء وتعديل بيانات CRM'),
  ('tenant.work.read', 'work', 'عرض المهام والتقويم', 'عرض مهام وتقويم المنشأة'),
  ('tenant.work.write', 'work', 'إدارة المهام والتقويم', 'إنشاء وإسناد وتحديث المهام'),
  ('tenant.content.read', 'content', 'عرض الأخبار والمعارف', 'عرض المحتوى الموجّه للمنشأة'),
  ('tenant.support.create', 'support', 'إنشاء طلبات الدعم', 'إرسال طلب دعم أو تعديل')
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.roles (role_key, name_ar, name_en, scope, is_system)
values
  ('platform_owner', 'مالك المنصة', 'Platform Owner', 'platform', true),
  ('tenant_owner', 'مالك المنشأة', 'Tenant Owner', 'tenant', true),
  ('tenant_admin', 'مدير المنشأة', 'Tenant Admin', 'tenant', true),
  ('sales_manager', 'مدير المبيعات', 'Sales Manager', 'tenant', true),
  ('sales_user', 'مسؤول المبيعات', 'Sales User', 'tenant', true)
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.role_key = 'platform_owner'
  and r.scope = 'platform'
  and p.permission_key like 'platform.%'
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.role_key = 'tenant_owner'
  and r.scope = 'tenant'
  and p.permission_key like 'tenant.%'
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.role_key = 'tenant_admin'
  and r.scope = 'tenant'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.settings.manage',
    'tenant.users.manage',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.role_key = 'sales_manager'
  and r.scope = 'tenant'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.role_key = 'sales_user'
  and r.scope = 'tenant'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create'
  )
on conflict do nothing;

insert into core.modules (module_key, name_ar, name_en, description, enabled_by_default, status)
values
  ('crm', 'إدارة العملاء والمبيعات', 'CRM', 'العملاء والفرص والأنشطة والمتابعات', true, 'active'),
  ('work', 'المهام والتقويم', 'Work', 'المهام والتقويم والدعوات والتنبيهات', true, 'active'),
  ('incentives', 'الأهداف والحوافز', 'Goals & Incentives', 'الأهداف والشرائح والحوافز', false, 'beta'),
  ('content', 'الأخبار والمعارف', 'News & Knowledge', 'الأخبار والمنافسات والمقالات', true, 'active'),
  ('people', 'الموظفون والصلاحيات', 'People & Access', 'الموظفون والمستخدمون والأدوار', true, 'active'),
  ('support', 'الدعم وتعديلات النظام', 'Support', 'طلبات الدعم والتعديلات بالموافقة البشرية', true, 'active')
on conflict (module_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description = excluded.description,
    enabled_by_default = excluded.enabled_by_default,
    status = excluded.status;

insert into catalog.plans (plan_key, name_ar, name_en, description, amount_minor, currency, interval, status)
values ('free', 'الخطة المجانية', 'Free', 'النواة المجانية الدائمة لمنصة ماركتون', 0, 'SAR', 'month', 'active')
on conflict (plan_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description = excluded.description,
    amount_minor = excluded.amount_minor,
    currency = excluded.currency,
    interval = excluded.interval,
    status = excluded.status;

create or replace function public.v2_current_user_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject access_control.subjects%rowtype;
  v_memberships jsonb;
  v_platform_access boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  select *
  into v_subject
  from access_control.subjects
  where auth_user_id = auth.uid()
    and status = 'active'
  limit 1;

  if v_subject.id is null then
    raise exception 'account_not_linked';
  end if;

  v_platform_access := private_app.has_platform_permission('platform.control.read');

  select coalesce(jsonb_agg(item order by item->>'tenantName'), '[]'::jsonb)
  into v_memberships
  from (
    select jsonb_build_object(
      'membershipId', m.id,
      'tenantId', t.id,
      'tenantSlug', t.slug,
      'tenantName', t.name,
      'status', m.status,
      'roles', coalesce((
        select jsonb_agg(r.role_key order by r.role_key)
        from access_control.membership_roles mr
        join access_control.roles r on r.id = mr.role_id
        where mr.membership_id = m.id
      ), '[]'::jsonb),
      'permissions', coalesce((
        select jsonb_agg(distinct rp.permission_key order by rp.permission_key)
        from access_control.membership_roles mr
        join access_control.role_permissions rp on rp.role_id = mr.role_id
        where mr.membership_id = m.id
      ), '[]'::jsonb)
    ) as item
    from access_control.memberships m
    join core.tenants t on t.id = m.tenant_id
    where m.subject_id = v_subject.id
      and m.scope = 'tenant'
      and m.status = 'active'
  ) memberships;

  return jsonb_build_object(
    'subject', jsonb_build_object(
      'id', v_subject.id,
      'email', v_subject.email,
      'fullName', v_subject.full_name,
      'status', v_subject.status,
      'mustChangePassword', v_subject.must_change_password
    ),
    'platformAccess', v_platform_access,
    'memberships', v_memberships
  );
end;
$$;

create or replace function public.v2_mark_password_changed()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  update access_control.subjects
  set must_change_password = false
  where auth_user_id = auth.uid();

  return found;
end;
$$;

create or replace function public.v2_platform_control_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private_app.has_platform_permission('platform.control.read') then
    raise exception 'forbidden';
  end if;

  select jsonb_build_object(
    'generatedAt', now(),
    'summary', jsonb_build_object(
      'organizations', (select count(*) from core.organizations),
      'activeTenants', (select count(*) from core.tenants where status = 'active'),
      'openSupport', (select count(*) from core.support_requests where status not in ('done', 'rejected')),
      'integrations', (select count(*) from core.integrations where status = 'active')
    ),
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'tenantKey', t.tenant_key,
        'slug', t.slug,
        'name', t.name,
        'legalName', t.legal_name,
        'status', t.status,
        'timezone', t.timezone,
        'planKey', p.plan_key,
        'planName', p.name_ar,
        'employees', 0,
        'services', 0,
        'openTasks', 0,
        'overdueTasks', 0,
        'pipelineValueMinor', 0
      ) order by t.created_at desc)
      from core.tenants t
      left join catalog.subscriptions s
        on s.tenant_id = t.id
       and s.status in ('trialing', 'active', 'past_due', 'paused')
      left join catalog.plans p on p.id = s.plan_id
    ), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'key', p.plan_key,
        'nameAr', p.name_ar,
        'nameEn', p.name_en,
        'amountMinor', p.amount_minor,
        'currency', p.currency,
        'interval', p.interval,
        'status', p.status
      ) order by p.amount_minor, p.created_at)
      from catalog.plans p
    ), '[]'::jsonb),
    'features', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id,
        'key', f.feature_key,
        'nameAr', f.name_ar,
        'nameEn', f.name_en,
        'category', f.category,
        'valueType', f.value_type,
        'defaultValue', f.default_value,
        'status', f.status
      ) order by f.category, f.name_ar)
      from catalog.features f
    ), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'tenantId', t.id,
        'tenantName', t.name,
        'planKey', p.plan_key,
        'planName', p.name_ar,
        'status', s.status,
        'periodStart', s.period_start,
        'periodEnd', s.period_end
      ) order by s.created_at desc)
      from catalog.subscriptions s
      join core.tenants t on t.id = s.tenant_id
      join catalog.plans p on p.id = s.plan_id
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'key', r.role_key,
        'nameAr', r.name_ar,
        'nameEn', r.name_en,
        'scope', r.scope,
        'system', r.is_system,
        'permissions', coalesce((
          select jsonb_agg(rp.permission_key order by rp.permission_key)
          from access_control.role_permissions rp
          where rp.role_id = r.id
        ), '[]'::jsonb)
      ) order by r.scope, r.name_ar)
      from access_control.roles r
      where r.tenant_id is null
    ), '[]'::jsonb),
    'integrations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'tenantId', i.tenant_id,
        'tenantName', t.name,
        'type', i.system_type,
        'name', i.display_name,
        'status', i.status,
        'lastCheckedAt', i.last_checked_at
      ) order by i.created_at desc)
      from core.integrations i
      left join core.tenants t on t.id = i.tenant_id
    ), '[]'::jsonb),
    'supportRequests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'tenantId', r.tenant_id,
        'tenantName', t.name,
        'category', r.category,
        'title', r.title,
        'description', r.description,
        'priority', r.priority,
        'status', r.status,
        'decisionNote', r.decision_note,
        'createdAt', r.created_at
      ) order by r.created_at desc)
      from core.support_requests r
      left join core.tenants t on t.id = r.tenant_id
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'tenantId', e.tenant_id,
        'tenantName', t.name,
        'actorEmail', s.email,
        'actorName', s.full_name,
        'action', e.action,
        'resourceType', e.resource_type,
        'resourceId', e.resource_id,
        'context', e.context,
        'occurredAt', e.occurred_at
      ) order by e.occurred_at desc)
      from (
        select *
        from audit_log.events
        order by occurred_at desc
        limit 100
      ) e
      left join core.tenants t on t.id = e.tenant_id
      left join access_control.subjects s on s.id = e.actor_subject_id
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

create or replace function public.v2_tenant_workspace_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
begin
  select *
  into v_tenant
  from core.tenants
  where slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.can_access_tenant(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'tenantKey', v_tenant.tenant_key,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'legalName', v_tenant.legal_name,
      'status', v_tenant.status,
      'countryCode', v_tenant.country_code,
      'timezone', v_tenant.timezone,
      'defaultLocale', v_tenant.default_locale
    ),
    'summary', jsonb_build_object(
      'contacts', 0,
      'openOpportunities', 0,
      'pipelineValueMinor', 0,
      'openTasks', 0,
      'overdueTasks', 0,
      'employees', 0,
      'services', 0,
      'pendingSupport', (
        select count(*)
        from core.support_requests
        where tenant_id = v_tenant.id
          and status not in ('done', 'rejected')
      )
    ),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', m.module_key,
        'nameAr', m.name_ar,
        'nameEn', m.name_en,
        'enabled', tm.enabled,
        'configuration', tm.configuration
      ) order by m.name_ar)
      from core.tenant_modules tm
      join core.modules m on m.id = tm.module_id
      where tm.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'contacts', '[]'::jsonb,
    'opportunities', '[]'::jsonb,
    'activities', '[]'::jsonb,
    'tasks', '[]'::jsonb,
    'employees', '[]'::jsonb,
    'services', '[]'::jsonb,
    'departments', '[]'::jsonb,
    'roles', '[]'::jsonb,
    'stages', '[]'::jsonb,
    'forms', '[]'::jsonb,
    'supportRequests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'category', r.category,
        'title', r.title,
        'description', r.description,
        'priority', r.priority,
        'status', r.status,
        'createdAt', r.created_at
      ) order by r.created_at desc)
      from core.support_requests r
      where r.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'notifications', '[]'::jsonb
  );
end;
$$;

create or replace function public.v2_platform_provision_tenant(
  p_display_name text,
  p_legal_name text,
  p_slug text,
  p_country_code text default 'SA',
  p_timezone text default 'Asia/Riyadh',
  p_plan_key text default 'free'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_tenant_id uuid;
  v_plan_id uuid;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;

  if p_slug is null or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid_slug';
  end if;

  insert into core.organizations (
    organization_key,
    legal_name,
    display_name,
    country_code
  )
  values (
    'org-' || p_slug,
    coalesce(nullif(trim(p_legal_name), ''), trim(p_display_name)),
    trim(p_display_name),
    upper(coalesce(nullif(trim(p_country_code), ''), 'SA'))
  )
  returning id into v_organization_id;

  insert into core.tenants (
    organization_id,
    tenant_key,
    slug,
    name,
    legal_name,
    status,
    country_code,
    timezone
  )
  values (
    v_organization_id,
    'tenant-' || p_slug,
    p_slug,
    trim(p_display_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_display_name)),
    'trial',
    upper(coalesce(nullif(trim(p_country_code), ''), 'SA')),
    coalesce(nullif(trim(p_timezone), ''), 'Asia/Riyadh')
  )
  returning id into v_tenant_id;

  insert into core.tenant_modules (tenant_id, module_id, enabled, enabled_at)
  select v_tenant_id, m.id, true, now()
  from core.modules m
  where m.enabled_by_default
  on conflict do nothing;

  select id into v_plan_id
  from catalog.plans
  where plan_key = coalesce(nullif(trim(p_plan_key), ''), 'free')
    and status = 'active'
  limit 1;

  if v_plan_id is not null then
    insert into catalog.subscriptions (tenant_id, plan_id, status)
    values (v_tenant_id, v_plan_id, 'trialing');
  end if;

  perform private_app.write_audit(
    'tenant.created',
    'tenant',
    v_tenant_id::text,
    v_tenant_id,
    jsonb_build_object('slug', p_slug, 'name', p_display_name)
  );

  return jsonb_build_object('id', v_tenant_id, 'slug', p_slug);
end;
$$;

create or replace function public.v2_platform_create_plan(
  p_plan_key text,
  p_name_ar text,
  p_name_en text default null,
  p_amount_minor bigint default 0,
  p_interval text default 'month'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan catalog.plans%rowtype;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;

  insert into catalog.plans (plan_key, name_ar, name_en, amount_minor, interval, status)
  values (trim(p_plan_key), trim(p_name_ar), nullif(trim(p_name_en), ''), greatest(p_amount_minor, 0), p_interval, 'active')
  returning * into v_plan;

  perform private_app.write_audit('plan.created', 'plan', v_plan.id::text);
  return jsonb_build_object('id', v_plan.id, 'key', v_plan.plan_key);
end;
$$;

create or replace function public.v2_platform_create_feature(
  p_feature_key text,
  p_name_ar text,
  p_name_en text default null,
  p_category text default 'module',
  p_value_type text default 'boolean',
  p_default_value jsonb default 'false'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feature catalog.features%rowtype;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;

  insert into catalog.features (
    feature_key,
    name_ar,
    name_en,
    category,
    value_type,
    default_value
  )
  values (
    trim(p_feature_key),
    trim(p_name_ar),
    nullif(trim(p_name_en), ''),
    coalesce(nullif(trim(p_category), ''), 'module'),
    p_value_type,
    coalesce(p_default_value, 'false'::jsonb)
  )
  returning * into v_feature;

  perform private_app.write_audit('feature.created', 'feature', v_feature.id::text);
  return jsonb_build_object('id', v_feature.id, 'key', v_feature.feature_key);
end;
$$;

create or replace function public.v2_platform_set_tenant_feature(
  p_tenant_id uuid,
  p_feature_key text,
  p_value jsonb,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feature_id uuid;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;

  select id into v_feature_id
  from catalog.features
  where feature_key = p_feature_key
    and status in ('active', 'beta')
  limit 1;

  if v_feature_id is null then
    raise exception 'feature_not_found';
  end if;

  insert into catalog.tenant_feature_overrides (
    tenant_id,
    feature_id,
    value,
    reason,
    updated_by_subject_id
  )
  values (
    p_tenant_id,
    v_feature_id,
    p_value,
    p_reason,
    private_app.current_subject_id()
  )
  on conflict (tenant_id, feature_id) do update
  set value = excluded.value,
      reason = excluded.reason,
      updated_by_subject_id = excluded.updated_by_subject_id,
      updated_at = now();

  perform private_app.write_audit(
    'tenant.feature.updated',
    'tenant_feature',
    v_feature_id::text,
    p_tenant_id,
    jsonb_build_object('featureKey', p_feature_key, 'value', p_value)
  );

  return true;
end;
$$;

create or replace function public.v2_platform_set_subscription(
  p_tenant_id uuid,
  p_plan_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_id uuid;
  v_subscription_id uuid;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;

  select id into v_plan_id
  from catalog.plans
  where plan_key = p_plan_key
    and status = 'active'
  limit 1;

  if v_plan_id is null then
    raise exception 'plan_not_found';
  end if;

  update catalog.subscriptions
  set status = 'cancelled',
      period_end = coalesce(period_end, now())
  where tenant_id = p_tenant_id
    and status in ('trialing', 'active', 'past_due', 'paused');

  insert into catalog.subscriptions (tenant_id, plan_id, status)
  values (p_tenant_id, v_plan_id, 'active')
  returning id into v_subscription_id;

  perform private_app.write_audit(
    'subscription.changed',
    'subscription',
    v_subscription_id::text,
    p_tenant_id,
    jsonb_build_object('planKey', p_plan_key)
  );

  return jsonb_build_object('id', v_subscription_id, 'planKey', p_plan_key);
end;
$$;

create or replace function public.v2_platform_set_tenant_status(
  p_tenant_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;

  update core.tenants
  set status = p_status
  where id = p_tenant_id;

  if not found then
    raise exception 'tenant_not_found';
  end if;

  perform private_app.write_audit(
    'tenant.status.changed',
    'tenant',
    p_tenant_id::text,
    p_tenant_id,
    jsonb_build_object('status', p_status)
  );

  return true;
end;
$$;

create or replace function public.v2_platform_upsert_connection(
  p_tenant_id uuid default null,
  p_system_type text default null,
  p_display_name text default null,
  p_status text default 'draft',
  p_configuration jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration core.integrations%rowtype;
begin
  if not private_app.has_platform_permission('platform.control.write') then
    raise exception 'forbidden';
  end if;

  insert into core.integrations (
    tenant_id,
    system_type,
    display_name,
    status,
    configuration
  )
  values (
    p_tenant_id,
    trim(p_system_type),
    trim(p_display_name),
    p_status,
    coalesce(p_configuration, '{}'::jsonb)
  )
  on conflict (tenant_id, system_type, display_name) do update
  set status = excluded.status,
      configuration = excluded.configuration,
      updated_at = now()
  returning * into v_integration;

  perform private_app.write_audit(
    'integration.upserted',
    'integration',
    v_integration.id::text,
    p_tenant_id
  );

  return jsonb_build_object('id', v_integration.id);
end;
$$;

create or replace function public.v2_support_create_request(
  p_tenant_slug text default null,
  p_category text default 'support',
  p_title text default null,
  p_description text default null,
  p_priority text default 'medium'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_request_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if p_tenant_slug is not null then
    select id into v_tenant_id
    from core.tenants
    where slug = p_tenant_slug
    limit 1;

    if v_tenant_id is null or not private_app.has_tenant_permission(v_tenant_id, 'tenant.support.create') then
      raise exception 'forbidden';
    end if;
  elsif not private_app.has_platform_permission('platform.control.write') then
    raise exception 'forbidden';
  end if;

  insert into core.support_requests (
    tenant_id,
    requested_by_subject_id,
    category,
    title,
    description,
    priority
  )
  values (
    v_tenant_id,
    private_app.current_subject_id(),
    p_category,
    trim(p_title),
    nullif(trim(p_description), ''),
    p_priority
  )
  returning id into v_request_id;

  perform private_app.write_audit(
    'support.created',
    'support_request',
    v_request_id::text,
    v_tenant_id
  );

  return jsonb_build_object('id', v_request_id);
end;
$$;

create or replace function public.v2_support_update_request(
  p_request_id uuid,
  p_status text,
  p_decision_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  if not private_app.has_platform_permission('platform.control.write') then
    raise exception 'forbidden';
  end if;

  update core.support_requests
  set status = p_status,
      decision_note = p_decision_note
  where id = p_request_id
  returning tenant_id into v_tenant_id;

  if not found then
    raise exception 'support_request_not_found';
  end if;

  perform private_app.write_audit(
    'support.status.changed',
    'support_request',
    p_request_id::text,
    v_tenant_id,
    jsonb_build_object('status', p_status)
  );

  return true;
end;
$$;

alter table core.organizations enable row level security;
alter table core.tenants enable row level security;
alter table core.domains enable row level security;
alter table core.modules enable row level security;
alter table core.tenant_modules enable row level security;
alter table core.integrations enable row level security;
alter table core.support_requests enable row level security;
alter table access_control.subjects enable row level security;
alter table access_control.memberships enable row level security;
alter table access_control.roles enable row level security;
alter table access_control.permissions enable row level security;
alter table access_control.role_permissions enable row level security;
alter table access_control.membership_roles enable row level security;
alter table catalog.plans enable row level security;
alter table catalog.features enable row level security;
alter table catalog.plan_features enable row level security;
alter table catalog.subscriptions enable row level security;
alter table catalog.tenant_feature_overrides enable row level security;
alter table audit_log.events enable row level security;

revoke all on all tables in schema core from public, anon, authenticated;
revoke all on all tables in schema access_control from public, anon, authenticated;
revoke all on all tables in schema catalog from public, anon, authenticated;
revoke all on all tables in schema audit_log from public, anon, authenticated;
revoke all on all sequences in schema core from public, anon, authenticated;
revoke all on all sequences in schema access_control from public, anon, authenticated;
revoke all on all sequences in schema catalog from public, anon, authenticated;
revoke all on all sequences in schema audit_log from public, anon, authenticated;

alter default privileges in schema core revoke all on tables from public, anon, authenticated;
alter default privileges in schema access_control revoke all on tables from public, anon, authenticated;
alter default privileges in schema catalog revoke all on tables from public, anon, authenticated;
alter default privileges in schema audit_log revoke all on tables from public, anon, authenticated;
alter default privileges in schema core revoke all on sequences from public, anon, authenticated;
alter default privileges in schema access_control revoke all on sequences from public, anon, authenticated;
alter default privileges in schema catalog revoke all on sequences from public, anon, authenticated;
alter default privileges in schema audit_log revoke all on sequences from public, anon, authenticated;

revoke execute on function public.v2_current_user_context() from public, anon;
revoke execute on function public.v2_mark_password_changed() from public, anon;
revoke execute on function public.v2_platform_control_snapshot() from public, anon;
revoke execute on function public.v2_tenant_workspace_snapshot(text) from public, anon;
revoke execute on function public.v2_platform_provision_tenant(text, text, text, text, text, text) from public, anon;
revoke execute on function public.v2_platform_create_plan(text, text, text, bigint, text) from public, anon;
revoke execute on function public.v2_platform_create_feature(text, text, text, text, text, jsonb) from public, anon;
revoke execute on function public.v2_platform_set_tenant_feature(uuid, text, jsonb, text) from public, anon;
revoke execute on function public.v2_platform_set_subscription(uuid, text) from public, anon;
revoke execute on function public.v2_platform_set_tenant_status(uuid, text) from public, anon;
revoke execute on function public.v2_platform_upsert_connection(uuid, text, text, text, jsonb) from public, anon;
revoke execute on function public.v2_support_create_request(text, text, text, text, text) from public, anon;
revoke execute on function public.v2_support_update_request(uuid, text, text) from public, anon;

grant execute on function public.v2_current_user_context() to authenticated;
grant execute on function public.v2_mark_password_changed() to authenticated;
grant execute on function public.v2_platform_control_snapshot() to authenticated;
grant execute on function public.v2_tenant_workspace_snapshot(text) to authenticated;
grant execute on function public.v2_platform_provision_tenant(text, text, text, text, text, text) to authenticated;
grant execute on function public.v2_platform_create_plan(text, text, text, bigint, text) to authenticated;
grant execute on function public.v2_platform_create_feature(text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.v2_platform_set_tenant_feature(uuid, text, jsonb, text) to authenticated;
grant execute on function public.v2_platform_set_subscription(uuid, text) to authenticated;
grant execute on function public.v2_platform_set_tenant_status(uuid, text) to authenticated;
grant execute on function public.v2_platform_upsert_connection(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.v2_support_create_request(text, text, text, text, text) to authenticated;
grant execute on function public.v2_support_update_request(uuid, text, text) to authenticated;

comment on schema core is 'Marktone v2 platform and tenant core. Independent from the legacy platform schema.';
comment on schema access_control is 'Marktone v2 identities, memberships, roles, and permissions.';
comment on schema catalog is 'Marktone v2 plans, subscriptions, and feature entitlements.';
comment on schema audit_log is 'Append-only operational audit events for Marktone v2.';

commit;
