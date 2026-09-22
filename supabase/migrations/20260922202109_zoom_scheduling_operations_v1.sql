begin;
create unique index if not exists zoom_sessions_tenant_id on academy.course_run_sessions(tenant_id,id);
create unique index if not exists zoom_runs_tenant_id on academy.course_runs(tenant_id,id);
create unique index if not exists zoom_enrollments_tenant_id on academy.enrollments(tenant_id,id);
create table zoom_core.links (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),session_id uuid not null,
 connection_id uuid,host_id uuid,instructor_subject_id uuid references access_control.subjects(id),
 kind text not null default 'meeting' check(kind in ('meeting','webinar')),revision integer not null default 0,
 desired jsonb not null default '{}',observed jsonb not null default '{}',
 meeting_id text,occurrence_id text not null default '',secret_id uuid,
 state text not null default 'unassigned' check(state in ('unassigned','queued','ready','live','ended','updating','cancelling','cancelled','uncertain','failed','drift','imported')),
 management text not null default 'managed' check(management in ('managed','read_only')),
 reason text,last_synced_at timestamptz,created_at timestamptz not null default now(),
 foreign key(tenant_id,session_id) references academy.course_run_sessions(tenant_id,id),
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),
 foreign key(tenant_id,host_id) references zoom_core.hosts(tenant_id,id),
 unique(tenant_id,id),unique(tenant_id,session_id),unique(connection_id,meeting_id,occurrence_id)
);
create index zoom_links_tenant_state on zoom_core.links(tenant_id,state,last_synced_at);
create table zoom_core.reservations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,link_id uuid not null,host_id uuid not null,
 instructor_subject_id uuid not null references access_control.subjects(id),slot integer not null check(slot>0),
 occupied_range tstzrange not null,revision integer not null,state text not null default 'held' check(state in ('held','confirmed','released')),
 foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),foreign key(tenant_id,host_id) references zoom_core.hosts(tenant_id,id),
 check(not isempty(occupied_range) and lower(occupied_range) is not null and upper(occupied_range) is not null),unique(tenant_id,link_id,revision)
);
create index zoom_reservations_host on zoom_core.reservations(tenant_id,host_id,slot,state);
create index zoom_reservations_teacher on zoom_core.reservations(tenant_id,instructor_subject_id,state);
create index zoom_reservations_window on zoom_core.reservations using gist(occupied_range);
create table zoom_core.busy_windows (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,host_id uuid not null,external_key text not null,
 occupied_range tstzrange not null,source text not null check(source in ('provider','unavailable')),observed_at timestamptz not null default now(),
 foreign key(tenant_id,host_id) references zoom_core.hosts(tenant_id,id),unique(tenant_id,host_id,external_key)
);
create index zoom_busy_host on zoom_core.busy_windows(tenant_id,host_id);
-- The existing message queue remains authoritative for communication. This
-- provider outbox has a distinct uncertain outcome/fencing lifecycle.
create table zoom_core.operations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,connection_id uuid not null,link_id uuid,
 revision integer,kind text not null check(kind in ('create','update','cancel','import','reconcile','hosts','register','revoke_registrant','poll','ai','purge')),
 command_id uuid,payload jsonb not null default '{}',state text not null default 'pending'
 check(state in ('pending','processing','complete','retry','uncertain','blocked','dead','cancelled')),
 due_at timestamptz not null default now(),attempts integer not null default 0,fence integer not null default 0,
 lease_id uuid,lease_until timestamptz,last_error text,result jsonb,created_at timestamptz not null default now(),
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),
 unique(tenant_id,command_id,kind),unique(tenant_id,id)
);
create index zoom_operations_due on zoom_core.operations(state,due_at,tenant_id,connection_id);
create index zoom_operations_link on zoom_core.operations(tenant_id,link_id,revision);
create table zoom_core.account_budgets (
 tenant_id uuid not null,connection_id uuid not null,next_call_at timestamptz not null default now(),
 primary key(tenant_id,connection_id),foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id)
);
create function zoom_core.reservation_guard() returns trigger language plpgsql set search_path='' as $$
declare max_slots integer;
begin
 if new.state='released' then return new;end if;
 -- One short tenant scheduling lock serializes host + human + session choices;
 -- there is no network call in this transaction. Different tenants never share it.
 perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text||':zoom-schedule',0));
 select concurrency_limit into max_slots from zoom_core.hosts where tenant_id=new.tenant_id and id=new.host_id;
 if new.slot>max_slots then raise exception 'zoom_capacity_conflict';end if;
 if exists(select 1 from zoom_core.reservations r where r.tenant_id=new.tenant_id and r.state<>'released' and r.id<>new.id and r.link_id<>new.link_id
  and r.occupied_range && new.occupied_range and ((r.host_id=new.host_id and r.slot=new.slot) or r.instructor_subject_id=new.instructor_subject_id)) then raise exception 'zoom_schedule_conflict';end if;
 return new;
end $$;
create trigger zoom_reservation_guard before insert or update on zoom_core.reservations for each row execute function zoom_core.reservation_guard();
create function zoom_core.candidates(t uuid,sid uuid,teacher uuid,starts timestamptz,ends timestamptz,attendees integer,kind_key text,requirements jsonb,exclude_link uuid default null) returns table(host_id uuid,connection_id uuid,slot integer,occupied_range tstzrange,reason text) language sql stable security definer set search_path='' as $$
 with eligible as (
 select h.*,c.sync_coverage,tstzrange(starts-make_interval(mins=>h.before_minutes),ends+make_interval(mins=>h.after_minutes),'[)') w,
  (select coalesce(sum(extract(epoch from upper(r.occupied_range)-lower(r.occupied_range))),0)/h.concurrency_limit from zoom_core.reservations r where r.tenant_id=t and r.host_id=h.id and r.state<>'released' and r.occupied_range && tstzrange(starts-interval '30 days',ends+interval '30 days','[)')) utilization
 from zoom_core.hosts h join zoom_core.connections c on c.tenant_id=h.tenant_id and c.id=h.connection_id
 where h.tenant_id=t and h.allowed and h.provider_active and h.licensed and h.verified_at>now()-interval '24 hours'
 and zoom_core.active_instructor(t,teacher) and c.status='connected' and c.vault_secret_id is not null and h.capacity>=attendees and attendees>0
 and h.capabilities->>kind_key='true' and (requirements->>'recording'<>'cloud' or h.capabilities->>'cloud_recording'='true' or not requirements?'recording')
 and (kind_key<>'webinar' or coalesce((h.capabilities->>'webinar_capacity')::int,0)>=attendees)
 and exists(select 1 from zoom_core.host_instructors hi where hi.tenant_id=t and hi.host_id=h.id and hi.subject_id=teacher and hi.active and hi.verified_at>now()-interval '24 hours')
 and exists(select 1 from academy.course_run_sessions s join academy.training_run_instructors i on i.tenant_id=s.tenant_id and i.run_id=s.course_run_id and i.active join access_control.subjects a on a.id=i.subject_id and a.status='active' where s.tenant_id=t and s.id=sid and i.subject_id=teacher)
 ), available as (
 select e.*,n slot_number from eligible e cross join lateral generate_series(1,e.concurrency_limit)n
 where not exists(select 1 from zoom_core.reservations r where r.tenant_id=t and r.state<>'released' and r.link_id is distinct from exclude_link and r.occupied_range&&e.w and ((r.host_id=e.id and r.slot=n)or r.instructor_subject_id=teacher))
 and not exists(select 1 from zoom_core.busy_windows b where b.tenant_id=t and b.host_id=e.id and b.occupied_range&&e.w)
 ) select a.id,a.connection_id,a.slot_number,a.w,
 case when a.instructor_subject_id=teacher then 'instructor_host' else 'least_utilized_eligible_host' end
 from available a order by (a.instructor_subject_id=teacher) desc nulls last,a.preference desc,a.utilization,a.last_assigned_at nulls first,a.id,a.slot_number
$$;
create function public.v1_zoom_assignment_preview(p_slug text,p_session_id uuid,p_payload jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);s academy.course_run_sessions%rowtype;l zoom_core.links%rowtype;
begin
 if not zoom_core.allowed(t,'sessions.manage') then raise exception 'zoom_forbidden';end if;
 select * into s from academy.course_run_sessions where tenant_id=t and id=p_session_id;
 if s.id is null then raise exception 'zoom_not_found';end if;
 select * into l from zoom_core.links where tenant_id=t and session_id=s.id;
 return jsonb_build_object('revision',coalesce(l.revision,0),'candidates',coalesce((select jsonb_agg(to_jsonb(x)) from(select * from zoom_core.candidates(t,s.id,(p_payload->>'instructorId')::uuid,coalesce((p_payload->>'startsAt')::timestamptz,s.starts_at),coalesce((p_payload->>'endsAt')::timestamptz,s.ends_at),coalesce((p_payload->>'attendees')::int,1),coalesce(p_payload->>'kind','meeting'),p_payload,l.id) limit 50)x),'[]'));
end $$;
create function public.v1_zoom_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;s academy.course_run_sessions%rowtype;l zoom_core.links%rowtype;h zoom_core.hosts%rowtype;
 candidate record;starts timestamptz;ends timestamptz;teacher uuid;operation_key text;rev integer;rec_policy text;connection_key uuid;entity uuid;
begin
 operation_key:=case when p_action in ('disconnect','pause','resume') then 'connections.manage' when p_action in ('configure_host','unavailable') then 'hosts.manage' else 'sessions.manage' end;
 if not zoom_core.allowed(t,operation_key) then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,p_action,p_payload);if result is not null then return result;end if;
 if p_action in ('disconnect','pause','resume') then
  update zoom_core.connections set status=case p_action when 'disconnect' then 'disconnected' when 'pause' then 'paused' else 'connected' end,generation=generation+case when p_action='disconnect' then 1 else 0 end,refresh_lease=case when p_action='disconnect' then null else refresh_lease end,refresh_until=case when p_action='disconnect' then null else refresh_until end
   where tenant_id=t and id=(p_payload->>'connectionId')::uuid and generation=(p_payload->>'expectedVersion')::int and status in ('connected','paused') returning id into entity;
  if entity is null then raise exception 'zoom_revision_conflict';end if;
  if p_action='disconnect' then
   delete from vault.secrets where id=(select vault_secret_id from zoom_core.connections where id=entity);
   update zoom_core.connections set vault_secret_id=null where id=entity;
   update zoom_core.operations set state='blocked',last_error='zoom_disconnected' where connection_id=entity and state in ('pending','retry');
  end if;
  result:=jsonb_build_object('id',entity,'status',p_action);
 elsif p_action='configure_host' then
  select * into h from zoom_core.hosts where tenant_id=t and id=(p_payload->>'hostId')::uuid for update;
  if h.id is null or h.revision is distinct from (p_payload->>'expectedVersion')::int then raise exception 'zoom_revision_conflict';end if;
  if p_payload->>'instructorId' is not null and not zoom_core.active_instructor(t,(p_payload->>'instructorId')::uuid) then raise exception 'zoom_invalid_instructor';end if;
  update zoom_core.hosts set allowed=coalesce((p_payload->>'allowed')::boolean,allowed),instructor_subject_id=(p_payload->>'instructorId')::uuid,
   preference=coalesce((p_payload->>'preference')::int,preference),before_minutes=coalesce((p_payload->>'beforeMinutes')::int,before_minutes),after_minutes=coalesce((p_payload->>'afterMinutes')::int,after_minutes),
   concurrency_limit=coalesce((p_payload->>'concurrency')::int,concurrency_limit),revision=revision+1 where id=h.id;
  -- Linking a teacher is not evidence of permission to start. Provider identity
  -- verification creates host_instructors separately via service continuation.
  result:=jsonb_build_object('id',h.id,'revision',h.revision+1);
 elsif p_action='unavailable' then
  select * into h from zoom_core.hosts where tenant_id=t and id=(p_payload->>'hostId')::uuid;
  starts:=(p_payload->>'startsAt')::timestamptz;ends:=(p_payload->>'endsAt')::timestamptz;
  if h.id is null or starts is null or ends<=starts then raise exception 'zoom_invalid_request';end if;
  insert into zoom_core.busy_windows(tenant_id,host_id,external_key,occupied_range,source) values(t,h.id,p_command_id::text,tstzrange(starts,ends,'[)'),'unavailable');
  result:=jsonb_build_object('status','saved');
 elsif p_action in ('assign','update','cancel','import','reconcile') then
  perform pg_advisory_xact_lock(hashtextextended(t::text||':zoom-schedule',0));
  select * into s from academy.course_run_sessions where tenant_id=t and id=(p_payload->>'sessionId')::uuid for update;
  if s.id is null then raise exception 'zoom_not_found';end if;
  select * into l from zoom_core.links where tenant_id=t and session_id=s.id for update;
  if coalesce(l.revision,0) is distinct from (p_payload->>'expectedVersion')::int then raise exception 'zoom_revision_conflict';end if;
  if p_action in ('assign','update','import') and (s.status<>'scheduled' or s.delivery_mode not in ('online','hybrid')) then raise exception 'zoom_session_unavailable';end if;
  if l.state in ('queued','updating','cancelling','uncertain','live') then raise exception 'zoom_operation_in_progress';end if;
  if l.management='read_only' and p_action in ('update','cancel') then raise exception 'zoom_read_only_import';end if;
  if p_action in ('assign','update','import') then
   if p_action='assign' and l.meeting_id is not null then raise exception 'zoom_already_linked';end if;
   if p_action='update' and l.meeting_id is null then raise exception 'zoom_not_found';end if;
   starts:=coalesce((p_payload->>'startsAt')::timestamptz,s.starts_at);ends:=coalesce((p_payload->>'endsAt')::timestamptz,s.ends_at);
   teacher:=(p_payload->>'instructorId')::uuid;
   if starts is null or ends is null or ends<=starts or ends-starts>interval '24 hours' or starts<=now() or teacher is null then raise exception 'zoom_invalid_schedule';end if;
   if p_payload->>'kind' is not null and p_payload->>'kind' not in ('meeting','webinar') then raise exception 'zoom_invalid_kind';end if;
   select recording_policy into rec_policy from zoom_core.settings where tenant_id=t;
   if coalesce(p_payload->>'recording','off')='cloud' and rec_policy<>'cloud' then raise exception 'zoom_recording_policy_required';end if;
   select * into candidate from zoom_core.candidates(t,s.id,teacher,starts,ends,coalesce((p_payload->>'attendees')::int,1),coalesce(p_payload->>'kind','meeting'),p_payload,l.id)
   where (p_payload->>'hostId' is null or host_id=(p_payload->>'hostId')::uuid) limit 1;
   if candidate.host_id is null then raise exception 'zoom_schedule_conflict';end if;
   if p_action='update' and candidate.connection_id<>l.connection_id then raise exception 'zoom_replacement_required';end if;
   if s.delivery_mode='hybrid' and nullif(s.venue_or_link,'') is not null and exists(select 1 from academy.course_run_sessions other_s where other_s.tenant_id=t and other_s.id<>s.id and other_s.status='scheduled' and other_s.delivery_mode in ('hybrid','onsite') and other_s.venue_or_link=s.venue_or_link and tstzrange(other_s.starts_at,other_s.ends_at,'[)')&&tstzrange(starts,ends,'[)')) then raise exception 'zoom_room_conflict';end if;
   rev:=coalesce(l.revision,0)+1;
   insert into zoom_core.links(tenant_id,session_id,connection_id,host_id,instructor_subject_id,kind,revision,desired,state,reason,management)
   values(t,s.id,candidate.connection_id,candidate.host_id,teacher,coalesce(p_payload->>'kind','meeting'),rev,
    jsonb_build_object('startsAt',starts,'endsAt',ends,'title',s.title,'recording',coalesce(p_payload->>'recording','off'),'attendees',coalesce((p_payload->>'attendees')::int,1),'registration',true,'waitingRoom',true,'importMeetingId',p_payload->>'meetingId','occurrenceId',coalesce(p_payload->>'occurrenceId','')),
    case when p_action='update' then 'updating' else 'queued' end,candidate.reason,case when p_action='import' and p_payload->>'management'='read_only' then 'read_only' else 'managed' end)
   on conflict(tenant_id,session_id) do update set connection_id=excluded.connection_id,host_id=excluded.host_id,instructor_subject_id=excluded.instructor_subject_id,kind=excluded.kind,revision=excluded.revision,desired=excluded.desired,state=excluded.state,reason=excluded.reason returning * into l;
   insert into zoom_core.reservations(tenant_id,link_id,host_id,instructor_subject_id,slot,occupied_range,revision) values(t,l.id,l.host_id,teacher,candidate.slot,candidate.occupied_range,l.revision);
   update zoom_core.hosts set last_assigned_at=now() where id=l.host_id;
  else
   if l.id is null or l.meeting_id is null then raise exception 'zoom_not_found';end if;
   if p_action='cancel' and coalesce(length(trim(p_payload->>'reason')),0)<3 then raise exception 'zoom_reason_required';end if;
   update zoom_core.links set revision=revision+1,state=case when p_action='cancel' then 'cancelling' else state end where id=l.id returning * into l;
  end if;
  operation_key:=case p_action when 'assign' then 'create' else p_action end;
  insert into zoom_core.operations(tenant_id,connection_id,link_id,revision,kind,command_id,payload) values(t,l.connection_id,l.id,l.revision,operation_key,p_command_id,jsonb_build_object('reason',left(p_payload->>'reason',500)));
  result:=jsonb_build_object('id',l.id,'revision',l.revision,'state',l.state,'reason',l.reason);
 else raise exception 'zoom_invalid_action';end if;
 update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.'||p_action,'zoom_command',p_command_id::text,t,jsonb_build_object('result',result));
 return result;
end $$;
create function public.v1_zoom_claim(p_lease_id uuid,p_limit integer default 10) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform zoom_core.service_only();if p_lease_id is null or p_limit not between 1 and 50 then raise exception 'zoom_invalid_request';end if;
 -- Expired mutating work may have succeeded externally. Retain reservations.
 update zoom_core.operations set state=case when kind in ('create','update','cancel','register','poll') then 'uncertain' else 'retry' end,last_error='worker_lease_expired',lease_id=null,lease_until=null where state='processing' and lease_until<=now();
 update zoom_core.links l set state='uncertain' where exists(select 1 from zoom_core.operations o where o.tenant_id=l.tenant_id and o.link_id=l.id and o.revision=l.revision and o.state='uncertain');
 with ranked as (
 select o.id,row_number() over(partition by o.tenant_id order by o.due_at,o.id) tenant_rank from zoom_core.operations o join zoom_core.connections c on c.tenant_id=o.tenant_id and c.id=o.connection_id join zoom_core.settings s on s.tenant_id=o.tenant_id
 left join zoom_core.account_budgets b on b.tenant_id=o.tenant_id and b.connection_id=o.connection_id
 where o.state in ('pending','retry') and o.due_at<=now() and o.attempts<8 and s.enabled and (c.status='connected' or (c.status='paused' and o.kind not in ('create','import')))
 and private_app.tenant_addon_enabled(o.tenant_id,'addon.integration.zoom') and coalesce(b.next_call_at,now())<=now()
 ), picked as (
 select o.id from zoom_core.operations o join ranked r on r.id=o.id order by r.tenant_rank,o.due_at,o.id limit p_limit for update of o skip locked
 ), claimed as (
 update zoom_core.operations o set state='processing',attempts=attempts+1,fence=fence+1,lease_id=p_lease_id,lease_until=now()+interval '90 seconds' where o.id in(select id from picked) returning o.*
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
 return result;
end $$;
create function public.v1_zoom_operation_context(p_operation_id uuid,p_lease_id uuid,p_fence integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare o zoom_core.operations%rowtype;l zoom_core.links%rowtype;h zoom_core.hosts%rowtype;c zoom_core.connections%rowtype;s academy.course_run_sessions%rowtype;actor access_control.subjects%rowtype;
begin
 perform zoom_core.service_only();
 select * into o from zoom_core.operations where id=p_operation_id and lease_id=p_lease_id and fence=p_fence and state='processing' and lease_until>now();
 if o.id is null then raise exception 'zoom_stale_lease';end if;
 select * into l from zoom_core.links where tenant_id=o.tenant_id and id=o.link_id;
 select * into c from zoom_core.connections where tenant_id=o.tenant_id and id=o.connection_id;
 select * into h from zoom_core.hosts where tenant_id=o.tenant_id and id=l.host_id and connection_id=o.connection_id;
 select * into s from academy.course_run_sessions where tenant_id=o.tenant_id and id=l.session_id;
 if l.id is null or h.id is null or s.id is null or l.revision<>o.revision or c.status not in ('connected','paused') or (c.status='paused' and o.kind in ('create','import')) or not exists(select 1 from zoom_core.settings where tenant_id=o.tenant_id and enabled) or not private_app.tenant_addon_enabled(o.tenant_id,'addon.integration.zoom') then raise exception 'zoom_stale_operation';end if;
 if o.kind in ('create','update','cancel','import') then
  select a.* into actor from zoom_core.commands cmd join access_control.subjects a on a.id=cmd.actor_subject_id where cmd.tenant_id=o.tenant_id and cmd.id=o.command_id;
  if actor.id is null then raise exception 'zoom_forbidden';end if;
  perform zoom_core.assert_actor(o.tenant_id,actor.auth_user_id,actor.id,'sessions.manage');
 end if;
 if o.kind in ('create','update','import') and (not h.allowed or not h.provider_active or not h.licensed or h.verified_at<=now()-interval '24 hours' or not zoom_core.active_instructor(o.tenant_id,l.instructor_subject_id) or not exists(select 1 from academy.training_run_instructors where tenant_id=o.tenant_id and run_id=s.course_run_id and subject_id=l.instructor_subject_id and active)) then raise exception 'zoom_host_identity_unverified';end if;
 return jsonb_build_object('operation',to_jsonb(o),'link',to_jsonb(l)-'secret_id','host',jsonb_build_object('id',h.id,'userId',h.user_id,'accountId',h.account_id),'session',jsonb_build_object('id',s.id,'title',s.title,'startsAt',s.starts_at,'endsAt',s.ends_at),'connectionGeneration',c.generation);
end $$;
create function public.v1_zoom_operation_complete(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_outcome text,p_result jsonb default '{}',p_retry_seconds integer default 60,p_generation integer default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare o zoom_core.operations%rowtype;l zoom_core.links%rowtype;secret uuid;stable_path text;state_key text;
begin
 perform zoom_core.service_only();
 select * into o from zoom_core.operations where id=p_operation_id for update;
 if o.id is null or o.state<>'processing' or o.lease_id is distinct from p_lease_id or o.fence<>p_fence or o.lease_until<=now() then raise exception 'zoom_stale_lease';end if;
 select * into l from zoom_core.links where tenant_id=o.tenant_id and id=o.link_id for update;
 if l.id is null or l.revision is distinct from o.revision then raise exception 'zoom_stale_operation';end if;
 if not exists(select 1 from zoom_core.connections c where c.tenant_id=o.tenant_id and c.id=o.connection_id and c.status in ('connected','paused') and (p_generation is null or c.generation=p_generation)) then raise exception 'zoom_stale_operation';end if;
 if p_outcome not in ('complete','retry','uncertain','blocked','dead') then raise exception 'zoom_invalid_outcome';end if;
 if p_outcome='complete' and o.kind in ('create','update','import') then
  if nullif(p_result->>'id','') is null or nullif(p_result->>'host_id','') is null or not exists(select 1 from zoom_core.hosts h where h.tenant_id=o.tenant_id and h.id=l.host_id and h.connection_id=o.connection_id and h.user_id=p_result->>'host_id') then raise exception 'zoom_invalid_provider_response';end if;
  if coalesce(p_result->>'join_url','') !~ '^https://([a-zA-Z0-9-]+\.)*zoom\.us/' then raise exception 'zoom_invalid_provider_response';end if;
  -- Never store start_url. It is fetched only after a fresh instructor check.
  if l.secret_id is null then select vault.create_secret(jsonb_build_object('join_url',p_result->>'join_url')::text,'zoom-link:'||l.id,'ODEIR Zoom attendee route',null) into secret;
  else secret:=l.secret_id;perform vault.update_secret(secret,jsonb_build_object('join_url',p_result->>'join_url')::text,null,null);end if;
  update zoom_core.links set meeting_id=p_result->>'id',occurrence_id=coalesce(p_result->>'occurrence_id',''),secret_id=secret,state=case when management='read_only' then 'imported' else 'ready' end,last_synced_at=now(),observed=jsonb_build_object('startsAt',p_result->>'start_time','duration',p_result->'duration','hostId',p_result->>'host_id','registration',p_result->'settings'->'approval_type') where id=l.id;
  update zoom_core.reservations set state=case when revision=l.revision then 'confirmed' else 'released' end where tenant_id=l.tenant_id and link_id=l.id and state<>'released';
  select '/training/'||slug||'/sessions/'||l.session_id into stable_path from core.tenants where id=l.tenant_id;
  update academy.course_run_sessions set starts_at=(l.desired->>'startsAt')::timestamptz,ends_at=(l.desired->>'endsAt')::timestamptz,meeting_join_url=stable_path,updated_at=now() where tenant_id=l.tenant_id and id=l.session_id;
 elsif p_outcome='complete' and o.kind='cancel' then
  update zoom_core.links set state='cancelled',last_synced_at=now() where id=l.id;
  update zoom_core.reservations set state='released' where tenant_id=l.tenant_id and link_id=l.id;
  update academy.course_run_sessions set status='cancelled' where tenant_id=l.tenant_id and id=l.session_id;
 elsif p_outcome<>'complete' then
  state_key:=case p_outcome when 'uncertain' then 'uncertain' when 'retry' then l.state else 'failed' end;
  update zoom_core.links set state=state_key,reason=left(p_result->>'code',100) where id=l.id;
 end if;
 if o.kind in ('update','cancel') and p_outcome='complete' then
  update academy.training_automation_jobs set status='cancelled',last_error='zoom_schedule_changed' where tenant_id=l.tenant_id and session_id=l.session_id and status in ('pending','waiting_configuration','failed') and channel in ('whatsapp','email') and metadata->>'zoomRevision' is distinct from l.revision::text;
 end if;
 update zoom_core.operations set state=case when p_outcome='retry' and attempts>=8 then 'dead' else p_outcome end,
 last_error=left(p_result->>'code',100),result=jsonb_build_object('id',p_result->>'id','outcome',p_outcome),due_at=now()+make_interval(secs=>greatest(1,least(p_retry_seconds,86400))),lease_id=null,lease_until=null where id=o.id;
 if p_result->>'code'='zoom_rate_limited' then insert into zoom_core.account_budgets(tenant_id,connection_id,next_call_at) values(o.tenant_id,o.connection_id,now()+make_interval(secs=>greatest(1,least(p_retry_seconds,86400)))) on conflict(tenant_id,connection_id) do update set next_call_at=greatest(zoom_core.account_budgets.next_call_at,excluded.next_call_at);end if;
 perform private_app.write_audit('zoom.provider.'||p_outcome,'zoom_operation',o.id::text,o.tenant_id,jsonb_build_object('kind',o.kind,'revision',o.revision));
 return jsonb_build_object('state',p_outcome);
end $$;
-- Deny legacy edits of a managed session while a provider transition is pending;
-- surface drift after other schedule edits without changing provider state silently.
create function zoom_core.session_guard() returns trigger language plpgsql set search_path='' as $$
declare l zoom_core.links%rowtype;
begin
 select * into l from zoom_core.links where tenant_id=new.tenant_id and session_id=new.id;
 if l.id is null then return new;end if;
 if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.status is distinct from old.status then
  if l.state in ('queued','updating','cancelling','uncertain','live') then raise exception 'zoom_operation_in_progress';end if;
  if l.state<>'cancelled' and (new.starts_at is distinct from (l.desired->>'startsAt')::timestamptz or new.ends_at is distinct from (l.desired->>'endsAt')::timestamptz or new.status='cancelled') then update zoom_core.links set state='drift',reason='local_schedule_changed',revision=revision+1 where id=l.id;end if;
 end if;return new;
end $$;
create trigger zoom_session_guard before update on academy.course_run_sessions for each row execute function zoom_core.session_guard();
do $$declare r record;begin
 for r in select tablename from pg_tables where schemaname='zoom_core' loop execute format('alter table zoom_core.%I enable row level security',r.tablename);execute format('revoke all on zoom_core.%I from public,anon,authenticated,service_role',r.tablename);end loop;
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_action','v1_zoom_assignment_preview','v1_zoom_claim','v1_zoom_operation_context','v1_zoom_operation_complete') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);
  execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_action','v1_zoom_assignment_preview') then 'authenticated' else 'service_role' end);
 end loop;
end $$;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
commit;
