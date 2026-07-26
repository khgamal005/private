begin;

create schema if not exists people;
create schema if not exists academy;

create table people.departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  department_key text not null,
  name_ar text not null,
  name_en text,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, department_key)
);

create table people.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  membership_id uuid unique
    references access_control.memberships(id) on delete set null,
  employee_code text,
  full_name text not null check (length(trim(full_name)) >= 2),
  email text check (email is null or email = lower(trim(email))),
  phone text,
  job_title text not null,
  department_id uuid references people.departments(id) on delete set null,
  role_key text not null,
  employment_status text not null default 'active'
    check (employment_status in ('active', 'leave', 'inactive')),
  account_status text not null default 'profile_only'
    check (account_status in ('profile_only', 'invited', 'active', 'suspended')),
  capacity_minutes_weekly integer not null default 2400
    check (capacity_minutes_weekly between 0 and 10080),
  hired_at date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index people_staff_tenant_code_idx
on people.staff_profiles (tenant_id, employee_code)
where employee_code is not null;

create unique index people_staff_tenant_name_role_idx
on people.staff_profiles (tenant_id, lower(full_name), role_key);

create index people_staff_tenant_department_idx
on people.staff_profiles (tenant_id, department_id);

create index people_staff_tenant_role_idx
on people.staff_profiles (tenant_id, role_key);

create table academy.courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_code text not null,
  title_ar text not null check (length(trim(title_ar)) >= 2),
  title_en text,
  category text not null,
  description text,
  delivery_mode text not null default 'hybrid'
    check (delivery_mode in ('online', 'onsite', 'hybrid')),
  duration_hours numeric(7,2)
    check (duration_hours is null or duration_hours > 0),
  duration_days integer
    check (duration_days is null or duration_days > 0),
  price_minor bigint
    check (price_minor is null or price_minor >= 0),
  currency text not null default 'SAR',
  certification_code text,
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, course_code)
);

create index academy_courses_tenant_status_idx
on academy.courses (tenant_id, status, title_ar);

create table academy.course_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_id uuid not null references academy.courses(id) on delete cascade,
  run_code text not null,
  title text,
  delivery_mode text not null
    check (delivery_mode in ('online', 'onsite', 'hybrid')),
  starts_at timestamptz,
  ends_at timestamptz,
  capacity integer check (capacity is null or capacity > 0),
  enrolled_count integer not null default 0 check (enrolled_count >= 0),
  instructor_name text,
  venue_or_link text,
  price_minor bigint check (price_minor is null or price_minor >= 0),
  currency text not null default 'SAR',
  status text not null default 'planning'
    check (status in ('planning', 'open', 'in_progress', 'completed', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, run_code),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index academy_course_runs_tenant_time_idx
on academy.course_runs (tenant_id, starts_at, status);

create trigger departments_set_updated_at
before update on people.departments
for each row execute function private_app.set_updated_at();

create trigger staff_profiles_set_updated_at
before update on people.staff_profiles
for each row execute function private_app.set_updated_at();

create trigger courses_set_updated_at
before update on academy.courses
for each row execute function private_app.set_updated_at();

create trigger course_runs_set_updated_at
before update on academy.course_runs
for each row execute function private_app.set_updated_at();

alter table people.departments enable row level security;
alter table people.staff_profiles enable row level security;
alter table academy.courses enable row level security;
alter table academy.course_runs enable row level security;

create policy departments_isolated_read
on people.departments
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy staff_profiles_isolated_read
on people.staff_profiles
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy courses_isolated_read
on academy.courses
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy course_runs_isolated_read
on academy.course_runs
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on all tables in schema people from public, anon, authenticated;
revoke all on all tables in schema academy from public, anon, authenticated;
revoke all on all sequences in schema people from public, anon, authenticated;
revoke all on all sequences in schema academy from public, anon, authenticated;

alter default privileges in schema people
revoke all on tables from public, anon, authenticated;
alter default privileges in schema academy
revoke all on tables from public, anon, authenticated;
alter default privileges in schema people
revoke all on sequences from public, anon, authenticated;
alter default privileges in schema academy
revoke all on sequences from public, anon, authenticated;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values
  ('tenant.people.read', 'people', 'عرض فريق العمل', 'عرض ملفات الموظفين والهيكل التنظيمي'),
  ('tenant.people.manage', 'people', 'إدارة فريق العمل', 'إنشاء وتحديث ملفات الموظفين'),
  ('tenant.academy.read', 'academy', 'عرض الدورات', 'عرض كتالوج الدورات والدفعات'),
  ('tenant.academy.write', 'academy', 'إدارة الدورات', 'إنشاء وتحديث الدورات والدفعات'),
  ('tenant.incentives.read', 'incentives', 'عرض الأهداف والحوافز', 'عرض الأهداف والإنجاز والحوافز'),
  ('tenant.incentives.write', 'incentives', 'إدارة الأهداف والحوافز', 'إنشاء خطط الأهداف والحوافز'),
  ('tenant.analytics.read', 'analytics', 'عرض التحليلات', 'عرض مؤشرات الأداء والتحليلات'),
  ('tenant.reports.read', 'reports', 'عرض التقارير', 'عرض وتصدير التقارير التشغيلية'),
  ('tenant.customer_service.manage', 'customer_service', 'إدارة خدمة العملاء', 'إدارة طلبات وخدمة العملاء'),
  ('tenant.integrations.manage', 'integrations', 'إدارة التكاملات', 'إدارة وربط تكاملات المنشأة'),
  ('tenant.ai.use', 'ai_assistant', 'استخدام المساعد الذكي', 'استخدام مساعد ماركتون حسب القسم')
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.roles (
  role_key,
  name_ar,
  name_en,
  scope,
  is_system
)
values
  ('executive_manager', 'المدير التنفيذي', 'Executive Manager', 'tenant', true),
  ('sales_supervisor', 'مشرف المبيعات', 'Sales Supervisor', 'tenant', true),
  ('customer_service', 'خدمة العملاء', 'Customer Service', 'tenant', true),
  ('data_officer', 'مسؤول البيانات', 'Data Officer', 'tenant', true),
  ('data_analyst', 'محلل البيانات', 'Data Analyst', 'tenant', true)
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.scope = 'tenant'
  and r.role_key in ('tenant_owner', 'tenant_admin', 'executive_manager')
  and p.permission_key like 'tenant.%'
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.scope = 'tenant'
  and r.role_key in ('sales_manager', 'sales_supervisor')
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create',
    'tenant.people.read',
    'tenant.academy.read',
    'tenant.incentives.read',
    'tenant.incentives.write',
    'tenant.analytics.read',
    'tenant.reports.read',
    'tenant.ai.use'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.scope = 'tenant'
  and r.role_key = 'sales_user'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create',
    'tenant.people.read',
    'tenant.academy.read',
    'tenant.incentives.read',
    'tenant.ai.use'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.scope = 'tenant'
  and r.role_key = 'customer_service'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create',
    'tenant.people.read',
    'tenant.academy.read',
    'tenant.customer_service.manage',
    'tenant.ai.use'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.scope = 'tenant'
  and r.role_key = 'data_officer'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.crm.write',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create',
    'tenant.people.read',
    'tenant.academy.read',
    'tenant.analytics.read',
    'tenant.reports.read',
    'tenant.ai.use'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from access_control.roles r
cross join access_control.permissions p
where r.scope = 'tenant'
  and r.role_key = 'data_analyst'
  and p.permission_key in (
    'tenant.workspace.read',
    'tenant.crm.read',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read',
    'tenant.support.create',
    'tenant.people.read',
    'tenant.academy.read',
    'tenant.analytics.read',
    'tenant.reports.read',
    'tenant.ai.use'
  )
on conflict do nothing;

insert into core.modules (
  module_key,
  name_ar,
  name_en,
  description,
  enabled_by_default,
  status
)
values
  ('academy', 'الدورات والتدريب', 'Academy', 'كتالوج الدورات والدفعات والتسجيلات', false, 'active'),
  ('analytics', 'التحليلات', 'Analytics', 'التحليلات ومؤشرات الأداء', false, 'active'),
  ('customer_service', 'خدمة العملاء', 'Customer Service', 'تشغيل ومتابعة خدمة العملاء', false, 'active'),
  ('integrations', 'التكاملات', 'Integrations', 'تكاملات المنشأة والخدمات الخارجية', false, 'active'),
  ('reports', 'التقارير', 'Reports', 'التقارير التشغيلية والتصدير', false, 'active'),
  ('ai_assistant', 'المساعد الذكي', 'AI Assistant', 'مساعد ماركتون السياقي داخل كل قسم', false, 'active')
on conflict (module_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description = excluded.description,
    status = excluded.status;

insert into catalog.plans (
  plan_key,
  name_ar,
  name_en,
  description,
  amount_minor,
  currency,
  interval,
  status
)
values (
  'full',
  'النسخة الكاملة',
  'Full',
  'جميع الموديلات والمزايا مفعلة؛ التسعير التعاقدي يحدد لاحقًا',
  0,
  'SAR',
  'month',
  'active'
)
on conflict (plan_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description = excluded.description,
    status = 'active';

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
select
  'module.' || m.module_key,
  'موديل ' || m.name_ar,
  coalesce(m.name_en, m.module_key),
  'module',
  'boolean',
  'false'::jsonb,
  'active'
from core.modules m
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    status = excluded.status;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values
  ('limit.users', 'حد المستخدمين', 'User limit', 'limit', 'number', '3'::jsonb, 'active'),
  ('limit.courses', 'حد الدورات', 'Course limit', 'limit', 'number', '5'::jsonb, 'active'),
  ('feature.ai.contextual', 'المساعد الذكي السياقي', 'Contextual AI assistant', 'capability', 'boolean', 'false'::jsonb, 'active')
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    default_value = excluded.default_value,
    status = excluded.status;

insert into catalog.plan_features (plan_id, feature_id, value)
select p.id, f.id,
  case
    when f.feature_key in ('limit.users', 'limit.courses') then '-1'::jsonb
    else 'true'::jsonb
  end
from catalog.plans p
cross join catalog.features f
where p.plan_key = 'full'
on conflict (plan_id, feature_id) do update
set value = excluded.value,
    updated_at = now();

create or replace function private_app.sync_staff_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_email text;
  v_role_key text;
begin
  select m.tenant_id, s.email, r.role_key
  into v_tenant_id, v_email, v_role_key
  from access_control.memberships m
  join access_control.subjects s on s.id = m.subject_id
  join access_control.roles r on r.id = new.role_id
  where m.id = new.membership_id
    and m.scope = 'tenant'
  limit 1;

  if v_tenant_id is not null and v_email is not null then
    update people.staff_profiles
    set membership_id = new.membership_id,
        role_key = v_role_key,
        account_status = 'active'
    where tenant_id = v_tenant_id
      and email = lower(v_email);
  end if;

  return new;
end;
$$;

revoke all on function private_app.sync_staff_membership()
from public, anon, authenticated;

create trigger membership_roles_sync_staff
after insert on access_control.membership_roles
for each row execute function private_app.sync_staff_membership();

create or replace function public.v2_tenant_create_staff(
  p_tenant_slug text,
  p_full_name text,
  p_role_key text,
  p_department_key text default 'general',
  p_job_title text default null,
  p_email text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_department_id uuid;
  v_staff_id uuid;
  v_email text;
  v_membership_link jsonb;
  v_account_status text := 'profile_only';
  v_membership_id uuid;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(v_tenant_id, 'tenant.people.manage') then
    raise exception 'forbidden';
  end if;
  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'full_name_required';
  end if;
  if not exists (
    select 1
    from access_control.roles r
    where r.scope = 'tenant'
      and r.role_key = p_role_key
      and (r.tenant_id is null or r.tenant_id = v_tenant_id)
  ) then
    raise exception 'invalid_role';
  end if;

  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;

  insert into people.departments (
    tenant_id,
    department_key,
    name_ar
  )
  values (
    v_tenant_id,
    coalesce(nullif(trim(p_department_key), ''), 'general'),
    case coalesce(nullif(trim(p_department_key), ''), 'general')
      when 'sales' then 'المبيعات'
      when 'customer_service' then 'خدمة العملاء'
      when 'data' then 'البيانات والتحليلات'
      when 'management' then 'الإدارة'
      else 'عام'
    end
  )
  on conflict (tenant_id, department_key) do update
  set status = 'active'
  returning id into v_department_id;

  if exists (
    select 1
    from people.staff_profiles sp
    where sp.tenant_id = v_tenant_id
      and lower(sp.full_name) = lower(trim(p_full_name))
      and sp.role_key = p_role_key
  ) then
    raise exception 'staff_exists';
  end if;

  if v_email is not null then
    v_membership_link := private_app.link_existing_tenant_user(
      v_tenant_id,
      trim(p_full_name),
      v_email,
      p_role_key
    );
    if coalesce((v_membership_link ->> 'linked')::boolean, false) then
      v_account_status := 'active';
      v_membership_id := (v_membership_link ->> 'membershipId')::uuid;
    end if;
  end if;

  insert into people.staff_profiles (
    tenant_id,
    membership_id,
    full_name,
    email,
    phone,
    job_title,
    department_id,
    role_key,
    account_status
  )
  values (
    v_tenant_id,
    v_membership_id,
    trim(p_full_name),
    v_email,
    nullif(trim(coalesce(p_phone, '')), ''),
    coalesce(nullif(trim(p_job_title), ''), trim(p_full_name)),
    v_department_id,
    p_role_key,
    v_account_status
  )
  returning id into v_staff_id;

  perform private_app.write_audit(
    'tenant.staff_created',
    'staff_profile',
    v_staff_id::text,
    v_tenant_id,
    jsonb_build_object(
      'name', trim(p_full_name),
      'roleKey', p_role_key,
      'accountStatus', v_account_status
    )
  );

  return jsonb_build_object(
    'id', v_staff_id,
    'name', trim(p_full_name),
    'roleKey', p_role_key,
    'accountStatus', v_account_status
  );
end;
$$;

create or replace function public.v2_tenant_create_course(
  p_tenant_slug text,
  p_title_ar text,
  p_course_code text,
  p_category text default 'general',
  p_delivery_mode text default 'hybrid',
  p_duration_hours numeric default null,
  p_duration_days integer default null,
  p_title_en text default null,
  p_description text default null,
  p_certification_code text default null,
  p_price_minor bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_course_id uuid;
  v_code text;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(v_tenant_id, 'tenant.academy.write') then
    raise exception 'forbidden';
  end if;
  if p_title_ar is null or length(trim(p_title_ar)) < 2 then
    raise exception 'course_title_required';
  end if;
  if p_delivery_mode not in ('online', 'onsite', 'hybrid') then
    raise exception 'invalid_delivery_mode';
  end if;

  v_code := upper(regexp_replace(trim(coalesce(p_course_code, '')), '[^A-Za-z0-9_-]+', '-', 'g'));
  if v_code = '' then
    raise exception 'course_code_required';
  end if;
  if exists (
    select 1 from academy.courses c
    where c.tenant_id = v_tenant_id and c.course_code = v_code
  ) then
    raise exception 'course_exists';
  end if;

  insert into academy.courses (
    tenant_id,
    course_code,
    title_ar,
    title_en,
    category,
    description,
    delivery_mode,
    duration_hours,
    duration_days,
    price_minor,
    certification_code,
    status
  )
  values (
    v_tenant_id,
    v_code,
    trim(p_title_ar),
    nullif(trim(coalesce(p_title_en, '')), ''),
    coalesce(nullif(trim(p_category), ''), 'general'),
    nullif(trim(coalesce(p_description, '')), ''),
    p_delivery_mode,
    p_duration_hours,
    p_duration_days,
    p_price_minor,
    nullif(trim(coalesce(p_certification_code, '')), ''),
    'active'
  )
  returning id into v_course_id;

  perform private_app.write_audit(
    'tenant.course_created',
    'course',
    v_course_id::text,
    v_tenant_id,
    jsonb_build_object('courseCode', v_code, 'title', trim(p_title_ar))
  );

  return jsonb_build_object(
    'id', v_course_id,
    'courseCode', v_code,
    'titleAr', trim(p_title_ar),
    'status', 'active'
  );
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
  select * into v_tenant
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
      'defaultLocale', v_tenant.default_locale,
      'settings', v_tenant.settings
    ),
    'summary', jsonb_build_object(
      'contacts', 0,
      'openOpportunities', 0,
      'pipelineValueMinor', 0,
      'openTasks', 0,
      'overdueTasks', 0,
      'employees', (
        select count(*) from people.staff_profiles sp
        where sp.tenant_id = v_tenant.id and sp.employment_status = 'active'
      ),
      'services', (
        select count(*) from academy.courses c
        where c.tenant_id = v_tenant.id and c.status = 'active'
      ),
      'pendingSupport', (
        select count(*) from core.support_requests r
        where r.tenant_id = v_tenant.id
          and r.status not in ('done', 'rejected')
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
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sp.id,
        'membershipId', sp.membership_id,
        'name', sp.full_name,
        'email', sp.email,
        'phone', sp.phone,
        'jobTitle', sp.job_title,
        'role', coalesce(r.name_ar, sp.job_title),
        'roleKey', sp.role_key,
        'department', d.name_ar,
        'departmentKey', d.department_key,
        'status', sp.employment_status,
        'accountStatus', sp.account_status,
        'capacityMinutesWeekly', sp.capacity_minutes_weekly
      ) order by d.name_ar, sp.full_name)
      from people.staff_profiles sp
      left join people.departments d on d.id = sp.department_id
      left join lateral (
        select role.name_ar
        from access_control.roles role
        where role.scope = 'tenant'
          and role.role_key = sp.role_key
          and (role.tenant_id is null or role.tenant_id = sp.tenant_id)
        order by (role.tenant_id = sp.tenant_id) desc
        limit 1
      ) r on true
      where sp.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'courseCode', c.course_code,
        'nameAr', c.title_ar,
        'nameEn', c.title_en,
        'type', 'course',
        'category', c.category,
        'description', c.description,
        'deliveryMode', c.delivery_mode,
        'durationHours', c.duration_hours,
        'durationDays', c.duration_days,
        'durationMinutes', case
          when c.duration_hours is null then null
          else round(c.duration_hours * 60)
        end,
        'priceMinor', c.price_minor,
        'currency', c.currency,
        'certificationCode', c.certification_code,
        'status', c.status
      ) order by c.title_ar)
      from academy.courses c
      where c.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id,
        'key', d.department_key,
        'nameAr', d.name_ar,
        'nameEn', d.name_en,
        'status', d.status
      ) order by d.name_ar)
      from people.departments d
      where d.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'contacts', '[]'::jsonb,
    'opportunities', '[]'::jsonb,
    'activities', '[]'::jsonb,
    'tasks', '[]'::jsonb,
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

revoke execute on function public.v2_tenant_create_staff(
  text, text, text, text, text, text, text
) from public, anon;
revoke execute on function public.v2_tenant_create_course(
  text, text, text, text, text, numeric, integer, text, text, text, bigint
) from public, anon;

grant execute on function public.v2_tenant_create_staff(
  text, text, text, text, text, text, text
) to authenticated;
grant execute on function public.v2_tenant_create_course(
  text, text, text, text, text, numeric, integer, text, text, text, bigint
) to authenticated;

comment on schema people is 'Tenant-scoped staff directory independent from login accounts.';
comment on schema academy is 'Tenant-scoped course catalog and delivery runs.';

commit;
