begin;
-- Independent meetings remain the default. A series is explicitly atomic,
-- bounded and regular in the tenant's IANA timezone, including DST changes.
create function public.v1_zoom_series(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;item record;first_session academy.course_run_sessions%rowtype;tz text;pattern text;step_days int;repeat_every int;n int:=0;total int;lid uuid;oid uuid;root_id uuid;members jsonb:='[]';recurrence jsonb;common jsonb;expected timestamptz;
begin
 if not zoom_core.allowed(t,'sessions.manage') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'series',p_payload);if result is not null then return result;end if;
 if jsonb_typeof(p_payload->'sessions') is distinct from 'array' or jsonb_array_length(p_payload->'sessions') not between 2 and 30 or nullif(p_payload->>'hostId','') is null then raise exception 'zoom_invalid_series';end if;
 total:=jsonb_array_length(p_payload->'sessions');pattern:=coalesce(p_payload->>'pattern','weekly');repeat_every:=coalesce((p_payload->>'repeatInterval')::int,1);
 if pattern not in ('daily','weekly') or repeat_every not between 1 and 12 then raise exception 'zoom_invalid_series';end if;
 select timezone into tz from core.tenants where id=t;if not exists(select 1 from pg_timezone_names where name=tz) then raise exception 'zoom_invalid_series';end if;
 if (select count(distinct value::uuid) from jsonb_array_elements_text(p_payload->'sessions'))<>total then raise exception 'zoom_invalid_series';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':zoom-schedule',0));
 if (select count(*) from academy.course_run_sessions where tenant_id=t and id in(select value::uuid from jsonb_array_elements_text(p_payload->'sessions')))<>total then raise exception 'zoom_not_found';end if;
 step_days:=repeat_every*case when pattern='weekly' then 7 else 1 end;
 common:=p_payload-'sessions'-'pattern'-'repeatInterval';
 for item in select * from academy.course_run_sessions where tenant_id=t and id in(select value::uuid from jsonb_array_elements_text(p_payload->'sessions')) order by starts_at,id for update loop
  if n=0 then select * into first_session from academy.course_run_sessions where tenant_id=t and id=item.id;end if;
  expected:=((first_session.starts_at at time zone tz)+make_interval(days=>n*step_days)) at time zone tz;
  if item.course_run_id<>first_session.course_run_id or item.starts_at is distinct from expected or item.ends_at-item.starts_at<>first_session.ends_at-first_session.starts_at or extract(epoch from item.ends_at-item.starts_at)::bigint%60<>0 then raise exception 'zoom_irregular_series';end if;
  result:=public.v1_zoom_action(p_slug,'assign',gen_random_uuid(),common||jsonb_build_object('sessionId',item.id,'expectedVersion',0,'startsAt',item.starts_at,'endsAt',item.ends_at));lid:=(result->>'id')::uuid;
  select id into oid from zoom_core.operations where tenant_id=t and link_id=lid and revision=1 and kind='create';
  if n=0 then root_id:=oid;else update zoom_core.operations set state='blocked',payload=payload||jsonb_build_object('seriesRoot',root_id) where id=oid;end if;
  members:=members||jsonb_build_array(jsonb_build_object('sessionId',item.id,'linkId',lid,'operationId',oid,'startsAt',item.starts_at,'endsAt',item.ends_at));n:=n+1;
 end loop;
 recurrence:=jsonb_build_object('type',case when pattern='weekly' then 2 else 1 end,'repeat_interval',repeat_every,'end_times',total);
 if pattern='weekly' then recurrence:=recurrence||jsonb_build_object('weekly_days',(extract(dow from first_session.starts_at at time zone tz)::int+1)::text);end if;
 update zoom_core.operations set payload=payload||jsonb_build_object('seriesMembers',members) where id=root_id;
 update zoom_core.links set desired=desired||jsonb_build_object('series',jsonb_build_object('timezone',tz,'recurrence',recurrence,'count',total)) where id=(members->0->>'linkId')::uuid;
 result:=jsonb_build_object('state','queued','seriesOperationId',root_id,'sessions',members,'timezone',tz,'atomic',true);
 update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.series.requested','zoom_operation',root_id::text,t,jsonb_build_object('sessions',total,'timezone',tz,'pattern',pattern));return result;
end $$;

alter function public.v1_zoom_operation_context(uuid,uuid,int) rename to v1_zoom_operation_context_before_series;
create function public.v1_zoom_operation_context(p_operation_id uuid,p_lease_id uuid,p_fence integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;member jsonb;peer zoom_core.operations%rowtype;
begin
 ctx:=public.v1_zoom_operation_context_before_series(p_operation_id,p_lease_id,p_fence);
 if ctx->'operation'->'payload' ? 'seriesMembers' then
  for member in select value from jsonb_array_elements(ctx->'operation'->'payload'->'seriesMembers') loop
   if (member->>'operationId')::uuid=p_operation_id then continue;end if;
   select * into peer from zoom_core.operations where tenant_id=(ctx->'operation'->>'tenant_id')::uuid and id=(member->>'operationId')::uuid and payload->>'seriesRoot'=p_operation_id::text for update;
   if peer.id is null or peer.state not in ('blocked','processing','retry','uncertain') then raise exception 'zoom_stale_operation';end if;
   update zoom_core.operations set state='processing',lease_id=p_lease_id,fence=p_fence,lease_until=now()+interval '90 seconds' where id=peer.id;
   perform public.v1_zoom_operation_context_before_series(peer.id,p_lease_id,p_fence);
  end loop;
 end if;
 return ctx;
end $$;

alter function public.v1_zoom_operation_complete(uuid,uuid,int,text,jsonb,int,int) rename to v1_zoom_operation_complete_before_series;
create function public.v1_zoom_operation_complete(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_outcome text,p_result jsonb default '{}',p_retry_seconds integer default 60,p_generation integer default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare root zoom_core.operations%rowtype;member jsonb;peer zoom_core.operations%rowtype;occ jsonb;root_result jsonb:=p_result;
begin
 perform zoom_core.service_only();select * into root from zoom_core.operations where id=p_operation_id for update;
 if not (root.payload ? 'seriesMembers') then return public.v1_zoom_operation_complete_before_series(p_operation_id,p_lease_id,p_fence,p_outcome,p_result,p_retry_seconds,p_generation);end if;
 if root.state<>'processing' or root.lease_id is distinct from p_lease_id or root.fence<>p_fence or root.lease_until<=now() then raise exception 'zoom_stale_lease';end if;
 if p_outcome='complete' then
  perform public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);
  if jsonb_typeof(p_result->'occurrences') is distinct from 'array' or jsonb_array_length(p_result->'occurrences')<>jsonb_array_length(root.payload->'seriesMembers') or (select count(distinct value->>'occurrence_id') from jsonb_array_elements(p_result->'occurrences'))<>jsonb_array_length(p_result->'occurrences') then raise exception 'zoom_invalid_provider_response';end if;
 end if;
 -- Whole-series persistence is one DB transaction. Partial response => no
 -- ready links and no released reservations; recovery requires provider proof.
 for member in select value from jsonb_array_elements(root.payload->'seriesMembers') loop
  select * into peer from zoom_core.operations where tenant_id=root.tenant_id and id=(member->>'operationId')::uuid for update;
  if peer.id is null or peer.connection_id<>root.connection_id or (peer.id<>root.id and peer.payload->>'seriesRoot' is distinct from root.id::text) then raise exception 'zoom_stale_operation';end if;
  if p_outcome='complete' then
   select value into occ from jsonb_array_elements(p_result->'occurrences') where (value->>'start_time')::timestamptz=(member->>'startsAt')::timestamptz and (value->>'duration')::int=extract(epoch from (member->>'endsAt')::timestamptz-(member->>'startsAt')::timestamptz)::int/60 and value->>'status' is distinct from 'deleted';
   if occ is null or nullif(occ->>'occurrence_id','') is null then raise exception 'zoom_invalid_provider_response';end if;
  else occ:='{}';end if;
  if peer.id=root.id then root_result:=p_result||occ;continue;end if;
  update zoom_core.operations set state='processing',lease_id=p_lease_id,fence=p_fence,lease_until=now()+interval '90 seconds' where id=peer.id;
  perform public.v1_zoom_operation_complete_before_series(peer.id,p_lease_id,p_fence,p_outcome,p_result||occ,p_retry_seconds,p_generation);
 end loop;
 return public.v1_zoom_operation_complete_before_series(p_operation_id,p_lease_id,p_fence,p_outcome,root_result,p_retry_seconds,p_generation);
end $$;
revoke all on function public.v1_zoom_series(text,uuid,jsonb),public.v1_zoom_operation_context(uuid,uuid,int),public.v1_zoom_operation_complete(uuid,uuid,int,text,jsonb,int,int),public.v1_zoom_operation_context_before_series(uuid,uuid,int),public.v1_zoom_operation_complete_before_series(uuid,uuid,int,text,jsonb,int,int) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_series(text,uuid,jsonb) to authenticated;
grant execute on function public.v1_zoom_operation_context(uuid,uuid,int),public.v1_zoom_operation_complete(uuid,uuid,int,text,jsonb,int,int) to service_role;
commit;
