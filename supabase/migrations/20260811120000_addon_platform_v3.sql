-- Modaar / Marktone add-on platform v3 (DRAFT ONLY).
--
-- Purpose
--   * Keep the v2 add-on, marketplace, tenant and operational data model intact.
--   * Add versioned manifests, declared UI surfaces and media records.
--   * Add immutable annual price history and expiry-aware entitlements.
--   * Add platform payment-provider configuration whose secrets live only in Vault.
--   * Grant every currently published add-on to reef-skills for one fixed year:
--       [2026-08-01 00:00 Asia/Riyadh, 2027-08-01 00:00 Asia/Riyadh).
--
-- Safety contract
--   * No DROP, DELETE, TRUNCATE or operational-data rewrite is performed.
--   * Disabling/uninstalling is represented by entitlement status only; tenant data
--     created by an add-on must be retained.
--   * Existing public v2 RPC signatures remain available.
--   * This draft must be applied to an isolated staging clone and reviewed with
--     Supabase security/performance advisors before production rollout.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('core.tenant_modules') is null
     or to_regclass('catalog.addon_products') is null
     or to_regclass('catalog.tenant_addon_subscriptions') is null
     or to_regclass('marketplace.orders') is null
     or to_regclass('audit_log.events') is null then
    raise exception 'addon_platform_v3_missing_required_schema';
  end if;

  if to_regprocedure('private_app.set_updated_at()') is null
     or to_regprocedure('private_app.addon_entitlement(uuid,text)') is null
     or to_regprocedure('private_app.tenant_addon_enabled(uuid,text)') is null
     or to_regprocedure('private_app.has_platform_permission(text)') is null
     or to_regprocedure('private_app.has_tenant_permission(uuid,text)') is null
     or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     or to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') is null then
    raise exception 'addon_platform_v3_missing_required_function';
  end if;
end;
$preflight$;

-------------------------------------------------------------------------------
-- 1. Versioned add-on catalog contract
-------------------------------------------------------------------------------

create table catalog.addon_manifests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null
    references catalog.addon_products(id) on delete restrict,
  manifest_version text not null
    check (
      manifest_version ~
        '^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-z0-9.-]+)?$'
    ),
  contract_version integer not null default 3
    check (contract_version between 1 and 100),
  short_description_ar text not null,
  long_description_ar text,
  publisher_name text not null default 'Marktone',
  install_mode text not null default 'entitlement'
    check (install_mode in ('entitlement', 'module', 'hybrid')),
  data_policy text not null default 'preserve_on_disable'
    check (
      data_policy in (
        'preserve_on_disable',
        'archive_on_disable'
      )
    ),
  dependencies jsonb not null default '[]'::jsonb
    check (jsonb_typeof(dependencies) = 'array'),
  required_permissions text[] not null default '{}'::text[],
  configuration_schema jsonb not null default '{}'::jsonb
    check (jsonb_typeof(configuration_schema) = 'object'),
  release_notes_ar text,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'retired')),
  is_current boolean not null default false,
  released_at timestamptz,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, manifest_version),
  check (not is_current or status = 'published'),
  check (
    (status = 'published' and released_at is not null)
    or status <> 'published'
  )
);

create unique index addon_manifests_one_current_idx
on catalog.addon_manifests (product_id)
where is_current;

create index addon_manifests_product_status_idx
on catalog.addon_manifests (product_id, status, created_at desc);

create table catalog.addon_surfaces (
  id uuid primary key default gen_random_uuid(),
  manifest_id uuid not null
    references catalog.addon_manifests(id) on delete cascade,
  surface_key text not null
    check (surface_key ~ '^[a-z][a-z0-9_.-]{2,100}$'),
  surface_type text not null
    check (
      surface_type in (
        'navigation',
        'screen',
        'settings',
        'dashboard_card',
        'report',
        'widget',
        'automation',
        'api'
      )
    ),
  location_key text not null
    check (location_key ~ '^[a-z][a-z0-9_.-]{2,100}$'),
  title_ar text not null,
  description_ar text,
  route_template text
    check (
      route_template is null
      or (
        route_template like '/%'
        and length(route_template) <= 500
      )
    ),
  icon_key text,
  required_permission text,
  visibility_mode text not null default 'when_entitled'
    check (
      visibility_mode in (
        'when_entitled',
        'always_locked',
        'platform_only'
      )
    ),
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  sort_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manifest_id, surface_key)
);

create index addon_surfaces_manifest_status_idx
on catalog.addon_surfaces (manifest_id, status, sort_order);

create table catalog.addon_media (
  id uuid primary key default gen_random_uuid(),
  manifest_id uuid not null
    references catalog.addon_manifests(id) on delete cascade,
  surface_id uuid
    references catalog.addon_surfaces(id) on delete set null,
  media_key text not null
    check (media_key ~ '^[a-z][a-z0-9_.-]{2,100}$'),
  media_type text not null
    check (
      media_type in (
        'thumbnail',
        'screenshot',
        'video',
        'gif',
        'icon'
      )
    ),
  media_role text not null default 'gallery'
    check (media_role in ('cover', 'gallery', 'onboarding', 'help')),
  storage_bucket text,
  storage_path text,
  external_url text
    check (
      external_url is null
      or external_url ~ '^https://[^[:space:]]+$'
    ),
  alt_ar text not null,
  caption_ar text,
  width_px integer check (width_px is null or width_px between 1 and 10000),
  height_px integer check (height_px is null or height_px between 1 and 10000),
  sort_order integer not null default 100,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manifest_id, media_key),
  check (
    (storage_bucket is null and storage_path is null)
    or
    (nullif(trim(storage_bucket), '') is not null
      and nullif(trim(storage_path), '') is not null)
  ),
  check (
    status <> 'active'
    or (
      ((storage_path is not null)::integer
        + (external_url is not null)::integer) = 1
    )
  )
);

create index addon_media_manifest_status_idx
on catalog.addon_media (manifest_id, status, sort_order);

-------------------------------------------------------------------------------
-- 2. Annual price history
-------------------------------------------------------------------------------

create table catalog.addon_price_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null
    references catalog.addon_products(id) on delete restrict,
  pricing_mode text not null default 'fixed'
    check (pricing_mode in ('fixed', 'free', 'contact_sales')),
  amount_minor bigint not null default 0
    check (amount_minor >= 0),
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  billing_interval text not null default 'year'
    check (billing_interval = 'year'),
  valid_from date not null,
  valid_to date,
  tax_inclusive boolean not null default false,
  tax_rate_bps integer not null default 1500
    check (tax_rate_bps between 0 and 10000),
  change_note text,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (product_id, currency, valid_from),
  check (valid_to is null or valid_to > valid_from),
  check (
    (pricing_mode = 'fixed' and amount_minor > 0)
    or
    (pricing_mode in ('free', 'contact_sales') and amount_minor = 0)
  )
);

create index addon_price_versions_current_lookup_idx
on catalog.addon_price_versions (
  product_id,
  currency,
  valid_from desc
)
where valid_to is null;

create or replace function private_app.addon_price_reject_overlap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      new.product_id::text || ':' || new.currency || ':year',
      0
    )
  );

  if exists (
    select 1
    from catalog.addon_price_versions price
    where price.product_id = new.product_id
      and price.currency = new.currency
      and price.id <> new.id
      and daterange(
            price.valid_from,
            price.valid_to,
            '[)'
          ) && daterange(new.valid_from, new.valid_to, '[)')
  ) then
    raise exception 'addon_price_period_overlap';
  end if;

  return new;
end;
$$;


revoke all on function private_app.addon_price_reject_overlap()
from public, anon, authenticated, service_role;

create trigger addon_price_versions_reject_overlap
before insert or update on catalog.addon_price_versions
for each row execute function private_app.addon_price_reject_overlap();

-------------------------------------------------------------------------------
-- 3. Platform payment provider configuration (Vault references only)
-------------------------------------------------------------------------------

create or replace function private_app.jsonb_has_sensitive_key(
  p_value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_child jsonb;
begin
  if p_value is null then
    return false;
  end if;

  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in
      select item.key, item.value
      from jsonb_each(p_value) item
    loop
      if v_key ~* '(secret|token|password|credential|api[_-]?key|client[_-]?id|private[_-]?key|public[_-]?key|hmac|signature)' then
        return true;
      end if;
      if private_app.jsonb_has_sensitive_key(v_child) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in
      select item.value
      from jsonb_array_elements(p_value) item
    loop
      if private_app.jsonb_has_sensitive_key(v_child) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

revoke all on function private_app.jsonb_has_sensitive_key(jsonb)
from public, anon, authenticated, service_role;

create table marketplace.payment_provider_configs (
  provider_key text primary key
    check (provider_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  name_ar text not null,
  name_en text,
  status text not null default 'draft'
    check (status in ('draft', 'configured', 'active', 'disabled', 'error')),
  environment text not null default 'sandbox'
    check (environment in ('sandbox', 'live')),
  checkout_mode text not null default 'redirect'
    check (checkout_mode in ('redirect', 'embedded', 'api')),
  supported_currencies text[] not null default array['SAR']::text[],
  required_secret_keys text[] not null default '{}'::text[],
  optional_secret_keys text[] not null default '{}'::text[],
  public_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(public_config) = 'object'),
  last_verified_at timestamptz,
  last_error_code text,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(supported_currencies) between 1 and 20),
  check (
    not private_app.jsonb_has_sensitive_key(public_config)
  )
);

create table marketplace.payment_provider_secret_refs (
  provider_key text not null
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict,
  secret_key text not null
    check (secret_key ~ '^[a-z][A-Za-z0-9]{1,80}$'),
  vault_secret_id uuid not null unique,
  last_rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_key, secret_key)
);

create index payment_provider_configs_status_order_idx
on marketplace.payment_provider_configs (status, sort_order);

-------------------------------------------------------------------------------
-- 4. Subscription billing references and immutable lifecycle events
-------------------------------------------------------------------------------

alter table catalog.tenant_addon_subscriptions
  add column if not exists price_version_id uuid,
  add column if not exists payment_provider_key text,
  add column if not exists marketplace_order_id uuid,
  add column if not exists external_subscription_ref text,
  add column if not exists auto_renew boolean not null default false,
  add column if not exists activated_at timestamptz,
  add column if not exists ended_at timestamptz;

alter table catalog.tenant_addon_subscriptions
  add constraint tenant_addons_price_version_fk_v3
    foreign key (price_version_id)
    references catalog.addon_price_versions(id)
    on delete restrict
    not valid,
  add constraint tenant_addons_payment_provider_fk_v3
    foreign key (payment_provider_key)
    references marketplace.payment_provider_configs(provider_key)
    on delete restrict
    not valid,
  add constraint tenant_addons_marketplace_order_fk_v3
    foreign key (marketplace_order_id)
    references marketplace.orders(id)
    on delete restrict
    not valid,
  add constraint tenant_addons_period_order_check_v3
    check (
      period_end is null
      or period_start is null
      or period_end > period_start
    ) not valid,
  add constraint tenant_addons_ended_after_activation_check_v3
    check (
      ended_at is null
      or activated_at is null
      or ended_at >= activated_at
    ) not valid;

create index tenant_addons_price_reference_idx_v3
on catalog.tenant_addon_subscriptions (price_version_id)
where price_version_id is not null;

create index tenant_addons_payment_provider_idx_v3
on catalog.tenant_addon_subscriptions (payment_provider_key)
where payment_provider_key is not null;

create index tenant_addons_marketplace_order_idx_v3
on catalog.tenant_addon_subscriptions (marketplace_order_id)
where marketplace_order_id is not null;

create index tenant_addons_tenant_expiry_idx_v3
on catalog.tenant_addon_subscriptions (
  tenant_id,
  status,
  period_end
)
where status in ('trialing', 'active', 'paused');

create table catalog.tenant_addon_subscription_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null
    references catalog.tenant_addon_subscriptions(id) on delete restrict,
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  product_id uuid not null
    references catalog.addon_products(id) on delete restrict,
  event_key text not null,
  event_type text not null
    check (
      event_type in (
        'requested',
        'trial_started',
        'activated',
        'renewed',
        'paused',
        'resumed',
        'cancel_scheduled',
        'cancelled',
        'expired',
        'payment_linked',
        'migration_grant'
      )
    ),
  from_status text,
  to_status text,
  effective_at timestamptz not null default now(),
  actor_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, product_id, event_key)
);

create index tenant_addon_events_subscription_time_idx
on catalog.tenant_addon_subscription_events (
  subscription_id,
  effective_at desc
);

create index tenant_addon_events_tenant_time_idx
on catalog.tenant_addon_subscription_events (
  tenant_id,
  effective_at desc
);

-------------------------------------------------------------------------------
-- 5. Timestamp triggers, RLS and direct-access revocation
-------------------------------------------------------------------------------

create trigger addon_manifests_set_updated_at
before update on catalog.addon_manifests
for each row execute function private_app.set_updated_at();

create trigger addon_surfaces_set_updated_at
before update on catalog.addon_surfaces
for each row execute function private_app.set_updated_at();

create trigger addon_media_set_updated_at
before update on catalog.addon_media
for each row execute function private_app.set_updated_at();

create trigger payment_provider_configs_set_updated_at
before update on marketplace.payment_provider_configs
for each row execute function private_app.set_updated_at();

create trigger payment_provider_secret_refs_set_updated_at
before update on marketplace.payment_provider_secret_refs
for each row execute function private_app.set_updated_at();

alter table catalog.addon_manifests enable row level security;
alter table catalog.addon_manifests force row level security;
alter table catalog.addon_surfaces enable row level security;
alter table catalog.addon_surfaces force row level security;
alter table catalog.addon_media enable row level security;
alter table catalog.addon_media force row level security;
alter table catalog.addon_price_versions enable row level security;
alter table catalog.addon_price_versions force row level security;
alter table catalog.tenant_addon_subscription_events enable row level security;
alter table catalog.tenant_addon_subscription_events force row level security;
alter table marketplace.payment_provider_configs enable row level security;
alter table marketplace.payment_provider_configs force row level security;
alter table marketplace.payment_provider_secret_refs enable row level security;
alter table marketplace.payment_provider_secret_refs force row level security;

create policy addon_manifests_platform_read_v3
on catalog.addon_manifests
for select to authenticated
using (
  private_app.has_platform_permission('platform.control.read')
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy addon_surfaces_platform_read_v3
on catalog.addon_surfaces
for select to authenticated
using (
  private_app.has_platform_permission('platform.control.read')
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy addon_media_platform_read_v3
on catalog.addon_media
for select to authenticated
using (
  private_app.has_platform_permission('platform.control.read')
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy addon_price_versions_platform_read_v3
on catalog.addon_price_versions
for select to authenticated
using (
  private_app.has_platform_permission('platform.control.read')
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy tenant_addon_events_isolated_read_v3
on catalog.tenant_addon_subscription_events
for select to authenticated
using (
  private_app.can_access_tenant(tenant_id)
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy payment_provider_configs_platform_read_v3
on marketplace.payment_provider_configs
for select to authenticated
using (private_app.has_platform_permission('platform.billing.manage'));

create policy payment_provider_secret_refs_platform_read_v3
on marketplace.payment_provider_secret_refs
for select to authenticated
using (private_app.has_platform_permission('platform.billing.manage'));

revoke all on table catalog.addon_manifests
from public, anon, authenticated;
revoke all on table catalog.addon_surfaces
from public, anon, authenticated;
revoke all on table catalog.addon_media
from public, anon, authenticated;
revoke all on table catalog.addon_price_versions
from public, anon, authenticated;
revoke all on table catalog.tenant_addon_subscription_events
from public, anon, authenticated;
revoke all on table marketplace.payment_provider_configs
from public, anon, authenticated;
revoke all on table marketplace.payment_provider_secret_refs
from public, anon, authenticated;

-------------------------------------------------------------------------------
-- 6. Seed the catalog contract without inventing or exposing credentials
-------------------------------------------------------------------------------

insert into catalog.addon_manifests (
  product_id,
  manifest_version,
  contract_version,
  short_description_ar,
  long_description_ar,
  publisher_name,
  install_mode,
  data_policy,
  dependencies,
  required_permissions,
  configuration_schema,
  release_notes_ar,
  status,
  is_current,
  released_at
)
select
  product.id,
  '1.0.0',
  3,
  coalesce(nullif(trim(product.description_ar), ''), product.name_ar),
  coalesce(nullif(trim(product.description_ar), ''), product.name_ar),
  'Marktone',
  case
    when product.activation_mode = 'module' then 'module'
    else 'entitlement'
  end,
  'preserve_on_disable',
  '[]'::jsonb,
  case
    when product.product_key in (
      'woocommerce', 'salla', 'zid', 'shopify', 'custom_store'
    ) then array['tenant.integrations.manage']::text[]
    when product.product_key = 'marketing_attribution'
      then array['tenant.marketing.read', 'tenant.marketing.manage']::text[]
    when product.product_key = 'yeastar'
      then array['tenant.crm.read', 'tenant.settings.manage']::text[]
    when product.product_key = 'cms_pro'
      then array['tenant.website.read', 'tenant.website.manage']::text[]
    else array['tenant.settings.manage']::text[]
  end,
  jsonb_build_object(
    '$schema', 'https://json-schema.org/draft/2020-12/schema',
    'type', 'object',
    'additionalProperties', false,
    'properties', '{}'::jsonb
  ),
  'تسجيل عقد الإضافة الحالي في منصة الإضافات v3 دون تغيير بيانات التشغيل.',
  'published',
  true,
  timestamptz '2026-08-01 00:00:00+03'
from catalog.addon_products product
where product.status in ('beta', 'active')
on conflict (product_id, manifest_version) do nothing;

-- Every product has one permanent catalog/control surface. This is visible even
-- when locked, just like the WordPress plug-in catalog.
insert into catalog.addon_surfaces (
  manifest_id,
  surface_key,
  surface_type,
  location_key,
  title_ar,
  description_ar,
  route_template,
  icon_key,
  required_permission,
  visibility_mode,
  status,
  sort_order,
  metadata
)
select
  manifest.id,
  'tenant.addons',
  'settings',
  'tenant.settings.addons',
  'إدارة ' || product.name_ar,
  'السعر السنوي، مدة الاشتراك، الشرح، الشاشات والصور الخاصة بالإضافة.',
  '/tenant/{slug}/settings?tab=addons&addon=' || product.product_key,
  'puzzle',
  'tenant.settings.manage',
  'always_locked',
  'active',
  10,
  jsonb_build_object('productKey', product.product_key)
from catalog.addon_manifests manifest
join catalog.addon_products product on product.id = manifest.product_id
where manifest.is_current
on conflict (manifest_id, surface_key) do nothing;

-- Known live surfaces from the current application routes. New add-ons must add
-- their own rows before they may be marked published.
insert into catalog.addon_surfaces (
  manifest_id,
  surface_key,
  surface_type,
  location_key,
  title_ar,
  description_ar,
  route_template,
  icon_key,
  required_permission,
  visibility_mode,
  status,
  sort_order,
  metadata
)
select
  manifest.id,
  seed.surface_key,
  seed.surface_type,
  seed.location_key,
  seed.title_ar,
  seed.description_ar,
  seed.route_template,
  seed.icon_key,
  seed.required_permission,
  'when_entitled',
  'active',
  seed.sort_order,
  jsonb_build_object('productKey', seed.product_key)
from (
  values
    (
      'whatsapp', 'tenant.settings.integrations', 'settings',
      'tenant.settings.integrations', 'إعدادات واتساب',
      'ربط مزود واتساب وإدارة إعداداته الآمنة.',
      '/tenant/{slug}/settings?tab=integrations', 'whatsapp',
      'tenant.settings.manage', 20
    ),
    (
      'email', 'tenant.settings.integrations', 'settings',
      'tenant.settings.integrations', 'إعدادات البريد',
      'ربط مزود البريد وإدارة الإرسال.',
      '/tenant/{slug}/settings?tab=integrations', 'mail',
      'tenant.settings.manage', 20
    ),
    (
      'zoom', 'tenant.settings.integrations', 'settings',
      'tenant.settings.integrations', 'إعدادات Zoom',
      'ربط الاجتماعات والجلسات التدريبية.',
      '/tenant/{slug}/settings?tab=integrations', 'video',
      'tenant.settings.manage', 20
    ),
    (
      'api', 'tenant.settings.integrations', 'settings',
      'tenant.settings.integrations', 'واجهات API',
      'إدارة الربط مع مزود أو نظام خارجي.',
      '/tenant/{slug}/settings?tab=integrations', 'api',
      'tenant.settings.manage', 20
    ),
    (
      'automation', 'tenant.settings.automation', 'automation',
      'tenant.settings.automation', 'الأتمتة الذكية',
      'إدارة قواعد الحدث والشرط والإجراء.',
      '/tenant/{slug}/settings?tab=automation', 'automation',
      'tenant.settings.manage', 20
    ),
    (
      'templates', 'tenant.settings.templates', 'settings',
      'tenant.settings.templates', 'قوالب الرسائل',
      'إنشاء القوالب وإدارة المتغيرات.',
      '/tenant/{slug}/settings?tab=templates', 'template',
      'tenant.settings.manage', 20
    ),
    (
      'delivery_analytics', 'tenant.settings.delivery', 'report',
      'tenant.settings.delivery', 'إثبات التسليم والتحليلات',
      'حالات القبول والتسليم والقراءة والفشل والتكلفة.',
      '/tenant/{slug}/settings?tab=delivery', 'analytics',
      'tenant.settings.manage', 20
    ),
    (
      'woocommerce', 'tenant.integrations', 'screen',
      'tenant.commerce.integrations', 'ربط WooCommerce',
      'الإعداد والمزامنة ومتابعة حالة الربط.',
      '/tenant/{slug}/integrations?provider=woocommerce', 'store',
      'tenant.integrations.manage', 20
    ),
    (
      'salla', 'tenant.integrations', 'screen',
      'tenant.commerce.integrations', 'ربط سلة',
      'الإعداد والمزامنة ومتابعة حالة الربط.',
      '/tenant/{slug}/integrations?provider=salla', 'store',
      'tenant.integrations.manage', 20
    ),
    (
      'zid', 'tenant.integrations', 'screen',
      'tenant.commerce.integrations', 'ربط زد',
      'الإعداد والمزامنة ومتابعة حالة الربط.',
      '/tenant/{slug}/integrations?provider=zid', 'store',
      'tenant.integrations.manage', 20
    ),
    (
      'shopify', 'tenant.integrations', 'screen',
      'tenant.commerce.integrations', 'ربط Shopify',
      'الإعداد والمزامنة ومتابعة حالة الربط.',
      '/tenant/{slug}/integrations?provider=shopify', 'store',
      'tenant.integrations.manage', 20
    ),
    (
      'custom_store', 'tenant.integrations', 'screen',
      'tenant.commerce.integrations', 'ربط متجر مخصص',
      'الإعداد والمزامنة ومتابعة حالة الربط.',
      '/tenant/{slug}/integrations?provider=custom', 'store',
      'tenant.integrations.manage', 20
    ),
    (
      'marketing_attribution', 'tenant.marketing', 'screen',
      'tenant.marketing.command_center', 'مركز الحملات',
      'الربط والتحليلات الموحدة وقياس الإسناد.',
      '/tenant/{slug}/marketing', 'campaign',
      'tenant.marketing.read', 20
    ),
    (
      'yeastar', 'tenant.yeastar', 'report',
      'tenant.telephony.reports', 'تقارير Yeastar',
      'تقارير المكالمات والتحويلات ومدة الاتصال.',
      '/tenant/{slug}/yeastar', 'phone',
      'tenant.crm.read', 20
    ),
    (
      'cms_pro', 'tenant.website', 'screen',
      'tenant.website.cms', 'الموقع الإلكتروني',
      'الموقع والمتجر والصفحات والمقالات وSEO.',
      '/tenant/{slug}/website', 'website',
      'tenant.website.read', 20
    )
) seed(
  product_key,
  surface_key,
  surface_type,
  location_key,
  title_ar,
  description_ar,
  route_template,
  icon_key,
  required_permission,
  sort_order
)
join catalog.addon_products product
  on product.product_key = seed.product_key
join catalog.addon_manifests manifest
  on manifest.product_id = product.id
 and manifest.is_current
on conflict (manifest_id, surface_key) do nothing;

-- Draft media slots make missing screenshots explicit to platform admins without
-- emitting broken tenant URLs. They become tenant-visible only after a verified
-- storage path or HTTPS URL is supplied and status is set to active.
insert into catalog.addon_media (
  manifest_id,
  media_key,
  media_type,
  media_role,
  alt_ar,
  caption_ar,
  sort_order,
  status
)
select
  manifest.id,
  slot.media_key,
  'screenshot',
  slot.media_role,
  slot.alt_prefix || product.name_ar,
  'بانتظار رفع لقطة شاشة حقيقية ومعتمدة من لوحة المنصة.',
  slot.sort_order,
  'draft'
from catalog.addon_manifests manifest
join catalog.addon_products product on product.id = manifest.product_id
cross join (
  values
    ('overview.cover', 'cover', 'غلاف إضافة ', 10),
    ('screen.primary', 'gallery', 'الشاشة الأساسية لإضافة ', 20),
    ('screen.details', 'gallery', 'تفاصيل التحكم في إضافة ', 30)
) slot(media_key, media_role, alt_prefix, sort_order)
where manifest.is_current
on conflict (manifest_id, media_key) do nothing;

-- Initial annual launch prices. Money is stored in minor units; future changes
-- append a dated version instead of overwriting history.
insert into catalog.addon_price_versions (
  product_id,
  pricing_mode,
  amount_minor,
  currency,
  billing_interval,
  valid_from,
  valid_to,
  tax_inclusive,
  tax_rate_bps,
  change_note
)
select
  product.id,
  'fixed',
  seed.amount_minor,
  'SAR',
  'year',
  date '2026-08-01',
  null,
  false,
  1500,
  'Initial annual launch price approved for the v3 add-on catalog.'
from (
  values
    ('templates', 40000::bigint),
    ('email', 60000::bigint),
    ('zoom', 60000::bigint),
    ('delivery_analytics', 80000::bigint),
    ('whatsapp', 90000::bigint),
    ('woocommerce', 90000::bigint),
    ('salla', 90000::bigint),
    ('zid', 90000::bigint),
    ('shopify', 100000::bigint),
    ('automation', 120000::bigint),
    ('marketing_attribution', 140000::bigint),
    ('api', 150000::bigint),
    ('custom_store', 180000::bigint),
    ('yeastar', 200000::bigint),
    ('cms_pro', 200000::bigint)
) seed(product_key, amount_minor)
join catalog.addon_products product
  on product.product_key = seed.product_key
where product.status in ('beta', 'active')
on conflict (product_id, currency, valid_from) do nothing;

-- v2 marketplace reads the denormalized columns. Keep them synchronized so old
-- callers immediately create a one-year entitlement instead of one month.
update catalog.addon_products product
set pricing_mode = price.pricing_mode,
    amount_minor = price.amount_minor,
    currency = price.currency,
    interval = 'year',
    updated_at = now()
from catalog.addon_price_versions price
where price.product_id = product.id
  and price.valid_from = date '2026-08-01'
  and price.valid_to is null
  and (
    product.pricing_mode is distinct from price.pricing_mode
    or product.amount_minor is distinct from price.amount_minor
    or product.currency is distinct from price.currency
    or product.interval is distinct from 'year'
  );

insert into marketplace.payment_provider_configs (
  provider_key,
  name_ar,
  name_en,
  status,
  environment,
  checkout_mode,
  supported_currencies,
  required_secret_keys,
  optional_secret_keys,
  public_config,
  sort_order
)
values
  (
    'tamara',
    'تمارا',
    'Tamara',
    'draft',
    'sandbox',
    'redirect',
    array['SAR']::text[],
    array['apiToken']::text[],
    array['notificationToken']::text[],
    jsonb_build_object(
      'displayLabelAr', 'ادفع مع تمارا',
      'returnUrlPath', '/api/payments/tamara/return',
      'webhookPath', '/api/payments/tamara/webhook'
    ),
    10
  ),
  (
    'paymob',
    'باي موب',
    'Paymob',
    'draft',
    'sandbox',
    'redirect',
    array['SAR', 'EGP']::text[],
    array['secretKey', 'publicKey', 'hmacSecret']::text[],
    array['apiKey']::text[],
    jsonb_build_object(
      'displayLabelAr', 'الدفع الإلكتروني',
      'returnUrlPath', '/api/payments/paymob/return',
      'webhookPath', '/api/payments/paymob/webhook'
    ),
    20
  ),
  (
    'paypal',
    'باي بال',
    'PayPal',
    'draft',
    'sandbox',
    'redirect',
    array['SAR', 'USD']::text[],
    array['clientId', 'clientSecret']::text[],
    array['webhookId']::text[],
    jsonb_build_object(
      'displayLabelAr', 'الدفع عبر PayPal',
      'returnUrlPath', '/api/payments/paypal/return',
      'webhookPath', '/api/payments/paypal/webhook'
    ),
    30
  )
on conflict (provider_key) do nothing;

-------------------------------------------------------------------------------
-- 7. Fixed one-year Reef grant; subscription/config rows only
-------------------------------------------------------------------------------

do $reef_grant$
declare
  v_reef_tenant_id uuid;
  v_product_count integer;
  v_subscription_count integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('addon_platform_v3:reef-skills', 0)
  );

  select tenant.id
  into v_reef_tenant_id
  from core.tenants tenant
  where tenant.tenant_key = 'tenant-reef-skills'
    and tenant.slug = 'reef-skills'
  limit 1;

  if v_reef_tenant_id is null then
    raise exception 'reef_skills_tenant_not_found_v3';
  end if;

  insert into catalog.tenant_addon_subscriptions as current_subscription (
    tenant_id,
    product_id,
    status,
    source,
    custom_limit,
    period_start,
    period_end,
    requested_note,
    decision_note,
    cancel_at_period_end,
    price_version_id,
    auto_renew,
    activated_at,
    ended_at
  )
  select
    v_reef_tenant_id,
    product.id,
    'active',
    'migration',
    null,
    timestamptz '2026-08-01 00:00:00+03',
    timestamptz '2027-08-01 00:00:00+03',
    'Reef full add-on access requested for the first live tenant.',
    'reef_all_addons_2026_2027',
    false,
    price.id,
    false,
    timestamptz '2026-08-01 00:00:00+03',
    null
  from catalog.addon_products product
  left join lateral (
    select annual_price.id
    from catalog.addon_price_versions annual_price
    where annual_price.product_id = product.id
      and annual_price.currency = 'SAR'
      and annual_price.valid_from <= date '2026-08-01'
      and (
        annual_price.valid_to is null
        or annual_price.valid_to > date '2026-08-01'
      )
    order by annual_price.valid_from desc
    limit 1
  ) price on true
  where product.status in ('beta', 'active')
  on conflict (tenant_id, product_id)
    where status in ('pending', 'trialing', 'active', 'paused')
  do update
  set status = 'active',
      source = case
        when current_subscription.source = 'billing'
          then current_subscription.source
        else 'migration'
      end,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      cancel_at_period_end = false,
      price_version_id = coalesce(
        excluded.price_version_id,
        current_subscription.price_version_id
      ),
      auto_renew = false,
      activated_at = coalesce(
        current_subscription.activated_at,
        excluded.activated_at
      ),
      ended_at = null,
      decision_note = coalesce(
        current_subscription.decision_note,
        excluded.decision_note
      ),
      updated_at = now();

  insert into catalog.tenant_addon_subscription_events (
    subscription_id,
    tenant_id,
    product_id,
    event_key,
    event_type,
    from_status,
    to_status,
    effective_at,
    metadata
  )
  select
    subscription.id,
    subscription.tenant_id,
    subscription.product_id,
    'reef_all_addons_20260801_' || product.product_key,
    'migration_grant',
    null,
    'active',
    timestamptz '2026-08-01 00:00:00+03',
    jsonb_build_object(
      'productKey', product.product_key,
      'startsAt', timestamptz '2026-08-01 00:00:00+03',
      'endsAt', timestamptz '2027-08-01 00:00:00+03',
      'preserveOperationalData', true
    )
  from catalog.tenant_addon_subscriptions subscription
  join catalog.addon_products product
    on product.id = subscription.product_id
  where subscription.tenant_id = v_reef_tenant_id
    and subscription.status = 'active'
    and subscription.period_start =
      timestamptz '2026-08-01 00:00:00+03'
    and subscription.period_end =
      timestamptz '2027-08-01 00:00:00+03'
  on conflict (tenant_id, product_id, event_key) do nothing;

  -- Module-style add-ons need only their module switch enabled. No site page,
  -- customer, task, call, campaign or other operational record is touched.
  insert into core.tenant_modules as current_module (
    tenant_id,
    module_id,
    enabled,
    configuration,
    enabled_at,
    updated_at
  )
  select
    v_reef_tenant_id,
    module.id,
    true,
    jsonb_build_object(
      'addonPlatformVersion', 3,
      'addonProductKey', product.product_key,
      'entitledFrom', '2026-08-01T00:00:00+03:00',
      'entitledUntil', '2027-08-01T00:00:00+03:00',
      'dataPolicy', 'preserve_on_disable'
    ),
    coalesce(
      (
        select existing.enabled_at
        from core.tenant_modules existing
        where existing.tenant_id = v_reef_tenant_id
          and existing.module_id = module.id
      ),
      timestamptz '2026-08-01 00:00:00+03'
    ),
    now()
  from catalog.addon_products product
  join catalog.features feature on feature.id = product.feature_id
  join core.modules module
    on feature.feature_key = 'module.' || module.module_key
  where product.status in ('beta', 'active')
    and product.activation_mode = 'module'
  on conflict (tenant_id, module_id) do update
  set enabled = true,
      configuration = current_module.configuration
        || excluded.configuration,
      enabled_at = coalesce(
        current_module.enabled_at,
        excluded.enabled_at
      ),
      updated_at = now();

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  select
    v_reef_tenant_id,
    null,
    'catalog.addon.reef_year_grant_v3',
    'tenant',
    v_reef_tenant_id::text,
    jsonb_build_object(
      'startsAt', timestamptz '2026-08-01 00:00:00+03',
      'endsAt', timestamptz '2027-08-01 00:00:00+03',
      'scope', 'all_published_addons',
      'operationalRowsChanged', false
    )
  where not exists (
    select 1
    from audit_log.events event
    where event.tenant_id = v_reef_tenant_id
      and event.action = 'catalog.addon.reef_year_grant_v3'
      and event.resource_id = v_reef_tenant_id::text
  );

  select count(*)
  into v_product_count
  from catalog.addon_products product
  where product.status in ('beta', 'active');

  select count(*)
  into v_subscription_count
  from catalog.tenant_addon_subscriptions subscription
  join catalog.addon_products product
    on product.id = subscription.product_id
   and product.status in ('beta', 'active')
  where subscription.tenant_id = v_reef_tenant_id
    and subscription.status = 'active'
    and subscription.period_start =
      timestamptz '2026-08-01 00:00:00+03'
    and subscription.period_end =
      timestamptz '2027-08-01 00:00:00+03';

  if v_subscription_count <> v_product_count then
    raise exception
      'reef_addon_grant_incomplete:%/%',
      v_subscription_count,
      v_product_count;
  end if;
end;
$reef_grant$;

-------------------------------------------------------------------------------
-- 8. Expiry-aware entitlement source of truth
-------------------------------------------------------------------------------

-- Freeze the proven v2 calculation (plan/override precedence and usage counters)
-- under a private name, then project date-aware state on top of it. The public
-- private_app.addon_entitlement signature is replaced below, so every old caller
-- becomes expiry-aware without changing its arguments.
create or replace function private_app.addon_entitlement_v2_base(
  p_tenant_id uuid,
  p_feature_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_feature catalog.features%rowtype;
  v_product catalog.addon_products%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_override boolean;
  v_plan_enabled boolean;
  v_default_enabled boolean;
  v_enabled boolean := false;
  v_source text := 'none';
  v_status text := 'disabled';
  v_limit bigint;
  v_period_start date := date_trunc('month', now())::date;
  v_period_end date :=
    (date_trunc('month', now()) + interval '1 month')::date;
  v_used bigint := 0;
  v_reserved bigint := 0;
begin
  select * into v_feature
  from catalog.features feature
  where feature.feature_key = p_feature_key
  limit 1;

  if v_feature.id is null then
    return jsonb_build_object(
      'enabled', false,
      'source', 'missing',
      'status', 'disabled'
    );
  end if;

  select * into v_product
  from catalog.addon_products product
  where product.feature_id = v_feature.id
  limit 1;

  select (override.value #>> '{}')::boolean
  into v_override
  from catalog.tenant_feature_overrides override
  where override.tenant_id = p_tenant_id
    and override.feature_id = v_feature.id
  limit 1;

  select * into v_subscription
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id = p_tenant_id
    and subscription.product_id = v_product.id
    and subscription.status in (
      'pending', 'trialing', 'active', 'paused'
    )
  order by subscription.created_at desc
  limit 1;

  select (plan_feature.value #>> '{}')::boolean
  into v_plan_enabled
  from catalog.subscriptions subscription
  join catalog.plan_features plan_feature
    on plan_feature.plan_id = subscription.plan_id
  where subscription.tenant_id = p_tenant_id
    and subscription.status in ('trialing', 'active')
    and plan_feature.feature_id = v_feature.id
  order by subscription.created_at desc
  limit 1;

  begin
    v_default_enabled := (v_feature.default_value #>> '{}')::boolean;
  exception when others then
    v_default_enabled := false;
  end;

  if v_override is not null then
    v_enabled := v_override;
    v_source := 'override';
    v_status := case when v_override then 'active' else 'disabled' end;
  elsif coalesce(v_plan_enabled, false) then
    v_enabled := true;
    v_source := 'plan';
    v_status := 'included';
  elsif v_subscription.status = 'active' then
    v_enabled := true;
    v_source := 'subscription';
    v_status := 'active';
  elsif v_subscription.status = 'trialing'
        and coalesce(v_subscription.trial_end, now()) >= now() then
    v_enabled := true;
    v_source := 'subscription';
    v_status := 'trialing';
  elsif v_subscription.status is not null then
    v_source := 'subscription';
    v_status := v_subscription.status;
  elsif coalesce(v_default_enabled, false) then
    v_enabled := true;
    v_source := 'default';
    v_status := 'active';
  end if;

  v_limit := coalesce(
    v_subscription.custom_limit,
    v_product.default_limit
  );

  if v_product.usage_metric = 'automation_runs' then
    select count(*) into v_used
    from automation_engine.runs run
    where run.tenant_id = p_tenant_id
      and run.created_at >= v_period_start;
  elsif v_product.usage_metric = 'active_templates' then
    select count(*) into v_used
    from communication_hub.message_templates template
    where template.tenant_id = p_tenant_id
      and template.status = 'active';
  elsif v_product.usage_metric = 'delivery_events' then
    select count(*) into v_used
    from communication_hub.delivery_events event
    where event.tenant_id = p_tenant_id
      and event.occurred_at >= v_period_start;
  elsif v_product.id is not null then
    select
      coalesce(counter.used_quantity, 0),
      coalesce(counter.reserved_quantity, 0)
    into v_used, v_reserved
    from catalog.addon_usage_counters counter
    where counter.tenant_id = p_tenant_id
      and counter.product_id = v_product.id
      and counter.metric_key = v_product.usage_metric
      and counter.period_start = v_period_start;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'enabled', v_enabled,
    'source', v_source,
    'status', v_status,
    'featureKey', v_feature.feature_key,
    'productId', v_product.id,
    'productKey', v_product.product_key,
    'metricKey', v_product.usage_metric,
    'limit', v_limit,
    'used', coalesce(v_used, 0),
    'reserved', coalesce(v_reserved, 0),
    'remaining', case
      when v_limit is null then null
      else greatest(
        v_limit - coalesce(v_used, 0) - coalesce(v_reserved, 0),
        0
      )
    end,
    'periodStart', v_period_start,
    'periodEnd', v_period_end,
    'trialEnd', v_subscription.trial_end,
    'subscriptionId', v_subscription.id
  ));
end;
$$;

revoke all on function private_app.addon_entitlement_v2_base(uuid, text)
from public, anon, authenticated, service_role;

create or replace function private_app.addon_entitlement_v3(
  p_tenant_id uuid,
  p_feature_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_source text;
  v_enabled boolean;
  v_effective_status text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_days_remaining integer;
begin
  v_result := private_app.addon_entitlement_v2_base(
    p_tenant_id,
    p_feature_key
  );
  v_source := coalesce(v_result ->> 'source', 'none');
  v_enabled := coalesce((v_result ->> 'enabled')::boolean, false);
  v_effective_status := coalesce(v_result ->> 'status', 'disabled');

  begin
    select subscription.*
    into v_subscription
    from catalog.tenant_addon_subscriptions subscription
    where subscription.id = (v_result ->> 'subscriptionId')::uuid
      and subscription.tenant_id = p_tenant_id
    limit 1;
  exception
    when invalid_text_representation then
      v_subscription.id := null;
  end;

  if v_subscription.id is not null then
    v_starts_at := coalesce(
      case
        when v_subscription.status = 'trialing'
          then v_subscription.trial_start
        else null
      end,
      v_subscription.period_start,
      v_subscription.activated_at,
      v_subscription.created_at
    );
    v_ends_at := coalesce(
      case
        when v_subscription.status = 'trialing'
          then v_subscription.trial_end
        else null
      end,
      v_subscription.period_end
    );

    -- Preserve v2 source precedence: a tenant override or an included plan is
    -- still authoritative. Date enforcement applies when this standalone
    -- subscription is the source of access, so expiry never removes a separate
    -- entitlement that the tenant still owns through its plan.
    if v_source = 'subscription' then
      if v_subscription.status = 'active'
         and (v_starts_at is null or v_starts_at <= now())
         and (v_ends_at is null or v_ends_at > now()) then
        v_enabled := true;
        v_effective_status := 'active';
      elsif v_subscription.status = 'trialing'
            and (v_starts_at is null or v_starts_at <= now())
            and v_ends_at is not null
            and v_ends_at > now() then
        v_enabled := true;
        v_effective_status := 'trialing';
      elsif v_starts_at > now() then
        v_enabled := false;
        v_effective_status := 'scheduled';
      elsif v_ends_at is not null and v_ends_at <= now() then
        v_enabled := false;
        v_effective_status := 'expired';
      else
        v_enabled := false;
        v_effective_status := v_subscription.status;
      end if;

      -- Preserve the concrete commercial source for display and audit.
      v_source := coalesce(v_subscription.source, 'subscription');
    end if;

    if v_ends_at is not null then
      v_days_remaining := greatest(
        ceil(extract(epoch from (v_ends_at - now())) / 86400)::integer,
        0
      );
    end if;
  end if;

  return jsonb_strip_nulls(
    coalesce(v_result, '{}'::jsonb)
    || jsonb_build_object(
      'enabled', v_enabled,
      'source', v_source,
      'status', v_effective_status,
      'startsAt', v_starts_at,
      'endsAt', v_ends_at,
      'expiresAt', v_ends_at,
      'daysRemaining', v_days_remaining,
      'expiryAware', true
    )
  );
end;
$$;

revoke all on function private_app.addon_entitlement_v3(uuid, text)
from public, anon, authenticated, service_role;

create or replace function private_app.addon_entitlement(
  p_tenant_id uuid,
  p_feature_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private_app.addon_entitlement_v3(
    p_tenant_id,
    p_feature_key
  );
$$;

revoke all on function private_app.addon_entitlement(uuid, text)
from public, anon, authenticated, service_role;

-- Backward-compatible safety fix: every existing gate that already calls
-- tenant_addon_enabled now receives the v3 period check without a caller change.
create or replace function private_app.tenant_addon_enabled(
  p_tenant_id uuid,
  p_feature_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      private_app.addon_entitlement_v3(
        p_tenant_id,
        p_feature_key
      ) ->> 'enabled'
    )::boolean,
    false
  );
$$;

revoke all on function private_app.tenant_addon_enabled(uuid, text)
from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 9. Tenant snapshot: WordPress-like catalog, surfaces and subscription state
-------------------------------------------------------------------------------

create or replace function public.v3_tenant_addon_center_snapshot(
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
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'schemaVersion', 3,
    'generatedAt', now(),
    'viewer', jsonb_build_object('canManage', true),
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'timezone', v_tenant.timezone
    ),
    'summary', jsonb_build_object(
      'products', (
        select count(*)
        from catalog.addon_products product
        where product.status in ('beta', 'active')
      ),
      'enabled', (
        select count(*)
        from catalog.addon_products product
        join catalog.features feature on feature.id = product.feature_id
        where product.status in ('beta', 'active')
          and private_app.tenant_addon_enabled(
            v_tenant.id,
            feature.feature_key
          )
      ),
      'pending', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.tenant_id = v_tenant.id
          and subscription.status = 'pending'
      ),
      'trialing', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.tenant_id = v_tenant.id
          and subscription.status = 'trialing'
          and coalesce(subscription.trial_end, subscription.period_end) > now()
      ),
      'expiringWithin30Days', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.tenant_id = v_tenant.id
          and subscription.status in ('trialing', 'active')
          and coalesce(subscription.trial_end, subscription.period_end)
            > now()
          and coalesce(subscription.trial_end, subscription.period_end)
            <= now() + interval '30 days'
      )
    ),
    'products', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', product.id,
          'key', product.product_key,
          'featureKey', feature.feature_key,
          'name', product.name_ar,
          'nameEn', product.name_en,
          'description', product.description_ar,
          'category', product.marketplace_category,
          'badge', product.badge_ar,
          'status', product.status,
          'activationMode', product.activation_mode,
          'price', (
            select jsonb_build_object(
              'id', price.id,
              'pricingMode', price.pricing_mode,
              'amountMinor', price.amount_minor,
              'currency', price.currency,
              'interval', price.billing_interval,
              'validFrom', price.valid_from,
              'validTo', price.valid_to,
              'taxInclusive', price.tax_inclusive,
              'taxRateBps', price.tax_rate_bps
            )
            from catalog.addon_price_versions price
            where price.product_id = product.id
              and price.currency = 'SAR'
              and price.valid_from <= current_date
              and (price.valid_to is null or price.valid_to > current_date)
            order by price.valid_from desc
            limit 1
          ),
          'entitlement', private_app.addon_entitlement_v3(
            v_tenant.id,
            feature.feature_key
          ),
          'subscription', (
            select jsonb_strip_nulls(jsonb_build_object(
              'id', subscription.id,
              'status', subscription.status,
              'source', subscription.source,
              'startsAt', coalesce(
                subscription.trial_start,
                subscription.period_start
              ),
              'endsAt', coalesce(
                subscription.trial_end,
                subscription.period_end
              ),
              'cancelAtPeriodEnd', subscription.cancel_at_period_end,
              'autoRenew', subscription.auto_renew,
              'paymentProviderKey', subscription.payment_provider_key
            ))
            from catalog.tenant_addon_subscriptions subscription
            where subscription.tenant_id = v_tenant.id
              and subscription.product_id = product.id
              and subscription.status in (
                'pending', 'trialing', 'active', 'paused'
              )
            order by subscription.created_at desc
            limit 1
          ),
          'manifest', (
            select jsonb_build_object(
              'id', manifest.id,
              'version', manifest.manifest_version,
              'contractVersion', manifest.contract_version,
              'shortDescription', manifest.short_description_ar,
              'longDescription', manifest.long_description_ar,
              'publisher', manifest.publisher_name,
              'installMode', manifest.install_mode,
              'dataPolicy', manifest.data_policy,
              'dependencies', manifest.dependencies,
              'requiredPermissions', to_jsonb(manifest.required_permissions),
              'configurationSchema', manifest.configuration_schema,
              'releaseNotes', manifest.release_notes_ar,
              'releasedAt', manifest.released_at
            )
            from catalog.addon_manifests manifest
            where manifest.product_id = product.id
              and manifest.is_current
              and manifest.status = 'published'
            limit 1
          ),
          'surfaces', coalesce((
            select jsonb_agg(jsonb_build_object(
              'key', surface.surface_key,
              'type', surface.surface_type,
              'location', surface.location_key,
              'title', surface.title_ar,
              'description', surface.description_ar,
              'routeTemplate', surface.route_template,
              'iconKey', surface.icon_key,
              'requiredPermission', surface.required_permission,
              'visibility', surface.visibility_mode,
              'sortOrder', surface.sort_order
            ) order by surface.sort_order, surface.surface_key)
            from catalog.addon_surfaces surface
            join catalog.addon_manifests manifest
              on manifest.id = surface.manifest_id
             and manifest.product_id = product.id
             and manifest.is_current
             and manifest.status = 'published'
            where surface.status = 'active'
          ), '[]'::jsonb),
          'media', coalesce((
            select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'key', media.media_key,
              'type', media.media_type,
              'role', media.media_role,
              'url', media.external_url,
              'storageBucket', media.storage_bucket,
              'storagePath', media.storage_path,
              'alt', media.alt_ar,
              'caption', media.caption_ar,
              'width', media.width_px,
              'height', media.height_px,
              'sortOrder', media.sort_order
            )) order by media.sort_order, media.media_key)
            from catalog.addon_media media
            join catalog.addon_manifests manifest
              on manifest.id = media.manifest_id
             and manifest.product_id = product.id
             and manifest.is_current
             and manifest.status = 'published'
            where media.status = 'active'
          ), '[]'::jsonb)
        )
        order by product.sort_order, product.product_key
      )
      from catalog.addon_products product
      join catalog.features feature on feature.id = product.feature_id
      where product.status in ('beta', 'active')
    ), '[]'::jsonb),
    'paymentProviders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', provider.provider_key,
        'name', provider.name_ar,
        'nameEn', provider.name_en,
        'status', provider.status,
        'environment', provider.environment,
        'checkoutMode', provider.checkout_mode,
        'supportedCurrencies', to_jsonb(provider.supported_currencies),
        'configured', not exists (
          select 1
          from unnest(provider.required_secret_keys) required(secret_key)
          where not exists (
            select 1
            from marketplace.payment_provider_secret_refs secret_ref
            where secret_ref.provider_key = provider.provider_key
              and secret_ref.secret_key = required.secret_key
          )
        ),
        'verifiedAt', provider.last_verified_at
      ) order by provider.sort_order)
      from marketplace.payment_provider_configs provider
      where provider.status = 'active'
        and provider.last_verified_at is not null
    ), '[]'::jsonb),
    'recentUsage', coalesce((
      select jsonb_agg(usage_row.payload order by usage_row.occurred_at desc)
      from (
        select
          usage.occurred_at,
          jsonb_build_object(
            'id', usage.id,
            'productKey', product.product_key,
            'name', product.name_ar,
            'metricKey', usage.metric_key,
            'quantity', usage.quantity,
            'sourceType', usage.source_type,
            'occurredAt', usage.occurred_at
          ) as payload
        from catalog.addon_usage_events usage
        join catalog.addon_products product
          on product.id = usage.product_id
        where usage.tenant_id = v_tenant.id
        order by usage.occurred_at desc
        limit 30
      ) usage_row
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.v3_tenant_addon_center_snapshot(text)
from public, anon;
grant execute on function public.v3_tenant_addon_center_snapshot(text)
to authenticated;

create or replace function public.v3_tenant_addon_center_action(
  p_slug text,
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
  v_product catalog.addon_products%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_actor uuid;
begin
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  if p_action in ('request_trial', 'cancel_request') then
    select product.* into v_product
    from catalog.addon_products product
    where product.product_key = p_payload ->> 'productKey'
      and product.status in ('beta', 'active')
    limit 1;
    if v_product.id is null then raise exception 'addon_product_not_found'; end if;

    -- Project a dated active/trial row to expired before v2 performs its
    -- idempotent request insert. This frees the existing partial unique index
    -- without deleting the historical subscription.
    update catalog.tenant_addon_subscriptions subscription
    set status = 'expired',
        ended_at = coalesce(subscription.ended_at, subscription.period_end),
        updated_at = now()
    where subscription.tenant_id = v_tenant.id
      and subscription.product_id = v_product.id
      and subscription.status in ('active', 'trialing')
      and coalesce(subscription.trial_end, subscription.period_end) <= now();

    return public.v2_tenant_addon_center_action(
      p_slug,
      p_action,
      p_payload
    );
  elsif p_action = 'cancel_at_period_end' then
    begin
      select subscription.* into v_subscription
      from catalog.tenant_addon_subscriptions subscription
      join catalog.addon_products product
        on product.id = subscription.product_id
      where subscription.tenant_id = v_tenant.id
        and subscription.status in ('trialing', 'active')
        and (
          subscription.id = nullif(
            p_payload ->> 'subscriptionId',
            ''
          )::uuid
          or product.product_key = p_payload ->> 'productKey'
        )
      order by subscription.created_at desc
      limit 1
      for update of subscription;
    exception when invalid_text_representation then
      raise exception 'invalid_addon_subscription';
    end;
    if v_subscription.id is null then
      raise exception 'addon_subscription_not_found';
    end if;

    update catalog.tenant_addon_subscriptions
    set cancel_at_period_end = true,
        decision_note = coalesce(
          left(nullif(trim(p_payload ->> 'reason'), ''), 500),
          decision_note
        ),
        updated_at = now()
    where id = v_subscription.id
    returning * into v_subscription;

    insert into catalog.tenant_addon_subscription_events (
      subscription_id, tenant_id, product_id, event_key, event_type,
      from_status, to_status, actor_subject_id, metadata
    ) values (
      v_subscription.id,
      v_subscription.tenant_id,
      v_subscription.product_id,
      'cancel_scheduled:' || v_subscription.id::text,
      'cancel_scheduled',
      v_subscription.status,
      v_subscription.status,
      v_actor,
      jsonb_build_object(
        'periodEnd', v_subscription.period_end,
        'preserveOperationalData', true
      )
    ) on conflict (tenant_id, product_id, event_key) do nothing;

    insert into audit_log.events (
      tenant_id, actor_subject_id, action, resource_type,
      resource_id, context
    ) values (
      v_tenant.id,
      v_actor,
      'catalog.addon.cancel_at_period_end',
      'tenant_addon_subscription',
      v_subscription.id::text,
      jsonb_build_object(
        'periodEnd', v_subscription.period_end,
        'dataPolicy', 'preserve_on_disable'
      )
    );

    return jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'status', v_subscription.status,
      'cancelAtPeriodEnd', true,
      'periodEnd', v_subscription.period_end
    );
  end if;

  raise exception 'invalid_addon_action';
end;
$$;

revoke all on function public.v3_tenant_addon_center_action(
  text,
  text,
  jsonb
) from public, anon;
grant execute on function public.v3_tenant_addon_center_action(
  text,
  text,
  jsonb
) to authenticated;

-------------------------------------------------------------------------------
-- 10. Platform snapshot and controlled lifecycle actions
-------------------------------------------------------------------------------

create or replace function public.v3_platform_addon_center_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'schemaVersion', 3,
    'generatedAt', now(),
    'summary', jsonb_build_object(
      'products', (
        select count(*) from catalog.addon_products
        where status in ('beta', 'active')
      ),
      'publishedProducts', (
        select count(*) from catalog.addon_manifests
        where is_current and status = 'published'
      ),
      'activeLicenses', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.status in ('active', 'trialing')
          and coalesce(
            subscription.trial_end,
            subscription.period_end,
            'infinity'::timestamptz
          ) > now()
      ),
      'pendingRequests', (
        select count(*) from catalog.tenant_addon_subscriptions
        where status = 'pending'
      ),
      'expiringWithin30Days', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.status in ('active', 'trialing')
          and coalesce(subscription.trial_end, subscription.period_end)
            > now()
          and coalesce(subscription.trial_end, subscription.period_end)
            <= now() + interval '30 days'
      )
    ),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id,
        'key', product.product_key,
        'featureKey', feature.feature_key,
        'name', product.name_ar,
        'nameEn', product.name_en,
        'description', product.description_ar,
        'category', product.marketplace_category,
        'badge', product.badge_ar,
        'status', product.status,
        'activationMode', product.activation_mode,
        'trialDays', product.trial_days,
        'price', (
          select jsonb_build_object(
            'id', price.id,
            'pricingMode', price.pricing_mode,
            'amountMinor', price.amount_minor,
            'currency', price.currency,
            'interval', price.billing_interval,
            'validFrom', price.valid_from,
            'validTo', price.valid_to,
            'taxInclusive', price.tax_inclusive,
            'taxRateBps', price.tax_rate_bps
          )
          from catalog.addon_price_versions price
          where price.product_id = product.id
            and price.valid_from <= current_date
            and (price.valid_to is null or price.valid_to > current_date)
          order by price.valid_from desc
          limit 1
        ),
        'manifest', (
          select jsonb_build_object(
            'id', manifest.id,
            'version', manifest.manifest_version,
            'status', manifest.status,
            'shortDescription', manifest.short_description_ar,
            'longDescription', manifest.long_description_ar,
            'dataPolicy', manifest.data_policy,
            'releasedAt', manifest.released_at
          )
          from catalog.addon_manifests manifest
          where manifest.product_id = product.id
            and manifest.is_current
          limit 1
        ),
        'surfaces', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', surface.id,
            'key', surface.surface_key,
            'type', surface.surface_type,
            'location', surface.location_key,
            'title', surface.title_ar,
            'description', surface.description_ar,
            'routeTemplate', surface.route_template,
            'requiredPermission', surface.required_permission,
            'visibility', surface.visibility_mode,
            'status', surface.status,
            'sortOrder', surface.sort_order
          ) order by surface.sort_order, surface.surface_key)
          from catalog.addon_surfaces surface
          join catalog.addon_manifests manifest
            on manifest.id = surface.manifest_id
           and manifest.product_id = product.id
           and manifest.is_current
        ), '[]'::jsonb),
        'media', coalesce((
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id', media.id,
            'key', media.media_key,
            'type', media.media_type,
            'role', media.media_role,
            'url', media.external_url,
            'storageBucket', media.storage_bucket,
            'storagePath', media.storage_path,
            'alt', media.alt_ar,
            'caption', media.caption_ar,
            'status', media.status,
            'sortOrder', media.sort_order
          )) order by media.sort_order, media.media_key)
          from catalog.addon_media media
          join catalog.addon_manifests manifest
            on manifest.id = media.manifest_id
           and manifest.product_id = product.id
           and manifest.is_current
        ), '[]'::jsonb)
      ) order by product.sort_order, product.product_key)
      from catalog.addon_products product
      join catalog.features feature on feature.id = product.feature_id
    ), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', subscription.id,
        'tenantId', tenant.id,
        'tenantName', tenant.name,
        'tenantSlug', tenant.slug,
        'protected', tenant.slug = 'reef-skills'
          and subscription.period_end =
            timestamptz '2027-08-01 00:00:00+03',
        'productKey', product.product_key,
        'productName', product.name_ar,
        'status', subscription.status,
        'effectiveStatus', private_app.addon_entitlement_v3(
          tenant.id,
          feature.feature_key
        ) ->> 'status',
        'source', subscription.source,
        'startsAt', coalesce(
          subscription.trial_start,
          subscription.period_start
        ),
        'endsAt', coalesce(
          subscription.trial_end,
          subscription.period_end
        ),
        'daysRemaining', case
          when coalesce(subscription.trial_end, subscription.period_end)
            is null then null
          else greatest(ceil(extract(epoch from (
            coalesce(subscription.trial_end, subscription.period_end) - now()
          )) / 86400)::integer, 0)
        end,
        'cancelAtPeriodEnd', subscription.cancel_at_period_end,
        'autoRenew', subscription.auto_renew,
        'paymentProviderKey', subscription.payment_provider_key,
        'createdAt', subscription.created_at
      ) order by
        case subscription.status when 'pending' then 0 else 1 end,
        subscription.created_at desc)
      from catalog.tenant_addon_subscriptions subscription
      join core.tenants tenant on tenant.id = subscription.tenant_id
      join catalog.addon_products product
        on product.id = subscription.product_id
      join catalog.features feature on feature.id = product.feature_id
    ), '[]'::jsonb),
    'paymentProviders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', provider.provider_key,
        'name', provider.name_ar,
        'nameEn', provider.name_en,
        'status', provider.status,
        'environment', provider.environment,
        'checkoutMode', provider.checkout_mode,
        'supportedCurrencies', to_jsonb(provider.supported_currencies),
        'requiredSecretKeys', to_jsonb(provider.required_secret_keys),
        'configuredSecretKeys', coalesce((
          select jsonb_agg(secret_ref.secret_key order by secret_ref.secret_key)
          from marketplace.payment_provider_secret_refs secret_ref
          where secret_ref.provider_key = provider.provider_key
        ), '[]'::jsonb),
        'configured', not exists (
          select 1
          from unnest(provider.required_secret_keys) required(secret_key)
          where not exists (
            select 1
            from marketplace.payment_provider_secret_refs secret_ref
            where secret_ref.provider_key = provider.provider_key
              and secret_ref.secret_key = required.secret_key
          )
        ),
        'verifiedAt', provider.last_verified_at,
        'lastErrorCode', provider.last_error_code
      ) order by provider.sort_order)
      from marketplace.payment_provider_configs provider
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.v3_platform_addon_center_snapshot()
from public, anon;
grant execute on function public.v3_platform_addon_center_snapshot()
to authenticated;

create or replace function public.v3_platform_addon_center_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_product catalog.addon_products%rowtype;
  v_tenant core.tenants%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_price catalog.addon_price_versions%rowtype;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_amount_minor bigint;
  v_tax_rate_bps integer;
  v_valid_from date;
  v_currency text;
  v_status text;
  v_reason text;
  v_currencies text[];
  v_public_config jsonb;
  v_protected boolean := false;
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  -- Preserve the existing platform workflow while blocking accidental changes
  -- to Reef's protected launch-year grant.
  if p_action in (
    'decide_request', 'set_limit', 'pause', 'resume', 'cancel'
  ) then
    if p_action in ('pause', 'cancel') then
      begin
        select subscription.* into v_subscription
        from catalog.tenant_addon_subscriptions subscription
        join core.tenants tenant on tenant.id = subscription.tenant_id
        where subscription.id =
          (p_payload ->> 'subscriptionId')::uuid
          and tenant.slug = 'reef-skills'
          and subscription.period_end =
            timestamptz '2027-08-01 00:00:00+03'
          and now() < subscription.period_end
        limit 1;
      exception when invalid_text_representation then
        raise exception 'invalid_addon_subscription';
      end;
      if v_subscription.id is not null then
        raise exception 'protected_reef_subscription';
      end if;
    end if;
    return public.v2_platform_addon_center_action(p_action, p_payload);
  elsif p_action = 'set_annual_price' then
    select product.* into v_product
    from catalog.addon_products product
    where product.product_key = p_payload ->> 'productKey'
    for update;
    if v_product.id is null then raise exception 'addon_product_not_found'; end if;

    begin
      v_amount_minor := (p_payload ->> 'amountMinor')::bigint;
      v_tax_rate_bps := coalesce(
        nullif(p_payload ->> 'taxRateBps', '')::integer,
        1500
      );
      v_valid_from := coalesce(
        nullif(p_payload ->> 'validFrom', '')::date,
        current_date
      );
    exception when invalid_text_representation then
      raise exception 'invalid_addon_price';
    end;
    v_currency := upper(coalesce(
      nullif(trim(p_payload ->> 'currency'), ''),
      'SAR'
    ));
    if v_amount_minor <= 0
       or v_amount_minor > 1000000000
       or v_currency !~ '^[A-Z]{3}$'
       or v_tax_rate_bps not between 0 and 10000
       or v_valid_from < current_date then
      raise exception 'invalid_addon_price';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      v_product.id::text || ':' || v_currency || ':year',
      0
    ));
    if exists (
      select 1 from catalog.addon_price_versions price
      where price.product_id = v_product.id
        and price.currency = v_currency
        and price.valid_from = v_valid_from
    ) then raise exception 'addon_price_version_exists'; end if;

    update catalog.addon_price_versions price
    set valid_to = v_valid_from
    where price.product_id = v_product.id
      and price.currency = v_currency
      and price.valid_to is null
      and price.valid_from < v_valid_from;

    insert into catalog.addon_price_versions (
      product_id, pricing_mode, amount_minor, currency,
      billing_interval, valid_from, tax_inclusive,
      tax_rate_bps, change_note, created_by_subject_id
    ) values (
      v_product.id,
      'fixed',
      v_amount_minor,
      v_currency,
      'year',
      v_valid_from,
      coalesce((p_payload ->> 'taxInclusive')::boolean, false),
      v_tax_rate_bps,
      left(nullif(trim(p_payload ->> 'reason'), ''), 500),
      v_actor
    ) returning * into v_price;

    if v_valid_from <= current_date then
      update catalog.addon_products
      set pricing_mode = 'fixed',
          amount_minor = v_amount_minor,
          currency = v_currency,
          interval = 'year',
          updated_at = now()
      where id = v_product.id;
    end if;

    insert into audit_log.events (
      actor_subject_id, action, resource_type, resource_id, context
    ) values (
      v_actor,
      'catalog.addon.set_annual_price',
      'addon_product',
      v_product.id::text,
      jsonb_build_object(
        'productKey', v_product.product_key,
        'amountMinor', v_amount_minor,
        'currency', v_currency,
        'validFrom', v_valid_from
      )
    );
    return jsonb_build_object(
      'productKey', v_product.product_key,
      'priceVersionId', v_price.id,
      'amountMinor', v_price.amount_minor,
      'currency', v_price.currency,
      'validFrom', v_price.valid_from
    );
  elsif p_action = 'configure_payment_provider' then
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = p_payload ->> 'providerKey'
    for update;
    if v_provider.provider_key is null then
      raise exception 'payment_provider_not_found';
    end if;

    v_status := coalesce(
      nullif(p_payload ->> 'status', ''),
      v_provider.status
    );
    if v_status not in ('draft', 'configured', 'disabled') then
      raise exception 'payment_provider_status_requires_verification';
    end if;
    if coalesce(p_payload ->> 'environment', v_provider.environment)
       not in ('sandbox', 'live') then
      raise exception 'invalid_payment_provider_environment';
    end if;
    if coalesce(p_payload ->> 'checkoutMode', v_provider.checkout_mode)
       not in ('redirect', 'embedded', 'api') then
      raise exception 'invalid_payment_provider_checkout_mode';
    end if;

    if p_payload ? 'supportedCurrencies' then
      begin
        select array_agg(upper(value) order by upper(value))
        into v_currencies
        from jsonb_array_elements_text(
          p_payload -> 'supportedCurrencies'
        ) item(value);
      exception when others then
        raise exception 'invalid_payment_provider_currencies';
      end;
    else
      v_currencies := v_provider.supported_currencies;
    end if;
    if cardinality(v_currencies) not between 1 and 20
       or exists (
         select 1 from unnest(v_currencies) currency
         where currency !~ '^[A-Z]{3}$'
       ) then raise exception 'invalid_payment_provider_currencies'; end if;
    v_public_config := coalesce(
      p_payload -> 'publicConfig',
      v_provider.public_config
    );
    if jsonb_typeof(v_public_config) <> 'object'
       or private_app.jsonb_has_sensitive_key(v_public_config) then
      raise exception 'sensitive_payment_provider_config_rejected';
    end if;

    update marketplace.payment_provider_configs provider
    set environment = coalesce(
          p_payload ->> 'environment',
          provider.environment
        ),
        checkout_mode = coalesce(
          p_payload ->> 'checkoutMode',
          provider.checkout_mode
        ),
        supported_currencies = v_currencies,
        public_config = v_public_config,
        status = case
          when v_status = 'disabled' then 'disabled'
          when not exists (
            select 1
            from unnest(provider.required_secret_keys) required(secret_key)
            where not exists (
              select 1
              from marketplace.payment_provider_secret_refs secret_ref
              where secret_ref.provider_key = provider.provider_key
                and secret_ref.secret_key = required.secret_key
            )
          ) then 'configured'
          else 'draft'
        end,
        last_verified_at = null,
        last_error_code = null,
        updated_at = now()
    where provider.provider_key = v_provider.provider_key
    returning * into v_provider;

    insert into audit_log.events (
      actor_subject_id, action, resource_type, resource_id, context
    ) values (
      v_actor,
      'marketplace.payment_provider.configure',
      'payment_provider',
      v_provider.provider_key,
      jsonb_build_object(
        'environment', v_provider.environment,
        'status', v_provider.status,
        'secretsReturned', false
      )
    );
    return jsonb_build_object(
      'providerKey', v_provider.provider_key,
      'status', v_provider.status,
      'environment', v_provider.environment,
      'configured', v_provider.status = 'configured'
    );
  elsif p_action = 'grant_subscription' then
    begin
      select tenant.* into v_tenant
      from core.tenants tenant
      where tenant.id = nullif(p_payload ->> 'tenantId', '')::uuid
         or tenant.slug = p_payload ->> 'tenantSlug'
      limit 1;
      v_starts_at := coalesce(
        nullif(p_payload ->> 'startsAt', '')::timestamptz,
        now()
      );
      v_ends_at := nullif(p_payload ->> 'endsAt', '')::timestamptz;
    exception when invalid_text_representation then
      raise exception 'invalid_addon_grant';
    end;
    select product.* into v_product
    from catalog.addon_products product
    where product.product_key = p_payload ->> 'productKey'
      and product.status in ('beta', 'active')
    limit 1;
    if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
    if v_product.id is null then raise exception 'addon_product_not_found'; end if;
    if v_ends_at is null or v_ends_at <= v_starts_at then
      raise exception 'invalid_addon_grant_period';
    end if;

    insert into catalog.tenant_addon_subscriptions as current_subscription (
      tenant_id, product_id, status, source, period_start, period_end,
      decision_note, cancel_at_period_end, price_version_id,
      auto_renew, activated_at, decided_by_subject_id
    ) values (
      v_tenant.id,
      v_product.id,
      'active',
      'platform',
      v_starts_at,
      v_ends_at,
      left(nullif(trim(p_payload ->> 'reason'), ''), 500),
      false,
      (
        select price.id
        from catalog.addon_price_versions price
        where price.product_id = v_product.id
          and price.valid_from <= v_starts_at::date
          and (price.valid_to is null or price.valid_to > v_starts_at::date)
        order by price.valid_from desc
        limit 1
      ),
      false,
      v_starts_at,
      v_actor
    ) on conflict (tenant_id, product_id)
      where status in ('pending', 'trialing', 'active', 'paused')
    do update set
      status = 'active',
      source = 'platform',
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      decision_note = excluded.decision_note,
      cancel_at_period_end = false,
      price_version_id = coalesce(
        excluded.price_version_id,
        current_subscription.price_version_id
      ),
      auto_renew = false,
      activated_at = coalesce(
        current_subscription.activated_at,
        excluded.activated_at
      ),
      ended_at = null,
      decided_by_subject_id = excluded.decided_by_subject_id,
      updated_at = now()
    returning * into v_subscription;

    insert into catalog.tenant_addon_subscription_events (
      subscription_id, tenant_id, product_id, event_key, event_type,
      from_status, to_status, effective_at, actor_subject_id, metadata
    ) values (
      v_subscription.id,
      v_subscription.tenant_id,
      v_subscription.product_id,
      'platform_grant:' || v_starts_at::text || ':' || v_ends_at::text,
      'activated',
      null,
      'active',
      v_starts_at,
      v_actor,
      jsonb_build_object(
        'endsAt', v_ends_at,
        'reason', left(nullif(trim(p_payload ->> 'reason'), ''), 500),
        'preserveOperationalData', true
      )
    ) on conflict (tenant_id, product_id, event_key) do nothing;

    insert into audit_log.events (
      tenant_id, actor_subject_id, action, resource_type,
      resource_id, context
    ) values (
      v_tenant.id,
      v_actor,
      'catalog.addon.platform_grant',
      'tenant_addon_subscription',
      v_subscription.id::text,
      jsonb_build_object(
        'productKey', v_product.product_key,
        'startsAt', v_starts_at,
        'endsAt', v_ends_at
      )
    );
    return jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'tenantId', v_tenant.id,
      'productKey', v_product.product_key,
      'status', v_subscription.status,
      'startsAt', v_subscription.period_start,
      'endsAt', v_subscription.period_end
    );
  elsif p_action = 'set_subscription_status' then
    begin
      select subscription.* into v_subscription
      from catalog.tenant_addon_subscriptions subscription
      join core.tenants tenant on tenant.id = subscription.tenant_id
      where subscription.id =
        (p_payload ->> 'subscriptionId')::uuid
      for update of subscription;
    exception when invalid_text_representation then
      raise exception 'invalid_addon_subscription';
    end;
    if v_subscription.id is null then
      raise exception 'addon_subscription_not_found';
    end if;
    v_protected := exists (
      select 1
      from core.tenants tenant
      where tenant.id = v_subscription.tenant_id
        and tenant.slug = 'reef-skills'
    )
      and v_subscription.period_end =
        timestamptz '2027-08-01 00:00:00+03'
      and now() < v_subscription.period_end;
    v_status := p_payload ->> 'status';
    v_reason := left(nullif(trim(p_payload ->> 'reason'), ''), 500);
    if v_status not in ('active', 'paused', 'cancelled', 'expired') then
      raise exception 'invalid_addon_subscription_status';
    end if;
    if v_protected
       and v_status in ('paused', 'cancelled', 'expired')
       and not (
         coalesce((p_payload ->> 'forceProtected')::boolean, false)
         and length(coalesce(v_reason, '')) >= 12
       ) then raise exception 'protected_reef_subscription'; end if;
    if v_status = 'active'
       and v_subscription.period_end is not null
       and v_subscription.period_end <= now() then
      raise exception 'expired_subscription_requires_new_period';
    end if;

    update catalog.tenant_addon_subscriptions
    set status = v_status,
        ended_at = case
          when v_status in ('cancelled', 'expired') then now()
          else null
        end,
        decision_note = coalesce(v_reason, decision_note),
        decided_by_subject_id = v_actor,
        updated_at = now()
    where id = v_subscription.id
    returning * into v_subscription;

    insert into catalog.tenant_addon_subscription_events (
      subscription_id, tenant_id, product_id, event_key, event_type,
      from_status, to_status, actor_subject_id, metadata
    ) values (
      v_subscription.id,
      v_subscription.tenant_id,
      v_subscription.product_id,
      'status:' || v_status || ':' || now()::text,
      case v_status
        when 'paused' then 'paused'
        when 'active' then 'resumed'
        when 'expired' then 'expired'
        else 'cancelled'
      end,
      null,
      v_status,
      v_actor,
      jsonb_build_object(
        'reason', v_reason,
        'protectedOverride', v_protected,
        'preserveOperationalData', true
      )
    );

    insert into audit_log.events (
      tenant_id, actor_subject_id, action, resource_type,
      resource_id, context
    ) values (
      v_subscription.tenant_id,
      v_actor,
      'catalog.addon.set_subscription_status',
      'tenant_addon_subscription',
      v_subscription.id::text,
      jsonb_build_object(
        'status', v_status,
        'reason', v_reason,
        'protectedOverride', v_protected
      )
    );
    return jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'status', v_subscription.status,
      'protectedOverride', v_protected
    );
  end if;

  raise exception 'invalid_addon_action';
end;
$$;

revoke all on function public.v3_platform_addon_center_action(text, jsonb)
from public, anon;
grant execute on function public.v3_platform_addon_center_action(text, jsonb)
to authenticated;

-------------------------------------------------------------------------------
-- 11. Service-only Vault writes and provider health promotion
-------------------------------------------------------------------------------

create or replace function public.v3_service_payment_provider_secret_action(
  p_action text,
  p_provider_key text,
  p_secret_key text,
  p_secret_value text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_ref marketplace.payment_provider_secret_refs%rowtype;
  v_vault_id uuid;
  v_vault_name text;
  v_complete boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  if p_action not in ('store', 'rotate') then
    raise exception 'invalid_payment_provider_secret_action';
  end if;
  if p_secret_value is null
     or length(p_secret_value) not between 1 and 8192 then
    raise exception 'invalid_payment_provider_secret';
  end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = p_provider_key
  for update;
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;
  if not (
    p_secret_key = any(v_provider.required_secret_keys)
    or p_secret_key = any(v_provider.optional_secret_keys)
  ) then raise exception 'payment_provider_secret_key_not_allowed'; end if;

  select secret_ref.* into v_ref
  from marketplace.payment_provider_secret_refs secret_ref
  where secret_ref.provider_key = p_provider_key
    and secret_ref.secret_key = p_secret_key
  for update;
  v_vault_name := 'marketplace_' || p_provider_key || '_' ||
    lower(regexp_replace(p_secret_key, '[^A-Za-z0-9]+', '_', 'g'));

  if v_ref.vault_secret_id is null then
    v_vault_id := vault.create_secret(
      p_secret_value,
      v_vault_name,
      'Managed payment provider credential. Never return to clients.'
    );
    insert into marketplace.payment_provider_secret_refs (
      provider_key, secret_key, vault_secret_id, last_rotated_at
    ) values (
      p_provider_key, p_secret_key, v_vault_id, now()
    );
  else
    perform vault.update_secret(
      v_ref.vault_secret_id,
      p_secret_value,
      v_vault_name,
      'Managed payment provider credential. Never return to clients.'
    );
    v_vault_id := v_ref.vault_secret_id;
    update marketplace.payment_provider_secret_refs
    set last_rotated_at = now(),
        updated_at = now()
    where provider_key = p_provider_key
      and secret_key = p_secret_key;
  end if;

  select not exists (
    select 1
    from unnest(v_provider.required_secret_keys) required(secret_key)
    where not exists (
      select 1
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = p_provider_key
        and secret_ref.secret_key = required.secret_key
    )
  ) into v_complete;

  update marketplace.payment_provider_configs
  set status = case when v_complete then 'configured' else 'draft' end,
      last_verified_at = null,
      last_error_code = null,
      updated_at = now()
  where provider_key = p_provider_key;

  insert into audit_log.events (
    action, resource_type, resource_id, context
  ) values (
    'marketplace.payment_provider.secret_' || p_action,
    'payment_provider',
    p_provider_key,
    jsonb_build_object(
      'secretKey', p_secret_key,
      'configured', v_complete,
      'secretReturned', false
    )
  );

  return jsonb_build_object(
    'providerKey', p_provider_key,
    'secretKey', p_secret_key,
    'stored', true,
    'configured', v_complete,
    'secretReturned', false
  );
end;
$$;

revoke all on function public.v3_service_payment_provider_secret_action(
  text,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.v3_service_payment_provider_secret_action(
  text,
  text,
  text,
  text
) to service_role;

create or replace function public.v3_service_payment_provider_health_action(
  p_provider_key text,
  p_ok boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_complete boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = p_provider_key
  for update;
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;
  select not exists (
    select 1
    from unnest(v_provider.required_secret_keys) required(secret_key)
    where not exists (
      select 1
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = p_provider_key
        and secret_ref.secret_key = required.secret_key
    )
  ) into v_complete;
  if p_ok and not v_complete then
    raise exception 'payment_provider_credentials_incomplete';
  end if;

  update marketplace.payment_provider_configs
  set status = case when p_ok then 'active' else 'error' end,
      last_verified_at = case when p_ok then now() else null end,
      last_error_code = case
        when p_ok then null
        else left(coalesce(nullif(trim(p_error_code), ''), 'health_check_failed'), 120)
      end,
      updated_at = now()
  where provider_key = p_provider_key
  returning * into v_provider;

  insert into audit_log.events (
    action, resource_type, resource_id, context
  ) values (
    'marketplace.payment_provider.health_check',
    'payment_provider',
    p_provider_key,
    jsonb_build_object(
      'ok', p_ok,
      'status', v_provider.status,
      'environment', v_provider.environment,
      'errorCode', v_provider.last_error_code
    )
  );
  return jsonb_build_object(
    'providerKey', p_provider_key,
    'status', v_provider.status,
    'verifiedAt', v_provider.last_verified_at,
    'errorCode', v_provider.last_error_code
  );
end;
$$;

revoke all on function public.v3_service_payment_provider_health_action(
  text,
  boolean,
  text
) from public, anon, authenticated;
grant execute on function public.v3_service_payment_provider_health_action(
  text,
  boolean,
  text
) to service_role;

comment on table catalog.addon_manifests is
  'Versioned add-on contract. Published versions are immutable by convention; data survives disable and expiry.';
comment on table catalog.addon_surfaces is
  'Declared add-on placements. Clients resolve only registered surface keys and never execute a database-provided component.';
comment on table catalog.addon_media is
  'Approved add-on screenshots and help media; draft slots never emit broken URLs to tenants.';
comment on table catalog.addon_price_versions is
  'Append-only annual price timeline used to freeze the commercial terms selected by an order or grant.';
comment on table marketplace.payment_provider_secret_refs is
  'Vault UUID references only. Secret plaintext must never be persisted or returned by a snapshot.';

commit;
