-- Sales-team ownership and employee achievement board.
begin;

alter table people.staff_profiles
  add column if not exists supervisor_staff_id uuid;

do $$
begin
  alter table people.staff_profiles
    add constraint staff_profiles_supervisor_staff_fk
    foreign key (supervisor_staff_id)
    references people.staff_profiles(id)
    on delete set null;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter table people.staff_profiles
    add constraint staff_profiles_supervisor_not_self_chk
    check (supervisor_staff_id is null or supervisor_staff_id <> id);
exception
  when duplicate_object then null;
end;
$$;

create index if not exists staff_profiles_supervisor_staff_idx
  on people.staff_profiles(tenant_id, supervisor_staff_id)
  where supervisor_staff_id is not null;

create or replace function public.v2_tenant_sales_team_snapshot(
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
  v_can_manage boolean := false;
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
    'tenant.people.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_can_manage := private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.people.manage'
  );

  return jsonb_build_object(
    'generatedAt', now(),
    'canManage', v_can_manage,
    'supervisors', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', supervisor.id,
          'name', supervisor.full_name,
          'jobTitle', supervisor.job_title,
          'roleKey', supervisor.role_key,
          'memberCount', (
            select count(*)
            from people.staff_profiles member
            where member.tenant_id = v_tenant_id
              and member.supervisor_staff_id = supervisor.id
              and member.role_key = 'sales_user'
              and member.employment_status = 'active'
          )
        )
        order by
          case supervisor.role_key
            when 'sales_manager' then 0
            else 1
          end,
          supervisor.full_name
      )
      from people.staff_profiles supervisor
      where supervisor.tenant_id = v_tenant_id
        and supervisor.employment_status = 'active'
        and supervisor.role_key in ('sales_manager', 'sales_supervisor')
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', member.id,
          'name', member.full_name,
          'jobTitle', member.job_title,
          'roleKey', member.role_key,
          'supervisorStaffId', member.supervisor_staff_id,
          'supervisorName', supervisor.full_name
        )
        order by member.full_name
      )
      from people.staff_profiles member
      left join people.staff_profiles supervisor
        on supervisor.id = member.supervisor_staff_id
       and supervisor.tenant_id = member.tenant_id
      where member.tenant_id = v_tenant_id
        and member.employment_status = 'active'
        and member.role_key = 'sales_user'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_assign_sales_team_member(
  p_tenant_slug text,
  p_staff_id uuid,
  p_supervisor_staff_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_member people.staff_profiles%rowtype;
  v_supervisor people.staff_profiles%rowtype;
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
    'tenant.people.manage'
  ) then
    raise exception 'forbidden';
  end if;

  select staff.*
  into v_member
  from people.staff_profiles staff
  where staff.id = p_staff_id
    and staff.tenant_id = v_tenant_id
  for update;

  if v_member.id is null then
    raise exception 'staff_not_found';
  end if;
  if v_member.role_key <> 'sales_user' then
    raise exception 'invalid_sales_team_member';
  end if;

  if p_supervisor_staff_id is not null then
    select staff.*
    into v_supervisor
    from people.staff_profiles staff
    where staff.id = p_supervisor_staff_id
      and staff.tenant_id = v_tenant_id
      and staff.employment_status = 'active'
      and staff.role_key in ('sales_manager', 'sales_supervisor')
    limit 1;

    if v_supervisor.id is null then
      raise exception 'invalid_sales_supervisor';
    end if;
  end if;

  update people.staff_profiles
  set supervisor_staff_id = p_supervisor_staff_id
  where id = v_member.id;

  perform private_app.write_audit(
    'tenant.sales_team_member_assigned',
    'staff_profile',
    v_member.id::text,
    v_tenant_id,
    jsonb_build_object(
      'staffName', v_member.full_name,
      'supervisorStaffId', p_supervisor_staff_id,
      'supervisorName', v_supervisor.full_name
    )
  );

  return jsonb_build_object(
    'staffId', v_member.id,
    'staffName', v_member.full_name,
    'supervisorStaffId', p_supervisor_staff_id,
    'supervisorName', v_supervisor.full_name
  );
end;
$$;

create or replace function public.v2_tenant_employee_achievement_snapshot(
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
  v_supervisor_id uuid;
  v_supervisor_name text;
  v_subject_id uuid;
  v_month_start timestamptz := date_trunc('month', now());
  v_customers integer := 0;
  v_active_customers integer := 0;
  v_paid_customers integer := 0;
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
  v_managed_team_size integer := 0;
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
      and staff.tenant_id = v_tenant_id
    limit 1;
  else
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
    where membership.tenant_id = v_tenant_id
      and membership.subject_id = v_subject_id
      and membership.status = 'active'
      and role.scope = 'tenant'
    order by private_app.tenant_role_rank(role.role_key) desc
    limit 1;
  end if;

  v_role_key := coalesce(v_role_key, 'tenant_user');
  v_staff_name := coalesce(v_staff_name, 'مستخدم ماركتون');
  v_job_title := coalesce(v_job_title, 'مستخدم المنشأة');

  if v_staff_id is not null then
    select
      count(*) filter (
        where task.status <> 'completed'
          and task.due_at >= date_trunc('day', now())
          and task.due_at < date_trunc('day', now()) + interval '1 day'
      ),
      count(*) filter (where task.status <> 'completed'),
      count(*) filter (
        where task.status <> 'completed'
          and task.due_at < now()
      ),
      count(*) filter (
        where task.status = 'completed'
          and task.completed_at >= v_month_start
      )
    into
      v_tasks_today,
      v_open_tasks,
      v_overdue_tasks,
      v_completed_this_month
    from work_core.tasks task
    where task.tenant_id = v_tenant_id
      and task.assigned_staff_id = v_staff_id;

    select count(*)
    into v_activities_today
    from sales_core.activities activity
    where activity.tenant_id = v_tenant_id
      and activity.actor_staff_id = v_staff_id
      and activity.occurred_at >= date_trunc('day', now());
  end if;

  if v_staff_id is not null
     and v_role_key in ('sales_user', 'sales_supervisor', 'sales_manager') then
    select
      count(*),
      count(*) filter (
        where contact.lead_status not in ('paid', 'unqualified', 'lost')
      ),
      count(*) filter (
        where contact.lead_status = 'paid'
          and contact.lead_status_changed_at >= v_month_start
      )
    into v_customers, v_active_customers, v_paid_customers
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant_id
      and contact.owner_staff_id = v_staff_id;

    select
      count(*),
      coalesce(sum(opportunity.value_minor), 0)
    into v_open_opportunities, v_open_opportunity_value_minor
    from sales_core.opportunities opportunity
    where opportunity.tenant_id = v_tenant_id
      and opportunity.owner_staff_id = v_staff_id
      and opportunity.status = 'open';

    select coalesce(
      (
        select sum(event.revenue_amount)
        from incentives_core.events event
        where event.tenant_id = v_tenant_id
          and event.staff_id = v_staff_id
          and event.occurred_at >= v_month_start
          and event.state <> 'cancelled'
      ),
      (
        select sum(opportunity.value_minor) / 100.0
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant_id
          and opportunity.owner_staff_id = v_staff_id
          and opportunity.status = 'won'
          and opportunity.updated_at >= v_month_start
      ),
      0
    )
    into v_sales_this_month;

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
      ), 0)
    into v_due_incentive, v_expected_incentive, v_paid_incentive
    from incentives_core.events event
    where event.tenant_id = v_tenant_id
      and event.staff_id = v_staff_id;

    select assignment.target_value, plan.metric_type
    into v_target_value, v_target_metric_type
    from incentives_core.assignments assignment
    join incentives_core.plans plan
      on plan.id = assignment.plan_id
     and plan.tenant_id = assignment.tenant_id
    where assignment.tenant_id = v_tenant_id
      and assignment.staff_id = v_staff_id
      and assignment.active
      and plan.status = 'active'
      and current_date between plan.period_start and plan.period_end
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
        where activity.tenant_id = v_tenant_id
          and activity.actor_staff_id = v_staff_id
          and activity.occurred_at >= v_month_start
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
    with peer_stats as (
      select
        peer.id,
        coalesce(
          (
            select sum(event.revenue_amount)
            from incentives_core.events event
            where event.tenant_id = v_tenant_id
              and event.staff_id = peer.id
              and event.occurred_at >= v_month_start
              and event.state <> 'cancelled'
          ),
          (
            select sum(opportunity.value_minor) / 100.0
            from sales_core.opportunities opportunity
            where opportunity.tenant_id = v_tenant_id
              and opportunity.owner_staff_id = peer.id
              and opportunity.status = 'won'
              and opportunity.updated_at >= v_month_start
          ),
          0
        ) as sales_amount
      from people.staff_profiles peer
      where peer.tenant_id = v_tenant_id
        and peer.supervisor_staff_id = v_supervisor_id
        and peer.role_key = 'sales_user'
        and peer.employment_status = 'active'
    ), ranked as (
      select
        peer_stats.id,
        dense_rank() over (
          order by peer_stats.sales_amount desc
        )::integer as sales_rank,
        count(*) over ()::integer as team_size
      from peer_stats
    )
    select ranked.sales_rank, ranked.team_size
    into v_rank, v_team_size
    from ranked
    where ranked.id = v_staff_id;
  elsif v_role_key = 'sales_supervisor' and v_staff_id is not null then
    select count(*)
    into v_managed_team_size
    from people.staff_profiles member
    where member.tenant_id = v_tenant_id
      and member.supervisor_staff_id = v_staff_id
      and member.role_key = 'sales_user'
      and member.employment_status = 'active';
    v_team_size := v_managed_team_size;
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
$$;

revoke all on function public.v2_tenant_sales_team_snapshot(text)
from public, anon;
revoke all on function public.v2_tenant_assign_sales_team_member(
  text,
  uuid,
  uuid
) from public, anon;
revoke all on function public.v2_tenant_employee_achievement_snapshot(text)
from public, anon;

grant execute on function public.v2_tenant_sales_team_snapshot(text)
to authenticated;
grant execute on function public.v2_tenant_assign_sales_team_member(
  text,
  uuid,
  uuid
) to authenticated;
grant execute on function public.v2_tenant_employee_achievement_snapshot(text)
to authenticated;

comment on column people.staff_profiles.supervisor_staff_id is
  'Direct sales-team supervisor used for dashboards, ranking, and reporting scope.';
comment on function public.v2_tenant_sales_team_snapshot(text) is
  'Returns sales supervisors and direct sales-team assignments for the tenant team screen.';
comment on function public.v2_tenant_assign_sales_team_member(text, uuid, uuid) is
  'Assigns or removes a direct supervisor for an active sales representative.';
comment on function public.v2_tenant_employee_achievement_snapshot(text) is
  'Returns personal employee achievements and sales rank within the assigned direct team.';

commit;
