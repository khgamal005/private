begin;

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
  v_exact_time_range_count integer;
  v_time_range_count integer;
  v_start_spread interval;
  v_end_spread interval;
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
    count(distinct (entry.start_time, entry.end_time))::integer,
    max(entry.start_time) - min(entry.start_time),
    max(entry.end_time) - min(entry.end_time)
  into
    v_entry_count,
    v_exact_time_range_count,
    v_start_spread,
    v_end_spread
  from entries entry;

  if v_entry_count = 0 then return 'سيحدد لاحقًا'; end if;

  v_time_range_count := case
    when v_exact_time_range_count = 1 then 1
    when v_start_spread <= interval '5 minutes'
     and v_end_spread <= interval '5 minutes' then 1
    else v_exact_time_range_count
  end;

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
        end as day_order
      from academy.course_run_sessions session
      where session.course_run_id = p_course_run_id
        and session.status <> 'cancelled'
    )
    select
      count(*)::integer,
      min(entry.day_order),
      max(entry.day_order),
      string_agg(
        private_app.arabic_weekday_name(entry.day_order),
        '، ' order by entry.day_order
      )
    into v_day_count, v_min_day, v_max_day, v_day_list
    from entries entry;

    with entries as (
      select
        (session.starts_at at time zone v_timezone)::time(0)
          as start_time,
        (session.ends_at at time zone v_timezone)::time(0)
          as end_time
      from academy.course_run_sessions session
      where session.course_run_id = p_course_run_id
        and session.status <> 'cancelled'
    )
    select
      mode() within group (order by entry.start_time),
      mode() within group (order by entry.end_time)
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

commit;
