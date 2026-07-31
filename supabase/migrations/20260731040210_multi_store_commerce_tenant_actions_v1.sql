-- Applied migration version: 20260731040210
begin;

create or replace function public.v2_tenant_commerce_hub_action(
  p_tenant_slug text,
  p_provider text,
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
  v_provider commerce_hub.providers%rowtype;
  v_connection commerce_hub.connections%rowtype;
  v_actor_subject_id uuid;
  v_provider_key text;
  v_frequency text;
  v_scope text[];
  v_config jsonb;
  v_direction text;
  v_source_of_truth text;
  v_conflict_policy text;
  v_match_by_sku boolean;
  v_secret_refs jsonb;
  v_secret_key text;
  v_secret_value text;
  v_existing_secret_id uuid;
  v_saved_secret_id uuid;
  v_allowed_secret_keys text[];
  v_required_secret text;
  v_feature_key text;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_manage_commerce_hub(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  v_provider_key := private_app.commerce_hub_provider_key(p_provider);
  if v_provider_key = 'woocommerce' then
    raise exception 'commerce_use_woocommerce_connector';
  end if;

  select * into v_provider
  from commerce_hub.providers provider
  where provider.provider_key = v_provider_key;

  v_feature_key := case v_provider_key
    when 'salla' then 'addon.integration.salla'
    when 'zid' then 'addon.integration.zid'
    when 'shopify' then 'addon.integration.shopify'
    else 'addon.integration.custom_store'
  end;

  if p_action = 'save'
     and not private_app.tenant_addon_enabled(v_tenant.id, v_feature_key) then
    raise exception 'integration_addon_not_enabled';
  end if;

  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;

  select * into v_connection
  from commerce_hub.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = v_provider_key
  for update;

  if p_action = 'save' then
    v_frequency := private_app.commerce_hub_frequency(
      coalesce(
        nullif(p_payload ->> 'frequency', ''),
        v_connection.frequency,
        'weekly'
      )
    );
    v_scope := private_app.commerce_hub_scope(
      case
        when jsonb_typeof(p_payload -> 'syncScope') = 'array'
          then p_payload -> 'syncScope'
        when v_connection.id is not null
          then to_jsonb(v_connection.sync_scope)
        else jsonb_build_array('products','categories','coupons','orders','customers')
      end
    );
    if not (v_scope <@ v_provider.capabilities) then
      raise exception 'commerce_scope_not_supported_by_provider';
    end if;
    v_config := private_app.commerce_hub_valid_config(
      v_provider_key,
      coalesce(p_payload -> 'configuration', '{}'::jsonb)
    );
    v_direction := lower(coalesce(
      nullif(trim(p_payload ->> 'direction'), ''),
      coalesce(v_connection.direction, 'inbound')
    ));
    if v_direction not in ('inbound','outbound','bidirectional') then
      raise exception 'commerce_invalid_direction';
    end if;
    v_source_of_truth := lower(coalesce(
      nullif(trim(p_payload ->> 'sourceOfTruth'), ''),
      coalesce(v_connection.source_of_truth, 'remote')
    ));
    if v_source_of_truth not in ('remote','marktone','latest_update') then
      raise exception 'commerce_invalid_source_of_truth';
    end if;
    v_conflict_policy := lower(coalesce(
      nullif(trim(p_payload ->> 'conflictPolicy'), ''),
      coalesce(v_connection.conflict_policy, 'remote_wins')
    ));
    if v_conflict_policy not in (
      'remote_wins','marktone_wins','latest_update','manual_review'
    ) then
      raise exception 'commerce_invalid_conflict_policy';
    end if;
    v_match_by_sku := case
      when jsonb_typeof(p_payload -> 'matchBySku') = 'boolean'
        then (p_payload ->> 'matchBySku')::boolean
      else coalesce(v_connection.match_by_sku, false)
    end;

    insert into commerce_hub.connections (
      tenant_id,
      provider_key,
      display_name,
      status,
      frequency,
      direction,
      source_of_truth,
      conflict_policy,
      match_by_sku,
      sync_scope,
      configuration,
      external_store_id,
      next_sync_at,
      last_error,
      created_by_subject_id,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_provider_key,
      nullif(trim(p_payload ->> 'displayName'), ''),
      'draft',
      v_frequency,
      v_direction,
      v_source_of_truth,
      v_conflict_policy,
      v_match_by_sku,
      v_scope,
      v_config,
      nullif(trim(coalesce(
        v_config ->> 'storeId',
        v_config ->> 'shopDomain',
        v_config ->> 'baseUrl'
      )), ''),
      null,
      null,
      v_actor_subject_id,
      v_actor_subject_id
    )
    on conflict (tenant_id, provider_key) do update
    set display_name = excluded.display_name,
        status = excluded.status,
        frequency = excluded.frequency,
        direction = excluded.direction,
        source_of_truth = excluded.source_of_truth,
        conflict_policy = excluded.conflict_policy,
        match_by_sku = excluded.match_by_sku,
        sync_scope = excluded.sync_scope,
        configuration = excluded.configuration,
        external_store_id = excluded.external_store_id,
        next_sync_at = null,
        last_error = null,
        updated_by_subject_id = excluded.updated_by_subject_id
    returning * into v_connection;

    v_secret_refs := coalesce(v_connection.secret_refs, '{}'::jsonb);
    v_allowed_secret_keys := v_provider.required_secret_keys
      || v_provider.optional_secret_keys;

    if jsonb_typeof(p_payload -> 'secrets') = 'object' then
      for v_secret_key, v_secret_value in
        select secret.key, nullif(trim(secret.value), '')
        from jsonb_each_text(p_payload -> 'secrets') secret
      loop
        if v_secret_value is null then continue; end if;
        if not (v_secret_key = any(v_allowed_secret_keys)) then
          raise exception 'commerce_secret_not_allowed:%', v_secret_key;
        end if;

        begin
          v_existing_secret_id :=
            nullif(v_secret_refs ->> v_secret_key, '')::uuid;
        exception when invalid_text_representation then
          v_existing_secret_id := null;
        end;

        v_saved_secret_id := private_app.integration_secret_upsert(
          v_tenant.id,
          v_connection.id,
          v_provider_key || ':' || v_secret_key,
          v_secret_value,
          v_existing_secret_id
        );
        v_secret_refs := jsonb_set(
          v_secret_refs,
          array[v_secret_key],
          to_jsonb(v_saved_secret_id::text),
          true
        );
      end loop;
    end if;

    foreach v_required_secret in array v_provider.required_secret_keys loop
      if not (v_secret_refs ? v_required_secret) then
        raise exception 'commerce_required_secret_missing:%', v_required_secret;
      end if;
    end loop;

    if v_provider_key = 'custom'
       and lower(v_config ->> 'authType') = 'api_key'
       and not (v_secret_refs ? 'apiKey') then
      raise exception 'commerce_required_secret_missing:apiKey';
    elsif v_provider_key = 'custom'
       and lower(v_config ->> 'authType') = 'bearer'
       and not (v_secret_refs ? 'bearerToken') then
      raise exception 'commerce_required_secret_missing:bearerToken';
    elsif v_provider_key = 'custom'
       and lower(v_config ->> 'authType') = 'basic'
       and (
         not (v_secret_refs ? 'basicUsername')
         or not (v_secret_refs ? 'basicPassword')
       ) then
      raise exception 'commerce_required_secret_missing:basic_credentials';
    end if;

    update commerce_hub.connections
    set secret_refs = v_secret_refs
    where id = v_connection.id
    returning * into v_connection;

    insert into core.integrations (
      tenant_id,
      system_type,
      display_name,
      status,
      configuration
    )
    values (
      v_tenant.id,
      v_provider_key,
      v_provider.name_en,
      v_connection.status,
      jsonb_build_object(
        'connectionId', v_connection.id,
        'providerKey', v_provider_key,
        'frequency', v_connection.frequency,
        'direction', v_connection.direction,
        'sourceOfTruth', v_connection.source_of_truth,
        'conflictPolicy', v_connection.conflict_policy,
        'matchBySku', v_connection.match_by_sku,
        'syncScope', to_jsonb(v_connection.sync_scope),
        'configuration', v_connection.configuration
      )
    )
    on conflict (tenant_id, system_type, display_name) do update
    set status = excluded.status,
        configuration = excluded.configuration,
        last_checked_at = null,
        updated_at = now();

    perform private_app.write_audit(
      'commerce.' || v_provider_key || '.settings_saved',
      'commerce_hub_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object(
        'providerKey', v_provider_key,
        'frequency', v_connection.frequency,
        'direction', v_connection.direction,
        'sourceOfTruth', v_connection.source_of_truth,
        'syncScope', to_jsonb(v_connection.sync_scope)
      )
    );

    return jsonb_build_object(
      'connectionId', v_connection.id,
      'providerKey', v_provider_key,
      'status', v_connection.status,
      'frequency', v_connection.frequency,
      'direction', v_connection.direction,
      'sourceOfTruth', v_connection.source_of_truth,
      'conflictPolicy', v_connection.conflict_policy,
      'syncScope', to_jsonb(v_connection.sync_scope),
      'configuredSecrets', (
        select coalesce(jsonb_agg(secret.key order by secret.key), '[]'::jsonb)
        from jsonb_each_text(v_connection.secret_refs) secret
      )
    );
  elsif p_action = 'disable' then
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;

    update commerce_hub.connections
    set status = 'disabled',
        next_sync_at = null,
        last_error = null,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection.id;

    update core.integrations
    set status = 'disabled',
        last_checked_at = now(),
        updated_at = now()
    where tenant_id = v_tenant.id
      and system_type = v_provider_key;

    perform private_app.write_audit(
      'commerce.' || v_provider_key || '.disabled',
      'commerce_hub_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object('providerKey', v_provider_key)
    );

    return jsonb_build_object(
      'connectionId', v_connection.id,
      'providerKey', v_provider_key,
      'status', 'disabled'
    );
  elsif p_action = 'enable' then
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;

    update commerce_hub.connections
    set status = 'draft',
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection.id
    returning * into v_connection;

    update core.integrations
    set status = v_connection.status,
        updated_at = now()
    where tenant_id = v_tenant.id
      and system_type = v_provider_key;

    return jsonb_build_object(
      'connectionId', v_connection.id,
      'providerKey', v_provider_key,
      'status', v_connection.status
    );
  else
    raise exception 'invalid_commerce_hub_action';
  end if;
end;
$$;

revoke all on function public.v2_tenant_commerce_hub_action(text,text,text,jsonb)
from public, anon;
grant execute on function public.v2_tenant_commerce_hub_action(text,text,text,jsonb)
to authenticated;

commit;
