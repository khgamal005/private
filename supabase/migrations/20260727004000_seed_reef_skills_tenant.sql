begin;

do $$
declare
  v_organization_id uuid;
  v_tenant_id uuid;
  v_plan_id uuid;
  v_admin_subject_id uuid;
  v_membership_id uuid;
  v_owner_role_id uuid;
begin
  select s.id
  into v_admin_subject_id
  from access_control.subjects s
  where s.email = 'admin@marktone.sa'
    and s.status = 'active'
  limit 1;

  if v_admin_subject_id is null then
    raise exception 'platform_admin_subject_not_found';
  end if;

  insert into core.organizations (
    organization_key,
    legal_name,
    display_name,
    country_code,
    status,
    metadata
  )
  values (
    'org-reef-skills',
    'مركز ريف المهارات للتدريب',
    'مركز ريف المهارات للتدريب',
    'SA',
    'active',
    jsonb_build_object(
      'source', 'first_live_tenant',
      'commercialStatus', 'full_access'
    )
  )
  on conflict (organization_key) do update
  set legal_name = excluded.legal_name,
      display_name = excluded.display_name,
      country_code = excluded.country_code,
      status = 'active',
      metadata = core.organizations.metadata || excluded.metadata
  returning id into v_organization_id;

  insert into core.tenants (
    organization_id,
    tenant_key,
    slug,
    name,
    legal_name,
    status,
    country_code,
    timezone,
    default_locale,
    settings
  )
  values (
    v_organization_id,
    'tenant-reef-skills',
    'reef-skills',
    'مركز ريف المهارات للتدريب',
    'مركز ريف المهارات للتدريب',
    'active',
    'SA',
    'Asia/Riyadh',
    'ar-SA',
    jsonb_build_object(
      'planMode', 'full',
      'onboarding', jsonb_build_object(
        'managerProfiles', 'pending',
        'staffContacts', 'pending',
        'coursePricing', 'pending',
        'courseSchedules', 'pending'
      )
    )
  )
  on conflict (tenant_key) do update
  set organization_id = excluded.organization_id,
      name = excluded.name,
      legal_name = excluded.legal_name,
      status = 'active',
      country_code = excluded.country_code,
      timezone = excluded.timezone,
      default_locale = excluded.default_locale,
      settings = core.tenants.settings || excluded.settings
  returning id into v_tenant_id;

  insert into core.tenant_modules (
    tenant_id,
    module_id,
    enabled,
    configuration,
    enabled_at
  )
  select
    v_tenant_id,
    m.id,
    true,
    jsonb_build_object('entitlement', 'full'),
    now()
  from core.modules m
  where m.status in ('active', 'beta')
  on conflict (tenant_id, module_id) do update
  set enabled = true,
      configuration = core.tenant_modules.configuration
        || jsonb_build_object('entitlement', 'full'),
      enabled_at = coalesce(core.tenant_modules.enabled_at, now()),
      updated_at = now();

  select p.id
  into v_plan_id
  from catalog.plans p
  where p.plan_key = 'full'
    and p.status = 'active'
  limit 1;

  if v_plan_id is null then
    raise exception 'full_plan_not_found';
  end if;

  update catalog.subscriptions
  set status = 'cancelled',
      cancel_at_period_end = false
  where tenant_id = v_tenant_id
    and status in ('trialing', 'active', 'past_due', 'paused')
    and plan_id <> v_plan_id;

  if exists (
    select 1
    from catalog.subscriptions s
    where s.tenant_id = v_tenant_id
      and s.plan_id = v_plan_id
      and s.status in ('trialing', 'active', 'past_due', 'paused')
  ) then
    update catalog.subscriptions
    set status = 'active',
        period_start = now(),
        period_end = null,
        cancel_at_period_end = false
    where tenant_id = v_tenant_id
      and plan_id = v_plan_id
      and status in ('trialing', 'active', 'past_due', 'paused');
  else
    insert into catalog.subscriptions (
      tenant_id,
      plan_id,
      status,
      period_start,
      period_end,
      cancel_at_period_end
    )
    values (
      v_tenant_id,
      v_plan_id,
      'active',
      now(),
      null,
      false
    );
  end if;

  select m.id
  into v_membership_id
  from access_control.memberships m
  where m.subject_id = v_admin_subject_id
    and m.tenant_id = v_tenant_id
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
      v_admin_subject_id,
      v_tenant_id,
      'tenant',
      'active'
    )
    returning id into v_membership_id;
  else
    update access_control.memberships
    set status = 'active'
    where id = v_membership_id;
  end if;

  select r.id
  into v_owner_role_id
  from access_control.roles r
  where r.scope = 'tenant'
    and r.role_key = 'tenant_owner'
    and r.tenant_id is null
  limit 1;

  insert into access_control.membership_roles (membership_id, role_id)
  values (v_membership_id, v_owner_role_id)
  on conflict do nothing;

  insert into people.departments (
    tenant_id,
    department_key,
    name_ar,
    name_en
  )
  values
    (v_tenant_id, 'management', 'الإدارة', 'Management'),
    (v_tenant_id, 'sales', 'المبيعات', 'Sales'),
    (v_tenant_id, 'customer_service', 'خدمة العملاء', 'Customer Service'),
    (v_tenant_id, 'data', 'البيانات والتحليلات', 'Data & Analytics')
  on conflict (tenant_id, department_key) do update
  set name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      status = 'active';

  insert into people.staff_profiles (
    tenant_id,
    employee_code,
    full_name,
    job_title,
    department_id,
    role_key,
    employment_status,
    account_status,
    metadata
  )
  select
    v_tenant_id,
    seed.employee_code,
    seed.full_name,
    seed.job_title,
    d.id,
    seed.role_key,
    'active',
    'profile_only',
    jsonb_build_object('source', 'initial_reef_team')
  from (
    values
      ('REEF-SALES-001', 'نور', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-002', 'مي', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-003', 'ليلى', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-004', 'روان', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-005', 'عبدالجليل', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-006', 'عمر', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-007', 'رزان', 'مسؤول مبيعات', 'sales', 'sales_user'),
      ('REEF-SALES-008', 'ياسمين', 'مشرف مبيعات', 'sales', 'sales_supervisor'),
      ('REEF-CS-001', 'داليا', 'خدمة عملاء', 'customer_service', 'customer_service'),
      ('REEF-DATA-001', 'وعد', 'مسؤول بيانات', 'data', 'data_officer'),
      ('REEF-DATA-002', 'ياسر', 'محلل بيانات', 'data', 'data_analyst')
  ) as seed(employee_code, full_name, job_title, department_key, role_key)
  join people.departments d
    on d.tenant_id = v_tenant_id
   and d.department_key = seed.department_key
  where not exists (
    select 1
    from people.staff_profiles existing
    where existing.tenant_id = v_tenant_id
      and existing.employee_code = seed.employee_code
  );

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
    certification_code,
    status,
    metadata
  )
  values
    (
      v_tenant_id,
      'PMP',
      'دورة إدارة المشاريع الاحترافية (PMP)',
      'Project Management Professional (PMP)',
      'project_management',
      'برنامج تحضيري احترافي لإدارة المشاريع وممارسات اختبار PMP.',
      'hybrid',
      35,
      5,
      'PMP',
      'active',
      jsonb_build_object('pricingStatus', 'pending', 'scheduleStatus', 'pending')
    ),
    (
      v_tenant_id,
      'AI-SKILLS',
      'دورة مهارات الذكاء الاصطناعي',
      'Artificial Intelligence Skills',
      'technology',
      'تطبيقات عملية للذكاء الاصطناعي ورفع الإنتاجية في بيئة العمل.',
      'hybrid',
      25,
      5,
      null,
      'active',
      jsonb_build_object('pricingStatus', 'pending', 'scheduleStatus', 'pending')
    ),
    (
      v_tenant_id,
      'POWER-BI',
      'دورة تحليل البيانات باستخدام Power BI',
      'Data Analysis with Power BI',
      'data_analytics',
      'إعداد لوحات المعلومات وتحليل البيانات وبناء المؤشرات باستخدام Power BI.',
      'hybrid',
      25,
      5,
      null,
      'active',
      jsonb_build_object('pricingStatus', 'pending', 'scheduleStatus', 'pending')
    ),
    (
      v_tenant_id,
      'KPI',
      'دورة مؤشرات الأداء الرئيسية (KPI)',
      'Key Performance Indicators (KPI)',
      'management',
      'تصميم مؤشرات الأداء وقياسها وربطها بالأهداف والنتائج.',
      'hybrid',
      25,
      5,
      null,
      'active',
      jsonb_build_object('pricingStatus', 'pending', 'scheduleStatus', 'pending')
    ),
    (
      v_tenant_id,
      'EXCEL-ADV',
      'دورة Microsoft Excel المتقدم',
      'Advanced Microsoft Excel',
      'productivity',
      'تحليل وتنظيم البيانات واستخدام الدوال والأدوات المتقدمة في Excel.',
      'hybrid',
      25,
      5,
      null,
      'active',
      jsonb_build_object('pricingStatus', 'pending', 'scheduleStatus', 'pending')
    ),
    (
      v_tenant_id,
      'APHRI',
      'البرنامج التحضيري لشهادة aPHRi',
      'Associate Professional in Human Resources International',
      'human_resources',
      'برنامج تحضيري لمفاهيم وممارسات الموارد البشرية الدولية.',
      'hybrid',
      null,
      null,
      'aPHRi',
      'active',
      jsonb_build_object('durationStatus', 'pending', 'pricingStatus', 'pending', 'scheduleStatus', 'pending')
    )
  on conflict (tenant_id, course_code) do update
  set title_ar = excluded.title_ar,
      title_en = excluded.title_en,
      category = excluded.category,
      description = excluded.description,
      delivery_mode = excluded.delivery_mode,
      duration_hours = excluded.duration_hours,
      duration_days = excluded.duration_days,
      certification_code = excluded.certification_code,
      status = 'active',
      metadata = academy.courses.metadata || excluded.metadata;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant_id,
    v_admin_subject_id,
    'tenant.reef_seeded',
    'tenant',
    v_tenant_id::text,
    jsonb_build_object(
      'staffProfiles', 11,
      'courses', 6,
      'planKey', 'full',
      'managerProfilesPending', true
    )
  );
end;
$$;

commit;
