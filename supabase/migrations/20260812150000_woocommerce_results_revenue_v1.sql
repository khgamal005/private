-- Make WooCommerce results visible, reconcile executive revenue with the
-- store's own Analytics report, and recover the deployment cutover gap.
begin;

-- The worker needs the connection timezone to request the same month-to-date
-- window that the tenant sees in WooCommerce Analytics. Vault values remain
-- service-only and are never included in tenant snapshots.
create or replace function public.v2_woocommerce_connection_configuration(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_consumer_key_id uuid;
  v_consumer_secret_id uuid;
  v_consumer_key text;
  v_consumer_secret text;
begin
  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  begin
    v_consumer_key_id :=
      nullif(v_connection.secret_refs ->> 'consumerKey', '')::uuid;
    v_consumer_secret_id :=
      nullif(v_connection.secret_refs ->> 'consumerSecret', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'woocommerce_credentials_required';
  end;

  select secret.decrypted_secret
  into v_consumer_key
  from vault.decrypted_secrets secret
  where secret.id = v_consumer_key_id
    and secret.name =
      'integration:' || v_connection.tenant_id::text
      || ':' || v_connection.id::text
      || ':woocommerceConsumerKey'
  limit 1;

  select secret.decrypted_secret
  into v_consumer_secret
  from vault.decrypted_secrets secret
  where secret.id = v_consumer_secret_id
    and secret.name =
      'integration:' || v_connection.tenant_id::text
      || ':' || v_connection.id::text
      || ':woocommerceConsumerSecret'
  limit 1;

  if nullif(v_consumer_key, '') is null
     or nullif(v_consumer_secret, '') is null
  then
    raise exception 'woocommerce_credentials_required';
  end if;

  return jsonb_build_object(
    'tenantId', v_connection.tenant_id,
    'connectionId', v_connection.id,
    'storeUrl', v_connection.store_url,
    'status', v_connection.status,
    'frequency', v_connection.frequency,
    'matchBySku', v_connection.match_by_sku,
    'syncScope', to_jsonb(v_connection.sync_scope),
    'syncTime', to_char(v_connection.sync_time_local, 'HH24:MI'),
    'syncTimezone', coalesce(
      nullif(v_connection.sync_timezone, ''),
      'UTC'
    ),
    'consumerKey', v_consumer_key,
    'consumerSecret', v_consumer_secret,
    'lastSyncedAt', v_connection.last_synced_at,
    'remoteMetadata', v_connection.remote_metadata
  );
end;
$$;

revoke all on function public.v2_woocommerce_connection_configuration(uuid)
from public, anon, authenticated;

-- The routing feature was enabled between two successful syncs. Move its
-- fence back only to the last successful run before enablement, and only for
-- tenants that have not routed an order yet. This recovers the narrow cutover
-- gap without backfilling older WooCommerce history.
with previous_success as (
  select
    settings.tenant_id,
    max(run.finished_at) as safe_cutover
  from sales_core.commerce_order_routing_settings settings
  join commerce_sync.connections connection
    on connection.tenant_id = settings.tenant_id
  join commerce_sync.sync_runs run
    on run.connection_id = connection.id
   and run.tenant_id = connection.tenant_id
  where run.status = 'success'
    and run.finished_at is not null
    and run.finished_at < settings.enabled_at
    and 'orders' = any(run.scope)
    and not exists (
      select 1
      from sales_core.commerce_order_work_items work_item
      where work_item.tenant_id = settings.tenant_id
    )
  group by settings.tenant_id
)
update sales_core.commerce_order_routing_settings settings
set enabled_at = previous.safe_cutover,
    updated_at = clock_timestamp()
from previous_success previous
where settings.tenant_id = previous.tenant_id
  and previous.safe_cutover is not null
  and previous.safe_cutover < settings.enabled_at;

-- Keep verified admissions as their own operational metric, while exposing
-- WooCommerce's authoritative Analytics totals separately to executives.
create or replace function public.v2_tenant_role_dashboard_snapshot_v5(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_tenant core.tenants%rowtype;
  v_connection commerce_sync.connections%rowtype;
  v_role_key text;
  v_report jsonb := '{}'::jsonb;
  v_period_key text;
  v_report_available boolean := false;
  v_revenue jsonb;
begin
  v_snapshot := public.v2_tenant_role_dashboard_snapshot_v4(p_slug);

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  v_role_key := coalesce(
    nullif(v_snapshot #>> '{viewer,roleKey}', ''),
    'tenant_user'
  );
  if v_role_key not in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  ) then
    return v_snapshot;
  end if;

  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled'
  order by connection.updated_at desc, connection.id
  limit 1;

  if v_connection.id is not null then
    v_report := coalesce(
      v_connection.remote_metadata -> 'revenueReport',
      '{}'::jsonb
    );
    v_period_key := to_char(
      now() at time zone coalesce(
        nullif(v_connection.sync_timezone, ''),
        nullif(v_tenant.timezone, ''),
        'UTC'
      ),
      'YYYY-MM'
    );
    v_report_available :=
      lower(coalesce(v_report ->> 'available', 'false')) = 'true'
      and v_report ->> 'periodKey' = v_period_key
      and 'orders' = any(v_connection.sync_scope);
  end if;

  v_revenue := jsonb_build_object(
    'available', v_report_available,
    'connected', v_connection.id is not null,
    'source', 'woocommerce_analytics',
    'periodKey', coalesce(v_report ->> 'periodKey', v_period_key),
    'currency', coalesce(
      nullif(v_report ->> 'currency', ''),
      nullif(v_connection.remote_metadata ->> 'currency', ''),
      'SAR'
    ),
    'minorDigits', coalesce(
      private_app.woocommerce_try_bigint(v_report ->> 'minorDigits'),
      2
    ),
    'timeZone', coalesce(
      nullif(v_report ->> 'timeZone', ''),
      nullif(v_connection.sync_timezone, ''),
      nullif(v_tenant.timezone, ''),
      'UTC'
    ),
    'fetchedAt', v_report ->> 'fetchedAt',
    'lastSyncedAt', v_connection.last_synced_at,
    'stale', v_connection.last_synced_at is null
      or v_connection.last_synced_at < now() - interval '36 hours',
    'error', case
      when v_report_available then null
      else v_report ->> 'error'
    end,
    'totals', coalesce(v_report -> 'totals', '{}'::jsonb)
  );

  return jsonb_set(
    v_snapshot,
    '{executive}',
    coalesce(v_snapshot -> 'executive', '{}'::jsonb)
      || jsonb_build_object('woocommerceRevenue', v_revenue),
    true
  );
end;
$$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v5(text)
from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v5(text)
to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot_v5(text) is
  'Role dashboard with separate verified-admission payments and authoritative month-to-date WooCommerce Analytics revenue.';

commit;
