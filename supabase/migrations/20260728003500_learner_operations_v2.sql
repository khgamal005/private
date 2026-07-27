begin;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values
  (
    'tenant.training.read',
    'training',
    'عرض تشغيل المتدربين',
    'عرض رسائل الانضمام والحضور والتقييمات والشهادات'
  ),
  (
    'tenant.training.write',
    'training',
    'إدارة تشغيل المتدربين',
    'إدارة الحضور والتقييم وقواعد الأهلية وإصدار الشهادات'
  )
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.roles (
  role_key,
  name_ar,
  name_en,
  scope,
  is_system
)
values (
  'training_manager',
  'مدير التدريب',
  'Training Manager',
  'tenant',
  true
)
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager',
    'training_manager',
    'customer_service'
  )
  and permission.permission_key in (
    'tenant.training.read',
    'tenant.training.write'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'sales_manager',
    'sales_supervisor',
    'data_officer',
    'data_analyst'
  )
  and permission.permission_key = 'tenant.training.read'
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key = 'training_manager'
  and permission.permission_key in (
    'tenant.workspace.read',
    'tenant.people.read',
    'tenant.academy.read',
    'tenant.academy.write',
    'tenant.admissions.read',
    'tenant.work.read',
    'tenant.work.write',
    'tenant.content.read'
  )
on conflict do nothing;

create table academy.course_run_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete cascade,
  min_attendance_percent numeric(5,2) not null default 75
    check (
      min_attendance_percent >= 0
      and min_attendance_percent <= 100
    ),
  min_assessment_percent numeric(5,2) not null default 70
    check (
      min_assessment_percent >= 0
      and min_assessment_percent <= 100
    ),
  require_completed_run boolean not null default true,
  certificate_enabled boolean not null default true,
  joining_message_template text not null default
    E'مرحبًا {student_name}،\nتم تسجيلك في {course_name} ضمن {run_name}.\nبداية البرنامج: {start_date}\nطريقة التقديم: {delivery_mode}\nمكان/رابط الحضور: {venue_or_link}\nنتمنى لك تجربة تدريبية موفقة.',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_run_id)
);

create table academy.attendance_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete cascade,
  session_id uuid not null
    references academy.course_run_sessions(id) on delete cascade,
  enrollment_id uuid not null
    references academy.enrollments(id) on delete cascade,
  status text not null
    check (status in ('present', 'late', 'absent', 'excused')),
  minutes_late integer not null default 0
    check (minutes_late >= 0 and minutes_late <= 1440),
  notes text,
  marked_at timestamptz not null default now(),
  marked_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, session_id),
  check (
    (status = 'late' and minutes_late > 0)
    or
    (status <> 'late' and minutes_late = 0)
  )
);

create table academy.assessment_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete cascade,
  enrollment_id uuid not null
    references academy.enrollments(id) on delete cascade,
  assessment_key text not null default 'final',
  title text not null default 'التقييم النهائي',
  score numeric(10,2) not null check (score >= 0),
  max_score numeric(10,2) not null default 100 check (max_score > 0),
  notes text,
  assessed_at timestamptz not null default now(),
  assessed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, assessment_key),
  check (score <= max_score)
);

create table academy.student_communications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete cascade,
  enrollment_id uuid not null
    references academy.enrollments(id) on delete cascade,
  message_type text not null
    check (message_type in ('joining_instructions')),
  channel text not null
    check (channel in ('manual', 'whatsapp', 'email', 'sms')),
  status text not null
    check (status in ('prepared', 'sent', 'failed')),
  message_text text not null check (length(trim(message_text)) >= 10),
  sent_at timestamptz,
  sent_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, message_type),
  check (
    (status = 'sent' and sent_at is not null)
    or
    (status <> 'sent')
  )
);

create table academy.certificates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete restrict,
  enrollment_id uuid not null
    references academy.enrollments(id) on delete restrict,
  certificate_number text not null,
  verification_code text not null,
  status text not null default 'issued'
    check (status in ('issued', 'revoked')),
  issued_at timestamptz not null default now(),
  issued_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  revoked_at timestamptz,
  revoked_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  revocation_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id),
  unique (tenant_id, certificate_number),
  unique (verification_code),
  check (
    (status = 'issued' and revoked_at is null)
    or
    (
      status = 'revoked'
      and revoked_at is not null
      and revocation_reason is not null
      and length(trim(revocation_reason)) >= 3
    )
  )
);

create index course_run_rules_tenant_idx
on academy.course_run_rules (tenant_id, course_run_id);

create index attendance_records_run_session_idx
on academy.attendance_records (course_run_id, session_id, status);

create index attendance_records_tenant_time_idx
on academy.attendance_records (tenant_id, marked_at desc);

create index assessment_results_run_idx
on academy.assessment_results (course_run_id, assessment_key);

create index student_communications_run_status_idx
on academy.student_communications (
  course_run_id,
  message_type,
  status
);

create index certificates_tenant_status_time_idx
on academy.certificates (tenant_id, status, issued_at desc);

create trigger course_run_rules_set_updated_at
before update on academy.course_run_rules
for each row execute function private_app.set_updated_at();

create trigger attendance_records_set_updated_at
before update on academy.attendance_records
for each row execute function private_app.set_updated_at();

create trigger assessment_results_set_updated_at
before update on academy.assessment_results
for each row execute function private_app.set_updated_at();

create trigger student_communications_set_updated_at
before update on academy.student_communications
for each row execute function private_app.set_updated_at();

create trigger certificates_set_updated_at
before update on academy.certificates
for each row execute function private_app.set_updated_at();

alter table academy.course_run_rules enable row level security;
alter table academy.attendance_records enable row level security;
alter table academy.assessment_results enable row level security;
alter table academy.student_communications enable row level security;
alter table academy.certificates enable row level security;

create policy course_run_rules_isolated_read
on academy.course_run_rules
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy attendance_records_isolated_read
on academy.attendance_records
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy assessment_results_isolated_read
on academy.assessment_results
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy student_communications_isolated_read
on academy.student_communications
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy certificates_isolated_read
on academy.certificates
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table academy.course_run_rules
from public, anon, authenticated;
revoke all on table academy.attendance_records
from public, anon, authenticated;
revoke all on table academy.assessment_results
from public, anon, authenticated;
revoke all on table academy.student_communications
from public, anon, authenticated;
revoke all on table academy.certificates
from public, anon, authenticated;

create or replace function private_app.ensure_course_run_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

revoke all on function private_app.ensure_course_run_rules()
from public, anon, authenticated;

create trigger course_runs_ensure_training_rules
after insert on academy.course_runs
for each row execute function private_app.ensure_course_run_rules();

insert into academy.course_run_rules (
  tenant_id,
  course_run_id
)
select run.tenant_id, run.id
from academy.course_runs run
on conflict (course_run_id) do nothing;

create or replace function private_app.validate_attendance_record()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

revoke all on function private_app.validate_attendance_record()
from public, anon, authenticated;

create trigger attendance_records_validate_links
before insert or update of
  tenant_id,
  course_run_id,
  session_id,
  enrollment_id
on academy.attendance_records
for each row execute function private_app.validate_attendance_record();

create or replace function private_app.validate_enrollment_training_record()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

revoke all on function private_app.validate_enrollment_training_record()
from public, anon, authenticated;

create trigger assessment_results_validate_links
before insert or update of tenant_id, course_run_id, enrollment_id
on academy.assessment_results
for each row execute function private_app.validate_enrollment_training_record();

create trigger student_communications_validate_links
before insert or update of tenant_id, course_run_id, enrollment_id
on academy.student_communications
for each row execute function private_app.validate_enrollment_training_record();

create trigger certificates_validate_links
before insert or update of tenant_id, course_run_id, enrollment_id
on academy.certificates
for each row execute function private_app.validate_enrollment_training_record();

create or replace function private_app.validate_enrollment_course_run()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

create or replace function private_app.build_joining_message(
  p_enrollment_id uuid
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_template text;
  v_message text;
  v_student_name text;
  v_course_name text;
  v_run_name text;
  v_start_date text;
  v_delivery_mode text;
  v_venue_or_link text;
begin
  select
    coalesce(
      rule.joining_message_template,
      E'مرحبًا {student_name}،\nتم تسجيلك في {course_name} ضمن {run_name}.\nبداية البرنامج: {start_date}\nطريقة التقديم: {delivery_mode}\nمكان/رابط الحضور: {venue_or_link}\nنتمنى لك تجربة تدريبية موفقة.'
    ),
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
    case run.delivery_mode
      when 'online' then 'عن بُعد'
      when 'onsite' then 'حضوري'
      else 'هجين'
    end,
    coalesce(run.venue_or_link, 'سيحدد لاحقًا')
  into
    v_template,
    v_student_name,
    v_course_name,
    v_run_name,
    v_start_date,
    v_delivery_mode,
    v_venue_or_link
  from academy.enrollments enrollment
  join academy.students student
    on student.id = enrollment.student_id
  join academy.course_runs run
    on run.id = enrollment.course_run_id
  join academy.courses course
    on course.id = enrollment.course_id
  join core.tenants tenant
    on tenant.id = enrollment.tenant_id
  left join academy.course_run_rules rule
    on rule.course_run_id = run.id
  where enrollment.id = p_enrollment_id;

  if v_student_name is null then
    raise exception 'enrollment_not_found';
  end if;

  v_message := replace(v_template, '{student_name}', v_student_name);
  v_message := replace(v_message, '{course_name}', v_course_name);
  v_message := replace(v_message, '{run_name}', v_run_name);
  v_message := replace(v_message, '{start_date}', v_start_date);
  v_message := replace(v_message, '{delivery_mode}', v_delivery_mode);
  v_message := replace(v_message, '{venue_or_link}', v_venue_or_link);
  return v_message;
end;
$$;

revoke all on function private_app.build_joining_message(uuid)
from public, anon, authenticated;

create or replace function private_app.training_eligibility(
  p_enrollment_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
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
$$;

revoke all on function private_app.training_eligibility(uuid)
from public, anon, authenticated;

create or replace function public.v2_tenant_training_operations_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    'tenant.training.read'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt',
    now(),
    'timezone',
    v_tenant.timezone,
    'viewer',
    jsonb_build_object(
      'canManage',
      private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.training.write'
      )
    ),
    'summary',
    jsonb_build_object(
      'activeLearners',
      (
        select count(*)
        from academy.enrollments enrollment
        where enrollment.tenant_id = v_tenant.id
          and enrollment.status in ('confirmed', 'active')
      ),
      'todaySessions',
      (
        select count(*)
        from academy.course_run_sessions session
        where session.tenant_id = v_tenant.id
          and session.status <> 'cancelled'
          and (
            session.starts_at at time zone v_tenant.timezone
          )::date = (
            now() at time zone v_tenant.timezone
          )::date
      ),
      'attendanceRecords',
      (
        select count(*)
        from academy.attendance_records attendance
        where attendance.tenant_id = v_tenant.id
      ),
      'readyCertificates',
      (
        select count(*)
        from academy.enrollments enrollment
        where enrollment.tenant_id = v_tenant.id
          and (
            private_app.training_eligibility(enrollment.id)
            ->> 'eligible'
          )::boolean
          and not exists (
            select 1
            from academy.certificates certificate
            where certificate.enrollment_id = enrollment.id
              and certificate.status = 'issued'
          )
      ),
      'issuedCertificates',
      (
        select count(*)
        from academy.certificates certificate
        where certificate.tenant_id = v_tenant.id
          and certificate.status = 'issued'
      )
    ),
    'courseRuns',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        run.id,
        'courseId',
        run.course_id,
        'courseName',
        course.title_ar,
        'runCode',
        run.run_code,
        'title',
        coalesce(run.title, course.title_ar),
        'status',
        run.status,
        'deliveryMode',
        run.delivery_mode,
        'startsAt',
        run.starts_at,
        'endsAt',
        run.ends_at,
        'instructorName',
        run.instructor_name,
        'venueOrLink',
        run.venue_or_link,
        'demo',
        coalesce((run.metadata ->> 'demo')::boolean, false),
        'rules',
        jsonb_build_object(
          'minAttendancePercent',
          coalesce(rule.min_attendance_percent, 75),
          'minAssessmentPercent',
          coalesce(rule.min_assessment_percent, 70),
          'requireCompletedRun',
          coalesce(rule.require_completed_run, true),
          'certificateEnabled',
          coalesce(rule.certificate_enabled, true)
        ),
        'summary',
        jsonb_build_object(
          'learners',
          (
            select count(*)
            from academy.enrollments enrollment
            where enrollment.course_run_id = run.id
              and enrollment.status not in ('withdrawn', 'cancelled')
          ),
          'sessions',
          (
            select count(*)
            from academy.course_run_sessions session
            where session.course_run_id = run.id
              and session.status <> 'cancelled'
          ),
          'completedSessions',
          (
            select count(*)
            from academy.course_run_sessions session
            where session.course_run_id = run.id
              and session.status = 'completed'
          ),
          'joiningSent',
          (
            select count(*)
            from academy.student_communications communication
            where communication.course_run_id = run.id
              and communication.message_type = 'joining_instructions'
              and communication.status = 'sent'
          ),
          'issuedCertificates',
          (
            select count(*)
            from academy.certificates certificate
            where certificate.course_run_id = run.id
              and certificate.status = 'issued'
          )
        ),
        'sessions',
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',
            session_stats.id,
            'sessionNumber',
            session_stats.session_number,
            'title',
            session_stats.title,
            'startsAt',
            session_stats.starts_at,
            'endsAt',
            session_stats.ends_at,
            'status',
            session_stats.status,
            'deliveryMode',
            session_stats.delivery_mode,
            'venueOrLink',
            session_stats.venue_or_link,
            'attendance',
            jsonb_build_object(
              'present',
              session_stats.present_count,
              'late',
              session_stats.late_count,
              'absent',
              session_stats.absent_count,
              'excused',
              session_stats.excused_count
            )
          ) order by session_stats.session_number)
          from (
            select
              session.id,
              session.session_number,
              session.title,
              session.starts_at,
              session.ends_at,
              session.status,
              session.delivery_mode,
              session.venue_or_link,
              count(attendance.id) filter (
                where attendance.status = 'present'
              ) as present_count,
              count(attendance.id) filter (
                where attendance.status = 'late'
              ) as late_count,
              count(attendance.id) filter (
                where attendance.status = 'absent'
              ) as absent_count,
              count(attendance.id) filter (
                where attendance.status = 'excused'
              ) as excused_count
            from academy.course_run_sessions session
            left join academy.attendance_records attendance
              on attendance.session_id = session.id
            where session.course_run_id = run.id
            group by session.id
          ) session_stats
        ), '[]'::jsonb),
        'learners',
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'enrollmentId',
            enrollment.id,
            'studentId',
            student.id,
            'studentNumber',
            student.student_number,
            'fullName',
            student.full_name,
            'phone',
            student.phone,
            'email',
            student.email,
            'status',
            enrollment.status,
            'demo',
            coalesce(
              (enrollment.metadata ->> 'demo')::boolean,
              false
            ),
            'joiningMessage',
            private_app.build_joining_message(enrollment.id),
            'joining',
            (
              select jsonb_build_object(
                'status',
                communication.status,
                'channel',
                communication.channel,
                'sentAt',
                communication.sent_at
              )
              from academy.student_communications communication
              where communication.enrollment_id = enrollment.id
                and communication.message_type = 'joining_instructions'
              limit 1
            ),
            'attendance',
            coalesce((
              select jsonb_object_agg(
                attendance.session_id::text,
                jsonb_build_object(
                  'status',
                  attendance.status,
                  'minutesLate',
                  attendance.minutes_late,
                  'notes',
                  attendance.notes
                )
              )
              from academy.attendance_records attendance
              where attendance.enrollment_id = enrollment.id
            ), '{}'::jsonb),
            'assessment',
            (
              select jsonb_build_object(
                'score',
                assessment.score,
                'maxScore',
                assessment.max_score,
                'percent',
                round(
                  (assessment.score * 100) / assessment.max_score,
                  2
                ),
                'notes',
                assessment.notes,
                'assessedAt',
                assessment.assessed_at
              )
              from academy.assessment_results assessment
              where assessment.enrollment_id = enrollment.id
                and assessment.assessment_key = 'final'
              limit 1
            ),
            'eligibility',
            private_app.training_eligibility(enrollment.id),
            'certificate',
            (
              select jsonb_build_object(
                'id',
                certificate.id,
                'certificateNumber',
                certificate.certificate_number,
                'verificationCode',
                certificate.verification_code,
                'status',
                certificate.status,
                'issuedAt',
                certificate.issued_at
              )
              from academy.certificates certificate
              where certificate.enrollment_id = enrollment.id
              limit 1
            )
          ) order by student.full_name)
          from academy.enrollments enrollment
          join academy.students student
            on student.id = enrollment.student_id
          where enrollment.course_run_id = run.id
            and enrollment.status not in ('withdrawn', 'cancelled')
        ), '[]'::jsonb)
      ) order by
        case run.status
          when 'in_progress' then 0
          when 'open' then 1
          when 'completed' then 2
          when 'planning' then 3
          else 4
        end,
        run.starts_at desc nulls last)
      from academy.course_runs run
      join academy.courses course
        on course.id = run.course_id
      left join academy.course_run_rules rule
        on rule.course_run_id = run.id
      where run.tenant_id = v_tenant.id
        and run.status <> 'cancelled'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_update_training_operation(
  p_tenant_slug text,
  p_action text,
  p_enrollment_id uuid default null,
  p_course_run_id uuid default null,
  p_session_id uuid default null,
  p_attendance_status text default null,
  p_minutes_late integer default 0,
  p_score numeric default null,
  p_max_score numeric default 100,
  p_notes text default null,
  p_channel text default 'manual',
  p_min_attendance_percent numeric default null,
  p_min_assessment_percent numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

create or replace function public.v2_tenant_certificate_snapshot(
  p_slug text,
  p_certificate_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_result jsonb;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.training.read'
  ) then raise exception 'forbidden'; end if;

  select jsonb_build_object(
    'id',
    certificate.id,
    'certificateNumber',
    certificate.certificate_number,
    'verificationCode',
    certificate.verification_code,
    'status',
    certificate.status,
    'issuedAt',
    certificate.issued_at,
    'tenant',
    jsonb_build_object(
      'name',
      v_tenant.name,
      'slug',
      v_tenant.slug
    ),
    'student',
    jsonb_build_object(
      'fullName',
      student.full_name,
      'studentNumber',
      student.student_number
    ),
    'course',
    jsonb_build_object(
      'name',
      course.title_ar,
      'code',
      course.course_code,
      'durationHours',
      course.duration_hours
    ),
    'courseRun',
    jsonb_build_object(
      'title',
      coalesce(run.title, course.title_ar),
      'runCode',
      run.run_code,
      'startsAt',
      run.starts_at,
      'endsAt',
      run.ends_at,
      'instructorName',
      run.instructor_name
    ),
    'eligibility',
    private_app.training_eligibility(enrollment.id)
  )
  into v_result
  from academy.certificates certificate
  join academy.enrollments enrollment
    on enrollment.id = certificate.enrollment_id
  join academy.students student
    on student.id = enrollment.student_id
  join academy.course_runs run
    on run.id = certificate.course_run_id
  join academy.courses course
    on course.id = enrollment.course_id
  where certificate.id = p_certificate_id
    and certificate.tenant_id = v_tenant.id;

  if v_result is null then raise exception 'certificate_not_found'; end if;
  return v_result;
end;
$$;

revoke execute on function
  public.v2_tenant_training_operations_snapshot(text)
from public, anon;
revoke execute on function
  public.v2_tenant_update_training_operation(
    text,
    text,
    uuid,
    uuid,
    uuid,
    text,
    integer,
    numeric,
    numeric,
    text,
    text,
    numeric,
    numeric
  )
from public, anon;
revoke execute on function
  public.v2_tenant_certificate_snapshot(text, uuid)
from public, anon;

grant execute on function
  public.v2_tenant_training_operations_snapshot(text)
to authenticated;
grant execute on function
  public.v2_tenant_update_training_operation(
    text,
    text,
    uuid,
    uuid,
    uuid,
    text,
    integer,
    numeric,
    numeric,
    text,
    text,
    numeric,
    numeric
  )
to authenticated;
grant execute on function
  public.v2_tenant_certificate_snapshot(text, uuid)
to authenticated;

do $seed$
declare
  v_tenant_id uuid;
  v_course_id uuid;
  v_run_id uuid;
  v_contact_id uuid;
  v_handoff_id uuid;
  v_student_id uuid;
  v_enrollment_id uuid;
  v_session_id uuid;
  v_index integer;
  v_session_number integer;
  v_attendance_status text;
  v_score numeric;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = 'reef-skills'
  limit 1;

  select course.id
  into v_course_id
  from academy.courses course
  where course.tenant_id = v_tenant_id
    and course.course_code = 'EXCEL-ADV'
  limit 1;

  if v_tenant_id is null or v_course_id is null then
    return;
  end if;

  insert into academy.course_runs (
    tenant_id,
    course_id,
    run_code,
    title,
    delivery_mode,
    starts_at,
    ends_at,
    capacity,
    instructor_name,
    venue_or_link,
    status,
    metadata
  )
  values (
    v_tenant_id,
    v_course_id,
    'EXCEL-OPS-DEMO-20260720',
    'دفعة تشغيل المتدربين التجريبية',
    'online',
    '2026-07-20 16:00:00+00',
    '2026-07-23 18:00:00+00',
    12,
    'مدرب تجريبي',
    'رابط تدريبي تجريبي',
    'open',
    jsonb_build_object(
      'demo',
      true,
      'seed',
      'learner-operations-v2'
    )
  )
  on conflict (tenant_id, run_code) do update
  set title = excluded.title
  returning id into v_run_id;

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
  select
    v_tenant_id,
    v_run_id,
    source.session_number,
    'المحاضرة التجريبية ' || source.session_number::text,
    source.starts_at,
    source.ends_at,
    'online',
    'مدرب تجريبي',
    'رابط تدريبي تجريبي',
    'completed',
    jsonb_build_object('demo', true)
  from (
    values
      (1, '2026-07-20 16:00:00+00'::timestamptz, '2026-07-20 18:00:00+00'::timestamptz),
      (2, '2026-07-21 16:00:00+00'::timestamptz, '2026-07-21 18:00:00+00'::timestamptz),
      (3, '2026-07-22 16:00:00+00'::timestamptz, '2026-07-22 18:00:00+00'::timestamptz),
      (4, '2026-07-23 16:00:00+00'::timestamptz, '2026-07-23 18:00:00+00'::timestamptz)
  ) source(session_number, starts_at, ends_at)
  on conflict (course_run_id, session_number) do update
  set title = excluded.title,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      status = 'completed';

  for v_index in 1..4 loop
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
      '2026-07-18 12:00:00+00',
      jsonb_build_object(
        'demo',
        true,
        'seed',
        'learner-operations-v2'
      )
    )
    on conflict (tenant_id, contact_key) do update
    set full_name = excluded.full_name
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
      payment_reported_at,
      payment_verified_at,
      accepted_at,
      completed_at
    )
    values (
      v_tenant_id,
      'reef-training-ops-handoff-00' || v_index::text,
      v_contact_id,
      v_course_id,
      v_run_id,
      'completed',
      '2026-07-18 12:00:00+00',
      0,
      'DEMO-PAID-00' || v_index::text,
      'سجل تجريبي لشرح دورة تشغيل المتدرب',
      jsonb_build_object(
        'demo',
        true,
        'seed',
        'learner-operations-v2'
      ),
      'verified',
      '2026-07-18 12:00:00+00',
      '2026-07-18 12:05:00+00',
      '2026-07-18 12:10:00+00',
      '2026-07-18 12:15:00+00'
    )
    on conflict (tenant_id, handoff_key) do update
    set course_run_id = excluded.course_run_id
    returning id into v_handoff_id;

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
        'demo',
        true,
        'seed',
        'learner-operations-v2'
      )
    )
    on conflict (tenant_id, student_key) do update
    set full_name = excluded.full_name
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
      'completed',
      '2026-07-18 12:15:00+00',
      jsonb_build_object(
        'demo',
        true,
        'seed',
        'learner-operations-v2'
      )
    )
    on conflict (tenant_id, enrollment_key) do update
    set status = excluded.status
    returning id into v_enrollment_id;

    for v_session_number in 1..4 loop
      select session.id
      into v_session_id
      from academy.course_run_sessions session
      where session.course_run_id = v_run_id
        and session.session_number = v_session_number;

      v_attendance_status := case
        when v_index = 1 then 'present'
        when v_index = 2 and v_session_number = 4 then 'absent'
        when v_index = 3 and v_session_number > 2 then 'absent'
        when v_index = 4 and v_session_number = 2 then 'late'
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
        v_attendance_status,
        case when v_attendance_status = 'late' then 10 else 0 end,
        'بيان حضور تجريبي',
        '2026-07-23 18:10:00+00',
        '{}'::jsonb
      )
      on conflict (enrollment_id, session_id) do update
      set status = excluded.status,
          minutes_late = excluded.minutes_late,
          notes = excluded.notes;
    end loop;

    v_score := case
      when v_index = 1 then 88
      when v_index = 2 then 72
      when v_index = 3 then 90
      else null
    end;

    if v_score is not null then
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
        'نتيجة تجريبية',
        '2026-07-23 18:15:00+00'
      )
      on conflict (enrollment_id, assessment_key) do update
      set score = excluded.score,
          max_score = excluded.max_score;
    end if;

    if v_index <= 2 then
      insert into academy.student_communications (
        tenant_id,
        course_run_id,
        enrollment_id,
        message_type,
        channel,
        status,
        message_text,
        sent_at,
        metadata
      )
      values (
        v_tenant_id,
        v_run_id,
        v_enrollment_id,
        'joining_instructions',
        'whatsapp',
        'sent',
        private_app.build_joining_message(v_enrollment_id),
        '2026-07-19 10:00:00+00',
        jsonb_build_object('demo', true)
      )
      on conflict (enrollment_id, message_type) do update
      set status = 'sent',
          sent_at = excluded.sent_at;
    end if;
  end loop;

  update academy.course_runs
  set status = 'completed',
      registration_opens_at = '2026-07-10 00:00:00+00',
      registration_closes_at = '2026-07-19 00:00:00+00',
      enrolled_count = (
        select count(*)::integer
        from academy.enrollments enrollment
        where enrollment.course_run_id = v_run_id
          and enrollment.status in ('confirmed', 'active', 'completed')
      )
  where id = v_run_id;

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
  select
    v_tenant_id,
    v_run_id,
    enrollment.id,
    'DEMO-CERT-2026-00'
      || row_number() over (order by student.student_number)::text,
    gen_random_uuid()::text,
    'issued',
    '2026-07-24 10:00:00+00',
    jsonb_build_object(
      'demo',
      true,
      'seed',
      'learner-operations-v2'
    )
  from academy.enrollments enrollment
  join academy.students student
    on student.id = enrollment.student_id
  where enrollment.course_run_id = v_run_id
    and student.student_number in ('DEMO-TRN-001', 'DEMO-TRN-002')
  on conflict (enrollment_id) do nothing;
end;
$seed$;

comment on table academy.course_run_rules is
'Per-batch attendance and assessment thresholds for certificate eligibility.';
comment on table academy.attendance_records is
'One tenant-isolated attendance outcome per learner and course-run session.';
comment on table academy.assessment_results is
'Learner assessment results used by the certificate eligibility rules.';
comment on table academy.student_communications is
'Auditable learner communications; manual confirmation is used until a provider is integrated.';
comment on table academy.certificates is
'Issued or revoked learner certificates with stable verification codes.';
comment on function public.v2_tenant_training_operations_snapshot(text) is
'Role-protected tenant snapshot for joining, attendance, evaluation, and certificates.';
comment on function public.v2_tenant_update_training_operation(
  text,
  text,
  uuid,
  uuid,
  uuid,
  text,
  integer,
  numeric,
  numeric,
  text,
  text,
  numeric,
  numeric
) is
'Mutates one learner-operation action after tenant and permission checks.';

commit;
