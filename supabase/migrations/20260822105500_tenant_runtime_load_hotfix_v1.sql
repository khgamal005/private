begin;

select pg_advisory_xact_lock(
  hashtextextended('tenant-runtime-load-hotfix-v1',31604)
);

-- Avoid scanning the timezone catalog view for every overdue check.
CREATE OR REPLACE FUNCTION private_app.task_day_is_overdue_v1(p_tenant_id uuid, p_due_at timestamp with time zone, p_as_of timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (
      p_due_at at time zone coalesce(nullif(tenant.timezone, ''), 'UTC')
    )::date < (
      p_as_of at time zone coalesce(nullif(tenant.timezone, ''), 'UTC')
    )::date,
    false
  )
  from core.tenants tenant
  where tenant.id = p_tenant_id
  limit 1;
$function$;

comment on function private_app.task_day_is_overdue_v1(
  uuid,timestamptz,timestamptz
) is 'Returns true only after the tenant-local due date has ended.';

revoke all on function private_app.task_day_is_overdue_v1(
  uuid,timestamptz,timestamptz
) from public,anon,authenticated;

-- Keep the tenant shell lightweight and independent from the legacy v1 wrapper.
CREATE OR REPLACE FUNCTION public.v2_tenant_dashboard_live_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_subject_id uuid;
  v_view_team boolean := false;
  v_can_read_crm boolean := false;
  v_can_read_work boolean := false;
  v_can_read_admissions boolean := false;
  v_timezone text := 'UTC';
  v_today date;
  v_today_from timestamptz;
  v_tomorrow_from timestamptz;
  v_open_tasks bigint := 0;
  v_overdue_tasks bigint := 0;
  v_completed_tasks bigint := 0;
  v_tasks_today bigint := 0;
  v_active_leads bigint := 0;
  v_activities_today bigint := 0;
  v_pending_admissions bigint := 0;
  v_tasks jsonb := '[]'::jsonb;
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
  v_subject_id := private_app.current_subject_id();
  v_view_team := coalesce(
    private_app.can_view_tenant_team(v_tenant.id),
    false
  );
  v_can_read_crm := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.crm.read'
  );
  v_can_read_work := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.work.read'
  );
  v_can_read_admissions := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.admissions.read'
  );
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_today_from := v_today::timestamp at time zone v_timezone;
  v_tomorrow_from := (v_today + 1)::timestamp at time zone v_timezone;

  if v_can_read_work then
    select
      count(*) filter (where task.status in ('todo', 'in_progress')),
      count(*) filter (
        where task.status in ('todo', 'in_progress')
          and (
            (
              private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < v_today_from
            )
            or (
              not private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < now()
            )
          )
      ),
      count(*) filter (where task.status = 'completed'),
      count(*) filter (
        where task.status in ('todo', 'in_progress')
          and task.due_at >= v_today_from
          and task.due_at < v_tomorrow_from
      )
    into
      v_open_tasks,
      v_overdue_tasks,
      v_completed_tasks,
      v_tasks_today
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and (
        v_view_team
        or task.assigned_staff_id = v_staff_id
        or task.created_by_subject_id = v_subject_id
      );

    select coalesce(
      jsonb_agg(
        item.payload
        order by item.due_at nulls last, item.created_at desc, item.id
      ),
      '[]'::jsonb
    )
    into v_tasks
    from (
      select
        task.id,
        task.due_at,
        task.created_at,
        jsonb_build_object(
          'id', task.id,
          'title', task.title,
          'status', task.status,
          'priority', task.priority,
          'assignedStaffId', task.assigned_staff_id,
          'assigneeName', assignee.full_name,
          'contactId', task.contact_id,
          'contactName', contact.full_name,
          'contactCourseName', course.title_ar,
          'startsAt', task.starts_at,
          'dueAt', task.due_at,
          'taskSource', coalesce(task.metadata ->> 'source', 'manual')
        ) as payload
      from work_core.tasks task
      left join people.staff_profiles assignee
        on assignee.id = task.assigned_staff_id
       and assignee.tenant_id = v_tenant.id
      left join sales_core.contacts contact
        on contact.id = task.contact_id
       and contact.tenant_id = v_tenant.id
      left join academy.courses course
        on course.id = contact.interest_course_id
       and course.tenant_id = v_tenant.id
      where task.tenant_id = v_tenant.id
        and task.status in ('todo', 'in_progress')
        and (
          v_view_team
          or task.assigned_staff_id = v_staff_id
          or task.created_by_subject_id = v_subject_id
        )
      order by task.due_at nulls last, task.created_at desc, task.id
      limit 6
    ) item;
  end if;

  if v_can_read_crm then
    select count(*)
    into v_active_leads
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and private_app.v2_metric_is_active_contact(
        contact.status,
        contact.lead_status
      )
      and (v_view_team or contact.owner_staff_id = v_staff_id);

    select count(*)
    into v_activities_today
    from sales_core.activities activity
    left join sales_core.opportunities opportunity
      on opportunity.id = activity.opportunity_id
     and opportunity.tenant_id = v_tenant.id
    left join sales_core.contacts contact
      on contact.id = activity.contact_id
     and contact.tenant_id = v_tenant.id
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_today_from
      and activity.occurred_at < v_tomorrow_from
      and (
        v_view_team
        or activity.actor_staff_id = v_staff_id
        or opportunity.owner_staff_id = v_staff_id
        or contact.owner_staff_id = v_staff_id
      );
  end if;

  if v_can_read_admissions and v_view_team then
    select count(*)
    into v_pending_admissions
    from academy.registration_handoffs handoff
    where handoff.tenant_id = v_tenant.id
      and handoff.status in ('pending', 'in_review');
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'timezone', v_timezone
    ),
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'viewTeam', v_view_team,
      'canReadCrm', v_can_read_crm,
      'canReadWork', v_can_read_work,
      'canReadAdmissions', v_can_read_admissions
    ),
    'summary', jsonb_build_object(
      'tasksToday', v_tasks_today,
      'openTasks', v_open_tasks,
      'overdueTasks', v_overdue_tasks,
      'completedTasks', v_completed_tasks,
      'activitiesToday', v_activities_today,
      'activeLeads', v_active_leads,
      'pendingAdmissions', v_pending_admissions
    ),
    'tasks', v_tasks
  );
end;
$function$;

comment on function public.v2_tenant_dashboard_live_snapshot(text)
is 'Lightweight tenant shell/dashboard snapshot without scanning the timezone catalog view; customer follow-up lateness starts on the next tenant-local day.';

revoke all on function public.v2_tenant_dashboard_live_snapshot(text)
from public,anon;
grant execute on function public.v2_tenant_dashboard_live_snapshot(text)
to authenticated,service_role;

-- Serve the task calendar without materializing the full operations and CRM workspaces.
CREATE OR REPLACE FUNCTION public.v1_tenant_task_calendar_snapshot(p_slug text, p_task_scope text DEFAULT 'all'::text, p_include_sales boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_subject_id uuid;
  v_view_team boolean := false;
  v_can_read_crm boolean := false;
  v_can_write_crm boolean := false;
  v_can_write_work boolean := false;
  v_sales_scope boolean := false;
  v_timezone text := 'UTC';
  v_today date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_tasks jsonb := '[]'::jsonb;
  v_staff jsonb := '[]'::jsonb;
  v_contacts jsonb := '[]'::jsonb;
  v_courses jsonb := '[]'::jsonb;
  v_course_runs jsonb := '[]'::jsonb;
  v_distribution_total bigint := 0;
  v_distribution_task_ids jsonb := '[]'::jsonb;
  v_distribution_by_staff jsonb := '[]'::jsonb;
  v_distribution_items jsonb := '[]'::jsonb;
begin
  if coalesce(p_task_scope, 'all') not in ('all', 'sales') then
    raise exception 'invalid_task_scope';
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
    'tenant.work.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_subject_id := private_app.current_subject_id();
  v_view_team := coalesce(
    private_app.can_view_tenant_team(v_tenant.id),
    false
  );
  v_can_read_crm := p_include_sales and private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.crm.read'
  );
  v_can_write_crm := v_can_read_crm and private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.crm.write'
  );
  v_can_write_work := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.work.write'
  );
  v_sales_scope := coalesce(p_task_scope, 'all') = 'sales';
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_day_start := v_today::timestamp at time zone v_timezone;
  v_day_end := (v_today + 1)::timestamp at time zone v_timezone;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', staff.id,
    'name', staff.full_name,
    'jobTitle', staff.job_title,
    'roleKey', staff.role_key,
    'department', department.name_ar,
    'accountStatus', staff.account_status
  ) order by department.name_ar, staff.full_name), '[]'::jsonb)
  into v_staff
  from people.staff_profiles staff
  left join people.departments department
    on department.id = staff.department_id
   and department.tenant_id = v_tenant.id
  where staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
    and (v_view_team or staff.id = v_staff_id)
    and (
      not v_sales_scope
      or staff.role_key in (
        'sales_user',
        'sales_supervisor',
        'sales_manager'
      )
    );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', course.id,
    'courseCode', course.course_code,
    'nameAr', course.title_ar,
    'status', course.status
  ) order by course.title_ar), '[]'::jsonb)
  into v_courses
  from academy.courses course
  where course.tenant_id = v_tenant.id
    and course.status = 'active';

  if v_can_read_crm then
    with latest_activity as materialized (
      select distinct on (activity.contact_id)
        activity.contact_id,
        activity.summary,
        activity.occurred_at,
        activity.activity_type
      from sales_core.activities activity
      where activity.tenant_id = v_tenant.id
        and activity.contact_id is not null
      order by
        activity.contact_id,
        activity.occurred_at desc,
        activity.id desc
    )
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', contact.id,
      'contactKey', contact.contact_key,
      'name', contact.full_name,
      'phone', contact.phone,
      'whatsapp', contact.whatsapp,
      'email', contact.email,
      'source', contact.source,
      'leadStatus', contact.lead_status,
      'leadQuality', contact.lead_quality,
      'ownerStaffId', contact.owner_staff_id,
      'ownerName', owner.full_name,
      'interestCourseId', contact.interest_course_id,
      'interestCourseName', course.title_ar,
      'notes', contact.notes,
      'nextActionType', contact.next_action_type,
      'nextActionAt', contact.next_action_at,
      'latestNote', coalesce(
        nullif(latest.summary, ''),
        nullif(contact.notes, '')
      ),
      'latestNoteAt', coalesce(
        latest.occurred_at,
        contact.updated_at
      ),
      'latestNoteType', coalesce(
        latest.activity_type,
        case when nullif(contact.notes, '') is not null
          then 'customer_note'
        end
      ),
      'createdAt', contact.created_at,
      'updatedAt', contact.updated_at
    )) order by contact.full_name, contact.id), '[]'::jsonb)
    into v_contacts
    from sales_core.contacts contact
    left join people.staff_profiles owner
      on owner.id = contact.owner_staff_id
     and owner.tenant_id = v_tenant.id
    left join academy.courses course
      on course.id = contact.interest_course_id
     and course.tenant_id = v_tenant.id
    left join latest_activity latest
      on latest.contact_id = contact.id
    where contact.tenant_id = v_tenant.id
      and (v_view_team or contact.owner_staff_id = v_staff_id);

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', run.id,
      'courseId', run.course_id,
      'runCode', run.run_code,
      'title', coalesce(run.title, course.title_ar),
      'startsAt', run.starts_at,
      'endsAt', run.ends_at,
      'status', run.status,
      'capacity', run.capacity,
      'enrolledCount', run.enrolled_count
    ) order by run.starts_at nulls last, run.created_at), '[]'::jsonb)
    into v_course_runs
    from academy.course_runs run
    join academy.courses course
      on course.id = run.course_id
     and course.tenant_id = v_tenant.id
    where run.tenant_id = v_tenant.id
      and run.status in ('planning', 'open', 'in_progress');
  end if;

  with latest_activity as materialized (
    select distinct on (activity.contact_id)
      activity.contact_id,
      activity.summary,
      activity.occurred_at,
      activity.activity_type
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.contact_id is not null
    order by
      activity.contact_id,
      activity.occurred_at desc,
      activity.id desc
  ), scoped_tasks as materialized (
    select
      task.*,
      assignee.full_name as assignee_name,
      assignee.role_key as assignee_role_key,
      contact.full_name as contact_name,
      contact.phone as contact_phone,
      contact.source as contact_source,
      contact.lead_status as contact_status,
      contact.lead_quality as contact_quality,
      contact.next_action_type as contact_next_action_type,
      contact.notes as contact_notes,
      contact.updated_at as contact_updated_at,
      course.title_ar as contact_course_name,
      latest.summary as latest_note,
      latest.occurred_at as latest_note_at,
      latest.activity_type as latest_note_type,
      coalesce(task.metadata ->> 'source', 'manual') as task_source
    from work_core.tasks task
    left join people.staff_profiles assignee
      on assignee.id = task.assigned_staff_id
     and assignee.tenant_id = v_tenant.id
    left join sales_core.contacts contact
      on contact.id = task.contact_id
     and contact.tenant_id = v_tenant.id
    left join academy.courses course
      on course.id = contact.interest_course_id
     and course.tenant_id = v_tenant.id
    left join latest_activity latest
      on latest.contact_id = task.contact_id
    where task.tenant_id = v_tenant.id
      and task.status <> 'cancelled'
      and (
        v_view_team
        or task.assigned_staff_id = v_staff_id
        or task.created_by_subject_id = v_subject_id
      )
      and (
        not v_sales_scope
        or (
          coalesce(task.metadata ->> 'source', '') <> 'registration_handoff'
          and (
            coalesce(task.metadata ->> 'source', '') in (
              'lead_assignment',
              'opportunity_next_action',
              'activity_next_action',
              'lead_next_action',
              'sales_followup'
            )
            or assignee.role_key in (
              'sales_user',
              'sales_supervisor',
              'sales_manager'
            )
          )
        )
      )
      and not (
        task.status = 'completed'
        and task.contact_id is not null
        and coalesce(task.metadata ->> 'source', '') in (
          'lead_assignment',
          'opportunity_next_action',
          'activity_next_action',
          'lead_next_action',
          'sales_followup'
        )
        and exists (
          select 1
          from work_core.tasks current_task
          where current_task.tenant_id = task.tenant_id
            and current_task.contact_id = task.contact_id
            and current_task.id <> task.id
            and current_task.status in ('todo', 'in_progress')
            and coalesce(current_task.metadata ->> 'source', '') in (
              'lead_assignment',
              'opportunity_next_action',
              'activity_next_action',
              'lead_next_action',
              'sales_followup'
            )
        )
      )
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', task.id,
    'taskKey', task.task_key,
    'title', task.title,
    'description', task.description,
    'status', task.status,
    'priority', task.priority,
    'assignedStaffId', task.assigned_staff_id,
    'assigneeName', task.assignee_name,
    'contactId', task.contact_id,
    'contactName', task.contact_name,
    'contactPhone', case when v_can_read_crm then task.contact_phone end,
    'contactStatus', case when v_can_read_crm then task.contact_status end,
    'contactQuality', case when v_can_read_crm then task.contact_quality end,
    'contactCourseName', task.contact_course_name,
    'contactSource', case when v_can_read_crm then task.contact_source end,
    'contactNextActionType', case
      when v_can_read_crm then task.contact_next_action_type
    end,
    'contactLatestNote', case
      when v_can_read_crm then coalesce(
        nullif(task.latest_note, ''),
        nullif(task.contact_notes, '')
      )
    end,
    'contactLatestNoteAt', case
      when v_can_read_crm then coalesce(
        task.latest_note_at,
        task.contact_updated_at
      )
    end,
    'contactLatestNoteType', case
      when v_can_read_crm then coalesce(
        task.latest_note_type,
        case when nullif(task.contact_notes, '') is not null
          then 'customer_note'
        end
      )
    end,
    'opportunityId', task.opportunity_id,
    'startsAt', task.starts_at,
    'dueAt', task.due_at,
    'completedAt', task.completed_at,
    'completionTiming', task.completion_timing,
    'demo', coalesce((task.metadata ->> 'demo')::boolean, false),
    'createdAt', task.created_at,
    'taskSource', task.task_source,
    'calendarCurrent', true
  )) order by task.due_at, task.id), '[]'::jsonb)
  into v_tasks
  from scoped_tasks task;

  if p_include_sales then
    with scoped_assignments as materialized (
      select
        assignment.id,
        assignment.contact_id,
        assignment.assigned_staff_id,
        assignment.task_id,
        assignment.assignment_strategy,
        assignment.assigned_at
      from sales_core.lead_assignments assignment
      where assignment.tenant_id = v_tenant.id
        and assignment.status = 'active'
        and assignment.assigned_at >= v_day_start
        and assignment.assigned_at < v_day_end
        and (
          v_view_team
          or assignment.assigned_staff_id = v_staff_id
        )
    ), team_latest as (
      select distinct on (assignment.contact_id)
        assignment.*
      from scoped_assignments assignment
      order by
        assignment.contact_id,
        assignment.assigned_at desc,
        assignment.id desc
    ), staff_latest as (
      select distinct on (
        assignment.assigned_staff_id,
        assignment.contact_id
      ) assignment.*
      from scoped_assignments assignment
      where assignment.assigned_staff_id is not null
      order by
        assignment.assigned_staff_id,
        assignment.contact_id,
        assignment.assigned_at desc,
        assignment.id desc
    ), staff_totals as (
      select
        assignment.assigned_staff_id,
        count(*)::integer as customer_count,
        coalesce(jsonb_agg(
          assignment.task_id
          order by assignment.assigned_at desc, assignment.id
        ) filter (where assignment.task_id is not null), '[]'::jsonb)
          as task_ids
      from staff_latest assignment
      group by assignment.assigned_staff_id
    ), latest_activity as materialized (
      select distinct on (activity.contact_id)
        activity.contact_id,
        activity.summary,
        activity.occurred_at,
        activity.activity_type
      from sales_core.activities activity
      where activity.tenant_id = v_tenant.id
        and activity.contact_id is not null
      order by
        activity.contact_id,
        activity.occurred_at desc,
        activity.id desc
    )
    select
      (select count(*) from team_latest),
      coalesce((
        select jsonb_agg(
          assignment.task_id
          order by assignment.assigned_at desc, assignment.id
        )
        from team_latest assignment
        where assignment.task_id is not null
      ), '[]'::jsonb),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'staffId', distribution.assigned_staff_id,
          'count', distribution.customer_count,
          'taskIds', distribution.task_ids
        ) order by distribution.assigned_staff_id)
        from staff_totals distribution
      ), '[]'::jsonb),
      coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id', task.id,
          'assignmentId', assignment.id,
          'taskKey', task.task_key,
          'title', task.title,
          'description', task.description,
          'status', task.status,
          'priority', task.priority,
          'assignedStaffId', assignment.assigned_staff_id,
          'assigneeName', assignee.full_name,
          'contactId', assignment.contact_id,
          'contactName', contact.full_name,
          'contactPhone', case when v_can_read_crm then contact.phone end,
          'contactStatus', case when v_can_read_crm then contact.lead_status end,
          'contactQuality', case when v_can_read_crm then contact.lead_quality end,
          'contactCourseName', course.title_ar,
          'contactSource', case when v_can_read_crm then contact.source end,
          'contactNextActionType', case
            when v_can_read_crm then contact.next_action_type
          end,
          'contactLatestNote', case when v_can_read_crm then coalesce(
            nullif(latest.summary, ''),
            nullif(contact.notes, '')
          ) end,
          'contactLatestNoteAt', case when v_can_read_crm then coalesce(
            latest.occurred_at,
            contact.updated_at
          ) end,
          'contactLatestNoteType', case when v_can_read_crm then coalesce(
            latest.activity_type,
            case when nullif(contact.notes, '') is not null
              then 'customer_note'
            end
          ) end,
          'opportunityId', task.opportunity_id,
          'startsAt', task.starts_at,
          'dueAt', task.due_at,
          'completedAt', task.completed_at,
          'completionTiming', task.completion_timing,
          'demo', coalesce((task.metadata ->> 'demo')::boolean, false),
          'createdAt', task.created_at,
          'taskSource', 'lead_assignment',
          'distributedAt', assignment.assigned_at,
          'distributionStrategy', assignment.assignment_strategy
        )) order by assignment.assigned_at desc, assignment.id)
        from staff_latest assignment
        join work_core.tasks task
          on task.id = assignment.task_id
         and task.tenant_id = v_tenant.id
        left join people.staff_profiles assignee
          on assignee.id = assignment.assigned_staff_id
         and assignee.tenant_id = v_tenant.id
        left join sales_core.contacts contact
          on contact.id = assignment.contact_id
         and contact.tenant_id = v_tenant.id
        left join academy.courses course
          on course.id = contact.interest_course_id
         and course.tenant_id = v_tenant.id
        left join latest_activity latest
          on latest.contact_id = assignment.contact_id
      ), '[]'::jsonb)
    into
      v_distribution_total,
      v_distribution_task_ids,
      v_distribution_by_staff,
      v_distribution_items;
  end if;

  return jsonb_build_object(
    'schemaVersion', 'task-calendar-v1',
    'generatedAt', now(),
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'timezone', v_timezone
    ),
    'timezone', v_timezone,
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'viewTeam', v_view_team,
      'canWriteCrm', v_can_write_crm,
      'canWriteWork', v_can_write_work
    ),
    'summary', jsonb_build_object(),
    'staff', v_staff,
    'contacts', v_contacts,
    'courses', v_courses,
    'courseRuns', v_course_runs,
    'tasks', v_tasks,
    'dailyLeadDistribution', jsonb_build_object(
      'date', v_today,
      'timezone', v_timezone,
      'total', v_distribution_total,
      'taskIds', v_distribution_task_ids,
      'byStaff', v_distribution_by_staff,
      'items', v_distribution_items
    )
  );
end;
$function$;

comment on function public.v1_tenant_task_calendar_snapshot(
  text,text,boolean
) is 'Lean calendar workspace payload that avoids loading the complete sales and operations workspaces on every calendar visit.';

revoke all on function public.v1_tenant_task_calendar_snapshot(
  text,text,boolean
) from public,anon;
grant execute on function public.v1_tenant_task_calendar_snapshot(
  text,text,boolean
) to authenticated,service_role;

notify pgrst,'reload schema';

commit;
