begin;
create table zoom_core.instances (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,connection_id uuid not null,link_id uuid not null,uuid text not null,
 started_at timestamptz,ended_at timestamptz,evidence_state text not null default 'preliminary' check(evidence_state in ('preliminary','complete','incomplete')),
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),
 unique(connection_id,uuid),unique(tenant_id,id)
);
create index zoom_instances_link on zoom_core.instances(tenant_id,link_id,started_at);
create table zoom_core.events (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,connection_id uuid not null,dedupe text not null,event_type text not null,
 source_at timestamptz not null,received_at timestamptz not null default now(),payload jsonb not null,state text not null default 'pending' check(state in ('pending','processed','review')),
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),unique(connection_id,dedupe)
);
create index zoom_events_pending on zoom_core.events(state,received_at,tenant_id);
create table zoom_core.registrations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,link_id uuid not null,enrollment_id uuid not null,student_id uuid not null,
 registrant_id text,verified_email text,verified_zoom_user_id text,secret_id uuid,
 state text not null default 'new' check(state in ('new','registering','registered','uncertain','revoked')),
 lease uuid,lease_until timestamptz,created_at timestamptz not null default now(),
 foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id),
 foreign key(tenant_id,student_id) references academy.students(tenant_id,id),unique(tenant_id,link_id,enrollment_id),unique(link_id,registrant_id),unique(tenant_id,id)
);
create table zoom_core.access_grants (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,link_id uuid not null,revision integer not null,
 auth_user_id uuid not null references auth.users(id),subject_id uuid not null references access_control.subjects(id),
 enrollment_id uuid,action text not null check(action in ('join','start','recording','sdk')),expires_at timestamptz not null default now()+interval '45 seconds',
 foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id)
);
create index zoom_grant_expiry on zoom_core.access_grants(expires_at);
create table zoom_core.roster (
 tenant_id uuid not null,link_id uuid not null,enrollment_id uuid not null,captured_at timestamptz not null default now(),source text not null,
 foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id),primary key(tenant_id,link_id,enrollment_id)
);
create table zoom_core.intervals (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,instance_id uuid not null,enrollment_id uuid,
 participant_key text not null,registrant_id text,verified_email text,display_name text,joined_at timestamptz,left_at timestamptz,
 source text not null check(source in ('webhook','report')),source_key text not null,
 quality text not null default 'unmatched' check(quality in ('matched','unmatched','ambiguous','incomplete','manual')),
 kind text not null default 'meeting' check(kind in ('meeting','waiting_room')),reviewed_by uuid references access_control.subjects(id),review_reason text,
 foreign key(tenant_id,instance_id) references zoom_core.instances(tenant_id,id),foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id),
 unique(instance_id,source,source_key),check(left_at is null or joined_at is null or left_at>=joined_at)
);
create index zoom_intervals_enrollment on zoom_core.intervals(tenant_id,enrollment_id,instance_id);
create table zoom_core.teaching_windows (
 tenant_id uuid not null,link_id uuid not null,approved_range tstzrange not null,breaks tstzmultirange not null default '{}'::tstzmultirange,
 policy jsonb not null,revision integer not null default 1,approved_by uuid not null references access_control.subjects(id),approved_at timestamptz not null default now(),reason text not null,
 foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),primary key(tenant_id,link_id),check(not isempty(approved_range) and lower(approved_range) is not null and upper(approved_range) is not null)
);
create function zoom_core.access_check(t uuid,lid uuid,eid uuid,operation text,check_time boolean default true) returns void language plpgsql stable security definer set search_path='' as $$
declare l zoom_core.links%rowtype;s academy.course_run_sessions%rowtype;e academy.enrollments%rowtype;financial jsonb;
begin
 select * into l from zoom_core.links where tenant_id=t and id=lid;
 select * into s from academy.course_run_sessions where tenant_id=t and id=l.session_id;
 if l.id is null or s.id is null or s.status='cancelled' or l.state in ('cancelled','drift','failed','uncertain','queued','updating','cancelling') then raise exception 'zoom_session_unavailable';end if;
 if not exists(select 1 from zoom_core.settings where tenant_id=t and enabled) or not private_app.tenant_addon_enabled(t,'addon.integration.zoom') or not exists(select 1 from zoom_core.connections where tenant_id=t and id=l.connection_id and status in ('connected','paused')) then raise exception 'zoom_not_enabled';end if;
 if operation='start' then
  if not private_app.training_is_instructor_v1(t,s.course_run_id) or l.instructor_subject_id<>private_app.current_subject_id()
   or not exists(select 1 from zoom_core.host_instructors where tenant_id=t and host_id=l.host_id and subject_id=private_app.current_subject_id() and active and verified_at>now()-interval '24 hours') then raise exception 'zoom_forbidden';end if;
 else
  select * into e from academy.enrollments where tenant_id=t and id=eid and course_run_id=s.course_run_id;
  if e.id is null or not private_app.training_is_learner_v1(t,e.id) then raise exception 'zoom_forbidden';end if;
  financial:=private_app.training_journey_financial_access_v1(e.id);
  if not coalesce((financial->>'trainingAllowed')::boolean,false) then raise exception 'zoom_not_entitled';end if;
 end if;
 if check_time and (l.state='ended' or now()<s.starts_at-make_interval(mins=>(select join_before_minutes from zoom_core.settings where tenant_id=t)) or (now()>s.ends_at+interval '15 minutes' and l.state<>'live')) then raise exception 'zoom_outside_join_window';end if;
end $$;
create function public.v1_zoom_access(p_slug text,p_session_id uuid,p_enrollment_id uuid,p_action text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;gid uuid;
begin
 if p_action not in ('join','start') then raise exception 'zoom_invalid_action';end if;
 select * into l from zoom_core.links where tenant_id=t and session_id=p_session_id;
 perform zoom_core.access_check(t,l.id,p_enrollment_id,p_action);
 insert into zoom_core.access_grants(tenant_id,link_id,revision,auth_user_id,subject_id,enrollment_id,action) values(t,l.id,l.revision,auth.uid(),private_app.current_subject_id(),case when p_action='join' then p_enrollment_id end,p_action) returning id into gid;
 return jsonb_build_object('grantId',gid);
end $$;
create function zoom_core.check_grant(gid uuid) returns zoom_core.access_grants language plpgsql security definer set search_path='' as $$
declare g zoom_core.access_grants%rowtype;l zoom_core.links%rowtype;prev_claims text:=current_setting('request.jwt.claims',true);prev_sub text:=current_setting('request.jwt.claim.sub',true);
begin
 select * into g from zoom_core.access_grants where id=gid and expires_at>now();
 select * into l from zoom_core.links where tenant_id=g.tenant_id and id=g.link_id and revision=g.revision;
 if g.id is null or l.id is null then raise exception 'zoom_access_expired';end if;
 perform set_config('request.jwt.claim.sub',g.auth_user_id::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',g.auth_user_id,'role','authenticated')::text,true);
 if private_app.current_subject_id() is distinct from g.subject_id then raise exception 'zoom_forbidden';end if;
 perform zoom_core.access_check(g.tenant_id,g.link_id,g.enrollment_id,g.action);
 perform set_config('request.jwt.claim.sub',coalesce(prev_sub,''),true);perform set_config('request.jwt.claims',coalesce(prev_claims,''),true);
 return g;
end $$;
create function public.v1_zoom_access_context(p_grant_id uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare g zoom_core.access_grants%rowtype;l zoom_core.links%rowtype;r zoom_core.registrations%rowtype;e academy.enrollments%rowtype;email_value text;name_value text;hi zoom_core.host_instructors%rowtype;url_value text;
begin
 perform zoom_core.service_only();g:=zoom_core.check_grant(p_grant_id);
 select * into l from zoom_core.links where tenant_id=g.tenant_id and id=g.link_id;
 if g.action='start' then
  select * into hi from zoom_core.host_instructors where tenant_id=g.tenant_id and host_id=l.host_id and subject_id=g.subject_id and active;
  return jsonb_build_object('action','start','connectionId',l.connection_id,'meetingId',l.meeting_id,'kind',l.kind,'providerUserId',hi.provider_user_id,'authorizationKind',hi.authorization_kind);
 end if;
 select * into e from academy.enrollments where tenant_id=g.tenant_id and id=g.enrollment_id;
 select lower(u.email),s.full_name into email_value,name_value from auth.users u join academy.students s on s.tenant_id=e.tenant_id and s.id=e.student_id where u.id=g.auth_user_id and u.email_confirmed_at is not null and lower(u.email)=lower(s.email);
 if email_value is null then raise exception 'zoom_verified_email_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(g.tenant_id::text||':zoom-registration:'||l.id||':'||e.id,0));
 insert into zoom_core.registrations(tenant_id,link_id,enrollment_id,student_id,verified_email) values(g.tenant_id,l.id,e.id,e.student_id,email_value) on conflict(tenant_id,link_id,enrollment_id) do nothing;
 select * into r from zoom_core.registrations where tenant_id=g.tenant_id and link_id=l.id and enrollment_id=e.id for update;
 if r.state='registered' then
  select decrypted_secret::jsonb->>'join_url' into url_value from vault.decrypted_secrets where id=r.secret_id;
  return jsonb_build_object('action','join','status','ready','url',url_value,'registrantId',r.registrant_id,'meetingId',l.meeting_id,'connectionId',l.connection_id);
 end if;
 if r.state='registering' and r.lease_until>now() then return jsonb_build_object('status','busy');end if;
 if r.state in ('registering','uncertain','revoked') then update zoom_core.registrations set state='uncertain' where id=r.id;return jsonb_build_object('status','uncertain');end if;
 if p_lease is null then raise exception 'zoom_invalid_lease';end if;
 update zoom_core.registrations set state='registering',lease=p_lease,lease_until=now()+interval '30 seconds' where id=r.id;
 insert into zoom_core.roster(tenant_id,link_id,enrollment_id,source) values(g.tenant_id,l.id,e.id,'eligible_join') on conflict do nothing;
 return jsonb_build_object('action','join','status','register','registrationId',r.id,'connectionId',l.connection_id,'meetingId',l.meeting_id,'occurrenceId',l.occurrence_id,'kind',l.kind,'email',email_value,'name',name_value);
end $$;
create function public.v1_zoom_registration_complete(p_grant_id uuid,p_lease uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare g zoom_core.access_grants%rowtype;r zoom_core.registrations%rowtype;secret uuid;
begin
 perform zoom_core.service_only();g:=zoom_core.check_grant(p_grant_id);
 select * into r from zoom_core.registrations where tenant_id=g.tenant_id and link_id=g.link_id and enrollment_id=g.enrollment_id for update;
 if r.id is null or r.lease is distinct from p_lease or r.state<>'registering' or r.lease_until<=now() then raise exception 'zoom_stale_lease';end if;
 if nullif(p_result->>'registrant_id','') is null or coalesce(p_result->>'join_url','') !~ '^https://([a-zA-Z0-9-]+\.)*zoom\.us/' then raise exception 'zoom_invalid_provider_response';end if;
 select vault.create_secret(jsonb_build_object('join_url',p_result->>'join_url')::text,'zoom-registrant:'||r.id,'ODEIR individual Zoom join',null) into secret;
 update zoom_core.registrations set registrant_id=p_result->>'registrant_id',secret_id=secret,state='registered',lease=null,lease_until=null where id=r.id;
 return jsonb_build_object('status','ready','url',p_result->>'join_url');
end $$;
create function public.v1_zoom_receive_event(p_environment text,p_dedupe text,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c zoom_core.connections%rowtype;eid uuid;
begin
 perform zoom_core.service_only();
 if p_environment not in ('test','production') or p_dedupe !~ '^[a-f0-9]{64}$' or octet_length(p_event::text)>262144 then raise exception 'zoom_invalid_event';end if;
 select * into c from zoom_core.connections where environment=p_environment and account_id=p_event->>'accountId';
 if c.id is null then return jsonb_build_object('status','ignored');end if;
 insert into zoom_core.events(tenant_id,connection_id,dedupe,event_type,source_at,payload) values(c.tenant_id,c.id,p_dedupe,p_event->>'event',to_timestamp((p_event->>'eventTs')::numeric/1000),p_event)
 on conflict(connection_id,dedupe) do nothing returning id into eid;
 return jsonb_build_object('status',case when eid is null then 'duplicate' else 'stored' end);
end $$;
create function public.v1_zoom_process_events(p_limit integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare ev zoom_core.events%rowtype;l zoom_core.links%rowtype;inst zoom_core.instances%rowtype;participant jsonb;known_enrollment uuid;join_time timestamptz;leave_time timestamptz;total int:=0;
begin
 perform zoom_core.service_only();if p_limit not between 1 and 100 then raise exception 'zoom_invalid_request';end if;
 for ev in select * from zoom_core.events where state='pending' order by received_at,id limit p_limit for update skip locked loop
  if ev.event_type='app_deauthorized' then
   delete from vault.secrets where id=(select vault_secret_id from zoom_core.connections where tenant_id=ev.tenant_id and id=ev.connection_id);
   update zoom_core.connections set status='deauthorized',vault_secret_id=null,generation=generation+1 where tenant_id=ev.tenant_id and id=ev.connection_id;
   update zoom_core.operations set state='blocked',last_error='zoom_deauthorized' where connection_id=ev.connection_id and state in ('pending','retry');
   update zoom_core.events set state='processed' where id=ev.id;total:=total+1;continue;
  end if;
  -- A recurring ID with multiple candidate occurrences is never guessed.
  select * into l from zoom_core.links where tenant_id=ev.tenant_id and connection_id=ev.connection_id and meeting_id=ev.payload->>'meetingId'
   and (occurrence_id='' or exists(select 1 from zoom_core.instances i where i.tenant_id=ev.tenant_id and i.link_id=zoom_core.links.id and i.uuid=ev.payload->>'uuid'));
  if l.id is null or nullif(ev.payload->>'uuid','') is null or (select count(*) from zoom_core.links x where x.tenant_id=ev.tenant_id and x.connection_id=ev.connection_id and x.meeting_id=ev.payload->>'meetingId' and (x.occurrence_id='' or exists(select 1 from zoom_core.instances i where i.tenant_id=ev.tenant_id and i.link_id=x.id and i.uuid=ev.payload->>'uuid')))<>1 then update zoom_core.events set state='review' where id=ev.id;continue;end if;
  insert into zoom_core.instances(tenant_id,connection_id,link_id,uuid) values(ev.tenant_id,ev.connection_id,l.id,ev.payload->>'uuid') on conflict(connection_id,uuid) do nothing;
  select * into inst from zoom_core.instances where tenant_id=ev.tenant_id and connection_id=ev.connection_id and uuid=ev.payload->>'uuid' for update;
  if inst.link_id<>l.id then update zoom_core.events set state='review' where id=ev.id;continue;end if;
  if ev.event_type in ('meeting.started','webinar.started') then
   update zoom_core.instances set started_at=coalesce(started_at,(ev.payload->>'startTime')::timestamptz,ev.source_at) where id=inst.id;
   if inst.ended_at is null and l.state not in ('cancelled','drift') and coalesce((ev.payload->>'startTime')::timestamptz,ev.source_at)>coalesce((select max(ended_at) from zoom_core.instances where tenant_id=ev.tenant_id and link_id=l.id and id<>inst.id),'-infinity'::timestamptz) then update zoom_core.links set state='live',last_synced_at=now() where id=l.id;end if;
   insert into zoom_core.roster(tenant_id,link_id,enrollment_id,source) select ev.tenant_id,l.id,e.id,'start_event' from academy.enrollments e join academy.course_run_sessions s on s.tenant_id=e.tenant_id and s.course_run_id=e.course_run_id where s.id=l.session_id and e.tenant_id=ev.tenant_id and e.status in ('confirmed','active','completed') and e.enrolled_at<=ev.source_at on conflict do nothing;
  elsif ev.event_type in ('meeting.ended','webinar.ended') then
   update zoom_core.instances set ended_at=coalesce((ev.payload->>'endTime')::timestamptz,ev.source_at) where id=inst.id;
   update zoom_core.links set state='ended',last_synced_at=now() where id=l.id and state not in ('cancelled','drift');
   insert into zoom_core.operations(tenant_id,connection_id,link_id,revision,kind,command_id,due_at) values(ev.tenant_id,ev.connection_id,l.id,l.revision,'reconcile',ev.id,now()+interval '3 minutes') on conflict do nothing;
  elsif ev.event_type in ('meeting.updated','meeting.deleted','webinar.updated','webinar.deleted') then
   update zoom_core.links set state='drift',reason='provider_changed',last_synced_at=now() where id=l.id;
  elsif ev.event_type like '%.participant_%' then
   participant:=ev.payload->'participant';known_enrollment:=null;
   select r.enrollment_id into known_enrollment from zoom_core.registrations r where r.tenant_id=ev.tenant_id and r.link_id=l.id and r.state='registered' and r.registrant_id=participant->>'registrantId';
   join_time:=(participant->>'joinTime')::timestamptz;leave_time:=(participant->>'leaveTime')::timestamptz;
   insert into zoom_core.intervals(tenant_id,instance_id,enrollment_id,participant_key,registrant_id,verified_email,display_name,joined_at,left_at,source,source_key,quality)
   values(ev.tenant_id,inst.id,known_enrollment,coalesce(participant->>'id',participant->>'userId',ev.dedupe),participant->>'registrantId',participant->>'email',left(participant->>'name',200),join_time,leave_time,'webhook',ev.dedupe,case when known_enrollment is null then 'unmatched' when join_time is null or leave_time is null then 'incomplete' else 'matched' end) on conflict do nothing;
  end if;
  update zoom_core.events set state='processed' where id=ev.id;total:=total+1;
 end loop;
 return jsonb_build_object('processed',total);
end $$;
create function public.v1_zoom_store_report(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_uuid text,p_participants jsonb,p_complete boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;l zoom_core.links%rowtype;i zoom_core.instances%rowtype;p jsonb;eid uuid;matches int;source_key text;
begin
 perform zoom_core.service_only();ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);
 select * into l from zoom_core.links where id=(ctx->'link'->>'id')::uuid;
 select * into i from zoom_core.instances where tenant_id=l.tenant_id and connection_id=l.connection_id and uuid=p_uuid and link_id=l.id for update;
 if i.id is null or jsonb_typeof(p_participants)<>'array' or jsonb_array_length(p_participants)>5000 then raise exception 'zoom_invalid_provider_response';end if;
 for p in select value from jsonb_array_elements(p_participants) loop
  eid:=null;matches:=0;
  select count(*),min(r.enrollment_id::text)::uuid into matches,eid from zoom_core.registrations r where r.tenant_id=l.tenant_id and r.link_id=l.id and r.state='registered' and
   ((nullif(p->>'registrant_id','') is not null and r.registrant_id=p->>'registrant_id') or
   (nullif(p->>'registrant_id','') is null and nullif(p->>'user_id','') is not null and r.verified_zoom_user_id=p->>'user_id'));
  if matches=0 and nullif(p->>'registrant_id','') is null and nullif(p->>'user_email','') is not null then select count(*),min(r.enrollment_id::text)::uuid into matches,eid from zoom_core.registrations r where r.tenant_id=l.tenant_id and r.link_id=l.id and r.state='registered' and lower(r.verified_email)=lower(p->>'user_email');end if;
  -- Conflicting provider identity and verified email require review even when
  -- the stronger identifier matches. Display names never supply identity.
  if matches=1 and exists(select 1 from zoom_core.registrations r where r.tenant_id=l.tenant_id and r.link_id=l.id and r.enrollment_id=eid and ((nullif(p->>'user_email','') is not null and lower(p->>'user_email') is distinct from lower(r.verified_email)) or (nullif(p->>'user_id','') is not null and r.verified_zoom_user_id is not null and p->>'user_id'<>r.verified_zoom_user_id))) then matches:=2;end if;
  if matches<>1 then eid:=null;end if;
  source_key:=md5(coalesce(p->>'id','')||':'||coalesce(p->>'user_id','')||':'||coalesce(p->>'join_time','')||':'||coalesce(p->>'leave_time','')||':'||coalesce(p->>'registrant_id',''));
  insert into zoom_core.intervals(tenant_id,instance_id,enrollment_id,participant_key,registrant_id,verified_email,display_name,joined_at,left_at,source,source_key,quality)
  values(l.tenant_id,i.id,eid,coalesce(p->>'id',p->>'user_id',source_key),p->>'registrant_id',p->>'user_email',left(p->>'name',200),(p->>'join_time')::timestamptz,(p->>'leave_time')::timestamptz,'report',source_key,
   case when matches>1 then 'ambiguous' when eid is null then 'unmatched' when nullif(p->>'join_time','') is null or nullif(p->>'leave_time','') is null then 'incomplete' else 'matched' end)
  on conflict(instance_id,source,source_key) do update set joined_at=excluded.joined_at,left_at=excluded.left_at,quality=case when zoom_core.intervals.quality='manual' then 'manual' else excluded.quality end,enrollment_id=case when zoom_core.intervals.quality='manual' then zoom_core.intervals.enrollment_id else excluded.enrollment_id end;
 end loop;
 update zoom_core.instances set evidence_state=case when p_complete and jsonb_array_length(p_participants)>0 and not exists(select 1 from zoom_core.intervals where instance_id=i.id and source='report' and quality='incomplete') then 'complete' else 'incomplete' end where id=i.id;
 return jsonb_build_object('state',case when p_complete then 'reconciled' else 'incomplete' end);
end $$;
create function zoom_core.attendance(t uuid,lid uuid,eid uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w zoom_core.teaching_windows%rowtype;eligible tstzmultirange;actual tstzmultirange;required_seconds numeric;attended_seconds numeric;complete boolean;first_join timestamptz;late_seconds numeric;
begin
 select * into w from zoom_core.teaching_windows where tenant_id=t and link_id=lid;
 if w.link_id is null then return jsonb_build_object('quality','policy_required','percent',null);end if;
 eligible:=tstzmultirange(w.approved_range)-w.breaks;
 select sum(extract(epoch from upper(x)-lower(x))) into required_seconds from unnest(eligible)x;
 select range_agg(tstzrange(v.joined_at,v.left_at,'[)')) into actual from zoom_core.intervals v join zoom_core.instances i on i.tenant_id=v.tenant_id and i.id=v.instance_id
 where v.tenant_id=t and i.link_id=lid and v.enrollment_id=eid and v.source='report' and v.kind='meeting' and v.quality in ('matched','manual') and v.joined_at is not null and v.left_at>v.joined_at;
 actual:=coalesce(actual,'{}'::tstzmultirange)*eligible;
 select coalesce(sum(extract(epoch from upper(x)-lower(x))),0) into attended_seconds from unnest(actual)x;
 complete:=exists(select 1 from zoom_core.instances where tenant_id=t and link_id=lid) and not exists(select 1 from zoom_core.instances where tenant_id=t and link_id=lid and evidence_state<>'complete')
  and not exists(select 1 from zoom_core.intervals v join zoom_core.instances i on i.tenant_id=v.tenant_id and i.id=v.instance_id where v.tenant_id=t and i.link_id=lid and v.source='report' and v.quality in ('unmatched','ambiguous','incomplete'));
 select min(lower(x)) into first_join from unnest(actual)x;late_seconds:=greatest(0,extract(epoch from first_join-lower(w.approved_range)));
 return jsonb_build_object('firstJoinedAt',first_join,'minutesLate',case when late_seconds>coalesce((w.policy->>'lateMinutes')::int,0)*60 then ceil(late_seconds/60) else 0 end,'attendedSeconds',attended_seconds,'requiredSeconds',required_seconds,'percent',case when required_seconds>0 then least(100,attended_seconds*100/required_seconds) end,'quality',case when complete and required_seconds>0 then 'complete' else 'incomplete' end,'policyRevision',w.revision);
end $$;
create function public.v1_zoom_review(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;e academy.enrollments%rowtype;s academy.course_run_sessions%rowtype;result jsonb;summary jsonb;range_value tstzrange;break_values tstzmultirange;state_key text;record_id uuid;reason text:=trim(p_payload->>'reason');
begin
 if not zoom_core.allowed(t,'attendance.review') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,p_action,p_payload);if result is not null then return result;end if;
 select * into l from zoom_core.links where tenant_id=t and id=(p_payload->>'linkId')::uuid for update;
 select * into s from academy.course_run_sessions where tenant_id=t and id=l.session_id;
 if l.id is null or coalesce(length(reason),0)<5 then raise exception 'zoom_review_reason_required';end if;
 if p_action='teaching_window' then
  if not zoom_core.allowed(t,'sessions.manage') or l.state<>'ended' then raise exception 'zoom_forbidden';end if;
  range_value:=tstzrange((p_payload->>'startsAt')::timestamptz,(p_payload->>'endsAt')::timestamptz,'[)');
  if isempty(range_value) or lower(range_value) is null or upper(range_value) is null or coalesce((p_payload->>'lateMinutes')::int,0) not between 0 and 180 or upper(range_value)-lower(range_value)>interval '24 hours' then raise exception 'zoom_invalid_request';end if;
  select coalesce(range_agg(tstzrange((x->>0)::timestamptz,(x->>1)::timestamptz,'[)')),'{}'::tstzmultirange) into break_values from jsonb_array_elements(coalesce(p_payload->'breaks','[]'))x;
  if not(tstzmultirange(range_value)@>break_values) then raise exception 'zoom_invalid_breaks';end if;
  if not exists(select 1 from academy.course_run_rules where tenant_id=t and course_run_id=s.course_run_id) then raise exception 'zoom_policy_required';end if;
  insert into zoom_core.teaching_windows(tenant_id,link_id,approved_range,breaks,policy,approved_by,reason) values(t,l.id,range_value,break_values,jsonb_build_object('lateMinutes',coalesce((p_payload->>'lateMinutes')::int,0)),private_app.current_subject_id(),reason)
   on conflict(tenant_id,link_id) do update set approved_range=excluded.approved_range,breaks=excluded.breaks,policy=excluded.policy,approved_by=excluded.approved_by,reason=excluded.reason,revision=zoom_core.teaching_windows.revision+1;
  result:=jsonb_build_object('status','approved');
 elsif p_action='match' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid and course_run_id=s.course_run_id;
  if e.id is null then raise exception 'zoom_not_found';end if;
  update zoom_core.intervals v set enrollment_id=e.id,quality='manual',reviewed_by=private_app.current_subject_id(),review_reason=reason where v.tenant_id=t and v.id=(p_payload->>'intervalId')::uuid and exists(select 1 from zoom_core.instances i where i.tenant_id=t and i.id=v.instance_id and i.link_id=l.id) returning v.id into record_id;
  if record_id is null then raise exception 'zoom_not_found';end if;result:=jsonb_build_object('status','matched');
 elsif p_action in ('approve_attendance','override_attendance') then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid and course_run_id=s.course_run_id;
  if e.id is null or not exists(select 1 from zoom_core.roster where tenant_id=t and link_id=l.id and enrollment_id=e.id) then raise exception 'zoom_not_found';end if;
  summary:=zoom_core.attendance(t,l.id,e.id);
  if p_action='approve_attendance' and summary->>'quality'<>'complete' then raise exception 'zoom_evidence_incomplete';end if;
  select case when (summary->>'percent')::numeric>=r.min_attendance_percent then case when coalesce((summary->>'minutesLate')::int,0)>0 then 'late' else 'present' end else 'absent' end into state_key from academy.course_run_rules r where r.tenant_id=t and r.course_run_id=s.course_run_id;
  if p_action='override_attendance' then if not zoom_core.allowed(t,'attendance.override') then raise exception 'zoom_forbidden';end if;state_key:=p_payload->>'status';end if;
  if state_key is null or state_key not in ('present','late','absent','excused') then raise exception 'zoom_policy_required';end if;
  -- Existing canonical table/triggers remain the final attendance authority.
  if p_action='approve_attendance' and exists(select 1 from academy.attendance_records where tenant_id=t and enrollment_id=e.id and session_id=s.id and metadata->'zoom'->>'override'='true') then raise exception 'zoom_manual_override_preserved';end if;
  insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status,minutes_late,notes,marked_by_subject_id,metadata)
  values(t,s.course_run_id,s.id,e.id,state_key,case when state_key='late' then greatest(1,coalesce((p_payload->>'minutesLate')::int,(summary->>'minutesLate')::int,1)) else 0 end,reason,private_app.current_subject_id(),jsonb_build_object('zoom',summary||jsonb_build_object('linkId',l.id,'override',p_action='override_attendance','reason',reason,'reviewedAt',now())))
  on conflict(enrollment_id,session_id) do update set status=excluded.status,minutes_late=excluded.minutes_late,notes=excluded.notes,marked_by_subject_id=excluded.marked_by_subject_id,marked_at=now(),metadata=academy.attendance_records.metadata||excluded.metadata returning id into record_id;
  result:=jsonb_build_object('attendanceId',record_id,'status',state_key,'evidence',summary);
 else raise exception 'zoom_invalid_action';end if;
 update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.review.'||p_action,'zoom_link',l.id::text,t,jsonb_build_object('reason',reason,'result',result));return result;
end $$;
-- Guard the canonical certificate entry point including legacy callers. This
-- does not issue/revoke a certificate or redefine financial/content eligibility.
create function zoom_core.certificate_guard() returns trigger language plpgsql set search_path='' as $$
declare l zoom_core.links%rowtype;a academy.attendance_records%rowtype;summary jsonb;
begin
 if new.status<>'issued' then return new;end if;
 for l in select x.* from zoom_core.links x join academy.course_run_sessions s on s.tenant_id=x.tenant_id and s.id=x.session_id join zoom_core.roster r on r.tenant_id=x.tenant_id and r.link_id=x.id and r.enrollment_id=new.enrollment_id where x.tenant_id=new.tenant_id and s.status<>'cancelled' loop
  summary:=zoom_core.attendance(new.tenant_id,l.id,new.enrollment_id);
  select * into a from academy.attendance_records where tenant_id=new.tenant_id and session_id=l.session_id and enrollment_id=new.enrollment_id;
  if (summary->>'quality'<>'complete' and coalesce(a.metadata->'zoom'->>'override','false')<>'true') or a.metadata->'zoom'->>'policyRevision' is distinct from summary->>'policyRevision' then raise exception 'zoom_certificate_evidence_incomplete';end if;
  if (summary->>'requiredSeconds')::numeric<(select coalesce(sum(extract(epoch from upper(x)-lower(x))),0) from academy.course_run_sessions s join zoom_core.teaching_windows w on w.tenant_id=s.tenant_id and w.link_id=l.id cross join lateral unnest(tstzmultirange(tstzrange(s.starts_at,s.ends_at,'[)'))-w.breaks)x where s.tenant_id=new.tenant_id and s.id=l.session_id) and not exists(select 1 from zoom_core.teaching_windows where tenant_id=new.tenant_id and link_id=l.id and policy->>'shortfallApproved'='true') then raise exception 'zoom_teaching_hours_shortfall';end if;
 end loop;return new;
end $$;
create trigger zoom_certificate_evidence before insert or update of status on academy.certificates for each row execute function zoom_core.certificate_guard();
do $$declare r record;begin
 for r in select tablename from pg_tables where schemaname='zoom_core' loop execute format('alter table zoom_core.%I enable row level security',r.tablename);execute format('revoke all on zoom_core.%I from public,anon,authenticated,service_role',r.tablename);end loop;
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_access','v1_zoom_access_context','v1_zoom_registration_complete','v1_zoom_receive_event','v1_zoom_process_events','v1_zoom_store_report','v1_zoom_review') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_access','v1_zoom_review') then 'authenticated' else 'service_role' end);
 end loop;
end $$;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
commit;
