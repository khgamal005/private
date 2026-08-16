-- Keep the tenant shell and live task panel independent from the large
-- operational and sales snapshots. This endpoint deliberately returns only
-- counters plus the six nearest open tasks.
begin;

create or replace function public.v1_tenant_dashboard_live_snapshot(
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
  v_staff_id uuid;
  v_subject_id uuid;
  v_view_team boolean;
  v_can_read_crm boolean := false;
  v_can_read_work boolean := false;
  v_can_read_admissions boolean := false;
  v_timezone text;
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
  select coalesce(zone.name, 'UTC')
  into v_timezone
  from (values (1)) seed(value)
  left join pg_catalog.pg_timezone_names zone
    on zone.name = nullif(v_tenant.timezone, '')
  limit 1;
  v_today := (now() at time zone v_timezone)::date;
  v_today_from := v_today::timestamp at time zone v_timezone;
  v_tomorrow_from := (v_today + 1)::timestamp at time zone v_timezone;

  if v_can_read_work then
    select
      count(*) filter (where task.status in ('todo', 'in_progress')),
      count(*) filter (
        where task.status in ('todo', 'in_progress')
          and task.due_at < now()
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
        'dueAt', task.due_at
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
$$;

revoke all on function public.v1_tenant_dashboard_live_snapshot(text)
from public, anon;
grant execute on function public.v1_tenant_dashboard_live_snapshot(text)
to authenticated;

comment on function public.v1_tenant_dashboard_live_snapshot(text) is
  'Bounded live tenant dashboard counters and nearest six open tasks.';

notify pgrst, 'reload schema';

commit;
