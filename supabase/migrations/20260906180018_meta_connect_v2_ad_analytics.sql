-- Social Connect ad-level analytics. This is additive: the V1 connection
-- snapshot stays intact while the reporting surface gets its own bounded RPC.

create index if not exists marketing_daily_metrics_account_ad_date_idx
on marketing_hub.daily_metrics(ad_account_id,metric_date desc,ad_id)
where entity_level='ad';

create index if not exists marketing_ads_account_status_idx
on marketing_hub.ads(ad_account_id,effective_status,status,updated_at desc);

create or replace function public.v2_tenant_meta_connect_v2_report(
  p_tenant_slug text,
  p_date_from date default null,
  p_date_to date default null,
  p_query text default null,
  p_campaign_id uuid default null,
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant_id uuid;
  v_connection meta_connect_v2.connections%rowtype;
  v_marketing marketing_hub.connections%rowtype;
  v_account marketing_hub.ad_accounts%rowtype;
  v_from date:=coalesce(p_date_from,current_date-29);
  v_to date:=coalesce(p_date_to,current_date);
  v_query text:=left(trim(coalesce(p_query,'')),80);
  v_status text:=lower(trim(coalesce(p_status,'all')));
  v_page integer:=greatest(1,least(coalesce(p_page,1),10000));
  v_page_size integer:=greatest(10,least(coalesce(p_page_size,25),50));
  v_ad_ids uuid[]:='{}'::uuid[];
  v_summary jsonb:='{}'::jsonb;
  v_analysis jsonb:='{}'::jsonb;
  v_campaigns jsonb:='[]'::jsonb;
  v_available_campaigns jsonb:='[]'::jsonb;
  v_ads jsonb:='[]'::jsonb;
  v_total_ads integer:=0;
  v_metric_rows integer:=0;
  v_coverage_from date;
  v_coverage_to date;
begin
  if v_from>v_to or v_to>current_date or v_to-v_from>92 then
    raise exception 'marketing_report_range_invalid';
  end if;
  if v_status not in ('all','active','paused','other') then
    raise exception 'marketing_report_filter_invalid';
  end if;

  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug=p_tenant_slug and tenant.status in ('trial','active');
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(v_tenant_id,'tenant.meta_connect.read')
    or private_app.has_tenant_permission(v_tenant_id,'tenant.meta_connect.manage')
  ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant_id,'addon.integrations.social_connect'
  ) then raise exception 'addon_not_enabled'; end if;

  select connection.* into v_connection
  from meta_connect_v2.connections connection
  where connection.tenant_id=v_tenant_id;
  if v_connection.marketing_connection_id is not null then
    select connection.* into v_marketing
    from marketing_hub.connections connection
    where connection.id=v_connection.marketing_connection_id
      and connection.tenant_id=v_tenant_id
      and connection.provider_key='meta'
      and connection.configuration->>'authSource'='meta_connect_v2';
    select account.* into v_account
    from marketing_hub.ad_accounts account
    where account.connection_id=v_marketing.id
      and account.tenant_id=v_tenant_id and account.is_selected
    order by account.updated_at desc limit 1;
  end if;

  if v_account.id is not null then
    select coalesce(array_agg(ad.id order by ad.updated_at desc),'{}'::uuid[])
    into v_ad_ids
    from marketing_hub.ads ad
    left join marketing_hub.campaigns campaign on campaign.id=ad.campaign_id
    left join marketing_hub.ad_groups ad_group on ad_group.id=ad.ad_group_id
    where ad.tenant_id=v_tenant_id and ad.ad_account_id=v_account.id
      and (p_campaign_id is null or ad.campaign_id=p_campaign_id)
      and (
        v_query='' or lower(concat_ws(' ',ad.name,ad.external_ad_id,
          campaign.name,campaign.external_campaign_id,
          ad_group.name,ad_group.external_ad_group_id
        )) like '%'||lower(v_query)||'%'
      )
      and (
        v_status='all'
        or (v_status='active' and lower(coalesce(ad.effective_status,ad.status,''))='active')
        or (v_status='paused' and lower(coalesce(ad.effective_status,ad.status,''))
          in ('paused','campaign_paused','adset_paused'))
        or (v_status='other' and lower(coalesce(ad.effective_status,ad.status,''))
          not in ('active','paused','campaign_paused','adset_paused'))
      );
    v_total_ads:=coalesce(cardinality(v_ad_ids),0);

    select min(metric.metric_date),max(metric.metric_date)
    into v_coverage_from,v_coverage_to
    from marketing_hub.daily_metrics metric
    where metric.tenant_id=v_tenant_id
      and metric.ad_account_id=v_account.id and metric.entity_level='ad';

    select count(*)::integer into v_metric_rows
    from marketing_hub.daily_metrics metric
    where metric.tenant_id=v_tenant_id
      and metric.ad_account_id=v_account.id and metric.entity_level='ad'
      and metric.metric_date between v_from and v_to
      and metric.ad_id=any(v_ad_ids);

    select jsonb_build_object(
      'currency',v_account.currency,
      'impressions',coalesce(sum(metric.impressions),0)::bigint,
      'reach',coalesce(sum(metric.reach),0)::bigint,
      'clicks',coalesce(sum(metric.clicks),0)::bigint,
      'linkClicks',coalesce(sum(metric.link_clicks),0)::bigint,
      'spendMinor',coalesce(sum(metric.spend_minor),0)::bigint,
      'platformLeads',round(coalesce(sum(metric.platform_leads),0),2),
      'platformConversions',round(coalesce(sum(metric.platform_conversions),0),2),
      'platformRevenueMinor',coalesce(sum(metric.platform_revenue_minor),0)::bigint,
      'videoViews',coalesce(sum(metric.video_views),0)::bigint,
      'ctr',case when coalesce(sum(metric.impressions),0)>0 then
        round(100.0*sum(metric.clicks)/sum(metric.impressions),2) end,
      'cpcMinor',case when coalesce(sum(metric.clicks),0)>0 then
        round(sum(metric.spend_minor)::numeric/sum(metric.clicks)) end,
      'cpaMinor',case when coalesce(sum(metric.platform_conversions),0)>0 then
        round(sum(metric.spend_minor)::numeric/sum(metric.platform_conversions)) end,
      'roas',case when coalesce(sum(metric.spend_minor),0)>0 then
        round(sum(metric.platform_revenue_minor)::numeric/sum(metric.spend_minor),2) end
    ) into v_summary
    from marketing_hub.daily_metrics metric
    where metric.tenant_id=v_tenant_id
      and metric.ad_account_id=v_account.id and metric.entity_level='ad'
      and metric.metric_date between v_from and v_to
      and metric.ad_id=any(v_ad_ids);

    with performance as (
      select ad.id,ad.name,ad.external_ad_id,
        lower(coalesce(ad.effective_status,ad.status,'unknown')) status,
        coalesce(sum(metric.spend_minor),0)::bigint spend_minor,
        coalesce(sum(metric.impressions),0)::bigint impressions,
        coalesce(sum(metric.clicks),0)::bigint clicks,
        round(coalesce(sum(metric.platform_conversions),0),2) results,
        case when coalesce(sum(metric.impressions),0)>0 then
          round(100.0*sum(metric.clicks)/sum(metric.impressions),2) end ctr
      from marketing_hub.ads ad
      left join marketing_hub.daily_metrics metric
        on metric.ad_id=ad.id and metric.ad_account_id=v_account.id
       and metric.entity_level='ad' and metric.metric_date between v_from and v_to
      where ad.id=any(v_ad_ids)
      group by ad.id,ad.name,ad.external_ad_id,ad.effective_status,ad.status
    )
    select jsonb_strip_nulls(jsonb_build_object(
      'topSpendAd',(select jsonb_build_object(
        'id',row.id,'externalAdId',row.external_ad_id,'name',row.name,
        'spendMinor',row.spend_minor,'results',row.results
      ) from performance row where row.spend_minor>0
        order by row.spend_minor desc,row.name limit 1),
      'bestCtrAd',(select jsonb_build_object(
        'id',row.id,'externalAdId',row.external_ad_id,'name',row.name,
        'ctr',row.ctr,'clicks',row.clicks,'impressions',row.impressions
      ) from performance row where row.impressions>=100 and row.ctr is not null
        order by row.ctr desc,row.clicks desc,row.name limit 1),
      'topResultsAd',(select jsonb_build_object(
        'id',row.id,'externalAdId',row.external_ad_id,'name',row.name,
        'results',row.results,'spendMinor',row.spend_minor
      ) from performance row where row.results>0
        order by row.results desc,row.spend_minor,row.name limit 1),
      'zeroResultAds',(select count(*)::integer from performance row
        where row.spend_minor>0 and row.results=0),
      'zeroResultSpendMinor',(select coalesce(sum(row.spend_minor),0)::bigint
        from performance row where row.spend_minor>0 and row.results=0),
      'activeAds',(select count(*)::integer from performance row where row.status='active'),
      'adsWithData',(select count(*)::integer from performance row
        where row.impressions>0 or row.clicks>0 or row.spend_minor>0 or row.results>0)
    )) into v_analysis;

    select coalesce(jsonb_agg(row.value order by row.spend_minor desc,row.name),'[]'::jsonb)
    into v_campaigns
    from (
      select campaign.name,coalesce(sum(metric.spend_minor),0)::bigint spend_minor,
        jsonb_build_object(
          'id',campaign.id,'externalCampaignId',campaign.external_campaign_id,
          'name',campaign.name,'objective',campaign.objective,
          'status',campaign.status,'effectiveStatus',campaign.effective_status,
          'currency',v_account.currency,'adCount',count(distinct ad.id),
          'impressions',coalesce(sum(metric.impressions),0)::bigint,
          'clicks',coalesce(sum(metric.clicks),0)::bigint,
          'spendMinor',coalesce(sum(metric.spend_minor),0)::bigint,
          'platformConversions',round(coalesce(sum(metric.platform_conversions),0),2),
          'ctr',case when coalesce(sum(metric.impressions),0)>0 then
            round(100.0*sum(metric.clicks)/sum(metric.impressions),2) end
        ) value
      from marketing_hub.ads ad
      join marketing_hub.campaigns campaign on campaign.id=ad.campaign_id
      left join marketing_hub.daily_metrics metric
        on metric.ad_id=ad.id and metric.ad_account_id=v_account.id
       and metric.entity_level='ad' and metric.metric_date between v_from and v_to
      where ad.id=any(v_ad_ids)
      group by campaign.id,campaign.name,campaign.external_campaign_id,
        campaign.objective,campaign.status,campaign.effective_status
      order by spend_minor desc,campaign.name
      limit 200
    ) row;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id',campaign.id,'name',campaign.name,
      'externalCampaignId',campaign.external_campaign_id
    ) order by campaign.name),'[]'::jsonb)
    into v_available_campaigns
    from (
      select item.id,item.name,item.external_campaign_id
      from marketing_hub.campaigns item
      where item.tenant_id=v_tenant_id and item.ad_account_id=v_account.id
      order by item.name limit 500
    ) campaign;

    with metric as (
      select daily.ad_id,
        coalesce(sum(daily.spend_minor),0)::bigint spend_minor,
        coalesce(sum(daily.impressions),0)::bigint impressions,
        coalesce(sum(daily.reach),0)::bigint reach,
        coalesce(sum(daily.clicks),0)::bigint clicks,
        coalesce(sum(daily.link_clicks),0)::bigint link_clicks,
        round(coalesce(sum(daily.platform_leads),0),2) leads,
        round(coalesce(sum(daily.platform_conversions),0),2) results,
        coalesce(sum(daily.platform_revenue_minor),0)::bigint revenue_minor,
        coalesce(sum(daily.video_views),0)::bigint video_views
      from marketing_hub.daily_metrics daily
      where daily.tenant_id=v_tenant_id and daily.ad_account_id=v_account.id
        and daily.entity_level='ad' and daily.metric_date between v_from and v_to
        and daily.ad_id=any(v_ad_ids)
      group by daily.ad_id
    )
    select coalesce(jsonb_agg(row.value order by row.spend_minor desc,row.name),'[]'::jsonb)
    into v_ads
    from (
      select ad.name,coalesce(metric.spend_minor,0)::bigint spend_minor,
        jsonb_build_object(
          'id',ad.id,'externalAdId',ad.external_ad_id,
          'externalCreativeId',ad.external_creative_id,'name',ad.name,
          'status',ad.status,'effectiveStatus',ad.effective_status,
          'campaignId',campaign.id,'campaignName',campaign.name,
          'adGroupId',ad_group.id,'adGroupName',ad_group.name,
          'currency',v_account.currency,
          'impressions',coalesce(metric.impressions,0),
          'reach',coalesce(metric.reach,0),'clicks',coalesce(metric.clicks,0),
          'linkClicks',coalesce(metric.link_clicks,0),
          'spendMinor',coalesce(metric.spend_minor,0),
          'platformLeads',coalesce(metric.leads,0),
          'platformConversions',coalesce(metric.results,0),
          'platformRevenueMinor',coalesce(metric.revenue_minor,0),
          'videoViews',coalesce(metric.video_views,0),
          'ctr',case when coalesce(metric.impressions,0)>0 then
            round(100.0*metric.clicks/metric.impressions,2) end,
          'cpcMinor',case when coalesce(metric.clicks,0)>0 then
            round(metric.spend_minor::numeric/metric.clicks) end,
          'cpaMinor',case when coalesce(metric.results,0)>0 then
            round(metric.spend_minor::numeric/metric.results) end
        ) value
      from marketing_hub.ads ad
      join marketing_hub.campaigns campaign on campaign.id=ad.campaign_id
      left join marketing_hub.ad_groups ad_group on ad_group.id=ad.ad_group_id
      left join metric on metric.ad_id=ad.id
      where ad.id=any(v_ad_ids)
      order by spend_minor desc,ad.name
      offset (v_page-1)*v_page_size limit v_page_size
    ) row;
  end if;

  return jsonb_build_object(
    'range',jsonb_build_object(
      'from',v_from,'to',v_to,'maxDays',93,
      'coverageFrom',v_coverage_from,'coverageTo',v_coverage_to
    ),
    'filters',jsonb_build_object(
      'query',v_query,'campaignId',p_campaign_id,'status',v_status,
      'page',v_page,'pageSize',v_page_size,'totalAds',v_total_ads,
      'totalPages',case when v_total_ads=0 then 0 else
        ceil(v_total_ads::numeric/v_page_size)::integer end,
      'campaigns',v_available_campaigns
    ),
    'metricRows',v_metric_rows,
    'summary',v_summary,
    'analysis',v_analysis,
    'campaigns',v_campaigns,
    'ads',v_ads
  );
end;
$$;

revoke execute on function public.v2_tenant_meta_connect_v2_report(
  text,date,date,text,uuid,text,integer,integer
) from public,anon,authenticated;
grant execute on function public.v2_tenant_meta_connect_v2_report(
  text,date,date,text,uuid,text,integer,integer
) to authenticated;
