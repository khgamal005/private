-- Canonical assignment-event contract for reports, UI filters, and XLSX exports.
-- Historical assignment counts must never depend on a contact's later outcome.
begin;

create or replace function private_app.v3_metric_is_valid_assigned_contact(
  p_contact_status text,
  p_lead_status text,
  p_lead_quality text
)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select coalesce(p_contact_status, 'active') not in (
      'unqualified',
      'duplicate',
      'invalid'
    )
    and coalesce(p_lead_status, 'new') not in (
      'wrong_number',
      'unqualified',
      'duplicate',
      'invalid'
    )
    and coalesce(p_lead_quality, 'unrated') not in (
      'wrong_number',
      'unqualified',
      'duplicate',
      'invalid'
    );
$$;

create or replace function private_app.v3_assignment_events(
  p_tenant_id uuid,
  p_from_at timestamptz,
  p_to_at timestamptz,
  p_staff_ids uuid[] default null
)
returns table (
  assignment_id uuid,
  tenant_id uuid,
  batch_id uuid,
  import_row_id uuid,
  contact_id uuid,
  assigned_staff_id uuid,
  assigned_by_staff_id uuid,
  assignment_strategy text,
  assignment_status text,
  assigned_at timestamptz,
  deadline_at timestamptz,
  first_action_at timestamptz,
  contact_name text,
  phone text,
  source text,
  campaign_name text,
  ad_set_name text,
  ad_name text,
  contact_status text,
  lead_status text,
  lead_quality text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    assignment.id,
    assignment.tenant_id,
    assignment.batch_id,
    assignment.import_row_id,
    assignment.contact_id,
    assignment.assigned_staff_id,
    assignment.assigned_by_staff_id,
    assignment.assignment_strategy,
    assignment.status,
    assignment.assigned_at,
    assignment.deadline_at,
    assignment.first_action_at,
    contact.full_name,
    contact.phone,
    coalesce(row_data.source, contact.source),
    coalesce(row_data.campaign_name, contact.campaign_name),
    row_data.ad_set_name,
    coalesce(row_data.ad_name, contact.ad_name),
    contact.status,
    contact.lead_status,
    contact.lead_quality
  from sales_core.lead_assignments assignment
  join sales_core.contacts contact
    on contact.id = assignment.contact_id
   and contact.tenant_id = assignment.tenant_id
  left join sales_core.lead_import_rows row_data
    on row_data.id = assignment.import_row_id
   and row_data.tenant_id = assignment.tenant_id
  where assignment.tenant_id = p_tenant_id
    and (p_from_at is null or assignment.assigned_at >= p_from_at)
    and (p_to_at is null or assignment.assigned_at < p_to_at)
    and (
      p_staff_ids is null
      or assignment.assigned_staff_id = any(p_staff_ids)
    );
$$;

create or replace function private_app.v3_assignment_metrics(
  p_tenant_id uuid,
  p_from_at timestamptz,
  p_to_at timestamptz,
  p_staff_ids uuid[] default null
)
returns table (
  assigned_customers bigint,
  assignment_operations bigint,
  valid_assigned_customers bigint,
  contacted_customers bigint,
  first_actions_on_time_customers bigint,
  average_first_response_minutes numeric,
  data_completeness_rate numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with events as (
    select event.*
    from private_app.v3_assignment_events(
      p_tenant_id,
      p_from_at,
      p_to_at,
      p_staff_ids
    ) event
  ),
  customer_rollup as (
    select
      event.contact_id,
      bool_or(private_app.v3_metric_is_valid_assigned_contact(
        event.contact_status,
        event.lead_status,
        event.lead_quality
      )) as valid,
      bool_or(event.first_action_at is not null) as contacted,
      bool_or(
        event.first_action_at is not null
        and event.first_action_at <= event.deadline_at
      ) as first_action_on_time,
      min(
        extract(epoch from (
          event.first_action_at - event.assigned_at
        )) / 60
      ) filter (
        where event.first_action_at is not null
      ) as first_response_minutes
    from events event
    group by event.contact_id
  )
  select
    count(*)::bigint,
    (select count(*)::bigint from events),
    count(*) filter (where rollup.valid)::bigint,
    count(*) filter (where rollup.contacted)::bigint,
    count(*) filter (where rollup.first_action_on_time)::bigint,
    round(avg(rollup.first_response_minutes)::numeric, 1),
    round(avg((
      (nullif(trim(contact.full_name), '') is not null)::integer
      + (
        nullif(trim(coalesce(contact.phone, '')), '') is not null
        or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
      )::integer
      + (nullif(trim(contact.source), '') is not null)::integer
      + (contact.interest_course_id is not null)::integer
      + (contact.owner_staff_id is not null)::integer
    ) * 20.0), 1)
  from customer_rollup rollup
  join sales_core.contacts contact on contact.id = rollup.contact_id;
$$;

create or replace function private_app.v3_assignment_staff_metrics(
  p_tenant_id uuid,
  p_from_at timestamptz,
  p_to_at timestamptz,
  p_staff_ids uuid[]
)
returns table (
  staff_id uuid,
  assigned_customers bigint,
  assignment_operations bigint,
  valid_assigned_customers bigint,
  contacted_customers bigint,
  first_actions_on_time_customers bigint,
  data_completeness_rate numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with events as (
    select event.*
    from private_app.v3_assignment_events(
      p_tenant_id,
      p_from_at,
      p_to_at,
      p_staff_ids
    ) event
  ),
  contact_rollup as (
    select
      event.assigned_staff_id,
      event.contact_id,
      count(*)::bigint as operations,
      bool_or(private_app.v3_metric_is_valid_assigned_contact(
        event.contact_status,
        event.lead_status,
        event.lead_quality
      )) as valid,
      bool_or(event.first_action_at is not null) as contacted,
      bool_or(
        event.first_action_at is not null
        and event.first_action_at <= event.deadline_at
      ) as first_action_on_time
    from events event
    group by event.assigned_staff_id, event.contact_id
  )
  select
    rollup.assigned_staff_id,
    count(*)::bigint,
    sum(rollup.operations)::bigint,
    count(*) filter (where rollup.valid)::bigint,
    count(*) filter (where rollup.contacted)::bigint,
    count(*) filter (where rollup.first_action_on_time)::bigint,
    round(avg((
      (nullif(trim(contact.full_name), '') is not null)::integer
      + (
        nullif(trim(coalesce(contact.phone, '')), '') is not null
        or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
      )::integer
      + (nullif(trim(contact.source), '') is not null)::integer
      + (contact.interest_course_id is not null)::integer
      + (contact.owner_staff_id is not null)::integer
    ) * 20.0), 1)
  from contact_rollup rollup
  join sales_core.contacts contact on contact.id = rollup.contact_id
  group by rollup.assigned_staff_id;
$$;

create or replace function public.v4_tenant_reports_snapshot(
  p_slug text,
  p_from date default null,
  p_to date default null,
  p_staff_id uuid default null,
  p_report text default 'overview',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_base jsonb;
  v_staff_ids uuid[] := '{}'::uuid[];
  v_from_date date;
  v_to_date date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_metrics record;
  v_employees jsonb := '[]'::jsonb;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.workspace.read'
  ) then
    raise exception 'forbidden';
  end if;

  -- The existing snapshot remains the employee-scope and report authority.
  v_base := public.v2_tenant_reports_snapshot_v3(
    p_slug,
    p_from,
    p_to,
    p_staff_id,
    p_report,
    p_limit,
    p_offset
  );

  v_from_date := (v_base #>> '{period,from}')::date;
  v_to_date := (v_base #>> '{period,to}')::date;
  v_from_at := v_from_date::timestamp at time zone v_tenant.timezone;
  v_to_at := (v_to_date + 1)::timestamp at time zone v_tenant.timezone;

  select coalesce(
    array_agg((item.value ->> 'staffId')::uuid order by item.ordinality),
    '{}'::uuid[]
  )
  into v_staff_ids
  from jsonb_array_elements(
    coalesce(v_base -> 'employees', '[]'::jsonb)
  ) with ordinality item(value, ordinality)
  where nullif(item.value ->> 'staffId', '') is not null;

  select metrics.*
  into v_metrics
  from private_app.v3_assignment_metrics(
    v_tenant.id,
    v_from_at,
    v_to_at,
    v_staff_ids
  ) metrics;

  with employee_rows as (
    select item.value, item.ordinality
    from jsonb_array_elements(
      coalesce(v_base -> 'employees', '[]'::jsonb)
    ) with ordinality item(value, ordinality)
  ),
  metrics as (
    select staff_metric.*
    from private_app.v3_assignment_staff_metrics(
      v_tenant.id,
      v_from_at,
      v_to_at,
      v_staff_ids
    ) staff_metric
  )
  select coalesce(jsonb_agg(
    employee.value || jsonb_build_object(
      'leadsAssigned', coalesce(metric.assigned_customers, 0),
      'assignmentOperations', coalesce(metric.assignment_operations, 0),
      'validAssignedLeads', coalesce(
        metric.valid_assigned_customers,
        0
      ),
      'contactedAssignedLeads', coalesce(metric.contacted_customers, 0),
      'dataCompletenessRate', metric.data_completeness_rate,
      'firstResponseSlaRate', case
        when coalesce(metric.assigned_customers, 0) > 0 then round(
          100.0 * metric.first_actions_on_time_customers
          / metric.assigned_customers,
          1
        )
      end
    ) order by employee.ordinality
  ), '[]'::jsonb)
  into v_employees
  from employee_rows employee
  left join metrics metric
    on metric.staff_id = (employee.value ->> 'staffId')::uuid;

  v_base := jsonb_set(
    v_base,
    '{summary}',
    coalesce(v_base -> 'summary', '{}'::jsonb) || jsonb_build_object(
      'leadsAssigned', coalesce(v_metrics.assigned_customers, 0),
      'assignmentOperations', coalesce(v_metrics.assignment_operations, 0),
      'validAssignedLeads', coalesce(
        v_metrics.valid_assigned_customers,
        0
      ),
      'contactedAssignedLeads', coalesce(
        v_metrics.contacted_customers,
        0
      ),
      'averageFirstResponseMinutes',
        v_metrics.average_first_response_minutes,
      'dataCompletenessRate', v_metrics.data_completeness_rate,
      'firstResponseSlaRate', case
        when coalesce(v_metrics.assigned_customers, 0) > 0 then round(
          100.0 * v_metrics.first_actions_on_time_customers
          / v_metrics.assigned_customers,
          1
        )
      end,
      'assignmentMetricContract', 'assignment-events-v1'
    ),
    true
  );
  v_base := jsonb_set(v_base, '{employees}', v_employees, true);
  v_base := jsonb_set(
    v_base,
    '{assignmentReconciliation}',
    jsonb_build_object(
      'contract', 'assignment-events-v1',
      'dateBasis', 'assigned_at',
      'timezone', v_tenant.timezone,
      'assignedCustomers', coalesce(v_metrics.assigned_customers, 0),
      'assignmentOperations', coalesce(v_metrics.assignment_operations, 0),
      'validAssignedCustomers', coalesce(
        v_metrics.valid_assigned_customers,
        0
      )
    ),
    true
  );

  return v_base;
end;
$$;

create or replace function public.v3_tenant_lead_intake_export_v1(
  p_slug text,
  p_section text default 'assignments',
  p_from date default null,
  p_to date default null,
  p_quality text default null,
  p_source text default null,
  p_campaign text default null,
  p_batch_id uuid default null,
  p_validation text default null,
  p_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_section text := lower(coalesce(
    nullif(trim(p_section), ''),
    'assignments'
  ));
  v_quality text := nullif(trim(p_quality), '');
  v_source text := nullif(trim(p_source), '');
  v_campaign text := nullif(trim(p_campaign), '');
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_result jsonb;
begin
  if v_section not in ('assignments', 'team') then
    return public.v2_tenant_lead_intake_export_v1(
      p_slug,
      p_section,
      p_from,
      p_to,
      p_quality,
      p_source,
      p_campaign,
      p_batch_id,
      p_validation,
      p_query
    );
  end if;

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.read'
  ) then
    raise exception 'forbidden';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'invalid_report_range';
  end if;
  if v_section = 'team'
     and not private_app.has_tenant_permission(
       v_tenant.id,
       'tenant.leads.distribute'
     ) then
    raise exception 'forbidden';
  end if;

  v_from_at := case when p_from is null then null
    else p_from::timestamp at time zone v_tenant.timezone
  end;
  v_to_at := case when p_to is null then null
    else (p_to + 1)::timestamp at time zone v_tenant.timezone
  end;

  if v_section = 'assignments' then
    with filtered_events as (
      select event.*
      from private_app.v3_assignment_events(
        v_tenant.id,
        v_from_at,
        v_to_at,
        null
      ) event
      where (
          v_quality is null
          or event.lead_quality = v_quality
          or event.lead_status = v_quality
        )
        and (v_source is null or event.source = v_source)
        and (v_campaign is null or event.campaign_name = v_campaign)
    )
    select jsonb_build_object(
      'metricContract', 'assignment-events-v1',
      'dateBasis', 'assigned_at',
      'reconciliation', jsonb_build_object(
        'assignmentOperations', count(*),
        'assignedCustomers', count(distinct event.contact_id),
        'validAssignedCustomers', count(distinct event.contact_id) filter (
          where private_app.v3_metric_is_valid_assigned_contact(
            event.contact_status,
            event.lead_status,
            event.lead_quality
          )
        )
      ),
      'assignments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'معرف عملية الإسناد', event_row.assignment_id,
          'العميل', event_row.contact_name,
          'رقم الجوال', event_row.phone,
          'المصدر', event_row.source,
          'الحملة', event_row.campaign_name,
          'مجموعة الإعلانات', event_row.ad_set_name,
          'الإعلان', event_row.ad_name,
          'المسؤول', assignee.full_name,
          'تم الإسناد بواسطة', coalesce(
            assigner.full_name,
            'إدارة المنشأة'
          ),
          'طريقة التوزيع', event_row.assignment_strategy,
          'حالة الإسناد', event_row.assignment_status,
          'تاريخ الإسناد', event_row.assigned_at,
          'موعد أول متابعة', event_row.deadline_at,
          'تاريخ أول استجابة', event_row.first_action_at,
          'زمن الاستجابة بالدقائق', case
            when event_row.first_action_at is null then null
            else round((extract(epoch from (
              event_row.first_action_at - event_row.assigned_at
            )) / 60)::numeric, 1)
          end,
          'حالة العميل', event_row.lead_status,
          'جودة الصف', event_row.lead_quality,
          'صالح بعد المعالجة',
            private_app.v3_metric_is_valid_assigned_contact(
              event_row.contact_status,
              event_row.lead_status,
              event_row.lead_quality
            ),
          'متأخر', (
            event_row.assignment_status = 'active'
            and event_row.first_action_at is null
            and event_row.deadline_at < now()
          )
        ) order by event_row.assigned_at desc, event_row.assignment_id)
        from filtered_events event_row
        join people.staff_profiles assignee
          on assignee.id = event_row.assigned_staff_id
        left join people.staff_profiles assigner
          on assigner.id = event_row.assigned_by_staff_id
      ), '[]'::jsonb)
    )
    into v_result
    from filtered_events event;

    return v_result;
  end if;

  select jsonb_build_object(
    'metricContract', 'assignment-events-v1',
    'dateBasis', 'assigned_at',
    'team', coalesce(jsonb_agg(jsonb_build_object(
      'الموظف', staff.full_name,
      'المسمى الوظيفي', staff.job_title,
      'قناة البيع', coalesce(profile.sales_channel, 'online'),
      'متاح للتوزيع', coalesce(profile.eligible_for_leads, false),
      'السعة اليومية', coalesce(profile.daily_capacity, 50),
      'الوزن', coalesce(profile.weight, 1),
      'إجمالي الإسنادات المطابقة', metrics.assignment_operations,
      'عمليات الإسناد المطابقة', metrics.assignment_operations,
      'العملاء المسندون المطابقون', metrics.assigned_customers,
      'العملاء الصالحون بعد المعالجة', metrics.valid_customers,
      'تم التواصل', metrics.contacted_customers,
      'بانتظار أول تواصل', metrics.active_assignments,
      'متأخر', metrics.overdue_assignments,
      'متوسط أول استجابة بالدقائق',
        metrics.average_first_response_minutes,
      'آخر إسناد', profile.last_assigned_at
    ) order by staff.full_name), '[]'::jsonb)
  )
  into v_result
  from people.staff_profiles staff
  left join sales_core.sales_assignment_profiles profile
    on profile.staff_id = staff.id
   and profile.tenant_id = staff.tenant_id
  left join lateral (
    select
      count(*)::bigint as assignment_operations,
      count(distinct event.contact_id)::bigint as assigned_customers,
      count(distinct event.contact_id) filter (
        where private_app.v3_metric_is_valid_assigned_contact(
          event.contact_status,
          event.lead_status,
          event.lead_quality
        )
      )::bigint as valid_customers,
      count(distinct event.contact_id) filter (
        where event.first_action_at is not null
      )::bigint as contacted_customers,
      count(*) filter (
        where event.assignment_status = 'active'
          and event.first_action_at is null
      )::bigint as active_assignments,
      count(*) filter (
        where event.assignment_status = 'active'
          and event.first_action_at is null
          and event.deadline_at < now()
      )::bigint as overdue_assignments,
      round((avg(
        extract(epoch from (
          event.first_action_at - event.assigned_at
        )) / 60
      ) filter (
        where event.first_action_at is not null
      ))::numeric, 1) as average_first_response_minutes
    from private_app.v3_assignment_events(
      v_tenant.id,
      v_from_at,
      v_to_at,
      array[staff.id]
    ) event
    where (
        v_quality is null
        or event.lead_quality = v_quality
        or event.lead_status = v_quality
      )
      and (v_source is null or event.source = v_source)
      and (v_campaign is null or event.campaign_name = v_campaign)
  ) metrics on true
  where staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
    and staff.role_key in (
      'sales_user',
      'sales_supervisor',
      'sales_manager'
    );

  return v_result;
end;
$$;

revoke all on function private_app.v3_metric_is_valid_assigned_contact(
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function private_app.v3_assignment_events(
  uuid,
  timestamptz,
  timestamptz,
  uuid[]
) from public, anon, authenticated;
revoke all on function private_app.v3_assignment_metrics(
  uuid,
  timestamptz,
  timestamptz,
  uuid[]
) from public, anon, authenticated;
revoke all on function private_app.v3_assignment_staff_metrics(
  uuid,
  timestamptz,
  timestamptz,
  uuid[]
) from public, anon, authenticated;

revoke all on function public.v4_tenant_reports_snapshot(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.v4_tenant_reports_snapshot(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) to authenticated;

revoke all on function public.v3_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) from public, anon;
grant execute on function public.v3_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) to authenticated;

comment on function private_app.v3_assignment_events(
  uuid,
  timestamptz,
  timestamptz,
  uuid[]
) is
  'Canonical immutable assignment-event source. Periods use assigned_at with inclusive lower and exclusive upper bounds; later contact outcomes never remove an event.';
comment on function private_app.v3_assignment_metrics(
  uuid,
  timestamptz,
  timestamptz,
  uuid[]
) is
  'assignment-events-v1 reconciliation metrics: distinct customers, operations, and current valid outcomes.';
comment on function public.v4_tenant_reports_snapshot(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) is
  'Tenant report snapshot reconciled against assignment-events-v1 while retaining v3 authorization and non-assignment metrics.';
comment on function public.v3_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) is
  'Lead-intake XLSX dataset. Assignment and team periods use assigned_at only and share assignment-events-v1.';

notify pgrst, 'reload schema';
commit;
