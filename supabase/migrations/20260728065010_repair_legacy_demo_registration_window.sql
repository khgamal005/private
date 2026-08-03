begin;
-- Repair any legacy/demo row inserted with a time-dependent opening date.
update academy.course_runs run
set registration_closes_at=case
      when run.starts_at is not null
       and run.registration_closes_at is not null
       and run.registration_closes_at>run.starts_at
      then run.starts_at-interval '1 minute'
      else run.registration_closes_at
    end;

update academy.course_runs run
set registration_opens_at=case
      when run.registration_closes_at is not null
      then run.registration_closes_at-interval '30 days'
      when run.starts_at is not null
      then run.starts_at-interval '30 days'
      else run.registration_opens_at
    end
where run.registration_opens_at is not null
  and (
    (run.registration_closes_at is not null
      and run.registration_opens_at>run.registration_closes_at)
    or (run.starts_at is not null
      and run.registration_opens_at>run.starts_at)
  );

alter table academy.course_runs
  drop constraint if exists course_runs_registration_window_check;
alter table academy.course_runs
  add constraint course_runs_registration_window_check
  check (
    (registration_opens_at is null
      or registration_closes_at is null
      or registration_opens_at<=registration_closes_at)
    and
    (registration_closes_at is null
      or starts_at is null
      or registration_closes_at<=starts_at)
  );
commit;
