-- Read-only ODEIR production function definitions inspected 2026-09-21.
-- Schema/code only; no production records or credentials.
set check_function_bodies=off;
CREATE OR REPLACE FUNCTION private_app.has_tenant_role(p_tenant_id uuid, p_role_keys text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects s
      join access_control.memberships m
        on m.subject_id = s.id
       and m.tenant_id = p_tenant_id
       and m.scope = 'tenant'
       and m.status = 'active'
      join access_control.membership_roles mr on mr.membership_id = m.id
      join access_control.roles r
        on r.id = mr.role_id
       and r.scope = 'tenant'
      where s.auth_user_id = auth.uid()
        and s.status = 'active'
        and r.role_key = any(p_role_keys)
    )
  )
$function$
;

CREATE OR REPLACE FUNCTION private_app.can_view_tenant_team(p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private_app.has_tenant_role(
    p_tenant_id,
    array[
      'tenant_owner',
      'tenant_admin',
      'executive_manager',
      'sales_manager',
      'sales_supervisor',
      'data_officer',
      'data_analyst'
    ]::text[]
  )
$function$
;

CREATE OR REPLACE FUNCTION private_app.commerce_order_pick_assignee(p_tenant_id uuid, p_mode text)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select staff.id
  from people.staff_profiles staff
  join sales_core.sales_assignment_profiles profile
    on profile.tenant_id = staff.tenant_id
   and profile.staff_id = staff.id
  where staff.tenant_id = p_tenant_id
    and staff.employment_status = 'active'
    and staff.role_key in (
      'sales_user',
      'sales_supervisor',
      'sales_manager'
    )
    and profile.eligible_for_leads
    and (
      p_mode <> 'auto_online'
      or profile.sales_channel in ('online', 'hybrid')
    )
    and (
      (
        select count(*)
        from sales_core.lead_assignments assignment
        join core.tenants tenant on tenant.id = assignment.tenant_id
        where assignment.tenant_id = p_tenant_id
          and assignment.assigned_staff_id = staff.id
          and (
            assignment.assigned_at at time zone tenant.timezone
          )::date = (
            clock_timestamp() at time zone tenant.timezone
          )::date
      ) + (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        join core.tenants tenant on tenant.id = work_item.tenant_id
        where work_item.tenant_id = p_tenant_id
          and work_item.assigned_staff_id = staff.id
          and work_item.assigned_at is not null
          and (
            work_item.assigned_at at time zone tenant.timezone
          )::date = (
            clock_timestamp() at time zone tenant.timezone
          )::date
      )
    ) < profile.daily_capacity
  order by
    (
      (
        select count(*)
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = p_tenant_id
          and assignment.assigned_staff_id = staff.id
          and assignment.status = 'active'
          and assignment.first_action_at is null
      ) + (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        join work_core.tasks task on task.id = work_item.task_id
        where work_item.tenant_id = p_tenant_id
          and work_item.assigned_staff_id = staff.id
          and task.status in ('todo', 'in_progress')
      )
    )::numeric / greatest(profile.weight, 1),
    profile.last_assigned_at nulls first,
    staff.id
  limit 1
$function$
;

CREATE OR REPLACE FUNCTION private_app.force_registration_document_optional()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.is_required := false;
  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION private_app.format_customer_phone(p_value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_original text;
  v_identity text;
begin
  v_original := nullif(pg_catalog.btrim(coalesce(p_value, '')), '');
  if v_original is null then
    return null;
  end if;

  v_identity := private_app.normalize_lead_phone(v_original);
  if v_identity is null then
    return null;
  end if;

  if v_identity ~ '^9665[0-9]{8}$' then
    return '0' || pg_catalog.right(v_identity, 9);
  end if;

  -- A non-Saudi number keeps its country code and entered representation.
  return v_original;
end;
$function$
;

CREATE OR REPLACE FUNCTION private_app.normalize_lead_phone(p_value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_digits text;
begin
  v_digits := pg_catalog.translate(
    coalesce(p_value, ''),
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
    '01234567890123456789'
  );
  v_digits := pg_catalog.regexp_replace(v_digits, '[^0-9]', '', 'g');

  if v_digits like '00%' then
    v_digits := pg_catalog.substr(v_digits, 3);
  end if;

  if v_digits ~ '^(9660?|996)5[0-9]{8}$' then
    return '966' || pg_catalog.right(v_digits, 9);
  end if;
  if v_digits ~ '^05[0-9]{8}$' then
    return '966' || pg_catalog.substr(v_digits, 2);
  end if;
  if v_digits ~ '^5[0-9]{8}$' then
    return '966' || v_digits;
  end if;
  if pg_catalog.length(v_digits) = 10 and v_digits like '0%' then
    return '966' || pg_catalog.substr(v_digits, 2);
  end if;
  if pg_catalog.length(v_digits) between 8 and 15 then
    return v_digits;
  end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v1_tenant_lead_reassignment_action(p_tenant_slug text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.v2_tenant_lead_intake_action_unhardened_20260806(p_tenant_slug text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_current_staff_id uuid;
  v_batch sales_core.lead_import_batches%rowtype;
  v_row jsonb;
  v_import_row sales_core.lead_import_rows%rowtype;
  v_row_number integer := 0;
  v_total integer := 0;
  v_valid integer := 0;
  v_duplicate integer := 0;
  v_invalid integer := 0;
  v_distributed integer := 0;
  v_name text;
  v_phone text;
  v_whatsapp text;
  v_normalized_phone text;
  v_normalized_whatsapp text;
  v_email text;
  v_source text;
  v_campaign_name text;
  v_ad_set_name text;
  v_ad_name text;
  v_program_name text;
  v_validation_status text;
  v_validation_errors text[];
  v_duplicate_kind text;
  v_duplicate_contact_id uuid;
  v_batch_id uuid;
  v_deadline_at timestamptz;
  v_strategy text;
  v_staff_ids uuid[];
  v_row_ids uuid[];
  v_assignee_id uuid;
  v_contact_id uuid;
  v_opportunity_id uuid;
  v_task_id uuid;
  v_assignment_id uuid;
  v_stage_id uuid;
  v_course_id uuid;
  v_candidate_count integer;
  v_sales_channel text;
  v_daily_capacity integer;
  v_weight integer;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant.id);

  if p_action = 'import' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.import'
    ) then
      raise exception 'forbidden';
    end if;
    if jsonb_typeof(p_payload -> 'rows') <> 'array'
       or jsonb_array_length(p_payload -> 'rows') = 0 then
      raise exception 'empty_lead_import';
    end if;
    if jsonb_array_length(p_payload -> 'rows') > 5000 then
      raise exception 'lead_import_too_large';
    end if;

    v_source := coalesce(
      nullif(trim(p_payload ->> 'source'), ''),
      'sheet_import'
    );
    v_campaign_name := nullif(
      trim(p_payload ->> 'campaignName'),
      ''
    );
    v_ad_set_name := nullif(trim(p_payload ->> 'adSetName'), '');
    v_ad_name := nullif(trim(p_payload ->> 'adName'), '');

    insert into sales_core.lead_import_batches (
      tenant_id,
      batch_key,
      file_name,
      source,
      campaign_name,
      ad_set_name,
      ad_name,
      imported_by_subject_id,
      imported_by_staff_id,
      status
    )
    values (
      v_tenant.id,
      'lead-batch-' || gen_random_uuid()::text,
      coalesce(
        nullif(trim(p_payload ->> 'fileName'), ''),
        'leads.xlsx'
      ),
      v_source,
      v_campaign_name,
      v_ad_set_name,
      v_ad_name,
      private_app.current_subject_id(),
      v_current_staff_id,
      'ready'
    )
    returning * into v_batch;

    for v_row in
      select value
      from jsonb_array_elements(p_payload -> 'rows')
    loop
      v_row_number := v_row_number + 1;
      v_total := v_total + 1;
      v_name := nullif(trim(coalesce(v_row ->> 'name', '')), '');
      v_phone := nullif(trim(coalesce(v_row ->> 'phone', '')), '');
      v_whatsapp := nullif(
        trim(coalesce(v_row ->> 'whatsapp', '')),
        ''
      );
      v_normalized_phone := private_app.normalize_lead_phone(v_phone);
      v_normalized_whatsapp := private_app.normalize_lead_phone(
        v_whatsapp
      );
      v_email := nullif(
        lower(trim(coalesce(v_row ->> 'email', ''))),
        ''
      );
      v_source := coalesce(
        nullif(trim(v_row ->> 'source'), ''),
        v_batch.source
      );
      v_campaign_name := coalesce(
        nullif(trim(v_row ->> 'campaignName'), ''),
        v_batch.campaign_name
      );
      v_ad_set_name := coalesce(
        nullif(trim(v_row ->> 'adSetName'), ''),
        v_batch.ad_set_name
      );
      v_ad_name := coalesce(
        nullif(trim(v_row ->> 'adName'), ''),
        v_batch.ad_name
      );
      v_program_name := nullif(trim(v_row ->> 'program'), '');
      v_validation_status := 'valid';
      v_validation_errors := '{}'::text[];
      v_duplicate_kind := null;
      v_duplicate_contact_id := null;

      if v_name is null or length(v_name) < 2 then
        v_validation_status := 'invalid';
        v_validation_errors := array_append(
          v_validation_errors,
          'الاسم مطلوب'
        );
      end if;
      if v_normalized_phone is null
         and v_normalized_whatsapp is null then
        v_validation_status := 'invalid';
        v_validation_errors := array_append(
          v_validation_errors,
          'رقم الجوال أو واتساب غير صالح'
        );
      end if;
      if v_email is not null
         and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        v_validation_status := 'invalid';
        v_validation_errors := array_append(
          v_validation_errors,
          'البريد الإلكتروني غير صالح'
        );
      end if;

      if v_validation_status = 'valid'
         and exists (
           select 1
           from sales_core.lead_import_rows previous_row
           where previous_row.batch_id = v_batch.id
             and (
               (
                 v_normalized_phone is not null
                 and previous_row.normalized_phone = v_normalized_phone
               )
               or (
                 v_normalized_whatsapp is not null
                 and previous_row.normalized_whatsapp =
                   v_normalized_whatsapp
               )
               or (
                 v_email is not null
                 and lower(previous_row.email) = v_email
               )
             )
         ) then
        v_validation_status := 'duplicate';
        v_duplicate_kind := 'same_file';
        v_validation_errors := array_append(
          v_validation_errors,
          'مكرر داخل نفس الملف'
        );
      end if;

      if v_validation_status = 'valid' then
        select contact.id
        into v_duplicate_contact_id
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and (
            (
              v_normalized_phone is not null
              and (
                private_app.normalize_lead_phone(contact.phone) =
                  v_normalized_phone
                or private_app.normalize_lead_phone(contact.whatsapp) =
                  v_normalized_phone
              )
            )
            or (
              v_normalized_whatsapp is not null
              and (
                private_app.normalize_lead_phone(contact.phone) =
                  v_normalized_whatsapp
                or private_app.normalize_lead_phone(contact.whatsapp) =
                  v_normalized_whatsapp
              )
            )
            or (
              v_email is not null
              and lower(contact.email) = v_email
            )
          )
        order by contact.created_at
        limit 1;

        if v_duplicate_contact_id is not null then
          v_validation_status := 'duplicate';
          v_duplicate_kind := 'existing_contact';
          v_validation_errors := array_append(
            v_validation_errors,
            'العميل موجود مسبقًا في CRM'
          );
        end if;
      end if;

      insert into sales_core.lead_import_rows (
        tenant_id,
        batch_id,
        row_number,
        full_name,
        organization_name,
        phone,
        normalized_phone,
        whatsapp,
        normalized_whatsapp,
        email,
        source,
        campaign_name,
        ad_set_name,
        ad_name,
        program_name,
        notes,
        validation_status,
        validation_errors,
        duplicate_kind,
        duplicate_contact_id,
        queue_status,
        raw_data
      )
      values (
        v_tenant.id,
        v_batch.id,
        v_row_number,
        v_name,
        nullif(trim(v_row ->> 'organization'), ''),
        v_phone,
        v_normalized_phone,
        v_whatsapp,
        v_normalized_whatsapp,
        v_email,
        v_source,
        v_campaign_name,
        v_ad_set_name,
        v_ad_name,
        v_program_name,
        nullif(trim(v_row ->> 'notes'), ''),
        v_validation_status,
        v_validation_errors,
        v_duplicate_kind,
        v_duplicate_contact_id,
        case
          when v_validation_status = 'valid'
            then 'awaiting_distribution'
          else 'skipped'
        end,
        v_row
      );

      if v_validation_status = 'valid' then
        v_valid := v_valid + 1;
      elsif v_validation_status = 'duplicate' then
        v_duplicate := v_duplicate + 1;
      else
        v_invalid := v_invalid + 1;
      end if;
    end loop;

    update sales_core.lead_import_batches
    set total_rows = v_total,
        valid_rows = v_valid,
        duplicate_rows = v_duplicate,
        invalid_rows = v_invalid
    where id = v_batch.id;

    perform private_app.write_audit(
      'tenant.lead_batch_imported',
      'lead_import_batch',
      v_batch.id::text,
      v_tenant.id,
      jsonb_build_object(
        'fileName', v_batch.file_name,
        'totalRows', v_total,
        'validRows', v_valid,
        'duplicateRows', v_duplicate,
        'invalidRows', v_invalid,
        'source', v_batch.source,
        'campaignName', v_batch.campaign_name
      )
    );

    return jsonb_build_object(
      'batchId', v_batch.id,
      'totalRows', v_total,
      'validRows', v_valid,
      'duplicateRows', v_duplicate,
      'invalidRows', v_invalid
    );
  end if;

  if p_action = 'save_profile' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.distribute'
    ) then
      raise exception 'forbidden';
    end if;

    v_assignee_id := (p_payload ->> 'staffId')::uuid;
    v_sales_channel := coalesce(
      nullif(trim(p_payload ->> 'salesChannel'), ''),
      'online'
    );
    v_daily_capacity := coalesce(
      (p_payload ->> 'dailyCapacity')::integer,
      50
    );
    v_weight := coalesce((p_payload ->> 'weight')::integer, 1);

    if v_sales_channel not in ('online', 'field', 'hybrid') then
      raise exception 'invalid_sales_channel';
    end if;
    if v_daily_capacity not between 1 and 1000 then
      raise exception 'invalid_daily_capacity';
    end if;
    if v_weight not between 1 and 10 then
      raise exception 'invalid_distribution_weight';
    end if;
    if not exists (
      select 1
      from people.staff_profiles staff
      where staff.id = v_assignee_id
        and staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        )
    ) then
      raise exception 'invalid_sales_assignee';
    end if;

    insert into sales_core.sales_assignment_profiles (
      tenant_id,
      staff_id,
      sales_channel,
      eligible_for_leads,
      daily_capacity,
      weight,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_assignee_id,
      v_sales_channel,
      coalesce((p_payload ->> 'eligible')::boolean, true),
      v_daily_capacity,
      v_weight,
      private_app.current_subject_id()
    )
    on conflict (tenant_id, staff_id) do update
    set sales_channel = excluded.sales_channel,
        eligible_for_leads = excluded.eligible_for_leads,
        daily_capacity = excluded.daily_capacity,
        weight = excluded.weight,
        updated_by_subject_id = excluded.updated_by_subject_id;

    return jsonb_build_object(
      'staffId', v_assignee_id,
      'saved', true
    );
  end if;

  if p_action = 'cancel_batch' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.import'
    ) then
      raise exception 'forbidden';
    end if;
    v_batch_id := (p_payload ->> 'batchId')::uuid;

    select batch.*
    into v_batch
    from sales_core.lead_import_batches batch
    where batch.id = v_batch_id
      and batch.tenant_id = v_tenant.id
    for update;

    if v_batch.id is null then
      raise exception 'lead_batch_not_found';
    end if;
    if v_batch.distributed_rows > 0 then
      raise exception 'lead_batch_already_distributed';
    end if;

    update sales_core.lead_import_rows
    set queue_status = 'cancelled'
    where batch_id = v_batch.id
      and validation_status = 'valid'
      and queue_status = 'awaiting_distribution';

    update sales_core.lead_import_batches
    set status = 'cancelled'
    where id = v_batch.id;

    return jsonb_build_object('batchId', v_batch.id, 'cancelled', true);
  end if;

  if p_action = 'distribute' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.distribute'
    ) then
      raise exception 'forbidden';
    end if;

    v_batch_id := (p_payload ->> 'batchId')::uuid;
    v_strategy := coalesce(
      nullif(trim(p_payload ->> 'strategy'), ''),
      'fair'
    );
    v_deadline_at := (p_payload ->> 'deadlineAt')::timestamptz;

    if v_strategy not in ('fair', 'online_only', 'selected') then
      raise exception 'invalid_distribution_strategy';
    end if;
    if v_deadline_at is null or v_deadline_at <= now() then
      raise exception 'invalid_distribution_deadline';
    end if;
    if v_deadline_at > now() + interval '90 days' then
      raise exception 'distribution_deadline_too_far';
    end if;

    select coalesce(array_agg(value::uuid), '{}'::uuid[])
    into v_staff_ids
    from jsonb_array_elements_text(
      coalesce(p_payload -> 'staffIds', '[]'::jsonb)
    );

    select coalesce(array_agg(value::uuid), '{}'::uuid[])
    into v_row_ids
    from jsonb_array_elements_text(
      coalesce(p_payload -> 'rowIds', '[]'::jsonb)
    );

    if v_strategy = 'selected'
       and cardinality(v_staff_ids) = 0 then
      raise exception 'distribution_staff_required';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_tenant.id::text, 1729)
    );

    select batch.*
    into v_batch
    from sales_core.lead_import_batches batch
    where batch.id = v_batch_id
      and batch.tenant_id = v_tenant.id
      and batch.status in ('ready', 'partially_distributed')
    for update;

    if v_batch.id is null then
      raise exception 'lead_batch_not_ready';
    end if;

    select count(*)
    into v_candidate_count
    from people.staff_profiles staff
    left join sales_core.sales_assignment_profiles profile
      on profile.staff_id = staff.id
     and profile.tenant_id = staff.tenant_id
    where staff.tenant_id = v_tenant.id
      and staff.employment_status = 'active'
      and staff.role_key in (
        'sales_user',
        'sales_supervisor',
        'sales_manager'
      )
      and (
        (
          v_strategy = 'selected'
          and staff.id = any(v_staff_ids)
        )
        or (
          v_strategy = 'fair'
          and coalesce(profile.eligible_for_leads, false)
        )
        or (
          v_strategy = 'online_only'
          and coalesce(profile.eligible_for_leads, false)
          and coalesce(profile.sales_channel, 'online') in (
            'online',
            'hybrid'
          )
        )
      );

    if v_candidate_count = 0 then
      if v_strategy = 'online_only' then
        raise exception 'no_online_sales_team';
      end if;
      raise exception 'no_sales_team';
    end if;

    select stage.id
    into v_stage_id
    from sales_core.pipeline_stages stage
    where stage.tenant_id = v_tenant.id
      and stage.stage_key = 'new_lead'
    limit 1;

    if v_stage_id is null then
      raise exception 'invalid_stage';
    end if;

    for v_import_row in
      select row_data.*
      from sales_core.lead_import_rows row_data
      where row_data.batch_id = v_batch.id
        and row_data.tenant_id = v_tenant.id
        and row_data.validation_status = 'valid'
        and row_data.queue_status = 'awaiting_distribution'
        and (
          cardinality(v_row_ids) = 0
          or row_data.id = any(v_row_ids)
        )
      order by row_data.row_number
      for update skip locked
    loop
      select staff.id
      into v_assignee_id
      from people.staff_profiles staff
      left join sales_core.sales_assignment_profiles profile
        on profile.staff_id = staff.id
       and profile.tenant_id = staff.tenant_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        )
        and (
          (
            v_strategy = 'selected'
            and staff.id = any(v_staff_ids)
          )
          or (
            v_strategy = 'fair'
            and coalesce(profile.eligible_for_leads, false)
          )
          or (
            v_strategy = 'online_only'
            and coalesce(profile.eligible_for_leads, false)
            and coalesce(profile.sales_channel, 'online') in (
              'online',
              'hybrid'
            )
          )
        )
        and (
          select count(*)
          from sales_core.lead_assignments today_assignment
          where today_assignment.assigned_staff_id = staff.id
            and (
              today_assignment.assigned_at
              at time zone v_tenant.timezone
            )::date = (
              now() at time zone v_tenant.timezone
            )::date
        ) < coalesce(profile.daily_capacity, 50)
      order by
        (
          (
            select count(*)
            from sales_core.lead_assignments active_assignment
            where active_assignment.assigned_staff_id = staff.id
              and active_assignment.status = 'active'
              and active_assignment.first_action_at is null
          )::numeric
          / greatest(coalesce(profile.weight, 1), 1)
        ),
        profile.last_assigned_at nulls first,
        staff.id
      limit 1;

      if v_assignee_id is null then
        exit;
      end if;

      v_course_id := null;
      if v_import_row.program_name is not null then
        select course.id
        into v_course_id
        from academy.courses course
        where course.tenant_id = v_tenant.id
          and course.status = 'active'
          and (
            lower(course.course_code) =
              lower(v_import_row.program_name)
            or lower(course.title_ar) =
              lower(v_import_row.program_name)
            or lower(coalesce(course.title_en, '')) =
              lower(v_import_row.program_name)
          )
        order by course.created_at
        limit 1;
      end if;

      insert into sales_core.contacts (
        tenant_id,
        contact_key,
        full_name,
        organization_name,
        phone,
        whatsapp,
        email,
        source,
        status,
        owner_staff_id,
        interest_course_id,
        notes,
        created_by_subject_id,
        metadata,
        lead_status,
        lead_quality,
        next_action_type,
        next_action_at,
        campaign_name,
        ad_name
      )
      values (
        v_tenant.id,
        'lead-import-' || v_import_row.id::text,
        v_import_row.full_name,
        v_import_row.organization_name,
        v_import_row.phone,
        v_import_row.whatsapp,
        v_import_row.email,
        v_import_row.source,
        'new',
        v_assignee_id,
        v_course_id,
        v_import_row.notes,
        private_app.current_subject_id(),
        jsonb_strip_nulls(jsonb_build_object(
          'model', 'lead_intake_v2',
          'importBatchId', v_batch.id,
          'importRowId', v_import_row.id,
          'normalizedPhone', v_import_row.normalized_phone,
          'normalizedWhatsapp', v_import_row.normalized_whatsapp,
          'programName', v_import_row.program_name,
          'adSetName', v_import_row.ad_set_name
        )),
        'new',
        'unrated',
        'call',
        v_deadline_at,
        v_import_row.campaign_name,
        v_import_row.ad_name
      )
      returning id into v_contact_id;

      insert into sales_core.opportunities (
        tenant_id,
        opportunity_key,
        contact_id,
        course_id,
        stage_id,
        owner_staff_id,
        title,
        value_minor,
        next_action_type,
        next_action_at,
        status,
        created_by_subject_id,
        metadata
      )
      values (
        v_tenant.id,
        'lead-import-' || v_import_row.id::text,
        v_contact_id,
        v_course_id,
        v_stage_id,
        v_assignee_id,
        case
          when v_import_row.program_name is null
            then 'متابعة ' || v_import_row.full_name
          else
            'متابعة ' || v_import_row.full_name
            || ' — ' || v_import_row.program_name
        end,
        0,
        'call',
        v_deadline_at,
        'open',
        private_app.current_subject_id(),
        jsonb_build_object(
          'model', 'lead_intake_v2',
          'importBatchId', v_batch.id,
          'importRowId', v_import_row.id
        )
      )
      returning id into v_opportunity_id;

      insert into sales_core.lead_assignments (
        tenant_id,
        batch_id,
        import_row_id,
        contact_id,
        opportunity_id,
        assigned_staff_id,
        assigned_by_staff_id,
        assigned_by_subject_id,
        assignment_strategy,
        deadline_at,
        metadata
      )
      values (
        v_tenant.id,
        v_batch.id,
        v_import_row.id,
        v_contact_id,
        v_opportunity_id,
        v_assignee_id,
        v_current_staff_id,
        private_app.current_subject_id(),
        v_strategy,
        v_deadline_at,
        jsonb_build_object(
          'source', 'lead_queue',
          'campaignName', v_import_row.campaign_name,
          'adSetName', v_import_row.ad_set_name,
          'adName', v_import_row.ad_name
        )
      )
      returning id into v_assignment_id;

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
        'lead-assignment-' || v_assignment_id::text,
        'متابعة العميل: ' || v_import_row.full_name,
        concat_ws(
          ' — ',
          nullif(v_import_row.program_name, ''),
          case
            when v_import_row.campaign_name is not null
              then 'الحملة: ' || v_import_row.campaign_name
          end,
          case
            when v_import_row.ad_name is not null
              then 'الإعلان: ' || v_import_row.ad_name
          end
        ),
        'high',
        'todo',
        v_assignee_id,
        private_app.current_subject_id(),
        v_contact_id,
        v_opportunity_id,
        now(),
        v_deadline_at,
        jsonb_build_object(
          'source', 'lead_assignment',
          'assignmentId', v_assignment_id,
          'batchId', v_batch.id,
          'rowId', v_import_row.id,
          'deadlineType', 'first_action'
        )
      )
      returning id into v_task_id;

      update sales_core.lead_assignments
      set task_id = v_task_id
      where id = v_assignment_id;

      update sales_core.lead_import_rows
      set queue_status = 'assigned',
          contact_id = v_contact_id
      where id = v_import_row.id;

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
        v_assignee_id,
        'online',
        true,
        50,
        now(),
        private_app.current_subject_id()
      )
      on conflict (tenant_id, staff_id) do update
      set last_assigned_at = excluded.last_assigned_at;

      v_distributed := v_distributed + 1;
    end loop;

    update sales_core.lead_import_batches batch
    set distributed_rows = (
          select count(*)
          from sales_core.lead_import_rows row_data
          where row_data.batch_id = batch.id
            and row_data.queue_status = 'assigned'
        ),
        last_distributed_by_staff_id = v_current_staff_id,
        last_distribution_strategy = v_strategy,
        last_deadline_at = v_deadline_at,
        distributed_at = case
          when v_distributed > 0 then now()
          else batch.distributed_at
        end,
        status = case
          when exists (
            select 1
            from sales_core.lead_import_rows remaining_row
            where remaining_row.batch_id = batch.id
              and remaining_row.validation_status = 'valid'
              and remaining_row.queue_status =
                'awaiting_distribution'
          ) then 'partially_distributed'
          else 'distributed'
        end
    where batch.id = v_batch.id;

    perform private_app.write_audit(
      'tenant.leads_distributed',
      'lead_import_batch',
      v_batch.id::text,
      v_tenant.id,
      jsonb_build_object(
        'distributed', v_distributed,
        'strategy', v_strategy,
        'deadlineAt', v_deadline_at,
        'candidateCount', v_candidate_count
      )
    );

    return jsonb_build_object(
      'batchId', v_batch.id,
      'distributed', v_distributed,
      'strategy', v_strategy,
      'deadlineAt', v_deadline_at,
      'teamSize', v_candidate_count
    );
  end if;

  raise exception 'invalid_lead_intake_action';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v2_tenant_save_course_run(p_tenant_slug text, p_course_id uuid, p_title text, p_delivery_mode text, p_starts_local timestamp without time zone, p_ends_local timestamp without time zone, p_capacity integer, p_sessions jsonb, p_course_run_id uuid DEFAULT NULL::uuid, p_run_code text DEFAULT NULL::text, p_instructor_name text DEFAULT NULL::text, p_venue_or_link text DEFAULT NULL::text, p_price_minor bigint DEFAULT NULL::bigint, p_registration_opens_local timestamp without time zone DEFAULT NULL::timestamp without time zone, p_registration_closes_local timestamp without time zone DEFAULT NULL::timestamp without time zone, p_status text DEFAULT 'planning'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_course academy.courses%rowtype;
  v_run academy.course_runs%rowtype;
  v_run_id uuid;
  v_code text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_registration_opens_at timestamptz;
  v_registration_closes_at timestamptz;
  v_enrolled_count integer;
  v_session jsonb;
  v_ordinality bigint;
  v_session_starts timestamptz;
  v_session_ends timestamptz;
  v_session_delivery text;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.academy.write'
    )
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.admissions.write'
    )
  ) then raise exception 'forbidden'; end if;

  select *
  into v_course
  from academy.courses course
  where course.id = p_course_id
    and course.tenant_id = v_tenant.id
    and course.status = 'active'
  limit 1;

  if v_course.id is null then raise exception 'invalid_course'; end if;
  if p_title is null or length(trim(p_title)) < 2 then
    raise exception 'batch_title_required';
  end if;
  if p_delivery_mode not in ('online', 'onsite', 'hybrid') then
    raise exception 'invalid_delivery_mode';
  end if;
  if p_status not in (
    'planning',
    'open',
    'in_progress',
    'completed',
    'cancelled'
  ) then raise exception 'invalid_course_run_status'; end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 100000 then
    raise exception 'invalid_course_run_capacity';
  end if;
  if p_price_minor is not null and p_price_minor < 0 then
    raise exception 'invalid_course_run_price';
  end if;
  if p_starts_local is null
     or p_ends_local is null
     or p_ends_local <= p_starts_local then
    raise exception 'invalid_course_run_dates';
  end if;
  if p_sessions is null or jsonb_typeof(p_sessions) <> 'array' then
    raise exception 'invalid_course_run_sessions';
  end if;
  if jsonb_array_length(p_sessions) > 100 then
    raise exception 'too_many_course_run_sessions';
  end if;
  if p_status in ('open', 'in_progress')
     and jsonb_array_length(p_sessions) = 0 then
    raise exception 'course_run_sessions_required';
  end if;

  v_starts_at := p_starts_local at time zone v_tenant.timezone;
  v_ends_at := p_ends_local at time zone v_tenant.timezone;
  v_registration_opens_at := case
    when p_registration_opens_local is null then null
    else p_registration_opens_local at time zone v_tenant.timezone
  end;
  v_registration_closes_at := case
    when p_registration_closes_local is null then null
    else p_registration_closes_local at time zone v_tenant.timezone
  end;

  if v_registration_opens_at is not null
     and v_registration_closes_at is not null
     and v_registration_closes_at <= v_registration_opens_at then
    raise exception 'invalid_registration_window';
  end if;
  if v_registration_closes_at is not null
     and v_registration_closes_at > v_starts_at then
    raise exception 'registration_after_batch_start';
  end if;
  if p_status = 'open'
     and v_registration_opens_at is not null
     and now() < v_registration_opens_at then
    raise exception 'course_run_registration_not_started';
  end if;
  if p_status = 'open'
     and v_registration_closes_at is not null
     and now() > v_registration_closes_at then
    raise exception 'course_run_registration_closed';
  end if;
  if p_status = 'open' and v_starts_at <= now() then
    raise exception 'course_run_start_must_be_future';
  end if;

  if p_course_run_id is null then
    if p_status not in ('planning', 'open') then
      raise exception 'invalid_course_run_transition';
    end if;

    v_code := upper(regexp_replace(
      trim(coalesce(p_run_code, '')),
      '[^A-Za-z0-9_-]+',
      '-',
      'g'
    ));
    if v_code = '' then
      v_code := v_course.course_code
        || '-'
        || to_char(
          v_starts_at at time zone v_tenant.timezone,
          'YYYYMMDD'
        );
    end if;

    if exists (
      select 1
      from academy.course_runs run
      where run.tenant_id = v_tenant.id
        and run.run_code = v_code
    ) then raise exception 'course_run_exists'; end if;

    insert into academy.course_runs (
      tenant_id,
      course_id,
      run_code,
      title,
      delivery_mode,
      starts_at,
      ends_at,
      registration_opens_at,
      registration_closes_at,
      capacity,
      instructor_name,
      venue_or_link,
      price_minor,
      currency,
      status,
      metadata
    )
    values (
      v_tenant.id,
      v_course.id,
      v_code,
      trim(p_title),
      p_delivery_mode,
      v_starts_at,
      v_ends_at,
      v_registration_opens_at,
      v_registration_closes_at,
      p_capacity,
      nullif(trim(coalesce(p_instructor_name, '')), ''),
      nullif(trim(coalesce(p_venue_or_link, '')), ''),
      p_price_minor,
      v_course.currency,
      p_status,
      jsonb_build_object('source', 'course_run_workspace')
    )
    returning * into v_run;
  else
    select *
    into v_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant.id
    for update;

    if v_run.id is null then raise exception 'course_run_not_found'; end if;

    select count(*)::integer
    into v_enrolled_count
    from academy.enrollments enrollment
    where enrollment.course_run_id = v_run.id
      and enrollment.status in ('confirmed', 'active', 'completed');

    if p_course_id <> v_run.course_id and v_enrolled_count > 0 then
      raise exception 'course_run_course_locked';
    end if;
    if p_capacity < v_enrolled_count then
      raise exception 'capacity_below_enrolled';
    end if;
    if p_status = 'cancelled' and v_enrolled_count > 0 then
      raise exception 'course_run_has_enrollments';
    end if;
    if not (
      (v_run.status = 'planning'
        and p_status in ('planning', 'open', 'cancelled'))
      or (v_run.status = 'open'
        and p_status in ('planning', 'open', 'in_progress', 'cancelled'))
      or (v_run.status = 'in_progress'
        and p_status in ('in_progress', 'completed'))
      or (v_run.status = 'completed' and p_status = 'completed')
      or (v_run.status = 'cancelled'
        and p_status in ('cancelled', 'planning'))
    ) then raise exception 'invalid_course_run_transition'; end if;
    if v_run.status = 'open'
       and p_status = 'planning'
       and v_enrolled_count > 0 then
      raise exception 'course_run_has_enrollments';
    end if;

    v_code := upper(regexp_replace(
      trim(coalesce(nullif(p_run_code, ''), v_run.run_code)),
      '[^A-Za-z0-9_-]+',
      '-',
      'g'
    ));
    if exists (
      select 1
      from academy.course_runs other_run
      where other_run.tenant_id = v_tenant.id
        and other_run.run_code = v_code
        and other_run.id <> v_run.id
    ) then raise exception 'course_run_exists'; end if;

    update academy.course_runs
    set course_id = p_course_id,
        run_code = v_code,
        title = trim(p_title),
        delivery_mode = p_delivery_mode,
        starts_at = v_starts_at,
        ends_at = v_ends_at,
        registration_opens_at = v_registration_opens_at,
        registration_closes_at = v_registration_closes_at,
        capacity = p_capacity,
        enrolled_count = v_enrolled_count,
        instructor_name = nullif(
          trim(coalesce(p_instructor_name, '')),
          ''
        ),
        venue_or_link = nullif(
          trim(coalesce(p_venue_or_link, '')),
          ''
        ),
        price_minor = p_price_minor,
        currency = v_course.currency,
        status = p_status
    where id = v_run.id
    returning * into v_run;
  end if;

  v_run_id := v_run.id;

  delete from academy.course_run_sessions
  where course_run_id = v_run_id;

  for v_session, v_ordinality in
    select item.value, item.ordinality
    from jsonb_array_elements(p_sessions)
      with ordinality as item(value, ordinality)
  loop
    begin
      v_session_starts := (
        nullif(v_session ->> 'startsAt', '')::timestamp
        at time zone v_tenant.timezone
      );
      v_session_ends := (
        nullif(v_session ->> 'endsAt', '')::timestamp
        at time zone v_tenant.timezone
      );
    exception
      when others then
        raise exception 'invalid_course_run_session_dates';
    end;

    v_session_delivery := coalesce(
      nullif(v_session ->> 'deliveryMode', ''),
      p_delivery_mode
    );

    if v_session_starts is null
       or v_session_ends is null
       or v_session_ends <= v_session_starts then
      raise exception 'invalid_course_run_session_dates';
    end if;
    if v_session_starts < v_starts_at
       or v_session_ends > v_ends_at then
      raise exception 'session_outside_course_run';
    end if;
    if v_session_delivery not in ('online', 'onsite', 'hybrid') then
      raise exception 'invalid_delivery_mode';
    end if;

    insert into academy.course_run_sessions (
      tenant_id,
      course_run_id,
      session_number,
      title,
      starts_at,
      ends_at,
      delivery_mode,
      instructor_name,
      venue_or_link,
      status,
      metadata
    )
    values (
      v_tenant.id,
      v_run_id,
      v_ordinality::integer,
      coalesce(
        nullif(trim(coalesce(v_session ->> 'title', '')), ''),
        'المحاضرة ' || v_ordinality::text
      ),
      v_session_starts,
      v_session_ends,
      v_session_delivery,
      coalesce(
        nullif(trim(coalesce(v_session ->> 'instructorName', '')), ''),
        v_run.instructor_name
      ),
      coalesce(
        nullif(trim(coalesce(v_session ->> 'venueOrLink', '')), ''),
        v_run.venue_or_link
      ),
      'scheduled',
      jsonb_build_object('source', 'course_run_workspace')
    );
  end loop;

  if exists (
    select 1
    from academy.course_run_sessions first_session
    join academy.course_run_sessions second_session
      on second_session.course_run_id = first_session.course_run_id
     and second_session.id > first_session.id
     and tstzrange(
       second_session.starts_at,
       second_session.ends_at,
       '[)'
     ) && tstzrange(
       first_session.starts_at,
       first_session.ends_at,
       '[)'
     )
    where first_session.course_run_id = v_run_id
  ) then raise exception 'course_run_sessions_overlap'; end if;

  perform private_app.write_audit(
    case
      when p_course_run_id is null then 'tenant.course_run_created'
      else 'tenant.course_run_updated'
    end,
    'course_run',
    v_run_id::text,
    v_tenant.id,
    jsonb_build_object(
      'courseId',
      v_course.id,
      'runCode',
      v_run.run_code,
      'status',
      v_run.status,
      'capacity',
      v_run.capacity,
      'sessions',
      jsonb_array_length(p_sessions)
    )
  );

  return jsonb_build_object(
    'id',
    v_run_id,
    'courseId',
    v_course.id,
    'runCode',
    v_run.run_code,
    'title',
    v_run.title,
    'status',
    v_run.status,
    'capacity',
    v_run.capacity,
    'sessions',
    jsonb_array_length(p_sessions)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v3_tenant_admissions_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb; t uuid;
begin
 result:=public.v2_tenant_admissions_snapshot(p_slug);
 select id into t from core.tenants where slug=p_slug;
 return result||jsonb_build_object('cases',(select coalesce(jsonb_agg(
  case when o.work_item_id is null then x.value else x.value||jsonb_build_object('paymentSource','woocommerce',
   'paymentSourceLabel','WooCommerce','sourcePaidAt',o.paid_at,'submittedAt',o.submitted_at,
   'salesOwnerName',s.full_name,'orderNumber',w.order_number,'paymentOnHold',h.metadata ? 'commerceSourceHold') end
  order by x.ordinality),'[]') from jsonb_array_elements(result->'cases') with ordinality x(value,ordinality)
  left join sales_core.commerce_admission_lines l on l.tenant_id=t and l.handoff_id=(x.value->>'id')::uuid
  left join sales_core.commerce_admission_orders o on o.tenant_id=l.tenant_id and o.work_item_id=l.work_item_id
  left join sales_core.commerce_order_work_items w on w.tenant_id=t and w.id=o.work_item_id
  left join academy.registration_handoffs h on h.tenant_id=t and h.id=l.handoff_id
  left join people.staff_profiles s on s.tenant_id=t and s.id=o.sales_staff_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.v4_tenant_customer_history_snapshot(p_slug text, p_contact_id uuid, p_limit integer DEFAULT 250)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.v2_tenant_update_admission_document(p_tenant_slug text, p_handoff_id uuid, p_document_type text, p_status text, p_notes text DEFAULT NULL::text, p_is_required boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_document_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.admissions.write'
  ) then raise exception 'forbidden'; end if;
  if p_document_type is null
     or length(trim(p_document_type)) < 2
     or length(trim(p_document_type)) > 80 then
    raise exception 'invalid_document_type';
  end if;
  if p_status not in (
    'pending',
    'received',
    'approved',
    'rejected',
    'not_required'
  ) then raise exception 'invalid_document_status'; end if;
  if p_status = 'rejected' and (
    p_notes is null
    or length(trim(p_notes)) < 3
  ) then raise exception 'reason_required'; end if;
  if not exists (
    select 1
    from academy.registration_handoffs handoff
    where handoff.id = p_handoff_id
      and handoff.tenant_id = v_tenant_id
      and handoff.status not in ('completed', 'cancelled')
  ) then raise exception 'admission_closed'; end if;

  insert into academy.registration_documents (
    tenant_id,
    handoff_id,
    document_type,
    is_required,
    status,
    notes,
    reviewed_at,
    reviewed_by_subject_id
  )
  values (
    v_tenant_id,
    p_handoff_id,
    trim(p_document_type),
    p_is_required,
    p_status,
    nullif(trim(coalesce(p_notes, '')), ''),
    case
      when p_status in ('approved', 'rejected', 'not_required') then now()
      else null
    end,
    case
      when p_status in ('approved', 'rejected', 'not_required')
        then private_app.current_subject_id()
      else null
    end
  )
  on conflict (handoff_id, document_type) do update
  set is_required = excluded.is_required,
      status = excluded.status,
      notes = excluded.notes,
      reviewed_at = excluded.reviewed_at,
      reviewed_by_subject_id = excluded.reviewed_by_subject_id
  returning id into v_document_id;

  perform private_app.write_audit(
    'tenant.admission_document_updated',
    'registration_document',
    v_document_id::text,
    v_tenant_id,
    jsonb_build_object(
      'handoffId',
      p_handoff_id,
      'documentType',
      trim(p_document_type),
      'status',
      p_status
    )
  );

  return jsonb_build_object(
    'id',
    v_document_id,
    'handoffId',
    p_handoff_id,
    'type',
    trim(p_document_type),
    'status',
    p_status
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v2_tenant_course_runs_snapshot(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.academy.read')
    or private_app.has_tenant_permission(v_tenant.id, 'tenant.admissions.read')
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt',
    now(),
    'timezone',
    v_tenant.timezone,
    'viewer',
    jsonb_build_object(
      'canManageBatches',
      (
        private_app.has_tenant_permission(
          v_tenant.id,
          'tenant.academy.write'
        )
        or private_app.has_tenant_permission(
          v_tenant.id,
          'tenant.admissions.write'
        )
      )
    ),
    'summary',
    jsonb_build_object(
      'totalBatches',
      (
        select count(*)
        from academy.course_runs run
        where run.tenant_id = v_tenant.id
          and run.status <> 'cancelled'
      ),
      'openBatches',
      (
        select count(*)
        from academy.course_runs run
        where run.tenant_id = v_tenant.id
          and run.status = 'open'
      ),
      'planningBatches',
      (
        select count(*)
        from academy.course_runs run
        where run.tenant_id = v_tenant.id
          and run.status = 'planning'
      ),
      'upcomingBatches',
      (
        select count(*)
        from academy.course_runs run
        where run.tenant_id = v_tenant.id
          and run.status in ('planning', 'open')
          and run.starts_at between now() and now() + interval '30 days'
      ),
      'scheduledSessions',
      (
        select count(*)
        from academy.course_run_sessions session
        where session.tenant_id = v_tenant.id
          and session.status = 'scheduled'
      )
    ),
    'courses',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        course.id,
        'courseCode',
        course.course_code,
        'nameAr',
        course.title_ar,
        'deliveryMode',
        course.delivery_mode,
        'durationHours',
        course.duration_hours,
        'durationDays',
        course.duration_days,
        'priceMinor',
        course.price_minor,
        'currency',
        course.currency,
        'status',
        course.status
      ) order by course.title_ar)
      from academy.courses course
      where course.tenant_id = v_tenant.id
        and course.status = 'active'
    ), '[]'::jsonb),
    'courseRuns',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        run.id,
        'courseId',
        run.course_id,
        'courseCode',
        course.course_code,
        'courseName',
        course.title_ar,
        'runCode',
        run.run_code,
        'title',
        coalesce(run.title, course.title_ar),
        'deliveryMode',
        run.delivery_mode,
        'startsAt',
        run.starts_at,
        'endsAt',
        run.ends_at,
        'registrationOpensAt',
        run.registration_opens_at,
        'registrationClosesAt',
        run.registration_closes_at,
        'capacity',
        run.capacity,
        'enrolledCount',
        enrollment_stats.enrolled_count,
        'availableSeats',
        case
          when run.capacity is null then null
          else greatest(run.capacity - enrollment_stats.enrolled_count, 0)
        end,
        'registrationOpen',
        (
          run.status = 'open'
          and (
            run.registration_opens_at is null
            or now() >= run.registration_opens_at
          )
          and (
            run.registration_closes_at is null
            or now() <= run.registration_closes_at
          )
          and (
            run.capacity is null
            or enrollment_stats.enrolled_count < run.capacity
          )
        ),
        'instructorName',
        run.instructor_name,
        'venueOrLink',
        run.venue_or_link,
        'priceMinor',
        run.price_minor,
        'currency',
        run.currency,
        'status',
        run.status,
        'demo',
        coalesce((run.metadata ->> 'demo')::boolean, false),
        'sessions',
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',
            session.id,
            'sessionNumber',
            session.session_number,
            'title',
            session.title,
            'startsAt',
            session.starts_at,
            'endsAt',
            session.ends_at,
            'deliveryMode',
            session.delivery_mode,
            'instructorName',
            session.instructor_name,
            'venueOrLink',
            session.venue_or_link,
            'status',
            session.status
          ) order by session.session_number)
          from academy.course_run_sessions session
          where session.course_run_id = run.id
        ), '[]'::jsonb)
      ) order by
        case run.status
          when 'open' then 0
          when 'planning' then 1
          when 'in_progress' then 2
          when 'completed' then 3
          else 4
        end,
        run.starts_at nulls last,
        run.created_at desc
      )
      from academy.course_runs run
      join academy.courses course
        on course.id = run.course_id
      cross join lateral (
        select count(*)::integer as enrolled_count
        from academy.enrollments enrollment
        where enrollment.course_run_id = run.id
          and enrollment.status in ('confirmed', 'active', 'completed')
      ) enrollment_stats
      where run.tenant_id = v_tenant.id
    ), '[]'::jsonb)
  );
end;
$function$
;

set check_function_bodies=on;
-- Inspected original attribution helper before governance wrapping.
set check_function_bodies=off;
CREATE OR REPLACE FUNCTION private_app.campaign_cash_origin_v1(p_tenant uuid, p_contact uuid, p_opportunity uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 with opportunity as (
  select o.* from sales_core.opportunities o where o.tenant_id=p_tenant and o.contact_id=p_contact and o.id=p_opportunity
 ), explicit_origin as (
  select r.origin_key from private_app.campaign_origins_v1(p_tenant) r join opportunity o
   on r.origin_key='import:'||(o.metadata->>'importRowId') and r.contact_id=p_contact
 ), first_opportunity as (
  select o.id from sales_core.opportunities o where o.tenant_id=p_tenant and o.contact_id=p_contact order by o.created_at,o.id limit 1
 )
 select coalesce((select origin_key from explicit_origin limit 1),
  case when p_opportunity=(select id from first_opportunity) then
   (select origin_key from private_app.campaign_origins_v1(p_tenant) where contact_id=p_contact and validation_status='valid' order by received_at,origin_key limit 1) end);
$function$

;
