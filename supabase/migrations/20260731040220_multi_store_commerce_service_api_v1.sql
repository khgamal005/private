-- Applied migration version: 20260731040220
begin;

create or replace function public.v2_commerce_hub_authorize(
  p_tenant_slug text,
  p_provider text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection commerce_hub.connections%rowtype;
  v_provider_key text;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if p_action not in ('test_connection','sync_now','authorize') then
    raise exception 'invalid_commerce_hub_action';
  end if;
  if not private_app.can_manage_commerce_hub(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  v_provider_key := private_app.commerce_hub_provider_key(p_provider);
  if v_provider_key = 'woocommerce' then
    raise exception 'commerce_use_woocommerce_connector';
  end if;

  select * into v_connection
  from commerce_hub.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = v_provider_key
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  if p_action = 'sync_now'
     and v_connection.status not in ('active','degraded') then
    raise exception 'commerce_connection_test_required';
  end if;

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'connectionId', v_connection.id,
    'providerKey', v_provider_key,
    'action', p_action
  );
end;
$$;

create or replace function public.v2_commerce_hub_connection_configuration(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection commerce_hub.connections%rowtype;
  v_secret record;
  v_secret_id uuid;
  v_secrets jsonb := '{}'::jsonb;
begin
  select * into v_connection
  from commerce_hub.connections connection
  where connection.id = p_connection_id
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  for v_secret in
    select secret.key, secret.value
    from jsonb_each_text(v_connection.secret_refs) secret
  loop
    begin
      v_secret_id := v_secret.value::uuid;
    exception when invalid_text_representation then
      raise exception 'commerce_secret_reference_invalid';
    end;

    v_secrets := jsonb_set(
      v_secrets,
      array[v_secret.key],
      to_jsonb(coalesce((
        select decrypted.decrypted_secret
        from vault.decrypted_secrets decrypted
        where decrypted.id = v_secret_id
          and decrypted.name =
            'integration:' || v_connection.tenant_id::text
            || ':' || v_connection.id::text
            || ':' || v_connection.provider_key || ':' || v_secret.key
        limit 1
      ), '')),
      true
    );
  end loop;

  return jsonb_build_object(
    'tenantId', v_connection.tenant_id,
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'status', v_connection.status,
    'frequency', v_connection.frequency,
    'direction', v_connection.direction,
    'sourceOfTruth', v_connection.source_of_truth,
    'conflictPolicy', v_connection.conflict_policy,
    'matchBySku', v_connection.match_by_sku,
    'syncScope', to_jsonb(v_connection.sync_scope),
    'configuration', v_connection.configuration,
    'secrets', v_secrets,
    'lastSyncedAt', v_connection.last_synced_at,
    'remoteMetadata', v_connection.remote_metadata
  );
end;
$$;

create or replace function public.v2_commerce_hub_start_sync(
  p_connection_id uuid,
  p_trigger text,
  p_scope jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_hub.connections%rowtype;
  v_run commerce_hub.sync_runs%rowtype;
  v_scope text[];
  v_key text;
begin
  if p_trigger not in ('manual','scheduled','webhook','recovery') then
    raise exception 'commerce_invalid_sync_trigger';
  end if;
  v_key := nullif(trim(p_idempotency_key), '');
  if v_key is null or length(v_key) > 200 then
    raise exception 'commerce_invalid_idempotency_key';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text, 0));

  select * into v_connection
  from commerce_hub.connections connection
  where connection.id = p_connection_id
    and connection.status in ('active','degraded')
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  update commerce_hub.sync_runs run
  set status = 'failed',
      error_detail = 'sync_lease_expired',
      finished_at = now()
  where run.connection_id = v_connection.id
    and run.status in ('queued','running')
    and run.updated_at < now() - interval '20 minutes';

  v_scope := case
    when p_scope is null or p_scope = 'null'::jsonb
      then v_connection.sync_scope
    else private_app.commerce_hub_scope(p_scope)
  end;

  if not (v_scope <@ v_connection.sync_scope) then
    raise exception 'commerce_scope_not_enabled';
  end if;

  select * into v_run
  from commerce_hub.sync_runs run
  where run.connection_id = v_connection.id
    and run.idempotency_key = v_key
  limit 1;

  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id,
      'duplicate', true,
      'status', v_run.status
    );
  end if;

  select * into v_run
  from commerce_hub.sync_runs run
  where run.connection_id = v_connection.id
    and run.status in ('queued','running')
  order by run.created_at desc
  limit 1;

  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id,
      'duplicate', true,
      'status', v_run.status
    );
  end if;

  insert into commerce_hub.sync_runs (
    tenant_id,
    connection_id,
    trigger_type,
    scope,
    idempotency_key,
    status,
    started_at
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    p_trigger,
    v_scope,
    v_key,
    'running',
    now()
  )
  returning * into v_run;

  update commerce_hub.connections
  set last_error = null
  where id = v_connection.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'duplicate', false,
    'status', v_run.status
  );
end;
$$;

create or replace function public.v2_commerce_hub_finish_sync(
  p_connection_id uuid,
  p_run_id uuid,
  p_status text,
  p_stats jsonb default '{}'::jsonb,
  p_error text default null,
  p_remote_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_hub.connections%rowtype;
  v_run commerce_hub.sync_runs%rowtype;
  v_status text;
  v_now timestamptz := now();
begin
  v_status := lower(trim(coalesce(p_status, '')));
  if v_status not in ('success','partial','failed') then
    raise exception 'commerce_invalid_run_status';
  end if;

  select * into v_connection
  from commerce_hub.connections connection
  where connection.id = p_connection_id
  for update;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select * into v_run
  from commerce_hub.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;
  if v_run.id is null then raise exception 'sync_run_not_found'; end if;

  update commerce_hub.sync_runs
  set status = v_status,
      stats = coalesce(p_stats, '{}'::jsonb),
      fetched_count = coalesce(private_app.commerce_hub_try_bigint(p_stats ->> 'fetchedCount'), fetched_count),
      stored_count = coalesce(private_app.commerce_hub_try_bigint(p_stats ->> 'storedCount'), stored_count),
      created_count = coalesce(private_app.commerce_hub_try_bigint(p_stats ->> 'createdCount'), created_count),
      updated_count = coalesce(private_app.commerce_hub_try_bigint(p_stats ->> 'updatedCount'), updated_count),
      archived_count = coalesce(private_app.commerce_hub_try_bigint(p_stats ->> 'archivedCount'), archived_count),
      failed_count = coalesce(private_app.commerce_hub_try_bigint(p_stats ->> 'failedCount'), failed_count),
      error_detail = nullif(trim(p_error), ''),
      finished_at = v_now
  where id = p_run_id
  returning * into v_run;

  update commerce_hub.connections
  set status = case
        when v_status = 'success' then 'active'
        when v_status = 'partial' then 'degraded'
        else 'error'
      end,
      last_checked_at = v_now,
      last_synced_at = case
        when v_status in ('success','partial') then v_now
        else last_synced_at
      end,
      next_sync_at = case
        when v_status in ('success','partial')
          then private_app.commerce_hub_next_sync(frequency, v_now)
        else null
      end,
      last_error = case
        when v_status = 'failed' then nullif(trim(p_error), '')
        else null
      end,
      remote_metadata = coalesce(p_remote_metadata, '{}'::jsonb)
  where id = p_connection_id;

  return jsonb_build_object(
    'runId', v_run.id,
    'status', v_run.status,
    'finishedAt', v_run.finished_at
  );
end;
$$;

revoke all on function public.v2_commerce_hub_authorize(text,text,text)
from public, anon;
revoke all on function public.v2_commerce_hub_connection_configuration(uuid)
from public, anon, authenticated;
revoke all on function public.v2_commerce_hub_start_sync(uuid,text,jsonb,text)
from public, anon, authenticated;
revoke all on function public.v2_commerce_hub_finish_sync(uuid,uuid,text,jsonb,text,jsonb)
from public, anon, authenticated;

grant execute on function public.v2_commerce_hub_authorize(text,text,text)
to authenticated;
grant execute on function public.v2_commerce_hub_connection_configuration(uuid)
to service_role;
grant execute on function public.v2_commerce_hub_start_sync(uuid,text,jsonb,text)
to service_role;
grant execute on function public.v2_commerce_hub_finish_sync(uuid,uuid,text,jsonb,text,jsonb)
to service_role;

commit;
