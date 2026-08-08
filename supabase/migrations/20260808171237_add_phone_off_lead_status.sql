begin;

alter table sales_core.contacts
  drop constraint if exists contacts_lead_status_check;

alter table sales_core.contacts
  add constraint contacts_lead_status_check
  check (lead_status in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'payment_submitted',
    'paid',
    'postponed',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  )) not valid;

alter table sales_core.contacts
  validate constraint contacts_lead_status_check;

alter table sales_core.activities
  drop constraint if exists activities_result_status_check;

alter table sales_core.activities
  add constraint activities_result_status_check
  check (
    result_status is null
    or result_status in (
      'new',
      'no_answer',
      'busy',
      'phone_off',
      'follow_up',
      'interested',
      'very_interested',
      'awaiting_payment',
      'payment_submitted',
      'paid',
      'postponed',
      'not_interested',
      'unqualified',
      'wrong_number',
      'duplicate',
      'cancelled'
    )
  ) not valid;

alter table sales_core.activities
  validate constraint activities_result_status_check;

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
    'phone_off',
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
    when p_lead_status in ('no_answer', 'busy', 'phone_off', 'follow_up', 'postponed')
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

revoke all on function public.v2_tenant_record_sales_followup_v2(
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
  text
) from public, anon;

grant execute on function public.v2_tenant_record_sales_followup_v2(
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
  text
) to authenticated, service_role;

comment on function public.v2_tenant_record_sales_followup_v2(
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
  text
) is
'Records one immutable sales outcome, moves one mutable follow-up task, and treats phone_off as an active follow-up status.';

commit;
