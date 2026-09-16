-- Canonical function bodies captured read-only on 2026-09-16.

CREATE OR REPLACE FUNCTION private_app.current_subject_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.id
  from access_control.subjects s
  where auth.uid() is not null
    and s.auth_user_id = auth.uid()
    and s.status = 'active'
  limit 1
$function$;

CREATE OR REPLACE FUNCTION private_app.has_platform_permission(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and exists (
    select 1
    from access_control.subjects s
    join access_control.memberships m
      on m.subject_id = s.id
     and m.scope = 'platform'
     and m.status = 'active'
    join access_control.membership_roles mr on mr.membership_id = m.id
    join access_control.roles r
      on r.id = mr.role_id
     and r.scope = 'platform'
    join access_control.role_permissions rp on rp.role_id = r.id
    where s.auth_user_id = auth.uid()
      and s.status = 'active'
      and not s.must_change_password
      and rp.permission_key = p_permission
  )
$function$;

CREATE OR REPLACE FUNCTION private_app.has_tenant_permission(p_tenant_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
      join core.tenants tenant
        on tenant.id=membership.tenant_id
       and tenant.status in ('trial','active')
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and membership.tenant_id=p_tenant_id
        and role_permission.permission_key=p_permission
    )
  )
$function$;

CREATE OR REPLACE FUNCTION private_app.has_accounting_permission(p_tenant_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.tenant_accounting.support')
    or exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
       and membership.tenant_id=p_tenant_id
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id and role.scope='tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and role_permission.permission_key=p_permission
    )
  )
$function$;

CREATE OR REPLACE FUNCTION private_app.current_staff_id(p_tenant_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select sp.id
  from access_control.subjects s
  join access_control.memberships m
    on m.subject_id = s.id
   and m.tenant_id = p_tenant_id
   and m.scope = 'tenant'
   and m.status = 'active'
  join people.staff_profiles sp
    on sp.membership_id = m.id
   and sp.tenant_id = p_tenant_id
   and sp.employment_status = 'active'
  where s.auth_user_id = auth.uid()
    and s.status = 'active'
  limit 1
$function$;

CREATE OR REPLACE FUNCTION private_app.can_access_tenant(p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
      join core.tenants tenant
        on tenant.id=membership.tenant_id
       and tenant.status in ('trial','active')
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and membership.tenant_id=p_tenant_id
    )
  )
$function$;

CREATE OR REPLACE FUNCTION private_app.write_audit(p_action text, p_resource_type text, p_resource_id text DEFAULT NULL::text, p_tenant_id uuid DEFAULT NULL::uuid, p_context jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    p_tenant_id,
    private_app.current_subject_id(),
    p_action,
    p_resource_type,
    p_resource_id,
    coalesce(p_context, '{}'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.training_eligibility(p_enrollment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_enrollment academy.enrollments%rowtype;
  v_run academy.course_runs%rowtype;
  v_min_attendance numeric(5,2);
  v_min_assessment numeric(5,2);
  v_require_completed boolean;
  v_certificate_enabled boolean;
  v_total_sessions integer;
  v_completed_sessions integer;
  v_recorded_sessions integer;
  v_attended_sessions integer;
  v_attendance_percent numeric(5,2);
  v_assessment_percent numeric(5,2);
  v_reasons jsonb := '[]'::jsonb;
  v_eligible boolean;
begin
  select *
  into v_enrollment
  from academy.enrollments enrollment
  where enrollment.id = p_enrollment_id;

  if v_enrollment.id is null then
    raise exception 'enrollment_not_found';
  end if;

  select *
  into v_run
  from academy.course_runs run
  where run.id = v_enrollment.course_run_id;

  select
    coalesce(rule.min_attendance_percent, 75),
    coalesce(rule.min_assessment_percent, 70),
    coalesce(rule.require_completed_run, true),
    coalesce(rule.certificate_enabled, true)
  into
    v_min_attendance,
    v_min_assessment,
    v_require_completed,
    v_certificate_enabled
  from academy.course_runs run
  left join academy.course_run_rules rule
    on rule.course_run_id = run.id
  where run.id = v_enrollment.course_run_id;

  select
    count(*) filter (where session.status <> 'cancelled')::integer,
    count(*) filter (where session.status = 'completed')::integer
  into v_total_sessions, v_completed_sessions
  from academy.course_run_sessions session
  where session.course_run_id = v_enrollment.course_run_id;

  select
    count(*)::integer,
    count(*) filter (
      where attendance.status in ('present', 'late')
    )::integer
  into v_recorded_sessions, v_attended_sessions
  from academy.attendance_records attendance
  join academy.course_run_sessions session
    on session.id = attendance.session_id
   and session.status <> 'cancelled'
  where attendance.enrollment_id = v_enrollment.id;

  v_attendance_percent := case
    when v_total_sessions = 0 then 0
    else round(
      (v_attended_sessions::numeric * 100) / v_total_sessions,
      2
    )
  end;

  select round((assessment.score * 100) / assessment.max_score, 2)
  into v_assessment_percent
  from academy.assessment_results assessment
  where assessment.enrollment_id = v_enrollment.id
    and assessment.assessment_key = 'final'
  limit 1;

  if not v_certificate_enabled then
    v_reasons := v_reasons || jsonb_build_array('certificate_disabled');
  end if;
  if v_require_completed and v_run.status <> 'completed' then
    v_reasons := v_reasons || jsonb_build_array('run_not_completed');
  end if;
  if v_total_sessions = 0 then
    v_reasons := v_reasons || jsonb_build_array('no_sessions');
  end if;
  if v_completed_sessions < v_total_sessions then
    v_reasons := v_reasons || jsonb_build_array('sessions_pending');
  end if;
  if v_recorded_sessions < v_total_sessions then
    v_reasons := v_reasons || jsonb_build_array('attendance_incomplete');
  end if;
  if v_attendance_percent < v_min_attendance then
    v_reasons := v_reasons || jsonb_build_array(
      'attendance_below_threshold'
    );
  end if;
  if v_assessment_percent is null then
    v_reasons := v_reasons || jsonb_build_array('assessment_missing');
  elsif v_assessment_percent < v_min_assessment then
    v_reasons := v_reasons || jsonb_build_array(
      'assessment_below_threshold'
    );
  end if;

  v_eligible := jsonb_array_length(v_reasons) = 0;

  return jsonb_build_object(
    'eligible',
    v_eligible,
    'reasons',
    v_reasons,
    'totalSessions',
    v_total_sessions,
    'completedSessions',
    v_completed_sessions,
    'recordedSessions',
    v_recorded_sessions,
    'attendedSessions',
    v_attended_sessions,
    'attendancePercent',
    v_attendance_percent,
    'assessmentPercent',
    v_assessment_percent,
    'minAttendancePercent',
    v_min_attendance,
    'minAssessmentPercent',
    v_min_assessment
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.ensure_course_run_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  insert into academy.course_run_rules (
    tenant_id,
    course_run_id
  )
  values (
    new.tenant_id,
    new.id
  )
  on conflict (course_run_id) do nothing;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.validate_handoff_course_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_run academy.course_runs%rowtype;
  v_enrolled_count integer;
begin
  if new.course_run_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.course_run_id is not distinct from old.course_run_id
     and new.course_id is not distinct from old.course_id
     and new.tenant_id is not distinct from old.tenant_id then
    return new;
  end if;

  select *
  into v_run
  from academy.course_runs run
  where run.id = new.course_run_id
  for update;

  if v_run.id is null
     or v_run.tenant_id <> new.tenant_id
     or v_run.course_id <> new.course_id then
    raise exception 'invalid_course_run';
  end if;
  if v_run.status <> 'open' then
    raise exception 'course_run_not_open';
  end if;
  if v_run.registration_opens_at is not null
     and now() < v_run.registration_opens_at then
    raise exception 'course_run_registration_not_started';
  end if;
  if v_run.registration_closes_at is not null
     and now() > v_run.registration_closes_at then
    raise exception 'course_run_registration_closed';
  end if;

  select count(*)::integer
  into v_enrolled_count
  from academy.enrollments enrollment
  where enrollment.course_run_id = v_run.id
    and enrollment.status in ('confirmed', 'active', 'completed');

  if v_run.capacity is not null
     and v_enrolled_count >= v_run.capacity then
    raise exception 'course_run_full';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.validate_enrollment_course_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_run academy.course_runs%rowtype;
  v_enrolled_count integer;
  v_lifecycle_update boolean := false;
begin
  if new.status not in ('confirmed', 'active', 'completed') then
    return new;
  end if;

  select *
  into v_run
  from academy.course_runs run
  where run.id = new.course_run_id
  for update;

  if v_run.id is null
     or v_run.tenant_id <> new.tenant_id
     or v_run.course_id <> new.course_id then
    raise exception 'invalid_course_run';
  end if;

  if tg_op = 'UPDATE' then
    v_lifecycle_update :=
      new.course_run_id is not distinct from old.course_run_id
      and new.course_id is not distinct from old.course_id
      and new.tenant_id is not distinct from old.tenant_id
      and new.status in ('active', 'completed');
  end if;

  if v_lifecycle_update then
    if v_run.status not in ('open', 'in_progress', 'completed') then
      raise exception 'course_run_not_operational';
    end if;
    return new;
  end if;

  if v_run.status <> 'open' then
    raise exception 'course_run_not_open';
  end if;
  if v_run.registration_opens_at is not null
     and now() < v_run.registration_opens_at then
    raise exception 'course_run_registration_not_started';
  end if;
  if v_run.registration_closes_at is not null
     and now() > v_run.registration_closes_at then
    raise exception 'course_run_registration_closed';
  end if;

  select count(*)::integer
  into v_enrolled_count
  from academy.enrollments enrollment
  where enrollment.course_run_id = v_run.id
    and enrollment.status in ('confirmed', 'active', 'completed')
    and enrollment.id <> new.id;

  if v_run.capacity is not null
     and v_enrolled_count >= v_run.capacity then
    raise exception 'course_run_full';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.validate_enrollment_training_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_enrollment academy.enrollments%rowtype;
begin
  select *
  into v_enrollment
  from academy.enrollments enrollment
  where enrollment.id = new.enrollment_id;

  if v_enrollment.id is null
     or v_enrollment.tenant_id <> new.tenant_id
     or v_enrollment.course_run_id <> new.course_run_id then
    raise exception 'invalid_training_record';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.validate_attendance_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_enrollment academy.enrollments%rowtype;
  v_session academy.course_run_sessions%rowtype;
begin
  select *
  into v_enrollment
  from academy.enrollments enrollment
  where enrollment.id = new.enrollment_id;

  select *
  into v_session
  from academy.course_run_sessions session
  where session.id = new.session_id;

  if v_enrollment.id is null or v_session.id is null then
    raise exception 'invalid_training_record';
  end if;
  if v_enrollment.tenant_id <> new.tenant_id
     or v_session.tenant_id <> new.tenant_id
     or v_enrollment.course_run_id <> new.course_run_id
     or v_session.course_run_id <> new.course_run_id then
    raise exception 'invalid_training_record';
  end if;
  if v_enrollment.status in ('withdrawn', 'cancelled') then
    raise exception 'enrollment_inactive';
  end if;
  if v_session.status = 'cancelled' then
    raise exception 'session_cancelled';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.accounting_next_number(p_tenant_id uuid, p_sequence_key text, p_on_date date, p_prefix text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_year integer:=extract(year from coalesce(p_on_date,current_date))::integer;
  v_number bigint;
begin
  insert into accounting_core.document_sequences(
    tenant_id,sequence_key,calendar_year,next_value
  ) values(p_tenant_id,p_sequence_key,v_year,2)
  on conflict(tenant_id,sequence_key,calendar_year) do update
  set next_value=accounting_core.document_sequences.next_value+1
  returning next_value-1 into v_number;
  return upper(p_prefix)||'-'||v_year::text||'-'||lpad(v_number::text,6,'0');
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.accounting_guard_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op='DELETE' then
    if old.status<>'draft' then raise exception 'issued_document_immutable'; end if;
    return old;
  end if;
  if old.status in ('issued','converted','cancelled','rejected','expired') then
    raise exception 'issued_document_immutable';
  end if;
  if old.status<>'draft' and (
    new.document_type is distinct from old.document_type
    or new.customer_account_id is distinct from old.customer_account_id
    or new.contact_id is distinct from old.contact_id
    or new.issue_date is distinct from old.issue_date
    or new.valid_until is distinct from old.valid_until
    or new.due_date is distinct from old.due_date
    or new.currency is distinct from old.currency
    or new.customer_name_snapshot is distinct from old.customer_name_snapshot
    or new.customer_tax_number_snapshot is distinct from old.customer_tax_number_snapshot
    or new.subtotal_minor is distinct from old.subtotal_minor
    or new.discount_minor is distinct from old.discount_minor
    or new.tax_minor is distinct from old.tax_minor
    or new.total_minor is distinct from old.total_minor
    or new.notes is distinct from old.notes
    or new.terms is distinct from old.terms
  ) then raise exception 'issued_document_immutable'; end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.accounting_guard_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_status text;
begin
  select status into v_status from accounting_core.sales_documents
  where tenant_id=coalesce(new.tenant_id,old.tenant_id)
    and id=coalesce(new.document_id,old.document_id);
  if v_status is distinct from 'draft' then raise exception 'issued_document_immutable'; end if;
  return case when tg_op='DELETE' then old else new end;
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.accounting_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ begin raise exception 'accounting_event_append_only'; end; $function$;

CREATE OR REPLACE FUNCTION private_app.build_joining_message(p_enrollment_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_values jsonb;
  v_fallback text;
begin
  select
    enrollment.tenant_id,
    jsonb_build_object(
      'name', student.full_name,
      'course', course.title_ar,
      'batch', coalesce(run.title, course.title_ar),
      'date',
        coalesce(
          to_char(
            run.starts_at at time zone tenant.timezone,
            'YYYY-MM-DD HH24:MI'
          ),
          'سيحدد لاحقًا'
        ),
      'time',
        coalesce(
          to_char(
            run.starts_at at time zone tenant.timezone,
            'HH24:MI'
          ),
          'سيحدد لاحقًا'
        ),
      'lecture_schedule',
        private_app.course_run_lecture_schedule(
          run.id,
          tenant.timezone
        ),
      'delivery_mode',
        case run.delivery_mode
          when 'online' then 'عن بُعد'
          when 'onsite' then 'حضوري'
          else 'هجين'
        end,
      'location', coalesce(run.venue_or_link, 'سيحدد لاحقًا'),
      'link', coalesce(run.venue_or_link, 'سيحدد لاحقًا'),
      'trainer', coalesce(run.instructor_name, 'سيحدد لاحقًا'),
      'center', tenant.name
    ),
    format(
      E'مرحبًا %s،\nتم تسجيلك في %s ضمن %s.\nبداية البرنامج: %s\nموعد المحاضرات: %s\nمكان/رابط الحضور: %s',
      student.full_name,
      course.title_ar,
      coalesce(run.title, course.title_ar),
      coalesce(
        to_char(
          run.starts_at at time zone tenant.timezone,
          'YYYY-MM-DD HH24:MI'
        ),
        'سيحدد لاحقًا'
      ),
      private_app.course_run_lecture_schedule(
        run.id,
        tenant.timezone
      ),
      coalesce(run.venue_or_link, 'سيحدد لاحقًا')
    )
  into v_tenant_id, v_values, v_fallback
  from academy.enrollments enrollment
  join academy.students student
    on student.id = enrollment.student_id
  join academy.course_runs run
    on run.id = enrollment.course_run_id
  join academy.courses course
    on course.id = enrollment.course_id
  join core.tenants tenant
    on tenant.id = enrollment.tenant_id
  where enrollment.id = p_enrollment_id;

  if v_tenant_id is null then raise exception 'enrollment_not_found'; end if;

  return private_app.message_template_field(
    v_tenant_id,
    'joining_instructions',
    'any',
    'body',
    v_values,
    v_fallback
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private_app.update_admission_before_commerce_v1(p_tenant_slug text, p_handoff_id uuid, p_action text, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
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

CREATE OR REPLACE FUNCTION public.v2_tenant_update_admission(p_tenant_slug text, p_handoff_id uuid, p_action text, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t uuid; contact uuid;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.current_subject_id() is null or t is null or not private_app.has_tenant_permission(t,'tenant.admissions.write')
  then raise exception 'forbidden';end if;
 select contact_id into contact from academy.registration_handoffs where tenant_id=t and id=p_handoff_id;
 if contact is null then raise exception 'admission_not_found';end if;
 perform 1 from commerce_sync.connections where tenant_id=t and id in (
  select w.connection_id from sales_core.commerce_admission_lines l join sales_core.commerce_order_work_items w
   on w.tenant_id=t and w.id=l.work_item_id where l.tenant_id=t and l.handoff_id=p_handoff_id) order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||contact::text,31603));
 perform 1 from sales_core.contacts where tenant_id=t and id=contact for update;
 return private_app.update_admission_before_commerce_v1(p_tenant_slug,p_handoff_id,p_action,p_course_id,p_course_run_id,p_notes,p_reason);
end $function$;

CREATE OR REPLACE FUNCTION public.v2_tenant_update_training_operation(p_tenant_slug text, p_action text, p_enrollment_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_session_id uuid DEFAULT NULL::uuid, p_attendance_status text DEFAULT NULL::text, p_minutes_late integer DEFAULT 0, p_score numeric DEFAULT NULL::numeric, p_max_score numeric DEFAULT 100, p_notes text DEFAULT NULL::text, p_channel text DEFAULT 'manual'::text, p_min_attendance_percent numeric DEFAULT NULL::numeric, p_min_assessment_percent numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_actor_subject_id uuid;
  v_enrollment academy.enrollments%rowtype;
  v_run academy.course_runs%rowtype;
  v_session academy.course_run_sessions%rowtype;
  v_student academy.students%rowtype;
  v_message text;
  v_eligibility jsonb;
  v_certificate academy.certificates%rowtype;
  v_active_enrollments integer;
  v_session_attendance integer;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.training.write'
  ) then raise exception 'forbidden'; end if;

  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;

  if p_action = 'update_rules' then
    select *
    into v_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant.id
    for update;

    if v_run.id is null then raise exception 'invalid_course_run'; end if;
    if p_min_attendance_percent is null
       or p_min_attendance_percent < 0
       or p_min_attendance_percent > 100 then
      raise exception 'invalid_attendance_threshold';
    end if;
    if p_min_assessment_percent is null
       or p_min_assessment_percent < 0
       or p_min_assessment_percent > 100 then
      raise exception 'invalid_assessment_threshold';
    end if;

    insert into academy.course_run_rules (
      tenant_id,
      course_run_id,
      min_attendance_percent,
      min_assessment_percent
    )
    values (
      v_tenant.id,
      v_run.id,
      p_min_attendance_percent,
      p_min_assessment_percent
    )
    on conflict (course_run_id) do update
    set min_attendance_percent = excluded.min_attendance_percent,
        min_assessment_percent = excluded.min_assessment_percent;

    insert into audit_log.events (
      tenant_id,
      actor_subject_id,
      action,
      resource_type,
      resource_id,
      context
    )
    values (
      v_tenant.id,
      v_actor_subject_id,
      'training.rules.updated',
      'course_run',
      v_run.id::text,
      jsonb_build_object(
        'minAttendancePercent',
        p_min_attendance_percent,
        'minAssessmentPercent',
        p_min_assessment_percent
      )
    );

    return jsonb_build_object(
      'courseRunId',
      v_run.id,
      'action',
      p_action
    );
  end if;

  select *
  into v_enrollment
  from academy.enrollments enrollment
  where enrollment.id = p_enrollment_id
    and enrollment.tenant_id = v_tenant.id
  for update;

  if v_enrollment.id is null then
    raise exception 'enrollment_not_found';
  end if;

  select *
  into v_run
  from academy.course_runs run
  where run.id = v_enrollment.course_run_id
  for update;

  select *
  into v_student
  from academy.students student
  where student.id = v_enrollment.student_id;

  if p_action = 'set_attendance' then
    if p_attendance_status not in (
      'present',
      'late',
      'absent',
      'excused'
    ) then raise exception 'invalid_attendance_status'; end if;
    if p_attendance_status = 'late'
       and (p_minutes_late is null or p_minutes_late < 1) then
      raise exception 'late_minutes_required';
    end if;
    if p_attendance_status <> 'late'
       and coalesce(p_minutes_late, 0) <> 0 then
      raise exception 'invalid_late_minutes';
    end if;

    select *
    into v_session
    from academy.course_run_sessions session
    where session.id = p_session_id
      and session.course_run_id = v_run.id
      and session.tenant_id = v_tenant.id
    for update;

    if v_session.id is null then raise exception 'invalid_session'; end if;
    if v_session.status = 'cancelled' then
      raise exception 'session_cancelled';
    end if;

    insert into academy.attendance_records (
      tenant_id,
      course_run_id,
      session_id,
      enrollment_id,
      status,
      minutes_late,
      notes,
      marked_at,
      marked_by_subject_id
    )
    values (
      v_tenant.id,
      v_run.id,
      v_session.id,
      v_enrollment.id,
      p_attendance_status,
      case
        when p_attendance_status = 'late' then p_minutes_late
        else 0
      end,
      nullif(trim(coalesce(p_notes, '')), ''),
      now(),
      v_actor_subject_id
    )
    on conflict (enrollment_id, session_id) do update
    set status = excluded.status,
        minutes_late = excluded.minutes_late,
        notes = excluded.notes,
        marked_at = now(),
        marked_by_subject_id = excluded.marked_by_subject_id;

    if v_run.status = 'open' then
      update academy.course_runs
      set status = 'in_progress'
      where id = v_run.id;
    end if;

    if v_enrollment.status = 'confirmed' then
      update academy.enrollments
      set status = 'active'
      where id = v_enrollment.id;
    end if;

    select count(*)::integer
    into v_active_enrollments
    from academy.enrollments enrollment
    where enrollment.course_run_id = v_run.id
      and enrollment.status in ('confirmed', 'active', 'completed');

    select count(*)::integer
    into v_session_attendance
    from academy.attendance_records attendance
    where attendance.session_id = v_session.id;

    if v_active_enrollments > 0
       and v_session_attendance >= v_active_enrollments then
      update academy.course_run_sessions
      set status = 'completed'
      where id = v_session.id
        and status = 'scheduled';
    end if;

  elsif p_action = 'save_assessment' then
    if p_score is null or p_score < 0 then
      raise exception 'invalid_assessment_score';
    end if;
    if p_max_score is null
       or p_max_score <= 0
       or p_score > p_max_score then
      raise exception 'invalid_assessment_max_score';
    end if;

    insert into academy.assessment_results (
      tenant_id,
      course_run_id,
      enrollment_id,
      assessment_key,
      title,
      score,
      max_score,
      notes,
      assessed_at,
      assessed_by_subject_id
    )
    values (
      v_tenant.id,
      v_run.id,
      v_enrollment.id,
      'final',
      'التقييم النهائي',
      p_score,
      p_max_score,
      nullif(trim(coalesce(p_notes, '')), ''),
      now(),
      v_actor_subject_id
    )
    on conflict (enrollment_id, assessment_key) do update
    set score = excluded.score,
        max_score = excluded.max_score,
        notes = excluded.notes,
        assessed_at = now(),
        assessed_by_subject_id = excluded.assessed_by_subject_id;

  elsif p_action = 'mark_joining_sent' then
    if p_channel not in ('manual', 'whatsapp', 'email', 'sms') then
      raise exception 'invalid_communication_channel';
    end if;

    v_message := private_app.build_joining_message(v_enrollment.id);

    insert into academy.student_communications (
      tenant_id,
      course_run_id,
      enrollment_id,
      message_type,
      channel,
      status,
      message_text,
      sent_at,
      sent_by_subject_id,
      metadata
    )
    values (
      v_tenant.id,
      v_run.id,
      v_enrollment.id,
      'joining_instructions',
      p_channel,
      'sent',
      v_message,
      now(),
      v_actor_subject_id,
      jsonb_build_object('deliveryMode', 'manual_confirmation')
    )
    on conflict (enrollment_id, message_type) do update
    set channel = excluded.channel,
        status = 'sent',
        message_text = excluded.message_text,
        sent_at = now(),
        sent_by_subject_id = excluded.sent_by_subject_id,
        metadata = excluded.metadata;

  elsif p_action = 'issue_certificate' then
    v_eligibility := private_app.training_eligibility(v_enrollment.id);

    if not coalesce((v_eligibility ->> 'eligible')::boolean, false) then
      raise exception 'certificate_not_eligible';
    end if;

    insert into academy.certificates (
      tenant_id,
      course_run_id,
      enrollment_id,
      certificate_number,
      verification_code,
      status,
      issued_at,
      issued_by_subject_id
    )
    values (
      v_tenant.id,
      v_run.id,
      v_enrollment.id,
      upper(
        left(regexp_replace(v_tenant.slug, '[^a-zA-Z0-9]', '', 'g'), 5)
      )
        || '-'
        || to_char(now(), 'YYYY')
        || '-'
        || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      gen_random_uuid()::text,
      'issued',
      now(),
      v_actor_subject_id
    )
    on conflict (enrollment_id) do update
    set status = 'issued',
        issued_at = now(),
        issued_by_subject_id = excluded.issued_by_subject_id,
        revoked_at = null,
        revoked_by_subject_id = null,
        revocation_reason = null
    returning *
    into v_certificate;

    update academy.enrollments
    set status = 'completed'
    where id = v_enrollment.id;

  elsif p_action = 'revoke_certificate' then
    if p_notes is null or length(trim(p_notes)) < 3 then
      raise exception 'revocation_reason_required';
    end if;

    update academy.certificates
    set status = 'revoked',
        revoked_at = now(),
        revoked_by_subject_id = v_actor_subject_id,
        revocation_reason = trim(p_notes)
    where enrollment_id = v_enrollment.id
      and status = 'issued'
    returning *
    into v_certificate;

    if v_certificate.id is null then
      raise exception 'certificate_not_found';
    end if;

  else
    raise exception 'invalid_training_action';
  end if;

  v_eligibility := private_app.training_eligibility(v_enrollment.id);

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant.id,
    v_actor_subject_id,
    'training.' || p_action,
    'enrollment',
    v_enrollment.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'studentId',
      v_student.id,
      'courseRunId',
      v_run.id,
      'sessionId',
      p_session_id,
      'attendanceStatus',
      p_attendance_status,
      'score',
      p_score,
      'channel',
      p_channel
    ))
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'action',
    p_action,
    'enrollmentId',
    v_enrollment.id,
    'courseRunId',
    v_run.id,
    'message',
    v_message,
    'eligibility',
    v_eligibility,
    'certificateId',
    v_certificate.id,
    'certificateNumber',
    v_certificate.certificate_number
  ));
end;
$function$;

CREATE OR REPLACE FUNCTION public.v1_tenant_accounting_action(p_slug text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_required_permission text;
  v_command_id uuid;
  v_request_hash text:=md5(coalesce(p_payload,'{}'::jsonb)::text);
  v_existing accounting_core.commands%rowtype;
  v_result jsonb;
  v_account accounting_core.customer_accounts%rowtype;
  v_document accounting_core.sales_documents%rowtype;
  v_parent accounting_core.sales_documents%rowtype;
  v_payment accounting_core.payments%rowtype;
  v_refund accounting_core.refunds%rowtype;
  v_receipt accounting_core.receipts%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_profile accounting_core.tenant_profiles%rowtype;
  v_id uuid;
  v_document_type text;
  v_target_status text;
  v_line jsonb;
  v_lines jsonb;
  v_position integer:=0;
  v_quantity numeric(12,3);
  v_unit bigint;
  v_subtotal bigint;
  v_discount bigint;
  v_tax_rate integer;
  v_tax bigint;
  v_total bigint;
  v_sum_subtotal bigint:=0;
  v_sum_discount bigint:=0;
  v_sum_tax bigint:=0;
  v_sum_total bigint:=0;
  v_amount bigint;
  v_allocated bigint;
  v_refunded bigint;
  v_prefix text;
  v_status text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(coalesce(p_payload,'{}'::jsonb))<>'object' then
    raise exception 'accounting_payload_invalid';
  end if;
  select * into v_tenant from core.tenants
  where slug=p_slug and status in ('trial','active') limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  v_required_permission:=case p_action
    when 'create_customer_account' then 'tenant.accounting.customers.write'
    when 'update_customer_account' then 'tenant.accounting.customers.write'
    when 'create_document' then case when p_payload->>'documentType'='quote'
      then 'tenant.accounting.quotes.write' else 'tenant.accounting.invoices.write' end
    when 'update_document' then case when p_payload->>'documentType'='quote'
      then 'tenant.accounting.quotes.write' else 'tenant.accounting.invoices.write' end
    when 'issue_document' then 'tenant.accounting.read'
    when 'cancel_document' then 'tenant.accounting.read'
    when 'record_payment' then 'tenant.accounting.payments.record'
    when 'verify_payment' then 'tenant.accounting.payments.approve'
    when 'allocate_payment' then 'tenant.accounting.payments.approve'
    when 'issue_receipt' then 'tenant.accounting.payments.approve'
    when 'create_schedule' then 'tenant.accounting.invoices.write'
    when 'record_collection_action' then 'tenant.accounting.read'
    when 'request_refund' then 'tenant.accounting.refunds.request'
    when 'approve_refund' then 'tenant.accounting.refunds.approve'
    when 'reject_refund' then 'tenant.accounting.refunds.approve'
    when 'complete_refund' then 'tenant.accounting.refunds.approve'
    when 'save_settings' then 'tenant.accounting.settings.manage'
    when 'import_handoff_payment' then 'tenant.accounting.payments.approve'
    else null end;
  if v_required_permission is null then raise exception 'accounting_action_invalid'; end if;
  if not private_app.has_accounting_permission(v_tenant.id,v_required_permission) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_action in ('issue_document','cancel_document') then
    select document_type into v_document_type
    from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'documentId')::uuid;
    if v_document_type is null then raise exception 'document_not_found'; end if;
    if v_document_type='quote' and not private_app.has_accounting_permission(
      v_tenant.id,'tenant.accounting.quotes.write'
    ) then raise exception 'forbidden' using errcode='42501'; end if;
    if v_document_type<>'quote' and not private_app.has_accounting_permission(
      v_tenant.id,case when p_action='issue_document'
        then 'tenant.accounting.invoices.issue' else 'tenant.accounting.invoices.write' end
    ) then raise exception 'forbidden' using errcode='42501'; end if;
  end if;
  v_actor:=private_app.current_subject_id();
  begin v_command_id:=nullif(p_payload->>'commandId','')::uuid;
  exception when invalid_text_representation then raise exception 'command_id_invalid'; end;
  if v_command_id is not null then
    select * into v_existing from accounting_core.commands
    where tenant_id=v_tenant.id and command_id=v_command_id;
    if v_existing.command_id is not null then
      if v_existing.action<>p_action or v_existing.request_hash<>v_request_hash then
        raise exception 'command_id_reused_with_different_payload';
      end if;
      return v_existing.response;
    end if;
  end if;

  select * into v_profile from accounting_core.tenant_profiles
  where tenant_id=v_tenant.id;

  if p_action='save_settings' then
    insert into accounting_core.tenant_profiles(
      tenant_id,legal_name_ar,commercial_registration_number,vat_number,
      tax_registered,base_currency,timezone,default_payment_terms_days,
      default_tax_rate_bps,quote_prefix,invoice_prefix,credit_note_prefix,
      debit_note_prefix,receipt_prefix,auto_import_verified_admissions,
      created_by_subject_id,updated_by_subject_id
    ) values(
      v_tenant.id,nullif(btrim(p_payload->>'legalNameAr'),''),
      nullif(btrim(p_payload->>'commercialRegistrationNumber'),''),
      nullif(btrim(p_payload->>'vatNumber'),''),
      coalesce((p_payload->>'taxRegistered')::boolean,false),
      coalesce(nullif(upper(btrim(p_payload->>'baseCurrency')),''),'SAR'),
      coalesce(nullif(btrim(p_payload->>'timezone'),''),'Asia/Riyadh'),
      coalesce((p_payload->>'defaultPaymentTermsDays')::integer,0),
      coalesce((p_payload->>'defaultTaxRateBps')::integer,1500),
      coalesce(nullif(upper(btrim(p_payload->>'quotePrefix')),''),'Q'),
      coalesce(nullif(upper(btrim(p_payload->>'invoicePrefix')),''),'INV'),
      coalesce(nullif(upper(btrim(p_payload->>'creditNotePrefix')),''),'CN'),
      coalesce(nullif(upper(btrim(p_payload->>'debitNotePrefix')),''),'DN'),
      coalesce(nullif(upper(btrim(p_payload->>'receiptPrefix')),''),'REC'),
      coalesce((p_payload->>'autoImportVerifiedAdmissions')::boolean,false),
      v_actor,v_actor
    ) on conflict(tenant_id) do update set
      legal_name_ar=excluded.legal_name_ar,
      commercial_registration_number=excluded.commercial_registration_number,
      vat_number=excluded.vat_number,tax_registered=excluded.tax_registered,
      base_currency=excluded.base_currency,timezone=excluded.timezone,
      default_payment_terms_days=excluded.default_payment_terms_days,
      default_tax_rate_bps=excluded.default_tax_rate_bps,
      quote_prefix=excluded.quote_prefix,invoice_prefix=excluded.invoice_prefix,
      credit_note_prefix=excluded.credit_note_prefix,
      debit_note_prefix=excluded.debit_note_prefix,receipt_prefix=excluded.receipt_prefix,
      auto_import_verified_admissions=excluded.auto_import_verified_admissions,
      updated_by_subject_id=excluded.updated_by_subject_id,updated_at=now();
    v_result:=jsonb_build_object('success',true,'action',p_action);

  elsif p_action in ('create_customer_account','update_customer_account') then
    if p_action='create_customer_account' then
      if nullif(p_payload->>'contactId','') is not null then
        select * into v_contact from sales_core.contacts
        where tenant_id=v_tenant.id and id=(p_payload->>'contactId')::uuid;
        if v_contact.id is null then raise exception 'contact_not_found'; end if;
      end if;
      insert into accounting_core.customer_accounts(
        tenant_id,contact_id,account_number,display_name,organization_name,
        billing_email,billing_phone,tax_number,billing_address,
        payment_terms_days,credit_limit_minor,status,notes,
        created_by_subject_id,updated_by_subject_id
      ) values(
        v_tenant.id,v_contact.id,
        private_app.accounting_next_number(v_tenant.id,'customer',current_date,'CUS'),
        coalesce(nullif(btrim(p_payload->>'displayName'),''),v_contact.full_name),
        coalesce(nullif(btrim(p_payload->>'organizationName'),''),v_contact.organization_name),
        coalesce(nullif(btrim(p_payload->>'billingEmail'),''),v_contact.email),
        coalesce(nullif(btrim(p_payload->>'billingPhone'),''),v_contact.phone),
        nullif(btrim(p_payload->>'taxNumber'),''),nullif(btrim(p_payload->>'billingAddress'),''),
        coalesce((p_payload->>'paymentTermsDays')::integer,v_profile.default_payment_terms_days,0),
        (p_payload->>'creditLimitMinor')::bigint,'active',nullif(btrim(p_payload->>'notes'),''),
        v_actor,v_actor
      ) returning * into v_account;
    else
      update accounting_core.customer_accounts set
        display_name=coalesce(nullif(btrim(p_payload->>'displayName'),''),display_name),
        organization_name=case when p_payload?'organizationName' then nullif(btrim(p_payload->>'organizationName'),'') else organization_name end,
        billing_email=case when p_payload?'billingEmail' then nullif(btrim(p_payload->>'billingEmail'),'') else billing_email end,
        billing_phone=case when p_payload?'billingPhone' then nullif(btrim(p_payload->>'billingPhone'),'') else billing_phone end,
        tax_number=case when p_payload?'taxNumber' then nullif(btrim(p_payload->>'taxNumber'),'') else tax_number end,
        billing_address=case when p_payload?'billingAddress' then nullif(btrim(p_payload->>'billingAddress'),'') else billing_address end,
        payment_terms_days=coalesce((p_payload->>'paymentTermsDays')::integer,payment_terms_days),
        credit_limit_minor=case when p_payload?'creditLimitMinor' then (p_payload->>'creditLimitMinor')::bigint else credit_limit_minor end,
        status=coalesce(nullif(p_payload->>'status',''),status),
        notes=case when p_payload?'notes' then nullif(btrim(p_payload->>'notes'),'') else notes end,
        updated_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=(p_payload->>'accountId')::uuid
      returning * into v_account;
      if v_account.id is null then raise exception 'customer_account_not_found'; end if;
    end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,'accountId',v_account.id);

  elsif p_action in ('create_document','update_document') then
    v_document_type:=coalesce(nullif(p_payload->>'documentType',''),'invoice');
    if v_document_type not in ('quote','invoice','credit_note','debit_note') then
      raise exception 'document_type_invalid';
    end if;
    if jsonb_typeof(p_payload->'lines')<>'array' or jsonb_array_length(p_payload->'lines')=0
       or jsonb_array_length(p_payload->'lines')>100 then raise exception 'document_lines_required'; end if;
    select * into v_account from accounting_core.customer_accounts
    where tenant_id=v_tenant.id and id=(p_payload->>'customerAccountId')::uuid and status<>'closed';
    if v_account.id is null then raise exception 'customer_account_not_found'; end if;
    if p_action='update_document' then
      select * into v_document from accounting_core.sales_documents
      where tenant_id=v_tenant.id and id=(p_payload->>'documentId')::uuid and status='draft'
      for update;
      if v_document.id is null then raise exception 'document_not_editable'; end if;
      if v_document.document_type<>v_document_type then raise exception 'document_type_immutable'; end if;
      delete from accounting_core.sales_document_lines
      where tenant_id=v_tenant.id and document_id=v_document.id;
    else
      if nullif(p_payload->>'parentDocumentId','') is not null then
        select * into v_parent from accounting_core.sales_documents
        where tenant_id=v_tenant.id and id=(p_payload->>'parentDocumentId')::uuid;
        if v_parent.id is null then raise exception 'parent_document_not_found'; end if;
        if v_document_type='invoice' and (v_parent.document_type<>'quote' or v_parent.status<>'accepted') then
          raise exception 'quote_not_convertible';
        end if;
      end if;
      v_prefix:=case v_document_type
        when 'quote' then coalesce(v_profile.quote_prefix,'Q')
        when 'invoice' then coalesce(v_profile.invoice_prefix,'INV')
        when 'credit_note' then coalesce(v_profile.credit_note_prefix,'CN')
        else coalesce(v_profile.debit_note_prefix,'DN') end;
      insert into accounting_core.sales_documents(
        tenant_id,document_type,document_number,status,customer_account_id,
        contact_id,parent_document_id,source_type,source_id,issue_date,
        valid_until,due_date,currency,customer_name_snapshot,
        customer_tax_number_snapshot,customer_email_snapshot,
        customer_phone_snapshot,customer_address_snapshot,notes,terms,
        metadata,created_by_subject_id,updated_by_subject_id
      ) values(
        v_tenant.id,v_document_type,
        private_app.accounting_next_number(v_tenant.id,v_document_type,
          coalesce((p_payload->>'issueDate')::date,current_date),v_prefix),
        'draft',v_account.id,v_account.contact_id,v_parent.id,
        nullif(p_payload->>'sourceType',''),nullif(p_payload->>'sourceId',''),
        coalesce((p_payload->>'issueDate')::date,current_date),
        (p_payload->>'validUntil')::date,
        coalesce((p_payload->>'dueDate')::date,
          case when v_document_type in ('invoice','debit_note') then current_date+v_account.payment_terms_days else null end),
        coalesce(nullif(upper(p_payload->>'currency'),''),v_profile.base_currency,'SAR'),
        v_account.display_name,v_account.tax_number,v_account.billing_email,
        v_account.billing_phone,v_account.billing_address,
        nullif(btrim(p_payload->>'notes'),''),nullif(btrim(p_payload->>'terms'),''),
        coalesce(p_payload->'metadata','{}'::jsonb),v_actor,v_actor
      ) returning * into v_document;
    end if;
    v_lines:=p_payload->'lines';
    v_position:=0;v_sum_subtotal:=0;v_sum_discount:=0;v_sum_tax:=0;v_sum_total:=0;
    for v_line in select value from jsonb_array_elements(v_lines) loop
      v_position:=v_position+1;
      v_quantity:=coalesce((v_line->>'quantity')::numeric,1);
      v_unit:=coalesce((v_line->>'unitAmountMinor')::bigint,0);
      v_subtotal:=round(v_quantity*v_unit)::bigint;
      v_discount:=coalesce((v_line->>'discountMinor')::bigint,0);
      v_tax_rate:=case when coalesce(v_line->>'taxCategory','standard')='standard'
        then coalesce((v_line->>'taxRateBps')::integer,v_profile.default_tax_rate_bps,1500) else 0 end;
      if v_quantity<=0 or v_unit<0 or v_discount<0 or v_discount>v_subtotal then
        raise exception 'document_line_invalid';
      end if;
      v_tax:=case when coalesce(v_line->>'taxCategory','standard')='standard'
        then round((v_subtotal-v_discount)::numeric*v_tax_rate/10000)::bigint else 0 end;
      v_total:=v_subtotal-v_discount+v_tax;
      insert into accounting_core.sales_document_lines(
        tenant_id,document_id,position,item_type,source_id,description,
        quantity,unit_amount_minor,subtotal_minor,discount_minor,
        tax_category,tax_rate_bps,tax_minor,total_minor,metadata
      ) values(
        v_tenant.id,v_document.id,v_position,
        coalesce(nullif(v_line->>'itemType',''),'service'),
        nullif(v_line->>'sourceId',''),
        btrim(v_line->>'description'),v_quantity,v_unit,v_subtotal,v_discount,
        coalesce(nullif(v_line->>'taxCategory',''),'standard'),v_tax_rate,v_tax,v_total,
        coalesce(v_line->'metadata','{}'::jsonb)
      );
      v_sum_subtotal:=v_sum_subtotal+v_subtotal;
      v_sum_discount:=v_sum_discount+v_discount;
      v_sum_tax:=v_sum_tax+v_tax;
      v_sum_total:=v_sum_total+v_total;
    end loop;
    update accounting_core.sales_documents set
      customer_account_id=v_account.id,contact_id=v_account.contact_id,
      issue_date=coalesce((p_payload->>'issueDate')::date,issue_date),
      valid_until=(p_payload->>'validUntil')::date,
      due_date=coalesce((p_payload->>'dueDate')::date,due_date),
      customer_name_snapshot=v_account.display_name,
      customer_tax_number_snapshot=v_account.tax_number,
      customer_email_snapshot=v_account.billing_email,
      customer_phone_snapshot=v_account.billing_phone,
      customer_address_snapshot=v_account.billing_address,
      subtotal_minor=v_sum_subtotal,discount_minor=v_sum_discount,
      tax_minor=v_sum_tax,total_minor=v_sum_total,
      notes=nullif(btrim(p_payload->>'notes'),''),
      terms=nullif(btrim(p_payload->>'terms'),''),
      updated_by_subject_id=v_actor,updated_at=now()
    where tenant_id=v_tenant.id and id=v_document.id returning * into v_document;
    if v_parent.id is not null and v_document_type='invoice' then
      update accounting_core.sales_documents set status='converted',updated_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=v_parent.id;
    end if;
    insert into accounting_core.document_events(
      tenant_id,document_id,event_type,to_status,actor_subject_id,details
    ) values(v_tenant.id,v_document.id,p_action,'draft',v_actor,jsonb_build_object('totalMinor',v_document.total_minor));
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'documentId',v_document.id,'documentNumber',v_document.document_number,
      'totalMinor',v_document.total_minor);

  elsif p_action in ('issue_document','cancel_document') then
    select * into v_document from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'documentId')::uuid
    for update;
    if v_document.id is null then raise exception 'document_not_found'; end if;
    v_status:=v_document.status;
    if p_action='cancel_document' then
      if v_document.status not in ('draft','sent') then raise exception 'issued_document_requires_adjustment'; end if;
      v_target_status:='cancelled';
    elsif v_document.document_type='quote' then
      v_target_status:=coalesce(nullif(p_payload->>'status',''),'sent');
      if not ((v_document.status='draft' and v_target_status in ('sent','cancelled'))
        or (v_document.status='sent' and v_target_status in ('accepted','rejected','expired','cancelled'))) then
        raise exception 'invalid_document_transition';
      end if;
    else
      if v_document.status<>'draft' then raise exception 'invalid_document_transition'; end if;
      v_target_status:='issued';
    end if;
    update accounting_core.sales_documents set
      status=v_target_status,issued_at=case when v_target_status='issued' then now() else issued_at end,
      issued_by_subject_id=case when v_target_status='issued' then v_actor else issued_by_subject_id end,
      updated_by_subject_id=v_actor,updated_at=now()
    where tenant_id=v_tenant.id and id=v_document.id returning * into v_document;
    insert into accounting_core.document_events(
      tenant_id,document_id,event_type,from_status,to_status,actor_subject_id
    ) values(v_tenant.id,v_document.id,p_action,v_status,v_target_status,v_actor);
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'documentId',v_document.id,'status',v_target_status);

  elsif p_action in ('record_payment','import_handoff_payment') then
    if p_action='import_handoff_payment' then
      select handoff.contact_id,handoff.payment_amount_minor,handoff.payment_reference
        into v_id,v_amount,v_prefix
      from academy.registration_handoffs handoff
      where handoff.tenant_id=v_tenant.id
        and handoff.id=(p_payload->>'handoffId')::uuid
        and handoff.payment_status='verified'
        and handoff.payment_verified_at is not null
        and handoff.payment_amount_minor>0;
      if v_id is null then raise exception 'verified_handoff_not_found'; end if;
      select * into v_account from accounting_core.customer_accounts
      where tenant_id=v_tenant.id and contact_id=v_id;
      if v_account.id is null then
        select * into v_contact from sales_core.contacts where tenant_id=v_tenant.id and id=v_id;
        insert into accounting_core.customer_accounts(
          tenant_id,contact_id,account_number,display_name,organization_name,
          billing_email,billing_phone,payment_terms_days,created_by_subject_id,updated_by_subject_id
        ) values(
          v_tenant.id,v_contact.id,
          private_app.accounting_next_number(v_tenant.id,'customer',current_date,'CUS'),
          v_contact.full_name,v_contact.organization_name,v_contact.email,v_contact.phone,
          coalesce(v_profile.default_payment_terms_days,0),v_actor,v_actor
        ) returning * into v_account;
      end if;
      if exists(select 1 from accounting_core.payments where tenant_id=v_tenant.id
        and source_type='registration_handoff' and source_id=p_payload->>'handoffId') then
        raise exception 'payment_source_already_imported';
      end if;
      insert into accounting_core.payments(
        tenant_id,customer_account_id,payment_number,amount_minor,currency,method,
        status,external_reference,source_type,source_id,received_at,verified_at,
        verified_by_subject_id,created_by_subject_id
      ) values(
        v_tenant.id,v_account.id,
        private_app.accounting_next_number(v_tenant.id,'payment',current_date,'PAY'),
        v_amount,coalesce(v_profile.base_currency,'SAR'),'bank_transfer','verified',v_prefix,
        'registration_handoff',p_payload->>'handoffId',now(),now(),v_actor,v_actor
      ) returning * into v_payment;
    else
      select * into v_account from accounting_core.customer_accounts
      where tenant_id=v_tenant.id and id=(p_payload->>'customerAccountId')::uuid;
      if v_account.id is null then raise exception 'customer_account_not_found'; end if;
      v_amount:=(p_payload->>'amountMinor')::bigint;
      if v_amount<=0 then raise exception 'payment_amount_invalid'; end if;
      v_status:=case when coalesce((p_payload->>'verifyNow')::boolean,false)
        and private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.payments.approve')
        then 'verified' else 'pending_verification' end;
      insert into accounting_core.payments(
        tenant_id,customer_account_id,payment_number,amount_minor,currency,method,
        status,external_reference,source_type,source_id,received_at,verified_at,
        verified_by_subject_id,notes,metadata,created_by_subject_id
      ) values(
        v_tenant.id,v_account.id,
        private_app.accounting_next_number(v_tenant.id,'payment',
          coalesce((p_payload->>'receivedAt')::timestamptz::date,current_date),'PAY'),
        v_amount,coalesce(nullif(upper(p_payload->>'currency'),''),v_profile.base_currency,'SAR'),
        coalesce(nullif(p_payload->>'method',''),'bank_transfer'),v_status,
        nullif(btrim(p_payload->>'externalReference'),''),
        nullif(p_payload->>'sourceType',''),nullif(p_payload->>'sourceId',''),
        coalesce((p_payload->>'receivedAt')::timestamptz,now()),
        case when v_status='verified' then now() end,
        case when v_status='verified' then v_actor end,
        nullif(btrim(p_payload->>'notes'),''),coalesce(p_payload->'metadata','{}'::jsonb),v_actor
      ) returning * into v_payment;
    end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'paymentId',v_payment.id,'paymentNumber',v_payment.payment_number,'status',v_payment.status);

  elsif p_action='verify_payment' then
    update accounting_core.payments set status='verified',verified_at=now(),
      verified_by_subject_id=v_actor,rejection_reason=null,updated_at=now()
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid
      and status='pending_verification' returning * into v_payment;
    if v_payment.id is null then raise exception 'payment_not_verifiable'; end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,'paymentId',v_payment.id,'status','verified');

  elsif p_action='allocate_payment' then
    select * into v_payment from accounting_core.payments
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid and status='verified'
    for update;
    select * into v_document from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'invoiceId')::uuid
      and status='issued' and document_type in ('invoice','debit_note')
    for update;
    if v_payment.id is null or v_document.id is null then raise exception 'allocation_target_invalid'; end if;
    if v_payment.customer_account_id<>v_document.customer_account_id then raise exception 'allocation_customer_mismatch'; end if;
    v_amount:=(p_payload->>'amountMinor')::bigint;
    select coalesce(sum(amount_minor),0)::bigint into v_allocated
    from accounting_core.payment_allocations where tenant_id=v_tenant.id and payment_id=v_payment.id;
    if v_amount<=0 or v_allocated+v_amount>v_payment.amount_minor then raise exception 'payment_allocation_exceeds_available'; end if;
    select coalesce(sum(amount_minor),0)::bigint into v_allocated
    from accounting_core.payment_allocations where tenant_id=v_tenant.id and invoice_id=v_document.id;
    if v_allocated+v_amount>v_document.total_minor then raise exception 'payment_allocation_exceeds_invoice'; end if;
    insert into accounting_core.payment_allocations(
      tenant_id,payment_id,invoice_id,amount_minor,created_by_subject_id
    ) values(v_tenant.id,v_payment.id,v_document.id,v_amount,v_actor)
    on conflict(tenant_id,payment_id,invoice_id) do update
    set amount_minor=accounting_core.payment_allocations.amount_minor+excluded.amount_minor;
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'paymentId',v_payment.id,'invoiceId',v_document.id,'allocatedMinor',v_amount);

  elsif p_action='issue_receipt' then
    select * into v_payment from accounting_core.payments
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid and status in ('verified','refunded');
    if v_payment.id is null then raise exception 'payment_not_receiptable'; end if;
    insert into accounting_core.receipts(
      tenant_id,payment_id,receipt_number,issued_by_subject_id
    ) values(
      v_tenant.id,v_payment.id,
      private_app.accounting_next_number(v_tenant.id,'receipt',current_date,coalesce(v_profile.receipt_prefix,'REC')),
      v_actor
    ) on conflict(tenant_id,payment_id) do update set payment_id=excluded.payment_id
    returning * into v_receipt;
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'receiptId',v_receipt.id,'receiptNumber',v_receipt.receipt_number);

  elsif p_action='create_schedule' then
    select * into v_document from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'invoiceId')::uuid
      and status='draft' and document_type in ('invoice','debit_note')
    for update;
    if v_document.id is null then raise exception 'schedule_invoice_not_editable'; end if;
    v_amount:=(p_payload->>'amountMinor')::bigint;
    select coalesce(sum(amount_minor),0)::bigint into v_allocated
    from accounting_core.payment_schedules where tenant_id=v_tenant.id and invoice_id=v_document.id;
    if v_amount<=0 or v_allocated+v_amount>v_document.total_minor then raise exception 'schedule_exceeds_invoice'; end if;
    insert into accounting_core.payment_schedules(
      tenant_id,invoice_id,installment_number,due_date,amount_minor,label,created_by_subject_id
    ) values(
      v_tenant.id,v_document.id,(p_payload->>'installmentNumber')::integer,
      (p_payload->>'dueDate')::date,v_amount,nullif(btrim(p_payload->>'label'),''),v_actor
    ) returning id into v_id;
    v_result:=jsonb_build_object('success',true,'action',p_action,'scheduleId',v_id);

  elsif p_action='record_collection_action' then
    if nullif(p_payload->>'invoiceId','') is not null and not exists(
      select 1 from accounting_core.sales_documents document
      where document.tenant_id=v_tenant.id
        and document.id=(p_payload->>'invoiceId')::uuid
        and document.customer_account_id=(p_payload->>'customerAccountId')::uuid
    ) then raise exception 'collection_invoice_customer_mismatch'; end if;
    insert into accounting_core.collection_actions(
      tenant_id,customer_account_id,invoice_id,action_type,summary,
      promised_date,promised_amount_minor,next_action_at,created_by_subject_id
    ) values(
      v_tenant.id,(p_payload->>'customerAccountId')::uuid,
      nullif(p_payload->>'invoiceId','')::uuid,coalesce(nullif(p_payload->>'type',''),'note'),
      btrim(p_payload->>'summary'),nullif(p_payload->>'promisedDate','')::date,
      (p_payload->>'promisedAmountMinor')::bigint,
      (p_payload->>'nextActionAt')::timestamptz,v_actor
    ) returning id into v_id;
    v_result:=jsonb_build_object('success',true,'action',p_action,'collectionActionId',v_id);

  elsif p_action='request_refund' then
    select * into v_payment from accounting_core.payments
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid and status in ('verified','refunded')
    for update;
    if v_payment.id is null then raise exception 'payment_not_refundable'; end if;
    v_amount:=(p_payload->>'amountMinor')::bigint;
    select coalesce(sum(amount_minor),0)::bigint into v_refunded
    from accounting_core.refunds where tenant_id=v_tenant.id and payment_id=v_payment.id
      and status in ('requested','approved','completed');
    if v_amount<=0 or v_refunded+v_amount>v_payment.amount_minor then raise exception 'refund_exceeds_payment'; end if;
    if nullif(p_payload->>'invoiceId','') is not null and not exists(
      select 1 from accounting_core.sales_documents document
      where document.tenant_id=v_tenant.id
        and document.id=(p_payload->>'invoiceId')::uuid
        and document.customer_account_id=v_payment.customer_account_id
        and document.document_type='invoice'
    ) then raise exception 'refund_invoice_customer_mismatch'; end if;
    if nullif(p_payload->>'creditNoteId','') is not null and not exists(
      select 1 from accounting_core.sales_documents document
      where document.tenant_id=v_tenant.id
        and document.id=(p_payload->>'creditNoteId')::uuid
        and document.customer_account_id=v_payment.customer_account_id
        and document.document_type='credit_note' and document.status='issued'
    ) then raise exception 'refund_credit_note_invalid'; end if;
    insert into accounting_core.refunds(
      tenant_id,customer_account_id,payment_id,invoice_id,credit_note_id,
      amount_minor,reason,status,requested_by_subject_id
    ) values(
      v_tenant.id,v_payment.customer_account_id,v_payment.id,
      nullif(p_payload->>'invoiceId','')::uuid,nullif(p_payload->>'creditNoteId','')::uuid,
      v_amount,btrim(p_payload->>'reason'),'requested',v_actor
    ) returning * into v_refund;
    v_result:=jsonb_build_object('success',true,'action',p_action,'refundId',v_refund.id,'status',v_refund.status);

  elsif p_action in ('approve_refund','reject_refund','complete_refund') then
    select * into v_refund from accounting_core.refunds
    where tenant_id=v_tenant.id and id=(p_payload->>'refundId')::uuid for update;
    if v_refund.id is null then raise exception 'refund_not_found'; end if;
    if p_action='approve_refund' then
      if v_refund.status<>'requested' then raise exception 'refund_transition_invalid'; end if;
      v_target_status:='approved';
      update accounting_core.refunds set status='approved',approved_at=now(),approved_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=v_refund.id;
    elsif p_action='reject_refund' then
      if v_refund.status not in ('requested','approved') then raise exception 'refund_transition_invalid'; end if;
      v_target_status:='rejected';
      update accounting_core.refunds set status='rejected',approved_at=now(),approved_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=v_refund.id;
    else
      if v_refund.status<>'approved' then raise exception 'refund_transition_invalid'; end if;
      v_target_status:='completed';
      update accounting_core.refunds set status='completed',completed_at=now(),completed_by_subject_id=v_actor,
        external_reference=nullif(btrim(p_payload->>'externalReference'),''),updated_at=now()
      where tenant_id=v_tenant.id and id=v_refund.id;
      select coalesce(sum(amount_minor),0)::bigint into v_refunded
      from accounting_core.refunds where tenant_id=v_tenant.id and payment_id=v_refund.payment_id and status='completed';
      if v_refunded>=(select amount_minor from accounting_core.payments where tenant_id=v_tenant.id and id=v_refund.payment_id) then
        update accounting_core.payments set status='refunded',updated_at=now()
        where tenant_id=v_tenant.id and id=v_refund.payment_id;
      end if;
    end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,'refundId',v_refund.id,'status',v_target_status);
  end if;

  perform private_app.write_audit(
    'accounting.'||p_action,'tenant_accounting',
    coalesce(v_result->>'documentId',v_result->>'paymentId',v_result->>'refundId',v_result->>'accountId'),
    v_tenant.id,jsonb_build_object('commandId',v_command_id,'result',v_result)
  );
  if v_command_id is not null then
    insert into accounting_core.commands(
      tenant_id,command_id,action,request_hash,response,actor_subject_id
    ) values(v_tenant.id,v_command_id,p_action,v_request_hash,v_result,v_actor);
  end if;
  return v_result;
end;
$function$;

CREATE TRIGGER assessment_results_set_updated_at BEFORE UPDATE ON academy.assessment_results FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER assessment_results_validate_links BEFORE INSERT OR UPDATE OF tenant_id, course_run_id, enrollment_id ON academy.assessment_results FOR EACH ROW EXECUTE FUNCTION private_app.validate_enrollment_training_record();
CREATE TRIGGER attendance_records_set_updated_at BEFORE UPDATE ON academy.attendance_records FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER attendance_records_validate_links BEFORE INSERT OR UPDATE OF tenant_id, course_run_id, session_id, enrollment_id ON academy.attendance_records FOR EACH ROW EXECUTE FUNCTION private_app.validate_attendance_record();
CREATE TRIGGER certificates_set_updated_at BEFORE UPDATE ON academy.certificates FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER certificates_validate_links BEFORE INSERT OR UPDATE OF tenant_id, course_run_id, enrollment_id ON academy.certificates FOR EACH ROW EXECUTE FUNCTION private_app.validate_enrollment_training_record();
CREATE TRIGGER course_run_rules_set_updated_at BEFORE UPDATE ON academy.course_run_rules FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER course_run_sessions_set_updated_at BEFORE UPDATE ON academy.course_run_sessions FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER course_runs_ensure_training_rules AFTER INSERT ON academy.course_runs FOR EACH ROW EXECUTE FUNCTION private_app.ensure_course_run_rules();
CREATE TRIGGER course_runs_set_updated_at BEFORE UPDATE ON academy.course_runs FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER courses_set_updated_at BEFORE UPDATE ON academy.courses FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER academy_enrollments_set_updated_at BEFORE UPDATE ON academy.enrollments FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER enrollments_validate_course_run BEFORE INSERT OR UPDATE OF tenant_id, course_id, course_run_id, status ON academy.enrollments FOR EACH ROW EXECUTE FUNCTION private_app.validate_enrollment_course_run();
CREATE TRIGGER registration_documents_set_updated_at BEFORE UPDATE ON academy.registration_documents FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER registration_handoffs_set_updated_at BEFORE UPDATE ON academy.registration_handoffs FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER registration_handoffs_validate_course_run BEFORE INSERT OR UPDATE OF tenant_id, course_id, course_run_id ON academy.registration_handoffs FOR EACH ROW EXECUTE FUNCTION private_app.validate_handoff_course_run();
CREATE TRIGGER student_communications_set_updated_at BEFORE UPDATE ON academy.student_communications FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER student_communications_validate_links BEFORE INSERT OR UPDATE OF tenant_id, course_run_id, enrollment_id ON academy.student_communications FOR EACH ROW EXECUTE FUNCTION private_app.validate_enrollment_training_record();
CREATE TRIGGER academy_students_set_updated_at BEFORE UPDATE ON academy.students FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER training_automation_jobs_set_updated_at BEFORE UPDATE ON academy.training_automation_jobs FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER training_automation_settings_set_updated_at BEFORE UPDATE ON academy.training_automation_settings FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER accounting_customer_updated_at BEFORE UPDATE ON accounting_core.customer_accounts FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER accounting_document_events_append_only BEFORE DELETE OR UPDATE ON accounting_core.document_events FOR EACH ROW EXECUTE FUNCTION private_app.accounting_append_only();
CREATE TRIGGER accounting_payment_updated_at BEFORE UPDATE ON accounting_core.payments FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER accounting_refund_updated_at BEFORE UPDATE ON accounting_core.refunds FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER accounting_line_immutable BEFORE INSERT OR DELETE OR UPDATE ON accounting_core.sales_document_lines FOR EACH ROW EXECUTE FUNCTION private_app.accounting_guard_line();
CREATE TRIGGER accounting_document_immutable BEFORE DELETE OR UPDATE ON accounting_core.sales_documents FOR EACH ROW EXECUTE FUNCTION private_app.accounting_guard_document();
CREATE TRIGGER accounting_document_updated_at BEFORE UPDATE ON accounting_core.sales_documents FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER accounting_profile_updated_at BEFORE UPDATE ON accounting_core.tenant_profiles FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();
CREATE TRIGGER work_tasks_set_updated_at BEFORE UPDATE ON work_core.tasks FOR EACH ROW EXECUTE FUNCTION private_app.set_updated_at();

-- External automation triggers intentionally outside this fixture:
-- attendance_records_automation_event
-- certificates_automation_event
-- course_run_sessions_change_automation_event
-- courses_plan_limit_v4
-- enrollments_automation_event
-- registration_documents_force_optional
-- commerce_admission_guard_v1
-- registration_handoff_incentives_v2
-- registration_handoff_notify_sales_owner
-- registration_handoffs_payment_automation_event
-- students_plan_limit_v4
-- training_automation_jobs_apply_template
-- training_jobs_sync_delivery_state
-- capture_task_history_after_update
-- commerce_task_completion_guard_v1
-- guard_terminal_contact_sales_task_before_insert
-- zz_enforce_task_day_timing_before_write
