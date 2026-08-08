begin;

-- Keep one mutable calendar task per active customer follow-up while the
-- immutable sales activity stream remains the customer history.

create table if not exists audit_log.followup_task_merge_archive (
  original_task_id uuid primary key,
  canonical_task_id uuid not null,
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  contact_id uuid not null,
  original_record jsonb not null,
  reason text not null default 'duplicate_followup_task_chain',
  archived_at timestamptz not null default now()
);

create index if not exists followup_task_merge_archive_tenant_contact_idx
on audit_log.followup_task_merge_archive (
  tenant_id,
  contact_id,
  archived_at desc
);

alter table audit_log.followup_task_merge_archive
enable row level security;

revoke all on table audit_log.followup_task_merge_archive
from public, anon, authenticated;

create temporary table followup_task_merge_plan
on commit drop
as
with open_followups as (
  select task.*
  from work_core.tasks task
  where task.contact_id is not null
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
), historical_followups as (
  select task.*
  from work_core.tasks task
  join open_followups current_task
    on current_task.tenant_id = task.tenant_id
   and current_task.contact_id = task.contact_id
   and current_task.id <> task.id
  where task.status in ('completed', 'cancelled')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
    and (
      task.metadata ? 'resolvedByActivityId'
      or task.metadata ->> 'cancelReason' in (
        'superseded_by_sales_outcome',
        'duplicate_open_sales_followup'
      )
    )
), canonical_tasks as (
  select distinct on (task.tenant_id, task.contact_id)
    task.tenant_id,
    task.contact_id,
    task.id as canonical_task_id
  from historical_followups task
  order by
    task.tenant_id,
    task.contact_id,
    task.created_at,
    task.due_at,
    task.id
)
select
  current_task.tenant_id,
  current_task.contact_id,
  canonical.canonical_task_id,
  current_task.id as active_task_id,
  to_jsonb(current_task) as active_task_record,
  array_append(
    array(
      select historical.id
      from historical_followups historical
      where historical.tenant_id = current_task.tenant_id
        and historical.contact_id = current_task.contact_id
        and historical.id <> canonical.canonical_task_id
      order by historical.created_at, historical.id
    ),
    current_task.id
  )::uuid[] as merged_task_ids
from open_followups current_task
join canonical_tasks canonical
  on canonical.tenant_id = current_task.tenant_id
 and canonical.contact_id = current_task.contact_id;

-- Move the old planned time to the immutable activity before consolidating
-- task rows, so customer timing history remains exact.
update sales_core.activities activity
set metadata = activity.metadata || jsonb_build_object(
      'scheduledTaskId', task.id,
      'scheduledAt', task.due_at,
      'taskUpdateMode', 'single_record_migration'
    )
from work_core.tasks task
join followup_task_merge_plan plan
  on plan.tenant_id = task.tenant_id
 and plan.contact_id = task.contact_id
where task.metadata ->> 'resolvedByActivityId' = activity.id::text
  and activity.tenant_id = task.tenant_id;

insert into audit_log.followup_task_merge_archive (
  original_task_id,
  canonical_task_id,
  tenant_id,
  contact_id,
  original_record
)
select
  task.id,
  plan.canonical_task_id,
  task.tenant_id,
  task.contact_id,
  to_jsonb(task)
from followup_task_merge_plan plan
join work_core.tasks task
  on task.id = any(plan.merged_task_ids)
on conflict (original_task_id) do nothing;

update sales_core.lead_assignments assignment
set task_id = plan.canonical_task_id
from followup_task_merge_plan plan
where assignment.task_id = any(plan.merged_task_ids);

update audit_log.events event
set context = pg_catalog.jsonb_set(
      event.context,
      '{taskId}',
      to_jsonb(plan.canonical_task_id),
      true
    ) || jsonb_build_object(
      'mergedDuplicateTaskId', event.context ->> 'taskId',
      'taskMergeVersion', 'single_followup_task_v1'
    )
from followup_task_merge_plan plan
where event.tenant_id = plan.tenant_id
  and exists (
    select 1
    from unnest(plan.merged_task_ids) merged_task_id
    where merged_task_id::text = event.context ->> 'taskId'
  );

delete from work_core.tasks task
using followup_task_merge_plan plan
where task.id = any(plan.merged_task_ids);

update work_core.tasks task
set title = plan.active_task_record ->> 'title',
    description = plan.active_task_record ->> 'description',
    status = plan.active_task_record ->> 'status',
    priority = plan.active_task_record ->> 'priority',
    assigned_staff_id = nullif(
      plan.active_task_record ->> 'assigned_staff_id',
      ''
    )::uuid,
    opportunity_id = nullif(
      plan.active_task_record ->> 'opportunity_id',
      ''
    )::uuid,
    activity_id = nullif(
      plan.active_task_record ->> 'activity_id',
      ''
    )::uuid,
    starts_at = nullif(
      plan.active_task_record ->> 'starts_at',
      ''
    )::timestamptz,
    due_at = (
      plan.active_task_record ->> 'due_at'
    )::timestamptz,
    completed_at = null,
    completion_timing = null,
    metadata = (
      coalesce(
        plan.active_task_record -> 'metadata',
        '{}'::jsonb
      )
      - 'resolvedByActivityId'
      - 'completedBySubjectId'
      - 'cancelReason'
    ) || jsonb_build_object(
      'taskUpdateMode', 'single_record',
      'mergedTaskIds', to_jsonb(plan.merged_task_ids),
      'migratedAt', now()
    ),
    updated_at = now()
from followup_task_merge_plan plan
where task.id = plan.canonical_task_id;

create or replace function public.v2_tenant_record_sales_followup_v2(
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
  p_closure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_opportunity sales_core.opportunities%rowtype;
  v_stage sales_core.pipeline_stages%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_is_open boolean;
  v_is_closed boolean;
  v_stage_key text;
  v_case_status text;
  v_contact_status text;
  v_course_id uuid;
  v_course_run academy.course_runs%rowtype;
  v_followup_task work_core.tasks%rowtype;
  v_activity_id uuid;
  v_task_id uuid;
  v_handoff_id uuid;
  v_admissions_department_id uuid;
  v_admissions_staff_id uuid;
  v_reopened boolean;
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
  if p_activity_type not in (
    'call', 'meeting', 'whatsapp', 'email', 'note'
  ) then raise exception 'invalid_activity_type'; end if;
  if p_summary is null or length(trim(p_summary)) < 2 then
    raise exception 'summary_required';
  end if;
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
  if p_lead_quality not in (
    'unrated', 'unqualified', 'weak', 'qualified', 'good', 'excellent'
  ) then raise exception 'invalid_lead_quality'; end if;
  if p_payment_amount_minor is not null and p_payment_amount_minor < 0 then
    raise exception 'invalid_value';
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
  v_is_closed := p_lead_status in (
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  );

  if v_is_open and (
    p_next_action_type is null
    or p_next_action_at is null
  ) then raise exception 'next_action_required'; end if;
  if v_is_open and p_next_action_type not in (
    'call',
    'whatsapp',
    'send_details',
    'meeting',
    'payment_followup',
    'follow_up'
  ) then raise exception 'invalid_next_action'; end if;
  if v_is_closed and (
    p_closure_reason is null
    or length(trim(p_closure_reason)) < 3
  ) then raise exception 'closure_reason_required'; end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;
  if v_contact.lead_status in ('payment_submitted', 'paid') then
    raise exception 'lead_under_admissions';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  v_course_id := coalesce(p_course_id, v_contact.interest_course_id);
  if v_course_id is not null and not exists (
    select 1
    from academy.courses course
    where course.id = v_course_id
      and course.tenant_id = v_tenant_id
      and course.status <> 'archived'
  ) then raise exception 'invalid_course'; end if;
  if p_lead_status = 'payment_submitted' and v_course_id is null then
    raise exception 'course_required_for_payment';
  end if;

  if p_course_run_id is not null then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_course_id
      and run.status in ('planning', 'open', 'in_progress');
    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
  end if;

  v_stage_key := case
    when p_lead_status = 'payment_submitted' then 'proposal'
    when v_is_closed then 'lost'
    when p_lead_status in ('very_interested', 'awaiting_payment') then 'proposal'
    when p_lead_status = 'interested' then 'qualified'
    when p_lead_status in ('no_answer', 'busy', 'follow_up', 'postponed')
      then 'contacted'
    else 'new_lead'
  end;

  select *
  into v_stage
  from sales_core.pipeline_stages stage
  where stage.tenant_id = v_tenant_id
    and stage.stage_key = v_stage_key
  limit 1;

  if v_stage.id is null then raise exception 'invalid_stage'; end if;

  select *
  into v_opportunity
  from sales_core.opportunities opportunity
  where opportunity.tenant_id = v_tenant_id
    and opportunity.contact_id = p_contact_id
  order by
    (opportunity.status in ('open', 'pending_verification')) desc,
    opportunity.created_at desc
  limit 1
  for update;

  v_case_status := case
    when p_lead_status = 'payment_submitted' then 'pending_verification'
    when v_is_open then 'open'
    else 'lost'
  end;
  v_contact_status := case
    when p_lead_status = 'payment_submitted' then 'active'
    when v_is_open then 'active'
    when p_lead_status = 'unqualified' then 'unqualified'
    else 'archived'
  end;
  v_reopened := v_contact.lead_status in (
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ) and v_is_open;

  if v_opportunity.id is null then
    insert into sales_core.opportunities (
      tenant_id,
      contact_id,
      course_id,
      stage_id,
      owner_staff_id,
      title,
      value_minor,
      next_action_type,
      next_action_at,
      status,
      lost_reason,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      p_contact_id,
      v_course_id,
      v_stage.id,
      coalesce(v_contact.owner_staff_id, v_current_staff_id),
      'متابعة ' || v_contact.full_name,
      coalesce(p_payment_amount_minor, 0),
      case when v_is_open then p_next_action_type else null end,
      case when v_is_open then p_next_action_at else null end,
      v_case_status,
      case when v_is_closed then trim(p_closure_reason) else null end,
      private_app.current_subject_id(),
      jsonb_build_object('model', 'lead_centric')
    )
    returning * into v_opportunity;
  else
    update sales_core.opportunities
    set course_id = coalesce(v_course_id, course_id),
        stage_id = v_stage.id,
        value_minor = coalesce(p_payment_amount_minor, value_minor),
        next_action_type = case
          when v_is_open then p_next_action_type
          else null
        end,
        next_action_at = case
          when v_is_open then p_next_action_at
          else null
        end,
        status = v_case_status,
        lost_reason = case
          when v_is_closed then trim(p_closure_reason)
          else null
        end
    where id = v_opportunity.id
    returning * into v_opportunity;
  end if;

  select task.*
  into v_followup_task
  from work_core.tasks task
  where task.tenant_id = v_tenant_id
    and task.contact_id = p_contact_id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
  order by task.due_at desc, task.created_at desc, task.id
  limit 1
  for update;

  insert into sales_core.activities (
    tenant_id,
    opportunity_id,
    contact_id,
    actor_staff_id,
    activity_type,
    outcome,
    summary,
    occurred_at,
    next_action_type,
    next_action_at,
    result_status,
    result_quality,
    closure_reason,
    created_by_subject_id,
    metadata
  )
  values (
    v_tenant_id,
    v_opportunity.id,
    p_contact_id,
    coalesce(v_current_staff_id, v_contact.owner_staff_id),
    p_activity_type,
    p_lead_status,
    trim(p_summary),
    now(),
    case when v_is_open then p_next_action_type else null end,
    case when v_is_open then p_next_action_at else null end,
    p_lead_status,
    p_lead_quality,
    case when v_is_closed then trim(p_closure_reason) else null end,
    private_app.current_subject_id(),
    jsonb_strip_nulls(jsonb_build_object(
      'model',
      'lead_centric',
      'reopened',
      v_reopened,
      'scheduledTaskId',
      v_followup_task.id,
      'scheduledAt',
      v_followup_task.due_at,
      'taskUpdateMode',
      case
        when v_followup_task.id is null then 'created'
        else 'updated'
      end
    ))
  )
  returning id into v_activity_id;

  update sales_core.contacts
  set status = v_contact_status,
      lead_status = p_lead_status,
      lead_quality = p_lead_quality,
      interest_course_id = coalesce(v_course_id, interest_course_id),
      next_action_type = case when v_is_open then p_next_action_type else null end,
      next_action_at = case when v_is_open then p_next_action_at else null end,
      last_activity_at = now(),
      lead_status_changed_at = case
        when lead_status is distinct from p_lead_status then now()
        else lead_status_changed_at
      end,
      closure_reason = case
        when v_is_closed then trim(p_closure_reason)
        else null
      end,
      closed_at = case
        when v_is_closed then now()
        else null
      end,
      reopened_at = case
        when v_reopened then now()
        else reopened_at
      end,
      payment_submitted_at = case
        when p_lead_status = 'payment_submitted' then now()
        else payment_submitted_at
      end
  where id = p_contact_id;

  if v_contact.lead_status is distinct from p_lead_status then
    insert into sales_core.lead_status_history (
      tenant_id,
      contact_id,
      activity_id,
      from_status,
      to_status,
      reason,
      changed_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      p_contact_id,
      v_activity_id,
      v_contact.lead_status,
      p_lead_status,
      case
        when v_is_closed then trim(p_closure_reason)
        else trim(p_summary)
      end,
      private_app.current_subject_id(),
      jsonb_build_object('reopened', v_reopened)
    );
  end if;

  if v_is_open then
    if v_followup_task.id is not null then
      update work_core.tasks
      set title = 'متابعة: ' || v_contact.full_name,
          description = 'الحالة: ' || p_lead_status
            || ' · الإجراء التالي: ' || p_next_action_type,
          priority = case
            when p_lead_status in ('very_interested', 'awaiting_payment')
              then 'high'
            else 'normal'
          end,
          status = 'todo',
          assigned_staff_id = coalesce(
            v_contact.owner_staff_id,
            v_current_staff_id
          ),
          opportunity_id = v_opportunity.id,
          activity_id = v_activity_id,
          due_at = p_next_action_at,
          completed_at = null,
          completion_timing = null,
          metadata = (
            metadata
            - 'resolvedByActivityId'
            - 'completedBySubjectId'
            - 'cancelReason'
          ) || jsonb_build_object(
            'source', 'sales_followup',
            'actionType', p_next_action_type,
            'leadStatus', p_lead_status,
            'leadQuality', p_lead_quality,
            'taskUpdateMode', 'single_record',
            'lastMovedAt', now()
          )
      where id = v_followup_task.id
        and tenant_id = v_tenant_id
      returning id into v_task_id;
    else
      insert into work_core.tasks (
        tenant_id,
        title,
        description,
        priority,
        assigned_staff_id,
        created_by_subject_id,
        contact_id,
        opportunity_id,
        activity_id,
        due_at,
        metadata
      )
      values (
        v_tenant_id,
        'متابعة: ' || v_contact.full_name,
        'الحالة: ' || p_lead_status
          || ' · الإجراء التالي: ' || p_next_action_type,
        case
          when p_lead_status in ('very_interested', 'awaiting_payment')
            then 'high'
          else 'normal'
        end,
        coalesce(v_contact.owner_staff_id, v_current_staff_id),
        private_app.current_subject_id(),
        p_contact_id,
        v_opportunity.id,
        v_activity_id,
        p_next_action_at,
        jsonb_build_object(
          'source', 'sales_followup',
          'actionType', p_next_action_type,
          'leadStatus', p_lead_status,
          'leadQuality', p_lead_quality,
          'taskUpdateMode', 'single_record'
        )
      )
      returning id into v_task_id;
    end if;
  elsif p_lead_status = 'payment_submitted' then
    select department.id
    into v_admissions_department_id
    from people.departments department
    where department.tenant_id = v_tenant_id
      and department.department_key = 'admissions'
    limit 1;

    select staff.id
    into v_admissions_staff_id
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.tenant_id = v_tenant_id
      and staff.employment_status = 'active'
      and (
        department.department_key = 'admissions'
        or staff.role_key = 'customer_service'
      )
    order by
      (department.department_key = 'admissions') desc,
      staff.created_at
    limit 1;

    insert into academy.registration_handoffs (
      tenant_id,
      handoff_key,
      contact_id,
      opportunity_id,
      course_id,
      course_run_id,
      assigned_department_id,
      assigned_staff_id,
      status,
      paid_at,
      payment_status,
      payment_reported_at,
      payment_amount_minor,
      payment_reference,
      preferred_start_date,
      notes,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'payment-' || v_opportunity.id::text,
      p_contact_id,
      v_opportunity.id,
      v_course_id,
      p_course_run_id,
      v_admissions_department_id,
      v_admissions_staff_id,
      'pending',
      now(),
      'pending_verification',
      now(),
      p_payment_amount_minor,
      nullif(trim(coalesce(p_payment_reference, '')), ''),
      p_preferred_start_date,
      trim(p_summary),
      private_app.current_subject_id(),
      jsonb_build_object(
        'source',
        'sales_payment_report',
        'notification',
        true
      )
    )
    on conflict (tenant_id, handoff_key) do update
    set course_id = excluded.course_id,
        course_run_id = excluded.course_run_id,
        assigned_department_id = excluded.assigned_department_id,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'pending',
        paid_at = excluded.paid_at,
        payment_status = 'pending_verification',
        payment_reported_at = excluded.payment_reported_at,
        payment_verified_at = null,
        payment_verified_by_subject_id = null,
        payment_rejection_reason = null,
        payment_amount_minor = excluded.payment_amount_minor,
        payment_reference = excluded.payment_reference,
        preferred_start_date = excluded.preferred_start_date,
        notes = excluded.notes,
        metadata = excluded.metadata
    returning id into v_handoff_id;

    insert into academy.registration_documents (
      tenant_id,
      handoff_id,
      document_type,
      is_required,
      status
    )
    select
      v_tenant_id,
      v_handoff_id,
      document.document_type,
      document.is_required,
      case
        when document.document_type = 'payment_receipt'
          and nullif(trim(coalesce(p_payment_reference, '')), '') is not null
          then 'received'
        else 'pending'
      end
    from (
      values
        ('payment_receipt'::text, true),
        ('national_id'::text, true),
        ('qualification'::text, true),
        ('personal_photo'::text, false)
    ) document(document_type, is_required)
    on conflict (handoff_id, document_type) do update
    set status = case
          when excluded.document_type = 'payment_receipt'
            and excluded.status = 'received' then 'received'
          else academy.registration_documents.status
        end,
        is_required = excluded.is_required;

    insert into work_core.tasks (
      tenant_id,
      task_key,
      title,
      description,
      priority,
      assigned_staff_id,
      created_by_subject_id,
      contact_id,
      opportunity_id,
      activity_id,
      due_at,
      metadata
    )
    values (
      v_tenant_id,
      'registration-' || v_handoff_id::text,
      'تحقق من الدفع: ' || v_contact.full_name,
      case
        when p_course_run_id is null
          then 'أبلغ العميل بالدفع · يلزم التحقق وتحديد الدفعة'
        else 'أبلغ العميل بالدفع · يلزم التحقق قبل تأكيد التسجيل'
      end,
      'urgent',
      v_admissions_staff_id,
      private_app.current_subject_id(),
      p_contact_id,
      v_opportunity.id,
      v_activity_id,
      now(),
      jsonb_build_object(
        'source',
        'registration_handoff',
        'handoffId',
        v_handoff_id,
        'department',
        'admissions',
        'notification',
        true,
        'paymentStatus',
        'pending_verification'
      )
    )
    on conflict (tenant_id, task_key) do update
    set title = excluded.title,
        description = excluded.description,
        priority = excluded.priority,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'todo',
        completed_at = null,
        completion_timing = null,
        due_at = excluded.due_at,
        metadata = excluded.metadata
    returning id into v_task_id;
  end if;

  perform private_app.write_audit(
    'tenant.sales_followup_recorded',
    'sales_contact',
    p_contact_id::text,
    v_tenant_id,
    jsonb_build_object(
      'activityId',
      v_activity_id,
      'status',
      p_lead_status,
      'quality',
      p_lead_quality,
      'taskId',
      v_task_id,
      'taskUpdated',
      v_is_open and v_followup_task.id is not null,
      'previousDueAt',
      v_followup_task.due_at,
      'nextDueAt',
      case when v_is_open then p_next_action_at else null end,
      'handoffId',
      v_handoff_id,
      'closureReason',
      case when v_is_closed then trim(p_closure_reason) else null end
    )
  );

  return jsonb_build_object(
    'id',
    v_activity_id,
    'contactId',
    p_contact_id,
    'status',
    p_lead_status,
    'quality',
    p_lead_quality,
    'taskId',
    v_task_id,
    'taskUpdated',
    v_is_open and v_followup_task.id is not null,
    'previousDueAt',
    v_followup_task.due_at,
    'nextDueAt',
    case when v_is_open then p_next_action_at else null end,
    'handoffId',
    v_handoff_id,
    'paymentReviewNotified',
    v_handoff_id is not null
  );
end;
$$;

create or replace function public.v2_tenant_customer_history_snapshot(
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
  v_tenant core.tenants%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_staff_id uuid;
  v_view_team boolean;
  v_limit integer;
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
    'tenant.crm.read'
  ) then
    raise exception 'forbidden';
  end if;

  select contact.*
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant.id
  limit 1;

  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_view_team := private_app.can_view_tenant_team(v_tenant.id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_staff_id then
    raise exception 'forbidden';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 250), 1), 500);

  return (
    with activity_events as (
      select
        'activity:' || activity.id::text as event_key,
        'activity'::text as event_type,
        activity.activity_type as category,
        case activity.activity_type
          when 'call' then 'مكالمة مع العميل'
          when 'meeting' then 'اجتماع مع العميل'
          when 'whatsapp' then 'متابعة عبر واتساب'
          when 'email' then 'رسالة بريد إلكتروني'
          when 'offer' then 'إرسال عرض'
          else 'ملاحظة على العميل'
        end as title,
        activity.summary as description,
        coalesce(actor.full_name, 'إدارة المنشأة') as actor_name,
        actor.id as actor_staff_id,
        resolved_task.due_at as scheduled_at,
        activity.occurred_at,
        activity.created_at as recorded_at,
        case
          when resolved_task.id is null then 'not_scheduled'
          when activity.occurred_at < resolved_task.due_at - interval '15 minutes'
            then 'early'
          when activity.occurred_at <= resolved_task.due_at then 'on_time'
          else 'late'
        end as timing_status,
        case
          when resolved_task.id is null then null::integer
          else round(extract(epoch from (
            activity.occurred_at - resolved_task.due_at
          )) / 60)::integer
        end as delay_minutes,
        activity.result_status as status,
        activity.result_quality as quality,
        activity.next_action_type,
        activity.next_action_at,
        jsonb_build_object(
          'activityId', activity.id,
          'taskId', resolved_task.id,
          'opportunityId', activity.opportunity_id,
          'outcome', activity.outcome,
          'fromStatus', status_change.from_status,
          'toStatus', status_change.to_status,
          'closureReason', activity.closure_reason,
          'source', activity.metadata ->> 'source',
          'taskUpdateMode', activity.metadata ->> 'taskUpdateMode'
        ) as details
      from sales_core.activities activity
      left join people.staff_profiles actor
        on actor.id = activity.actor_staff_id
        and actor.tenant_id = activity.tenant_id
      left join lateral (
        select
          nullif(
            activity.metadata ->> 'scheduledTaskId',
            ''
          )::uuid as id,
          nullif(
            activity.metadata ->> 'scheduledAt',
            ''
          )::timestamptz as due_at
        where activity.metadata ? 'scheduledAt'

        union all

        select task.id, task.due_at
        from work_core.tasks task
        where task.tenant_id = activity.tenant_id
          and task.contact_id = activity.contact_id
          and task.metadata ->> 'resolvedByActivityId' = activity.id::text
          and not (activity.metadata ? 'scheduledAt')
        order by due_at desc nulls last
        limit 1
      ) resolved_task on true
      left join lateral (
        select history.from_status, history.to_status
        from sales_core.lead_status_history history
        where history.tenant_id = activity.tenant_id
          and history.contact_id = activity.contact_id
          and history.activity_id = activity.id
        order by history.changed_at desc
        limit 1
      ) status_change on true
      where activity.tenant_id = v_tenant.id
        and activity.contact_id = v_contact.id
    ), task_events as (
      select
        'task:' || task.id::text as event_key,
        'task'::text as event_type,
        coalesce(
          task.metadata ->> 'actionType',
          task.metadata ->> 'source',
          'task'
        ) as category,
        task.title,
        task.description,
        coalesce(
          completion_actor.full_name,
          assignee.full_name,
          'إدارة المنشأة'
        ) as actor_name,
        coalesce(completion_actor.id, assignee.id) as actor_staff_id,
        task.due_at as scheduled_at,
        case
          when task.status = 'completed' then task.completed_at
          when task.status = 'cancelled' then task.updated_at
          else null
        end as occurred_at,
        task.created_at as recorded_at,
        case
          when task.status = 'completed'
               and task.completed_at < task.due_at - interval '15 minutes'
            then 'early'
          when task.status = 'completed'
               and task.completed_at <= task.due_at
            then 'on_time'
          when task.status = 'completed' then 'late'
          when task.status = 'cancelled' then 'cancelled'
          when task.due_at < now() then 'overdue'
          else 'pending'
        end as timing_status,
        case
          when task.completed_at is null then null::integer
          else round(extract(epoch from (
            task.completed_at - task.due_at
          )) / 60)::integer
        end as delay_minutes,
        task.status,
        task.metadata ->> 'leadQuality' as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'taskId', task.id,
          'priority', task.priority,
          'source', task.metadata ->> 'source',
          'cancelReason', task.metadata ->> 'cancelReason',
          'opportunityId', task.opportunity_id
        ) as details
      from work_core.tasks task
      left join people.staff_profiles assignee
        on assignee.id = task.assigned_staff_id
        and assignee.tenant_id = task.tenant_id
      left join lateral (
        select actor_staff.id, actor_staff.full_name
        from audit_log.events audit
        left join access_control.memberships actor_membership
          on actor_membership.subject_id = audit.actor_subject_id
          and actor_membership.tenant_id = audit.tenant_id
        left join people.staff_profiles actor_staff
          on actor_staff.membership_id = actor_membership.id
          and actor_staff.tenant_id = audit.tenant_id
        where audit.tenant_id = task.tenant_id
          and audit.resource_type = 'work_task'
          and audit.resource_id = task.id::text
          and audit.action = 'tenant.work_task_status_updated'
          and audit.context ->> 'status' = task.status
        order by audit.occurred_at desc
        limit 1
      ) completion_actor on true
      where task.tenant_id = v_tenant.id
        and task.contact_id = v_contact.id
        and not (
          task.status = 'completed'
          and task.metadata ? 'resolvedByActivityId'
        )
    ), assignment_events as (
      select
        'assignment:' || assignment.id::text as event_key,
        'assignment'::text as event_type,
        assignment.assignment_strategy as category,
        'إسناد العميل إلى ' || assignee.full_name as title,
        'موعد أول إجراء: '
          || to_char(
            assignment.deadline_at at time zone v_tenant.timezone,
            'YYYY-MM-DD HH24:MI'
          ) as description,
        coalesce(assigner.full_name, 'إدارة المنشأة') as actor_name,
        assigner.id as actor_staff_id,
        assignment.deadline_at as scheduled_at,
        assignment.first_action_at as occurred_at,
        assignment.assigned_at as recorded_at,
        case
          when assignment.status = 'cancelled' then 'cancelled'
          when assignment.first_action_at < assignment.deadline_at - interval '15 minutes'
            then 'early'
          when assignment.first_action_at <= assignment.deadline_at then 'on_time'
          when assignment.first_action_at is not null then 'late'
          when assignment.deadline_at < now() then 'overdue'
          else 'pending'
        end as timing_status,
        case
          when assignment.first_action_at is null then null::integer
          else round(extract(epoch from (
            assignment.first_action_at - assignment.deadline_at
          )) / 60)::integer
        end as delay_minutes,
        assignment.status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'assignmentId', assignment.id,
          'strategy', assignment.assignment_strategy,
          'assignedStaffId', assignment.assigned_staff_id,
          'completedAt', assignment.completed_at
        ) as details
      from sales_core.lead_assignments assignment
      join people.staff_profiles assignee
        on assignee.id = assignment.assigned_staff_id
        and assignee.tenant_id = assignment.tenant_id
      left join people.staff_profiles assigner
        on assigner.id = assignment.assigned_by_staff_id
        and assigner.tenant_id = assignment.tenant_id
      where assignment.tenant_id = v_tenant.id
        and assignment.contact_id = v_contact.id
    ), status_events as (
      select
        'status:' || history.id::text as event_key,
        'status'::text as event_type,
        history.to_status as category,
        'تغيير حالة العميل' as title,
        coalesce(history.reason, 'تم تحديث حالة العميل') as description,
        coalesce(actor.full_name, subject.full_name, 'إدارة المنشأة') as actor_name,
        actor.id as actor_staff_id,
        null::timestamptz as scheduled_at,
        history.changed_at as occurred_at,
        history.changed_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        history.to_status as status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'fromStatus', history.from_status,
          'toStatus', history.to_status,
          'reason', history.reason
        ) as details
      from sales_core.lead_status_history history
      left join access_control.subjects subject
        on subject.id = history.changed_by_subject_id
      left join access_control.memberships actor_membership
        on actor_membership.subject_id = history.changed_by_subject_id
        and actor_membership.tenant_id = history.tenant_id
      left join people.staff_profiles actor
        on actor.membership_id = actor_membership.id
        and actor.tenant_id = history.tenant_id
      where history.tenant_id = v_tenant.id
        and history.contact_id = v_contact.id
        and history.activity_id is null
    ), payment_events as (
      select
        'payment:' || handoff.id::text as event_key,
        'payment'::text as event_type,
        'payment_submitted'::text as category,
        'إرسال بلاغ دفع للتسجيل والقبول' as title,
        concat_ws(
          ' · ',
          case
            when handoff.payment_reference is not null
              then 'المرجع: ' || handoff.payment_reference
          end,
          handoff.notes
        ) as description,
        coalesce(actor.full_name, subject.full_name, 'مسؤول المبيعات') as actor_name,
        actor.id as actor_staff_id,
        null::timestamptz as scheduled_at,
        handoff.payment_reported_at as occurred_at,
        handoff.created_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        handoff.payment_status as status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'handoffId', handoff.id,
          'amountMinor', handoff.payment_amount_minor,
          'paymentReference', handoff.payment_reference,
          'courseId', handoff.course_id,
          'courseRunId', handoff.course_run_id
        ) as details
      from academy.registration_handoffs handoff
      left join access_control.subjects subject
        on subject.id = handoff.created_by_subject_id
      left join access_control.memberships actor_membership
        on actor_membership.subject_id = handoff.created_by_subject_id
        and actor_membership.tenant_id = handoff.tenant_id
      left join people.staff_profiles actor
        on actor.membership_id = actor_membership.id
        and actor.tenant_id = handoff.tenant_id
      where handoff.tenant_id = v_tenant.id
        and handoff.contact_id = v_contact.id
    ), admission_events as (
      select
        'admission:' || audit.id::text as event_key,
        'admission'::text as event_type,
        coalesce(audit.context ->> 'action', audit.action) as category,
        case audit.context ->> 'action'
          when 'start_review' then 'بدء مراجعة طلب التسجيل'
          when 'save_details' then 'تحديث بيانات التسجيل'
          when 'verify_payment' then 'التحقق من الدفع'
          when 'reject_payment' then 'رفض إثبات الدفع'
          when 'accept' then 'قبول طلب التسجيل'
          when 'complete' then 'إكمال التسجيل'
          when 'cancel' then 'إلغاء طلب التسجيل'
          else 'تحديث في التسجيل والقبول'
        end as title,
        concat_ws(
          ' · ',
          audit.context ->> 'status',
          audit.context ->> 'paymentStatus'
        ) as description,
        coalesce(actor.full_name, subject.full_name, 'قسم التسجيل والقبول') as actor_name,
        actor.id as actor_staff_id,
        null::timestamptz as scheduled_at,
        audit.occurred_at,
        audit.occurred_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        audit.context ->> 'status' as status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        audit.context as details
      from audit_log.events audit
      join academy.registration_handoffs handoff
        on handoff.id::text = audit.resource_id
        and handoff.tenant_id = audit.tenant_id
      left join access_control.subjects subject
        on subject.id = audit.actor_subject_id
      left join access_control.memberships actor_membership
        on actor_membership.subject_id = audit.actor_subject_id
        and actor_membership.tenant_id = audit.tenant_id
      left join people.staff_profiles actor
        on actor.membership_id = actor_membership.id
        and actor.tenant_id = audit.tenant_id
      where audit.tenant_id = v_tenant.id
        and audit.resource_type = 'registration_handoff'
        and audit.action = 'tenant.admission_updated'
        and handoff.contact_id = v_contact.id
    ), enrollment_events as (
      select
        'enrollment:' || enrollment.id::text as event_key,
        'enrollment'::text as event_type,
        enrollment.status as category,
        'إنشاء ملف المتدرب وإتمام التسجيل' as title,
        concat_ws(
          ' · ',
          course.title_ar,
          run.title
        ) as description,
        coalesce(actor.full_name, subject.full_name, 'قسم التسجيل والقبول') as actor_name,
        actor.id as actor_staff_id,
        null::timestamptz as scheduled_at,
        enrollment.enrolled_at as occurred_at,
        enrollment.created_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        enrollment.status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'enrollmentId', enrollment.id,
          'studentId', enrollment.student_id,
          'courseId', enrollment.course_id,
          'courseRunId', enrollment.course_run_id
        ) as details
      from academy.enrollments enrollment
      join academy.registration_handoffs handoff
        on handoff.id = enrollment.handoff_id
        and handoff.tenant_id = enrollment.tenant_id
      left join academy.courses course
        on course.id = enrollment.course_id
      left join academy.course_runs run
        on run.id = enrollment.course_run_id
      left join access_control.subjects subject
        on subject.id = enrollment.confirmed_by_subject_id
      left join access_control.memberships actor_membership
        on actor_membership.subject_id = enrollment.confirmed_by_subject_id
        and actor_membership.tenant_id = enrollment.tenant_id
      left join people.staff_profiles actor
        on actor.membership_id = actor_membership.id
        and actor.tenant_id = enrollment.tenant_id
      where enrollment.tenant_id = v_tenant.id
        and handoff.contact_id = v_contact.id
    ), communication_events as (
      select
        'message:' || message.id::text as event_key,
        'communication'::text as event_type,
        message.channel as category,
        'إرسال رسالة عبر ' || coalesce(message.channel, 'قناة التواصل') as title,
        left(
          coalesce(message.subject, message.message_text, 'رسالة آلية'),
          500
        ) as description,
        'الأتمتة'::text as actor_name,
        null::uuid as actor_staff_id,
        message.due_at as scheduled_at,
        coalesce(
          message.read_at,
          message.delivered_at,
          message.processed_at
        ) as occurred_at,
        message.created_at as recorded_at,
        case
          when message.status in ('failed', 'cancelled') then 'cancelled'
          when message.processed_at < message.due_at - interval '15 minutes'
            then 'early'
          when message.processed_at <= message.due_at then 'on_time'
          when message.processed_at is not null then 'late'
          when message.due_at < now() then 'overdue'
          else 'pending'
        end as timing_status,
        case
          when message.processed_at is null then null::integer
          else round(extract(epoch from (
            message.processed_at - message.due_at
          )) / 60)::integer
        end as delay_minutes,
        coalesce(message.delivery_state, message.status) as status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'messageId', message.id,
          'templateKey', message.template_key,
          'recipient', message.recipient,
          'provider', message.provider_key,
          'deliveryState', message.delivery_state
        ) as details
      from communication_hub.message_outbox message
      where message.tenant_id = v_tenant.id
        and (
          message.metadata ->> 'contactId' = v_contact.id::text
          or (
            coalesce(v_contact.email, '') <> ''
            and lower(message.recipient) = lower(v_contact.email)
          )
          or (
            length(regexp_replace(
              coalesce(v_contact.phone, v_contact.whatsapp, ''),
              '[^0-9]', '', 'g'
            )) >= 9
            and right(regexp_replace(
              coalesce(message.recipient, ''),
              '[^0-9]', '', 'g'
            ), 9) = right(regexp_replace(
              coalesce(v_contact.phone, v_contact.whatsapp, ''),
              '[^0-9]', '', 'g'
            ), 9)
          )
        )
    ), call_events as (
      select
        'call:' || call_record.id::text as event_key,
        'call'::text as event_type,
        call_record.call_type as category,
        case
          when call_record.call_type = 'inbound' then 'مكالمة واردة من العميل'
          else 'مكالمة صادرة إلى العميل'
        end as title,
        concat_ws(
          ' · ',
          call_record.final_status,
          call_record.call_duration_seconds::text || ' ثانية',
          call_record.call_note
        ) as description,
        coalesce(
          case
            when right(regexp_replace(
              coalesce(call_record.caller_number, ''),
              '[^0-9]', '', 'g'
            ), 9) = right(regexp_replace(
              coalesce(v_contact.phone, v_contact.whatsapp, ''),
              '[^0-9]', '', 'g'
            ), 9)
              then call_record.callee_name
            else call_record.caller_name
          end,
          'نظام الاتصالات'
        ) as actor_name,
        null::uuid as actor_staff_id,
        null::timestamptz as scheduled_at,
        call_record.started_at as occurred_at,
        call_record.first_seen_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        call_record.final_status as status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'callId', call_record.id,
          'durationSeconds', call_record.call_duration_seconds,
          'hasRecording', call_record.has_recording,
          'dispositionCodes', call_record.disposition_codes
        ) as details
      from telephony.call_records call_record
      where call_record.tenant_id = v_tenant.id
        and length(regexp_replace(
          coalesce(v_contact.phone, v_contact.whatsapp, ''),
          '[^0-9]', '', 'g'
        )) >= 9
        and right(regexp_replace(
          coalesce(v_contact.phone, v_contact.whatsapp, ''),
          '[^0-9]', '', 'g'
        ), 9) in (
          right(regexp_replace(
            coalesce(call_record.caller_number, ''),
            '[^0-9]', '', 'g'
          ), 9),
          right(regexp_replace(
            coalesce(call_record.callee_number, ''),
            '[^0-9]', '', 'g'
          ), 9),
          right(regexp_replace(
            coalesce(call_record.second_participant_number, ''),
            '[^0-9]', '', 'g'
          ), 9),
          right(regexp_replace(
            coalesce(call_record.last_participant_number, ''),
            '[^0-9]', '', 'g'
          ), 9)
        )
    ), conversion_events as (
      select
        'conversion:' || conversion.id::text as event_key,
        'conversion'::text as event_type,
        conversion.event_type as category,
        'تحويل تسويقي: ' || conversion.event_type as title,
        concat_ws(
          ' · ',
          conversion.source_kind,
          conversion.amount_minor::text || ' ' || conversion.currency
        ) as description,
        'النظام'::text as actor_name,
        null::uuid as actor_staff_id,
        null::timestamptz as scheduled_at,
        conversion.occurred_at,
        conversion.created_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        conversion.status,
        null::text as quality,
        null::text as next_action_type,
        null::timestamptz as next_action_at,
        jsonb_build_object(
          'conversionId', conversion.id,
          'sourceKind', conversion.source_kind,
          'sourceRef', conversion.source_ref,
          'amountMinor', conversion.amount_minor,
          'currency', conversion.currency
        ) as details
      from marketing_hub.conversion_events conversion
      where conversion.tenant_id = v_tenant.id
        and conversion.contact_id = v_contact.id
    ), contact_event as (
      select
        'contact:' || v_contact.id::text as event_key,
        'contact'::text as event_type,
        v_contact.source as category,
        'إنشاء سجل العميل' as title,
        concat_ws(
          ' · ',
          v_contact.source,
          v_contact.campaign_name,
          v_contact.ad_name
        ) as description,
        coalesce(actor.full_name, subject.full_name, 'إدارة المنشأة') as actor_name,
        actor.id as actor_staff_id,
        null::timestamptz as scheduled_at,
        v_contact.created_at as occurred_at,
        v_contact.created_at as recorded_at,
        'not_scheduled'::text as timing_status,
        null::integer as delay_minutes,
        v_contact.lead_status as status,
        v_contact.lead_quality as quality,
        v_contact.next_action_type,
        v_contact.next_action_at,
        jsonb_build_object(
          'source', v_contact.source,
          'campaignName', v_contact.campaign_name,
          'adName', v_contact.ad_name
        ) as details
      from (values (1)) seed(value)
      left join access_control.subjects subject
        on subject.id = v_contact.created_by_subject_id
      left join access_control.memberships actor_membership
        on actor_membership.subject_id = v_contact.created_by_subject_id
        and actor_membership.tenant_id = v_contact.tenant_id
      left join people.staff_profiles actor
        on actor.membership_id = actor_membership.id
        and actor.tenant_id = v_contact.tenant_id
    ), event_rows as (
      select * from activity_events
      union all select * from task_events
      union all select * from assignment_events
      union all select * from status_events
      union all select * from payment_events
      union all select * from admission_events
      union all select * from enrollment_events
      union all select * from communication_events
      union all select * from call_events
      union all select * from conversion_events
      union all select * from contact_event
    ), ordered_events as (
      select event.*
      from event_rows event
      order by coalesce(
        event.occurred_at,
        event.scheduled_at,
        event.recorded_at
      ) desc, event.recorded_at desc, event.event_key
      limit v_limit
    )
    select jsonb_build_object(
      'generatedAt', now(),
      'timezone', v_tenant.timezone,
      'contact', jsonb_build_object(
        'id', v_contact.id,
        'name', v_contact.full_name,
        'phone', v_contact.phone,
        'whatsapp', v_contact.whatsapp,
        'email', v_contact.email,
        'organizationName', v_contact.organization_name,
        'leadStatus', v_contact.lead_status,
        'leadQuality', v_contact.lead_quality,
        'ownerStaffId', v_contact.owner_staff_id,
        'ownerName', (
          select owner.full_name
          from people.staff_profiles owner
          where owner.id = v_contact.owner_staff_id
            and owner.tenant_id = v_tenant.id
          limit 1
        ),
        'courseName', (
          select course.title_ar
          from academy.courses course
          where course.id = v_contact.interest_course_id
            and course.tenant_id = v_tenant.id
          limit 1
        ),
        'nextActionType', v_contact.next_action_type,
        'nextActionAt', v_contact.next_action_at,
        'createdAt', v_contact.created_at
      ),
      'summary', jsonb_build_object(
        'totalEvents', (select count(*) from event_rows),
        'completedOnTime', (
          select count(*)
          from event_rows
          where timing_status in ('early', 'on_time')
        ),
        'completedLate', (
          select count(*)
          from event_rows
          where timing_status = 'late'
        ),
        'overdue', (
          select count(*)
          from event_rows
          where timing_status = 'overdue'
        ),
        'pending', (
          select count(*)
          from event_rows
          where timing_status = 'pending'
        ),
        'cancelled', (
          select count(*)
          from event_rows
          where timing_status = 'cancelled'
        ),
        'adherencePercent', coalesce((
          select round(
            100.0 * count(*) filter (
              where timing_status in ('early', 'on_time')
            ) / nullif(count(*) filter (
              where timing_status in ('early', 'on_time', 'late')
            ), 0)
          )
          from event_rows
        ), 0)
      ),
      'events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', event.event_key,
          'type', event.event_type,
          'category', event.category,
          'title', event.title,
          'description', event.description,
          'actorName', event.actor_name,
          'actorStaffId', event.actor_staff_id,
          'scheduledAt', event.scheduled_at,
          'occurredAt', event.occurred_at,
          'recordedAt', event.recorded_at,
          'timingStatus', event.timing_status,
          'delayMinutes', event.delay_minutes,
          'status', event.status,
          'quality', event.quality,
          'nextActionType', event.next_action_type,
          'nextActionAt', event.next_action_at,
          'details', event.details
        ) order by coalesce(
          event.occurred_at,
          event.scheduled_at,
          event.recorded_at
        ) desc, event.recorded_at desc, event.event_key)
        from ordered_events event
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.v2_tenant_customer_history_snapshot(
  text,
  uuid,
  integer
) from public, anon;

grant execute on function public.v2_tenant_customer_history_snapshot(
  text,
  uuid,
  integer
) to authenticated, service_role;

create or replace function public.v3_tenant_sales_pipeline_snapshot(
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
  v_contacts jsonb;
begin
  v_snapshot := public.v2_tenant_sales_pipeline_snapshot(p_slug);

  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  select coalesce(
    jsonb_agg(
      contact.item || jsonb_strip_nulls(jsonb_build_object(
        'latestNote',
        coalesce(
          nullif(latest_activity.summary, ''),
          nullif(contact.item ->> 'notes', '')
        ),
        'latestNoteAt',
        coalesce(
          latest_activity.occurred_at,
          nullif(contact.item ->> 'updatedAt', '')::timestamptz
        ),
        'latestNoteType',
        coalesce(
          latest_activity.activity_type,
          case
            when nullif(contact.item ->> 'notes', '') is not null
              then 'customer_note'
          end
        )
      ))
      order by contact.position
    ),
    '[]'::jsonb
  )
  into v_contacts
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'contacts', '[]'::jsonb)
  ) with ordinality contact(item, position)
  left join lateral (
    select
      activity.summary,
      activity.occurred_at,
      activity.activity_type
    from sales_core.activities activity
    where activity.tenant_id = v_tenant_id
      and activity.contact_id = (
        contact.item ->> 'id'
      )::uuid
    order by activity.occurred_at desc, activity.id desc
    limit 1
  ) latest_activity on true;

  return jsonb_set(
    v_snapshot,
    '{contacts}',
    v_contacts,
    true
  );
end;
$$;

revoke all on function public.v3_tenant_sales_pipeline_snapshot(text)
from public, anon;

grant execute on function public.v3_tenant_sales_pipeline_snapshot(text)
to authenticated, service_role;

comment on function public.v3_tenant_sales_pipeline_snapshot(text) is
'Adds the exact latest customer activity note to the permission-scoped sales snapshot.';

commit;
