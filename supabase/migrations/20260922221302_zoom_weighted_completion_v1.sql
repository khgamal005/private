begin;
-- Add a weighted projection to the existing eligibility sources. Enrollments
-- without Zoom retain their exact canonical result and policy.
create function zoom_core.weighted_eligibility(eid uuid,base jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e academy.enrollments%rowtype;s record;a academy.attendance_records%rowtype;summary jsonb;seconds numeric;credit numeric;required_total numeric:=0;attended_total numeric:=0;ratio numeric;reasons jsonb;quality text:='complete';threshold numeric;
begin
 if base is null then return null;end if;
 select * into e from academy.enrollments where id=eid;
 if not exists(select 1 from zoom_core.links l join academy.course_run_sessions cs on cs.tenant_id=l.tenant_id and cs.id=l.session_id where l.tenant_id=e.tenant_id and cs.course_run_id=e.course_run_id) then return base;end if;
 reasons:=coalesce(base->'reasons','[]')-'attendance_below_threshold'-'zoom_attendance_policy_required'-'zoom_attendance_evidence_incomplete';
 for s in select cs.*,l.id link_id from academy.course_run_sessions cs left join zoom_core.links l on l.tenant_id=cs.tenant_id and l.session_id=cs.id where cs.tenant_id=e.tenant_id and cs.course_run_id=e.course_run_id and cs.status<>'cancelled' loop
  select * into a from academy.attendance_records where tenant_id=e.tenant_id and enrollment_id=e.id and session_id=s.id;
  if s.link_id is not null then
   summary:=zoom_core.attendance(e.tenant_id,s.link_id,e.id);seconds:=(summary->>'requiredSeconds')::numeric;credit:=(summary->>'attendedSeconds')::numeric;
   -- Human status and human credit remain distinct; unknown duration is never
   -- silently converted to 100%. Explicit credit needs attendance.override.
   if a.metadata->'zoom'->>'override'='true' and a.metadata->'zoom'->>'manualSeconds' is not null and a.metadata->'zoom'->>'policyRevision'=summary->>'policyRevision' then
    credit:=(a.metadata->'zoom'->>'manualSeconds')::numeric;
   elsif summary->>'quality'<>'complete' or a.id is null or a.metadata->'zoom'->>'policyRevision' is distinct from summary->>'policyRevision' then quality:=case when quality='policy_required' then quality else 'incomplete' end;
   end if;
  else
   seconds:=extract(epoch from s.ends_at-s.starts_at);
   credit:=case when a.status in ('present','late') then seconds else 0 end;
   if a.id is null then quality:=case when quality='policy_required' then quality else 'incomplete' end;end if;
  end if;
  if seconds is null or seconds<=0 then quality:='policy_required';else required_total:=required_total+seconds;attended_total:=attended_total+least(seconds,greatest(0,coalesce(credit,0)));end if;
 end loop;
 threshold:=(base->>'minAttendancePercent')::numeric;
 if threshold is null or not exists(select 1 from academy.course_run_rules where tenant_id=e.tenant_id and course_run_id=e.course_run_id) then quality:='policy_required';end if;
 ratio:=case when required_total>0 then round(attended_total*100/required_total,2) end;
 if quality='policy_required' then reasons:=reasons||'"zoom_attendance_policy_required"'::jsonb;
 elsif quality<>'complete' then reasons:=reasons||'"zoom_attendance_evidence_incomplete"'::jsonb;end if;
 if ratio<threshold then reasons:=reasons||'"attendance_below_threshold"'::jsonb;end if;
 return base||jsonb_build_object('eligible',jsonb_array_length(reasons)=0,'reasons',reasons,'attendancePercent',case when quality='complete' then ratio end,'zoomWeightedAttendance',jsonb_build_object('attendedSeconds',attended_total,'requiredSeconds',required_total,'percent',case when quality='complete' then ratio end,'quality',quality,'basis','approved_seconds'));
end $$;
alter function private_app.training_learning_eligibility_v1(uuid) rename to training_learning_eligibility_before_zoom_v1;
create function private_app.training_learning_eligibility_v1(p_enrollment_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select zoom_core.weighted_eligibility(p_enrollment_id,private_app.training_learning_eligibility_before_zoom_v1(p_enrollment_id))
$$;
alter function private_app.training_eligibility(uuid) rename to training_eligibility_before_zoom_v1;
create function private_app.training_eligibility(p_enrollment_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select zoom_core.weighted_eligibility(p_enrollment_id,private_app.training_eligibility_before_zoom_v1(p_enrollment_id))
$$;
create function zoom_core.weighted_certificate_guard() returns trigger language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if new.status='issued' then
  result:=private_app.training_eligibility(new.enrollment_id);
  if result?'zoomWeightedAttendance' and (result->'zoomWeightedAttendance'->>'quality'<>'complete' or (result->'zoomWeightedAttendance'->>'percent')::numeric<(result->>'minAttendancePercent')::numeric) then raise exception 'zoom_certificate_weighted_attendance';end if;
  if result?'zoomWeightedAttendance' then new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('zoomWeightedAttendance',result->'zoomWeightedAttendance');end if;
 end if;return new;
end $$;
create trigger zoom_weighted_certificate_guard before insert or update of status on academy.certificates for each row execute function zoom_core.weighted_certificate_guard();
revoke all on function private_app.training_learning_eligibility_before_zoom_v1(uuid),private_app.training_learning_eligibility_v1(uuid),private_app.training_eligibility_before_zoom_v1(uuid),private_app.training_eligibility(uuid),zoom_core.weighted_eligibility(uuid,jsonb),zoom_core.weighted_certificate_guard() from public,anon,authenticated,service_role;
commit;
