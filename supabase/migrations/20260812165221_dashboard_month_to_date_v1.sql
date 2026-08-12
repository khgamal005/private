-- Give the executive dashboard one tenant-local month-to-date contract.
begin;

create index if not exists lead_status_history_tenant_contact_qualified_idx
on sales_core.lead_status_history (tenant_id, contact_id, changed_at)
where to_status in (
  'interested',
  'very_interested',
  'awaiting_payment',
  'payment_submitted',
  'paid'
);

create index if not exists sales_contacts_tenant_created_dashboard_idx
on sales_core.contacts (tenant_id, created_at)
include (status, lead_status, source);

create index if not exists academy_enrollments_tenant_enrolled_dashboard_idx
on academy.enrollments (tenant_id, enrolled_at)
include (status);

create or replace function public.v3_tenant_marketing_month_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_timezone text;
  v_from date;
  v_to date;
  v_snapshot jsonb;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  -- The underlying snapshot performs the tenant permission check. Resolve the
  -- range here so the dashboard never falls back to a rolling 30-day window.
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_to := (now() at time zone v_timezone)::date;
  v_from := date_trunc('month', v_to::timestamp)::date;
  v_snapshot := public.v2_tenant_marketing_hub_snapshot(
    p_slug,
    v_from,
    v_to
  );

  return v_snapshot || jsonb_build_object(
    'rangeMode', 'month_to_date',
    'range', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'timeZone', v_timezone
    )
  );
end;
$$;

revoke all on function public.v3_tenant_marketing_month_snapshot(text)
from public, anon;
grant execute on function public.v3_tenant_marketing_month_snapshot(text)
to authenticated;

comment on function public.v3_tenant_marketing_month_snapshot(text) is
  'Tenant-authorized marketing snapshot fixed to the current tenant-local month through today.';

create or replace function public.v2_tenant_role_dashboard_snapshot_v6(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_tenant core.tenants%rowtype;
  v_role_key text;
  v_can_crm boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_timezone text;
  v_today date;
  v_month_date date;
  v_month_start timestamptz;
  v_now timestamptz := clock_timestamp();
  v_distributed_this_month bigint := 0;
  v_paid_from_distributed bigint := 0;
  v_closing_rate numeric;
  v_qualified_entered_month bigint := 0;
  v_qualified_open_month bigint := 0;
  v_qualified_won_month bigint := 0;
  v_new_contacts_month bigint := 0;
  v_verified_admissions_month bigint := 0;
  v_activities_month bigint := 0;
  v_due_tasks_month bigint := 0;
  v_completed_due_tasks_month bigint := 0;
  v_completed_tasks_month bigint := 0;
  v_on_time_tasks_month bigint := 0;
  v_task_completion_rate numeric := 0;
  v_new_enrollments_month bigint := 0;
  v_sessions_month bigint := 0;
  v_attendance_month bigint := 0;
  v_attended_month bigint := 0;
  v_attendance_rate_month numeric := 0;
  v_sources jsonb := '[]'::jsonb;
  v_crm_month_available boolean := false;
  v_training_month_available boolean := false;
begin
  -- v5 remains the authorization boundary and WooCommerce revenue source.
  v_snapshot := public.v2_tenant_role_dashboard_snapshot_v5(p_slug);

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  v_role_key := coalesce(
    nullif(v_snapshot #>> '{viewer,roleKey}', ''),
    'tenant_user'
  );
  v_can_crm := coalesce(
    (v_snapshot #>> '{permissions,crm}')::boolean,
    false
  );
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_month_date := date_trunc('month', v_today)::date;
  v_month_start := v_month_date::timestamp at time zone v_timezone;

  v_snapshot := jsonb_set(
    v_snapshot,
    '{period}',
    jsonb_build_object(
      'mode', 'month_to_date',
      'from', v_month_date,
      'to', v_today,
      'timeZone', v_timezone
    ),
    true
  );

  if v_role_key not in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  ) then
    return v_snapshot;
  end if;

  select coalesce(array_agg(staff.id order by staff.id), '{}'::uuid[])
  into v_scope_staff_ids
  from people.staff_profiles staff
  where staff.tenant_id = v_tenant.id;

  if v_can_crm then
    v_crm_month_available := true;
    with assignment_cohort as (
      select
        assignment.contact_id,
        min(assignment.assigned_at) as first_assigned_at
      from sales_core.lead_assignments assignment
      where assignment.tenant_id = v_tenant.id
        and assignment.assigned_staff_id = any(v_scope_staff_ids)
        and assignment.assigned_at >= v_month_start
        and assignment.assigned_at <= v_now
      group by assignment.contact_id
    )
    select
      count(*),
      count(*) filter (
        where exists (
          select 1
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant.id
            and handoff.contact_id = assignment.contact_id
            and handoff.payment_status = 'verified'
            and handoff.paid_at >= assignment.first_assigned_at
            and handoff.paid_at >= v_month_start
            and handoff.paid_at <= v_now
        )
      )
    into v_distributed_this_month, v_paid_from_distributed
    from assignment_cohort assignment;

    if v_distributed_this_month > 0 then
      v_closing_rate := round(
        least(
          100.0,
          100.0 * v_paid_from_distributed
            / v_distributed_this_month
        ),
        1
      );
    end if;

    with first_qualified as (
      select
        history.contact_id,
        min(history.changed_at) as first_qualified_at
      from sales_core.lead_status_history history
      where history.tenant_id = v_tenant.id
        and history.to_status in (
          'interested',
          'very_interested',
          'awaiting_payment',
          'payment_submitted',
          'paid'
        )
      group by history.contact_id
    ), month_qualified as (
      select qualified.contact_id
      from first_qualified qualified
      where qualified.first_qualified_at >= v_month_start
        and qualified.first_qualified_at <= v_now
    )
    select
      count(*),
      count(*) filter (
        where private_app.v2_metric_is_countable_contact(
          contact.status,
          contact.lead_status
        )
          and contact.lead_status in (
            'interested',
            'very_interested',
            'awaiting_payment',
            'payment_submitted'
          )
      ),
      count(*) filter (where contact.lead_status = 'paid')
    into
      v_qualified_entered_month,
      v_qualified_open_month,
      v_qualified_won_month
    from month_qualified qualified
    join sales_core.contacts contact
      on contact.id = qualified.contact_id
     and contact.tenant_id = v_tenant.id;

    select count(*)
    into v_new_contacts_month
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.created_at >= v_month_start
      and contact.created_at <= v_now
      and private_app.v2_metric_is_countable_contact(
        contact.status,
        contact.lead_status
      );

    select count(*)
    into v_activities_month
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.actor_staff_id = any(v_scope_staff_ids)
      and activity.occurred_at >= v_month_start
      and activity.occurred_at <= v_now;

    with source_contacts as (
      select
        contact.id,
        coalesce(nullif(trim(contact.source), ''), 'غير محدد') as source,
        exists (
          select 1
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant.id
            and handoff.contact_id = contact.id
            and handoff.payment_status = 'verified'
            and handoff.paid_at >= v_month_start
            and handoff.paid_at <= v_now
        ) as paid
      from sales_core.contacts contact
      where contact.tenant_id = v_tenant.id
        and contact.created_at >= v_month_start
        and contact.created_at <= v_now
        and private_app.v2_metric_is_countable_contact(
          contact.status,
          contact.lead_status
        )
    ), source_stats as (
      select
        source,
        count(*) as total,
        count(*) filter (where paid) as paid
      from source_contacts
      group by source
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'source', source.source,
      'total', source.total,
      'paid', source.paid,
      'conversionRate', case when source.total > 0 then
        round(100.0 * source.paid / source.total, 1)
      else 0 end
    ) order by source.total desc, source.source), '[]'::jsonb)
    into v_sources
    from (
      select *
      from source_stats
      order by total desc, source
      limit 5
    ) source;
  end if;

  if coalesce((v_snapshot #>> '{permissions,training}')::boolean,false)
  then
    v_training_month_available := true;
    select count(distinct handoff.contact_id)
    into v_verified_admissions_month
    from academy.registration_handoffs handoff
    where handoff.tenant_id = v_tenant.id
      and handoff.payment_status = 'verified'
      and handoff.paid_at >= v_month_start
      and handoff.paid_at <= v_now;
  end if;

  select
    count(*) filter (
      where task.due_at >= v_month_start
        and task.due_at <= v_now
        and task.status <> 'cancelled'
    ),
    count(*) filter (
      where task.due_at >= v_month_start
        and task.due_at <= v_now
        and task.status = 'completed'
    ),
    count(*) filter (
      where task.status = 'completed'
        and task.completed_at >= v_month_start
        and task.completed_at <= v_now
    ),
    count(*) filter (
      where task.status = 'completed'
        and task.completed_at >= v_month_start
        and task.completed_at <= v_now
        and task.completed_at <= task.due_at
    )
  into
    v_due_tasks_month,
    v_completed_due_tasks_month,
    v_completed_tasks_month,
    v_on_time_tasks_month
  from work_core.tasks task
  where task.tenant_id = v_tenant.id;

  if v_due_tasks_month > 0 then
    v_task_completion_rate := round(
      100.0 * v_completed_due_tasks_month / v_due_tasks_month,
      1
    );
  end if;

  if coalesce((v_snapshot #>> '{permissions,training}')::boolean,false)
  then
    v_training_month_available := true;
    select count(*)
    into v_new_enrollments_month
    from academy.enrollments enrollment
    where enrollment.tenant_id = v_tenant.id
      and enrollment.enrolled_at >= v_month_start
      and enrollment.enrolled_at <= v_now;

    select count(*)
    into v_sessions_month
    from academy.course_run_sessions session
    where session.tenant_id = v_tenant.id
      and session.starts_at >= v_month_start
      and session.starts_at <= v_now
      and session.status <> 'cancelled';

    select
      count(*),
      count(*) filter (where attendance.status in ('present', 'late'))
    into v_attendance_month, v_attended_month
    from academy.attendance_records attendance
    where attendance.tenant_id = v_tenant.id
      and attendance.marked_at >= v_month_start
      and attendance.marked_at <= v_now;
  end if;

  if v_attendance_month > 0 then
    v_attendance_rate_month := round(
      100.0 * v_attended_month / v_attendance_month,
      1
    );
  end if;

  v_snapshot := jsonb_set(
    v_snapshot,
    '{executive}',
    coalesce(v_snapshot -> 'executive', '{}'::jsonb)
      || jsonb_build_object(
        'newContactsThisMonth', v_new_contacts_month,
        'verifiedAdmissionsThisMonth', v_verified_admissions_month,
        'activitiesThisMonth', v_activities_month,
        'dueTasksThisMonthToDate', v_due_tasks_month,
        'completedDueTasksThisMonthToDate',
          v_completed_due_tasks_month,
        'completedTasksThisMonth', v_completed_tasks_month,
        'onTimeTasksThisMonth', v_on_time_tasks_month,
        'taskCompletionRateThisMonth', v_task_completion_rate,
        'crmMonthAvailable', v_crm_month_available,
        'trainingMonthAvailable', v_training_month_available
      ),
    true
  );

  v_snapshot := jsonb_set(
    v_snapshot,
    '{sales}',
    coalesce(v_snapshot -> 'sales', '{}'::jsonb)
      || jsonb_build_object(
        'distributedThisMonth', v_distributed_this_month,
        'paidFromDistributedThisMonth', v_paid_from_distributed,
        'closingRate', v_closing_rate,
        'conversionRate', v_closing_rate,
        'qualifiedEnteredThisMonth', v_qualified_entered_month,
        'qualifiedOpenFromMonth', v_qualified_open_month,
        'qualifiedWonFromMonth', v_qualified_won_month,
        'closingMethod', 'same_month_assignment_and_payment',
        'monthAvailable', v_crm_month_available
      ),
    true
  );

  v_snapshot := jsonb_set(
    v_snapshot,
    '{training}',
    coalesce(v_snapshot -> 'training', '{}'::jsonb)
      || jsonb_build_object(
        'newEnrollmentsThisMonth', v_new_enrollments_month,
        'sessionsThisMonth', v_sessions_month,
        'attendanceRecordsThisMonth', v_attendance_month,
        'attendanceRateThisMonth', v_attendance_rate_month,
        'monthAvailable', v_training_month_available
      ),
    true
  );

  v_snapshot := jsonb_set(v_snapshot, '{sources}', v_sources, true);
  return v_snapshot;
end;
$$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v6(text)
from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v6(text)
to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot_v6(text) is
  'Executive dashboard with one tenant-local month-to-date period, same-month cohort conversion, qualified-flow metrics, tasks, training, and monthly sources.';

commit;
