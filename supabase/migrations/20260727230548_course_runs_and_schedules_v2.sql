begin;

alter table academy.course_runs
  add column registration_opens_at timestamptz,
  add column registration_closes_at timestamptz;

alter table academy.course_runs
  add constraint course_runs_registration_window_check
  check (
    registration_opens_at is null
    or registration_closes_at is null
    or registration_closes_at > registration_opens_at
  ),
  add constraint course_runs_registration_before_start_check
  check (
    registration_closes_at is null
    or starts_at is null
    or registration_closes_at <= starts_at
  ),
  add constraint course_runs_capacity_not_below_enrolled_check
  check (capacity is null or capacity >= enrolled_count);

create table academy.course_run_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete cascade,
  session_number integer not null check (session_number > 0),
  title text not null check (length(trim(title)) >= 2),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  delivery_mode text not null
    check (delivery_mode in ('online', 'onsite', 'hybrid')),
  instructor_name text,
  venue_or_link text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'completed', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_run_id, session_number),
  check (ends_at > starts_at)
);

create index course_run_sessions_tenant_time_idx
on academy.course_run_sessions (tenant_id, starts_at, status);

create index course_run_sessions_run_time_idx
on academy.course_run_sessions (course_run_id, starts_at);

create trigger course_run_sessions_set_updated_at
before update on academy.course_run_sessions
for each row execute function private_app.set_updated_at();

alter table academy.course_run_sessions enable row level security;

create policy course_run_sessions_isolated_read
on academy.course_run_sessions
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table academy.course_run_sessions
from public, anon, authenticated;

create or replace function private_app.validate_handoff_course_run()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

create trigger registration_handoffs_validate_course_run
before insert or update of tenant_id, course_id, course_run_id
on academy.registration_handoffs
for each row execute function private_app.validate_handoff_course_run();

create or replace function private_app.validate_enrollment_course_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_run academy.course_runs%rowtype;
  v_enrolled_count integer;
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

create trigger enrollments_validate_course_run
before insert or update of tenant_id, course_id, course_run_id, status
on academy.enrollments
for each row execute function private_app.validate_enrollment_course_run();

create or replace function public.v2_tenant_course_runs_snapshot(
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
$$;

create or replace function public.v2_tenant_save_course_run(
  p_tenant_slug text,
  p_course_id uuid,
  p_title text,
  p_delivery_mode text,
  p_starts_local timestamp,
  p_ends_local timestamp,
  p_capacity integer,
  p_sessions jsonb,
  p_course_run_id uuid default null,
  p_run_code text default null,
  p_instructor_name text default null,
  p_venue_or_link text default null,
  p_price_minor bigint default null,
  p_registration_opens_local timestamp default null,
  p_registration_closes_local timestamp default null,
  p_status text default 'planning'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

do $$
declare
  v_tenant_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = 'reef-skills'
  limit 1;

  if v_tenant_id is null then
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
    registration_opens_at,
    registration_closes_at,
    capacity,
    enrolled_count,
    instructor_name,
    venue_or_link,
    status,
    metadata
  )
  select
    v_tenant_id,
    course.id,
    seed.run_code,
    seed.title,
    seed.delivery_mode,
    seed.starts_at,
    seed.ends_at,
    now() - interval '1 day',
    seed.registration_closes_at,
    seed.capacity,
    0,
    null,
    'يحدد قبل الانطلاق',
    seed.status,
    jsonb_build_object(
      'demo',
      true,
      'source',
      'reef-course-runs-v2'
    )
  from (
    values
      (
        'PMP',
        'PMP-DEMO-20260802',
        'دفعة PMP التجريبية — أغسطس 2026',
        'hybrid',
        '2026-08-02 16:00:00+03'::timestamptz,
        '2026-08-06 23:00:00+03'::timestamptz,
        '2026-08-01 23:59:00+03'::timestamptz,
        25,
        'open'
      ),
      (
        'POWER-BI',
        'POWER-BI-DEMO-20260809',
        'دفعة Power BI التجريبية — أغسطس 2026',
        'hybrid',
        '2026-08-09 18:00:00+03'::timestamptz,
        '2026-08-13 23:00:00+03'::timestamptz,
        '2026-08-08 23:59:00+03'::timestamptz,
        20,
        'open'
      ),
      (
        'KPI',
        'KPI-DEMO-20260816',
        'دفعة KPI التجريبية — أغسطس 2026',
        'hybrid',
        '2026-08-16 18:00:00+03'::timestamptz,
        '2026-08-20 23:00:00+03'::timestamptz,
        '2026-08-15 23:59:00+03'::timestamptz,
        20,
        'planning'
      )
  ) as seed(
    course_code,
    run_code,
    title,
    delivery_mode,
    starts_at,
    ends_at,
    registration_closes_at,
    capacity,
    status
  )
  join academy.courses course
    on course.tenant_id = v_tenant_id
   and course.course_code = seed.course_code
  on conflict (tenant_id, run_code) do nothing;

  insert into academy.course_run_sessions (
    tenant_id,
    course_run_id,
    session_number,
    title,
    starts_at,
    ends_at,
    delivery_mode,
    venue_or_link,
    status,
    metadata
  )
  select
    v_tenant_id,
    run.id,
    session.session_number,
    session.title,
    session.starts_at,
    session.ends_at,
    run.delivery_mode,
    run.venue_or_link,
    'scheduled',
    jsonb_build_object(
      'demo',
      true,
      'source',
      'reef-course-runs-v2'
    )
  from (
    values
      ('PMP-DEMO-20260802', 1, 'المحاضرة الأولى', '2026-08-02 16:00:00+03'::timestamptz, '2026-08-02 23:00:00+03'::timestamptz),
      ('PMP-DEMO-20260802', 2, 'المحاضرة الثانية', '2026-08-03 16:00:00+03'::timestamptz, '2026-08-03 23:00:00+03'::timestamptz),
      ('PMP-DEMO-20260802', 3, 'المحاضرة الثالثة', '2026-08-04 16:00:00+03'::timestamptz, '2026-08-04 23:00:00+03'::timestamptz),
      ('PMP-DEMO-20260802', 4, 'المحاضرة الرابعة', '2026-08-05 16:00:00+03'::timestamptz, '2026-08-05 23:00:00+03'::timestamptz),
      ('PMP-DEMO-20260802', 5, 'المحاضرة الخامسة', '2026-08-06 16:00:00+03'::timestamptz, '2026-08-06 23:00:00+03'::timestamptz),
      ('POWER-BI-DEMO-20260809', 1, 'المحاضرة الأولى', '2026-08-09 18:00:00+03'::timestamptz, '2026-08-09 23:00:00+03'::timestamptz),
      ('POWER-BI-DEMO-20260809', 2, 'المحاضرة الثانية', '2026-08-10 18:00:00+03'::timestamptz, '2026-08-10 23:00:00+03'::timestamptz),
      ('POWER-BI-DEMO-20260809', 3, 'المحاضرة الثالثة', '2026-08-11 18:00:00+03'::timestamptz, '2026-08-11 23:00:00+03'::timestamptz),
      ('POWER-BI-DEMO-20260809', 4, 'المحاضرة الرابعة', '2026-08-12 18:00:00+03'::timestamptz, '2026-08-12 23:00:00+03'::timestamptz),
      ('POWER-BI-DEMO-20260809', 5, 'المحاضرة الخامسة', '2026-08-13 18:00:00+03'::timestamptz, '2026-08-13 23:00:00+03'::timestamptz),
      ('KPI-DEMO-20260816', 1, 'المحاضرة الأولى', '2026-08-16 18:00:00+03'::timestamptz, '2026-08-16 23:00:00+03'::timestamptz),
      ('KPI-DEMO-20260816', 2, 'المحاضرة الثانية', '2026-08-17 18:00:00+03'::timestamptz, '2026-08-17 23:00:00+03'::timestamptz),
      ('KPI-DEMO-20260816', 3, 'المحاضرة الثالثة', '2026-08-18 18:00:00+03'::timestamptz, '2026-08-18 23:00:00+03'::timestamptz),
      ('KPI-DEMO-20260816', 4, 'المحاضرة الرابعة', '2026-08-19 18:00:00+03'::timestamptz, '2026-08-19 23:00:00+03'::timestamptz),
      ('KPI-DEMO-20260816', 5, 'المحاضرة الخامسة', '2026-08-20 18:00:00+03'::timestamptz, '2026-08-20 23:00:00+03'::timestamptz)
  ) as session(run_code, session_number, title, starts_at, ends_at)
  join academy.course_runs run
    on run.tenant_id = v_tenant_id
   and run.run_code = session.run_code
  on conflict (course_run_id, session_number) do nothing;
end;
$$;

revoke execute on function public.v2_tenant_course_runs_snapshot(text)
from public, anon;

revoke execute on function public.v2_tenant_save_course_run(
  text,
  uuid,
  text,
  text,
  timestamp,
  timestamp,
  integer,
  jsonb,
  uuid,
  text,
  text,
  text,
  bigint,
  timestamp,
  timestamp,
  text
) from public, anon;

grant execute on function public.v2_tenant_course_runs_snapshot(text)
to authenticated;

grant execute on function public.v2_tenant_save_course_run(
  text,
  uuid,
  text,
  text,
  timestamp,
  timestamp,
  integer,
  jsonb,
  uuid,
  text,
  text,
  text,
  bigint,
  timestamp,
  timestamp,
  text
) to authenticated;

comment on table academy.course_run_sessions is
'Tenant-isolated timetable sessions for a specific delivery run.';

comment on function public.v2_tenant_course_runs_snapshot(text) is
'Returns batch capacity, registration windows, and timetable sessions for one tenant.';

comment on function public.v2_tenant_save_course_run(
  text,
  uuid,
  text,
  text,
  timestamp,
  timestamp,
  integer,
  jsonb,
  uuid,
  text,
  text,
  text,
  bigint,
  timestamp,
  timestamp,
  text
) is
'Creates or updates a tenant course run and its timetable in one audited transaction.';

commit;
