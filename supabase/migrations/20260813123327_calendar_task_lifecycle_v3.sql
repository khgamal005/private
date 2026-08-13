begin;

-- One mutable calendar row represents the current task. Every meaningful
-- transition is copied to this append-only history before the row changes.
-- This applies to sales, admissions, customer service, data, and operational
-- tasks because it is enforced on work_core.tasks rather than in one UI flow.

create table if not exists work_core.task_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  task_id uuid not null,
  task_key text not null,
  contact_id uuid references sales_core.contacts(id) on delete set null,
  opportunity_id uuid references sales_core.opportunities(id) on delete set null,
  actor_subject_id uuid references access_control.subjects(id) on delete set null,
  event_type text not null check (
    event_type in ('rescheduled', 'status_changed', 'reassigned', 'updated')
  ),
  task_title text not null,
  task_description text,
  previous_status text,
  next_status text,
  previous_due_at timestamptz,
  next_due_at timestamptz,
  previous_assigned_staff_id uuid references people.staff_profiles(id) on delete set null,
  next_assigned_staff_id uuid references people.staff_profiles(id) on delete set null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  changed_at timestamptz not null default now()
);

create index if not exists work_task_history_tenant_task_changed_idx
on work_core.task_history (tenant_id, task_id, changed_at desc);

create index if not exists work_task_history_tenant_contact_changed_idx
on work_core.task_history (tenant_id, contact_id, changed_at desc)
where contact_id is not null;

alter table work_core.task_history enable row level security;

revoke all on table work_core.task_history
from public, anon, authenticated;

grant select on table work_core.task_history to service_role;

create or replace function private_app.capture_task_history_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_type text;
  v_transition jsonb;
begin
  if row(
    old.status,
    old.due_at,
    old.assigned_staff_id,
    old.title,
    old.description,
    old.priority,
    old.metadata
  ) is not distinct from row(
    new.status,
    new.due_at,
    new.assigned_staff_id,
    new.title,
    new.description,
    new.priority,
    new.metadata
  ) then
    return new;
  end if;

  v_event_type := case
    when old.due_at is distinct from new.due_at then 'rescheduled'
    when old.status is distinct from new.status then 'status_changed'
    when old.assigned_staff_id is distinct from new.assigned_staff_id
      then 'reassigned'
    else 'updated'
  end;
  v_transition := case
    when old.metadata -> 'lastTransition'
      is distinct from new.metadata -> 'lastTransition'
      then coalesce(new.metadata -> 'lastTransition', '{}'::jsonb)
    else '{}'::jsonb
  end;

  insert into work_core.task_history (
    tenant_id,
    task_id,
    task_key,
    contact_id,
    opportunity_id,
    actor_subject_id,
    event_type,
    task_title,
    task_description,
    previous_status,
    next_status,
    previous_due_at,
    next_due_at,
    previous_assigned_staff_id,
    next_assigned_staff_id,
    note,
    metadata,
    changed_at
  )
  values (
    new.tenant_id,
    new.id,
    new.task_key,
    new.contact_id,
    new.opportunity_id,
    private_app.current_subject_id(),
    v_event_type,
    new.title,
    new.description,
    old.status,
    new.status,
    old.due_at,
    new.due_at,
    old.assigned_staff_id,
    new.assigned_staff_id,
    nullif(v_transition ->> 'note', ''),
    jsonb_strip_nulls(jsonb_build_object(
      'source', new.metadata ->> 'source',
      'actionType', new.metadata ->> 'actionType',
      'transition', v_transition
    )),
    now()
  );

  return new;
end;
$$;

revoke all on function private_app.capture_task_history_v1()
from public, anon, authenticated;

drop trigger if exists capture_task_history_after_update
on work_core.tasks;

create trigger capture_task_history_after_update
after update of
  status,
  due_at,
  assigned_staff_id,
  title,
  description,
  priority,
  metadata
on work_core.tasks
for each row
execute function private_app.capture_task_history_v1();

create or replace function public.v3_tenant_transition_task(
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
  v_tenant_id uuid;
  v_task work_core.tasks%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_next_status text;
  v_next_due_at timestamptz;
  v_completed_at timestamptz;
  v_completion_timing text;
  v_clean_note text;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.work.write'
  ) then raise exception 'forbidden'; end if;
  if p_status is not null
     and p_status not in ('todo', 'in_progress', 'completed', 'cancelled') then
    raise exception 'invalid_task_status';
  end if;

  select task.*
  into v_task
  from work_core.tasks task
  where task.id = p_task_id
    and task.tenant_id = v_tenant_id
  for update;

  if v_task.id is null then raise exception 'task_not_found'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_task.assigned_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  v_next_status := coalesce(p_status, v_task.status);
  v_next_due_at := coalesce(p_due_at, v_task.due_at);
  v_clean_note := nullif(btrim(coalesce(p_note, '')), '');

  if length(coalesce(v_clean_note, '')) > 2000 then
    raise exception 'task_note_too_long';
  end if;
  if v_task.status in ('completed', 'cancelled')
     and v_next_status = v_task.status
     and v_next_due_at is distinct from v_task.due_at then
    raise exception 'task_closed';
  end if;
  if v_next_status = v_task.status
     and v_next_due_at is not distinct from v_task.due_at
     and v_clean_note is null then
    raise exception 'task_transition_required';
  end if;

  if v_next_status = 'completed' then
    v_completed_at := case
      when v_task.status = 'completed' then v_task.completed_at
      else now()
    end;
    v_completion_timing := case
      when v_completed_at <= v_next_due_at then 'on_time'
      else 'late'
    end;
  else
    v_completed_at := null;
    v_completion_timing := null;
  end if;

  update work_core.tasks
  set status = v_next_status,
      due_at = v_next_due_at,
      completed_at = v_completed_at,
      completion_timing = v_completion_timing,
      metadata = metadata || jsonb_build_object(
        'lastTransition',
        jsonb_strip_nulls(jsonb_build_object(
          'fromStatus', v_task.status,
          'toStatus', v_next_status,
          'fromDueAt', v_task.due_at,
          'toDueAt', v_next_due_at,
          'note', v_clean_note,
          'actorSubjectId', private_app.current_subject_id(),
          'at', now(),
          'mode', 'same_task_row_v3'
        ))
      ),
      updated_at = now()
  where id = v_task.id
    and tenant_id = v_tenant_id;

  perform private_app.write_audit(
    'tenant.work_task_transitioned',
    'work_task',
    v_task.id::text,
    v_tenant_id,
    jsonb_strip_nulls(jsonb_build_object(
      'previousStatus', v_task.status,
      'status', v_next_status,
      'previousDueAt', v_task.due_at,
      'nextDueAt', v_next_due_at,
      'note', v_clean_note,
      'taskUpdateMode', 'same_task_row_v3'
    ))
  );

  return jsonb_build_object(
    'id', v_task.id,
    'status', v_next_status,
    'dueAt', v_next_due_at,
    'previousDueAt', v_task.due_at,
    'completionTiming', v_completion_timing,
    'moved', v_next_due_at is distinct from v_task.due_at,
    'taskUpdateMode', 'same_task_row_v3'
  );
end;
$$;

revoke all on function public.v3_tenant_transition_task(
  text, uuid, text, timestamptz, text
) from public, anon;

grant execute on function public.v3_tenant_transition_task(
  text, uuid, text, timestamptz, text
) to authenticated, service_role;

-- The calendar binds a customer action to the exact task that the employee
-- opened. Calls from other CRM screens may omit p_task_id and keep the
-- established contact-level fallback.
create or replace function public.v2_tenant_record_sales_followup_v5(
  p_tenant_slug text,
  p_contact_id uuid,
  p_activity_type text,
  p_summary text,
  p_lead_status text,
  p_lead_quality text default 'unrated',
  p_next_action_type text default null,
  p_next_action_at timestamptz default null,
  p_course_id uuid default null,
  p_course_run_id uuid default null,
  p_payment_amount_minor bigint default null,
  p_payment_reference text default null,
  p_preferred_start_date date default null,
  p_closure_reason text default null,
  p_contact_name text default null,
  p_task_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_selected_task work_core.tasks%rowtype;
  v_result jsonb;
  v_result_task_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_tenant_id::text || ':' || p_contact_id::text,
      31603
    )
  );

  if p_task_id is not null then
    select task.*
    into v_selected_task
    from work_core.tasks task
    where task.id = p_task_id
      and task.tenant_id = v_tenant_id
      and task.contact_id = p_contact_id
      and task.status in ('todo', 'in_progress')
      and coalesce(task.metadata ->> 'source', '') in (
        'lead_assignment',
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'sales_followup'
      )
    for update;

    if v_selected_task.id is null then
      raise exception 'task_not_followup';
    end if;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v4(
    p_tenant_slug => p_tenant_slug,
    p_contact_id => p_contact_id,
    p_activity_type => p_activity_type,
    p_summary => p_summary,
    p_lead_status => p_lead_status,
    p_lead_quality => p_lead_quality,
    p_next_action_type => p_next_action_type,
    p_next_action_at => p_next_action_at,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => p_closure_reason,
    p_contact_name => p_contact_name
  );

  if p_task_id is not null then
    v_result_task_id := nullif(
      coalesce(
        v_result ->> 'followupTaskId',
        v_result ->> 'taskId'
      ),
      ''
    )::uuid;
    if v_result_task_id is distinct from p_task_id then
      raise exception 'task_transition_conflict';
    end if;
  end if;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'selectedTaskId', p_task_id,
    'taskUpdateMode', 'bound_task_id_v5'
  ));
end;
$$;

revoke all on function public.v2_tenant_record_sales_followup_v5(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text,
  text,
  uuid
) from public, anon;

grant execute on function public.v2_tenant_record_sales_followup_v5(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text,
  text,
  uuid
) to authenticated, service_role;

-- Keep completed/cancelled predecessors in history, not as a second active
-- calendar card. Completed tasks remain visible when there is no current
-- follow-up, preserving the existing completion view and performance metrics.
create or replace function public.v3_tenant_operations_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_tasks jsonb;
begin
  v_result := public.v2_tenant_operations_snapshot(p_slug);

  select coalesce(jsonb_agg(
    task_row.item || jsonb_build_object(
      'taskSource', coalesce(task.metadata ->> 'source', 'manual'),
      'calendarCurrent', true
    )
    order by task.due_at, task.id
  ), '[]'::jsonb)
  into v_tasks
  from jsonb_array_elements(
    coalesce(v_result -> 'tasks', '[]'::jsonb)
  ) task_row(item)
  join work_core.tasks task
    on task.id = nullif(task_row.item ->> 'id', '')::uuid
  where task.status <> 'cancelled'
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
    );

  return pg_catalog.jsonb_set(
    v_result,
    '{tasks}',
    v_tasks,
    true
  );
end;
$$;

revoke all on function public.v3_tenant_operations_snapshot(text)
from public, anon;

grant execute on function public.v3_tenant_operations_snapshot(text)
to authenticated, service_role;

-- Add old calendar dates to the customer timeline from append-only task
-- history. The active calendar still receives only the current task row.
create or replace function public.v3_tenant_customer_history_snapshot(
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
  v_result jsonb;
  v_tenant core.tenants%rowtype;
  v_limit integer;
  v_events jsonb;
  v_summary jsonb;
  v_history_total integer;
  v_history_on_time integer;
  v_history_late integer;
  v_base_on_time integer;
  v_base_late integer;
begin
  v_limit := least(greatest(coalesce(p_limit, 250), 1), 500);
  v_result := public.v2_tenant_customer_history_snapshot_v2(
    p_slug,
    p_contact_id,
    v_limit
  );

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  with base_events as (
    select
      event.item,
      coalesce(
        nullif(event.item ->> 'occurredAt', '')::timestamptz,
        nullif(event.item ->> 'scheduledAt', '')::timestamptz,
        nullif(event.item ->> 'recordedAt', '')::timestamptz
      ) as sort_at,
      event.item ->> 'id' as event_key
    from jsonb_array_elements(
      coalesce(v_result -> 'events', '[]'::jsonb)
    ) event(item)
  ), history_events as (
    select
      jsonb_build_object(
        'id', 'task-history:' || history.id::text,
        'type', 'task',
        'category', 'task_rescheduled',
        'title', 'نقل موعد المهمة: ' || history.task_title,
        'description', coalesce(
          history.note,
          'تم نقل الموعد مع الحفاظ على نفس المهمة دون إنشاء نسخة جديدة.'
        ),
        'actorName', coalesce(actor.full_name, subject.full_name, 'إدارة المنشأة'),
        'actorStaffId', actor.id,
        'scheduledAt', history.previous_due_at,
        'occurredAt', history.changed_at,
        'recordedAt', history.changed_at,
        'timingStatus', case
          when history.changed_at <= history.previous_due_at then 'on_time'
          else 'late'
        end,
        'delayMinutes', round(extract(epoch from (
          history.changed_at - history.previous_due_at
        )) / 60)::integer,
        'status', history.next_status,
        'quality', null::text,
        'nextActionType', 'follow_up',
        'nextActionAt', history.next_due_at,
        'details', jsonb_build_object(
          'taskId', history.task_id,
          'taskKey', history.task_key,
          'previousStatus', history.previous_status,
          'nextStatus', history.next_status,
          'previousDueAt', history.previous_due_at,
          'nextDueAt', history.next_due_at,
          'source', history.metadata ->> 'source',
          'historyOnly', true
        )
      ) as item,
      history.changed_at as sort_at,
      'task-history:' || history.id::text as event_key
    from work_core.task_history history
    left join access_control.subjects subject
      on subject.id = history.actor_subject_id
    left join access_control.memberships membership
      on membership.subject_id = history.actor_subject_id
      and membership.tenant_id = history.tenant_id
      and membership.status = 'active'
    left join people.staff_profiles actor
      on actor.membership_id = membership.id
      and actor.tenant_id = history.tenant_id
    where history.tenant_id = v_tenant.id
      and history.contact_id = p_contact_id
      and history.previous_due_at is distinct from history.next_due_at
  ), combined_events as (
    select * from base_events
    union all
    select * from history_events
  ), ordered_events as (
    select combined.item, combined.sort_at, combined.event_key
    from combined_events combined
    order by combined.sort_at desc nulls last, combined.event_key
    limit v_limit
  )
  select coalesce(jsonb_agg(
    ordered.item
    order by ordered.sort_at desc nulls last, ordered.event_key
  ), '[]'::jsonb)
  into v_events
  from ordered_events ordered;

  select
    count(*)::integer,
    count(*) filter (
      where history.changed_at <= history.previous_due_at
    )::integer,
    count(*) filter (
      where history.changed_at > history.previous_due_at
    )::integer
  into v_history_total, v_history_on_time, v_history_late
  from work_core.task_history history
  where history.tenant_id = v_tenant.id
    and history.contact_id = p_contact_id
    and history.previous_due_at is distinct from history.next_due_at;

  v_base_on_time := coalesce(
    nullif(v_result #>> '{summary,completedOnTime}', '')::integer,
    0
  );
  v_base_late := coalesce(
    nullif(v_result #>> '{summary,completedLate}', '')::integer,
    0
  );
  v_summary := coalesce(v_result -> 'summary', '{}'::jsonb)
    || jsonb_build_object(
      'totalEvents', coalesce(
        nullif(v_result #>> '{summary,totalEvents}', '')::integer,
        0
      ) + v_history_total,
      'completedOnTime', v_base_on_time + v_history_on_time,
      'completedLate', v_base_late + v_history_late,
      'adherencePercent', coalesce(round(
        100.0 * (v_base_on_time + v_history_on_time)
        / nullif(
          v_base_on_time + v_history_on_time
          + v_base_late + v_history_late,
          0
        )
      ), 0)
    );

  return pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(v_result, '{events}', v_events, true),
    '{summary}',
    v_summary,
    true
  );
end;
$$;

revoke all on function public.v3_tenant_customer_history_snapshot(
  text, uuid, integer
) from public, anon;

grant execute on function public.v3_tenant_customer_history_snapshot(
  text, uuid, integer
) to authenticated, service_role;

comment on table work_core.task_history is
'Append-only task transition history. Calendar dates move on one task row; previous dates remain here for audit and customer history.';

comment on function public.v3_tenant_transition_task(
  text, uuid, text, timestamptz, text
) is
'Atomically changes the assigned task row for any tenant role and records its previous state through the task-history trigger.';

comment on function public.v2_tenant_record_sales_followup_v5(
  text, uuid, text, text, text, text, text, timestamptz, uuid, uuid,
  bigint, text, date, text, text, uuid
) is
'Binds a calendar customer action to the exact open follow-up task id, preventing POST-style duplicate task creation.';

commit;
