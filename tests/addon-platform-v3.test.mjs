import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const TEST_DIR=dirname(fileURLToPath(import.meta.url));
const MAIN_DIR=resolve(TEST_DIR,'..');
const MIGRATIONS_DIR=resolve(MAIN_DIR,'supabase/migrations');

const FILES={
  migration:resolve(
    MIGRATIONS_DIR,
    '20260811120000_addon_platform_v3.sql'
  ),
  foreignKeyIndexes:resolve(
    MIGRATIONS_DIR,
    '20260811121000_addon_platform_v3_fk_indexes.sql'
  ),
  periodAuthority:resolve(
    MIGRATIONS_DIR,
    '20260811122000_addon_platform_v3_period_authority.sql'
  ),
  contracts:resolve(
    MIGRATIONS_DIR,
    '20260811123000_addon_platform_v3_contracts.sql'
  ),
  paymentBundle:resolve(
    MIGRATIONS_DIR,
    '20260811124000_addon_platform_v3_payment_bundle.sql'
  ),
  grantHardening:resolve(
    MIGRATIONS_DIR,
    '20260811125000_addon_platform_v3_grant_hardening.sql'
  ),
  paymentHardening:resolve(
    MIGRATIONS_DIR,
    '20260811126000_addon_platform_v3_payment_hardening.sql'
  ),
  businessTimezone:resolve(
    MIGRATIONS_DIR,
    '20260811127000_addon_platform_v3_business_timezone.sql'
  ),
  jsonbKeyCount:resolve(
    MIGRATIONS_DIR,
    '20260811128000_addon_platform_v3_jsonb_key_count.sql'
  ),
  lmsNavigation:resolve(
    MIGRATIONS_DIR,
    '20260812110000_lms_addon_navigation_gates.sql'
  ),
  api:resolve(MAIN_DIR,'lib/api.js'),
  placementRegistry:resolve(MAIN_DIR,'lib/addons/placement-registry.js'),
  tenantCenter:resolve(MAIN_DIR,'components/addon-center.js'),
  platformConsole:resolve(MAIN_DIR,'components/platform-addon-console.js'),
  tenantPage:resolve(MAIN_DIR,'app/tenant/[slug]/addons/page.js'),
  platformPage:resolve(MAIN_DIR,'app/control/addons/page.js'),
  providerProxy:resolve(
    MAIN_DIR,
    'app/api/platform/payment-provider-secret/route.js'
  ),
  tenantActionRoute:resolve(
    MAIN_DIR,
    'app/api/tenant/[action]/route.js'
  ),
  platformActionRoute:resolve(
    MAIN_DIR,
    'app/api/platform/[action]/route.js'
  ),
  providerEdge:resolve(
    MAIN_DIR,
    'supabase/functions/payment-provider-admin/index.ts'
  ),
  mediaProxy:resolve(
    MAIN_DIR,
    'app/api/tenant/[action]/addon-media/[productKey]/[mediaKey]/route.js'
  )
};

const entries=await Promise.all(
  Object.entries(FILES).map(async([key,path])=>[
    key,
    await readFile(path,'utf8')
  ])
);
const source=Object.fromEntries(entries);

const INITIAL_PRODUCTS=[
  'api',
  'automation',
  'cms_pro',
  'custom_store',
  'delivery_analytics',
  'email',
  'marketing_attribution',
  'salla',
  'shopify',
  'templates',
  'whatsapp',
  'woocommerce',
  'yeastar',
  'zid',
  'zoom'
];

const EXPECTED_PRODUCTS=[
  ...INITIAL_PRODUCTS,
  'lms'
].sort();

function sortedUnique(values){
  return [...new Set(values)].sort();
}

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function sectionBetween(text,startMarker,endMarker){
  const start=text.indexOf(startMarker);
  assert.notEqual(start,-1,`Missing start marker: ${startMarker}`);
  const end=text.indexOf(endMarker,start+startMarker.length);
  assert.notEqual(end,-1,`Missing end marker: ${endMarker}`);
  return text.slice(start,end);
}

function sqlFunction(text,qualifiedName){
  const startPattern=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i'
  );
  const match=startPattern.exec(text);
  assert.ok(match,`Missing SQL function: ${qualifiedName}`);
  const tail=text.slice(match.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,`Unterminated SQL function: ${qualifiedName}`);
  return tail.slice(0,body.index+body[0].length);
}

function withoutSqlComments(text){
  return text
    .replace(/\/\*[\s\S]*?\*\//g,' ')
    .replace(/--[^\r\n]*/g,' ');
}

function withoutAllowedForeignKeyDeletes(text){
  return withoutSqlComments(text).replace(
    /\bon\s+delete\s+(?:no\s+action|restrict|cascade|set\s+(?:null|default))\b/gi,
    ' '
  );
}

function objectFreezeBody(text,name){
  const pattern=new RegExp(
    `const\\s+${escapeRegExp(name)}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`
  );
  const match=pattern.exec(text);
  assert.ok(match,`Missing Object.freeze registry: ${name}`);
  return match[1];
}

function quotedObjectKeys(body){
  return [...body.matchAll(/'([^']+)'\s*:/g)].map(match=>match[1]);
}

function productPlacementEntries(body){
  return [...body.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:\s*'([^']+)'/gm)]
    .map(([,productKey,placementKey])=>({productKey,placementKey}));
}

test('migrations are additive and contain no destructive SQL statements',()=>{
  for(const key of [
    'migration',
    'foreignKeyIndexes',
    'periodAuthority',
    'contracts',
    'paymentBundle',
    'grantHardening',
    'paymentHardening',
    'businessTimezone',
    'jsonbKeyCount',
    'lmsNavigation'
  ]){
    const migration=withoutAllowedForeignKeyDeletes(source[key]);
    assert.doesNotMatch(
      migration,
      /\b(?:drop\s+(?:table|schema)|delete\s+from|truncate(?:\s+table)?)\b/i,
      `${key} contains destructive schema or row removal`
    );
    assert.equal(
      (migration.match(/\bbegin\s*;/gi)||[]).length,
      1,
      `${key} must have exactly one transaction start`
    );
    assert.equal(
      (migration.match(/\bcommit\s*;/gi)||[]).length,
      1,
      `${key} must have exactly one transaction commit`
    );
  }

  const expectedIndexes=[
    'addon_manifests_creator_idx_v3',
    'addon_media_surface_reference_idx_v3',
    'addon_price_versions_creator_idx_v3',
    'tenant_addon_events_actor_idx_v3',
    'tenant_addon_events_product_time_idx_v3'
  ];
  for(const indexName of expectedIndexes){
    assert.match(
      source.foreignKeyIndexes,
      new RegExp(`create\\s+index\\s+if\\s+not\\s+exists\\s+${indexName}\\b`,'i')
    );
  }
});

test('the fixed 15-product annual price catalog has matching manifest surfaces',()=>{
  const priceSeed=sectionBetween(
    source.migration,
    '-- Initial annual launch prices.',
    '-- v2 marketplace reads the denormalized columns.'
  );
  const prices=[...priceSeed.matchAll(
    /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*(\d+)::bigint\s*\)/g
  )].map(([,productKey,amountMinor])=>({
    productKey,
    amountMinor:Number(amountMinor)
  }));

  assert.equal(prices.length,15,'Expected exactly 15 initial annual prices');
  assert.deepEqual(
    sortedUnique(prices.map(price=>price.productKey)),
    INITIAL_PRODUCTS
  );
  assert.ok(prices.every(price=>price.amountMinor>0));
  assert.match(priceSeed,/'SAR'[\s\S]*?'year'[\s\S]*?date\s*'2026-08-01'/i);
  assert.match(
    priceSeed,
    /on\s+conflict\s*\(product_id,\s*currency,\s*valid_from\)\s+do\s+nothing/i
  );

  const manifestSeed=sectionBetween(
    source.migration,
    'insert into catalog.addon_manifests',
    '-- Every product has one permanent catalog/control surface.'
  );
  assert.match(manifestSeed,/'1\.0\.0'[\s\S]*?'published'[\s\S]*?true/i);
  assert.match(
    manifestSeed,
    /from\s+catalog\.addon_products\s+product[\s\S]*?where\s+product\.status\s+in\s*\(\s*'beta'\s*,\s*'active'\s*\)/i
  );
  assert.match(
    manifestSeed,
    /on\s+conflict\s*\(product_id,\s*manifest_version\)\s+do\s+nothing/i
  );

  const surfaceSeed=sectionBetween(
    source.migration,
    '-- Known live surfaces from the current application routes.',
    '-- Draft media slots make missing screenshots explicit'
  );
  const surfaceProducts=[...surfaceSeed.matchAll(
    /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'([^']+)'/g
  )].map(([,productKey])=>productKey);
  assert.equal(surfaceProducts.length,15,'Expected one known surface per product');
  assert.deepEqual(sortedUnique(surfaceProducts),INITIAL_PRODUCTS);
});

test('LMS is a standalone licensed surface with a tenant-safe navigation snapshot',()=>{
  const migration=source.lmsNavigation;
  const navigation=sqlFunction(
    migration,
    'public.v3_tenant_addon_navigation_snapshot'
  );

  assert.match(migration,/'addon\.training\.lms'/);
  assert.match(migration,/'lms'[\s\S]*?'training'/);
  assert.match(migration,/200000[\s\S]*?'SAR'[\s\S]*?'year'/);
  assert.match(migration,/'tenant\.lms'[\s\S]*?'when_entitled'/);
  assert.match(migration,/\/tenant\/\{slug\}\/lms/);
  assert.match(migration,/tenant\.academy\.read/);

  assert.match(navigation,/private_app\.can_access_tenant\s*\(/i);
  assert.match(navigation,/private_app\.tenant_addon_enabled\s*\(/i);
  assert.match(navigation,/'enabledProductKeys'/);
  assert.match(navigation,/'surfaces'/);
  assert.doesNotMatch(navigation,/route_template|external_url|secret/i);

  const reef=sectionBetween(
    migration,
    'do $reef_lms_grant$',
    '$reef_lms_grant$;'
  );
  assert.match(reef,/tenant\.tenant_key\s*=\s*'tenant-reef-skills'/i);
  assert.match(reef,/period_is_authoritative[\s\S]*?true/i);
  assert.match(
    reef,
    /lifecycle_protected_until[\s\S]*?2027-08-01 00:00:00\+03/i
  );
  assert.doesNotMatch(migration,/tenant-modaar-training-center[\s\S]*?insert into catalog\.tenant_addon_subscriptions/i);
});

test('Reef receives every published add-on for the exact fixed year only',()=>{
  const reef=sectionBetween(
    source.migration,
    'do $reef_grant$',
    '$reef_grant$;'
  );
  const start="2026-08-01 00:00:00+03";
  const end="2027-08-01 00:00:00+03";

  assert.match(reef,/tenant\.tenant_key\s*=\s*'tenant-reef-skills'/i);
  assert.match(reef,/tenant\.slug\s*=\s*'reef-skills'/i);
  assert.ok(reef.includes(`timestamptz '${start}'`));
  assert.ok(reef.includes(`timestamptz '${end}'`));

  const timestampLiterals=[...reef.matchAll(/timestamptz\s*'([^']+)'/gi)]
    .map(match=>match[1]);
  assert.ok(timestampLiterals.length>=8,'Expected dated grant, event and audit rows');
  assert.ok(
    timestampLiterals.every(value=>value===start||value===end),
    `Unexpected Reef timestamp: ${timestampLiterals.join(', ')}`
  );
  assert.match(
    reef,
    /period_start[\s\S]*?period_end[\s\S]*?timestamptz\s*'2026-08-01 00:00:00\+03'[\s\S]*?timestamptz\s*'2027-08-01 00:00:00\+03'/i
  );
  assert.match(reef,/product\.status\s+in\s*\(\s*'beta'\s*,\s*'active'\s*\)/i);
  assert.match(reef,/auto_renew[\s\S]*?false/i);
  assert.match(reef,/v_subscription_count\s*<>\s*v_product_count/i);
  assert.match(reef,/reef_addon_grant_incomplete/i);

  const mutationTargets=sortedUnique(
    [...reef.matchAll(/\b(?:insert\s+into|update)\s+([a-z_]+\.[a-z_]+)/gi)]
      .map(match=>match[1].toLowerCase())
  );
  assert.deepEqual(mutationTargets,[
    'audit_log.events',
    'catalog.tenant_addon_subscription_events',
    'catalog.tenant_addon_subscriptions',
    'core.tenant_modules'
  ]);
});

test('all legacy entitlement gates are expiry-aware, including bundled tenants',()=>{
  const base=sqlFunction(
    source.migration,
    'private_app.addon_entitlement_v2_base'
  );
  const expiry=sqlFunction(
    source.periodAuthority,
    'private_app.addon_entitlement_v3'
  );
  const compatibilityWrapper=sqlFunction(
    source.migration,
    'private_app.addon_entitlement'
  );
  const booleanGate=sqlFunction(
    source.migration,
    'private_app.tenant_addon_enabled'
  );

  assert.ok(
    source.migration.indexOf('private_app.addon_entitlement_v2_base')<
      source.migration.indexOf('private_app.addon_entitlement_v3')
  );
  assert.match(expiry,/private_app\.addon_entitlement_v2_base\s*\(/i);
  assert.match(expiry,/v_starts_at\s+is\s+null\s+or\s+v_starts_at\s*<=\s*now\(\)/i);
  assert.match(expiry,/v_ends_at\s+is\s+null\s+or\s+v_ends_at\s*>\s*now\(\)/i);
  assert.match(expiry,/v_ends_at\s+is\s+not\s+null\s+and\s+v_ends_at\s*<=\s*now\(\)/i);
  assert.match(expiry,/'expired'/i);
  assert.match(expiry,/'expiryAware'\s*,\s*true/i);
  assert.match(compatibilityWrapper,/select\s+private_app\.addon_entitlement_v3\s*\(/i);
  assert.match(booleanGate,/private_app\.addon_entitlement_v3\s*\(/i);

  const planBranch=base.indexOf("coalesce(v_plan_enabled, false)");
  const subscriptionBranch=base.indexOf("v_subscription.status = 'active'");
  const basePrioritizesDatedSubscription=
    subscriptionBranch!==-1&&planBranch!==-1&&subscriptionBranch<planBranch;
  const v3PrioritizesDatedSubscription=
    /v_subscription\.period_is_authoritative/i.test(expiry)
    &&/v_source\s*(?:<>|!=)\s*'override'/i.test(expiry);
  assert.ok(
    basePrioritizesDatedSubscription||v3PrioritizesDatedSubscription,
    'A standalone dated subscription must outrank a legacy bundled plan, while an explicit tenant override remains authoritative'
  );
  assert.match(
    source.periodAuthority,
    /lifecycle_protected_until[\s\S]*?protected_addon_subscription_lifecycle/i
  );
  assert.match(
    source.periodAuthority,
    /period_is_authoritative\s*=\s*true[\s\S]*?tenant\.slug\s*=\s*'reef-skills'/i
  );
});

test('tenant and platform snapshots never expose payment secret material',()=>{
  const tenantSnapshot=sqlFunction(
    source.contracts,
    'public.v3_tenant_addon_center_snapshot'
  );
  const platformSnapshot=sqlFunction(
    source.contracts,
    'public.v3_platform_addon_center_snapshot'
  );
  const providerAdminSnapshot=sqlFunction(
    source.paymentHardening,
    'public.v3_platform_payment_provider_admin_snapshot'
  );
  const secretAction=sqlFunction(
    source.migration,
    'public.v3_service_payment_provider_secret_action'
  );
  const bannedSnapshotMaterial=/\b(?:vault_secret_id|p_secret_value|decrypted_secret|decrypted_secrets)\b|['"](?:secretValue|vaultSecretId)['"]/i;

  assert.doesNotMatch(tenantSnapshot,bannedSnapshotMaterial);
  assert.doesNotMatch(platformSnapshot,bannedSnapshotMaterial);
  assert.doesNotMatch(providerAdminSnapshot,bannedSnapshotMaterial);
  assert.match(
    tenantSnapshot,
    /provider\.status\s*=\s*'active'[\s\S]*?provider\.last_verified_at\s+is\s+not\s+null/i
  );
  assert.match(platformSnapshot,/'configuredSecretKeys'/i);
  assert.match(platformSnapshot,/private_app\.has_platform_permission\s*\(/i);
  assert.match(providerAdminSnapshot,/'actorSubjectId'/i);
  assert.match(providerAdminSnapshot,/'nativeAdapterDeployed'\s*,\s*false/i);

  const secretReturn=secretAction.slice(
    secretAction.toLowerCase().lastIndexOf('return jsonb_build_object')
  );
  assert.doesNotMatch(secretReturn,/\bp_secret_value\b|\bvault_secret_id\b/i);
  assert.match(secretReturn,/'secretReturned'\s*,\s*false/i);
  assert.match(
    source.migration,
    /revoke\s+all\s+on\s+table\s+marketplace\.payment_provider_secret_refs\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i
  );
  assert.match(
    source.paymentHardening,
    /revoke\s+all\s+on\s+function\s+public\.v3_service_payment_provider_secret_action[\s\S]*?from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*;/i
  );
});

test('payment credential API authenticates first and returns no secret values',()=>{
  const proxy=source.providerProxy;
  const edge=source.providerEdge;

  assert.doesNotMatch(proxy,/SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey/);
  assert.match(proxy,/const\s+PROVIDERS\s*=\s*new\s+Set\(\['tamara','paymob','paypal'\]\)/);
  assert.match(proxy,/Authorization:`Bearer \$\{token\}`/);
  assert.match(proxy,/cache:'no-store'/);
  assert.match(proxy,/secretEntries\.length>20/);
  assert.match(proxy,/value\.length>8192/);

  const authorizeAt=edge.indexOf(
    '/rpc/v3_platform_payment_provider_admin_snapshot'
  );
  const storeAt=edge.indexOf('/rpc/v3_service_payment_provider_bundle_action');
  assert.ok(authorizeAt!==-1&&storeAt!==-1&&authorizeAt<storeAt);
  assert.match(edge,/Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  assert.match(edge,/if\(!authorizationCheck\.ok\)return json\(403/);
  assert.match(edge,/actorSubjectId/);
  assert.match(edge,/p_actor_subject_id:actorSubjectId/);
  assert.match(edge,/p_public_config:publicConfig/);
  assert.match(edge,/p_secrets:secrets/);
  assert.match(edge,/secretReturned:false/);
  assert.doesNotMatch(edge,/console\.(?:log|info|warn|error)\([^\n]*secretValue/i);

  const successResponse=sectionBetween(
    edge,
    'return json(200,{',
    '});\n  }catch'
  );
  assert.doesNotMatch(successResponse,/\bsecretValue\b|\bserviceRoleKey\b/);
  assert.match(successResponse,/secretReturned:false/);

  const bundleGateway=sqlFunction(
    source.paymentHardening,
    'public.v3_service_payment_provider_bundle_action'
  );
  const bundleCore=sqlFunction(
    source.paymentHardening,
    'private_app.v3_payment_provider_bundle_core'
  );
  assert.match(bundleGateway,/auth\.role\(\)\s*<>\s*'service_role'/i);
  assert.match(bundleGateway,/payment_provider_actor_required/i);
  assert.match(bundleCore,/v3_payment_provider_store_secret_v2\s*\(/i);
  assert.match(bundleCore,/'secretReturned'\s*,\s*false/i);
  assert.doesNotMatch(
    bundleCore.slice(
      bundleCore.toLowerCase().lastIndexOf('return jsonb_build_object')
    ),
    /p_secrets|p_secret_value/i
  );
});

test('grant gateway uses tenant UUID, deterministic currency, and no Reef bypass',()=>{
  const gateway=sqlFunction(
    source.grantHardening,
    'public.v3_platform_addon_center_action'
  );
  assert.match(gateway,/v_payload\s*\?\s*'tenantSlug'/i);
  assert.match(gateway,/tenant_slug_not_allowed_for_addon_grant/i);
  assert.match(gateway,/\(v_payload\s*->>\s*'tenantId'\)::uuid/i);
  assert.match(gateway,/protected_override_not_supported/i);
  assert.match(gateway,/price\.currency\s*=\s*v_currency/i);
  assert.match(gateway,/price\.billing_interval\s*=\s*'year'/i);
  assert.match(gateway,/addon_price_not_found_for_currency/i);
  assert.doesNotMatch(gateway,/tenant\.slug\s*=\s*v_payload/i);
  assert.match(
    source.grantHardening,
    /before\s+delete\s+on\s+catalog\.tenant_addon_subscriptions/i
  );
  assert.match(
    source.grantHardening,
    /reef_effective_addon_entitlement_incomplete/i
  );
  assert.match(
    source.businessTimezone,
    /alter\s+function\s+public\.v3_platform_addon_center_action\s*\(\s*text\s*,\s*jsonb\s*\)[\s\S]*?set\s+timezone\s+to\s+'Africa\/Cairo'/i
  );
});

test('payment environments are bound and native activation fails closed',()=>{
  const hardening=source.paymentHardening;
  const health=sqlFunction(
    hardening,
    'public.v3_service_payment_provider_health_action'
  );
  const providerSnapshot=sqlFunction(
    hardening,
    'public.v3_platform_payment_provider_admin_snapshot'
  );
  assert.match(hardening,/credentials_environment\s+text/i);
  assert.match(hardening,/payment_provider_full_secret_rotation_required/i);
  assert.match(hardening,/required_public_config_keys/i);
  assert.match(hardening,/payment_provider_public_config_key_not_allowed/i);
  assert.match(
    source.jsonbKeyCount,
    /private_app\.jsonb_object_length[\s\S]*?jsonb_object_keys/i
  );
  assert.match(hardening,/'merchantAccountId'\s*,\s*'integrationId'/i);
  assert.match(health,/if\s+coalesce\(p_ok,\s*false\)[\s\S]*?payment_provider_native_adapter_not_deployed/i);
  assert.match(health,/invalid_payment_provider_error_code/i);
  assert.match(providerSnapshot,/'active'\s*,\s*false/i);
  assert.match(providerSnapshot,/'configuredPublicConfig'/i);
  assert.match(providerSnapshot,/'configuredSecretKeys'/i);
  assert.doesNotMatch(
    providerSnapshot,
    /vault_secret_id|p_secret_value|decrypted_secret/i
  );
});

test('database surface keys resolve only through the tenant-safe placement registry',()=>{
  const routesBody=objectFreezeBody(source.placementRegistry,'ROUTES');
  const productBody=objectFreezeBody(source.placementRegistry,'PRODUCT_PRIMARY');
  const routeKeys=sortedUnique(quotedObjectKeys(routesBody));
  const placements=productPlacementEntries(productBody);

  assert.equal(placements.length,16);
  assert.deepEqual(
    sortedUnique(placements.map(entry=>entry.productKey)),
    EXPECTED_PRODUCTS
  );
  for(const {placementKey} of placements){
    assert.ok(routeKeys.includes(placementKey),`Unknown placement: ${placementKey}`);
  }
  assert.ok(routeKeys.includes('tenant.addons'));
  assert.equal(
    (routesBody.match(/encodeURIComponent\(slug\)/g)||[]).length,
    routeKeys.length,
    'Every tenant route must encode the slug'
  );
  assert.doesNotMatch(routesBody,/\$\{\s*slug\s*\}/);
  assert.match(source.placementRegistry,/\?ROUTES\[placementKey\]\(slug\)\s*:\s*null/);
  assert.doesNotMatch(source.placementRegistry,/routeTemplate|javascript:|https?:\/\//i);

  const surfaceSeed=sectionBetween(
    source.migration,
    '-- Known live surfaces from the current application routes.',
    '-- Draft media slots make missing screenshots explicit'
  );
  const sqlSurfaceKeys=sortedUnique(
    [...surfaceSeed.matchAll(
      /\(\s*'[a-z][a-z0-9_]*'\s*,\s*'([^']+)'/g
    )].map(match=>match[1])
  );
  for(const surfaceKey of ['tenant.addons',...sqlSurfaceKeys]){
    assert.ok(routeKeys.includes(surfaceKey),`Unregistered SQL surface: ${surfaceKey}`);
  }

  assert.match(source.tenantCenter,/import\s+\{addonHref\}/);
  assert.match(source.tenantCenter,/addonHref\(slug,product\)/);
  assert.match(source.tenantCenter,/href=\{openHref\}/);
  assert.doesNotMatch(
    source.tenantCenter,
    /href=\{[^}]*\.(?:routeTemplate|location|url)[^}]*\}/i
  );
  assert.match(source.tenantCenter,/item\.displayUrl/);
  assert.match(source.tenantCenter,/unoptimized/);
  assert.doesNotMatch(source.tenantCenter,/src=\{item\.url\}/);
  assert.match(
    source.mediaProxy,
    /v3_tenant_addon_media_resolve/
  );
  assert.match(source.mediaProxy,/\{action:slug,productKey,mediaKey\}/);
  assert.match(
    source.mediaProxy,
    /contentType\.startsWith\('image\/'\)/
  );
  assert.match(source.mediaProxy,/MAX_IMAGE_BYTES/);
});

test('add-on pages and UI actions use permission-gated, same-origin APIs',()=>{
  const platformPermission=source.platformPage.indexOf(
    "requirePlatformPermission('platform.billing.manage')"
  );
  const platformRead=source.platformPage.indexOf('getPlatformAddonCenter()');
  assert.ok(platformPermission!==-1&&platformPermission<platformRead);
  assert.match(
    source.api,
    /authRpc\('v3_platform_payment_provider_admin_snapshot'\)/
  );

  const tenantPermission=source.tenantPage.indexOf(
    "requireTenantPermission(slug,'tenant.settings.manage')"
  );
  const tenantRead=source.tenantPage.indexOf('getTenantAddonCenter(slug)');
  assert.ok(tenantPermission!==-1&&tenantPermission<tenantRead);

  assert.match(source.tenantCenter,/fetch\('\/api\/tenant\/addon-center'/);
  assert.match(source.tenantCenter,/المحاكاة والفشل لا يُفوتران/);
  assert.match(source.tenantCenter,/طلب تجربة/);
  assert.match(source.tenantCenter,/فتح إضافة Yeastar/);
  assert.match(source.platformConsole,/fetch\('\/api\/platform\/addon-decision'/);
  assert.match(
    source.platformConsole,
    /fetch\('\/api\/platform\/payment-provider-secret'/
  );
  assert.doesNotMatch(
    `${source.tenantCenter}\n${source.platformConsole}`,
    /fetch\(\s*(?:`|['"])https?:\/\//i
  );
  assert.match(source.platformConsole,/type="password"\s+autoComplete="new-password"/);
  assert.doesNotMatch(source.platformConsole,/Date\.now\s*\(/);
  assert.match(source.platformConsole,/function\s+annualEnd\s*\(/);
  assert.match(source.tenantActionRoute,/v3_tenant_addon_center_action/);
  assert.match(source.tenantActionRoute,/v2_tenant_addon_center_action/);
  assert.match(source.platformActionRoute,/v3_platform_addon_center_action/);
  assert.match(source.platformActionRoute,/v2_platform_addon_center_action/);
});
