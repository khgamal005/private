import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

const [migration,consoleUi,consoleCss,tenantStore,platformRoute]=await Promise.all([
  read('supabase/migrations/20260826221000_addon_catalog_control_v1.sql'),
  read('components/platform-addon-console.js'),
  read('components/platform-addon-console.module.css'),
  read('components/marketplace-addon-store-v2.js'),
  read('app/api/platform/[action]/route.js')
]);

test('catalog visibility is additive and explicitly separate from entitlement',()=>{
  assert.match(
    migration,
    /add column if not exists is_marketplace_visible boolean not null default true/i
  );
  assert.match(migration,/Commercial discovery and new-purchase visibility only/i);
  assert.match(migration,/Never used by entitlement or operational feature gates/i);
  assert.doesNotMatch(migration,/\b(delete|truncate|drop table)\b/i);
  assert.doesNotMatch(migration,/update\s+catalog\.tenant_addon_subscriptions/i);
  assert.doesNotMatch(migration,/create or replace function\s+private_app\.(?:addon_entitlement|tenant_addon_enabled)/i);
});

test('public marketplace contracts stay stable behind private legacy implementations',()=>{
  for(const signature of [
    /private_app\.v3_platform_addon_center_snapshot_catalog_legacy\(\)/i,
    /private_app\.v3_platform_addon_center_action_catalog_legacy\(text,\s*jsonb\)/i,
    /private_app\.v2_tenant_marketplace_snapshot_catalog_legacy\(text\)/i,
    /private_app\.v2_tenant_marketplace_action_catalog_legacy\(text,\s*text,\s*jsonb\)/i
  ])assert.match(migration,signature);
  assert.match(migration,/create or replace function public\.v3_platform_addon_center_snapshot\(\)/i);
  assert.match(migration,/create or replace function public\.v3_platform_addon_center_action\s*\(/i);
  assert.match(migration,/create or replace function public\.v2_tenant_marketplace_snapshot\s*\(/i);
  assert.match(migration,/create or replace function public\.v2_tenant_marketplace_action\s*\(/i);
});

test('platform catalog editing is permissioned, concurrency-safe and audited',()=>{
  assert.match(migration,/has_platform_permission\(\s*'platform\.billing\.manage'\s*\)/i);
  assert.match(migration,/p_action is distinct from 'update_product_catalog'/i);
  assert.match(migration,/where product\.id = v_product_id\s+for update/i);
  assert.match(migration,/v_product\.updated_at is distinct from v_expected_updated_at/i);
  assert.match(migration,/raise exception 'addon_product_update_conflict'/i);
  assert.match(migration,/catalog\.addon\.product_catalog_updated/i);
  assert.match(migration,/'operationalStatusChanged', false/i);
  assert.match(migration,/'subscriptionRowsChanged', 0/i);
  assert.match(migration,/'tenantDataChanged', false/i);
});

test('platform snapshot exposes display and store state without changing runtime status',()=>{
  assert.match(migration,/'marketplaceVisible', product\.is_marketplace_visible/i);
  assert.match(migration,/'displayOrder', product\.sort_order/i);
  assert.match(migration,/'updatedAt', product\.updated_at/i);
  assert.match(migration,/'visibleProducts'/i);
  assert.match(migration,/'hiddenProducts'/i);
  const update=migration.match(
    /update\s+catalog\.addon_products[\s\S]*?where id = v_product\.id/i
  )?.[0];
  assert.ok(update);
  assert.doesNotMatch(update,/\bstatus\s*=/i);
});

test('tenant discovery and direct purchase both enforce hidden state',()=>{
  assert.match(
    migration,
    /where product\.is_marketplace_visible[\s\S]*?product\.status in \('beta', 'active'\)/i
  );
  assert.match(
    migration,
    /p_action = 'create_order'[\s\S]*?product\.is_marketplace_visible[\s\S]*?for key share/i
  );
  assert.match(
    migration,
    /p_action = 'activate_free_addon'[\s\S]*?not v_product\.is_marketplace_visible[\s\S]*?addon_entitlement/i
  );
  assert.match(migration,/raise exception 'marketplace_product_not_found'/i);
  assert.match(
    migration,
    /retry of an already-created order is not a new purchase/i
  );
});

test('tenant store categories come from the managed category catalog',()=>{
  assert.match(migration,/'addonCategories'/);
  assert.match(migration,/'categoryKey', coalesce\(/);
  assert.match(migration,/'categoryName', coalesce\(/);
  assert.match(tenantStore,/const addonCategories=data\.addonCategories\|\|EMPTY/);
  assert.match(tenantStore,/const categoryOptions=useMemo/);
  assert.match(tenantStore,/categoryOptions\.map/);
  assert.match(tenantStore,/item\.categoryName\|\|ADDON_CATEGORIES/);
});

test('admin UI supports commercial copy, ordering and safe store hiding',()=>{
  assert.match(consoleUi,/platformAction\('update_product_catalog'/);
  for(const field of [
    'name_ar','name_en','description_ar','badge_ar',
    'display_order','marketplace_visible','reason'
  ])assert.match(consoleUi,new RegExp('name="'+field+'"'));
  assert.match(consoleUi,/مخفية من المتجر/);
  assert.match(consoleUi,/لا يوقف الإضافة لدى أي منشأة مشتركة/);
  assert.match(consoleUi,/تراخيص المنشآت وبياناتها ما زالت تعمل/);
  assert.match(consoleCss,/\.storeHidden/);
  assert.match(consoleCss,/\.visibilityCheck/);
});

test('catalog validation errors are translated for platform operators',()=>{
  for(const errorKey of [
    'invalid_addon_product_update',
    'invalid_addon_product_visibility',
    'addon_product_name_required',
    'addon_product_description_required',
    'invalid_addon_product_display_order',
    'addon_product_update_reason_required',
    'addon_product_update_conflict'
  ])assert.match(platformRoute,new RegExp(errorKey));
});
