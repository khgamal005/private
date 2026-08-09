begin;

-- A distributed lead starts with a `lead_assignment` task. That row is the
-- same customer follow-up lifecycle as the later `sales_followup` task and
-- must move on the calendar instead of being duplicated.

create temporary table followup_task_merge_plan_v2
on commit drop
as
with lead_tasks as (
  select task.*
  from work_core.tasks task
  where task.contact_id is not null
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
), duplicate_chains as (
  select task.tenant_id, task.contact_id
  from lead_tasks task
  group by task.tenant_id, task.contact_id
  having count(*) > 1
), canonical_tasks as (
  select distinct on (task.tenant_id, task.contact_id)
    task.tenant_id,
    task.contact_id,
    task.id as canonical_task_id
  from lead_tasks task
  join duplicate_chains chain
    on chain.tenant_id = task.tenant_id
   and chain.contact_id = task.contact_id
  left join sales_core.lead_assignments assignment
    on assignment.tenant_id = task.tenant_id
   and assignment.contact_id = task.contact_id
   and assignment.task_id = task.id
  order by
    task.tenant_id,
    task.contact_id,
    (assignment.task_id is not null) desc,
    task.created_at,
    task.id
), authoritative_tasks as (
  select distinct on (task.tenant_id, task.contact_id)
    task.tenant_id,
    task.contact_id,
    task.id as authoritative_task_id,
    to_jsonb(task) as authoritative_record
  from lead_tasks task
  join duplicate_chains chain
    on chain.tenant_id = task.tenant_id
   and chain.contact_id = task.contact_id
  join sales_core.contacts contact
    on contact.tenant_id = task.tenant_id
   and contact.id = task.contact_id
  order by
    task.tenant_id,
    task.contact_id,
    (task.status in ('todo', 'in_progress')) desc,
    (
      contact.next_action_at is not null
      and task.due_at = contact.next_action_at
    ) desc,
    (task.metadata ->> 'source' = 'sales_followup') desc,
    task.updated_at desc,
    task.due_at desc,
    task.id
)
select
  canonical.tenant_id,
  canonical.contact_id,
  canonical.canonical_task_id,
  authoritative.authoritative_task_id,
  authoritative.authoritative_record,
  array(
    select duplicate.id
    from lead_tasks duplicate
    where duplicate.tenant_id = canonical.tenant_id
      and duplicate.contact_id = canonical.contact_id
      and duplicate.id <> canonical.canonical_task_id
    order by duplicate.created_at, duplicate.id
  )::uuid[] as duplicate_task_ids
from canonical_tasks canonical
join authoritative_tasks authoritative
  on authoritative.tenant_id = canonical.tenant_id
 and authoritative.contact_id = canonical.contact_id;

insert into audit_log.followup_task_merge_archive (
  original_task_id,
  canonical_task_id,
  tenant_id,
  contact_id,
  original_record,
  reason
)
select
  task.id,
  plan.canonical_task_id,
  task.tenant_id,
  task.contact_id,
  to_jsonb(task),
  'lead_assignment_followup_duplicate_v2'
from followup_task_merge_plan_v2 plan
join work_core.tasks task
  on task.id = any(plan.duplicate_task_ids)
on conflict (original_task_id) do nothing;

update sales_core.activities activity
set metadata = activity.metadata || jsonb_build_object(
      'originalScheduledTaskId', activity.metadata ->> 'scheduledTaskId',
      'scheduledTaskId', plan.canonical_task_id,
      'taskMergeVersion', 'single_calendar_record_v2'
    )
from followup_task_merge_plan_v2 plan
where activity.tenant_id = plan.tenant_id
  and exists (
    select 1
    from unnest(plan.duplicate_task_ids) duplicate_task_id
    where duplicate_task_id::text = activity.metadata ->> 'scheduledTaskId'
  );

update sales_core.lead_assignments assignment
set task_id = plan.canonical_task_id
from followup_task_merge_plan_v2 plan
where assignment.tenant_id = plan.tenant_id
  and assignment.contact_id = plan.contact_id
  and assignment.task_id = any(plan.duplicate_task_ids);

update audit_log.events event
set context = pg_catalog.jsonb_set(
      event.context,
      '{taskId}',
      to_jsonb(plan.canonical_task_id),
      true
    ) || jsonb_build_object(
      'mergedDuplicateTaskId', event.context ->> 'taskId',
      'taskMergeVersion', 'single_calendar_record_v2'
    )
from followup_task_merge_plan_v2 plan
where event.tenant_id = plan.tenant_id
  and exists (
    select 1
    from unnest(plan.duplicate_task_ids) duplicate_task_id
    where duplicate_task_id::text = event.context ->> 'taskId'
  );

delete from work_core.tasks task
using followup_task_merge_plan_v2 plan
where task.id = any(plan.duplicate_task_ids);

update work_core.tasks task
set title = plan.authoritative_record ->> 'title',
    description = plan.authoritative_record ->> 'description',
    status = plan.authoritative_record ->> 'status',
    priority = plan.authoritative_record ->> 'priority',
    assigned_staff_id = nullif(
      plan.authoritative_record ->> 'assigned_staff_id',
      ''
    )::uuid,
    opportunity_id = nullif(
      plan.authoritative_record ->> 'opportunity_id',
      ''
    )::uuid,
    activity_id = nullif(
      plan.authoritative_record ->> 'activity_id',
      ''
    )::uuid,
    starts_at = nullif(
      plan.authoritative_record ->> 'starts_at',
      ''
    )::timestamptz,
    due_at = (
      plan.authoritative_record ->> 'due_at'
    )::timestamptz,
    completed_at = nullif(
      plan.authoritative_record ->> 'completed_at',
      ''
    )::timestamptz,
    completion_timing = plan.authoritative_record ->> 'completion_timing',
    metadata = (
      task.metadata
      || coalesce(plan.authoritative_record -> 'metadata', '{}'::jsonb)
    ) || jsonb_build_object(
      'source', 'sales_followup',
      'taskUpdateMode', 'single_calendar_record_v2',
      'mergedTaskIds', to_jsonb(plan.duplicate_task_ids),
      'lastConsolidatedAt', now()
    ),
    updated_at = now()
from followup_task_merge_plan_v2 plan
where task.id = plan.canonical_task_id;

drop index if exists work_core.work_tasks_one_open_sales_followup_idx;

create unique index work_tasks_one_open_sales_followup_idx
on work_core.tasks (tenant_id, contact_id)
where contact_id is not null
  and status in ('todo', 'in_progress')
  and coalesce(metadata ->> 'source', '') in (
    'lead_assignment',
    'opportunity_next_action',
    'activity_next_action',
    'lead_next_action',
    'sales_followup'
  );

create or replace function public.v2_tenant_record_sales_followup_v4(
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
  p_contact_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_is_open boolean;
  v_followup_task work_core.tasks%rowtype;
  v_previous_due_at timestamptz;
  v_result jsonb;
  v_activity_id uuid;
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
  if p_lead_status not in (
    'new',
    'no_answer',
    'busy',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'payment_submitted',
    'postponed',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ) then raise exception 'invalid_lead_status'; end if;

  select contact.*
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  v_is_open := p_lead_status in (
    'new',
    'no_answer',
    'busy',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'postponed'
  );

  if v_is_open and (
    p_next_action_type is null
    or p_next_action_at is null
  ) then raise exception 'next_action_required'; end if;

  select task.*
  into v_followup_task
  from work_core.tasks task
  where task.tenant_id = v_tenant_id
    and task.contact_id = p_contact_id
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
  order by
    (task.status in ('todo', 'in_progress')) desc,
    (
      v_contact.next_action_at is not null
      and task.due_at = v_contact.next_action_at
    ) desc,
    (task.metadata ->> 'source' = 'sales_followup') desc,
    task.updated_at desc,
    task.id
  limit 1
  for update;

  v_previous_due_at := v_followup_task.due_at;

  if v_is_open and v_followup_task.id is not null then
    update work_core.tasks
    set status = 'todo',
        due_at = p_next_action_at,
        completed_at = null,
        completion_timing = null,
        metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
          'source', 'sales_followup',
          'originalSource', coalesce(
            metadata ->> 'originalSource',
            metadata ->> 'source'
          ),
          'taskUpdateMode', 'single_calendar_record_v2'
        )),
        updated_at = now()
    where id = v_followup_task.id
      and tenant_id = v_tenant_id;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v3(
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

  v_activity_id := nullif(v_result ->> 'id', '')::uuid;

  if v_followup_task.id is not null then
    update sales_core.activities activity
    set metadata = activity.metadata || jsonb_strip_nulls(jsonb_build_object(
          'scheduledTaskId', v_followup_task.id,
          'scheduledAt', v_previous_due_at,
          'taskUpdateMode', 'single_calendar_record_v2'
        ))
    where activity.id = v_activity_id
      and activity.tenant_id = v_tenant_id;
  end if;

  if not v_is_open and v_followup_task.id is not null then
    update work_core.tasks
    set status = 'completed',
        activity_id = v_activity_id,
        completed_at = now(),
        completion_timing = case
          when v_previous_due_at < now() then 'late'
          else 'on_time'
        end,
        metadata = (
          metadata
          - 'cancelReason'
        ) || jsonb_build_object(
          'source', 'sales_followup',
          'resolvedByActivityId', v_activity_id,
          'completedBySubjectId', private_app.current_subject_id(),
          'taskUpdateMode', 'single_calendar_record_v2',
          'lastResolvedAt', now()
        ),
        updated_at = now()
    where id = v_followup_task.id
      and tenant_id = v_tenant_id;
  end if;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'followupTaskId', coalesce(
      case when v_is_open then v_result ->> 'taskId' end,
      v_followup_task.id::text
    ),
    'taskClosed', not v_is_open and v_followup_task.id is not null,
    'previousDueAt', v_previous_due_at,
    'nextDueAt', case when v_is_open then p_next_action_at end
  ));
end;
$$;

revoke all on function public.v2_tenant_record_sales_followup_v4(
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
  text
) from public, anon;

grant execute on function public.v2_tenant_record_sales_followup_v4(
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
  text
) to authenticated, service_role;

comment on function public.v2_tenant_record_sales_followup_v4(
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
  text
) is
'Moves the single lead-assignment/follow-up task to the next action date while preserving activities as immutable customer history.';

commit;
