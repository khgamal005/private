begin;
-- Preserve the historical roster before canonical transfer/withdrawal changes.
-- It is evidence of who was expected, never a new entitlement or enrollment.
create function zoom_core.capture_previous_roster() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status in ('confirmed','active','completed') and (new.course_run_id is distinct from old.course_run_id or new.status is distinct from old.status) then
  insert into zoom_core.roster(tenant_id,link_id,enrollment_id,source)
  select old.tenant_id,l.id,old.id,'canonical_enrollment_transition' from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id
  where l.tenant_id=old.tenant_id and s.course_run_id=old.course_run_id and s.starts_at<=now() and old.enrolled_at<=s.starts_at on conflict do nothing;
 end if;return new;
end $$;
create trigger zoom_roster_before_transfer before update of course_run_id,status on academy.enrollments for each row execute function zoom_core.capture_previous_roster();

-- Per-instance marketing evidence avoids overwriting an earlier restarted instance.
create table zoom_core.webinar_intervals (
 tenant_id uuid not null,registration_id uuid not null,instance_id uuid not null,intervals tstzmultirange not null,
 primary key(tenant_id,registration_id,instance_id),foreign key(tenant_id,registration_id) references zoom_core.webinar_registrations(tenant_id,id),foreign key(tenant_id,instance_id) references zoom_core.instances(tenant_id,id)
);
create or replace function public.v1_zoom_webinar_evidence(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_uuid text,p_participants jsonb,p_complete boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;l zoom_core.links%rowtype;r zoom_core.webinar_registrations%rowtype;i zoom_core.instances%rowtype;periods tstzmultirange;seconds_value numeric;w zoom_core.webinars%rowtype;
begin
 ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);select * into l from zoom_core.links where id=(ctx->'link'->>'id')::uuid;select * into w from zoom_core.webinars where tenant_id=l.tenant_id and link_id=l.id;
 if w.link_id is null then return '{"marketing":false}';end if;
 select * into i from zoom_core.instances where tenant_id=l.tenant_id and link_id=l.id and uuid=p_uuid;
 if i.id is null or not p_complete or jsonb_typeof(p_participants)<>'array' or jsonb_array_length(p_participants)>5000 or exists(select 1 from jsonb_array_elements(p_participants)p where nullif(p->>'join_time','') is null or nullif(p->>'leave_time','') is null) then return '{"marketing":true,"status":"incomplete"}';end if;
 for r in select * from zoom_core.webinar_registrations where tenant_id=l.tenant_id and link_id=l.id and state='registered' loop
  select coalesce(range_agg(tstzrange((p->>'join_time')::timestamptz,(p->>'leave_time')::timestamptz,'[)')),'{}') into periods from jsonb_array_elements(p_participants)p where p->>'registrant_id'=r.registrant_id and (p->>'leave_time')::timestamptz>(p->>'join_time')::timestamptz;
  insert into zoom_core.webinar_intervals values(l.tenant_id,r.id,i.id,periods) on conflict(tenant_id,registration_id,instance_id) do update set intervals=excluded.intervals;
  select coalesce(range_agg(x),'{}') into periods from zoom_core.webinar_intervals v cross join lateral unnest(v.intervals)x where v.tenant_id=l.tenant_id and v.registration_id=r.id;
  select coalesce(sum(extract(epoch from upper(x)-lower(x))),0) into seconds_value from unnest(periods)x;
  update zoom_core.webinar_registrations set attended_seconds=seconds_value::int,quality='complete' where id=r.id;
  insert into sales_core.activities(tenant_id,activity_key,contact_id,activity_type,summary,metadata) values(l.tenant_id,'zoom:webinar:attendance:'||r.id,r.contact_id,'note','تحديث دليل حضور ندوة زووم',jsonb_build_object('source','zoom_webinar','linkId',l.id,'seconds',seconds_value,'complete',true,'campaignId',w.campaign_id)) on conflict(tenant_id,activity_key) do update set metadata=excluded.metadata;
 end loop;return '{"marketing":true,"status":"stored"}';
end $$;

create function public.v1_zoom_poll(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;result jsonb;q jsonb;choice jsonb;oid uuid;
begin
 if not zoom_core.allowed(t,'sessions.manage') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'poll',p_payload);if result is not null then return result;end if;
 select * into l from zoom_core.links where tenant_id=t and id=(p_payload->>'linkId')::uuid and revision=(p_payload->>'expectedVersion')::int for update;
 if l.id is null or l.state not in ('ready','imported') or l.management<>'managed' then raise exception 'zoom_revision_conflict';end if;
 if not exists(select 1 from zoom_core.hosts where tenant_id=t and id=l.host_id and licensed and capabilities->>case when l.kind='webinar' then 'webinar_polls' else 'polls' end='true') then raise exception 'zoom_scope_or_license_required';end if;
 if length(trim(coalesce(p_payload->>'title',''))) not between 1 and 64 or jsonb_typeof(p_payload->'questions') is distinct from 'array' or jsonb_array_length(p_payload->'questions') not between 1 and 10 then raise exception 'zoom_invalid_poll';end if;
 for q in select value from jsonb_array_elements(p_payload->'questions') loop
  if coalesce(q->>'type','') not in ('single','multiple') or length(trim(coalesce(q->>'name',''))) not between 1 and 255 or jsonb_typeof(q->'answers') is distinct from 'array' or jsonb_array_length(q->'answers') not between 2 and 10 then raise exception 'zoom_invalid_poll';end if;
  for choice in select value from jsonb_array_elements(q->'answers') loop if jsonb_typeof(choice)<>'string' or length(choice#>>'{}') not between 1 and 255 then raise exception 'zoom_invalid_poll';end if;end loop;
 end loop;
 if exists(select 1 from zoom_core.operations where tenant_id=t and link_id=l.id and kind='poll' and state in ('pending','processing','uncertain')) then raise exception 'zoom_operation_in_progress';end if;
 insert into zoom_core.operations(tenant_id,connection_id,link_id,revision,kind,command_id,payload) values(t,l.connection_id,l.id,l.revision,'poll',p_command_id,jsonb_build_object('title',p_payload->>'title','questions',p_payload->'questions','anonymous',false)) returning id into oid;
 result:=jsonb_build_object('operationId',oid,'state','queued');update zoom_core.commands set result=jsonb_build_object('operationId',oid,'state','queued') where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.poll_queued','zoom_link',l.id::text,t,jsonb_build_object('questions',jsonb_array_length(p_payload->'questions')));return result;
end $$;

create function public.v1_zoom_ai_snapshot(p_slug text,p_recording_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);course_key uuid;
begin
 if not zoom_core.allowed(t,'ai.generate') then raise exception 'zoom_forbidden';end if;
 perform public.v1_zoom_transcript_authorize(p_slug,p_recording_id);
 select run.course_id into course_key from zoom_core.recordings r join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id join zoom_core.links l on l.tenant_id=i.tenant_id and l.id=i.link_id join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id join academy.course_runs run on run.tenant_id=s.tenant_id and run.id=s.course_run_id where r.tenant_id=t and r.id=p_recording_id;
 return jsonb_build_object('courseId',course_key,'authoringRevision',(select revision from academy.course_authoring where tenant_id=t and course_id=course_key),'drafts',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,kind,state,content,source_revision,model,usage,created_at from zoom_core.ai_drafts where tenant_id=t and recording_id=p_recording_id order by created_at desc limit 20)x),'[]'));
end $$;

-- Revoking Odeir access also queues cancellation of the known personal provider
-- registrant. Until the provider confirms, copied-link revocation is unproven.
create function public.v1_zoom_revocations(p_limit integer default 10) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform zoom_core.service_only();if p_limit not between 1 and 20 then raise exception 'zoom_invalid_request';end if;
 return coalesce((select jsonb_agg(to_jsonb(x)) from(select r.id,l.connection_id,l.meeting_id,l.kind,r.registrant_id from zoom_core.registrations r join zoom_core.links l on l.tenant_id=r.tenant_id and l.id=r.link_id join zoom_core.connections c on c.tenant_id=l.tenant_id and c.id=l.connection_id join academy.enrollments e on e.tenant_id=r.tenant_id and e.id=r.enrollment_id join academy.students s on s.tenant_id=e.tenant_id and s.id=e.student_id where r.state='registered' and not exists(select 1 from zoom_core.account_budgets b where b.connection_id=c.id and b.next_call_at>now()) and c.status in ('connected','paused') and (l.state='cancelled' or e.status not in ('confirmed','active','completed') or lower(s.email) is distinct from r.verified_email or not exists(select 1 from academy.training_learner_accounts a where a.tenant_id=e.tenant_id and a.student_id=e.student_id and a.status='active') or not coalesce((private_app.training_journey_financial_access_v1(e.id)->>'trainingAllowed')::boolean,false)) order by r.created_at,r.id limit p_limit)x),'[]');
end $$;
create function public.v1_zoom_revocation_complete(p_registration_id uuid,p_generation integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.registrations%rowtype;l zoom_core.links%rowtype;
begin
 perform zoom_core.service_only();select * into r from zoom_core.registrations where id=p_registration_id for update;select * into l from zoom_core.links where tenant_id=r.tenant_id and id=r.link_id;
 if r.id is null or not exists(select 1 from zoom_core.connections where id=l.connection_id and tenant_id=r.tenant_id and generation=p_generation and status in ('connected','paused')) then raise exception 'zoom_stale_operation';end if;
 delete from vault.secrets where id=r.secret_id;update zoom_core.registrations set secret_id=null,state='revoked' where id=r.id;return '{"state":"revoked"}';
end $$;

-- Cleanup expands after advanced tables exist. Independent customer and finance
-- rows survive; provider-derived copies in Odeiry are redacted with usage intact.
alter function public.v1_zoom_purge(integer) rename to v1_zoom_purge_core;
create function public.v1_zoom_purge(p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;req zoom_core.purge_requests%rowtype;d zoom_core.ai_drafts%rowtype;
begin
 perform zoom_core.service_only();result:=public.v1_zoom_purge_core(p_limit);
 for req in select * from zoom_core.purge_requests where state in ('complete','policy_required') order by created_at limit p_limit loop
  for d in select x.* from zoom_core.ai_drafts x join zoom_core.recordings r on r.tenant_id=x.tenant_id and r.id=x.recording_id join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id where x.tenant_id=req.tenant_id and i.connection_id=req.connection_id loop
   update core.odeiry_runs set response_data='{}' where tenant_id=req.tenant_id and id=d.run_id;
   update core.odeiry_messages set content='[مصدر زووم أُزيل وفق سياسة حذف المزود]',content_hash=encode(extensions.digest('[مصدر زووم أُزيل وفق سياسة حذف المزود]','sha256'),'hex') where tenant_id=req.tenant_id and run_id=d.run_id and message_role='assistant';
   update zoom_core.ai_drafts set state='source_removed',content=null,source_hash='removed' where id=d.id;
   if d.applied_course_id is not null then update zoom_core.purge_requests set state='policy_required',completed_at=null where id=req.id;end if;
  end loop;
  delete from zoom_core.webinar_intervals where tenant_id=req.tenant_id and instance_id in(select id from zoom_core.instances where tenant_id=req.tenant_id and connection_id=req.connection_id);
  delete from vault.secrets where id in(select w.secret_id from zoom_core.webinar_registrations w join zoom_core.links l on l.tenant_id=w.tenant_id and l.id=w.link_id where w.tenant_id=req.tenant_id and l.connection_id=req.connection_id);
  update zoom_core.webinar_registrations set registrant_id=null,secret_id=null,state='revoked',attended_seconds=null,quality='source_removed' where tenant_id=req.tenant_id and link_id in(select id from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id);
  update sales_core.activities set metadata=jsonb_build_object('source','zoom_removed'),summary='أزيل دليل زووم وفق سياسة حذف المزود' where tenant_id=req.tenant_id and metadata->>'source'='zoom_webinar' and metadata->>'linkId' in(select id::text from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id);
 end loop;return result||jsonb_build_object('derivedContent','published_authoring_requires_review');
end $$;
create table zoom_core.resource_syncs (
 connection_id uuid primary key,tenant_id uuid not null,cursor_value text not null default '',seen_users jsonb not null default '[]',coverage text not null default 'complete',
 next_attempt_at timestamptz not null default now(),attempts integer not null default 0,last_error text,state text not null default 'pending' check(state in ('pending','processing','complete','partial','failed')),lease_id uuid,lease_until timestamptz,fence int not null default 0,
 actor_subject_id uuid not null references access_control.subjects(id),auth_user_id uuid not null references auth.users(id),updated_at timestamptz not null default now(),
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id)
);
create function public.v1_zoom_resources_request(p_slug text,p_connection_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;t uuid:=zoom_core.tenant(p_slug);
begin
 ctx:=public.v1_zoom_connection_authorize(p_slug,p_connection_id);
 insert into zoom_core.resource_syncs(tenant_id,connection_id,actor_subject_id,auth_user_id) values(t,p_connection_id,private_app.current_subject_id(),auth.uid()) on conflict(connection_id) do update set state='pending',attempts=0,next_attempt_at=now(),cursor_value='',seen_users='[]',coverage='complete',actor_subject_id=excluded.actor_subject_id,auth_user_id=excluded.auth_user_id,updated_at=now() where zoom_core.resource_syncs.state in ('complete','partial','failed');
 return '{"status":"queued"}';
end $$;
create function public.v1_zoom_resources_claim(p_lease_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.resource_syncs%rowtype;c zoom_core.connections%rowtype;
begin
 perform zoom_core.service_only();
 update zoom_core.resource_syncs set state='pending',attempts=0,cursor_value='',seen_users='[]',coverage='complete',next_attempt_at=now(),updated_at=now() where connection_id in (select connection_id from zoom_core.resource_syncs where state in ('complete','partial') and updated_at<now()-interval '6 hours' order by updated_at limit 20);

 select s.* into r from zoom_core.resource_syncs s join zoom_core.connections conn on conn.tenant_id=s.tenant_id and conn.id=s.connection_id and conn.status in ('connected','paused') join zoom_core.settings cfg on cfg.tenant_id=s.tenant_id and cfg.enabled where s.next_attempt_at<=now() and not exists(select 1 from zoom_core.account_budgets b where b.connection_id=s.connection_id and b.next_call_at>now()) and (s.state='pending' or (s.state='processing' and s.lease_until<=now())) and private_app.tenant_addon_enabled(s.tenant_id,'addon.integration.zoom') order by s.updated_at limit 1 for update of s skip locked;
 if r.connection_id is null then return null;end if;
 begin perform zoom_core.assert_actor(r.tenant_id,r.auth_user_id,r.actor_subject_id,'connections.manage');exception when others then update zoom_core.resource_syncs set state='failed' where connection_id=r.connection_id;return null;end;
 update zoom_core.resource_syncs set state='processing',lease_id=p_lease_id,lease_until=now()+interval '90 seconds',fence=fence+1,attempts=attempts+1,updated_at=now() where connection_id=r.connection_id returning * into r;
 select * into c from zoom_core.connections where id=r.connection_id;
 return jsonb_build_object('connectionId',r.connection_id,'accountId',c.account_id,'cursor',r.cursor_value,'fence',r.fence);
end $$;
create function public.v1_zoom_resources_page(p_connection_id uuid,p_lease_id uuid,p_fence int,p_generation int,p_hosts jsonb,p_next text,p_coverage text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.resource_syncs%rowtype;seen jsonb;effective_coverage text;
begin
 perform zoom_core.service_only();select * into r from zoom_core.resource_syncs where connection_id=p_connection_id for update;
 if r.connection_id is null or r.state<>'processing' or r.lease_id is distinct from p_lease_id or r.fence<>p_fence or r.lease_until<=now() or length(coalesce(p_next,''))>2048 or (p_next<>'' and p_next=r.cursor_value) then raise exception 'zoom_stale_lease';end if;
 perform zoom_core.assert_actor(r.tenant_id,r.auth_user_id,r.actor_subject_id,'connections.manage');
 perform public.v1_zoom_sync_hosts(p_connection_id,p_generation,p_hosts,'partial');
 effective_coverage:=case when r.coverage<>'complete' then r.coverage else p_coverage end;
 seen:=r.seen_users||coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(p_hosts)x),'[]');
 if jsonb_array_length(seen)>10000 then raise exception 'zoom_result_incomplete';end if;
 update zoom_core.resource_syncs set cursor_value=coalesce(p_next,''),seen_users=seen,coverage=effective_coverage,state=case when p_next<>'' then 'pending' when effective_coverage='complete' then 'complete' else 'partial' end,lease_id=null,lease_until=null,updated_at=now() where connection_id=p_connection_id;
 if coalesce(p_next,'')='' then
  if effective_coverage='complete' then update zoom_core.hosts set provider_active=false where connection_id=p_connection_id and not seen?user_id;end if;
  update zoom_core.connections set sync_coverage=effective_coverage,last_synced_at=now() where id=p_connection_id;
 end if;return jsonb_build_object('status',case when p_next<>'' then 'queued' else 'complete' end);
end $$;
create function public.v1_zoom_busy_authorize(p_slug text,p_host_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);h zoom_core.hosts%rowtype;
begin
 if not zoom_core.allowed(t,'hosts.manage') then raise exception 'zoom_forbidden';end if;
 select * into h from zoom_core.hosts where tenant_id=t and id=p_host_id;
 if h.id is null then raise exception 'zoom_not_found';end if;
 return jsonb_build_object('hostId',h.id,'connectionId',h.connection_id,'userId',h.user_id);
end $$;
alter table zoom_core.resource_syncs enable row level security;
revoke all on zoom_core.resource_syncs from public,anon,authenticated,service_role;

revoke all on function public.v1_zoom_purge_core(integer) from public,anon,authenticated,service_role;
alter table zoom_core.webinar_intervals enable row level security;
revoke all on zoom_core.webinar_intervals from public,anon,authenticated,service_role;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
do $$declare r record;begin
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_resources_request','v1_zoom_resources_claim','v1_zoom_resources_page','v1_zoom_busy_authorize','v1_zoom_poll','v1_zoom_ai_snapshot','v1_zoom_revocations','v1_zoom_revocation_complete','v1_zoom_purge') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_resources_request','v1_zoom_busy_authorize','v1_zoom_poll','v1_zoom_ai_snapshot') then 'authenticated' else 'service_role' end);end loop;
end $$;

create function public.v1_zoom_provider_defer(p_connection_id uuid,p_retry_seconds integer) returns void language plpgsql security definer set search_path='' as $$
begin
 perform zoom_core.service_only();if p_retry_seconds not between 1 and 86400 then raise exception 'zoom_invalid_request';end if;
 insert into zoom_core.account_budgets(tenant_id,connection_id,next_call_at) select tenant_id,id,now()+make_interval(secs=>p_retry_seconds) from zoom_core.connections where id=p_connection_id on conflict(tenant_id,connection_id) do update set next_call_at=greatest(zoom_core.account_budgets.next_call_at,excluded.next_call_at);
end $$;
create function public.v1_zoom_resources_fail(p_connection_id uuid,p_lease_id uuid,p_fence integer,p_code text,p_retry_seconds integer) returns void language plpgsql security definer set search_path='' as $$
begin
 perform zoom_core.service_only();if p_retry_seconds not between 1 and 86400 or p_code !~ '^zoom_[a-z_]{1,80}$' then raise exception 'zoom_invalid_request';end if;
 update zoom_core.resource_syncs set state=case when p_code in ('zoom_reauth_required','zoom_forbidden') or attempts>=12 then 'failed' else 'pending' end,lease_id=null,lease_until=null,last_error=p_code,next_attempt_at=now()+make_interval(secs=>p_retry_seconds),updated_at=now() where connection_id=p_connection_id and lease_id=p_lease_id and fence=p_fence and state='processing';
 if not found then raise exception 'zoom_stale_lease';end if;
 if p_code='zoom_rate_limited' then perform public.v1_zoom_provider_defer(p_connection_id,p_retry_seconds);end if;
end $$;
revoke all on function public.v1_zoom_provider_defer(uuid,integer),public.v1_zoom_resources_fail(uuid,uuid,integer,text,integer) from public,anon,authenticated;
grant execute on function public.v1_zoom_provider_defer(uuid,integer),public.v1_zoom_resources_fail(uuid,uuid,integer,text,integer) to service_role;


create function public.v1_zoom_bindings_due() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform zoom_core.service_only();
 return coalesce((select jsonb_agg(to_jsonb(x)) from(select hi.host_id,hi.subject_id,h.connection_id,lower(u.email) email from zoom_core.host_instructors hi join zoom_core.hosts h on h.tenant_id=hi.tenant_id and h.id=hi.host_id join zoom_core.connections c on c.tenant_id=h.tenant_id and c.id=h.connection_id and c.status in ('connected','paused') join zoom_core.settings cfg on cfg.tenant_id=h.tenant_id and cfg.enabled join access_control.subjects actor on actor.id=hi.subject_id join auth.users u on u.id=actor.auth_user_id and u.email_confirmed_at is not null where hi.active and hi.verified_at<now()-interval '6 hours' and zoom_core.active_instructor(hi.tenant_id,hi.subject_id) and private_app.tenant_addon_enabled(hi.tenant_id,'addon.integration.zoom') and not exists(select 1 from zoom_core.account_budgets b where b.connection_id=c.id and b.next_call_at>now()) order by hi.verified_at limit 3)x),'[]');
end $$;
revoke all on function public.v1_zoom_bindings_due() from public,anon,authenticated;
grant execute on function public.v1_zoom_bindings_due() to service_role;

commit;
