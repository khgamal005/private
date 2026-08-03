-- Applied migration version: 20260803020100
begin;

create or replace function public.v2_tenant_marketing_hub_action(
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
  v_provider marketing_hub.providers%rowtype;
  v_connection marketing_hub.connections%rowtype;
  v_settings marketing_hub.attribution_settings%rowtype;
  v_actor uuid;
  v_provider_key text;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_frequency text;
  v_lookback integer;
  v_api_version text;
  v_config jsonb;
  v_secret_refs jsonb;
  v_secret_key text;
  v_secret_value text;
  v_existing_secret_id uuid;
  v_saved_secret_id uuid;
  v_allowed_secret_keys text[];
  v_required_secret text;
  v_model text;
  v_click_window integer;
  v_view_window integer;
  v_currency text;
  v_timezone text;
  v_insight marketing_hub.insights%rowtype;
  v_status text;
begin
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception 'marketing_payload_invalid';
  end if;

  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_manage_marketing_hub(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_addon_enabled(
    v_tenant.id,
    'addon.marketing_attribution'
  ) then
    raise exception 'marketing_addon_not_enabled';
  end if;

  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'forbidden'; end if;

  if v_action = 'save_settings' then
    v_model := lower(coalesce(
      nullif(trim(p_payload ->> 'model'), ''),
      'last_non_direct'
    ));
    if v_model not in (
      'last_non_direct',
      'last_touch',
      'first_touch',
      'linear'
    ) then
      raise exception 'marketing_attribution_model_invalid';
    end if;

    v_click_window := coalesce(
      private_app.marketing_try_bigint(
        p_payload ->> 'clickWindowDays'
      )::integer,
      30
    );
    v_view_window := coalesce(
      private_app.marketing_try_bigint(
        p_payload ->> 'viewWindowDays'
      )::integer,
      1
    );
    if v_click_window not between 1 and 180 then
      raise exception 'marketing_click_window_invalid';
    end if;
    if v_view_window not between 0 and 30 then
      raise exception 'marketing_view_window_invalid';
    end if;

    v_currency := upper(coalesce(
      nullif(trim(p_payload ->> 'baseCurrency'), ''),
      'SAR'
    ));
    if v_currency !~ '^[A-Z]{3}$' then
      raise exception 'marketing_currency_invalid';
    end if;

    v_timezone := coalesce(
      nullif(trim(p_payload ->> 'timezone'), ''),
      v_tenant.timezone,
      'Asia/Riyadh'
    );
    if not exists (
      select 1
      from pg_catalog.pg_timezone_names timezone
      where timezone.name = v_timezone
    ) then
      raise exception 'marketing_timezone_invalid';
    end if;

    insert into marketing_hub.attribution_settings (
      tenant_id,
      model,
      click_window_days,
      view_window_days,
      base_currency,
      timezone,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_model,
      v_click_window,
      v_view_window,
      v_currency,
      v_timezone,
      v_actor
    )
    on conflict (tenant_id) do update
    set model = excluded.model,
        click_window_days = excluded.click_window_days,
        view_window_days = excluded.view_window_days,
        base_currency = excluded.base_currency,
        timezone = excluded.timezone,
        updated_by_subject_id = excluded.updated_by_subject_id
    returning * into v_settings;

    perform private_app.write_audit(
      'marketing.attribution.settings_saved',
      'marketing_attribution_settings',
      v_tenant.id::text,
      v_tenant.id,
      jsonb_build_object(
        'model', v_settings.model,
        'clickWindowDays', v_settings.click_window_days,
        'viewWindowDays', v_settings.view_window_days,
        'baseCurrency', v_settings.base_currency,
        'timezone', v_settings.timezone
      )
    );

    return jsonb_build_object(
      'model', v_settings.model,
      'clickWindowDays', v_settings.click_window_days,
      'viewWindowDays', v_settings.view_window_days,
      'baseCurrency', v_settings.base_currency,
      'timezone', v_settings.timezone
    );
  elsif v_action = 'insight_status' then
    begin
      select * into v_insight
      from marketing_hub.insights insight
      where insight.id = (p_payload ->> 'insightId')::uuid
        and insight.tenant_id = v_tenant.id
      for update;
    exception when invalid_text_representation then
      raise exception 'marketing_insight_invalid';
    end;
    if v_insight.id is null then
      raise exception 'marketing_insight_not_found';
    end if;
    v_status := lower(trim(coalesce(p_payload ->> 'status', '')));
    if v_status not in (
      'open',
      'acknowledged',
      'resolved',
      'dismissed'
    ) then
      raise exception 'marketing_insight_status_invalid';
    end if;

    update marketing_hub.insights
    set status = v_status,
        resolved_at = case
          when v_status in ('resolved','dismissed') then now()
          else null
        end
    where id = v_insight.id
    returning * into v_insight;

    perform private_app.write_audit(
      'marketing.insight.' || v_status,
      'marketing_insight',
      v_insight.id::text,
      v_tenant.id,
      jsonb_build_object(
        'insightType', v_insight.insight_type,
        'providerKey', v_insight.provider_key,
        'campaignId', v_insight.campaign_id
      )
    );

    return jsonb_build_object(
      'insightId', v_insight.id,
      'status', v_insight.status
    );
  end if;

  if v_action not in ('save','disable','enable') then
    raise exception 'marketing_action_invalid';
  end if;

  v_provider_key := private_app.marketing_provider_key(p_provider);
  select * into v_provider
  from marketing_hub.providers provider
  where provider.provider_key = v_provider_key
    and provider.status in ('active','beta')
    and provider.adapter_status in ('active','configuration_ready')
  limit 1;
  if v_provider.provider_key is null then
    raise exception 'marketing_provider_unavailable';
  end if;

  select * into v_connection
  from marketing_hub.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = v_provider_key
  for update;

  if v_action = 'save' then
    v_frequency := private_app.marketing_frequency(coalesce(
      nullif(p_payload ->> 'frequency', ''),
      v_connection.frequency,
      'daily'
    ));
    v_lookback := coalesce(
      private_app.marketing_try_bigint(
        p_payload ->> 'syncLookbackDays'
      )::integer,
      v_connection.sync_lookback_days,
      14
    );
    if v_lookback not between 1 and 90 then
      raise exception 'marketing_lookback_invalid';
    end if;

    v_api_version := coalesce(
      nullif(trim(p_payload ->> 'apiVersion'), ''),
      nullif(v_connection.api_version, ''),
      v_provider.default_api_version
    );
    if cardinality(v_provider.supported_api_versions) > 0
       and not (v_api_version = any(v_provider.supported_api_versions)) then
      raise exception 'marketing_api_version_invalid';
    end if;

    v_config := private_app.marketing_valid_config(
      v_provider_key,
      coalesce(p_payload -> 'configuration', '{}'::jsonb)
    );

    insert into marketing_hub.connections (
      tenant_id,
      provider_key,
      display_name,
      status,
      frequency,
      sync_lookback_days,
      api_version,
      configuration,
      next_sync_at,
      last_error_code,
      last_error_detail,
      created_by_subject_id,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_provider_key,
      left(nullif(trim(p_payload ->> 'displayName'), ''), 160),
      'draft',
      v_frequency,
      v_lookback,
      v_api_version,
      v_config,
      null,
      null,
      null,
      v_actor,
      v_actor
    )
    on conflict (tenant_id, provider_key) do update
    set display_name = excluded.display_name,
        status = 'draft',
        frequency = excluded.frequency,
        sync_lookback_days = excluded.sync_lookback_days,
        api_version = excluded.api_version,
        configuration = excluded.configuration,
        next_sync_at = null,
        last_error_code = null,
        last_error_detail = null,
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
          raise exception 'marketing_secret_not_allowed:%', v_secret_key;
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
          'marketing:' || v_provider_key || ':' || v_secret_key,
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
        raise exception 'marketing_required_secret_missing:%',
          v_required_secret;
      end if;
    end loop;

    if v_provider_key = 'google_ads'
       and not (v_secret_refs ? 'accessToken')
       and not (
         v_secret_refs ? 'refreshToken'
         and v_secret_refs ? 'clientId'
         and v_secret_refs ? 'clientSecret'
       ) then
      raise exception 'marketing_google_oauth_credentials_required';
    end if;

    update marketing_hub.connections
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
      'marketing_' || v_provider_key,
      v_provider.name_en,
      v_connection.status,
      jsonb_build_object(
        'connectionId', v_connection.id,
        'providerKey', v_provider_key,
        'frequency', v_connection.frequency,
        'apiVersion', v_connection.api_version,
        'syncLookbackDays', v_connection.sync_lookback_days,
        'configuration', v_connection.configuration
      )
    )
    on conflict (tenant_id, system_type, display_name) do update
    set status = excluded.status,
        configuration = excluded.configuration,
        last_checked_at = null,
        updated_at = now();

    perform private_app.write_audit(
      'marketing.' || v_provider_key || '.settings_saved',
      'marketing_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object(
        'providerKey', v_provider_key,
        'frequency', v_connection.frequency,
        'apiVersion', v_connection.api_version,
        'syncLookbackDays', v_connection.sync_lookback_days,
        'configuredSecrets', (
          select coalesce(
            jsonb_agg(secret.key order by secret.key),
            '[]'::jsonb
          )
          from jsonb_each_text(v_secret_refs) secret
        )
      )
    );

    return jsonb_build_object(
      'connectionId', v_connection.id,
      'providerKey', v_connection.provider_key,
      'status', v_connection.status,
      'frequency', v_connection.frequency,
      'apiVersion', v_connection.api_version,
      'syncLookbackDays', v_connection.sync_lookback_days,
      'configuredSecrets', (
        select coalesce(
          jsonb_agg(secret.key order by secret.key),
          '[]'::jsonb
        )
        from jsonb_each_text(v_secret_refs) secret
      )
    );
  end if;

  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;

  if v_action = 'disable' then
    update marketing_hub.connections
    set status = 'disabled',
        next_sync_at = null,
        last_error_code = null,
        last_error_detail = null,
        updated_by_subject_id = v_actor
    where id = v_connection.id
    returning * into v_connection;
  else
    update marketing_hub.connections
    set status = 'draft',
        next_sync_at = null,
        last_error_code = null,
        last_error_detail = null,
        updated_by_subject_id = v_actor
    where id = v_connection.id
    returning * into v_connection;
  end if;

  update core.integrations
  set status = v_connection.status,
      last_checked_at = now(),
      updated_at = now()
  where tenant_id = v_tenant.id
    and system_type = 'marketing_' || v_provider_key;

  perform private_app.write_audit(
    'marketing.' || v_provider_key || '.' || v_action || 'd',
    'marketing_connection',
    v_connection.id::text,
    v_tenant.id,
    jsonb_build_object(
      'providerKey', v_provider_key,
      'status', v_connection.status
    )
  );

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'status', v_connection.status
  );
end;
$$;

revoke all on function public.v2_tenant_marketing_hub_action(
  text,
  text,
  text,
  jsonb
)
from public, anon;

grant execute on function public.v2_tenant_marketing_hub_action(
  text,
  text,
  text,
  jsonb
)
to authenticated;

commit;
