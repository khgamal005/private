-- Keep platform-reported outcomes visible beside verified CRM outcomes.
begin;

create or replace function public.v2_tenant_marketing_hub_snapshot(
  p_slug text,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_settings marketing_hub.attribution_settings%rowtype;
  v_from date := coalesce(p_from, current_date - 29);
  v_to date := coalesce(p_to, current_date);
  v_feature_enabled boolean;
  v_can_manage boolean;
  v_providers jsonb := '[]'::jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_campaigns jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_funnel jsonb := '[]'::jsonb;
  v_insights jsonb := '[]'::jsonb;
  v_store_sources jsonb := '[]'::jsonb;
  v_data_health jsonb := '{}'::jsonb;
begin
  if v_to < v_from or v_to - v_from > 366 then
    raise exception 'marketing_snapshot_range_invalid';
  end if;

  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_read_marketing_hub(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  v_feature_enabled := private_app.tenant_addon_enabled(
    v_tenant.id,
    'addon.marketing_attribution'
  );
  v_can_manage := private_app.can_manage_marketing_hub(v_tenant.id);

  select * into v_settings
  from marketing_hub.attribution_settings settings
  where settings.tenant_id = v_tenant.id;
  if v_settings.tenant_id is null then
    v_settings.tenant_id := v_tenant.id;
    v_settings.model := 'last_non_direct';
    v_settings.click_window_days := 30;
    v_settings.view_window_days := 1;
    v_settings.base_currency := upper(coalesce(
      nullif(v_tenant.settings ->> 'currency', ''),
      'SAR'
    ));
    v_settings.timezone := coalesce(v_tenant.timezone, 'Asia/Riyadh');
  end if;

  v_providers := (
    select coalesce(jsonb_agg(jsonb_build_object(
    'providerKey', provider.provider_key,
    'nameAr', provider.name_ar,
    'nameEn', provider.name_en,
    'descriptionAr', provider.description_ar,
    'setupMode', provider.setup_mode,
    'adapterStatus', provider.adapter_status,
    'apiVersion', coalesce(
      connection.api_version,
      provider.default_api_version
    ),
    'supportedApiVersions', to_jsonb(provider.supported_api_versions),
    'capabilities', to_jsonb(provider.capabilities),
    'requiredConfigKeys', to_jsonb(provider.required_config_keys),
    'optionalConfigKeys', to_jsonb(provider.optional_config_keys),
    'requiredSecretKeys', to_jsonb(provider.required_secret_keys),
    'optionalSecretKeys', to_jsonb(provider.optional_secret_keys),
    'documentationUrl', provider.documentation_url,
    'connection', case
      when connection.id is null then null
      else jsonb_build_object(
        'connectionId', connection.id,
        'displayName', connection.display_name,
        'status', connection.status,
        'frequency', connection.frequency,
        'syncLookbackDays', connection.sync_lookback_days,
        'apiVersion', connection.api_version,
        'configuration', connection.configuration,
        'configuredSecrets', (
          select coalesce(
            jsonb_agg(secret.key order by secret.key),
            '[]'::jsonb
          )
          from jsonb_each_text(connection.secret_refs) secret
        ),
        'lastCheckedAt', connection.last_checked_at,
        'lastSyncedAt', connection.last_synced_at,
        'nextSyncAt', connection.next_sync_at,
        'lastErrorCode', connection.last_error_code,
        'accountCount', (
          select count(*)
          from marketing_hub.ad_accounts account
          where account.connection_id = connection.id
            and account.is_selected
        ),
        'accounts', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', account.id,
            'externalAccountId', account.external_account_id,
            'name', account.name,
            'currency', account.currency,
            'timezone', account.timezone,
            'status', account.status,
            'lastSyncedAt', account.last_synced_at
          ) order by account.name), '[]'::jsonb)
          from marketing_hub.ad_accounts account
          where account.connection_id = connection.id
            and account.is_selected
        ),
        'recentRuns', (
          select coalesce(jsonb_agg(run_row.value order by run_row.created_at desc), '[]'::jsonb)
          from (
            select
              run.created_at,
              jsonb_build_object(
                'id', run.id,
                'status', run.status,
                'triggerType', run.trigger_type,
                'dateFrom', run.date_from,
                'dateTo', run.date_to,
                'stats', run.stats,
                'errorCode', run.error_code,
                'startedAt', run.started_at,
                'finishedAt', run.finished_at
              ) as value
            from marketing_hub.sync_runs run
            where run.connection_id = connection.id
            order by run.created_at desc
            limit 5
          ) run_row
        )
      )
      end
    ) order by provider.sort_order, provider.provider_key), '[]'::jsonb)
    from marketing_hub.providers provider
    left join marketing_hub.connections connection
      on connection.tenant_id = v_tenant.id
     and connection.provider_key = provider.provider_key
    where provider.status in ('active','beta')
  );

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
      and metric.currency = v_settings.base_currency
  ), selected_metrics as (
    select *
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
  ), performance as (
    select
      coalesce(sum(metric.impressions), 0)::bigint as impressions,
      coalesce(sum(metric.reach), 0)::bigint as reach,
      coalesce(sum(metric.clicks), 0)::bigint as clicks,
      coalesce(sum(metric.link_clicks), 0)::bigint as link_clicks,
      coalesce(sum(metric.spend_minor), 0)::bigint as spend_minor,
      coalesce(sum(metric.platform_leads), 0)::numeric
        as platform_leads,
      coalesce(sum(metric.platform_conversions), 0)::numeric
        as platform_conversions,
      coalesce(sum(metric.platform_revenue_minor), 0)::bigint
        as platform_revenue_minor
    from selected_metrics metric
  ), attributed as (
    select
      count(distinct conversion.id) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )::integer as leads,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'qualified_lead'
          and conversion.status = 'active'
      )::integer as qualified_leads,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )::integer as sales,
      count(distinct conversion.id) filter (
        where conversion.status = 'refunded'
      )::integer as refunds,
      coalesce(sum(attribution.attributed_revenue_minor) filter (
        where conversion.currency = v_settings.base_currency
      ), 0)::bigint as revenue_minor,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status <> 'cancelled'
      )::integer as revenue_events,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status <> 'cancelled'
          and attribution.confidence <> 'untracked'
      )::integer as tracked_revenue_events
    from marketing_hub.conversion_events conversion
    left join marketing_hub.attributions attribution
      on attribution.conversion_event_id = conversion.id
     and attribution.model = v_settings.model
    where conversion.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to
  )
  select jsonb_build_object(
    'currency', v_settings.base_currency,
    'impressions', performance.impressions,
    'reach', performance.reach,
    'clicks', performance.clicks,
    'linkClicks', performance.link_clicks,
    'spendMinor', performance.spend_minor,
    'platformLeads', round(performance.platform_leads, 2),
    'platformConversions', round(performance.platform_conversions, 2),
    'platformRevenueMinor', performance.platform_revenue_minor,
    'platformRoas', case
      when performance.spend_minor > 0 then round(
        performance.platform_revenue_minor::numeric
          / performance.spend_minor,
        3
      )
      else null
    end,
    'platformCplMinor', case
      when performance.platform_leads > 0 then round(
        performance.spend_minor::numeric / performance.platform_leads
      )
      else null
    end,
    'platformCostPerConversionMinor', case
      when performance.platform_conversions > 0 then round(
        performance.spend_minor::numeric
          / performance.platform_conversions
      )
      else null
    end,
    'leads', attributed.leads,
    'qualifiedLeads', attributed.qualified_leads,
    'sales', attributed.sales,
    'refunds', attributed.refunds,
    'revenueMinor', attributed.revenue_minor,
    'roas', case
      when performance.spend_minor > 0 then round(
        attributed.revenue_minor::numeric / performance.spend_minor,
        3
      )
      else null
    end,
    'ctr', case
      when performance.impressions > 0 then round(
        100.0 * performance.clicks / performance.impressions,
        2
      )
      else null
    end,
    'cpcMinor', case
      when performance.clicks > 0
        then round(performance.spend_minor::numeric / performance.clicks)
      else null
    end,
    'cplMinor', case
      when attributed.leads > 0
        then round(performance.spend_minor::numeric / attributed.leads)
      else null
    end,
    'cacMinor', case
      when attributed.sales > 0
        then round(performance.spend_minor::numeric / attributed.sales)
      else null
    end,
    'conversionRate', case
      when attributed.leads > 0 then round(
        100.0 * attributed.sales / attributed.leads,
        2
      )
      else null
    end,
    'attributionCoverageRate', case
      when attributed.revenue_events > 0 then round(
        100.0 * attributed.tracked_revenue_events
          / attributed.revenue_events,
        2
      )
      else null
    end
  )
  into v_summary
  from performance, attributed;

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
  ), performance as (
    select
      metric.campaign_id,
      metric.currency,
      sum(metric.impressions)::bigint as impressions,
      sum(metric.clicks)::bigint as clicks,
      sum(metric.link_clicks)::bigint as link_clicks,
      sum(metric.spend_minor)::bigint as spend_minor,
      sum(metric.platform_leads)::numeric as platform_leads,
      sum(metric.platform_conversions)::numeric as platform_conversions,
      sum(metric.platform_revenue_minor)::bigint as platform_revenue_minor
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
    group by metric.campaign_id, metric.currency
  ), attributed as (
    select
      attribution.campaign_id,
      conversion.currency,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )::integer as leads,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'qualified_lead'
          and conversion.status = 'active'
      )::integer as qualified_leads,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )::integer as sales,
      count(distinct conversion.id) filter (
        where conversion.status = 'refunded'
      )::integer as refunds,
      sum(attribution.attributed_revenue_minor)::bigint as revenue_minor,
      round(avg(attribution.confidence_score), 0)::integer
        as confidence_score
    from marketing_hub.attributions attribution
    join marketing_hub.conversion_events conversion
      on conversion.id = attribution.conversion_event_id
    where attribution.tenant_id = v_tenant.id
      and attribution.model = v_settings.model
      and conversion.occurred_at::date between v_from and v_to
    group by attribution.campaign_id, conversion.currency
  ), rows as (
    select
      campaign.id,
      campaign.provider_key,
      campaign.external_campaign_id,
      campaign.name,
      campaign.objective,
      campaign.status,
      campaign.effective_status,
      account.name as account_name,
      coalesce(performance.currency, attributed.currency, account.currency)
        as currency,
      coalesce(performance.impressions, 0) as impressions,
      coalesce(performance.clicks, 0) as clicks,
      coalesce(performance.link_clicks, 0) as link_clicks,
      coalesce(performance.spend_minor, 0) as spend_minor,
      coalesce(performance.platform_leads, 0) as platform_leads,
      coalesce(performance.platform_conversions, 0)
        as platform_conversions,
      coalesce(performance.platform_revenue_minor, 0)
        as platform_revenue_minor,
      coalesce(attributed.leads, 0) as leads,
      coalesce(attributed.qualified_leads, 0) as qualified_leads,
      coalesce(attributed.sales, 0) as sales,
      coalesce(attributed.refunds, 0) as refunds,
      coalesce(attributed.revenue_minor, 0) as revenue_minor,
      attributed.confidence_score
    from marketing_hub.campaigns campaign
    join marketing_hub.ad_accounts account
      on account.id = campaign.ad_account_id
    left join performance
      on performance.campaign_id = campaign.id
    left join attributed
      on attributed.campaign_id = campaign.id
     and attributed.currency = coalesce(performance.currency, account.currency)
    where campaign.tenant_id = v_tenant.id
      and (
        performance.campaign_id is not null
        or attributed.campaign_id is not null
        or campaign.status in ('active','enabled')
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rows.id,
    'providerKey', rows.provider_key,
    'externalCampaignId', rows.external_campaign_id,
    'name', rows.name,
    'objective', rows.objective,
    'status', rows.status,
    'effectiveStatus', rows.effective_status,
    'accountName', rows.account_name,
    'currency', rows.currency,
    'impressions', rows.impressions,
    'clicks', rows.clicks,
    'linkClicks', rows.link_clicks,
    'spendMinor', rows.spend_minor,
    'platformLeads', round(rows.platform_leads, 2),
    'platformConversions', round(rows.platform_conversions, 2),
    'platformRevenueMinor', rows.platform_revenue_minor,
    'platformRoas', case
      when rows.spend_minor > 0 then round(
        rows.platform_revenue_minor::numeric / rows.spend_minor,
        3
      )
      else null
    end,
    'platformCplMinor', case
      when rows.platform_leads > 0
        then round(rows.spend_minor::numeric / rows.platform_leads)
      else null
    end,
    'platformCostPerConversionMinor', case
      when rows.platform_conversions > 0 then round(
        rows.spend_minor::numeric / rows.platform_conversions
      )
      else null
    end,
    'leads', rows.leads,
    'qualifiedLeads', rows.qualified_leads,
    'sales', rows.sales,
    'refunds', rows.refunds,
    'revenueMinor', rows.revenue_minor,
    'confidenceScore', rows.confidence_score,
    'roas', case
      when rows.spend_minor > 0
        then round(rows.revenue_minor::numeric / rows.spend_minor, 3)
      else null
    end,
    'ctr', case
      when rows.impressions > 0
        then round(100.0 * rows.clicks / rows.impressions, 2)
      else null
    end,
    'cplMinor', case
      when rows.leads > 0
        then round(rows.spend_minor::numeric / rows.leads)
      else null
    end,
    'cacMinor', case
      when rows.sales > 0
        then round(rows.spend_minor::numeric / rows.sales)
      else null
    end
  ) order by rows.spend_minor desc, rows.revenue_minor desc, rows.name), '[]'::jsonb)
  into v_campaigns
  from rows;

  with campaign_rows as (
    select value
    from jsonb_array_elements(v_campaigns) value
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'providerKey', source.provider_key,
    'spendMinor', source.spend_minor,
    'platformLeads', round(source.platform_leads, 2),
    'platformConversions', round(source.platform_conversions, 2),
    'platformRevenueMinor', source.platform_revenue_minor,
    'platformRoas', case
      when source.spend_minor > 0 then round(
        source.platform_revenue_minor::numeric / source.spend_minor,
        3
      )
      else null
    end,
    'platformCplMinor', case
      when source.platform_leads > 0
        then round(source.spend_minor::numeric / source.platform_leads)
      else null
    end,
    'revenueMinor', source.revenue_minor,
    'leads', source.leads,
    'sales', source.sales,
    'roas', case
      when source.spend_minor > 0
        then round(source.revenue_minor::numeric / source.spend_minor, 3)
      else null
    end
  ) order by source.spend_minor desc, source.revenue_minor desc), '[]'::jsonb)
  into v_sources
  from (
    select
      value ->> 'providerKey' as provider_key,
      sum((value ->> 'spendMinor')::bigint)::bigint as spend_minor,
      sum((value ->> 'platformLeads')::numeric)::numeric
        as platform_leads,
      sum((value ->> 'platformConversions')::numeric)::numeric
        as platform_conversions,
      sum((value ->> 'platformRevenueMinor')::bigint)::bigint
        as platform_revenue_minor,
      sum((value ->> 'revenueMinor')::bigint)::bigint as revenue_minor,
      sum((value ->> 'leads')::integer)::integer as leads,
      sum((value ->> 'sales')::integer)::integer as sales
    from campaign_rows
    group by value ->> 'providerKey'
  ) source;

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
      and metric.currency = v_settings.base_currency
  ), performance as (
    select
      metric.metric_date as day,
      sum(metric.spend_minor)::bigint as spend_minor,
      sum(metric.clicks)::bigint as clicks,
      sum(metric.impressions)::bigint as impressions,
      sum(metric.platform_leads)::numeric as platform_leads,
      sum(metric.platform_conversions)::numeric as platform_conversions,
      sum(metric.platform_revenue_minor)::bigint
        as platform_revenue_minor
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
    group by metric.metric_date
  ), attributed as (
    select
      conversion.occurred_at::date as day,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )::integer as leads,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )::integer as sales,
      sum(attribution.attributed_revenue_minor) filter (
        where conversion.currency = v_settings.base_currency
      )::bigint as revenue_minor
    from marketing_hub.conversion_events conversion
    left join marketing_hub.attributions attribution
      on attribution.conversion_event_id = conversion.id
     and attribution.model = v_settings.model
    where conversion.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to
    group by conversion.occurred_at::date
  ), days as (
    select generate_series(v_from, v_to, interval '1 day')::date as day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', days.day,
    'spendMinor', coalesce(performance.spend_minor, 0),
    'impressions', coalesce(performance.impressions, 0),
    'clicks', coalesce(performance.clicks, 0),
    'platformLeads', round(coalesce(performance.platform_leads, 0), 2),
    'platformConversions',
      round(coalesce(performance.platform_conversions, 0), 2),
    'platformRevenueMinor',
      coalesce(performance.platform_revenue_minor, 0),
    'leads', coalesce(attributed.leads, 0),
    'sales', coalesce(attributed.sales, 0),
    'revenueMinor', coalesce(attributed.revenue_minor, 0)
  ) order by days.day), '[]'::jsonb)
  into v_daily
  from days
  left join performance on performance.day = days.day
  left join attributed on attributed.day = days.day;

  select jsonb_build_array(
    jsonb_build_object(
      'key', 'leads',
      'label', 'عملاء جدد',
      'count', count(*) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )
    ),
    jsonb_build_object(
      'key', 'qualified',
      'label', 'عملاء مؤهلون',
      'count', count(*) filter (
        where conversion.event_type = 'qualified_lead'
          and conversion.status = 'active'
      )
    ),
    jsonb_build_object(
      'key', 'sales',
      'label', 'مبيعات موثقة',
      'count', count(*) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )
    ),
    jsonb_build_object(
      'key', 'refunds',
      'label', 'مرتجعات',
      'count', count(*) filter (where conversion.status = 'refunded')
    )
  )
  into v_funnel
  from marketing_hub.conversion_events conversion
  where conversion.tenant_id = v_tenant.id
    and conversion.occurred_at::date between v_from and v_to;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', insight.id,
    'type', insight.insight_type,
    'severity', insight.severity,
    'title', insight.title_ar,
    'detail', insight.detail_ar,
    'recommendedAction', insight.recommended_action_ar,
    'providerKey', insight.provider_key,
    'campaignId', insight.campaign_id,
    'evidence', insight.evidence,
    'status', insight.status,
    'lastDetectedAt', insight.last_detected_at
  ) order by
    case insight.severity
      when 'critical' then 1
      when 'warning' then 2
      when 'opportunity' then 3
      else 4
    end,
    insight.last_detected_at desc
  ), '[]'::jsonb)
  into v_insights
  from marketing_hub.insights insight
  where insight.tenant_id = v_tenant.id
    and insight.status in ('open','acknowledged');

  select coalesce(jsonb_agg(source.value order by source.sort_order), '[]'::jsonb)
  into v_store_sources
  from (
    select
      10 + provider.sort_order as sort_order,
      jsonb_build_object(
        'providerKey', provider.provider_key,
        'nameAr', provider.name_ar,
        'status', connection.status,
        'lastSyncedAt', connection.last_synced_at,
        'orderCount', (
          select count(*)
          from commerce_hub.external_entities entity
          where entity.connection_id = connection.id
            and entity.entity_type = 'orders'
            and entity.sync_state = 'active'
        )
      ) as value
    from commerce_hub.connections connection
    join commerce_hub.providers provider
      on provider.provider_key = connection.provider_key
    where connection.tenant_id = v_tenant.id
      and connection.status <> 'disabled'
    union all
    select
      10,
      jsonb_build_object(
        'providerKey', 'woocommerce',
        'nameAr', 'WooCommerce',
        'status', connection.status,
        'lastSyncedAt', connection.last_synced_at,
        'orderCount', (
          select count(*)
          from commerce_sync.external_entities entity
          where entity.connection_id = connection.id
            and entity.entity_type = 'orders'
            and entity.sync_state = 'active'
        )
      )
    from commerce_sync.connections connection
    where connection.tenant_id = v_tenant.id
      and connection.status <> 'disabled'
  ) source;

  select jsonb_build_object(
    'activeConnections', count(*) filter (
      where connection.status in ('active','degraded')
    ),
    'connectionsNeedingAttention', count(*) filter (
      where connection.status in ('error','reauth_required')
    ),
    'staleConnections', count(*) filter (
      where connection.status in ('active','degraded')
        and (
          connection.last_synced_at is null
          or connection.last_synced_at < now() - interval '48 hours'
        )
    ),
    'lastSyncedAt', max(connection.last_synced_at),
    'currencyMismatches', (
      select count(distinct metric.currency)
      from marketing_hub.daily_metrics metric
      where metric.tenant_id = v_tenant.id
        and metric.metric_date between v_from and v_to
        and metric.currency <> v_settings.base_currency
    ),
    'commerceSources', jsonb_array_length(v_store_sources),
    'attributionModel', v_settings.model,
    'clickWindowDays', v_settings.click_window_days,
    'viewWindowDays', v_settings.view_window_days
  )
  into v_data_health
  from marketing_hub.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled';

  return jsonb_build_object(
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'timezone', v_settings.timezone
    ),
    'featureEnabled', v_feature_enabled,
    'canManage', v_can_manage,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'settings', jsonb_build_object(
      'model', v_settings.model,
      'clickWindowDays', v_settings.click_window_days,
      'viewWindowDays', v_settings.view_window_days,
      'baseCurrency', v_settings.base_currency,
      'timezone', v_settings.timezone
    ),
    'providers', v_providers,
    'summary', v_summary,
    'campaigns', v_campaigns,
    'sources', v_sources,
    'daily', v_daily,
    'funnel', v_funnel,
    'insights', v_insights,
    'commerceSources', v_store_sources,
    'dataHealth', v_data_health
  );
end;
$$;

drop function if exists public.v2_tenant_marketing_hub_snapshot_v2(
  text,date,date
);

comment on function public.v2_tenant_marketing_hub_snapshot(text,date,date)
is 'Tenant-isolated marketing snapshot with platform-reported outcomes kept separate from first-party verified CRM and commerce outcomes.';

commit;
