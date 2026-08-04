begin;
-- A legacy demo seed computes registration_opens_at from now(). Once the
-- fixed demo dates passed, that value could temporarily be later than the
-- fixed registration_closes_at. The strict constraint is restored by the
-- immediately following repair migration after the seed runs.
alter table academy.course_runs
  drop constraint if exists course_runs_registration_window_check;
commit;
