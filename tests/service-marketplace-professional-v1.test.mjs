import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const migrationPath=join(
  root,
  'supabase/migrations/20260826235130_service_marketplace_professional_v1.sql'
);

function source(relativePath){
  const absolutePath=join(root,relativePath);
  assert.ok(existsSync(absolutePath),`Expected ${relativePath} to exist`);
  return readFileSync(absolutePath,'utf8');
}

function section(text,start,end){
  const from=text.indexOf(start);
  assert.notEqual(from,-1,`Missing section start: ${start}`);
  const to=end?text.indexOf(end,from+start.length):text.length;
  assert.notEqual(to,-1,`Missing section end: ${end}`);
  return text.slice(from,to);
}

const migration=source(
  'supabase/migrations/20260826235130_service_marketplace_professional_v1.sql'
);
const indexesMigration=source(
  'supabase/migrations/20260827180600_service_marketplace_fk_indexes_v1.sql'
);

test('professional services schema is additive and keeps the canonical order ledger',()=>{
  const newTables=[
    'service_providers',
    'service_provider_contacts',
    'service_provider_courses',
    'service_packages',
    'service_order_briefs',
    'service_order_assignments',
    'service_assignment_events',
    'service_reviews'
  ];

  for(const table of newTables){
    assert.match(
      migration,
      new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+marketplace\\.${table}\\b`,'i'),
      `${table} must be created additively`
    );
  }

  assert.match(migration,/alter\s+table\s+marketplace\.service_products[\s\S]*?add\s+column\s+if\s+not\s+exists\s+provider_id\b/i);
  assert.match(migration,/alter\s+table\s+marketplace\.service_products[\s\S]*?add\s+column\s+if\s+not\s+exists\s+marketplace_visible\b/i);
  assert.match(migration,/alter\s+table\s+marketplace\.order_items[\s\S]*?add\s+column\s+if\s+not\s+exists\s+service_package_id\b/i);

  assert.doesNotMatch(migration,/\bdrop\s+(?:table|schema)\b/i);
  assert.doesNotMatch(migration,/\btruncate(?:\s+table)?\b/i);
  assert.doesNotMatch(migration,/\balter\s+table[\s\S]{0,160}?\bdrop\s+column\b/i);
  assert.doesNotMatch(migration,/create\s+table\s+(?:if\s+not\s+exists\s+)?marketplace\.service_orders\b/i);

  const tenantAction=section(
    migration,
    'create or replace function public.v2_tenant_service_marketplace_action',
    'create or replace function private_app.sync_service_assignment_order_status_v1'
  );
  assert.match(tenantAction,/insert\s+into\s+marketplace\.orders\s*\(/i);
  assert.match(tenantAction,/insert\s+into\s+marketplace\.order_items\s*\(/i);
  assert.match(tenantAction,/insert\s+into\s+marketplace\.order_events\s*\(/i);
  assert.match(tenantAction,/private_app\.marketplace_order_payload\s*\(/i);
});

test('remaining marketplace foreign keys have additive covering indexes',()=>{
  for(const indexName of [
    'service_order_briefs_package_idx',
    'service_assignments_package_idx',
    'service_assignments_assigned_by_idx',
    'service_assignment_events_tenant_idx',
    'service_assignment_events_from_provider_idx',
    'service_assignment_events_actor_idx',
    'service_reviews_created_by_idx'
  ])assert.match(indexesMigration,new RegExp(`create index if not exists ${indexName}`));
  assert.doesNotMatch(indexesMigration,/\b(delete|truncate|drop table|update)\b/i);
});

test('all new marketplace tables use RLS and remain RPC-only',()=>{
  const protectedTables=[
    'service_providers',
    'service_provider_contacts',
    'service_provider_courses',
    'service_packages',
    'service_order_briefs',
    'service_order_assignments',
    'service_assignment_events',
    'service_reviews'
  ];

  for(const table of protectedTables){
    assert.match(
      migration,
      new RegExp(`alter\\s+table\\s+marketplace\\.${table}\\s+enable\\s+row\\s+level\\s+security`,'i'),
      `${table} must have RLS enabled`
    );
    assert.match(
      migration,
      new RegExp(`revoke\\s+all\\s+on\\s+(?:table\\s+)?marketplace\\.${table}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`,'i'),
      `${table} must not be directly readable or writable by API roles`
    );
  }
  assert.doesNotMatch(
    migration,
    /grant[\s\S]{0,120}?on\s+(?:table\s+)?marketplace\.service_provider_contacts\b/i,
    'provider contacts must never receive a direct table grant'
  );

  const rpcSignatures=[
    'public.v1_platform_service_marketplace_snapshot\\(\\)',
    'public.v1_platform_service_marketplace_action\\(text,jsonb\\)',
    'public.v2_tenant_service_marketplace_snapshot\\(text\\)',
    'public.v2_tenant_service_marketplace_action\\(text,text,jsonb\\)'
  ];
  for(const signature of rpcSignatures){
    assert.match(migration,new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${signature}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`,'i'));
    assert.match(migration,new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${signature}\\s+to\\s+authenticated`,'i'));
  }
});

test('tenant marketplace exposes the public provider profile without private contacts',()=>{
  const publicProviderPayload=section(
    migration,
    'create or replace function private_app.service_provider_public_payload',
    'create or replace function public.v1_platform_service_marketplace_snapshot'
  );
  const tenantSnapshot=section(
    migration,
    'create or replace function public.v2_tenant_service_marketplace_snapshot',
    'create or replace function public.v2_tenant_service_marketplace_action'
  );
  const tenantSurface=`${publicProviderPayload}\n${tenantSnapshot}`;

  for(const privateField of [
    'service_provider_contacts',
    "'contact'",
    "'email'",
    "'phone'",
    "'whatsapp'",
    "'internalNotes'",
    'website_url',
    'linkedin_url'
  ]){
    assert.ok(
      !tenantSurface.includes(privateField),
      `Tenant provider payload must not expose ${privateField}`
    );
  }

  assert.match(publicProviderPayload,/'name'\s*,\s*provider\.display_name_ar/i);
  assert.match(publicProviderPayload,/'bio'\s*,\s*provider\.bio_ar/i);
  assert.match(publicProviderPayload,/'verified'\s*,\s*provider\.verification_status\s*=\s*'verified'/i);
  assert.match(tenantSnapshot,/where\s+product\.marketplace_visible\s+and\s+product\.status\s+in\s*\('beta','active'\)/i);

  const platformSnapshot=section(
    migration,
    'create or replace function public.v1_platform_service_marketplace_snapshot',
    'create or replace function public.v1_platform_service_marketplace_action'
  );
  assert.match(platformSnapshot,/left\s+join\s+marketplace\.service_provider_contacts\s+contact/i);
  assert.match(platformSnapshot,/'internalNotes'\s*,\s*contact\.internal_notes/i);
});

test('platform edits use optimistic concurrency and write an audit trail',()=>{
  const platformAction=section(
    migration,
    'create or replace function public.v1_platform_service_marketplace_action',
    'create or replace function public.v2_tenant_service_marketplace_snapshot'
  );

  for(const action of [
    'save_provider',
    'save_course',
    'save_service',
    'save_package',
    'assign_order',
    'moderate_review'
  ]){
    assert.match(platformAction,new RegExp(`'${action}'`),`Missing ${action} action`);
  }
  assert.match(platformAction,/'save_service_product'/,'legacy service save action must remain an alias');

  assert.ok(
    (platformAction.match(/expectedUpdatedAt/g)||[]).length>=5,
    'mutable provider, course, service, package and assignment records need expectedUpdatedAt'
  );
  for(const conflict of [
    'service_provider_update_conflict',
    'service_course_update_conflict',
    'service_product_update_conflict',
    'service_package_update_conflict',
    'service_assignment_update_conflict'
  ]){
    assert.match(platformAction,new RegExp(`raise\\s+exception\\s+'${conflict}'`,'i'));
  }

  for(const auditAction of [
    'service.provider.saved',
    'service.course.saved',
    'service.product.saved',
    'service.package.saved',
    'service.order.assigned',
    'service.review.moderated'
  ]){
    assert.match(platformAction,new RegExp(`private_app\\.write_audit\\(\\s*'${auditAction.replaceAll('.','\\.')}'`,'i'));
  }
});

test('tenant order creation is idempotent, serialized and snapshots package pricing',()=>{
  const tenantAction=section(
    migration,
    'create or replace function public.v2_tenant_service_marketplace_action',
    'create or replace function private_app.sync_service_assignment_order_status_v1'
  );

  assert.match(tenantAction,/marketplace_idempotency_required/i);
  assert.match(tenantAction,/tenant_id\s*=\s*v_tenant\.id\s+and\s+idempotency_key\s*=\s*v_idempotency_key/i);
  assert.match(tenantAction,/pg_advisory_xact_lock\s*\(/i);
  assert.match(tenantAction,/hashtextextended\s*\(/i);
  assert.match(tenantAction,/'duplicate'\s*,\s*true/i);
  assert.match(tenantAction,/'pending_product_order'/i);
  assert.match(tenantAction,/v_amount\s*:=\s*v_package\.amount_minor/i);
  assert.match(tenantAction,/service_package_id\s*,\s*product_key/i);
  assert.match(tenantAction,/v_product\.name_ar\s*,\s*v_quantity\s*,\s*v_amount\s*,\s*v_subtotal/i);
  assert.match(tenantAction,/insert\s+into\s+marketplace\.service_order_briefs\s*\(/i);
  assert.match(tenantAction,/'packageName'\s*,\s*v_package\.name_ar/i);
  assert.match(tenantAction,/'packageIncludedItems'\s*,\s*v_package\.included_items_ar/i);
  assert.match(tenantAction,/payment_provider\s*,/i);
  assert.match(tenantAction,/marketplace_payment_provider_unavailable/i);
});

test('legacy marketplace contracts remain rollback-compatible but cannot bypass service visibility',()=>{
  assert.match(migration,/alter\s+function\s+public\.v1_tenant_marketplace_snapshot\(text\)[\s\S]*?set\s+schema\s+private_app/i);
  assert.match(migration,/alter\s+function\s+public\.v1_tenant_marketplace_action\(text,text,jsonb\)[\s\S]*?set\s+schema\s+private_app/i);
  assert.match(migration,/alter\s+function\s+public\.v2_tenant_marketplace_snapshot\(text\)[\s\S]*?set\s+schema\s+private_app/i);
  assert.match(migration,/alter\s+function\s+public\.v2_tenant_marketplace_action\(text,text,jsonb\)[\s\S]*?set\s+schema\s+private_app/i);
  assert.match(migration,/create\s+or\s+replace\s+function\s+public\.v1_tenant_marketplace_snapshot/i);
  assert.match(migration,/create\s+or\s+replace\s+function\s+public\.v1_tenant_marketplace_action/i);
  assert.match(migration,/product\.marketplace_visible/i);
  assert.match(migration,/product\.is_marketplace_visible/i);
  assert.match(migration,/coalesce\(p_payload,'\{\}'::jsonb\)\s*-\s*'itemType'/i);
  assert.equal(
    (migration.match(/lower\(pg_catalog\.btrim\(coalesce\(p_payload ->> 'itemType',''\)\)\)/g)||[]).length,
    3,
    'all compatibility itemType branches must trim before hardened routing'
  );
  assert.match(migration,/v_base[\s\S]*?-\s*'addons'[\s\S]*?-\s*'addonCategories'/i);
});

test('assignment history is append-only and the purchased package cannot be changed',()=>{
  const platformAction=section(
    migration,
    'create or replace function public.v1_platform_service_marketplace_action',
    'create or replace function public.v2_tenant_service_marketplace_snapshot'
  );
  assert.match(platformAction,/insert\s+into\s+marketplace\.service_assignment_events\s*\(/i);
  assert.match(platformAction,/service_assignment_package_locked/i);
  assert.match(platformAction,/'fromProviderId'\s*,\s*v_previous_provider_id/i);
  assert.doesNotMatch(platformAction,/delete\s+from\s+marketplace\.service_assignment_events/i);
});

test('server loaders and API routes are wired to the dedicated marketplace RPCs',()=>{
  const api=source('lib/api.js');
  const controlPage=source('app/control/services/page.js');
  const platformRoute=source('app/api/platform/[action]/route.js');
  const tenantRoute=source('app/api/tenant/[action]/route.js');

  assert.match(api,/v2_tenant_service_marketplace_snapshot/);
  assert.match(api,/v1_platform_service_marketplace_snapshot/);
  assert.match(api,/export\s+async\s+function\s+getPlatformServiceMarketplace\b/);
  assert.match(controlPage,/getPlatformServiceMarketplace/);
  assert.match(platformRoute,/["']service-marketplace["']\s*:\s*["']v1_platform_service_marketplace_action["']/);
  assert.match(tenantRoute,/["']marketplace["']\s*:\s*["']v1_tenant_marketplace_action["']/);
  assert.match(tenantRoute,/["']service-marketplace["']\s*:\s*["']v2_tenant_service_marketplace_action["']/);
});

test('services storefront cannot discover or purchase add-ons through the legacy RPC',()=>{
  const storefront=source('components/marketplace-store.js');

  assert.match(storefront,/\/addons-store/,'Services Store should link to the dedicated Add-ons Store');
  assert.match(storefront,/\/api\/tenant\/service-marketplace/);
  assert.match(storefront,/p_action\s*:\s*['"]create_service_order['"]/);
  assert.match(storefront,/packageId/,'Service package selection must reach the order RPC');

  assert.doesNotMatch(storefront,/data\.addons\b/);
  assert.doesNotMatch(storefront,/ADDON_CATEGORIES/);
  assert.doesNotMatch(storefront,/filteredAddons/);
  assert.doesNotMatch(storefront,/openCheckout\s*\(\s*item\s*,\s*['"]addon['"]\s*\)/);
  assert.doesNotMatch(storefront,/itemType\s*:\s*['"]addon['"]/);
  assert.doesNotMatch(storefront,/p_action\s*:\s*['"]create_order['"]/);
  assert.doesNotMatch(storefront,/\/api\/tenant\/marketplace/);
});

test('platform services UI covers providers, courses, services, packages and assignment',()=>{
  const platformServices=source('components/platform-services.js');

  assert.match(platformServices,/\/api\/platform\/service-marketplace/);
  for(const action of [
    'save_provider',
    'save_course',
    'save_service',
    'save_package',
    'assign_order'
  ]){
    assert.match(platformServices,new RegExp(`['"]${action}['"]`),`Platform UI must call ${action}`);
  }
  assert.match(platformServices,/expectedUpdatedAt/);
});
