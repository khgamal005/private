-- Read-only function definitions inspected from the current ODEIR production schema.
-- No production records. Executed against synthetic fixtures only.
CREATE OR REPLACE FUNCTION public.v2_tenant_admissions_snapshot(p_slug text)
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
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.admissions.read'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt',
    now(),
    'viewer',
    jsonb_build_object(
      'staffId',
      private_app.current_staff_id(v_tenant.id),
      'canManage',
      private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.admissions.write'
      )
    ),
    'summary',
    jsonb_build_object(
      'pendingVerification',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'pending_verification'
          and handoff.status not in ('completed', 'cancelled')
      ),
      'inReview',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'in_review'
      ),
      'accepted',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'accepted'
      ),
      'completed',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'completed'
      ),
      'documentsPending',
      (
        select count(*)
        from academy.registration_documents document
        join academy.registration_handoffs handoff
          on handoff.id = document.handoff_id
        where document.tenant_id = v_tenant.id
          and document.is_required
          and document.status not in ('approved', 'not_required')
          and handoff.status not in ('completed', 'cancelled', 'rejected')
      )
    ),
    'cases',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        handoff.id,
        'contactId',
        handoff.contact_id,
        'contactName',
        contact.full_name,
        'phone',
        contact.phone,
        'whatsapp',
        contact.whatsapp,
        'email',
        contact.email,
        'source',
        contact.source,
        'campaignName',
        contact.campaign_name,
        'salesOwnerName',
        owner.full_name,
        'courseId',
        handoff.course_id,
        'courseName',
        course.title_ar,
        'courseRunId',
        handoff.course_run_id,
        'courseRunName',
        coalesce(run.title, run.run_code),
        'runStartsAt',
        run.starts_at,
        'preferredStartDate',
        handoff.preferred_start_date,
        'status',
        handoff.status,
        'paymentStatus',
        handoff.payment_status,
        'paymentReportedAt',
        handoff.payment_reported_at,
        'paymentVerifiedAt',
        handoff.payment_verified_at,
        'paymentAmountMinor',
        handoff.payment_amount_minor,
        'paymentReference',
        handoff.payment_reference,
        'paymentRejectionReason',
        handoff.payment_rejection_reason,
        'notes',
        handoff.notes,
        'assignedStaffId',
        handoff.assigned_staff_id,
        'assignedStaffName',
        assignee.full_name,
        'acceptedAt',
        handoff.accepted_at,
        'completedAt',
        handoff.completed_at,
        'demo',
        coalesce((handoff.metadata ->> 'demo')::boolean, false),
        'documents',
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',
            document.id,
            'type',
            document.document_type,
            'required',
            document.is_required,
            'status',
            document.status,
            'fileName',
            document.file_name,
            'notes',
            document.notes,
            'reviewedAt',
            document.reviewed_at
          ) order by document.is_required desc, document.document_type)
          from academy.registration_documents document
          where document.handoff_id = handoff.id
        ), '[]'::jsonb),
        'enrollment',
        (
          select jsonb_build_object(
            'id',
            enrollment.id,
            'studentId',
            student.id,
            'studentNumber',
            student.student_number,
            'status',
            enrollment.status,
            'enrolledAt',
            enrollment.enrolled_at
          )
          from academy.enrollments enrollment
          join academy.students student on student.id = enrollment.student_id
          where enrollment.handoff_id = handoff.id
          limit 1
        )
      ) order by
        case handoff.payment_status
          when 'pending_verification' then 0
          when 'verified' then 1
          when 'rejected' then 2
          else 3
        end,
        handoff.payment_reported_at desc
      )
      from academy.registration_handoffs handoff
      join sales_core.contacts contact on contact.id = handoff.contact_id
      join academy.courses course on course.id = handoff.course_id
      left join academy.course_runs run on run.id = handoff.course_run_id
      left join people.staff_profiles owner
        on owner.id = contact.owner_staff_id
      left join people.staff_profiles assignee
        on assignee.id = handoff.assigned_staff_id
      where handoff.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'staff',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        staff.id,
        'name',
        staff.full_name,
        'roleKey',
        staff.role_key,
        'department',
        department.name_ar
      ) order by staff.full_name)
      from people.staff_profiles staff
      left join people.departments department
        on department.id = staff.department_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and (
          department.department_key = 'admissions'
          or staff.role_key in (
            'customer_service',
            'tenant_admin',
            'executive_manager'
          )
        )
    ), '[]'::jsonb),
    'courses',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        course.id,
        'courseCode',
        course.course_code,
        'nameAr',
        course.title_ar,
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
        'runCode',
        run.run_code,
        'title',
        coalesce(run.title, course.title_ar),
        'startsAt',
        run.starts_at,
        'endsAt',
        run.ends_at,
        'capacity',
        run.capacity,
        'enrolledCount',
        run.enrolled_count,
        'status',
        run.status
      ) order by run.starts_at nulls last, run.created_at)
      from academy.course_runs run
      join academy.courses course on course.id = run.course_id
      where run.tenant_id = v_tenant.id
        and run.status in ('planning', 'open', 'in_progress')
    ), '[]'::jsonb)
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.v2_tenant_update_admission(p_tenant_slug text, p_handoff_id uuid, p_action text, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_handoff academy.registration_handoffs%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_subject_id uuid;
  v_course_id uuid;
  v_course_run academy.course_runs%rowtype;
  v_stage_id uuid;
  v_activity_id uuid;
  v_task_id uuid;
  v_student_id uuid;
  v_enrollment_id uuid;
  v_student_number text;
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
  if p_action not in (
    'start_review',
    'save_details',
    'verify_payment',
    'reject_payment',
    'accept',
    'complete',
    'cancel'
  ) then raise exception 'invalid_admission_action'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_subject_id := private_app.current_subject_id();

  select *
  into v_handoff
  from academy.registration_handoffs handoff
  where handoff.id = p_handoff_id
    and handoff.tenant_id = v_tenant_id
  for update;

  if v_handoff.id is null then raise exception 'admission_not_found'; end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = v_handoff.contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;

  v_course_id := coalesce(p_course_id, v_handoff.course_id);
  if not exists (
    select 1
    from academy.courses course
    where course.id = v_course_id
      and course.tenant_id = v_tenant_id
      and course.status <> 'archived'
  ) then raise exception 'invalid_course'; end if;

  if p_course_run_id is not null then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_course_id
      and run.status in ('planning', 'open', 'in_progress');
    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
  elsif v_handoff.course_run_id is not null
        and v_handoff.course_id = v_course_id then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = v_handoff.course_run_id
      and run.tenant_id = v_tenant_id;
  end if;

  if v_handoff.status in ('completed', 'cancelled')
     and p_action <> 'save_details' then
    raise exception 'admission_closed';
  end if;

  update academy.registration_handoffs
  set course_id = v_course_id,
      course_run_id = case
        when p_course_run_id is not null then p_course_run_id
        when course_id = v_course_id then course_run_id
        else null
      end,
      assigned_staff_id = coalesce(
        assigned_staff_id,
        v_current_staff_id
      ),
      notes = coalesce(
        nullif(trim(coalesce(p_notes, '')), ''),
        notes
      )
  where id = v_handoff.id
  returning * into v_handoff;

  if p_action = 'start_review' then
    if v_handoff.status not in ('pending', 'in_review') then
      raise exception 'invalid_admission_transition';
    end if;

    update academy.registration_handoffs
    set status = 'in_review'
    where id = v_handoff.id
    returning * into v_handoff;

  elsif p_action = 'save_details' then
    if v_handoff.status in ('completed', 'cancelled') then
      raise exception 'admission_closed';
    end if;

  elsif p_action = 'verify_payment' then
    if v_handoff.payment_status = 'refunded' then
      raise exception 'invalid_payment_transition';
    end if;

    update academy.registration_handoffs
    set status = 'in_review',
        payment_status = 'verified',
        payment_verified_at = now(),
        payment_verified_by_subject_id = v_subject_id,
        payment_rejection_reason = null
    where id = v_handoff.id
    returning * into v_handoff;

    update academy.registration_documents
    set status = 'approved',
        reviewed_at = now(),
        reviewed_by_subject_id = v_subject_id,
        notes = coalesce(notes, 'تم التحقق بواسطة التسجيل والقبول')
    where handoff_id = v_handoff.id
      and document_type = 'payment_receipt';

    select stage.id
    into v_stage_id
    from sales_core.pipeline_stages stage
    where stage.tenant_id = v_tenant_id
      and stage.stage_key = 'won'
    limit 1;

    if v_stage_id is null then raise exception 'invalid_stage'; end if;

    update sales_core.opportunities
    set course_id = v_handoff.course_id,
        stage_id = v_stage_id,
        value_minor = coalesce(
          v_handoff.payment_amount_minor,
          value_minor
        ),
        next_action_type = null,
        next_action_at = null,
        status = 'won',
        lost_reason = null
    where id = v_handoff.opportunity_id;

    insert into sales_core.activities (
      tenant_id,
      opportunity_id,
      contact_id,
      actor_staff_id,
      activity_type,
      outcome,
      summary,
      result_status,
      result_quality,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      v_handoff.opportunity_id,
      v_contact.id,
      v_current_staff_id,
      'note',
      'paid',
      'تم التحقق من الدفع بواسطة التسجيل والقبول',
      'paid',
      v_contact.lead_quality,
      v_subject_id,
      jsonb_build_object(
        'source',
        'admissions_payment_verification',
        'handoffId',
        v_handoff.id
      )
    )
    returning id into v_activity_id;

    if v_contact.lead_status is distinct from 'paid' then
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
        v_contact.id,
        v_activity_id,
        v_contact.lead_status,
        'paid',
        'تم تأكيد الدفع بواسطة التسجيل والقبول',
        v_subject_id,
        jsonb_build_object('handoffId', v_handoff.id)
      );
    end if;

    update sales_core.contacts
    set status = 'converted',
        lead_status = 'paid',
        lead_status_changed_at = case
          when lead_status is distinct from 'paid' then now()
          else lead_status_changed_at
        end,
        next_action_type = null,
        next_action_at = null,
        last_activity_at = now(),
        closure_reason = null,
        closed_at = null
    where id = v_contact.id;

    update work_core.tasks
    set title = 'استكمال القبول: ' || v_contact.full_name,
        description = 'تم تأكيد الدفع · استكمل المستندات والدفعة',
        priority = 'high',
        metadata = metadata || jsonb_build_object(
          'paymentStatus',
          'verified'
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text
      and status in ('todo', 'in_progress');

  elsif p_action = 'reject_payment' then
    if p_reason is null or length(trim(p_reason)) < 3 then
      raise exception 'reason_required';
    end if;

    update academy.registration_handoffs
    set status = 'rejected',
        payment_status = 'rejected',
        payment_verified_at = null,
        payment_verified_by_subject_id = null,
        payment_rejection_reason = trim(p_reason)
    where id = v_handoff.id
    returning * into v_handoff;

    update academy.registration_documents
    set status = 'rejected',
        reviewed_at = now(),
        reviewed_by_subject_id = v_subject_id,
        notes = trim(p_reason)
    where handoff_id = v_handoff.id
      and document_type = 'payment_receipt';

    select stage.id
    into v_stage_id
    from sales_core.pipeline_stages stage
    where stage.tenant_id = v_tenant_id
      and stage.stage_key = 'proposal'
    limit 1;

    if v_stage_id is null then raise exception 'invalid_stage'; end if;

    update sales_core.opportunities
    set stage_id = v_stage_id,
        next_action_type = 'payment_followup',
        next_action_at = now() + interval '1 day',
        status = 'open',
        lost_reason = null
    where id = v_handoff.opportunity_id;

    insert into sales_core.activities (
      tenant_id,
      opportunity_id,
      contact_id,
      actor_staff_id,
      activity_type,
      outcome,
      summary,
      next_action_type,
      next_action_at,
      result_status,
      result_quality,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      v_handoff.opportunity_id,
      v_contact.id,
      v_current_staff_id,
      'note',
      'awaiting_payment',
      'تعذر تأكيد الدفع: ' || trim(p_reason),
      'payment_followup',
      now() + interval '1 day',
      'awaiting_payment',
      v_contact.lead_quality,
      v_subject_id,
      jsonb_build_object(
        'source',
        'admissions_payment_rejection',
        'handoffId',
        v_handoff.id
      )
    )
    returning id into v_activity_id;

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
      v_contact.id,
      v_activity_id,
      v_contact.lead_status,
      'awaiting_payment',
      trim(p_reason),
      v_subject_id,
      jsonb_build_object(
        'handoffId',
        v_handoff.id,
        'returnedToSales',
        true
      )
    );

    update sales_core.contacts
    set status = 'active',
        lead_status = 'awaiting_payment',
        lead_status_changed_at = now(),
        next_action_type = 'payment_followup',
        next_action_at = now() + interval '1 day',
        last_activity_at = now(),
        closure_reason = null,
        closed_at = null
    where id = v_contact.id;

    update work_core.tasks
    set status = 'cancelled',
        metadata = metadata || jsonb_build_object(
          'cancelReason',
          'payment_rejected'
        )
    where tenant_id = v_tenant_id
      and contact_id = v_contact.id
      and status in ('todo', 'in_progress')
      and coalesce(metadata ->> 'source', '') in (
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'sales_followup'
      );

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
      'متابعة دفع: ' || v_contact.full_name,
      'أعاد التسجيل الحالة للمبيعات: ' || trim(p_reason),
      'urgent',
      v_contact.owner_staff_id,
      v_subject_id,
      v_contact.id,
      v_handoff.opportunity_id,
      v_activity_id,
      now() + interval '1 day',
      jsonb_build_object(
        'source',
        'sales_followup',
        'actionType',
        'payment_followup',
        'leadStatus',
        'awaiting_payment',
        'returnedByAdmissions',
        true
      )
    )
    returning id into v_task_id;

    update work_core.tasks
    set status = 'cancelled',
        metadata = metadata || jsonb_build_object(
          'cancelReason',
          'payment_rejected'
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text;

  elsif p_action = 'accept' then
    if v_handoff.payment_status <> 'verified' then
      raise exception 'payment_not_verified';
    end if;

    update academy.registration_handoffs
    set status = 'accepted',
        accepted_at = coalesce(accepted_at, now()),
        accepted_by_subject_id = coalesce(
          accepted_by_subject_id,
          v_subject_id
        )
    where id = v_handoff.id
    returning * into v_handoff;

  elsif p_action = 'complete' then
    if v_handoff.payment_status <> 'verified' then
      raise exception 'payment_not_verified';
    end if;
    if v_handoff.course_run_id is null then
      raise exception 'course_run_required';
    end if;
    if exists (
      select 1
      from academy.registration_documents document
      where document.handoff_id = v_handoff.id
        and document.is_required
        and document.status not in ('approved', 'not_required')
    ) then raise exception 'documents_incomplete'; end if;

    select *
    into v_course_run
    from academy.course_runs run
    where run.id = v_handoff.course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_handoff.course_id
      and run.status in ('planning', 'open', 'in_progress')
    for update;

    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
    if v_course_run.capacity is not null
       and v_course_run.enrolled_count >= v_course_run.capacity then
      raise exception 'course_run_full';
    end if;

    v_student_number := 'STU-'
      || to_char(now(), 'YYYY')
      || '-'
      || upper(substr(replace(v_contact.id::text, '-', ''), 1, 8));

    insert into academy.students (
      tenant_id,
      student_key,
      student_number,
      contact_id,
      full_name,
      phone,
      email,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'contact-' || v_contact.id::text,
      v_student_number,
      v_contact.id,
      v_contact.full_name,
      coalesce(v_contact.phone, v_contact.whatsapp),
      v_contact.email,
      v_subject_id,
      jsonb_build_object(
        'source',
        'registration_admission',
        'handoffId',
        v_handoff.id
      )
    )
    on conflict (tenant_id, contact_id) do update
    set full_name = excluded.full_name,
        phone = coalesce(excluded.phone, academy.students.phone),
        email = coalesce(excluded.email, academy.students.email),
        status = 'active'
    returning id into v_student_id;

    insert into academy.enrollments (
      tenant_id,
      enrollment_key,
      handoff_id,
      student_id,
      course_id,
      course_run_id,
      status,
      confirmed_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'handoff-' || v_handoff.id::text,
      v_handoff.id,
      v_student_id,
      v_handoff.course_id,
      v_handoff.course_run_id,
      'confirmed',
      v_subject_id,
      jsonb_build_object('source', 'admissions')
    )
    on conflict (handoff_id) do update
    set student_id = excluded.student_id,
        course_id = excluded.course_id,
        course_run_id = excluded.course_run_id,
        status = 'confirmed',
        confirmed_by_subject_id = excluded.confirmed_by_subject_id
    returning id into v_enrollment_id;

    update academy.course_runs run
    set enrolled_count = (
      select count(*)
      from academy.enrollments enrollment
      where enrollment.course_run_id = run.id
        and enrollment.status in ('confirmed', 'active', 'completed')
    )
    where run.id = v_handoff.course_run_id;

    update academy.registration_handoffs
    set status = 'completed',
        accepted_at = coalesce(accepted_at, now()),
        accepted_by_subject_id = coalesce(
          accepted_by_subject_id,
          v_subject_id
        ),
        completed_at = now(),
        completed_by_subject_id = v_subject_id
    where id = v_handoff.id
    returning * into v_handoff;

    update work_core.tasks
    set status = 'completed',
        completed_at = now(),
        completion_timing = case
          when now() <= due_at then 'on_time'
          else 'late'
        end,
        metadata = metadata || jsonb_build_object(
          'enrollmentId',
          v_enrollment_id
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text
      and status in ('todo', 'in_progress');

  elsif p_action = 'cancel' then
    if p_reason is null or length(trim(p_reason)) < 3 then
      raise exception 'reason_required';
    end if;

    update academy.registration_handoffs
    set status = 'cancelled',
        notes = concat_ws(
          E'\n',
          notes,
          'سبب الإلغاء: ' || trim(p_reason)
        )
    where id = v_handoff.id
    returning * into v_handoff;

    update work_core.tasks
    set status = 'cancelled',
        metadata = metadata || jsonb_build_object(
          'cancelReason',
          trim(p_reason)
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text;
  end if;

  perform private_app.write_audit(
    'tenant.admission_updated',
    'registration_handoff',
    v_handoff.id::text,
    v_tenant_id,
    jsonb_build_object(
      'action',
      p_action,
      'status',
      v_handoff.status,
      'paymentStatus',
      v_handoff.payment_status,
      'studentId',
      v_student_id,
      'enrollmentId',
      v_enrollment_id
    )
  );

  return jsonb_build_object(
    'id',
    v_handoff.id,
    'action',
    p_action,
    'status',
    v_handoff.status,
    'paymentStatus',
    v_handoff.payment_status,
    'taskId',
    v_task_id,
    'studentId',
    v_student_id,
    'enrollmentId',
    v_enrollment_id
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.v3_tenant_commerce_order_action(p_tenant_slug text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_settings sales_core.commerce_order_routing_settings%rowtype;
  v_work_item sales_core.commerce_order_work_items%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_mode text;
  v_strategy text;
  v_picker_mode text;
  v_queue_owner_id uuid;
  v_assignee_id uuid;
  v_ids_json jsonb;
  v_item_ids uuid[] := '{}'::uuid[];
  v_due_minutes integer;
  v_count integer := 0;
  v_skipped integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_commerce_order_payload';
  end if;

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
    'tenant.commerce_orders.distribute'
  ) then
    raise exception 'forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'woocommerce-order-routing:' || v_tenant.id::text,
      2401
    )
  );

  insert into sales_core.commerce_order_routing_settings (
    tenant_id,
    routing_mode,
    queue_owner_staff_id,
    enabled_at
  )
  values (
    v_tenant.id,
    'queue',
    private_app.commerce_order_queue_owner(v_tenant.id, null),
    transaction_timestamp()
  )
  on conflict (tenant_id) do nothing;

  select settings.*
  into v_settings
  from sales_core.commerce_order_routing_settings settings
  where settings.tenant_id = v_tenant.id
  for update;

  if v_action = 'set_routing' then
    v_mode := lower(trim(coalesce(
      p_payload ->> 'routingMode',
      p_payload ->> 'mode',
      ''
    )));
    if v_mode not in ('queue', 'auto_fair', 'auto_online') then
      raise exception 'invalid_commerce_order_routing_mode';
    end if;

    if nullif(trim(p_payload ->> 'queueOwnerStaffId'), '') is not null then
      if (p_payload ->> 'queueOwnerStaffId') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then
        raise exception 'invalid_commerce_order_queue_owner';
      end if;
      v_queue_owner_id := (p_payload ->> 'queueOwnerStaffId')::uuid;
    else
      v_queue_owner_id := v_settings.queue_owner_staff_id;
    end if;

    v_queue_owner_id := private_app.commerce_order_queue_owner(
      v_tenant.id,
      v_queue_owner_id
    );
    if v_mode = 'queue' and v_queue_owner_id is null then
      raise exception 'commerce_order_queue_owner_required';
    end if;

    if coalesce(p_payload ->> 'defaultDueMinutes', '')
       ~ '^[0-9]{1,5}$'
    then
      v_due_minutes := (p_payload ->> 'defaultDueMinutes')::integer;
    elsif coalesce(p_payload ->> 'slaMinutes', '')
       ~ '^[0-9]{1,5}$'
    then
      v_due_minutes := (p_payload ->> 'slaMinutes')::integer;
    else
      v_due_minutes := v_settings.default_due_minutes;
    end if;
    if v_due_minutes not between 5 and 10080 then
      raise exception 'invalid_commerce_order_due_minutes';
    end if;

    update sales_core.commerce_order_routing_settings settings
    set routing_mode = v_mode,
        queue_owner_staff_id = v_queue_owner_id,
        default_due_minutes = v_due_minutes,
        updated_by_subject_id = private_app.current_subject_id()
    where settings.tenant_id = v_tenant.id;

    perform private_app.write_audit(
      'tenant.commerce_order_routing_updated',
      'commerce_order_routing_settings',
      v_tenant.id::text,
      v_tenant.id,
      jsonb_build_object(
        'routingMode', v_mode,
        'queueOwnerStaffId', v_queue_owner_id,
        'defaultDueMinutes', v_due_minutes
      )
    );

    return jsonb_build_object(
      'mode', v_mode,
      'routingMode', v_mode,
      'queueOwnerStaffId', v_queue_owner_id,
      'slaMinutes', v_due_minutes,
      'defaultDueMinutes', v_due_minutes,
      'enabledAt', v_settings.enabled_at,
      'saved', true
    );
  end if;

  if p_payload ? 'itemIds' then
    v_ids_json := p_payload -> 'itemIds';
  elsif p_payload ? 'workItemIds' then
    v_ids_json := p_payload -> 'workItemIds';
  elsif nullif(trim(p_payload ->> 'workItemId'), '') is not null then
    v_ids_json := jsonb_build_array(p_payload ->> 'workItemId');
  else
    v_ids_json := '[]'::jsonb;
  end if;

  if jsonb_typeof(v_ids_json) <> 'array'
     or jsonb_array_length(v_ids_json) > 250
  then
    raise exception 'invalid_commerce_order_work_items';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_ids_json) item(value)
    where item.value !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid_commerce_order_work_items';
  end if;
  select coalesce(array_agg(item.value::uuid), '{}'::uuid[])
  into v_item_ids
  from jsonb_array_elements_text(v_ids_json) item(value);

  if v_action = 'assign' then
    if cardinality(v_item_ids) = 0 then
      raise exception 'commerce_order_work_items_required';
    end if;
    if nullif(trim(p_payload ->> 'staffId'), '') is null
       or (p_payload ->> 'staffId') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      raise exception 'invalid_sales_assignee';
    end if;
    v_assignee_id := (p_payload ->> 'staffId')::uuid;

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

    for v_work_item in
      select work_item.*
      from sales_core.commerce_order_work_items work_item
      join work_core.tasks task on task.id = work_item.task_id
      where work_item.tenant_id = v_tenant.id
        and work_item.id = any(v_item_ids)
        and task.status in ('todo', 'in_progress')
      order by work_item.id
      for update of work_item
    loop
      update work_core.tasks task
      set assigned_staff_id = v_assignee_id
      where task.id = v_work_item.task_id
        and task.tenant_id = v_tenant.id
        and task.status in ('todo', 'in_progress');

      update sales_core.commerce_order_work_items work_item
      set assigned_staff_id = v_assignee_id,
          routing_state = 'assigned',
          assignment_strategy = 'selected',
          assigned_at = clock_timestamp(),
          last_error = null,
          metadata = work_item.metadata || jsonb_build_object(
            'lastAssignedBySubjectId', private_app.current_subject_id(),
            'lastAssignedAt', clock_timestamp()
          )
      where work_item.id = v_work_item.id;

      if v_work_item.contact_id is not null then
        update sales_core.contacts contact
        set owner_staff_id = v_assignee_id
        where contact.id = v_work_item.contact_id
          and contact.tenant_id = v_tenant.id
          and contact.owner_staff_id is null;
      end if;

      v_count := v_count + 1;
    end loop;

    update sales_core.sales_assignment_profiles profile
    set last_assigned_at = clock_timestamp()
    where profile.tenant_id = v_tenant.id
      and profile.staff_id = v_assignee_id;

    perform private_app.write_audit(
      'tenant.commerce_order_tasks_assigned',
      'commerce_order_work_item',
      null,
      v_tenant.id,
      jsonb_build_object(
        'staffId', v_assignee_id,
        'assigned', v_count,
        'workItemIds', to_jsonb(v_item_ids)
      )
    );

    return jsonb_build_object(
      'assigned', v_count,
      'queued', 0,
      'staffId', v_assignee_id
    );
  end if;

  if v_action = 'auto_distribute' then
    if cardinality(v_item_ids) = 0 then
      raise exception 'commerce_order_work_items_required';
    end if;
    v_strategy := lower(trim(coalesce(
      p_payload ->> 'strategy',
      'fair'
    )));
    if v_strategy not in ('fair', 'online_only') then
      raise exception 'invalid_distribution_strategy';
    end if;
    v_picker_mode := case
      when v_strategy = 'online_only' then 'auto_online'
      else 'auto_fair'
    end;

    for v_work_item in
      select work_item.*
      from sales_core.commerce_order_work_items work_item
      join work_core.tasks task on task.id = work_item.task_id
      where work_item.tenant_id = v_tenant.id
        and work_item.routing_state = 'awaiting_distribution'
        and task.status in ('todo', 'in_progress')
        and work_item.id = any(v_item_ids)
      order by work_item.first_seen_at, work_item.id
      for update of work_item skip locked
      limit 250
    loop
      v_assignee_id := private_app.commerce_order_pick_assignee(
        v_tenant.id,
        v_picker_mode
      );
      if v_assignee_id is null then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      update work_core.tasks task
      set assigned_staff_id = v_assignee_id
      where task.id = v_work_item.task_id
        and task.tenant_id = v_tenant.id
        and task.status in ('todo', 'in_progress');

      update sales_core.commerce_order_work_items work_item
      set assigned_staff_id = v_assignee_id,
          routing_state = 'assigned',
          assignment_strategy = v_strategy,
          assigned_at = clock_timestamp(),
          last_error = null,
          metadata = work_item.metadata || jsonb_build_object(
            'lastAssignedBySubjectId', private_app.current_subject_id(),
            'lastAssignedAt', clock_timestamp()
          )
      where work_item.id = v_work_item.id;

      if v_work_item.contact_id is not null then
        update sales_core.contacts contact
        set owner_staff_id = v_assignee_id
        where contact.id = v_work_item.contact_id
          and contact.tenant_id = v_tenant.id
          and contact.owner_staff_id is null;
      end if;

      update sales_core.sales_assignment_profiles profile
      set last_assigned_at = clock_timestamp()
      where profile.tenant_id = v_tenant.id
        and profile.staff_id = v_assignee_id;

      v_count := v_count + 1;
    end loop;

    perform private_app.write_audit(
      'tenant.commerce_order_tasks_auto_distributed',
      'commerce_order_work_item',
      null,
      v_tenant.id,
      jsonb_build_object(
        'strategy', v_strategy,
        'assigned', v_count,
        'skippedForCapacity', v_skipped,
        'workItemIds', to_jsonb(v_item_ids)
      )
    );

    return jsonb_build_object(
      'strategy', v_strategy,
      'assigned', v_count,
      'queued', v_skipped,
      'skippedForCapacity', v_skipped
    );
  end if;

  raise exception 'invalid_commerce_order_action';
end;
$function$;


CREATE OR REPLACE FUNCTION public.v3_tenant_transition_task(p_tenant_slug text, p_task_id uuid, p_status text DEFAULT NULL::text, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
