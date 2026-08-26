-- ODEIR add-on catalog control v1.
--
-- Separates marketplace merchandising from operational entitlement:
--   * hiding a product blocks new discovery, self-activation and purchases;
--   * existing subscriptions, navigation, integrations and tenant data continue;
--   * commercial copy can change without changing the immutable product key;
--   * all platform changes are permission checked, concurrency checked and audited.
--
-- Additive data change only. No tenant subscription, order or operational row is
-- updated or deleted by this migration.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('catalog.addon_products') is null
     or to_regclass('catalog.addon_categories') is null
     or to_regclass('catalog.tenant_addon_subscriptions') is null
     or to_regclass('marketplace.orders') is null
     or to_regclass('audit_log.events') is null then
    raise exception 'addon_catalog_control_missing_required_schema';
  end if;

  if to_regprocedure(
       'public.v3_platform_addon_center_snapshot()'
     ) is null
     or to_regprocedure(
       'public.v3_platform_addon_center_action(text,jsonb)'
     ) is null
     or to_regprocedure(
       'public.v2_tenant_marketplace_snapshot(text)'
     ) is null
     or to_regprocedure(
       'public.v2_tenant_marketplace_action(text,text,jsonb)'
     ) is null
     or to_regprocedure(
       'private_app.has_platform_permission(text)'
     ) is null
     or to_regprocedure(
       'private_app.has_tenant_permission(uuid,text)'
     ) is null
     or to_regprocedure(
       'private_app.write_audit(text,text,text,uuid,jsonb)'
     ) is null then
    raise exception 'addon_catalog_control_missing_required_function';
  end if;

  if to_regprocedure(
       'private_app.v3_platform_addon_center_snapshot_catalog_legacy()'
     ) is not null
     or to_regprocedure(
       'private_app.v3_platform_addon_center_action_catalog_legacy(text,jsonb)'
     ) is not null
     or to_regprocedure(
       'private_app.v2_tenant_marketplace_snapshot_catalog_legacy(text)'
     ) is not null
     or to_regprocedure(
       'private_app.v2_tenant_marketplace_action_catalog_legacy(text,text,jsonb)'
     ) is not null then
    raise exception 'addon_catalog_control_legacy_function_exists';
  end if;
end;
$preflight$;

alter table catalog.addon_products
  add column if not exists is_marketplace_visible boolean not null default true;

comment on column catalog.addon_products.is_marketplace_visible is
  'Commercial discovery and new-purchase visibility only. Never used by entitlement or operational feature gates.';

create index if not exists addon_products_visible_store_order_idx
  on catalog.addon_products(sort_order, product_key)
  where is_marketplace_visible
    and status in ('beta', 'active')
    and pricing_mode in ('fixed', 'free');

-------------------------------------------------------------------------------
-- Preserve the proven implementations privately, then keep the public RPC
-- signatures stable so an application rollback cannot bypass hidden products.
-------------------------------------------------------------------------------

alter function public.v3_platform_addon_center_snapshot()
  rename to v3_platform_addon_center_snapshot_catalog_legacy;
alter function public.v3_platform_addon_center_snapshot_catalog_legacy()
  set schema private_app;

alter function public.v3_platform_addon_center_action(text, jsonb)
  rename to v3_platform_addon_center_action_catalog_legacy;
alter function public.v3_platform_addon_center_action_catalog_legacy(text, jsonb)
  set schema private_app;

alter function public.v2_tenant_marketplace_snapshot(text)
  rename to v2_tenant_marketplace_snapshot_catalog_legacy;
alter function public.v2_tenant_marketplace_snapshot_catalog_legacy(text)
  set schema private_app;

alter function public.v2_tenant_marketplace_action(text, text, jsonb)
  rename to v2_tenant_marketplace_action_catalog_legacy;
alter function public.v2_tenant_marketplace_action_catalog_legacy(
  text,
  text,
  jsonb
)
  set schema private_app;

revoke all on function
  private_app.v3_platform_addon_center_snapshot_catalog_legacy()
from public, anon, authenticated;
revoke all on function
  private_app.v3_platform_addon_center_action_catalog_legacy(text, jsonb)
from public, anon, authenticated;
revoke all on function
  private_app.v2_tenant_marketplace_snapshot_catalog_legacy(text)
from public, anon, authenticated;
revoke all on function
  private_app.v2_tenant_marketplace_action_catalog_legacy(text, text, jsonb)
from public, anon, authenticated;

-------------------------------------------------------------------------------
-- Platform read model: enrich the existing contract without rebuilding its
-- subscription, manifest, price, surface or provider logic.
-------------------------------------------------------------------------------

create or replace function public.v3_platform_addon_center_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_products jsonb;
  v_summary jsonb;
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then
    raise exception 'forbidden';
  end if;

  v_base :=
    private_app.v3_platform_addon_center_snapshot_catalog_legacy();

  select coalesce(
    jsonb_agg(
      entry.value || jsonb_build_object(
        'marketplaceVisible', product.is_marketplace_visible,
        'displayOrder', product.sort_order,
        'updatedAt', product.updated_at
      )
      order by entry.ordinality
    ),
    '[]'::jsonb
  )
  into v_products
  from jsonb_array_elements(
    coalesce(v_base -> 'products', '[]'::jsonb)
  ) with ordinality as entry(value, ordinality)
  join catalog.addon_products product
    on product.id = (entry.value ->> 'id')::uuid;

  v_summary := coalesce(v_base -> 'summary', '{}'::jsonb)
    || jsonb_build_object(
      'visibleProducts', (
        select count(*)
        from catalog.addon_products product
        where product.is_marketplace_visible
          and product.status in ('beta', 'active')
          and product.pricing_mode in ('fixed', 'free')
          and (
            product.pricing_mode = 'free'
            or product.amount_minor > 0
          )
      ),
      'hiddenProducts', (
        select count(*)
        from catalog.addon_products product
        where not product.is_marketplace_visible
          and product.status in ('beta', 'active')
      )
    );

  return v_base || jsonb_build_object(
    'schemaVersion', 4,
    'summary', v_summary,
    'products', v_products
  );
end;
$$;

-------------------------------------------------------------------------------
-- Platform write gateway: mutable commercial fields only. Product key,
-- feature, runtime status, prices and every tenant entitlement stay untouched.
-------------------------------------------------------------------------------

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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_product catalog.addon_products%rowtype;
  v_before jsonb;
  v_name_ar text;
  v_name_en text;
  v_description_ar text;
  v_badge_ar text;
  v_reason text;
  v_display_order integer;
  v_marketplace_visible boolean;
  v_expected_updated_at timestamptz;
  v_product_id uuid;
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'invalid_addon_action_payload';
  end if;

  if p_action is distinct from 'update_product_catalog' then
    return
      private_app.v3_platform_addon_center_action_catalog_legacy(
        p_action,
        v_payload
      );
  end if;

  begin
    v_product_id := nullif(
      pg_catalog.btrim(v_payload ->> 'productId'),
      ''
    )::uuid;
    v_expected_updated_at := nullif(
      v_payload ->> 'expectedUpdatedAt',
      ''
    )::timestamptz;
    v_display_order := (v_payload ->> 'displayOrder')::integer;
  exception
    when invalid_text_representation
      or invalid_datetime_format
      or datetime_field_overflow
      or numeric_value_out_of_range then
      raise exception 'invalid_addon_product_update';
  end;

  if v_product_id is null or v_expected_updated_at is null then
    raise exception 'invalid_addon_product_update';
  end if;
  if not (v_payload ? 'marketplaceVisible')
     or jsonb_typeof(v_payload -> 'marketplaceVisible') <> 'boolean' then
    raise exception 'invalid_addon_product_visibility';
  end if;

  v_marketplace_visible :=
    (v_payload ->> 'marketplaceVisible')::boolean;
  v_name_ar := nullif(
    pg_catalog.btrim(v_payload ->> 'nameAr'),
    ''
  );
  v_name_en := nullif(
    pg_catalog.btrim(v_payload ->> 'nameEn'),
    ''
  );
  v_description_ar := nullif(
    pg_catalog.btrim(v_payload ->> 'descriptionAr'),
    ''
  );
  v_badge_ar := nullif(
    pg_catalog.btrim(v_payload ->> 'badgeAr'),
    ''
  );
  v_reason := nullif(
    pg_catalog.btrim(v_payload ->> 'reason'),
    ''
  );

  if v_name_ar is null
     or pg_catalog.length(v_name_ar) not between 2 and 120 then
    raise exception 'addon_product_name_required';
  end if;
  if v_name_en is not null
     and pg_catalog.length(v_name_en) > 120 then
    raise exception 'addon_product_name_too_long';
  end if;
  if v_description_ar is null
     or pg_catalog.length(v_description_ar) not between 10 and 1000 then
    raise exception 'addon_product_description_required';
  end if;
  if v_badge_ar is not null
     and pg_catalog.length(v_badge_ar) > 60 then
    raise exception 'addon_product_badge_too_long';
  end if;
  if v_display_order not between 0 and 10000 then
    raise exception 'invalid_addon_product_display_order';
  end if;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'addon_product_update_reason_required';
  end if;

  select product.*
  into v_product
  from catalog.addon_products product
  where product.id = v_product_id
  for update;

  if v_product.id is null then
    raise exception 'addon_product_not_found';
  end if;
  if v_product.updated_at is distinct from v_expected_updated_at then
    raise exception 'addon_product_update_conflict';
  end if;

  v_before := jsonb_strip_nulls(jsonb_build_object(
    'nameAr', v_product.name_ar,
    'nameEn', v_product.name_en,
    'descriptionAr', v_product.description_ar,
    'badgeAr', v_product.badge_ar,
    'displayOrder', v_product.sort_order,
    'marketplaceVisible', v_product.is_marketplace_visible
  ));

  update catalog.addon_products
  set name_ar = v_name_ar,
      name_en = v_name_en,
      description_ar = v_description_ar,
      badge_ar = v_badge_ar,
      sort_order = v_display_order,
      is_marketplace_visible = v_marketplace_visible,
      updated_at = pg_catalog.clock_timestamp()
  where id = v_product.id
  returning * into v_product;

  perform private_app.write_audit(
    'catalog.addon.product_catalog_updated',
    'addon_product',
    v_product.id::text,
    null,
    jsonb_build_object(
      'productKey', v_product.product_key,
      'reason', v_reason,
      'before', v_before,
      'after', jsonb_strip_nulls(jsonb_build_object(
        'nameAr', v_product.name_ar,
        'nameEn', v_product.name_en,
        'descriptionAr', v_product.description_ar,
        'badgeAr', v_product.badge_ar,
        'displayOrder', v_product.sort_order,
        'marketplaceVisible', v_product.is_marketplace_visible
      )),
      'operationalStatusChanged', false,
      'subscriptionRowsChanged', 0,
      'tenantDataChanged', false
    )
  );

  return jsonb_build_object(
    'id', v_product.id,
    'key', v_product.product_key,
    'name', v_product.name_ar,
    'nameEn', v_product.name_en,
    'description', v_product.description_ar,
    'badge', v_product.badge_ar,
    'displayOrder', v_product.sort_order,
    'marketplaceVisible', v_product.is_marketplace_visible,
    'updatedAt', v_product.updated_at
  );
end;
$$;

-------------------------------------------------------------------------------
-- Tenant marketplace read model: hidden products disappear from discovery,
-- while active-entitlement counts and all historical orders remain intact.
-------------------------------------------------------------------------------

create or replace function public.v2_tenant_marketplace_snapshot(
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
  v_base jsonb;
  v_summary jsonb;
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
    'tenant.workspace.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_base :=
    private_app.v2_tenant_marketplace_snapshot_catalog_legacy(p_slug);

  v_summary := coalesce(v_base -> 'summary', '{}'::jsonb)
    || jsonb_build_object(
      'addonProducts', (
        select count(*)
        from catalog.addon_products product
        where product.is_marketplace_visible
          and product.status in ('beta', 'active')
          and product.pricing_mode in ('fixed', 'free')
          and (
            product.pricing_mode = 'free'
            or product.amount_minor > 0
          )
      ),
      'freeAddonProducts', (
        select count(*)
        from catalog.addon_products product
        where product.is_marketplace_visible
          and product.status in ('beta', 'active')
          and product.pricing_mode = 'free'
          and product.amount_minor = 0
      )
    );

  return v_base || jsonb_build_object(
    'schemaVersion', 3,
    'summary', v_summary,
    'addonCategories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', category.category_key,
        'name', category.name_ar,
        'description', category.description_ar
      ) order by category.display_order, category.category_key)
      from catalog.addon_categories category
      where category.status = 'active'
        and exists (
          select 1
          from catalog.addon_products product
          where product.category_id = category.id
            and product.is_marketplace_visible
            and product.status in ('beta', 'active')
            and product.pricing_mode in ('fixed', 'free')
            and (
              product.pricing_mode = 'free'
              or product.amount_minor > 0
            )
        )
    ), '[]'::jsonb),
    'addons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id,
        'key', product.product_key,
        'featureKey', feature.feature_key,
        'categoryKey', coalesce(
          category.category_key,
          product.marketplace_category
        ),
        'categoryName', coalesce(
          category.name_ar,
          'إضافات أخرى'
        ),
        'name', product.name_ar,
        'nameEn', product.name_en,
        'description', product.description_ar,
        'pricingMode', product.pricing_mode,
        'amountMinor', product.amount_minor,
        'currency', product.currency,
        'interval', product.interval,
        'trialDays', product.trial_days,
        'badge', product.badge_ar,
        'activationMode', product.activation_mode,
        'entitlement', private_app.addon_entitlement(
          v_tenant.id,
          feature.feature_key
        )
      ) order by
        coalesce(category.display_order, 999),
        product.sort_order,
        product.product_key)
      from catalog.addon_products product
      join catalog.features feature
        on feature.id = product.feature_id
      left join catalog.addon_categories category
        on category.id = product.category_id
       and category.status = 'active'
      where product.is_marketplace_visible
        and product.status in ('beta', 'active')
        and product.pricing_mode in ('fixed', 'free')
        and (
          product.pricing_mode = 'free'
          or product.amount_minor > 0
        )
    ), '[]'::jsonb)
  );
end;
$$;

-------------------------------------------------------------------------------
-- Tenant marketplace write gateway: server-side enforcement prevents a hidden
-- product from being activated or bought through a stale UI/direct RPC call.
-- Existing orders remain payable/reviewable and existing entitlements remain on.
-------------------------------------------------------------------------------

create or replace function public.v2_tenant_marketplace_action(
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_product catalog.addon_products%rowtype;
  v_product_key text;
  v_feature_key text;
  v_idempotency_key text;
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
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'marketplace_product_invalid';
  end if;

  if p_action = 'create_order'
     and lower(coalesce(v_payload ->> 'itemType', '')) = 'addon' then
    v_idempotency_key := left(nullif(
      pg_catalog.btrim(v_payload ->> 'idempotencyKey'),
      ''
    ), 120);

    -- A retry of an already-created order is not a new purchase and must keep
    -- the legacy idempotency contract even if the product was hidden later.
    if v_idempotency_key is not null
       and exists (
         select 1
         from marketplace.orders orders
         where orders.tenant_id = v_tenant.id
           and orders.idempotency_key = v_idempotency_key
       ) then
      return
        private_app.v2_tenant_marketplace_action_catalog_legacy(
          p_slug,
          p_action,
          v_payload
        );
    end if;

    v_product_key := lower(nullif(
      pg_catalog.btrim(v_payload ->> 'productKey'),
      ''
    ));

    select product.*
    into v_product
    from catalog.addon_products product
    where product.product_key = v_product_key
      and product.is_marketplace_visible
      and product.status in ('beta', 'active')
      and product.pricing_mode = 'fixed'
      and product.amount_minor > 0
    for key share;

    if v_product.id is null then
      raise exception 'marketplace_product_not_found';
    end if;
  elsif p_action = 'activate_free_addon' then
    v_product_key := lower(nullif(
      pg_catalog.btrim(v_payload ->> 'productKey'),
      ''
    ));

    select product.*
    into v_product
    from catalog.addon_products product
    where product.product_key = v_product_key
      and product.status in ('beta', 'active')
      and product.pricing_mode = 'free'
      and product.amount_minor = 0
    for key share;

    if v_product.id is null then
      raise exception 'marketplace_product_not_found';
    end if;

    select feature.feature_key
    into v_feature_key
    from catalog.features feature
    where feature.id = v_product.feature_id
    limit 1;

    if not v_product.is_marketplace_visible
       and not coalesce((
         private_app.addon_entitlement(
           v_tenant.id,
           v_feature_key
         ) ->> 'enabled'
       )::boolean, false) then
      raise exception 'marketplace_product_not_found';
    end if;
  end if;

  return private_app.v2_tenant_marketplace_action_catalog_legacy(
    p_slug,
    p_action,
    v_payload
  );
end;
$$;

revoke all on function
  public.v3_platform_addon_center_snapshot()
from public, anon;
revoke all on function
  public.v3_platform_addon_center_action(text, jsonb)
from public, anon;
revoke all on function
  public.v2_tenant_marketplace_snapshot(text)
from public, anon;
revoke all on function
  public.v2_tenant_marketplace_action(text, text, jsonb)
from public, anon;

grant execute on function
  public.v3_platform_addon_center_snapshot()
to authenticated;
grant execute on function
  public.v3_platform_addon_center_action(text, jsonb)
to authenticated;
grant execute on function
  public.v2_tenant_marketplace_snapshot(text)
to authenticated;
grant execute on function
  public.v2_tenant_marketplace_action(text, text, jsonb)
to authenticated;

comment on function public.v3_platform_addon_center_snapshot() is
  'Add-on admin snapshot with commercial visibility, mutable copy metadata and unchanged entitlement state.';
comment on function public.v3_platform_addon_center_action(text, jsonb) is
  'Permissioned and audited add-on catalog editor. Product keys, runtime status and subscriptions are immutable through this action.';
comment on function public.v2_tenant_marketplace_snapshot(text) is
  'Tenant marketplace snapshot that excludes hidden products while preserving active entitlement and order history.';
comment on function public.v2_tenant_marketplace_action(text, text, jsonb) is
  'Tenant marketplace gateway that rejects new hidden-product activation or purchase, while preserving existing order actions.';

commit;
