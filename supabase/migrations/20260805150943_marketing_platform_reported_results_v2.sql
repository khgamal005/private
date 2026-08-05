-- Expose platform-reported outcomes separately from first-party verified results.
begin;

create or replace function public.v2_tenant_marketing_hub_snapshot_v2(
  p_slug text,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_tenant_id uuid;
  v_from date;
  v_to date;
  v_base_currency text;
  v_summary_metrics jsonb := '{}'::jsonb;
  v_campaign_metrics jsonb := '{}'::jsonb;
  v_source_metrics jsonb := '{}'::jsonb;
  v_daily_metrics jsonb := '{}'::jsonb;
  v_campaigns jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
begin
  if auth.uid() is null
    and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
  then
    raise exception 'authentication_required';
  end if;

  -- The v1 snapshot performs the canonical tenant permission and add-on checks.
  v_snapshot := public.v2_tenant_marketing_hub_snapshot(
    p_slug,
    p_from,
    p_to
  );
  v_tenant_id := (v_snapshot #>> '{tenant,id}')::uuid;
  v_from := (v_snapshot #>> '{range,from}')::date;
  v_to := (v_snapshot #>> '{range,to}')::date;
  v_base_currency := upper(coalesce(
    nullif(v_snapshot #>> '{summary,currency}', ''),
    'SAR'
  ));

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
    where metric.tenant_id = v_tenant_id
      and metric.metric_date between v_from and v_to
  ), selected as (
    select metric.*
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
  ), totals as (
    select
      coalesce(sum(metric.platform_leads), 0)::numeric as platform_leads,
      coalesce(sum(metric.platform_conversions), 0)::numeric
        as platform_conversions,
      coalesce(sum(metric.platform_revenue_minor), 0)::bigint
        as platform_revenue_minor,
      coalesce(sum(metric.spend_minor), 0)::bigint as spend_minor
    from selected metric
    where metric.currency = v_base_currency
  )
  select jsonb_build_object(
    'platformLeads', round(totals.platform_leads, 2),
    'platformConversions', round(totals.platform_conversions, 2),
    'platformRevenueMinor', totals.platform_revenue_minor,
    'platformRoas', case
      when totals.spend_minor > 0 then round(
        totals.platform_revenue_minor::numeric / totals.spend_minor,
        3
      )
      else null
    end,
    'platformCplMinor', case
      when totals.platform_leads > 0
        then round(totals.spend_minor::numeric / totals.platform_leads)
      else null
    end,
    'platformCostPerConversionMinor', case
      when totals.platform_conversions > 0
        then round(totals.spend_minor::numeric / totals.platform_conversions)
      else null
    end
  )
  into v_summary_metrics
  from totals;

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
    where metric.tenant_id = v_tenant_id
      and metric.metric_date between v_from and v_to
  ), selected as (
    select metric.*
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
  ), campaign_totals as (
    select
      metric.campaign_id,
      coalesce(sum(metric.platform_leads), 0)::numeric as platform_leads,
      coalesce(sum(metric.platform_conversions), 0)::numeric
        as platform_conversions,
      coalesce(sum(metric.platform_revenue_minor), 0)::bigint
        as platform_revenue_minor,
      coalesce(sum(metric.spend_minor), 0)::bigint as spend_minor
    from selected metric
    where metric.campaign_id is not null
    group by metric.campaign_id
  )
  select coalesce(jsonb_object_agg(
    totals.campaign_id::text,
    jsonb_build_object(
      'platformLeads', round(totals.platform_leads, 2),
      'platformConversions', round(totals.platform_conversions, 2),
      'platformRevenueMinor', totals.platform_revenue_minor,
      'platformRoas', case
        when totals.spend_minor > 0 then round(
          totals.platform_revenue_minor::numeric / totals.spend_minor,
          3
        )
        else null
      end,
      'platformCplMinor', case
        when totals.platform_leads > 0 then round(
          totals.spend_minor::numeric / totals.platform_leads
        )
        else null
      end
    )
  ), '{}'::jsonb)
  into v_campaign_metrics
  from campaign_totals totals;

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
    where metric.tenant_id = v_tenant_id
      and metric.metric_date between v_from and v_to
      and metric.currency = v_base_currency
  ), selected as (
    select metric.*
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
  ), source_totals as (
    select
      metric.provider_key,
      coalesce(sum(metric.platform_leads), 0)::numeric as platform_leads,
      coalesce(sum(metric.platform_conversions), 0)::numeric
        as platform_conversions,
      coalesce(sum(metric.platform_revenue_minor), 0)::bigint
        as platform_revenue_minor,
      coalesce(sum(metric.spend_minor), 0)::bigint as spend_minor
    from selected metric
    group by metric.provider_key
  )
  select coalesce(jsonb_object_agg(
    totals.provider_key,
    jsonb_build_object(
      'platformLeads', round(totals.platform_leads, 2),
      'platformConversions', round(totals.platform_conversions, 2),
      'platformRevenueMinor', totals.platform_revenue_minor,
      'platformRoas', case
        when totals.spend_minor > 0 then round(
          totals.platform_revenue_minor::numeric / totals.spend_minor,
          3
        )
        else null
      end,
      'platformCplMinor', case
        when totals.platform_leads > 0 then round(
          totals.spend_minor::numeric / totals.platform_leads
        )
        else null
      end
    )
  ), '{}'::jsonb)
  into v_source_metrics
  from source_totals totals;

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
    where metric.tenant_id = v_tenant_id
      and metric.metric_date between v_from and v_to
      and metric.currency = v_base_currency
  ), selected as (
    select metric.*
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
  ), daily_totals as (
    select
      metric.metric_date,
      coalesce(sum(metric.platform_leads), 0)::numeric as platform_leads,
      coalesce(sum(metric.platform_conversions), 0)::numeric
        as platform_conversions,
      coalesce(sum(metric.platform_revenue_minor), 0)::bigint
        as platform_revenue_minor
    from selected metric
    group by metric.metric_date
  )
  select coalesce(jsonb_object_agg(
    totals.metric_date::text,
    jsonb_build_object(
      'platformLeads', round(totals.platform_leads, 2),
      'platformConversions', round(totals.platform_conversions, 2),
      'platformRevenueMinor', totals.platform_revenue_minor
    )
  ), '{}'::jsonb)
  into v_daily_metrics
  from daily_totals totals;

  select coalesce(jsonb_agg(
    item.value
      || coalesce(v_campaign_metrics -> (item.value ->> 'id'), jsonb_build_object(
        'platformLeads', 0,
        'platformConversions', 0,
        'platformRevenueMinor', 0,
        'platformRoas', null,
        'platformCplMinor', null
      ))
    order by item.position
  ), '[]'::jsonb)
  into v_campaigns
  from jsonb_array_elements(coalesce(v_snapshot -> 'campaigns', '[]'::jsonb))
    with ordinality as item(value, position);

  select coalesce(jsonb_agg(
    item.value
      || coalesce(v_source_metrics -> (item.value ->> 'providerKey'), jsonb_build_object(
        'platformLeads', 0,
        'platformConversions', 0,
        'platformRevenueMinor', 0,
        'platformRoas', null,
        'platformCplMinor', null
      ))
    order by item.position
  ), '[]'::jsonb)
  into v_sources
  from jsonb_array_elements(coalesce(v_snapshot -> 'sources', '[]'::jsonb))
    with ordinality as item(value, position);

  select coalesce(jsonb_agg(
    item.value
      || coalesce(v_daily_metrics -> (item.value ->> 'date'), jsonb_build_object(
        'platformLeads', 0,
        'platformConversions', 0,
        'platformRevenueMinor', 0
      ))
    order by item.position
  ), '[]'::jsonb)
  into v_daily
  from jsonb_array_elements(coalesce(v_snapshot -> 'daily', '[]'::jsonb))
    with ordinality as item(value, position);

  v_snapshot := jsonb_set(
    v_snapshot,
    '{summary}',
    coalesce(v_snapshot -> 'summary', '{}'::jsonb) || v_summary_metrics,
    true
  );
  v_snapshot := jsonb_set(v_snapshot, '{campaigns}', v_campaigns, true);
  v_snapshot := jsonb_set(v_snapshot, '{sources}', v_sources, true);
  v_snapshot := jsonb_set(v_snapshot, '{daily}', v_daily, true);

  return v_snapshot;
end;
$$;

revoke all on function public.v2_tenant_marketing_hub_snapshot_v2(
  text,date,date
)
from public, anon;

grant execute on function public.v2_tenant_marketing_hub_snapshot_v2(
  text,date,date
)
to authenticated, service_role;

comment on function public.v2_tenant_marketing_hub_snapshot_v2(text,date,date)
is 'Authorized tenant marketing snapshot with platform-reported outcomes kept separate from first-party verified CRM and commerce outcomes.';

commit;
