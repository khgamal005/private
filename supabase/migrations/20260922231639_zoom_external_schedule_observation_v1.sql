begin;
create function public.v1_zoom_schedule_observe(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;l zoom_core.links%rowtype;diff boolean;observed_options jsonb;
begin
 ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);select * into l from zoom_core.links where tenant_id=(ctx->'link'->>'tenant_id')::uuid and id=(ctx->'link'->>'id')::uuid for update;
 if ctx->'operation'->'payload'->>'checkSchedule' is distinct from 'true' then raise exception 'zoom_invalid_action';end if;
 if l.state='cancelled' then return '{"state":"cancelled"}';end if;
 if l.state in ('queued','updating','cancelling','uncertain') then raise exception 'zoom_result_incomplete';end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into observed_options from jsonb_each(coalesce(p_result->'settings','{}')) where key in ('waiting_room','meeting_authentication','host_video','participant_video','mute_upon_entry','join_before_host');
 diff:=coalesce(p_result->>'missing'='true',false) or p_result->>'id' is distinct from l.meeting_id or p_result->>'host_id' is distinct from ctx->'host'->>'userId'
  or (p_result->>'start_time')::timestamptz is distinct from (l.desired->>'startsAt')::timestamptz or (p_result->>'duration')::int is distinct from ceil(extract(epoch from (l.desired->>'endsAt')::timestamptz-(l.desired->>'startsAt')::timestamptz)/60)::int
  or (l.desired?'meetingOptions' and not observed_options@>(l.desired->'meetingOptions')) or coalesce((l.desired->>'registration'='true' and p_result->'settings'->>'approval_type' is distinct from '0'),false);
 update zoom_core.links set observed=observed||jsonb_build_object('startsAt',p_result->>'start_time','duration',p_result->'duration','hostId',p_result->>'host_id','missing',coalesce(p_result->>'missing'='true',false),'meetingOptions',observed_options),last_synced_at=now(),state=case when diff then 'drift' else state end,reason=case when diff then 'zoom_external_schedule_changed' else reason end where id=l.id;
 perform private_app.write_audit('zoom.schedule.observed','zoom_link',l.id::text,l.tenant_id,jsonb_build_object('different',diff,'missing',p_result->'missing'));
 return jsonb_build_object('different',diff,'state',case when diff then 'drift' else l.state end);
end $$;
revoke all on function public.v1_zoom_schedule_observe(uuid,uuid,int,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_schedule_observe(uuid,uuid,int,jsonb) to service_role;
commit;
