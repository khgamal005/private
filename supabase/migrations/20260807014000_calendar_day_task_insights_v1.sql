-- Verified daily task intelligence for the calendar, including Yeastar talk
-- time linked to completed customer tasks. Each call is attributed once.
begin;

create or replace function public.v5_tenant_calendar_day_snapshot(
  p_tenant_slug text,
  p_day date,
  p_task_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_current_staff_id uuid;
  v_subject_id uuid;
  v_role_key text;
  v_is_platform boolean := false;
  v_view_all boolean := false;
  v_can_crm boolean := false;
  v_addon_enabled boolean := false;
  v_yeastar_available boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_assignment_map jsonb := '{}'::jsonb;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_today date;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if p_day is null then
    raise exception 'invalid_calendar_day';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.work.read'
  ) and not private_app.has_platform_permission(
    'platform.tenants.read'
  ) then
    raise exception 'forbidden';
  end if;
  if coalesce(cardinality(p_task_ids), 0) > 500 then
    raise exception 'too_many_calendar_tasks';
  end if;

  v_today := (now() at time zone v_tenant.timezone)::date;
  if p_day < v_today - 366 or p_day > v_today + 366 then
    raise exception 'invalid_calendar_day';
  end if;

  v_day_start := p_day::timestamp at time zone v_tenant.timezone;
  v_day_end := (p_day + 1)::timestamp at time zone v_tenant.timezone;
  v_current_staff_id := private_app.current_staff_id(v_tenant.id);
  v_subject_id := private_app.current_subject_id();
  v_is_platform := (
    private_app.has_platform_permission('platform.tenants.read')
    or private_app.has_platform_permission('platform.control.read')
  );
  v_can_crm := (
    v_is_platform
    or private_app.has_tenant_permission(v_tenant.id, 'tenant.crm.read')
  );

  select staff.role_key
  into v_role_key
  from people.staff_profiles staff
  where staff.id = v_current_staff_id
    and staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
  limit 1;

  if v_role_key is null then
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
  v_view_all := (
    v_is_platform
    or v_role_key in (
      'tenant_owner',
      'tenant_admin',
      'executive_manager',
      'sales_manager'
    )
  );
  v_scope_staff_ids := private_app.v2_metric_staff_scope(
    v_tenant.id,
    v_current_staff_id,
    v_role_key,
    v_is_platform
  );

  v_addon_enabled :=
    private_app.tenant_yeastar_addon_enabled(v_tenant.id);
  if v_addon_enabled then
    select connection.*
    into v_connection
    from communication_hub.provider_connections connection
    where connection.tenant_id = v_tenant.id
      and connection.provider_key = 'yeastar_p550'
    limit 1;
  end if;
  v_assignment_map := coalesce(
    v_connection.public_config -> 'extensionAssignments',
    '{}'::jsonb
  );
  if jsonb_typeof(v_assignment_map) <> 'object' then
    v_assignment_map := '{}'::jsonb;
  end if;
  v_yeastar_available := (
    v_can_crm
    and v_addon_enabled
    and v_connection.id is not null
    and v_connection.status in ('active', 'degraded')
  );

  return (
    with visible_tasks as materialized (
      select
        task.id,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.assigned_staff_id,
        assignee.full_name as assignee_name,
        task.contact_id,
        contact.full_name as contact_name,
        case when v_can_crm then contact.phone end as contact_phone,
        contact.lead_status as contact_status,
        contact.lead_quality as contact_quality,
        course.title_ar as contact_course_name,
        coalesce(
          private_app.normalize_lead_phone(contact.phone),
          private_app.normalize_lead_phone(contact.whatsapp)
        ) as contact_phone_key,
        task.due_at,
        task.completed_at,
        task.completion_timing
      from work_core.tasks task
      left join people.staff_profiles assignee
        on assignee.id = task.assigned_staff_id
       and assignee.tenant_id = task.tenant_id
      left join sales_core.contacts contact
        on contact.id = task.contact_id
       and contact.tenant_id = task.tenant_id
      left join academy.courses course
        on course.id = contact.interest_course_id
       and course.tenant_id = contact.tenant_id
      where task.tenant_id = v_tenant.id
        and task.due_at >= v_day_start
        and task.due_at < v_day_end
        and (
          p_task_ids is null
          or task.id = any(p_task_ids)
        )
        and (
          v_view_all
          or task.assigned_staff_id = any(v_scope_staff_ids)
          or task.created_by_subject_id = v_subject_id
        )
    ),
    extension_values as materialized (
      select
        mapping.key as extension,
        case
          when mapping.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then mapping.value::uuid
          else null
        end as staff_id
      from jsonb_each_text(v_assignment_map) mapping
      where mapping.key ~ '^[0-9]{1,10}$'
    ),
    staff_extensions as materialized (
      select distinct extension.extension, extension.staff_id
      from extension_values extension
      where extension.staff_id is not null
        and (
          v_view_all
          or extension.staff_id = any(v_scope_staff_ids)
        )
    ),
    mapped_calls as materialized (
      select distinct
        record.id,
        record.started_at,
        record.final_status,
        record.handling_duration_seconds,
        assignment.staff_id,
        private_app.normalize_lead_phone(
          case
            when record.call_type = 'Outbound' then record.callee_number
            when record.call_type = 'Inbound' then record.caller_number
            else null
          end
        ) as external_phone_key
      from telephony.call_records record
      join staff_extensions assignment
        on assignment.extension = any(record.involved_extensions)
      where v_yeastar_available
        and record.tenant_id = v_tenant.id
        and record.started_at >= v_day_start
        and record.started_at < v_day_end
        and record.call_type in ('Inbound', 'Outbound')
    ),
    candidate_matches as materialized (
      select
        call.id,
        call.started_at,
        call.final_status,
        call.handling_duration_seconds,
        task.id as task_id,
        row_number() over (
          partition by call.id
          order by
            least(
              abs(extract(epoch from call.started_at - task.due_at)),
              abs(extract(epoch from call.started_at - coalesce(
                task.completed_at,
                task.due_at
              )))
            ),
            task.id
        ) as task_rank
      from mapped_calls call
      join visible_tasks task
        on task.assigned_staff_id = call.staff_id
       and task.contact_phone_key = call.external_phone_key
      where call.external_phone_key is not null
        and call.final_status = 'ANSWERED'
        and task.status = 'completed'
        and task.contact_id is not null
    ),
    linked_calls as materialized (
      select match.*
      from candidate_matches match
      where match.task_rank = 1
    ),
    task_call_totals as materialized (
      select
        call.task_id,
        count(distinct call.id) as answered_calls,
        coalesce(sum(call.handling_duration_seconds), 0) as talk_seconds
      from linked_calls call
      group by call.task_id
    ),
    completed_call_totals as materialized (
      select
        count(distinct call.id) as matched_calls,
        count(distinct call.task_id) as matched_tasks,
        coalesce(sum(call.handling_duration_seconds), 0) as talk_seconds
      from linked_calls call
      join visible_tasks task on task.id = call.task_id
      where task.status = 'completed'
    ),
    task_summary as materialized (
      select
        count(*) filter (where task.status <> 'cancelled') as total_tasks,
        count(*) filter (where task.status = 'completed') as completed_tasks,
        count(*) filter (
          where private_app.v2_metric_is_open_task(task.status)
        ) as open_tasks,
        count(*) filter (where task.status = 'in_progress')
          as in_progress_tasks,
        count(*) filter (
          where private_app.v2_metric_is_open_task(task.status)
            and task.due_at < now()
        ) as overdue_tasks,
        count(*) filter (
          where task.status = 'completed'
            and task.completion_timing = 'on_time'
        ) as on_time_tasks,
        count(*) filter (
          where task.status = 'completed'
            and task.completion_timing = 'late'
        ) as late_tasks,
        count(*) filter (
          where task.contact_id is not null
            and task.status <> 'cancelled'
        ) as customer_tasks,
        count(*) filter (
          where task.contact_id is not null
            and task.status = 'completed'
        ) as completed_customer_tasks
      from visible_tasks task
    )
    select jsonb_build_object(
      'generatedAt', now(),
      'day', p_day,
      'timezone', v_tenant.timezone,
      'viewer', jsonb_build_object(
        'staffId', v_current_staff_id,
        'roleKey', v_role_key,
        'viewAll', v_view_all
      ),
      'summary', (
        select jsonb_build_object(
          'totalTasks', summary.total_tasks,
          'completedTasks', summary.completed_tasks,
          'openTasks', summary.open_tasks,
          'inProgressTasks', summary.in_progress_tasks,
          'overdueTasks', summary.overdue_tasks,
          'onTimeTasks', summary.on_time_tasks,
          'lateTasks', summary.late_tasks,
          'customerTasks', summary.customer_tasks,
          'completedCustomerTasks', summary.completed_customer_tasks,
          'completionRate', case
            when summary.total_tasks > 0 then round(
              100.0 * summary.completed_tasks / summary.total_tasks,
              1
            )
            else 0
          end,
          'customerCompletionRate', case
            when summary.customer_tasks > 0 then round(
              100.0 * summary.completed_customer_tasks
                / summary.customer_tasks,
              1
            )
            else 0
          end
        )
        from task_summary summary
      ),
      'yeastar', (
        select jsonb_build_object(
          'status', case
            when not v_can_crm then 'crm_permission_required'
            when not v_addon_enabled then 'addon_not_enabled'
            when v_connection.id is null then 'not_configured'
            when v_connection.status = 'disabled' then 'not_configured'
            when v_connection.status not in ('active', 'degraded')
              then 'sync_unavailable'
            when v_connection.status = 'degraded' then 'degraded'
            else 'ready'
          end,
          'enabled', v_addon_enabled,
          'configured', v_connection.id is not null,
          'available', v_yeastar_available,
          'matchedCalls', calls.matched_calls,
          'matchedCompletedTasks', calls.matched_tasks,
          'talkSeconds', calls.talk_seconds,
          'coverageRate', case
            when summary.completed_customer_tasks > 0 then round(
              100.0 * calls.matched_tasks
                / summary.completed_customer_tasks,
              1
            )
            else 0
          end,
          'lastSyncAt', (
            select run.finished_at
            from telephony.sync_runs run
            where run.tenant_id = v_tenant.id
              and run.provider_connection_id = v_connection.id
            order by run.started_at desc
            limit 1
          )
        )
        from completed_call_totals calls
        cross join task_summary summary
      ),
      'tasks', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', task.id,
            'title', task.title,
            'description', task.description,
            'status', task.status,
            'priority', task.priority,
            'assignedStaffId', task.assigned_staff_id,
            'assigneeName', task.assignee_name,
            'contactId', task.contact_id,
            'contactName', task.contact_name,
            'contactPhone', task.contact_phone,
            'contactStatus', task.contact_status,
            'contactQuality', task.contact_quality,
            'contactCourseName', task.contact_course_name,
            'dueAt', task.due_at,
            'completedAt', task.completed_at,
            'completionTiming', task.completion_timing,
            'yeastarAnsweredCalls', coalesce(calls.answered_calls, 0),
            'yeastarTalkSeconds', coalesce(calls.talk_seconds, 0)
          )
          order by
            case task.status
              when 'in_progress' then 1
              when 'todo' then 2
              when 'completed' then 3
              else 4
            end,
            task.due_at,
            task.id
        )
        from visible_tasks task
        left join task_call_totals calls on calls.task_id = task.id
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.v5_tenant_calendar_day_snapshot(
  text,
  date,
  uuid[]
) from public, anon;

grant execute on function public.v5_tenant_calendar_day_snapshot(
  text,
  date,
  uuid[]
) to authenticated;

comment on function public.v5_tenant_calendar_day_snapshot(
  text,
  date,
  uuid[]
) is
  'Returns permission-scoped daily tasks and de-duplicated Yeastar talk time attributed to completed tasks by staff extension, normalized customer phone, and nearest task activity time.';

notify pgrst, 'reload schema';

commit;
