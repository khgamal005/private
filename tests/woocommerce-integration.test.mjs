import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration=await read(
  '../supabase/migrations/20260731023000_woocommerce_course_commerce_sync_v1.sql'
);
const edge=await read('../supabase/functions/woocommerce-sync/index.ts');
const api=await read('../app/api/woocommerce/[action]/route.js');
const panel=await read('../components/woocommerce-sync-panel.js');
const catalog=await read('../components/course-catalog.js');
const page=await read('../app/tenant/[slug]/courses/page.js');
const config=await read('../supabase/config.toml');
const proxy=await read('../proxy.js');

test('WooCommerce storage is tenant isolated and credentials stay in Vault',()=>{
  const snapshot=migration.slice(
    migration.indexOf(
      'create or replace function public.v2_tenant_woocommerce_snapshot'
    ),
    migration.indexOf(
      'create or replace function public.v2_tenant_woocommerce_action'
    )
  );
  assert.match(migration,/create schema if not exists commerce_sync/);
  assert.match(migration,/create table commerce_sync\.connections/);
  assert.match(migration,/create table commerce_sync\.external_entities/);
  assert.match(migration,/create table commerce_sync\.sync_runs/);
  assert.match(migration,/alter table commerce_sync\.connections enable row level security/);
  assert.match(migration,/revoke all on all tables in schema commerce_sync/);
  assert.match(migration,/private_app\.can_manage_woocommerce/);
  assert.match(migration,/platform\.control\.write/);
  assert.match(migration,/vault\.create_secret/);
  assert.match(migration,/private_app\.integration_secret_upsert/);
  assert.match(migration,/configuredSecrets/);
  assert.doesNotMatch(snapshot,/decrypted_secrets|consumer_secret|consumer_key/);
});

test('WooCommerce sync is idempotent and preserves a local course identity',()=>{
  assert.match(
    migration,
    /unique\s*\(\s*connection_id,\s*entity_type,\s*external_id\s*\)/
  );
  assert.match(migration,/on conflict\s*\(\s*connection_id,\s*entity_type,\s*external_id\s*\)/);
  assert.match(migration,/local_course_id/);
  assert.match(migration,/match_by_sku boolean not null default false/);
  assert.match(migration,/origin'[\s\S]*'linked'/);
  assert.match(migration,/external_source/);
  assert.match(migration,/regular_price_minor/);
  assert.match(migration,/sale_price_minor/);
  assert.match(migration,/sale_starts_at/);
  assert.match(migration,/sale_ends_at/);
  assert.doesNotMatch(migration,/delete from academy\.courses/i);
});

test('connector uses authenticated wc v3 reads with safe pagination and retries',()=>{
  assert.match(edge,/\/wp-json\/wc\/v3/);
  assert.match(edge,/Basic/);
  assert.match(edge,/per_page/);
  assert.match(edge,/'100'|100/);
  assert.match(edge,/x-wp-totalpages/i);
  assert.match(edge,/retry-after/i);
  assert.match(edge,/429/);
  assert.match(edge,/502/);
  assert.match(edge,/503/);
  assert.match(edge,/504/);
  assert.match(edge,/\w+Url\.protocol\s*!==\s*'https:'/);
  assert.match(edge,/a\s*===\s*192\s*&&\s*b\s*===\s*168/);
  assert.match(edge,/redirect:\s*'error'/);
  assert.match(edge,/MAX_PAGES_PER_COLLECTION/);
  assert.match(edge,/MAX_REMOTE_RESPONSE_BYTES/);
  assert.match(edge,/itemCount > 0/);
  assert.match(edge,/startsWith\('sb_secret_'\)/);
  assert.doesNotMatch(edge,/consumer_key=.*consumer_secret=/i);
});

test('core WooCommerce resources and scheduled reconciliation are supported',()=>{
  for(const resource of [
    'categories',
    'attributes',
    'attribute_terms',
    'products',
    'variations',
    'coupons',
    'orders',
    'customers'
  ]){
    assert.match(edge,new RegExp(resource));
  }
  assert.match(migration,/v2_woocommerce_due_connections/);
  assert.match(migration,/cron\.schedule/);
  assert.match(migration,/woocommerce-sync/);
  assert.match(migration,/p_action not in \('test_connection', 'sync_now'\)/);
  assert.match(migration,/'recentRuns'/);
  assert.match(migration,/'counts'/);
  assert.match(migration,/last_seen_run_id is distinct from v_run\.id/);
  assert.match(config,/\[functions\.woocommerce-sync\][\s\S]*verify_jwt\s*=\s*false/);
});

test('application route keeps secrets server-side and course UI exposes sync controls',()=>{
  assert.match(api,/ACCESS_COOKIE/);
  assert.match(api,/authorization:`Bearer \$\{token\}`/);
  assert.doesNotMatch(api,/SERVICE_ROLE|service_role/);
  assert.match(proxy,/\/api\/woocommerce/);
  assert.match(page,/getTenantWooCommerce/);
  assert.match(page,/commerce\?\.canManage/);
  assert.match(panel,/Consumer Key/);
  assert.match(panel,/Consumer Secret/);
  assert.match(panel,/مزامنة الآن/);
  assert.match(panel,/يدوي فقط/);
  assert.match(panel,/أسبوعي/);
  assert.match(panel,/الطلبات والمدفوعات/);
  assert.match(panel,/syncScope:scopeList\(scope\)/);
  assert.match(panel,/matchBySku:Boolean\(scope\.matchBySku\)/);
  assert.match(catalog,/regularPriceMinor/);
  assert.match(catalog,/salePriceMinor/);
  assert.match(catalog,/فتح في المتجر/);
});
