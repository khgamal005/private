-- Production definitions captured read-only before Zoom deployment.
-- Reference only: do not execute as a blanket rollback. Keep customer data and Zoom schema.

CREATE OR REPLACE FUNCTION private_app.academy_authoring_release_immutable_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ begin raise exception 'academy_authoring_release_immutable';end $function$

CREATE OR REPLACE FUNCTION private_app.training_eligibility(p_enrollment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v_result jsonb;begin
 v_result:=private_app.training_learning_eligibility_v1(p_enrollment_id);
 if v_result is not null then return v_result-'financialAccess';end if;
 if exists(select 1 from academy.enrollments e join academy.training_financial_links l on l.tenant_id=e.tenant_id and l.handoff_id=e.handoff_id join academy.training_journey_settings cfg on cfg.tenant_id=e.tenant_id and cfg.enabled where e.id=p_enrollment_id and e.tenant_id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid) then return jsonb_build_object('eligible',false,'reasons',jsonb_build_array('training_version_required'));end if;
 return private_app.training_eligibility_before_journey_v1(p_enrollment_id);
end $function$

CREATE OR REPLACE FUNCTION private_app.training_learning_eligibility_v1(p_enrollment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 e academy.enrollments%rowtype;v academy.training_course_versions%rowtype;r academy.course_runs%rowtype;
 v_required int;v_completed int;v_assessment_count int;v_graded_count int;v_score numeric;v_total int;v_done int;v_marked int;v_attended int;v_attendance numeric;
 v_reasons jsonb:='[]';v_finance jsonb;
begin
 select * into e from academy.enrollments where id=p_enrollment_id;
 select cv.* into v from academy.training_enrollment_versions ev join academy.training_course_versions cv on cv.tenant_id=ev.tenant_id and cv.id=ev.version_id where ev.tenant_id=e.tenant_id and ev.enrollment_id=e.id;
 if v.id is null then return null;end if;
 select * into r from academy.course_runs where tenant_id=e.tenant_id and id=e.course_run_id;
 select count(*),count(*) filter(where p.completed_at is not null) into v_required,v_completed from academy.training_units u left join academy.training_unit_progress p on p.tenant_id=u.tenant_id and p.unit_id=u.id and p.enrollment_id=e.id where u.tenant_id=e.tenant_id and u.version_id=v.id and u.required;
 select count(*),count(score),round(avg(score),2) into v_assessment_count,v_graded_count,v_score from (
  select case when u.kind='quiz' then (select max(a.score) from academy.training_quiz_attempts a where a.tenant_id=e.tenant_id and a.enrollment_id=e.id and a.unit_id=u.id) else (select g.score from academy.training_submissions s join academy.training_grades g on g.tenant_id=s.tenant_id and g.submission_id=s.id where s.tenant_id=e.tenant_id and s.enrollment_id=e.id and s.unit_id=u.id order by s.attempt desc,g.graded_at desc,g.id desc limit 1) end score from academy.training_units u where u.tenant_id=e.tenant_id and u.version_id=v.id and u.required and u.kind in ('quiz','assignment')
 ) x;
 select count(*),count(*) filter(where s.status='completed') into v_total,v_done from academy.course_run_sessions s where s.tenant_id=e.tenant_id and s.course_run_id=e.course_run_id and s.status<>'cancelled';
 select count(*),count(*) filter(where a.status in ('present','late')) into v_marked,v_attended from academy.attendance_records a join academy.course_run_sessions s on s.tenant_id=a.tenant_id and s.id=a.session_id and s.status<>'cancelled' where a.tenant_id=e.tenant_id and a.enrollment_id=e.id;
 v_attendance:=case when v_total=0 then 0 else round(v_attended*100.0/v_total,2) end;
 v_finance:=private_app.training_journey_financial_access_v1(e.id);
 if e.status not in ('confirmed','active','completed') then v_reasons:=v_reasons||'"enrollment_inactive"'::jsonb;end if;
 if not coalesce((v.policy->>'certificateEnabled')::boolean,false) then v_reasons:=v_reasons||'"certificate_disabled"'::jsonb;end if;
 if v_required=0 or v_completed<v_required then v_reasons:=v_reasons||'"required_units_incomplete"'::jsonb;end if;
 if v_assessment_count=0 or v_graded_count<v_assessment_count then v_reasons:=v_reasons||'"assessment_missing"'::jsonb;
 elsif v_score<(v.policy->>'minAssessmentPercent')::numeric then v_reasons:=v_reasons||'"assessment_below_threshold"'::jsonb;end if;
 if v.learning_mode<>'self_paced' then
  if v_total=0 then v_reasons:=v_reasons||'"no_sessions"'::jsonb;end if;
  if v_done<v_total then v_reasons:=v_reasons||'"sessions_pending"'::jsonb;end if;
  if v_marked<v_total then v_reasons:=v_reasons||'"attendance_incomplete"'::jsonb;end if;
  if v_attendance<(v.policy->>'minAttendancePercent')::numeric then v_reasons:=v_reasons||'"attendance_below_threshold"'::jsonb;end if;
 end if;
 if coalesce((v.policy->>'requireCompletedRun')::boolean,false) and r.status<>'completed' then v_reasons:=v_reasons||'"run_not_completed"'::jsonb;end if;
 if not coalesce((v_finance->>'certificationAllowed')::boolean,false) then v_reasons:=v_reasons||'"financial_clearance_required"'::jsonb;end if;
 return jsonb_build_object('eligible',jsonb_array_length(v_reasons)=0,'reasons',v_reasons,'versionId',v.id,'versionTitle',v.title,'policy',v.policy,'totalUnits',v_required,'completedUnits',v_completed,'assessmentPercent',v_score,'minAssessmentPercent',(v.policy->>'minAssessmentPercent')::numeric,'totalSessions',v_total,'completedSessions',v_done,'recordedSessions',v_marked,'attendedSessions',v_attended,'attendancePercent',v_attendance,'minAttendancePercent',(v.policy->>'minAttendancePercent')::numeric,'financialAccess',v_finance);
end $function$

CREATE OR REPLACE FUNCTION private_app.training_version_immutable_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if tg_table_name='training_course_versions' then
  if old.status='published' then raise exception 'training_published_version_immutable';end if;
 elsif exists(select 1 from academy.training_course_versions where id=old.version_id and status='published') then
  raise exception 'training_published_version_immutable';
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $function$

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
$function$
