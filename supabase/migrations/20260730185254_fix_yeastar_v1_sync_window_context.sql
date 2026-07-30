create or replace function public.v2_yeastar_sync_context(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_last_success timestamptz;
begin
  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.id = p_connection_id
    and connection.provider_key = 'yeastar_p550'
    and connection.status <> 'disabled';

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select max(coalesce(run.requested_to, run.finished_at))
  into v_last_success
  from telephony.sync_runs run
  where run.provider_connection_id = v_connection.id
    and run.status in ('success', 'partial')
    and run.trigger_type in ('manual', 'scheduled')
    and run.requested_from is not null
    and run.requested_to is not null;

  return jsonb_build_object(
    'tenantId', v_connection.tenant_id,
    'connectionId', v_connection.id,
    'lastSuccessfulAt', v_last_success,
    'initialHistoryDays',
      coalesce(
        (v_connection.public_config ->> 'initialHistoryDays')::integer,
        30
      )
  );
end;
$function$;

revoke all on function public.v2_yeastar_sync_context(uuid)
  from public, anon, authenticated;
grant execute on function public.v2_yeastar_sync_context(uuid)
  to service_role;

update telephony.sync_runs run
set status = 'failed',
    error_code = 'yeastar_invalid_sync_window',
    error_detail = 'The Yeastar v1 connector returned records outside the requested window before the v1 time-filter fix.'
where run.status in ('success', 'partial')
  and run.trigger_type in ('manual', 'scheduled')
  and run.api_version = 'v1.0'
  and run.requested_from is not null
  and run.requested_to is not null
  and coalesce(run.fetched_count, 0) > 0
  and not exists (
    select 1
    from telephony.call_records record
    where record.provider_connection_id = run.provider_connection_id
      and record.started_at >= run.requested_from
      and record.started_at <= run.requested_to
  )
  and exists (
    select 1
    from telephony.call_records record
    where record.provider_connection_id = run.provider_connection_id
      and (
        record.started_at < run.requested_from
        or record.started_at > run.requested_to
      )
  );
