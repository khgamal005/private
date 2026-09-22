begin;
-- Keep canonical attendance history reviewable after a legitimate transfer or
-- withdrawal, strictly for a captured past roster and an authorized human review.
create or replace function private_app.validate_attendance_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_enrollment academy.enrollments%rowtype;
  v_session academy.course_run_sessions%rowtype;
  historical boolean:=false;
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
  historical:=zoom_core.allowed(new.tenant_id,'attendance.review') and new.marked_by_subject_id=private_app.current_subject_id() and exists(select 1 from zoom_core.links l where l.tenant_id=new.tenant_id and l.session_id=new.session_id and l.id::text=new.metadata->'zoom'->>'linkId' and zoom_core.historical_enrollment(new.tenant_id,l.id,new.enrollment_id));

  if v_enrollment.tenant_id <> new.tenant_id
     or v_session.tenant_id <> new.tenant_id
     or (v_enrollment.course_run_id <> new.course_run_id and not historical)
     or v_session.course_run_id <> new.course_run_id then
    raise exception 'invalid_training_record';
  end if;
  if v_enrollment.status in ('withdrawn', 'cancelled') and not historical then
    raise exception 'enrollment_inactive';
  end if;
  if v_session.status = 'cancelled' then
    raise exception 'session_cancelled';
  end if;

  return new;
end;
$$;
revoke all on function private_app.validate_attendance_record() from public,anon,authenticated,service_role;
commit;
