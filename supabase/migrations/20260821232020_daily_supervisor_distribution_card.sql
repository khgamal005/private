begin;

create or replace function public.v1_tenant_lead_reassignment_snapshot(
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
  v_timezone text;
  v_staff_id uuid;
  v_view_team boolean;
  v_is_data_officer boolean;
  v_can_reassign boolean;
  v_today date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_active_assignments jsonb := '[]'::jsonb;
  v_daily_distribution_total bigint := 0;
  v_daily_distribution_task_ids jsonb := '[]'::jsonb;
  v_daily_distribution_by_staff jsonb := '[]'::jsonb;
  v_daily_distribution_items jsonb := '[]'::jsonb;
begin
  select tenant.id, tenant.timezone
  into v_tenant_id, v_timezone
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  -- This snapshot is consumed by both the CRM workspace and lead-intake
  -- workspace. A sales user can legitimately read CRM data without having
  -- the broader lead-distribution permission.
  if not (
    private_app.has_tenant_permission(v_tenant_id, 'tenant.leads.read')
    or private_app.has_tenant_permission(v_tenant_id, 'tenant.crm.read')
  ) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_today := (now() at time zone v_timezone)::date;
  v_day_start := v_today::timestamp at time zone v_timezone;
  v_day_end := (v_today + 1)::timestamp at time zone v_timezone;

  select exists (
    select 1
    from access_control.subjects subject
    join access_control.memberships membership
      on membership.subject_id = subject.id
     and membership.tenant_id = v_tenant_id
     and membership.scope = 'tenant'
     and membership.status = 'active'
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.roles role
      on role.id = membership_role.role_id
     and role.scope = 'tenant'
     and role.role_key = 'data_officer'
    where subject.auth_user_id = auth.uid()
      and subject.status = 'active'
      and not subject.must_change_password
  ) into v_is_data_officer;

  v_can_reassign := private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.leads.reassign'
  );

  if v_can_reassign then
    select coalesce(jsonb_agg(jsonb_build_object(
      'assignmentId', assignment.id,
      'contactId', assignment.contact_id,
      'assignedStaffId', assignment.assigned_staff_id
    ) order by assignment.assigned_at desc, assignment.id), '[]'::jsonb)
    into v_active_assignments
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant_id
      and assignment.status = 'active';
  end if;

  -- Count every customer distributed today, whether automatically or
  -- manually. Team totals de-duplicate a customer reassigned on the same
  -- day, while per-staff totals preserve each employee's received list.
  with scoped_assignments as materialized (
    select
      assignment.id,
      assignment.contact_id,
      assignment.assigned_staff_id,
      assignment.task_id,
      assignment.assignment_strategy,
      assignment.assigned_at
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant_id
      and assignment.status = 'active'
      and assignment.assigned_at >= v_day_start
      and assignment.assigned_at < v_day_end
      and (
        v_view_team
        or assignment.assigned_staff_id = v_staff_id
      )
  ),
  team_latest as (
    select distinct on (assignment.contact_id)
      assignment.*
    from scoped_assignments assignment
    order by
      assignment.contact_id,
      assignment.assigned_at desc,
      assignment.id desc
  ),
  staff_latest as (
    select distinct on (
      assignment.assigned_staff_id,
      assignment.contact_id
    )
      assignment.*
    from scoped_assignments assignment
    where assignment.assigned_staff_id is not null
    order by
      assignment.assigned_staff_id,
      assignment.contact_id,
      assignment.assigned_at desc,
      assignment.id desc
  ),
  staff_totals as (
    select
      assignment.assigned_staff_id,
      count(*)::integer as customer_count,
      coalesce(jsonb_agg(
        assignment.task_id
        order by assignment.assigned_at desc, assignment.id
      ) filter (
        where assignment.task_id is not null
      ), '[]'::jsonb) as task_ids
    from staff_latest assignment
    group by assignment.assigned_staff_id
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
        'staffId', staff_distribution.assigned_staff_id,
        'count', staff_distribution.customer_count,
        'taskIds', staff_distribution.task_ids
      ) order by staff_distribution.assigned_staff_id)
      from staff_totals staff_distribution
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
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
        'opportunityId', task.opportunity_id,
        'opportunityTitle', opportunity.title,
        'startsAt', task.starts_at,
        'dueAt', task.due_at,
        'completedAt', task.completed_at,
        'completionTiming', task.completion_timing,
        'demo', coalesce((task.metadata ->> 'demo')::boolean, false),
        'createdAt', task.created_at,
        'taskSource', 'lead_assignment',
        'distributedAt', assignment.assigned_at,
        'distributionStrategy', assignment.assignment_strategy
      ) order by assignment.assigned_at desc, assignment.id)
      from staff_latest assignment
      join work_core.tasks task on task.id = assignment.task_id
      left join people.staff_profiles assignee
        on assignee.id = assignment.assigned_staff_id
      left join sales_core.contacts contact
        on contact.id = assignment.contact_id
      left join sales_core.opportunities opportunity
        on opportunity.id = task.opportunity_id
    ), '[]'::jsonb)
  into
    v_daily_distribution_total,
    v_daily_distribution_task_ids,
    v_daily_distribution_by_staff,
    v_daily_distribution_items;

  return jsonb_build_object(
    'schemaVersion', 'lead-reassignment-v1',
    'viewer', jsonb_build_object(
      'isDataOfficer', v_is_data_officer,
      'canReassign', v_can_reassign
    ),
    'activeAssignments', v_active_assignments,
    'dailyLeadDistribution', jsonb_build_object(
      'date', v_today,
      'timezone', v_timezone,
      'total', v_daily_distribution_total,
      'taskIds', v_daily_distribution_task_ids,
      'byStaff', v_daily_distribution_by_staff,
      'items', v_daily_distribution_items
    )
  );
end;
$$;

revoke all on function public.v1_tenant_lead_reassignment_snapshot(text)
from public, anon, authenticated;

grant execute on function public.v1_tenant_lead_reassignment_snapshot(text)
to authenticated, service_role;

comment on function public.v1_tenant_lead_reassignment_snapshot(text) is
'Returns reassignment capability, permission-scoped active references, and today''s distinct automatically or manually distributed customers with their original assignment tasks.';

notify pgrst, 'reload schema';

commit;
