const ROUTES=Object.freeze({
  'tenant.addons':slug=>`/tenant/${encodeURIComponent(slug)}/addons`,
  'tenant.settings.integrations':slug=>`/tenant/${encodeURIComponent(slug)}/settings?tab=integrations`,
  'tenant.settings.automation':slug=>`/tenant/${encodeURIComponent(slug)}/settings?tab=automation`,
  'tenant.settings.delivery':slug=>`/tenant/${encodeURIComponent(slug)}/settings?tab=delivery`,
  'tenant.settings.templates':slug=>`/tenant/${encodeURIComponent(slug)}/settings?tab=templates`,
  'tenant.integrations':slug=>`/tenant/${encodeURIComponent(slug)}/integrations`,
  'tenant.commerce.integrations':slug=>`/tenant/${encodeURIComponent(slug)}/integrations`,
  'tenant.yeastar':slug=>`/tenant/${encodeURIComponent(slug)}/yeastar`,
  'tenant.telephony.reports':slug=>`/tenant/${encodeURIComponent(slug)}/yeastar`,
  'tenant.yeastar.settings':slug=>`/tenant/${encodeURIComponent(slug)}/yeastar/settings`,
  'tenant.website':slug=>`/tenant/${encodeURIComponent(slug)}/website`,
  'tenant.website.cms':slug=>`/tenant/${encodeURIComponent(slug)}/website`,
  'tenant.marketing':slug=>`/tenant/${encodeURIComponent(slug)}/marketing`,
  'tenant.marketing.command_center':slug=>`/tenant/${encodeURIComponent(slug)}/marketing`
});

const PRODUCT_PRIMARY=Object.freeze({
  whatsapp:'tenant.settings.integrations',
  email:'tenant.settings.integrations',
  zoom:'tenant.settings.integrations',
  automation:'tenant.settings.automation',
  templates:'tenant.settings.templates',
  delivery_analytics:'tenant.settings.delivery',
  api:'tenant.settings.integrations',
  yeastar:'tenant.yeastar',
  cms_pro:'tenant.website',
  woocommerce:'tenant.integrations',
  salla:'tenant.integrations',
  zid:'tenant.integrations',
  shopify:'tenant.integrations',
  custom_store:'tenant.integrations',
  marketing_attribution:'tenant.marketing'
});

export function addonHref(slug,product={}){
  const surfaces=product.surfaces||[];
  const operational=surfaces.filter(surface=>
    surface.status!=='archived'
    &&surface.visibility==='when_entitled'
    &&surface.key!=='tenant.addons'
  );
  const requested=[
    product.actions?.openPlacementKey,
    product.openPlacementKey,
    product.primarySurfaceKey,
    ...operational.map(surface=>surface.location),
    ...operational.map(surface=>surface.key),
    PRODUCT_PRIMARY[product.key]
  ].filter(Boolean);
  const placementKey=requested.find(isRegisteredPlacement);
  return placementKey
    ?ROUTES[placementKey](slug)
    :null;
}

export function isRegisteredPlacement(key){
  return Boolean(ROUTES[key]);
}

export const ADDON_PLACEMENT_KEYS=Object.freeze(Object.keys(ROUTES));
