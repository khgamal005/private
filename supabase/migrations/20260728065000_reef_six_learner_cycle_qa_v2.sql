begin;

do $reef_six_learner_cycle$
declare
  v_tenant_id uuid;
  v_course_id uuid;
  v_run_id uuid;
  v_tenant_timezone text;
  v_contact_id uuid;
  v_handoff_id uuid;
  v_student_id uuid;
  v_enrollment_id uuid;
  v_session_id uuid;
  v_certificate_id uuid;
  v_index integer;
  v_session_number integer;
  v_status text;
  v_score numeric;
  v_eligibility jsonb;
  v_processed jsonb;
  v_enrollments integer;
  v_verified_payments integer;
  v_attendance integer;
  v_assessments integer;
  v_certificates integer;
  v_eligible integer;
  v_ineligible integer;
  v_joining_events integer;
  v_joining_jobs integer;
begin
  select tenant.id, tenant.timezone
  into v_tenant_id, v_tenant_timezone
  from core.tenants tenant
  where tenant.slug = 'reef-skills'
  limit 1;

  select run.id, run.course_id
  into v_run_id, v_course_id
  from academy.course_runs run
  where run.tenant_id = v_tenant_id
    and run.run_code = 'EXCEL-OPS-DEMO-20260720'
  limit 1;

  if v_tenant_id is null
     or v_run_id is null
     or v_course_id is null then
    raise exception 'reef_qa_fixture_missing';
  end if;

  update academy.course_runs
  set status = 'open',
      starts_at = now() + interval '2 days',
      ends_at = now() + interval '5 days',
      registration_opens_at = now() - interval '1 day',
      registration_closes_at = now() + interval '1 day',
      metadata = metadata || jsonb_build_object(
        'qaCycle', 'six-learners-beta16'
      )
  where id = v_run_id;

  for v_index in 5..6 loop
    insert into sales_core.contacts (
      tenant_id,
      contact_key,
      full_name,
      phone,
      whatsapp,
      email,
      source,
      status,
      interest_course_id,
      lead_status,
      lead_quality,
      payment_submitted_at,
      metadata
    )
    values (
      v_tenant_id,
      'reef-training-ops-demo-00' || v_index::text,
      'متدرب تجريبي ' || v_index::text,
      '05000002' || lpad(v_index::text, 2, '0'),
      '05000002' || lpad(v_index::text, 2, '0'),
      'demo.learner' || v_index::text || '@example.invalid',
      'demo',
      'converted',
      v_course_id,
      'paid',
      'good',
      now(),
      jsonb_build_object(
        'demo', true,
        'seed', 'six-learners-beta16',
        'qaOnly', true
      )
    )
    on conflict (tenant_id, contact_key) do update
    set full_name = excluded.full_name,
        phone = excluded.phone,
        whatsapp = excluded.whatsapp,
        email = excluded.email,
        metadata = excluded.metadata
    returning id into v_contact_id;

    insert into academy.registration_handoffs (
      tenant_id,
      handoff_key,
      contact_id,
      course_id,
      course_run_id,
      status,
      paid_at,
      payment_amount_minor,
      payment_reference,
      notes,
      metadata,
      payment_status,
      payment_reported_at
    )
    values (
      v_tenant_id,
      'reef-training-ops-handoff-00' || v_index::text,
      v_contact_id,
      v_course_id,
      v_run_id,
      'in_review',
      now(),
      0,
      'DEMO-PAID-00' || v_index::text,
      'اختبار كامل لدورة المتدرب — بيانات غير حقيقية',
      jsonb_build_object(
        'demo', true,
        'seed', 'six-learners-beta16',
        'qaOnly', true
      ),
      'pending_verification',
      now()
    )
    on conflict (tenant_id, handoff_key) do update
    set course_run_id = excluded.course_run_id,
        status = 'in_review',
        payment_status = 'pending_verification',
        payment_verified_at = null,
        metadata = excluded.metadata
    returning id into v_handoff_id;

    update academy.registration_handoffs
    set payment_status = 'verified',
        payment_verified_at = now(),
        status = 'accepted',
        accepted_at = now()
    where id = v_handoff_id;

    insert into academy.students (
      tenant_id,
      student_key,
      student_number,
      contact_id,
      full_name,
      phone,
      email,
      status,
      metadata
    )
    values (
      v_tenant_id,
      'reef-training-ops-student-00' || v_index::text,
      'DEMO-TRN-00' || v_index::text,
      v_contact_id,
      'متدرب تجريبي ' || v_index::text,
      '05000002' || lpad(v_index::text, 2, '0'),
      'demo.learner' || v_index::text || '@example.invalid',
      'active',
      jsonb_build_object(
        'demo', true,
        'seed', 'six-learners-beta16',
        'qaOnly', true
      )
    )
    on conflict (tenant_id, student_key) do update
    set full_name = excluded.full_name,
        contact_id = excluded.contact_id,
        phone = excluded.phone,
        email = excluded.email,
        metadata = excluded.metadata
    returning id into v_student_id;

    insert into academy.enrollments (
      tenant_id,
      enrollment_key,
      handoff_id,
      student_id,
      course_id,
      course_run_id,
      status,
      enrolled_at,
      metadata
    )
    values (
      v_tenant_id,
      'reef-training-ops-enrollment-00' || v_index::text,
      v_handoff_id,
      v_student_id,
      v_course_id,
      v_run_id,
      'active',
      now(),
      jsonb_build_object(
        'demo', true,
        'seed', 'six-learners-beta16',
        'qaOnly', true
      )
    )
    on conflict (tenant_id, enrollment_key) do update
    set handoff_id = excluded.handoff_id,
        student_id = excluded.student_id,
        course_run_id = excluded.course_run_id,
        status = 'active',
        metadata = excluded.metadata
    returning id into v_enrollment_id;

    for v_session_number in 1..4 loop
      select session.id
      into v_session_id
      from academy.course_run_sessions session
      where session.course_run_id = v_run_id
        and session.session_number = v_session_number;

      v_status := case
        when v_index = 6 and v_session_number = 4 then 'absent'
        when v_index = 6 and v_session_number = 2 then 'late'
        else 'present'
      end;

      insert into academy.attendance_records (
        tenant_id,
        course_run_id,
        session_id,
        enrollment_id,
        status,
        minutes_late,
        notes,
        marked_at,
        metadata
      )
      values (
        v_tenant_id,
        v_run_id,
        v_session_id,
        v_enrollment_id,
        v_status,
        case when v_status = 'late' then 12 else 0 end,
        'سجل QA لدورة ستة متدربين',
        now(),
        jsonb_build_object('qaOnly', true)
      )
      on conflict (enrollment_id, session_id) do update
      set status = excluded.status,
          minutes_late = excluded.minutes_late,
          notes = excluded.notes,
          metadata = excluded.metadata;
    end loop;

    v_score := case when v_index = 5 then 95 else 65 end;
    insert into academy.assessment_results (
      tenant_id,
      course_run_id,
      enrollment_id,
      assessment_key,
      title,
      score,
      max_score,
      notes,
      assessed_at
    )
    values (
      v_tenant_id,
      v_run_id,
      v_enrollment_id,
      'final',
      'التقييم النهائي',
      v_score,
      100,
      'نتيجة QA لدورة ستة متدربين',
      now()
    )
    on conflict (enrollment_id, assessment_key) do update
    set score = excluded.score,
        max_score = excluded.max_score,
        notes = excluded.notes,
        assessed_at = excluded.assessed_at;

    update academy.enrollments
    set status = 'completed'
    where id = v_enrollment_id;

    update academy.registration_handoffs
    set status = 'completed',
        completed_at = now()
    where id = v_handoff_id;
  end loop;

  update academy.course_runs
  set status = 'completed',
      starts_at = '2026-07-20 16:00:00+00',
      ends_at = '2026-07-23 18:00:00+00',
      registration_opens_at = '2026-07-10 00:00:00+00',
      registration_closes_at = '2026-07-19 00:00:00+00',
      enrolled_count = (
        select count(*)::integer
        from academy.enrollments enrollment
        where enrollment.course_run_id = v_run_id
          and enrollment.status in ('confirmed', 'active', 'completed')
      )
  where id = v_run_id;

  select enrollment.id
  into v_enrollment_id
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number = 'DEMO-TRN-005';

  v_eligibility := private_app.training_eligibility(v_enrollment_id);
  if not coalesce((v_eligibility ->> 'eligible')::boolean, false) then
    raise exception 'reef_qa_learner_5_should_be_eligible';
  end if;

  insert into academy.certificates (
    tenant_id,
    course_run_id,
    enrollment_id,
    certificate_number,
    verification_code,
    status,
    issued_at,
    metadata
  )
  values (
    v_tenant_id,
    v_run_id,
    v_enrollment_id,
    'DEMO-CERT-2026-005',
    gen_random_uuid()::text,
    'issued',
    now(),
    jsonb_build_object(
      'demo', true,
      'seed', 'six-learners-beta16',
      'qaOnly', true
    )
  )
  on conflict (enrollment_id) do update
  set status = 'issued',
      metadata = excluded.metadata
  returning id into v_certificate_id;

  select enrollment.id
  into v_enrollment_id
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number = 'DEMO-TRN-006';
  v_eligibility := private_app.training_eligibility(v_enrollment_id);
  if coalesce((v_eligibility ->> 'eligible')::boolean, false)
     or not (
       (v_eligibility -> 'reasons')
       ? 'assessment_below_threshold'
     ) then
    raise exception 'reef_qa_learner_6_negative_path_failed';
  end if;

  for v_enrollment_id in
    select enrollment.id
    from academy.enrollments enrollment
    join academy.students student on student.id = enrollment.student_id
    where enrollment.course_run_id = v_run_id
      and student.student_number between
        'DEMO-TRN-001' and 'DEMO-TRN-006'
    order by student.student_number
  loop
    perform private_app.queue_automation_event(
      v_tenant_id,
      'joining_instructions',
      'qa_full_cycle',
      v_enrollment_id::text,
      'qa-full-cycle-joining:' || v_enrollment_id::text,
      (
        select jsonb_build_object(
          'enrollmentId', enrollment.id,
          'courseRunId', enrollment.course_run_id,
          'recipientPhone', student.phone,
          'recipientEmail', student.email,
          'templateValues', jsonb_build_object(
            'name', student.full_name,
            'course', course.title_ar,
            'batch', run.title,
            'date', to_char(
              run.starts_at at time zone v_tenant_timezone,
              'YYYY-MM-DD'
            ),
            'time', to_char(
              run.starts_at at time zone v_tenant_timezone,
              'HH24:MI'
            ),
            'link', run.venue_or_link,
            'center', 'ريف للمهارات'
          )
        )
        from academy.enrollments enrollment
        join academy.students student
          on student.id = enrollment.student_id
        join academy.course_runs run
          on run.id = enrollment.course_run_id
        join academy.courses course on course.id = enrollment.course_id
        where enrollment.id = v_enrollment_id
      ),
      now()
    );
  end loop;

  v_processed := private_app.process_automation_events(
    100,
    v_tenant_id
  );

  select count(*)::integer
  into v_enrollments
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number between
      'DEMO-TRN-001' and 'DEMO-TRN-006'
    and enrollment.status = 'completed';

  select count(*)::integer
  into v_verified_payments
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  join academy.registration_handoffs handoff
    on handoff.id = enrollment.handoff_id
  where enrollment.course_run_id = v_run_id
    and student.student_number between
      'DEMO-TRN-001' and 'DEMO-TRN-006'
    and handoff.payment_status = 'verified'
    and handoff.status = 'completed';

  select count(*)::integer
  into v_attendance
  from academy.attendance_records attendance
  join academy.enrollments enrollment
    on enrollment.id = attendance.enrollment_id
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number between
      'DEMO-TRN-001' and 'DEMO-TRN-006';

  select count(*)::integer
  into v_assessments
  from academy.assessment_results assessment
  join academy.enrollments enrollment
    on enrollment.id = assessment.enrollment_id
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number between
      'DEMO-TRN-001' and 'DEMO-TRN-006'
    and assessment.assessment_key = 'final';

  select count(*)::integer
  into v_certificates
  from academy.certificates certificate
  join academy.enrollments enrollment
    on enrollment.id = certificate.enrollment_id
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number between
      'DEMO-TRN-001' and 'DEMO-TRN-006'
    and certificate.status = 'issued';

  select
    count(*) filter (
      where coalesce(
        (
          private_app.training_eligibility(enrollment.id)
          ->> 'eligible'
        )::boolean,
        false
      )
    )::integer,
    count(*) filter (
      where not coalesce(
        (
          private_app.training_eligibility(enrollment.id)
          ->> 'eligible'
        )::boolean,
        false
      )
    )::integer
  into v_eligible, v_ineligible
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number between
      'DEMO-TRN-001' and 'DEMO-TRN-006';

  select count(*)::integer
  into v_joining_events
  from automation_engine.events event
  where event.tenant_id = v_tenant_id
    and event.source_type = 'qa_full_cycle'
    and event.event_key = 'joining_instructions';

  select count(*)::integer
  into v_joining_jobs
  from communication_hub.message_outbox job
  join automation_engine.events event on event.id = job.event_id
  where event.tenant_id = v_tenant_id
    and event.source_type = 'qa_full_cycle'
    and event.event_key = 'joining_instructions';

  if v_enrollments <> 6
     or v_verified_payments <> 6
     or v_attendance <> 24
     or v_assessments <> 5
     or v_certificates <> 3
     or v_eligible <> 3
     or v_ineligible <> 3
     or v_joining_events <> 6
     or v_joining_jobs <> 6 then
    raise exception
      'reef_six_learner_cycle_assertion_failed';
  end if;

  insert into audit_log.events (
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant_id,
    'quality.learner_cycle.passed',
    'course_run',
    v_run_id::text,
    jsonb_build_object(
      'testKey', 'reef-six-learners-beta16',
      'learners', v_enrollments,
      'verifiedPayments', v_verified_payments,
      'attendanceRecords', v_attendance,
      'assessments', v_assessments,
      'certificates', v_certificates,
      'eligible', v_eligible,
      'ineligible', v_ineligible,
      'joiningEvents', v_joining_events,
      'joiningJobs', v_joining_jobs,
      'automationProcessed', v_processed,
      'containsRealContacts', false,
      'passed', true
    )
  );
end;
$reef_six_learner_cycle$;

commit;
