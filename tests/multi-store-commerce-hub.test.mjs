import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration=[
  await read('../supabase/migrations/20260731040000_multi_store_commerce_hub_core_v1.sql'),
  await read('../supabase/migrations/20260731040100_multi_store_commerce_data_plane_v1.sql'),
  await read('../supabase/migrations/20260731040200_multi_store_commerce_snapshot_v1.sql'),
  await read('../supabase/migrations/20260731040210_multi_store_commerce_tenant_actions_v1.sql'),
  await read('../supabase/migrations/20260731040220_multi_store_commerce_service_api_v1.sql'),
  await read('../supabase/migrations/20260731040230_multi_store_commerce_runtime_v1.sql')
].join('\n');
const edge=[
  await read('../supabase/functions/commerce-sync/index.ts'),
  await read('../supabase/functions/commerce-sync/shared.ts'),
  await read('../supabase/functions/commerce-sync/adapters/salla.ts'),
  await read('../supabase/functions/commerce-sync/adapters/zid.ts'),
  await read('../supabase/functions/commerce-sync/adapters/shopify.ts'),
  await read('../supabase/functions/commerce-sync/adapters/custom.ts')
].join('\n');
const route=await read('../app/api/commerce/[provider]/[action]/route.js');
const hub=await read('../components/commerce-integration-hub.js');
const page=await read('../app/tenant/[slug]/courses/page.js');
const api=await read('../lib/commerce-api.js');
const proxy=await read('../proxy.js');
const config=await read('../supabase/config.toml');

test('commerce hub registers supported providers without replacing WooCommerce',()=>{
  for(const provider of ['woocommerce','salla','zid','shopify','custom']){
    assert.match(migration,new RegExp(`'${provider}'`));
  }
  assert.match(migration,/adapter_status/);
  assert.match(migration,/v2_tenant_woocommerce_snapshot/);
  assert.doesNotMatch(migration,/drop table commerce_sync|drop schema commerce_sync/i);
});

test('commerce storage is tenant-isolated, idempotent, and Vault-backed',()=>{
  assert.match(migration,/create schema if not exists commerce_hub/);
  assert.match(migration,/create table commerce_hub\.connections/);
  assert.match(migration,/create table commerce_hub\.sync_runs/);
  assert.match(migration,/create table commerce_hub\.external_entities/);
  assert.match(migration,/create table commerce_hub\.webhook_events/);
  assert.match(migration,/unique \(tenant_id, provider_key\)/);
  assert.match(migration,/unique \(connection_id, entity_type, external_id\)/);
  assert.match(migration,/unique \(connection_id, idempotency_key\)/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/integration_secret_upsert/);
  assert.match(migration,/vault\.decrypted_secrets/);
  assert.match(migration,/revoke all on all tables in schema commerce_hub/);
});

test('normalized data plane preserves course identity and archives safely',()=>{
  assert.match(migration,/v2_commerce_hub_store_batch/);
  assert.match(migration,/local_course_id/);
  assert.match(migration,/match_by_sku/);
  assert.match(migration,/external_source = v_connection\.provider_key/);
  assert.match(migration,/v_course_is_linked[\s\S]*'linked'/);
  assert.match(migration,/last_seen_run_id is distinct from v_run\.id/);
  assert.doesNotMatch(migration,/delete from academy\.courses/i);
});

test('configuration validates provider capabilities and blocks private custom URLs',()=>{
  assert.match(migration,/commerce_scope_not_supported_by_provider/);
  assert.match(migration,/myshopify/);
  assert.match(migration,/localhost/);
  assert.ok(migration.includes('192[.]168[.]'));
  assert.ok(migration.includes('169[.]254[.]'));
  assert.match(migration,/commerce_public_https_url_required/);
  assert.match(edge,/Deno\.resolveDns/);
  assert.match(edge,/custom_private_host_blocked/);
  assert.match(edge,/redirect:\s*'error'/);
});

test('tenant API uses the user session and never exposes a service key',()=>{
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/authorization:`Bearer \$\{token\}`/);
  assert.match(route,/v2_tenant_commerce_hub_action/);
  assert.match(route,/\/functions\/v1\/commerce-sync/);
  assert.match(route,/x-idempotency-key/);
  assert.match(route,/test_connection/);
  assert.match(route,/sync_now/);
  assert.doesNotMatch(route,/SERVICE_ROLE|service_role/);
});

test('connector runtime authorizes tenant actions and stores normalized batches',()=>{
  for(const rpc of [
    'v2_commerce_hub_authorize',
    'v2_commerce_hub_connection_configuration',
    'v2_commerce_hub_start_sync',
    'v2_commerce_hub_store_batch',
    'v2_commerce_hub_finish_sync',
    'v2_commerce_hub_finish_test'
  ]){
    assert.match(edge,new RegExp(rpc));
  }
  assert.match(edge,/MAX_ATTEMPTS/);
  assert.match(edge,/retry-after/);
  assert.match(edge,/MAX_RESPONSE_BYTES/);
  assert.match(edge,/remote_timeout/);
  assert.match(edge,/duplicate/);
  assert.match(migration,/sync_lease_expired/);
});

test('live adapters use current provider authentication and APIs',()=>{
  assert.match(edge,/https:\/\/api\.salla\.dev\/admin\/v2/);
  assert.match(edge,/Bearer \$\{secret\(connection, 'accessToken'\)\}/);
  assert.match(edge,/https:\/\/api\.zid\.sa\/v1/);
  assert.match(edge,/'Access-Token'/);
  assert.match(edge,/'Store-Id'/);
  assert.match(edge,/'X-Manager-Token'/);
  assert.match(edge,/const API_VERSION = '2026-07'/);
  assert.match(edge,/X-Shopify-Access-Token/);
  assert.match(edge,/graphql\.json/);
});

test('manager UI exposes setup, connection test, sync, schedules, and safe secret fields',()=>{
  assert.match(hub,/مركز ربط المتاجر/);
  assert.match(hub,/salla/);
  assert.match(hub,/zid/);
  assert.match(hub,/shopify/);
  assert.match(hub,/custom/);
  assert.match(hub,/type={SECRET_FIELDS\.has\(fieldKey\)\?'password':'text'}/);
  assert.match(hub,/اختبار الاتصال/);
  assert.match(hub,/مزامنة الآن/);
  assert.match(hub,/matchBySku/);
  assert.match(hub,/weekly/);
  assert.match(page,/getTenantCommerceHub/);
  assert.match(api,/v2_tenant_commerce_hub_snapshot/);
  assert.match(proxy,/\/api\/commerce/);
});

test('commerce Edge Function uses explicit tenant authorization contract',()=>{
  assert.match(config,/\[functions\.commerce-sync\][\s\S]*verify_jwt\s*=\s*false/);
  assert.match(edge,/rpcUser\(config, token, 'v2_commerce_hub_authorize'/);
  assert.match(edge,/rpcService\([\s\S]*'v2_commerce_hub_connection_configuration'/);
  assert.match(migration,/grant execute on function public\.v2_commerce_hub_authorize[\s\S]*to authenticated/);
  assert.match(migration,/grant execute on function public\.v2_commerce_hub_connection_configuration[\s\S]*to service_role/);
});
