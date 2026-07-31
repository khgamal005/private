-- Applied migration version: 20260731040000
begin;

create schema if not exists commerce_hub;

revoke all on schema commerce_hub
from public, anon, authenticated;

grant usage on schema commerce_hub to service_role;

create table commerce_hub.providers (
  provider_key text primary key
    check (provider_key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name_ar text not null,
  name_en text not null,
  description_ar text not null,
  auth_mode text not null
    check (auth_mode in ('api_keys', 'oauth2', 'access_token', 'custom')),
  setup_mode text not null default 'manual'
    check (setup_mode in ('manual', 'oauth', 'hybrid')),
  adapter_status text not null default 'configuration_ready'
    check (adapter_status in ('active', 'configuration_ready', 'coming_soon', 'disabled')),
  capabilities text[] not null default '{}'::text[],
  required_config_keys text[] not null default '{}'::text[],
  required_secret_keys text[] not null default '{}'::text[],
  optional_secret_keys text[] not null default '{}'::text[],
  status text not null default 'beta'
    check (status in ('active', 'beta', 'coming_soon', 'disabled')),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table commerce_hub.connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  provider_key text not null
    references commerce_hub.providers(provider_key) on delete restrict,
  display_name text,
  status text not null default 'draft'
    check (
      status in (
        'draft',
        'awaiting_authorization',
        'active',
        'degraded',
        'error',
        'disabled'
      )
    ),
  frequency text not null default 'weekly'
    check (frequency in ('manual', 'daily', 'weekly', 'monthly')),
  direction text not null default 'inbound'
    check (direction in ('inbound', 'outbound', 'bidirectional')),
  source_of_truth text not null default 'remote'
    check (source_of_truth in ('remote', 'marktone', 'latest_update')),
  conflict_policy text not null default 'remote_wins'
    check (
      conflict_policy in (
        'remote_wins',
        'marktone_wins',
        'latest_update',
        'manual_review'
      )
    ),
  match_by_sku boolean not null default false,
  sync_scope text[] not null default array[
    'products',
    'categories',
    'variations',
    'coupons'
  ]::text[],
  configuration jsonb not null default '{}'::jsonb
    check (jsonb_typeof(configuration) = 'object'),
  secret_refs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(secret_refs) = 'object'),
  external_store_id text,
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error text,
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

create index commerce_hub_connections_due_idx
on commerce_hub.connections (status, next_sync_at)
where status in ('active', 'degraded');

create index commerce_hub_connections_tenant_idx
on commerce_hub.connections (tenant_id, status, provider_key);

create table commerce_hub.sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references commerce_hub.connections(id) on delete cascade,
  trigger_type text not null
    check (trigger_type in ('manual', 'scheduled', 'webhook', 'recovery')),
  scope text[] not null,
  idempotency_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'success', 'partial', 'failed')),
  fetched_count bigint not null default 0 check (fetched_count >= 0),
  stored_count bigint not null default 0 check (stored_count >= 0),
  created_count bigint not null default 0 check (created_count >= 0),
  updated_count bigint not null default 0 check (updated_count >= 0),
  archived_count bigint not null default 0 check (archived_count >= 0),
  failed_count bigint not null default 0 check (failed_count >= 0),
  cursor jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  error_detail text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, idempotency_key)
);

create index commerce_hub_sync_runs_connection_time_idx
on commerce_hub.sync_runs (connection_id, created_at desc);

create index commerce_hub_sync_runs_tenant_time_idx
on commerce_hub.sync_runs (tenant_id, created_at desc);

create table commerce_hub.webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references commerce_hub.connections(id) on delete cascade,
  provider_key text not null,
  event_name text not null,
  external_event_id text not null,
  signature_valid boolean,
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  error_detail text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (connection_id, external_event_id)
);

create index commerce_hub_webhook_events_queue_idx
on commerce_hub.webhook_events (status, received_at)
where status in ('received', 'failed');

create table commerce_hub.external_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references commerce_hub.connections(id) on delete cascade,
  provider_key text not null
    references commerce_hub.providers(provider_key) on delete restrict,
  entity_type text not null
    check (
      entity_type in (
        'products','categories','attributes','collections','variations',
        'variants','coupons','discounts','orders','customers','webhooks'
      )
    ),
  external_id text not null
    check (nullif(trim(external_id), '') is not null),
  external_parent_id text,
  local_course_id uuid
    references academy.courses(id) on delete set null,
  raw_payload jsonb not null,
  normalized_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(normalized_payload) = 'object'),
  remote_updated_at timestamptz,
  remote_hash text,
  sync_state text not null default 'active'
    check (sync_state in ('active','archived','error')),
  last_seen_run_id uuid
    references commerce_hub.sync_runs(id) on delete set null,
  last_synced_at timestamptz not null default now(),
  archived_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, entity_type, external_id),
  check (
    (sync_state = 'archived' and archived_at is not null)
    or sync_state <> 'archived'
  )
);

create index commerce_hub_external_entities_tenant_type_idx
on commerce_hub.external_entities (
  tenant_id,
  provider_key,
  entity_type,
  remote_updated_at desc
);

create index commerce_hub_external_entities_connection_state_idx
on commerce_hub.external_entities (
  connection_id,
  entity_type,
  sync_state
);

create unique index commerce_hub_external_entities_local_course_idx
on commerce_hub.external_entities (
  connection_id,
  entity_type,
  local_course_id
)
where entity_type = 'products' and local_course_id is not null;

create trigger commerce_hub_providers_set_updated_at
before update on commerce_hub.providers
for each row execute function private_app.set_updated_at();

create trigger commerce_hub_connections_set_updated_at
before update on commerce_hub.connections
for each row execute function private_app.set_updated_at();

create trigger commerce_hub_sync_runs_set_updated_at
before update on commerce_hub.sync_runs
for each row execute function private_app.set_updated_at();

create trigger commerce_hub_external_entities_set_updated_at
before update on commerce_hub.external_entities
for each row execute function private_app.set_updated_at();

alter table commerce_hub.providers enable row level security;
alter table commerce_hub.connections enable row level security;
alter table commerce_hub.sync_runs enable row level security;
alter table commerce_hub.webhook_events enable row level security;
alter table commerce_hub.external_entities enable row level security;

revoke all on all tables in schema commerce_hub
from public, anon, authenticated;
revoke all on all sequences in schema commerce_hub
from public, anon, authenticated;

alter default privileges in schema commerce_hub
revoke all on tables from public, anon, authenticated;
alter default privileges in schema commerce_hub
revoke all on sequences from public, anon, authenticated;

grant select, insert, update, delete on all tables in schema commerce_hub
to service_role;
grant usage, select on all sequences in schema commerce_hub
to service_role;

insert into commerce_hub.providers (
  provider_key,
  name_ar,
  name_en,
  description_ar,
  auth_mode,
  setup_mode,
  adapter_status,
  capabilities,
  required_config_keys,
  required_secret_keys,
  optional_secret_keys,
  status,
  sort_order
)
values
  (
    'woocommerce',
    'WooCommerce',
    'WooCommerce',
    'متجر WordPress للدورات والمنتجات والأسعار والعروض والطلبات.',
    'api_keys',
    'manual',
    'active',
    array['products','categories','attributes','variations','coupons','orders','customers','webhooks'],
    array['storeUrl'],
    array['consumerKey','consumerSecret'],
    '{}'::text[],
    'active',
    10
  ),
  (
    'salla',
    'سلة',
    'Salla',
    'ربط المتجر السعودي عبر تطبيق ماركتون وOAuth مع مزامنة المنتجات والطلبات والعملاء.',
    'oauth2',
    'hybrid',
    'configuration_ready',
    array['products','categories','coupons','orders','customers','webhooks'],
    '{}'::text[],
    array['accessToken'],
    array['refreshToken'],
    'beta',
    20
  ),
  (
    'zid',
    'زد',
    'Zid',
    'ربط متجر زد عبر تطبيق ماركتون مع مزامنة المنتجات والطلبات وحالات الدفع.',
    'oauth2',
    'hybrid',
    'configuration_ready',
    array['products','categories','coupons','orders','customers','webhooks'],
    array['storeId'],
    array['accessToken','authorizationToken'],
    array['refreshToken'],
    'beta',
    30
  ),
  (
    'shopify',
    'Shopify',
    'Shopify',
    'ربط Shopify عبر Admin GraphQL API لمزامنة المنتجات والطلبات والعملاء.',
    'oauth2',
    'hybrid',
    'configuration_ready',
    array['products','collections','variants','discounts','orders','customers','webhooks'],
    array['shopDomain'],
    array['accessToken'],
    array['webhookSecret'],
    'beta',
    40
  ),
  (
    'custom',
    'متجر مخصص',
    'Custom API',
    'ربط أي متجر أو موقع مخصص يوفّر REST أو GraphQL API موثقًا.',
    'custom',
    'manual',
    'configuration_ready',
    array['products','categories','coupons','orders','customers','webhooks'],
    array['baseUrl','authType'],
    '{}'::text[],
    array['apiKey','bearerToken','basicUsername','basicPassword','webhookSecret'],
    'beta',
    90
  )
on conflict (provider_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    auth_mode = excluded.auth_mode,
    setup_mode = excluded.setup_mode,
    adapter_status = excluded.adapter_status,
    capabilities = excluded.capabilities,
    required_config_keys = excluded.required_config_keys,
    required_secret_keys = excluded.required_secret_keys,
    optional_secret_keys = excluded.optional_secret_keys,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.can_manage_commerce_hub(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.write')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id = subject.id
       and membership.scope = 'tenant'
       and membership.status = 'active'
      join access_control.membership_roles membership_role
        on membership_role.membership_id = membership.id
      join access_control.roles role
        on role.id = membership_role.role_id
       and role.scope = 'tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id = role.id
      where subject.auth_user_id = auth.uid()
        and subject.status = 'active'
        and not subject.must_change_password
        and membership.tenant_id = p_tenant_id
        and role_permission.permission_key = 'tenant.integrations.manage'
    )
  );
$$;

revoke all on function private_app.can_manage_commerce_hub(uuid)
from public, anon, authenticated;

create policy commerce_hub_connections_read
on commerce_hub.connections
for select
to authenticated
using (
  private_app.has_tenant_permission(tenant_id, 'tenant.academy.read')
  or private_app.can_manage_commerce_hub(tenant_id)
);

create policy commerce_hub_external_entities_read
on commerce_hub.external_entities
for select
to authenticated
using (
  private_app.has_tenant_permission(tenant_id, 'tenant.academy.read')
  or private_app.can_manage_commerce_hub(tenant_id)
);

create policy commerce_hub_sync_runs_read
on commerce_hub.sync_runs
for select
to authenticated
using (
  private_app.has_tenant_permission(tenant_id, 'tenant.academy.read')
  or private_app.can_manage_commerce_hub(tenant_id)
);

create or replace function private_app.commerce_hub_provider_key(
  p_provider text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_provider text;
begin
  v_provider := lower(trim(coalesce(p_provider, '')));
  if not exists (
    select 1
    from commerce_hub.providers provider
    where provider.provider_key = v_provider
      and provider.status <> 'disabled'
  ) then
    raise exception 'commerce_provider_not_supported';
  end if;
  return v_provider;
end;
$$;

create or replace function private_app.commerce_hub_frequency(
  p_frequency text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_frequency text;
begin
  v_frequency := lower(trim(coalesce(p_frequency, 'weekly')));
  if v_frequency not in ('manual', 'daily', 'weekly', 'monthly') then
    raise exception 'commerce_invalid_frequency';
  end if;
  return v_frequency;
end;
$$;

create or replace function private_app.commerce_hub_scope(
  p_scope jsonb
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_scope text[];
  v_allowed constant text[] := array[
    'products','categories','attributes','collections','variations','variants',
    'coupons','discounts','orders','customers','webhooks'
  ];
begin
  if p_scope is null or jsonb_typeof(p_scope) <> 'array' then
    raise exception 'commerce_invalid_scope';
  end if;

  select coalesce(
    array_agg(distinct lower(trim(item.value)) order by lower(trim(item.value))),
    '{}'::text[]
  )
  into v_scope
  from jsonb_array_elements_text(p_scope) item(value)
  where nullif(trim(item.value), '') is not null;

  if cardinality(v_scope) = 0 or not (v_scope <@ v_allowed) then
    raise exception 'commerce_invalid_scope';
  end if;

  if not ('products' = any(v_scope)) then
    v_scope := array_prepend('products', v_scope);
  end if;

  return v_scope;
end;
$$;

create or replace function private_app.commerce_hub_next_sync(
  p_frequency text,
  p_from timestamptz
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'daily' then p_from + interval '1 day'
    when 'weekly' then p_from + interval '7 days'
    when 'monthly' then p_from + interval '1 month'
    else null
  end;
$$;

create or replace function private_app.commerce_hub_valid_config(
  p_provider text,
  p_config jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_provider commerce_hub.providers%rowtype;
  v_config jsonb;
  v_key text;
  v_value text;
  v_domain text;
  v_url text;
begin
  select * into v_provider
  from commerce_hub.providers provider
  where provider.provider_key = p_provider;

  if v_provider.provider_key is null then
    raise exception 'commerce_provider_not_supported';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    v_config := '{}'::jsonb;
  else
    v_config := p_config;
  end if;

  foreach v_key in array v_provider.required_config_keys loop
    v_value := nullif(trim(v_config ->> v_key), '');
    if v_value is null then
      raise exception 'commerce_required_config_missing:%', v_key;
    end if;
  end loop;

  if p_provider = 'shopify' then
    v_domain := lower(trim(v_config ->> 'shopDomain'));
    v_domain := regexp_replace(v_domain, '^https?://', '');
    v_domain := regexp_replace(v_domain, '/.*$', '');
    if v_domain !~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' then
      raise exception 'commerce_shopify_domain_invalid';
    end if;
    v_config := jsonb_set(v_config, '{shopDomain}', to_jsonb(v_domain), true);
  elsif p_provider = 'custom' then
    v_url := regexp_replace(trim(v_config ->> 'baseUrl'), '/+$', '');
    if length(v_url) not between 12 and 2048
       or v_url !~* '^https://[^[:space:]@?#]+(?:/[^[:space:]?#]*)?$'
       or v_url ~ '[\\]'
       or v_url ~* '^https://(localhost|localhost[.]|[^/]+[.]localhost)(:|/|$)'
       or v_url ~* '^https://(0[.]|10[.]|127[.]|169[.]254[.]|192[.]168[.])([0-9.]*)(:|/|$)'
       or v_url ~* '^https://172[.](1[6-9]|2[0-9]|3[01])[.][0-9.]+(:|/|$)'
       or v_url ~* '^https://100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.][0-9.]+(:|/|$)'
       or v_url ~* '^https://\[(::1|f[cd][0-9a-f:]*|fe8[0-9a-f:]*)(\]|:)'
       or v_url ~* '^https://[^/]+[.](local|internal)(:|/|$)' then
      raise exception 'commerce_public_https_url_required';
    end if;
    if lower(coalesce(v_config ->> 'authType', '')) not in (
      'none','api_key','bearer','basic'
    ) then
      raise exception 'commerce_custom_auth_type_invalid';
    end if;
    v_config := jsonb_set(v_config, '{baseUrl}', to_jsonb(v_url), true);
  end if;

  return v_config;
end;
$$;

revoke all on function private_app.commerce_hub_provider_key(text)
from public, anon, authenticated;
revoke all on function private_app.commerce_hub_frequency(text)
from public, anon, authenticated;
revoke all on function private_app.commerce_hub_scope(jsonb)
from public, anon, authenticated;
revoke all on function private_app.commerce_hub_next_sync(text, timestamptz)
from public, anon, authenticated;
revoke all on function private_app.commerce_hub_valid_config(text, jsonb)
from public, anon, authenticated;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values
  ('addon.integration.salla','ربط سلة','Salla Integration','addon','boolean','false'::jsonb,'beta'),
  ('addon.integration.zid','ربط زد','Zid Integration','addon','boolean','false'::jsonb,'beta'),
  ('addon.integration.shopify','ربط Shopify','Shopify Integration','addon','boolean','false'::jsonb,'beta'),
  ('addon.integration.custom_store','ربط متجر مخصص','Custom Store Integration','addon','boolean','false'::jsonb,'beta')
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    status = excluded.status,
    updated_at = now();

insert into catalog.plan_features (plan_id, feature_id, value)
select plan.id, feature.id, 'true'::jsonb
from catalog.plans plan
join catalog.features feature
  on feature.feature_key in (
    'addon.integration.salla',
    'addon.integration.zid',
    'addon.integration.shopify',
    'addon.integration.custom_store'
  )
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
  valueset.product_key,
  feature.id,
  valueset.name_ar,
  valueset.name_en,
  valueset.description_ar,
  'contact_sales',
  0,
  'SAR',
  'month',
  14,
  valueset.usage_metric,
  null,
  'beta',
  valueset.sort_order
from (
  values
    ('salla','addon.integration.salla','إضافة سلة','Salla Add-on','ربط المنتجات والأسعار والعروض والطلبات والعملاء مع سلة.','salla_sync_entities',81),
    ('zid','addon.integration.zid','إضافة زد','Zid Add-on','ربط المنتجات والأسعار والعروض والطلبات والعملاء مع زد.','zid_sync_entities',82),
    ('shopify','addon.integration.shopify','إضافة Shopify','Shopify Add-on','ربط المنتجات والأسعار والعروض والطلبات والعملاء مع Shopify.','shopify_sync_entities',83),
    ('custom_store','addon.integration.custom_store','إضافة متجر مخصص','Custom Store Add-on','ربط متجر أو موقع مخصص عبر REST أو GraphQL API.','custom_store_sync_entities',89)
) as valueset(
  product_key,
  feature_key,
  name_ar,
  name_en,
  description_ar,
  usage_metric,
  sort_order
)
join catalog.features feature
  on feature.feature_key = valueset.feature_key
on conflict (product_key) do update
set feature_id = excluded.feature_id,
    name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    usage_metric = excluded.usage_metric,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.commerce_hub_try_timestamptz(
  p_value text
)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(trim(p_value), '') is null then return null; end if;
  return p_value::timestamptz;
exception
  when invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;

create or replace function private_app.commerce_hub_try_bigint(
  p_value text
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(trim(p_value), '') !~ '^[0-9]+$' then return null; end if;
  return p_value::bigint;
exception when numeric_value_out_of_range then return null;
end;
$$;

create or replace function private_app.commerce_hub_try_numeric(
  p_value text
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(trim(p_value), '') !~ '^[0-9]+([.][0-9]+)?$' then return null; end if;
  return p_value::numeric;
exception when numeric_value_out_of_range then return null;
end;
$$;

revoke all on function private_app.commerce_hub_try_timestamptz(text)
from public, anon, authenticated;
revoke all on function private_app.commerce_hub_try_bigint(text)
from public, anon, authenticated;
revoke all on function private_app.commerce_hub_try_numeric(text)
from public, anon, authenticated;

commit;
