create or replace function public.v2_yeastar_sync_context(p_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_last_success timestamptz;
  v_sync_start timestamptz;
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

  v_sync_start := nullif(
    v_connection.public_config ->> 'syncStartAt',
    ''
  )::timestamptz;

  return jsonb_build_object(
    'tenantId', v_connection.tenant_id,
    'connectionId', v_connection.id,
    'lastSuccessfulAt', coalesce(v_last_success, v_sync_start),
    'initialHistoryDays',
      coalesce(
        (v_connection.public_config ->> 'initialHistoryDays')::integer,
        30
      )
  );
end;
$$;

create or replace function public.v2_yeastar_due_connections()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', connection.tenant_id,
    'connectionId', connection.id,
    'lastAttemptAt', latest.finished_at,
    'syncStartAt', nullif(
      connection.public_config ->> 'syncStartAt',
      ''
    )::timestamptz
  )), '[]'::jsonb)
  from communication_hub.provider_connections connection
  left join lateral (
    select run.finished_at
    from telephony.sync_runs run
    where run.provider_connection_id = connection.id
      and run.trigger_type in ('manual', 'scheduled')
    order by run.finished_at desc nulls last
    limit 1
  ) latest on true
  where connection.provider_key = 'yeastar_p550'
    and connection.status in ('active', 'degraded')
    and (
      coalesce(
        latest.finished_at,
        nullif(connection.public_config ->> 'syncStartAt', '')::timestamptz
      ) is null
      or coalesce(
        latest.finished_at,
        nullif(connection.public_config ->> 'syncStartAt', '')::timestamptz
      )
        + make_interval(
            mins => coalesce(
              (connection.public_config ->> 'syncIntervalMinutes')::integer,
              60
            )
          ) <= now()
    );
$$;
