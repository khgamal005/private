-- Standalone LMS add-on plus a fail-closed tenant navigation contract.
-- Additive only: disabling access never removes training or integration data.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('catalog.addon_products') is null
     or to_regclass('catalog.addon_manifests') is null
     or to_regclass('catalog.addon_surfaces') is null
     or to_regclass('catalog.addon_price_versions') is null
     or to_regclass('catalog.tenant_addon_subscriptions') is null
     or to_regprocedure(
       'private_app.tenant_addon_enabled(uuid,text)'
     ) is null then
    raise exception 'lms_addon_navigation_missing_v3_contract';
  end if;
end;
$preflight$;

-------------------------------------------------------------------------------
-- 1. LMS catalog product: purchased independently from the free core
-------------------------------------------------------------------------------

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
  'addon.training.lms',
  'منصة التدريب التفاعلي',
  'Interactive Training LMS',
  'addon',
  'boolean',
  'false'::jsonb,
  'active'
)
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    default_value = excluded.default_value,
    status = excluded.status,
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
  sort_order,
  marketplace_category,
  badge_ar,
  activation_mode
)
select
  'lms',
  feature.id,
  'منصة التدريب التفاعلي',
  'Interactive Training LMS',
  'إدارة الدفعات والجداول والحضور والتقييم والشهادات والتواصل التشغيلي.',
  'fixed',
  200000,
  'SAR',
  'year',
  14,
  'active_learners',
  null,
  'active',
  75,
  'training',
  'تشغيل التدريب كاملًا',
  'entitlement'
from catalog.features feature
where feature.feature_key = 'addon.training.lms'
on conflict (product_key) do update
set feature_id = excluded.feature_id,
    name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    pricing_mode = excluded.pricing_mode,
    amount_minor = excluded.amount_minor,
    currency = excluded.currency,
    interval = excluded.interval,
    trial_days = excluded.trial_days,
    usage_metric = excluded.usage_metric,
    default_limit = excluded.default_limit,
    status = excluded.status,
    sort_order = excluded.sort_order,
    marketplace_category = excluded.marketplace_category,
    badge_ar = excluded.badge_ar,
    activation_mode = excluded.activation_mode,
    updated_at = now();

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
  'تشغيل التدريب التفاعلي من شاشة مستقلة ومحكومة بالترخيص.',
  product.description_ar,
  'Marktone',
  'entitlement',
  'preserve_on_disable',
  '[]'::jsonb,
  array['tenant.academy.read']::text[],
  jsonb_build_object(
    '$schema', 'https://json-schema.org/draft/2020-12/schema',
    'type', 'object',
    'additionalProperties', false,
    'properties', '{}'::jsonb
  ),
  'فصل منصة التدريب التفاعلي عن كتالوج الدبلومات والدورات.',
  'published',
  true,
  timestamptz '2026-08-12 00:00:00+03'
from catalog.addon_products product
where product.product_key = 'lms'
on conflict (product_id, manifest_version) do nothing;

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
  surface.surface_key,
  surface.surface_type,
  surface.location_key,
  surface.title_ar,
  surface.description_ar,
  surface.route_template,
  surface.icon_key,
  surface.required_permission,
  surface.visibility_mode,
  'active',
  surface.sort_order,
  jsonb_build_object('productKey', 'lms')
from catalog.addon_manifests manifest
join catalog.addon_products product
  on product.id = manifest.product_id
cross join (
  values
    (
      'tenant.addons', 'settings', 'tenant.addons',
      'إدارة منصة التدريب التفاعلي',
      'حالة الترخيص والسعر والمدة مع الاحتفاظ ببيانات التشغيل.',
      '/tenant/{slug}/addons?addon=lms', 'puzzle',
      'tenant.settings.manage', 'always_locked', 10
    ),
    (
      'tenant.lms', 'screen', 'tenant.training.lms',
      'منصة التدريب التفاعلي',
      'الدفعات والجداول والحضور والتقييم والشهادات.',
      '/tenant/{slug}/lms', 'training',
      'tenant.academy.read', 'when_entitled', 20
    )
) surface(
  surface_key,
  surface_type,
  location_key,
  title_ar,
  description_ar,
  route_template,
  icon_key,
  required_permission,
  visibility_mode,
  sort_order
)
where product.product_key = 'lms'
  and manifest.manifest_version = '1.0.0'
on conflict (manifest_id, surface_key) do nothing;

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
  slot.alt_ar,
  'بانتظار رفع لقطة معتمدة من شاشة منصة التدريب التفاعلي.',
  slot.sort_order,
  'draft'
from catalog.addon_manifests manifest
join catalog.addon_products product
  on product.id = manifest.product_id
cross join (
  values
    ('overview.cover', 'cover', 'غلاف منصة التدريب التفاعلي', 10),
    ('screen.batches', 'gallery', 'شاشة الدفعات والجداول', 20),
    ('screen.operations', 'gallery', 'شاشة تشغيل المتدربين', 30)
) slot(media_key, media_role, alt_ar, sort_order)
where product.product_key = 'lms'
  and manifest.manifest_version = '1.0.0'
on conflict (manifest_id, media_key) do nothing;

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
  200000,
  'SAR',
  'year',
  date '2026-08-12',
  null,
  false,
  1500,
  'Initial annual LMS add-on price.'
from catalog.addon_products product
where product.product_key = 'lms'
on conflict (product_id, currency, valid_from) do nothing;

-------------------------------------------------------------------------------
-- 2. Reef keeps every add-on for its already-approved fixed launch year
-------------------------------------------------------------------------------

do $reef_lms_grant$
declare
  v_reef_tenant_id uuid;
  v_product_id uuid;
  v_subscription_id uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('addon_lms:reef-skills', 0)
  );

  select tenant.id into v_reef_tenant_id
  from core.tenants tenant
  where tenant.tenant_key = 'tenant-reef-skills'
    and tenant.slug = 'reef-skills'
  limit 1;

  select product.id into v_product_id
  from catalog.addon_products product
  where product.product_key = 'lms'
  limit 1;

  if v_reef_tenant_id is null or v_product_id is null then
    raise exception 'reef_lms_grant_precondition_failed';
  end if;

  insert into catalog.tenant_addon_subscriptions (
    tenant_id,
    product_id,
    status,
    source,
    period_start,
    period_end,
    requested_note,
    decision_note,
    cancel_at_period_end,
    price_version_id,
    auto_renew,
    activated_at,
    period_is_authoritative,
    lifecycle_protected_until
  )
  select
    v_reef_tenant_id,
    v_product_id,
    'active',
    'migration',
    timestamptz '2026-08-01 00:00:00+03',
    timestamptz '2027-08-01 00:00:00+03',
    'Reef retains every published add-on during its approved launch year.',
    'reef_lms_addon_2026_2027',
    false,
    price.id,
    false,
    timestamptz '2026-08-01 00:00:00+03',
    true,
    timestamptz '2027-08-01 00:00:00+03'
  from catalog.addon_price_versions price
  where price.product_id = v_product_id
    and price.currency = 'SAR'
    and price.valid_from = date '2026-08-12'
  on conflict (tenant_id, product_id)
    where status in ('pending', 'trialing', 'active', 'paused')
  do nothing;

  select subscription.id into v_subscription_id
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id = v_reef_tenant_id
    and subscription.product_id = v_product_id
    and subscription.status = 'active'
    and subscription.period_start =
      timestamptz '2026-08-01 00:00:00+03'
    and subscription.period_end =
      timestamptz '2027-08-01 00:00:00+03'
    and subscription.period_is_authoritative
    and subscription.lifecycle_protected_until =
      timestamptz '2027-08-01 00:00:00+03'
  limit 1;

  if v_subscription_id is null then
    raise exception 'reef_lms_subscription_incomplete';
  end if;

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
  values (
    v_subscription_id,
    v_reef_tenant_id,
    v_product_id,
    'reef_lms_addon_20260801',
    'migration_grant',
    null,
    'active',
    timestamptz '2026-08-01 00:00:00+03',
    jsonb_build_object(
      'productKey', 'lms',
      'startsAt', timestamptz '2026-08-01 00:00:00+03',
      'endsAt', timestamptz '2027-08-01 00:00:00+03',
      'preserveOperationalData', true
    )
  )
  on conflict (tenant_id, product_id, event_key) do nothing;

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
    'catalog.addon.reef_lms_grant_v3',
    'tenant_addon_subscription',
    v_subscription_id::text,
    jsonb_build_object(
      'productKey', 'lms',
      'operationalRowsChanged', false,
      'dataPolicy', 'preserve_on_disable'
    )
  where not exists (
    select 1
    from audit_log.events event
    where event.tenant_id = v_reef_tenant_id
      and event.action = 'catalog.addon.reef_lms_grant_v3'
      and event.resource_id = v_subscription_id::text
  );

  if now() >= timestamptz '2026-08-01 00:00:00+03'
     and now() < timestamptz '2027-08-01 00:00:00+03'
     and not private_app.tenant_addon_enabled(
       v_reef_tenant_id,
       'addon.training.lms'
     ) then
    raise exception 'reef_lms_effective_entitlement_missing';
  end if;
end;
$reef_lms_grant$;

-------------------------------------------------------------------------------
-- 3. One entitlement snapshot drives menus, pages and server action gates
-------------------------------------------------------------------------------

create or replace function public.v3_tenant_addon_navigation_snapshot(
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
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.can_access_tenant(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', now(),
    'tenantId', v_tenant.id,
    'tenantSlug', v_tenant.slug,
    'enabledProductKeys', coalesce((
      select jsonb_agg(product.product_key order by product.product_key)
      from catalog.addon_products product
      join catalog.features feature on feature.id = product.feature_id
      where product.status in ('beta', 'active')
        and private_app.tenant_addon_enabled(
          v_tenant.id,
          feature.feature_key
        )
    ), '[]'::jsonb),
    'surfaces', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'productKey', product.product_key,
          'key', surface.surface_key,
          'location', surface.location_key,
          'type', surface.surface_type,
          'requiredPermission', surface.required_permission
        )
        order by surface.sort_order, product.sort_order, surface.surface_key
      )
      from catalog.addon_products product
      join catalog.features feature on feature.id = product.feature_id
      join catalog.addon_manifests manifest
        on manifest.product_id = product.id
       and manifest.is_current
       and manifest.status = 'published'
      join catalog.addon_surfaces surface
        on surface.manifest_id = manifest.id
       and surface.status = 'active'
       and surface.visibility_mode = 'when_entitled'
      where product.status in ('beta', 'active')
        and private_app.tenant_addon_enabled(
          v_tenant.id,
          feature.feature_key
        )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function
  public.v3_tenant_addon_navigation_snapshot(text)
from public, anon;

grant execute on function
  public.v3_tenant_addon_navigation_snapshot(text)
to authenticated;

comment on function
  public.v3_tenant_addon_navigation_snapshot(text) is
  'Fail-closed tenant add-on keys and declared surfaces; contains no secrets or executable route values.';

commit;
