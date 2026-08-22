-- Customer follow-up times organize the sales employee's day. A follow-up
-- task only becomes overdue after its tenant-local calendar day has ended.
begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('task-day-overdue-policy-v1', 31604)
);

create or replace function private_app.task_day_is_overdue_v1(
  p_tenant_id uuid,
  p_due_at timestamptz,
  p_as_of timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      p_due_at at time zone coalesce(zone.name, 'UTC')
    )::date < (
      p_as_of at time zone coalesce(zone.name, 'UTC')
    )::date,
    false
  )
  from core.tenants tenant
  left join pg_catalog.pg_timezone_names zone
    on zone.name = nullif(tenant.timezone, '')
  where tenant.id = p_tenant_id
  limit 1;
$$;

revoke all on function private_app.task_day_is_overdue_v1(
  uuid,
  timestamptz,
  timestamptz
) from public, anon, authenticated;

create or replace function private_app.customer_followup_uses_day_policy_v1(
  p_contact_id uuid,
  p_source text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_contact_id is not null
    or coalesce(p_source, '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    );
$$;

revoke all on function private_app.customer_followup_uses_day_policy_v1(
  uuid,
  text
) from public, anon, authenticated;

create or replace function private_app.enforce_task_day_timing_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed'
     and new.completed_at is not null
     and new.due_at is not null
  then
    if private_app.customer_followup_uses_day_policy_v1(
      new.contact_id,
      new.metadata ->> 'source'
    ) then
      new.completion_timing := case
        when private_app.task_day_is_overdue_v1(
          new.tenant_id,
          new.due_at,
          new.completed_at
        ) then 'late'
        else 'on_time'
      end;
    else
      new.completion_timing := case
        when new.completed_at <= new.due_at then 'on_time'
        else 'late'
      end;
    end if;
  else
    new.completion_timing := null;
  end if;

  return new;
end;
$$;

revoke all on function private_app.enforce_task_day_timing_v1()
from public, anon, authenticated;

drop trigger if exists zz_enforce_task_day_timing_before_write
on work_core.tasks;

create trigger zz_enforce_task_day_timing_before_write
before insert or update on work_core.tasks
for each row
execute function private_app.enforce_task_day_timing_v1();

-- Repair only the derived timing flag. No task, customer, or activity row is
-- deleted or duplicated.
update work_core.tasks task
set completion_timing = case
  when private_app.customer_followup_uses_day_policy_v1(
    task.contact_id,
    task.metadata ->> 'source'
  ) and (
      task.completed_at at time zone coalesce(zone.name, 'UTC')
    )::date <= (
      task.due_at at time zone coalesce(zone.name, 'UTC')
    )::date then 'on_time'
  when not private_app.customer_followup_uses_day_policy_v1(
    task.contact_id,
    task.metadata ->> 'source'
  ) and task.completed_at <= task.due_at then 'on_time'
  else 'late'
end
from core.tenants tenant
left join pg_catalog.pg_timezone_names zone
  on zone.name = nullif(tenant.timezone, '')
where task.tenant_id = tenant.id
  and task.status = 'completed'
  and task.completed_at is not null
  and task.due_at is not null
  and task.completion_timing is distinct from case
    when private_app.customer_followup_uses_day_policy_v1(
      task.contact_id,
      task.metadata ->> 'source'
    ) and (
        task.completed_at at time zone coalesce(zone.name, 'UTC')
      )::date <= (
        task.due_at at time zone coalesce(zone.name, 'UTC')
      )::date then 'on_time'
    when not private_app.customer_followup_uses_day_policy_v1(
      task.contact_id,
      task.metadata ->> 'source'
    ) and task.completed_at <= task.due_at then 'on_time'
    else 'late'
  end;

create or replace function public.v3_tenant_update_task_status(
  p_tenant_slug text,
  p_task_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_task work_core.tasks%rowtype;
begin
  v_result := public.v2_tenant_update_task_status(
    p_tenant_slug,
    p_task_id,
    p_status
  );

  select task.*
  into v_task
  from work_core.tasks task
  join core.tenants tenant
    on tenant.id = task.tenant_id
  where tenant.slug = p_tenant_slug
    and task.id = p_task_id
  limit 1;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'completionTiming', v_task.completion_timing,
    'completedAt', v_task.completed_at
  ));
end;
$$;

revoke all on function public.v3_tenant_update_task_status(
  text,
  uuid,
  text
) from public, anon;
grant execute on function public.v3_tenant_update_task_status(
  text,
  uuid,
  text
) to authenticated, service_role;

create or replace function public.v4_tenant_transition_task(
  p_tenant_slug text,
  p_task_id uuid,
  p_status text default null,
  p_due_at timestamptz default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_task work_core.tasks%rowtype;
begin
  v_result := public.v3_tenant_transition_task(
    p_tenant_slug,
    p_task_id,
    p_status,
    p_due_at,
    p_note
  );

  select task.*
  into v_task
  from work_core.tasks task
  join core.tenants tenant
    on tenant.id = task.tenant_id
  where tenant.slug = p_tenant_slug
    and task.id = p_task_id
  limit 1;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'completionTiming', v_task.completion_timing,
    'completedAt', v_task.completed_at
  ));
end;
$$;

revoke all on function public.v4_tenant_transition_task(
  text,
  uuid,
  text,
  timestamptz,
  text
) from public, anon;
grant execute on function public.v4_tenant_transition_task(
  text,
  uuid,
  text,
  timestamptz,
  text
) to authenticated, service_role;

create or replace function public.v3_platform_control_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_tenants jsonb := '[]'::jsonb;
begin
  v_snapshot := public.v2_platform_control_snapshot_v2();

  select coalesce(jsonb_agg(
    member.item || jsonb_build_object(
      'overdueTasks', (
        select count(*)
        from work_core.tasks task
        join core.tenants tenant
          on tenant.id = task.tenant_id
        left join pg_catalog.pg_timezone_names zone
          on zone.name = nullif(tenant.timezone, '')
        where task.tenant_id = nullif(
            member.item ->> 'id',
            ''
          )::uuid
          and task.status not in ('completed', 'cancelled')
          and (
            (
              private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < (
                (
                  now() at time zone coalesce(zone.name, 'UTC')
                )::date::timestamp at time zone coalesce(zone.name, 'UTC')
              )
            )
            or (
              not private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < now()
            )
          )
      )
    ) order by member.position
  ), '[]'::jsonb)
  into v_tenants
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'tenants', '[]'::jsonb)
  ) with ordinality member(item, position);

  return jsonb_set(v_snapshot, '{tenants}', v_tenants, true);
end;
$$;

revoke all on function public.v3_platform_control_snapshot()
from public, anon;
grant execute on function public.v3_platform_control_snapshot()
to authenticated, service_role;

create or replace function public.v4_tenant_operations_snapshot(
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
  v_timezone text;
  v_today date;
  v_overdue bigint := 0;
  v_leaderboard jsonb := '[]'::jsonb;
begin
  v_snapshot := public.v3_tenant_operations_snapshot(p_slug);

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;

  select count(*)
  into v_overdue
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'tasks', '[]'::jsonb)
  ) task(item)
  cross join lateral (
    select
      nullif(task.item ->> 'dueAt', '')::timestamptz as due_at,
      nullif(task.item ->> 'contactId', '') is not null
        or coalesce(task.item ->> 'taskSource', '') in (
          'lead_assignment',
          'opportunity_next_action',
          'activity_next_action',
          'lead_next_action',
          'sales_followup'
        ) as uses_day_policy
  ) timing
  where task.item ->> 'status' in ('todo', 'in_progress')
    and timing.due_at is not null
    and (
      (
        timing.uses_day_policy
        and (
          timing.due_at at time zone v_timezone
        )::date < v_today
      )
      or (
        not timing.uses_day_policy
        and timing.due_at < now()
      )
    );

  select coalesce(jsonb_agg(
    member.item || jsonb_build_object(
      'overdueTasks', (
        select count(*)
        from jsonb_array_elements(
          coalesce(v_snapshot -> 'tasks', '[]'::jsonb)
        ) task(item)
        cross join lateral (
          select
            nullif(task.item ->> 'dueAt', '')::timestamptz as due_at,
            nullif(task.item ->> 'contactId', '') is not null
              or coalesce(task.item ->> 'taskSource', '') in (
                'lead_assignment',
                'opportunity_next_action',
                'activity_next_action',
                'lead_next_action',
                'sales_followup'
              ) as uses_day_policy
        ) timing
        where task.item ->> 'status' in ('todo', 'in_progress')
          and task.item ->> 'assignedStaffId' =
            member.item ->> 'staffId'
          and timing.due_at is not null
          and (
            (
              timing.uses_day_policy
              and (
                timing.due_at at time zone v_timezone
              )::date < v_today
            )
            or (
              not timing.uses_day_policy
              and timing.due_at < now()
            )
          )
      )
    ) order by member.position
  ), '[]'::jsonb)
  into v_leaderboard
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'leaderboard', '[]'::jsonb)
  ) with ordinality member(item, position);

  v_snapshot := v_snapshot || jsonb_build_object(
    'timezone', v_timezone
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb)
      || jsonb_build_object('overdueTasks', v_overdue),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{leaderboard}',
    v_leaderboard,
    true
  );

  return v_snapshot;
end;
$$;

revoke all on function public.v4_tenant_operations_snapshot(text)
from public, anon;
grant execute on function public.v4_tenant_operations_snapshot(text)
to authenticated, service_role;

create or replace function public.v4_tenant_sales_pipeline_snapshot(
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
  v_timezone text;
  v_today date;
  v_overdue_followups bigint := 0;
begin
  v_snapshot := public.v3_tenant_sales_pipeline_snapshot(p_slug);

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;

  select count(*)
  into v_overdue_followups
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'contacts', '[]'::jsonb)
  ) contact(item)
  where nullif(contact.item ->> 'nextActionAt', '') is not null
    and coalesce(
      contact.item ->> 'leadStatus',
      contact.item ->> 'status'
    ) not in (
      'paid',
      'not_interested',
      'unqualified',
      'wrong_number',
      'duplicate',
      'cancelled'
    )
    and (
      nullif(contact.item ->> 'nextActionAt', '')::timestamptz
        at time zone v_timezone
    )::date < v_today;

  v_snapshot := v_snapshot || jsonb_build_object(
    'timezone', v_timezone
  );
  return jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb)
      || jsonb_build_object(
        'overdueFollowups', v_overdue_followups
      ),
    true
  );
end;
$$;

revoke all on function public.v4_tenant_sales_pipeline_snapshot(text)
from public, anon;
grant execute on function public.v4_tenant_sales_pipeline_snapshot(text)
to authenticated, service_role;

create or replace function public.v2_tenant_dashboard_live_snapshot(
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
  v_tenant_id uuid;
  v_staff_id uuid;
  v_subject_id uuid;
  v_view_team boolean := false;
  v_can_read_work boolean := false;
  v_timezone text := 'UTC';
  v_today date;
  v_today_start timestamptz;
  v_overdue bigint := 0;
begin
  v_snapshot := public.v1_tenant_dashboard_live_snapshot(p_slug);
  v_tenant_id := nullif(
    v_snapshot #>> '{tenant,id}',
    ''
  )::uuid;
  v_staff_id := nullif(
    v_snapshot #>> '{viewer,staffId}',
    ''
  )::uuid;
  v_subject_id := private_app.current_subject_id();
  v_view_team := coalesce(
    (v_snapshot #>> '{viewer,viewTeam}')::boolean,
    false
  );
  v_can_read_work := coalesce(
    (v_snapshot #>> '{viewer,canReadWork}')::boolean,
    false
  );
  v_timezone := coalesce(
    nullif(v_snapshot #>> '{tenant,timezone}', ''),
    'UTC'
  );
  v_today := (now() at time zone v_timezone)::date;
  v_today_start := v_today::timestamp at time zone v_timezone;

  if v_can_read_work then
    select count(*)
    into v_overdue
    from work_core.tasks task
    where task.tenant_id = v_tenant_id
      and task.status in ('todo', 'in_progress')
      and (
        (
          private_app.customer_followup_uses_day_policy_v1(
            task.contact_id,
            task.metadata ->> 'source'
          )
          and task.due_at < v_today_start
        )
        or (
          not private_app.customer_followup_uses_day_policy_v1(
            task.contact_id,
            task.metadata ->> 'source'
          )
          and task.due_at < now()
        )
      )
      and (
        v_view_team
        or task.assigned_staff_id = v_staff_id
        or task.created_by_subject_id = v_subject_id
      );
  end if;

  return jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb)
      || jsonb_build_object('overdueTasks', v_overdue),
    true
  );
end;
$$;

revoke all on function public.v2_tenant_dashboard_live_snapshot(text)
from public, anon;
grant execute on function public.v2_tenant_dashboard_live_snapshot(text)
to authenticated;

create or replace function public.v6_tenant_calendar_day_snapshot(
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
  v_snapshot jsonb;
  v_timezone text := 'UTC';
  v_today date;
  v_overdue bigint := 0;
begin
  v_snapshot := public.v5_tenant_calendar_day_snapshot(
    p_tenant_slug,
    p_day,
    p_task_ids
  );
  v_timezone := coalesce(
    nullif(v_snapshot ->> 'timezone', ''),
    'UTC'
  );
  v_today := (now() at time zone v_timezone)::date;

  select count(*)
  into v_overdue
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'tasks', '[]'::jsonb)
  ) task(item)
  cross join lateral (
    select
      nullif(task.item ->> 'dueAt', '')::timestamptz as due_at,
      nullif(task.item ->> 'contactId', '') is not null
        or coalesce(task.item ->> 'taskSource', '') in (
          'lead_assignment',
          'opportunity_next_action',
          'activity_next_action',
          'lead_next_action',
          'sales_followup'
        ) as uses_day_policy
  ) timing
  where task.item ->> 'status' in ('todo', 'in_progress')
    and timing.due_at is not null
    and (
      (
        timing.uses_day_policy
        and (
          timing.due_at at time zone v_timezone
        )::date < v_today
      )
      or (
        not timing.uses_day_policy
        and timing.due_at < now()
      )
    );

  return jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb)
      || jsonb_build_object('overdueTasks', v_overdue),
    true
  );
end;
$$;

revoke all on function public.v6_tenant_calendar_day_snapshot(
  text,
  date,
  uuid[]
) from public, anon;
grant execute on function public.v6_tenant_calendar_day_snapshot(
  text,
  date,
  uuid[]
) to authenticated, service_role;

create or replace function public.v2_tenant_role_dashboard_snapshot_v8(
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
  v_snapshot jsonb;
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_role_key text;
  v_is_platform boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_timezone text := 'UTC';
  v_today date;
  v_today_start timestamptz;
  v_personal_overdue bigint := 0;
  v_sales_overdue bigint := 0;
  v_team jsonb := '[]'::jsonb;
begin
  v_snapshot := public.v2_tenant_role_dashboard_snapshot_v7(
    p_slug,
    p_from,
    p_to
  );

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  v_staff_id := nullif(
    v_snapshot #>> '{viewer,staffId}',
    ''
  )::uuid;
  v_role_key := coalesce(
    nullif(v_snapshot #>> '{viewer,roleKey}', ''),
    'tenant_user'
  );
  v_is_platform := private_app.has_platform_permission(
    'platform.tenants.read'
  );
  v_scope_staff_ids := private_app.v2_metric_staff_scope(
    v_tenant.id,
    v_staff_id,
    v_role_key,
    v_is_platform
  );
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_today_start := v_today::timestamp at time zone v_timezone;

  if v_staff_id is not null then
    select count(*)
    into v_personal_overdue
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.assigned_staff_id = v_staff_id
      and private_app.v2_metric_is_open_task(task.status)
      and (
        (
          private_app.customer_followup_uses_day_policy_v1(
            task.contact_id,
            task.metadata ->> 'source'
          )
          and task.due_at < v_today_start
        )
        or (
          not private_app.customer_followup_uses_day_policy_v1(
            task.contact_id,
            task.metadata ->> 'source'
          )
          and task.due_at < now()
        )
      );
  end if;

  select count(*)
  into v_sales_overdue
  from sales_core.contacts contact
  where contact.tenant_id = v_tenant.id
    and contact.owner_staff_id = any(v_scope_staff_ids)
    and private_app.v2_metric_is_active_contact(
      contact.status,
      contact.lead_status
    )
    and contact.next_action_at < v_today_start;

  select coalesce(jsonb_agg(
    member.item || jsonb_build_object(
      'overdueTasks', (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.assigned_staff_id = nullif(
            member.item ->> 'staffId',
            ''
          )::uuid
          and private_app.v2_metric_is_open_task(task.status)
          and (
            (
              private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < v_today_start
            )
            or (
              not private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < now()
            )
          )
      )
    ) order by member.position
  ), '[]'::jsonb)
  into v_team
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'team', '[]'::jsonb)
  ) with ordinality member(item, position);

  v_snapshot := jsonb_set(
    v_snapshot,
    '{personal}',
    coalesce(v_snapshot -> 'personal', '{}'::jsonb)
      || jsonb_build_object('overdueTasks', v_personal_overdue),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{sales}',
    coalesce(v_snapshot -> 'sales', '{}'::jsonb)
      || jsonb_build_object('overdueFollowUps', v_sales_overdue),
    true
  );
  v_snapshot := jsonb_set(v_snapshot, '{team}', v_team, true);

  return v_snapshot;
end;
$$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v8(
  text,
  date,
  date
) from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v8(
  text,
  date,
  date
) to authenticated, service_role;

create or replace function public.v2_tenant_employee_achievement_snapshot_v3(
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
  v_staff_id uuid;
  v_timezone text := 'UTC';
  v_today date;
  v_today_start timestamptz;
  v_overdue bigint := 0;
begin
  v_snapshot := public.v2_tenant_employee_achievement_snapshot_v2(
    p_slug
  );

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  v_staff_id := nullif(
    v_snapshot #>> '{viewer,staffId}',
    ''
  )::uuid;
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_today_start := v_today::timestamp at time zone v_timezone;

  if v_staff_id is not null then
    select count(*)
    into v_overdue
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.assigned_staff_id = v_staff_id
      and private_app.v2_metric_is_open_task(task.status)
      and (
        (
          private_app.customer_followup_uses_day_policy_v1(
            task.contact_id,
            task.metadata ->> 'source'
          )
          and task.due_at < v_today_start
        )
        or (
          not private_app.customer_followup_uses_day_policy_v1(
            task.contact_id,
            task.metadata ->> 'source'
          )
          and task.due_at < now()
        )
      );
  end if;

  return jsonb_set(
    v_snapshot,
    '{personal}',
    coalesce(v_snapshot -> 'personal', '{}'::jsonb)
      || jsonb_build_object('overdueTasks', v_overdue),
    true
  );
end;
$$;

revoke all on function public.v2_tenant_employee_achievement_snapshot_v3(text)
from public, anon;
grant execute on function public.v2_tenant_employee_achievement_snapshot_v3(text)
to authenticated, service_role;

create or replace function public.v4_tenant_customer_history_snapshot(
  p_slug text,
  p_contact_id uuid,
  p_limit integer default 250
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
  v_timezone text := 'UTC';
  v_today date;
  v_events jsonb := '[]'::jsonb;
  v_on_time_delta bigint := 0;
  v_late_delta bigint := 0;
  v_overdue_delta bigint := 0;
  v_pending_delta bigint := 0;
  v_on_time bigint := 0;
  v_late bigint := 0;
  v_overdue bigint := 0;
  v_pending bigint := 0;
  v_adherence numeric := 0;
begin
  v_snapshot := public.v3_tenant_customer_history_snapshot(
    p_slug,
    p_contact_id,
    p_limit
  );

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;

  with event_rows as (
    select
      event.item,
      event.position,
      event.item ->> 'type' as event_type,
      event.item ->> 'status' as event_status,
      nullif(event.item ->> 'scheduledAt', '')::timestamptz
        as scheduled_at,
      nullif(event.item ->> 'occurredAt', '')::timestamptz
        as occurred_at
    from jsonb_array_elements(
      coalesce(v_snapshot -> 'events', '[]'::jsonb)
    ) with ordinality event(item, position)
  ), normalized as (
    select
      case
        when event.event_type in ('task', 'activity')
             and event.scheduled_at is not null
        then event.item || jsonb_build_object(
          'timingStatus', case
            when event.event_type = 'task'
                 and event.event_status = 'cancelled' then 'cancelled'
            when event.occurred_at is not null
                 and (
                   event.occurred_at at time zone v_timezone
                 )::date < (
                   event.scheduled_at at time zone v_timezone
                 )::date then 'early'
            when event.occurred_at is not null
                 and (
                   event.occurred_at at time zone v_timezone
                 )::date = (
                   event.scheduled_at at time zone v_timezone
                 )::date then 'on_time'
            when event.occurred_at is not null then 'late'
            when (
              event.scheduled_at at time zone v_timezone
            )::date < v_today then 'overdue'
            else 'pending'
          end,
          'delayMinutes', case
            when event.occurred_at is not null
                 and (
                   event.occurred_at at time zone v_timezone
                 )::date = (
                   event.scheduled_at at time zone v_timezone
                 )::date then 0
            else nullif(event.item ->> 'delayMinutes', '')::integer
          end
        )
        else event.item
      end as item,
      event.position
    from event_rows event
  )
  select coalesce(jsonb_agg(
    normalized.item order by normalized.position
  ), '[]'::jsonb)
  into v_events
  from normalized;

  with task_timing as (
    select
      case
        when task.status = 'completed'
             and coalesce(activity.occurred_at, task.completed_at)
               <= task.due_at then 'on_time'
        when task.status = 'completed' then 'late'
        when task.due_at < now() then 'overdue'
        else 'pending'
      end as old_timing,
      case
        when task.status = 'completed'
             and (
               coalesce(activity.occurred_at, task.completed_at)
                 at time zone v_timezone
             )::date <= (
               task.due_at at time zone v_timezone
             )::date then 'on_time'
        when task.status = 'completed' then 'late'
        when (
          task.due_at at time zone v_timezone
        )::date < v_today then 'overdue'
        else 'pending'
      end as new_timing
    from work_core.tasks task
    left join sales_core.activities activity
      on activity.tenant_id = task.tenant_id
     and activity.id::text = task.metadata ->> 'resolvedByActivityId'
    where task.tenant_id = v_tenant.id
      and task.contact_id = p_contact_id
      and task.status in ('todo', 'in_progress', 'completed')
  ), history_timing as (
    select
      case
        when history.changed_at <= history.previous_due_at
          then 'on_time'
        else 'late'
      end as old_timing,
      case
        when (
          history.changed_at at time zone v_timezone
        )::date <= (
          history.previous_due_at at time zone v_timezone
        )::date then 'on_time'
        else 'late'
      end as new_timing
    from work_core.task_history history
    where history.tenant_id = v_tenant.id
      and history.contact_id = p_contact_id
      and history.previous_due_at is distinct from history.next_due_at
  ), all_timing as (
    select * from task_timing
    union all
    select * from history_timing
  )
  select
    count(*) filter (where new_timing = 'on_time')
      - count(*) filter (where old_timing = 'on_time'),
    count(*) filter (where new_timing = 'late')
      - count(*) filter (where old_timing = 'late'),
    count(*) filter (where new_timing = 'overdue')
      - count(*) filter (where old_timing = 'overdue'),
    count(*) filter (where new_timing = 'pending')
      - count(*) filter (where old_timing = 'pending')
  into
    v_on_time_delta,
    v_late_delta,
    v_overdue_delta,
    v_pending_delta
  from all_timing;

  v_on_time := greatest(0, coalesce(nullif(
    v_snapshot #>> '{summary,completedOnTime}',
    ''
  )::bigint, 0) + v_on_time_delta);
  v_late := greatest(0, coalesce(nullif(
    v_snapshot #>> '{summary,completedLate}',
    ''
  )::bigint, 0) + v_late_delta);
  v_overdue := greatest(0, coalesce(nullif(
    v_snapshot #>> '{summary,overdue}',
    ''
  )::bigint, 0) + v_overdue_delta);
  v_pending := greatest(0, coalesce(nullif(
    v_snapshot #>> '{summary,pending}',
    ''
  )::bigint, 0) + v_pending_delta);
  v_adherence := coalesce(round(
    100.0 * v_on_time / nullif(v_on_time + v_late, 0),
    1
  ), 0);

  v_snapshot := jsonb_set(v_snapshot, '{events}', v_events, true);
  v_snapshot := jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb)
      || jsonb_build_object(
        'completedOnTime', v_on_time,
        'completedLate', v_late,
        'overdue', v_overdue,
        'pending', v_pending,
        'adherencePercent', v_adherence
      ),
    true
  );

  return v_snapshot;
end;
$$;

revoke all on function public.v4_tenant_customer_history_snapshot(
  text,
  uuid,
  integer
) from public, anon;
grant execute on function public.v4_tenant_customer_history_snapshot(
  text,
  uuid,
  integer
) to authenticated, service_role;

create or replace function public.v5_tenant_reports_snapshot(
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
  v_snapshot jsonb;
  v_tenant core.tenants%rowtype;
  v_timezone text := 'UTC';
  v_today date;
  v_today_start timestamptz;
  v_from_date date;
  v_to_date date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_staff_ids uuid[] := '{}'::uuid[];
  v_overdue bigint := 0;
  v_employees jsonb := '[]'::jsonb;
begin
  v_snapshot := public.v4_tenant_reports_snapshot(
    p_slug,
    p_from,
    p_to,
    p_staff_id,
    p_report,
    p_limit,
    p_offset
  );

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  v_today_start := v_today::timestamp at time zone v_timezone;
  v_from_date := (v_snapshot #>> '{period,from}')::date;
  v_to_date := (v_snapshot #>> '{period,to}')::date;
  v_from_at := v_from_date::timestamp at time zone v_timezone;
  v_to_at := (v_to_date + 1)::timestamp at time zone v_timezone;

  select coalesce(array_agg(
    nullif(employee.item ->> 'staffId', '')::uuid
    order by employee.position
  ), '{}'::uuid[])
  into v_staff_ids
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'employees', '[]'::jsonb)
  ) with ordinality employee(item, position)
  where nullif(employee.item ->> 'staffId', '') is not null;

  select count(*)
  into v_overdue
  from work_core.tasks task
  where task.tenant_id = v_tenant.id
    and task.assigned_staff_id = any(v_staff_ids)
    and task.status in ('todo', 'in_progress')
    and task.due_at >= v_from_at
    and task.due_at < v_to_at
    and (
      (
        private_app.customer_followup_uses_day_policy_v1(
          task.contact_id,
          task.metadata ->> 'source'
        )
        and task.due_at < v_today_start
      )
      or (
        not private_app.customer_followup_uses_day_policy_v1(
          task.contact_id,
          task.metadata ->> 'source'
        )
        and task.due_at < now()
      )
    );

  select coalesce(jsonb_agg(
    employee.item || jsonb_build_object(
      'overdueTasks', (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.assigned_staff_id = nullif(
            employee.item ->> 'staffId',
            ''
          )::uuid
          and task.status in ('todo', 'in_progress')
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and (
            (
              private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < v_today_start
            )
            or (
              not private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < now()
            )
          )
      )
    ) order by employee.position
  ), '[]'::jsonb)
  into v_employees
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'employees', '[]'::jsonb)
  ) with ordinality employee(item, position);

  v_snapshot := jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb)
      || jsonb_build_object('overdueTasks', v_overdue),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{employees}',
    v_employees,
    true
  );

  return v_snapshot;
end;
$$;

revoke all on function public.v5_tenant_reports_snapshot(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.v5_tenant_reports_snapshot(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) to authenticated, service_role;

comment on function private_app.task_day_is_overdue_v1(
  uuid,
  timestamptz,
  timestamptz
) is
  'Returns true only after the tenant-local due date has ended.';

comment on function public.v6_tenant_calendar_day_snapshot(
  text,
  date,
  uuid[]
) is
  'Calendar insight where customer follow-up hours are organizational and lateness starts the next local day.';

notify pgrst, 'reload schema';

commit;
