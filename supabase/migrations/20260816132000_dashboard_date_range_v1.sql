-- Range-aware executive dashboard. The existing v6 contract remains the
-- authorization/current-state base; date-sensitive metrics come from the
-- reviewed tenant reporting contract and tenant-local half-open boundaries.
begin;

create or replace function public.v2_tenant_role_dashboard_snapshot_v7(
  p_slug text,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_snapshot jsonb;
  v_report jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_role_key text;
  v_can_crm boolean := false;
  v_timezone text;
  v_today date;
  v_from_date date;
  v_to_date date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_is_month_to_date boolean := false;
  v_distributed bigint := 0;
  v_paid_from_distributed bigint := 0;
  v_closing_rate numeric;
  v_qualified_entered bigint := 0;
  v_qualified_open bigint := 0;
  v_qualified_won bigint := 0;
  v_verified_admissions bigint := 0;
  v_verified_revenue_minor bigint := 0;
  v_new_contacts bigint := 0;
  v_due_tasks bigint := 0;
  v_completed_due_tasks bigint := 0;
  v_task_completion_rate numeric;
  v_missed_calls bigint := 0;
  v_new_enrollments bigint := 0;
  v_sessions bigint := 0;
  v_attendance_records bigint := 0;
  v_attended bigint := 0;
  v_attendance_rate numeric := 0;
  v_issued_certificates bigint := 0;
  v_sources jsonb := '[]'::jsonb;
  v_team jsonb := '[]'::jsonb;
  v_woo jsonb := '{}'::jsonb;
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

  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_from_date := coalesce(
    p_from,
    date_trunc('month', v_today::timestamp)::date
  );
  v_to_date := coalesce(p_to, v_today);

  if v_from_date > v_to_date
     or v_to_date > v_today
     or v_to_date - v_from_date > 365 then
    raise exception 'invalid_dashboard_period';
  end if;

  v_from_at := v_from_date::timestamp at time zone v_timezone;
  v_to_at := (v_to_date + 1)::timestamp at time zone v_timezone;
  v_is_month_to_date := v_from_date = date_trunc(
    'month',
    v_today::timestamp
  )::date and v_to_date = v_today;

  -- v6 owns role resolution, permissions, current queues, readiness alerts,
  -- integration state, and the canonical current-month Woo report.
  v_snapshot := public.v2_tenant_role_dashboard_snapshot_v6(p_slug);
  v_role_key := coalesce(
    nullif(v_snapshot #>> '{viewer,roleKey}', ''),
    'tenant_user'
  );
  v_can_crm := coalesce(
    (v_snapshot #>> '{permissions,crm}')::boolean,
    false
  );

  -- The interactive range is intentionally restricted to the executive
  -- command center in this release. Other role dashboards retain v6 exactly.
  if v_role_key not in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  ) then
    return v_snapshot;
  end if;
  -- The date-aware executive contract contains CRM-derived cross-system
  -- metrics. Never invoke the privileged reporting function without CRM read.
  if not v_can_crm then
    return v_snapshot;
  end if;

  -- Reuse the reporting center's reviewed tenant/team authorization and its
  -- reconciled date contract for common CRM, task, call, source, team, and
  -- daily-series values.
  v_report := public.v4_tenant_reports_snapshot(
    p_slug,
    v_from_date,
    v_to_date,
    null,
    'overview',
    100,
    0
  );
  v_summary := coalesce(v_report -> 'summary', '{}'::jsonb);

  select count(*)
  into v_new_contacts
  from sales_core.contacts contact
  where contact.tenant_id = v_tenant.id
    and contact.created_at >= v_from_at
    and contact.created_at < v_to_at
    and private_app.v2_metric_is_countable_contact(
      contact.status,
      contact.lead_status
    );

  select
    count(*),
    count(*) filter (
      where task.status = 'completed'
        and task.completed_at < v_to_at
    )
  into v_due_tasks, v_completed_due_tasks
  from work_core.tasks task
  where task.tenant_id = v_tenant.id
    and task.due_at >= v_from_at
    and task.due_at < v_to_at
    and task.status <> 'cancelled';

  if v_due_tasks > 0 then
    v_task_completion_rate := round(
      100.0 * v_completed_due_tasks / v_due_tasks,
      1
    );
  end if;

  select coalesce(sum((item.value ->> 'count')::bigint), 0)
  into v_missed_calls
  from jsonb_array_elements(
    coalesce(v_report -> 'callBreakdown', '[]'::jsonb)
  ) item(value)
  where item.value ->> 'key' in ('NO ANSWER', 'ABANDONED', 'BUSY');

  if v_can_crm then
    with assignment_cohort as (
    select
      assignment.contact_id,
      min(assignment.assigned_at) as first_assigned_at
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
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
          and handoff.paid_at < v_to_at
      )
    )
  into v_distributed, v_paid_from_distributed
    from assignment_cohort assignment;

    if v_distributed > 0 then
      v_closing_rate := round(
        least(100.0,100.0 * v_paid_from_distributed / v_distributed),
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
  ), range_qualified as (
    select qualified.contact_id
    from first_qualified qualified
    where qualified.first_qualified_at >= v_from_at
      and qualified.first_qualified_at < v_to_at
  ), latest_status as (
    select distinct on (history.contact_id)
      history.contact_id,
      history.to_status
    from sales_core.lead_status_history history
    join range_qualified qualified
      on qualified.contact_id = history.contact_id
    where history.tenant_id = v_tenant.id
      and history.changed_at < v_to_at
    order by history.contact_id, history.changed_at desc
  )
  select
    count(*),
    count(*) filter (
      where status.to_status in (
          'interested',
          'very_interested',
          'awaiting_payment',
          'payment_submitted'
      )
    ),
    count(*) filter (where status.to_status = 'paid')
  into v_qualified_entered, v_qualified_open, v_qualified_won
    from range_qualified qualified
    join latest_status status
      on status.contact_id = qualified.contact_id;
  end if;

  if coalesce(
    (v_snapshot #>> '{permissions,training}')::boolean,
    false
  ) then
    select
      count(distinct handoff.contact_id),
      coalesce(sum(handoff.payment_amount_minor), 0)
    into v_verified_admissions, v_verified_revenue_minor
    from academy.registration_handoffs handoff
    where handoff.tenant_id = v_tenant.id
      and handoff.payment_status = 'verified'
      and handoff.paid_at >= v_from_at
      and handoff.paid_at < v_to_at;

    select count(*)
    into v_new_enrollments
    from academy.enrollments enrollment
    where enrollment.tenant_id = v_tenant.id
      and enrollment.enrolled_at >= v_from_at
      and enrollment.enrolled_at < v_to_at;

    select count(*)
    into v_sessions
    from academy.course_run_sessions session
    where session.tenant_id = v_tenant.id
      and session.starts_at >= v_from_at
      and session.starts_at < v_to_at
      and session.status <> 'cancelled';

    select
      count(*),
      count(*) filter (where attendance.status in ('present', 'late'))
    into v_attendance_records, v_attended
    from academy.attendance_records attendance
    where attendance.tenant_id = v_tenant.id
      and attendance.marked_at >= v_from_at
      and attendance.marked_at < v_to_at;

    select count(*)
    into v_issued_certificates
    from academy.certificates certificate
    where certificate.tenant_id = v_tenant.id
      and certificate.status = 'issued'
      and certificate.issued_at >= v_from_at
      and certificate.issued_at < v_to_at;
  end if;

  if v_attendance_records > 0 then
    v_attendance_rate := round(
      100.0 * v_attended / v_attendance_records,
      1
    );
  end if;

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
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
      ) as paid
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
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

  with report_member as (
    select member.value, member.ordinality
    from jsonb_array_elements(
      coalesce(v_report -> 'employees', '[]'::jsonb)
    ) with ordinality member(value, ordinality)
  ), base_member as (
    select member.value
    from jsonb_array_elements(
      coalesce(v_snapshot -> 'team', '[]'::jsonb)
    ) member(value)
  ), paid_member as (
    select
      owner.staff_id,
      count(distinct handoff.contact_id) as paid_contacts
    from academy.registration_handoffs handoff
    join lateral (
      select assignment.assigned_staff_id as staff_id
      from sales_core.lead_assignments assignment
      where assignment.tenant_id = v_tenant.id
        and assignment.contact_id = handoff.contact_id
        and assignment.assigned_at <= handoff.paid_at
      order by assignment.assigned_at desc
      limit 1
    ) owner on true
    where handoff.tenant_id = v_tenant.id
      and handoff.payment_status = 'verified'
      and handoff.paid_at >= v_from_at
      and handoff.paid_at < v_to_at
      and owner.staff_id is not null
    group by owner.staff_id
  )
  select coalesce(jsonb_agg(
    coalesce(base.value, '{}'::jsonb)
      || report.value
      || jsonb_build_object(
        'activeLeads', coalesce(
          (report.value ->> 'leadsAssigned')::bigint,
          0
        ),
        'activitiesToday', coalesce(
          (report.value ->> 'activities')::bigint,
          0
        ),
        'paidThisMonth', coalesce(
          paid.paid_contacts,
          0
        ),
        'totalCalls', coalesce(
          (report.value ->> 'calls')::bigint,
          0
        ),
        'answerRate', coalesce(
          (report.value ->> 'callAnswerRate')::numeric,
          0
        )
      )
    order by report.ordinality
  ), '[]'::jsonb)
  into v_team
  from report_member report
  left join base_member base
    on base.value ->> 'staffId' = report.value ->> 'staffId'
  left join paid_member paid
    on paid.staff_id::text = report.value ->> 'staffId';

  v_woo := coalesce(
    v_snapshot #> '{executive,woocommerceRevenue}',
    '{}'::jsonb
  );
  if v_is_month_to_date then
    v_woo := v_woo || jsonb_build_object(
      'rangeAvailable', true,
      'range', jsonb_build_object(
        'from', v_from_date,
        'to', v_to_date,
        'timeZone', coalesce(
          nullif(v_woo ->> 'timeZone', ''),
          v_timezone
        )
      )
    );
  else
    -- The Woo Analytics cache currently stores only the official current MTD
    -- report. Never place that number under a historical/custom date label.
    v_woo := (v_woo - 'totals') || jsonb_build_object(
      'available', false,
      'rangeAvailable', false,
      'error', 'woocommerce_range_not_cached',
      'totals', '{}'::jsonb,
      'range', jsonb_build_object(
        'from', v_from_date,
        'to', v_to_date,
        'timeZone', coalesce(
          nullif(v_woo ->> 'timeZone', ''),
          v_timezone
        )
      )
    );
  end if;

  v_snapshot := jsonb_set(
    v_snapshot,
    '{period}',
    jsonb_build_object(
      'mode', case
        when v_is_month_to_date then 'month_to_date'
        else 'date_range'
      end,
      'from', v_from_date,
      'to', v_to_date,
      'today', v_today,
      'days', v_to_date - v_from_date + 1,
      'timeZone', v_timezone
    ),
    true
  );
  v_snapshot := jsonb_set(v_snapshot, '{generatedAt}', to_jsonb(now()), true);
  v_snapshot := jsonb_set(
    v_snapshot,
    '{daily}',
    coalesce(v_report -> 'daily', '[]'::jsonb),
    true
  );
  v_snapshot := jsonb_set(v_snapshot, '{sources}', v_sources, true);
  v_snapshot := jsonb_set(v_snapshot, '{team}', v_team, true);

  v_snapshot := jsonb_set(
    v_snapshot,
    '{executive}',
    coalesce(v_snapshot -> 'executive', '{}'::jsonb)
      || jsonb_build_object(
        'newContactsThisMonth', v_new_contacts,
        'verifiedAdmissionsThisMonth', v_verified_admissions,
        'wonRevenueMinor', v_verified_revenue_minor,
        'activitiesThisMonth', coalesce(
          (v_summary ->> 'activities')::bigint,
          0
        ),
        'dueTasksThisMonthToDate', v_due_tasks,
        'completedDueTasksThisMonthToDate', v_completed_due_tasks,
        'taskCompletionRateThisMonth', v_task_completion_rate,
        'revenueCurrency', upper(coalesce(
          nullif(v_tenant.settings ->> 'currency', ''),
          'SAR'
        )),
        'revenueMinorDigits', 2,
        'woocommerceRevenue', v_woo,
        'crmMonthAvailable', v_can_crm,
        'trainingMonthAvailable', coalesce(
          (v_snapshot #>> '{permissions,training}')::boolean,
          false
        )
      ),
    true
  );

  v_snapshot := jsonb_set(
    v_snapshot,
    '{sales}',
    coalesce(v_snapshot -> 'sales', '{}'::jsonb)
      || jsonb_build_object(
        'distributedThisMonth', v_distributed,
        'paidFromDistributedThisMonth', v_paid_from_distributed,
        'closingRate', v_closing_rate,
        'conversionRate', v_closing_rate,
        'qualifiedEnteredThisMonth', v_qualified_entered,
        'qualifiedOpenFromMonth', v_qualified_open,
        'qualifiedWonFromMonth', v_qualified_won,
        'paidThisMonth', coalesce(
          (v_summary ->> 'paidContacts')::bigint,
          0
        ),
        'activitiesToday', coalesce(
          (v_summary ->> 'activities')::bigint,
          0
        ),
        'averageFirstResponseMinutes', coalesce(
          (v_summary ->> 'averageFirstResponseMinutes')::numeric,
          0
        ),
        'firstResponseSlaRate', coalesce(
          (v_summary ->> 'firstResponseSlaRate')::numeric,
          0
        ),
        'closingMethod', 'range_assignment_and_payment',
        'monthAvailable', v_can_crm
      ),
    true
  );

  v_snapshot := jsonb_set(
    v_snapshot,
    '{telephony}',
    coalesce(v_snapshot -> 'telephony', '{}'::jsonb)
      || jsonb_build_object(
        'totalCalls', coalesce((v_summary ->> 'calls')::bigint, 0),
        'answeredCalls', coalesce(
          (v_summary ->> 'answeredCalls')::bigint,
          0
        ),
        'missedCalls', v_missed_calls,
        'answerRate', coalesce(
          (v_summary ->> 'callAnswerRate')::numeric,
          0
        ),
        'talkSeconds', coalesce(
          (v_summary ->> 'talkSeconds')::bigint,
          0
        ),
        'averageTalkSeconds', case
          when coalesce((v_summary ->> 'calls')::bigint, 0) > 0
            then round(
              coalesce((v_summary ->> 'talkSeconds')::numeric, 0)
                / (v_summary ->> 'calls')::numeric
            )
          else 0
        end
      ),
    true
  );

  v_snapshot := jsonb_set(
    v_snapshot,
    '{leadOperations}',
    coalesce(v_snapshot -> 'leadOperations', '{}'::jsonb)
      || jsonb_build_object(
        'totalRows', coalesce(
          (v_summary ->> 'leadsCreated')::bigint,
          0
        ),
        'validRows', coalesce(
          (v_summary ->> 'validAssignedLeads')::bigint,
          0
        ),
        'averageFirstResponseMinutes', coalesce(
          (v_summary ->> 'averageFirstResponseMinutes')::numeric,
          0
        ),
        'firstResponseSlaRate', coalesce(
          (v_summary ->> 'firstResponseSlaRate')::numeric,
          0
        )
      ),
    true
  );

  v_snapshot := jsonb_set(
    v_snapshot,
    '{training}',
    coalesce(v_snapshot -> 'training', '{}'::jsonb)
      || jsonb_build_object(
        'newEnrollmentsThisMonth', v_new_enrollments,
        'sessionsThisMonth', v_sessions,
        'attendanceRecordsThisMonth', v_attendance_records,
        'attendanceRateThisMonth', v_attendance_rate,
        'issuedCertificatesThisMonth', v_issued_certificates,
        'monthAvailable', coalesce(
          (v_snapshot #>> '{permissions,training}')::boolean,
          false
        )
      ),
    true
  );

  return v_snapshot;
end;
$$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v7(
  text,
  date,
  date
) from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v7(
  text,
  date,
  date
) to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot_v7(
  text,
  date,
  date
) is
  'Tenant-authorized executive dashboard for an inclusive date range (max 366 days), using tenant-local half-open timestamps and never reusing current Woo revenue under a different range.';

commit;
