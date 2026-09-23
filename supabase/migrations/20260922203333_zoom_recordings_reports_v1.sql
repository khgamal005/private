begin;
create table zoom_core.recordings (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,instance_id uuid not null,provider_file_id text not null,
 file_type text not null,recording_type text,size_bytes bigint not null default 0 check(size_bytes>=0),
 state text not null default 'review' check(state in ('processing','review','published','withdrawn','source_missing','deleted')),
 secret_id uuid,transcript text,transcript_revision integer not null default 1,expires_at timestamptz,
 published_by uuid references access_control.subjects(id),published_at timestamptz,updated_at timestamptz not null default now(),
 foreign key(tenant_id,instance_id) references zoom_core.instances(tenant_id,id),unique(instance_id,provider_file_id),unique(tenant_id,id)
);
create index zoom_recordings_tenant_state on zoom_core.recordings(tenant_id,state,updated_at);
create table zoom_core.recording_opens (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,recording_id uuid not null,subject_id uuid not null references access_control.subjects(id),
 event text not null default 'opened' check(event='opened'),created_at timestamptz not null default now(),
 foreign key(tenant_id,recording_id) references zoom_core.recordings(tenant_id,id)
);
create index zoom_recording_opens on zoom_core.recording_opens(tenant_id,recording_id,created_at);
create table zoom_core.retention_runs (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,connection_id uuid not null,status text not null,counts jsonb not null default '{}',created_at timestamptz not null default now(),
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id)
);
create function public.v1_zoom_recordings_store(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_uuid text,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;i zoom_core.instances%rowtype;f jsonb;existing zoom_core.recordings%rowtype;sid uuid;
begin
 perform zoom_core.service_only();ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);
 select * into i from zoom_core.instances where tenant_id=(ctx->'link'->>'tenant_id')::uuid and link_id=(ctx->'link'->>'id')::uuid and uuid=p_uuid;
 if i.id is null or jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files)>200 then raise exception 'zoom_invalid_provider_response';end if;
 for f in select value from jsonb_array_elements(p_files) loop
  if nullif(f->>'id','') is null or f->>'file_type' not in ('MP4','M4A','TIMELINE','TRANSCRIPT','CC','CHAT') then continue;end if;
  select * into existing from zoom_core.recordings where tenant_id=i.tenant_id and instance_id=i.id and provider_file_id=f->>'id' for update;
  sid:=existing.secret_id;
  if nullif(f->>'play_url','') is not null then
   if f->>'play_url' !~ '^https://([a-zA-Z0-9-]+\.)*zoom\.us/' then raise exception 'zoom_invalid_provider_response';end if;
   if sid is null then select vault.create_secret(jsonb_build_object('play_url',f->>'play_url')::text,'zoom-recording:'||gen_random_uuid(),'ODEIR controlled recording link',null) into sid;
   else perform vault.update_secret(sid,jsonb_build_object('play_url',f->>'play_url')::text,null,null);end if;
  end if;
  insert into zoom_core.recordings(tenant_id,instance_id,provider_file_id,file_type,recording_type,size_bytes,state,secret_id)
  values(i.tenant_id,i.id,f->>'id',f->>'file_type',f->>'recording_type',coalesce((f->>'file_size')::bigint,0),case when f->>'status'='completed' then 'review' else 'processing' end,sid)
  on conflict(instance_id,provider_file_id) do update set size_bytes=excluded.size_bytes,secret_id=excluded.secret_id,state=case when zoom_core.recordings.state in ('published','withdrawn','deleted') then zoom_core.recordings.state else excluded.state end,updated_at=now();
 end loop;return jsonb_build_object('status','stored');
end $$;
create function public.v1_zoom_recording_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);r zoom_core.recordings%rowtype;result jsonb;policy jsonb;days integer;
begin
 if not zoom_core.allowed(t,'recordings.publish') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,p_action,p_payload);if result is not null then return result;end if;
 select * into r from zoom_core.recordings where tenant_id=t and id=(p_payload->>'recordingId')::uuid for update;
 if r.id is null or r.state='deleted' then raise exception 'zoom_not_found';end if;
 if p_action='publish_recording' then
  select retention_policy into policy from zoom_core.settings where tenant_id=t;
  days:=(policy->>'days')::integer;
  if policy->>'approved' is distinct from 'true' or policy->>'revocationLimitAcknowledged' is distinct from 'true' or days is null or days not between 1 and 3650 or coalesce(p_payload->>'reviewed','false')<>'true' or r.secret_id is null then raise exception 'zoom_recording_review_required';end if;
  update zoom_core.recordings set state='published',published_by=private_app.current_subject_id(),published_at=now(),expires_at=now()+make_interval(days=>days),updated_at=now() where id=r.id;
 elsif p_action='withdraw_recording' then
  if length(trim(coalesce(p_payload->>'reason','')))<5 then raise exception 'zoom_reason_required';end if;
  update zoom_core.recordings set state='withdrawn',updated_at=now() where id=r.id;
 else raise exception 'zoom_invalid_action';end if;
 result:=jsonb_build_object('id',r.id,'action',p_action);update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.'||p_action,'zoom_recording',r.id::text,t,jsonb_build_object('reason',left(p_payload->>'reason',500)));return result;
end $$;
create function public.v1_zoom_recording_access(p_slug text,p_recording_id uuid,p_enrollment_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);r zoom_core.recordings%rowtype;l zoom_core.links%rowtype;e academy.enrollments%rowtype;url_value text;f jsonb;
begin
 select * into r from zoom_core.recordings where tenant_id=t and id=p_recording_id;
 select x.* into l from zoom_core.links x join zoom_core.instances i on i.tenant_id=x.tenant_id and i.link_id=x.id where i.tenant_id=t and i.id=r.instance_id;
 if r.id is null or r.state in ('deleted','source_missing') then raise exception 'zoom_not_found';end if;
 if not zoom_core.allowed(t,'recordings.publish') and not private_app.training_is_instructor_v1(t,(select course_run_id from academy.course_run_sessions where tenant_id=t and id=l.session_id)) then
  select e1.* into e from academy.enrollments e1 join academy.course_run_sessions s on s.tenant_id=e1.tenant_id and s.course_run_id=e1.course_run_id where e1.tenant_id=t and e1.id=p_enrollment_id and s.id=l.session_id;
  if e.id is null or not private_app.training_is_learner_v1(t,e.id) then raise exception 'zoom_forbidden';end if;
  f:=private_app.training_journey_financial_access_v1(e.id);
  -- Reuse the installed financial policy; do not invent paid-in-full gating.
  if not coalesce((f->>'trainingAllowed')::boolean,false) then raise exception 'zoom_not_entitled';end if;
  if r.state<>'published' or r.expires_at<=now() then raise exception 'zoom_recording_unavailable';end if;
 end if;
 if not exists(select 1 from zoom_core.connections where tenant_id=t and id=l.connection_id and status in ('connected','paused')) then raise exception 'zoom_recording_unavailable';end if;
 select decrypted_secret::jsonb->>'play_url' into url_value from vault.decrypted_secrets where id=r.secret_id;
 if url_value is null then raise exception 'zoom_recording_unavailable';end if;
 insert into zoom_core.recording_opens(tenant_id,recording_id,subject_id) values(t,r.id,private_app.current_subject_id());
 return jsonb_build_object('url',url_value,'delivery','provider','measurement','opened_only');
end $$;
create function public.v1_zoom_snapshot(p_slug text,p_view text default 'sessions',p_options jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug,false);manager boolean:=zoom_core.allowed(t,'sessions.manage');account_manager boolean:=zoom_core.allowed(t,'connections.manage');
 result jsonb;start_at timestamptz:=coalesce((p_options->>'from')::timestamptz,now()-interval '7 days');end_at timestamptz:=coalesce((p_options->>'to')::timestamptz,now()+interval '30 days');off integer:=coalesce((p_options->>'offset')::int,0);q text:=coalesce(p_options->>'query','');lid uuid:=(p_options->>'linkId')::uuid;
begin
 if off not between 0 and 100000 or length(q)>100 or end_at<=start_at or end_at-start_at>interval '93 days' then raise exception 'zoom_invalid_range';end if;
 if not(manager or account_manager or zoom_core.allowed(t,'reports.export') or zoom_core.allowed(t,'attendance.review') or zoom_core.allowed(t,'recordings.publish') or zoom_core.allowed(t,'ai.generate') or zoom_core.allowed(t,'webinars.manage'))
  and not exists(select 1 from academy.enrollments e where e.tenant_id=t and private_app.training_is_learner_v1(t,e.id))
  and not exists(select 1 from academy.training_run_instructors i where i.tenant_id=t and private_app.training_is_instructor_v1(t,i.run_id)) then raise exception 'zoom_forbidden';end if;
 result:=jsonb_build_object('enabled',exists(select 1 from zoom_core.settings where tenant_id=t and enabled) and private_app.tenant_addon_enabled(t,'addon.integration.zoom'),
 'tenant',jsonb_build_object('slug',p_slug,'name',(select name from core.tenants where id=t),'timezone',(select timezone from core.tenants where id=t)),
 'permissions',jsonb_build_object('accounts',account_manager,'hosts',zoom_core.allowed(t,'hosts.manage'),'sessions',manager,'attendance',zoom_core.allowed(t,'attendance.review'),'override',zoom_core.allowed(t,'attendance.override'),'recordings',zoom_core.allowed(t,'recordings.publish'),'export',zoom_core.allowed(t,'reports.export'),'retention',zoom_core.allowed(t,'retention.manage'),'ai',zoom_core.allowed(t,'ai.generate'),'webinars',zoom_core.allowed(t,'webinars.manage')),'settings',case when account_manager then (select to_jsonb(cfg)-'ai_policy' from zoom_core.settings cfg where cfg.tenant_id=t) end,'offset',off,'limit',50);
 if manager and p_view='sessions' then
  result:=result||jsonb_build_object('hosts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name)) from zoom_core.hosts where tenant_id=t and allowed),'[]'),
   'instructors',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'full_name',a.full_name,'run_id',i.run_id)) from academy.training_run_instructors i join access_control.subjects a on a.id=i.subject_id where i.tenant_id=t and i.active and zoom_core.active_instructor(t,a.id)),'[]'));
 end if;
 if p_view='accounts' then
  if not account_manager then raise exception 'zoom_forbidden';end if;
  return result||jsonb_build_object('accounts',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,label,status,scopes,generation,last_synced_at,sync_coverage,last_error from zoom_core.connections where tenant_id=t order by created_at,id limit 50 offset off)x),'[]'),
   'hosts',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,connection_id,user_id,name,allowed,provider_active,licensed,capacity,concurrency_limit,provider_concurrency,capabilities,verified_at,instructor_subject_id,revision,before_minutes,after_minutes from zoom_core.hosts where tenant_id=t and (q='' or name ilike '%'||q||'%') order by name,id limit 50 offset off)x),'[]'),
   'instructors',coalesce((select jsonb_agg(to_jsonb(x)) from(select distinct a.id,a.full_name from academy.training_run_instructors i join access_control.subjects a on a.id=i.subject_id and a.status='active' where i.tenant_id=t and i.active limit 100)x),'[]'));
 elsif p_view in ('sessions','learner') then
  return result||jsonb_build_object('sessions',coalesce((select jsonb_agg(x.item) from(select jsonb_build_object('id',s.id,'title',s.title,'runId',s.course_run_id,'runTitle',r.title,'courseTitle',c.title_ar,'startsAt',s.starts_at,'endsAt',s.ends_at,'academicStatus',s.status,'instructor',s.instructor_name,'linkId',l.id,'revision',coalesce(l.revision,0),'meetingOptions',l.desired->'meetingOptions','occurrenceId',l.occurrence_id,'seriesRoot',l.desired->'series','timezone',(select timezone from core.tenants where id=t),'kind',l.kind,'state',l.state,'reason',l.reason,'lastSyncedAt',l.last_synced_at,'observedSchedule',case when p_view<>'learner' then jsonb_build_object('startsAt',l.observed->'startsAt','duration',l.observed->'duration','missing',l.observed->'missing') end,'livePresence',case when p_view<>'learner' and l.state='live' then jsonb_build_object('participants',(select count(distinct coalesce(v.enrollment_id::text,v.participant_key)) from zoom_core.intervals v join zoom_core.instances i on i.tenant_id=v.tenant_id and i.id=v.instance_id where v.tenant_id=t and i.link_id=l.id and i.ended_at is null and v.source='webhook' and v.kind='meeting' and v.joined_at is not null and v.left_at is null),'lastEventAt',(select max(ev.received_at) from zoom_core.events ev where ev.tenant_id=t and ev.connection_id=l.connection_id and ev.payload->>'meetingId'=l.meeting_id),'basis','preliminary_events') end,'attendance',case when p_view='learner' then (select jsonb_build_object('status',a.status,'percent',a.metadata->'zoom'->'percent') from academy.attendance_records a where a.tenant_id=t and a.session_id=s.id and private_app.training_is_learner_v1(t,a.enrollment_id) limit 1) end,'enrollmentId',case when p_view='learner' then (select e.id from academy.enrollments e where e.tenant_id=t and e.course_run_id=s.course_run_id and private_app.training_is_learner_v1(t,e.id) limit 1) end) item
   from academy.course_run_sessions s join academy.course_runs r on r.tenant_id=s.tenant_id and r.id=s.course_run_id join academy.courses c on c.tenant_id=r.tenant_id and c.id=r.course_id left join zoom_core.links l on l.tenant_id=s.tenant_id and l.session_id=s.id
   where s.tenant_id=t and (p_options->>'sessionId' is not null or (s.starts_at>=start_at and s.starts_at<end_at)) and (p_options->>'sessionId' is null or s.id=(p_options->>'sessionId')::uuid) and (q='' or s.title ilike '%'||q||'%')
   and ((p_view<>'learner' and (manager or private_app.training_is_instructor_v1(t,s.course_run_id))) or (p_view='learner' and exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_run_id=s.course_run_id and private_app.training_is_learner_v1(t,e.id)))) order by s.starts_at,s.id limit 50 offset off)x),'[]'));
 elsif p_view='attendance' then
  if not exists(select 1 from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id where l.tenant_id=t and l.id=lid and (zoom_core.allowed(t,'attendance.review') or private_app.training_is_instructor_v1(t,s.course_run_id))) then raise exception 'zoom_forbidden';end if;
  return result||jsonb_build_object('roster',coalesce((select jsonb_agg(to_jsonb(x)) from(select r.enrollment_id,s.full_name,(select jsonb_build_object('status',a.status,'override',a.metadata->'zoom'->'override','reason',a.notes) from academy.attendance_records a where a.tenant_id=t and a.enrollment_id=r.enrollment_id and a.session_id=(select session_id from zoom_core.links where tenant_id=t and id=lid)) approved,zoom_core.attendance(t,lid,r.enrollment_id) evidence from zoom_core.roster r join academy.enrollments e on e.tenant_id=r.tenant_id and e.id=r.enrollment_id join academy.students s on s.tenant_id=e.tenant_id and s.id=e.student_id where r.tenant_id=t and r.link_id=lid order by s.full_name,r.enrollment_id limit 50 offset off)x),'[]'),
   'unmatched',coalesce((select jsonb_agg(to_jsonb(x)) from(select v.id,v.display_name,v.joined_at,v.left_at,v.quality from zoom_core.intervals v join zoom_core.instances i on i.tenant_id=v.tenant_id and i.id=v.instance_id where v.tenant_id=t and i.link_id=lid and v.quality in ('unmatched','ambiguous','incomplete') order by v.joined_at,v.id limit 50 offset off)x),'[]'));
 elsif p_view='recordings' then
  return result||jsonb_build_object('recordings',coalesce((select jsonb_agg(to_jsonb(x)) from(select r.id,r.file_type,r.recording_type,r.size_bytes,r.state,r.expires_at,r.transcript_revision,s.title,s.id session_id,l.id link_id from zoom_core.recordings r join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id join zoom_core.links l on l.tenant_id=i.tenant_id and l.id=i.link_id join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id
   where r.tenant_id=t and (lid is null or l.id=lid) and (zoom_core.allowed(t,'recordings.publish') or private_app.training_is_instructor_v1(t,s.course_run_id) or (r.state='published' and r.expires_at>now() and exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_run_id=s.course_run_id and private_app.training_is_learner_v1(t,e.id)))) order by r.updated_at desc,r.id limit 50 offset off)x),'[]'));
 elsif p_view='reports' then
  if not manager and not zoom_core.allowed(t,'reports.export') then raise exception 'zoom_forbidden';end if;
  return result||jsonb_build_object('period',jsonb_build_object('from',start_at,'to',end_at),'summary',(select jsonb_build_object('scheduled',count(*),'ended',count(*)filter(where l.state='ended'),'cancelled',count(*)filter(where l.state='cancelled'),'exceptions',count(*)filter(where l.state in ('uncertain','drift','failed')),'evidenceComplete',count(*)filter(where exists(select 1 from zoom_core.instances i where i.tenant_id=t and i.link_id=l.id) and not exists(select 1 from zoom_core.instances i where i.tenant_id=t and i.link_id=l.id and i.evidence_state<>'complete'))) from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id where l.tenant_id=t and s.starts_at>=start_at and s.starts_at<end_at),
   'cost',null,'watchSeconds',null,'rows',coalesce((select jsonb_agg(to_jsonb(x)) from(select s.title,s.starts_at,l.state,l.reason,h.name host_name,c.label account_name,(select count(*) from zoom_core.roster r where r.tenant_id=t and r.link_id=l.id) expected_learners from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id join zoom_core.hosts h on h.tenant_id=l.tenant_id and h.id=l.host_id join zoom_core.connections c on c.tenant_id=l.tenant_id and c.id=l.connection_id where l.tenant_id=t and s.starts_at>=start_at and s.starts_at<end_at and (q='' or s.title ilike '%'||q||'%') order by s.starts_at,l.id limit 50 offset off)x),'[]'));
 else raise exception 'zoom_invalid_view';end if;
end $$;
create function public.v1_zoom_export(p_slug text,p_options jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);r jsonb;
begin
 if not zoom_core.allowed(t,'reports.export') then raise exception 'zoom_forbidden';end if;
 r:=public.v1_zoom_snapshot(p_slug,'reports',p_options);
 perform private_app.write_audit('zoom.export','zoom_report',null,t,jsonb_build_object('from',p_options->>'from','to',p_options->>'to','offset',p_options->>'offset'));
 return r;
end $$;
create function public.v1_zoom_settings(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;settings zoom_core.settings%rowtype;
begin
 if not zoom_core.allowed(t,'connections.manage') or not zoom_core.allowed(t,'retention.manage') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'settings',p_payload);if result is not null then return result;end if;
 select * into settings from zoom_core.settings where tenant_id=t for update;
 if settings.revision is distinct from (p_payload->>'expectedVersion')::int then raise exception 'zoom_revision_conflict';end if;
 if p_payload->>'ownerStaffId' is not null and not exists(select 1 from people.staff_profiles where tenant_id=t and id=(p_payload->>'ownerStaffId')::uuid and employment_status='active') then raise exception 'zoom_invalid_owner';end if;
 if p_payload?'retentionDays' and coalesce((p_payload->>'retentionDays')::int,0) not between 1 and 3650 then raise exception 'zoom_invalid_retention';end if;
 update zoom_core.settings set join_before_minutes=coalesce((p_payload->>'joinBeforeMinutes')::int,join_before_minutes),recording_policy=coalesce(p_payload->>'recordingPolicy',recording_policy),owner_staff_id=coalesce((p_payload->>'ownerStaffId')::uuid,owner_staff_id),
 retention_policy=case when p_payload?'retentionDays' and p_payload->>'retentionApproved'='true' then jsonb_build_object('days',(p_payload->>'retentionDays')::int,'approved',true,'approvedBy',private_app.current_subject_id(),'approvedAt',now(),'delivery','provider','revocationLimitAcknowledged',p_payload->>'providerLimitAcknowledged'='true') else retention_policy end,revision=revision+1 where tenant_id=t;
 result:=jsonb_build_object('revision',settings.revision+1);update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.settings','zoom_settings',t::text,t,result);return result;
end $$;
create function public.v1_zoom_operational_tasks() returns jsonb language plpgsql security definer set search_path='' as $$
declare n int;
begin
 perform zoom_core.service_only();
 insert into work_core.tasks(tenant_id,task_key,title,description,priority,assigned_staff_id,due_at,metadata)
 select l.tenant_id,'zoom:exception:'||l.id,'متابعة محاضرة زووم',coalesce(l.reason,'تحتاج المحاضرة إلى مراجعة التشغيل'),'high',cfg.owner_staff_id,now()+interval '1 hour',jsonb_build_object('source','zoom_exception','linkId',l.id)
 from zoom_core.links l join zoom_core.settings cfg on cfg.tenant_id=l.tenant_id and cfg.enabled join people.staff_profiles p on p.tenant_id=l.tenant_id and p.id=cfg.owner_staff_id and p.employment_status='active'
 where l.state in ('uncertain','drift','failed') on conflict(tenant_id,task_key) do update set description=excluded.description,updated_at=now();
 get diagnostics n=row_count;
 update work_core.tasks task set status='completed',completed_at=now(),updated_at=now() where task.metadata->>'source'='zoom_exception' and task.status in ('todo','in_progress') and exists(select 1 from zoom_core.links l where l.tenant_id=task.tenant_id and l.id=(task.metadata->>'linkId')::uuid and l.state in ('ready','ended','cancelled'));
 return jsonb_build_object('exceptions',n);
end $$;
do $$declare r record;begin
 for r in select tablename from pg_tables where schemaname='zoom_core' loop execute format('alter table zoom_core.%I enable row level security',r.tablename);execute format('revoke all on zoom_core.%I from public,anon,authenticated,service_role',r.tablename);end loop;
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_recordings_store','v1_zoom_recording_action','v1_zoom_recording_access','v1_zoom_snapshot','v1_zoom_export','v1_zoom_settings','v1_zoom_operational_tasks') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_recordings_store','v1_zoom_operational_tasks') then 'service_role' else 'authenticated' end);
 end loop;
end $$;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
commit;
