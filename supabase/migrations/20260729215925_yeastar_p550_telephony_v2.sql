-- Applied migration version: 20260729215925
begin;

create schema if not exists telephony;

revoke all on schema telephony from public, anon, authenticated;

create table telephony.call_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  provider_connection_id uuid not null
    references communication_hub.provider_connections(id) on delete cascade,
  cdr_uid text not null,
  source_record_id text,
  api_version text not null default 'v1.0',
  started_at timestamptz not null,
  call_type text not null
    check (call_type in ('Inbound', 'Outbound', 'Internal', 'Unknown')),
  final_status text not null
    check (
      final_status in (
        'ANSWERED',
        'NO ANSWER',
        'ABANDONED',
        'BUSY',
        'FAILED',
        'VOICEMAIL',
        'UNKNOWN'
      )
    ),
  caller_number text,
  caller_name text,
  callee_number text,
  callee_name text,
  second_participant_number text,
  second_participant_name text,
  last_participant_number text,
  last_participant_name text,
  involved_extensions text[] not null default '{}'::text[],
  call_duration_seconds integer not null default 0
    check (call_duration_seconds >= 0),
  routing_duration_seconds integer not null default 0
    check (routing_duration_seconds >= 0),
  handling_duration_seconds integer not null default 0
    check (handling_duration_seconds >= 0),
  disconnected_by text,
  segments integer not null default 1 check (segments >= 0),
  queue_names text[] not null default '{}'::text[],
  ring_group_names text[] not null default '{}'::text[],
  source_trunks text[] not null default '{}'::text[],
  destination_trunks text[] not null default '{}'::text[],
  did_numbers text[] not null default '{}'::text[],
  has_recording boolean not null default false,
  recording_reference text,
  call_note text,
  disposition_codes text[] not null default '{}'::text[],
  provider_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_connection_id, cdr_uid)
);

create index telephony_calls_tenant_started_idx
on telephony.call_records (tenant_id, started_at desc);

create index telephony_calls_connection_started_idx
on telephony.call_records (provider_connection_id, started_at desc);

create index telephony_calls_status_started_idx
on telephony.call_records (tenant_id, final_status, started_at desc);

create index telephony_calls_extensions_gin_idx
on telephony.call_records using gin (involved_extensions);

create table telephony.sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  provider_connection_id uuid not null
    references communication_hub.provider_connections(id) on delete cascade,
  trigger_type text not null
    check (trigger_type in ('manual', 'test', 'scheduled')),
  status text not null
    check (status in ('running', 'success', 'partial', 'failed')),
  requested_from timestamptz,
  requested_to timestamptz,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  device_model text,
  firmware_version text,
  api_version text,
  error_code text,
  error_detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index telephony_sync_runs_connection_idx
on telephony.sync_runs (provider_connection_id, started_at desc);

create trigger telephony_call_records_set_updated_at
before update on telephony.call_records
for each row execute function private_app.set_updated_at();

alter table telephony.call_records enable row level security;
alter table telephony.sync_runs enable row level security;

revoke all on all tables in schema telephony
from public, anon, authenticated;

revoke all on all sequences in schema telephony
from public, anon, authenticated;

alter default privileges in schema telephony
revoke all on tables from public, anon, authenticated;

alter default privileges in schema telephony
revoke all on sequences from public, anon, authenticated;

insert into communication_hub.provider_catalog (
  provider_key,
  channel,
  name_ar,
  description_ar,
  addon_key,
  setup_fields,
  secret_fields,
  docs_url,
  supports_test,
  status,
  sort_order
)
values (
  'yeastar_p550',
  'api',
  'Yeastar P550',
  'سجلات المكالمات والتقارير التشغيلية من سنترال Yeastar P-Series.',
  'addon.integration.api',
  '[]'::jsonb,
  '[]'::jsonb,
  'https://help.yeastar.com/en/p-series-appliance-edition/developer-guide/api-interfaces-and-events-summary.html',
  true,
  'disabled',
  65
)
on conflict (provider_key) do update
set name_ar = excluded.name_ar,
    description_ar = excluded.description_ar,
    addon_key = excluded.addon_key,
    docs_url = excluded.docs_url,
    supports_test = excluded.supports_test,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.yeastar_public_config(
  p_config jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_base_url text;
  v_extensions text[];
  v_timezone text;
  v_sync_interval integer;
  v_history_days integer;
begin
  v_base_url := regexp_replace(
    coalesce(nullif(trim(p_config ->> 'baseUrl'), ''), ''),
    '/+$',
    ''
  );
  if v_base_url !~ '^https://[^[:space:]]+$'
     or v_base_url ~* '^https://(localhost|127\.|0\.0\.0\.0|\[?::1\]?)(:|/|$)'
     or v_base_url ~* '^https://(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' then
    raise exception 'yeastar_public_https_required';
  end if;

  select coalesce(array_agg(distinct value order by value), '{}'::text[])
  into v_extensions
  from (
    select trim(item) as value
    from regexp_split_to_table(
      coalesce(p_config ->> 'extensions', ''),
      '[,[:space:]]+'
    ) item
    where trim(item) ~ '^[0-9]{1,12}$'
  ) normalized;
  if cardinality(v_extensions) = 0 then
    raise exception 'yeastar_extension_required';
  end if;
  if cardinality(v_extensions) > 100 then
    raise exception 'yeastar_too_many_extensions';
  end if;

  v_timezone := coalesce(
    nullif(trim(p_config ->> 'timezone'), ''),
    'Asia/Riyadh'
  );
  if v_timezone not in ('Asia/Riyadh', 'Africa/Cairo', 'UTC') then
    raise exception 'yeastar_invalid_timezone';
  end if;

  begin
    v_sync_interval := coalesce(
      (p_config ->> 'syncIntervalMinutes')::integer,
      60
    );
  exception when invalid_text_representation then
    raise exception 'yeastar_invalid_sync_interval';
  end;
  if v_sync_interval not in (15, 30, 60, 360, 1440) then
    raise exception 'yeastar_invalid_sync_interval';
  end if;

  begin
    v_history_days := coalesce(
      (p_config ->> 'initialHistoryDays')::integer,
      30
    );
  exception when invalid_text_representation then
    raise exception 'yeastar_invalid_history_days';
  end;
  if v_history_days not between 1 and 90 then
    raise exception 'yeastar_invalid_history_days';
  end if;

  return jsonb_build_object(
    'baseUrl', v_base_url,
    'extensions', array_to_string(v_extensions, ','),
    'timezone', v_timezone,
    'syncIntervalMinutes', v_sync_interval,
    'initialHistoryDays', v_history_days,
    'apiMode',
      case
        when p_config ->> 'apiMode' = 'v1.0' then 'v1.0'
        when p_config ->> 'apiMode' = 'v2.0' then 'v2.0'
        else 'auto'
      end
  );
end;
$$;

revoke all on function private_app.yeastar_public_config(jsonb)
from public, anon, authenticated;

create or replace function public.v2_tenant_yeastar_settings_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_last_run telephony.sync_runs%rowtype;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  if v_connection.id is not null then
    select * into v_last_run
    from telephony.sync_runs run
    where run.provider_connection_id = v_connection.id
    order by run.started_at desc
    limit 1;
  end if;

  return jsonb_build_object(
    'canManage', true,
    'configured', v_connection.id is not null,
    'connectionId', v_connection.id,
    'displayName', coalesce(v_connection.display_name, 'Yeastar P550'),
    'status', coalesce(v_connection.status, 'disabled'),
    'publicConfig', coalesce(
      v_connection.public_config,
      jsonb_build_object(
        'baseUrl', '',
        'extensions', '',
        'timezone', 'Asia/Riyadh',
        'syncIntervalMinutes', 60,
        'initialHistoryDays', 30,
        'apiMode', 'auto'
      )
    ),
    'configuredSecrets',
      case
        when v_connection.id is null then '[]'::jsonb
        else coalesce((
          select jsonb_agg(secret.key order by secret.key)
          from jsonb_each_text(v_connection.secret_refs) secret
        ), '[]'::jsonb)
      end,
    'lastCheckedAt', v_connection.last_checked_at,
    'lastError', v_connection.last_error,
    'lastSync',
      case
        when v_last_run.id is null then null
        else jsonb_build_object(
          'status', v_last_run.status,
          'startedAt', v_last_run.started_at,
          'finishedAt', v_last_run.finished_at,
          'fetchedCount', v_last_run.fetched_count,
          'insertedCount', v_last_run.inserted_count,
          'updatedCount', v_last_run.updated_count,
          'deviceModel', v_last_run.device_model,
          'firmwareVersion', v_last_run.firmware_version,
          'apiVersion', v_last_run.api_version,
          'errorDetail', v_last_run.error_detail
        )
      end
  );
end;
$$;

create or replace function public.v2_tenant_yeastar_action(
  p_tenant_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor_subject_id uuid;
  v_connection communication_hub.provider_connections%rowtype;
  v_connection_id uuid;
  v_public_config jsonb;
  v_secret_refs jsonb;
  v_secret_value text;
  v_existing_secret_id uuid;
  v_saved_secret_id uuid;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant.id,
    'addon.integration.api'
  ) then raise exception 'integration_addon_not_enabled'; end if;

  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  for update;

  if p_action = 'save' then
    v_public_config := private_app.yeastar_public_config(
      coalesce(p_payload -> 'publicConfig', '{}'::jsonb)
    );

    if v_connection.id is null then
      insert into communication_hub.provider_connections (
        tenant_id,
        channel,
        provider_key,
        display_name,
        status,
        is_default,
        public_config,
        created_by_subject_id,
        updated_by_subject_id
      )
      values (
        v_tenant.id,
        'api',
        'yeastar_p550',
        coalesce(
          nullif(trim(p_payload ->> 'displayName'), ''),
          'Yeastar P550'
        ),
        'draft',
        false,
        v_public_config,
        v_actor_subject_id,
        v_actor_subject_id
      )
      returning * into v_connection;
    else
      update communication_hub.provider_connections
      set display_name = coalesce(
            nullif(trim(p_payload ->> 'displayName'), ''),
            display_name
          ),
          public_config = v_public_config,
          status = 'draft',
          last_error = null,
          updated_by_subject_id = v_actor_subject_id
      where id = v_connection.id
      returning * into v_connection;
    end if;

    v_connection_id := v_connection.id;
    v_secret_refs := coalesce(v_connection.secret_refs, '{}'::jsonb);

    v_secret_value := nullif(p_payload #>> '{secrets,clientId}', '');
    if v_secret_value is not null then
      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> 'clientId', '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;
      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection_id,
        'clientId',
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        '{clientId}',
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end if;

    v_secret_value := nullif(p_payload #>> '{secrets,clientSecret}', '');
    if v_secret_value is not null then
      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> 'clientSecret', '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;
      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection_id,
        'clientSecret',
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        '{clientSecret}',
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end if;

    if not (v_secret_refs ? 'clientId')
       or not (v_secret_refs ? 'clientSecret') then
      raise exception 'yeastar_credentials_required';
    end if;

    update communication_hub.provider_connections
    set secret_refs = v_secret_refs
    where id = v_connection_id;

    insert into core.integrations (
      tenant_id,
      system_type,
      display_name,
      status,
      configuration
    )
    values (
      v_tenant.id,
      'yeastar_pbx',
      v_connection.display_name,
      'draft',
      jsonb_build_object(
        'connectionId', v_connection_id,
        'providerKey', 'yeastar_p550',
        'extensions', v_public_config ->> 'extensions'
      )
    )
    on conflict (tenant_id, system_type) where tenant_id is not null
    do update
    set display_name = excluded.display_name,
        status = excluded.status,
        configuration = excluded.configuration,
        last_checked_at = null,
        updated_at = now();

    perform private_app.write_audit(
      'telephony.yeastar.settings_saved',
      'provider_connection',
      v_connection_id::text,
      v_tenant.id,
      jsonb_build_object(
        'extensions', v_public_config ->> 'extensions',
        'syncIntervalMinutes',
          v_public_config ->> 'syncIntervalMinutes'
      )
    );

    return jsonb_build_object(
      'connectionId', v_connection_id,
      'status', 'draft',
      'configuredSecrets',
        jsonb_build_array('clientId', 'clientSecret')
    );

  elsif p_action = 'disable' then
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;
    update communication_hub.provider_connections
    set status = 'disabled',
        last_error = null,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection.id;
    update core.integrations
    set status = 'disabled',
        updated_at = now()
    where tenant_id = v_tenant.id
      and system_type = 'yeastar_pbx';
    return jsonb_build_object('status', 'disabled');
  else
    raise exception 'invalid_yeastar_action';
  end if;
end;
$$;

create or replace function public.v2_tenant_yeastar_authorize(
  p_tenant_slug text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if p_action not in ('test', 'sync') then
    raise exception 'invalid_yeastar_action';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
    and connection.status <> 'disabled'
  limit 1;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;
  if not (v_connection.secret_refs ? 'clientId')
     or not (v_connection.secret_refs ? 'clientSecret') then
    raise exception 'yeastar_credentials_required';
  end if;

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'connectionId', v_connection.id,
    'action', p_action
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
    'lastSuccessfulAt', latest.finished_at
  )), '[]'::jsonb)
  from communication_hub.provider_connections connection
  left join lateral (
    select run.finished_at
    from telephony.sync_runs run
    where run.provider_connection_id = connection.id
      and run.status in ('success', 'partial')
    order by run.finished_at desc nulls last
    limit 1
  ) latest on true
  where connection.provider_key = 'yeastar_p550'
    and connection.status in ('active', 'degraded')
    and (
      latest.finished_at is null
      or latest.finished_at
        + make_interval(
            mins => coalesce(
              (connection.public_config ->> 'syncIntervalMinutes')::integer,
              60
            )
          ) <= now()
    );
$$;

do $secret$
begin
  if not exists (
    select 1
    from vault.secrets secret
    where secret.name = 'yeastar_dispatch_secret'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'yeastar_dispatch_secret',
      'Authorizes the scheduled Yeastar CDR dispatcher.'
    );
  end if;
end;
$secret$;

create or replace function public.v2_yeastar_schedule_authorize(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'yeastar_dispatch_secret'
      and secret.decrypted_secret = p_secret
  );
$$;

create or replace function public.v2_yeastar_sync_context(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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

  select max(run.finished_at) into v_last_success
  from telephony.sync_runs run
  where run.provider_connection_id = v_connection.id
    and run.status in ('success', 'partial');

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
$$;

create or replace function public.v2_yeastar_store_sync(
  p_connection_id uuid,
  p_trigger_type text,
  p_requested_from timestamptz,
  p_requested_to timestamptz,
  p_device jsonb,
  p_api_version text,
  p_calls jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_run_id uuid;
  v_call jsonb;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_existing boolean;
  v_started_at timestamptz;
begin
  if p_trigger_type not in ('manual', 'scheduled') then
    raise exception 'invalid_yeastar_trigger';
  end if;
  if jsonb_typeof(p_calls) <> 'array'
     or jsonb_array_length(p_calls) > 10000 then
    raise exception 'invalid_yeastar_payload';
  end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.id = p_connection_id
    and connection.provider_key = 'yeastar_p550'
    and connection.status <> 'disabled';
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  insert into telephony.sync_runs (
    tenant_id,
    provider_connection_id,
    trigger_type,
    status,
    requested_from,
    requested_to,
    fetched_count,
    device_model,
    firmware_version,
    api_version
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    p_trigger_type,
    'running',
    p_requested_from,
    p_requested_to,
    jsonb_array_length(p_calls),
    left(p_device ->> 'modelName', 120),
    left(p_device ->> 'firmwareVersion', 120),
    left(p_api_version, 12)
  )
  returning id into v_run_id;

  for v_call in select value from jsonb_array_elements(p_calls)
  loop
    if coalesce(nullif(v_call ->> 'uid', ''), '') = '' then
      continue;
    end if;
    begin
      v_started_at := (v_call ->> 'startedAt')::timestamptz;
    exception when others then
      continue;
    end;

    select exists (
      select 1
      from telephony.call_records record
      where record.provider_connection_id = v_connection.id
        and record.cdr_uid = v_call ->> 'uid'
    ) into v_existing;

    insert into telephony.call_records (
      tenant_id,
      provider_connection_id,
      cdr_uid,
      source_record_id,
      api_version,
      started_at,
      call_type,
      final_status,
      caller_number,
      caller_name,
      callee_number,
      callee_name,
      second_participant_number,
      second_participant_name,
      last_participant_number,
      last_participant_name,
      involved_extensions,
      call_duration_seconds,
      routing_duration_seconds,
      handling_duration_seconds,
      disconnected_by,
      segments,
      queue_names,
      ring_group_names,
      source_trunks,
      destination_trunks,
      did_numbers,
      has_recording,
      recording_reference,
      call_note,
      disposition_codes,
      provider_payload
    )
    values (
      v_connection.tenant_id,
      v_connection.id,
      left(v_call ->> 'uid', 200),
      left(v_call ->> 'sourceRecordId', 200),
      left(coalesce(v_call ->> 'apiVersion', p_api_version), 12),
      v_started_at,
      case
        when v_call ->> 'callType'
          in ('Inbound', 'Outbound', 'Internal')
        then v_call ->> 'callType'
        else 'Unknown'
      end,
      case
        when upper(coalesce(v_call ->> 'finalStatus', ''))
          in (
            'ANSWERED',
            'NO ANSWER',
            'ABANDONED',
            'BUSY',
            'FAILED',
            'VOICEMAIL'
          )
        then upper(v_call ->> 'finalStatus')
        else 'UNKNOWN'
      end,
      left(nullif(v_call ->> 'callerNumber', ''), 120),
      left(nullif(v_call ->> 'callerName', ''), 200),
      left(nullif(v_call ->> 'calleeNumber', ''), 120),
      left(nullif(v_call ->> 'calleeName', ''), 200),
      left(nullif(v_call ->> 'secondParticipantNumber', ''), 120),
      left(nullif(v_call ->> 'secondParticipantName', ''), 200),
      left(nullif(v_call ->> 'lastParticipantNumber', ''), 120),
      left(nullif(v_call ->> 'lastParticipantName', ''), 200),
      coalesce(
        array(
          select left(value, 40)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'involvedExtensions', '[]'::jsonb)
          ) value
          where value ~ '^[0-9]{1,12}$'
          limit 100
        ),
        '{}'::text[]
      ),
      greatest(coalesce((v_call ->> 'callDuration')::integer, 0), 0),
      greatest(coalesce((v_call ->> 'routingDuration')::integer, 0), 0),
      greatest(coalesce((v_call ->> 'handlingDuration')::integer, 0), 0),
      left(nullif(v_call ->> 'disconnectedBy', ''), 80),
      greatest(coalesce((v_call ->> 'segments')::integer, 1), 0),
      coalesce(
        array(
          select left(value, 120)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'queueNames', '[]'::jsonb)
          ) value limit 30
        ),
        '{}'::text[]
      ),
      coalesce(
        array(
          select left(value, 120)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'ringGroupNames', '[]'::jsonb)
          ) value limit 30
        ),
        '{}'::text[]
      ),
      coalesce(
        array(
          select left(value, 120)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'sourceTrunks', '[]'::jsonb)
          ) value limit 30
        ),
        '{}'::text[]
      ),
      coalesce(
        array(
          select left(value, 120)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'destinationTrunks', '[]'::jsonb)
          ) value limit 30
        ),
        '{}'::text[]
      ),
      coalesce(
        array(
          select left(value, 120)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'didNumbers', '[]'::jsonb)
          ) value limit 30
        ),
        '{}'::text[]
      ),
      coalesce((v_call ->> 'hasRecording')::boolean, false),
      left(nullif(v_call ->> 'recordingReference', ''), 500),
      left(nullif(v_call ->> 'callNote', ''), 2000),
      coalesce(
        array(
          select left(value, 120)
          from jsonb_array_elements_text(
            coalesce(v_call -> 'dispositionCodes', '[]'::jsonb)
          ) value limit 30
        ),
        '{}'::text[]
      ),
      jsonb_strip_nulls(jsonb_build_object(
        'queues', v_call -> 'queues',
        'ringGroups', v_call -> 'ringGroups',
        'dids', v_call -> 'dids'
      ))
    )
    on conflict (provider_connection_id, cdr_uid) do update
    set source_record_id = excluded.source_record_id,
        api_version = excluded.api_version,
        started_at = excluded.started_at,
        call_type = excluded.call_type,
        final_status = excluded.final_status,
        caller_number = excluded.caller_number,
        caller_name = excluded.caller_name,
        callee_number = excluded.callee_number,
        callee_name = excluded.callee_name,
        second_participant_number =
          excluded.second_participant_number,
        second_participant_name =
          excluded.second_participant_name,
        last_participant_number = excluded.last_participant_number,
        last_participant_name = excluded.last_participant_name,
        involved_extensions = excluded.involved_extensions,
        call_duration_seconds = excluded.call_duration_seconds,
        routing_duration_seconds = excluded.routing_duration_seconds,
        handling_duration_seconds = excluded.handling_duration_seconds,
        disconnected_by = excluded.disconnected_by,
        segments = excluded.segments,
        queue_names = excluded.queue_names,
        ring_group_names = excluded.ring_group_names,
        source_trunks = excluded.source_trunks,
        destination_trunks = excluded.destination_trunks,
        did_numbers = excluded.did_numbers,
        has_recording = excluded.has_recording,
        recording_reference = excluded.recording_reference,
        call_note = excluded.call_note,
        disposition_codes = excluded.disposition_codes,
        provider_payload = excluded.provider_payload,
        updated_at = now();

    if v_existing then
      v_updated := v_updated + 1;
    else
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  update telephony.sync_runs
  set status = 'success',
      inserted_count = v_inserted,
      updated_count = v_updated,
      finished_at = now()
  where id = v_run_id;

  update communication_hub.provider_connections
  set status = 'active',
      last_checked_at = now(),
      last_error = null
  where id = v_connection.id;

  update core.integrations
  set status = 'active',
      last_checked_at = now(),
      configuration = configuration || jsonb_build_object(
        'deviceModel', left(p_device ->> 'modelName', 120),
        'firmwareVersion', left(p_device ->> 'firmwareVersion', 120),
        'apiVersion', left(p_api_version, 12),
        'lastSyncAt', now()
      ),
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'yeastar_pbx';

  return jsonb_build_object(
    'runId', v_run_id,
    'fetchedCount', jsonb_array_length(p_calls),
    'insertedCount', v_inserted,
    'updatedCount', v_updated
  );
exception when others then
  if v_run_id is not null then
    update telephony.sync_runs
    set status = 'failed',
        error_code = sqlstate,
        error_detail = left(sqlerrm, 1000),
        finished_at = now()
    where id = v_run_id;
  end if;
  raise;
end;
$$;

create or replace function public.v2_yeastar_test_complete(
  p_connection_id uuid,
  p_state text,
  p_device jsonb default '{}'::jsonb,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
begin
  if p_state not in ('ready', 'error') then
    raise exception 'invalid_provider_state';
  end if;
  update communication_hub.provider_connections
  set status = case when p_state = 'ready' then 'active' else 'error' end,
      last_checked_at = now(),
      last_error = case
        when p_state = 'error'
        then left(coalesce(nullif(p_detail, ''), 'connection_test_failed'), 500)
        else null
      end
  where id = p_connection_id
    and provider_key = 'yeastar_p550'
  returning * into v_connection;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  update core.integrations
  set status = case when p_state = 'ready' then 'active' else 'error' end,
      last_checked_at = now(),
      configuration = configuration || jsonb_strip_nulls(
        jsonb_build_object(
          'deviceModel', left(p_device ->> 'modelName', 120),
          'firmwareVersion', left(p_device ->> 'firmwareVersion', 120),
          'lastTestDetail', left(nullif(p_detail, ''), 240)
        )
      ),
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'yeastar_pbx';

  insert into telephony.sync_runs (
    tenant_id,
    provider_connection_id,
    trigger_type,
    status,
    fetched_count,
    device_model,
    firmware_version,
    api_version,
    error_detail,
    finished_at
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    'test',
    case when p_state = 'ready' then 'success' else 'failed' end,
    0,
    left(p_device ->> 'modelName', 120),
    left(p_device ->> 'firmwareVersion', 120),
    left(p_device ->> 'apiVersion', 12),
    case when p_state = 'error' then left(p_detail, 1000) else null end,
    now()
  );

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'state', p_state,
    'status', v_connection.status
  );
end;
$$;

create or replace function public.v2_yeastar_sync_failed(
  p_connection_id uuid,
  p_trigger_type text,
  p_requested_from timestamptz,
  p_requested_to timestamptz,
  p_detail text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_detail text;
begin
  if p_trigger_type not in ('manual', 'scheduled') then
    raise exception 'invalid_yeastar_trigger';
  end if;

  v_detail := left(
    regexp_replace(
      coalesce(nullif(p_detail, ''), 'yeastar_sync_failed'),
      '(access_token|client_secret|clientSecret)=?[^&[:space:]]+',
      '\1=[REDACTED]',
      'gi'
    ),
    1000
  );

  update communication_hub.provider_connections
  set status = case when status = 'active' then 'degraded' else 'error' end,
      last_checked_at = now(),
      last_error = left(v_detail, 500)
  where id = p_connection_id
    and provider_key = 'yeastar_p550'
    and status <> 'disabled'
  returning * into v_connection;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  insert into telephony.sync_runs (
    tenant_id,
    provider_connection_id,
    trigger_type,
    status,
    requested_from,
    requested_to,
    error_code,
    error_detail,
    finished_at
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    p_trigger_type,
    'failed',
    p_requested_from,
    p_requested_to,
    'YEASTAR_SYNC_FAILED',
    v_detail,
    now()
  );

  update core.integrations
  set status = case when status = 'active' then 'degraded' else 'error' end,
      last_checked_at = now(),
      configuration = configuration || jsonb_build_object(
        'lastSyncFailedAt', now(),
        'lastSyncError', left(v_detail, 240)
      ),
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'yeastar_pbx';

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'state', 'failed'
  );
end;
$$;

create or replace function public.v2_tenant_yeastar_reports_snapshot(
  p_slug text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_extension text default null,
  p_call_type text default null,
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_from timestamptz := coalesce(p_from, date_trunc('day', now()) - interval '29 days');
  v_to timestamptz := coalesce(p_to, now());
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.crm.read')
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.settings.manage'
    )
  ) then raise exception 'forbidden'; end if;
  if v_from >= v_to or v_to - v_from > interval '366 days' then
    raise exception 'invalid_report_period';
  end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  return jsonb_build_object(
    'generatedAt', now(),
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'connection', jsonb_build_object(
      'configured', v_connection.id is not null,
      'status', coalesce(v_connection.status, 'disabled'),
      'displayName', coalesce(v_connection.display_name, 'Yeastar P550'),
      'extensions',
        coalesce(v_connection.public_config ->> 'extensions', ''),
      'lastCheckedAt', v_connection.last_checked_at,
      'lastError', v_connection.last_error
    ),
    'summary', (
      select jsonb_build_object(
        'totalCalls', count(*),
        'answeredCalls', count(*) filter (where final_status = 'ANSWERED'),
        'missedCalls', count(*) filter (
          where final_status in ('NO ANSWER', 'ABANDONED', 'BUSY')
        ),
        'failedCalls', count(*) filter (where final_status = 'FAILED'),
        'inboundCalls', count(*) filter (where call_type = 'Inbound'),
        'outboundCalls', count(*) filter (where call_type = 'Outbound'),
        'internalCalls', count(*) filter (where call_type = 'Internal'),
        'recordedCalls', count(*) filter (where has_recording),
        'answerRate',
          round(
            100.0 * count(*) filter (where final_status = 'ANSWERED')
            / nullif(count(*), 0),
            1
          ),
        'totalTalkSeconds',
          coalesce(sum(handling_duration_seconds), 0),
        'averageTalkSeconds',
          coalesce(round(avg(handling_duration_seconds))::integer, 0),
        'averageRoutingSeconds',
          coalesce(round(avg(routing_duration_seconds))::integer, 0)
      )
      from telephony.call_records record
      where record.tenant_id = v_tenant.id
        and record.started_at >= v_from
        and record.started_at < v_to
        and (
          p_extension is null
          or p_extension = any(record.involved_extensions)
        )
        and (p_call_type is null or record.call_type = p_call_type)
        and (p_status is null or record.final_status = p_status)
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day,
        'total', total,
        'answered', answered,
        'missed', missed,
        'talkSeconds', talk_seconds
      ) order by day)
      from (
        select date_trunc('day', record.started_at)::date as day,
               count(*) as total,
               count(*) filter (
                 where record.final_status = 'ANSWERED'
               ) as answered,
               count(*) filter (
                 where record.final_status
                   in ('NO ANSWER', 'ABANDONED', 'BUSY')
               ) as missed,
               coalesce(sum(record.handling_duration_seconds), 0)
                 as talk_seconds
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            p_extension is null
            or p_extension = any(record.involved_extensions)
          )
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        group by 1
      ) days
    ), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object(
        'hour', hour_of_day,
        'total', total,
        'answered', answered
      ) order by hour_of_day)
      from (
        select extract(hour from record.started_at)::integer as hour_of_day,
               count(*) as total,
               count(*) filter (
                 where record.final_status = 'ANSWERED'
               ) as answered
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            p_extension is null
            or p_extension = any(record.involved_extensions)
          )
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        group by 1
      ) hours
    ), '[]'::jsonb),
    'extensions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'extension', stats.extension,
        'totalCalls', stats.total_calls,
        'answeredCalls', stats.answered_calls,
        'missedCalls', stats.missed_calls,
        'inboundCalls', stats.inbound_calls,
        'outboundCalls', stats.outbound_calls,
        'talkSeconds', stats.talk_seconds,
        'answerRate',
          round(100.0 * stats.answered_calls / nullif(stats.total_calls, 0), 1)
      ) order by stats.total_calls desc, stats.extension)
      from (
        select extension,
               count(*) as total_calls,
               count(*) filter (
                 where record.final_status = 'ANSWERED'
               ) as answered_calls,
               count(*) filter (
                 where record.final_status
                   in ('NO ANSWER', 'ABANDONED', 'BUSY')
               ) as missed_calls,
               count(*) filter (
                 where record.call_type = 'Inbound'
               ) as inbound_calls,
               count(*) filter (
                 where record.call_type = 'Outbound'
               ) as outbound_calls,
               coalesce(sum(record.handling_duration_seconds), 0)
                 as talk_seconds
        from telephony.call_records record
        cross join lateral unnest(record.involved_extensions) extension
        where record.tenant_id = v_tenant.id
          and record.started_at >= v_from
          and record.started_at < v_to
          and (p_extension is null or extension = p_extension)
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        group by extension
      ) stats
    ), '[]'::jsonb),
    'totalRecords', (
      select count(*)
      from telephony.call_records record
      where record.tenant_id = v_tenant.id
        and record.started_at >= v_from
        and record.started_at < v_to
        and (
          p_extension is null
          or p_extension = any(record.involved_extensions)
        )
        and (p_call_type is null or record.call_type = p_call_type)
        and (p_status is null or record.final_status = p_status)
    ),
    'calls', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', filtered.id,
        'uid', filtered.cdr_uid,
        'startedAt', filtered.started_at,
        'callType', filtered.call_type,
        'finalStatus', filtered.final_status,
        'callerNumber', filtered.caller_number,
        'callerName', filtered.caller_name,
        'calleeNumber', filtered.callee_number,
        'calleeName', filtered.callee_name,
        'lastParticipantNumber', filtered.last_participant_number,
        'lastParticipantName', filtered.last_participant_name,
        'extensions', filtered.involved_extensions,
        'callDurationSeconds', filtered.call_duration_seconds,
        'routingDurationSeconds', filtered.routing_duration_seconds,
        'handlingDurationSeconds', filtered.handling_duration_seconds,
        'segments', filtered.segments,
        'queues', filtered.queue_names,
        'hasRecording', filtered.has_recording,
        'callNote', filtered.call_note,
        'returnedAfterMissed',
          case
            when filtered.call_type = 'Inbound'
              and filtered.final_status
                in ('NO ANSWER', 'ABANDONED', 'BUSY')
            then exists (
              select 1
              from telephony.call_records callback
              where callback.tenant_id = filtered.tenant_id
                and callback.call_type = 'Outbound'
                and callback.final_status = 'ANSWERED'
                and callback.callee_number = filtered.caller_number
                and callback.started_at > filtered.started_at
                and callback.started_at
                  <= filtered.started_at + interval '7 days'
            )
            else null
          end
      ) order by filtered.started_at desc)
      from (
        select record.*
        from telephony.call_records record
        where record.tenant_id = v_tenant.id
          and record.started_at >= v_from
          and record.started_at < v_to
          and (
            p_extension is null
            or p_extension = any(record.involved_extensions)
          )
          and (p_call_type is null or record.call_type = p_call_type)
          and (p_status is null or record.final_status = p_status)
        order by record.started_at desc
        limit v_limit offset v_offset
      ) filtered
    ), '[]'::jsonb),
    'lastSync', (
      select jsonb_build_object(
        'status', run.status,
        'startedAt', run.started_at,
        'finishedAt', run.finished_at,
        'fetchedCount', run.fetched_count,
        'insertedCount', run.inserted_count,
        'updatedCount', run.updated_count,
        'deviceModel', run.device_model,
        'firmwareVersion', run.firmware_version,
        'apiVersion', run.api_version,
        'errorDetail', run.error_detail
      )
      from telephony.sync_runs run
      where run.tenant_id = v_tenant.id
      order by run.started_at desc
      limit 1
    )
  );
end;
$$;

revoke execute on function
  public.v2_tenant_yeastar_settings_snapshot(text)
from public, anon;
revoke execute on function
  public.v2_tenant_yeastar_action(text, text, jsonb)
from public, anon;
revoke execute on function
  public.v2_tenant_yeastar_authorize(text, text)
from public, anon;
revoke execute on function public.v2_yeastar_due_connections()
from public, anon, authenticated;
revoke execute on function public.v2_yeastar_schedule_authorize(text)
from public, anon, authenticated;
revoke execute on function public.v2_yeastar_sync_context(uuid)
from public, anon, authenticated;
revoke execute on function
  public.v2_yeastar_store_sync(
    uuid,
    text,
    timestamptz,
    timestamptz,
    jsonb,
    text,
    jsonb
  )
from public, anon, authenticated;
revoke execute on function
  public.v2_yeastar_test_complete(uuid, text, jsonb, text)
from public, anon, authenticated;
revoke execute on function
  public.v2_yeastar_sync_failed(
    uuid,
    text,
    timestamptz,
    timestamptz,
    text
  )
from public, anon, authenticated;
revoke execute on function
  public.v2_tenant_yeastar_reports_snapshot(
    text,
    timestamptz,
    timestamptz,
    text,
    text,
    text,
    integer,
    integer
  )
from public, anon;

grant execute on function
  public.v2_tenant_yeastar_settings_snapshot(text)
to authenticated;
grant execute on function
  public.v2_tenant_yeastar_action(text, text, jsonb)
to authenticated;
grant execute on function
  public.v2_tenant_yeastar_authorize(text, text)
to authenticated;
grant execute on function public.v2_yeastar_due_connections()
to service_role;
grant execute on function public.v2_yeastar_schedule_authorize(text)
to service_role;
grant execute on function public.v2_yeastar_sync_context(uuid)
to service_role;
grant execute on function
  public.v2_yeastar_store_sync(
    uuid,
    text,
    timestamptz,
    timestamptz,
    jsonb,
    text,
    jsonb
  )
to service_role;
grant execute on function
  public.v2_yeastar_test_complete(uuid, text, jsonb, text)
to service_role;
grant execute on function
  public.v2_yeastar_sync_failed(
    uuid,
    text,
    timestamptz,
    timestamptz,
    text
  )
to service_role;
grant execute on function
  public.v2_tenant_yeastar_reports_snapshot(
    text,
    timestamptz,
    timestamptz,
    text,
    text,
    text,
    integer,
    integer
  )
to authenticated;

do $schedule$
declare
  v_job_id bigint;
begin
  select job.jobid
  into v_job_id
  from cron.job job
  where job.jobname = 'marktone-yeastar-cdr-sync'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-yeastar-cdr-sync',
    '*/15 * * * *',
    $command$
      select net.http_post(
        url :=
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'yeastar-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-marktone-yeastar-secret',
          (
            select secret.decrypted_secret
            from vault.decrypted_secrets secret
            where secret.name = 'yeastar_dispatch_secret'
          )
        ),
        body := jsonb_build_object(
          'action', 'scheduled',
          'requestedAt', now()
        ),
        timeout_milliseconds := 60000
      ) as request_id;
    $command$
  );
end;
$schedule$;

comment on schema telephony is
'Tenant-isolated normalized PBX CDR data and Yeastar synchronization history.';
comment on table telephony.call_records is
'Normalized Yeastar CDR records without access tokens or credential material.';
comment on function public.v2_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) is
'Role-protected call reporting snapshot with extension, time, status, and callback analytics.';

commit;
