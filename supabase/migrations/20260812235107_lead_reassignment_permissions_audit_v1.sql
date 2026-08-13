begin;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values (
  'tenant.leads.reassign',
  'crm',
  'تغيير إسناد العملاء',
  'نقل ملكية العميل ومهام متابعته من مسؤول مبيعات إلى آخر مع التوثيق والإشعار'
)
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

-- The data officer owns the intake queue and must be able to see every
-- distribution screen, including the team view guarded by this permission.
insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key = 'data_officer'
  and permission.permission_key = 'tenant.leads.distribute'
on conflict do nothing;

-- Reassignment audit notes belong in the customer timeline, but they must not
-- be mistaken for a completed sales follow-up by the generic activity trigger.
create or replace function private_app.complete_customer_followup_tasks()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.activity_type = 'note'
     and new.metadata ->> 'source' = 'lead_reassignment_audit' then
    return new;
  end if;

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

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager',
    'sales_manager',
    'sales_supervisor',
    'data_officer'
  )
  and permission.permission_key = 'tenant.leads.reassign'
on conflict do nothing;

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
    'tenant.leads.read'
  ) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'schemaVersion', 'lead-reassignment-v1',
    'viewer', jsonb_build_object(
      'canReassign', private_app.has_tenant_permission(
        v_tenant_id,
        'tenant.leads.reassign'
      )
    )
  );
end;
$$;

create or replace function public.v1_tenant_lead_assignment_search(
  p_slug text,
  p_query text,
  p_from date default null,
  p_to date default null,
  p_quality text default null,
  p_source text default null,
  p_campaign text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_query text := nullif(lower(trim(p_query)), '');
  v_phone_query text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
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
    'tenant.leads.read'
  ) then
    raise exception 'forbidden';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'invalid_report_range';
  end if;
  if v_query is null then
    return jsonb_build_object(
      'query', '',
      'assignments', '[]'::jsonb,
      'limit', v_limit
    );
  end if;

  return jsonb_build_object(
    'query', p_query,
    'limit', v_limit,
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', result.id,
        'batchId', result.batch_id,
        'rowId', result.import_row_id,
        'contactId', result.contact_id,
        'contactName', result.contact_name,
        'phone', result.phone,
        'source', result.source,
        'campaignName', result.campaign_name,
        'adName', result.ad_name,
        'leadStatus', result.lead_status,
        'leadQuality', result.lead_quality,
        'assignedStaffId', result.assigned_staff_id,
        'assignedStaffName', result.assigned_staff_name,
        'assignedByName', result.assigned_by_name,
        'strategy', result.assignment_strategy,
        'status', result.status,
        'assignedAt', result.assigned_at,
        'deadlineAt', result.deadline_at,
        'firstActionAt', result.first_action_at,
        'overdue', result.overdue,
        'responseMinutes', result.response_minutes,
        'previousStaffName', result.previous_staff_name,
        'reassignmentReason', result.reassignment_reason
      ) order by result.assigned_at desc, result.id)
      from (
        select
          assignment.*,
          contact.full_name as contact_name,
          coalesce(contact.phone, contact.whatsapp) as phone,
          contact.source,
          contact.campaign_name,
          contact.ad_name,
          contact.lead_status,
          contact.lead_quality,
          assignee.full_name as assigned_staff_name,
          assigner.full_name as assigned_by_name,
          (
            assignment.status = 'active'
            and assignment.first_action_at is null
            and assignment.deadline_at < now()
          ) as overdue,
          case
            when assignment.first_action_at is null then null
            else round((
              extract(epoch from (
                assignment.first_action_at - assignment.assigned_at
              )) / 60
            )::numeric, 1)
          end as response_minutes,
          assignment.metadata ->> 'previousStaffName' as previous_staff_name,
          assignment.metadata ->> 'reassignmentReason' as reassignment_reason
        from sales_core.lead_assignments assignment
        join sales_core.contacts contact
          on contact.id = assignment.contact_id
         and contact.tenant_id = assignment.tenant_id
        join people.staff_profiles assignee
          on assignee.id = assignment.assigned_staff_id
         and assignee.tenant_id = assignment.tenant_id
        left join people.staff_profiles assigner
          on assigner.id = assignment.assigned_by_staff_id
         and assigner.tenant_id = assignment.tenant_id
        where assignment.tenant_id = v_tenant.id
          and (
            lower(contact.full_name) like '%' || v_query || '%'
            or (
              v_phone_query <> ''
              and regexp_replace(
                coalesce(contact.phone, contact.whatsapp, ''),
                '[^0-9]',
                '',
                'g'
              ) like '%' || v_phone_query || '%'
            )
          )
          and (
            (p_from is null and p_to is null)
            or (
              (
                assignment.assigned_at at time zone v_tenant.timezone
              )::date between coalesce(p_from, '-infinity'::date)
                and coalesce(p_to, 'infinity'::date)
              or (
                assignment.first_action_at is not null
                and (
                  assignment.first_action_at at time zone v_tenant.timezone
                )::date between coalesce(p_from, '-infinity'::date)
                  and coalesce(p_to, 'infinity'::date)
              )
            )
          )
          and (
            nullif(trim(p_quality), '') is null
            or contact.lead_quality = p_quality
            or contact.lead_status = p_quality
          )
          and (
            nullif(trim(p_source), '') is null
            or contact.source = p_source
          )
          and (
            nullif(trim(p_campaign), '') is null
            or contact.campaign_name = p_campaign
          )
        order by assignment.assigned_at desc, assignment.id
        limit v_limit
      ) result
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v1_tenant_lead_reassignment_action(
  p_tenant_slug text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_target_staff people.staff_profiles%rowtype;
  v_actor_staff people.staff_profiles%rowtype;
  v_assignment sales_core.lead_assignments%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_subject_id uuid;
  v_current_staff_id uuid;
  v_assignment_ids uuid[];
  v_target_staff_id uuid;
  v_deadline_at timestamptz;
  v_reason text;
  v_operation_id uuid := gen_random_uuid();
  v_new_assignment_id uuid;
  v_task_id uuid;
  v_old_staff_name text;
  v_actor_name text;
  v_requested integer;
  v_active_count integer;
  v_reassigned integer := 0;
  v_unchanged integer := 0;
  v_contact_ids jsonb := '[]'::jsonb;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.reassign'
  ) then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(p_payload -> 'assignmentIds') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'assignmentIds') = 0 then
    raise exception 'lead_assignment_required';
  end if;
  if jsonb_array_length(p_payload -> 'assignmentIds') > 100 then
    raise exception 'lead_reassignment_too_large';
  end if;

  begin
    select coalesce(array_agg(distinct value::uuid), '{}'::uuid[])
    into v_assignment_ids
    from jsonb_array_elements_text(p_payload -> 'assignmentIds');

    v_target_staff_id := nullif(
      trim(coalesce(p_payload ->> 'newStaffId', '')),
      ''
    )::uuid;
    v_deadline_at := nullif(
      trim(coalesce(p_payload ->> 'deadlineAt', '')),
      ''
    )::timestamptz;
  exception
    when invalid_text_representation then
      raise exception 'invalid_lead_reassignment_payload';
  end;

  v_reason := nullif(trim(coalesce(p_payload ->> 'reason', '')), '');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'lead_reassignment_reason_required';
  end if;
  if length(v_reason) > 500 then
    raise exception 'lead_reassignment_reason_too_long';
  end if;
  if v_target_staff_id is null then
    raise exception 'invalid_sales_assignee';
  end if;
  if v_deadline_at is null or v_deadline_at <= now() then
    raise exception 'invalid_distribution_deadline';
  end if;
  if v_deadline_at > now() + interval '90 days' then
    raise exception 'distribution_deadline_too_far';
  end if;

  select staff.*
  into v_target_staff
  from people.staff_profiles staff
  where staff.id = v_target_staff_id
    and staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
    and staff.role_key in (
      'sales_user',
      'sales_supervisor',
      'sales_manager'
    )
  limit 1;

  if v_target_staff.id is null then
    raise exception 'invalid_sales_assignee';
  end if;

  v_subject_id := private_app.current_subject_id();
  v_current_staff_id := private_app.current_staff_id(v_tenant.id);

  select staff.*
  into v_actor_staff
  from people.staff_profiles staff
  where staff.id = v_current_staff_id
    and staff.tenant_id = v_tenant.id
  limit 1;

  v_actor_name := coalesce(v_actor_staff.full_name, 'إدارة المنشأة');
  v_requested := cardinality(v_assignment_ids);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant.id::text, 3917)
  );

  select count(*)
  into v_active_count
  from sales_core.lead_assignments assignment
  where assignment.tenant_id = v_tenant.id
    and assignment.id = any(v_assignment_ids)
    and assignment.status = 'active';

  if v_active_count <> v_requested then
    raise exception 'lead_assignment_not_active';
  end if;

  for v_assignment in
    select assignment.*
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.id = any(v_assignment_ids)
      and assignment.status = 'active'
    order by assignment.id
    for update
  loop
    if v_assignment.assigned_staff_id = v_target_staff.id then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    select contact.*
    into v_contact
    from sales_core.contacts contact
    where contact.id = v_assignment.contact_id
      and contact.tenant_id = v_tenant.id
    for update;

    if v_contact.id is null then
      raise exception 'invalid_contact';
    end if;

    select staff.full_name
    into v_old_staff_name
    from people.staff_profiles staff
    where staff.id = v_assignment.assigned_staff_id
      and staff.tenant_id = v_tenant.id
    limit 1;

    v_old_staff_name := coalesce(v_old_staff_name, 'مسؤول المبيعات السابق');
    v_new_assignment_id := gen_random_uuid();
    v_task_id := null;

    select task.id
    into v_task_id
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.contact_id = v_contact.id
      and task.status in ('todo', 'in_progress')
      and (
        task.id = v_assignment.task_id
        or coalesce(task.metadata ->> 'source', '') in (
          'opportunity_next_action',
          'activity_next_action',
          'lead_next_action',
          'sales_followup',
          'lead_assignment'
        )
      )
    order by
      (task.id = v_assignment.task_id) desc,
      task.due_at,
      task.id
    limit 1
    for update;

    update sales_core.lead_assignments assignment
    set status = 'reassigned',
        completed_at = now(),
        metadata = assignment.metadata || jsonb_build_object(
          'reassignedAt', now(),
          'reassignedBySubjectId', v_subject_id,
          'reassignedByStaffId', v_current_staff_id,
          'reassignedToStaffId', v_target_staff.id,
          'replacementAssignmentId', v_new_assignment_id,
          'reassignmentReason', v_reason,
          'reassignmentOperationId', v_operation_id
        )
    where assignment.id = v_assignment.id;

    insert into sales_core.lead_assignments (
      id,
      tenant_id,
      batch_id,
      import_row_id,
      contact_id,
      opportunity_id,
      task_id,
      assigned_staff_id,
      assigned_by_staff_id,
      assigned_by_subject_id,
      assignment_strategy,
      status,
      assigned_at,
      deadline_at,
      metadata
    )
    values (
      v_new_assignment_id,
      v_tenant.id,
      v_assignment.batch_id,
      v_assignment.import_row_id,
      v_contact.id,
      v_assignment.opportunity_id,
      null,
      v_target_staff.id,
      v_current_staff_id,
      v_subject_id,
      'selected',
      'active',
      now(),
      v_deadline_at,
      v_assignment.metadata || jsonb_build_object(
        'source', 'manual_reassignment',
        'previousAssignmentId', v_assignment.id,
        'previousStaffId', v_assignment.assigned_staff_id,
        'previousStaffName', v_old_staff_name,
        'reassignmentReason', v_reason,
        'reassignmentOperationId', v_operation_id
      )
    );

    if v_task_id is null then
      insert into work_core.tasks (
        tenant_id,
        task_key,
        title,
        description,
        priority,
        status,
        assigned_staff_id,
        created_by_subject_id,
        contact_id,
        opportunity_id,
        starts_at,
        due_at,
        metadata
      )
      values (
        v_tenant.id,
        'lead-reassignment-' || v_new_assignment_id::text,
        'متابعة العميل: ' || v_contact.full_name,
        'تم نقل المسؤول من ' || v_old_staff_name
          || ' إلى ' || v_target_staff.full_name
          || '. السبب: ' || v_reason,
        'high',
        'todo',
        v_target_staff.id,
        v_subject_id,
        v_contact.id,
        v_assignment.opportunity_id,
        now(),
        v_deadline_at,
        jsonb_build_object(
          'source', 'lead_assignment',
          'assignmentId', v_new_assignment_id,
          'previousAssignmentId', v_assignment.id,
          'previousStaffId', v_assignment.assigned_staff_id,
          'reassignmentReason', v_reason,
          'reassignmentOperationId', v_operation_id,
          'deadlineType', 'first_action'
        )
      )
      returning id into v_task_id;
    else
      update work_core.tasks task
      set assigned_staff_id = v_target_staff.id,
          due_at = v_deadline_at,
          metadata = task.metadata || jsonb_build_object(
            'source', 'lead_assignment',
            'assignmentId', v_new_assignment_id,
            'previousAssignmentId', v_assignment.id,
            'previousStaffId', v_assignment.assigned_staff_id,
            'reassignedAt', now(),
            'reassignmentReason', v_reason,
            'reassignmentOperationId', v_operation_id,
            'deadlineType', 'first_action'
          )
      where task.id = v_task_id;
    end if;

    update work_core.tasks task
    set assigned_staff_id = v_target_staff.id,
        metadata = task.metadata || jsonb_build_object(
          'reassignedAt', now(),
          'reassignedByStaffId', v_current_staff_id,
          'previousStaffId', v_assignment.assigned_staff_id,
          'reassignmentReason', v_reason,
          'reassignmentOperationId', v_operation_id
        )
    where task.tenant_id = v_tenant.id
      and task.contact_id = v_contact.id
      and task.id is distinct from v_task_id
      and task.status in ('todo', 'in_progress')
      and coalesce(task.metadata ->> 'source', '') in (
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'sales_followup',
        'lead_assignment'
      );

    update sales_core.lead_assignments assignment
    set task_id = v_task_id
    where assignment.id = v_new_assignment_id;

    update sales_core.contacts contact
    set owner_staff_id = v_target_staff.id,
        next_action_type = 'call',
        next_action_at = v_deadline_at,
        metadata = contact.metadata || jsonb_build_object(
          'lastReassignment', jsonb_build_object(
            'at', now(),
            'fromStaffId', v_assignment.assigned_staff_id,
            'fromStaffName', v_old_staff_name,
            'toStaffId', v_target_staff.id,
            'toStaffName', v_target_staff.full_name,
            'reason', v_reason,
            'actorStaffId', v_current_staff_id,
            'actorName', v_actor_name,
            'operationId', v_operation_id
          )
        )
    where contact.id = v_contact.id;

    update sales_core.opportunities opportunity
    set owner_staff_id = v_target_staff.id,
        next_action_type = 'call',
        next_action_at = v_deadline_at,
        metadata = opportunity.metadata || jsonb_build_object(
          'lastReassignmentOperationId', v_operation_id,
          'reassignedAt', now(),
          'previousOwnerStaffId', v_assignment.assigned_staff_id
        )
    where opportunity.tenant_id = v_tenant.id
      and opportunity.contact_id = v_contact.id
      and opportunity.status in ('open', 'pending_verification');

    insert into sales_core.sales_assignment_profiles (
      tenant_id,
      staff_id,
      sales_channel,
      eligible_for_leads,
      daily_capacity,
      last_assigned_at,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_target_staff.id,
      'online',
      true,
      50,
      now(),
      v_subject_id
    )
    on conflict (tenant_id, staff_id) do update
    set last_assigned_at = excluded.last_assigned_at,
        updated_by_subject_id = excluded.updated_by_subject_id;

    insert into sales_core.activities (
      tenant_id,
      activity_key,
      opportunity_id,
      contact_id,
      actor_staff_id,
      activity_type,
      summary,
      occurred_at,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant.id,
      'lead-reassignment-' || v_new_assignment_id::text,
      v_assignment.opportunity_id,
      v_contact.id,
      v_current_staff_id,
      'note',
      'تغيير إسناد العميل من ' || v_old_staff_name
        || ' إلى ' || v_target_staff.full_name
        || '. السبب: ' || v_reason,
      now(),
      v_subject_id,
      jsonb_build_object(
        'source', 'lead_reassignment_audit',
        'operationId', v_operation_id,
        'previousAssignmentId', v_assignment.id,
        'assignmentId', v_new_assignment_id,
        'fromStaffId', v_assignment.assigned_staff_id,
        'fromStaffName', v_old_staff_name,
        'toStaffId', v_target_staff.id,
        'toStaffName', v_target_staff.full_name,
        'deadlineAt', v_deadline_at,
        'reason', v_reason
      )
    );

    with recipient_candidates as (
      select v_assignment.assigned_staff_id as recipient_staff_id,
             'previous'::text as recipient_kind
      union all
      select v_target_staff.id, 'new'::text
      union all
      select manager.id, 'management'::text
      from people.staff_profiles manager
      join access_control.memberships membership
        on membership.id = manager.membership_id
       and membership.tenant_id = v_tenant.id
       and membership.status = 'active'
      join access_control.membership_roles membership_role
        on membership_role.membership_id = membership.id
      join access_control.roles role
        on role.id = membership_role.role_id
       and role.scope = 'tenant'
       and role.role_key in (
         'tenant_owner',
         'tenant_admin',
         'executive_manager',
         'sales_manager',
         'sales_supervisor'
       )
      where manager.tenant_id = v_tenant.id
        and manager.employment_status = 'active'
    ), recipients as (
      select
        candidate.recipient_staff_id,
        case
          when bool_or(candidate.recipient_kind = 'previous') then 'previous'
          when bool_or(candidate.recipient_kind = 'new') then 'new'
          else 'management'
        end as recipient_kind
      from recipient_candidates candidate
      where candidate.recipient_staff_id is not null
      group by candidate.recipient_staff_id
    )
    insert into work_core.notifications (
      tenant_id,
      notification_key,
      recipient_staff_id,
      notification_type,
      title,
      message,
      severity,
      action_path,
      contact_id,
      metadata
    )
    select
      v_tenant.id,
      'lead-reassignment:' || v_new_assignment_id::text,
      recipient.recipient_staff_id,
      'lead_reassigned',
      case recipient.recipient_kind
        when 'previous' then 'تم نقل العميل: ' || v_contact.full_name
        when 'new' then 'إسناد عميل جديد: ' || v_contact.full_name
        else 'تغيير إسناد عميل: ' || v_contact.full_name
      end,
      case recipient.recipient_kind
        when 'previous' then
          'نقل ' || v_actor_name || ' العميل من عهدتك إلى '
            || v_target_staff.full_name || '. السبب: ' || v_reason
        when 'new' then
          'أسند ' || v_actor_name || ' العميل إليك بدلًا من '
            || v_old_staff_name || '. موعد المتابعة: '
            || to_char(
              v_deadline_at at time zone v_tenant.timezone,
              'YYYY-MM-DD HH24:MI'
            ) || '. السبب: ' || v_reason
        else
          'غيّر ' || v_actor_name || ' إسناد العميل من '
            || v_old_staff_name || ' إلى ' || v_target_staff.full_name
            || '. السبب: ' || v_reason
      end,
      case recipient.recipient_kind
        when 'new' then 'warning'
        else 'info'
      end,
      'lead-queue',
      v_contact.id,
      jsonb_build_object(
        'recipientKind', recipient.recipient_kind,
        'operationId', v_operation_id,
        'previousAssignmentId', v_assignment.id,
        'assignmentId', v_new_assignment_id,
        'fromStaffId', v_assignment.assigned_staff_id,
        'toStaffId', v_target_staff.id,
        'deadlineAt', v_deadline_at,
        'reason', v_reason,
        'tab', 'assignments'
      )
    from recipients recipient
    on conflict (tenant_id, notification_key, recipient_staff_id)
    do nothing;

    perform private_app.write_audit(
      'tenant.lead_reassigned',
      'lead_assignment',
      v_new_assignment_id::text,
      v_tenant.id,
      jsonb_build_object(
        'operationId', v_operation_id,
        'contactId', v_contact.id,
        'contactName', v_contact.full_name,
        'previousAssignmentId', v_assignment.id,
        'fromStaffId', v_assignment.assigned_staff_id,
        'fromStaffName', v_old_staff_name,
        'toStaffId', v_target_staff.id,
        'toStaffName', v_target_staff.full_name,
        'deadlineAt', v_deadline_at,
        'reason', v_reason,
        'taskId', v_task_id
      )
    );

    v_contact_ids := v_contact_ids || jsonb_build_array(v_contact.id);
    v_reassigned := v_reassigned + 1;
  end loop;

  if v_reassigned = 0 then
    raise exception 'same_sales_assignee';
  end if;

  return jsonb_build_object(
    'operationId', v_operation_id,
    'reassigned', v_reassigned,
    'unchanged', v_unchanged,
    'newStaffId', v_target_staff.id,
    'newStaffName', v_target_staff.full_name,
    'deadlineAt', v_deadline_at,
    'contactIds', v_contact_ids
  );
end;
$$;

revoke all on function public.v1_tenant_lead_reassignment_snapshot(text)
from public, anon, authenticated;
revoke all on function public.v1_tenant_lead_assignment_search(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  integer
) from public, anon, authenticated;
revoke all on function public.v1_tenant_lead_reassignment_action(text, jsonb)
from public, anon, authenticated;

grant execute on function public.v1_tenant_lead_reassignment_snapshot(text)
to authenticated, service_role;
grant execute on function public.v1_tenant_lead_assignment_search(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  integer
) to authenticated, service_role;
grant execute on function public.v1_tenant_lead_reassignment_action(text, jsonb)
to authenticated, service_role;

comment on function public.v1_tenant_lead_reassignment_action(text, jsonb) is
'Atomically reassigns active leads, transfers ownership and open sales work, preserves assignment history, notifies affected staff and tenant management, and writes an audit event.';

commit;

