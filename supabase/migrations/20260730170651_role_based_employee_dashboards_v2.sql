-- Role-based employee dashboards and secure Yeastar-to-staff assignment.
begin;

create or replace function public.v2_tenant_yeastar_staff_options(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', staff.id,
        'name', staff.full_name,
        'jobTitle', staff.job_title,
        'roleKey', staff.role_key,
        'accountStatus', staff.account_status
      )
      order by staff.full_name
    )
    from people.staff_profiles staff
    where staff.tenant_id = v_tenant_id
      and staff.employment_status = 'active'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.v2_tenant_yeastar_save_with_assignments(
  p_tenant_slug text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_connection_id uuid;
  v_result jsonb;
  v_extensions text[] := '{}'::text[];
  v_requested jsonb;
  v_assignments jsonb := '{}'::jsonb;
  v_extension text;
  v_staff_text text;
  v_staff_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;

  v_result := public.v2_tenant_yeastar_action(
    p_tenant_slug,
    'save',
    coalesce(p_payload, '{}'::jsonb)
  );

  select
    connection.id,
    regexp_split_to_array(
      coalesce(connection.public_config ->> 'extensions', ''),
      '\s*,\s*'
    )
  into v_connection_id, v_extensions
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant_id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  if v_connection_id is null then
    raise exception 'integration_connection_not_found';
  end if;

  v_requested := coalesce(
    p_payload #> '{publicConfig,extensionAssignments}',
    '{}'::jsonb
  );
  if jsonb_typeof(v_requested) <> 'object' then
    raise exception 'yeastar_invalid_extension_assignments';
  end if;

  for v_extension, v_staff_text in
    select trim(entry.key), trim(entry.value)
    from jsonb_each_text(v_requested) entry
  loop
    if v_staff_text = '' then
      continue;
    end if;
    if v_extension !~ '^[0-9]{1,10}$'
       or not (v_extension = any(v_extensions)) then
      raise exception 'yeastar_extension_mapping_not_configured:%',
        v_extension;
    end if;

    begin
      v_staff_id := v_staff_text::uuid;
    exception when invalid_text_representation then
      raise exception 'yeastar_invalid_staff_assignment:%', v_extension;
    end;

    if not exists (
      select 1
      from people.staff_profiles staff
      where staff.id = v_staff_id
        and staff.tenant_id = v_tenant_id
        and staff.employment_status = 'active'
    ) then
      raise exception 'yeastar_staff_not_found:%', v_extension;
    end if;

    v_assignments := v_assignments
      || jsonb_build_object(v_extension, v_staff_id::text);
  end loop;

  update communication_hub.provider_connections connection
  set public_config = jsonb_set(
        connection.public_config,
        '{extensionAssignments}',
        v_assignments,
        true
      ),
      updated_at = now()
  where connection.id = v_connection_id;

  perform private_app.write_audit(
    'tenant.yeastar.staff_mapping.updated',
    'provider_connection',
    v_connection_id::text,
    v_tenant_id,
    jsonb_build_object(
      'mappedExtensions', (
        select count(*) from jsonb_object_keys(v_assignments)
      )
    )
  );

  return coalesce(v_result, '{}'::jsonb)
    || jsonb_build_object('extensionAssignments', v_assignments);
end;
$$;

create or replace function public.v2_tenant_role_dashboard_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_staff_id uuid;
  v_staff_name text;
  v_job_title text;
  v_role_key text;
  v_role_label text;
  v_view_team boolean := false;
  v_can_crm boolean := false;
  v_can_leads boolean := false;
  v_can_training boolean := false;
  v_can_incentives boolean := false;
  v_is_executive boolean := false;
  v_connection communication_hub.provider_connections%rowtype;
  v_assignment_map jsonb := '{}'::jsonb;
  v_extensions text[] := '{}'::text[];
  v_personal jsonb;
  v_executive jsonb := '{}'::jsonb;
  v_sales jsonb := '{}'::jsonb;
  v_telephony jsonb := '{}'::jsonb;
  v_lead_operations jsonb := '{}'::jsonb;
  v_training jsonb := '{}'::jsonb;
  v_team jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.workspace.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant_id);
  select
    staff.full_name,
    staff.job_title,
    staff.role_key
  into
    v_staff_name,
    v_job_title,
    v_role_key
  from people.staff_profiles staff
  where staff.id = v_staff_id
    and staff.tenant_id = v_tenant_id
  limit 1;

  if v_role_key is null
     and private_app.has_platform_permission('platform.tenants.read') then
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

  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_can_crm := private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.read'
  );
  v_can_leads := (
    private_app.has_tenant_permission(v_tenant_id, 'tenant.leads.read')
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.leads.analytics'
    )
  );
  v_can_training := (
    private_app.has_tenant_permission(v_tenant_id, 'tenant.academy.read')
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.admissions.read'
    )
  );
  v_can_incentives := private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.incentives.read'
  );
  v_is_executive := v_role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  );

  select *
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant_id
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
    select coalesce(array_agg(mapping.key), '{}'::text[])
    into v_extensions
    from jsonb_each_text(v_assignment_map) mapping
    where mapping.value = v_staff_id::text;
  end if;

  select jsonb_build_object(
    'tasksToday', count(*) filter (
      where task.status <> 'completed'
        and task.due_at >= date_trunc('day', now())
        and task.due_at < date_trunc('day', now()) + interval '1 day'
    ),
    'openTasks', count(*) filter (where task.status <> 'completed'),
    'overdueTasks', count(*) filter (
      where task.status <> 'completed' and task.due_at < now()
    ),
    'completedThisMonth', count(*) filter (
      where task.status = 'completed'
        and task.completed_at >= date_trunc('month', now())
    ),
    'onTimeThisMonth', count(*) filter (
      where task.status = 'completed'
        and task.completed_at >= date_trunc('month', now())
        and task.completion_timing = 'on_time'
    )
  )
  into v_personal
  from work_core.tasks task
  where task.tenant_id = v_tenant_id
    and task.assigned_staff_id = v_staff_id;

  v_personal := coalesce(v_personal, '{}'::jsonb)
    || jsonb_build_object(
      'activitiesToday', (
        select count(*)
        from sales_core.activities activity
        where activity.tenant_id = v_tenant_id
          and activity.actor_staff_id = v_staff_id
          and activity.occurred_at >= date_trunc('day', now())
      ),
      'activeLeads', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant_id
          and contact.owner_staff_id = v_staff_id
          and contact.lead_status not in ('paid', 'unqualified', 'lost')
      ),
      'paidThisMonth', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant_id
          and contact.owner_staff_id = v_staff_id
          and contact.lead_status = 'paid'
          and contact.lead_status_changed_at >= date_trunc('month', now())
      ),
      'pendingIncentive', case when v_can_incentives then (
        select coalesce(sum(event.incentive_amount), 0)
        from incentives_core.events event
        where event.tenant_id = v_tenant_id
          and event.staff_id = v_staff_id
          and event.state in ('expected', 'pending', 'due', 'approved')
      ) else 0 end,
      'paidIncentiveThisMonth', case when v_can_incentives then (
        select coalesce(sum(event.incentive_amount), 0)
        from incentives_core.events event
        where event.tenant_id = v_tenant_id
          and event.staff_id = v_staff_id
          and event.state = 'paid'
          and event.paid_at >= date_trunc('month', now())
      ) else 0 end
    );

  if v_is_executive then
    select jsonb_build_object(
      'activeStaff', count(*) filter (
        where staff.employment_status = 'active'
      ),
      'activeAccounts', count(*) filter (
        where staff.account_status = 'active'
      )
    )
    into v_executive
    from people.staff_profiles staff
    where staff.tenant_id = v_tenant_id;

    v_executive := coalesce(v_executive, '{}'::jsonb)
      || jsonb_build_object(
        'pipelineValueMinor', (
          select coalesce(sum(opportunity.value_minor), 0)
          from sales_core.opportunities opportunity
          where opportunity.tenant_id = v_tenant_id
            and opportunity.status = 'open'
        ),
        'wonRevenueMinor', (
          select coalesce(sum(opportunity.value_minor), 0)
          from sales_core.opportunities opportunity
          where opportunity.tenant_id = v_tenant_id
            and opportunity.status = 'won'
            and opportunity.updated_at >= date_trunc('month', now())
        ),
        'pendingAdmissions', (
          select count(*)
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant_id
            and handoff.status in ('pending', 'in_review')
        ),
        'activeCourseRuns', (
          select count(*)
          from academy.course_runs course_run
          where course_run.tenant_id = v_tenant_id
            and course_run.status in ('open', 'in_progress')
        )
      );
  end if;

  if v_can_crm then
    select jsonb_build_object(
      'activeLeads', count(*) filter (
        where contact.lead_status not in ('paid', 'unqualified', 'lost')
      ),
      'newLeads', count(*) filter (
        where contact.lead_status in ('new', 'not_contacted')
      ),
      'awaitingPayment', count(*) filter (
        where contact.lead_status = 'awaiting_payment'
      ),
      'paidThisMonth', count(*) filter (
        where contact.lead_status = 'paid'
          and contact.lead_status_changed_at >= date_trunc('month', now())
      ),
      'overdueFollowUps', count(*) filter (
        where contact.lead_status not in ('paid', 'unqualified', 'lost')
          and contact.next_action_at < now()
      ),
      'conversionRate', coalesce(round(
        100.0 * count(*) filter (where contact.lead_status = 'paid')
        / nullif(count(*), 0),
        1
      ), 0)
    )
    into v_sales
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant_id
      and (v_view_team or contact.owner_staff_id = v_staff_id);

    v_sales := coalesce(v_sales, '{}'::jsonb)
      || jsonb_build_object(
        'pipelineValueMinor', (
          select coalesce(sum(opportunity.value_minor), 0)
          from sales_core.opportunities opportunity
          where opportunity.tenant_id = v_tenant_id
            and opportunity.status = 'open'
            and (
              v_view_team
              or opportunity.owner_staff_id = v_staff_id
            )
        ),
        'assignmentsThisMonth', (
          select count(*)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant_id
            and assignment.assigned_at >= date_trunc('month', now())
            and (
              v_view_team
              or assignment.assigned_staff_id = v_staff_id
            )
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
          where assignment.tenant_id = v_tenant_id
            and assignment.assigned_at >= date_trunc('month', now())
            and (
              v_view_team
              or assignment.assigned_staff_id = v_staff_id
            )
        ),
        'averageFirstResponseMinutes', (
          select coalesce(round(avg(
            extract(epoch from (
              assignment.first_action_at - assignment.assigned_at
            )) / 60
          ))::integer, 0)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant_id
            and assignment.first_action_at is not null
            and assignment.assigned_at >= date_trunc('month', now())
            and (
              v_view_team
              or assignment.assigned_staff_id = v_staff_id
            )
        )
      );

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'source', source_stats.source,
        'total', source_stats.total,
        'paid', source_stats.paid,
        'conversionRate', source_stats.conversion_rate
      )
      order by source_stats.total desc
    ), '[]'::jsonb)
    into v_sources
    from (
      select
        coalesce(nullif(contact.source, ''), 'غير محدد') as source,
        count(*) as total,
        count(*) filter (where contact.lead_status = 'paid') as paid,
        coalesce(round(
          100.0 * count(*) filter (where contact.lead_status = 'paid')
          / nullif(count(*), 0),
          1
        ), 0) as conversion_rate
      from sales_core.contacts contact
      where contact.tenant_id = v_tenant_id
        and (v_view_team or contact.owner_staff_id = v_staff_id)
      group by 1
      order by count(*) desc
      limit 5
    ) source_stats;
  end if;

  if v_can_crm or v_role_key = 'customer_service' then
    select jsonb_build_object(
      'configured', v_connection.id is not null,
      'status', coalesce(v_connection.status, 'disabled'),
      'mapped', v_view_team or cardinality(v_extensions) > 0,
      'extensions', case
        when v_view_team then coalesce(
          v_connection.public_config ->> 'extensions',
          ''
        )
        else array_to_string(v_extensions, ', ')
      end,
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
    where record.tenant_id = v_tenant_id
      and record.started_at >= date_trunc('month', now())
      and (
        v_view_team
        or (
          cardinality(v_extensions) > 0
          and record.involved_extensions && v_extensions
        )
      );
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
    where batch.tenant_id = v_tenant_id
      and batch.created_at >= date_trunc('month', now());

    v_lead_operations := coalesce(v_lead_operations, '{}'::jsonb)
      || jsonb_build_object(
        'awaitingDistribution', (
          select count(*)
          from sales_core.lead_import_rows import_row
          where import_row.tenant_id = v_tenant_id
            and import_row.validation_status = 'valid'
            and import_row.queue_status in ('ready', 'pending')
        ),
        'slaBreaches', (
          select count(*)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant_id
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
          where assignment.tenant_id = v_tenant_id
            and assignment.assigned_at >= date_trunc('month', now())
        ),
        'averageFirstResponseMinutes', (
          select coalesce(round(avg(
            extract(epoch from (
              assignment.first_action_at - assignment.assigned_at
            )) / 60
          ))::integer, 0)
          from sales_core.lead_assignments assignment
          where assignment.tenant_id = v_tenant_id
            and assignment.first_action_at is not null
            and assignment.assigned_at >= date_trunc('month', now())
        )
      );
  end if;

  if v_can_training then
    v_training := jsonb_build_object(
      'pendingAdmissions', (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant_id
          and handoff.status in ('pending', 'in_review')
      ),
      'pendingPaymentVerification', (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant_id
          and handoff.payment_status = 'pending_verification'
      ),
      'activeCourseRuns', (
        select count(*)
        from academy.course_runs course_run
        where course_run.tenant_id = v_tenant_id
          and course_run.status in ('open', 'in_progress')
      ),
      'upcomingSessions', (
        select count(*)
        from academy.course_run_sessions session
        where session.tenant_id = v_tenant_id
          and session.starts_at >= now()
          and session.starts_at < now() + interval '7 days'
          and session.status <> 'cancelled'
      ),
      'activeEnrollments', (
        select count(*)
        from academy.enrollments enrollment
        where enrollment.tenant_id = v_tenant_id
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
        where attendance.tenant_id = v_tenant_id
      ),
      'averageAssessmentRate', (
        select coalesce(round(avg(
          case
            when assessment.max_score > 0
              then 100.0 * assessment.score / assessment.max_score
            else null
          end
        ), 1), 0)
        from academy.assessment_results assessment
        where assessment.tenant_id = v_tenant_id
      ),
      'issuedCertificatesThisMonth', (
        select count(*)
        from academy.certificates certificate
        where certificate.tenant_id = v_tenant_id
          and certificate.status = 'issued'
          and certificate.issued_at >= date_trunc('month', now())
      ),
      'failedAutomationJobs', (
        select count(*)
        from academy.training_automation_jobs job
        where job.tenant_id = v_tenant_id
          and job.status = 'failed'
      )
    );
  end if;

  if v_view_team and v_can_crm then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'staffId', team_row.staff_id,
        'name', team_row.full_name,
        'roleKey', team_row.role_key,
        'jobTitle', team_row.job_title,
        'extension', team_row.extension,
        'activeLeads', team_row.active_leads,
        'activitiesToday', team_row.activities_today,
        'paidThisMonth', team_row.paid_this_month,
        'overdueTasks', team_row.overdue_tasks,
        'totalCalls', team_row.total_calls,
        'answerRate', team_row.answer_rate,
        'talkSeconds', team_row.talk_seconds
      )
      order by team_row.paid_this_month desc,
        team_row.activities_today desc,
        team_row.full_name
    ), '[]'::jsonb)
    into v_team
    from (
      select
        staff.id as staff_id,
        staff.full_name,
        staff.role_key,
        staff.job_title,
        coalesce((
          select string_agg(mapping.key, ', ' order by mapping.key)
          from jsonb_each_text(v_assignment_map) mapping
          where mapping.value = staff.id::text
        ), '') as extension,
        (
          select count(*)
          from sales_core.contacts contact
          where contact.tenant_id = v_tenant_id
            and contact.owner_staff_id = staff.id
            and contact.lead_status not in ('paid', 'unqualified', 'lost')
        ) as active_leads,
        (
          select count(*)
          from sales_core.activities activity
          where activity.tenant_id = v_tenant_id
            and activity.actor_staff_id = staff.id
            and activity.occurred_at >= date_trunc('day', now())
        ) as activities_today,
        (
          select count(*)
          from sales_core.contacts contact
          where contact.tenant_id = v_tenant_id
            and contact.owner_staff_id = staff.id
            and contact.lead_status = 'paid'
            and contact.lead_status_changed_at >= date_trunc('month', now())
        ) as paid_this_month,
        (
          select count(*)
          from work_core.tasks task
          where task.tenant_id = v_tenant_id
            and task.assigned_staff_id = staff.id
            and task.status <> 'completed'
            and task.due_at < now()
        ) as overdue_tasks,
        (
          select count(*)
          from telephony.call_records record
          where record.tenant_id = v_tenant_id
            and record.started_at >= date_trunc('month', now())
            and record.involved_extensions && coalesce((
              select array_agg(mapping.key)
              from jsonb_each_text(v_assignment_map) mapping
              where mapping.value = staff.id::text
            ), '{}'::text[])
        ) as total_calls,
        (
          select coalesce(round(
            100.0 * count(*) filter (
              where record.final_status = 'ANSWERED'
            ) / nullif(count(*), 0),
            1
          ), 0)
          from telephony.call_records record
          where record.tenant_id = v_tenant_id
            and record.started_at >= date_trunc('month', now())
            and record.involved_extensions && coalesce((
              select array_agg(mapping.key)
              from jsonb_each_text(v_assignment_map) mapping
              where mapping.value = staff.id::text
            ), '{}'::text[])
        ) as answer_rate,
        (
          select coalesce(sum(record.handling_duration_seconds), 0)
          from telephony.call_records record
          where record.tenant_id = v_tenant_id
            and record.started_at >= date_trunc('month', now())
            and record.involved_extensions && coalesce((
              select array_agg(mapping.key)
              from jsonb_each_text(v_assignment_map) mapping
              where mapping.value = staff.id::text
            ), '{}'::text[])
        ) as talk_seconds
      from people.staff_profiles staff
      where staff.tenant_id = v_tenant_id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_manager',
          'sales_supervisor',
          'sales_user',
          'customer_service'
        )
    ) team_row;
  end if;

  if v_can_crm then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'date', trend.day,
        'activities', trend.activities,
        'paid', trend.paid,
        'calls', trend.calls
      )
      order by trend.day
    ), '[]'::jsonb)
    into v_daily
    from (
      select
        day::date as day,
        (
          select count(*)
          from sales_core.activities activity
          where activity.tenant_id = v_tenant_id
            and activity.occurred_at >= day
            and activity.occurred_at < day + interval '1 day'
            and (
              v_view_team
              or activity.actor_staff_id = v_staff_id
            )
        ) as activities,
        (
          select count(*)
          from sales_core.contacts contact
          where contact.tenant_id = v_tenant_id
            and contact.lead_status = 'paid'
            and contact.lead_status_changed_at >= day
            and contact.lead_status_changed_at < day + interval '1 day'
            and (
              v_view_team
              or contact.owner_staff_id = v_staff_id
            )
        ) as paid,
        (
          select count(*)
          from telephony.call_records record
          where record.tenant_id = v_tenant_id
            and record.started_at >= day
            and record.started_at < day + interval '1 day'
            and (
              v_view_team
              or (
                cardinality(v_extensions) > 0
                and record.involved_extensions && v_extensions
              )
            )
        ) as calls
      from generate_series(
        date_trunc('day', now()) - interval '6 days',
        date_trunc('day', now()),
        interval '1 day'
      ) day
    ) trend;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'name', coalesce(v_staff_name, 'مستخدم ماركتون'),
      'jobTitle', v_job_title,
      'roleKey', v_role_key,
      'roleLabel', v_role_label,
      'viewTeam', v_view_team,
      'mappedExtensions', to_jsonb(v_extensions)
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
$$;

revoke all on function public.v2_tenant_yeastar_staff_options(text)
from public, anon;
revoke all on function public.v2_tenant_yeastar_save_with_assignments(
  text,
  jsonb
) from public, anon;
revoke all on function public.v2_tenant_role_dashboard_snapshot(text)
from public, anon;

grant execute on function public.v2_tenant_yeastar_staff_options(text)
to authenticated;
grant execute on function public.v2_tenant_yeastar_save_with_assignments(
  text,
  jsonb
) to authenticated;
grant execute on function public.v2_tenant_role_dashboard_snapshot(text)
to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot(text) is
  'Returns role-aware employee and team KPIs with server-side tenant scope.';
comment on function public.v2_tenant_yeastar_save_with_assignments(
  text,
  jsonb
) is
  'Atomically saves encrypted Yeastar settings and validates extension-to-staff mappings.';

commit;
