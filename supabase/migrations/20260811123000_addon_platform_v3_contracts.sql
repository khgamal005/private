-- Add-on platform v3 follow-up: finalize UI contracts and safe media reads.

begin;

-- Webhook verification material is required before provider health may become
-- active. No secret value is stored in these catalog rows.
update marketplace.payment_provider_configs
set required_secret_keys = array['apiToken', 'notificationToken']::text[],
    optional_secret_keys = '{}'::text[],
    updated_at = now()
where provider_key = 'tamara';

update marketplace.payment_provider_configs
set required_secret_keys =
      array['clientId', 'clientSecret', 'webhookId']::text[],
    optional_secret_keys = '{}'::text[],
    updated_at = now()
where provider_key = 'paypal';

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
              and price.currency = 'SAR'
              and price.valid_from <= current_date
              and (price.valid_to is null or price.valid_to > current_date)
            order by price.valid_from desc
            limit 1
          ),
          'entitlement', entitlement.value,
          'actions', jsonb_build_object(
            'canOpen', coalesce(
              (entitlement.value ->> 'enabled')::boolean,
              false
            ) and (entitlement.value ->> 'status') in (
              'active', 'included', 'trialing'
            ),
            'canRequestTrial', not coalesce(
              (entitlement.value ->> 'enabled')::boolean,
              false
            ) and product.trial_days > 0
              and (entitlement.value ->> 'status') in (
                'disabled', 'expired', 'cancelled'
              ),
            'canCancelRequest',
              (entitlement.value ->> 'status') = 'pending',
            'canCheckout', not coalesce(
              (entitlement.value ->> 'enabled')::boolean,
              false
            ) and (entitlement.value ->> 'status') in (
              'disabled', 'expired', 'cancelled'
            ),
            'canRenew', (entitlement.value ->> 'status') in (
              'expired', 'cancelled'
            ),
            'canManage', true,
            'openPlacementKey', (
              select surface.location_key
              from catalog.addon_surfaces surface
              join catalog.addon_manifests manifest
                on manifest.id = surface.manifest_id
               and manifest.product_id = product.id
               and manifest.is_current
               and manifest.status = 'published'
              where surface.status = 'active'
                and surface.visibility_mode = 'when_entitled'
              order by surface.sort_order, surface.surface_key
              limit 1
            )
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
              'displayUrl', '/api/tenant/' || v_tenant.slug
                || '/addon-media/' || product.product_key
                || '/' || media.media_key,
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
      cross join lateral (
        select private_app.addon_entitlement_v3(
          v_tenant.id,
          feature.feature_key
        ) as value
      ) entitlement
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

create or replace function public.v3_tenant_addon_media_resolve(
  p_slug text,
  p_product_key text,
  p_media_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_media catalog.addon_media%rowtype;
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

  select media.* into v_media
  from catalog.addon_media media
  join catalog.addon_manifests manifest
    on manifest.id = media.manifest_id
   and manifest.is_current
   and manifest.status = 'published'
  join catalog.addon_products product
    on product.id = manifest.product_id
   and product.status in ('beta', 'active')
  where product.product_key = p_product_key
    and media.media_key = p_media_key
    and media.status = 'active'
  limit 1;

  if v_media.id is null then raise exception 'addon_media_not_found'; end if;
  if v_media.storage_path is null and v_media.external_url is null then
    raise exception 'addon_media_not_ready';
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'key', v_media.media_key,
    'type', v_media.media_type,
    'storageBucket', v_media.storage_bucket,
    'storagePath', v_media.storage_path,
    'externalUrl', v_media.external_url,
    'width', v_media.width_px,
    'height', v_media.height_px
  ));
end;
$$;

revoke all on function public.v3_tenant_addon_media_resolve(
  text,
  text,
  text
) from public, anon;
grant execute on function public.v3_tenant_addon_media_resolve(
  text,
  text,
  text
) to authenticated;

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
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', tenant.id,
        'name', tenant.name,
        'slug', tenant.slug,
        'status', tenant.status
      ) order by tenant.name, tenant.slug)
      from core.tenants tenant
    ), '[]'::jsonb),
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
            and price.currency = 'SAR'
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
        'protected', subscription.lifecycle_protected_until is not null
          and now() < subscription.lifecycle_protected_until,
        'periodIsAuthoritative', subscription.period_is_authoritative,
        'lifecycleProtectedUntil',
          subscription.lifecycle_protected_until,
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
        'optionalSecretKeys', to_jsonb(provider.optional_secret_keys),
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

commit;
