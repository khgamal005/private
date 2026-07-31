-- Applied migration version: 20260731040230
begin;

update commerce_hub.providers
set adapter_status = 'active',
    capabilities = case provider_key
      when 'salla' then array['products','categories','coupons','orders','customers','webhooks']
      when 'zid' then array['products','categories','coupons','orders','customers','webhooks']
      when 'shopify' then array['products','collections','orders','customers','webhooks']
      when 'custom' then array['products','categories','coupons','orders','customers']
      else capabilities
    end,
    updated_at = now()
where provider_key in ('salla','zid','shopify','custom');

create or replace function public.v2_commerce_hub_finish_test(
  p_connection_id uuid,
  p_success boolean,
  p_identity jsonb default '{}'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_hub.connections%rowtype;
  v_now timestamptz := now();
  v_external_store_id text;
  v_metadata jsonb;
begin
  select * into v_connection
  from commerce_hub.connections connection
  where connection.id = p_connection_id
  for update;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  v_external_store_id := nullif(trim(coalesce(
    p_identity ->> 'externalStoreId',
    v_connection.external_store_id
  )), '');
  v_metadata := coalesce(p_identity -> 'metadata', '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'name', nullif(trim(p_identity ->> 'name'), ''),
      'currency', nullif(trim(p_identity ->> 'currency'), ''),
      'domain', nullif(trim(p_identity ->> 'domain'), ''),
      'testedAt', v_now
    ));

  update commerce_hub.connections
  set status = case when p_success then 'active' else 'error' end,
      external_store_id = case when p_success then v_external_store_id else external_store_id end,
      last_checked_at = v_now,
      next_sync_at = case
        when p_success then private_app.commerce_hub_next_sync(frequency, v_now)
        else null
      end,
      last_error = case when p_success then null else left(nullif(trim(p_error), ''), 1000) end,
      remote_metadata = case when p_success then v_metadata else remote_metadata end
  where id = p_connection_id
  returning * into v_connection;

  update core.integrations
  set status = v_connection.status,
      last_checked_at = v_now,
      configuration = coalesce(configuration, '{}'::jsonb)
        || jsonb_build_object(
          'connectionId', v_connection.id,
          'externalStoreId', v_connection.external_store_id,
          'remoteMetadata', v_connection.remote_metadata
        ),
      updated_at = v_now
  where tenant_id = v_connection.tenant_id
    and system_type = v_connection.provider_key;

  perform private_app.write_audit(
    'commerce.' || v_connection.provider_key || '.connection_tested',
    'commerce_hub_connection',
    v_connection.id::text,
    v_connection.tenant_id,
    jsonb_build_object(
      'providerKey', v_connection.provider_key,
      'success', p_success,
      'externalStoreId', v_connection.external_store_id
    )
  );

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'status', v_connection.status,
    'externalStoreId', v_connection.external_store_id,
    'lastCheckedAt', v_connection.last_checked_at
  );
end;
$$;

revoke all on function public.v2_commerce_hub_finish_test(uuid,boolean,jsonb,text)
from public, anon, authenticated;
grant execute on function public.v2_commerce_hub_finish_test(uuid,boolean,jsonb,text)
to service_role;

commit;
