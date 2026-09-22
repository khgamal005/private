begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- Academy-only scheduling uses canonical runs/sessions and existing evidence
-- guards. No tenant activation, attendance deletion, certificate or provider calls.
create function private_app.academy_schedule_run_v1(r academy.course_runs) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',r.id,'title',coalesce(r.title,r.run_code),'courseId',r.course_id,'status',r.status,
 'version',md5(to_jsonb(r)::text),'startsAt',r.starts_at,'endsAt',r.ends_at,'deliveryMode',r.delivery_mode,
 'selfPaced',coalesce(r.metadata->>'trainingJourneySelfpaced','false')='true',
 'sessionCount',(select count(*) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status<>'cancelled'),
 'pendingSessions',(select count(*) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status='scheduled'),
 'futureSessions',(select count(*) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status<>'cancelled' and s.ends_at>now()),
 'missingAttendance',(select count(*) from academy.enrollments e join academy.course_run_sessions s on s.tenant_id=e.tenant_id and s.course_run_id=e.course_run_id
 where e.tenant_id=r.tenant_id and e.course_run_id=r.id and e.status in ('confirmed','active','completed') and s.status<>'cancelled' and s.ends_at<=now() and e.enrolled_at<=s.ends_at
 and not exists(select 1 from academy.attendance_records a where a.tenant_id=e.tenant_id and a.enrollment_id=e.id and a.session_id=s.id)))
$$;

create function public.v1_academy_schedule_snapshot(p_slug text,p_run_id uuid default null,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;r academy.course_runs%rowtype;runs jsonb;sessions jsonb;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);
 if not private_app.academy_has_permission_v1(t,'manageLearning') then raise exception 'forbidden' using errcode='42501';end if;
 if p_offset is null or p_offset not between 0 and 100000 then raise exception 'invalid_request';end if;
 select coalesce(jsonb_agg(x.row),'[]') into runs from (select private_app.academy_schedule_run_v1(run) row from academy.course_runs run where run.tenant_id=t order by run.created_at desc,run.id limit 50 offset p_offset)x;
 if p_run_id is not null then
  select * into r from academy.course_runs where tenant_id=t and id=p_run_id;
  if r.id is null then raise exception 'course_run_not_found';end if;
  select coalesce(jsonb_agg(x.row),'[]') into sessions from (select jsonb_build_object('id',s.id,'number',s.session_number,'title',s.title,'startsAt',s.starts_at,'endsAt',s.ends_at,
   'deliveryMode',s.delivery_mode,'instructorName',s.instructor_name,'location',s.venue_or_link,'meetingUrl',s.meeting_join_url,'status',s.status,'version',md5(to_jsonb(s)::text),
   'providerManaged',s.external_meeting_id is not null,'hasAttendance',exists(select 1 from academy.attendance_records a where a.tenant_id=t and a.session_id=s.id)) row
   from academy.course_run_sessions s where s.tenant_id=t and s.course_run_id=r.id order by s.starts_at,s.id limit 100)x;
 end if;
 return jsonb_build_object('tenant',(select jsonb_build_object('slug',slug,'timezone',timezone) from core.tenants where id=t),
 'runs',runs,'selectedRun',case when r.id is not null then private_app.academy_schedule_run_v1(r) end,'sessions',coalesce(sessions,'[]'),
 'offset',p_offset,'hasMore',p_offset+50<(select count(*) from academy.course_runs where tenant_id=t));
end $$;

create function public.v1_academy_schedule_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid;actor uuid;r academy.course_runs%rowtype;s academy.course_run_sessions%rowtype;cached academy.platform_commands%rowtype;
 result jsonb;before_state jsonb;before_session jsonb;evidence jsonb;start_at timestamptz;end_at timestamptz;link text;location_value text;mode_value text;sid uuid;n integer;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);actor:=private_app.current_subject_id();
 if not private_app.academy_has_permission_v1(t,'manageLearning') then raise exception 'forbidden' using errcode='42501';end if;
 if p_action is null or p_action not in ('save_session','cancel_session','complete_session','start_run','complete_run') or p_command_id is null
 or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>12000 then raise exception 'invalid_request';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-command:'||p_command_id::text,220926));
 select * into cached from academy.platform_commands where tenant_id=t and command_id=p_command_id;
 if cached.command_id is not null then
  if cached.actor_subject_id<>actor or cached.action<>'schedule.'||p_action or cached.payload<>p_payload then raise exception 'academy_command_conflict';end if;
  return cached.response;
 end if;
 select * into r from academy.course_runs where tenant_id=t and id=(p_payload->>'runId')::uuid for update;
 if r.id is null then raise exception 'course_run_not_found';end if;
 if p_payload->>'expectedRunVersion' is distinct from md5(to_jsonb(r)::text) then raise exception 'academy_schedule_conflict';end if;
 if r.status not in ('open','in_progress','planning') then raise exception 'academy_schedule_run_locked';end if;
 before_state:=private_app.academy_schedule_run_v1(r);
 if p_action in ('start_run','complete_run') then
  if p_payload->>'reviewed' is distinct from 'true' then raise exception 'academy_schedule_review_required';end if;
  evidence:=private_app.academy_schedule_run_v1(r);
  if (evidence->>'sessionCount')::integer=0 and not (evidence->>'selfPaced')::boolean then raise exception 'course_run_sessions_required';end if;
  if p_action='start_run' then
   if r.status<>'open' or r.starts_at>now() then raise exception 'academy_schedule_not_started';end if;
   update academy.course_runs set status='in_progress' where tenant_id=t and id=r.id;
  else
   if r.status not in ('open','in_progress') then raise exception 'academy_schedule_run_locked';end if;
   if (evidence->>'futureSessions')::integer>0 or r.ends_at>now() then raise exception 'course_run_sessions_not_ended';end if;
   if (evidence->>'pendingSessions')::integer>0 then raise exception 'course_run_sessions_not_completed';end if;
   if (evidence->>'missingAttendance')::integer>0 then raise exception 'attendance_unrecorded_blocks_closure';end if;
   update academy.course_runs set status='completed' where tenant_id=t and id=r.id;
  end if;
 else
  sid:=nullif(p_payload->>'sessionId','')::uuid;
  if sid is not null then
   select * into s from academy.course_run_sessions where tenant_id=t and course_run_id=r.id and id=sid for update;
   if s.id is null then raise exception 'training_session_not_found';end if;
   before_session:=to_jsonb(s);
   if p_payload->>'expectedSessionVersion' is distinct from md5(to_jsonb(s)::text) then raise exception 'academy_schedule_conflict';end if;
   if s.status<>'scheduled' then raise exception 'academy_schedule_session_locked';end if;
  elsif p_action<>'save_session' then raise exception 'training_session_not_found';end if;
  if p_action='save_session' then
   start_at:=(p_payload->>'startsAt')::timestamptz;end_at:=(p_payload->>'endsAt')::timestamptz;
   if coalesce(p_payload->>'startsAt','')!~'(Z|[+-][0-9]{2}:[0-9]{2})$' or coalesce(p_payload->>'endsAt','')!~'(Z|[+-][0-9]{2}:[0-9]{2})$'
    or start_at is null or end_at is null or not isfinite(start_at) or not isfinite(end_at) or end_at<=start_at then raise exception 'invalid_course_run_session_dates';end if;
   if start_at<r.starts_at or end_at>r.ends_at then raise exception 'session_outside_course_run';end if;
   if coalesce(length(btrim(p_payload->>'title')),0) not between 2 and 200 then raise exception 'invalid_request';end if;
   mode_value:=p_payload->>'deliveryMode';link:=nullif(btrim(p_payload->>'meetingUrl'),'');location_value:=nullif(btrim(p_payload->>'location'),'');
   if mode_value is null or mode_value not in ('online','onsite','hybrid') then raise exception 'invalid_delivery_mode';end if;
   if link is not null and (length(link)>2000 or link!~'^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$') then raise exception 'academy_schedule_https_required';end if;
   if mode_value in ('online','hybrid') and link is null or mode_value in ('onsite','hybrid') and coalesce(length(location_value),0) not between 2 and 500 then raise exception 'academy_schedule_location_required';end if;
   if coalesce(length(p_payload->>'instructorName'),0)>200 then raise exception 'invalid_request';end if;
   if s.id is not null and (s.external_meeting_id is not null or s.meeting_status in ('queued','ready')) then raise exception 'academy_schedule_provider_managed';end if;
   if s.id is not null and (start_at<>s.starts_at or end_at<>s.ends_at) and exists(select 1 from academy.attendance_records where tenant_id=t and session_id=s.id) then raise exception 'recorded_session_schedule_locked';end if;
   if exists(select 1 from academy.course_run_sessions x where x.tenant_id=t and x.course_run_id=r.id and x.status<>'cancelled' and (sid is null or x.id<>sid) and tstzrange(x.starts_at,x.ends_at,'[)')&&tstzrange(start_at,end_at,'[)')) then raise exception 'course_run_sessions_overlap';end if;
   if sid is null then
    if (select count(*) from academy.course_run_sessions where tenant_id=t and course_run_id=r.id)>=100 then raise exception 'too_many_course_run_sessions';end if;
    select coalesce(max(session_number),0)+1 into n from academy.course_run_sessions where tenant_id=t and course_run_id=r.id;
    insert into academy.course_run_sessions(tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,instructor_name,venue_or_link,meeting_join_url,metadata)
    values(t,r.id,n,btrim(p_payload->>'title'),start_at,end_at,mode_value,nullif(btrim(p_payload->>'instructorName'),''),location_value,link,jsonb_build_object('source','academy_schedule')) returning id into sid;
   else
    update academy.course_run_sessions set title=btrim(p_payload->>'title'),starts_at=start_at,ends_at=end_at,delivery_mode=mode_value,instructor_name=nullif(btrim(p_payload->>'instructorName'),''),venue_or_link=location_value,meeting_join_url=link where tenant_id=t and id=sid;
   end if;
  elsif p_action='cancel_session' then
   if coalesce(length(btrim(p_payload->>'reason')),0) not between 5 and 500 then raise exception 'academy_schedule_reason_required';end if;
   if exists(select 1 from academy.attendance_records where tenant_id=t and session_id=sid) then raise exception 'recorded_session_schedule_locked';end if;
   update academy.course_run_sessions set status='cancelled',metadata=metadata||jsonb_build_object('academyCancellationReason',btrim(p_payload->>'reason')) where tenant_id=t and id=sid;
  else
   if p_payload->>'reviewed' is distinct from 'true' then raise exception 'academy_schedule_review_required';end if;
   if s.ends_at>now() then raise exception 'course_run_sessions_not_ended';end if;
   if exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_run_id=r.id and e.status in ('confirmed','active','completed') and e.enrolled_at<=s.ends_at and not exists(select 1 from academy.attendance_records a where a.tenant_id=t and a.enrollment_id=e.id and a.session_id=s.id)) then raise exception 'attendance_unrecorded_blocks_closure';end if;
   update academy.course_run_sessions set status='completed' where tenant_id=t and id=sid;
  end if;
  update academy.course_runs set metadata=metadata||jsonb_build_object('academyScheduleRevision',coalesce((metadata->>'academyScheduleRevision')::bigint,0)+1) where tenant_id=t and id=r.id;
 end if;
 select * into r from academy.course_runs where tenant_id=t and id=r.id;
 result:=jsonb_build_object('run',private_app.academy_schedule_run_v1(r),'sessionId',sid);
 perform private_app.write_audit('academy.schedule.'||p_action,'course_run',r.id::text,t,jsonb_build_object('commandId',p_command_id,'sessionId',sid,'before',before_state,'after',result,
  'sessionBefore',before_session,'sessionAfter',(select to_jsonb(x) from academy.course_run_sessions x where x.tenant_id=t and x.id=sid)));
 insert into academy.platform_commands(tenant_id,command_id,actor_subject_id,action,payload,response) values(t,p_command_id,actor,'schedule.'||p_action,p_payload,result);
 return result;
end $$;

revoke all on function private_app.academy_schedule_run_v1(academy.course_runs) from public,anon,authenticated,service_role;
revoke all on function public.v1_academy_schedule_snapshot(text,uuid,integer),public.v1_academy_schedule_action(text,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_academy_schedule_snapshot(text,uuid,integer),public.v1_academy_schedule_action(text,text,uuid,jsonb) to authenticated;
commit;
