-- Applied migration version: 20260803020000
begin;

create schema if not exists marketing_hub;

revoke all on schema marketing_hub
from public, anon, authenticated;

grant usage on schema marketing_hub to service_role;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values (
  'addon.marketing_attribution',
  'مركز الحملات والإسناد التسويقي',
  'Campaign performance and attribution hub',
  'addon',
  'boolean',
  'false'::jsonb,
  'beta'
)
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    status = excluded.status;

insert into catalog.plan_features (plan_id, feature_id, value)
select plan.id, feature.id, 'true'::jsonb
from catalog.plans plan
join catalog.features feature
  on feature.feature_key = 'addon.marketing_attribution'
where plan.plan_key = 'full'
on conflict (plan_id, feature_id) do update
set value = excluded.value,
    updated_at = now();

insert into catalog.addon_products (
  product_key,
  feature_id,
  name_ar,
  name_en,
  description_ar,
  pricing_mode,
  amount_minor,
  currency,
  interval,
  trial_days,
  usage_metric,
  default_limit,
  status,
  sort_order
)
select
  'marketing_attribution',
  feature.id,
  'إضافة إدارة الحملات والإسناد',
  'Campaign management and attribution',
  'ربط منصات الإعلانات الرسمية وقياس التكلفة والعملاء والمبيعات والعائد على الإنفاق الإعلاني.',
  'contact_sales',
  0,
  'SAR',
  'month',
  14,
  'marketing_api_rows',
  null,
  'beta',
  90
from catalog.features feature
where feature.feature_key = 'addon.marketing_attribution'
on conflict (product_key) do update
set feature_id = excluded.feature_id,
    name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    pricing_mode = excluded.pricing_mode,
    usage_metric = excluded.usage_metric,
    status = excluded.status,
    sort_order = excluded.sort_order;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values
  (
    'tenant.marketing.read',
    'marketing',
    'عرض مركز الحملات',
    'عرض أداء الحملات والتكلفة والإسناد والعائد على الإنفاق الإعلاني'
  ),
  (
    'tenant.marketing.manage',
    'marketing',
    'إدارة مركز الحملات',
    'إدارة ربط الحسابات الإعلانية وإعدادات الإسناد وتشغيل المزامنة'
  )
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  )
  and permission.permission_key in (
    'tenant.marketing.read',
    'tenant.marketing.manage'
  )
on conflict (role_id, permission_key) do nothing;

create table marketing_hub.providers (
  provider_key text primary key
    check (provider_key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name_ar text not null,
  name_en text not null,
  description_ar text not null,
  auth_mode text not null
    check (auth_mode in ('oauth2', 'access_token', 'hybrid')),
  setup_mode text not null default 'hybrid'
    check (setup_mode in ('manual', 'oauth', 'hybrid')),
  adapter_status text not null default 'active'
    check (
      adapter_status in (
        'active',
        'configuration_ready',
        'coming_soon',
        'disabled'
      )
    ),
  default_api_version text not null,
  supported_api_versions text[] not null default '{}'::text[],
  capabilities text[] not null default '{}'::text[],
  attribution_keys text[] not null default '{}'::text[],
  required_config_keys text[] not null default '{}'::text[],
  optional_config_keys text[] not null default '{}'::text[],
  required_secret_keys text[] not null default '{}'::text[],
  optional_secret_keys text[] not null default '{}'::text[],
  documentation_url text not null
    check (documentation_url ~* '^https://'),
  status text not null default 'beta'
    check (status in ('active', 'beta', 'coming_soon', 'disabled')),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into marketing_hub.providers (
  provider_key,
  name_ar,
  name_en,
  description_ar,
  auth_mode,
  setup_mode,
  adapter_status,
  default_api_version,
  supported_api_versions,
  capabilities,
  attribution_keys,
  required_config_keys,
  optional_config_keys,
  required_secret_keys,
  optional_secret_keys,
  documentation_url,
  status,
  sort_order
)
values
  (
    'meta',
    'Meta Ads',
    'Meta Ads',
    'قياس حملات Facebook وInstagram والعملاء والمبيعات عبر Marketing API الرسمي.',
    'oauth2',
    'hybrid',
    'active',
    'v26.0',
    array['v26.0'],
    array['accounts','campaigns','ad_groups','ads','daily_insights'],
    array['fbclid','fbc','fbp','utm_campaign','utm_content'],
    array['accountId'],
    array['businessId'],
    array['accessToken'],
    array['appId','appSecret'],
    'https://developers.facebook.com/docs/marketing-api/',
    'beta',
    10
  ),
  (
    'google_ads',
    'Google Ads',
    'Google Ads',
    'قياس البحث وYouTube وPerformance Max وربط النقرات والتحويلات عبر Google Ads API الرسمي.',
    'oauth2',
    'hybrid',
    'active',
    'v25',
    array['v25','v24'],
    array['accounts','campaigns','ad_groups','ads','daily_insights'],
    array['gclid','gbraid','wbraid','utm_campaign','utm_content'],
    array['customerId'],
    array['loginCustomerId'],
    array['developerToken'],
    array['accessToken','refreshToken','clientId','clientSecret'],
    'https://developers.google.com/google-ads/api/',
    'beta',
    20
  ),
  (
    'tiktok_ads',
    'TikTok Ads',
    'TikTok Ads',
    'قياس حملات TikTok والعملاء والمشتريات عبر API for Business الرسمي.',
    'oauth2',
    'hybrid',
    'active',
    'v1.3',
    array['v1.3'],
    array['accounts','campaigns','ad_groups','ads','daily_insights'],
    array['ttclid','utm_campaign','utm_content'],
    array['advertiserId'],
    array[]::text[],
    array['accessToken'],
    array['appId','secret'],
    'https://business-api.tiktok.com/portal/docs',
    'beta',
    30
  ),
  (
    'snapchat_ads',
    'Snapchat Ads',
    'Snapchat Ads',
    'قياس حملات Snapchat والإنفاق والتحويلات عبر Marketing API الرسمي.',
    'oauth2',
    'hybrid',
    'active',
    'v1',
    array['v1'],
    array['accounts','campaigns','ad_groups','ads','daily_insights'],
    array['sc_click_id','utm_campaign','utm_content'],
    array['adAccountId'],
    array['organizationId'],
    array['accessToken'],
    array['refreshToken','clientId','clientSecret'],
    'https://developers.snap.com/marketing-api/Ads-API/introduction',
    'beta',
    40
  )
on conflict (provider_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    auth_mode = excluded.auth_mode,
    setup_mode = excluded.setup_mode,
    adapter_status = excluded.adapter_status,
    default_api_version = excluded.default_api_version,
    supported_api_versions = excluded.supported_api_versions,
    capabilities = excluded.capabilities,
    attribution_keys = excluded.attribution_keys,
    required_config_keys = excluded.required_config_keys,
    optional_config_keys = excluded.optional_config_keys,
    required_secret_keys = excluded.required_secret_keys,
    optional_secret_keys = excluded.optional_secret_keys,
    documentation_url = excluded.documentation_url,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create table marketing_hub.attribution_settings (
  tenant_id uuid primary key
    references core.tenants(id) on delete cascade,
  model text not null default 'last_non_direct'
    check (model in ('last_non_direct','last_touch','first_touch','linear')),
  click_window_days integer not null default 30
    check (click_window_days between 1 and 180),
  view_window_days integer not null default 1
    check (view_window_days between 0 and 30),
  base_currency text not null default 'SAR'
    check (base_currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Riyadh',
  revenue_source_priority text[] not null default array[
    'verified_payment',
    'commerce_order',
    'won_opportunity'
  ]::text[],
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table marketing_hub.connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  provider_key text not null
    references marketing_hub.providers(provider_key) on delete restrict,
  display_name text,
  status text not null default 'draft'
    check (
      status in (
        'draft',
        'awaiting_authorization',
        'active',
        'degraded',
        'reauth_required',
        'error',
        'disabled'
      )
    ),
  frequency text not null default 'daily'
    check (frequency in ('manual','every_6_hours','daily')),
  sync_lookback_days integer not null default 14
    check (sync_lookback_days between 1 and 90),
  api_version text not null,
  configuration jsonb not null default '{}'::jsonb
    check (jsonb_typeof(configuration) = 'object'),
  secret_refs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(secret_refs) = 'object'),
  external_user_id text,
  token_expires_at timestamptz,
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error_code text,
  last_error_detail text,
  remote_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(remote_metadata) = 'object'),
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider_key)
);

create index marketing_connections_due_idx
on marketing_hub.connections (next_sync_at, provider_key)
where status in ('active','degraded');

create index marketing_connections_tenant_status_idx
on marketing_hub.connections (tenant_id, status, provider_key);

create table marketing_hub.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references marketing_hub.connections(id) on delete cascade,
  provider_key text not null
    references marketing_hub.providers(provider_key) on delete restrict,
  external_account_id text not null
    check (nullif(trim(external_account_id), '') is not null),
  name text not null,
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  timezone text,
  status text not null default 'active'
    check (status in ('active','inactive','closed','unknown')),
  is_selected boolean not null default true,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  remote_updated_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_account_id)
);

create index marketing_ad_accounts_tenant_idx
on marketing_hub.ad_accounts (tenant_id, provider_key, status);

create table marketing_hub.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  ad_account_id uuid not null
    references marketing_hub.ad_accounts(id) on delete cascade,
  provider_key text not null
    references marketing_hub.providers(provider_key) on delete restrict,
  external_campaign_id text not null,
  name text not null,
  objective text,
  status text not null default 'unknown',
  effective_status text,
  budget_type text,
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  start_date date,
  end_date date,
  destination_url text,
  tracking_template text,
  raw_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(raw_payload) = 'object'),
  remote_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, external_campaign_id)
);

create index marketing_campaigns_tenant_status_idx
on marketing_hub.campaigns (tenant_id, status, updated_at desc);

create index marketing_campaigns_external_idx
on marketing_hub.campaigns (
  tenant_id,
  provider_key,
  external_campaign_id
);

create table marketing_hub.ad_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  ad_account_id uuid not null
    references marketing_hub.ad_accounts(id) on delete cascade,
  campaign_id uuid not null
    references marketing_hub.campaigns(id) on delete cascade,
  provider_key text not null
    references marketing_hub.providers(provider_key) on delete restrict,
  external_ad_group_id text not null,
  name text not null,
  status text not null default 'unknown',
  effective_status text,
  optimization_goal text,
  bid_strategy text,
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  raw_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(raw_payload) = 'object'),
  remote_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, external_ad_group_id)
);

create index marketing_ad_groups_campaign_idx
on marketing_hub.ad_groups (campaign_id, status, updated_at desc);

create index marketing_ad_groups_external_idx
on marketing_hub.ad_groups (
  tenant_id,
  provider_key,
  external_ad_group_id
);

create table marketing_hub.ads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  ad_account_id uuid not null
    references marketing_hub.ad_accounts(id) on delete cascade,
  campaign_id uuid not null
    references marketing_hub.campaigns(id) on delete cascade,
  ad_group_id uuid
    references marketing_hub.ad_groups(id) on delete cascade,
  provider_key text not null
    references marketing_hub.providers(provider_key) on delete restrict,
  external_ad_id text not null,
  external_creative_id text,
  name text not null,
  status text not null default 'unknown',
  effective_status text,
  destination_url text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  raw_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(raw_payload) = 'object'),
  remote_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, external_ad_id)
);

create index marketing_ads_campaign_idx
on marketing_hub.ads (campaign_id, status, updated_at desc);

create index marketing_ads_external_idx
on marketing_hub.ads (tenant_id, provider_key, external_ad_id);

create table marketing_hub.daily_metrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  ad_account_id uuid not null
    references marketing_hub.ad_accounts(id) on delete cascade,
  campaign_id uuid
    references marketing_hub.campaigns(id) on delete cascade,
  ad_group_id uuid
    references marketing_hub.ad_groups(id) on delete cascade,
  ad_id uuid
    references marketing_hub.ads(id) on delete cascade,
  provider_key text not null
    references marketing_hub.providers(provider_key) on delete restrict,
  metric_date date not null,
  entity_level text not null
    check (entity_level in ('account','campaign','ad_group','ad')),
  external_entity_id text not null,
  breakdown_key text not null default 'all',
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  link_clicks bigint not null default 0 check (link_clicks >= 0),
  spend_minor bigint not null default 0 check (spend_minor >= 0),
  platform_leads numeric(18,6) not null default 0
    check (platform_leads >= 0),
  platform_conversions numeric(18,6) not null default 0
    check (platform_conversions >= 0),
  platform_revenue_minor bigint not null default 0
    check (platform_revenue_minor >= 0),
  video_views bigint not null default 0 check (video_views >= 0),
  raw_metrics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(raw_metrics) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (
    ad_account_id,
    metric_date,
    entity_level,
    external_entity_id,
    breakdown_key
  )
);

create index marketing_daily_metrics_tenant_date_idx
on marketing_hub.daily_metrics (
  tenant_id,
  metric_date desc,
  provider_key
);

create index marketing_daily_metrics_campaign_date_idx
on marketing_hub.daily_metrics (campaign_id, metric_date desc)
where campaign_id is not null;

create table marketing_hub.touchpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  occurred_at timestamptz not null,
  source_kind text not null
    check (source_kind in ('crm','commerce','web','manual','provider')),
  source_ref text not null,
  contact_id uuid
    references sales_core.contacts(id) on delete cascade,
  commerce_entity_id uuid
    references commerce_hub.external_entities(id) on delete cascade,
  anonymous_id_hash text,
  identity_hashes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(identity_hashes) = 'object'),
  provider_key text,
  channel text,
  click_id_type text,
  click_id_hash text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  external_campaign_id text,
  external_ad_group_id text,
  external_ad_id text,
  landing_url text,
  referrer_url text,
  consent_status text not null default 'not_required'
    check (
      consent_status in (
        'granted',
        'denied',
        'not_required',
        'unknown'
      )
    ),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_kind, source_ref)
);

create index marketing_touchpoints_contact_time_idx
on marketing_hub.touchpoints (tenant_id, contact_id, occurred_at desc)
where contact_id is not null;

create index marketing_touchpoints_campaign_time_idx
on marketing_hub.touchpoints (
  tenant_id,
  provider_key,
  external_campaign_id,
  occurred_at desc
)
where external_campaign_id is not null;

create index marketing_touchpoints_click_hash_idx
on marketing_hub.touchpoints (tenant_id, click_id_hash)
where click_id_hash is not null;

create table marketing_hub.conversion_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  event_type text not null
    check (
      event_type in (
        'lead',
        'qualified_lead',
        'won_opportunity',
        'payment',
        'purchase',
        'enrollment'
      )
    ),
  occurred_at timestamptz not null,
  source_kind text not null
    check (source_kind in ('crm','academy','commerce','manual')),
  source_ref text not null,
  dedupe_key text not null,
  contact_id uuid
    references sales_core.contacts(id) on delete cascade,
  commerce_entity_id uuid
    references commerce_hub.external_entities(id) on delete cascade,
  opportunity_id uuid
    references sales_core.opportunities(id) on delete cascade,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active'
    check (status in ('active','refunded','cancelled')),
  identity_hashes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(identity_hashes) = 'object'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create index marketing_conversion_events_tenant_time_idx
on marketing_hub.conversion_events (
  tenant_id,
  occurred_at desc,
  event_type
);

create index marketing_conversion_events_contact_idx
on marketing_hub.conversion_events (tenant_id, contact_id, occurred_at desc)
where contact_id is not null;

create table marketing_hub.attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  conversion_event_id uuid not null
    references marketing_hub.conversion_events(id) on delete cascade,
  touchpoint_id uuid
    references marketing_hub.touchpoints(id) on delete cascade,
  model text not null
    check (model in ('last_non_direct','last_touch','first_touch','linear')),
  credit numeric(9,8) not null check (credit > 0 and credit <= 1),
  attributed_revenue_minor bigint not null default 0,
  provider_key text,
  campaign_id uuid
    references marketing_hub.campaigns(id) on delete set null,
  ad_group_id uuid
    references marketing_hub.ad_groups(id) on delete set null,
  ad_id uuid
    references marketing_hub.ads(id) on delete set null,
  external_campaign_id text,
  external_ad_group_id text,
  external_ad_id text,
  campaign_name text,
  ad_group_name text,
  ad_name text,
  confidence text not null
    check (confidence in ('exact','strong','probable','untracked')),
  confidence_score smallint not null
    check (confidence_score between 0 and 100),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  window_days integer not null check (window_days between 0 and 180),
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index marketing_attributions_touchpoint_unique_idx
on marketing_hub.attributions (
  conversion_event_id,
  touchpoint_id,
  model
)
where touchpoint_id is not null;

create unique index marketing_attributions_untracked_unique_idx
on marketing_hub.attributions (conversion_event_id, model)
where touchpoint_id is null;

create index marketing_attributions_tenant_campaign_idx
on marketing_hub.attributions (
  tenant_id,
  campaign_id,
  calculated_at desc
);

create table marketing_hub.sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references marketing_hub.connections(id) on delete cascade,
  trigger_type text not null
    check (trigger_type in ('manual','scheduled','recovery')),
  entity_scope text[] not null default array[
    'campaigns',
    'ad_groups',
    'ads',
    'daily_insights',
    'attribution'
  ]::text[],
  date_from date not null,
  date_to date not null,
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued','running','success','partial','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  worker_id text,
  lease_expires_at timestamptz,
  cursor jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_to >= date_from),
  unique (connection_id, idempotency_key)
);

create index marketing_sync_runs_queue_idx
on marketing_hub.sync_runs (status, lease_expires_at, created_at)
where status in ('queued','running');

create index marketing_sync_runs_tenant_time_idx
on marketing_hub.sync_runs (tenant_id, created_at desc);

create table marketing_hub.insights (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  fingerprint text not null,
  insight_type text not null
    check (
      insight_type in (
        'scale',
        'review_spend',
        'tracking_gap',
        'sync_health',
        'currency_mismatch'
      )
    ),
  severity text not null
    check (severity in ('info','opportunity','warning','critical')),
  title_ar text not null,
  detail_ar text not null,
  recommended_action_ar text not null,
  provider_key text,
  campaign_id uuid
    references marketing_hub.campaigns(id) on delete cascade,
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  status text not null default 'open'
    check (status in ('open','acknowledged','resolved','dismissed')),
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, fingerprint)
);

create index marketing_insights_tenant_status_idx
on marketing_hub.insights (
  tenant_id,
  status,
  severity,
  last_detected_at desc
);

create trigger marketing_providers_set_updated_at
before update on marketing_hub.providers
for each row execute function private_app.set_updated_at();

create trigger marketing_settings_set_updated_at
before update on marketing_hub.attribution_settings
for each row execute function private_app.set_updated_at();

create trigger marketing_connections_set_updated_at
before update on marketing_hub.connections
for each row execute function private_app.set_updated_at();

create trigger marketing_ad_accounts_set_updated_at
before update on marketing_hub.ad_accounts
for each row execute function private_app.set_updated_at();

create trigger marketing_campaigns_set_updated_at
before update on marketing_hub.campaigns
for each row execute function private_app.set_updated_at();

create trigger marketing_ad_groups_set_updated_at
before update on marketing_hub.ad_groups
for each row execute function private_app.set_updated_at();

create trigger marketing_ads_set_updated_at
before update on marketing_hub.ads
for each row execute function private_app.set_updated_at();

create trigger marketing_daily_metrics_set_updated_at
before update on marketing_hub.daily_metrics
for each row execute function private_app.set_updated_at();

create trigger marketing_touchpoints_set_updated_at
before update on marketing_hub.touchpoints
for each row execute function private_app.set_updated_at();

create trigger marketing_conversion_events_set_updated_at
before update on marketing_hub.conversion_events
for each row execute function private_app.set_updated_at();

create trigger marketing_sync_runs_set_updated_at
before update on marketing_hub.sync_runs
for each row execute function private_app.set_updated_at();

create trigger marketing_insights_set_updated_at
before update on marketing_hub.insights
for each row execute function private_app.set_updated_at();

alter table marketing_hub.providers enable row level security;
alter table marketing_hub.attribution_settings enable row level security;
alter table marketing_hub.connections enable row level security;
alter table marketing_hub.ad_accounts enable row level security;
alter table marketing_hub.campaigns enable row level security;
alter table marketing_hub.ad_groups enable row level security;
alter table marketing_hub.ads enable row level security;
alter table marketing_hub.daily_metrics enable row level security;
alter table marketing_hub.touchpoints enable row level security;
alter table marketing_hub.conversion_events enable row level security;
alter table marketing_hub.attributions enable row level security;
alter table marketing_hub.sync_runs enable row level security;
alter table marketing_hub.insights enable row level security;

revoke all on all tables in schema marketing_hub
from public, anon, authenticated;

revoke all on all sequences in schema marketing_hub
from public, anon, authenticated;

grant select, insert, update, delete
on all tables in schema marketing_hub to service_role;

grant usage, select
on all sequences in schema marketing_hub to service_role;

create or replace function private_app.marketing_provider_key(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := lower(trim(coalesce(p_value, '')));
begin
  v_value := case v_value
    when 'facebook' then 'meta'
    when 'instagram' then 'meta'
    when 'google' then 'google_ads'
    when 'tiktok' then 'tiktok_ads'
    when 'snapchat' then 'snapchat_ads'
    else v_value
  end;
  if v_value not in ('meta','google_ads','tiktok_ads','snapchat_ads') then
    raise exception 'marketing_provider_not_supported';
  end if;
  return v_value;
end;
$$;

create or replace function private_app.marketing_frequency(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := lower(trim(coalesce(p_value, 'daily')));
begin
  if v_value not in ('manual','every_6_hours','daily') then
    raise exception 'marketing_frequency_invalid';
  end if;
  return v_value;
end;
$$;

create or replace function private_app.marketing_next_sync(
  p_frequency text,
  p_from timestamptz default now()
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'every_6_hours' then p_from + interval '6 hours'
    when 'daily' then p_from + interval '1 day'
    else null
  end;
$$;

create or replace function private_app.marketing_try_bigint(p_value text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(trim(p_value), '') is null then return null; end if;
  return p_value::bigint;
exception when invalid_text_representation or numeric_value_out_of_range then
  return null;
end;
$$;

create or replace function private_app.marketing_try_numeric(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(trim(p_value), '') is null then return null; end if;
  return p_value::numeric;
exception when invalid_text_representation or numeric_value_out_of_range then
  return null;
end;
$$;

create or replace function private_app.marketing_try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if nullif(trim(p_value), '') is null then return null; end if;
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then
  return null;
end;
$$;

create or replace function private_app.can_read_marketing_hub(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private_app.has_tenant_permission(
    p_tenant_id,
    'tenant.marketing.read'
  );
$$;

create or replace function private_app.can_manage_marketing_hub(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private_app.has_tenant_permission(
    p_tenant_id,
    'tenant.marketing.manage'
  );
$$;

create or replace function private_app.marketing_valid_config(
  p_provider text,
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_provider text := private_app.marketing_provider_key(p_provider);
  v_value jsonb := coalesce(p_value, '{}'::jsonb);
  v_result jsonb := '{}'::jsonb;
  v_account_id text;
  v_optional text;
begin
  if jsonb_typeof(v_value) <> 'object' then
    raise exception 'marketing_configuration_invalid';
  end if;

  v_account_id := case v_provider
    when 'meta' then nullif(trim(v_value ->> 'accountId'), '')
    when 'google_ads' then nullif(regexp_replace(
      coalesce(v_value ->> 'customerId', ''),
      '[^0-9]',
      '',
      'g'
    ), '')
    when 'tiktok_ads' then nullif(trim(v_value ->> 'advertiserId'), '')
    when 'snapchat_ads' then nullif(trim(v_value ->> 'adAccountId'), '')
  end;

  if v_account_id is null or length(v_account_id) > 120 then
    raise exception 'marketing_account_id_required';
  end if;

  if v_provider = 'meta' then
    v_account_id := regexp_replace(v_account_id, '^act_', '', 'i');
    if v_account_id !~ '^[0-9]{3,40}$' then
      raise exception 'marketing_meta_account_invalid';
    end if;
    v_result := jsonb_build_object('accountId', v_account_id);
    v_optional := nullif(regexp_replace(
      coalesce(v_value ->> 'businessId', ''),
      '[^0-9]',
      '',
      'g'
    ), '');
    if v_optional is not null then
      v_result := v_result || jsonb_build_object('businessId', v_optional);
    end if;
  elsif v_provider = 'google_ads' then
    if v_account_id !~ '^[0-9]{10}$' then
      raise exception 'marketing_google_customer_invalid';
    end if;
    v_result := jsonb_build_object('customerId', v_account_id);
    v_optional := nullif(regexp_replace(
      coalesce(v_value ->> 'loginCustomerId', ''),
      '[^0-9]',
      '',
      'g'
    ), '');
    if v_optional is not null then
      if v_optional !~ '^[0-9]{10}$' then
        raise exception 'marketing_google_manager_invalid';
      end if;
      v_result := v_result || jsonb_build_object(
        'loginCustomerId',
        v_optional
      );
    end if;
  elsif v_provider = 'tiktok_ads' then
    if v_account_id !~ '^[0-9]{3,40}$' then
      raise exception 'marketing_tiktok_advertiser_invalid';
    end if;
    v_result := jsonb_build_object('advertiserId', v_account_id);
  else
    if v_account_id !~ '^[0-9a-fA-F-]{16,80}$' then
      raise exception 'marketing_snapchat_account_invalid';
    end if;
    v_result := jsonb_build_object('adAccountId', v_account_id);
    v_optional := nullif(trim(v_value ->> 'organizationId'), '');
    if v_optional is not null then
      v_result := v_result || jsonb_build_object(
        'organizationId',
        left(v_optional, 120)
      );
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function private_app.marketing_provider_key(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_frequency(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_next_sync(text,timestamptz)
from public, anon, authenticated;
revoke all on function private_app.marketing_try_bigint(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_try_numeric(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_try_timestamptz(text)
from public, anon, authenticated;
revoke all on function private_app.can_read_marketing_hub(uuid)
from public, anon, authenticated;
revoke all on function private_app.can_manage_marketing_hub(uuid)
from public, anon, authenticated;
revoke all on function private_app.marketing_valid_config(text,jsonb)
from public, anon, authenticated;

commit;
