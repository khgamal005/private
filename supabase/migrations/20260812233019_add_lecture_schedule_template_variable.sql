begin;

create or replace function private_app.arabic_weekday_name(
  p_day_order integer
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_day_order
    when 1 then 'الأحد'
    when 2 then 'الاثنين'
    when 3 then 'الثلاثاء'
    when 4 then 'الأربعاء'
    when 5 then 'الخميس'
    when 6 then 'الجمعة'
    when 7 then 'السبت'
    else null
  end;
$$;

revoke all on function private_app.arabic_weekday_name(integer)
from public, anon, authenticated;

create or replace function private_app.format_arabic_lecture_time(
  p_time time without time zone
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_time is null then null
    else to_char(p_time, 'FMHH12:MI') || case
      when p_time < time '12:00' then ' ص'
      else ' م'
    end
  end;
$$;

revoke all on function private_app.format_arabic_lecture_time(
  time without time zone
)
from public, anon, authenticated;

create or replace function private_app.course_run_lecture_schedule(
  p_course_run_id uuid,
  p_timezone text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text := coalesce(
    nullif(trim(p_timezone), ''),
    'Asia/Riyadh'
  );
  v_entry_count integer;
  v_time_range_count integer;
  v_day_count integer;
  v_min_day integer;
  v_max_day integer;
  v_day_list text;
  v_days text;
  v_start_time time without time zone;
  v_end_time time without time zone;
  v_schedule text;
begin
  with entries as (
    select distinct
      case extract(
        isodow from session.starts_at at time zone v_timezone
      )::integer
        when 7 then 1
        else extract(
          isodow from session.starts_at at time zone v_timezone
        )::integer + 1
      end as day_order,
      (session.starts_at at time zone v_timezone)::time(0)
        as start_time,
      (session.ends_at at time zone v_timezone)::time(0)
        as end_time
    from academy.course_run_sessions session
    where session.course_run_id = p_course_run_id
      and session.status <> 'cancelled'
  )
  select
    count(*)::integer,
    count(distinct (entry.start_time, entry.end_time))::integer
  into v_entry_count, v_time_range_count
  from entries entry;

  if v_entry_count = 0 then return 'سيحدد لاحقًا'; end if;

  if v_time_range_count = 1 then
    with entries as (
      select distinct
        case extract(
          isodow from session.starts_at at time zone v_timezone
        )::integer
          when 7 then 1
          else extract(
            isodow from session.starts_at at time zone v_timezone
          )::integer + 1
        end as day_order,
        (session.starts_at at time zone v_timezone)::time(0)
          as start_time,
        (session.ends_at at time zone v_timezone)::time(0)
          as end_time
      from academy.course_run_sessions session
      where session.course_run_id = p_course_run_id
        and session.status <> 'cancelled'
    ),
    days as (
      select distinct entry.day_order
      from entries entry
    )
    select
      count(*)::integer,
      min(day.day_order),
      max(day.day_order),
      string_agg(
        private_app.arabic_weekday_name(day.day_order),
        '، ' order by day.day_order
      )
    into v_day_count, v_min_day, v_max_day, v_day_list
    from days day;

    with entries as (
      select distinct
        (session.starts_at at time zone v_timezone)::time(0)
          as start_time,
        (session.ends_at at time zone v_timezone)::time(0)
          as end_time
      from academy.course_run_sessions session
      where session.course_run_id = p_course_run_id
        and session.status <> 'cancelled'
    )
    select min(entry.start_time), min(entry.end_time)
    into v_start_time, v_end_time
    from entries entry;

    v_days := case
      when v_day_count = 1 then
        private_app.arabic_weekday_name(v_min_day)
      when v_max_day - v_min_day + 1 = v_day_count then
        format(
          'من %s إلى %s',
          private_app.arabic_weekday_name(v_min_day),
          private_app.arabic_weekday_name(v_max_day)
        )
      else v_day_list
    end;

    return format(
      '%s، من %s إلى %s',
      v_days,
      private_app.format_arabic_lecture_time(v_start_time),
      private_app.format_arabic_lecture_time(v_end_time)
    );
  end if;

  with entries as (
    select distinct
      case extract(
        isodow from session.starts_at at time zone v_timezone
      )::integer
        when 7 then 1
        else extract(
          isodow from session.starts_at at time zone v_timezone
        )::integer + 1
      end as day_order,
      (session.starts_at at time zone v_timezone)::time(0)
        as start_time,
      (session.ends_at at time zone v_timezone)::time(0)
        as end_time
    from academy.course_run_sessions session
    where session.course_run_id = p_course_run_id
      and session.status <> 'cancelled'
  )
  select string_agg(
    format(
      '%s: من %s إلى %s',
      private_app.arabic_weekday_name(entry.day_order),
      private_app.format_arabic_lecture_time(entry.start_time),
      private_app.format_arabic_lecture_time(entry.end_time)
    ),
    '؛ ' order by entry.day_order, entry.start_time
  )
  into v_schedule
  from entries entry;

  return coalesce(v_schedule, 'سيحدد لاحقًا');
end;
$$;

revoke all on function private_app.course_run_lecture_schedule(uuid, text)
from public, anon, authenticated;

create or replace function private_app.validate_message_template(
  p_subject text,
  p_body text
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_token text;
  v_allowed constant text[] := array[
    'name',
    'course',
    'batch',
    'session',
    'date',
    'time',
    'lecture_schedule',
    'trainer',
    'location',
    'link',
    'certificate_link',
    'amount',
    'center',
    'delivery_mode'
  ];
begin
  if length(trim(coalesce(p_body, ''))) < 10 then
    raise exception 'template_body_required';
  end if;
  if length(p_body) > 5000 then
    raise exception 'template_body_too_long';
  end if;
  if length(coalesce(p_subject, '')) > 500 then
    raise exception 'template_subject_too_long';
  end if;

  foreach v_token in array private_app.message_template_variables(
    p_subject,
    p_body
  )
  loop
    if not (v_token = any(v_allowed)) then
      raise exception 'invalid_template_variable';
    end if;
  end loop;
end;
$$;

revoke all on function private_app.validate_message_template(text, text)
from public, anon, authenticated;

create or replace function private_app.build_joining_message(
  p_enrollment_id uuid
)
returns text
language plpgsql
stable
set search_path = ''
as $$
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
$$;

revoke all on function private_app.build_joining_message(uuid)
from public, anon, authenticated;

create or replace function private_app.training_job_apply_template()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_template_key text;
  v_values jsonb;
  v_center_name text;
  v_lecture_schedule text;
  v_delivery_mode text;
begin
  v_template_key := case new.job_type
    when 'joining_instructions' then 'joining_instructions'
    when 'session_reminder_24h' then 'session_reminder_24h'
    when 'session_reminder_1h' then 'session_reminder_1h'
    else null
  end;
  if v_template_key is null then return new; end if;

  select
    tenant.name,
    private_app.course_run_lecture_schedule(
      new.course_run_id,
      tenant.timezone
    ),
    case run.delivery_mode
      when 'online' then 'عن بُعد'
      when 'onsite' then 'حضوري'
      when 'hybrid' then 'هجين'
      else null
    end
  into v_center_name, v_lecture_schedule, v_delivery_mode
  from core.tenants tenant
  left join academy.course_runs run
    on run.id = new.course_run_id
   and run.tenant_id = new.tenant_id
  where tenant.id = new.tenant_id;

  v_values := jsonb_strip_nulls(jsonb_build_object(
    'name', new.metadata ->> 'studentName',
    'course', new.metadata ->> 'courseName',
    'batch', new.metadata ->> 'runName',
    'session', new.metadata ->> 'sessionTitle',
    'date', new.metadata ->> 'startDate',
    'time', coalesce(
      nullif(new.metadata ->> 'startTime', ''),
      substring(
        new.metadata ->> 'startDate'
        from '([0-2][0-9]:[0-5][0-9])'
      ),
      new.metadata ->> 'startDate'
    ),
    'lecture_schedule', v_lecture_schedule,
    'trainer', new.metadata ->> 'trainerName',
    'location', new.metadata ->> 'venueOrLink',
    'link', new.metadata ->> 'venueOrLink',
    'center', v_center_name,
    'delivery_mode', v_delivery_mode
  ));

  new.subject := private_app.message_template_field(
    new.tenant_id,
    v_template_key,
    new.channel,
    'subject',
    v_values,
    new.subject
  );
  new.message_text := private_app.message_template_field(
    new.tenant_id,
    v_template_key,
    new.channel,
    'body',
    v_values,
    new.message_text
  );
  new.metadata := new.metadata || jsonb_build_object(
    'templateKey', v_template_key,
    'lectureSchedule', v_lecture_schedule
  );
  return new;
end;
$$;

revoke all on function private_app.training_job_apply_template()
from public, anon, authenticated;

update communication_hub.message_templates template
set body_template = replace(
      template.body_template,
      E'\nطريقة التقديم:',
      E'\nموعد المحاضرات: {{lecture_schedule}}\nطريقة التقديم:'
    ),
    default_body_template = replace(
      template.default_body_template,
      E'\nطريقة التقديم:',
      E'\nموعد المحاضرات: {{lecture_schedule}}\nطريقة التقديم:'
    ),
    variables = private_app.message_template_variables(
      template.subject_template,
      replace(
        template.body_template,
        E'\nطريقة التقديم:',
        E'\nموعد المحاضرات: {{lecture_schedule}}\nطريقة التقديم:'
      )
    )
where template.template_key = 'joining_instructions'
  and template.is_system
  and template.body_template = template.default_body_template
  and template.body_template not like '%{{lecture_schedule}}%';

update communication_hub.message_templates template
set default_body_template = replace(
      template.default_body_template,
      E'\nطريقة التقديم:',
      E'\nموعد المحاضرات: {{lecture_schedule}}\nطريقة التقديم:'
    )
where template.template_key = 'joining_instructions'
  and template.is_system
  and template.default_body_template not like '%{{lecture_schedule}}%';

commit;
