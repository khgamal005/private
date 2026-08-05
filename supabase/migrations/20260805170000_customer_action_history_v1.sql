-- Customer action history with planned-vs-actual timing.
-- Existing follow-up tasks that were closed as "superseded" are repaired and
-- future sales activities complete their related task automatically.

create index if not exists work_tasks_tenant_contact_due_idx
  on work_core.tasks (tenant_id, contact_id, due_at desc)
  where contact_id is not null;

create index if not exists sales_activities_tenant_contact_occurred_idx
  on sales_core.activities (tenant_id, contact_id, occurred_at desc);

create index if not exists sales_status_history_tenant_contact_changed_idx
  on sales_core.lead_status_history (tenant_id, contact_id, changed_at desc);

create index if not exists sales_assignments_tenant_contact_assigned_idx
  on sales_core.lead_assignments (tenant_id, contact_id, assigned_at desc);

create index if not exists registration_handoffs_tenant_contact_created_idx
  on academy.registration_handoffs (tenant_id, contact_id, created_at desc);

create index if not exists audit_events_tenant_resource_history_idx
  on audit_log.events (
    tenant_id,
    resource_type,
    resource_id,
    occurred_at desc
  );

with repaired as (
  select
    task.id as task_id,
    resolved_activity.id as activity_id,
    resolved_activity.occurred_at
  from work_core.tasks task
  join lateral (
    select activity.id, activity.occurred_at
    from sales_core.activities activity
    where activity.tenant_id = task.tenant_id
      and activity.contact_id = task.contact_id
      and activity.occurred_at >= task.created_at
    order by activity.occurred_at, activity.id
    limit 1
  ) resolved_activity on true
  where task.status = 'cancelled'
    and task.contact_id is not null
    and task.metadata ->> 'cancelReason' = 'superseded_by_sales_outcome'
)
update work_core.tasks task
set status = 'completed',
    completed_at = repaired.occurred_at,
    completion_timing = case
      when repaired.occurred_at <= task.due_at then 'on_time'
      else 'late'
    end,
    metadata = task.metadata
      || jsonb_build_object(
        'resolvedByActivityId', repaired.activity_id,
        'historyRepair', true
      ),
    updated_at = greatest(task.updated_at, repaired.occurred_at)
from repaired
where task.id = repaired.task_id;

create or replace function private_app.complete_customer_followup_tasks()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update work_core.tasks task
  set status = 'completed',
      completed_at = new.occurred_at,
      completion_timing = case
        when new.occurred_at <= task.due_at then 'on_time'
        else 'late'
      end,
      metadata = task.metadata
        || jsonb_build_object(
          'resolvedByActivityId', new.id,
          'completedBySubjectId', new.created_by_subject_id
        ),
      updated_at = greatest(task.updated_at, new.occurred_at)
  where task.tenant_id = new.tenant_id
    and task.contact_id = new.contact_id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
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

drop trigger if exists complete_customer_followup_tasks_after_activity
on sales_core.activities;

create trigger complete_customer_followup_tasks_after_activity
after insert on sales_core.activities
for each row
execute function private_app.complete_customer_followup_tasks();

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
          'source', activity.metadata ->> 'source'
        ) as details
      from sales_core.activities activity
      left join people.staff_profiles actor
        on actor.id = activity.actor_staff_id
        and actor.tenant_id = activity.tenant_id
      left join lateral (
        select task.id, task.due_at
        from work_core.tasks task
        where task.tenant_id = activity.tenant_id
          and task.contact_id = activity.contact_id
          and task.metadata ->> 'resolvedByActivityId' = activity.id::text
        order by task.due_at desc
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

