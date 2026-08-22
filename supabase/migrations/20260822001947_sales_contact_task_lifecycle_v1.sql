-- Keep the sales calendar aligned with the customer lifecycle without
-- deleting or duplicating the original task row.
begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('sales-contact-task-lifecycle-v1', 31604)
);

-- Every real customer activity resolves the currently scheduled sales task.
-- The next action flow may reopen the same row later in the same transaction.
create or replace function private_app.complete_customer_followup_tasks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_completed_at timestamptz;
begin
  if new.activity_type = 'note'
     and new.metadata ->> 'source' = 'lead_reassignment_audit'
  then
    return new;
  end if;

  update work_core.tasks task
  set status = 'completed',
      activity_id = new.id,
      completed_at = greatest(new.occurred_at, task.created_at),
      completion_timing = case
        when greatest(new.occurred_at, task.created_at) <= task.due_at
          then 'on_time'
        else 'late'
      end,
      metadata = (
        task.metadata - 'cancelReason'
      ) || jsonb_strip_nulls(jsonb_build_object(
        'resolvedByActivityId', new.id,
        'completedBySubjectId', new.created_by_subject_id,
        'terminalLeadStatus', new.result_status,
        'lastTransition', jsonb_strip_nulls(jsonb_build_object(
          'fromStatus', task.status,
          'toStatus', 'completed',
          'fromDueAt', task.due_at,
          'toDueAt', task.due_at,
          'actorSubjectId', new.created_by_subject_id,
          'at', greatest(new.occurred_at, task.created_at),
          'mode', 'sales_activity_resolution_v2',
          'note', 'إغلاق مهمة المبيعات بعد تسجيل نتيجة التواصل'
        ))
      ))
  where task.tenant_id = new.tenant_id
    and task.contact_id = new.contact_id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    );

  return new;
end;
$$;

revoke all on function private_app.complete_customer_followup_tasks()
from public, anon, authenticated;

-- Keep v4 compatible with phone-off and do not overwrite task provenance after
-- the activity trigger has already completed the selected row.
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
    'phone_off',
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
     and v_contact.owner_staff_id is distinct from v_current_staff_id
  then
    raise exception 'forbidden';
  end if;

  v_is_open := p_lead_status in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
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
        ))
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
    update work_core.tasks task
    set status = 'completed',
        activity_id = v_activity_id,
        completed_at = now(),
        completion_timing = case
          when v_previous_due_at < now() then 'late'
          else 'on_time'
        end,
        metadata = (
          task.metadata - 'cancelReason'
        ) || jsonb_strip_nulls(jsonb_build_object(
          'resolvedByActivityId', v_activity_id,
          'completedBySubjectId', private_app.current_subject_id(),
          'taskUpdateMode', 'single_calendar_record_v2',
          'lastResolvedAt', now(),
          'lastTransition', jsonb_build_object(
            'fromStatus', task.status,
            'toStatus', 'completed',
            'fromDueAt', task.due_at,
            'toDueAt', task.due_at,
            'actorSubjectId', private_app.current_subject_id(),
            'at', now(),
            'mode', 'sales_followup_terminal_v2',
            'note', 'إغلاق مهمة المبيعات بعد تسجيل نتيجة نهائية'
          )
        ))
    where task.id = v_followup_task.id
      and task.tenant_id = v_tenant_id
      and task.status in ('todo', 'in_progress');
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

-- V5 is the sole authenticated entry point. It locks contact before task to
-- match admissions, and normalizes the unqualified quality/status pair before
-- invoking lower lifecycle functions.
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
  v_lead_status text := p_lead_status;
  v_lead_quality text := coalesce(p_lead_quality, 'unrated');
  v_closure_reason text := p_closure_reason;
  v_normalized boolean := false;
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

  if v_lead_quality = 'unqualified'
     and v_lead_status in (
       'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
       'interested', 'very_interested', 'awaiting_payment', 'postponed'
     )
  then
    v_lead_status := 'unqualified';
    v_closure_reason := coalesce(
      nullif(trim(v_closure_reason), ''),
      'جودة العميل غير مؤهل'
    );
    v_normalized := true;
  elsif v_lead_status = 'unqualified'
        and v_lead_quality <> 'unqualified'
  then
    v_lead_quality := 'unqualified';
    v_normalized := true;
  elsif v_lead_quality = 'unqualified'
        and v_lead_status in ('payment_submitted', 'paid')
  then
    raise exception 'unqualified_quality_requires_closed_status';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_tenant_id::text || ':' || p_contact_id::text,
      31603
    )
  );

  perform contact.id
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if not found then raise exception 'invalid_contact'; end if;

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
    p_lead_status => v_lead_status,
    p_lead_quality => v_lead_quality,
    p_next_action_type => case
      when v_lead_status in (
        'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
        'interested', 'very_interested', 'awaiting_payment', 'postponed'
      ) then p_next_action_type
      else null
    end,
    p_next_action_at => case
      when v_lead_status in (
        'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
        'interested', 'very_interested', 'awaiting_payment', 'postponed'
      ) then p_next_action_at
      else null
    end,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => v_closure_reason,
    p_contact_name => p_contact_name
  );

  if p_task_id is not null then
    v_result_task_id := nullif(coalesce(
      v_result ->> 'followupTaskId',
      v_result ->> 'taskId'
    ), '')::uuid;
    if v_result_task_id is distinct from p_task_id then
      raise exception 'task_transition_conflict';
    end if;
  end if;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'selectedTaskId', p_task_id,
    'taskUpdateMode', 'bound_task_id_v5',
    'lifecycleNormalized', v_normalized,
    'normalizedLeadStatus', case when v_normalized then v_lead_status end,
    'normalizedLeadQuality', case when v_normalized then v_lead_quality end
  ));
end;
$$;

revoke all on function public.v2_tenant_record_sales_followup_v2(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date, text
) from public, anon, authenticated;
revoke all on function public.v2_tenant_record_sales_followup_v3(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date, text, text
) from public, anon, authenticated;
revoke all on function public.v2_tenant_record_sales_followup_v4(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date, text, text
) from public, anon, authenticated;

revoke all on function public.v2_tenant_record_sales_followup_v5(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date, text, text, uuid
) from public, anon;
grant execute on function public.v2_tenant_record_sales_followup_v5(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date, text, text, uuid
) to authenticated, service_role;

-- Build a deterministic, historical plan before mutating any production row.
create temporary table sales_contact_quality_plan_v1 (
  tenant_id uuid not null,
  contact_id uuid primary key,
  previous_lead_status text not null,
  activity_id uuid,
  actor_subject_id uuid,
  resolution_at timestamptz not null
) on commit drop;

insert into sales_contact_quality_plan_v1 (
  tenant_id,
  contact_id,
  previous_lead_status,
  activity_id,
  actor_subject_id,
  resolution_at
)
select
  contact.tenant_id,
  contact.id,
  contact.lead_status,
  quality_event.id,
  quality_event.created_by_subject_id,
  coalesce(
    quality_event.occurred_at,
    contact.updated_at,
    contact.lead_status_changed_at,
    contact.created_at,
    transaction_timestamp()
  )
from sales_core.contacts contact
left join lateral (
  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  from sales_core.activities activity
  where activity.tenant_id = contact.tenant_id
    and activity.contact_id = contact.id
    and activity.result_quality = 'unqualified'
  order by activity.occurred_at desc, activity.id desc
  limit 1
) quality_event on true
where contact.lead_quality = 'unqualified'
  and contact.lead_status in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'postponed'
  );

create temporary table sales_task_lifecycle_plan_v1 (
  task_id uuid primary key,
  tenant_id uuid not null,
  contact_id uuid not null,
  previous_lead_status text not null,
  target_lead_status text not null,
  resolution_kind text not null,
  activity_id uuid,
  actor_subject_id uuid,
  resolution_at timestamptz not null,
  completed_at timestamptz not null,
  completion_timing text not null
) on commit drop;

insert into sales_task_lifecycle_plan_v1 (
  task_id,
  tenant_id,
  contact_id,
  previous_lead_status,
  target_lead_status,
  resolution_kind,
  activity_id,
  actor_subject_id,
  resolution_at,
  completed_at,
  completion_timing
)
select
  task.id,
  task.tenant_id,
  contact.id,
  contact.lead_status,
  case when quality_plan.contact_id is not null
    then 'unqualified' else contact.lead_status end,
  case when quality_plan.contact_id is not null
    then 'unqualified_quality' else 'terminal_lead_status' end,
  coalesce(quality_plan.activity_id, terminal_event.activity_id),
  coalesce(
    quality_plan.actor_subject_id,
    terminal_event.actor_subject_id
  ),
  resolution.resolution_at,
  greatest(resolution.resolution_at, task.created_at),
  case
    when greatest(resolution.resolution_at, task.created_at) <= task.due_at
      then 'on_time'
    else 'late'
  end
from work_core.tasks task
join sales_core.contacts contact
  on contact.tenant_id = task.tenant_id
 and contact.id = task.contact_id
left join sales_contact_quality_plan_v1 quality_plan
  on quality_plan.tenant_id = contact.tenant_id
 and quality_plan.contact_id = contact.id
left join lateral (
  select
    history.activity_id,
    coalesce(
      activity.occurred_at,
      history.changed_at
    ) as occurred_at,
    coalesce(
      activity.created_by_subject_id,
      history.changed_by_subject_id
    ) as actor_subject_id
  from sales_core.lead_status_history history
  left join sales_core.activities activity
    on activity.tenant_id = history.tenant_id
   and activity.id = history.activity_id
  where history.tenant_id = contact.tenant_id
    and history.contact_id = contact.id
    and history.to_status = contact.lead_status
  order by history.changed_at desc, history.id desc
  limit 1
) terminal_event on true
cross join lateral (
  select coalesce(
    quality_plan.resolution_at,
    terminal_event.occurred_at,
    case when contact.lead_status = 'payment_submitted'
      then contact.payment_submitted_at end,
    case when contact.lead_status in (
      'not_interested', 'unqualified', 'wrong_number',
      'duplicate', 'cancelled'
    ) then contact.closed_at end,
    contact.lead_status_changed_at,
    contact.last_activity_at,
    contact.updated_at,
    contact.created_at,
    transaction_timestamp()
  ) as resolution_at
) resolution
where task.status in ('todo', 'in_progress')
  and coalesce(task.metadata ->> 'source', '') in (
    'lead_assignment',
    'opportunity_next_action',
    'activity_next_action',
    'lead_next_action',
    'sales_followup'
  )
  and (
    quality_plan.contact_id is not null
    or contact.lead_status in (
      'payment_submitted',
      'paid',
      'not_interested',
      'unqualified',
      'wrong_number',
      'duplicate',
      'cancelled'
    )
  );

-- Preserve a lead-status history event for every historical quality mismatch.
insert into sales_core.lead_status_history (
  tenant_id,
  contact_id,
  activity_id,
  from_status,
  to_status,
  reason,
  changed_by_subject_id,
  metadata,
  changed_at
)
select
  plan.tenant_id,
  plan.contact_id,
  plan.activity_id,
  plan.previous_lead_status,
  'unqualified',
  'تسوية تلقائية: جودة العميل غير مؤهل',
  plan.actor_subject_id,
  jsonb_build_object(
    'source', 'sales_contact_task_lifecycle_v1',
    'reconciled', true
  ),
  plan.resolution_at
from sales_contact_quality_plan_v1 plan
where not exists (
  select 1
  from sales_core.lead_status_history history
  where history.tenant_id = plan.tenant_id
    and history.contact_id = plan.contact_id
    and history.metadata ->> 'source' =
      'sales_contact_task_lifecycle_v1'
);

update sales_core.contacts contact
set status = 'unqualified',
    lead_status = 'unqualified',
    next_action_type = null,
    next_action_at = null,
    lead_status_changed_at = plan.resolution_at,
    closure_reason = coalesce(
      nullif(trim(contact.closure_reason), ''),
      'جودة العميل غير مؤهل'
    ),
    closed_at = plan.resolution_at,
    metadata = contact.metadata || jsonb_build_object(
      'salesLifecycleReconciliation', jsonb_build_object(
        'version', 'sales_contact_task_lifecycle_v1',
        'reason', 'unqualified_quality',
        'resolvedAt', plan.resolution_at
      )
    )
from sales_contact_quality_plan_v1 plan
where contact.tenant_id = plan.tenant_id
  and contact.id = plan.contact_id;

with latest_open_opportunity as (
  select distinct on (opportunity.tenant_id, opportunity.contact_id)
    opportunity.id,
    stage.id as lost_stage_id,
    plan.resolution_at
  from sales_core.opportunities opportunity
  join sales_contact_quality_plan_v1 plan
    on plan.tenant_id = opportunity.tenant_id
   and plan.contact_id = opportunity.contact_id
  join sales_core.pipeline_stages stage
    on stage.tenant_id = opportunity.tenant_id
   and stage.stage_key = 'lost'
  where opportunity.status in ('open', 'pending_verification')
  order by
    opportunity.tenant_id,
    opportunity.contact_id,
    opportunity.updated_at desc,
    opportunity.created_at desc,
    opportunity.id desc
)
update sales_core.opportunities opportunity
set stage_id = target.lost_stage_id,
    status = 'lost',
    next_action_type = null,
    next_action_at = null,
    lost_reason = coalesce(
      nullif(trim(opportunity.lost_reason), ''),
      'جودة العميل غير مؤهل'
    ),
    metadata = opportunity.metadata || jsonb_build_object(
      'salesLifecycleReconciliation', jsonb_build_object(
        'version', 'sales_contact_task_lifecycle_v1',
        'resolvedAt', target.resolution_at
      )
    )
from latest_open_opportunity target
where opportunity.id = target.id;

update work_core.tasks task
set status = 'completed',
    activity_id = coalesce(plan.activity_id, task.activity_id),
    completed_at = plan.completed_at,
    completion_timing = plan.completion_timing,
    metadata = (
      task.metadata - 'cancelReason'
    ) || jsonb_strip_nulls(jsonb_build_object(
      'resolvedByActivityId', plan.activity_id,
      'completedBySubjectId', plan.actor_subject_id,
      'salesLifecycleResolution', jsonb_build_object(
        'version', 'sales_contact_task_lifecycle_v1',
        'kind', plan.resolution_kind,
        'leadStatus', plan.target_lead_status,
        'resolvedAt', plan.completed_at
      ),
      'lastTransition', jsonb_strip_nulls(jsonb_build_object(
        'fromStatus', task.status,
        'toStatus', 'completed',
        'fromDueAt', task.due_at,
        'toDueAt', task.due_at,
        'actorSubjectId', plan.actor_subject_id,
        'at', plan.completed_at,
        'mode', 'sales_lifecycle_reconciliation_v1',
        'note', case plan.resolution_kind
          when 'unqualified_quality'
            then 'إغلاق تاريخي: جودة العميل غير مؤهل'
          else 'إغلاق تاريخي بعد وصول العميل إلى حالة نهائية'
        end
      ))
    ))
from sales_task_lifecycle_plan_v1 plan
where task.id = plan.task_id
  and task.tenant_id = plan.tenant_id
  and task.status in ('todo', 'in_progress');

-- Link historical activities to the same task row when the old data omitted it.
update sales_core.activities activity
set metadata = activity.metadata || jsonb_build_object(
      'scheduledTaskId', plan.task_id,
      'scheduledAt', task.due_at,
      'taskLifecycleReconciled', true
    )
from sales_task_lifecycle_plan_v1 plan
join work_core.tasks task on task.id = plan.task_id
where activity.tenant_id = plan.tenant_id
  and activity.id = plan.activity_id
  and nullif(activity.metadata ->> 'scheduledTaskId', '') is null;

-- The update trigger wrote history at migration time. Correct that one event to
-- the real business timestamp and actor retained in the reconciliation plan.
update work_core.task_history history
set actor_subject_id = plan.actor_subject_id,
    note = case plan.resolution_kind
      when 'unqualified_quality'
        then 'إغلاق تاريخي: جودة العميل غير مؤهل'
      else 'إغلاق تاريخي بعد وصول العميل إلى حالة نهائية'
    end,
    metadata = history.metadata || jsonb_build_object(
      'reconciliationVersion', 'sales_contact_task_lifecycle_v1',
      'resolutionKind', plan.resolution_kind
    ),
    changed_at = plan.completed_at
from sales_task_lifecycle_plan_v1 plan
where history.task_id = plan.task_id
  and history.tenant_id = plan.tenant_id
  and history.previous_status in ('todo', 'in_progress')
  and history.next_status = 'completed'
  and history.metadata #>> '{transition,mode}' =
    'sales_lifecycle_reconciliation_v1';

-- Enforce the business rule after legacy rows have been normalized.
do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname =
      'contacts_unqualified_quality_closed_check'
      and constraint_row.conrelid = 'sales_core.contacts'::regclass
  ) then
    alter table sales_core.contacts
    add constraint contacts_unqualified_quality_closed_check
    check (
      lead_quality <> 'unqualified'
      or lead_status not in (
        'new',
        'no_answer',
        'busy',
        'phone_off',
        'follow_up',
        'interested',
        'very_interested',
        'awaiting_payment',
        'postponed'
      )
    ) not valid;
  end if;
end;
$constraint$;

alter table sales_core.contacts
validate constraint contacts_unqualified_quality_closed_check;

-- Fallback for admissions, integrations, and any writer that changes the
-- customer status without going through the sales follow-up RPC.
create or replace function private_app.complete_terminal_contact_sales_tasks_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity_id uuid;
  v_actor_subject_id uuid;
  v_terminal_at timestamptz;
begin
  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  into
    v_activity_id,
    v_actor_subject_id,
    v_terminal_at
  from sales_core.activities activity
  where activity.tenant_id = new.tenant_id
    and activity.contact_id = new.id
    and activity.result_status = new.lead_status
  order by activity.occurred_at desc, activity.id desc
  limit 1;

  v_terminal_at := coalesce(
    v_terminal_at,
    case when new.lead_status = 'payment_submitted'
      then new.payment_submitted_at end,
    case when new.lead_status in (
      'not_interested', 'unqualified', 'wrong_number',
      'duplicate', 'cancelled'
    ) then new.closed_at end,
    new.lead_status_changed_at,
    new.last_activity_at,
    clock_timestamp()
  );

  update work_core.tasks task
  set status = 'completed',
      activity_id = coalesce(v_activity_id, task.activity_id),
      completed_at = greatest(v_terminal_at, task.created_at),
      completion_timing = case
        when greatest(v_terminal_at, task.created_at) <= task.due_at
          then 'on_time'
        else 'late'
      end,
      metadata = (
        task.metadata - 'cancelReason'
      ) || jsonb_strip_nulls(jsonb_build_object(
        'resolvedByActivityId', v_activity_id,
        'completedBySubjectId', v_actor_subject_id,
        'terminalLeadStatus', new.lead_status,
        'salesLifecycleResolution', jsonb_build_object(
          'version', 'sales_contact_task_lifecycle_v1',
          'kind', 'terminal_contact_fallback',
          'leadStatus', new.lead_status,
          'resolvedAt', greatest(v_terminal_at, task.created_at)
        ),
        'lastTransition', jsonb_strip_nulls(jsonb_build_object(
          'fromStatus', task.status,
          'toStatus', 'completed',
          'fromDueAt', task.due_at,
          'toDueAt', task.due_at,
          'actorSubjectId', v_actor_subject_id,
          'at', greatest(v_terminal_at, task.created_at),
          'mode', 'terminal_contact_fallback_v1',
          'note', 'إغلاق مهمة المبيعات بعد وصول العميل إلى حالة نهائية'
        ))
      ))
  where task.tenant_id = new.tenant_id
    and task.contact_id = new.id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    );

  return new;
end;
$$;

revoke all on function
private_app.complete_terminal_contact_sales_tasks_v1()
from public, anon, authenticated;

drop trigger if exists complete_terminal_contact_sales_tasks_after_update
on sales_core.contacts;
create trigger complete_terminal_contact_sales_tasks_after_update
after update of lead_status on sales_core.contacts
for each row
when (
  old.lead_status is distinct from new.lead_status
  and new.lead_status in (
    'payment_submitted',
    'paid',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  )
)
execute function private_app.complete_terminal_contact_sales_tasks_v1();

-- Prevent a later insert from reopening a sales task for a terminal customer.
-- FOR SHARE closes the insert/update race while keeping contact -> task lock order.
create or replace function private_app.guard_terminal_contact_sales_task_insert_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact sales_core.contacts%rowtype;
  v_activity_id uuid;
  v_actor_subject_id uuid;
  v_terminal_at timestamptz;
begin
  if new.status not in ('todo', 'in_progress')
     or new.contact_id is null
     or coalesce(new.metadata ->> 'source', '') not in (
       'lead_assignment',
       'opportunity_next_action',
       'activity_next_action',
       'lead_next_action',
       'sales_followup'
     )
  then
    return new;
  end if;

  select contact.*
  into v_contact
  from sales_core.contacts contact
  where contact.tenant_id = new.tenant_id
    and contact.id = new.contact_id
  for share;

  if v_contact.id is null
     or v_contact.lead_status not in (
       'payment_submitted',
       'paid',
       'not_interested',
       'unqualified',
       'wrong_number',
       'duplicate',
       'cancelled'
     )
  then
    return new;
  end if;

  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  into
    v_activity_id,
    v_actor_subject_id,
    v_terminal_at
  from sales_core.activities activity
  where activity.tenant_id = new.tenant_id
    and activity.contact_id = new.contact_id
    and activity.result_status = v_contact.lead_status
  order by activity.occurred_at desc, activity.id desc
  limit 1;

  v_terminal_at := greatest(
    coalesce(
      v_terminal_at,
      case when v_contact.lead_status = 'payment_submitted'
        then v_contact.payment_submitted_at end,
      case when v_contact.lead_status in (
        'not_interested', 'unqualified', 'wrong_number',
        'duplicate', 'cancelled'
      ) then v_contact.closed_at end,
      v_contact.lead_status_changed_at,
      v_contact.last_activity_at,
      clock_timestamp()
    ),
    coalesce(new.created_at, clock_timestamp())
  );

  new.status := 'completed';
  new.activity_id := coalesce(v_activity_id, new.activity_id);
  new.completed_at := v_terminal_at;
  new.completion_timing := case
    when v_terminal_at <= new.due_at then 'on_time'
    else 'late'
  end;
  new.metadata := (
    new.metadata - 'cancelReason'
  ) || jsonb_strip_nulls(jsonb_build_object(
    'resolvedByActivityId', v_activity_id,
    'completedBySubjectId', v_actor_subject_id,
    'terminalLeadStatus', v_contact.lead_status,
    'salesLifecycleResolution', jsonb_build_object(
      'version', 'sales_contact_task_lifecycle_v1',
      'kind', 'terminal_contact_insert_guard',
      'leadStatus', v_contact.lead_status,
      'resolvedAt', v_terminal_at
    )
  ));

  return new;
end;
$$;

revoke all on function
private_app.guard_terminal_contact_sales_task_insert_v1()
from public, anon, authenticated;

drop trigger if exists guard_terminal_contact_sales_task_before_insert
on work_core.tasks;
create trigger guard_terminal_contact_sales_task_before_insert
before insert on work_core.tasks
for each row
execute function private_app.guard_terminal_contact_sales_task_insert_v1();

insert into audit_log.events (
  tenant_id,
  actor_subject_id,
  action,
  resource_type,
  resource_id,
  context
)
select
  plan.tenant_id,
  null,
  'tenant.sales_task_lifecycle_reconciled',
  'sales_task_lifecycle',
  plan.tenant_id::text,
  jsonb_build_object(
    'version', 'sales_contact_task_lifecycle_v1',
    'tasksCompleted', count(*),
    'completedOnTime', count(*) filter (
      where plan.completion_timing = 'on_time'
    ),
    'completedLate', count(*) filter (
      where plan.completion_timing = 'late'
    ),
    'unqualifiedQualityTasks', count(*) filter (
      where plan.resolution_kind = 'unqualified_quality'
    )
  )
from sales_task_lifecycle_plan_v1 plan
group by plan.tenant_id;

comment on function
private_app.complete_terminal_contact_sales_tasks_v1() is
'Closes only open sales-source tasks when a contact reaches a terminal sales state.';
comment on function
private_app.guard_terminal_contact_sales_task_insert_v1() is
'Prevents a new open sales-source task for an already terminal contact; downstream registration tasks are excluded.';
comment on constraint contacts_unqualified_quality_closed_check
on sales_core.contacts is
'Unqualified quality cannot coexist with an open sales lead status.';

commit;
