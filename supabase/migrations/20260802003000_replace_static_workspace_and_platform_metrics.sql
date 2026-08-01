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
      'contacts', (
        select count(*)
        from sales_core.contacts c
        where c.tenant_id = v_tenant.id
      ),
      'openOpportunities', (
        select count(*)
        from sales_core.opportunities o
        where o.tenant_id = v_tenant.id
          and o.status = 'open'
      ),
      'pipelineValueMinor', (
        select coalesce(sum(o.value_minor), 0)
        from sales_core.opportunities o
        where o.tenant_id = v_tenant.id
          and o.status = 'open'
      ),
      'openTasks', (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.status not in ('completed', 'cancelled')
      ),
      'overdueTasks', (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.status not in ('completed', 'cancelled')
          and task.due_at < now()
      ),
      'employees', (
        select count(*)
        from people.staff_profiles sp
        where sp.tenant_id = v_tenant.id
          and sp.employment_status = 'active'
      ),
      'services', (
        select count(*)
        from academy.courses c
        where c.tenant_id = v_tenant.id
          and c.status = 'active'
      ),
      'pendingSupport', (
        select count(*)
        from core.support_requests r
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
        'employees', (
          select count(*)
          from people.staff_profiles sp
          where sp.tenant_id = t.id
            and sp.employment_status = 'active'
        ),
        'services', (
          select count(*)
          from academy.courses c
          where c.tenant_id = t.id
            and c.status = 'active'
        ),
        'openTasks', (
          select count(*)
          from work_core.tasks task
          where task.tenant_id = t.id
            and task.status not in ('completed', 'cancelled')
        ),
        'overdueTasks', (
          select count(*)
          from work_core.tasks task
          where task.tenant_id = t.id
            and task.status not in ('completed', 'cancelled')
            and task.due_at < now()
        ),
        'pipelineValueMinor', (
          select coalesce(sum(o.value_minor), 0)
          from sales_core.opportunities o
          where o.tenant_id = t.id
            and o.status = 'open'
        )
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
