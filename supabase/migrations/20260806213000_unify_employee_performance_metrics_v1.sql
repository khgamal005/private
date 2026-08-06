-- Unify employee dashboards, cards, achievement, and reporting metrics.
begin;

create index if not exists registration_handoffs_verified_paid_idx
on academy.registration_handoffs (
  tenant_id,
  paid_at,
  contact_id
)
include (payment_amount_minor, course_id)
where payment_status = 'verified';

create or replace function private_app.v2_metric_is_open_task(
  p_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_status, '') in ('todo', 'in_progress');
$$;

create or replace function private_app.v2_metric_is_countable_contact(
  p_contact_status text,
  p_lead_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_contact_status, 'active') <> 'archived'
    and coalesce(p_lead_status, 'new') <> 'duplicate';
$$;

create or replace function private_app.v2_metric_is_active_contact(
  p_contact_status text,
  p_lead_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select private_app.v2_metric_is_countable_contact(
    p_contact_status,
    p_lead_status
  )
  and coalesce(p_lead_status, 'new') in (
    'new',
    'not_contacted',
    'contacted',
    'no_answer',
    'busy',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'payment_submitted',
    'postponed'
  );
$$;

create or replace function private_app.v2_metric_staff_scope(
  p_tenant_id uuid,
  p_viewer_staff_id uuid,
  p_role_key text,
  p_is_platform boolean default false
)
returns uuid[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(staff.id order by staff.id), '{}'::uuid[])
  from people.staff_profiles staff
  where staff.tenant_id = p_tenant_id
    and staff.employment_status = 'active'
    and (
      p_is_platform
      or p_role_key in (
        'tenant_owner',
        'tenant_admin',
        'executive_manager',
        'sales_manager'
      )
      or (
        p_role_key = 'sales_supervisor'
        and (
          staff.id = p_viewer_staff_id
          or staff.supervisor_staff_id = p_viewer_staff_id
        )
      )
      or staff.id = p_viewer_staff_id
    );
$$;

revoke all on function private_app.v2_metric_is_open_task(text)
from public, anon, authenticated;
revoke all on function private_app.v2_metric_is_countable_contact(text, text)
from public, anon, authenticated;
revoke all on function private_app.v2_metric_is_active_contact(text, text)
from public, anon, authenticated;
revoke all on function private_app.v2_metric_staff_scope(
  uuid,
  uuid,
  text,
  boolean
) from public, anon, authenticated;

create or replace function public.v2_tenant_role_dashboard_snapshot_v3(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_subject_id uuid;
  v_staff_id uuid;
  v_staff_name text;
  v_job_title text;
  v_role_key text;
  v_role_label text;
  v_is_platform boolean := false;
  v_view_team boolean := false;
  v_can_crm boolean := false;
  v_can_leads boolean := false;
  v_can_training boolean := false;
  v_can_incentives boolean := false;
  v_is_executive boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_scope_staff_text text[] := '{}'::text[];
  v_timezone text;
  v_today date;
  v_month_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_connection communication_hub.provider_connections%rowtype;
  v_assignment_map jsonb := '{}'::jsonb;
  v_personal_extensions text[] := '{}'::text[];
  v_scope_extensions text[] := '{}'::text[];
  v_personal jsonb := '{}'::jsonb;
  v_executive jsonb := '{}'::jsonb;
  v_sales jsonb := '{}'::jsonb;
  v_telephony jsonb := '{}'::jsonb;
  v_lead_operations jsonb := '{}'::jsonb;
  v_training jsonb := '{}'::jsonb;
  v_team jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
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

  v_is_platform :=
    private_app.has_platform_permission('platform.tenants.read');
  v_staff_id := private_app.current_staff_id(v_tenant.id);

  select staff.full_name, staff.job_title, staff.role_key
  into v_staff_name, v_job_title, v_role_key
  from people.staff_profiles staff
  where staff.id = v_staff_id
    and staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
  limit 1;

  if v_role_key is null then
    v_subject_id := private_app.current_subject_id();
    select role.role_key, subject.full_name, role.name_ar
    into v_role_key, v_staff_name, v_job_title
    from access_control.memberships membership
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.roles role
      on role.id = membership_role.role_id
    join access_control.subjects subject
      on subject.id = membership.subject_id
    where membership.tenant_id = v_tenant.id
      and membership.subject_id = v_subject_id
      and membership.status = 'active'
      and role.scope = 'tenant'
    order by private_app.tenant_role_rank(role.role_key) desc
    limit 1;
  end if;

  if v_role_key is null and v_is_platform then
    v_role_key := 'tenant_owner';
    v_staff_name := 'إدارة منصة ماركتون';
    v_job_title := 'إدارة المنصة';
  end if;

  v_role_key := coalesce(v_role_key, 'tenant_user');
  v_role_label := case v_role_key
    when 'tenant_owner' then 'مالك المنشأة'
    when 'tenant_admin' then 'مدير المنشأة'
    when 'executive_manager' then 'المدير التنفيذي'
    when 'sales_manager' then 'مدير المبيعات'
    when 'sales_supervisor' then 'مشرف المبيعات'
    when 'sales_user' then 'مسؤول المبيعات'
    when 'customer_service' then 'خدمة العملاء'
    when 'data_officer' then 'مسؤول البيانات'
    when 'data_analyst' then 'محلل البيانات'
    when 'training_manager' then 'مدير التدريب'
    else 'مستخدم المنشأة'
  end;

  v_can_crm := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.crm.read')
    or v_is_platform
  );
  v_can_leads := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.leads.read')
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.analytics'
    )
    or v_is_platform
  );
  v_can_training := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.academy.read')
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.admissions.read'
    )
    or v_is_platform
  );
  v_can_incentives := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.incentives.read')
    or v_is_platform
  );
  v_is_executive := v_role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  );
  v_view_team := (
    v_is_platform
    or v_role_key in (
      'tenant_owner',
      'tenant_admin',
      'executive_manager',
      'sales_manager',
      'sales_supervisor'
    )
  );

  v_scope_staff_ids := private_app.v2_metric_staff_scope(
    v_tenant.id,
    v_staff_id,
    v_role_key,
    v_is_platform
  );
  select coalesce(array_agg(scoped.staff_id::text), '{}'::text[])
  into v_scope_staff_text
  from unnest(v_scope_staff_ids) scoped(staff_id);

  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_month_date := date_trunc('month', v_today::timestamp)::date;
  v_day_start := v_today::timestamp at time zone v_timezone;
  v_day_end := (v_today + 1)::timestamp at time zone v_timezone;
  v_month_start := v_month_date::timestamp at time zone v_timezone;
  v_month_end := (
    v_month_date + interval '1 month'
  )::timestamp at time zone v_timezone;

  select connection.*
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  if v_connection.id is not null then
    v_assignment_map := coalesce(
      v_connection.public_config -> 'extensionAssignments',
      '{}'::jsonb
    );
    if jsonb_typeof(v_assignment_map) <> 'object' then
      v_assignment_map := '{}'::jsonb;
    end if;

    select coalesce(array_agg(mapping.key order by mapping.key), '{}'::text[])
    into v_personal_extensions
    from jsonb_each_text(v_assignment_map) mapping
    where v_staff_id is not null
      and mapping.value = v_staff_id::text;

    select coalesce(array_agg(mapping.key order by mapping.key), '{}'::text[])
    into v_scope_extensions
    from jsonb_each_text(v_assignment_map) mapping
    where mapping.value = any(v_scope_staff_text);
  end if;

  select jsonb_build_object(
    'tasksToday', count(*) filter (
      where private_app.v2_metric_is_open_task(task.status)
        and task.due_at >= v_day_start
        and task.due_at < v_day_end
    ),
    'openTasks', count(*) filter (
      where private_app.v2_metric_is_open_task(task.status)
    ),
    'overdueTasks', count(*) filter (
      where private_app.v2_metric_is_open_task(task.status)
        and task.due_at < now()
    ),
    'completedThisMonth', count(*) filter (
      where task.status = 'completed'
        and task.completed_at >= v_month_start
        and task.completed_at < v_month_end
    ),
    'onTimeThisMonth', count(*) filter (
      where task.status = 'completed'
        and task.completed_at >= v_month_start
        and task.completed_at < v_month_end
        and task.completed_at <= task.due_at
    )
  )
  into v_personal
  from work_core.tasks task
  where v_staff_id is not null
    and task.tenant_id = v_tenant.id
    and task.assigned_staff_id = v_staff_id;

  v_personal := coalesce(v_personal, '{}'::jsonb)
    || jsonb_build_object(
      'activitiesToday', (
        select count(*)
        from sales_core.activities activity
        where v_staff_id is not null
          and activity.tenant_id = v_tenant.id
          and activity.actor_staff_id = v_staff_id
          and activity.occurred_at >= v_day_start
          and activity.occurred_at < v_day_end
      ),
      'activeLeads', (
        select count(*)
        from sales_core.contacts contact
        where v_staff_id is not null
          and contact.tenant_id = v_tenant.id
          and contact.owner_staff_id = v_staff_id
          and private_app.v2_metric_is_active_contact(
            contact.status,
            contact.lead_status
          )
      ),
      'paidThisMonth', (
        select count(distinct handoff.contact_id)
        from academy.registration_handoffs handoff
        join sales_core.contacts contact
          on contact.id = handoff.contact_id
         and contact.tenant_id = handoff.tenant_id
        where v_staff_id is not null
          and handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_month_start
          and handoff.paid_at < v_month_end
          and contact.owner_staff_id = v_staff_id
      ),
      'pendingIncentive', case when v_can_incentives then (
        select coalesce(sum(event.incentive_amount), 0)
        from incentives_core.events event
        where v_staff_id is not null
          and event.tenant_id = v_tenant.id
          and event.staff_id = v_staff_id
          and event.state in ('expected', 'pending', 'due', 'approved')
      ) else 0 end,
      'paidIncentiveThisMonth', case when v_can_incentives then (
        select coalesce(sum(event.incentive_amount), 0)
        from incentives_core.events event
        where v_staff_id is not null
          and event.tenant_id = v_tenant.id
          and event.staff_id = v_staff_id
          and event.state = 'paid'
          and event.paid_at >= v_month_start
          and event.paid_at < v_month_end
      ) else 0 end
    );

  if v_is_executive then
    select jsonb_build_object(
      'activeStaff', count(*) filter (
        where staff.employment_status = 'active'
      ),
      'activeAccounts', count(*) filter (
        where staff.employment_status = 'active'
          and staff.account_status = 'active'
      ),
      'pipelineValueMinor', (
        select coalesce(sum(opportunity.value_minor), 0)
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.status = 'open'
      ),
      'wonRevenueMinor', (
        select coalesce(sum(handoff.payment_amount_minor), 0)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_month_start
          and handoff.paid_at < v_month_end
      ),
      'pendingAdmissions', (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status in ('pending', 'in_review')
      ),
      'pendingPaymentVerification', (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'pending_verification'
      ),
      'activeCourseRuns', (
        select count(*)
        from academy.course_runs course_run
        where course_run.tenant_id = v_tenant.id
          and course_run.status in ('open', 'in_progress')
      )
    )
    into v_executive
    from people.staff_profiles staff
    where staff.tenant_id = v_tenant.id;
  end if;

  if v_can_crm then
    with contact_stats as (
      select
        count(*) filter (
          where private_app.v2_metric_is_active_contact(
            contact.status,
            contact.lead_status
          )
        ) as active_leads,
        count(*) filter (
          where private_app.v2_metric_is_countable_contact(
            contact.status,
            contact.lead_status
          )
            and contact.lead_status in ('new', 'not_contacted')
        ) as new_leads,
        count(*) filter (
          where private_app.v2_metric_is_countable_contact(
            contact.status,
            contact.lead_status
          )
            and contact.lead_status = 'awaiting_payment'
        ) as awaiting_payment,
        count(*) filter (
          where private_app.v2_metric_is_active_contact(
            contact.status,
            contact.lead_status
          )
            and contact.next_action_at < now()
        ) as overdue_follow_ups
      from sales_core.contacts contact
      where contact.tenant_id = v_tenant.id
        and contact.owner_staff_id = any(v_scope_staff_ids)
    ),
    payment_stats as (
      select
        count(distinct handoff.contact_id) filter (
          where handoff.payment_status = 'verified'
            and handoff.paid_at >= v_month_start
            and handoff.paid_at < v_month_end
        ) as paid_this_month,
        count(distinct handoff.contact_id) filter (
          where handoff.payment_status = 'pending_verification'
        ) as pending_verification
      from academy.registration_handoffs handoff
      join sales_core.contacts contact
        on contact.id = handoff.contact_id
       and contact.tenant_id = handoff.tenant_id
      where handoff.tenant_id = v_tenant.id
        and contact.owner_staff_id = any(v_scope_staff_ids)
    ),
    assignment_stats as (
      select
        count(distinct assignment.contact_id) as assignments,
        count(*) filter (
          where assignment.first_action_at is not null
            and assignment.first_action_at <= assignment.deadline_at
        ) as first_actions_on_time,
        round(avg(
          extract(epoch from (
            assignment.first_action_at - assignment.assigned_at
          )) / 60
        ) filter (
          where assignment.first_action_at is not null
        ))::integer as average_first_response_minutes
      from sales_core.lead_assignments assignment
      where assignment.tenant_id = v_tenant.id
        and assignment.assigned_at >= v_month_start
        and assignment.assigned_at < v_month_end
        and assignment.assigned_staff_id = any(v_scope_staff_ids)
    ),
    opportunity_stats as (
      select coalesce(sum(opportunity.value_minor), 0)
        as pipeline_value_minor
      from sales_core.opportunities opportunity
      where opportunity.tenant_id = v_tenant.id
        and opportunity.status = 'open'
        and opportunity.owner_staff_id = any(v_scope_staff_ids)
    ),
    activity_stats as (
      select count(*) as activities_today
      from sales_core.activities activity
      where activity.tenant_id = v_tenant.id
        and activity.actor_staff_id = any(v_scope_staff_ids)
        and activity.occurred_at >= v_day_start
        and activity.occurred_at < v_day_end
    )
    select jsonb_build_object(
      'activeLeads', contact.active_leads,
      'newLeads', contact.new_leads,
      'awaitingPayment', contact.awaiting_payment,
      'paidThisMonth', payment.paid_this_month,
      'pendingPaymentVerification', payment.pending_verification,
      'overdueFollowUps', contact.overdue_follow_ups,
      'activitiesToday', activity.activities_today,
      'pipelineValueMinor', opportunity.pipeline_value_minor,
      'assignmentsThisMonth', assignment.assignments,
      'conversionRate', case when assignment.assignments > 0 then
        round(least(
          100.0,
          100.0 * payment.paid_this_month / assignment.assignments
        ), 1)
      else 0 end,
      'firstResponseSlaRate', case when assignment.assignments > 0 then
        round(
          100.0 * assignment.first_actions_on_time
            / assignment.assignments,
          1
        )
      else 0 end,
      'averageFirstResponseMinutes',
        coalesce(assignment.average_first_response_minutes, 0)
    )
    into v_sales
    from contact_stats contact
    cross join payment_stats payment
    cross join assignment_stats assignment
    cross join opportunity_stats opportunity
    cross join activity_stats activity;

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
        ) as paid
      from sales_core.contacts contact
      where contact.tenant_id = v_tenant.id
        and contact.owner_staff_id = any(v_scope_staff_ids)
        and private_app.v2_metric_is_countable_contact(
          contact.status,
          contact.lead_status
        )
    ),
    source_stats as (
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

  if v_can_crm or v_role_key = 'customer_service' then
    select jsonb_build_object(
      'configured', v_connection.id is not null,
      'status', coalesce(v_connection.status, 'disabled'),
      'mapped', cardinality(v_scope_extensions) > 0,
      'extensions', array_to_string(v_scope_extensions, ', '),
      'totalCalls', count(record.id),
      'answeredCalls', count(record.id) filter (
        where record.final_status = 'ANSWERED'
      ),
      'missedCalls', count(record.id) filter (
        where record.final_status in ('NO ANSWER', 'ABANDONED', 'BUSY')
      ),
      'answerRate', coalesce(round(
        100.0 * count(record.id) filter (
          where record.final_status = 'ANSWERED'
        ) / nullif(count(record.id), 0),
        1
      ), 0),
      'talkSeconds', coalesce(sum(record.handling_duration_seconds), 0),
      'averageTalkSeconds', coalesce(
        round(avg(record.handling_duration_seconds))::integer,
        0
      ),
      'averageRoutingSeconds', coalesce(
        round(avg(record.routing_duration_seconds))::integer,
        0
      )
    )
    into v_telephony
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_month_start
      and record.started_at < v_month_end
      and cardinality(v_scope_extensions) > 0
      and record.involved_extensions && v_scope_extensions;
  end if;

  if v_can_leads then
    select jsonb_build_object(
      'batchesThisMonth', count(*),
      'totalRows', coalesce(sum(batch.total_rows), 0),
      'validRows', coalesce(sum(batch.valid_rows), 0),
      'invalidRows', coalesce(sum(batch.invalid_rows), 0),
      'duplicateRows', coalesce(sum(batch.duplicate_rows), 0),
      'distributedRows', coalesce(sum(batch.distributed_rows), 0)
    )
    into v_lead_operations
    from sales_core.lead_import_batches batch
    where batch.tenant_id = v_tenant.id
      and batch.created_at >= v_month_start
      and batch.created_at < v_month_end;

    v_lead_operations := coalesce(v_lead_operations, '{}'::jsonb)
      || jsonb_build_object(
        'awaitingDistribution', (
          select count(*)
          from sales_core.lead_import_rows import_row
          where import_row.tenant_id = v_tenant.id
            and import_row.validation_status = 'valid'
            and import_row.queue_status in ('ready', 'pending')
        ),
        'slaBreaches', (
          select count(*)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant.id
            and assignment.deadline_at < now()
            and assignment.first_action_at is null
        ),
        'firstResponseSlaRate', (
          select coalesce(round(
            100.0 * count(*) filter (
              where assignment.first_action_at is not null
                and assignment.first_action_at <= assignment.deadline_at
            ) / nullif(count(*), 0),
            1
          ), 0)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant.id
            and assignment.assigned_at >= v_month_start
            and assignment.assigned_at < v_month_end
        ),
        'averageFirstResponseMinutes', (
          select coalesce(round(avg(
            extract(epoch from (
              assignment.first_action_at - assignment.assigned_at
            )) / 60
          ))::integer, 0)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant.id
            and assignment.first_action_at is not null
            and assignment.assigned_at >= v_month_start
            and assignment.assigned_at < v_month_end
        )
      );
  end if;

  if v_can_training then
    v_training := jsonb_build_object(
      'pendingAdmissions', (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status in ('pending', 'in_review')
      ),
      'pendingPaymentVerification', (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'pending_verification'
      ),
      'activeCourseRuns', (
        select count(*)
        from academy.course_runs course_run
        where course_run.tenant_id = v_tenant.id
          and course_run.status in ('open', 'in_progress')
      ),
      'upcomingSessions', (
        select count(*)
        from academy.course_run_sessions session
        where session.tenant_id = v_tenant.id
          and session.starts_at >= now()
          and session.starts_at < now() + interval '7 days'
          and session.status <> 'cancelled'
      ),
      'activeEnrollments', (
        select count(*)
        from academy.enrollments enrollment
        where enrollment.tenant_id = v_tenant.id
          and enrollment.status in ('confirmed', 'active')
      ),
      'attendanceRate', (
        select coalesce(round(
          100.0 * count(*) filter (
            where attendance.status in ('present', 'late')
          ) / nullif(count(*), 0),
          1
        ), 0)
        from academy.attendance_records attendance
        where attendance.tenant_id = v_tenant.id
      ),
      'averageAssessmentRate', (
        select coalesce(round(avg(
          case
            when assessment.max_score > 0 then
              100.0 * assessment.score / assessment.max_score
            else null
          end
        ), 1), 0)
        from academy.assessment_results assessment
        where assessment.tenant_id = v_tenant.id
      ),
      'issuedCertificatesThisMonth', (
        select count(*)
        from academy.certificates certificate
        where certificate.tenant_id = v_tenant.id
          and certificate.status = 'issued'
          and certificate.issued_at >= v_month_start
          and certificate.issued_at < v_month_end
      ),
      'failedAutomationJobs', (
        select count(*)
        from academy.training_automation_jobs job
        where job.tenant_id = v_tenant.id
          and job.status = 'failed'
      )
    );
  end if;

  if v_view_team and v_can_crm then
    with staff_scope as (
      select staff.id, staff.full_name, staff.role_key, staff.job_title
      from people.staff_profiles staff
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.id = any(v_scope_staff_ids)
        and staff.role_key in (
          'sales_manager',
          'sales_supervisor',
          'sales_user',
          'customer_service'
        )
    ),
    contact_stats as (
      select contact.owner_staff_id as staff_id, count(*) as active_leads
      from sales_core.contacts contact
      join staff_scope staff on staff.id = contact.owner_staff_id
      where contact.tenant_id = v_tenant.id
        and private_app.v2_metric_is_active_contact(
          contact.status,
          contact.lead_status
        )
      group by contact.owner_staff_id
    ),
    activity_stats as (
      select activity.actor_staff_id as staff_id, count(*) as activities
      from sales_core.activities activity
      join staff_scope staff on staff.id = activity.actor_staff_id
      where activity.tenant_id = v_tenant.id
        and activity.occurred_at >= v_day_start
        and activity.occurred_at < v_day_end
      group by activity.actor_staff_id
    ),
    payment_stats as (
      select
        contact.owner_staff_id as staff_id,
        count(distinct handoff.contact_id) as paid
      from academy.registration_handoffs handoff
      join sales_core.contacts contact
        on contact.id = handoff.contact_id
       and contact.tenant_id = handoff.tenant_id
      join staff_scope staff on staff.id = contact.owner_staff_id
      where handoff.tenant_id = v_tenant.id
        and handoff.payment_status = 'verified'
        and handoff.paid_at >= v_month_start
        and handoff.paid_at < v_month_end
      group by contact.owner_staff_id
    ),
    task_stats as (
      select task.assigned_staff_id as staff_id, count(*) as overdue
      from work_core.tasks task
      join staff_scope staff on staff.id = task.assigned_staff_id
      where task.tenant_id = v_tenant.id
        and private_app.v2_metric_is_open_task(task.status)
        and task.due_at < now()
      group by task.assigned_staff_id
    ),
    extensions as (
      select
        staff.id as staff_id,
        mapping.key as extension
      from staff_scope staff
      cross join lateral jsonb_each_text(v_assignment_map) mapping
      where mapping.value = staff.id::text
    ),
    extension_labels as (
      select staff_id, string_agg(extension, ', ' order by extension)
        as extension
      from extensions
      group by staff_id
    ),
    staff_calls as (
      select distinct
        extension.staff_id,
        record.id,
        record.final_status,
        record.handling_duration_seconds
      from extensions extension
      join telephony.call_records record
        on extension.extension = any(record.involved_extensions)
      where record.tenant_id = v_tenant.id
        and record.started_at >= v_month_start
        and record.started_at < v_month_end
    ),
    call_stats as (
      select
        call.staff_id,
        count(*) as total_calls,
        count(*) filter (
          where call.final_status = 'ANSWERED'
        ) as answered_calls,
        coalesce(sum(call.handling_duration_seconds), 0) as talk_seconds
      from staff_calls call
      group by call.staff_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'staffId', staff.id,
      'name', staff.full_name,
      'roleKey', staff.role_key,
      'jobTitle', staff.job_title,
      'extension', coalesce(extension.extension, ''),
      'activeLeads', coalesce(contact.active_leads, 0),
      'activitiesToday', coalesce(activity.activities, 0),
      'paidThisMonth', coalesce(payment.paid, 0),
      'overdueTasks', coalesce(task.overdue, 0),
      'totalCalls', coalesce(call.total_calls, 0),
      'answerRate', case when coalesce(call.total_calls, 0) > 0 then
        round(100.0 * call.answered_calls / call.total_calls, 1)
      else 0 end,
      'talkSeconds', coalesce(call.talk_seconds, 0)
    ) order by
      coalesce(payment.paid, 0) desc,
      coalesce(activity.activities, 0) desc,
      staff.full_name
    ), '[]'::jsonb)
    into v_team
    from staff_scope staff
    left join contact_stats contact on contact.staff_id = staff.id
    left join activity_stats activity on activity.staff_id = staff.id
    left join payment_stats payment on payment.staff_id = staff.id
    left join task_stats task on task.staff_id = staff.id
    left join extension_labels extension on extension.staff_id = staff.id
    left join call_stats call on call.staff_id = staff.id;
  end if;

  if v_can_crm then
    with days as (
      select (v_today - series.days)::date as day
      from generate_series(6, 0, -1) series(days)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'date', day.day,
      'activities', (
        select count(*)
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.actor_staff_id = any(v_scope_staff_ids)
          and activity.occurred_at >=
            day.day::timestamp at time zone v_timezone
          and activity.occurred_at <
            (day.day + 1)::timestamp at time zone v_timezone
      ),
      'paid', (
        select count(distinct handoff.contact_id)
        from academy.registration_handoffs handoff
        join sales_core.contacts contact
          on contact.id = handoff.contact_id
         and contact.tenant_id = handoff.tenant_id
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'verified'
          and contact.owner_staff_id = any(v_scope_staff_ids)
          and handoff.paid_at >=
            day.day::timestamp at time zone v_timezone
          and handoff.paid_at <
            (day.day + 1)::timestamp at time zone v_timezone
      ),
      'calls', (
        select count(*)
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
          and cardinality(v_scope_extensions) > 0
          and record.involved_extensions && v_scope_extensions
          and record.started_at >=
            day.day::timestamp at time zone v_timezone
          and record.started_at <
            (day.day + 1)::timestamp at time zone v_timezone
      )
    ) order by day.day), '[]'::jsonb)
    into v_daily
    from days day;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'name', coalesce(v_staff_name, 'مستخدم ماركتون'),
      'jobTitle', coalesce(v_job_title, v_role_label),
      'roleKey', v_role_key,
      'roleLabel', v_role_label,
      'viewTeam', v_view_team,
      'mappedExtensions', to_jsonb(v_personal_extensions)
    ),
    'permissions', jsonb_build_object(
      'crm', v_can_crm,
      'leadOperations', v_can_leads,
      'training', v_can_training,
      'incentives', v_can_incentives,
      'executive', v_is_executive
    ),
    'personal', coalesce(v_personal, '{}'::jsonb),
    'executive', coalesce(v_executive, '{}'::jsonb),
    'sales', coalesce(v_sales, '{}'::jsonb),
    'telephony', coalesce(v_telephony, '{}'::jsonb),
    'leadOperations', coalesce(v_lead_operations, '{}'::jsonb),
    'training', coalesce(v_training, '{}'::jsonb),
    'team', coalesce(v_team, '[]'::jsonb),
    'daily', coalesce(v_daily, '[]'::jsonb),
    'sources', coalesce(v_sources, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v3(text)
from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v3(text)
to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot_v3(text) is
  'Canonical tenant role dashboard using explicit task/contact/payment definitions, tenant-local periods, and direct-report scope.';

create or replace function public.v2_tenant_employee_achievement_snapshot_v2(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_staff_name text;
  v_job_title text;
  v_role_key text;
  v_supervisor_id uuid;
  v_supervisor_name text;
  v_subject_id uuid;
  v_timezone text;
  v_today date;
  v_month_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_customers integer := 0;
  v_active_customers integer := 0;
  v_paid_customers integer := 0;
  v_pending_payment_verification integer := 0;
  v_open_opportunities integer := 0;
  v_open_opportunity_value_minor bigint := 0;
  v_sales_this_month numeric := 0;
  v_due_incentive numeric := 0;
  v_expected_incentive numeric := 0;
  v_paid_incentive numeric := 0;
  v_tasks_today integer := 0;
  v_open_tasks integer := 0;
  v_overdue_tasks integer := 0;
  v_completed_this_month integer := 0;
  v_activities_today integer := 0;
  v_target_value numeric := 0;
  v_target_metric_type text;
  v_achieved_value numeric := 0;
  v_progress numeric := 0;
  v_rank integer;
  v_team_size integer := 0;
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

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  if v_staff_id is not null then
    select
      staff.full_name,
      staff.job_title,
      staff.role_key,
      staff.supervisor_staff_id,
      supervisor.full_name
    into
      v_staff_name,
      v_job_title,
      v_role_key,
      v_supervisor_id,
      v_supervisor_name
    from people.staff_profiles staff
    left join people.staff_profiles supervisor
      on supervisor.id = staff.supervisor_staff_id
     and supervisor.tenant_id = staff.tenant_id
    where staff.id = v_staff_id
      and staff.tenant_id = v_tenant.id
      and staff.employment_status = 'active'
    limit 1;
  end if;

  if v_role_key is null then
    v_subject_id := private_app.current_subject_id();
    select subject.full_name, role.role_key, role.name_ar
    into v_staff_name, v_role_key, v_job_title
    from access_control.memberships membership
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.roles role
      on role.id = membership_role.role_id
    join access_control.subjects subject
      on subject.id = membership.subject_id
    where membership.tenant_id = v_tenant.id
      and membership.subject_id = v_subject_id
      and membership.status = 'active'
      and role.scope = 'tenant'
    order by private_app.tenant_role_rank(role.role_key) desc
    limit 1;
  end if;

  if v_role_key is null
     and private_app.has_platform_permission('platform.tenants.read') then
    v_role_key := 'tenant_owner';
    v_staff_name := 'إدارة منصة ماركتون';
    v_job_title := 'إدارة المنصة';
  end if;

  v_role_key := coalesce(v_role_key, 'tenant_user');
  v_staff_name := coalesce(v_staff_name, 'مستخدم ماركتون');
  v_job_title := coalesce(v_job_title, 'مستخدم المنشأة');
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_month_date := date_trunc('month', v_today::timestamp)::date;
  v_day_start := v_today::timestamp at time zone v_timezone;
  v_day_end := (v_today + 1)::timestamp at time zone v_timezone;
  v_month_start := v_month_date::timestamp at time zone v_timezone;
  v_month_end := (
    v_month_date + interval '1 month'
  )::timestamp at time zone v_timezone;

  if v_staff_id is not null then
    select
      count(*) filter (
        where private_app.v2_metric_is_open_task(task.status)
          and task.due_at >= v_day_start
          and task.due_at < v_day_end
      ),
      count(*) filter (
        where private_app.v2_metric_is_open_task(task.status)
      ),
      count(*) filter (
        where private_app.v2_metric_is_open_task(task.status)
          and task.due_at < now()
      ),
      count(*) filter (
        where task.status = 'completed'
          and task.completed_at >= v_month_start
          and task.completed_at < v_month_end
      )
    into
      v_tasks_today,
      v_open_tasks,
      v_overdue_tasks,
      v_completed_this_month
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.assigned_staff_id = v_staff_id;

    select count(*)
    into v_activities_today
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.actor_staff_id = v_staff_id
      and activity.occurred_at >= v_day_start
      and activity.occurred_at < v_day_end;
  end if;

  if v_staff_id is not null
     and v_role_key in ('sales_user', 'sales_supervisor', 'sales_manager') then
    select
      count(*) filter (
        where private_app.v2_metric_is_countable_contact(
          contact.status,
          contact.lead_status
        )
      ),
      count(*) filter (
        where private_app.v2_metric_is_active_contact(
          contact.status,
          contact.lead_status
        )
      )
    into v_customers, v_active_customers
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.owner_staff_id = v_staff_id;

    select
      count(distinct handoff.contact_id) filter (
        where handoff.payment_status = 'verified'
          and handoff.paid_at >= v_month_start
          and handoff.paid_at < v_month_end
      ),
      count(distinct handoff.contact_id) filter (
        where handoff.payment_status = 'pending_verification'
      ),
      coalesce(sum(handoff.payment_amount_minor) filter (
        where handoff.payment_status = 'verified'
          and handoff.paid_at >= v_month_start
          and handoff.paid_at < v_month_end
      ), 0) / 100.0
    into
      v_paid_customers,
      v_pending_payment_verification,
      v_sales_this_month
    from academy.registration_handoffs handoff
    join sales_core.contacts contact
      on contact.id = handoff.contact_id
     and contact.tenant_id = handoff.tenant_id
    where handoff.tenant_id = v_tenant.id
      and contact.owner_staff_id = v_staff_id;

    select
      count(*),
      coalesce(sum(opportunity.value_minor), 0)
    into v_open_opportunities, v_open_opportunity_value_minor
    from sales_core.opportunities opportunity
    where opportunity.tenant_id = v_tenant.id
      and opportunity.owner_staff_id = v_staff_id
      and opportunity.status = 'open';

    select
      coalesce(sum(event.incentive_amount) filter (
        where event.state in ('due', 'approved')
      ), 0),
      coalesce(sum(event.incentive_amount) filter (
        where event.state in ('expected', 'pending')
      ), 0),
      coalesce(sum(event.incentive_amount) filter (
        where event.state = 'paid'
          and event.paid_at >= v_month_start
          and event.paid_at < v_month_end
      ), 0)
    into v_due_incentive, v_expected_incentive, v_paid_incentive
    from incentives_core.events event
    where event.tenant_id = v_tenant.id
      and event.staff_id = v_staff_id;

    select assignment.target_value, plan.metric_type
    into v_target_value, v_target_metric_type
    from incentives_core.assignments assignment
    join incentives_core.plans plan
      on plan.id = assignment.plan_id
     and plan.tenant_id = assignment.tenant_id
    where assignment.tenant_id = v_tenant.id
      and assignment.staff_id = v_staff_id
      and assignment.active
      and plan.status = 'active'
      and v_today between plan.period_start and plan.period_end
    order by assignment.assigned_at desc
    limit 1;

    v_target_value := coalesce(v_target_value, 0);
    v_achieved_value := case
      when v_target_metric_type in (
        'registrations',
        'customers',
        'sales_count',
        'paid_customers'
      ) then v_paid_customers
      when v_target_metric_type in ('activities', 'followups') then (
        select count(*)
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.actor_staff_id = v_staff_id
          and activity.occurred_at >= v_month_start
          and activity.occurred_at < v_month_end
      )
      else v_sales_this_month
    end;

    if v_target_value > 0 then
      v_progress := least(100, greatest(
        0,
        round(100.0 * v_achieved_value / v_target_value, 1)
      ));
    end if;
  end if;

  if v_role_key = 'sales_user' and v_supervisor_id is not null then
    with peers as (
      select peer.id
      from people.staff_profiles peer
      where peer.tenant_id = v_tenant.id
        and peer.supervisor_staff_id = v_supervisor_id
        and peer.role_key = 'sales_user'
        and peer.employment_status = 'active'
    ),
    peer_sales as (
      select
        peer.id,
        coalesce(sum(handoff.payment_amount_minor), 0) as sales_minor
      from peers peer
      left join sales_core.contacts contact
        on contact.tenant_id = v_tenant.id
       and contact.owner_staff_id = peer.id
      left join academy.registration_handoffs handoff
        on handoff.tenant_id = v_tenant.id
       and handoff.contact_id = contact.id
       and handoff.payment_status = 'verified'
       and handoff.paid_at >= v_month_start
       and handoff.paid_at < v_month_end
      group by peer.id
    ),
    ranked as (
      select
        peer.id,
        dense_rank() over (
          order by peer.sales_minor desc
        )::integer as sales_rank,
        count(*) over ()::integer as team_size
      from peer_sales peer
    )
    select ranked.sales_rank, ranked.team_size
    into v_rank, v_team_size
    from ranked
    where ranked.id = v_staff_id;
  elsif v_role_key = 'sales_supervisor' and v_staff_id is not null then
    select count(*)
    into v_team_size
    from people.staff_profiles member
    where member.tenant_id = v_tenant.id
      and member.supervisor_staff_id = v_staff_id
      and member.role_key = 'sales_user'
      and member.employment_status = 'active';
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'name', v_staff_name,
      'jobTitle', v_job_title,
      'roleKey', v_role_key,
      'supervisorStaffId', v_supervisor_id,
      'supervisorName', v_supervisor_name
    ),
    'personal', jsonb_build_object(
      'tasksToday', v_tasks_today,
      'openTasks', v_open_tasks,
      'overdueTasks', v_overdue_tasks,
      'completedThisMonth', v_completed_this_month,
      'activitiesToday', v_activities_today
    ),
    'sales', jsonb_build_object(
      'customers', v_customers,
      'activeCustomers', v_active_customers,
      'paidCustomers', v_paid_customers,
      'pendingPaymentVerification', v_pending_payment_verification,
      'openOpportunities', v_open_opportunities,
      'openOpportunityValueMinor', v_open_opportunity_value_minor,
      'salesThisMonth', v_sales_this_month,
      'dueIncentive', v_due_incentive,
      'expectedIncentive', v_expected_incentive,
      'paidIncentiveThisMonth', v_paid_incentive
    ),
    'ranking', jsonb_build_object(
      'available', v_role_key = 'sales_user'
        and v_supervisor_id is not null
        and v_rank is not null,
      'rank', v_rank,
      'teamSize', v_team_size,
      'teamName', coalesce(v_supervisor_name, 'غير مسند')
    ),
    'target', jsonb_build_object(
      'metricType', v_target_metric_type,
      'targetValue', v_target_value,
      'achievedValue', v_achieved_value,
      'progressPercent', v_progress
    )
  );
end;
$function$;

revoke all on function public.v2_tenant_employee_achievement_snapshot_v2(text)
from public, anon;
grant execute on function public.v2_tenant_employee_achievement_snapshot_v2(text)
to authenticated;

comment on function public.v2_tenant_employee_achievement_snapshot_v2(text) is
  'Canonical personal achievement metrics based on verified payments and tenant-local periods.';

create or replace function public.v2_tenant_reports_snapshot_v1(
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
  v_subject_id uuid;
  v_current_staff_id uuid;
  v_target_staff_id uuid;
  v_role_key text;
  v_is_platform boolean := false;
  v_view_team boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_scope_staff_text text[] := '{}'::text[];
  v_can_crm boolean := false;
  v_can_leads boolean := false;
  v_from_date date;
  v_to_date date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_assignment_map jsonb := '{}'::jsonb;
  v_selected_employee jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_campaigns jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_lead_statuses jsonb := '[]'::jsonb;
  v_pipeline_stages jsonb := '[]'::jsonb;
  v_courses jsonb := '[]'::jsonb;
  v_activity_breakdown jsonb := '[]'::jsonb;
  v_task_breakdown jsonb := '[]'::jsonb;
  v_call_breakdown jsonb := '[]'::jsonb;
  v_details jsonb := '{}'::jsonb;
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
  if coalesce(p_report, 'overview') not in (
    'overview',
    'employees',
    'employee',
    'sales',
    'campaigns'
  ) then
    raise exception 'invalid_report_type';
  end if;

  v_from_date := coalesce(
    p_from,
    (now() at time zone v_tenant.timezone)::date - 29
  );
  v_to_date := coalesce(
    p_to,
    (now() at time zone v_tenant.timezone)::date
  );
  if v_from_date > v_to_date
     or v_to_date - v_from_date > 365 then
    raise exception 'invalid_report_period';
  end if;
  v_from_at := v_from_date::timestamp at time zone v_tenant.timezone;
  v_to_at := (v_to_date + 1)::timestamp at time zone v_tenant.timezone;

  v_is_platform :=
    private_app.has_platform_permission('platform.tenants.read');
  v_current_staff_id := private_app.current_staff_id(v_tenant.id);

  select staff.role_key
  into v_role_key
  from people.staff_profiles staff
  where staff.id = v_current_staff_id
    and staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
  limit 1;

  if v_role_key is null then
    v_subject_id := private_app.current_subject_id();
    select role.role_key
    into v_role_key
    from access_control.memberships membership
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.roles role
      on role.id = membership_role.role_id
    where membership.tenant_id = v_tenant.id
      and membership.subject_id = v_subject_id
      and membership.status = 'active'
      and role.scope = 'tenant'
    order by private_app.tenant_role_rank(role.role_key) desc
    limit 1;
  end if;

  if v_role_key is null and v_is_platform then
    v_role_key := 'tenant_owner';
  end if;
  v_role_key := coalesce(v_role_key, 'tenant_user');

  v_scope_staff_ids := private_app.v2_metric_staff_scope(
    v_tenant.id,
    v_current_staff_id,
    v_role_key,
    v_is_platform
  );
  v_view_team := (
    v_is_platform
    or v_role_key in (
      'tenant_owner',
      'tenant_admin',
      'executive_manager',
      'sales_manager',
      'sales_supervisor'
    )
  );
  v_can_crm := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.crm.read')
    or v_is_platform
  );
  v_can_leads := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.leads.read')
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.analytics'
    )
    or v_is_platform
  );

  if p_report = 'sales' and not v_can_crm then
    raise exception 'forbidden';
  end if;
  if p_report = 'campaigns' and not (v_can_crm or v_can_leads) then
    raise exception 'forbidden';
  end if;

  if p_staff_id is not null then
    if not exists (
      select 1
      from people.staff_profiles staff
      where staff.id = p_staff_id
        and staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
    ) then
      raise exception 'staff_not_found';
    end if;
    if not (p_staff_id = any(v_scope_staff_ids)) then
      raise exception 'forbidden';
    end if;
    v_target_staff_id := p_staff_id;
    v_scope_staff_ids := array[p_staff_id];
    v_view_team := false;
  elsif not v_view_team then
    if v_current_staff_id is null then
      raise exception 'staff_profile_required';
    end if;
    v_target_staff_id := v_current_staff_id;
    v_scope_staff_ids := array[v_current_staff_id];
  end if;

  select coalesce(array_agg(scoped.staff_id::text), '{}'::text[])
  into v_scope_staff_text
  from unnest(v_scope_staff_ids) scoped(staff_id);

  select coalesce(
    connection.public_config -> 'extensionAssignments',
    '{}'::jsonb
  )
  into v_assignment_map
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;
  v_assignment_map := coalesce(v_assignment_map, '{}'::jsonb);

  if v_target_staff_id is not null then
    select jsonb_build_object(
      'staffId', staff.id,
      'name', staff.full_name,
      'jobTitle', staff.job_title,
      'roleKey', staff.role_key,
      'roleLabel', case staff.role_key
        when 'tenant_owner' then 'مالك المنشأة'
        when 'tenant_admin' then 'مدير المنشأة'
        when 'executive_manager' then 'المدير التنفيذي'
        when 'sales_manager' then 'مدير المبيعات'
        when 'sales_supervisor' then 'مشرف المبيعات'
        when 'sales_user' then 'مسؤول المبيعات'
        when 'customer_service' then 'خدمة العملاء'
        when 'data_officer' then 'مسؤول البيانات'
        when 'data_analyst' then 'محلل البيانات'
        when 'training_manager' then 'مدير التدريب'
        else 'مستخدم المنشأة'
      end,
      'department', department.name_ar,
      'accountStatus', staff.account_status
    )
    into v_selected_employee
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.id = v_target_staff_id
      and staff.tenant_id = v_tenant.id;
  end if;

  with staff_scope as (
    select
      staff.id,
      staff.full_name,
      staff.job_title,
      staff.role_key,
      staff.account_status,
      department.name_ar as department_name
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.tenant_id = v_tenant.id
      and staff.employment_status = 'active'
      and staff.id = any(v_scope_staff_ids)
  ),
  assignment_contacts as (
    select distinct
      assignment.assigned_staff_id as staff_id,
      assignment.contact_id
    from sales_core.lead_assignments assignment
    join staff_scope staff on staff.id = assignment.assigned_staff_id
    join sales_core.contacts contact
      on contact.id = assignment.contact_id
     and contact.tenant_id = assignment.tenant_id
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
      and private_app.v2_metric_is_countable_contact(
        contact.status,
        contact.lead_status
      )
  ),
  assignment_stats as (
    select
      assignment.assigned_staff_id as staff_id,
      count(distinct assignment.contact_id) as leads_assigned,
      count(*) filter (
        where assignment.first_action_at is not null
      ) as first_actions,
      count(*) filter (
        where assignment.first_action_at is not null
          and assignment.first_action_at <= assignment.deadline_at
      ) as first_actions_on_time
    from sales_core.lead_assignments assignment
    join staff_scope staff on staff.id = assignment.assigned_staff_id
    join sales_core.contacts contact
      on contact.id = assignment.contact_id
     and contact.tenant_id = assignment.tenant_id
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
      and private_app.v2_metric_is_countable_contact(
        contact.status,
        contact.lead_status
      )
    group by assignment.assigned_staff_id
  ),
  contact_stats as (
    select
      scoped.staff_id,
      count(*) filter (
        where exists (
          select 1
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant.id
            and handoff.contact_id = contact.id
            and handoff.payment_status = 'verified'
            and handoff.paid_at >= v_from_at
            and handoff.paid_at < v_to_at
        )
      ) as paid_contacts,
      round(avg(
        (
          (nullif(trim(contact.full_name), '') is not null)::integer
          + (
            nullif(trim(coalesce(contact.phone, '')), '') is not null
            or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
          )::integer
          + (nullif(trim(contact.source), '') is not null)::integer
          + (contact.interest_course_id is not null)::integer
          + (contact.owner_staff_id is not null)::integer
        ) * 20.0
      ), 1) as data_completeness_rate,
      count(*) filter (
        where exists (
          select 1
          from sales_core.activities activity
          where activity.tenant_id = v_tenant.id
            and activity.contact_id = contact.id
            and activity.occurred_at >= v_from_at
            and activity.occurred_at < v_to_at
        )
      ) as touched_leads
    from assignment_contacts scoped
    join sales_core.contacts contact on contact.id = scoped.contact_id
    group by scoped.staff_id
  ),
  activity_stats as (
    select
      activity.actor_staff_id as staff_id,
      count(*) as activities
    from sales_core.activities activity
    join staff_scope staff on staff.id = activity.actor_staff_id
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_from_at
      and activity.occurred_at < v_to_at
    group by activity.actor_staff_id
  ),
  task_stats as (
    select
      task.assigned_staff_id as staff_id,
      count(*) filter (
        where task.status in ('todo', 'in_progress', 'completed')
      ) as tasks_total,
      count(*) filter (
        where task.status = 'completed'
          and task.completed_at < v_to_at
      ) as tasks_completed,
      count(*) filter (
        where task.status = 'completed'
          and task.completed_at <= task.due_at
      ) as tasks_on_time,
      count(*) filter (
        where task.status in ('todo', 'in_progress')
          and task.due_at < least(v_to_at, now())
      ) as overdue_tasks
    from work_core.tasks task
    join staff_scope staff on staff.id = task.assigned_staff_id
    where task.tenant_id = v_tenant.id
      and task.due_at >= v_from_at
      and task.due_at < v_to_at
    group by task.assigned_staff_id
  ),
  opportunity_stats as (
    select
      opportunity.owner_staff_id as staff_id,
      count(*) filter (
        where opportunity.status = 'won'
      ) as won_opportunities,
      coalesce(sum(opportunity.value_minor) filter (
        where opportunity.status = 'won'
      ), 0) as won_revenue_minor
    from sales_core.opportunities opportunity
    join staff_scope staff on staff.id = opportunity.owner_staff_id
    where opportunity.tenant_id = v_tenant.id
      and opportunity.updated_at >= v_from_at
      and opportunity.updated_at < v_to_at
    group by opportunity.owner_staff_id
  ),
  payment_stats as (
    select
      contact.owner_staff_id as staff_id,
      count(distinct handoff.contact_id) as verified_sales,
      coalesce(sum(handoff.payment_amount_minor), 0)
        as realized_revenue_minor
    from academy.registration_handoffs handoff
    join sales_core.contacts contact on contact.id = handoff.contact_id
    join staff_scope staff on staff.id = contact.owner_staff_id
    where handoff.tenant_id = v_tenant.id
      and handoff.payment_status = 'verified'
      and handoff.paid_at >= v_from_at
      and handoff.paid_at < v_to_at
    group by contact.owner_staff_id
  ),
  staff_extensions as (
    select
      staff.id as staff_id,
      mapping.key as extension
    from staff_scope staff
    cross join lateral jsonb_each_text(v_assignment_map) mapping
    where mapping.value = staff.id::text
  ),
  staff_calls as (
    select distinct
      extension.staff_id,
      record.id,
      record.final_status,
      record.handling_duration_seconds
    from staff_extensions extension
    join telephony.call_records record
      on extension.extension = any(record.involved_extensions)
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
  ),
  call_stats as (
    select
      call.staff_id,
      count(*) as calls,
      count(*) filter (
        where call.final_status = 'ANSWERED'
      ) as answered_calls,
      coalesce(sum(call.handling_duration_seconds), 0) as talk_seconds
    from staff_calls call
    group by call.staff_id
  ),
  employee_rows as (
    select
      staff.id as staff_id,
      staff.full_name as name,
      staff.job_title,
      staff.role_key,
      staff.department_name,
      staff.account_status,
      coalesce(assignment.leads_assigned, 0) as leads_assigned,
      coalesce(contact.touched_leads, 0) as touched_leads,
      coalesce(activity.activities, 0) as activities,
      coalesce(contact.paid_contacts, 0) as paid_contacts,
      coalesce(opportunity.won_opportunities, 0) as won_opportunities,
      coalesce(opportunity.won_revenue_minor, 0) as won_revenue_minor,
      coalesce(payment.realized_revenue_minor, 0)
        as realized_revenue_minor,
      coalesce(task.tasks_total, 0) as tasks_total,
      coalesce(task.tasks_completed, 0) as tasks_completed,
      coalesce(task.tasks_on_time, 0) as tasks_on_time,
      coalesce(task.overdue_tasks, 0) as overdue_tasks,
      coalesce(call.calls, 0) as calls,
      coalesce(call.answered_calls, 0) as answered_calls,
      coalesce(call.talk_seconds, 0) as talk_seconds,
      case when coalesce(assignment.leads_assigned, 0) > 0 then
        round(
          least(
            100.0,
            100.0 * coalesce(contact.paid_contacts, 0)
              / assignment.leads_assigned
          ),
          1
        )
      end as conversion_rate,
      case when coalesce(task.tasks_total, 0) > 0 then
        round(100.0 * task.tasks_completed / task.tasks_total, 1)
      end as task_completion_rate,
      case when coalesce(task.tasks_completed, 0) > 0 then
        round(100.0 * task.tasks_on_time / task.tasks_completed, 1)
      end as task_on_time_rate,
      case when coalesce(call.calls, 0) > 0 then
        round(100.0 * call.answered_calls / call.calls, 1)
      end as call_answer_rate,
      contact.data_completeness_rate,
      case when coalesce(assignment.leads_assigned, 0) > 0 then
        round(
          100.0 * coalesce(assignment.first_actions_on_time, 0)
            / assignment.leads_assigned,
          1
        )
      end as first_response_sla_rate
    from staff_scope staff
    left join assignment_stats assignment on assignment.staff_id = staff.id
    left join contact_stats contact on contact.staff_id = staff.id
    left join activity_stats activity on activity.staff_id = staff.id
    left join task_stats task on task.staff_id = staff.id
    left join opportunity_stats opportunity
      on opportunity.staff_id = staff.id
    left join payment_stats payment on payment.staff_id = staff.id
    left join call_stats call on call.staff_id = staff.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'staffId', row.staff_id,
    'name', row.name,
    'jobTitle', row.job_title,
    'roleKey', row.role_key,
    'department', row.department_name,
    'accountStatus', row.account_status,
    'leadsAssigned', row.leads_assigned,
    'touchedLeads', row.touched_leads,
    'activities', row.activities,
    'paidContacts', row.paid_contacts,
    'wonOpportunities', row.won_opportunities,
    'wonRevenueMinor', row.won_revenue_minor,
    'realizedRevenueMinor', row.realized_revenue_minor,
    'tasksTotal', row.tasks_total,
    'tasksCompleted', row.tasks_completed,
    'tasksOnTime', row.tasks_on_time,
    'overdueTasks', row.overdue_tasks,
    'calls', row.calls,
    'answeredCalls', row.answered_calls,
    'talkSeconds', row.talk_seconds,
    'conversionRate', row.conversion_rate,
    'taskCompletionRate', row.task_completion_rate,
    'taskOnTimeRate', row.task_on_time_rate,
    'callAnswerRate', row.call_answer_rate,
    'dataCompletenessRate', row.data_completeness_rate,
    'firstResponseSlaRate', row.first_response_sla_rate
  ) order by
    row.realized_revenue_minor desc,
    row.paid_contacts desc,
    row.activities desc,
    row.name
  ), '[]'::jsonb)
  into v_employees
  from employee_rows row;

  with scoped_assignments as (
    select distinct
      assignment.contact_id,
      assignment.assigned_staff_id,
      assignment.first_action_at,
      assignment.deadline_at
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
      and assignment.assigned_staff_id = any(v_scope_staff_ids)
  ),
  assigned_quality as (
    select
      count(*) as total,
      count(*) filter (
        where exists (
          select 1
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant.id
            and handoff.contact_id = contact.id
            and handoff.payment_status = 'verified'
            and handoff.paid_at >= v_from_at
            and handoff.paid_at < v_to_at
        )
      ) as paid,
      round(avg(
        (
          (nullif(trim(contact.full_name), '') is not null)::integer
          + (
            nullif(trim(coalesce(contact.phone, '')), '') is not null
            or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
          )::integer
          + (nullif(trim(contact.source), '') is not null)::integer
          + (contact.interest_course_id is not null)::integer
          + (contact.owner_staff_id is not null)::integer
        ) * 20.0
      ), 1) as completeness
    from scoped_assignments assignment
    join sales_core.contacts contact on contact.id = assignment.contact_id
    where private_app.v2_metric_is_countable_contact(
      contact.status,
      contact.lead_status
    )
  ),
  scoped_calls as (
    select distinct record.*
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
      and exists (
        select 1
        from jsonb_each_text(v_assignment_map) mapping
        where mapping.value = any(v_scope_staff_text)
          and mapping.key = any(record.involved_extensions)
      )
  ),
  values as (
    select
      (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.created_at >= v_from_at
          and contact.created_at < v_to_at
          and contact.owner_staff_id = any(v_scope_staff_ids)
          and private_app.v2_metric_is_countable_contact(
            contact.status,
            contact.lead_status
          )
      ) as leads_created,
      (select total from assigned_quality) as leads_assigned,
      (select paid from assigned_quality) as assigned_paid,
      (select completeness from assigned_quality) as completeness,
      (
        select count(*)
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.occurred_at >= v_from_at
          and activity.occurred_at < v_to_at
          and activity.actor_staff_id = any(v_scope_staff_ids)
      ) as activities,
      (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and task.assigned_staff_id = any(v_scope_staff_ids)
          and task.status in ('todo', 'in_progress', 'completed')
      ) as tasks_total,
      (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and task.status = 'completed'
          and task.completed_at < v_to_at
          and task.assigned_staff_id = any(v_scope_staff_ids)
      ) as tasks_completed,
      (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and task.status in ('todo', 'in_progress')
          and task.due_at < least(v_to_at, now())
          and task.assigned_staff_id = any(v_scope_staff_ids)
      ) as overdue_tasks,
      (select count(*) from scoped_calls) as calls,
      (
        select count(*) from scoped_calls
        where final_status = 'ANSWERED'
      ) as answered_calls,
      (
        select coalesce(sum(handling_duration_seconds), 0)
        from scoped_calls
      ) as talk_seconds,
      (
        select count(distinct handoff.contact_id)
        from academy.registration_handoffs handoff
        join sales_core.contacts contact
          on contact.id = handoff.contact_id
         and contact.tenant_id = handoff.tenant_id
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
          and contact.owner_staff_id = any(v_scope_staff_ids)
      ) as paid_contacts,
      (
        select coalesce(sum(handoff.payment_amount_minor), 0)
        from academy.registration_handoffs handoff
        join sales_core.contacts contact on contact.id = handoff.contact_id
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
          and contact.owner_staff_id = any(v_scope_staff_ids)
      ) as realized_revenue_minor,
      (
        select coalesce(sum(opportunity.value_minor), 0)
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.status = 'won'
          and opportunity.updated_at >= v_from_at
          and opportunity.updated_at < v_to_at
          and opportunity.owner_staff_id = any(v_scope_staff_ids)
      ) as won_revenue_minor,
      (
        select coalesce(sum(opportunity.value_minor), 0)
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.status = 'open'
          and opportunity.owner_staff_id = any(v_scope_staff_ids)
      ) as pipeline_value_minor,
      (
        select count(distinct concat_ws(
          '|',
          coalesce(contact.source, ''),
          coalesce(contact.campaign_name, ''),
          coalesce(contact.ad_name, '')
        ))
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.created_at >= v_from_at
          and contact.created_at < v_to_at
          and contact.owner_staff_id = any(v_scope_staff_ids)
      ) as campaign_count,
      (
        select count(*)
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = v_tenant.id
          and assignment.assigned_at >= v_from_at
          and assignment.assigned_at < v_to_at
          and assignment.first_action_at is not null
          and assignment.first_action_at <= assignment.deadline_at
          and assignment.assigned_staff_id = any(v_scope_staff_ids)
      ) as first_actions_on_time
  )
  select jsonb_build_object(
    'leadsCreated', value.leads_created,
    'leadsAssigned', value.leads_assigned,
    'activities', value.activities,
    'tasksTotal', value.tasks_total,
    'tasksCompleted', value.tasks_completed,
    'overdueTasks', value.overdue_tasks,
    'calls', value.calls,
    'answeredCalls', value.answered_calls,
    'talkSeconds', value.talk_seconds,
    'paidContacts', value.paid_contacts,
    'realizedRevenueMinor', value.realized_revenue_minor,
    'wonRevenueMinor', value.won_revenue_minor,
    'pipelineValueMinor', value.pipeline_value_minor,
    'campaignCount', value.campaign_count,
    'conversionRate', case when value.leads_created > 0 then
      round(100.0 * value.paid_contacts / value.leads_created, 1)
    end,
    'averageSaleMinor', case when value.paid_contacts > 0 then
      round(
        value.realized_revenue_minor::numeric / value.paid_contacts
      )::bigint
    else 0 end,
    'taskCompletionRate', case when value.tasks_total > 0 then
      round(100.0 * value.tasks_completed / value.tasks_total, 1)
    end,
    'callAnswerRate', case when value.calls > 0 then
      round(100.0 * value.answered_calls / value.calls, 1)
    end,
    'dataCompletenessRate', value.completeness,
    'firstResponseSlaRate', case when value.leads_assigned > 0 then
      round(
        100.0 * value.first_actions_on_time / value.leads_assigned,
        1
      )
    end
  )
  into v_summary
  from values value;

  with days as (
    select day::date
    from generate_series(
      v_from_date::timestamp,
      v_to_date::timestamp,
      interval '1 day'
    ) day
  ),
  assigned as (
    select
      (assignment.assigned_at at time zone v_tenant.timezone)::date as day,
      count(distinct assignment.contact_id) as total
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
      and assignment.assigned_staff_id = any(v_scope_staff_ids)
    group by 1
  ),
  created as (
    select
      (contact.created_at at time zone v_tenant.timezone)::date as day,
      count(*) as total
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
      and contact.owner_staff_id = any(v_scope_staff_ids)
      and private_app.v2_metric_is_countable_contact(
        contact.status,
        contact.lead_status
      )
    group by 1
  ),
  activities as (
    select
      (activity.occurred_at at time zone v_tenant.timezone)::date as day,
      count(*) as total
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_from_at
      and activity.occurred_at < v_to_at
      and activity.actor_staff_id = any(v_scope_staff_ids)
    group by 1
  ),
  paid as (
    select
      (handoff.paid_at at time zone v_tenant.timezone)::date as day,
      count(distinct handoff.contact_id) as total
    from academy.registration_handoffs handoff
    join sales_core.contacts contact
      on contact.id = handoff.contact_id
     and contact.tenant_id = handoff.tenant_id
    where handoff.tenant_id = v_tenant.id
      and handoff.payment_status = 'verified'
      and handoff.paid_at >= v_from_at
      and handoff.paid_at < v_to_at
      and contact.owner_staff_id = any(v_scope_staff_ids)
    group by 1
  ),
  tasks as (
    select
      (task.completed_at at time zone v_tenant.timezone)::date as day,
      count(*) as total
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.status = 'completed'
      and task.completed_at >= v_from_at
      and task.completed_at < v_to_at
      and task.assigned_staff_id = any(v_scope_staff_ids)
    group by 1
  ),
  calls as (
    select
      (record.started_at at time zone v_tenant.timezone)::date as day,
      count(distinct record.id) as total
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
      and exists (
        select 1
        from jsonb_each_text(v_assignment_map) mapping
        where mapping.value = any(v_scope_staff_text)
          and mapping.key = any(record.involved_extensions)
      )
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', day.day,
    'leadsAssigned', coalesce(assigned.total, 0),
    'leadsCreated', coalesce(created.total, 0),
    'activities', coalesce(activities.total, 0),
    'paid', coalesce(paid.total, 0),
    'tasksCompleted', coalesce(tasks.total, 0),
    'calls', coalesce(calls.total, 0)
  ) order by day.day), '[]'::jsonb)
  into v_daily
  from days day
  left join assigned on assigned.day = day.day
  left join created on created.day = day.day
  left join activities on activities.day = day.day
  left join paid on paid.day = day.day
  left join tasks on tasks.day = day.day
  left join calls on calls.day = day.day;

  with campaign_contacts as (
    select
      contact.id,
      contact.source,
      contact.campaign_name,
      contact.ad_name,
      exists (
        select 1
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.contact_id = contact.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
      ) as paid,
      (
        (
          (nullif(trim(contact.full_name), '') is not null)::integer
          + (
            nullif(trim(coalesce(contact.phone, '')), '') is not null
            or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
          )::integer
          + (nullif(trim(contact.source), '') is not null)::integer
          + (contact.interest_course_id is not null)::integer
          + (contact.owner_staff_id is not null)::integer
        ) * 20.0
      ) as completeness,
      exists (
        select 1
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.contact_id = contact.id
          and activity.occurred_at >= v_from_at
          and activity.occurred_at < v_to_at
      ) as touched,
      coalesce((
        select sum(handoff.payment_amount_minor)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.contact_id = contact.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
      ), 0) as revenue_minor
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
      and contact.owner_staff_id = any(v_scope_staff_ids)
      and private_app.v2_metric_is_countable_contact(
        contact.status,
        contact.lead_status
      )
  ),
  rollup as (
    select
      coalesce(nullif(trim(source), ''), 'غير محدد') as source,
      coalesce(nullif(trim(campaign_name), ''), 'بدون اسم حملة')
        as campaign,
      coalesce(nullif(trim(ad_name), ''), 'بدون اسم إعلان') as ad,
      count(*) as leads,
      count(*) filter (where touched) as touched_leads,
      count(*) filter (where paid) as paid_contacts,
      coalesce(sum(revenue_minor), 0) as revenue_minor,
      round(avg(completeness), 1) as completeness
    from campaign_contacts
    group by 1, 2, 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', item.source,
    'campaign', item.campaign,
    'ad', item.ad,
    'leads', item.leads,
    'touchedLeads', item.touched_leads,
    'paidContacts', item.paid_contacts,
    'conversionRate', case when item.leads > 0 then
      round(100.0 * item.paid_contacts / item.leads, 1)
    end,
    'revenueMinor', item.revenue_minor,
    'dataCompletenessRate', item.completeness
  ) order by item.paid_contacts desc, item.leads desc, item.source),
  '[]'::jsonb)
  into v_campaigns
  from rollup item;

  with rows as (
    select value as campaign
    from jsonb_array_elements(v_campaigns)
  ),
  rollup as (
    select
      campaign ->> 'source' as source,
      sum((campaign ->> 'leads')::integer) as leads,
      sum((campaign ->> 'paidContacts')::integer) as paid_contacts,
      sum((campaign ->> 'revenueMinor')::bigint) as revenue_minor
    from rows
    group by campaign ->> 'source'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', source,
    'leads', leads,
    'paidContacts', paid_contacts,
    'conversionRate', case when leads > 0 then
      round(100.0 * paid_contacts / leads, 1)
    end,
    'revenueMinor', revenue_minor
  ) order by paid_contacts desc, leads desc), '[]'::jsonb)
  into v_sources
  from rollup;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', status,
    'label', case status
      when 'new' then 'جديد'
      when 'contacted' then 'تم التواصل'
      when 'no_answer' then 'لا يرد'
      when 'interested' then 'مهتم'
      when 'very_interested' then 'مهتم جدًا'
      when 'awaiting_payment' then 'بانتظار الدفع'
      when 'paid' then 'تم الدفع'
      when 'not_interested' then 'غير مهتم'
      when 'unqualified' then 'غير مؤهل'
      when 'wrong_number' then 'رقم خاطئ'
      when 'duplicate' then 'مكرر'
      when 'cancelled' then 'ملغي'
      else status
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_lead_statuses
  from (
    select contact.lead_status as status, count(*) as total
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and (
        (
          p_report = 'employee'
          and exists (
            select 1
            from sales_core.lead_assignments assignment
            where assignment.tenant_id = v_tenant.id
              and assignment.contact_id = contact.id
              and assignment.assigned_staff_id = v_target_staff_id
              and assignment.assigned_at >= v_from_at
              and assignment.assigned_at < v_to_at
          )
        )
        or (
          p_report <> 'employee'
          and contact.created_at >= v_from_at
          and contact.created_at < v_to_at
          and contact.owner_staff_id = any(v_scope_staff_ids)
        )
      )
    group by contact.lead_status
  ) status_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', stage.id,
    'name', stage.name_ar,
    'key', stage.stage_key,
    'count', stats.total,
    'valueMinor', stats.value_minor
  ) order by stage.position), '[]'::jsonb)
  into v_pipeline_stages
  from sales_core.pipeline_stages stage
  join lateral (
    select
      count(*) as total,
      coalesce(sum(opportunity.value_minor), 0) as value_minor
    from sales_core.opportunities opportunity
    where opportunity.tenant_id = v_tenant.id
      and opportunity.stage_id = stage.id
      and opportunity.created_at < v_to_at
      and opportunity.updated_at >= v_from_at
      and opportunity.owner_staff_id = any(v_scope_staff_ids)
  ) stats on true
  where stage.tenant_id = v_tenant.id
    and stats.total > 0;

  select coalesce(jsonb_agg(jsonb_build_object(
    'courseId', course.id,
    'name', course.title_ar,
    'leads', stats.leads,
    'paidContacts', stats.paid_contacts,
    'revenueMinor', stats.revenue_minor
  ) order by stats.paid_contacts desc, stats.leads desc, course.title_ar),
  '[]'::jsonb)
  into v_courses
  from academy.courses course
  join lateral (
    select
      count(*) as leads,
      count(*) filter (
        where exists (
          select 1
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant.id
            and handoff.contact_id = contact.id
            and handoff.course_id = course.id
            and handoff.payment_status = 'verified'
            and handoff.paid_at >= v_from_at
            and handoff.paid_at < v_to_at
        )
      ) as paid_contacts,
      coalesce(sum(coalesce((
        select sum(handoff.payment_amount_minor)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.contact_id = contact.id
          and handoff.course_id = course.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
      ), 0)), 0) as revenue_minor
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.interest_course_id = course.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
      and contact.owner_staff_id = any(v_scope_staff_ids)
      and private_app.v2_metric_is_countable_contact(
        contact.status,
        contact.lead_status
      )
  ) stats on true
  where course.tenant_id = v_tenant.id
    and (stats.leads > 0 or stats.revenue_minor > 0);

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', activity_type,
    'label', case activity_type
      when 'call' then 'مكالمة'
      when 'whatsapp' then 'واتساب'
      when 'meeting' then 'اجتماع'
      when 'note' then 'ملاحظة'
      when 'offer' then 'عرض'
      when 'email' then 'بريد إلكتروني'
      else activity_type
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_activity_breakdown
  from (
    select activity.activity_type, count(*) as total
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_from_at
      and activity.occurred_at < v_to_at
      and activity.actor_staff_id = any(v_scope_staff_ids)
    group by activity.activity_type
  ) activity_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', status,
    'label', case status
      when 'todo' then 'لم يبدأ'
      when 'in_progress' then 'قيد التنفيذ'
      when 'completed' then 'مكتمل'
      when 'cancelled' then 'ملغي'
      else status
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_task_breakdown
  from (
    select task.status, count(*) as total
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.due_at >= v_from_at
      and task.due_at < v_to_at
      and task.assigned_staff_id = any(v_scope_staff_ids)
    group by task.status
  ) task_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', final_status,
    'label', case final_status
      when 'ANSWERED' then 'تم الرد'
      when 'NO ANSWER' then 'لا يوجد رد'
      when 'BUSY' then 'مشغول'
      when 'FAILED' then 'فشلت'
      when 'VOICEMAIL' then 'بريد صوتي'
      else final_status
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_call_breakdown
  from (
    select record.final_status, count(distinct record.id) as total
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
      and exists (
        select 1
        from jsonb_each_text(v_assignment_map) mapping
        where mapping.value = any(v_scope_staff_text)
          and mapping.key = any(record.involved_extensions)
      )
    group by record.final_status
  ) call_rows;

  if p_report = 'employee' and v_target_staff_id is not null then
    v_details := jsonb_build_object(
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', task.id,
          'title', task.title,
          'status', task.status,
          'priority', task.priority,
          'dueAt', task.due_at,
          'completedAt', task.completed_at,
          'contactName', contact.full_name
        ) order by task.due_at desc)
        from (
          select scoped.*
          from work_core.tasks scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.assigned_staff_id = v_target_staff_id
            and scoped.due_at >= v_from_at
            and scoped.due_at < v_to_at
          order by scoped.due_at desc
          limit v_limit offset v_offset
        ) task
        left join sales_core.contacts contact on contact.id = task.contact_id
      ), '[]'::jsonb),
      'activities', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', activity.id,
          'type', activity.activity_type,
          'summary', activity.summary,
          'outcome', activity.outcome,
          'occurredAt', activity.occurred_at,
          'contactName', contact.full_name
        ) order by activity.occurred_at desc)
        from (
          select scoped.*
          from sales_core.activities scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.actor_staff_id = v_target_staff_id
            and scoped.occurred_at >= v_from_at
            and scoped.occurred_at < v_to_at
          order by scoped.occurred_at desc
          limit v_limit offset v_offset
        ) activity
        join sales_core.contacts contact on contact.id = activity.contact_id
      ), '[]'::jsonb),
      'calls', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', call.id,
          'startedAt', call.started_at,
          'callType', call.call_type,
          'finalStatus', call.final_status,
          'otherNumber', case
            when call.call_type = 'Outbound' then call.callee_number
            else call.caller_number
          end,
          'talkSeconds', call.handling_duration_seconds
        ) order by call.started_at desc)
        from (
          select distinct scoped.*
          from telephony.call_records scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.started_at >= v_from_at
            and scoped.started_at < v_to_at
            and exists (
              select 1
              from jsonb_each_text(v_assignment_map) mapping
              where mapping.value = v_target_staff_id::text
                and mapping.key = any(scoped.involved_extensions)
            )
          order by scoped.started_at desc
          limit v_limit offset v_offset
        ) call
      ), '[]'::jsonb),
      'leads', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', contact.id,
          'name', contact.full_name,
          'status', contact.lead_status,
          'source', contact.source,
          'courseName', course.title_ar,
          'assignedAt', assignment.assigned_at,
          'completenessRate', (
            (
              (nullif(trim(contact.full_name), '') is not null)::integer
              + (
                nullif(trim(coalesce(contact.phone, '')), '') is not null
                or nullif(
                  trim(coalesce(contact.whatsapp, '')),
                  ''
                ) is not null
              )::integer
              + (nullif(trim(contact.source), '') is not null)::integer
              + (contact.interest_course_id is not null)::integer
              + (contact.owner_staff_id is not null)::integer
            ) * 20.0
          )
        ) order by assignment.assigned_at desc)
        from (
          select distinct on (scoped.contact_id)
            scoped.contact_id,
            scoped.assigned_at
          from sales_core.lead_assignments scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.assigned_staff_id = v_target_staff_id
            and scoped.assigned_at >= v_from_at
            and scoped.assigned_at < v_to_at
          order by scoped.contact_id, scoped.assigned_at desc
          limit v_limit offset v_offset
        ) assignment
        join sales_core.contacts contact on contact.id = assignment.contact_id
        left join academy.courses course
          on course.id = contact.interest_course_id
      ), '[]'::jsonb)
    );
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'period', jsonb_build_object(
      'from', v_from_date,
      'to', v_to_date,
      'days', v_to_date - v_from_date + 1,
      'timezone', v_tenant.timezone
    ),
    'viewer', jsonb_build_object(
      'staffId', v_current_staff_id,
      'roleKey', v_role_key,
      'viewTeam', v_view_team,
      'scope', case
        when v_target_staff_id is not null then 'employee'
        else 'team'
      end
    ),
    'availability', jsonb_build_object(
      'sales', v_can_crm,
      'campaigns', v_can_crm or v_can_leads,
      'team', v_view_team
    ),
    'selectedEmployee', v_selected_employee,
    'summary', v_summary,
    'employees', v_employees,
    'daily', v_daily,
    'campaigns', v_campaigns,
    'sources', v_sources,
    'leadStatuses', v_lead_statuses,
    'pipelineStages', v_pipeline_stages,
    'courses', v_courses,
    'activityBreakdown', v_activity_breakdown,
    'taskBreakdown', v_task_breakdown,
    'callBreakdown', v_call_breakdown,
    'details', v_details
  );
end;
$$;

revoke all on function public.v2_tenant_reports_snapshot_v1(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.v2_tenant_reports_snapshot_v1(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) to authenticated;

create or replace function public.v2_tenant_reports_snapshot_v3(
  p_slug text,
  p_from date default null,
  p_to date default null,
  p_staff_id uuid default null,
  p_report text default 'overview',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.v2_tenant_reports_snapshot_v1(
    p_slug,
    p_from,
    p_to,
    p_staff_id,
    p_report,
    p_limit,
    p_offset
  );
$$;

revoke all on function public.v2_tenant_reports_snapshot_v3(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.v2_tenant_reports_snapshot_v3(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) to authenticated;

comment on function public.v2_tenant_reports_snapshot_v3(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) is
  'Canonical employee and campaign reporting using direct-report scope and verified payment metrics.';

commit;
