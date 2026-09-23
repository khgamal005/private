begin;
alter table zoom_core.host_instructors add column provider_email text;
create function public.v1_zoom_host_identity(p_slug text,p_host_id uuid,p_subject_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);h zoom_core.hosts%rowtype;email_value text;
begin
 if not zoom_core.allowed(t,'hosts.manage') then raise exception 'zoom_forbidden';end if;
 select * into h from zoom_core.hosts where tenant_id=t and id=p_host_id;
 select lower(u.email) into email_value from access_control.subjects a join auth.users u on u.id=a.auth_user_id and u.email_confirmed_at is not null
 where a.id=p_subject_id and a.status='active' and not a.must_change_password and zoom_core.active_instructor(t,a.id);
 if h.id is null or email_value is null then raise exception 'zoom_invalid_instructor';end if;
 return jsonb_build_object('connectionId',h.connection_id,'accountId',h.account_id,'hostUserId',h.user_id,'email',email_value,'subjectId',p_subject_id,'hostId',h.id);
end $$;
create function public.v1_zoom_host_identity_save(p_host_id uuid,p_subject_id uuid,p_identity jsonb,p_generation integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare h zoom_core.hosts%rowtype;c zoom_core.connections%rowtype;email_value text;
begin
 perform zoom_core.service_only();
 select * into h from zoom_core.hosts where id=p_host_id;
 select * into c from zoom_core.connections where tenant_id=h.tenant_id and id=h.connection_id;
 select lower(u.email) into email_value from access_control.subjects a join auth.users u on u.id=a.auth_user_id and u.email_confirmed_at is not null where a.id=p_subject_id and a.status='active' and not a.must_change_password and zoom_core.active_instructor(h.tenant_id,a.id);
 if h.id is null or c.generation is distinct from p_generation or c.status not in ('connected','paused') or email_value is null or lower(p_identity->>'email') is distinct from email_value or p_identity->>'account_id' is distinct from c.account_id or p_identity->>'status' is distinct from 'active' or coalesce(p_identity->>'type','') not in ('2','3') then raise exception 'zoom_host_identity_unverified';end if;
 insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,provider_email,authorization_kind,verified_at)
 values(h.tenant_id,h.id,p_subject_id,p_identity->>'id',email_value,case when p_identity->>'id'=h.user_id then 'host' else 'alternative_host' end,now())
 on conflict(tenant_id,host_id,subject_id) do update set provider_user_id=excluded.provider_user_id,provider_email=excluded.provider_email,authorization_kind=excluded.authorization_kind,verified_at=now(),active=true;
 return jsonb_build_object('status','verified');
end $$;
create function public.v1_zoom_busy_store(p_connection_id uuid,p_generation integer,p_host_id uuid,p_meetings jsonb,p_complete boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare h zoom_core.hosts%rowtype;c zoom_core.connections%rowtype;m jsonb;start_at timestamptz;end_at timestamptz;
begin
 perform zoom_core.service_only();select * into h from zoom_core.hosts where id=p_host_id and connection_id=p_connection_id;
 select * into c from zoom_core.connections where id=p_connection_id and tenant_id=h.tenant_id and generation=p_generation and status='connected';
 if c.id is null or jsonb_typeof(p_meetings)<>'array' or jsonb_array_length(p_meetings)>1000 then raise exception 'zoom_stale_operation';end if;
 if p_complete then delete from zoom_core.busy_windows where tenant_id=h.tenant_id and host_id=h.id and source='provider';end if;
 for m in select value from jsonb_array_elements(p_meetings) loop
  if exists(select 1 from zoom_core.links where tenant_id=h.tenant_id and connection_id=c.id and meeting_id=m->>'id') then continue;end if;
  start_at:=(m->>'start_time')::timestamptz;end_at:=start_at+make_interval(mins=>(m->>'duration')::integer);
  if start_at is null or end_at<=start_at then continue;end if;
  insert into zoom_core.busy_windows(tenant_id,host_id,external_key,occupied_range,source) values(h.tenant_id,h.id,m->>'id',tstzrange(start_at,end_at,'[)'),'provider') on conflict(tenant_id,host_id,external_key) do update set occupied_range=excluded.occupied_range,observed_at=now();
 end loop;
 update zoom_core.hosts set capabilities=capabilities||jsonb_build_object('externalBusyCoverage',case when p_complete then 'complete' else 'partial' end,'externalBusyCheckedAt',now()) where id=h.id;
 return jsonb_build_object('status','stored');
end $$;
create function public.v1_zoom_reconcile_context(p_operation_id uuid,p_lease_id uuid,p_fence integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;t uuid;lid uuid;
begin
 ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);t:=(ctx->'link'->>'tenant_id')::uuid;lid:=(ctx->'link'->>'id')::uuid;
 return ctx||jsonb_build_object('instances',coalesce((select jsonb_agg(jsonb_build_object('uuid',uuid,'id',id,'startedAt',started_at,'endedAt',ended_at)) from zoom_core.instances where tenant_id=t and link_id=lid),'[]'),
 'alternativeHosts',coalesce((select string_agg(provider_email,';') from zoom_core.host_instructors where tenant_id=t and host_id=(ctx->'link'->>'host_id')::uuid and subject_id=(ctx->'link'->>'instructor_subject_id')::uuid and authorization_kind='alternative_host' and active and verified_at>now()-interval '24 hours'),''));
end $$;
-- Repeated series are mapped by provider occurrence before instances are ingested.
create function public.v1_zoom_instances_store(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_instances jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;l zoom_core.links%rowtype;i jsonb;
begin
 ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);
 select * into l from zoom_core.links where id=(ctx->'link'->>'id')::uuid;
 if jsonb_typeof(p_instances)<>'array' or jsonb_array_length(p_instances)>500 then raise exception 'zoom_invalid_provider_response';end if;
 for i in select value from jsonb_array_elements(p_instances) loop
  if nullif(i->>'uuid','') is null then continue;end if;
  -- Provider past-instances lacks a reliable occurrence_id in some plans.
  -- Require an explicit verified occurrence/UUID mapping; never infer by time.
  if l.occurrence_id<>'' and not exists(select 1 from zoom_core.instances x where x.tenant_id=l.tenant_id and x.link_id=l.id and x.uuid=i->>'uuid') then continue;end if;
  if exists(select 1 from zoom_core.links x where x.tenant_id=l.tenant_id and x.connection_id=l.connection_id and x.meeting_id=l.meeting_id and x.id<>l.id) and not exists(select 1 from zoom_core.instances x where x.tenant_id=l.tenant_id and x.link_id=l.id and x.uuid=i->>'uuid') then continue;end if;
  insert into zoom_core.instances(tenant_id,connection_id,link_id,uuid,started_at) values(l.tenant_id,l.connection_id,l.id,i->>'uuid',(i->>'start_time')::timestamptz) on conflict(connection_id,uuid) do nothing;
 end loop;return jsonb_build_object('status','stored');
end $$;
create function public.v1_zoom_instance_details(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_uuid text,p_details jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;l zoom_core.links%rowtype;i zoom_core.instances%rowtype;
begin
 ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);select * into l from zoom_core.links where id=(ctx->'link'->>'id')::uuid;
 select * into i from zoom_core.instances where tenant_id=l.tenant_id and connection_id=l.connection_id and link_id=l.id and uuid=p_uuid;
 if i.id is null or p_details->>'uuid' is distinct from p_uuid or p_details->>'id' is distinct from l.meeting_id or (p_details->>'end_time')::timestamptz is null then raise exception 'zoom_invalid_provider_response';end if;
 update zoom_core.instances set started_at=(p_details->>'start_time')::timestamptz,ended_at=(p_details->>'end_time')::timestamptz where id=i.id;
 update zoom_core.links set state='ended',last_synced_at=now() where id=l.id and state not in ('cancelled','drift','uncertain');
 insert into zoom_core.roster(tenant_id,link_id,enrollment_id,source,captured_at) select l.tenant_id,l.id,e.id,'reconciled_provider_start',(p_details->>'start_time')::timestamptz from academy.enrollments e join academy.course_run_sessions s on s.tenant_id=e.tenant_id and s.course_run_id=e.course_run_id where s.tenant_id=l.tenant_id and s.id=l.session_id and e.status in ('confirmed','active','completed') and e.enrolled_at<=(p_details->>'start_time')::timestamptz on conflict do nothing;
 return jsonb_build_object('status','stored');
end $$;
-- Before delivery, regenerate current message variables and enforce entitlement.
-- No new messaging provider or recipient pool is introduced.
create function public.v1_zoom_message_check(p_job_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j academy.training_automation_jobs%rowtype;l zoom_core.links%rowtype;f jsonb;s academy.course_run_sessions%rowtype;url_value text;
begin
 perform zoom_core.service_only();select * into j from academy.training_automation_jobs where id=p_job_id;
 select * into l from zoom_core.links where tenant_id=j.tenant_id and session_id=j.session_id;
 if l.id is null then return jsonb_build_object('managed',false);end if;
 if j.channel='zoom' then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_new_engine_required');end if;
 select * into s from academy.course_run_sessions where tenant_id=j.tenant_id and id=j.session_id;
 f:=private_app.training_journey_financial_access_v1(j.enrollment_id);
 if s.status='cancelled' or l.state not in ('ready','live','imported') or not coalesce((f->>'trainingAllowed')::boolean,false) then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_message_not_eligible');end if;
 select 'https://odeir.com/training/'||slug||'/sessions/'||s.id into url_value from core.tenants where id=j.tenant_id;
 return jsonb_build_object('managed',true,'allowed',true,'url',url_value,'revision',l.revision);
end $$;
do $$declare r record;begin
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_instance_details','v1_zoom_host_identity','v1_zoom_host_identity_save','v1_zoom_busy_store','v1_zoom_reconcile_context','v1_zoom_instances_store','v1_zoom_message_check') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname='v1_zoom_host_identity' then 'authenticated' else 'service_role' end);
 end loop;
end $$;
commit;
