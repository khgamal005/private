-- Applied migration version: 20260731040200
begin;

create or replace function public.v2_tenant_commerce_hub_snapshot(
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
  v_can_manage boolean;
  v_woocommerce jsonb;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(v_tenant.id, 'tenant.academy.read') then
    raise exception 'forbidden';
  end if;

  v_can_manage := private_app.can_manage_commerce_hub(v_tenant.id);

  begin
    v_woocommerce := public.v2_tenant_woocommerce_snapshot(p_slug);
  exception when undefined_function then
    v_woocommerce := jsonb_build_object(
      'configured', false,
      'featureEnabled', false,
      'connection', null,
      'courses', '[]'::jsonb,
      'counts', '{}'::jsonb,
      'recentRuns', '[]'::jsonb
    );
  end;

  return jsonb_build_object(
    'generatedAt', now(),
    'tenantId', v_tenant.id,
    'canManage', v_can_manage,
    'woocommerce', v_woocommerce,
    'courses', coalesce(v_woocommerce -> 'courses', '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'providerKey', provider.provider_key,
          'nameAr', provider.name_ar,
          'nameEn', provider.name_en,
          'descriptionAr', provider.description_ar,
          'authMode', provider.auth_mode,
          'setupMode', provider.setup_mode,
          'adapterStatus', provider.adapter_status,
          'capabilities', to_jsonb(provider.capabilities),
          'requiredConfigKeys', to_jsonb(provider.required_config_keys),
          'requiredSecretKeys', to_jsonb(provider.required_secret_keys),
          'optionalSecretKeys', to_jsonb(provider.optional_secret_keys),
          'providerStatus', provider.status,
          'featureEnabled', case provider.provider_key
            when 'woocommerce' then coalesce(
              (v_woocommerce ->> 'featureEnabled')::boolean,
              false
            )
            when 'salla' then private_app.tenant_addon_enabled(
              v_tenant.id,
              'addon.integration.salla'
            )
            when 'zid' then private_app.tenant_addon_enabled(
              v_tenant.id,
              'addon.integration.zid'
            )
            when 'shopify' then private_app.tenant_addon_enabled(
              v_tenant.id,
              'addon.integration.shopify'
            )
            else private_app.tenant_addon_enabled(
              v_tenant.id,
              'addon.integration.custom_store'
            )
          end,
          'connection', case
            when provider.provider_key = 'woocommerce'
              then v_woocommerce -> 'connection'
            when connection.id is null then null
            else jsonb_build_object(
              'connectionId', connection.id,
              'displayName', connection.display_name,
              'status', connection.status,
              'frequency', connection.frequency,
              'direction', connection.direction,
              'sourceOfTruth', connection.source_of_truth,
              'conflictPolicy', connection.conflict_policy,
              'matchBySku', connection.match_by_sku,
              'syncScope', to_jsonb(connection.sync_scope),
              'configuration', connection.configuration,
              'configuredSecrets', (
                select coalesce(
                  jsonb_agg(secret.key order by secret.key),
                  '[]'::jsonb
                )
                from jsonb_each_text(connection.secret_refs) secret
              ),
              'externalStoreId', connection.external_store_id,
              'lastCheckedAt', connection.last_checked_at,
              'lastSyncedAt', connection.last_synced_at,
              'nextSyncAt', connection.next_sync_at,
              'lastError', connection.last_error,
              'remoteMetadata', connection.remote_metadata
            )
          end,
          'recentRuns', case
            when provider.provider_key = 'woocommerce'
              then coalesce(v_woocommerce -> 'recentRuns', '[]'::jsonb)
            else coalesce((
              select jsonb_agg(
                jsonb_build_object(
                  'runId', run.id,
                  'trigger', run.trigger_type,
                  'scope', to_jsonb(run.scope),
                  'status', run.status,
                  'fetchedCount', run.fetched_count,
                  'storedCount', run.stored_count,
                  'createdCount', run.created_count,
                  'updatedCount', run.updated_count,
                  'archivedCount', run.archived_count,
                  'failedCount', run.failed_count,
                  'stats', run.stats,
                  'error', run.error_detail,
                  'startedAt', run.started_at,
                  'finishedAt', run.finished_at
                )
                order by run.created_at desc
              )
              from (
                select recent.*
                from commerce_hub.sync_runs recent
                where recent.connection_id = connection.id
                order by recent.created_at desc
                limit 8
              ) run
            ), '[]'::jsonb)
          end
        )
        order by provider.sort_order
      )
      from commerce_hub.providers provider
      left join commerce_hub.connections connection
        on connection.tenant_id = v_tenant.id
       and connection.provider_key = provider.provider_key
      where provider.status <> 'disabled'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.v2_tenant_commerce_hub_snapshot(text)
from public, anon;
grant execute on function public.v2_tenant_commerce_hub_snapshot(text)
to authenticated;

commit;
