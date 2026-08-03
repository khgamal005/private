-- Applied migration version: 20260803020400
begin;

-- Cover every foreign-key lookup used by deletes, reconciliation, and joins.
-- Composite business indexes remain in place for dashboard and sync queries.
create index if not exists marketing_ad_accounts_provider_idx
  on marketing_hub.ad_accounts (provider_key);

create index if not exists marketing_ad_groups_provider_idx
  on marketing_hub.ad_groups (provider_key);

create index if not exists marketing_ads_ad_group_idx
  on marketing_hub.ads (ad_group_id);

create index if not exists marketing_ads_provider_idx
  on marketing_hub.ads (provider_key);

create index if not exists marketing_attribution_settings_editor_idx
  on marketing_hub.attribution_settings (updated_by_subject_id);

create index if not exists marketing_attributions_ad_group_idx
  on marketing_hub.attributions (ad_group_id);

create index if not exists marketing_attributions_ad_idx
  on marketing_hub.attributions (ad_id);

create index if not exists marketing_attributions_campaign_idx
  on marketing_hub.attributions (campaign_id);

create index if not exists marketing_attributions_touchpoint_idx
  on marketing_hub.attributions (touchpoint_id);

create index if not exists marketing_campaigns_provider_idx
  on marketing_hub.campaigns (provider_key);

create index if not exists marketing_connections_creator_idx
  on marketing_hub.connections (created_by_subject_id);

create index if not exists marketing_connections_provider_idx
  on marketing_hub.connections (provider_key);

create index if not exists marketing_connections_editor_idx
  on marketing_hub.connections (updated_by_subject_id);

create index if not exists marketing_conversion_commerce_idx
  on marketing_hub.conversion_events (commerce_entity_id);

create index if not exists marketing_conversion_contact_idx
  on marketing_hub.conversion_events (contact_id);

create index if not exists marketing_conversion_opportunity_idx
  on marketing_hub.conversion_events (opportunity_id);

create index if not exists marketing_daily_metrics_ad_group_idx
  on marketing_hub.daily_metrics (ad_group_id);

create index if not exists marketing_daily_metrics_ad_idx
  on marketing_hub.daily_metrics (ad_id);

create index if not exists marketing_daily_metrics_provider_idx
  on marketing_hub.daily_metrics (provider_key);

create index if not exists marketing_insights_campaign_idx
  on marketing_hub.insights (campaign_id);

create index if not exists marketing_touchpoints_commerce_idx
  on marketing_hub.touchpoints (commerce_entity_id);

create index if not exists marketing_touchpoints_contact_idx
  on marketing_hub.touchpoints (contact_id);

commit;
